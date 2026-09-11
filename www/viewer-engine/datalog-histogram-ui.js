/* =================================================================================================
 * datalog-histogram-ui.js -- the BigData "Histograms" TABLE VIEW (Phase 2: UI over the Phase 1 engine).
 *
 * WHAT THIS IS
 *   The two-pane histogram workspace a tuner keeps open all day, modeled on HP Tuners VCM Scanner's
 *   table histograms: a LIST of definitions on the left, and on the right a toolbar (statistic /
 *   range / min-hits / colour / invert / copy), a heat-mapped TABLE with sticky axis headers, and a
 *   details strip for the clicked cell (count, avg, min, max, first/last + timestamps, jump/zoom/
 *   highlight actions). Everything numeric comes from `Histogram` (datalog-histogram.js); every
 *   math channel / filter comes from `DatalogExpr` (datalog-expr.js). This file never bins a sample.
 *
 * GLUE CONTRACT (what the host viewer -- Phase 3 -- or dev/histogram-lab.html hands to mount())
 *   glue = {
 *     data()           -> { channels, units, time, series:{ch:number[]}, textLevels, channelIds,
 *                           sampleInfo:{ isDecimated, totalRows, returnedRows } }
 *     resolvedRoles()  -> { roleId: channelName }            (presets resolveChannelRoles)
 *     unitByChannel()  -> { ch: unit }
 *     getRange()       -> { t0, t1, startIdx, endIdx, isFull } (current visible/zoomed window, inclusive)
 *     onRangeChange(fn) / offRangeChange(fn)
 *     navigate: { setRange(t0,t1), setCursor(t), highlightIndices(Int32Array|null) }
 *     convertValue(v, from, to) -> number|null
 *     openEditor(def, { data, resolver, onSave(def), focusSlot }) -- OPTIONAL (datalog-histogram-editor.js)
 *     defsChanged(defs)          -- persistence/dirty hook, after ANY def-list mutation
 *     onCompute(info)            -- OPTIONAL dev hook: { def, result, elapsedMs, reason }
 *     isPro, toast(msg), escapeHtml(s)
 *   }
 *   ctl = mount(hostEl, glue) -> { setDefs, getDefs, setActive, getActive, recompute, refresh,
 *                                  setStatistic, setRangeMode, getResult, getSelection, destroy }
 *
 * PARAMETER RESOLUTION (makeParamResolver) -- precedence ROLE -> CHANNEL NAME -> MATH
 *   A PARAM is { channel, role, math, unit, label }. The role is tried first (through resolvedRoles),
 *   then the literal channel name, then the math expression (compiled once per expression per data
 *   identity, evaluated over the whole log; its unit is param.unit). Inside expressions, [Name]
 *   resolves to a channel by exact name, then case-insensitively, then as a ROLE id -- so
 *   `[engine_rpm] - [Trans Input Shaft RPM B]` works across logs whose RPM channel is named
 *   differently. Filters go through the same lookup (compileFilter), and a simple-filter clause may
 *   carry a `role` next to its `param` for the same reason.
 *
 * RENDERING RULES
 *   - The table is built ONCE per compute (one HTML string); statistic / colour / min-hit changes
 *     only rewrite cell text + background through cached element refs. No re-render, no recompute.
 *   - Cells: right-aligned numbers, decimals from the value magnitude (Count = integer), "—" for a
 *     cell with 0 hits (distinct from a LOW-COUNT cell: 0 < count < minHits, drawn dimmed with a
 *     faint value, or a "·" when Show Low-Count is off). Count itself is always shown.
 *   - Heat colour: Auto = Histogram.valueRange over cells at/above min hits; Manual = def.colorScale.
 *     A range spanning zero (or a manual centre) is DIVERGING (blue below, neutral at centre, red
 *     above); otherwise SEQUENTIAL. colorScale.higherIsWorse flips which end is red (null = neutral
 *     amber heat). Count always uses a neutral sequential blue.
 *   - Selection is a Uint8Array mask over cells (single click / drag rectangle / Shift-extend /
 *     Ctrl-toggle / row / column / corner / Ctrl+A / Escape) and survives statistic changes.
 *   - Keyboard shortcuts are live only while the pointer or focus is inside the view and never
 *     while an input / textarea / select has focus.
 *
 * Style: plain ES5 (var/function; no class/arrow/let/const/template literals), one global
 * `HistogramUI`. The pure helpers (colorFor, toTsv, decimalsFor, normalizeRect, selectionBounds,
 * makeParamResolver, compileFilter, makeScale, EXAMPLE_DEFS) run under node (dev/histogram-ui-test.js);
 * the DOM layer only attaches when a document exists.
 * =============================================================================================== */
(function (global) {
  'use strict';

  function H() { return global.Histogram; }
  function E() { return global.DatalogExpr; }

  // ================================================================================================
  // 0. Small helpers
  // ================================================================================================
  function isFin(v) { return typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity; }
  function isObj(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }
  function clamp01(t) { return t < 0 ? 0 : t > 1 ? 1 : t; }
  function localEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;';
    });
  }
  /** 4500 -> "4,500"; keeps decimals as given; non-finite -> "". */
  function fmtK(v, dec) {
    if (!isFin(v)) return '';
    var s = dec == null ? String(Number(v.toPrecision(10))) : v.toFixed(dec);
    var neg = s.charAt(0) === '-'; if (neg) s = s.slice(1);
    var parts = s.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '-' : '') + parts.join('.');
  }
  function fmtTime(t) { return isFin(t) ? (t >= 100 ? t.toFixed(1) : t.toFixed(2)) + ' s' : '—'; }
  // Axis breakpoint labels come from the ENGINE at 10 significant figures (fmtNum in
  // datalog-histogram.js) so the stored def keeps full precision -- a converted or Auto/percentile
  // axis (e.g. Load) can then show a dozen digits on screen. Round to AT MOST `dec` decimals and strip
  // trailing zeros (never pad): 21.5734829 -> "21.57" at dec=2, but a whole-number axis like RPM
  // (1500) stays "1500", not "1500.00" -- padding every axis to a fixed width was rejected because it
  // would make every RPM/gear column noisier to fix a problem only fractional axes (Load, AFR, %) have.
  // Handles a distribution bin's "10.4567–20.3212" range label by rounding each side. Non-numeric
  // (categorical) labels pass through untouched.
  function roundAxisLabel(label, dec) {
    if (label == null) return label;
    var s = String(label);
    if (s.indexOf('–') >= 0) {
      var parts = s.split('–');
      return roundAxisLabel(parts[0], dec) + '–' + roundAxisLabel(parts[1], dec);
    }
    var n = Number(s);
    if (!isFin(n)) return s;
    var t = n.toFixed(Math.max(0, Math.min(6, isFin(dec) ? dec : 2)));
    if (t.indexOf('.') >= 0) t = t.replace(/0+$/, '').replace(/\.$/, '');
    return t;
  }
  /** def.display.axisDecimals, clamped 0-6; unset (the common case) defaults to 2. */
  function axisDecimalsFor(def) {
    var d = def && def.display && def.display.axisDecimals;
    return isFin(d) ? Math.max(0, Math.min(6, Math.round(d))) : 2;
  }
  function seq(a, b, step) { var out = []; for (var v = a; v <= b + step * 1e-9; v += step) out.push(Number(v.toPrecision(10))); return out; }
  function shortName(name) {
    if (typeof global.shortChannelName === 'function') { try { return global.shortChannelName(name) || name; } catch (e) { return name; } }
    return name;
  }
  function displayUnit(u) {
    if (!u) return '';
    if (typeof global.displayUnitFor === 'function') { try { return global.displayUnitFor(u); } catch (e) { return String(u); } }
    return String(u);
  }

  // ================================================================================================
  // 1. Pure helpers (node-tested)
  // ================================================================================================
  /** Display decimals for a set of cell values: integers -> 0, else by magnitude (>=100: 0, >=10: 1, >=1: 2, else 3). Count -> 0. */
  function decimalsFor(values, stat) {
    if (H() && H().normalizeStat(stat) === 'count') return 0;
    var maxAbs = 0, n = 0, allInt = true, i, v, a;
    if (values && values.length != null) {
      for (i = 0; i < values.length; i++) {
        v = values[i];
        if (!isFin(v)) continue;
        n++; a = Math.abs(v);
        if (a > maxAbs) maxAbs = a;
        if (allInt && Math.abs(v - Math.round(v)) > 1e-9) allInt = false;
      }
    }
    if (n === 0) return 1;
    if (allInt) return 0;
    return maxAbs >= 100 ? 0 : maxAbs >= 10 ? 1 : maxAbs >= 1 ? 2 : 3;
  }
  function formatValue(v, dec) { return isFin(v) ? v.toFixed(dec == null ? 2 : dec) : ''; }

  /** anchor/extent {r,c} -> {r0,c0,r1,c1} (inclusive, normalised). A missing extent = the anchor cell. */
  function normalizeRect(anchor, extent) {
    if (!anchor) return null;
    var e = extent || anchor;
    return { r0: Math.min(anchor.r, e.r), r1: Math.max(anchor.r, e.r), c0: Math.min(anchor.c, e.c), c1: Math.max(anchor.c, e.c) };
  }
  /** Bounding box + count of set cells in a selection mask (row-major R x C), or null when empty. */
  function selectionBounds(mask, R, C) {
    if (!mask || !mask.length) return null;
    var r0 = R, r1 = -1, c0 = C, c1 = -1, count = 0;
    for (var r = 0; r < R; r++) for (var c = 0; c < C; c++) {
      if (!mask[r * C + c]) continue;
      count++;
      if (r < r0) r0 = r; if (r > r1) r1 = r; if (c < c0) c0 = c; if (c > c1) c1 = c;
    }
    return count ? { r0: r0, r1: r1, c0: c0, c1: c1, count: count } : null;
  }
  /** rows (array of arrays) -> tab-delimited text. null/undefined/NaN -> empty string; no trailing tab or newline. */
  function toTsv(rows) {
    var out = [];
    if (!Array.isArray(rows)) return '';
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i] || [], line = [];
      for (var j = 0; j < row.length; j++) {
        var v = row[j];
        line.push(v == null || (typeof v === 'number' && v !== v) ? '' : String(v));
      }
      out.push(line.join('\t'));
    }
    return out.join('\n');
  }

  // ---- colour scale ------------------------------------------------------------------------------
  var PAL = {
    neutral: [22, 22, 26],        // sits on the table background: "no heat"
    red: [209, 19, 46],           // --red
    blue: [59, 130, 246],         // --dlv-blue
    green: [34, 197, 94],         // --green
    amber: [245, 166, 35],        // --amber
    count: [37, 99, 235]          // deeper blue for sample counts (never reads as "bad")
  };
  function lerp3(a, b, t) {
    return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];
  }
  function rgbStr(c) { return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')'; }
  function curve(t) { return Math.pow(clamp01(t), 0.8); }   // lifts the low-mid a touch; endpoints exact
  /**
   * colorFor(v, scale) -> 'rgb(r,g,b)' | null
   *   scale = { kind:'sequential'|'diverging', min, max, center, higherIsWorse:true|false|null, stat }
   *   sequential: higherIsWorse true  -> neutral at min .. red at max
   *               higherIsWorse false -> red at min .. neutral at max      (the RED end flips)
   *               null                -> neutral .. amber (heat, no judgement); stat 'count' -> neutral .. blue
   *   diverging:  blue below centre, neutral at centre, red above (red/blue swap when higherIsWorse === false)
   *   Values clamp to [min,max]. NaN / non-finite / unusable scale -> null (caller paints nothing).
   */
  function colorFor(v, scale) {
    if (!scale || !isFin(v) || !isFin(scale.min) || !isFin(scale.max)) return null;
    var min = scale.min, max = scale.max, t, span;
    if (scale.kind === 'diverging') {
      var c = isFin(scale.center) ? scale.center : 0;
      var flip = scale.higherIsWorse === false;
      if (v >= c) { span = max - c; t = span > 0 ? (v - c) / span : (v > c ? 1 : 0); return rgbStr(lerp3(PAL.neutral, flip ? PAL.blue : PAL.red, curve(t))); }
      span = c - min; t = span > 0 ? (c - v) / span : 1;
      return rgbStr(lerp3(PAL.neutral, flip ? PAL.red : PAL.blue, curve(t)));
    }
    span = max - min;
    if (!(span > 0)) return rgbStr(PAL.neutral);      // a constant table has no "worse" cell: paint no heat
    t = (v - min) / span;
    if (scale.stat === 'count') return rgbStr(lerp3(PAL.neutral, PAL.count, curve(t)));
    if (scale.higherIsWorse === true) return rgbStr(lerp3(PAL.neutral, PAL.red, curve(t)));
    if (scale.higherIsWorse === false) return rgbStr(lerp3(PAL.red, PAL.neutral, 1 - curve(1 - clamp01(t))));
    return rgbStr(lerp3(PAL.neutral, PAL.amber, curve(t)));
  }
  /** Build the scale for a result + statistic from def.colorScale (auto/manual) and Histogram.valueRange. */
  function makeScale(result, def, stat, minHits) {
    var cs = (def && isObj(def.colorScale)) ? def.colorScale : {};
    var hiw = cs.higherIsWorse === true ? true : (cs.higherIsWorse === false ? false : null);
    var s = (H() && H().normalizeStat(stat)) || 'average';
    var manual = cs.mode === 'manual';
    var min = manual && isFin(cs.min) ? cs.min : NaN, max = manual && isFin(cs.max) ? cs.max : NaN;
    var center = manual && isFin(cs.center) ? cs.center : NaN;
    var vr = (result && H()) ? H().valueRange(result, s, minHits) : { min: NaN, max: NaN, cells: 0 };
    if (!isFin(min)) min = vr.min;
    if (!isFin(max)) max = vr.max;
    var out = { kind: 'sequential', min: min, max: max, center: null, higherIsWorse: hiw, stat: s, manual: manual, empty: false };
    if (!isFin(min) || !isFin(max)) { out.empty = true; return out; }
    if (min > max) { var tmp = min; min = max; max = tmp; }
    var diverging = s !== 'count' && (isFin(center) || (min < 0 && max > 0));
    if (diverging) {
      if (!isFin(center)) center = 0;
      if (!manual) { var half = Math.max(Math.abs(max - center), Math.abs(center - min)); if (!(half > 0)) half = 1; min = center - half; max = center + half; }
      out.kind = 'diverging'; out.center = center;
    }
    out.min = min; out.max = max;
    return out;
  }
  /** CSS linear-gradient for the legend bar (sampled through colorFor so it always matches the cells). */
  function legendGradient(scale, stops) {
    if (!scale || scale.empty) return 'linear-gradient(90deg,#16161a,#16161a)';
    var n = stops || 16, parts = [];
    for (var i = 0; i <= n; i++) {
      var v = scale.min + (scale.max - scale.min) * (i / n);
      parts.push((colorFor(v, scale) || '#16161a') + ' ' + Math.round(i / n * 100) + '%');
    }
    return 'linear-gradient(90deg,' + parts.join(',') + ')';
  }

  // ================================================================================================
  // 2. Parameter resolver + filter compiler (the ctx Histogram.compute needs)
  // ================================================================================================
  function normName(s) { return String(s == null ? '' : s).toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim(); }
  /**
   * makeParamResolver(data, resolvedRoles, unitByChannel, mathChannelsList) -> resolver(param, slot) ->
   * {values, unit, levels, label, channel, source} | null
   *   Precedence: role -> channel name -> named math channel (param.mathChannelId) -> inline math
   *   (param.math). Also exposes:
   *     resolver.lookup(name)      expression-side channel lookup (exact name, then case-insensitive, then role id)
   *     resolver.resolveName(p)    concrete channel name for a {channel, role} param, or null
   *     resolver.mathStatus(expr)  { ok, error, missing } for a compiled math expression
   *     resolver.channels()        [{ name, unit, isText }] for replacement pickers
   *     resolver.data              the data object this resolver was built for (identity check)
   *   `mathChannelsList` (optional) is a FUNCTION returning the current [{id,name,expression,unit}]
   *   list, called fresh on every resolve -- so editing a named math channel in the manager takes
   *   effect immediately for every histogram referencing it, with no need to rebuild the resolver.
   */
  function makeParamResolver(data, resolvedRoles, unitByChannel, mathChannelsList) {
    data = data || {};
    var series = data.series || {}, levels = data.textLevels || {}, time = data.time || [];
    var channels = data.channels || Object.keys(series), roles = resolvedRoles || {}, units = unitByChannel || {};
    var n = time.length || (channels.length && series[channels[0]] ? series[channels[0]].length : 0);
    var byNorm = {};
    for (var i = 0; i < channels.length; i++) { var k = normName(channels[i]); if (byNorm[k] === undefined) byNorm[k] = channels[i]; }
    var mathCache = {};

    function has(name) { return !!(name && series[name] && typeof series[name].length === 'number'); }
    function entry(name, label, source) {
      return { values: series[name], unit: units[name] || null, levels: levels[name] || null, label: label || name, channel: name, source: source };
    }
    function resolveName(p) {
      if (!p) return null;
      if (typeof p === 'string') p = { channel: p };
      if (p.role && roles[p.role] && has(roles[p.role])) return roles[p.role];
      if (p.channel && has(p.channel)) return p.channel;
      if (p.channel && byNorm[normName(p.channel)] && has(byNorm[normName(p.channel)])) return byNorm[normName(p.channel)];
      return null;
    }
    // Math channels currently being compiled, by id: a channel whose expression references itself
    // (directly, or A -> B -> A) resolves to null instead of recursing forever.
    var compilingMath = {};
    function mathList() {
      if (typeof mathChannelsList !== 'function') return [];
      try { return mathChannelsList() || []; } catch (e) { return []; }
    }
    // Compile a NAMED math channel, honouring the cycle guard. null when it can't be evaluated here.
    function mathChannelValues(mc) {
      if (!mc || !mc.expression || compilingMath[mc.id]) return null;
      compilingMath[mc.id] = true;
      var cm;
      try { cm = compileMath(mc.expression); } finally { delete compilingMath[mc.id]; }
      return cm && cm.values ? cm : null;
    }
    function lookup(name) {
      if (has(name)) return entry(name, name, 'channel');
      var loose = byNorm[normName(name)];
      if (loose && has(loose)) return entry(loose, loose, 'channel');
      if (roles[name] && has(roles[name])) return entry(roles[name], roles[name], 'role');
      // A math channel referenced BY NAME from another expression (nested channels). The graphs
      // already allow this -- injected math channels are ordinary columns of the display set -- but
      // the histogram set is the full-resolution data where no injection happens, so resolve it here
      // (Ken, 2026-09-08: histogram of a nested math channel showed "missing parameter").
      var mc = H().mathChannelByRef(mathList(), name);
      if (mc) {
        var cm = mathChannelValues(mc);
        if (cm) return { values: cm.values, unit: mc.unit || null, levels: null, label: mc.name || name, channel: null, source: 'mathChannel' };
      }
      return null;
    }
    function compileMath(expr) {
      var c = mathCache[expr];
      if (c) return c;
      c = { ok: false, error: null, missing: [], values: null };
      if (!E()) { c.error = { message: 'DatalogExpr is not loaded', pos: 0 }; mathCache[expr] = c; return c; }
      var compiled = E().compile(expr, { resolve: lookup, time: time, n: n });
      c.ok = compiled.ok; c.error = compiled.error; c.missing = compiled.missing || [];
      if (compiled.ok && !c.missing.length) c.values = compiled.evaluateAll(0, n - 1);
      mathCache[expr] = c;
      return c;
    }
    // By id, then by name -- see Histogram.mathChannelByRef for why a stale id must still resolve.
    function getMathChannel(ref) { return H().mathChannelByRef(mathList(), ref); }
    function resolver(param) {
      if (!param) return null;
      var name = resolveName(param);
      // a label makeParam auto-filled from the ROLE id ("engine_rpm") is not a display name; use the channel's
      if (name) return entry(name, (param.label && param.label !== param.role) ? param.label : name, (param.role && roles[param.role] === name) ? 'role' : 'channel');
      // A by-NAME reference to a named math channel ({channel:'Total Fuel Trim 1'} -- what a paged
      // "Total Fuel Trim {n}" parameter becomes once the page is filled in): not a column of this set,
      // so resolve it through the math list exactly as lookup() does for expressions (Ken, 2026-09-09).
      if (param.channel && !param.mathChannelId) {
        var mcByName = getMathChannel(param.channel);
        if (mcByName && mcByName.expression) {
          var cmb = mathChannelValues(mcByName);
          if (cmb) return { values: cmb.values, unit: (param.unit || mcByName.unit) || null, levels: null, label: (param.label && param.label !== param.role) ? param.label : (mcByName.name || param.channel), channel: null, source: 'mathChannel' };
        }
      }
      if (param.mathChannelId) {
        // Id, then the id as a name, then the param's LABEL (the picker stores the channel's name
        // there): an orphaned id from a reloaded layout still lands on the live channel of that name.
        var mc = getMathChannel(param.mathChannelId) || (param.label ? getMathChannel(param.label) : null);
        // Deleted or renamed-away-from math channel: fall through to null (missing_parameter), never
        // a stale copy of an expression that no longer exists.
        if (!mc || !mc.expression) return null;
        var cm = mathChannelValues(mc);
        if (!cm) return null;
        return { values: cm.values, unit: (param.unit || mc.unit) || null, levels: null, label: param.label || mc.name || mc.expression, channel: null, source: 'mathChannel' };
      }
      if (param.math) {
        var c = compileMath(param.math);
        if (!c.values) return null;
        return { values: c.values, unit: param.unit || null, levels: null, label: param.label || param.math, channel: null, source: 'math' };
      }
      return null;
    }
    resolver.lookup = lookup;
    resolver.mathChannel = getMathChannel;
    resolver.resolveName = resolveName;
    resolver.mathStatus = function (expr) { var c = compileMath(expr); return { ok: c.ok, error: c.error, missing: c.missing }; };
    resolver.channels = function () {
      var out = [];
      for (var j = 0; j < channels.length; j++) if (has(channels[j])) out.push({ name: channels[j], unit: units[channels[j]] || '', isText: !!levels[channels[j]] });
      return out;
    };
    resolver.data = data;
    resolver.n = n;
    return resolver;
  }

  /** Clause params may be a name, a {channel, role} object, or a name + sibling `role`; rewrite each to a concrete channel. */
  function resolveClauses(clauses, resolver, missing) {
    var out = [];
    for (var k = 0; k < clauses.length; k++) {
      var c = clauses[k];
      if (Array.isArray(c)) { out.push(resolveClauses(c, resolver, missing)); continue; }
      if (!c) continue;
      if (Array.isArray(c.group)) { out.push({ group: resolveClauses(c.group, resolver, missing), join: c.join }); continue; }
      var copy = {}; for (var key in c) if (Object.prototype.hasOwnProperty.call(c, key)) copy[key] = c[key];
      var p = c.param;
      var pobj = isObj(p) ? p : { channel: typeof p === 'string' ? p : null, role: c.role || null };
      if (isObj(p) && !pobj.role && c.role) pobj = { channel: pobj.channel, role: c.role };
      var hit = resolver.resolveName(pobj);
      if (hit) copy.param = hit;
      else { copy.param = pobj.channel || pobj.role || ''; if (copy.param && missing.indexOf(copy.param) < 0) missing.push(copy.param); }
      out.push(copy);
    }
    return out;
  }
  /**
   * compileFilter(def, data, resolver) -> { mask:Uint8Array|null, source, error, missing:string[] }
   *   mask null = no filter (empty / absent) or unusable (error or missing channel; caller decides).
   */
  function compileFilter(def, data, resolver) {
    var none = { mask: null, source: null, error: null, missing: [] };
    var f = def && isObj(def.filter) ? def.filter : null;
    if (!f || !E()) return none;
    var src, missing = [];
    if (f.mode === 'simple') {
      if (!Array.isArray(f.clauses) || !f.clauses.length) return none;
      // buildSimpleFilter throws on a channel name it cannot write as a reference (one containing
      // both ']' and '"'). Surface that as a filter error on the table, never as an exception that
      // takes the whole view down.
      try { src = E().buildSimpleFilter(resolveClauses(f.clauses, resolver, missing)); }
      catch (e) { return { mask: null, source: '', error: { message: e && e.message ? e.message : String(e), pos: 0 }, missing: missing }; }
    } else src = f.expression;
    if (typeof src !== 'string' || !src.replace(/\s/g, '')) return none;
    var n = resolver.n || (data && data.time ? data.time.length : 0);
    var compiled = E().compile(src, { resolve: resolver.lookup, time: data ? data.time : [], n: n });
    if (!compiled.ok) return { mask: null, source: src, error: compiled.error, missing: missing };
    for (var i = 0; i < compiled.missing.length; i++) if (missing.indexOf(compiled.missing[i]) < 0) missing.push(compiled.missing[i]);
    if (missing.length) return { mask: null, source: src, error: null, missing: missing };
    return { mask: compiled.evaluateMask(0, n - 1), source: src, error: null, missing: [] };
  }

  // ================================================================================================
  // 3. Example definitions (Ken's fixtures; fresh copies every call)
  // ================================================================================================
  /** A default, reusable math channel definition. Fresh id each call (like Histogram.makeDef). */
  function newMcId() { return 'mc_' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6); }
  /**
   * EXAMPLE_MATH_CHANNELS() -> [{id, name, expression, unit}]
   *   Common, broadly-useful calculated channels a tuner reaches for immediately -- expressions use
   *   ROLE ids (e.g. [lambda_bank_1]) rather than literal channel names, so they resolve on whatever
   *   log is open (DatalogExpr falls back to a role lookup for an unresolved bracket reference; see
   *   makeParamResolver's `lookup`). "Load starter set" seeds these once (merged by name, never
   *   duplicated) alongside EXAMPLE_DEFS.
   */
  function EXAMPLE_MATH_CHANNELS() {
    return [
      { id: newMcId(), name: 'Lambda Error % (Bank 1)', expression: '(([lambda_bank_1] / [commanded_lambda]) - 1) * 100', unit: '%' },
      { id: newMcId(), name: 'Lambda Error % (Bank 2)', expression: '(([lambda_bank_2] / [commanded_lambda]) - 1) * 100', unit: '%' },
      { id: newMcId(), name: 'Total Fuel Trim (Bank 1)', expression: '[stft_bank_1] + [ltft_bank_1]', unit: '%' },
      { id: newMcId(), name: 'Total Fuel Trim (Bank 2)', expression: '[stft_bank_2] + [ltft_bank_2]', unit: '%' },
      { id: newMcId(), name: 'Bank-to-Bank Lambda Imbalance', expression: '[lambda_bank_1] - [lambda_bank_2]', unit: null }
    ];
  }
  /**
   * EXAMPLE_DEFS(mathChannelIdByName) -> [Knock–RPM-vs-Airmass, MAF Lambda Error, 10R80 Slip]
   *   Ken's spec fixtures (§36-38). `mathChannelIdByName` is optional: when it maps 'Lambda Error %
   *   (Bank 1)' to an id, the MAF Lambda Error example REFERENCES that named math channel
   *   (mathChannelId) instead of carrying its own inline copy of the expression -- demonstrating the
   *   reuse a named channel is for. Called with no argument (tests, or a host with no math-channel
   *   store) it falls back to the original inline expression, unchanged.
   */
  function EXAMPLE_DEFS(mathChannelIdByName) {
    var mk = H().makeDef;
    var lambdaErrId = mathChannelIdByName && mathChannelIdByName['Lambda Error % (Bank 1)'];
    return [
      mk({
        name: 'Knock – RPM vs Airmass', description: 'Peak knock retard by RPM and cylinder airmass, throttle above 50%',
        cellParameter: { role: 'total_knock', channel: 'Knock Retard', label: 'Knock Retard' },
        columnAxis: { parameter: { role: 'engine_rpm', channel: 'Engine RPM', label: 'Engine RPM' }, unit: 'rpm', breakpoints: seq(1000, 7500, 500) },
        rowAxis: { parameter: { channel: 'Cylinder Airmass', label: 'Cylinder Airmass' }, unit: 'g/cyl', breakpoints: seq(0.2, 1.4, 0.1) },
        statistic: 'maximum', minimumHits: 3,
        filter: { mode: 'simple', clauses: [{ param: 'Throttle Position', role: 'throttle_position', op: '>', value: 50 }], expression: null },
        colorScale: { mode: 'auto', min: null, center: null, max: null, higherIsWorse: true }
      }),
      mk({
        name: 'MAF Lambda Error', description: 'Percent lambda error vs MAF frequency, engine warm',
        cellParameter: lambdaErrId
          ? { mathChannelId: lambdaErrId, unit: '%', label: 'Lambda Error % (Bank 1)' }
          : { math: '(([Lambda Bank 1] / [Commanded Lambda]) - 1) * 100', unit: '%', label: 'Lambda Error' },
        columnAxis: { parameter: { channel: 'MAF Frequency', label: 'MAF Frequency' }, unit: 'Hz', breakpoints: seq(1000, 12000, 500) },
        rowAxis: null, statistic: 'average', minimumHits: 10,
        filter: { mode: 'advanced', clauses: null, expression: '[Engine Coolant Temp] > 170' },
        colorScale: { mode: 'auto', min: null, center: null, max: null, higherIsWorse: null }
      }),
      mk({
        name: '10R80 Slip', description: 'Converter slip (engine RPM minus input shaft RPM) by RPM and gear',
        cellParameter: { math: '[engine_rpm] - [Trans Input Shaft RPM B]', unit: 'rpm', label: 'Converter Slip' },
        columnAxis: { parameter: { role: 'engine_rpm', channel: 'Engine RPM', label: 'Engine RPM' }, unit: 'rpm', breakpoints: seq(1000, 7000, 500) },
        rowAxis: { parameter: { role: 'current_gear', channel: 'Trans Commanded Gear', label: 'Gear' }, breakpoints: seq(1, 10, 1),
          categories: ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th'] },
        statistic: 'maximum', minimumHits: 5,
        colorScale: { mode: 'auto', min: null, center: null, max: null, higherIsWorse: true }
      })
    ];
  }

  // ================================================================================================
  // 4. DOM layer (browser only)
  // ================================================================================================
  // 'weighted' is only shown when the active def has a weight parameter (syncToolbar hides it).
  var STAT_BUTTONS = [['average', 'Average'], ['weighted', 'Weighted'], ['minimum', 'Minimum'], ['maximum', 'Maximum'], ['last', 'Last'], ['count', 'Count']];
  var RANGE_DEBOUNCE_MS = 80, TIP_DELAY_MS = 150;

  function attachDomLayer(UI) {
    function isEditable(node) {
      if (!node || node === document.body) return false;
      var t = node.tagName;
      return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || !!node.isContentEditable;
    }
    function closestAttr(node, attr, stopAt) {
      while (node && node !== stopAt && node.nodeType === 1) { if (node.hasAttribute && node.hasAttribute(attr)) return node; node = node.parentNode; }
      return null;
    }
    function now() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }
    function typeBadge(def) { return def.type === 'distribution' ? 'DIST' : (def.rowAxis ? '2D' : '1D'); }
    function paramLabel(p) { return p ? (p.label || p.channel || p.role || p.math || '?') : '?'; }

    function shellHtml() {
      var stat = '';
      for (var i = 0; i < STAT_BUTTONS.length; i++) stat += '<button type="button" data-v="' + STAT_BUTTONS[i][0] + '">' + STAT_BUTTONS[i][1] + '</button>';
      return '' +
        '<div class="dlv-hist-list">' +
          '<div class="dlv-hist-list-head"><span class="dlv-hist-list-title">Histograms</span>' +
            '<button type="button" class="dlv-hist-btn dlv-hist-add" data-a="add" title="Add a histogram">+ Add</button>' +
            '<button type="button" class="dlv-hist-ibtn" data-a="listmenu" title="Import / export / examples">⋯</button>' +
            '<button type="button" class="dlv-hist-ibtn" data-a="collapse" title="Collapse the list">‹</button></div>' +
          '<div class="dlv-hist-list-rows"></div>' +
          '<input type="file" class="dlv-hist-file" accept=".json,.xml,application/json,text/xml" hidden>' +
        '</div>' +
        '<button type="button" class="dlv-hist-expander" data-a="expand" title="Show the histogram list" hidden>›</button>' +
        '<div class="dlv-hist-main">' +
          '<div class="dlv-hist-toolbar">' +
            '<select class="dlv-hist-defsel" title="Histogram"></select>' +
            '<button type="button" class="dlv-hist-btn" data-a="edit" title="Edit this histogram">Edit</button>' +
            // Pages: one def cycled through a numbered channel family (Mapped Point {n} Weight...).
            // Hidden unless the active def has pages; ← → on the keyboard do the same as the arrows.
            '<span class="dlv-hist-pager" hidden>' +
              '<button type="button" class="dlv-hist-ibtn dlv-hist-page-arrow" data-a="pageprev" title="Previous page (←)">◀</button>' +
              '<button type="button" class="dlv-hist-page-lbl" data-a="pagemenu" title="Click to jump to a page"><b class="dlv-hist-page-name"></b><span class="dlv-hist-page-count"></span></button>' +
              '<button type="button" class="dlv-hist-ibtn dlv-hist-page-arrow" data-a="pagenext" title="Next page (→)">▶</button>' +
              '<button type="button" class="dlv-hist-pill dlv-hist-page-owner" data-a="pageowner" title="Owner map: which page dominates each cell, across every page">Owners</button>' +
              '<select class="dlv-hist-mini dlv-hist-owner-by" data-f="ownerby" title="What decides the owner of a cell" hidden>' +
                '<option value="weight">by weight</option><option value="count">by samples</option><option value="sum">by total value</option>' +
                '<option value="max">by peak value</option><option value="active">by active samples</option></select>' +
            '</span>' +
            '<span class="dlv-hist-grp"><span class="dlv-hist-lbl">Statistic</span><span class="dlv-hist-seg" data-seg="stat">' + stat + '</span></span>' +
            '<span class="dlv-hist-grp"><span class="dlv-hist-lbl">Range</span><span class="dlv-hist-seg" data-seg="range">' +
              '<button type="button" data-v="entire">Entire Log</button><button type="button" data-v="selection">Selection</button></span></span>' +
            '<span class="dlv-hist-grp"><span class="dlv-hist-lbl">Min Hits</span><input type="number" min="0" step="1" class="dlv-hist-num" data-f="minhits" title="Cells with fewer samples are dimmed (0 = off)"></span>' +
            '<button type="button" class="dlv-hist-pill" data-a="lowcount" title="Show the value in low-count cells">Show Low-Count</button>' +
            '<span class="dlv-hist-grp"><span class="dlv-hist-lbl">Color</span><span class="dlv-hist-seg" data-seg="color">' +
              '<button type="button" data-v="auto">Auto</button><button type="button" data-v="manual">Manual</button></span>' +
              '<span class="dlv-hist-manual" hidden><input type="number" step="any" class="dlv-hist-num" data-f="cmin" placeholder="min" title="Scale minimum">' +
              '<input type="number" step="any" class="dlv-hist-num" data-f="ccenter" placeholder="center" title="Scale centre (blank = none)">' +
              '<input type="number" step="any" class="dlv-hist-num" data-f="cmax" placeholder="max" title="Scale maximum"></span>' +
              '<select class="dlv-hist-mini" data-f="redend" title="Which end of the scale reads as bad (red)">' +
                '<option value="high">Red: high</option><option value="low">Red: low</option><option value="none">Red: off</option></select></span>' +
            '<button type="button" class="dlv-hist-pill" data-a="invert" title="Swap rows and columns">Invert Axes</button>' +
            '<span class="dlv-hist-grp"><button type="button" class="dlv-hist-btn" data-a="copy" title="Copy the selected cells (Ctrl+C)">Copy</button>' +
              '<button type="button" class="dlv-hist-btn" data-a="copyaxis" title="Copy with the axis labels">Copy With Axis</button>' +
              '<button type="button" class="dlv-hist-btn" data-a="clear" title="Recompute from the log">Clear</button></span>' +
            '<span class="dlv-hist-samples"></span>' +
          '</div>' +
          '<div class="dlv-hist-legend"></div>' +
          '<div class="dlv-hist-warn" hidden></div>' +
          // The table scrolls in a transparent wrap over a back layer the HOST may fill (gauges behind
          // the table, Ken 2026-09-09) -- the table itself is opaque, so where it extends it covers them.
          '<div class="dlv-hist-tablearea"><div class="dlv-hist-back" aria-hidden="true"></div><div class="dlv-hist-tablewrap" tabindex="0"></div></div>' +
          '<div class="dlv-hist-details"></div>' +
        '</div>';
    }

    UI.mount = function (hostEl, glue) {
      glue = glue || {};
      var esc = typeof glue.escapeHtml === 'function' ? glue.escapeHtml : localEsc;
      var toast = typeof glue.toast === 'function' ? glue.toast : function (m) { if (global.console) console.log('[histogram] ' + m); };
      var S = {
        defs: [], activeId: null, resolver: null, entries: {}, filterCache: {},
        base: null, view: null, R: 0, C: 0, cells: [], rowHeads: [], colHeads: [],
        sel: null, pendingSel: null, anchor: null, detail: null, missing: null, dec: 1, scale: null, statTable: null,
        drag: null, mouseInside: false, rangeTimer: null, tip: null, tipTimer: null, menu: null,
        computeCount: 0, lastElapsed: 0, destroyed: false, listCollapsed: false, unsub: [],
        cursorTime: null,
        owner: null, ownerPages: null           // the owner map (Histogram.ownerTable) when that view is on
      };
      hostEl.classList.add('dlv-hist');
      hostEl.innerHTML = shellHtml();
      function Q(sel) { return hostEl.querySelector(sel); }
      var D = {
        list: Q('.dlv-hist-list'), rows: Q('.dlv-hist-list-rows'), expander: Q('.dlv-hist-expander'), file: Q('.dlv-hist-file'),
        tb: Q('.dlv-hist-toolbar'), defsel: Q('.dlv-hist-defsel'), legend: Q('.dlv-hist-legend'), warn: Q('.dlv-hist-warn'),
        wrap: Q('.dlv-hist-tablewrap'), details: Q('.dlv-hist-details'), samples: Q('.dlv-hist-samples'), manual: Q('.dlv-hist-manual'),
        pager: Q('.dlv-hist-pager'), pageName: Q('.dlv-hist-page-name'), pageCount: Q('.dlv-hist-page-count'),
        back: Q('.dlv-hist-back')
      };
      // The live cursor mark is one persistent element, re-attached to D.wrap after every renderTable()
      // wipes it out with a fresh innerHTML -- creating it once here (rather than per-render) means
      // applyCursorMark() never has to recreate it, only reposition it.
      D.cursorMark = document.createElement('div');
      D.cursorMark.className = 'dlv-hist-cursor-mark';
      D.cursorMark.hidden = true;

      // ---- def access ------------------------------------------------------------------------------
      // The painted table's footprint inside the pane (clipped to the scroll wrap), or null when a state
      // panel is showing. The host lays its back-layer gauges out around it (Ken, 2026-09-09: "a large 1D
      // histogram collides with the gauges I have to the right ... move gauges down if needed").
      function tableFootprint() {
        var t = D.wrap ? D.wrap.querySelector('table.dlv-hist-table') : null;
        if (!t) return null;
        var w = Math.min(t.offsetWidth, D.wrap.clientWidth), h = Math.min(t.offsetHeight, D.wrap.clientHeight);
        return (w > 0 && h > 0) ? { w: w, h: h, tableW: t.offsetWidth, tableH: t.offsetHeight } : null;
      }
      // After EVERY render of the active view (table, owner map, state panel) the host may re-fit
      // whatever it keeps behind the table; renderActive() below funnels all of them through here.
      function notifyLayout() {
        if (S.destroyed || typeof glue.onTableLayout !== 'function') return;
        try { glue.onTableLayout(tableFootprint()); } catch (e) { if (global.console) console.warn('[histogram] onTableLayout failed', e); }
      }
      function defById(id) { for (var i = 0; i < S.defs.length; i++) if (S.defs[i].id === id) return S.defs[i]; return null; }
      function defIndex(id) { for (var i = 0; i < S.defs.length; i++) if (S.defs[i].id === id) return i; return -1; }
      function activeDef() { return defById(S.activeId); }
      function changed() { if (typeof glue.defsChanged === 'function') { try { glue.defsChanged(S.defs); } catch (e) { if (global.console) console.error(e); } } }
      // Entries are keyed by def id, or "id#page" for a paged def (one computed result per page, so
      // stepping back to a page you already looked at is instant) -- dirtying a def drops all of them.
      function markDirty(id) {
        if (id == null) { S.entries = {}; return; }
        delete S.entries[id];
        var prefix = id + '#';
        Object.keys(S.entries).forEach(function (k) { if (k.indexOf(prefix) === 0) delete S.entries[k]; });
      }
      // ---- pages -------------------------------------------------------------------------------------
      // A def with `pages` is a template: {n} in its filter / parameters / name stands for the current
      // page value (Histogram.applyPage). Everything below that computes, lists or validates a def
      // goes through effectiveDef() so the concrete, current-page def is what gets binned.
      function channelNames() {
        var data = null;
        try { data = ensureData(); } catch (e) { data = null; }
        var names = data ? (data.channels || Object.keys(data.series || {})).slice() : [];
        // Named math channels page too -- "Total Fuel Trim {n}" over Total Fuel Trim 1 / 2 (Ken,
        // 2026-09-09). They are not columns of the histogram data set, so add their names for {n}
        // discovery; the resolver maps each page's name back to the math channel.
        mathNames().forEach(function (nm) { if (names.indexOf(nm) < 0) names.push(nm); });
        return names;
      }
      function mathListSafe() {
        try { return (glue.mathChannels && typeof glue.mathChannels.list === 'function') ? (glue.mathChannels.list() || []) : []; } catch (e) { return []; }
      }
      function mathNames() { return mathListSafe().map(function (m) { return m && m.name; }).filter(Boolean); }
      function mathNameMap() { var out = {}; mathListSafe().forEach(function (m) { if (m && m.id != null) out[m.id] = m.name || ''; }); return out; }
      function pageInfo(def) {
        if (!def || !H().usesPages(def)) return null;
        var values = H().pageValues(def, channelNames());
        var cur = H().currentPage(def, values), idx = -1;
        for (var i = 0; i < values.length; i++) if (H().samePage(values[i], cur)) { idx = i; break; }
        return { values: values, current: cur, index: idx, label: H().pageLabel(def, cur) };
      }
      function effectiveDef(def) {
        var pi = pageInfo(def);
        return (pi && pi.current != null) ? H().applyPage(def, pi.current) : def;
      }
      function displayName(def) {
        if (!def) return '';
        var pi = pageInfo(def);
        return (pi && pi.current != null) ? H().substitutePage(def.name, pi.current) : def.name;
      }
      function setPage(def, value) {
        if (!def || !isObj(def.pages) || value == null) return;
        if (H().samePage(def.pages.current, value)) return;
        def.pages.current = value;
        changed();
        renderList();                                   // the row + toolbar select show the page's name
        if (def.id === S.activeId) renderActive('page');
      }
      function stepPage(def, delta) {
        var pi = pageInfo(def);
        if (!pi || !pi.values.length) return;
        var i = pi.index < 0 ? 0 : (pi.index + delta + pi.values.length) % pi.values.length;
        setPage(def, pi.values[i]);
      }
      function pageMenuItems(def) {
        var pi = pageInfo(def), items = [];
        if (!pi) return items;
        if (!pi.values.length) return [{ label: 'No channel in this log matches ' + def.pages.pattern, disabled: true }];
        pi.values.forEach(function (v, i) {
          items.push({ label: (i === pi.index ? '✓ ' : ' ') + H().pageLabel(def, v), action: function () { setPage(def, v); } });
        });
        return items;
      }
      // Fold MP0 FT / MP1 FT / ... (tables that differ only by one number in a channel name) into one
      // paged def each. Offered from the list menu, and run automatically on an HP Tuners layout import.
      function combinePages(defs, interactive) {
        var r = H().collapsePaged(defs);
        if (!r.collapsed.length) {
          if (interactive) toast('No numbered families found — tables that differ only by a number in a channel name (Mapped Point 3 / 4 / 5 Weight…) can be combined.');
          return null;
        }
        var what = r.collapsed.map(function (c) { return '"' + c.name + '" (' + c.count + ' tables, ' + H().pageLabel({ pages: { pattern: c.pattern } }, c.values[0]) + ' – ' + H().pageLabel({ pages: { pattern: c.pattern } }, c.values[c.values.length - 1]) + ')'; });
        if (interactive) {
          var okGo = true;
          try { okGo = window.confirm('Combine into paged histograms?\n\n' + what.join('\n') + '\n\nThe separate tables are replaced by one table with ◀ ▶ page arrows.'); } catch (e) { okGo = true; }
          if (!okGo) return null;
        }
        return r;
      }
      // ---- owner map: which page dominates each cell -------------------------------------------------
      function ownerModeOf(def) { return !!(def && isObj(def.display) && def.display.pageView === 'owner'); }
      // What "owns" a cell (Histogram.OWNER_MODES): the def's saved choice, else a default from its
      // shape -- a weight parameter means blend weights; a paged CELL parameter (Knock Cyl {n})
      // means the page's own value is the action; pages that differ only by filter mean samples.
      function defaultOwnerBy(def) {
        if (def.weightParameter) return 'weight';
        if (H().pageVarUses(def).indexOf('cell parameter') >= 0) return 'sum';
        return 'count';
      }
      function ownerByOf(def) {
        var m = def && isObj(def.display) ? def.display.ownerBy : null;
        return (m && H().OWNER_MODES.indexOf(m) >= 0) ? m : defaultOwnerBy(def);
      }
      var OWNER_BY_TEXT = { weight: 'most weight in the cell', count: 'most samples in the cell', sum: 'largest total |value| in the cell', max: 'highest peak |value| in the cell', active: 'most samples with a non-zero value' };
      function ownerMassText(b, mode, unit) {
        var u = unit ? ' ' + esc(displayUnit(unit)) : '';
        if (mode === 'sum') return 'Σ ' + fmtK(Number(b.mass.toFixed(b.mass >= 100 ? 0 : 1))) + u;
        if (mode === 'max') return 'peak ' + formatValue(b.mass, b.mass >= 100 ? 0 : 2) + u;
        if (mode === 'weight') return 'Σw ' + fmtK(Math.round(b.mass));
        return fmtK(b.mass) + ' sample' + (b.mass === 1 ? '' : 's');
      }
      function setOwnerMode(def, on) {
        if (!def) return;
        if (!isObj(def.display)) def.display = {};
        if (on) def.display.pageView = 'owner'; else delete def.display.pageView;
        changed(); S.owner = null; S.ownerPages = null;
        if (def.id === S.activeId) renderActive('owner');
      }
      function ownerColor(i, share) {
        var hue = (i * 137.508) % 360, a = isFin(share) ? 0.32 + 0.6 * Math.max(0, Math.min(1, share)) : 0.32;
        return 'hsla(' + hue.toFixed(1) + ',62%,46%,' + a.toFixed(2) + ')';
      }
      function renderOwnerView(def, pi, reason) {
        var data = ensureData();
        if (!data) { statePanel('', 'No datalog loaded', 'Open a log to compute this histogram.'); return; }
        if (!pi.values.length) { statePanel('', 'No pages on this log', 'No channel in this log matches ' + esc(def.pages.pattern) + '.'); return; }
        var inverted = def.orientation === 'inverted', pages = [], skipped = [];
        for (var i = 0; i < pi.values.length; i++) {
          var v = pi.values[i], e = ensureEntry(def, reason, v);
          if (e.state !== 'ok' || !e.result || !e.result.cells) { skipped.push(H().pageLabel(def, v) + (e.state === 'missing' ? ' (missing parameter)' : e.state === 'filter_error' ? ' (filter error)' : '')); continue; }
          var view = e.result;
          if (inverted && view.rows) { if (!e.viewT) e.viewT = H().transposeResult(e.result); view = e.viewT; }
          pages.push({ page: v, label: H().pageLabel(def, v), result: view, entry: e });
        }
        if (!pages.length) { statePanel('dlv-hist-missing', 'No page could be computed', esc(skipped.join(' · ')), '<button type="button" class="dlv-hist-btn primary" data-a="edit">Edit…</button>'); return; }
        var owner = H().ownerTable(pages, { mass: ownerByOf(def) }), first = pages[0].result;
        var sameShape = S.view && S.owner && S.R === first.shape.rows && S.C === first.shape.cols;
        var keepSel = sameShape ? S.sel : null;
        S.base = first;
        renderTable(first);
        if (keepSel) S.sel = keepSel;
        S.owner = owner; S.ownerPages = pages;
        applyOwnerCells(def);
        applySelection();
        applyCursorMark();
        var w = [];
        if (skipped.length) w.push('Skipped ' + skipped.join(', '));
        if (owner.skipped.length) w.push('Different table shape on ' + owner.skipped.length + ' page(s)');
        if (w.length) { D.warn.innerHTML = '<span class="dlv-hist-warn-ico">⚠</span> ' + esc(w.join(' · ')); D.warn.hidden = false; }
        var reached = 0;
        for (var k = 0; k < owner.owner.length; k++) if (owner.owner[k] >= 0) reached++;
        D.samples.innerHTML = '<span><b>' + pages.length + '</b> pages · <b>' + reached + '</b> of ' + owner.owner.length + ' cells reached</span>';
        if (S.detail && S.detail.r < S.R && S.detail.c < S.C) renderDetails(S.detail.r, S.detail.c); else renderDetails();
      }
      function applyOwnerCells(def) {
        var o = S.owner, mh = minHitsOf(def);
        if (!o || !S.cells.length) return;
        S.statTable = null; S.scale = null; S.dec = 0;
        for (var k = 0; k < S.cells.length; k++) {
          var td = S.cells[k], i = o.owner[k], cls = '', text = '—', bg = '';
          // samples landed on some page but none of them carried any value/weight (no knock here)
          if (i < 0 && o.hits[k] > 0) { cls = 'dlv-hist-cell-low'; text = '0'; }
          else if (i < 0) cls = 'dlv-hist-cell-empty';
          else {
            text = o.pages[i].label;
            cls = 'dlv-hist-cell-owner';
            if (o.hits[k] < mh) cls += ' dlv-hist-cell-low';
            else bg = ownerColor(i, o.share[k]);
          }
          if (S.sel && S.sel[k]) cls += ' dlv-hist-sel';
          td.className = cls; td.textContent = text; td.style.background = bg;
        }
        renderOwnerLegend();
      }
      function renderOwnerLegend() {
        var o = S.owner, present = {}, k;
        for (k = 0; k < o.owner.length; k++) if (o.owner[k] >= 0) present[o.owner[k]] = (present[o.owner[k]] || 0) + 1;
        var html = '<span class="dlv-hist-legend-stat">Owner · ' + esc(OWNER_BY_TEXT[o.mode] || OWNER_BY_TEXT.count) + '</span>';
        var idx = Object.keys(present).map(Number).sort(function (a, b) { return a - b; });
        idx.slice(0, 16).forEach(function (i) { html += '<span class="dlv-hist-legend-sw"><i style="background:' + ownerColor(i, 1) + '"></i>' + esc(o.pages[i].label) + '<small>' + present[i] + '</small></span>'; });
        if (idx.length > 16) html += '<span class="dlv-hist-legend-c">+' + (idx.length - 16) + ' more</span>';
        html += '<span class="dlv-hist-legend-note">stronger colour = bigger share · click a cell for the split</span>';
        D.legend.innerHTML = html;
      }
      function ownerTooltipHtml(r, c) {
        var view = S.view, k = r * S.C + c, o = S.owner;
        var head = '<div class="dlv-hist-tip-head">' + axisText(view, 'col', c) + (view.rows ? '<br>' + axisText(view, 'row', r) : '') + '</div>';
        if (o.owner[k] < 0) return head + '<div class="dlv-hist-tip-row">' + (o.hits[k] > 0 ? 'Samples on ' + fmtK(Math.round(o.hits[k])) + ' hits, but no value on any page' : 'No samples on any page') + '</div>';
        var mh = minHitsOf(activeDef());
        return head + '<div class="dlv-hist-tip-grid">' +
          o.breakdown(k).slice(0, 6).map(function (b) { return '<span>' + esc(b.label) + '</span><b>' + Math.round(b.share * 100) + '% <i>' + ownerMassText(b, o.mode, view.cellUnit) + '</i></b>'; }).join('') +
          '<span>Hits</span><b>' + fmtK(Math.round(o.hits[k])) + (o.hits[k] < mh ? ' <i>(below ' + mh + ')</i>' : '') + '</b></div>';
      }
      function ownerDetails(r, c) {
        var view = S.view, k = r * S.C + c, o = S.owner;
        S.detail = { r: r, c: c };
        var html = '<span class="dlv-hist-d-axis">' + axisText(view, 'col', c) + (view.rows ? ' · ' + axisText(view, 'row', r) : '') + '</span>';
        if (o.owner[k] < 0) { D.details.innerHTML = html + '<span class="dlv-hist-d-hint">' + (o.hits[k] > 0 ? 'Samples here on ' + fmtK(Math.round(o.hits[k])) + ' hits, but no page carried a value' : 'No samples in this cell on any page') + '</span>'; return; }
        var rows = o.breakdown(k);
        rows.slice(0, 8).forEach(function (b) {
          html += '<span class="dlv-hist-d-owner"><i style="background:' + ownerColor(b.index, 1) + '"></i><b>' + esc(b.label) + '</b>' + Math.round(b.share * 100) + '% <span class="dlv-hist-d-hint">' + ownerMassText(b, o.mode, view.cellUnit) + '</span>' +
            '<button type="button" class="dlv-hist-link" data-gopage="' + esc(String(b.page)) + '" title="Show this page\'s table">open</button></span>';
        });
        if (rows.length > 8) html += '<span class="dlv-hist-d-hint">+' + (rows.length - 8) + ' more</span>';
        html += '<span class="dlv-hist-d-hint">' + fmtK(Math.round(o.hits[k])) + ' hits across all pages</span>';
        D.details.innerHTML = html;
      }
      function ownerCopyRows(withAxis) {
        var view = S.view, o = S.owner, rows = [], r, c, line;
        var axDec = axisDecimalsFor(activeDef());
        if (withAxis) {
          line = [cornerLabel(view)];
          for (c = 0; c < S.C; c++) line.push(roundAxisLabel(view.columns[c].label, axDec));
          rows.push(line);
        }
        for (r = 0; r < S.R; r++) {
          line = withAxis ? [view.rows ? roundAxisLabel(view.rows[r].label, axDec) : 'Owner'] : [];
          for (c = 0; c < S.C; c++) { var k = r * S.C + c, i = o.owner[k]; line.push(i < 0 ? '' : o.pages[i].label + ' ' + Math.round(o.share[k] * 100) + '%'); }
          rows.push(line);
        }
        return rows;
      }
      function goToPage(def, raw) {
        var pi = pageInfo(def);
        if (!pi) return;
        var hit = null;
        for (var i = 0; i < pi.values.length; i++) if (H().samePage(pi.values[i], raw)) { hit = pi.values[i]; break; }
        if (hit == null) return;
        if (isObj(def.display)) delete def.display.pageView;
        S.owner = null; S.ownerPages = null;
        def.pages.current = hit;
        changed(); renderList(); renderActive('page');
      }
      function combinePagesInList() {
        var r = combinePages(S.defs, true);
        if (!r) return;
        S.defs = r.defs; S.entries = {}; changed(); renderList(); activate(r.collapsed[0].id, true);
        toast('Combined ' + r.collapsed.map(function (c) { return c.count + ' tables into "' + c.name + '"'; }).join(', ') + ' — use ◀ ▶ to change page');
      }
      function statOf(def) { return (def && H().normalizeStat(def.statistic)) || 'average'; }
      function minHitsOf(def) { return def && isFin(def.minimumHits) ? Math.max(0, def.minimumHits) : 0; }
      function showLowOf(def) { return !(def && def.display && def.display.showLowCount === false); }

      // ---- data / resolver ---------------------------------------------------------------------------
      function ensureData() {
        var data = null;
        try { data = typeof glue.data === 'function' ? glue.data() : null; } catch (e) { data = null; }
        if (!data || !data.time || !data.time.length) { S.resolver = null; return null; }
        if (!S.resolver || S.resolver.data !== data) {
          var roles = {}, units = {};
          try { roles = (typeof glue.resolvedRoles === 'function' && glue.resolvedRoles()) || {}; } catch (e1) { roles = {}; }
          try { units = (typeof glue.unitByChannel === 'function' && glue.unitByChannel()) || {}; } catch (e2) { units = {}; }
          var mcList = (glue.mathChannels && typeof glue.mathChannels.list === 'function') ? glue.mathChannels.list : null;
          S.resolver = makeParamResolver(data, roles, units, mcList);
          S.entries = {}; S.filterCache = {};
        }
        return data;
      }
      function cachedFilter(def, data) {
        var f = def.filter || {};
        var key = (f.mode === 'simple' ? 'S:' + JSON.stringify(f.clauses || null) : 'A:' + (f.expression || ''));
        if (!S.filterCache[key]) S.filterCache[key] = compileFilter(def, data, S.resolver);
        return S.filterCache[key];
      }
      /** Cheap "would this def resolve on this log?" check (no binning) for the list dots. */
      function missingFor(def, data) {
        var out = [];
        if (!data || !S.resolver || !def) return out;
        def = effectiveDef(def);
        var slots = [['cell', def.cellParameter], ['weight', def.weightParameter], ['column', def.columnAxis && def.columnAxis.parameter], ['row', def.rowAxis && def.rowAxis.parameter]];
        for (var i = 0; i < slots.length; i++) {
          var p = slots[i][1];
          if (!p) continue;
          if (!S.resolver(p)) out.push({ slot: slots[i][0], param: p, label: paramLabel(p), math: !!p.math && !p.channel && !p.role });
        }
        var filt = cachedFilter(def, data);
        for (var j = 0; j < filt.missing.length; j++) out.push({ slot: 'filter', name: filt.missing[j], label: filt.missing[j] });
        return out;
      }

      // ---- compute -----------------------------------------------------------------------------------
      // pageValue (optional) computes a specific page of a paged def instead of its current one --
      // the owner map needs every page.
      function ensureEntry(def, reason, pageValue) {
        var data = ensureData();
        if (!data) return { result: null, filter: null, state: 'no_data' };
        var range = null;
        if (def.dataRange === 'selection' && typeof glue.getRange === 'function') { try { range = glue.getRange(); } catch (e) { range = null; } }
        var rangeKey = (def.dataRange === 'selection' && range) ? range.startIdx + ':' + range.endIdx : 'all';
        var pi = pageInfo(def);
        var pv = pageValue != null ? pageValue : (pi ? pi.current : null);
        var eff = (pi && pv != null) ? H().applyPage(def, pv) : def;
        var entryKey = pi ? def.id + '#' + pv : def.id;
        var cur = S.entries[entryKey];
        if (cur && cur.rangeKey === rangeKey && cur.data === data) return cur;
        def = eff;
        var filt = cachedFilter(def, data);
        var ctx = {
          getParam: S.resolver, time: data.time, n: data.time.length,
          range: (def.dataRange === 'selection' && range) ? { startIdx: range.startIdx, endIdx: range.endIdx } : null,
          filterMask: filt.mask, convertValue: typeof glue.convertValue === 'function' ? glue.convertValue : null, collectIndices: true
        };
        var result = H().compute(def, ctx);
        S.computeCount++; S.lastElapsed = result.elapsedMs;
        var entry = { result: result, filter: filt, rangeKey: rangeKey, data: data, viewT: null, state: 'ok', page: pv };
        if (filt.error) entry.state = 'filter_error';
        else if (filt.missing.length || result.state === 'missing_parameter') entry.state = 'missing';
        else if (result.state === 'invalid' || result.state === 'error') entry.state = 'invalid';
        S.entries[entryKey] = entry;
        if (typeof glue.onCompute === 'function') { try { glue.onCompute({ def: def, result: result, elapsedMs: result.elapsedMs, reason: reason || 'compute', count: S.computeCount }); } catch (e2) { /* dev hook */ } }
        return entry;
      }

      // ---- list panel --------------------------------------------------------------------------------
      function renderList() {
        var data = null;
        try { data = ensureData(); } catch (e) { data = null; }
        var html = '';
        for (var i = 0; i < S.defs.length; i++) {
          var d = S.defs[i], miss = d.enabled ? missingFor(d, data) : [];
          var pi = pageInfo(d);
          html += '<div class="dlv-hist-row' + (d.id === S.activeId ? ' active' : '') + (d.enabled ? '' : ' off') + '" data-id="' + esc(d.id) + '" title="' + esc(d.description || d.name) + '">' +
            '<input type="checkbox" class="dlv-hist-row-en" title="Enabled"' + (d.enabled ? ' checked' : '') + '>' +
            '<span class="dlv-hist-row-name">' + esc(displayName(d)) + '</span>' +
            (miss.length ? '<span class="dlv-hist-dot" title="Missing on this log: ' + esc(miss.map(function (m) { return m.label; }).join(', ')) + '"></span>' : '') +
            (pi ? '<span class="dlv-hist-badge pages" title="' + esc(pi.values.length + ' pages of ' + d.pages.pattern) + '">×' + pi.values.length + '</span>' : '') +
            '<span class="dlv-hist-badge">' + typeBadge(d) + '</span>' +
            '<button type="button" class="dlv-hist-row-menu" title="Actions">⋯</button></div>';
        }
        if (!S.defs.length) html = '<div class="dlv-hist-list-empty">No histograms yet.</div>';
        D.rows.innerHTML = html;
        // toolbar select mirrors the list
        var opts = '';
        for (var j = 0; j < S.defs.length; j++) opts += '<option value="' + esc(S.defs[j].id) + '"' + (S.defs[j].id === S.activeId ? ' selected' : '') + '>' + esc(displayName(S.defs[j])) + (S.defs[j].enabled ? '' : ' (off)') + '</option>';
        D.defsel.innerHTML = opts || '<option value="">— none —</option>';
        D.defsel.disabled = !S.defs.length;
      }
      function rowMenuItems(def) {
        var idx = defIndex(def.id);
        return [
          { label: 'Edit…', action: function () { openEditor(def, null); } },
          { label: 'Duplicate', action: function () { var c = H().cloneDef(def); S.defs.splice(idx + 1, 0, c); changed(); renderList(); activate(c.id); } },
          { label: 'Rename…', action: function () { renameDef(def); } },
          { label: def.enabled ? 'Disable' : 'Enable', action: function () { def.enabled = !def.enabled; changed(); renderList(); if (def.id === S.activeId) renderActive('toggle'); } },
          'sep',
          { label: 'Move Up', disabled: idx <= 0, action: function () { moveDef(idx, idx - 1); } },
          { label: 'Move Down', disabled: idx >= S.defs.length - 1, action: function () { moveDef(idx, idx + 1); } },
          { label: 'Reset Data (recompute)', action: function () { markDirty(def.id); if (def.id === S.activeId) renderActive('reset'); else renderList(); } },
          'sep',
          { label: 'Export JSON', action: function () { downloadText(safeFile(def.name) + '.histogram.json', H().exportDef(def)); } },
          { label: 'Import JSON…', action: function () { D.file.click(); } },
          { label: 'Share to library…', disabled: !libraryAvailable(), action: function () { shareToLibrary(def); } },
          'sep',
          { label: 'Delete', danger: true, action: function () { deleteDef(def); } }
        ];
      }
      function listMenuItems() {
        return [
          { label: 'Add histogram', action: function () { addDef(); } },
          { label: 'Load example set', action: function () { loadExamples(); } },
          { label: 'Browse the library…', disabled: !libraryAvailable(), action: function () { openLibrary(); } },
          'sep',
          // The picker inside the def editor offers named math channels and its own "Manage…" link;
          // this is the entry point for getting in there WITHOUT opening a histogram first (Ken's ask,
          // 2026-09-07 -- previously the only way in was buried inside a parameter pick).
          { label: 'Manage math channels…', disabled: !mathManagerAvailable(), action: function () { openMathManagerFromList(); } },
          { label: 'Combine numbered tables into pages…', disabled: S.defs.length < 2, action: function () { combinePagesInList(); } },
          { label: (typeof glue.hasBackGauges === 'function' && glue.hasBackGauges()) ? 'Edit the gauges behind the table…' : 'Add gauges behind the table…', disabled: typeof glue.editBackGauges !== 'function', action: function () { glue.editBackGauges(); } },
          'sep',
          { label: 'Import JSON…', action: function () { D.file.click(); } },
          // One picker for both: the file itself decides. A tuner reaches for "import" holding a
          // VCM Scanner .Layout.xml as often as one of our JSON packages.
          { label: 'Import HP Tuners layout…', disabled: !hptAvailable(), action: function () { D.file.click(); } },
          { label: 'Export all (JSON)', disabled: !S.defs.length, action: function () { downloadText('histograms.json', H().exportDefs(S.defs)); } }
        ];
      }
      function mathManagerAvailable() { return typeof glue.openMathManager === 'function'; }
      // ---- shared library (datalog-library.js + a host provider) ------------------------------------
      function libraryAvailable() { return typeof global.Library !== 'undefined' && !!global.Library.available && global.Library.available(); }
      function openLibrary() {
        if (!libraryAvailable()) { toast('The library is not available here.'); return; }
        global.Library.open({ kind: 'histogram', onUse: function (item) {
          // The library has a tab per kind: a dashboard or a math channel picked here goes to the viewer.
          if (item && item.kind !== 'histogram' && typeof glue.useLibraryItem === 'function') { glue.useLibraryItem(item); return; }
          var pl = item && item.payload;
          if (!pl || !pl.def) { toast('That histogram is empty.'); return; }
          // Stamp the def with where it came from so "Share to library" can offer to update that entry.
          var def = Object.assign({}, pl.def, { libraryId: item.id, vehicle: global.Library.vehicleOf ? global.Library.vehicleOf(item) : null });
          importPackage({ kind: H().PACKAGE_KIND, histograms: [def], mathChannels: Array.isArray(pl.mathChannels) ? pl.mathChannels : [] }, 'library item');
        } });
      }
      // Share one table: its def plus every math channel it depends on (transitively), and a
      // thumbnail painted from the LIVE table when this def is the one on screen. A def that came
      // from the library (or was shared before) carries libraryId, so the dialog offers Update.
      function shareToLibrary(def) {
        if (!libraryAvailable()) { toast('The library is not available here.'); return; }
        var list = (glue.mathChannels && typeof glue.mathChannels.list === 'function') ? (glue.mathChannels.list() || []) : [];
        var deps = H().mathChannelDeps([def], list);
        var live = def.id === S.activeId && S.view && S.statTable && S.scale;
        var svg = null;
        try { svg = live ? thumbnailSvg(def, S.view, S.statTable, S.scale) : thumbnailSvg(def, null, null, null); } catch (e) { svg = null; }
        var packed = JSON.parse(JSON.stringify(def));
        delete packed.libraryId;   // the item id is the library's business, not part of the shared def
        global.Library.share({
          kind: 'histogram', name: def.name || 'Histogram', description: def.description || '',
          payload: { kind: 'histogram', def: packed, mathChannels: deps },
          thumbSvg: svg,
          vehicle: def.vehicle || null,
          libraryId: def.libraryId || null,
          onDone: function (item) {
            if (!item) return;
            def.libraryId = item.id;
            def.vehicle = global.Library.vehicleOf ? global.Library.vehicleOf(item) : null;
            changed();
          }
        });
      }
      // Import a package object ({histograms, mathChannels?}): packaged math channels merge into the
      // live list BY NAME (a same-named channel of ours keeps its id; new ones are added), the incoming
      // defs are remapped onto those ids, then adopted. Used by the file importer and the library.
      function importPackage(obj, what) {
        var r = H().importDefs(obj);
        var defs = r.defs;
        if (r.mathChannels && r.mathChannels.length && glue.mathChannels && typeof glue.mathChannels.list === 'function') {
          var m = H().mergeMathChannels(glue.mathChannels.list() || [], r.mathChannels);
          if (m.added.length && typeof glue.mathChannels.save === 'function') glue.mathChannels.save(m.list);
          defs = H().remapMathChannelIds(defs, m.idMap);
          if (m.added.length) toast('Added ' + m.added.length + ' math channel' + (m.added.length === 1 ? '' : 's'));
        }
        adoptImported(defs, r.warnings, what || 'histogram');
      }
      function openMathManagerFromList() {
        if (!mathManagerAvailable()) { toast('Math channel management is not available here.'); return; }
        var data = ensureData();
        glue.openMathManager({ data: data, resolvedRoles: (typeof glue.resolvedRoles === 'function' && glue.resolvedRoles()) || {}, unitByChannel: (typeof glue.unitByChannel === 'function' && glue.unitByChannel()) || {} });
      }
      function moveDef(from, to) {
        if (to < 0 || to >= S.defs.length) return;
        var d = S.defs.splice(from, 1)[0]; S.defs.splice(to, 0, d);
        changed(); renderList();
      }
      function deleteDef(def) {
        var idx = defIndex(def.id);
        if (idx < 0) return;
        S.defs.splice(idx, 1); delete S.entries[def.id]; changed();
        if (S.activeId === def.id) { S.activeId = null; renderList(); activate(S.defs.length ? S.defs[Math.min(idx, S.defs.length - 1)].id : null); }
        else renderList();
        toast('Deleted "' + def.name + '"');
      }
      function renameDef(def) {
        var name = null;
        try { name = window.prompt('Rename histogram:', def.name); } catch (e) { name = null; }
        if (name == null) return;
        name = String(name).replace(/^\s+|\s+$/g, '');
        if (!name) return;
        def.name = name; changed(); renderList();
        if (def.id === S.activeId) syncToolbar();
      }
      function safeFile(s) { return String(s || 'histogram').replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, '') || 'histogram'; }
      function downloadText(name, text) {
        try {
          var blob = new Blob([text], { type: 'application/json' });
          var url = URL.createObjectURL(blob), a = document.createElement('a');
          a.href = url; a.download = name; document.body.appendChild(a); a.click();
          setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
          toast('Exported ' + name);
        } catch (e) { writeClipboard(text, function () { toast('Download blocked — JSON copied to the clipboard instead'); }); }
      }
      function hptAvailable() { return !!(glue.hpt && glue.hpt.available && glue.hpt.importLayout); }
      // An HP Tuners layout is XML; ours is JSON. Sniff the CONTENT rather than the extension, so a
      // renamed file still lands in the right importer.
      function looksLikeHptLayout(text) {
        if (!hptAvailable()) return false;
        if (glue.hpt.isLayoutXml) { try { if (glue.hpt.isLayoutXml(text)) return true; } catch (e) { /* fall through */ } }
        return /^\s*(?:﻿)?<\?xml|<DocumentContents/i.test(text || '');
      }
      // Adopt imported defs: unique ids, appended in order, first one activated.
      function adoptImported(defs, warnings, what) {
        if (!defs || !defs.length) { toast('Nothing imported' + (warnings && warnings.length ? ': ' + warnings[0] : '')); return; }
        for (var i = 0; i < defs.length; i++) { if (defById(defs[i].id)) defs[i].id = H().cloneDef(defs[i]).id; S.defs.push(defs[i]); }
        changed(); renderList(); activate(defs[0].id);
        var n = warnings ? warnings.length : 0;
        toast('Imported ' + defs.length + ' ' + what + (defs.length === 1 ? '' : 's') + (n ? ' (' + n + ' warning' + (n === 1 ? '' : 's') + ')' : ''));
      }
      function importFile(file) {
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function () {
          var text = String(reader.result);
          if (looksLikeHptLayout(text)) {
            var hr;
            try { hr = glue.hpt.importLayout(text, {}); }
            catch (e) { toast('Could not read that HP Tuners layout: ' + (e && e.message ? e.message : e)); return; }
            // A VCM Scanner layout with one table per mapped point (MP0 FT … MP20 FT) becomes ONE paged
            // table here; say so, since 21 tables going in and 1 coming out looks like a lossy import.
            var folded = combinePages(hr.defs, false);
            if (folded) {
              hr.defs = folded.defs;
              setTimeout(function () { toast('Combined ' + folded.collapsed.map(function (c) { return c.count + ' tables into "' + c.name + '"'; }).join(', ') + ' — use ◀ ▶ to change page'); }, 1200);
            }
            adoptImported(hr.defs, hr.warnings, 'table');
            // Parameters HP Tuners names only by numeric id, that this log cannot resolve, arrive as
            // placeholders -- the table shows the missing-parameter panel, where mapping one remembers
            // it for every later import. Say how many so nobody wonders why a table is empty.
            if (hr.unresolved && hr.unresolved.length) {
              var pids = {}, k;
              for (k = 0; k < hr.unresolved.length; k++) pids[hr.unresolved[k].pid] = 1;
              var nPid = 0; for (k in pids) if (Object.prototype.hasOwnProperty.call(pids, k)) nPid++;
              toast(nPid + ' HP Tuners parameter' + (nPid === 1 ? '' : 's') + " couldn't be matched to this log — map them on the table.");
            }
            return;
          }
          importPackage(text, 'histogram');
        };
        reader.readAsText(file);
      }
      function loadExamples() {
        // Seed the default math channels FIRST (merged by name -- clicking "Load example set" twice
        // never creates duplicates), so the histogram examples below can reference them by id and
        // demonstrate the whole point of a named channel: define once, every histogram reuses it.
        var idByName = {}, addedMath = 0;
        if (glue.mathChannels && typeof glue.mathChannels.list === 'function' && typeof glue.mathChannels.save === 'function') {
          var mcList = (glue.mathChannels.list() || []).slice();
          var haveNames = {}; mcList.forEach(function (m) { if (m && m.name) haveNames[m.name] = m.id; });
          EXAMPLE_MATH_CHANNELS().forEach(function (mc) {
            if (haveNames[mc.name]) { idByName[mc.name] = haveNames[mc.name]; return; }
            mcList.push(mc); idByName[mc.name] = mc.id; addedMath++;
          });
          if (addedMath) glue.mathChannels.save(mcList);
        }
        var ex = EXAMPLE_DEFS(idByName);
        for (var i = 0; i < ex.length; i++) S.defs.push(ex[i]);
        changed(); renderList(); activate(ex[0].id);
        toast('Loaded ' + ex.length + ' example histograms' + (addedMath ? ' + ' + addedMath + ' math channel' + (addedMath === 1 ? '' : 's') : ''));
      }
      function starterDef(name) {
        return H().makeDef({
          name: name, cellParameter: { role: 'total_knock', channel: 'Knock Retard', label: 'Knock Retard' },
          columnAxis: { parameter: { role: 'engine_rpm', channel: 'Engine RPM', label: 'Engine RPM' }, unit: 'rpm', breakpoints: seq(1000, 7500, 500) },
          rowAxis: null, statistic: 'maximum', minimumHits: 3
        });
      }
      function addDef() {
        if (typeof glue.openEditor === 'function') { openEditor(starterDef('New Histogram'), null, true); return; }
        var name = null;
        try { name = window.prompt('Name the new histogram:', 'New Histogram'); } catch (e) { name = null; }
        if (name == null) return;
        var d = starterDef(String(name).replace(/^\s+|\s+$/g, '') || 'New Histogram');
        S.defs.push(d); changed(); renderList(); activate(d.id);
        toast('Editor not loaded — created a starter 1D histogram; use "Choose replacement" or Edit to point it at channels');
      }
      function openEditor(def, focusSlot, isNew) {
        if (typeof glue.openEditor !== 'function') { if (!isNew) renameDef(def); return; }
        var data = ensureData();
        glue.openEditor(def, {
          data: data, resolver: S.resolver, focusSlot: focusSlot || null, isNew: !!isNew,
          onSave: function (saved) {
            saved = H().migrateDef(saved || def);
            var idx = defIndex(saved.id);
            if (idx < 0) S.defs.push(saved); else S.defs[idx] = saved;
            markDirty(saved.id); changed(); renderList(); activate(saved.id, true);
          }
        });
      }
      function setCollapsed(on) {
        S.listCollapsed = !!on;
        D.list.hidden = S.listCollapsed;
        D.expander.hidden = !S.listCollapsed;
      }

      // ---- activation + main render -------------------------------------------------------------
      function activate(id, force) {
        if (id != null && !defById(id)) id = null;
        if (id == null && S.defs.length) { id = S.defs[0].id; for (var i = 0; i < S.defs.length; i++) if (S.defs[i].enabled) { id = S.defs[i].id; break; } }
        var same = id === S.activeId;
        S.activeId = id;
        if (!same) { S.detail = null; S.anchor = null; }
        renderList();
        renderActive(same && !force ? 'refresh' : 'activate');
      }
      function statePanel(cls, title, body, actions) {
        var html = '<div class="dlv-hist-state ' + (cls || '') + '"><div class="dlv-hist-state-title">' + title + '</div>' +
          (body ? '<div class="dlv-hist-state-body">' + body + '</div>' : '') +
          (actions ? '<div class="dlv-hist-state-actions">' + actions + '</div>' : '') + '</div>';
        hideTip();
        D.wrap.innerHTML = html;
        S.view = null; S.base = null; S.cells = []; S.rowHeads = []; S.colHeads = []; S.sel = null; S.R = 0; S.C = 0;
        S.owner = null; S.ownerPages = null;
        D.legend.innerHTML = ''; D.samples.innerHTML = '';
        renderDetails();
      }
      function renderActive(reason) { renderActiveCore(reason); notifyLayout(); }
      function renderActiveCore(reason) {
        if (S.destroyed) return;
        var def = activeDef();
        D.warn.hidden = true; D.warn.innerHTML = '';
        if (!def) {
          statePanel('dlv-hist-empty-state', S.defs.length ? 'Select a histogram' : 'No histograms yet',
            S.defs.length ? '' : 'Build a table of any channel by RPM, load, MAF frequency… the way VCM Scanner histograms do.',
            '<button type="button" class="dlv-hist-btn primary" data-a="add">Add histogram</button>' +
            '<button type="button" class="dlv-hist-btn" data-a="examples">Load example set</button>' +
            (libraryAvailable() ? '<button type="button" class="dlv-hist-btn" data-a="library">Browse the library</button>' : ''));
          syncToolbar(); return;
        }
        if (!def.enabled) {
          statePanel('', esc(def.name) + ' is disabled', 'Disabled histograms are kept but not computed.',
            '<button type="button" class="dlv-hist-btn primary" data-a="enable">Enable</button>');
          syncToolbar(); return;
        }
        var pInfo = pageInfo(def);
        if (pInfo && ownerModeOf(def)) { renderOwnerView(def, pInfo, reason); syncToolbar(); return; }
        S.owner = null; S.ownerPages = null;
        var entry = ensureEntry(def, reason);
        if (entry.state === 'no_data') { statePanel('', 'No datalog loaded', 'Open a log to compute this histogram.'); syncToolbar(); return; }
        var result = entry.result;
        if (entry.state === 'filter_error') {
          statePanel('dlv-hist-error', 'Filter error', esc(entry.filter.error.message) + (isFin(entry.filter.error.pos) ? ' (at ' + entry.filter.error.pos + ')' : '') +
            '<div class="dlv-hist-code">' + esc(entry.filter.source || '') + '</div>',
            '<button type="button" class="dlv-hist-btn primary" data-a="edit">Edit…</button><button type="button" class="dlv-hist-btn" data-a="disable">Disable histogram</button>');
          syncToolbar(); return;
        }
        if (entry.state === 'missing') { renderMissing(def, entry); syncToolbar(); return; }
        if (entry.state === 'invalid') {
          statePanel('dlv-hist-error', result.state === 'error' ? 'Histogram error' : 'Invalid definition', esc(result.errors.join(' · ')),
            '<button type="button" class="dlv-hist-btn primary" data-a="edit">Edit…</button><button type="button" class="dlv-hist-btn" data-a="disable">Disable histogram</button>');
          syncToolbar(); return;
        }
        var view = result;
        if (def.orientation === 'inverted' && result.rows) { if (!entry.viewT) entry.viewT = H().transposeResult(result); view = entry.viewT; }
        var sameShape = S.view && S.base === result && S.R === view.shape.rows && S.C === view.shape.cols;
        var keepSel = sameShape ? S.sel : null;
        S.base = result;
        renderTable(view);
        if (keepSel) S.sel = keepSel;
        else if (S.pendingSel && S.pendingSel.length === S.R * S.C) { S.sel = S.pendingSel; }
        S.pendingSel = null;
        applyCells();
        applySelection();
        applyCursorMark();
        renderWarnings(def, entry);
        renderSamples(view, entry);
        if (S.detail && S.detail.r < S.R && S.detail.c < S.C) renderDetails(S.detail.r, S.detail.c); else renderDetails();
        syncToolbar();
      }
      function renderWarnings(def, entry) {
        var w = (entry.result && entry.result.warnings) ? entry.result.warnings.slice() : [];
        if (entry.result && entry.result.state === 'empty') w.unshift('No samples landed in the table' + (entry.filter && entry.filter.mask ? ' (check the filter and the selected range)' : ''));
        if (!w.length) { D.warn.hidden = true; return; }
        D.warn.innerHTML = '<span class="dlv-hist-warn-ico">⚠</span> ' + esc(w.join(' · '));
        D.warn.hidden = false;
      }
      function renderSamples(view, entry) {
        var st = view.sampleStats || {}, data = entry.data || {};
        var info = data.sampleInfo || {};
        var title = 'binned ' + fmtK(st.binned) + ' of ' + fmtK(st.inRange) + ' in range · filtered out ' + fmtK(st.filteredOut) +
          ' · missing values ' + fmtK(st.invalid) + ' · out of range ' + fmtK(st.droppedOutOfRange) + ' · computed in ' + (entry.result.elapsedMs || 0).toFixed(1) + ' ms';
        var html = '<span title="' + esc(title) + '"><b>' + fmtK(st.binned) + '</b> / ' + fmtK(st.inRange) + ' samples used</span>';
        if (info.isDecimated) {
          html += ' <span class="dlv-hist-badge warn" title="This log is downsampled for display (' + fmtK(info.returnedRows) + ' of ' + fmtK(info.totalRows) +
            ' rows). Counts are of the retained samples, not the full log.">downsampled</span>';
        }
        D.samples.innerHTML = html;
      }

      // ---- missing-parameter panel --------------------------------------------------------------
      function renderMissing(def, entry) {
        var data = entry.data, miss = missingFor(def, data);
        if (!miss.length && entry.result.missing) {
          for (var q = 0; q < entry.result.missing.length; q++) { var m0 = entry.result.missing[q]; miss.push({ slot: m0.slot, param: m0.param, label: paramLabel(m0.param) }); }
        }
        var chans = S.resolver ? S.resolver.channels() : [];
        var opts = '<option value="">Choose a channel…</option>';
        for (var i = 0; i < chans.length; i++) opts += '<option value="' + esc(chans[i].name) + '">' + esc(chans[i].name) + (chans[i].unit ? ' (' + esc(displayUnit(chans[i].unit)) + ')' : '') + (chans[i].isText ? ' [text]' : '') + '</option>';
        var slotName = { cell: 'cell value', weight: 'weight', column: 'column axis', row: 'row axis', filter: 'filter' };
        var first = miss[0];
        var rows = '';
        for (var k = 0; k < miss.length; k++) {
          var m = miss[k], why = '';
          if (m.math && S.resolver) { var ms = S.resolver.mathStatus(m.param.math); if (ms.error) why = 'math error: ' + ms.error.message; else if (ms.missing.length) why = 'math references missing channel' + (ms.missing.length > 1 ? 's' : '') + ' ' + ms.missing.join(', '); }
          rows += '<div class="dlv-hist-miss-row"><b>' + esc(m.label) + '</b><span class="dlv-hist-miss-slot">' + slotName[m.slot] + '</span>' +
            (why ? '<span class="dlv-hist-miss-why">' + esc(why) + '</span>' : '') +
            '<select class="dlv-hist-miss-sel" data-miss="' + k + '" title="Replace with a channel from this log">' + opts + '</select></div>';
        }
        S.missing = miss;
        statePanel('dlv-hist-missing', 'Missing parameter: ' + esc(first.label) + ' <span class="dlv-hist-state-sub">(' + slotName[first.slot] + ')</span>',
          rows,
          (typeof glue.openEditor === 'function' ? '<button type="button" class="dlv-hist-btn primary" data-a="choose" data-slot="' + first.slot + '">Choose replacement…</button>' : '') +
          '<button type="button" class="dlv-hist-btn" data-a="disable">Disable histogram</button>');
        if (entry.result.warnings && entry.result.warnings.length) { D.warn.innerHTML = '<span class="dlv-hist-warn-ico">⚠</span> ' + esc(entry.result.warnings.join(' · ')); D.warn.hidden = false; }
      }
      function applyReplacement(m, name) {
        var def = activeDef();
        if (!def || !name) return;
        if (m.slot === 'filter') {
          var f = def.filter || {};
          if (f.mode === 'simple' && Array.isArray(f.clauses)) {
            (function walk(list) {
              for (var i = 0; i < list.length; i++) {
                var c = list[i];
                if (Array.isArray(c)) { walk(c); continue; }
                if (!c) continue;
                if (Array.isArray(c.group)) { walk(c.group); continue; }
                var p = c.param, pname = isObj(p) ? (p.channel || p.role) : p;
                if (pname === m.name || c.role === m.name || (isObj(p) && p.role === m.name)) { c.param = name; c.role = null; }
              }
            })(f.clauses);
          } else if (typeof f.expression === 'string') {
            f.expression = f.expression.split('[' + m.name + ']').join('[' + name + ']').split('"' + m.name + '"').join('[' + name + ']');
          }
        } else {
          var axis = m.slot === 'column' ? def.columnAxis : (m.slot === 'row' ? def.rowAxis : null);
          var p2 = axis ? axis.parameter : (m.slot === 'weight' ? def.weightParameter : def.cellParameter);
          p2.channel = name; p2.role = null; p2.math = null; p2.label = null;
          // HIGH: this used to ALWAYS overwrite axis.unit with the replacement channel's live unit,
          // throwing away the unit the breakpoints were actually authored in -- a table saved with
          // its axis in kPa, opened on a log missing that role and mapped to a psi channel, silently
          // bins the SAME numbers as psi. The engine already converts a def's axis unit to whatever
          // unit the resolved channel reports (Histogram.compute); only fall back to adopting the
          // live unit when there is nothing to convert FROM (no prior unit) or the conversion isn't
          // possible at all (a genuinely incompatible family -- e.g. the old parameter was a
          // percentage and the replacement is a temperature).
          if (axis) {
            var u = S.resolver && S.resolver.lookup(name);
            var liveUnit = (u && u.unit) ? u.unit : null;
            var canKeep = axis.unit && liveUnit && typeof glue.convertValue === 'function' &&
              isFin(glue.convertValue(1, axis.unit, liveUnit));
            if (!canKeep) axis.unit = liveUnit;
          }
          H().migrateDef(def);
        }
        S.filterCache = {}; markDirty(def.id); changed(); renderList(); renderActive('replace');
        toast('Using "' + name + '"');
      }

      // ---- table -----------------------------------------------------------------------------------
      function axisTitle(label, unit) { return esc(shortName(label || '')) + (unit ? ' <span class="dlv-hist-unit">' + esc(displayUnit(unit)) + '</span>' : ''); }
      function renderTable(view) {
        var R = view.shape.rows, C = view.shape.cols, cols = view.columns, rows = view.rows, labels = view.labels || {};
        var axDec = axisDecimalsFor(activeDef());
        var html = '<table class="dlv-hist-table"><thead><tr><th class="dlv-hist-corner" title="' + esc((rows ? (labels.row || 'Row') : (labels.cell || 'Value')) + ' \\ ' + (labels.column || 'Column')) + '">' +
          '<div class="dlv-hist-corner-a">' + (rows ? '↓ ' + axisTitle(labels.row, view.rowUnit) : esc(shortName(labels.cell || ''))) + '</div>' +
          '<div class="dlv-hist-corner-b">→ ' + axisTitle(labels.column, view.columnUnit) + '</div></th>';
        var c, r, k;
        for (c = 0; c < C; c++) html += '<th class="dlv-hist-ch" data-c="' + c + '">' + esc(roundAxisLabel(cols[c].label, axDec)) + '</th>';
        html += '</tr></thead><tbody>';
        for (r = 0; r < R; r++) {
          html += '<tr><th class="dlv-hist-rh" data-r="' + r + '">' + esc(rows ? roundAxisLabel(rows[r].label, axDec) : H().statLabel(statOf(activeDef()))) + '</th>';
          for (c = 0; c < C; c++) { k = r * C + c; html += '<td data-k="' + k + '"></td>'; }
          html += '</tr>';
        }
        html += '</tbody></table>';
        hideTip();                       // the cell under the cursor is about to be replaced
        D.wrap.innerHTML = html;
        D.wrap.appendChild(D.cursorMark);  // innerHTML= just wiped it out; re-attach the persistent marker
        S.view = view; S.R = R; S.C = C;
        S.cells = Array.prototype.slice.call(D.wrap.querySelectorAll('td[data-k]'));
        S.rowHeads = Array.prototype.slice.call(D.wrap.querySelectorAll('th.dlv-hist-rh'));
        S.colHeads = Array.prototype.slice.call(D.wrap.querySelectorAll('th.dlv-hist-ch'));
        S.sel = new Uint8Array(R * C);
        S.missing = null;
      }
      /** Statistic / colour / min-hits pass: text + background only, through the cached cell refs. */
      function applyCells() {
        var def = activeDef(), view = S.view;
        if (!def || !view || !view.cells) return;
        if (S.owner) { applyOwnerCells(def); return; }
        var stat = statOf(def), mh = minHitsOf(def), showLow = showLowOf(def), isCount = stat === 'count';
        var table = H().statTable(view, stat), counts = view.cells.count;
        S.statTable = table;
        // The editor's "Decimals" field (display.decimals) was previously never read here -- it
        // overrides the auto-by-magnitude default when the tuner sets one explicitly.
        var decOverride = def.display && def.display.decimals;
        S.dec = isFin(decOverride) ? Math.max(0, Math.min(6, Math.round(decOverride))) : decimalsFor(table, stat);
        S.scale = makeScale(view, def, stat, mh);
        for (var k = 0; k < S.cells.length; k++) {
          var td = S.cells[k], n = counts[k], v = table[k], cls = '', text, bg = '';
          // hits: the sample count, or Σweight/scale for the weighted statistic (a cell full of
          // zero-weight samples is "low" however many samples it holds)
          var hits = H().effectiveHits(view, k, stat);
          if (n === 0) { cls = 'dlv-hist-cell-empty'; text = '—'; }
          else if (hits < mh || (!isCount && !isFin(v))) { cls = 'dlv-hist-cell-low'; text = isCount ? String(n) : (showLow && isFin(v) ? formatValue(v, S.dec) : '·'); }
          else { text = formatValue(v, S.dec); bg = colorFor(v, S.scale) || ''; }
          if (S.sel && S.sel[k]) cls += ' dlv-hist-sel';
          td.className = cls; td.textContent = text; td.style.background = bg;
        }
        if (!view.rows && S.rowHeads[0]) S.rowHeads[0].textContent = H().statLabel(stat);
        renderLegend(def, view, stat);
      }
      // ---- live cursor mark ---------------------------------------------------------------------
      // A floating dot showing exactly where the scrubber/graph cursor sits on the table's axes,
      // driven by ctl.setCursor() on every viewer cursor move. It does NOT snap to the nearest cell
      // (Ken, 2026-09-08: "it should be able to interpolate the hover... if there is a 5000 rpm
      // breakpoint and 6000 breakpoint and the RPM is actually 5500 the trace should be halfway") --
      // each axis independently interpolates between the two breakpoints the live value falls
      // between, in both directions for a 2D table. sampleCellIndex still answers the one question
      // interpolation can't: whether this sample is even ON the table at all (out of a 'Selection'
      // range, filtered out, or outside the axis with outOfRange:'drop') -- transposeResult() remaps
      // it through the same permutation as the cells, so it's always in S.cells' coordinate space
      // regardless of orientation. A categorical axis (no numeric breakpoints) has no "between", so
      // that axis falls back to the discrete cell it decomposes sampleCellIndex into.
      function nearestIdx(arr, x) {
        var lo = 0, hi = arr.length - 1;
        if (x <= arr[0]) return 0;
        if (x >= arr[hi]) return hi;
        while (lo < hi) {
          var mid = (lo + hi) >> 1;
          if (arr[mid] === x) return mid;
          if (arr[mid] < x) lo = mid + 1; else hi = mid;
        }
        if (lo > 0 && Math.abs(arr[lo - 1] - x) <= Math.abs(arr[lo] - x)) return lo - 1;
        return lo;
      }
      /** Center of a header cell along one axis, in D.wrap's own (scroll-stable) layout space. */
      function headCenter(el, vertical) {
        if (!el) return null;
        return vertical ? (el.offsetTop + el.offsetHeight / 2) : (el.offsetLeft + el.offsetWidth / 2);
      }
      /** Where the live value sits along one axis, interpolated between its bracketing breakpoints.
       *  entries/headEls are view.columns/S.colHeads (or rows/rowHeads), same order. null when the
       *  axis is categorical or the value isn't a usable number -- caller snaps to a cell instead. */
      function axisInterpPos(headEls, entries, rawVal, vertical) {
        if (!entries || !entries.length || !headEls || !headEls.length || entries[0].breakpoint == null) return null;
        if (typeof rawVal !== 'number' || rawVal !== rawVal) return null;
        var pairs = [];
        // rawVal is the LIVE channel value (the log's unit). entry.breakpoint is the def's breakpoint in
        // the def's axis unit -- binValue is that same breakpoint converted to the live unit by
        // resolveAxis. A MAP axis authored in inHg on a log that reads psi interpolated 35 psi against
        // 5..100 inHg and parked the dot at "35-40 inHg" while the samples sat at 72 (Ken, 2026-09-08).
        for (var i = 0; i < entries.length && i < headEls.length; i++) pairs.push({ v: entries[i].binValue != null ? entries[i].binValue : entries[i].breakpoint, el: headEls[i] });
        pairs.sort(function (a, b) { return a.v - b.v; });
        var n = pairs.length;
        if (n === 1) return headCenter(pairs[0].el, vertical);
        if (rawVal <= pairs[0].v) return headCenter(pairs[0].el, vertical);
        if (rawVal >= pairs[n - 1].v) return headCenter(pairs[n - 1].el, vertical);
        var lo = 0, hi = n - 1;
        while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (pairs[mid].v <= rawVal) lo = mid; else hi = mid; }
        var v0 = pairs[lo].v, v1 = pairs[hi].v, c0 = headCenter(pairs[lo].el, vertical), c1 = headCenter(pairs[hi].el, vertical);
        return c0 + (c1 - c0) * ((v1 > v0) ? (rawVal - v0) / (v1 - v0) : 0);
      }
      function applyCursorMark() {
        var view = S.view, def = activeDef();
        if (!view || !def || !view.sampleCellIndex || !S.cells || !S.cells.length) { D.cursorMark.hidden = true; return; }
        var data = ensureData();
        if (!data || !data.time || !data.time.length) { D.cursorMark.hidden = true; return; }
        var t = (S.cursorTime != null) ? S.cursorTime : data.time[data.time.length - 1];
        var idx = nearestIdx(data.time, t);
        var k = view.sampleCellIndex[idx];
        if (k == null || k < 0 || !S.cells[k]) { D.cursorMark.hidden = true; return; }   // off the table entirely
        var c = k % S.C, r = (k / S.C) | 0;
        // transposeResult() swaps which original axis feeds view.columns vs view.rows.
        var transposed = !!(S.base && view !== S.base);
        var colParam = transposed ? (def.rowAxis && def.rowAxis.parameter) : def.columnAxis.parameter;
        var rowParam = transposed ? def.columnAxis.parameter : (def.rowAxis && def.rowAxis.parameter);
        var colEntry = colParam && S.resolver ? S.resolver(colParam) : null;
        var colVal = colEntry ? colEntry.values[idx] : null;
        var x = axisInterpPos(S.colHeads, view.columns, colVal, false);
        if (x == null) x = headCenter(S.colHeads[c], false);
        var y;
        if (view.rows && rowParam) {
          var rowEntry = S.resolver ? S.resolver(rowParam) : null;
          var rowVal = rowEntry ? rowEntry.values[idx] : null;
          y = axisInterpPos(S.rowHeads, view.rows, rowVal, true);
          if (y == null) y = headCenter(S.rowHeads[r], true);
        } else {
          y = headCenter(S.rowHeads[0], true);
        }
        if (x == null || y == null) { D.cursorMark.hidden = true; return; }
        D.cursorMark.style.left = x + 'px';
        D.cursorMark.style.top = y + 'px';
        D.cursorMark.hidden = false;
      }
      function renderLegend(def, view, stat) {
        var sc = S.scale;
        if (!sc || sc.empty) { D.legend.innerHTML = '<span class="dlv-hist-legend-note">No cells at or above ' + minHitsOf(def) + ' hits</span>'; return; }
        var dec = Math.max(S.dec, sc.kind === 'diverging' ? 1 : 0);
        var unit = stat === 'count' ? '' : displayUnit(view.cellUnit);
        D.legend.innerHTML = '<span class="dlv-hist-legend-stat">' + esc(H().statLabel(stat)) + ' · ' + esc(shortName(view.labels.cell || '')) + (unit ? ' (' + esc(unit) + ')' : '') + '</span>' +
          '<span class="dlv-hist-legend-v">' + esc(formatValue(sc.min, dec)) + '</span>' +
          '<span class="dlv-hist-legend-bar" style="background:' + legendGradient(sc) + '"></span>' +
          '<span class="dlv-hist-legend-v">' + esc(formatValue(sc.max, dec)) + '</span>' +
          (sc.kind === 'diverging' ? '<span class="dlv-hist-legend-c">centre ' + esc(formatValue(sc.center, dec)) + '</span>' : '') +
          (sc.manual ? '<span class="dlv-hist-legend-c">manual</span>' : '');
      }

      // ---- selection -------------------------------------------------------------------------------
      function applySelection() {
        if (!S.sel) return;
        for (var k = 0; k < S.cells.length; k++) {
          var on = !!S.sel[k], has = S.cells[k].classList.contains('dlv-hist-sel');
          if (on !== has) S.cells[k].classList.toggle('dlv-hist-sel', on);
        }
      }
      function clearMask() { if (S.sel) for (var k = 0; k < S.sel.length; k++) S.sel[k] = 0; }
      function selectRect(rect, base) {
        if (!S.sel || !rect) return;
        if (base) { for (var i = 0; i < S.sel.length; i++) S.sel[i] = base[i]; } else clearMask();
        for (var r = rect.r0; r <= rect.r1; r++) for (var c = rect.c0; c <= rect.c1; c++) S.sel[r * S.C + c] = 1;
        applySelection();
      }
      function selectAll() { if (!S.sel) return; selectRect({ r0: 0, r1: S.R - 1, c0: 0, c1: S.C - 1 }, null); renderDetails(); }
      function clearSelection() { if (!S.sel) return; clearMask(); applySelection(); }
      function selectedCount() { var n = 0; if (S.sel) for (var k = 0; k < S.sel.length; k++) if (S.sel[k]) n++; return n; }
      function cellFromNode(node) {
        var td = closestAttr(node, 'data-k', D.wrap);
        if (!td) return null;
        var k = parseInt(td.getAttribute('data-k'), 10);
        return { r: Math.floor(k / S.C), c: k % S.C, k: k, el: td };
      }

      // ---- details strip -----------------------------------------------------------------------------
      function axisText(view, which, idx) {
        var ents = which === 'col' ? view.columns : view.rows, unit = which === 'col' ? view.columnUnit : view.rowUnit;
        if (!ents || !ents[idx]) return '';
        var e = ents[idx], val = isFin(e.breakpoint) ? fmtK(e.breakpoint, axisDecimalsFor(activeDef())) : e.label;
        return '<b>' + esc(shortName(which === 'col' ? view.labels.column : view.labels.row)) + ':</b> ' + esc(val) + (unit ? ' ' + esc(displayUnit(unit)) : '');
      }
      function renderDetails(r, c) {
        var view = S.view;
        if (S.owner && view && r != null) { ownerDetails(r, c); return; }
        if (!view || r == null) {
          S.detail = null;
          var n = selectedCount();
          if (view && n > 1) {
            var b = selectionBounds(S.sel, S.R, S.C), tot = 0, mn = Infinity, mx = -Infinity, stat = statOf(activeDef());
            for (var k = 0; k < S.sel.length; k++) { if (!S.sel[k]) continue; tot += view.cells.count[k]; var v = S.statTable ? S.statTable[k] : NaN; if (isFin(v) && view.cells.count[k] > 0) { if (v < mn) mn = v; if (v > mx) mx = v; } }
            D.details.innerHTML = '<span class="dlv-hist-d-hint">' + n + ' cells selected (' + (b.r1 - b.r0 + 1) + '×' + (b.c1 - b.c0 + 1) + ')</span>' +
              '<span>Samples <b>' + fmtK(tot) + '</b></span>' + (isFin(mn) ? '<span>' + esc(H().statLabel(stat)) + ' min <b>' + formatValue(mn, S.dec) + '</b> · max <b>' + formatValue(mx, S.dec) + '</b></span>' : '') +
              '<span class="dlv-hist-d-hint">Ctrl+C copies the selection</span>';
          } else D.details.innerHTML = '<span class="dlv-hist-d-hint">' + (view ? 'Click a cell for its samples · drag to select · Ctrl+C to copy' : '') + '</span>';
          return;
        }
        var info = H().cellInfo(view, r, c);
        if (!info) { renderDetails(); return; }
        S.detail = { r: r, c: c };
        var dec = Math.min(4, S.dec + 1), unit = displayUnit(view.cellUnit), u = unit ? ' ' + esc(unit) : '';
        var html = '<span class="dlv-hist-d-axis">' + axisText(view, 'col', c) + (view.rows ? ' · ' + axisText(view, 'row', r) : '') + '</span>';
        if (info.count === 0) html += '<span class="dlv-hist-d-hint">No samples in this cell</span>';
        else {
          var lv = view.cellLevels;
          var fv = function (v) { return lv && isFin(v) && lv[Math.round(v)] != null ? esc(lv[Math.round(v)]) : formatValue(v, dec) + u; };
          html += (info.weighted ? '<span><b>Weighted</b> ' + fv(info.weightedAverage) + '</span>' : '') +
            '<span><b>Average</b> ' + fv(info.average) + '</span><span><b>Min</b> ' + fv(info.min) + '</span><span><b>Max</b> ' + fv(info.max) + '</span>' +
            '<span><b>Last</b> ' + fv(info.last) + '</span><span><b>First</b> ' + fv(info.first) + '</span>' +
            '<span><b>Samples</b> ' + fmtK(info.count) + (info.weighted ? ' <span class="dlv-hist-d-hint">· ' + fmtK(Number(info.effectiveHits.toFixed(1))) + ' weighted hits</span>' : '') + '</span>' +
            '<span class="dlv-hist-d-time">first ' + fmtTime(info.firstTime) + ' → last ' + fmtTime(info.lastTime) + (isFin(info.maxTime) ? ' · max at ' + fmtTime(info.maxTime) : '') + '</span>' +
            '<span class="dlv-hist-d-acts"><span class="dlv-hist-lbl">Show samples</span>' +
              '<button type="button" class="dlv-hist-btn" data-nav="highlight">Highlight</button>' +
              '<button type="button" class="dlv-hist-btn" data-nav="first">Jump to first</button>' +
              '<button type="button" class="dlv-hist-btn" data-nav="max">Jump to max</button>' +
              '<button type="button" class="dlv-hist-btn" data-nav="zoom">Zoom to samples</button>' +
              '<button type="button" class="dlv-hist-btn" data-nav="clearhl">Clear highlight</button></span>';
        }
        D.details.innerHTML = html;
      }
      function tooltipHtml(r, c) {
        if (S.owner) return ownerTooltipHtml(r, c);
        var view = S.view, info = H().cellInfo(view, r, c);
        if (!info) return '';
        var dec = Math.min(4, S.dec + 1), u = displayUnit(view.cellUnit);
        var head = '<div class="dlv-hist-tip-head">' + axisText(view, 'col', c) + (view.rows ? '<br>' + axisText(view, 'row', r) : '') + '</div>';
        if (info.count === 0) return head + '<div class="dlv-hist-tip-row">No samples</div>';
        var mh = minHitsOf(activeDef()), stat = statOf(activeDef());
        var hits = H().effectiveHits(view, r * S.C + c, stat);
        return head + '<div class="dlv-hist-tip-grid">' +
          '<span>Samples</span><b>' + fmtK(info.count) + (info.weighted ? ' · ' + fmtK(Number(info.effectiveHits.toFixed(1))) + ' weighted' : '') + (hits < mh ? ' <i>(below ' + mh + ')</i>' : '') + '</b>' +
          (info.weighted ? '<span>Weighted avg</span><b>' + formatValue(info.weightedAverage, dec) + ' ' + esc(u) + '</b>' : '') +
          '<span>Average</span><b>' + formatValue(info.average, dec) + ' ' + esc(u) + '</b>' +
          '<span>Min / Max</span><b>' + formatValue(info.min, dec) + ' / ' + formatValue(info.max, dec) + '</b>' +
          '<span>First / Last</span><b>' + formatValue(info.first, dec) + ' / ' + formatValue(info.last, dec) + '</b>' +
          '<span>Time</span><b>' + fmtTime(info.firstTime) + ' → ' + fmtTime(info.lastTime) + '</b></div>';
      }
      function navAction(which) {
        var view = S.view, d = S.detail, nav = glue.navigate || {};
        if (!view || !d) return;
        var info = H().cellInfo(view, d.r, d.c);
        if (!info) return;
        var call = function (fn, args, msg) { if (typeof nav[fn] !== 'function') { toast('Viewer navigation is not available here'); return; } try { nav[fn].apply(nav, args); } catch (e) { toast('Could not ' + msg); } };
        if (which === 'highlight') { if (!info.sampleIndices || !info.sampleIndices.length) return toast('No samples to highlight'); call('highlightIndices', [new Int32Array(info.sampleIndices)], 'highlight'); }
        else if (which === 'clearhl') call('highlightIndices', [null], 'clear the highlight');
        else if (which === 'first') { if (!isFin(info.firstTime)) return; call('setCursor', [info.firstTime], 'move the cursor'); }
        else if (which === 'max') { if (!isFin(info.maxTime)) return; call('setCursor', [info.maxTime], 'move the cursor'); }
        else if (which === 'zoom') { if (!isFin(info.firstTime) || !isFin(info.lastTime)) return; call('setRange', [info.firstTime, info.lastTime], 'zoom'); }
      }

      // ---- clipboard ---------------------------------------------------------------------------------
      function writeClipboard(text, done) {
        var fallback = function () { try { window.prompt('Copy this value:', text); } catch (e) { /* headless */ } done(); };
        if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
          try { navigator.clipboard.writeText(text).then(done, fallback); } catch (e) { fallback(); }
        } else fallback();
      }
      function cornerLabel(view) {
        var left = view.rows ? (view.labels.row || 'Row') : H().statLabel(statOf(activeDef()));
        return shortName(left) + ' \\ ' + shortName(view.labels.column || 'Column');
      }
      function copySelection(withAxis) {
        var view = S.view, def = activeDef();
        if (!view || !view.cells) { toast('Nothing to copy'); return; }
        var stat = statOf(def), showLow = showLowOf(def);
        var rows = S.owner ? ownerCopyRows(withAxis) : H().toRows(view, stat, { includeAxis: withAxis, precision: S.dec, minHits: showLow ? null : minHitsOf(def), nanAs: '' });
        // The engine's raw axis labels (10 significant figures) leak into the clipboard the same way
        // they used to leak onto screen; round them to match what the table now displays, so what you
        // copy is what you saw, not a column of 21.573482910273-style noise pasted into a tuning sheet.
        if (withAxis && rows.length) {
          var axDecCopy = axisDecimalsFor(def);
          for (var ci = 1; ci < rows[0].length; ci++) rows[0][ci] = roundAxisLabel(rows[0][ci], axDecCopy);
          for (var ri = 1; ri < rows.length; ri++) rows[ri][0] = roundAxisLabel(rows[ri][0], axDecCopy);
        }
        var b = selectionBounds(S.sel, S.R, S.C), off = withAxis ? 1 : 0, nR = S.R, nC = S.C;
        if (b) {
          var out = [], r, c, line;
          if (withAxis) { line = [rows[0][0]]; for (c = b.c0; c <= b.c1; c++) line.push(rows[0][c + 1]); out.push(line); }
          for (r = b.r0; r <= b.r1; r++) {
            line = withAxis ? [rows[r + off][0]] : [];
            for (c = b.c0; c <= b.c1; c++) line.push(S.sel[r * S.C + c] ? rows[r + off][c + off] : '');
            out.push(line);
          }
          rows = out; nR = b.r1 - b.r0 + 1; nC = b.c1 - b.c0 + 1;
        }
        if (withAxis && rows.length) rows[0][0] = cornerLabel(view);
        var text = toTsv(rows);
        writeClipboard(text, function () { toast('Copied ' + nR + '×' + nC + ' cells' + (withAxis ? ' with axis' : '')); });
        return text;
      }

      // ---- tooltip + floating menu ------------------------------------------------------------------
      function hideTip() { clearTimeout(S.tipTimer); S.tipTimer = null; if (S.tip) S.tip.hidden = true; }
      function positionTip(x, y) {
        var t = S.tip; if (!t || t.hidden) return;
        var w = t.offsetWidth, h = t.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
        var left = x + 14, top = y + 16;
        if (left + w > vw - 8) left = Math.max(8, x - w - 12);
        if (top + h > vh - 8) top = Math.max(8, y - h - 12);
        t.style.left = left + 'px'; t.style.top = top + 'px';
      }
      function scheduleTip(cell, x, y) {
        clearTimeout(S.tipTimer);
        S.tipTimer = setTimeout(function () {
          if (S.destroyed || S.drag || !S.view) return;
          if (!S.tip) { S.tip = document.createElement('div'); S.tip.className = 'dlv-hist-tip'; document.body.appendChild(S.tip); }
          S.tip.innerHTML = tooltipHtml(cell.r, cell.c);
          S.tip.hidden = false;
          positionTip(x, y);
        }, TIP_DELAY_MS);
      }
      function closeMenu() { if (S.menu) { if (S.menu.parentNode) S.menu.parentNode.removeChild(S.menu); S.menu = null; } }
      function openMenu(x, y, items) {
        closeMenu();
        var m = document.createElement('div'); m.className = 'dlv-hist-menu';
        var html = '';
        for (var i = 0; i < items.length; i++) {
          var it = items[i];
          if (it === 'sep') { html += '<div class="dlv-hist-menu-sep"></div>'; continue; }
          html += '<button type="button" class="dlv-hist-menu-item' + (it.danger ? ' danger' : '') + '" data-i="' + i + '"' + (it.disabled ? ' disabled' : '') + '>' + esc(it.label) + '</button>';
        }
        m.innerHTML = html;
        m.addEventListener('click', function (e) {
          var b = closestAttr(e.target, 'data-i', m);
          e.stopPropagation();
          if (!b || b.disabled) return;
          var it = items[parseInt(b.getAttribute('data-i'), 10)];
          closeMenu();
          if (it && typeof it.action === 'function') it.action();
        });
        m.addEventListener('contextmenu', function (e) { e.preventDefault(); });
        document.body.appendChild(m);
        var vw = window.innerWidth, vh = window.innerHeight;
        m.style.left = Math.max(4, Math.min(x, vw - m.offsetWidth - 8)) + 'px';
        m.style.top = Math.max(4, Math.min(y, vh - m.offsetHeight - 8)) + 'px';
        S.menu = m;
      }

      // ---- toolbar sync ------------------------------------------------------------------------------
      function setSeg(name, value) {
        var seg = D.tb.querySelector('[data-seg="' + name + '"]');
        if (!seg) return;
        var btns = seg.querySelectorAll('button');
        for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('active', btns[i].getAttribute('data-v') === value);
      }
      function syncToolbar() {
        var def = activeDef(), has = !!def, live = !!(S.view && S.view.cells);
        D.defsel.value = def ? def.id : '';
        var pi = has ? pageInfo(def) : null, ownerOn = !!(pi && ownerModeOf(def));
        D.pager.hidden = !pi;
        if (pi) {
          D.pageName.textContent = ownerOn ? 'All pages' : (pi.label || '—');
          D.pageCount.textContent = ownerOn ? pi.values.length + ' pages' : (pi.values.length ? (pi.index + 1) + '/' + pi.values.length : '0');
          D.pager.title = ownerOn ? 'Owner map across ' + pi.values.length + ' pages of ' + def.pages.pattern : (pi.values.length ? 'Page ' + (pi.index + 1) + ' of ' + pi.values.length + ' of ' + def.pages.pattern : 'No channel in this log matches ' + def.pages.pattern);
          var arrows = D.tb.querySelectorAll('.dlv-hist-page-arrow');
          for (var ai = 0; ai < arrows.length; ai++) arrows[ai].disabled = ownerOn || pi.values.length < 2;
          var ob = D.tb.querySelector('[data-a="pageowner"]');
          ob.classList.toggle('on', ownerOn); ob.disabled = pi.values.length < 2 && !ownerOn;
        }
        var obs = D.tb.querySelector('[data-f="ownerby"]');
        obs.hidden = !ownerOn;
        if (ownerOn) {
          obs.value = ownerByOf(def);
          var wopt = obs.querySelector('option[value="weight"]');
          if (wopt) wopt.disabled = !def.weightParameter;
        }
        var wb = D.tb.querySelector('[data-seg="stat"] [data-v="weighted"]');
        if (wb) wb.hidden = !(has && def.weightParameter);
        setSeg('stat', has ? statOf(def) : '');
        setSeg('range', has ? (def.dataRange === 'selection' ? 'selection' : 'entire') : '');
        var cs = has && isObj(def.colorScale) ? def.colorScale : {};
        setSeg('color', has ? (cs.mode === 'manual' ? 'manual' : 'auto') : '');
        D.manual.hidden = !(has && cs.mode === 'manual');
        var f = function (name) { return D.tb.querySelector('[data-f="' + name + '"]'); };
        if (document.activeElement !== f('minhits')) f('minhits').value = has ? String(minHitsOf(def)) : '';
        if (document.activeElement !== f('cmin')) f('cmin').value = isFin(cs.min) ? cs.min : (S.scale && !S.scale.empty ? Number(S.scale.min.toFixed(Math.max(S.dec, 1))) : '');
        if (document.activeElement !== f('cmax')) f('cmax').value = isFin(cs.max) ? cs.max : (S.scale && !S.scale.empty ? Number(S.scale.max.toFixed(Math.max(S.dec, 1))) : '');
        if (document.activeElement !== f('ccenter')) f('ccenter').value = isFin(cs.center) ? cs.center : (S.scale && S.scale.kind === 'diverging' ? S.scale.center : '');
        f('redend').value = cs.higherIsWorse === true ? 'high' : (cs.higherIsWorse === false ? 'low' : 'none');
        D.tb.querySelector('[data-a="lowcount"]').classList.toggle('on', has && showLowOf(def));
        var inv = D.tb.querySelector('[data-a="invert"]');
        inv.classList.toggle('on', has && def.orientation === 'inverted');
        inv.disabled = !(has && def.rowAxis);
        var dis = ['edit', 'copy', 'copyaxis', 'clear', 'lowcount'];
        for (var i = 0; i < dis.length; i++) { var b = D.tb.querySelector('[data-a="' + dis[i] + '"]'); if (b) b.disabled = dis[i] === 'edit' ? !has : !live; }
        var segs = D.tb.querySelectorAll('[data-seg] button, [data-f]');
        for (var j = 0; j < segs.length; j++) segs[j].disabled = !has;
      }
      function setStatistic(id) {
        var def = activeDef(), s = H().normalizeStat(id);
        if (!def || !s || s === statOf(def)) return;
        def.statistic = s; changed(); applyCells(); syncToolbar();
        if (S.detail) renderDetails(S.detail.r, S.detail.c); else renderDetails();
      }
      function setRangeMode(mode) {
        var def = activeDef();
        if (!def) return;
        var m = mode === 'selection' ? 'selection' : 'entire';
        if (def.dataRange === m) return;
        def.dataRange = m; changed(); markDirty(def.id); renderActive('range');
      }
      function setColorMode(mode) {
        var def = activeDef();
        if (!def) return;
        if (!isObj(def.colorScale)) def.colorScale = { mode: 'auto', min: null, center: null, max: null, higherIsWorse: null };
        def.colorScale.mode = mode === 'manual' ? 'manual' : 'auto';
        if (def.colorScale.mode === 'manual' && S.scale && !S.scale.empty) {
          if (!isFin(def.colorScale.min)) def.colorScale.min = Number(S.scale.min.toFixed(Math.max(S.dec, 1)));
          if (!isFin(def.colorScale.max)) def.colorScale.max = Number(S.scale.max.toFixed(Math.max(S.dec, 1)));
          if (!isFin(def.colorScale.center) && S.scale.kind === 'diverging') def.colorScale.center = S.scale.center;
        }
        changed(); applyCells(); syncToolbar();
      }
      function invertAxes() {
        var def = activeDef();
        if (!def) return;
        if (!def.rowAxis) { toast('This histogram has a single axis'); return; }
        def.orientation = def.orientation === 'inverted' ? 'normal' : 'inverted';
        if (S.sel && S.view) {   // carry the selection across the transpose
          var R = S.R, C = S.C, t = new Uint8Array(R * C);
          for (var r = 0; r < R; r++) for (var c = 0; c < C; c++) t[c * R + r] = S.sel[r * C + c];
          S.pendingSel = t;
          if (S.detail) S.detail = { r: S.detail.c, c: S.detail.r };
        }
        changed(); renderActive('invert');
      }

      // ---- events ------------------------------------------------------------------------------------
      function onHostClick(e) {
        var b = closestAttr(e.target, 'data-a', hostEl);
        if (b) {
          var a = b.getAttribute('data-a'), def = activeDef();
          if (a === 'add') addDef();
          else if (a === 'examples') loadExamples();
        else if (a === 'library') openLibrary();
          else if (a === 'listmenu') { var rc = b.getBoundingClientRect(); openMenu(rc.left, rc.bottom + 4, listMenuItems()); e.stopPropagation(); }
          else if (a === 'collapse') setCollapsed(true);
          else if (a === 'expand') setCollapsed(false);
          else if (a === 'edit') { if (def) openEditor(def, null); }
          else if (a === 'enable') { if (def) { def.enabled = true; changed(); renderList(); renderActive('enable'); } }
          else if (a === 'disable') { if (def) { def.enabled = false; changed(); renderList(); renderActive('disable'); } }
          else if (a === 'choose') { if (def) openEditor(def, b.getAttribute('data-slot')); }
          else if (a === 'lowcount') { if (def) { if (!isObj(def.display)) def.display = {}; def.display.showLowCount = !showLowOf(def); changed(); applyCells(); syncToolbar(); } }
          else if (a === 'invert') invertAxes();
          else if (a === 'copy') copySelection(false);
          else if (a === 'copyaxis') copySelection(true);
          else if (a === 'pageprev') { if (def) stepPage(def, -1); }
          else if (a === 'pagenext') { if (def) stepPage(def, 1); }
          else if (a === 'pageowner') { if (def) setOwnerMode(def, !ownerModeOf(def)); }
          else if (a === 'pagemenu') { if (def) { var pr = b.getBoundingClientRect(); openMenu(pr.left, pr.bottom + 4, pageMenuItems(def)); e.stopPropagation(); } }
          else if (a === 'clear') { if (def) { markDirty(def.id); renderActive('clear'); toast('Recomputed'); } }
          return;
        }
        var seg = closestAttr(e.target, 'data-seg', hostEl);
        var v = closestAttr(e.target, 'data-v', hostEl);
        if (seg && v) {
          var name = seg.getAttribute('data-seg'), val = v.getAttribute('data-v');
          if (name === 'stat') setStatistic(val); else if (name === 'range') setRangeMode(val); else if (name === 'color') setColorMode(val);
          return;
        }
        var nav = closestAttr(e.target, 'data-nav', hostEl);
        if (nav) { navAction(nav.getAttribute('data-nav')); return; }
        var gp = closestAttr(e.target, 'data-gopage', hostEl);
        if (gp) { var gd = activeDef(); if (gd) goToPage(gd, gp.getAttribute('data-gopage')); return; }
        var rowMenu = e.target.classList && e.target.classList.contains('dlv-hist-row-menu') ? e.target : null;
        var row = closestAttr(e.target, 'data-id', hostEl);
        if (row) {
          var d = defById(row.getAttribute('data-id'));
          if (!d) return;
          if (rowMenu) { var r2 = rowMenu.getBoundingClientRect(); openMenu(r2.left, r2.bottom + 4, rowMenuItems(d)); e.stopPropagation(); return; }
          if (e.target.classList && e.target.classList.contains('dlv-hist-row-en')) { d.enabled = !!e.target.checked; changed(); renderList(); if (d.id === S.activeId) renderActive('toggle'); return; }
          activate(d.id);
        }
      }
      function onHostChange(e) {
        var t = e.target, def = activeDef();
        if (t === D.defsel) { activate(t.value); return; }
        if (t === D.file) { importFile(t.files && t.files[0]); t.value = ''; return; }
        var miss = t.getAttribute && t.getAttribute('data-miss');
        if (miss != null && S.missing) { applyReplacement(S.missing[parseInt(miss, 10)], t.value); return; }
        var f = t.getAttribute && t.getAttribute('data-f');
        if (!f || !def) return;
        if (f === 'ownerby') { if (!isObj(def.display)) def.display = {}; def.display.ownerBy = t.value; changed(); S.owner = null; renderActive('ownerby'); }
        else if (f === 'redend') { if (!isObj(def.colorScale)) def.colorScale = {}; def.colorScale.higherIsWorse = t.value === 'high' ? true : (t.value === 'low' ? false : null); changed(); applyCells(); }
        else if (f === 'cmin' || f === 'cmax' || f === 'ccenter') {
          if (!isObj(def.colorScale)) def.colorScale = { mode: 'manual' };
          var num = t.value === '' ? null : parseFloat(t.value);
          def.colorScale[f === 'cmin' ? 'min' : f === 'cmax' ? 'max' : 'center'] = isFin(num) ? num : null;
          changed(); applyCells();
        }
      }
      function onHostInput(e) {
        var t = e.target, def = activeDef();
        if (!def || !t.getAttribute || t.getAttribute('data-f') !== 'minhits') return;
        var n = parseInt(t.value, 10);
        if (!isFin(n) || n < 0) n = 0;
        if (n === minHitsOf(def)) return;
        def.minimumHits = n; changed(); applyCells();
        if (S.detail) renderDetails(S.detail.r, S.detail.c); else renderDetails();
      }
      function onHostContext(e) {
        var row = closestAttr(e.target, 'data-id', hostEl);
        if (!row) return;
        var d = defById(row.getAttribute('data-id'));
        if (!d) return;
        e.preventDefault();
        openMenu(e.clientX, e.clientY, rowMenuItems(d));
      }
      function onWrapDown(e) {
        if (e.button !== 0 || !S.view) return;
        var cell = cellFromNode(e.target);
        var th = closestAttr(e.target, 'data-c', D.wrap) || closestAttr(e.target, 'data-r', D.wrap);
        var corner = !cell && !th && e.target.closest && e.target.closest('.dlv-hist-corner');
        var mod = e.ctrlKey || e.metaKey;
        if (cell) {
          e.preventDefault();
          try { D.wrap.focus({ preventScroll: true }); } catch (x) { D.wrap.focus(); }
          hideTip();
          if (mod) { S.sel[cell.k] = S.sel[cell.k] ? 0 : 1; S.anchor = { r: cell.r, c: cell.c }; applySelection(); renderDetails(cell.r, cell.c); return; }
          if (e.shiftKey && S.anchor) { selectRect(normalizeRect(S.anchor, cell), null); renderDetails(cell.r, cell.c); return; }
          S.anchor = { r: cell.r, c: cell.c };
          S.drag = { anchor: S.anchor, moved: false, last: cell.k };
          selectRect(normalizeRect(S.anchor, cell), null);
          return;
        }
        if (th) {
          e.preventDefault();
          var base = mod ? new Uint8Array(S.sel) : null;
          if (th.hasAttribute('data-c')) { var c = parseInt(th.getAttribute('data-c'), 10); selectRect({ r0: 0, r1: S.R - 1, c0: c, c1: c }, base); }
          else { var r = parseInt(th.getAttribute('data-r'), 10); selectRect({ r0: r, r1: r, c0: 0, c1: S.C - 1 }, base); }
          renderDetails();
          return;
        }
        if (corner) { e.preventDefault(); selectAll(); }
      }
      function onWrapOver(e) {
        var cell = cellFromNode(e.target);
        if (S.drag) {
          if (!cell || cell.k === S.drag.last) return;
          S.drag.last = cell.k; S.drag.moved = true;
          selectRect(normalizeRect(S.drag.anchor, cell), null);
          return;
        }
        if (cell) scheduleTip(cell, e.clientX, e.clientY); else hideTip();
      }
      function onWrapMove(e) { if (S.tip && !S.tip.hidden) positionTip(e.clientX, e.clientY); }
      function onDocUp() {
        if (!S.drag) return;
        var d = S.drag; S.drag = null;
        if (!d.moved) renderDetails(d.anchor.r, d.anchor.c); else renderDetails();
      }
      function onDocClick() { closeMenu(); }
      function onKey(e) {
        if (S.destroyed) return;
        if (!(S.mouseInside || hostEl.contains(document.activeElement))) return;
        if (isEditable(document.activeElement)) return;
        var mod = e.ctrlKey || e.metaKey, key = e.key;
        if (key === 'Escape') { if (S.menu) closeMenu(); else { clearSelection(); renderDetails(); } hideTip(); return; }
        if (!mod && (key === 'ArrowLeft' || key === 'ArrowRight')) {
          var pd = activeDef();
          if (pd && H().usesPages(pd) && !ownerModeOf(pd)) { e.preventDefault(); stepPage(pd, key === 'ArrowRight' ? 1 : -1); return; }
        }
        if (!S.view) return;
        if (mod && (key === 'c' || key === 'C')) { e.preventDefault(); copySelection(e.shiftKey); return; }
        if (mod && (key === 'a' || key === 'A')) { e.preventDefault(); selectAll(); }
      }
      function onRange() {
        var def = activeDef();
        if (!def || def.dataRange !== 'selection') return;
        clearTimeout(S.rangeTimer);
        S.rangeTimer = setTimeout(function () { if (S.destroyed) return; markDirty(def.id); renderActive('range'); }, RANGE_DEBOUNCE_MS);
      }
      function sub(node, ev, fn, opts) { node.addEventListener(ev, fn, opts || false); S.unsub.push(function () { node.removeEventListener(ev, fn, opts || false); }); }
      sub(hostEl, 'click', onHostClick);
      sub(hostEl, 'change', onHostChange);
      sub(hostEl, 'input', onHostInput);
      sub(hostEl, 'contextmenu', onHostContext);
      sub(hostEl, 'mouseenter', function () { S.mouseInside = true; });
      sub(hostEl, 'mouseleave', function () { S.mouseInside = false; hideTip(); });
      sub(D.wrap, 'mousedown', onWrapDown);
      sub(D.wrap, 'mouseover', onWrapOver);
      sub(D.wrap, 'mousemove', onWrapMove);
      sub(D.wrap, 'mouseleave', hideTip);
      sub(D.wrap, 'scroll', hideTip, { passive: true });
      sub(document, 'mouseup', onDocUp);
      sub(document, 'click', onDocClick);
      sub(document, 'keydown', onKey);
      if (typeof glue.onRangeChange === 'function') { try { glue.onRangeChange(onRange); } catch (e0) { /* optional */ } }

      // ---- controller ---------------------------------------------------------------------------------
      var ctl = {
        setDefs: function (defs) {
          S.defs = [];
          if (Array.isArray(defs)) for (var i = 0; i < defs.length; i++) if (isObj(defs[i])) S.defs.push(H().migrateDef(defs[i]));
          S.entries = {}; S.detail = null; S.anchor = null;
          activate(defById(S.activeId) ? S.activeId : null, true);
        },
        getDefs: function () { return S.defs; },
        setActive: function (id) { activate(id); },
        getActive: function () { return S.activeId; },
        recompute: function () { var d = activeDef(); if (d) { markDirty(d.id); renderActive('recompute'); } },
        refresh: function () { S.entries = {}; S.filterCache = {}; S.resolver = null; renderList(); renderActive('refresh'); },
        importPackage: importPackage,
        openLibrary: openLibrary,
        // pages
        setPage: function (value) { var d = activeDef(); if (d) setPage(d, value); },
        stepPage: function (delta) { var d = activeDef(); if (d) stepPage(d, delta || 1); },
        pageInfo: function () { return pageInfo(activeDef()); },
        combinePages: combinePagesInList,
        setOwnerMode: function (on) { var d = activeDef(); if (d) setOwnerMode(d, !!on); },
        setOwnerBy: function (mode) { var d = activeDef(); if (!d) return; if (!isObj(d.display)) d.display = {}; d.display.ownerBy = mode; changed(); S.owner = null; renderActive('ownerby'); },
        // The layer under the table, for the host to fill (gauges). Never touched by renders here.
        backLayer: function () { return D.back; },
        tableFootprint: tableFootprint,
        ownerTable: function () { return S.owner; },
        setStatistic: setStatistic,
        setRangeMode: setRangeMode,
        // dataX is a TIME value (or null = latest), in the same coordinate space the host's other
        // per-cursor readouts use -- we re-resolve it against OUR OWN data().time rather than take an
        // index from the caller, because that array can be the full-resolution set while the caller's
        // index is walked against a shorter, decimated display set (see histogramRange() upstream).
        setCursor: function (dataX) {
          if (S.destroyed) return;
          S.cursorTime = (dataX == null) ? null : dataX;
          applyCursorMark();
        },
        getResult: function () { return S.view; },
        getSelection: function () { return S.sel; },
        copy: copySelection,
        stats: function () { return { computeCount: S.computeCount, lastElapsedMs: S.lastElapsed }; },
        resolver: function () { ensureData(); return S.resolver; },
        destroy: function () {
          S.destroyed = true;
          clearTimeout(S.rangeTimer); hideTip(); closeMenu();
          if (S.tip && S.tip.parentNode) S.tip.parentNode.removeChild(S.tip);
          for (var i = 0; i < S.unsub.length; i++) S.unsub[i]();
          S.unsub = [];
          if (typeof glue.offRangeChange === 'function') { try { glue.offRangeChange(onRange); } catch (e) { /* optional */ } }
          hostEl.innerHTML = ''; hostEl.classList.remove('dlv-hist');
        }
      };
      renderList();
      renderActive('mount');
      return ctl;
    };
  }

  // ================================================================================================
  // 9. Public API namespace
  // ================================================================================================
  // thumbnailSvg(def, view, table, scale) -> SVG string for the shared library. With a computed view,
  // its stat table and colour scale it paints the REAL cell colours (call it at publish time from the
  // live table); without a log it draws a schematic grid of the def's shape with a canned gradient.
  function thumbnailSvg(def, view, table, scale) {
    var esc = function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
    var R, C, colorAt;
    if (view && view.shape && table && scale) {
      R = view.shape.rows; C = view.shape.cols;
      colorAt = function (r, c) { return colorFor(table[r * C + c], scale) || '#16161a'; };
    } else {
      var cb = def && def.columnAxis && Array.isArray(def.columnAxis.breakpoints) ? def.columnAxis.breakpoints.length : 0;
      var rb = def && def.rowAxis && Array.isArray(def.rowAxis.breakpoints) ? def.rowAxis.breakpoints.length : 0;
      C = Math.max(4, Math.min(24, cb || 12)); R = rb ? Math.max(2, Math.min(16, rb)) : 4;
      var sc = { kind: 'sequential', min: 0, max: 1, higherIsWorse: true };
      colorAt = function (r, c) { var v = (c / Math.max(1, C - 1)) * 0.7 + (r / Math.max(1, R - 1)) * 0.3; return colorFor(v * v, sc) || '#16161a'; };
    }
    var W = 320, Hh = 180, pad = 8, top = 28, left = 30, bottom = 16;
    var cw = (W - left - pad) / C, ch = (Hh - top - bottom) / R;
    var out = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + Hh + '" preserveAspectRatio="xMidYMid meet">', '<rect width="100%" height="100%" rx="10" fill="#0d0d11"/>'];
    out.push('<text x="' + pad + '" y="17" font-family="system-ui,sans-serif" font-size="12" font-weight="700" fill="#e6e6ea">' + esc(String((def && def.name) || 'Histogram').slice(0, 40)) + '</text>');
    for (var r = 0; r < R; r++) for (var c = 0; c < C; c++) {
      out.push('<rect x="' + (left + c * cw).toFixed(1) + '" y="' + (top + r * ch).toFixed(1) + '" width="' + Math.max(0.5, cw - 1).toFixed(1) + '" height="' + Math.max(0.5, ch - 1).toFixed(1) + '" fill="' + colorAt(r, c) + '"/>');
    }
    var labels = (view && view.labels) || {};
    var pl = function (p) { return p ? (p.label || p.channel || p.role || '') : ''; };
    var colLbl = labels.column || (def && def.columnAxis ? pl(def.columnAxis.parameter) : '');
    var rowLbl = labels.row || (def && def.rowAxis ? pl(def.rowAxis.parameter) : '');
    if (colLbl) out.push('<text x="' + (left + (W - left - pad) / 2).toFixed(1) + '" y="' + (Hh - 4) + '" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="#8a8a94">' + esc(String(colLbl).slice(0, 32)) + '</text>');
    if (rowLbl) out.push('<text transform="translate(10 ' + (top + (Hh - top - bottom) / 2).toFixed(1) + ') rotate(-90)" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="#8a8a94">' + esc(String(rowLbl).slice(0, 26)) + '</text>');
    out.push('</svg>');
    return out.join('');
  }

  var HistogramUI = {
    thumbnailSvg: thumbnailSvg,
    VERSION: 1,
    // pure helpers
    colorFor: colorFor, makeScale: makeScale, legendGradient: legendGradient, decimalsFor: decimalsFor, formatValue: formatValue,
    roundAxisLabel: roundAxisLabel, axisDecimalsFor: axisDecimalsFor,
    normalizeRect: normalizeRect, selectionBounds: selectionBounds, toTsv: toTsv, formatThousands: fmtK,
    makeParamResolver: makeParamResolver, compileFilter: compileFilter, EXAMPLE_DEFS: EXAMPLE_DEFS,
    EXAMPLE_MATH_CHANNELS: EXAMPLE_MATH_CHANNELS,
    // DOM layer (attached below when a document exists)
    mount: function () { throw new Error('HistogramUI.mount needs a DOM'); }
  };
  if (typeof document !== 'undefined') attachDomLayer(HistogramUI);
  global.HistogramUI = HistogramUI;
  if (typeof module !== 'undefined' && module.exports) module.exports = HistogramUI;
})(typeof window !== 'undefined' ? window : globalThis);
