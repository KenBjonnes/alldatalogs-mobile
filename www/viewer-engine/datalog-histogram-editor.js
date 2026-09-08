/* =================================================================================================
 * datalog-histogram-editor.js -- the BigData "Histograms" DEFINITION EDITOR (Phase 2: editing UI).
 *
 * WHAT THIS IS
 *   The panel a tuner uses to build / edit one histogram definition, modeled on HP Tuners VCM
 *   Scanner's table & graph configuration (Cell parameter, Column axis, Row axis, Filter, Display).
 *   It edits a DEEP COPY of the definition, validates continuously, and hands the validated copy to
 *   opts.onSave. Nothing here computes a histogram: datalog-histogram.js (global `Histogram`) owns
 *   the schema + engine and datalog-expr.js (global `DatalogExpr`) owns math/filter expressions.
 *   datalog-presets.js supplies roles, unit families and channel grouping (read as globals, lazily,
 *   so load order only matters at call time and node tests can attach them to globalThis).
 *
 * PUBLIC API (global `HistogramEditor`)
 *   open(def, opts) -> { close() }            the editor overlay (DOM only)
 *   channelPicker(anchorEl, opts) -> popover  reusable channel/role/math picker (DOM only)
 *   normalizeAxisPaste(text)                  PURE  -- pasted row / column / 2-D table -> axis values
 *   validateForm(def, ctx)                    PURE  -- schema + expressions + breakpoints + unit families
 *   inferUnitForMath(expression, unitByChannel)  PURE
 *   defaultBreakpointsFor(param, data, resolver) PURE -- "nice" 8..20 breakpoints from the live data
 *   makeLocalResolver(data, resolvedRoles, unitByChannel)  the fallback PARAM resolver (channel -> role -> math)
 *
 * PASTE RULES (normalizeAxisPaste)
 *   - One row (tab / comma / semicolon / space separated) or one column (one value per line) -> all
 *     values, in order, via Histogram.parseBreakpoints (units, negatives, scientific, de-dupe).
 *   - A 2-D block (several rows AND several columns, e.g. a table copied from VCM Editor / Excel
 *     "with axes") is a TABLE paste ('hpt-table'): the FIRST ROW is the axis. When that row's first
 *     cell is blank or a label (the corner cell of an HPT copy) it is skipped; a fully numeric grid
 *     also takes its first row. Cells split on tabs; when there are no tabs at all, on commas or
 *     semicolons. Spaces never split table cells, so "1000 rpm" stays one cell.
 *
 * FILTER MODEL
 *   def.filter = { mode:'simple'|'advanced', clauses, expression }. In simple mode the editor keeps
 *   `expression` in sync (DatalogExpr.buildSimpleFilter(clauses)) on every change, so consumers can
 *   always compile `filter.expression` regardless of mode.
 *
 * Style: ES5 vanilla JS (plain <script> in the viewer, require() in node). DOM layer only when
 * `document` exists. No frameworks. CSS in datalog-histogram-editor.css (dlv-hg-* classes).
 * =============================================================================================== */
(function (global) {
  'use strict';

  // ================================================================================================
  // 0. Lazy access to the sibling modules (globals). Presets functions are plain top-level vars in a
  //    classic <script>, i.e. window properties; under node the test attaches them to globalThis.
  // ================================================================================================
  function H() { return global.Histogram; }
  function X() { return global.DatalogExpr; }
  function P(name) { return typeof global[name] !== 'undefined' ? global[name] : undefined; }

  // buildSimpleFilter THROWS on a channel name it cannot write as a reference (one containing both
  // ']' and '"' -- there is no escape for that). The editor calls it on every keystroke while a
  // tuner builds a filter, so it is always wrapped: an unwritable name becomes a validation error
  // next to the row, never an exception that kills the dialog mid-edit.
  function buildSimpleSafe(clauses) {
    if (!X() || !Array.isArray(clauses) || !clauses.length) return { text: '', error: null };
    try { return { text: X().buildSimpleFilter(clauses), error: null }; }
    catch (e) { return { text: '', error: e && e.message ? e.message : String(e) }; }
  }

  function isFin(v) { return typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity; }
  function isObj(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function trim(s) { return String(s == null ? '' : s).replace(/^\s+|\s+$/g, ''); }
  function fmtNum(v) { return isFin(v) ? String(Number(v.toPrecision(10))) : ''; }
  function sameUnit(a, b) { return trim(a).toLowerCase() === trim(b).toLowerCase(); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function setPath(obj, path, val) {
    var parts = path.split('.'), o = obj;
    for (var i = 0; i < parts.length - 1; i++) { o = o[parts[i]] = (o[parts[i]] == null ? {} : o[parts[i]]); }
    o[parts[parts.length - 1]] = val;
  }
  function getPath(obj, path) {
    var parts = path.split('.'), o = obj;
    for (var i = 0; i < parts.length; i++) { if (o == null) return undefined; o = o[parts[i]]; }
    return o;
  }
  function numberToken(t) {
    // Same shape as Histogram.parseNumberToken (not exported): a clean number with optional unit tail.
    var s = String(t).replace(/^[\(\[\{"'`°º~≈$]+/, '').replace(/[\)\]\}"'`]+$/, '').replace(/−/g, '-');
    var m = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)(.*)$/.exec(trim(s));
    if (!m || /\d/.test(m[2])) return null;
    var v = parseFloat(m[1]);
    return isFin(v) ? v : null;
  }
  function isLabelLike(cell) { return trim(cell) === '' || numberToken(cell) === null; }

  // ================================================================================================
  // 1. normalizeAxisPaste
  // ================================================================================================
  function splitCells(line, sep) {
    if (sep === 'tab') return line.split('\t');
    if (sep === 'comma') return line.split(/[,;]/);
    return [line];
  }
  function normalizeAxisPaste(text) {
    var out = { values: [], rejected: [], units: [], detected: 'newline', rows: 0, cols: 0, source: 'column' };
    if (text == null) return out;
    if (Array.isArray(text)) text = text.join('\n');
    var s = String(text).replace(/\r\n?/g, '\n');
    var lines = s.split('\n').filter(function (l) { return trim(l) !== ''; });
    out.rows = lines.length;
    if (!lines.length) return out;
    var hasTab = s.indexOf('\t') >= 0;
    var cellSep = hasTab ? 'tab' : (/[,;]/.test(s) ? 'comma' : null);
    var grid = lines.map(function (l) { return cellSep ? splitCells(l, cellSep) : [l]; });
    var maxCols = 0;
    grid.forEach(function (r) { if (r.length > maxCols) maxCols = r.length; });
    out.cols = maxCols;
    var pb = H().parseBreakpoints;
    var res;
    if (lines.length > 1 && maxCols > 1) {
      // 2-D block: the first row is the axis (skip a blank / label corner cell).
      var first = grid[0].slice();
      if (isLabelLike(first[0])) first = first.slice(1);
      res = pb(first.join('\t'));
      out.detected = 'hpt-table';
      out.source = 'row';
    } else if (lines.length > 1) {
      res = pb(lines.join('\n'));
      out.detected = 'newline';
      out.source = 'column';
    } else {
      var line = lines[0];
      var kinds = [];
      if (line.indexOf('\t') >= 0) kinds.push('tab');
      if (/[,;]/.test(line)) kinds.push('comma');
      if (/\S[ ]+\S/.test(trim(line))) kinds.push('space');
      res = pb(line);
      out.detected = kinds.length > 1 ? 'mixed' : (kinds[0] || 'newline');
      out.source = 'row';
    }
    out.values = res.values; out.rejected = res.rejected; out.units = res.units;
    return out;
  }

  // ================================================================================================
  // 2. Unit helpers (thin wrappers over presets; safe when presets are absent)
  // ================================================================================================
  function unitFamily(u) { var f = P('unitFamilyFor'); return (f && u) ? f(u) : null; }
  function displayUnit(u) { var f = P('displayUnitFor'); return f ? f(u) : (u == null ? '' : String(u)); }
  function convertOne(v, from, to) { var f = P('convertValue'); return f ? f(v, from, to) : null; }
  function canConvert(from, to) {
    if (!from || !to || sameUnit(from, to)) return true;
    var fa = unitFamily(from), fb = unitFamily(to);
    return !!(fa && fb && fa === fb);
  }
  /** Distinct members of a unit's family as [{key,label}] (spelling variants collapsed by label). */
  function familyMembers(u) {
    var fam = unitFamily(u), UF = P('UNIT_FAMILIES');
    if (!fam || !UF || !UF[fam]) return [];
    var members = UF[fam].members, seen = {}, out = [];
    Object.keys(members).forEach(function (k) {
      var lbl = members[k].label || k;
      if (seen[lbl]) return;
      seen[lbl] = true;
      out.push({ key: k, label: lbl });
    });
    return out;
  }

  // ================================================================================================
  // 3. Local PARAM resolver (fallback for opts.resolver): channel in this log -> role -> math
  // ================================================================================================
  function makeLocalResolver(data, resolvedRoles, unitByChannel, mathChannelsList) {
    data = data || {};
    var series = data.series || {}, levels = data.textLevels || {}, roles = resolvedRoles || {};
    var units = unitByChannel || unitsFromData(data);
    var mathCache = {}, compilingMath = {};
    function chanRec(ch, label) {
      var vals = series[ch];
      if (!vals || vals.length === undefined) return null;
      return { values: vals, unit: units[ch] || null, levels: levels[ch] || null, label: label || ch, channel: ch };
    }
    function mathList() {
      if (typeof mathChannelsList !== 'function') return [];
      try { return mathChannelsList() || []; } catch (e) { return []; }
    }
    // Nested math channels: an expression may reference another NAMED channel that is not a column of
    // this data set. Same cycle guard as the histogram resolver (a self-referencing chain is null).
    function mathByName(name) {
      var mc = findMathChannel(name);
      if (!mc || !mc.expression || compilingMath[mc.id]) return null;
      compilingMath[mc.id] = true;
      var cm;
      try { cm = compileExpr(mc.expression); } finally { delete compilingMath[mc.id]; }
      return cm && cm.values ? { values: cm.values, levels: null } : null;
    }
    function compileExpr(key) {
      var c = mathCache[key];
      if (!c) {
        var comp = X() ? X().compile(key, exprCtx(data, mathByName)) : { ok: false, missing: [] };
        c = mathCache[key] = comp.ok && !comp.missing.length ? { values: comp.evaluateAll(), missing: comp.missing } : { values: null, missing: comp.missing || [], error: comp.error };
      }
      return c;
    }
    // By id, then by name: a stale id from a reloaded layout must still find the live channel.
    function findMathChannel(ref) { return mathChannelByRef(mathList(), ref); }
    var fn = function (param) {
      if (!isObj(param)) return null;
      if (param.channel && series[param.channel]) return chanRec(param.channel, param.label);
      if (param.role && roles[param.role] && series[roles[param.role]]) return chanRec(roles[param.role], param.label);
      if (param.mathChannelId) {
        var mc = findMathChannel(param.mathChannelId) || (param.label ? findMathChannel(param.label) : null);
        if (!mc || !mc.expression || compilingMath[mc.id]) return null;
        compilingMath[mc.id] = true;
        var cm;
        try { cm = compileExpr(mc.expression); } finally { delete compilingMath[mc.id]; }
        if (!cm.values) return null;
        return { values: cm.values, unit: (param.unit || mc.unit) || null, levels: null, label: param.label || mc.name || mc.expression };
      }
      if (param.math && X()) {
        var c = compileExpr(param.math);
        if (!c.values) return null;
        return { values: c.values, unit: param.unit || inferUnitForMath(param.math, units), levels: null, label: param.label || param.math, math: param.math };
      }
      return null;
    };
    fn.mathChannel = findMathChannel;
    return fn;
  }
  function unitsFromData(data) {
    var out = {};
    if (!data || !data.channels) return out;
    data.channels.forEach(function (c, i) { out[c] = (data.units && data.units[i]) ? data.units[i] : ''; });
    return out;
  }
  // Channel lookup is FORGIVING here, exactly as it is when the histogram computes (HistogramUI's
  // resolver.lookup): exact name, then case/space-insensitive, then `fallback` (a named math channel).
  // The editor used to be exact-only, so "[Long Term Fuel Trim 1 ]" or a doubled space showed
  // "not in this log" and blocked the save while the table itself would have resolved it (Ken,
  // 2026-09-08). DatalogExpr.seriesResolver is the single implementation of that rule.
  function exprCtx(data, fallback) {
    data = data || {};
    var series = data.series || {}, levels = data.textLevels || {};
    var resolve = X() && X().seriesResolver ? X().seriesResolver(series, levels, fallback) : function (name) {
      var v = series[name];
      if (!v) return typeof fallback === 'function' ? fallback(name) : null;
      return { values: v, levels: levels[name] || null };
    };
    return { resolve: resolve, time: data.time || null, n: data.time ? data.time.length : 0 };
  }
  // Every name an expression may reference by [Name]: the log's channels plus the named math channels.
  function knownExprNames(ed) {
    var names = ((ed && ed.data && ed.data.channels) || []).slice();
    var list = ed && ed.opts && ed.opts.mathChannels && typeof ed.opts.mathChannels.list === 'function' ? ed.opts.mathChannels.list() : (ed && ed.mathNames) || null;
    if (Array.isArray(list)) list.forEach(function (m) { var nm = m && (typeof m === 'string' ? m : m.name); if (nm) names.push(nm); });
    return names;
  }
  // A channel name typed without brackets ("Short Term Fuel Trim 1 + Long Term Fuel Trim 1") is a
  // parse error, and on 2026-09-08 it cost Ken the second term of a fuel-trim channel. When a box is
  // committed with a source that does not parse but WOULD after DatalogExpr.autoBracket, the rewrite
  // is applied to the box and the model, and the user is told what changed. Returns the (possibly
  // rewritten) source.
  function autoBracketField(ed, ta) {
    if (!ta || !X() || !X().autoBracket) return ta ? ta.value : '';
    var src = ta.value;
    if (!trim(src) || X().parse(src).ok) return src;
    var ab = X().autoBracket(src, knownExprNames(ed));
    if (!ab.changed.length || !X().parse(ab.src).ok) return src;
    ta.value = ab.src;
    if (ed && typeof ed.toast === 'function') ed.toast('Added brackets around ' + ab.changed.map(function (c) { return c.to; }).join(', '));
    return ab.src;
  }
  // Id first, then case-insensitive name (mirrors Histogram.mathChannelByRef; kept local so the editor
  // never depends on load order for a lookup it performs on every render).
  function normChannelName(s) { return String(s == null ? '' : s).toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim(); }
  function mathChannelByRef(list, ref) {
    if (!Array.isArray(list) || !ref) return null;
    var i;
    for (i = 0; i < list.length; i++) if (list[i] && list[i].id === ref) return list[i];
    var want = normChannelName(ref);
    if (!want) return null;
    for (i = 0; i < list.length; i++) if (list[i] && normChannelName(list[i].name) === want) return list[i];
    return null;
  }

  // ================================================================================================
  // 4. inferUnitForMath
  // ================================================================================================
  var UNIT_PRESERVING_FNS = { abs: 1, min: 1, max: 1, minw: 1, maxw: 1, avg: 1, delta: 1, prev: 1, next: 1, clamp: 1, round: 1, floor: 1, ceil: 1, 'if': 1, sum: 1 };
  function unitPreserving(node) {
    switch (node.type) {
      case 'ref': case 'num': return true;
      case 'neg': return unitPreserving(node.arg);
      case 'bin': return (node.op === '+' || node.op === '-') && unitPreserving(node.left) && unitPreserving(node.right);
      case 'ternary': return unitPreserving(node.a) && unitPreserving(node.b);
      case 'call':
        if (!UNIT_PRESERVING_FNS[node.fn]) return false;
        for (var i = 0; i < node.args.length; i++) if (!unitPreserving(node.args[i])) return false;
        return true;
      default: return false;
    }
  }
  function inferUnitForMath(expression, unitByChannel) {
    if (!X() || expression == null) return null;
    var p = X().parse(expression);
    if (!p.ok) return null;
    var src = String(expression).replace(/\[[^\]]*\]|"[^"]*"/g, ' ');
    if (/\*\s*100(?![\d.])/.test(src) || /(^|[^\d.])100\s*\*/.test(src)) return '%';
    var units = unitByChannel || {}, refs = p.references, first = null;
    if (!refs.length) return null;
    for (var i = 0; i < refs.length; i++) {
      var u = trim(units[refs[i]]);
      if (!u) return null;
      if (first === null) first = u;
      else if (!sameUnit(first, u)) return null;
    }
    return unitPreserving(p.ast) ? first : null;
  }

  // ================================================================================================
  // 5. defaultBreakpointsFor -- "nice" 8..20 steps over the live channel's p2/p98
  // ================================================================================================
  var NICE = [1, 2, 2.5, 5, 10];
  function niceStepsFor(lo, hi) {
    var span = hi - lo;
    if (!(span > 0)) span = Math.max(Math.abs(lo) * 0.2, 1);
    var raw = span / 14, exp = Math.floor(Math.log(raw) / Math.LN10), base = Math.pow(10, exp);
    var candidates = [];
    for (var e = exp - 1; e <= exp + 2; e++) for (var k = 0; k < NICE.length; k++) candidates.push(NICE[k] * Math.pow(10, e));
    candidates.sort(function (a, b) { return a - b; });
    var best = null, bestScore = Infinity;
    for (var i = 0; i < candidates.length; i++) {
      var st = candidates[i], vals = rangeValues(lo, hi, st), n = vals.length;
      if (n < 8 || n > 20) continue;
      var score = Math.abs(n - 14) + (st / base < 1 ? 0.5 : 0);
      if (score < bestScore) { bestScore = score; best = vals; }
    }
    if (!best) best = rangeValues(lo, hi, span / 13);
    return best;
  }
  function rangeValues(lo, hi, step) {
    var out = [], start = Math.floor(lo / step) * step, end = Math.ceil(hi / step) * step, v, i = 0;
    if (end <= start) end = start + step;
    for (v = start; v <= end + step * 1e-9 && i < 1000; v = start + (++i) * step) out.push(Number(v.toPrecision(10)));
    return out;
  }
  function robustLoHi(values) {
    var f = [];
    for (var i = 0; i < values.length; i++) { var v = values[i]; if (isFin(v)) f.push(v); }
    if (!f.length) return null;
    f.sort(function (a, b) { return a - b; });
    if (f.length >= 20) return { min: f[Math.floor(f.length * 0.02)], max: f[Math.floor(f.length * 0.98)] };
    return { min: f[0], max: f[f.length - 1] };
  }
  function defaultBreakpointsFor(param, data, resolver) {
    var res = null;
    var r = typeof resolver === 'function' ? resolver : makeLocalResolver(data, (data && data.resolvedRoles) || null, null);
    try { res = r(param, 'axis'); } catch (e) { res = null; }
    if (!res || !res.values) return [];
    if (res.levels && res.levels.length) return [];
    var b = robustLoHi(res.values);
    if (!b) return [];
    var lo = b.min, hi = b.max;
    if (hi - lo < 1e-12) { lo -= 1; hi += 1; }
    return niceStepsFor(lo, hi);
  }
  function generateBreakpoints(start, end, stepOrCount, byCount) {
    if (!isFin(start) || !isFin(end)) return [];
    var out = [], i;
    if (byCount) {
      var n = Math.max(1, Math.floor(stepOrCount));
      if (n === 1) return [start];
      for (i = 0; i < n; i++) out.push(Number((start + (end - start) * i / (n - 1)).toPrecision(10)));
      return out;
    }
    var step = Math.abs(stepOrCount);
    if (!(step > 0)) return [];
    var dir = end >= start ? 1 : -1;
    for (i = 0; i < 1000; i++) {
      var v = start + dir * i * step;
      if (dir > 0 ? v > end + step * 1e-9 : v < end - step * 1e-9) break;
      out.push(Number(v.toPrecision(10)));
    }
    return out;
  }

  // ================================================================================================
  // 6. validateForm
  // ================================================================================================
  function liveUnitFor(param, ctx) {
    if (!isObj(param) || !ctx) return null;
    if (typeof ctx.resolver === 'function') {
      try { var r = ctx.resolver(param, 'validate'); if (r && r.unit != null) return r.unit; } catch (e) { /* ignore */ }
    }
    var units = ctx.unitByChannel || unitsFromData(ctx.data);
    if (param.channel && units[param.channel] != null) return units[param.channel];
    if (param.role && ctx.resolvedRoles && ctx.resolvedRoles[param.role]) return units[ctx.resolvedRoles[param.role]] || null;
    return null;
  }
  function paramPresent(param, ctx) {
    if (!isObj(param) || !ctx) return null;   // unknown
    if (typeof ctx.resolver === 'function') { try { return !!ctx.resolver(param, 'validate'); } catch (e) { return false; } }
    if (!ctx.data || !ctx.data.series) return null;
    if (param.channel && ctx.data.series[param.channel]) return true;
    if (param.role && ctx.resolvedRoles && ctx.data.series[ctx.resolvedRoles[param.role]]) return true;
    if (param.math) return true;
    return false;
  }
  function checkExpression(src, path, label, errors, warnings, ctx, wantBoolean) {
    if (!X()) return;
    var p = X().parse(src);
    if (!p.ok) {
      errors.push({ path: path, message: label + ': ' + p.error.message + ' (at position ' + (p.error.pos + 1) + ')', pos: p.error.pos });
      return;
    }
    if (ctx && ctx.data && ctx.data.series) {
      // Same forgiving lookup the compile uses; a named math channel is a legal reference too.
      var chanFor = X().seriesResolver ? X().seriesResolver(ctx.data.series, ctx.data.textLevels || {}).channelFor : function (r) { return ctx.data.series[r] ? r : null; };
      var mathOk = function (ref) { return !!(ctx.resolver && typeof ctx.resolver.mathChannel === 'function' && ctx.resolver.mathChannel(ref)); };
      p.references.forEach(function (ref) {
        if (!chanFor(ref) && !mathOk(ref)) warnings.push({ path: path, message: label + ' references [' + ref + '], which is not in this log' });
      });
    }
    if (wantBoolean) {
      var c = X().compile(src, { resolve: function () { return { values: [] }; }, time: [0], n: 0 });
      if (c.ok && !c.isBoolean) warnings.push({ path: path, message: label + ' is not a true/false expression; non-zero values will count as "pass"' });
    }
  }
  function validateParam(param, path, label, errors, warnings, ctx) {
    var H_ = H();
    if (!isObj(param) || !(param.channel || param.role || param.math || param.mathChannelId)) { errors.push({ path: path, message: label + ' is required -- pick a channel, a math channel, or write a math expression' }); return; }
    if (param.mathChannelId) {
      // The expression lives in the named math channel, not here -- nothing to compile-check against
      // THIS def; a deleted/renamed-away channel already surfaces as missing_parameter at compute time.
    } else if (param.math) checkExpression(param.math, path + '.math', label + ' math', errors, warnings, ctx, false);
    else {
      var present = paramPresent(param, ctx);
      if (present === false) warnings.push({ path: path, message: label + ' "' + (param.label || param.channel || param.role) + '" is missing in this log' });
    }
    if (!H_) return;
  }
  function validateAxisForm(ax, path, label, errors, warnings, ctx) {
    if (!isObj(ax)) { errors.push({ path: path, message: label + ' is required' }); return; }
    validateParam(ax.parameter, path + '.parameter', label + ' parameter', errors, warnings, ctx);
    var hasCats = Array.isArray(ax.categories) && ax.categories.length > 0;
    var bp = Array.isArray(ax.breakpoints) ? ax.breakpoints : [];
    if (!bp.length) {
      if (!hasCats) errors.push({ path: path + '.breakpoints', message: label + ' has no breakpoints' });
      return;
    }
    var seen = {}, dupes = [], bad = 0, asc = true, desc = bp.length > 1, i;
    for (i = 0; i < bp.length; i++) {
      var v = bp[i];
      if (!isFin(v)) { bad++; continue; }
      var key = String(v);
      if (seen[key]) { if (dupes.indexOf(key) < 0) dupes.push(key); }
      seen[key] = true;
      if (i > 0 && isFin(bp[i - 1])) { if (v <= bp[i - 1]) asc = false; if (v >= bp[i - 1]) desc = false; }
    }
    if (bad) errors.push({ path: path + '.breakpoints', message: label + ' has ' + bad + ' non-numeric breakpoint' + (bad > 1 ? 's' : '') });
    if (dupes.length) errors.push({ path: path + '.breakpoints', message: label + ' has duplicate breakpoint' + (dupes.length > 1 ? 's' : '') + ' ' + dupes.join(', ') });
    if (bp.length > 1 && !asc && !desc) warnings.push({ path: path + '.breakpoints', message: label + ' breakpoints are not in order (use Sort)' });
    if (ax.unit) {
      var live = liveUnitFor(ax.parameter, ctx);
      if (live && !sameUnit(ax.unit, live) && !canConvert(ax.unit, live))
        warnings.push({ path: path + '.unit', message: label + ' unit "' + ax.unit + '" cannot be converted to the log\'s "' + live + '"; breakpoints will bin as-is' });
    }
  }
  function validateForm(def, ctx) {
    var errors = [], warnings = [];
    ctx = ctx || {};
    if (!isObj(def)) return { ok: false, errors: [{ path: '', message: 'definition is not an object' }], warnings: warnings };
    if (!trim(def.name)) warnings.push({ path: 'name', message: 'Give the histogram a name' });
    if (def.type !== 'table' && def.type !== 'distribution') errors.push({ path: 'type', message: 'Type must be Table or Distribution' });
    validateParam(def.cellParameter, 'cellParameter', 'Cell parameter', errors, warnings, ctx);
    if (isObj(def.cellParameter) && def.cellParameter.unit && !def.cellParameter.math) {
      var cl = liveUnitFor(def.cellParameter, ctx);
      if (cl && !sameUnit(def.cellParameter.unit, cl)) warnings.push({ path: 'cellParameter.unit', message: 'Cell unit "' + def.cellParameter.unit + '" differs from the log\'s "' + cl + '"; values are reported in ' + cl });
    }
    if (def.type === 'table') {
      validateAxisForm(def.columnAxis, 'columnAxis', 'Column axis', errors, warnings, ctx);
      if (def.rowAxis != null) validateAxisForm(def.rowAxis, 'rowAxis', 'Row axis', errors, warnings, ctx);
    } else if (def.type === 'distribution') {
      var d = def.distribution;
      if (!isObj(d)) errors.push({ path: 'distribution', message: 'Distribution settings are required' });
      else {
        if (!(d.bins === 'auto' || d.bins == null || (isFin(d.bins) && d.bins >= 1 && Math.floor(d.bins) === d.bins))) errors.push({ path: 'distribution.bins', message: 'Bins must be Auto or a whole number >= 1' });
        if (!(d.binWidth == null || (isFin(d.binWidth) && d.binWidth > 0))) errors.push({ path: 'distribution.binWidth', message: 'Bin width must be > 0' });
        if (isFin(d.min) && isFin(d.max) && d.min >= d.max) errors.push({ path: 'distribution.min', message: 'Distribution min must be below max' });
      }
    }
    var f = isObj(def.filter) ? def.filter : null;
    if (f) {
      if (f.mode === 'advanced') {
        if (trim(f.expression)) checkExpression(f.expression, 'filter.expression', 'Filter', errors, warnings, ctx, true);
      } else if (Array.isArray(f.clauses) && f.clauses.length) {
        var incomplete = countIncompleteClauses(f.clauses);
        if (incomplete) errors.push({ path: 'filter.clauses', message: incomplete + ' filter condition' + (incomplete > 1 ? 's are' : ' is') + ' incomplete (parameter and value required)' });
        else if (X()) {
          var built = buildSimpleSafe(f.clauses);
          if (built.error) errors.push({ path: 'filter.clauses', message: built.error });
          else checkExpression(built.text, 'filter.clauses', 'Filter', errors, warnings, ctx, true);
        }
      }
    }
    if (!(isFin(def.minimumHits) && def.minimumHits >= 0)) errors.push({ path: 'minimumHits', message: 'Minimum hits must be a number >= 0' });
    var cs = isObj(def.colorScale) ? def.colorScale : null;
    if (cs && cs.mode === 'manual') {
      if (!isFin(cs.min) || !isFin(cs.max)) errors.push({ path: 'colorScale', message: 'Manual color scale needs a min and a max' });
      else if (cs.min >= cs.max) errors.push({ path: 'colorScale', message: 'Color scale min must be below max' });
      else if (isFin(cs.center) && (cs.center <= cs.min || cs.center >= cs.max)) warnings.push({ path: 'colorScale', message: 'Color scale center is outside min..max' });
    }
    // Anything the engine rejects that the checks above did not already phrase (belt and braces).
    if (H()) {
      var v = H().validateDef(def);
      v.errors.forEach(function (msg) {
        // engine messages start with the field ("columnAxis has no breakpoints"); skip any field the
        // checks above already reported so the summary never shows the same problem twice
        var top = msg.split(/[\s.]/)[0];
        var covered = errors.some(function (e) { return String(e.path).split('.')[0] === top; });
        if (!covered) errors.push({ path: top, message: msg });
      });
    }
    return { ok: errors.length === 0, errors: errors, warnings: warnings };
  }
  function countIncompleteClauses(clauses) {
    var n = 0;
    (clauses || []).forEach(function (c) {
      if (!c) return;
      if (Array.isArray(c)) { n += countIncompleteClauses(c); return; }
      if (Array.isArray(c.group)) { n += countIncompleteClauses(c.group); return; }
      var v = c.value;
      var okVal = (typeof v === 'number' && isFin(v)) || (typeof v === 'string' && trim(v) !== '');
      if (!trim(c.param) || !okVal) n++;
    });
    return n;
  }

  // ================================================================================================
  // 7. DOM layer -- shared widgets: channel picker popover, param button, small builders
  // ================================================================================================
  function hasDom() { return typeof document !== 'undefined' && !!document.body; }
  function el(html) { var d = document.createElement('div'); d.innerHTML = html; return d.firstChild; }
  function seg(path, value, options, extraAttr) {
    // Segmented pill group (like .dlv-dash-park-btn). options: [[value,label],...]. Commits via click.
    return '<div class="dlv-hg-seg" data-seg="' + esc(path) + '"' + (extraAttr || '') + '>' + options.map(function (o) {
      return '<button type="button" class="dlv-hg-seg-btn' + (String(o[0]) === String(value) ? ' on' : '') + '" data-seg-val="' + esc(o[0]) + '">' + esc(o[1]) + '</button>';
    }).join('') + '</div>';
  }
  function row(label, control, help) {
    return '<div class="dlv-hg-row"><label class="dlv-hg-lbl">' + esc(label) + '</label><div class="dlv-hg-ctl">' + control + (help ? '<div class="dlv-hg-help">' + help + '</div>' : '') + '</div></div>';
  }
  function inp(path, value, type, attrs) {
    var t = type === 'num' || type === 'int' || type === 'nullnum' || type === 'nullint' ? 'number' : 'text';
    return '<input class="dlv-hg-in" type="' + t + '"' + (t === 'number' ? ' step="any"' : '') + ' data-path="' + esc(path) + '" data-type="' + esc(type) + '" value="' + esc(value == null ? '' : value) + '"' + (attrs || '') + '>';
  }
  function chk(path, checked, label) {
    return '<label class="dlv-hg-chk"><input type="checkbox" data-path="' + esc(path) + '" data-type="bool"' + (checked ? ' checked' : '') + '> ' + esc(label) + '</label>';
  }
  function roleLabelOf(roleId) { var R = P('NORMALIZED_CHANNEL_ROLES'); return (R && R[roleId]) ? R[roleId].label : roleId; }
  function rolesByChannel(resolvedRoles) {
    var out = {};
    Object.keys(resolvedRoles || {}).forEach(function (r) { var ch = resolvedRoles[r]; if (ch && !out[ch]) out[ch] = r; });
    return out;
  }
  function paramLabel(param) {
    if (!isObj(param)) return '';
    return param.label || param.channel || (param.role ? roleLabelOf(param.role) : '') || param.math || param.mathChannelId || '';
  }
  /** The current name of a named math channel by id, or null if it has been deleted/is unavailable. */
  function mathChannelName(ed, id) {
    var mc = mathChannelById(ed, id);
    return mc ? (mc.name || null) : null;
  }
  function mathChannelById(ed, id) {
    if (!id) return null;
    var list = ed && ed.opts && ed.opts.mathChannels && typeof ed.opts.mathChannels.list === 'function' ? ed.opts.mathChannels.list() : null;
    return list ? mathChannelByRef(list, id) : null;
  }
  // A param whose mathChannelId is stale (the channel was re-created / reloaded under a new id) but
  // whose NAME still matches a live channel is repaired in place, so the next save stores the live id.
  function healMathRef(ed, param) {
    if (!isObj(param) || !param.mathChannelId) return;
    var mc = mathChannelById(ed, param.mathChannelId) || (param.label ? mathChannelById(ed, param.label) : null);
    if (mc && mc.id !== param.mathChannelId) param.mathChannelId = mc.id;
  }
  function fuzzyChannels(name, channels, limit) {
    var toks = trim(name).toLowerCase().split(/[^a-z0-9]+/).filter(function (t) { return t.length > 1; });
    if (!toks.length) return [];
    var scored = [];
    (channels || []).forEach(function (ch) {
      var ct = ch.toLowerCase().split(/[^a-z0-9]+/).filter(function (t) { return t.length > 1; });
      if (!ct.length) return;
      var hits = 0;
      toks.forEach(function (t) { if (ct.indexOf(t) >= 0) hits++; });
      if (!hits) return;
      scored.push({ name: ch, score: hits / Math.min(toks.length, ct.length) });
    });
    scored.sort(function (a, b) { return b.score - a.score; });
    return scored.slice(0, limit || 3).map(function (s) { return s.name; });
  }

  var PICKER_OPEN = null;
  function closePicker() { if (PICKER_OPEN) { PICKER_OPEN.close(); } }
  /**
   * channelPicker(anchorEl, opts) -> { close(), el }
   *   opts: { channels, unitByChannel, textLevels, resolvedRoles, allowCategorical, allowMath, current, onPick(PARAM) }
   *   A two-part popover: search box + grouped channel list (channelGroupFor), "auto" badges on the
   *   channels a role resolved to, "text" badges on categorical channels, and a "Math…" entry.
   */
  function channelPicker(anchorEl, opts) {
    if (!hasDom()) throw new Error('channelPicker needs a DOM');
    closePicker();
    opts = opts || {};
    var channels = opts.channels || [], units = opts.unitByChannel || {}, levels = opts.textLevels || {};
    var byCh = rolesByChannel(opts.resolvedRoles);
    var cur = isObj(opts.current) ? opts.current : {};
    var groupFn = P('groupChannels');
    var groups = groupFn ? groupFn(channels) : [{ id: 'all', label: 'Channels', channels: channels }];
    var pop = document.createElement('div');
    pop.className = 'dlv-hg-pick';
    pop.setAttribute('role', 'dialog');
    var list = groups.map(function (g) {
      return '<div class="dlv-hg-pick-group" data-group="' + esc(g.id) + '"><div class="dlv-hg-pick-glabel">' + esc(g.label) + '</div>' + g.channels.map(function (c) {
        var isText = !!levels[c], role = byCh[c];
        if (isText && opts.allowCategorical === false) return '';
        var search = (c + ' ' + (role ? roleLabelOf(role) + ' ' + role : '') + ' ' + (units[c] || '')).toLowerCase();
        return '<button type="button" class="dlv-hg-pick-item' + (cur.channel === c ? ' on' : '') + '" data-ch="' + esc(c) + '" data-search="' + esc(search) + '">' +
          '<span class="dlv-hg-pick-name">' + esc(c) + '</span>' +
          (units[c] ? '<span class="dlv-hg-pick-unit">' + esc(displayUnit(units[c])) + '</span>' : '') +
          (isText ? '<span class="dlv-hg-badge text" title="Categorical (text) channel">text</span>' : '') +
          (role ? '<span class="dlv-hg-badge auto" title="Auto-resolved for role ' + esc(role) + '">auto · ' + esc(roleLabelOf(role)) + '</span>' : '') +
          '</button>';
      }).join('') + '</div>';
    }).join('');
    var mathChannels = opts.mathChannels || [];
    var mcList = (opts.allowMath !== false && mathChannels.length) ?
      '<div class="dlv-hg-pick-group" data-group="mathchannels"><div class="dlv-hg-pick-glabel">Math Channels</div>' +
      mathChannels.map(function (mc) {
        var search = ((mc.name || '') + ' ' + (mc.expression || '') + ' ' + (mc.unit || '')).toLowerCase();
        return '<button type="button" class="dlv-hg-pick-item' + (cur.mathChannelId === mc.id ? ' on' : '') + '" data-mc="' + esc(mc.id) + '" data-search="' + esc(search) + '">' +
          '<span class="dlv-hg-pick-name">ƒ ' + esc(mc.name || '(unnamed)') + '</span>' +
          (mc.unit ? '<span class="dlv-hg-pick-unit">' + esc(displayUnit(mc.unit)) + '</span>' : '') + '</button>';
      }).join('') + '</div>' : '';
    pop.innerHTML =
      '<input type="text" class="dlv-hg-pick-search" placeholder="Filter channels… (name, role, unit)">' +
      (opts.allowMath !== false ? '<button type="button" class="dlv-hg-pick-item dlv-hg-pick-math' + (cur.math != null && !cur.channel ? ' on' : '') + '" data-math="1"><span class="dlv-hg-pick-name">ƒ  Math…</span><span class="dlv-hg-pick-unit">new calculated channel</span></button>' : '') +
      mcList +
      '<div class="dlv-hg-pick-list">' + list + '</div>' +
      (typeof opts.onManageMath === 'function' ? '<button type="button" class="dlv-hg-pick-manage" data-manage-math="1">⚙ Manage math channels…</button>' : '') +
      '<div class="dlv-hg-pick-foot"><span class="dlv-hg-pick-count"></span><span class="dlv-hg-faint">Enter picks the first match · Esc closes</span></div>';
    document.body.appendChild(pop);
    var r = anchorEl && anchorEl.getBoundingClientRect ? anchorEl.getBoundingClientRect() : { left: 20, bottom: 20, top: 20 };
    var pad = 8, w = pop.offsetWidth, top;
    var left = Math.max(pad, Math.min(r.left, window.innerWidth - w - pad));
    // Drop below the anchor whenever there is reasonable room (the list is capped to that room and
    // scrolls); otherwise open upward. Never jump to the top of the screen away from the anchor.
    var maxH = Math.min(460, window.innerHeight - 2 * pad);
    var below = window.innerHeight - r.bottom - 4 - pad, above = r.top - 4 - pad;
    if (below >= Math.min(280, maxH) || below >= above) {
      pop.style.maxHeight = Math.max(120, Math.min(maxH, below)) + 'px';
      top = r.bottom + 4;
    } else {
      pop.style.maxHeight = Math.max(120, Math.min(maxH, above)) + 'px';
      top = Math.max(pad, r.top - 4 - pop.offsetHeight);
    }
    pop.style.left = left + 'px'; pop.style.top = top + 'px';
    var search = pop.querySelector('.dlv-hg-pick-search'), countEl = pop.querySelector('.dlv-hg-pick-count');
    function visibleItems() { return Array.prototype.filter.call(pop.querySelectorAll('.dlv-hg-pick-item[data-ch], .dlv-hg-pick-item[data-mc]'), function (b) { return b.style.display !== 'none'; }); }
    function applyFilter() {
      var q = trim(search.value).toLowerCase(), n = 0;
      Array.prototype.forEach.call(pop.querySelectorAll('.dlv-hg-pick-item[data-ch], .dlv-hg-pick-item[data-mc]'), function (b) {
        var show = !q || b.getAttribute('data-search').indexOf(q) >= 0;
        b.style.display = show ? '' : 'none';
        if (show) n++;
      });
      Array.prototype.forEach.call(pop.querySelectorAll('.dlv-hg-pick-group'), function (g) {
        var any = Array.prototype.some.call(g.querySelectorAll('.dlv-hg-pick-item'), function (b) { return b.style.display !== 'none'; });
        g.style.display = any ? '' : 'none';
      });
      countEl.textContent = n + ' of ' + (channels.length + mathChannels.length);
    }
    function pick(ch) {
      var role = byCh[ch] || null;
      var param = { channel: ch, role: role, math: null, unit: units[ch] || null, label: ch };
      close();
      if (opts.onPick) opts.onPick(param, { categorical: !!levels[ch], levels: levels[ch] || null });
    }
    function pickMathChannel(id) {
      var mc = null;
      for (var i = 0; i < mathChannels.length; i++) if (mathChannels[i].id === id) { mc = mathChannels[i]; break; }
      if (!mc) return;
      close();
      if (opts.onPick) opts.onPick({ channel: null, role: null, math: null, mathChannelId: mc.id, unit: mc.unit || null, label: mc.name || '' }, { mathChannel: true });
    }
    function close() {
      if (pop.parentNode) pop.parentNode.removeChild(pop);
      document.removeEventListener('mousedown', outside, true);
      document.removeEventListener('keydown', onKey, true);
      if (PICKER_OPEN === handle) PICKER_OPEN = null;
    }
    function outside(e) { if (!pop.contains(e.target) && e.target !== anchorEl) close(); }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
      if ((e.key === 'Enter' || e.key === 'Return' || e.keyCode === 13) && e.target === search) {
        e.preventDefault();
        var v = visibleItems();
        if (v.length) { var vmc = v[0].getAttribute('data-mc'); if (vmc) pickMathChannel(vmc); else pick(v[0].getAttribute('data-ch')); }
      }
    }
    pop.addEventListener('click', function (e) {
      if (e.target.closest('[data-manage-math]')) { close(); if (opts.onManageMath) opts.onManageMath(); return; }
      var b = e.target.closest('.dlv-hg-pick-item');
      if (!b) return;
      if (b.getAttribute('data-math')) { close(); if (opts.onPick) opts.onPick({ channel: null, role: null, math: cur.math || '', unit: cur.unit || null, label: cur.math ? (cur.label || '') : '' }, { math: true }); return; }
      var mcId = b.getAttribute('data-mc');
      if (mcId) { pickMathChannel(mcId); return; }
      pick(b.getAttribute('data-ch'));
    });
    search.addEventListener('input', applyFilter);
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('keydown', onKey, true);
    applyFilter();
    setTimeout(function () { search.focus(); }, 0);
    var handle = { close: close, el: pop };
    PICKER_OPEN = handle;
    return handle;
  }

  // ================================================================================================
  // Math Channel manager -- Ken's ask (2026-09-07): "need to be able to get into, edit, add and
  // delete math channels", not just create one ad-hoc while picking a parameter. A named math channel
  // is {id, name, expression, unit}; a histogram's cell/axis parameter references it by id
  // (mathChannelId, see datalog-histogram-ui.js's resolver), so editing it here updates every
  // histogram that uses it -- reusing the SAME expression textarea/validation/insert-helpers/preview
  // machinery as the per-parameter "ƒ Math…" panel above (mathPanel/liveExpr/updateMathPreview/
  // insertIntoExpr all key off ed.work/ed.data/ed.units/ed.body/ed.esc + a dotted pPath, so a tiny
  // shim object with its OWN .work.current reuses them verbatim).
  // ================================================================================================
  function openMathManager(opts) {
    if (!hasDom()) throw new Error('openMathManager needs a DOM');
    opts = opts || {};
    var escapeHtml = typeof opts.escapeHtml === 'function' ? opts.escapeHtml : esc;
    var toast = typeof opts.toast === 'function' ? opts.toast : function (m) { if (global.console) console.log('[math channels] ' + m); };
    var data = opts.data || null, unitByChannel = opts.unitByChannel || unitsFromData(data);
    var srcList = typeof opts.list === 'function' ? opts.list() : (Array.isArray(opts.list) ? opts.list : []);
    var S = { list: (srcList || []).map(function (m) { return { id: m.id, name: m.name || '', expression: m.expression || '', unit: m.unit || null }; }) };
    S.activeId = opts.focusId && S.list.some(function (m) { return m.id === opts.focusId; }) ? opts.focusId : (S.list[0] ? S.list[0].id : null);
    function persist() { if (typeof opts.onSave === 'function') { try { opts.onSave(S.list.map(function (m) { return { id: m.id, name: m.name, expression: m.expression, unit: m.unit || null }; })); } catch (e) { /* ignore */ } } }
    function active() { for (var i = 0; i < S.list.length; i++) if (S.list[i].id === S.activeId) return S.list[i]; return null; }
    function newId() { return 'mc_' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6); }

    var ovl = document.createElement('div');
    ovl.className = 'dlv-hg-ed-ovl dlv-hg-mm-ovl';
    document.body.appendChild(ovl);
    // The shim: mathPanel/liveExpr/updateMathPreview/insertIntoExpr only ever touch these five fields,
    // keyed by pPath -- 'current' here always means "the math channel selected in the list".
    var ed = { work: { current: null }, data: data, units: unitByChannel, ctx: { resolvedRoles: opts.resolvedRoles || {} }, body: ovl, esc: escapeHtml, pendingConv: {}, timers: {}, toast: toast,
      // knownExprNames() reads this: the other named channels are legal [Name] references here too
      get mathNames() { return S.list.map(function (m) { return m.name; }); } };

    function rowHtml(m) {
      return '<div class="dlv-hg-mm-row' + (m.id === S.activeId ? ' active' : '') + '" data-mm-pick="' + escapeHtml(m.id) + '">' +
        '<div class="dlv-hg-mm-row-top"><span class="dlv-hg-mm-row-name">ƒ ' + escapeHtml(m.name || '(unnamed)') + '</span>' +
        (m.unit ? '<span class="dlv-hg-unit">' + escapeHtml(displayUnit(m.unit)) + '</span>' : '') +
        '<button type="button" class="dlv-hg-mini x" data-mm-del="' + escapeHtml(m.id) + '" title="Delete">×</button></div>' +
        '<div class="dlv-hg-mm-row-expr mono">' + escapeHtml(m.expression || '(empty)') + '</div></div>';
    }
    function render() {
      var a = active();
      ed.work.current = a ? { channel: null, role: null, math: a.expression, unit: a.unit, label: a.name } : null;
      ovl.innerHTML =
        '<div class="dlv-hg-ed dlv-hg-mm" role="dialog" aria-label="Math Channels">' +
          '<div class="dlv-hg-ed-head"><div class="dlv-hg-ed-title"><span class="dlv-hg-ed-kicker">Math Channels</span><b>Named, reusable calculated channels</b></div>' +
            '<button type="button" class="dlv-hg-ed-x" data-mm-act="close" aria-label="Close">×</button></div>' +
          '<div class="dlv-hg-mm-body">' +
            '<div class="dlv-hg-mm-list">' +
              '<button type="button" class="dlv-hg-btn sm primary" data-mm-act="new" style="width:100%;margin-bottom:8px;">+ New math channel</button>' +
              (S.list.length ? S.list.map(rowHtml).join('') : '<div class="dlv-hg-faint" style="padding:8px 4px;">No math channels yet. A histogram\'s parameter picker will offer any you create here.</div>') +
            '</div>' +
            '<div class="dlv-hg-mm-detail">' + (a ?
              ('<label class="dlv-hg-mm-field"><span>Name</span><input type="text" class="dlv-hg-in" data-mm-field="name" value="' + escapeHtml(a.name || '') + '" placeholder="Lambda Error %"></label>' +
               mathPanel(ed, ed.work.current, 'current') +
               '<label class="dlv-hg-mm-field"><span>Unit</span><input type="text" class="dlv-hg-in" data-mm-field="unit" value="' + escapeHtml(a.unit || '') + '" placeholder="' + escapeHtml(inferUnitForMath(a.expression || '', unitByChannel) || 'as computed') + '"></label>')
              : '<div class="dlv-hg-help">Select a math channel on the left, or create a new one.</div>') + '</div>' +
          '</div>' +
          '<div class="dlv-hg-ed-foot"><span class="dlv-hg-faint">Editing a definition updates every histogram that references it.</span><button type="button" class="dlv-hg-btn primary" data-mm-act="done">Done</button></div>' +
        '</div>';
      if (a) { updateMathPreview(ed, 'current'); liveExpr(ed, ovl.querySelector('[data-expr="current"]')); }
    }
    function commitExpr(ta) {
      var a = active(); if (!a) return;
      a.expression = ta.value;
      if (!a.unit) { var u = inferUnitForMath(a.expression, unitByChannel); if (u) { a.unit = u; var ui = ovl.querySelector('[data-mm-field="unit"]'); if (ui) ui.value = u; } }
      persist();
    }
    function close() {
      document.removeEventListener('keydown', onKey, true);
      if (ovl.parentNode) ovl.parentNode.removeChild(ovl);
      if (typeof opts.onClose === 'function') { try { opts.onClose(); } catch (e) { /* ignore */ } }
    }
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } }
    ovl.addEventListener('click', function (e) {
      if (e.target === ovl) { close(); return; }
      var pickRow = e.target.closest('[data-mm-pick]');
      if (pickRow && !e.target.closest('[data-mm-del]')) { S.activeId = pickRow.getAttribute('data-mm-pick'); render(); return; }
      var delBtn = e.target.closest('[data-mm-del]');
      if (delBtn) {
        var id = delBtn.getAttribute('data-mm-del'), m = null;
        for (var i = 0; i < S.list.length; i++) if (S.list[i].id === id) { m = S.list[i]; break; }
        if (m && window.confirm('Delete "' + (m.name || 'this math channel') + '"? Any histogram referencing it will show "missing parameter."')) {
          S.list = S.list.filter(function (x) { return x.id !== id; });
          if (S.activeId === id) S.activeId = S.list[0] ? S.list[0].id : null;
          persist(); render(); toast('Deleted "' + (m.name || 'math channel') + '"');
        }
        return;
      }
      var act = e.target.closest('[data-mm-act]'); if (!act) return;
      var a2 = act.getAttribute('data-mm-act');
      if (a2 === 'close' || a2 === 'done') { close(); return; }
      if (a2 === 'new') {
        var m2 = { id: newId(), name: 'New Math Channel', expression: '', unit: null };
        S.list.push(m2); S.activeId = m2.id; persist(); render();
        var nameInp = ovl.querySelector('[data-mm-field="name"]'); if (nameInp) { nameInp.focus(); nameInp.select(); }
        return;
      }
      var actBtn = e.target.closest('[data-act]');
      if (actBtn) { insertOrFn(actBtn); return; }
    });
    function insertOrFn(btn) {
      var act = btn.getAttribute('data-act');
      if (act === 'insert-fn') { insertIntoExpr(ed, 'current', btn.getAttribute('data-fn') + '('); syncFromShim(); return; }
      if (act === 'math-clear') return;   // no "use a channel instead" concept for a standalone math channel
    }
    function syncFromShim() {
      var a = active(); if (!a) return;
      a.expression = (ed.work.current && ed.work.current.math) || '';
      persist();
    }
    ovl.addEventListener('change', function (e) {
      var t = e.target;
      if (t.getAttribute('data-mm-field') === 'name') { var a = active(); if (a) { a.name = t.value; persist(); var rowName = ovl.querySelector('.dlv-hg-mm-row.active .dlv-hg-mm-row-name'); if (rowName) rowName.textContent = 'ƒ ' + (t.value || '(unnamed)'); } return; }
      if (t.getAttribute('data-mm-field') === 'unit') { var a2 = active(); if (a2) { a2.unit = t.value || null; persist(); } return; }
      if (t.getAttribute('data-expr') === 'current') { autoBracketField(ed, t); commitExpr(t); liveExpr(ed, t); return; }
      if (t.getAttribute('data-insert-ch') === 'current') { if (t.value) { insertIntoExpr(ed, 'current', '[' + t.value + ']'); syncFromShim(); } t.value = ''; return; }
    });
    ovl.addEventListener('input', function (e) {
      var t = e.target;
      if (t.getAttribute('data-expr') === 'current') { var a = active(); if (a) a.expression = t.value; liveExpr(ed, t); }
    });
    document.addEventListener('keydown', onKey, true);
    render();
    return { close: close };
  }
  // Bridge from the per-histogram editor: open the manager against the SAME math-channel store,
  // re-rendering the editor on close so a picker button showing "ƒ <old name>" picks up a rename, and
  // a param whose channel was just deleted repaints as "missing math channel" instead of stale text.
  function openMathManagerFromEditor(ed, focusId) {
    if (!ed.opts.mathChannels || typeof ed.opts.mathChannels.list !== 'function') { ed.toast('Math channels are not available here.'); return; }
    openMathManager({
      list: ed.opts.mathChannels.list, onSave: ed.opts.mathChannels.save, focusId: focusId,
      data: ed.data, unitByChannel: ed.units, resolvedRoles: ed.ctx.resolvedRoles,
      toast: ed.toast, escapeHtml: ed.esc, onClose: function () { if (!ed.closed) ed.render(); }
    });
  }

  // ================================================================================================
  // 8. The editor overlay
  // ================================================================================================
  var TABS = [['general', 'General'], ['cell', 'Cell Parameter'], ['column', 'Column Axis'], ['row', 'Row Axis'], ['filter', 'Filter'], ['display', 'Display']];
  var SLOT_TAB = { cell: 'cell', column: 'column', row: 'row', filter: 'filter' };
  var PATH_TAB = { name: 'general', type: 'general', cellParameter: 'cell', columnAxis: 'column', rowAxis: 'row', filter: 'filter', distribution: 'display', colorScale: 'display', minimumHits: 'display', statistic: 'display' };
  var OPS = [['>', '>'], ['>=', '≥'], ['<', '<'], ['<=', '≤'], ['==', '='], ['!=', '≠']];

  function openEditor(def, opts) {
    if (!hasDom()) throw new Error('HistogramEditor.open needs a DOM');
    opts = opts || {};
    var H_ = H();
    var work = H_.migrateDef(clone(isObj(def) ? def : {}));
    if (!isObj(work.filter)) work.filter = { mode: 'simple', clauses: null, expression: null };
    if (!isObj(work.colorScale)) work.colorScale = { mode: 'auto', min: null, center: null, max: null, higherIsWorse: null };
    if (!isObj(work.display)) work.display = {};
    if (work.type !== 'distribution' && !isObj(work.columnAxis)) work.columnAxis = H_.makeAxis({ breakpoints: [] });   // a table always has a column axis
    var data = opts.data || null;
    var units = opts.unitByChannel || unitsFromData(data);
    var mcListFn0 = opts.mathChannels && typeof opts.mathChannels.list === 'function' ? opts.mathChannels.list : null;
    var resolver = typeof opts.resolver === 'function' ? opts.resolver : makeLocalResolver(data, opts.resolvedRoles, units, mcListFn0);
    var escapeHtml = typeof opts.escapeHtml === 'function' ? opts.escapeHtml : esc;
    var toast = typeof opts.toast === 'function' ? opts.toast : function (m) { if (global.console) console.log('[histogram editor] ' + m); };
    var ctx = { data: data, unitByChannel: units, resolver: resolver, resolvedRoles: opts.resolvedRoles || {} };
    var ed = {
      work: work, opts: opts, data: data, units: units, resolver: resolver, ctx: ctx, esc: escapeHtml, toast: toast,
      baseline: JSON.stringify(work), tab: SLOT_TAB[opts.focusSlot] || 'general',
      rowStash: null, pendingConv: {}, confirmOpen: false, timers: {}, closed: false
    };
    ed.isDirty = function () { return JSON.stringify(ed.work) !== ed.baseline; };

    var ovl = document.createElement('div');
    ovl.className = 'dlv-hg-ed-ovl';
    ovl.innerHTML =
      '<div class="dlv-hg-ed" role="dialog" aria-label="Histogram definition">' +
        '<div class="dlv-hg-ed-head"><div class="dlv-hg-ed-title"><span class="dlv-hg-ed-kicker">' + (opts.isNew ? 'New histogram' : 'Edit histogram') + '</span><b data-hg-title>' + escapeHtml(work.name || 'Histogram') + '</b></div>' +
          '<button type="button" class="dlv-hg-ed-x" data-act="cancel" aria-label="Close">×</button></div>' +
        '<div class="dlv-hg-ed-tabs">' + TABS.map(function (t) { return '<button type="button" data-hg-tab="' + t[0] + '"' + (t[0] === ed.tab ? ' class="on"' : '') + '>' + t[1] + '</button>'; }).join('') + '</div>' +
        '<div class="dlv-hg-ed-body" data-hg-body></div>' +
        '<div class="dlv-hg-ed-foot">' +
          '<div class="dlv-hg-ed-val" data-hg-val></div>' +
          '<div class="dlv-hg-ed-acts">' +
            '<button type="button" class="dlv-hg-btn" data-act="cancel">Cancel</button>' +
            '<button type="button" class="dlv-hg-btn" data-act="savecopy" title="Save as a new histogram with a new id">Save As Copy</button>' +
            '<button type="button" class="dlv-hg-btn primary" data-act="save" title="Ctrl+Enter">' + (opts.isNew ? 'Create' : 'Save') + '</button>' +
          '</div></div>' +
      '</div>';
    document.body.appendChild(ovl);
    ed.ovl = ovl;
    ed.body = ovl.querySelector('[data-hg-body]');

    function close() {
      if (ed.closed) return;
      ed.closed = true;
      closePicker();
      document.removeEventListener('keydown', onKey, true);
      if (ovl.parentNode) ovl.parentNode.removeChild(ovl);
    }
    function cancel() {
      if (ed.isDirty() && !ed.confirmOpen) { showConfirm(); return; }
      close();
      if (opts.onCancel) opts.onCancel();
    }
    function showConfirm() {
      ed.confirmOpen = true;
      var v = ovl.querySelector('[data-hg-val]');
      v.innerHTML = '<div class="dlv-hg-confirm"><b>Unsaved changes.</b> Discard them? <button type="button" class="dlv-hg-btn danger" data-act="discard">Discard</button><button type="button" class="dlv-hg-btn" data-act="keep">Keep editing</button></div>';
      var b = v.querySelector('[data-act="keep"]'); if (b) b.focus();
    }
    function save(asCopy) {
      // HIGH: Ctrl+Enter (or Save clicked while a field still had focus, e.g. via a mouse drag that
      // never blurred it) used to validate and save ed.work as it stood BEFORE this keystroke -- a
      // field only commits on 'change', so the breakpoint/name/math/filter text just typed was
      // silently dropped. Force that commit first.
      commitFocusedField();
      var res = validateForm(ed.work, ed.ctx);
      if (!res.ok) { refreshValidation(); jumpTo(res.errors[0].path); ed.toast('Fix ' + res.errors.length + ' error' + (res.errors.length > 1 ? 's' : '') + ' before saving'); return; }
      var out = clone(ed.work);
      if (asCopy) out = H_.cloneDef(out);
      H_.migrateDef(out);
      var v = H_.validateDef(out);
      if (!v.ok) { ed.toast('Definition rejected: ' + v.errors.join('; ')); refreshValidation(); return; }
      close();
      if (opts.onSave) opts.onSave(out);
    }
    function jumpTo(path) {
      var top = String(path || '').split('.')[0], tab = PATH_TAB[top];
      if (tab && tab !== ed.tab) setTab(tab);
    }
    function setTab(tab) {
      ed.tab = tab;
      Array.prototype.forEach.call(ovl.querySelectorAll('[data-hg-tab]'), function (b) { b.classList.toggle('on', b.getAttribute('data-hg-tab') === tab); });
      render();
    }
    function render() {
      closePicker();
      ed.body.innerHTML = renderTab(ed);
      afterRender(ed);
      refreshValidation();
    }
    function refreshValidation() {
      if (ed.confirmOpen) return;
      var res = validateForm(ed.work, ed.ctx), v = ovl.querySelector('[data-hg-val]');
      var tabsWithErr = {};
      res.errors.forEach(function (e) { var t = PATH_TAB[String(e.path).split('.')[0]]; if (t) tabsWithErr[t] = 1; });
      Array.prototype.forEach.call(ovl.querySelectorAll('[data-hg-tab]'), function (b) { b.classList.toggle('err', !!tabsWithErr[b.getAttribute('data-hg-tab')]); });
      var html;
      if (!res.errors.length && !res.warnings.length) html = '<span class="dlv-hg-ok">✓ Ready to save</span>';
      else {
        html = '<span class="' + (res.errors.length ? 'dlv-hg-err' : 'dlv-hg-warn') + '">' +
          (res.errors.length ? res.errors.length + ' error' + (res.errors.length > 1 ? 's' : '') : '') +
          (res.errors.length && res.warnings.length ? ' · ' : '') +
          (res.warnings.length ? res.warnings.length + ' warning' + (res.warnings.length > 1 ? 's' : '') : '') + '</span>' +
          '<div class="dlv-hg-ed-vallist">' +
          res.errors.map(function (e) { return '<button type="button" class="dlv-hg-vitem err" data-jump="' + escapeHtml(e.path) + '">' + escapeHtml(e.message) + '</button>'; }).join('') +
          res.warnings.map(function (w) { return '<button type="button" class="dlv-hg-vitem warn" data-jump="' + escapeHtml(w.path) + '">' + escapeHtml(w.message) + '</button>'; }).join('') +
          '</div>';
      }
      v.innerHTML = html;
      var sb = ovl.querySelector('[data-act="save"]'), sc = ovl.querySelector('[data-act="savecopy"]');
      if (sb) sb.disabled = !res.ok;
      if (sc) sc.disabled = !res.ok;
      var t = ovl.querySelector('[data-hg-title]'); if (t) t.textContent = ed.work.name || 'Histogram';
    }
    ed.render = render; ed.setTab = setTab; ed.refreshValidation = refreshValidation; ed.close = close; ed.save = save;

    // A field only writes into ed.work on 'change' (blur) -- shared here so save() can force that
    // same commit for whatever is still focused when Ctrl+Enter fires (a "Save" click also blurs the
    // field first, via the mousedown-then-click sequence, so this path is specific to the shortcut).
    // Returns true if `t` was a field this function knows how to commit.
    function commitPathField(t) {
      var path = t && t.getAttribute && t.getAttribute('data-path');
      if (!path) return false;
      if (t.getAttribute('data-expr')) autoBracketField(ed, t);
      var type = t.getAttribute('data-type') || 'str', val;
      if (type === 'bool') val = !!t.checked;
      else if (type === 'num') { val = parseFloat(t.value); if (!isFin(val)) val = 0; }
      else if (type === 'int') { val = parseInt(t.value, 10); if (!isFin(val)) val = 0; }
      else if (type === 'nullnum') { val = trim(t.value) === '' ? null : parseFloat(t.value); if (val !== null && !isFin(val)) val = null; }
      else if (type === 'nullint') { val = trim(t.value) === '' ? null : parseInt(t.value, 10); if (val !== null && !isFin(val)) val = null; }
      else if (type === 'nullstr') { val = trim(t.value) === '' ? null : t.value; }
      else val = t.value;
      setPath(ed.work, path, val);
      onPathChanged(ed, path, val, t);
      return true;
    }
    function commitFocusedField() {
      var t = document.activeElement;
      if (!t || !ovl.contains(t)) return;
      if (commitPathField(t)) return;
      var bpKey = t.getAttribute && t.getAttribute('data-bp');
      if (bpKey) { commitBreakpoints(ed, bpKey, t.value); return; }
    }
    // ---- one delegated change listener keyed on data-path (like the scorecard config) -----------
    ovl.addEventListener('change', function (e) {
      var t = e.target;
      if (commitPathField(t)) { refreshValidation(); return; }
      if (t.getAttribute && t.getAttribute('data-bp')) { commitBreakpoints(ed, t.getAttribute('data-bp'), t.value); refreshValidation(); return; }
      if (t.getAttribute && t.getAttribute('data-clause')) { onClauseChange(ed, t); refreshValidation(); return; }
      if (t.getAttribute && t.getAttribute('data-insert-ch')) { if (t.value) insertIntoExpr(ed, t.getAttribute('data-insert-ch'), '[' + t.value + ']'); t.value = ''; return; }
      if (t.getAttribute && t.getAttribute('data-toggle') === 'row') { setRowEnabled(ed, !t.checked); refreshValidation(); return; }
    });
    // Pasting into a breakpoints box replaces the list with the normalised values (row / column /
    // 2-D HPT table). A single plain number falls through to the default paste.
    ovl.addEventListener('paste', function (e) {
      var t = e.target, axKey = t.getAttribute && t.getAttribute('data-bp');
      if (!axKey || !e.clipboardData) return;
      var text = e.clipboardData.getData('text');
      var r = normalizeAxisPaste(text);
      if (r.values.length < 2 && r.detected !== 'hpt-table') return;
      e.preventDefault();
      setBp(ed, axKey, r.values, 'Pasted ' + r.values.length + ' values (' + r.detected + ')');
    });
    ovl.addEventListener('input', function (e) {
      var t = e.target;
      if (t.getAttribute('data-path') === 'name') { var tt = ovl.querySelector('[data-hg-title]'); if (tt) tt.textContent = t.value || 'Histogram'; }
      if (t.getAttribute('data-bp')) updateBpStatus(ed, t.getAttribute('data-bp'), t.value);
      if (t.getAttribute('data-expr')) liveExpr(ed, t);
      if (t.getAttribute('data-path') === 'filter.expression') liveFilterCount(ed, true);
    });
    ovl.addEventListener('click', function (e) {
      var t = e.target;
      if (t === ovl) { cancel(); return; }
      var tabBtn = t.closest('[data-hg-tab]');
      if (tabBtn) { setTab(tabBtn.getAttribute('data-hg-tab')); return; }
      var segBtn = t.closest('.dlv-hg-seg-btn');
      if (segBtn) { onSegClick(ed, segBtn); refreshValidation(); return; }
      var jump = t.closest('[data-jump]');
      if (jump) { jumpTo(jump.getAttribute('data-jump')); return; }
      var actBtn = t.closest('[data-act]');
      if (!actBtn) return;
      var act = actBtn.getAttribute('data-act');
      if (act === 'cancel') cancel();
      else if (act === 'discard') { ed.confirmOpen = false; close(); if (opts.onCancel) opts.onCancel(); }
      else if (act === 'keep') { ed.confirmOpen = false; refreshValidation(); }
      else if (act === 'save') save(false);
      else if (act === 'savecopy') save(true);
      else onAction(ed, act, actBtn);
    });
    function onKey(e) {
      if (PICKER_OPEN) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); save(false); }
    }
    document.addEventListener('keydown', onKey, true);
    render();
    setTimeout(function () { var f = ed.body.querySelector('input[type=text], textarea'); if (f && ed.tab === 'general') f.focus(); }, 0);
    return { close: close, editor: ed };
  }

  // ---- change hooks -------------------------------------------------------------------------------
  function onPathChanged(ed, path, val, inputEl) {
    var w = ed.work;
    if (path === 'type') {
      if (val === 'distribution' && !isObj(w.distribution)) w.distribution = { bins: 'auto', binWidth: null, min: null, max: null, mode: 'count' };
      if (val === 'table' && !isObj(w.columnAxis)) w.columnAxis = H().makeAxis({ breakpoints: [] });
      ed.render();
    } else if (path === 'filter.expression') {
      liveFilterCount(ed, false);
    } else if (/^(columnAxis|rowAxis)\.unit$/.test(path)) {
      var axKey = path.split('.')[0], ax = w[axKey], prev = inputEl.getAttribute('data-prev') || '';
      // If a conversion is already pending, the breakpoints are STILL in that prompt's original unit
      // (nothing has been converted yet) -- a second unit change before Yes/No must keep that true
      // origin, or converting later would scale from the wrong starting unit.
      var existingSel = ed.pendingConv[axKey];
      var trueFromSel = existingSel ? existingSel.from : prev;
      if (ax && ax.breakpoints && ax.breakpoints.length && trueFromSel && val && !sameUnit(trueFromSel, val) && canConvert(trueFromSel, val)) {
        ed.pendingConv[axKey] = { from: trueFromSel, to: val };
      } else delete ed.pendingConv[axKey];
      inputEl.setAttribute('data-prev', val || '');
      ed.render();
    } else if (/^cellParameter\.math$/.test(path) || /^(columnAxis|rowAxis)\.parameter\.math$/.test(path)) {
      var pPath = path.replace(/\.math$/, ''), param = getPath(w, pPath);
      if (param && !param.label) param.label = '';
      if (param && !param.unit) { var u = inferUnitForMath(val, ed.units); if (u) { param.unit = u; var ui = ed.ovl.querySelector('[data-path="' + pPath + '.unit"]'); if (ui) ui.value = u; } }
      // keep the picker button + slot header in step without a full re-render (the textarea keeps focus)
      var pb = ed.body.querySelector('.dlv-hg-parambtn[data-ppath="' + pPath + '"] .name');
      if (pb) pb.textContent = 'ƒ ' + (trim(val) || '(empty expression)');
      var sh = ed.body.querySelector('[data-slot-for="' + pPath + '"]');
      if (sh) { var tmp = document.createElement('div'); tmp.innerHTML = slotHeader(ed, param, sh.getAttribute('data-slot') || 'cell', pPath); if (tmp.firstChild) sh.parentNode.replaceChild(tmp.firstChild, sh); }
      updateMathPreview(ed, pPath);
    } else if (path === 'colorScale.mode' || path === 'distribution.mode') {
      ed.render();
    }
  }
  function onSegClick(ed, btn) {
    var group = btn.closest('.dlv-hg-seg'), path = group.getAttribute('data-seg'), raw = btn.getAttribute('data-seg-val');
    var val = raw === 'true' ? true : raw === 'false' ? false : raw === 'null' ? null : raw;
    Array.prototype.forEach.call(group.querySelectorAll('.dlv-hg-seg-btn'), function (b) { b.classList.toggle('on', b === btn); });
    if (path === 'filter.mode') { switchFilterMode(ed, val); return; }
    if (path === 'distribution.binsMode') { setBinsMode(ed, val); return; }
    if (path === 'rowAxis.enabled') { setRowEnabled(ed, val === true || val === 'true'); return; }
    if (path === 'bp.genMode') { ed.genMode = val; var gl = ed.body.querySelector('[data-gen-label="' + group.getAttribute('data-ax') + '"]'); if (gl) gl.textContent = val === 'count' ? 'Count' : 'Step'; return; }
    setPath(ed.work, path, val);
    onPathChanged(ed, path, val, btn);
  }

  // ---- tab renderers -----------------------------------------------------------------------------
  function renderTab(ed) {
    switch (ed.tab) {
      case 'cell': return cellTab(ed);
      case 'column': return axisTab(ed, 'columnAxis');
      case 'row': return axisTab(ed, 'rowAxis');
      case 'filter': return filterTab(ed);
      case 'display': return displayTab(ed);
      default: return generalTab(ed);
    }
  }
  function generalTab(ed) {
    var w = ed.work;
    return row('Name', inp('name', w.name, 'str', ' placeholder="e.g. Knock Retard vs RPM / Load"')) +
      row('Description', inp('description', w.description, 'str', ' placeholder="optional"')) +
      row('Type', seg('type', w.type, [['table', 'Table'], ['distribution', 'Distribution']]), w.type === 'distribution' ? 'One parameter binned into equal-width bins (a bar chart of how often each value occurs).' : 'Cells filled by a statistic of the cell parameter, binned by column (and optionally row) axis breakpoints.') +
      row('Enabled', chk('enabled', w.enabled !== false, 'Compute and show this histogram')) +
      row('Data range', seg('dataRange', w.dataRange, [['entire', 'Entire Log'], ['selection', 'Selection']])) +
      row('Orientation', seg('orientation', w.orientation, [['normal', 'Normal'], ['inverted', 'Inverted']]), 'Inverted swaps rows and columns in the view without changing the definition.') +
      row('Out-of-range', seg('outOfRange', w.outOfRange, [['clamp', 'Clamp to edge cells (HPT)'], ['drop', 'Drop']]), 'Clamp: values beyond the first/last breakpoint land in that edge cell, as VCM Scanner does. Drop: they are discarded.');
  }
  function slotHeader(ed, param, slot, pPath) {
    var tag = '<div data-slot-for="' + ed.esc(pPath) + '" data-slot="' + ed.esc(slot) + '" class="dlv-hg-slot ';
    if (!isObj(param) || !(param.channel || param.role || param.math || param.mathChannelId)) return tag + 'dlv-hg-faint">' + (isObj(param) && param.math === '' ? 'Write a math expression below.' : 'No parameter picked yet.') + '</div>';
    healMathRef(ed, param);
    var rec = null;
    try { rec = ed.resolver(param, slot); } catch (e) { rec = null; }
    var isCalc = (param.math && !param.channel) || (param.mathChannelId && !param.channel);
    if (rec && rec.values) {
      var n = 0, len = rec.values.length;
      for (var i = 0; i < len; i++) { var v = rec.values[i]; if (typeof v === 'number' && v === v) n++; }
      return tag + 'ok">' + (isCalc ? 'Math' : 'Resolved') + ': <b>' + ed.esc(isCalc ? (param.label || rec.label || param.math) : (rec.label || paramLabel(param))) + '</b>' +
        (rec.unit ? ' <span class="dlv-hg-unit">' + ed.esc(displayUnit(rec.unit)) + '</span>' : '') +
        (rec.levels ? ' <span class="dlv-hg-badge text">text · ' + rec.levels.length + ' labels</span>' : '') +
        ' <span class="dlv-hg-faint">' + n + ' of ' + len + ' samples valid' + (param.role && param.channel ? ' · via role ' + ed.esc(roleLabelOf(param.role)) : '') + '</span></div>';
    }
    if (param.mathChannelId) return tag + 'missing"><b>Missing math channel</b> — it was deleted or is unavailable. <button type="button" class="dlv-hg-link" data-act="open-mathmgr">Choose another…</button></div>';
    if (param.math) return tag + 'dlv-hg-faint">Math expression (see below).</div>';
    var chans = (ed.data && ed.data.channels) || [];
    var sugg = [];
    var sfr = P('suggestChannelsForRole');
    if (param.role && sfr) sugg = sfr(param.role, chans, 3);
    if (!sugg.length && param.channel) sugg = fuzzyChannels(param.channel, chans, 3);
    return tag + 'missing"><b>Missing in this log</b> — "' + ed.esc(paramLabel(param)) + '"' + (param.role ? ' (role ' + ed.esc(roleLabelOf(param.role)) + ')' : '') + ' has no channel here.' +
      (sugg.length ? '<div class="dlv-hg-sugg"><span>Map one of these:</span>' + sugg.map(function (c) { return '<button type="button" class="dlv-hg-chip" data-act="map" data-ppath="' + ed.esc(pPath) + '" data-ch="' + ed.esc(c) + '">' + ed.esc(c) + '</button>'; }).join('') + '</div>' : '<div class="dlv-hg-faint">No similar channel names found — pick one manually.</div>') +
      '</div>';
  }
  function paramButton(ed, param, pPath, slot) {
    healMathRef(ed, param);
    var has = isObj(param) && (param.channel || param.role || param.math || param.mathChannelId);
    var isCalc = has && !param.channel && (param.math || param.mathChannelId);
    var lbl = has ? (isCalc ? 'ƒ ' + (param.label || (param.mathChannelId && mathChannelName(ed, param.mathChannelId)) || param.math || '(empty expression)') : paramLabel(param)) : 'Pick a parameter…';
    var unit = has ? displayUnit(param.unit || liveUnitFor(param, ed.ctx) || '') : '';
    return '<button type="button" class="dlv-hg-parambtn' + (has ? '' : ' empty') + '" data-act="pick" data-ppath="' + ed.esc(pPath) + '" data-slot="' + ed.esc(slot) + '" title="Choose a channel, role or math expression">' +
      '<span class="name">' + ed.esc(lbl) + '</span>' + (unit ? '<span class="unit">' + ed.esc(unit) + '</span>' : '') + '<span class="caret">▾</span></button>';
  }
  function mathPanel(ed, param, pPath) {
    if (!isObj(param) || param.channel) return '';
    healMathRef(ed, param);
    if (param.mathChannelId) {
      // A NAMED, reusable channel is read-only here by design: editing the expression inline would
      // fork it silently for this one histogram, defeating the entire point of a shared definition.
      // Ken's ask (2026-09-07): edit once in Math Channels, every histogram using it updates.
      var mc = mathChannelById(ed, param.mathChannelId);
      if (!mc) return '<div class="dlv-hg-math"><div class="dlv-hg-warn">This math channel no longer exists (deleted, or not available here).</div>' +
        '<button type="button" class="dlv-hg-btn sm" data-act="open-mathmgr">Open Math Channels…</button></div>';
      return '<div class="dlv-hg-math">' +
        '<div class="dlv-hg-math-head"><b>Math channel</b><span class="dlv-hg-faint">named, reusable — used by every histogram that references it</span>' +
          '<button type="button" class="dlv-hg-link" data-act="math-clear" data-ppath="' + ed.esc(pPath) + '">use a channel instead</button></div>' +
        '<div class="dlv-hg-math-ro mono">' + ed.esc(mc.expression || '(empty)') + '</div>' +
        '<div class="dlv-hg-math-tools"><span class="dlv-hg-faint">' + (mc.unit ? 'Unit: ' + ed.esc(displayUnit(mc.unit)) : 'No unit set') + '</span>' +
          '<button type="button" class="dlv-hg-link" data-act="open-mathmgr" data-mcid="' + ed.esc(mc.id) + '">Edit this definition…</button>' +
          '<button type="button" class="dlv-hg-link" data-act="mc-pick-other" data-ppath="' + ed.esc(pPath) + '">Choose a different math channel…</button></div>' +
        '</div>';
    }
    if (param.math == null) return '';
    var chans = (ed.data && ed.data.channels) || [];
    var fns = X() ? X().listFunctions() : [];
    return '<div class="dlv-hg-math">' +
      '<div class="dlv-hg-math-head"><b>Math expression</b><span class="dlv-hg-faint">[Channel Name] references · + − × ÷ ^ · functions below</span><button type="button" class="dlv-hg-link" data-act="math-clear" data-ppath="' + ed.esc(pPath) + '">use a channel instead</button></div>' +
      '<textarea class="dlv-hg-ta mono" rows="3" spellcheck="false" data-path="' + ed.esc(pPath) + '.math" data-expr="' + ed.esc(pPath) + '" placeholder="(([Equivalence Ratio Commanded - Bank 1]) - 1) * 100">' + ed.esc(param.math) + '</textarea>' +
      '<div class="dlv-hg-expr-status" data-expr-status="' + ed.esc(pPath) + '"></div>' +
      '<div class="dlv-hg-math-tools">' +
        '<select class="dlv-hg-in" data-insert-ch="' + ed.esc(pPath) + '"><option value="">Insert channel…</option>' + chans.map(function (c) { return '<option value="' + ed.esc(c) + '">' + ed.esc(c) + (ed.units[c] ? ' (' + ed.esc(ed.units[c]) + ')' : '') + '</option>'; }).join('') + '</select>' +
        '<details class="dlv-hg-fns"><summary>Functions (' + fns.length + ')</summary><div class="dlv-hg-fnlist">' + fns.map(function (f) {
          return '<button type="button" class="dlv-hg-fn" data-act="insert-fn" data-ppath="' + ed.esc(pPath) + '" data-fn="' + ed.esc(f.name) + '" title="' + ed.esc(f.doc) + '"><b>' + ed.esc(f.name) + '</b>(' + ed.esc(f.args) + ')' + (f.kind === 'window' ? '<i>ms</i>' : '') + '</button>';
        }).join('') + '</div></details>' +
      '</div>' +
      '<div class="dlv-hg-math-preview" data-math-preview="' + ed.esc(pPath) + '"></div>' +
      '</div>';
  }
  function cellTab(ed) {
    var w = ed.work, p = w.cellParameter;
    return '<div class="dlv-hg-section"><div class="dlv-hg-sect-title">Cell parameter <span class="dlv-hg-faint">— the value that fills the cells' + (w.type === 'distribution' ? ' / is binned' : '') + '</span></div>' +
      slotHeader(ed, p, 'cell', 'cellParameter') +
      row('Parameter', paramButton(ed, p, 'cellParameter', 'cell')) +
      mathPanel(ed, p, 'cellParameter') +
      row('Label', inp('cellParameter.label', p && p.label, 'nullstr', ' placeholder="shown on the table"')) +
      row('Unit', inp('cellParameter.unit', p && p.unit, 'nullstr', ' placeholder="' + ed.esc(liveUnitFor(p, ed.ctx) || 'as logged') + '"'), p && p.math != null && !p.channel ? 'Prefilled from the expression when it can be inferred (same-unit +/−, or × 100 → %).' : 'Informational for a channel parameter; values are reported in the log\'s unit.') +
      '</div>';
  }
  function bpLines(bp) { return (bp || []).map(function (v) { return isFin(v) ? fmtNum(v) : String(v); }).join('\n'); }
  function unitControl(ed, axKey, ax) {
    var live = liveUnitFor(ax.parameter, ed.ctx) || '';
    var cur = ax.unit || live || '';
    var members = familyMembers(cur || live);
    if (!members.length) return inp(axKey + '.unit', ax.unit || '', 'nullstr', ' placeholder="' + ed.esc(live || 'unit') + '" data-prev="' + ed.esc(ax.unit || '') + '"');
    var have = members.some(function (m) { return sameUnit(m.label, cur) || sameUnit(m.key, cur); });
    return '<select class="dlv-hg-in" data-path="' + ed.esc(axKey) + '.unit" data-type="nullstr" data-prev="' + ed.esc(ax.unit || live || '') + '">' +
      (!have && cur ? '<option value="' + ed.esc(cur) + '" selected>' + ed.esc(cur) + '</option>' : '') +
      members.map(function (m) { return '<option value="' + ed.esc(m.label) + '"' + (sameUnit(m.label, cur) || sameUnit(m.key, cur) ? ' selected' : '') + '>' + ed.esc(m.label) + (sameUnit(m.label, live) || sameUnit(m.key, live) ? ' (log)' : '') + '</option>'; }).join('') +
      '</select>';
  }
  function axisTab(ed, axKey) {
    var w = ed.work, ax = w[axKey], isRow = axKey === 'rowAxis', html = '';
    var title = isRow ? 'Row axis' : 'Column axis';
    if (w.type === 'distribution') return '<div class="dlv-hg-help">A distribution has no axes: its bins come from the cell parameter (see Display → Bins).</div>';
    html += '<div class="dlv-hg-section"><div class="dlv-hg-sect-title">' + title + (isRow ? ' <label class="dlv-hg-chk inline"><input type="checkbox" data-toggle="row"' + (ax ? '' : ' checked') + '> No row axis (1D)</label>' : '') + '</div>';
    if (!ax) return html + '<div class="dlv-hg-help">One-dimensional table: a single row of cells binned by the column axis.</div></div>';
    var rec = null;
    try { rec = ed.resolver(ax.parameter, isRow ? 'row' : 'column'); } catch (e) { rec = null; }
    var categorical = !!(rec && rec.levels && rec.levels.length) || !!(ax.categories && ax.categories.length && !(ax.breakpoints && ax.breakpoints.length));
    html += slotHeader(ed, ax.parameter, isRow ? 'row' : 'column', axKey + '.parameter') +
      row('Parameter', paramButton(ed, ax.parameter, axKey + '.parameter', isRow ? 'row' : 'column')) +
      mathPanel(ed, ax.parameter, axKey + '.parameter');
    if (categorical) {
      var cats = (ax.categories && ax.categories.length) ? ax.categories : (rec && rec.levels ? rec.levels.slice() : []);
      var levels = rec && rec.levels ? rec.levels : [];
      var missingCats = levels.filter(function (l) { return cats.indexOf(l) < 0; });
      html += row('Categories', '<div class="dlv-hg-cats">' + cats.map(function (c, i) {
        return '<div class="dlv-hg-cat' + (levels.length && levels.indexOf(c) < 0 ? ' absent' : '') + '"><span class="dlv-hg-cat-n">' + (i + 1) + '</span><span class="dlv-hg-cat-lbl">' + ed.esc(c) + '</span>' +
          '<button type="button" class="dlv-hg-mini" data-act="cat-up" data-ax="' + axKey + '" data-i="' + i + '" title="Move up">↑</button><button type="button" class="dlv-hg-mini" data-act="cat-down" data-ax="' + axKey + '" data-i="' + i + '" title="Move down">↓</button><button type="button" class="dlv-hg-mini x" data-act="cat-del" data-ax="' + axKey + '" data-i="' + i + '" title="Remove">×</button></div>';
      }).join('') + '</div>' +
        '<div class="dlv-hg-btnrow"><button type="button" class="dlv-hg-btn sm" data-act="cat-reset" data-ax="' + axKey + '">Reset to log order</button>' + (missingCats.length ? '<button type="button" class="dlv-hg-btn sm" data-act="cat-addall" data-ax="' + axKey + '">Add ' + missingCats.length + ' missing label' + (missingCats.length > 1 ? 's' : '') + '</button>' : '') + '</div>',
        'Categorical (text) parameter: one cell per label, in this order. Breakpoints do not apply.');
      return html + '</div>';
    }
    html += row('Unit', unitControl(ed, axKey, ax), 'Breakpoints are in this unit; the engine converts them to the log\'s unit when they differ.');
    var pc = ed.pendingConv[axKey];
    if (pc) html += '<div class="dlv-hg-convert"><b>Convert existing breakpoints?</b> ' + ax.breakpoints.length + ' values from ' + ed.esc(displayUnit(pc.from)) + ' → ' + ed.esc(displayUnit(pc.to)) + ' <button type="button" class="dlv-hg-btn sm primary" data-act="conv-yes" data-ax="' + axKey + '">Yes, convert</button><button type="button" class="dlv-hg-btn sm" data-act="conv-no" data-ax="' + axKey + '">No, keep numbers</button></div>';
    var gm = ed.genMode || 'step';
    html += '<div class="dlv-hg-sect-title sub">Breakpoints <span class="dlv-hg-faint">— cell centers, one per line · paste a row, a column or a whole HPT table</span></div>' +
      '<div class="dlv-hg-bp">' +
        '<div class="dlv-hg-bp-left"><textarea class="dlv-hg-bp-ta mono" data-bp="' + axKey + '" rows="11" spellcheck="false" placeholder="1000&#10;1500&#10;2000&#10;…">' + ed.esc(bpLines(ax.breakpoints)) + '</textarea><div class="dlv-hg-bp-status" data-bp-status="' + axKey + '"></div></div>' +
        '<div class="dlv-hg-bp-btns">' +
          '<button type="button" class="dlv-hg-btn sm" data-act="bp-paste" data-ax="' + axKey + '" title="Read the clipboard and replace the list">Paste Axis</button>' +
          '<button type="button" class="dlv-hg-btn sm" data-act="bp-clear" data-ax="' + axKey + '">Clear</button>' +
          '<button type="button" class="dlv-hg-btn sm" data-act="bp-reverse" data-ax="' + axKey + '">Reverse</button>' +
          '<button type="button" class="dlv-hg-btn sm" data-act="bp-sortasc" data-ax="' + axKey + '">Sort ↑</button>' +
          '<button type="button" class="dlv-hg-btn sm" data-act="bp-sortdesc" data-ax="' + axKey + '">Sort ↓</button>' +
          '<button type="button" class="dlv-hg-btn sm" data-act="bp-auto" data-ax="' + axKey + '" title="Nice steps from this log\'s 2nd–98th percentile">Auto</button>' +
          '<div class="dlv-hg-bp-gen"><div class="dlv-hg-bp-gen-title">Generate</div>' +
            '<label>Start <input type="number" step="any" class="dlv-hg-in" data-gen="start" data-ax="' + axKey + '"></label>' +
            '<label>End <input type="number" step="any" class="dlv-hg-in" data-gen="end" data-ax="' + axKey + '"></label>' +
            seg('bp.genMode', gm, [['step', 'Step'], ['count', 'Count']], ' data-ax="' + axKey + '"') +
            '<label><span data-gen-label="' + axKey + '">' + (gm === 'count' ? 'Count' : 'Step') + '</span> <input type="number" step="any" class="dlv-hg-in" data-gen="value" data-ax="' + axKey + '"></label>' +
            '<button type="button" class="dlv-hg-btn sm" data-act="bp-gen" data-ax="' + axKey + '">Generate</button>' +
          '</div>' +
        '</div>' +
      '</div></div>';
    return html;
  }
  // ---- filter --------------------------------------------------------------------------------------
  function ensureClauses(ed) { var f = ed.work.filter; if (!Array.isArray(f.clauses)) f.clauses = []; return f.clauses; }
  function clauseAt(clauses, cpath) {
    var parts = String(cpath).split('.'), list = clauses, c = null;
    for (var i = 0; i < parts.length; i++) {
      c = list[parseInt(parts[i], 10)];
      if (!c) return null;
      if (i < parts.length - 1) { list = Array.isArray(c) ? c : c.group; if (!list) return null; }
    }
    return c;
  }
  function clauseParent(clauses, cpath) {
    var parts = String(cpath).split('.'), list = clauses;
    for (var i = 0; i < parts.length - 1; i++) { var c = list[parseInt(parts[i], 10)]; list = Array.isArray(c) ? c : (c && c.group); if (!list) return null; }
    return { list: list, index: parseInt(parts[parts.length - 1], 10) };
  }
  function syncFilterExpression(ed) {
    var f = ed.work.filter;
    if (f.mode !== 'advanced' && X()) f.expression = buildSimpleSafe(f.clauses).text || null;
  }
  function clauseRows(ed, list, prefix) {
    var levels = (ed.data && ed.data.textLevels) || {};
    return list.map(function (c, i) {
      var cpath = prefix + i, join = (c && String(c.join || 'AND').toUpperCase() === 'OR') ? 'OR' : 'AND';
      var joinSel = i > 0 ? '<select class="dlv-hg-in dlv-hg-flt-join" data-clause="join" data-cpath="' + cpath + '"><option value="AND"' + (join === 'AND' ? ' selected' : '') + '>AND</option><option value="OR"' + (join === 'OR' ? ' selected' : '') + '>OR</option></select>' : '<span class="dlv-hg-flt-join first">where</span>';
      if (Array.isArray(c) || (c && Array.isArray(c.group))) {
        var inner = Array.isArray(c) ? c : c.group;
        return '<div class="dlv-hg-flt-grp">' + joinSel + '<div class="dlv-hg-flt-grpbox"><span class="dlv-hg-flt-paren">(</span>' + clauseRows(ed, inner, cpath + '.') +
          '<div class="dlv-hg-btnrow"><button type="button" class="dlv-hg-btn sm" data-act="clause-add" data-cpath="' + cpath + '">+ Add condition</button></div><span class="dlv-hg-flt-paren">)</span></div>' +
          '<button type="button" class="dlv-hg-mini x" data-act="clause-remove" data-cpath="' + cpath + '" title="Remove group">×</button></div>';
      }
      var lv = c.param ? levels[c.param] : null;
      var unit = c.param ? (ed.units[c.param] || '') : '';
      var valCtl = lv ? '<select class="dlv-hg-in" data-clause="value" data-cpath="' + cpath + '">' + lv.map(function (l) { return '<option value="' + ed.esc(l) + '"' + (String(c.value) === l ? ' selected' : '') + '>' + ed.esc(l) + '</option>'; }).join('') + '</select>' :
        '<input type="number" step="any" class="dlv-hg-in" data-clause="value" data-cpath="' + cpath + '" value="' + ed.esc(c.value == null ? '' : c.value) + '" placeholder="value">' + (unit ? '<span class="dlv-hg-unit">' + ed.esc(displayUnit(unit)) + '</span>' : '');
      return '<div class="dlv-hg-flt-row">' + joinSel +
        '<button type="button" class="dlv-hg-parambtn sm' + (c.param ? '' : ' empty') + '" data-act="pick-clause" data-cpath="' + cpath + '"><span class="name">' + ed.esc(c.param || 'Parameter…') + '</span><span class="caret">▾</span></button>' +
        '<select class="dlv-hg-in dlv-hg-flt-op" data-clause="op" data-cpath="' + cpath + '">' + OPS.map(function (o) { return '<option value="' + o[0] + '"' + ((c.op === '=' ? '==' : c.op) === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>' +
        valCtl +
        '<button type="button" class="dlv-hg-mini x" data-act="clause-remove" data-cpath="' + cpath + '" title="Remove">×</button></div>';
    }).join('');
  }
  function filterTab(ed) {
    var f = ed.work.filter, mode = f.mode === 'advanced' ? 'advanced' : 'simple', html;
    html = '<div class="dlv-hg-section"><div class="dlv-hg-sect-title">Sample filter <span class="dlv-hg-faint">— only samples that pass are binned</span></div>' +
      row('Mode', seg('filter.mode', mode, [['simple', 'Simple'], ['advanced', 'Advanced']]));
    if (mode === 'simple') {
      var clauses = ensureClauses(ed);
      html += '<div class="dlv-hg-flt">' + (clauses.length ? clauseRows(ed, clauses, '') : '<div class="dlv-hg-faint">No conditions — every sample passes.</div>') +
        '<div class="dlv-hg-btnrow"><button type="button" class="dlv-hg-btn sm" data-act="clause-add" data-cpath="">+ Add condition</button><button type="button" class="dlv-hg-btn sm" data-act="group-add" data-cpath="">+ Add group</button></div></div>';
    } else {
      var chans = (ed.data && ed.data.channels) || [], fns = X() ? X().listFunctions() : [];
      html += '<textarea class="dlv-hg-ta mono" rows="4" spellcheck="false" data-path="filter.expression" data-type="nullstr" data-expr="filter" placeholder="[Throttle Position] > 50 and [Engine RPM] > 2500">' + ed.esc(f.expression || '') + '</textarea>' +
        '<div class="dlv-hg-expr-status" data-expr-status="filter"></div>' +
        '<div class="dlv-hg-math-tools">' +
          '<select class="dlv-hg-in" data-insert-ch="filter"><option value="">Insert channel…</option>' + chans.map(function (c) { return '<option value="' + ed.esc(c) + '">' + ed.esc(c) + (ed.units[c] ? ' (' + ed.esc(ed.units[c]) + ')' : '') + '</option>'; }).join('') + '</select>' +
          '<details class="dlv-hg-fns"><summary>Functions (' + fns.length + ')</summary><div class="dlv-hg-fnlist">' + fns.map(function (fn) {
            return '<button type="button" class="dlv-hg-fn" data-act="insert-fn" data-ppath="filter" data-fn="' + ed.esc(fn.name) + '" title="' + ed.esc(fn.doc) + '"><b>' + ed.esc(fn.name) + '</b>(' + ed.esc(fn.args) + ')' + (fn.kind === 'window' ? '<i>ms</i>' : '') + '</button>';
          }).join('') + '</div></details>' +
        '</div>' +
        '<div class="dlv-hg-help block"><b>Time-window filters</b> (sizes in milliseconds, computed from the log\'s time stamps):' +
          '<div class="mono">held([Throttle Position] &gt; 50, 500, 500)</div><span>throttle held above 50 for the prior <i>and</i> following 500 ms — rejects tip-in / tip-out transients</span>' +
          '<div class="mono">avg([Engine RPM], 250) &gt; 3000</div><span>250 ms trailing average of RPM above 3000</span>' +
          '<div class="mono">[Gear] == \'4\' and not held([Brake], 200)</div><span>categorical labels compare in quotes; <i>and / or / not</i> combine</span>' +
        '</div>';
    }
    html += '<div class="dlv-hg-flt-readout" data-filter-count>…</div></div>';
    return html;
  }
  // ---- display -------------------------------------------------------------------------------------
  function binsModeOf(d) { if (!d) return 'auto'; if (isFin(d.bins)) return 'count'; if (isFin(d.binWidth) && d.binWidth > 0) return 'width'; return 'auto'; }
  function displayTab(ed) {
    var w = ed.work, cs = w.colorScale, H_ = H(), html;
    html = '<div class="dlv-hg-section"><div class="dlv-hg-sect-title">Display</div>' +
      row('Statistic', '<select class="dlv-hg-in" data-path="statistic">' + H_.STATISTICS.map(function (s) { return '<option value="' + s.id + '"' + (H_.normalizeStat(w.statistic) === s.id ? ' selected' : '') + '>' + s.label + '</option>'; }).join('') + '</select>', 'Default statistic shown in each cell; every statistic stays available in the view.') +
      row('Minimum hits', inp('minimumHits', w.minimumHits, 'int', ' min="0" step="1"'), 'Cells with fewer samples are shown greyed (not trusted).') +
      row('Color scale', seg('colorScale.mode', cs.mode === 'manual' ? 'manual' : 'auto', [['auto', 'Auto'], ['manual', 'Manual']]) +
        (cs.mode === 'manual' ? '<div class="dlv-hg-inline"><label>Min ' + inp('colorScale.min', cs.min, 'nullnum') + '</label><label>Center ' + inp('colorScale.center', cs.center, 'nullnum', ' placeholder="auto"') + '</label><label>Max ' + inp('colorScale.max', cs.max, 'nullnum') + '</label></div>' : '')) +
      row('Higher is worse', seg('colorScale.higherIsWorse', cs.higherIsWorse === true ? 'true' : cs.higherIsWorse === false ? 'false' : 'null', [['null', 'Auto'], ['true', 'Yes'], ['false', 'No']]), 'Which end of the scale is painted red. Auto guesses from the parameter (knock retard: lower is worse).') +
      row('Decimals', inp('display.decimals', w.display && w.display.decimals, 'nullint', ' min="0" max="6" step="1" placeholder="auto"'), 'Cell values (Average/Min/Max/Last/First). Blank picks decimals from the value magnitude.') +
      row('Axis decimals', inp('display.axisDecimals', w.display && w.display.axisDecimals, 'nullint', ' min="0" max="6" step="1" placeholder="2"'), 'Column/row breakpoint labels, e.g. a converted or Auto-generated Load axis. Trailing zeros are always trimmed, so a whole-number axis like RPM is unaffected.');
    if (w.type === 'distribution') {
      var d = w.distribution || {}, bm = binsModeOf(d);
      html += '<div class="dlv-hg-sect-title sub">Distribution bins</div>' +
        row('Bins', seg('distribution.binsMode', bm, [['auto', 'Auto'], ['count', 'Count N'], ['width', 'Width']]) +
          (bm === 'count' ? '<div class="dlv-hg-inline"><label>Count ' + inp('distribution.bins', d.bins, 'int', ' min="1" step="1"') + '</label></div>' : '') +
          (bm === 'width' ? '<div class="dlv-hg-inline"><label>Width ' + inp('distribution.binWidth', d.binWidth, 'nullnum', ' min="0"') + '</label></div>' : ''),
          bm === 'auto' ? 'Freedman–Diaconis width rounded to a 1/2/5 step.' : '') +
        row('Range', '<div class="dlv-hg-inline"><label>Min ' + inp('distribution.min', d.min, 'nullnum', ' placeholder="data"') + '</label><label>Max ' + inp('distribution.max', d.max, 'nullnum', ' placeholder="data"') + '</label></div>') +
        row('Mode', seg('distribution.mode', d.mode === 'percent' ? 'percent' : 'count', [['count', 'Count'], ['percent', 'Percent']]));
    }
    return html + '</div>';
  }

  // ---- post-render + actions ---------------------------------------------------------------------
  function afterRender(ed) {
    Array.prototype.forEach.call(ed.body.querySelectorAll('[data-bp]'), function (ta) { updateBpStatus(ed, ta.getAttribute('data-bp'), ta.value); });
    Array.prototype.forEach.call(ed.body.querySelectorAll('[data-expr]'), function (ta) { liveExpr(ed, ta); });
    if (ed.tab === 'filter') liveFilterCount(ed, false);
  }
  function debounce(ed, key, fn, ms) { if (ed.timers[key]) clearTimeout(ed.timers[key]); ed.timers[key] = setTimeout(function () { ed.timers[key] = null; if (!ed.closed) fn(); }, ms); }
  function bpTextarea(ed, axKey) { return ed.body.querySelector('[data-bp="' + axKey + '"]'); }
  function setBp(ed, axKey, values, note) {
    var ax = ed.work[axKey];
    if (!ax) return;
    ax.breakpoints = values.slice();
    var ta = bpTextarea(ed, axKey);
    if (ta) ta.value = bpLines(values);
    updateBpStatus(ed, axKey, ta ? ta.value : bpLines(values), note);
    ed.refreshValidation();
  }
  function commitBreakpoints(ed, axKey, text) {
    var r = normalizeAxisPaste(text), ax = ed.work[axKey];
    if (!ax) return;
    ax.breakpoints = r.values;
    var ta = bpTextarea(ed, axKey);
    if (ta && (r.detected !== 'newline' || r.rejected.length)) ta.value = bpLines(r.values);
    updateBpStatus(ed, axKey, ta ? ta.value : text);
  }
  function updateBpStatus(ed, axKey, text, note) {
    var st = ed.body.querySelector('[data-bp-status="' + axKey + '"]');
    if (!st) return;
    var r = normalizeAxisPaste(text), v = r.values, html;
    if (!v.length) html = '<span class="dlv-hg-warn">No breakpoints</span>';
    else {
      var ax = H().prepareAxis(v), even = ax ? looksUniform(ax.sorted) : false;
      var shape = ax ? (ax.isAscending ? (even ? 'even' : 'uneven') : ax.isDescending ? 'descending' + (even ? '' : ' · uneven') : 'unsorted') : '';
      html = '<b>' + v.length + '</b> breakpoint' + (v.length > 1 ? 's' : '') + (ax ? ' · ' + fmtNum(ax.min) + ' → ' + fmtNum(ax.max) + ' · ' + shape : '');
    }
    if (r.rejected.length) html += ' <span class="dlv-hg-faint">ignored: ' + ed.esc(r.rejected.slice(0, 6).join(', ')) + (r.rejected.length > 6 ? '…' : '') + '</span>';
    if (note) html += ' <span class="dlv-hg-note">' + ed.esc(note) + '</span>';
    st.innerHTML = html;
  }
  /** Even spacing within 1e-6 relative -- unit-converted axes are rounded to 6 significant digits. */
  function looksUniform(sorted) {
    var n = sorted.length;
    if (n < 3) return true;
    var step = sorted[1] - sorted[0], tol = Math.max(Math.abs(step) * 1e-6, 1e-12);
    for (var k = 1; k < n - 1; k++) if (Math.abs((sorted[k + 1] - sorted[k]) - step) > tol) return false;
    return true;
  }
  function exprTextarea(ed, pPath) { return ed.body.querySelector('[data-expr="' + pPath + '"]'); }
  function liveExpr(ed, ta) {
    var pPath = ta.getAttribute('data-expr'), st = ed.body.querySelector('[data-expr-status="' + pPath + '"]');
    if (!st || !X()) return;
    var src = ta.value, p = X().parse(src);
    if (!trim(src)) { st.innerHTML = '<span class="dlv-hg-faint">Empty expression' + (pPath === 'filter' ? ' — every sample passes' : '') + '</span>'; }
    else if (!p.ok) {
      var pos = p.error.pos, before = src.slice(Math.max(0, pos - 24), pos), at = src.slice(pos, pos + 24);
      // Unbracketed channel names are the common cause; say so, and that leaving the box fixes it.
      var fixable = X().autoBracket ? X().autoBracket(src, knownExprNames(ed)) : null;
      var hint = fixable && fixable.changed.length && X().parse(fixable.src).ok
        ? '<div class="dlv-hg-note">Channel names go in brackets — ' + ed.esc(fixable.changed.map(function (c) { return c.to; }).join(', ')) + ' will be added when you leave this box.</div>' : '';
      st.innerHTML = '<span class="dlv-hg-err">✗ ' + ed.esc(p.error.message) + '</span> <button type="button" class="dlv-hg-link" data-act="expr-jump" data-ppath="' + ed.esc(pPath) + '" data-pos="' + pos + '">at position ' + (pos + 1) + '</button>' +
        '<div class="dlv-hg-caret mono">' + ed.esc(before) + '<span class="dlv-hg-caret-mark">' + (at ? ed.esc(at.charAt(0)) : '⏎') + '</span>' + ed.esc(at.slice(1)) + '<br>' + new Array(before.length + 1).join(' ') + '^</div>' + hint;
    } else {
      var missing = [];
      if (ed.data && ed.data.series) {
        // Same forgiving lookup the compile uses (exprCtx), so the status never contradicts the preview.
        var chanFor = X().seriesResolver ? X().seriesResolver(ed.data.series, ed.data.textLevels || {}).channelFor : function (r) { return ed.data.series[r] ? r : null; };
        var mathNames = {};
        knownExprNames(ed).forEach(function (nm) { mathNames[X().normName ? X().normName(nm) : String(nm).toLowerCase()] = 1; });
        p.references.forEach(function (r) { if (!chanFor(r) && !mathNames[X().normName ? X().normName(r) : String(r).toLowerCase()]) missing.push(r); });
      }
      st.innerHTML = '<span class="dlv-hg-ok">✓ valid</span> <span class="dlv-hg-faint">' + p.references.length + ' channel' + (p.references.length === 1 ? '' : 's') + (p.functions.length ? ' · ' + p.functions.join(', ') : '') + '</span>' +
        (missing.length ? ' <span class="dlv-hg-warn">not in this log: ' + ed.esc(missing.join(', ')) + '</span>' : '');
    }
    if (pPath === 'filter') debounce(ed, 'fcount', function () { liveFilterCount(ed, false); }, 200);
    else debounce(ed, 'preview:' + pPath, function () { updateMathPreview(ed, pPath); }, 200);
  }
  function updateMathPreview(ed, pPath) {
    var pv = ed.body.querySelector('[data-math-preview="' + pPath + '"]');
    if (!pv || !X()) return;
    var ta = exprTextarea(ed, pPath), src = ta ? ta.value : (getPath(ed.work, pPath + '.math') || '');
    if (!trim(src)) { pv.innerHTML = ''; return; }
    if (!ed.data || !ed.data.series) { pv.innerHTML = '<span class="dlv-hg-faint">No log loaded — preview unavailable.</span>'; return; }
    var c = X().compile(src, exprCtx(ed.data));
    if (!c.ok) { pv.innerHTML = ''; return; }
    if (c.missing.length) { pv.innerHTML = '<span class="dlv-hg-warn">Cannot preview: ' + ed.esc(c.missing.join(', ')) + ' missing in this log</span>'; return; }
    var vals = c.evaluateAll(), n = vals.length, k = 0, mn = Infinity, mx = -Infinity, sum = 0, nan = 0;
    for (var i = 0; i < n; i++) { var v = vals[i]; if (v !== v || v === Infinity || v === -Infinity) { nan++; continue; } k++; sum += v; if (v < mn) mn = v; if (v > mx) mx = v; }
    var unit = getPath(ed.work, pPath + '.unit') || inferUnitForMath(src, ed.units) || '';
    pv.innerHTML = k ? '<span class="dlv-hg-faint">Preview on this log:</span> min <b>' + fmtNum(Number(mn.toPrecision(6))) + '</b> · avg <b>' + fmtNum(Number((sum / k).toPrecision(6))) + '</b> · max <b>' + fmtNum(Number(mx.toPrecision(6))) + '</b>' + (unit ? ' <span class="dlv-hg-unit">' + ed.esc(displayUnit(unit)) + '</span>' : '') + ' <span class="dlv-hg-faint">· ' + nan + ' NaN of ' + n + '</span>'
      : '<span class="dlv-hg-warn">Every sample evaluates to NaN (' + n + ' samples)</span>';
  }
  function currentFilterSource(ed) {
    var f = ed.work.filter;
    if (f.mode === 'advanced') { var ta = exprTextarea(ed, 'filter'); return ta ? ta.value : (f.expression || ''); }
    return buildSimpleSafe(f.clauses).text;
  }
  function liveFilterCount(ed, debounced) {
    if (debounced) { debounce(ed, 'fcount', function () { liveFilterCount(ed, false); }, 200); return; }
    var out = ed.body.querySelector('[data-filter-count]');
    if (!out) return;
    var src = currentFilterSource(ed), M = ed.data && ed.data.time ? ed.data.time.length : 0;
    if (!X() || !ed.data || !M) { out.innerHTML = '<span class="dlv-hg-faint">No log loaded — pass count unavailable.</span>'; return; }
    if (!trim(src)) { out.innerHTML = 'No filter — <b>all ' + M + '</b> samples pass'; return; }
    var c = X().compile(src, exprCtx(ed.data));
    if (!c.ok) { out.innerHTML = '<span class="dlv-hg-err">Filter does not compile: ' + ed.esc(c.error.message) + '</span>'; return; }
    if (c.missing.length) { out.innerHTML = '<span class="dlv-hg-warn">0 of ' + M + ' pass — ' + ed.esc(c.missing.join(', ')) + ' missing in this log</span>'; return; }
    var mask = c.evaluateMask(), n = 0;
    for (var i = 0; i < mask.length; i++) n += mask[i];
    out.innerHTML = '<b>' + n + '</b> of <b>' + M + '</b> samples pass <span class="dlv-hg-faint">(' + (M ? (100 * n / M).toFixed(1) : '0') + '%)</span>' + (c.isBoolean ? '' : ' <span class="dlv-hg-warn">— not a true/false expression; non-zero counts as pass</span>');
  }
  function switchFilterMode(ed, mode) {
    var f = ed.work.filter;
    if (mode === (f.mode === 'advanced' ? 'advanced' : 'simple')) return;
    if (!X()) { f.mode = mode; ed.render(); return; }
    if (mode === 'advanced') {
      f.expression = buildSimpleSafe(f.clauses).text || (f.expression || null);
      f.mode = 'advanced';
    } else {
      var src = trim(f.expression);
      if (src) {
        var parsed = X().parseSimpleFilter(src);
        if (!parsed) {
          ed.toast('This expression uses functions or math that Simple mode can\'t show — staying in Advanced.');
          var seg_ = ed.body.querySelector('[data-seg="filter.mode"]');
          if (seg_) Array.prototype.forEach.call(seg_.querySelectorAll('.dlv-hg-seg-btn'), function (b) { b.classList.toggle('on', b.getAttribute('data-seg-val') === 'advanced'); });
          var st = ed.body.querySelector('[data-expr-status="filter"]');
          if (st) st.innerHTML = '<span class="dlv-hg-warn">Not representable as simple conditions (functions, math or nested logic) — kept as Advanced.</span>';
          return;
        }
        f.clauses = parsed;
      } else f.clauses = [];
      f.mode = 'simple';
      syncFilterExpression(ed);
    }
    ed.render();
  }
  function setBinsMode(ed, mode) {
    var w = ed.work;
    if (!isObj(w.distribution)) w.distribution = { bins: 'auto', binWidth: null, min: null, max: null, mode: 'count' };
    var d = w.distribution;
    if (mode === 'count') { d.bins = isFin(d.bins) ? d.bins : 20; d.binWidth = null; }
    else if (mode === 'width') { d.bins = 'auto'; d.binWidth = isFin(d.binWidth) && d.binWidth > 0 ? d.binWidth : null; }
    else { d.bins = 'auto'; d.binWidth = null; }
    ed.render();
  }
  function setRowEnabled(ed, enabled) {
    var w = ed.work;
    if (enabled) {
      w.rowAxis = ed.rowStash || H().makeAxis({ parameter: null, breakpoints: [] });
    } else {
      if (w.rowAxis) ed.rowStash = w.rowAxis;
      w.rowAxis = null;
    }
    ed.render();
  }
  function onClauseChange(ed, t) {
    var clauses = ensureClauses(ed), c = clauseAt(clauses, t.getAttribute('data-cpath')), field = t.getAttribute('data-clause');
    if (!c) return;
    if (field === 'join') c.join = t.value === 'OR' ? 'OR' : 'AND';
    else if (field === 'op') c.op = t.value;
    else if (field === 'value') {
      if (t.tagName === 'SELECT') c.value = t.value;
      else { var v = parseFloat(t.value); c.value = isFin(v) ? v : (trim(t.value) === '' ? null : t.value); }
    }
    syncFilterExpression(ed);
    liveFilterCount(ed, false);
  }
  function insertIntoExpr(ed, pPath, text) {
    var ta = exprTextarea(ed, pPath);
    if (!ta) return;
    var s = ta.selectionStart != null ? ta.selectionStart : ta.value.length, e = ta.selectionEnd != null ? ta.selectionEnd : s;
    var before = ta.value.slice(0, s), after = ta.value.slice(e);
    var pad = before && !/\s$/.test(before) && !/[(\[]$/.test(before) ? ' ' : '';
    ta.value = before + pad + text + after;
    var caret = (before + pad + text).length;
    ta.focus();
    try { ta.setSelectionRange(caret, caret); } catch (err) { /* ignore */ }
    var path = ta.getAttribute('data-path');
    if (path) { setPath(ed.work, path, ta.value); onPathChanged(ed, path, ta.value, ta); }
    liveExpr(ed, ta);
    ed.refreshValidation();
  }
  function applyPickedParam(ed, pPath, param, info) {
    var w = ed.work;
    var isAxis = /^(columnAxis|rowAxis)\.parameter$/.test(pPath);
    var prev = getPath(w, pPath);
    if (info && info.math) {
      // Switching a channel parameter to Math: drop the channel's unit/label so inferUnitForMath can
      // prefill from the expression; an existing math parameter keeps its own unit/label.
      var wasMath = !!(prev && prev.math && !prev.channel);
      param = { channel: null, role: null, math: wasMath ? prev.math : '', unit: wasMath ? prev.unit : null, label: wasMath ? (prev.label || '') : '' };
    }
    setPath(w, pPath, param);
    if (isAxis) {
      var ax = w[pPath.split('.')[0]];
      if (info && info.categorical) { ax.categories = info.levels.slice(); ax.breakpoints = []; ax.unit = null; }
      else {
        ax.categories = null;
        var axKeyP = pPath.split('.')[0];
        if (!ax.breakpoints || !ax.breakpoints.length || !ax.unit) { ax.unit = param.unit || null; delete ed.pendingConv[axKeyP]; }
        else {
          // Same "keep the true origin" rule as the unit <select> above: a re-pick before the
          // pending prompt is answered must not lose track of what unit the numbers actually are.
          var existingP = ed.pendingConv[axKeyP];
          var trueFromP = existingP ? existingP.from : ax.unit;
          if (param.unit && !sameUnit(trueFromP, param.unit) && canConvert(trueFromP, param.unit)) {
            ed.pendingConv[axKeyP] = { from: trueFromP, to: param.unit };
          } else {
            // Different, non-convertible unit family (or picking back into the original family with
            // nothing to offer): nothing to convert FROM, so adopt the new unit directly rather than
            // leaving the axis stuck reporting a family that no longer matches its parameter.
            ax.unit = param.unit || null;
            delete ed.pendingConv[axKeyP];
          }
        }
      }
    }
    ed.render();
    if (info && info.math) { var ta = exprTextarea(ed, pPath); if (ta) ta.focus(); }
  }
  function onAction(ed, act, btn) {
    var w = ed.work, axKey = btn.getAttribute('data-ax'), pPath = btn.getAttribute('data-ppath'), ax = axKey ? w[axKey] : null, H_ = H();
    switch (act) {
      case 'pick': case 'mc-pick-other': {
        var cur = getPath(w, pPath), slot = btn.getAttribute('data-slot');
        var mcListFn = ed.opts.mathChannels && typeof ed.opts.mathChannels.list === 'function' ? ed.opts.mathChannels.list : null;
        channelPicker(btn, {
          channels: (ed.data && ed.data.channels) || [], unitByChannel: ed.units, textLevels: (ed.data && ed.data.textLevels) || {},
          resolvedRoles: ed.ctx.resolvedRoles, allowCategorical: true, allowMath: true, current: cur,
          mathChannels: mcListFn ? mcListFn() : [],
          onManageMath: mcListFn ? function () { openMathManagerFromEditor(ed, null); } : null,
          onPick: function (param, info) { applyPickedParam(ed, pPath, param, info); }
        });
        return;
      }
      case 'map': {
        var ch = btn.getAttribute('data-ch'), cur2 = getPath(w, pPath) || {};
        var lv = ed.data && ed.data.textLevels ? ed.data.textLevels[ch] : null;
        applyPickedParam(ed, pPath, { channel: ch, role: cur2.role || null, math: null, unit: ed.units[ch] || null, label: ch }, { categorical: !!lv, levels: lv });
        return;
      }
      case 'math-clear': { var p0 = getPath(w, pPath); if (p0) { p0.math = null; p0.channel = null; p0.role = null; p0.mathChannelId = null; } ed.render(); return; }
      case 'open-mathmgr': { openMathManagerFromEditor(ed, btn.getAttribute('data-mcid') || null); return; }
      case 'insert-fn': insertIntoExpr(ed, pPath, btn.getAttribute('data-fn') + '('); return;
      case 'expr-jump': { var ta0 = exprTextarea(ed, pPath); if (ta0) { ta0.focus(); var pos = parseInt(btn.getAttribute('data-pos'), 10) || 0; try { ta0.setSelectionRange(pos, pos + 1); } catch (e0) { /* ignore */ } } return; }
      case 'bp-paste': {
        var ta1 = bpTextarea(ed, axKey);
        if (global.navigator && navigator.clipboard && navigator.clipboard.readText) {
          navigator.clipboard.readText().then(function (text) {
            var r = normalizeAxisPaste(text);
            if (!r.values.length) { updateBpStatus(ed, axKey, ta1 ? ta1.value : '', 'Clipboard had no numbers'); return; }
            setBp(ed, axKey, r.values, 'Pasted ' + r.values.length + ' values (' + r.detected + ')');
          }, function () { if (ta1) ta1.focus(); updateBpStatus(ed, axKey, ta1 ? ta1.value : '', 'Clipboard blocked — click the box and press Ctrl+V'); });
        } else { if (ta1) ta1.focus(); updateBpStatus(ed, axKey, ta1 ? ta1.value : '', 'Click the box and press Ctrl+V to paste'); }
        return;
      }
      case 'bp-clear': setBp(ed, axKey, []); return;
      case 'bp-reverse': setBp(ed, axKey, H_.reverseBreakpoints(ax.breakpoints)); return;
      case 'bp-sortasc': setBp(ed, axKey, H_.sortBreakpoints(ax.breakpoints, 'asc')); return;
      case 'bp-sortdesc': setBp(ed, axKey, H_.sortBreakpoints(ax.breakpoints, 'desc')); return;
      case 'bp-auto': {
        var auto = defaultBreakpointsFor(ax.parameter, ed.data, ed.resolver);
        if (!auto.length) { updateBpStatus(ed, axKey, bpTextarea(ed, axKey).value, 'Auto needs a numeric parameter with data in this log'); return; }
        if (ax.unit) { var live = liveUnitFor(ax.parameter, ed.ctx); if (live && !sameUnit(ax.unit, live) && canConvert(live, ax.unit)) auto = auto.map(function (v) { return Number(convertOne(v, live, ax.unit).toPrecision(6)); }); }
        setBp(ed, axKey, auto, 'Auto: ' + auto.length + ' steps from this log');
        return;
      }
      case 'bp-gen': {
        var g = {};
        Array.prototype.forEach.call(ed.body.querySelectorAll('[data-gen][data-ax="' + axKey + '"]'), function (i) { g[i.getAttribute('data-gen')] = parseFloat(i.value); });
        var byCount = (ed.genMode || 'step') === 'count';
        var vals = generateBreakpoints(g.start, g.end, g.value, byCount);
        if (!vals.length) { updateBpStatus(ed, axKey, bpTextarea(ed, axKey).value, 'Generate needs start, end and a ' + (byCount ? 'count' : 'step')); return; }
        setBp(ed, axKey, vals, 'Generated ' + vals.length);
        return;
      }
      case 'conv-yes': {
        // CRITICAL: this used to convert the displayed NUMBERS but leave ax.unit at the old unit, so
        // the engine (which independently converts a def's axis unit to the live channel's unit at
        // compute time) converted the ALREADY-converted numbers a second time -- every sample
        // clamped into one edge cell while the editor still said "Ready to save". Both must move
        // together: once the numbers are in pc.to, the axis must say pc.to too.
        var pc = ed.pendingConv[axKey];
        if (pc) {
          ax.breakpoints = ax.breakpoints.map(function (v) { var c = convertOne(v, pc.from, pc.to); return isFin(c) ? Number(c.toPrecision(6)) : v; });
          ax.unit = pc.to;
        }
        delete ed.pendingConv[axKey];
        ed.render();
        return;
      }
      case 'conv-no': delete ed.pendingConv[axKey]; ed.render(); return;
      case 'cat-up': case 'cat-down': case 'cat-del': case 'cat-reset': case 'cat-addall': {
        var rec = null;
        try { rec = ed.resolver(ax.parameter, axKey === 'rowAxis' ? 'row' : 'column'); } catch (e1) { rec = null; }
        var levels = rec && rec.levels ? rec.levels : [];
        var cats = (ax.categories && ax.categories.length) ? ax.categories.slice() : levels.slice();
        var i = parseInt(btn.getAttribute('data-i'), 10);
        if (act === 'cat-up' && i > 0) { var t1 = cats[i - 1]; cats[i - 1] = cats[i]; cats[i] = t1; }
        else if (act === 'cat-down' && i < cats.length - 1) { var t2 = cats[i + 1]; cats[i + 1] = cats[i]; cats[i] = t2; }
        else if (act === 'cat-del') cats.splice(i, 1);
        else if (act === 'cat-reset') cats = levels.slice();
        else if (act === 'cat-addall') levels.forEach(function (l) { if (cats.indexOf(l) < 0) cats.push(l); });
        ax.categories = cats.length ? cats : null;
        ed.render();
        return;
      }
      case 'clause-add': case 'group-add': {
        var clauses = ensureClauses(ed), cpath = btn.getAttribute('data-cpath'), list = clauses;
        if (cpath) { var grp = clauseAt(clauses, cpath); list = Array.isArray(grp) ? grp : grp.group; }
        if (act === 'group-add') list.push({ group: [{ param: '', op: '>', value: null, join: 'AND' }], join: 'AND' });
        else list.push({ param: '', op: '>', value: null, join: 'AND' });
        syncFilterExpression(ed);
        ed.render();
        return;
      }
      case 'clause-remove': {
        var par = clauseParent(ensureClauses(ed), btn.getAttribute('data-cpath'));
        if (par) par.list.splice(par.index, 1);
        syncFilterExpression(ed);
        ed.render();
        return;
      }
      case 'pick-clause': {
        var cp = btn.getAttribute('data-cpath'), cl = clauseAt(ensureClauses(ed), cp);
        channelPicker(btn, {
          channels: (ed.data && ed.data.channels) || [], unitByChannel: ed.units, textLevels: (ed.data && ed.data.textLevels) || {},
          resolvedRoles: ed.ctx.resolvedRoles, allowCategorical: true, allowMath: false, current: { channel: cl ? cl.param : null },
          onPick: function (param, info) {
            if (!cl) return;
            // HIGH: leaving a prior pick's `role` on the clause let the TABLE (which resolves role
            // before channel) keep filtering on the OLD channel while the editor's own "N of M pass"
            // count -- built from `param` alone -- already reflected the newly picked one; the two
            // disagreed on the same log. Always replace both together.
            cl.param = param.channel;
            cl.role = param.role || null;
            if (info && info.categorical) { cl.op = '=='; cl.value = info.levels[0]; }
            else if (typeof cl.value === 'string') cl.value = null;
            syncFilterExpression(ed);
            ed.render();
          }
        });
        return;
      }
      default: return;
    }
  }

  // ================================================================================================
  // 9. Public API namespace
  // ================================================================================================
  var HistogramEditor = {
    VERSION: 1,
    normalizeAxisPaste: normalizeAxisPaste,
    validateForm: validateForm,
    inferUnitForMath: inferUnitForMath,
    defaultBreakpointsFor: defaultBreakpointsFor,
    generateBreakpoints: generateBreakpoints,
    makeLocalResolver: makeLocalResolver,
    familyMembers: familyMembers,
    open: openEditor,
    channelPicker: channelPicker,
    closePicker: closePicker,
    openMathManager: openMathManager
  };
  global.HistogramEditor = HistogramEditor;
  if (typeof module !== 'undefined' && module.exports) module.exports = HistogramEditor;
})(typeof window !== 'undefined' ? window : globalThis);
