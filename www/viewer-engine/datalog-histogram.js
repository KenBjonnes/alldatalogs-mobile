/* =================================================================================================
 * datalog-histogram.js -- the BigData "Histograms" CALCULATION engine (Phase 1: engine only, no UI).
 *
 * WHAT THIS IS
 *   A pure, UI-agnostic engine that maps logged samples into a 1D or 2D table by user-chosen axis
 *   parameters and BREAKPOINTS, the way HP Tuners VCM Scanner's table/binning histograms do:
 *     Columns = Engine RPM (1000,1500,...)  Rows = Cylinder Airmass (0.20,0.30,...)  Cell = Knock Retard
 *   Every sample lands in exactly ONE cell (no interpolation). Breakpoints are cell CENTERS: a value is
 *   assigned to the NEAREST breakpoint, so the boundary between two adjacent breakpoints is their
 *   midpoint. Cells keep raw accumulators (count/sum/min/max/first/last + sample indices) so the
 *   displayed statistic (Average/Minimum/Maximum/Last/First/Count) switches instantly, and so later
 *   layers (rules/AI, two-log diff) can query the structured result.
 *
 * BINNING RULES (documented here, enforced in prepareAxis/binPos)
 *   - Breakpoints may be ascending, descending, unevenly spaced, floating point or negative. Nothing
 *     assumes linear spacing: binning is a binary search over the midpoints of the ASCENDING sorted
 *     copy, mapped back to the breakpoint's DISPLAY index (original order).
 *   - A value exactly on a midpoint (equal distance to two breakpoints) goes to the LOWER breakpoint
 *     in ascending order -- including decimal ties whose midpoint is not representable (0.65 between
 *     0.6 and 0.7: the computed bound is 0.6499999999999999; a value within 4 ulps above it is a tie).
 *   - outOfRange:'clamp' (default, HPT-style): values below the smallest / above the largest
 *     breakpoint land in that edge cell. outOfRange:'drop': values strictly outside
 *     [min breakpoint, max breakpoint] are discarded (counted in sampleStats.droppedOutOfRange).
 *   - A single breakpoint bins everything into that one cell in both modes. Zero breakpoints is an
 *     invalid definition (compute returns state:'invalid'; prepareAxis returns null).
 *   - Missing data (NaN / undefined / null / non-finite) in ANY required value skips the sample. It is
 *     NEVER treated as 0.
 *   - Min/max ties keep the FIRST occurrence (strict comparisons). Sums are plain double summation.
 *
 * DEFINITION SCHEMA (JSON, versioned -- see makeDef for defaults, validateDef for the rules)
 *   Parameters are OPAQUE to this engine: a PARAM {channel, role, math, unit, label} is resolved by the
 *   caller through ctx.getParam(param, slot). Categorical channels arrive as level indices + levels[];
 *   a definition never stores a level index, only labels (axis.categories).
 *   Additions to the brief's schema: axis.categories (string[]|null) for categorical axis parameters.
 *
 * Style: ES5 vanilla JS (plain <script> in the viewer, require() in node), one global `Histogram`.
 * No DOM, no eval, no closures or allocation per sample in the hot loops (typed-array accumulators).
 * =============================================================================================== */
(function (global) {
  'use strict';

  /** Bump when the persisted definition shape changes; migrateDef() upgrades older defs. */
  var HISTOGRAM_SCHEMA_VERSION = 1;
  var PACKAGE_KIND = 'bigdata-histograms';
  var MAX_DISTRIBUTION_BINS = 10000;
  var MAX_AUTO_BINS = 500;

  var STATISTICS = [
    { id: 'average', label: 'Average' },
    // Σ(weight × value) / Σweight over the cell, with def.weightParameter as the weight (Ford blends
    // between mapped points, so a sample that is 70% MP15 counts 0.7 in MP15's table -- Ken,
    // 2026-09-08). Without a weight parameter it is the plain average.
    { id: 'weighted', label: 'Weighted Avg' },
    { id: 'minimum', label: 'Minimum' },
    { id: 'maximum', label: 'Maximum' },
    { id: 'last', label: 'Last' },
    { id: 'first', label: 'First' },
    { id: 'count', label: 'Count' }
  ];
  var STAT_IDS = STATISTICS.map(function (s) { return s.id; });
  var STAT_ALIASES = { avg: 'average', mean: 'average', min: 'minimum', max: 'maximum', cnt: 'count', hits: 'count', wavg: 'weighted', 'weighted average': 'weighted', weighted_average: 'weighted', weightedaverage: 'weighted' };
  var OUT_OF_RANGE = ['clamp', 'drop'];
  var DATA_RANGES = ['entire', 'selection'];
  var ORIENTATIONS = ['normal', 'inverted'];
  var TYPES = ['table', 'distribution'];

  // ================================================================================================
  // 0. Small helpers
  // ================================================================================================
  function isFin(v) { return typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity; }
  function isObj(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  var _idSeq = 0;
  function newId() {
    _idSeq++;
    return 'hg_' + Date.now().toString(36) + '_' + _idSeq.toString(36) + Math.floor(Math.random() * 46656).toString(36);
  }
  /** Compact numeric label: trims float noise (0.30000000000000004 -> "0.3"). */
  function fmtNum(v) { return isFin(v) ? String(Number(v.toPrecision(10))) : ''; }
  function now() {
    return (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') ? performance.now() : Date.now();
  }
  function sameUnit(a, b) { return String(a).trim().toLowerCase() === String(b).trim().toLowerCase(); }
  function normalizeStat(stat) {
    if (typeof stat !== 'string') return null;
    var s = stat.trim().toLowerCase();
    s = STAT_ALIASES[s] || s;
    return STAT_IDS.indexOf(s) >= 0 ? s : null;
  }
  function statLabel(stat) {
    var id = normalizeStat(stat);
    for (var i = 0; i < STATISTICS.length; i++) if (STATISTICS[i].id === id) return STATISTICS[i].label;
    return String(stat);
  }
  function mergeInto(target, defaults) {
    Object.keys(defaults).forEach(function (k) { if (target[k] === undefined) target[k] = defaults[k]; });
    return target;
  }

  // ================================================================================================
  // 1. Breakpoint utilities (tuners paste axes copied from VCM Editor / Excel / hand-typed lists)
  // ================================================================================================
  /**
   * parseBreakpoints(text) -> { values:number[], rejected:string[], units:string[] }
   *   Accepts tab / comma / space / semicolon / newline separated input (a row or a column copied from
   *   a table), values with attached units or labels ("1000 rpm", "0.20 g/cyl", "20%", "45°"),
   *   negatives, unicode minus, scientific notation. Non-numeric tokens go to `rejected`, except a
   *   run of non-numeric tokens directly following a number, which is treated as that number's unit
   *   label and reported in `units` (so "1000 rpm, 1500 rpm" is not "rejected: rpm, rpm").
   *   Exact repeats are de-duplicated; ORIGINAL order is kept (never sorted).
   *   THOUSANDS RULE: a comma between digits with EXACTLY 3 following digits ("1,500") is treated as a
   *   thousands separator ONLY when another separator type (tab, newline, semicolon, or whitespace
   *   between tokens) is present in the text; otherwise every comma is a separator ("1,500" alone
   *   or "1000,1500,2000" -> commas separate). Ambiguous input therefore errs toward "separator".
   */
  function parseBreakpoints(text) {
    var values = [], rejected = [], units = [], seen = {};
    if (text == null) return { values: values, rejected: rejected, units: units };
    if (Array.isArray(text)) text = text.join('\n');
    var s = String(text).replace(/ /g, ' ').replace(/−/g, '-').replace(/\r\n?/g, '\n');
    var hasOtherSep = /[\t\n;]/.test(s) || /\S[ ]+\S/.test(s.trim());
    if (hasOtherSep) {
      var prev;
      do { prev = s; s = s.replace(/(\d),(\d{3})(?!\d)/g, '$1$2'); } while (s !== prev);
    }
    var tokens = s.split(/[\s;,]+/);
    var lastWasNumber = false;
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      if (!t) continue;
      var v = parseNumberToken(t);
      if (v === null) {
        if (lastWasNumber && !/\d/.test(t)) units.push(t); else { rejected.push(t); lastWasNumber = false; }
        continue;
      }
      lastWasNumber = true;
      var key = String(v);
      if (seen[key]) continue;
      seen[key] = true;
      values.push(v);
    }
    return { values: values, rejected: rejected, units: units };
  }
  /** One token -> finite number, or null. Strips wrapping brackets/quotes and a trailing unit. */
  function parseNumberToken(t) {
    var s = String(t).replace(/^[\(\[\{"'`°º~≈$]+/, '').replace(/[\)\]\}"'`]+$/, '');
    var m = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)(.*)$/.exec(s);
    if (!m) return null;
    if (/\d/.test(m[2])) return null;          // "12abc34", "1.2.3", "1-2" -> not a clean number
    var v = parseFloat(m[1]);
    return isFin(v) ? v : null;
  }
  function numericCopy(values) {
    var out = [];
    if (!values || values.length == null) return out;
    for (var i = 0; i < values.length; i++) { var v = values[i]; if (typeof v === 'string') v = parseFloat(v); if (isFin(v)) out.push(v); }
    return out;
  }
  function sortBreakpoints(values, dir) {
    var out = numericCopy(values);
    out.sort(function (a, b) { return a - b; });
    if (dir === 'desc') out.reverse();
    return out;
  }
  function reverseBreakpoints(values) { return numericCopy(values).reverse(); }
  function formatBreakpoints(values, sep) { return numericCopy(values).map(fmtNum).join(sep == null ? ', ' : sep); }

  // ================================================================================================
  // 2. Definition schema: defaults, validation, migration, clone/invert, import/export
  // ================================================================================================
  function makeParam(p) {
    if (p == null) return null;
    if (typeof p === 'string') p = { channel: p };
    if (!isObj(p)) return null;
    var str = function (v) { return typeof v === 'string' && v ? v : null; };
    var out = { channel: str(p.channel), role: str(p.role), math: str(p.math), unit: str(p.unit), label: str(p.label), mathChannelId: str(p.mathChannelId) };
    if (!out.label) out.label = out.channel || out.role || out.math || out.mathChannelId || '';
    return out;
  }
  // mathChannelId references a NAMED, reusable calculated channel (managed outside this engine, in the
  // viewer glue) instead of copying its expression inline -- the engine never evaluates a param itself
  // (that's always ctx.getParam), so accepting this shape here is just "this def names a parameter."
  function isParam(p) { return isObj(p) && (!!p.channel || !!p.role || !!p.math || !!p.mathChannelId); }
  // ---- Math-channel references -----------------------------------------------------------------
  // A param carries a math channel's ID, but ids are minted per creation: a saved layout carries its
  // own copy of the channel list with the ids current at save time, and loading it (or building the
  // same channel again on another host) leaves earlier histograms pointing at an id that no longer
  // exists while a channel of the same NAME sits right there (Ken, 2026-09-08: "missing or deleted,
  // but it's right there"). So every lookup resolves by id first, then by name, and a load remaps
  // stale ids onto the live ones. Names compare case-insensitively with underscores/spacing folded.
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
  // Rewrite every mathChannelId in a def list through idMap (old id -> live id). Returns deep copies;
  // defs and params without a mapped id come back unchanged.
  function remapMathChannelIds(defs, idMap) {
    if (!Array.isArray(defs)) return [];
    var map = isObj(idMap) ? idMap : {};
    var touch = function (p) { if (isObj(p) && p.mathChannelId && map[p.mathChannelId]) p.mathChannelId = map[p.mathChannelId]; };
    var walkClauses = function (clauses) {
      if (!Array.isArray(clauses)) return;
      clauses.forEach(function (c) {
        if (Array.isArray(c)) { walkClauses(c); return; }
        if (!isObj(c)) return;
        if (Array.isArray(c.group)) { walkClauses(c.group); return; }
        touch(c.param);
      });
    };
    return defs.map(function (d) {
      var copy = clone(d);
      if (!isObj(copy)) return copy;
      touch(copy.cellParameter);
      touch(copy.weightParameter);
      if (isObj(copy.columnAxis)) touch(copy.columnAxis.parameter);
      if (isObj(copy.rowAxis)) touch(copy.rowAxis.parameter);
      if (isObj(copy.filter)) walkClauses(copy.filter.clauses);
      return copy;
    });
  }
  function makeAxis(a) {
    if (a == null) return null;
    if (Array.isArray(a) || typeof a === 'string') a = { breakpoints: a };
    if (!isObj(a)) return null;
    var bp = a.breakpoints;
    if (typeof bp === 'string') bp = parseBreakpoints(bp).values;
    if (!Array.isArray(bp)) bp = [];
    // numeric strings become numbers; anything else is kept so validateDef can report it
    bp = bp.map(function (x) { return (typeof x === 'string' && parseNumberToken(x) !== null) ? parseNumberToken(x) : x; });
    var cats = Array.isArray(a.categories) ? a.categories.filter(function (s) { return typeof s === 'string' && s; }) : null;
    return {
      parameter: makeParam(a.parameter),
      unit: typeof a.unit === 'string' && a.unit ? a.unit : null,
      breakpoints: bp,
      categories: cats && cats.length ? cats : null
    };
  }
  function defaultFilter() { return { mode: 'simple', clauses: null, expression: null }; }
  function defaultColorScale() { return { mode: 'auto', min: null, center: null, max: null, higherIsWorse: null }; }
  function defaultDistribution() { return { bins: 'auto', binWidth: null, min: null, max: null, mode: 'count' }; }

  /** Build a complete definition from a partial one (fills defaults + id). Enum values given by the
   *  caller are kept even when invalid so validateDef() can report them; only MISSING fields default. */
  function makeDef(partial) {
    partial = isObj(partial) ? partial : {};
    var type = partial.type == null ? 'table' : partial.type;
    var stat = partial.statistic == null ? 'average' : (normalizeStat(partial.statistic) || partial.statistic);
    var wantDist = type === 'distribution' || isObj(partial.distribution);
    return {
      version: HISTOGRAM_SCHEMA_VERSION,
      id: typeof partial.id === 'string' && partial.id ? partial.id : newId(),
      name: typeof partial.name === 'string' ? partial.name : 'New Histogram',
      description: typeof partial.description === 'string' ? partial.description : '',
      type: type,
      enabled: partial.enabled !== false,
      cellParameter: makeParam(partial.cellParameter),
      // Optional: each sample's contribution to Average-type statistics ('weighted') is scaled by this
      // parameter (e.g. "Mapped Point {n} Weight"). An empty/cleared param object means "no weight".
      weightParameter: isParam(makeParam(partial.weightParameter)) ? makeParam(partial.weightParameter) : null,
      columnAxis: makeAxis(partial.columnAxis),
      rowAxis: makeAxis(partial.rowAxis),
      statistic: stat,
      minimumHits: partial.minimumHits == null ? 5 : partial.minimumHits,
      outOfRange: partial.outOfRange == null ? 'clamp' : partial.outOfRange,
      filter: mergeInto(clone(isObj(partial.filter) ? partial.filter : {}), defaultFilter()),          // opaque, carried through
      colorScale: mergeInto(clone(isObj(partial.colorScale) ? partial.colorScale : {}), defaultColorScale()), // carried through
      dataRange: partial.dataRange == null ? 'entire' : partial.dataRange,
      orientation: partial.orientation == null ? 'normal' : partial.orientation,
      distribution: wantDist ? mergeInto(clone(isObj(partial.distribution) ? partial.distribution : {}), defaultDistribution()) : null,
      display: isObj(partial.display) ? clone(partial.display) : {},
      // The shared-library item this def was published to / pulled from (so "Share to library"
      // can offer to update it rather than duplicate it). Null for a def that has never been shared.
      libraryId: typeof partial.libraryId === 'string' && partial.libraryId ? partial.libraryId : null,
      vehicle: isObj(partial.vehicle) ? clone(partial.vehicle) : null,
      // One definition cycled through a numbered family of channels (see "Pages" below). null = off.
      pages: normalizePages(partial.pages)
    };
  }

  // ================================================================================================
  // 2b. Pages -- one definition, cycled through a numbered family of channels
  // ================================================================================================
  // Ken (2026-09-08): a Coyote's fueling error has to be read PER MAPPED POINT (the ECU's pre-mapped
  // cam positions), so the filter is "[Mapped Point 15 Weight] > 5" -- and a copy of the same table
  // existed for every point ("I have to have a ton of them"). def.pages names the channel family with
  // a {n} placeholder ("Mapped Point {n} Weight"); the values {n} takes are discovered from the log's
  // channel names (or listed explicitly), and applyPage() writes the current value into every string
  // of the def -- filter, parameters, math, name -- to make the concrete def that gets computed. The
  // engine's compute never sees {n}; the table UI keeps one result per page and steps with the arrows.
  var PAGE_VAR = '{n}';
  function hasPageVar(s) { return typeof s === 'string' && s.indexOf(PAGE_VAR) >= 0; }
  function substitutePage(s, value) { return (typeof s === 'string' && value != null) ? s.split(PAGE_VAR).join(String(value)) : s; }
  function isPageValue(v) { return typeof v === 'number' ? isFin(v) : (typeof v === 'string' && v !== ''); }
  function normalizePages(p) {
    if (!isObj(p)) return null;
    var pattern = typeof p.pattern === 'string' ? p.pattern.replace(/^\s+|\s+$/g, '') : '';
    if (!pattern) return null;
    var values = Array.isArray(p.values) ? p.values.filter(isPageValue) : null;
    return {
      pattern: pattern,
      values: values && values.length ? values : null,
      label: (typeof p.label === 'string' && p.label.replace(/^\s+|\s+$/g, '')) ? p.label : null,
      current: isPageValue(p.current) ? p.current : null
    };
  }
  function usesPages(def) { return !!(isObj(def) && isObj(def.pages) && typeof def.pages.pattern === 'string' && def.pages.pattern); }
  function samePage(a, b) { return a != null && b != null && String(a).toLowerCase() === String(b).toLowerCase(); }
  function escapeRe(s) { return String(s).replace(/[.*+?^$\{}()|[\]\\]/g, '\\$&'); }
  /** RegExp that matches a channel name against a {n} pattern -- case-insensitive, any run of spaces or
   *  underscores matches any other, {n} captures the value. null when the pattern has no {n}. */
  function pageRegExp(pattern) {
    if (!hasPageVar(pattern)) return null;
    var parts = String(pattern).split(PAGE_VAR).map(function (t) {
      return escapeRe(t.replace(/^\s+|\s+$/g, '')).replace(/\s+/g, '[\\s_]+');
    });
    return new RegExp('^' + parts.join('[\\s_]*(.+?)[\\s_]*') + '$', 'i');
  }
  function pageValueOf(raw) {
    raw = String(raw == null ? '' : raw).replace(/^\s+|\s+$/g, '');
    return (/^-?\d+(\.\d+)?$/.test(raw) && String(Number(raw)) === raw) ? Number(raw) : raw;
  }
  /** The values {n} takes: def.pages.values when listed, else every value found in channelNames. */
  function pageValues(def, channelNames) {
    if (!usesPages(def)) return [];
    var p = def.pages;
    if (Array.isArray(p.values) && p.values.length) return p.values.slice();
    var re = pageRegExp(p.pattern);
    if (!re || !Array.isArray(channelNames)) return [];
    var out = [], seen = {};
    for (var i = 0; i < channelNames.length; i++) {
      var m = re.exec(String(channelNames[i] == null ? '' : channelNames[i]));
      if (!m) continue;
      var v = pageValueOf(m[1]);
      if (v === '') continue;
      var key = typeof v === 'number' ? 'n:' + v : 's:' + v.toLowerCase();
      if (seen[key]) continue;
      seen[key] = true; out.push(v);
    }
    var allNum = out.every(function (v) { return typeof v === 'number'; });
    out.sort(allNum ? function (a, b) { return a - b; } : function (a, b) { return String(a).localeCompare(String(b), undefined, { numeric: true }); });
    return out;
  }
  /** The page to show: def.pages.current when it is one of `values`, else the first value, else current. */
  function currentPage(def, values) {
    if (!usesPages(def)) return null;
    var cur = def.pages.current;
    if (Array.isArray(values) && values.length) {
      if (cur != null) for (var i = 0; i < values.length; i++) if (samePage(values[i], cur)) return values[i];
      return values[0];
    }
    return cur;
  }
  /** Short label for the arrows: "MP 15" for "Mapped Point {n} Weight" (initials of the words before
   *  {n} when they are long, the words themselves when short), or def.pages.label with {n} filled in. */
  function defaultPageLabel(pattern) {
    var head = String(pattern || '').split(PAGE_VAR)[0].replace(/[\s_]+$/g, '').replace(/[\s_]+/g, ' ');
    if (!head) return 'Page ' + PAGE_VAR;
    if (head.length > 8) {
      var words = head.split(' ').filter(Boolean);
      if (words.length > 1) head = words.map(function (w) { return w.charAt(0).toUpperCase(); }).join('');
    }
    return head + ' ' + PAGE_VAR;
  }
  function pageLabel(def, value) {
    if (!usesPages(def)) return '';
    var tpl = def.pages.label || defaultPageLabel(def.pages.pattern);
    return value == null ? tpl : substitutePage(tpl, value);
  }
  function substituteParam(p, value) {
    if (!isObj(p)) return p;
    var c = clone(p);
    c.channel = substitutePage(c.channel, value);
    c.math = substitutePage(c.math, value);
    c.label = substitutePage(c.label, value);
    return c;
  }
  function substituteClauses(list, value) {
    if (!Array.isArray(list)) return list;
    return list.map(function (c) {
      if (Array.isArray(c)) return substituteClauses(c, value);
      if (!isObj(c)) return c;
      var copy = clone(c);
      if (Array.isArray(copy.group)) { copy.group = substituteClauses(copy.group, value); return copy; }
      if (typeof copy.param === 'string') copy.param = substitutePage(copy.param, value);
      else if (isObj(copy.param)) copy.param = substituteParam(copy.param, value);
      return copy;
    });
  }
  /** The concrete def for one page: a deep copy with {n} replaced by `value` everywhere it can appear
   *  (name, cell/axis parameters, inline math, filter expression and simple-filter clauses). */
  function applyPage(def, value) {
    if (!isObj(def)) return def;
    var d = clone(def);
    if (value == null) return d;
    d.name = substitutePage(d.name, value);
    d.cellParameter = substituteParam(d.cellParameter, value);
    d.weightParameter = substituteParam(d.weightParameter, value);
    if (isObj(d.columnAxis)) d.columnAxis.parameter = substituteParam(d.columnAxis.parameter, value);
    if (isObj(d.rowAxis)) d.rowAxis.parameter = substituteParam(d.rowAxis.parameter, value);
    if (isObj(d.filter)) {
      d.filter.expression = substitutePage(d.filter.expression, value);
      d.filter.clauses = substituteClauses(d.filter.clauses, value);
    }
    return d;
  }
  function paramUsesPageVar(p) { return isObj(p) && (hasPageVar(p.channel) || hasPageVar(p.math) || hasPageVar(p.label)); }
  function clausesUsePageVar(list) {
    if (!Array.isArray(list)) return false;
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (Array.isArray(c)) { if (clausesUsePageVar(c)) return true; continue; }
      if (!isObj(c)) continue;
      if (Array.isArray(c.group)) { if (clausesUsePageVar(c.group)) return true; continue; }
      if (hasPageVar(c.param) || paramUsesPageVar(c.param)) return true;
    }
    return false;
  }
  /** Which parts of the def carry {n}: any of 'name', 'cell parameter', 'column axis', 'row axis', 'filter'. */
  function pageVarUses(def) {
    var out = [];
    if (!isObj(def)) return out;
    if (hasPageVar(def.name)) out.push('name');
    if (paramUsesPageVar(def.cellParameter)) out.push('cell parameter');
    if (paramUsesPageVar(def.weightParameter)) out.push('weight');
    if (isObj(def.columnAxis) && paramUsesPageVar(def.columnAxis.parameter)) out.push('column axis');
    if (isObj(def.rowAxis) && paramUsesPageVar(def.rowAxis.parameter)) out.push('row axis');
    if (isObj(def.filter) && (hasPageVar(def.filter.expression) || clausesUsePageVar(def.filter.clauses))) out.push('filter');
    return out;
  }
  /** Every way to read a channel name as "family + number": one candidate per integer in the name,
   *  {pattern, value}, space-bounded numbers first ("Mapped Point 15 Weight" -> "Mapped Point {n} Weight", 15). */
  function derivePagePatterns(name) {
    name = String(name == null ? '' : name);
    var out = [], re = /\d+/g, m;
    while ((m = re.exec(name))) {
      var s = m.index, e = s + m[0].length;
      var before = s > 0 ? name.charAt(s - 1) : '', after = e < name.length ? name.charAt(e) : '';
      if (before === '.' || after === '.') continue;          // part of a decimal
      var bounded = (before === '' || /[\s_]/.test(before)) && (after === '' || /[\s_]/.test(after));
      out.push({ pattern: name.slice(0, s) + PAGE_VAR + name.slice(e), value: Number(m[0]), bounded: bounded, concrete: name });
    }
    out.sort(function (a, b) { return (b.bounded ? 1 : 0) - (a.bounded ? 1 : 0); });
    return out;
  }
  function derivePagePattern(name) { var c = derivePagePatterns(name); return c.length ? c[0] : null; }
  function sameChannelName(a, b) { return normChannelName(a) === normChannelName(b) && normChannelName(a) !== ''; }
  function replaceRefs(src, concrete, pattern, counter) {
    if (typeof src !== 'string') return src;
    return src.replace(/\[([^\]]+)\]|"([^"]+)"/g, function (whole, br, qu) {
      var ref = br != null ? br : qu;
      if (!sameChannelName(ref, concrete)) return whole;
      counter.n++;
      return '[' + pattern + ']';
    });
  }
  function patternParam(p, concrete, pattern, counter) {
    if (!isObj(p)) return p;
    var c = clone(p);
    if (sameChannelName(c.channel, concrete)) { c.channel = pattern; c.role = null; counter.n++; if (sameChannelName(c.label, concrete)) c.label = pattern; }
    if (typeof c.math === 'string') c.math = replaceRefs(c.math, concrete, pattern, counter);
    return c;
  }
  function patternClauses(list, concrete, pattern, counter) {
    if (!Array.isArray(list)) return list;
    return list.map(function (c) {
      if (Array.isArray(c)) return patternClauses(c, concrete, pattern, counter);
      if (!isObj(c)) return c;
      var copy = clone(c);
      if (Array.isArray(copy.group)) { copy.group = patternClauses(copy.group, concrete, pattern, counter); return copy; }
      if (typeof copy.param === 'string') { if (sameChannelName(copy.param, concrete)) { copy.param = pattern; copy.role = null; counter.n++; } }
      else if (isObj(copy.param)) { var before = counter.n; copy.param = patternParam(copy.param, concrete, pattern, counter); if (counter.n > before) copy.role = null; }
      return copy;
    });
  }
  /** Rewrite every use of the concrete channel `concrete` in a def as the {n} `pattern` (parameters,
   *  inline math and filter expression references, simple-filter clauses); when `value` is given, a
   *  standalone occurrence of that number in the NAME becomes {n} too ("MP15 FT" -> "MP{n} FT").
   *  Returns { def, count } -- a deep copy and how many places changed. */
  function applyPagePattern(def, concrete, pattern, value) {
    var counter = { n: 0 };
    if (!isObj(def)) return { def: def, count: 0 };
    var d = clone(def);
    d.cellParameter = patternParam(d.cellParameter, concrete, pattern, counter);
    d.weightParameter = patternParam(d.weightParameter, concrete, pattern, counter);
    if (isObj(d.columnAxis)) d.columnAxis.parameter = patternParam(d.columnAxis.parameter, concrete, pattern, counter);
    if (isObj(d.rowAxis)) d.rowAxis.parameter = patternParam(d.rowAxis.parameter, concrete, pattern, counter);
    if (isObj(d.filter)) {
      d.filter.expression = replaceRefs(d.filter.expression, concrete, pattern, counter);
      d.filter.clauses = patternClauses(d.filter.clauses, concrete, pattern, counter);
    }
    if (typeof d.name === 'string' && !hasPageVar(d.name)) {
      if (sameChannelName(d.name, concrete)) { d.name = pattern; counter.n++; }
      else if (value != null && /^-?\d+$/.test(String(value))) {
        var re = new RegExp('(^|\\D)' + escapeRe(String(value)) + '(?!\\d)');
        if (re.test(d.name)) { d.name = d.name.replace(re, '$1' + PAGE_VAR); counter.n++; }
      }
    }
    return { def: d, count: counter.n };
  }
  /** Every concrete channel name a def refers to (parameters, bracketed refs in math/filters, clauses). */
  function channelStringsOf(def) {
    var out = [];
    var add = function (s) { if (typeof s === 'string' && s && out.indexOf(s) < 0) out.push(s); };
    var fromParam = function (p) {
      if (!isObj(p)) return;
      if (p.channel) add(p.channel);
      if (typeof p.math === 'string') p.math.replace(/\[([^\]]+)\]/g, function (_, ref) { add(ref.replace(/^\s+|\s+$/g, '')); return _; });
    };
    var walk = function (list) {
      if (!Array.isArray(list)) return;
      list.forEach(function (c) {
        if (Array.isArray(c)) { walk(c); return; }
        if (!isObj(c)) return;
        if (Array.isArray(c.group)) { walk(c.group); return; }
        if (typeof c.param === 'string') add(c.param); else fromParam(c.param);
      });
    };
    if (!isObj(def)) return out;
    fromParam(def.cellParameter);
    fromParam(def.weightParameter);
    if (isObj(def.columnAxis)) fromParam(def.columnAxis.parameter);
    if (isObj(def.rowAxis)) fromParam(def.rowAxis.parameter);
    if (isObj(def.filter)) {
      if (typeof def.filter.expression === 'string') def.filter.expression.replace(/\[([^\]]+)\]/g, function (_, ref) { add(ref.replace(/^\s+|\s+$/g, '')); return _; });
      walk(def.filter.clauses);
    }
    return out;
  }
  /** The concrete members of a def's page family still written out in full (e.g. "Mapped Point 15
   *  Weight" while the pattern is "Mapped Point {n} Weight") -- what "Replace with the pattern" acts on. */
  function pageConcretes(def, pattern) {
    var re = pageRegExp(pattern);
    if (!re) return [];
    return channelStringsOf(def).filter(function (s) { return !hasPageVar(s) && re.test(s); });
  }
  /** Fold a list of defs that differ only by one number in a channel name (MP0 FT, MP1 FT, ... each
   *  filtering on its own "Mapped Point N Weight") into one paged def per family. Returns
   *  { defs, collapsed:[{id, name, pattern, values, count}] }; defs keeps the original order, the paged
   *  def taking the first member's place and id. Defs with no family come through untouched. */
  function collapsePaged(defs) {
    var out = { defs: Array.isArray(defs) ? defs.slice() : [], collapsed: [] };
    if (out.defs.length < 2) return out;
    var groups = {}, order = [];
    var normalKey = function (d) {
      var c = clone(d);
      delete c.id; delete c.display; delete c.description; delete c.libraryId; delete c.enabled;
      c.pages = null;
      return JSON.stringify(c);
    };
    out.defs.forEach(function (d, idx) {
      if (!isObj(d) || usesPages(d)) return;
      channelStringsOf(d).forEach(function (s) {
        derivePagePatterns(s).forEach(function (cand) {
          var r = applyPagePattern(d, s, cand.pattern, cand.value);
          if (!r.count) return;
          var key = cand.pattern.toLowerCase() + '\u0001' + normalKey(r.def);
          if (!groups[key]) { groups[key] = { pattern: cand.pattern, members: [] }; order.push(key); }
          groups[key].members.push({ idx: idx, value: cand.value, def: r.def, concrete: s });
        });
      });
    });
    // Largest family first; a def joins one family only.
    var keys = order.slice().sort(function (a, b) { return groups[b].members.length - groups[a].members.length; });
    var taken = {}, replaceAt = {}, remove = {};
    keys.forEach(function (key) {
      var g = groups[key], members = [], seenVal = {};
      g.members.forEach(function (m) {
        if (taken[m.idx] || seenVal[m.value]) return;
        members.push(m); seenVal[m.value] = true;
      });
      if (members.length < 2) return;
      members.sort(function (a, b) { return a.value - b.value; });
      members.forEach(function (m) { taken[m.idx] = true; });
      // The paged def takes the LIST-FIRST member's slot and id (a layout that referenced that table
      // still finds it); it opens on the lowest page value.
      var firstIdx = Math.min.apply(null, members.map(function (m) { return m.idx; }));
      var lead = null;
      for (var li = 0; li < members.length; li++) if (members[li].idx === firstIdx) lead = members[li];
      var paged = lead.def;
      paged.id = out.defs[firstIdx].id;
      paged.pages = normalizePages({ pattern: g.pattern, values: null, label: null, current: members[0].value });
      replaceAt[firstIdx] = paged;
      members.forEach(function (m) { if (m.idx !== firstIdx) remove[m.idx] = true; });
      out.collapsed.push({ id: paged.id, name: paged.name, pattern: g.pattern, values: members.map(function (m) { return m.value; }), count: members.length });
    });
    if (!out.collapsed.length) return out;
    var list = [];
    out.defs.forEach(function (d, idx) {
      if (replaceAt[idx]) list.push(replaceAt[idx]);
      else if (!remove[idx]) list.push(d);
    });
    out.defs = list;
    return out;
  }

  function validateAxis(ax, name, errors) {
    if (!isObj(ax)) { errors.push(name + ' is required'); return; }
    if (!isParam(ax.parameter)) errors.push(name + '.parameter is required (channel, role or math)');
    var bp = ax.breakpoints, cats = Array.isArray(ax.categories) ? ax.categories : null, hasCats = !!(cats && cats.length);
    if (hasCats) {
      var seenC = {};
      for (var c = 0; c < cats.length; c++) {
        if (seenC['#' + cats[c]]) errors.push(name + ' has a duplicate category "' + cats[c] + '"');
        seenC['#' + cats[c]] = true;
      }
    }
    if (!Array.isArray(bp) || bp.length === 0) {
      if (!hasCats) errors.push(name + ' has no breakpoints');
      return;
    }
    var seen = {};
    for (var i = 0; i < bp.length; i++) {
      if (!isFin(bp[i])) { errors.push(name + ' breakpoint #' + (i + 1) + ' is not a finite number (' + JSON.stringify(bp[i]) + ')'); continue; }
      var key = String(bp[i]);
      if (seen[key]) errors.push(name + ' has a duplicate breakpoint ' + fmtNum(bp[i]));
      seen[key] = true;
    }
  }
  function validateDef(def) {
    var errors = [];
    if (!isObj(def)) return { ok: false, errors: ['definition is not an object'] };
    if (TYPES.indexOf(def.type) === -1) errors.push('type must be "table" or "distribution"');
    if (!isParam(def.cellParameter)) errors.push('cellParameter is required (channel, role or math)');
    // An all-null weight object (the editor's cleared state) is "no weight" -- makeDef nulls it.
    if (def.weightParameter != null && !isObj(def.weightParameter)) errors.push('weightParameter must be a parameter (channel, role or math) or null');
    if (normalizeStat(def.statistic) === null) errors.push('statistic "' + def.statistic + '" is not one of ' + STAT_IDS.join('/'));
    if (!(isFin(def.minimumHits) && def.minimumHits >= 0)) errors.push('minimumHits must be a number >= 0');
    if (OUT_OF_RANGE.indexOf(def.outOfRange) === -1) errors.push('outOfRange must be "clamp" or "drop"');
    if (DATA_RANGES.indexOf(def.dataRange) === -1) errors.push('dataRange must be "entire" or "selection"');
    if (ORIENTATIONS.indexOf(def.orientation) === -1) errors.push('orientation must be "normal" or "inverted"');
    if (def.pages != null) {
      if (!isObj(def.pages)) errors.push('pages must be an object or null');
      else {
        if (!hasPageVar(def.pages.pattern)) errors.push('pages.pattern must contain ' + PAGE_VAR + ' (e.g. "Mapped Point ' + PAGE_VAR + ' Weight")');
        if (def.pages.values != null && !(Array.isArray(def.pages.values) && def.pages.values.every(isPageValue))) errors.push('pages.values must be a list of numbers or names');
      }
    }
    if (def.type === 'table') {
      validateAxis(def.columnAxis, 'columnAxis', errors);
      if (def.rowAxis != null) validateAxis(def.rowAxis, 'rowAxis', errors);
    } else if (def.type === 'distribution') {
      var d = def.distribution;
      if (!isObj(d)) errors.push('distribution settings are required for type "distribution"');
      else {
        if (!(d.bins === 'auto' || d.bins == null || (isFin(d.bins) && d.bins >= 1 && d.bins <= MAX_DISTRIBUTION_BINS && Math.floor(d.bins) === d.bins)))
          errors.push('distribution.bins must be "auto" or an integer 1..' + MAX_DISTRIBUTION_BINS);
        if (!(d.binWidth == null || (isFin(d.binWidth) && d.binWidth > 0))) errors.push('distribution.binWidth must be null or > 0');
        if (!(d.min == null || isFin(d.min))) errors.push('distribution.min must be null or a finite number');
        if (!(d.max == null || isFin(d.max))) errors.push('distribution.max must be null or a finite number');
        if (isFin(d.min) && isFin(d.max) && d.min >= d.max) errors.push('distribution.min must be below distribution.max');
        if (isFin(d.min) && isFin(d.max) && d.min < d.max && isFin(d.binWidth) && d.binWidth > 0 && (d.max - d.min) / d.binWidth > MAX_DISTRIBUTION_BINS)
          errors.push('distribution.binWidth ' + fmtNum(d.binWidth) + ' over ' + fmtNum(d.min) + '..' + fmtNum(d.max) + ' would create more than ' + MAX_DISTRIBUTION_BINS + ' bins');
        if (d.mode !== 'count' && d.mode !== 'percent') errors.push('distribution.mode must be "count" or "percent"');
      }
    }
    return { ok: errors.length === 0, errors: errors };
  }

  /** Upgrade an older / version-less / hand-written def to the current schema IN PLACE (keeps the
   *  object's identity, like Scorecard.migrateDef). Fills missing optional fields, normalizes axes
   *  and params, accepts legacy aliases, stamps `version`. Idempotent. */
  function migrateDef(def) {
    if (!isObj(def)) return def;
    var v = isFin(def.version) ? def.version : 0;
    if (v < 1) {
      // v0 (version-less): tolerate short-hand keys from hand-written JSON
      if (def.cellParameter == null && def.cell != null) { def.cellParameter = def.cell; delete def.cell; }
      if (def.columnAxis == null && def.columns != null) { def.columnAxis = def.columns; delete def.columns; }
      if (def.rowAxis == null && def.rows != null) { def.rowAxis = def.rows; delete def.rows; }
      if (def.statistic == null && def.stat != null) { def.statistic = def.stat; delete def.stat; }
      if (def.minimumHits == null && def.minHits != null) { def.minimumHits = def.minHits; delete def.minHits; }
    }
    var filled = makeDef(def);
    Object.keys(filled).forEach(function (k) { def[k] = filled[k]; });
    def.version = HISTOGRAM_SCHEMA_VERSION;
    return def;
  }
  function cloneDef(def) {
    var c = migrateDef(clone(def));
    c.id = newId();
    c.name = (def && def.name ? def.name : 'Histogram') + ' (copy)';
    return c;
  }
  /** Swap column/row axes (structural). Returns a NEW def with the same id; a 1D def is returned as-is.
   *  Independent of def.orientation, which is the UI's view flag (use transposeResult for that). */
  function invertDef(def) {
    if (!isObj(def) || !def.rowAxis) return def;
    var c = clone(def);
    c.columnAxis = clone(def.rowAxis);
    c.rowAxis = clone(def.columnAxis);
    return c;
  }
  function exportDef(def) { return JSON.stringify(def, null, 2); }
  // A math channel as it travels inside a package: the four fields and nothing else.
  function packMathChannel(m) {
    if (!isObj(m) || !m.name || !m.expression) return null;
    return { id: String(m.id || ''), name: String(m.name), expression: String(m.expression), unit: m.unit == null ? null : String(m.unit) };
  }
  // The math channels a def list depends on: those referenced by id (or by a name in the param label)
  // plus, transitively, every channel an included expression references by [Name]. A package or a
  // shared library item that carries these imports whole; one that doesn't imports as "missing
  // parameter" (Ken, 2026-09-08).
  function mathChannelDeps(defs, list) {
    var out = [], seen = {};
    if (!Array.isArray(list) || !list.length) return out;
    var add = function (mc) {
      if (!mc || seen[mc.id]) return;
      seen[mc.id] = true; out.push(mc);
      String(mc.expression || '').replace(/\[([^\]]+)\]/g, function (_, ref) { add(mathChannelByRef(list, ref)); return _; });
    };
    var fromParam = function (p) { if (isObj(p) && p.mathChannelId) add(mathChannelByRef(list, p.mathChannelId) || (p.label ? mathChannelByRef(list, p.label) : null)); };
    var walkClauses = function (clauses) {
      if (!Array.isArray(clauses)) return;
      clauses.forEach(function (c) {
        if (Array.isArray(c)) { walkClauses(c); return; }
        if (!isObj(c)) return;
        if (Array.isArray(c.group)) { walkClauses(c.group); return; }
        fromParam(c.param);
      });
    };
    (Array.isArray(defs) ? defs : [defs]).forEach(function (d) {
      if (!isObj(d)) return;
      fromParam(d.cellParameter);
      fromParam(d.weightParameter);
      if (isObj(d.columnAxis)) fromParam(d.columnAxis.parameter);
      if (isObj(d.rowAxis)) fromParam(d.rowAxis.parameter);
      if (isObj(d.filter)) walkClauses(d.filter.clauses);
    });
    return out;
  }
  function exportDefs(defs, mathChannels) {
    var pkg = { version: HISTOGRAM_SCHEMA_VERSION, kind: PACKAGE_KIND, exportedAt: new Date().toISOString(),
      histograms: (Array.isArray(defs) ? defs : [defs]).filter(isObj) };
    var mcs = Array.isArray(mathChannels) ? mathChannels.map(packMathChannel).filter(Boolean) : [];
    if (mcs.length) pkg.mathChannels = mcs;
    return JSON.stringify(pkg, null, 2);
  }
  function parseInput(input, warnings) {
    if (typeof input === 'string') {
      try { return JSON.parse(input); } catch (e) { warnings.push('invalid JSON: ' + (e && e.message ? e.message : e)); return null; }
    }
    return input;
  }
  function looksLikeDef(o) {
    return isObj(o) && (isObj(o.cellParameter) || typeof o.cellParameter === 'string' || isObj(o.columnAxis) || TYPES.indexOf(o.type) !== -1);
  }
  function importDef(input) {
    var warnings = [];
    var obj = parseInput(input, warnings);
    if (obj === null || obj === undefined) { if (!warnings.length) warnings.push('nothing to import'); return { def: null, warnings: warnings }; }
    if (isObj(obj) && Array.isArray(obj.histograms)) { warnings.push('input is a histogram package; use importDefs'); return { def: null, warnings: warnings }; }
    if (!looksLikeDef(obj)) { warnings.push('input does not look like a histogram definition'); return { def: null, warnings: warnings }; }
    var def = migrateDef(clone(obj));
    if (isFin(obj.version) && obj.version > HISTOGRAM_SCHEMA_VERSION) {
      warnings.push('definition schema version ' + obj.version + ' is newer than this viewer supports (' + HISTOGRAM_SCHEMA_VERSION + '); fields it does not understand are ignored');
      def.version = obj.version;   // keep the original stamp rather than silently downgrading
    }
    var v = validateDef(def);
    v.errors.forEach(function (e) { warnings.push('validation: ' + e); });
    return { def: def, warnings: warnings };
  }
  function importDefs(input) {
    var warnings = [], defs = [], mathChannels = [];
    var obj = parseInput(input, warnings);
    if (obj === null || obj === undefined) { if (!warnings.length) warnings.push('nothing to import'); return { defs: defs, mathChannels: mathChannels, warnings: warnings }; }
    var list;
    if (Array.isArray(obj)) list = obj;
    else if (isObj(obj) && Array.isArray(obj.histograms)) {
      if (obj.kind && obj.kind !== PACKAGE_KIND) warnings.push('package kind "' + obj.kind + '" is not ' + PACKAGE_KIND);
      if (isFin(obj.version) && obj.version > HISTOGRAM_SCHEMA_VERSION) warnings.push('package schema version ' + obj.version + ' is newer than this viewer supports (' + HISTOGRAM_SCHEMA_VERSION + ')');
      list = obj.histograms;
      if (Array.isArray(obj.mathChannels)) mathChannels = obj.mathChannels.map(packMathChannel).filter(Boolean);
    } else if (looksLikeDef(obj)) list = [obj];
    else { warnings.push('input is not a histogram package'); return { defs: defs, mathChannels: mathChannels, warnings: warnings }; }
    list.forEach(function (item, i) {
      var r = importDef(item);
      if (r.def) defs.push(r.def); else warnings.push('histogram #' + (i + 1) + ' skipped');
      r.warnings.forEach(function (w) { warnings.push('#' + (i + 1) + ': ' + w); });
    });
    return { defs: defs, mathChannels: mathChannels, warnings: warnings };
  }
  // Merge packaged math channels into a live list BY NAME: a same-named live channel wins (its id
  // is kept, so nothing already referencing it moves), a new one is added under a fresh id when its
  // packaged id collides. Returns { list, idMap } -- idMap rewrites the package's ids onto the live
  // ones for remapMathChannelIds.
  function mergeMathChannels(live, incoming, mintId) {
    var list = (Array.isArray(live) ? live : []).slice(), idMap = {}, added = [];
    var byName = {}, byId = {};
    list.forEach(function (m) { if (m && m.name) byName[normChannelName(m.name)] = m; if (m && m.id) byId[m.id] = m; });
    (Array.isArray(incoming) ? incoming : []).forEach(function (raw) {
      var m = packMathChannel(raw);
      if (!m) return;
      var have = byName[normChannelName(m.name)];
      if (have) { if (m.id && m.id !== have.id) idMap[m.id] = have.id; return; }
      var id = m.id && !byId[m.id] ? m.id : (typeof mintId === 'function' ? mintId(m) : 'mc_' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36));
      if (m.id && id !== m.id) idMap[m.id] = id;
      var copy = { id: id, name: m.name, expression: m.expression, unit: m.unit };
      list.push(copy); added.push(copy); byName[normChannelName(m.name)] = copy; byId[id] = copy;
    });
    return { list: list, idMap: idMap, added: added };
  }

  // ================================================================================================
  // 3. Binning core
  // ================================================================================================
  /**
   * prepareAxis(breakpoints, opts) -> axis | null (null when no finite breakpoint)
   *   breakpoints: original (display) order; sorted: ascending Float64Array; sortedToDisplay /
   *   displayToSorted: index maps; bounds: B-1 midpoints between ascending neighbours; min/max;
   *   isAscending / isDescending (original order), isUniform (equal spacing), labels, dropped.
   */
  function prepareAxis(breakpoints, opts) {
    opts = opts || {};
    if (typeof breakpoints === 'string') breakpoints = parseBreakpoints(breakpoints).values;   // never iterate characters
    var src = (breakpoints && typeof breakpoints === 'object' && typeof breakpoints.length === 'number') ? breakpoints : null;
    if (!src) return null;                                                                       // non-array-like
    var bp = [], dropped = [], seen = {}, i, k;
    for (i = 0; i < src.length; i++) {
      var v = src[i];
      if (typeof v === 'string') v = parseFloat(v);
      if (!isFin(v)) { dropped.push(src[i]); continue; }
      var key = String(v);
      if (seen[key]) { dropped.push(v); continue; }
      seen[key] = true;
      bp.push(v);
    }
    var B = bp.length;
    if (B === 0) return null;
    var order = [];
    for (i = 0; i < B; i++) order.push(i);
    order.sort(function (a, b) { return bp[a] - bp[b]; });
    var sorted = new Float64Array(B), s2d = new Int32Array(B), d2s = new Int32Array(B);
    for (k = 0; k < B; k++) { sorted[k] = bp[order[k]]; s2d[k] = order[k]; d2s[order[k]] = k; }
    var bounds = new Float64Array(B > 1 ? B - 1 : 0);
    for (k = 0; k < B - 1; k++) bounds[k] = (sorted[k] + sorted[k + 1]) / 2;
    var isAsc = true, isDesc = B > 1;
    for (i = 1; i < B; i++) { if (bp[i] <= bp[i - 1]) isAsc = false; if (bp[i] >= bp[i - 1]) isDesc = false; }
    var isUniform = true;
    if (B > 2) {
      var step = sorted[1] - sorted[0], tol = Math.max(Math.abs(step) * 1e-9, 1e-12);
      for (k = 1; k < B - 1; k++) if (Math.abs((sorted[k + 1] - sorted[k]) - step) > tol) { isUniform = false; break; }
    }
    return {
      breakpoints: bp, count: B, sorted: sorted, sortedToDisplay: s2d, displayToSorted: d2s, bounds: bounds,
      min: sorted[0], max: sorted[B - 1], isAscending: isAsc, isDescending: isDesc, isUniform: isUniform,
      labels: Array.isArray(opts.labels) && opts.labels.length === B ? opts.labels.slice() : bp.map(fmtNum), dropped: dropped
    };
  }
  /** Hot-path binning: display index of the nearest breakpoint, or -1 (dropped). O(log B). */
  function binPos(axis, v, drop) {
    var B = axis.count;
    if (B === 1) return 0;
    var s = axis.sorted;
    if (v < s[0]) return drop ? -1 : axis.sortedToDisplay[0];
    if (v > s[B - 1]) return drop ? -1 : axis.sortedToDisplay[B - 1];
    var bounds = axis.bounds, lo = 0, hi = B - 1;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (bounds[mid] < v) lo = mid + 1; else hi = mid; }
    // v <= bounds[lo] -> lower breakpoint on an exact tie. The midpoint of two decimals is often not
    // representable ((0.6 + 0.7) / 2 = 0.6499999999999999 < 0.65), so a value within a few ulps ABOVE
    // the bound below is that same tie and stays with the lower breakpoint too.
    if (lo > 0 && v - bounds[lo - 1] <= TIE_EPS * (v > 1 || v < -1 ? (v < 0 ? -v : v) : 1)) lo--;
    return axis.sortedToDisplay[lo];
  }
  var TIE_EPS = 4 * 2.220446049250313e-16;   // 4 * Number.EPSILON (ES5: no Number.EPSILON)
  function binIndex(axis, v, outOfRange) {
    if (!axis || !isFin(v)) return -1;
    return binPos(axis, v, outOfRange === 'drop');
  }

  // ================================================================================================
  // 4. compute -- the main entry
  // ================================================================================================
  function emptyStats(n) { return { total: n || 0, inRange: 0, filteredOut: 0, invalid: 0, droppedOutOfRange: 0, binned: 0 }; }
  function allocCells(cells) {
    var a = {
      count: new Int32Array(cells), sum: new Float64Array(cells),
      min: new Float64Array(cells), max: new Float64Array(cells), first: new Float64Array(cells), last: new Float64Array(cells),
      firstIdx: new Int32Array(cells), lastIdx: new Int32Array(cells), minIdx: new Int32Array(cells), maxIdx: new Int32Array(cells),
      // weighted: Σweight and Σ(weight × value) per cell; `weighted` flips true when a weight parameter
      // resolved, so statValue('weighted') knows whether these mean anything.
      wsum: new Float64Array(cells), wvsum: new Float64Array(cells), weighted: false
    };
    for (var k = 0; k < cells; k++) {
      a.min[k] = NaN; a.max[k] = NaN; a.first[k] = NaN; a.last[k] = NaN;
      a.firstIdx[k] = -1; a.lastIdx[k] = -1; a.minIdx[k] = -1; a.maxIdx[k] = -1;
    }
    return a;
  }
  function baseResult(def) {
    var r = {
      state: 'ok', definition: def, schemaVersion: HISTOGRAM_SCHEMA_VERSION, computedAt: new Date().toISOString(),
      type: isObj(def) ? def.type : null, transposed: false,
      columns: null, rows: null, shape: { rows: 0, cols: 0 },
      cellUnit: null, columnUnit: null, rowUnit: null, axisUnitConverted: null, axisUnitUnverified: null,
      labels: { cell: null, column: null, row: null, weight: null }, cellLevels: null,
      // weightScale: 100 when the weight channel reads as a percent (max > 1.5), else 1 -- effective
      // hits = Σweight / weightScale, so a 100%-weighted sample counts as one hit either way.
      weightScale: null, weightUnit: null,
      // cellIndices: absolute sample indices per cell (CSR via cellOffsets). sampleCellIndex: Int32Array(n)
      // indexed by ABSOLUTE sample index -> cell index, -1 when not binned (outside the range included).
      cells: null, cellOffsets: null, cellIndices: null, sampleCellIndex: null,
      sampleStats: emptyStats(0), rangeUsed: null,
      warnings: [], missing: [], errors: [], elapsedMs: 0
    };
    setTimeRef(r, null);
    return r;
  }
  /** ctx.time is kept on the result as a NON-enumerable reference (cellInfo needs it; JSON skips it). */
  function setTimeRef(result, time) {
    Object.defineProperty(result, 'time', { value: time || null, enumerable: false, writable: true, configurable: true });
  }
  function resolveParam(ctx, param, slot, missing) {
    var p = null, reason = 'not in this log';
    try { p = ctx.getParam(param, slot); } catch (e) { p = null; reason = 'resolver error: ' + (e && e.message ? e.message : e); }
    if (!p || !p.values || typeof p.values.length !== 'number') { missing.push({ slot: slot, param: param, reason: reason }); return null; }
    return p;
  }
  function resolveRange(ctx, n) {
    if (!(n > 0)) return null;
    var s = 0, e = n - 1, r = ctx.range;
    if (isObj(r)) {
      if (isFin(r.startIdx)) s = Math.max(0, Math.floor(r.startIdx));
      if (isFin(r.endIdx)) e = Math.min(n - 1, Math.floor(r.endIdx));
    }
    return s > e ? null : { startIdx: s, endIdx: e };
  }
  // ---- load ratio / percent detection (shared with resolveAxis; exported for the editor) -------
  var LOAD_RATIO_MAX = 3;   // same threshold as datalog-presets normalizeLoadScale
  var LOAD_NAME = /\bload\b/i;
  var LOAD_EXCLUDE = /\b(alt|alternator|trans|transmission|injector|fuel|battery|electrical|cpu|a\/?c)\b/i;
  function isLoadName(s) { return !!s && LOAD_NAME.test(String(s)) && !LOAD_EXCLUDE.test(String(s)); }
  function isLoadParam(axisDef, param) {
    var p = axisDef && axisDef.parameter;
    if (p && (p.role === 'actual_load' || p.role === 'desired_load')) return true;
    return isLoadName(p && p.channel) || isLoadName(p && p.label) || isLoadName(param && param.channel) || isLoadName(param && param.label);
  }
  function finiteMax(values) {
    var m = -Infinity, n = values && values.length ? values.length : 0;
    for (var i = 0; i < n; i++) { var v = values[i]; if (typeof v === 'number' && v === v && v !== Infinity && v > m) m = v; }
    return m;
  }
  /**
   * loadScaleFor(axisDef, param, bps) -> { factor:100|0.01, from, to, bpMax, dataMax } | null
   * Non-null when the axis is a load parameter and its breakpoints are on the other scale than the
   * data (ratio vs percent). Pure; unit-tested.
   */
  function loadScaleFor(axisDef, param, bps) {
    if (!isLoadParam(axisDef, param) || !bps || !bps.length || !param || !param.values) return null;
    var bpMax = finiteMax(bps), dataMax = finiteMax(param.values);
    if (!isFin(bpMax) || !isFin(dataMax) || bpMax <= 0 || dataMax <= 0) return null;
    if (bpMax <= LOAD_RATIO_MAX && dataMax > LOAD_RATIO_MAX) return { factor: 100, from: 'ratio', to: 'percent', bpMax: bpMax, dataMax: dataMax };
    if (bpMax > LOAD_RATIO_MAX && dataMax <= LOAD_RATIO_MAX) return { factor: 0.01, from: 'percent', to: 'ratio', bpMax: bpMax, dataMax: dataMax };
    return null;
  }
  /**
   * Resolve one axis against the live parameter: unit conversion of the BREAKPOINTS into the log's
   * unit (when def unit != live unit and ctx.convertValue exists), or a categorical level map.
   */
  function resolveAxis(axisDef, param, slot, ctx, result) {
    var warnings = result.warnings, i;
    var levels = param.levels && param.levels.length ? param.levels : null;
    var wantCats = !!(axisDef.categories && axisDef.categories.length);
    if (levels) {
      var cats = wantCats ? axisDef.categories : levels.slice();
      if (!wantCats && axisDef.breakpoints && axisDef.breakpoints.length)
        warnings.push(slot + ' axis parameter is categorical; breakpoints ignored (one cell per level)');
      var catMap = new Int32Array(levels.length);
      for (i = 0; i < levels.length; i++) catMap[i] = -1;
      var entries = [];
      for (i = 0; i < cats.length; i++) {
        var idx = levels.indexOf(cats[i]);
        if (idx < 0) warnings.push(slot + ' axis category "' + cats[i] + '" is not present in this log');
        else if (catMap[idx] >= 0) warnings.push(slot + ' axis category "' + cats[i] + '" is listed twice; its samples count in the first column only');
        else catMap[idx] = i;
        entries.push({ index: i, breakpoint: null, binValue: null, label: cats[i], level: idx });
      }
      return { axis: null, catMap: catMap, catLen: levels.length, unit: null, converted: null, unverified: false, entries: entries, count: cats.length };
    }
    if (wantCats && !(axisDef.breakpoints && axisDef.breakpoints.length)) {
      // A categorical axis definition applied to a log where this channel is plain numeric: report it
      // as a missing parameter for that SLOT (the UI's replacement flow), not as "no breakpoints".
      var shown = axisDef.categories.slice(0, 3).join(', ') + (axisDef.categories.length > 3 ? ', ...' : '');
      result.missing.push({ slot: slot, param: axisDef.parameter, reason: 'axis expects a categorical parameter (categories ' + shown + ') but the channel is numeric in this log' });
      return null;
    }
    var bps = axisDef.breakpoints, keep = null, converted = null, unverified = false;
    var defUnit = axisDef.unit || null, liveUnit = param.unit || null;
    if (defUnit && liveUnit && !sameUnit(defUnit, liveUnit)) {
      if (typeof ctx.convertValue === 'function') {
        var conv = [], kept = [], collapsed = [], seenConv = {}, okAll = true;
        for (i = 0; i < bps.length; i++) {
          var cv;
          try { cv = ctx.convertValue(bps[i], defUnit, liveUnit); } catch (e) { cv = null; }
          if (!isFin(cv)) { okAll = false; break; }
          if (seenConv[String(cv)]) { collapsed.push(bps[i]); continue; }      // lossy conversion: same live value
          seenConv[String(cv)] = true;
          conv.push(cv); kept.push(bps[i]);
        }
        if (okAll) {
          bps = conv; keep = kept; converted = { from: defUnit, to: liveUnit };
          if (collapsed.length) warnings.push(slot + ' axis: converting ' + defUnit + ' to ' + liveUnit + ' collapsed breakpoint' + (collapsed.length > 1 ? 's ' : ' ') +
            collapsed.map(fmtNum).join(', ') + ' onto a neighbour; those cells are merged');
        } else warnings.push(slot + ' axis: no conversion from ' + defUnit + ' to ' + liveUnit + '; binning breakpoints as-is');
      } else warnings.push(slot + ' axis unit "' + defUnit + '" differs from the log unit "' + liveUnit + '" and no converter was supplied; binning breakpoints as-is');
    } else if (defUnit && !liveUnit) {
      unverified = true;
      warnings.push(slot + ' axis unit "' + defUnit + '" cannot be verified: channel has no unit; binning as-is');
    }
    // Load arrives as a RATIO (1.2 = 120%) in some logs and as a PERCENT (120) in others, and the
    // viewer normalises the data to percent at load (datalog-presets normalizeLoadScale) -- but a
    // breakpoint list pasted from an HP Tuners Ford table is in ratio (0.1 ... 1.2), so every sample
    // used to land in the top cell. The two populations never overlap (a ratio never exceeds ~3, a
    // percent is never below it), so the mismatch is unambiguous and is corrected here, both ways
    // (Ken, 2026-09-08: "smart enough to adjust on its own").
    var loadScale = loadScaleFor(axisDef, param, bps);
    if (loadScale) {
      var scaledBps = [];
      for (i = 0; i < bps.length; i++) scaledBps.push(isFin(bps[i]) ? Number((bps[i] * loadScale.factor).toPrecision(6)) : bps[i]);
      bps = scaledBps; keep = scaledBps;
      converted = { from: loadScale.from, to: loadScale.to, load: true };
      warnings.push(slot + ' axis: load breakpoints are in ' + loadScale.from + ' (max ' + fmtNum(loadScale.bpMax) + ') but this log\'s load is in ' + loadScale.to +
        ' (max ' + fmtNum(loadScale.dataMax) + '); breakpoints scaled ' + (loadScale.factor === 100 ? '×100' : '÷100') + ' to match');
    }
    var axis = prepareAxis(bps);
    if (!axis) return null;
    // Labels always show the DEF breakpoint (def unit); `orig` maps each live bin value back to it.
    var orig = keep || axisDef.breakpoints, aligned = axis.dropped.length === 0 && orig.length === axis.count;
    var ents = [];
    for (i = 0; i < axis.count; i++) {
      var ov = aligned ? orig[i] : axis.breakpoints[i];
      ents.push({ index: i, breakpoint: ov, binValue: axis.breakpoints[i], label: fmtNum(ov) });
      axis.labels[i] = fmtNum(ov);
    }
    return { axis: axis, catMap: null, catLen: 0, unit: defUnit || liveUnit, converted: converted, unverified: unverified, entries: ents, count: axis.count };
  }
  /** A filter mask shorter than the range: samples beyond its end are treated as filtered OUT, and said so. */
  function checkMask(mask, end, warnings) {
    if (mask && typeof mask.length === 'number' && mask.length <= end)
      warnings.push('filter mask covers samples 0..' + (mask.length - 1) + ' only; samples ' + mask.length + '..' + end + ' are treated as filtered out');
  }
  /** Build the CSR sample-index lists from the ABSOLUTE per-sample cell array (counting pass done already). */
  function buildCSR(result, sampleCell, start, end) {
    var count = result.cells.count, cells = count.length, k, i;
    var offsets = new Int32Array(cells + 1);
    for (k = 0; k < cells; k++) offsets[k + 1] = offsets[k] + count[k];
    var indices = new Int32Array(offsets[cells]);
    var ptr = new Int32Array(cells);
    for (k = 0; k < cells; k++) ptr[k] = offsets[k];
    for (i = start; i <= end; i++) { k = sampleCell[i]; if (k >= 0) indices[ptr[k]++] = i; }
    result.cellOffsets = offsets;
    result.cellIndices = indices;
    result.sampleCellIndex = sampleCell;
  }
  function newSampleCell(n) { var a = new Int32Array(n); for (var j = 0; j < n; j++) a[j] = -1; return a; }

  function compute(def, ctx) {
    var t0 = now();
    var result = baseResult(def);
    try {
      computeInto(def, ctx, result);
    } catch (e) {
      result.state = 'error';
      result.errors.push(String(e && e.message ? e.message : e));
    }
    result.elapsedMs = now() - t0;
    return result;
  }
  function computeInto(def, ctx, result) {
    if (!isObj(def)) { result.state = 'invalid'; result.errors.push('definition is not an object'); return; }
    def = migrateDef(clone(def));            // compute on a migrated CLONE; the caller's object is never written
    result.definition = def;
    result.type = def.type;
    var v = validateDef(def);
    if (!v.ok) { result.state = 'invalid'; result.errors = v.errors; return; }
    if (!isObj(ctx) || typeof ctx.getParam !== 'function') { result.state = 'invalid'; result.errors.push('ctx.getParam is required'); return; }
    setTimeRef(result, ctx.time || null);
    if (def.type === 'distribution') computeDistributionInto(def, ctx, result);
    else computeTableInto(def, ctx, result);
  }

  function computeTableInto(def, ctx, result) {
    var missing = result.missing, warnings = result.warnings;
    var cellP = resolveParam(ctx, def.cellParameter, 'cell', missing);
    var wP = def.weightParameter ? resolveParam(ctx, def.weightParameter, 'weight', missing) : null;
    var colP = resolveParam(ctx, def.columnAxis.parameter, 'column', missing);
    var rowP = def.rowAxis ? resolveParam(ctx, def.rowAxis.parameter, 'row', missing) : null;
    if (missing.length) { result.state = 'missing_parameter'; return; }

    var colR = resolveAxis(def.columnAxis, colP, 'column', ctx, result);
    var rowR = def.rowAxis ? resolveAxis(def.rowAxis, rowP, 'row', ctx, result) : null;
    if (missing.length) { result.state = 'missing_parameter'; return; }      // categorical axis on a numeric channel
    if (!colR || colR.count === 0 || (def.rowAxis && (!rowR || rowR.count === 0))) {
      result.state = 'invalid'; result.errors.push('an axis has no usable breakpoints'); return;
    }
    var C = colR.count, R = rowR ? rowR.count : 1, cells = R * C;
    result.columns = colR.entries;
    result.rows = rowR ? rowR.entries : null;
    result.shape = { rows: R, cols: C };
    result.cellUnit = cellP.unit || null;
    result.columnUnit = colR.unit;
    result.rowUnit = rowR ? rowR.unit : null;
    result.axisUnitConverted = (colR.converted || (rowR && rowR.converted)) ? { column: colR.converted, row: rowR ? rowR.converted : null } : null;
    result.axisUnitUnverified = (colR.unverified || (rowR && rowR.unverified)) ? { column: colR.unverified, row: rowR ? rowR.unverified : false } : null;
    result.labels = {
      cell: cellP.label || def.cellParameter.label || null,
      column: colP.label || def.columnAxis.parameter.label || null,
      row: rowP ? (rowP.label || def.rowAxis.parameter.label || null) : null
    };
    result.cellLevels = cellP.levels && cellP.levels.length ? cellP.levels.slice() : null;
    result.labels.weight = wP ? (wP.label || def.weightParameter.label || null) : null;
    result.weightUnit = wP ? (wP.unit || null) : null;
    if (def.cellParameter.unit && cellP.unit && !sameUnit(def.cellParameter.unit, cellP.unit))
      warnings.push('cell parameter unit "' + def.cellParameter.unit + '" differs from the log unit "' + cellP.unit + '"; values are reported in ' + cellP.unit);

    var n = isFin(ctx.n) ? Math.max(0, Math.floor(ctx.n)) : cellP.values.length;
    var stats = emptyStats(n);
    result.sampleStats = stats;
    var acc = allocCells(cells);
    result.cells = acc;
    var rng = resolveRange(ctx, n);
    result.rangeUsed = rng;
    if (!rng) { result.state = 'empty'; return; }

    var start = rng.startIdx, end = rng.endIdx, span = end - start + 1;
    stats.inRange = span;
    var collect = ctx.collectIndices !== false;
    var sampleCell = collect ? newSampleCell(n) : null;          // absolute index -> cell

    // ---- hot loop: no allocation, no closures ----------------------------------------------------
    var cellVals = cellP.values, colVals = colP.values, rowVals = rowP ? rowP.values : null;
    var wVals = wP ? wP.values : null, wsum = acc.wsum, wvsum = acc.wvsum, wv = 0, wMax = 0;
    var colAxis = colR.axis, rowAxis = rowR ? rowR.axis : null;
    var colCat = colR.catMap, rowCat = rowR ? rowR.catMap : null, colCatLen = colR.catLen, rowCatLen = rowR ? rowR.catLen : 0;
    var is2D = rowR !== null, drop = def.outOfRange === 'drop';
    var mask = ctx.filterMask || null;
    if (mask !== null) checkMask(mask, end, warnings);
    var count = acc.count, sum = acc.sum, mn = acc.min, mx = acc.max, first = acc.first, last = acc.last;
    var firstIdx = acc.firstIdx, lastIdx = acc.lastIdx, minIdx = acc.minIdx, maxIdx = acc.maxIdx;
    var filteredOut = 0, invalid = 0, dropped = 0, binned = 0;
    var i, cv, xv, yv, c, r, k;
    for (i = start; i <= end; i++) {
      if (mask !== null && !mask[i]) { filteredOut++; continue; }
      cv = cellVals[i];
      if (typeof cv !== 'number' || cv !== cv || cv === Infinity || cv === -Infinity) { invalid++; continue; }
      xv = colVals[i];
      if (typeof xv !== 'number' || xv !== xv || xv === Infinity || xv === -Infinity) { invalid++; continue; }
      if (colCat !== null) c = (xv >= 0 && xv < colCatLen) ? colCat[xv | 0] : -1;
      else c = binPos(colAxis, xv, drop);
      if (c < 0) { dropped++; continue; }
      if (is2D) {
        yv = rowVals[i];
        if (typeof yv !== 'number' || yv !== yv || yv === Infinity || yv === -Infinity) { invalid++; continue; }
        if (rowCat !== null) r = (yv >= 0 && yv < rowCatLen) ? rowCat[yv | 0] : -1;
        else r = binPos(rowAxis, yv, drop);
        if (r < 0) { dropped++; continue; }
        k = r * C + c;
      } else k = c;
      if (wVals !== null) {
        wv = wVals[i];
        if (typeof wv !== 'number' || wv !== wv || wv === Infinity || wv === -Infinity) { invalid++; continue; }
        if (wv < 0) wv = 0;
        if (wv > wMax) wMax = wv;
      }
      if (count[k] === 0) {
        first[k] = cv; firstIdx[k] = i; mn[k] = cv; minIdx[k] = i; mx[k] = cv; maxIdx[k] = i;
      } else {
        if (cv < mn[k]) { mn[k] = cv; minIdx[k] = i; }
        if (cv > mx[k]) { mx[k] = cv; maxIdx[k] = i; }
      }
      last[k] = cv; lastIdx[k] = i;
      sum[k] += cv; count[k]++;
      if (wVals !== null) { wsum[k] += wv; wvsum[k] += wv * cv; }
      binned++;
      if (sampleCell !== null) sampleCell[i] = k;
    }
    stats.filteredOut = filteredOut; stats.invalid = invalid; stats.droppedOutOfRange = dropped; stats.binned = binned;
    if (wVals !== null) {
      acc.weighted = true;
      result.weightScale = wMax > 1.5 ? 100 : 1;
      if (binned > 0 && wMax === 0) warnings.push('weight "' + (result.labels.weight || 'weight') + '" is zero on every binned sample; Weighted Avg has nothing to show');
    }
    if (sampleCell !== null) buildCSR(result, sampleCell, start, end);
    result.state = binned > 0 ? 'ok' : 'empty';
  }

  // ------------------------------------------------------------------------------------------------
  // 4b. Distribution type: one parameter, uniform bins from EDGES (not centers), [lo,hi) per bin.
  //     bins:N -> N equal bins from min to max, the last bin inclusive of max. binWidth / auto ->
  //     edges aligned to multiples of the width, last edge strictly above the data max so an edge
  //     value always belongs to the upper bin. Values within 1e-9 widths below an edge count as the
  //     upper bin (float noise). Auto = Freedman-Diaconis (Sturges when IQR is 0) rounded to a
  //     1/2/5 "nice" width; constant data -> one bin.
  // ------------------------------------------------------------------------------------------------
  function quantile(sorted, q) {
    var m = sorted.length, pos = (m - 1) * q, b = Math.floor(pos), f = pos - b;
    return b + 1 < m ? sorted[b] + f * (sorted[b + 1] - sorted[b]) : sorted[b];
  }
  function niceWidth(raw) {
    if (!(raw > 0)) return 1;
    var exp = Math.floor(Math.log(raw) / Math.LN10), base = Math.pow(10, exp), f = raw / base;
    var nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
    return nf * base;
  }
  /** Freedman-Diaconis width (Sturges when IQR is 0), before "nice" rounding. */
  var AUTO_IQR_SAMPLE = 50000;
  function autoWidth(buf, m, lo, hi) {
    if (m < 2) return (hi - lo) || 1;
    // IQR estimated from a fixed-size stride sample (sorting every in-range value was O(m log m) per
    // compute); the Freedman-Diaconis divisor still uses the FULL count m.
    var stride = m > AUTO_IQR_SAMPLE ? Math.ceil(m / AUTO_IQR_SAMPLE) : 1, ms = Math.floor((m - 1) / stride) + 1;
    var sorted = new Float64Array(ms);
    for (var j = 0; j < ms; j++) sorted[j] = buf[j * stride];
    sorted.sort();
    var iqr = quantile(sorted, 0.75) - quantile(sorted, 0.25), w;
    if (iqr > 0) w = 2 * iqr / Math.pow(m, 1 / 3);
    else { var k = Math.ceil(Math.log(m) / Math.LN2) + 1; w = (hi - lo) / k; }
    if (!(w > 0)) w = (hi - lo) / 10 || 1;
    if ((hi - lo) / w > MAX_AUTO_BINS) w = (hi - lo) / MAX_AUTO_BINS;
    return w;
  }
  /** Bins of width w from e0 so that the LAST edge is strictly above hi (an edge belongs to the upper bin). */
  function ceilBins(hi, e0, w) {
    var span = (hi - e0) / w;
    // Far beyond the cap (or NaN): report the implied count and let makeEdges take the cap path.
    // The fix-up loop below is BOUNDED: for a huge nb, e0 + nb * w stops changing in doubles.
    if (!(span < MAX_DISTRIBUTION_BINS * 2)) return isFin(span) ? Math.ceil(span) + 1 : Infinity;
    var tol = w * 1e-9, nb = Math.floor(span + 1e-9) + 1;
    if (nb < 1) nb = 1;
    for (var guard = 0; guard < 4 && e0 + nb * w <= hi + tol; guard++) nb++;
    return nb;
  }
  /** First edge at a multiple of w at or just below lo. lo / w is taken with a tolerance so that
   *  0.3 / 0.1 (= 2.9999999999999996) aligns to 0.3 instead of opening an empty leading bin [0.2, 0.3). */
  function alignEdge(lo, w) { return Math.floor(lo / w + 1e-9) * w; }
  function makeEdges(d, lo, hi, buf, m, warnings) {
    if (hi < lo) { var t = lo; lo = hi; hi = t; }
    var constant = hi === lo;
    if (constant) { lo -= 0.5; hi += 0.5; }
    var w, e0, nb, exact = false;
    if (isFin(d.bins) && d.bins >= 1) { nb = Math.floor(d.bins); w = (hi - lo) / nb; e0 = lo; exact = true; }   // last bin inclusive of hi
    else if (isFin(d.binWidth) && d.binWidth > 0) { w = d.binWidth; e0 = alignEdge(lo, w); nb = ceilBins(hi, e0, w); }
    else if (constant) { w = 1; e0 = lo; nb = 1; }
    else { w = niceWidth(autoWidth(buf, m, lo, hi)); e0 = alignEdge(lo, w); nb = ceilBins(hi, e0, w); }
    if (nb > MAX_DISTRIBUTION_BINS) {
      warnings.push('distribution: bin width ' + fmtNum(w) + ' would create ' + nb + ' bins; capped at ' + MAX_DISTRIBUTION_BINS);
      nb = MAX_DISTRIBUTION_BINS; w = (hi - e0) / nb; exact = true;
    }
    var edges = new Float64Array(nb + 1);
    for (var k = 0; k <= nb; k++) edges[k] = e0 + k * w;
    if (exact) edges[nb] = hi;
    return { e0: e0, w: w, nb: nb, edges: edges };
  }
  function computeDistributionInto(def, ctx, result) {
    var missing = result.missing, warnings = result.warnings;
    var p = resolveParam(ctx, def.cellParameter, 'cell', missing);
    if (missing.length) { result.state = 'missing_parameter'; return; }
    var n = isFin(ctx.n) ? Math.max(0, Math.floor(ctx.n)) : p.values.length;
    var stats = emptyStats(n);
    result.sampleStats = stats;
    result.cellUnit = p.unit || null;
    result.columnUnit = result.cellUnit;
    result.labels = { cell: p.label || def.cellParameter.label || null, column: p.label || def.cellParameter.label || null, row: null };
    result.cellLevels = p.levels && p.levels.length ? p.levels.slice() : null;
    result.columns = []; result.rows = null; result.shape = { rows: 1, cols: 0 }; result.cells = allocCells(0);
    var rng = resolveRange(ctx, n);
    result.rangeUsed = rng;
    if (!rng) { result.state = 'empty'; return; }
    var start = rng.startIdx, end = rng.endIdx, span = end - start + 1;
    stats.inRange = span;
    var mask = ctx.filterMask || null, vals = p.values;
    if (mask !== null) checkMask(mask, end, warnings);
    var buf = new Float64Array(span), idx = new Int32Array(span), m = 0, filteredOut = 0, invalid = 0;
    var lo = Infinity, hi = -Infinity, i, v, j, k;
    for (i = start; i <= end; i++) {
      if (mask !== null && !mask[i]) { filteredOut++; continue; }
      v = vals[i];
      if (typeof v !== 'number' || v !== v || v === Infinity || v === -Infinity) { invalid++; continue; }
      buf[m] = v; idx[m] = i; m++;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    stats.filteredOut = filteredOut; stats.invalid = invalid;
    var d = def.distribution || defaultDistribution();
    result.valueExtent = m > 0 ? { min: lo, max: hi } : { min: NaN, max: NaN };
    // An explicit bound on the WRONG side of the data would be swapped into a nonsense table: say so.
    if (m > 0 && isFin(d.min) && !isFin(d.max) && d.min > hi) {
      warnings.push('distribution.min ' + fmtNum(d.min) + ' is above the data maximum ' + fmtNum(hi) + '; nothing to bin'); result.state = 'empty'; return;
    }
    if (m > 0 && isFin(d.max) && !isFin(d.min) && d.max < lo) {
      warnings.push('distribution.max ' + fmtNum(d.max) + ' is below the data minimum ' + fmtNum(lo) + '; nothing to bin'); result.state = 'empty'; return;
    }
    if (isFin(d.min)) lo = d.min;
    if (isFin(d.max)) hi = d.max;
    if (!(isFin(lo) && isFin(hi))) { result.state = 'empty'; return; }
    var e = makeEdges(d, lo, hi, buf, m, warnings);
    var nb = e.nb, w = e.w, e0 = e.e0, edges = e.edges, eLast = edges[nb], eTol = w * 1e-9;
    for (k = 0; k < nb; k++) {
      result.columns.push({ index: k, lo: edges[k], hi: edges[k + 1], breakpoint: (edges[k] + edges[k + 1]) / 2,
        label: fmtNum(edges[k]) + '–' + fmtNum(edges[k + 1]) });
    }
    result.shape = { rows: 1, cols: nb };
    result.binWidth = w;
    result.edges = edges;
    var acc = allocCells(nb);
    result.cells = acc;
    var collect = ctx.collectIndices !== false;
    var sampleCell = collect ? newSampleCell(n) : null;          // absolute index -> bin
    var count = acc.count, sum = acc.sum, mn = acc.min, mx = acc.max, first = acc.first, last = acc.last;
    var firstIdx = acc.firstIdx, lastIdx = acc.lastIdx, minIdx = acc.minIdx, maxIdx = acc.maxIdx;
    var drop = def.outOfRange === 'drop', dropped = 0, binned = 0;
    for (j = 0; j < m; j++) {
      v = buf[j]; i = idx[j];
      if (v < e0 - eTol) { if (drop) { dropped++; continue; } k = 0; }              // eTol: e0 may sit a few ulps above lo
      else if (v > eLast + eTol) { if (drop) { dropped++; continue; } k = nb - 1; }
      else { k = Math.floor((v - e0) / w + 1e-9); if (k >= nb) k = nb - 1; if (k < 0) k = 0; }
      if (count[k] === 0) {
        first[k] = v; firstIdx[k] = i; mn[k] = v; minIdx[k] = i; mx[k] = v; maxIdx[k] = i;
      } else {
        if (v < mn[k]) { mn[k] = v; minIdx[k] = i; }
        if (v > mx[k]) { mx[k] = v; maxIdx[k] = i; }
      }
      last[k] = v; lastIdx[k] = i;
      sum[k] += v; count[k]++;
      binned++;
      if (sampleCell !== null) sampleCell[i] = k;
    }
    stats.droppedOutOfRange = dropped; stats.binned = binned;
    if (sampleCell !== null) buildCSR(result, sampleCell, start, end);
    result.state = binned > 0 ? 'ok' : 'empty';
  }
  function distributionValues(result, mode) {
    if (!result || !result.cells) return new Float64Array(0);
    var c = result.cells.count, out = new Float64Array(c.length), total = result.sampleStats ? result.sampleStats.binned : 0;
    var pct = (mode || (result.definition && result.definition.distribution && result.definition.distribution.mode)) === 'percent';
    for (var k = 0; k < c.length; k++) out[k] = pct ? (total > 0 ? c[k] / total * 100 : 0) : c[k];
    return out;
  }

  // ================================================================================================
  // 5. Result helpers (the UI's render inputs; also what the rules/AI layer queries)
  // ================================================================================================
  function hasCells(result) { return !!(result && result.cells && result.cells.count && result.shape); }
  function cellIndex(result, r, c) { return r * result.shape.cols + c; }
  function statValue(cells, k, stat) {
    var n = cells.count[k];
    switch (stat) {
      case 'count': return n;
      case 'average': return n > 0 ? cells.sum[k] / n : NaN;
      case 'weighted': return cells.weighted ? (cells.wsum[k] > 0 ? cells.wvsum[k] / cells.wsum[k] : NaN) : (n > 0 ? cells.sum[k] / n : NaN);
      case 'minimum': return n > 0 ? cells.min[k] : NaN;
      case 'maximum': return n > 0 ? cells.max[k] : NaN;
      case 'first': return n > 0 ? cells.first[k] : NaN;
      case 'last': return n > 0 ? cells.last[k] : NaN;
      default: return NaN;
    }
  }
  function resultStat(result, stat) { return normalizeStat(stat) || normalizeStat(result.definition && result.definition.statistic) || 'average'; }
  function cellStat(result, r, c, stat) {
    if (!hasCells(result)) return NaN;
    var k = cellIndex(result, r, c);
    if (!(r >= 0 && c >= 0 && r < result.shape.rows && c < result.shape.cols)) return NaN;
    return statValue(result.cells, k, resultStat(result, stat));
  }
  function timeAt(result, idx) { var t = result.time; return (t && idx >= 0 && idx < t.length && isFin(t[idx])) ? t[idx] : NaN; }
  function cellInfo(result, r, c) {
    if (!hasCells(result) || !(r >= 0 && c >= 0 && r < result.shape.rows && c < result.shape.cols)) return null;
    var k = cellIndex(result, r, c), a = result.cells, n = a.count[k];
    return {
      row: r, col: c, index: k, count: n,
      average: n > 0 ? a.sum[k] / n : NaN, sum: a.sum[k],
      weighted: !!a.weighted,
      weightSum: a.weighted ? a.wsum[k] : NaN,
      weightedAverage: a.weighted ? (a.wsum[k] > 0 ? a.wvsum[k] / a.wsum[k] : NaN) : (n > 0 ? a.sum[k] / n : NaN),
      effectiveHits: a.weighted ? a.wsum[k] / (result.weightScale || 1) : n,
      min: n > 0 ? a.min[k] : NaN, max: n > 0 ? a.max[k] : NaN,
      first: n > 0 ? a.first[k] : NaN, last: n > 0 ? a.last[k] : NaN,
      firstIdx: a.firstIdx[k], lastIdx: a.lastIdx[k], minIdx: a.minIdx[k], maxIdx: a.maxIdx[k],
      firstTime: timeAt(result, a.firstIdx[k]), lastTime: timeAt(result, a.lastIdx[k]),
      minTime: timeAt(result, a.minIdx[k]), maxTime: timeAt(result, a.maxIdx[k]),
      sampleIndices: result.cellOffsets ? result.cellIndices.subarray(result.cellOffsets[k], result.cellOffsets[k + 1]) : null
    };
  }
  function statTable(result, stat) {
    if (!hasCells(result)) return new Float64Array(0);
    var s = resultStat(result, stat), a = result.cells, cells = a.count.length, out = new Float64Array(cells);
    for (var k = 0; k < cells; k++) out[k] = statValue(a, k, s);
    return out;
  }
  function minHitsOf(result, minHits) { return isFin(minHits) ? minHits : (result.definition && isFin(result.definition.minimumHits) ? result.definition.minimumHits : 0); }
  /** The hits a cell has for min-hits purposes: the sample count, or for the weighted statistic on a
   *  weighted result, Σweight / weightScale (a 100%-weighted sample = one hit). */
  function effectiveHits(result, k, stat) {
    var a = result.cells;
    if (normalizeStat(stat) === 'weighted' && a.weighted) return a.wsum[k] / (result.weightScale || 1);
    return a.count[k];
  }
  /** 1 where hits < minHits (empty cells included), else 0. `stat` picks weighted hits for 'weighted'. */
  function lowCountMask(result, minHits, stat) {
    if (!hasCells(result)) return new Uint8Array(0);
    var mh = minHitsOf(result, minHits), c = result.cells.count, out = new Uint8Array(c.length), s = resultStat(result, stat);
    for (var k = 0; k < c.length; k++) out[k] = effectiveHits(result, k, s) < mh ? 1 : 0;
    return out;
  }
  /** {min,max,cells} of a statistic over cells with hits >= max(1, minHits) -- the auto colour scale input. */
  function valueRange(result, stat, minHits) {
    var out = { min: NaN, max: NaN, cells: 0 };
    if (!hasCells(result)) return out;
    var s = resultStat(result, stat), a = result.cells, th = Math.max(1, minHitsOf(result, minHits));
    for (var k = 0; k < a.count.length; k++) {
      if (effectiveHits(result, k, s) < th) continue;
      var v = statValue(a, k, s);
      if (!isFin(v)) continue;
      if (out.cells === 0 || v < out.min) out.min = v;
      if (out.cells === 0 || v > out.max) out.max = v;
      out.cells++;
    }
    return out;
  }
  /** Swap rows/columns of a 2D result without recomputing (Invert Axes). 1D results return as-is. */
  function transposeResult(result) {
    if (!hasCells(result) || !result.rows) return result;
    var R = result.shape.rows, C = result.shape.cols, cells = R * C, a = result.cells, k, r, c;
    var perm = new Int32Array(cells);                 // old k -> new k'
    for (k = 0; k < cells; k++) { r = (k / C) | 0; c = k - r * C; perm[k] = c * R + r; }
    var out = baseResult(invertDef(result.definition));
    setTimeRef(out, result.time);
    out.state = result.state; out.computedAt = result.computedAt; out.type = result.type; out.transposed = !result.transposed;
    out.columns = result.rows.map(function (e, i) { var x = clone(e); x.index = i; return x; });
    out.rows = result.columns.map(function (e, i) { var x = clone(e); x.index = i; return x; });
    out.shape = { rows: C, cols: R };
    out.cellUnit = result.cellUnit; out.columnUnit = result.rowUnit; out.rowUnit = result.columnUnit;
    out.axisUnitConverted = result.axisUnitConverted ? { column: result.axisUnitConverted.row, row: result.axisUnitConverted.column } : null;
    out.axisUnitUnverified = result.axisUnitUnverified ? { column: result.axisUnitUnverified.row, row: result.axisUnitUnverified.column } : null;
    out.labels = { cell: result.labels.cell, column: result.labels.row, row: result.labels.column, weight: result.labels.weight };
    out.cellLevels = result.cellLevels;
    out.weightScale = result.weightScale; out.weightUnit = result.weightUnit;
    out.sampleStats = clone(result.sampleStats); out.rangeUsed = clone(result.rangeUsed);
    out.warnings = result.warnings.slice(); out.missing = result.missing.slice(); out.errors = result.errors.slice();
    out.elapsedMs = result.elapsedMs;
    var b = allocCells(cells);
    for (k = 0; k < cells; k++) {
      var j = perm[k];
      b.count[j] = a.count[k]; b.sum[j] = a.sum[k]; b.min[j] = a.min[k]; b.max[j] = a.max[k]; b.first[j] = a.first[k]; b.last[j] = a.last[k];
      b.firstIdx[j] = a.firstIdx[k]; b.lastIdx[j] = a.lastIdx[k]; b.minIdx[j] = a.minIdx[k]; b.maxIdx[j] = a.maxIdx[k];
      b.wsum[j] = a.wsum[k]; b.wvsum[j] = a.wvsum[k];
    }
    b.weighted = !!a.weighted;
    out.cells = b;
    if (result.cellOffsets) {
      var offsets = new Int32Array(cells + 1);
      for (k = 0; k < cells; k++) offsets[k + 1] = offsets[k] + b.count[k];
      var indices = new Int32Array(offsets[cells]);
      for (k = 0; k < cells; k++) {
        var src = result.cellOffsets[k], dst = offsets[perm[k]], len = result.cellOffsets[k + 1] - src;
        for (var q = 0; q < len; q++) indices[dst + q] = result.cellIndices[src + q];
      }
      out.cellOffsets = offsets; out.cellIndices = indices;
      if (result.sampleCellIndex) {
        var sc = new Int32Array(result.sampleCellIndex.length);
        for (k = 0; k < sc.length; k++) { var o = result.sampleCellIndex[k]; sc[k] = o >= 0 ? perm[o] : -1; }
        out.sampleCellIndex = sc;
      }
    }
    return out;
  }
  /**
   * ownerTable(pages) -> which page "owns" each cell (Ken, 2026-09-08: "a who-owns-this-cell map" --
   * which mapped point dominates each RPM × MAP cell, so you know which of the 27 tables matters).
   *   pages = [{ page, label, result }]: the SAME def computed per page (same shape). A page's mass in
   *   a cell is its Σweight when the def has a weight parameter, else its sample count. Returns
   *   { shape, pages:[{page,label}], owner: Int32Array (index into pages, -1 = nothing landed),
   *     share: Float64Array (owner mass / total mass, NaN when empty), mass: Float64Array (total),
   *     hits: Float64Array (total effective hits, for min-hits dimming), skipped:[page] (shape
   *     mismatch), breakdown(k) -> [{index, page, label, mass, share}] largest first }.
   */
  function ownerTable(pages) {
    var out = { shape: null, pages: [], owner: null, share: null, mass: null, hits: null, skipped: [], breakdown: function () { return []; } };
    var list = (Array.isArray(pages) ? pages : []).filter(function (p) { return p && hasCells(p.result); });
    if (!list.length) return out;
    var shape = list[0].result.shape, cells = shape.rows * shape.cols, used = [];
    list.forEach(function (p) {
      if (p.result.shape.rows !== shape.rows || p.result.shape.cols !== shape.cols) { out.skipped.push(p.page); return; }
      used.push(p);
    });
    var massOf = function (res, k) { return res.cells.weighted ? res.cells.wsum[k] : res.cells.count[k]; };
    var hitsOf = function (res, k) { return res.cells.weighted ? res.cells.wsum[k] / (res.weightScale || 1) : res.cells.count[k]; };
    var owner = new Int32Array(cells), share = new Float64Array(cells), mass = new Float64Array(cells), hits = new Float64Array(cells);
    for (var k = 0; k < cells; k++) {
      var best = -1, bestM = 0, tot = 0, th = 0;
      for (var i = 0; i < used.length; i++) {
        var m = massOf(used[i].result, k);
        tot += m; th += hitsOf(used[i].result, k);
        if (m > bestM) { bestM = m; best = i; }
      }
      owner[k] = best; mass[k] = tot; hits[k] = th; share[k] = tot > 0 ? bestM / tot : NaN;
    }
    out.shape = { rows: shape.rows, cols: shape.cols };
    out.pages = used.map(function (p) { return { page: p.page, label: p.label }; });
    out.owner = owner; out.share = share; out.mass = mass; out.hits = hits;
    out.breakdown = function (k) {
      var rows = [], tot = mass[k];
      for (var i = 0; i < used.length; i++) {
        var m = massOf(used[i].result, k);
        if (m > 0) rows.push({ index: i, page: used[i].page, label: used[i].label, mass: m, share: tot > 0 ? m / tot : NaN });
      }
      rows.sort(function (a, b) { return b.mass - a.mass; });
      return rows;
    };
    return out;
  }
  /**
   * toRows(result, stat, opts) -> array of arrays for the clipboard / CSV.
   *   opts.includeAxis: header row (corner cell 'RowLabel\ColLabel' + column labels) and a row-label
   *   column (a 1D table's single row is labelled with the statistic). opts.precision: toFixed digits.
   *   opts.nanAs: what an empty cell becomes (default ''). opts.minHits: cells below become nanAs.
   */
  function toRows(result, stat, opts) {
    opts = opts || {};
    if (!hasCells(result)) return [];
    var s = resultStat(result, stat), table = statTable(result, s), count = result.cells.count;
    var R = result.shape.rows, C = result.shape.cols, rows = [], r, c, line;
    var nanAs = opts.nanAs === undefined ? '' : opts.nanAs, prec = isFin(opts.precision) ? opts.precision : null;
    var mh = isFin(opts.minHits) ? opts.minHits : null;
    var labels = result.labels || {};
    if (opts.includeAxis) {
      var corner = (result.rows ? (labels.row || 'Row') : (labels.cell || 'Value')) + '\\' + (labels.column || 'Column');
      line = [corner];
      for (c = 0; c < C; c++) line.push(result.columns[c].label);
      rows.push(line);
    }
    for (r = 0; r < R; r++) {
      line = [];
      if (opts.includeAxis) line.push(result.rows ? result.rows[r].label : statLabel(s));
      for (c = 0; c < C; c++) {
        var k = r * C + c, v = table[k];
        if ((mh !== null && s !== 'count' && count[k] < mh) || v !== v) line.push(nanAs);
        else line.push(prec !== null ? Number(v.toFixed(prec)) : v);
      }
      rows.push(line);
    }
    return rows;
  }
  /**
   * diff(resultA, resultB, stat, opts) -> { state, table: Float64Array (B minus A), shape, ... }
   *   NaN where either side has no data (count < opts.minHits, default 1) for value statistics; for
   *   'count' the difference of counts is always reported. Shapes must match (else 'shape_mismatch').
   */
  function diff(resultA, resultB, stat, opts) {
    opts = opts || {};
    if (!hasCells(resultA) || !hasCells(resultB)) return { state: 'no_data', table: null, shape: null };
    if (resultA.shape.rows !== resultB.shape.rows || resultA.shape.cols !== resultB.shape.cols)
      return { state: 'shape_mismatch', table: null, shape: null, shapeA: clone(resultA.shape), shapeB: clone(resultB.shape) };
    var s = resultStat(resultA, stat), ta = statTable(resultA, s), tb = statTable(resultB, s);
    var ca = resultA.cells.count, cb = resultB.cells.count, cells = ta.length, table = new Float64Array(cells);
    var mh = isFin(opts.minHits) ? Math.max(1, opts.minHits) : 1;
    for (var k = 0; k < cells; k++) {
      if (s === 'count') table[k] = tb[k] - ta[k];
      else table[k] = (ca[k] < mh || cb[k] < mh) ? NaN : tb[k] - ta[k];
    }
    var labelMismatch = false;
    for (k = 0; k < resultA.columns.length; k++) if (resultA.columns[k].label !== resultB.columns[k].label) labelMismatch = true;
    if (resultA.rows && resultB.rows) for (k = 0; k < resultA.rows.length; k++) if (resultA.rows[k].label !== resultB.rows[k].label) labelMismatch = true;
    return { state: 'ok', stat: s, direction: 'b-a', shape: clone(resultA.shape), table: table, a: ta, b: tb,
      countA: ca, countB: cb, columns: resultA.columns, rows: resultA.rows, labelMismatch: labelMismatch };
  }

  // ================================================================================================
  // 6. Public API namespace
  // ================================================================================================
  var Histogram = {
    SCHEMA_VERSION: HISTOGRAM_SCHEMA_VERSION, PACKAGE_KIND: PACKAGE_KIND, STATISTICS: STATISTICS, STATISTIC_IDS: STAT_IDS,
    OUT_OF_RANGE: OUT_OF_RANGE, MAX_DISTRIBUTION_BINS: MAX_DISTRIBUTION_BINS,
    // definitions
    makeDef: makeDef, makeParam: makeParam, makeAxis: makeAxis, validateDef: validateDef, migrateDef: migrateDef,
    cloneDef: cloneDef, invertDef: invertDef, exportDef: exportDef, importDef: importDef, exportDefs: exportDefs, importDefs: importDefs,
    // math-channel references + packaging
    mathChannelByRef: mathChannelByRef, remapMathChannelIds: remapMathChannelIds, normChannelName: normChannelName,
    loadScaleFor: loadScaleFor, isLoadName: isLoadName,
    // pages (one def cycled through a numbered channel family)
    PAGE_VAR: PAGE_VAR, hasPageVar: hasPageVar, substitutePage: substitutePage, normalizePages: normalizePages, usesPages: usesPages,
    samePage: samePage, pageRegExp: pageRegExp, pageValues: pageValues, currentPage: currentPage, pageLabel: pageLabel,
    defaultPageLabel: defaultPageLabel, applyPage: applyPage, substituteParam: substituteParam, pageVarUses: pageVarUses,
    derivePagePatterns: derivePagePatterns, derivePagePattern: derivePagePattern, applyPagePattern: applyPagePattern,
    pageConcretes: pageConcretes, channelStringsOf: channelStringsOf, collapsePaged: collapsePaged,
    mathChannelDeps: mathChannelDeps, mergeMathChannels: mergeMathChannels, packMathChannel: packMathChannel,
    // breakpoints
    parseBreakpoints: parseBreakpoints, sortBreakpoints: sortBreakpoints, reverseBreakpoints: reverseBreakpoints,
    formatBreakpoints: formatBreakpoints, formatNumber: fmtNum,
    // binning
    prepareAxis: prepareAxis, binIndex: binIndex,
    // compute + result helpers
    compute: compute, cellIndex: cellIndex, cellStat: cellStat, cellInfo: cellInfo, statTable: statTable,
    lowCountMask: lowCountMask, valueRange: valueRange, transposeResult: transposeResult, toRows: toRows, diff: diff,
    effectiveHits: effectiveHits, ownerTable: ownerTable,
    distributionValues: distributionValues, normalizeStat: normalizeStat, statLabel: statLabel
  };
  global.Histogram = Histogram;
  if (typeof module !== 'undefined' && module.exports) module.exports = Histogram;
})(typeof window !== 'undefined' ? window : globalThis);
