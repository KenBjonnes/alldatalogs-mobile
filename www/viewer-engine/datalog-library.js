'use strict';
/*
 * datalog-library.js -- the shared library (browse / use / share) for custom-gauge dashboards and
 * histogram definitions. Ken, 2026-09-08: "a library of gauges and histograms ... labeled as our
 * official one ... if a user shares one it will be marked as a user share ... a thumbnail to show
 * what it looks like." Same day: our own shares (admin accounts) are marked SYSTEM automatically,
 * never "User share"; the car link is an official Year / Make / Model picked from
 * datalog-vehicles.js (nothing typed in); sharing something already in the library offers to
 * UPDATE that entry or create a new one; and browsing can show System, User or both.
 *
 * Host-agnostic on purpose: this file talks only to the async provider a host installs at
 * window.DATAVIEWER.library (runtime.js carries it) and to the callbacks a caller passes in. On a
 * host with no provider, Library.available() is false and every entry point stays hidden.
 *
 * Provider contract (every method returns a Promise):
 *   list({kind, q, source:'all'|'official'|'user', mine, page, pageSize}) -> { items: [summary...], hasMore }
 *       (`official: true` is still sent alongside source:'official' for older providers)
 *   get(id)            -> full item (summary + payload) | null
 *   publish({kind, name, description, vehicle, vehicle_year, vehicle_make, vehicle_model, tags, payload, thumb_svg})
 *                      -> { ok, item } | { ok:false, error }   (an admin caller's item comes back is_official)
 *   update(id, {name, description, vehicle, vehicle_year, vehicle_make, vehicle_model, payload, thumb_svg})
 *                      -> { ok, item } | { ok:false, error }   (the caller's own items)
 *   remove(id)         -> { ok } | { ok:false, error }        (the caller's own items)
 *   pull(id)                                                  (use counter, best effort)
 *   me()               -> { userId, email } | null
 *   isAdmin()          -> boolean
 *   admin: { setOfficial(id, bool), hide(id, bool), remove(id) }  (each -> { ok } | { ok:false, error })
 * Summary: { id, kind:'gauges'|'histogram', name, description, owner_id, author_name, is_official,
 *            status:'published'|'hidden', thumb_svg, vehicle, vehicle_year, vehicle_make, vehicle_model,
 *            tags, pulls, updated_at }
 *
 * Thumbnails are SVG strings other users generated (via gaugesThumbnailSvg / HistogramUI.thumbnailSvg).
 * They are shown through <img src="data:image/svg+xml,..."> and never inlined into the DOM: an image
 * cannot run script or fetch anything, so a hostile thumbnail is at worst an ugly picture.
 *
 * Load order: after datalog-histogram-editor.js (and datalog-vehicles.js) and before
 * datalog-viewer.js (the viewer references window.Library lazily, guarded by typeof).
 */
(function (global) {
  var KINDS = { gauges: 'Gauge dashboards', histogram: 'Histograms' };
  var PAGE = 30;
  var SYSTEM_LABEL = 'System', USER_LABEL = 'User share';
  var state = { ovl: null };

  function provider() {
    var d = global.DATAVIEWER;
    return d && d.library && typeof d.library.list === 'function' ? d.library : null;
  }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function toast(msg) { if (typeof global.showToast === 'function') global.showToast(msg); }
  function isPro() { return typeof global.viewerIsPro === 'function' ? !!global.viewerIsPro() : !!(global.DATAVIEWER && global.DATAVIEWER.isPro === true); }
  var PRO_MSG = 'Activate Pro to use and share library items';
  function plural(n, s) { return n + ' ' + s + (n === 1 ? '' : 's'); }
  function when(fn) { return Promise.resolve().then(fn); }

  // ---- vehicles (official Year / Make / Model list, datalog-vehicles.js) ---------------------------
  function vehicles() { var v = global.DATALOG_VEHICLES; return v && v.makes && typeof v.makes === 'object' ? v : null; }
  /** Display string for a {year, make, model} (or a legacy free-text string). */
  function vehicleText(v) {
    if (!v) return '';
    if (typeof v === 'string') return v;
    return [v.year, v.make, v.model].filter(Boolean).join(' ');
  }
  /** The structured fields a provider stores, from a {year, make, model}. */
  function vehicleFields(v) {
    var year = v && v.year ? parseInt(v.year, 10) : null;
    return { vehicle: vehicleText(v), vehicle_year: year && isFinite(year) ? year : null, vehicle_make: (v && v.make) || '', vehicle_model: (v && v.model) || '' };
  }
  /** {year, make, model} from a library item (null when it carries no structured car). */
  function vehicleOf(item) {
    if (!item) return null;
    if (item.vehicle_make || item.vehicle_model || item.vehicle_year) return { year: item.vehicle_year || '', make: item.vehicle_make || '', model: item.vehicle_model || '' };
    return null;
  }
  function optionsHtml(list, selected, placeholder) {
    return '<option value="">' + esc(placeholder) + '</option>' + list.map(function (v) {
      return '<option value="' + esc(v) + '"' + (String(v) === String(selected) ? ' selected' : '') + '>' + esc(v) + '</option>';
    }).join('');
  }
  function vehiclePickerHtml(v) {
    var cat = vehicles();
    if (!cat) return '<div class="dlv-lib-field"><span>Car (optional)</span><div class="dlv-lib-note">The car list is not available on this page.</div></div>';
    var years = [];
    for (var y = cat.yearMax; y >= cat.yearMin; y--) years.push(y);
    var makes = Object.keys(cat.makes).sort(function (a, b) { return a.localeCompare(b); });
    var models = v && v.make && cat.makes[v.make] ? cat.makes[v.make] : [];
    return '<div class="dlv-lib-field"><span>Car (optional)</span><div class="dlv-lib-veh">' +
      '<select class="dlv-lib-in" data-f="year" aria-label="Year">' + optionsHtml(years, v && v.year, 'Year') + '</select>' +
      '<select class="dlv-lib-in" data-f="make" aria-label="Make">' + optionsHtml(makes, v && v.make, 'Make') + '</select>' +
      '<select class="dlv-lib-in" data-f="model" aria-label="Model"' + (models.length ? '' : ' disabled') + '>' + optionsHtml(models, v && v.model, 'Model') + '</select>' +
      '</div><div class="dlv-lib-note">Official make and model names (NHTSA). Pick a make first.</div></div>';
  }
  function wireVehiclePicker(root) {
    var cat = vehicles(), make = root.querySelector('[data-f="make"]'), model = root.querySelector('[data-f="model"]');
    if (!cat || !make || !model) return;
    make.addEventListener('change', function () {
      var list = cat.makes[make.value] || [];
      model.innerHTML = optionsHtml(list, '', 'Model');
      model.disabled = !list.length;
    });
  }
  function readVehicle(root) {
    var y = root.querySelector('[data-f="year"]'), m = root.querySelector('[data-f="make"]'), d = root.querySelector('[data-f="model"]');
    if (!y || !m || !d) return null;
    var v = { year: y.value || '', make: m.value || '', model: d.value || '' };
    return v.year || v.make || v.model ? v : null;
  }

  // ---- overlay plumbing ------------------------------------------------------------------------------
  function close() {
    if (state.ovl) { state.ovl.remove(); state.ovl = null; }
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') close(); }

  function thumbHtml(svg) {
    var s = String(svg || '').trim();
    if (!/^<svg[\s>]/i.test(s) || s.length > 60000) return '<div class="dlv-lib-thumb dlv-lib-thumb-empty">No preview</div>';
    return '<img class="dlv-lib-thumb" alt="" src="data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s) + '">';
  }
  function headHtml(kicker, title, tabsHtml) {
    return '<div class="dlv-lib-head"><div class="dlv-lib-title"><span class="dlv-lib-kicker">' + esc(kicker) + '</span><b>' + esc(title) + '</b></div>' +
      (tabsHtml || '') + '<button type="button" class="dlv-lib-x" title="Close">&times;</button></div>';
  }
  function mount(html) {
    close();
    var ovl = document.createElement('div');
    ovl.className = 'dlv-lib-ovl';
    ovl.innerHTML = html;
    document.body.appendChild(ovl);
    state.ovl = ovl;
    ovl.addEventListener('click', function (e) { if (e.target === ovl) close(); });
    ovl.querySelector('.dlv-lib-x').addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    return ovl;
  }
  function badgeHtml(it) {
    return it.is_official ? '<span class="dlv-lib-badge official">' + SYSTEM_LABEL + '</span>' : '<span class="dlv-lib-badge user">' + USER_LABEL + '</span>';
  }

  // ---- Browse ------------------------------------------------------------------------------------
  // opts: { kind: 'gauges'|'histogram', onUse(item) }  onUse receives the FULL item (with payload).
  function open(opts) {
    opts = opts || {};
    var p = provider();
    if (!p) { toast('The library is not available on this page.'); return; }
    var st = { kind: opts.kind === 'histogram' ? 'histogram' : 'gauges', q: '', filter: 'all', page: 0, items: [], hasMore: false, busy: false, me: null, admin: false, seq: 0 };
    var tabs = '<div class="dlv-lib-tabs">' + Object.keys(KINDS).map(function (k) {
      return '<button type="button" data-kind="' + k + '"' + (k === st.kind ? ' class="on"' : '') + '>' + esc(KINDS[k]) + '</button>';
    }).join('') + '</div>';
    var ovl = mount('<div class="dlv-lib" role="dialog" aria-label="Shared library">' +
      headHtml('Shared library', KINDS[st.kind], tabs) +
      '<div class="dlv-lib-bar"><input type="text" class="dlv-lib-search" placeholder="Search by name, car or author…" spellcheck="false">' +
        '<div class="dlv-lib-filters" role="group" aria-label="Show">' +
          '<button type="button" data-filter="all" class="on">Both</button>' +
          '<button type="button" data-filter="official">' + SYSTEM_LABEL + '</button>' +
          '<button type="button" data-filter="user">Users</button>' +
          '<button type="button" data-filter="mine">Mine</button></div></div>' +
      '<div class="dlv-lib-body"><div class="dlv-lib-grid"></div><div class="dlv-lib-foot"></div></div></div>');
    var grid = ovl.querySelector('.dlv-lib-grid'), foot = ovl.querySelector('.dlv-lib-foot'), search = ovl.querySelector('.dlv-lib-search');
    var titleEl = ovl.querySelector('.dlv-lib-title b');

    function card(it) {
      var mine = !!(st.me && it.owner_id === st.me.userId);
      var acts = '<button type="button" class="dlv-hg-btn primary sm' + (isPro() ? '' : ' dlv-pro-locked') + '" data-act="use">Use</button>';
      if (mine) acts += '<button type="button" class="dlv-hg-btn sm danger" data-act="remove">Remove</button>';
      if (st.admin) {
        acts += '<button type="button" class="dlv-hg-btn sm" data-act="official">' + (it.is_official ? 'Unmark ' + SYSTEM_LABEL : 'Mark ' + SYSTEM_LABEL) + '</button>' +
          '<button type="button" class="dlv-hg-btn sm" data-act="hide">' + (it.status === 'hidden' ? 'Unhide' : 'Hide') + '</button>' +
          (mine ? '' : '<button type="button" class="dlv-hg-btn sm danger" data-act="admin-remove">Remove</button>');
      }
      var car = vehicleText(vehicleOf(it)) || it.vehicle || '';
      return '<div class="dlv-lib-card' + (it.status === 'hidden' ? ' is-hidden' : '') + '" data-id="' + esc(it.id) + '">' + thumbHtml(it.thumb_svg) +
        '<div class="dlv-lib-card-body">' +
          '<div class="dlv-lib-card-name" title="' + esc(it.name) + '">' + esc(it.name) + (it.status === 'hidden' ? ' <span class="dlv-lib-hiddenmark">(hidden)</span>' : '') + '</div>' +
          '<div class="dlv-lib-card-meta">' + badgeHtml(it) + '<span>' + esc(it.is_official ? 'AllDataLogs' : (it.author_name || 'AllDataLogs user')) + '</span>' +
            (car ? '<span>&middot; ' + esc(car) + '</span>' : '') + '<span>&middot; ' + plural(it.pulls | 0, 'use') + '</span></div>' +
          (it.description ? '<div class="dlv-lib-card-desc">' + esc(it.description) + '</div>' : '') +
          '<div class="dlv-lib-card-acts">' + acts + '</div>' +
        '</div></div>';
    }
    function render() {
      grid.innerHTML = st.items.map(card).join('');
      if (st.busy) foot.innerHTML = '<span class="dlv-lib-faint">Loading…</span>';
      else if (!st.items.length) foot.innerHTML = '<span class="dlv-lib-faint">' + (st.filter === 'mine' ? 'You have not shared anything yet.' : st.q ? 'Nothing matches that search.' : 'Nothing here yet — be the first to share one.') + '</span>';
      else foot.innerHTML = st.hasMore ? '<button type="button" class="dlv-hg-btn sm" data-more="1">Load more</button>' : '<span class="dlv-lib-faint">' + plural(st.items.length, 'item') + '</span>';
    }
    function load(reset) {
      if (reset) { st.page = 0; st.items = []; st.hasMore = false; }
      var seq = ++st.seq;
      st.busy = true; render();
      var source = st.filter === 'official' ? 'official' : st.filter === 'user' ? 'user' : 'all';
      var q = { kind: st.kind, q: st.q, source: source, official: source === 'official', mine: st.filter === 'mine', page: st.page, pageSize: PAGE };
      when(function () { return p.list(q); }).then(function (r) {
        if (seq !== st.seq || !state.ovl) return;
        var items = (r && r.items) || [];
        st.items = st.items.concat(items); st.hasMore = !!(r && r.hasMore); st.busy = false;
        render();
        if (r && r.error) toast('Library: ' + r.error);
      }).catch(function (e) {
        if (seq !== st.seq || !state.ovl) return;
        st.busy = false; render(); toast('Could not load the library: ' + (e && e.message ? e.message : e));
      });
    }
    function reloadKeep() { load(true); }

    ovl.querySelectorAll('[data-kind]').forEach(function (b) {
      b.addEventListener('click', function () {
        st.kind = b.getAttribute('data-kind');
        ovl.querySelectorAll('[data-kind]').forEach(function (x) { x.classList.toggle('on', x === b); });
        titleEl.textContent = KINDS[st.kind];
        load(true);
      });
    });
    ovl.querySelectorAll('[data-filter]').forEach(function (b) {
      b.addEventListener('click', function () {
        st.filter = b.getAttribute('data-filter');
        ovl.querySelectorAll('[data-filter]').forEach(function (x) { x.classList.toggle('on', x === b); });
        load(true);
      });
    });
    var debounce = null;
    search.addEventListener('input', function () {
      clearTimeout(debounce);
      debounce = setTimeout(function () { st.q = search.value.trim(); load(true); }, 220);
    });
    foot.addEventListener('click', function (e) {
      var more = e.target.closest && e.target.closest('[data-more]');
      if (more) { st.page++; load(false); }
    });
    grid.addEventListener('click', function (e) {
      var btn = e.target.closest && e.target.closest('[data-act]');
      if (!btn) return;
      var cardEl = btn.closest('.dlv-lib-card'), id = cardEl && cardEl.getAttribute('data-id');
      var it = null;
      for (var i = 0; i < st.items.length; i++) if (st.items[i].id === id) { it = st.items[i]; break; }
      if (!it) return;
      var act = btn.getAttribute('data-act');
      if (act === 'use') {
        if (!isPro()) { toast(PRO_MSG); return; }
        btn.disabled = true;
        when(function () { return p.get(it.id); }).then(function (full) {
          if (!full || !full.payload) { btn.disabled = false; toast('That item is no longer available.'); return; }
          try { p.pull(it.id); } catch (err) { /* counter only */ }
          close();
          if (typeof opts.onUse === 'function') opts.onUse(full);
        }).catch(function (err) { btn.disabled = false; toast('Could not load that item: ' + (err && err.message ? err.message : err)); });
        return;
      }
      if (act === 'remove' || act === 'admin-remove') {
        if (!global.confirm('Remove "' + it.name + '" from the library? This cannot be undone.')) return;
        var rm = act === 'remove' ? p.remove(it.id) : p.admin.remove(it.id);
        Promise.resolve(rm).then(function (r) { if (r && r.ok === false) toast(r.error || 'Could not remove.'); else toast('Removed.'); reloadKeep(); });
        return;
      }
      if (act === 'official') {
        Promise.resolve(p.admin.setOfficial(it.id, !it.is_official)).then(function (r) { if (r && r.ok === false) toast(r.error || 'Could not update.'); reloadKeep(); });
        return;
      }
      if (act === 'hide') {
        Promise.resolve(p.admin.hide(it.id, it.status !== 'hidden')).then(function (r) { if (r && r.ok === false) toast(r.error || 'Could not update.'); reloadKeep(); });
      }
    });

    Promise.all([
      when(function () { return p.me(); }).catch(function () { return null; }),
      when(function () { return typeof p.isAdmin === 'function' ? p.isAdmin() : false; }).catch(function () { return false; })
    ]).then(function (r) {
      st.me = r[0] || null; st.admin = !!r[1];
      if (state.ovl === ovl) load(true);
    });
    load(true);
    search.focus();
  }

  // ---- Share -------------------------------------------------------------------------------------
  // opts: { kind, name, description, vehicle: {year, make, model} | string, payload, thumbSvg,
  //         libraryId, onDone(item, mode) }   mode: 'new' | 'update'
  // With `libraryId` naming an item the caller owns, the dialog offers "Update" (replace that entry's
  // content and details in place; it keeps its System mark, use count and comments) next to "Share as
  // new" (Ken, 2026-09-08). Anyone else's item, or a deleted one, falls back to a plain share.
  function share(opts) {
    opts = opts || {};
    var p = provider();
    if (!p) { toast('The library is not available on this page.'); return; }
    if (!isPro()) { toast(PRO_MSG); return; }
    var kind = opts.kind === 'histogram' ? 'histogram' : 'gauges';
    var vehicle = opts.vehicle && typeof opts.vehicle === 'object' ? opts.vehicle : null;
    var ovl = mount('<div class="dlv-lib dlv-lib-share" role="dialog" aria-label="Share to the library">' +
      headHtml('Share to the library', KINDS[kind]) +
      '<div class="dlv-lib-share-body">' + thumbHtml(opts.thumbSvg) +
        '<label>Name<input type="text" class="dlv-lib-in" data-f="name" maxlength="120" value="' + esc(opts.name || '') + '"></label>' +
        '<label>Description<textarea class="dlv-lib-in" data-f="description" rows="3" maxlength="2000" placeholder="What is it for, what does it show, what to look for…">' + esc(opts.description || '') + '</textarea></label>' +
        vehiclePickerHtml(vehicle) +
        '<div class="dlv-lib-note" data-note>Shared items are public and appear right away, marked as a ' + USER_LABEL + '. Your account name is shown as the author.</div>' +
        '<div class="dlv-lib-share-acts" data-acts><button type="button" class="dlv-hg-btn" data-act="cancel">Cancel</button><button type="button" class="dlv-hg-btn primary" data-act="share">Share</button></div>' +
      '</div></div>');
    var body = ovl.querySelector('.dlv-lib-share-body');
    wireVehiclePicker(body);
    var val = function (f) { var el = ovl.querySelector('[data-f="' + f + '"]'); return el ? String(el.value || '').trim() : ''; };
    var existing = null;   // the caller's own library item this content came from, when there is one
    function fields() {
      var v = vehicleFields(readVehicle(body));
      return { name: val('name'), description: val('description'), vehicle: v.vehicle, vehicle_year: v.vehicle_year, vehicle_make: v.vehicle_make, vehicle_model: v.vehicle_model,
        tags: [], payload: opts.payload, thumb_svg: opts.thumbSvg || null };
    }
    function busy(btn, on, label) { btn.disabled = on; btn.textContent = on ? 'Working…' : label; }
    function finish(r, mode, name, btn, label) {
      if (!r || r.ok === false) { busy(btn, false, label); toast((r && r.error) || 'Could not share that.'); return; }
      close();
      toast(mode === 'update' ? 'Updated "' + name + '" in the library.' : 'Shared "' + name + '" to the library.');
      if (typeof opts.onDone === 'function') opts.onDone(r.item || null, mode);
    }
    function wireActs() {
      var acts = ovl.querySelector('[data-acts]');
      acts.querySelector('[data-act="cancel"]').addEventListener('click', close);
      var shareBtn = acts.querySelector('[data-act="share"]'), updBtn = acts.querySelector('[data-act="update"]');
      shareBtn.addEventListener('click', function () {
        var f = fields();
        if (!f.name) { toast('Give it a name first.'); ovl.querySelector('[data-f="name"]').focus(); return; }
        busy(shareBtn, true, 'Share');
        when(function () { return p.publish(Object.assign({ kind: kind }, f)); })
          .then(function (r) { finish(r, 'new', f.name, shareBtn, 'Share'); })
          .catch(function (e) { busy(shareBtn, false, 'Share'); toast('Could not share: ' + (e && e.message ? e.message : e)); });
      });
      if (updBtn) updBtn.addEventListener('click', function () {
        var f = fields();
        if (!f.name) { toast('Give it a name first.'); ovl.querySelector('[data-f="name"]').focus(); return; }
        if (typeof p.update !== 'function') { toast('Updating library items is not available on this page.'); return; }
        busy(updBtn, true, 'Update');
        when(function () { return p.update(existing.id, f); })
          .then(function (r) { finish(r, 'update', f.name, updBtn, 'Update'); })
          .catch(function (e) { busy(updBtn, false, 'Update'); toast('Could not update: ' + (e && e.message ? e.message : e)); });
      });
    }
    wireActs();
    var nameIn = ovl.querySelector('[data-f="name"]');
    nameIn.focus(); nameIn.select();

    // Admins share as System; owners of the source item get Update / Share as new.
    Promise.all([
      when(function () { return typeof p.isAdmin === 'function' ? p.isAdmin() : false; }).catch(function () { return false; }),
      when(function () { return opts.libraryId ? p.get(opts.libraryId) : null; }).catch(function () { return null; }),
      when(function () { return p.me(); }).catch(function () { return null; })
    ]).then(function (r) {
      if (state.ovl !== ovl) return;
      var admin = !!r[0], item = r[1], me = r[2];
      var note = ovl.querySelector('[data-note]');
      if (admin && note) note.textContent = 'You are an AllDataLogs admin: this will be listed as ' + SYSTEM_LABEL + ' (ours), not as a user share.';
      if (item && me && item.owner_id === me.userId && typeof p.update === 'function') {
        existing = item;
        if (!opts.name && item.name) nameIn.value = item.name;
        if (!opts.description && item.description) ovl.querySelector('[data-f="description"]').value = item.description;
        if (!vehicle && vehicleOf(item)) {
          var field = body.querySelector('.dlv-lib-field'), tmp = document.createElement('div');
          tmp.innerHTML = vehiclePickerHtml(vehicleOf(item));
          if (field && tmp.firstChild) { field.parentNode.replaceChild(tmp.firstChild, field); wireVehiclePicker(body); }
        }
        var acts = ovl.querySelector('[data-acts]');
        acts.innerHTML = '<span class="dlv-lib-note dlv-lib-grow">This came from your library item “' + esc(item.name) + '”.</span>' +
          '<button type="button" class="dlv-hg-btn" data-act="cancel">Cancel</button>' +
          '<button type="button" class="dlv-hg-btn" data-act="share">Share as new</button>' +
          '<button type="button" class="dlv-hg-btn primary" data-act="update">Update</button>';
        wireActs();
      }
    });
  }

  global.Library = {
    available: function () { return !!provider(); },
    open: open,
    share: share,
    close: close,
    vehicleText: vehicleText,
    vehicleOf: vehicleOf,
    vehicleFields: vehicleFields,
    SYSTEM_LABEL: SYSTEM_LABEL,
    USER_LABEL: USER_LABEL
  };
})(typeof window !== 'undefined' ? window : globalThis);
