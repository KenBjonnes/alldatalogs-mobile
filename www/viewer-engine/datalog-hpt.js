/* =================================================================================================
 * datalog-hpt.js -- HP Tuners VCM Scanner LAYOUT import for BigData histograms.
 *
 * WHAT THIS IS
 *   A pure, UI-agnostic module that reads a VCM Scanner layout file (`*.Layout.xml`) and turns each
 *   <Table> block (a Scanner histogram: cell parameter x column axis x optional row axis + a filter)
 *   into a BigData histogram definition (Histogram.makeDef), so a tuner's existing Scanner tables
 *   load straight into the Histograms view. Gauges / strip charts in the same file are not imported,
 *   but their <Label>/<ParameterID>/<Unit> triples are harvested as parameter-name hints.
 *
 * THE HPT FORMAT (reverse-engineered from real layouts; the schema is flat, one level of children)
 *   <DocumentContents><Content ...>
 *     <Table>
 *       <Label>MP26 FT</Label>
 *       <FilterFunction>[19043.156]&gt;5 AND [50091.156] &gt; 3</FilterFunction>
 *       <ParameterID>60040</ParameterID><Unit>156</Unit>              <- the CELL parameter
 *       <HighValueColor>-1</HighValueColor><LowValueColor>-1</LowValueColor>   (.NET ARGB ints, -1 = auto)
 *       <ColumnParameterID>50070</ColumnParameterID><ColumnUnit>56</ColumnUnit>
 *       <ColumnAxis>500,600,...,7250</ColumnAxis>
 *       <RowParameterID>50091</RowParameterID><RowUnit>156</RowUnit>  <- absent on a 1-D table
 *       <RowAxis>0.5,10,...,100</RowAxis>
 *     </Table>
 *     <Gauge><Label>RPM</Label><ParameterID>50070</ParameterID><Unit>56</Unit>...</Gauge>
 *     <Chart><Series><Label>Speed</Label><ParameterID>50020</ParameterID><Unit>114</Unit>...</Series></Chart>
 *   Every parameter is a NUMERIC id; filter references are `[ParameterID.UnitID]`. Filter operators
 *   seen/handled: > >= < <= = == <> != AND OR NOT (any case), parentheses, numbers.
 *
 * RESOLUTION (makeResolver) -- an HPT id has to become a BigData PARAM {channel, role, math, unit, label}:
 *   (1) the loaded LOG: BigData's parsed data carries `channelIds` (the HPT PID per column, index 0 =
 *       time, channelIds[i+1] pairs with channels[i]) -> exact channel name.        source 'log'
 *   (2) ctx.userMap { pid: channelName } -- mappings the user made earlier.          source 'user'
 *   (3) HPT_GENERIC_PIDS -> a normalized ROLE (datalog-presets.js NORMALIZED_CHANNEL_ROLES), taken
 *       only when the role resolves in this log; role-math entries (60040 = LTFT + STFT) become a
 *       concrete `math` expression over the log's real channel names.                source 'generic'
 *   (4) ctx.pidNames (HPL decoder table) / label hints harvested from the layout -> the channel of
 *       that exact name when the log has it, else just a better label.       source 'pidNames'|'hint'
 *   Anything else is UNRESOLVED but never blocks the import: the def gets a placeholder PARAM
 *   (channel 'HPT parameter <pid>' -- or the generic role when one is known) so the histogram shows
 *   BigData's "Missing parameter" UI, where the user maps it and the caller remembers the mapping in
 *   `userMap`. The HPT ids ride along in def.display.hpt for round-trip / debugging.
 *
 * Style: ES5 vanilla JS (plain <script> in the viewer, require() in node), one global `HptConfig`.
 * No DOM (no DOMParser: a small tolerant tag extractor with entity decoding instead), no eval.
 * Optional peers, looked up lazily on the global at call time: Histogram (datalog-histogram.js) for
 * makeDef/validateDef, DatalogExpr (datalog-expr.js) to validate translated filters.
 * =============================================================================================== */
(function (global) {
  'use strict';

  var VERSION = 1;
  var PLACEHOLDER_PREFIX = 'HPT parameter ';

  // ================================================================================================
  // 0. Small helpers
  // ================================================================================================
  function isFin(v) { return typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity; }
  function isObj(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }
  function trim(s) { return String(s == null ? '' : s).replace(/^\s+|\s+$/g, ''); }
  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function pushUnique(arr, s) { if (arr.indexOf(s) < 0) arr.push(s); }
  /** Integer id text -> number, or null ("", "abc", "1.5" -> null). */
  function toInt(s) {
    if (s == null) return null;
    var t = trim(s);
    if (!/^[+-]?\d+$/.test(t)) return null;
    var v = parseInt(t, 10);
    return isFin(v) ? v : null;
  }
  function placeholderName(pid) { return PLACEHOLDER_PREFIX + pid; }
  /** `[Name]` reference text for the expression language; falls back to "Name" when the name holds ']'. */
  function refText(name) {
    name = trim(name);
    if (name.indexOf(']') < 0) return '[' + name + ']';
    return '"' + name.replace(/"/g, '') + '"';
  }

  // ================================================================================================
  // 1. Tolerant XML text extraction (no DOMParser -- must run under node and inside workers)
  // ================================================================================================
  var ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  function fromCodePoint(code) {
    if (code <= 0xFFFF) return String.fromCharCode(code);
    code -= 0x10000;
    return String.fromCharCode(0xD800 + (code >> 10), 0xDC00 + (code & 0x3FF));
  }
  /** Decodes &gt; &lt; &amp; &quot; &apos; &#NN; &#xHH; -- unknown entities are left as written. */
  function decodeEntities(s) {
    if (s == null) return '';
    return String(s).replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, function (m, body) {
      if (body.charAt(0) === '#') {
        var hex = body.charAt(1) === 'x' || body.charAt(1) === 'X';
        var code = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        return (isFin(code) && code >= 0 && code <= 0x10FFFF) ? fromCodePoint(code) : m;
      }
      return has(ENTITIES, body) ? ENTITIES[body] : m;
    });
  }
  /** BOM (as U+FEFF, or the latin1-misdecoded "ï»¿" triplet) + CRLF/CR normalisation + comment strip. */
  function cleanText(text) {
    var s = String(text);
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
    else if (s.slice(0, 3) === 'ï»¿') s = s.slice(3);
    s = s.replace(/\r\n?/g, '\n');
    s = s.replace(/<!--[\s\S]*?-->/g, '');
    return s;
  }
  function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  /** Inner text of every <Tag ...>...</Tag> block (self-closing ones are skipped). Flat schema: no nesting of the same tag. */
  function blocks(text, tag) {
    var re = new RegExp('<' + escapeRe(tag) + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + escapeRe(tag) + '\\s*>', 'g');
    var out = [], m;
    while ((m = re.exec(text)) !== null) out.push(m[1]);
    return out;
  }
  /** Decoded, trimmed text of the first <Tag>...</Tag> child in a block; '' for <Tag/>; null when absent. */
  function childText(block, tag) {
    var t = escapeRe(tag);
    var m = new RegExp('<' + t + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + t + '\\s*>').exec(block);
    if (!m) return new RegExp('<' + t + '(?:\\s[^>]*)?\\/>').test(block) ? '' : null;
    var inner = trim(m[1]);
    var cd = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(inner);
    return cd ? trim(cd[1]) : trim(decodeEntities(inner));
  }
  /** "500,600,700" (or whitespace / semicolon separated) -> number[]; exact repeats dropped (reported). */
  function parseAxisText(s, report) {
    var values = [], seen = {}, dupes = 0, bad = 0;
    if (s == null) return values;
    var tokens = String(s).split(/[\s,;]+/);
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      if (!t) continue;
      var v = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(t) ? parseFloat(t) : NaN;
      if (!isFin(v)) { bad++; continue; }
      var key = String(v);
      if (seen[key]) { dupes++; continue; }
      seen[key] = true;
      values.push(v);
    }
    if (report) { report.dupes = dupes; report.bad = bad; }
    return values;
  }

  // ================================================================================================
  // 2. Sniff + parse
  // ================================================================================================
  /** True when the text looks like a VCM Scanner layout (DocumentContents root, or Table/Gauge/Series blocks with ParameterIDs). */
  function isLayoutXml(text) {
    if (typeof text !== 'string' || !text) return false;
    var s = cleanText(text);
    if (/<DocumentContents[\s>]/.test(s)) return true;
    return /<(Table|Gauge|Series)[\s>]/.test(s) && /<ParameterID[\s>]/.test(s);
  }

  /**
   * parseLayout(text) -> { tables:[HptTable], warnings:string[] }   -- never throws.
   * HptTable = { label, filterFunction, cell:{pid,unitId}, column:{pid,unitId,breakpoints:number[]},
   *              row:{pid,unitId,breakpoints}|null, colors:{low,high} }
   * Tables are captured faithfully even when incomplete (pid null / no breakpoints); toHistogramDefs
   * decides what to skip. Garbage -> { tables:[], warnings:['...'] }.
   */
  function parseLayout(text) {
    var out = { tables: [], warnings: [] };
    try {
      if (typeof text !== 'string') { out.warnings.push('layout input is not text'); return out; }
      var s = cleanText(text);
      if (!trim(s)) { out.warnings.push('layout input is empty'); return out; }
      if (!isLayoutXml(s)) { out.warnings.push('input does not look like a VCM Scanner layout (no DocumentContents / Table / Gauge blocks)'); return out; }
      var tbs = blocks(s, 'Table');
      if (!tbs.length) {
        var g = blocks(s, 'Gauge').length, ser = blocks(s, 'Series').length;
        out.warnings.push('layout contains no histogram <Table> blocks (' + g + ' gauge' + (g === 1 ? '' : 's') + ', ' + ser + ' chart series) -- nothing to import');
        return out;
      }
      for (var i = 0; i < tbs.length; i++) {
        var b = tbs[i];
        var label = childText(b, 'Label');
        if (!label) label = 'Table ' + (i + 1);
        var rep = {};
        var colBps = parseAxisText(childText(b, 'ColumnAxis'), rep);
        if (rep.dupes) out.warnings.push('table "' + label + '": ' + rep.dupes + ' duplicate column breakpoint(s) dropped');
        if (rep.bad) out.warnings.push('table "' + label + '": ' + rep.bad + ' unreadable column axis value(s) ignored');
        var rowPidText = childText(b, 'RowParameterID'), rowAxisText = childText(b, 'RowAxis');
        var row = null;
        if ((rowPidText != null && rowPidText !== '') || (rowAxisText != null && trim(rowAxisText) !== '')) {
          var rrep = {};
          row = { pid: toInt(rowPidText), unitId: toInt(childText(b, 'RowUnit')), breakpoints: parseAxisText(rowAxisText, rrep) };
          if (rrep.dupes) out.warnings.push('table "' + label + '": ' + rrep.dupes + ' duplicate row breakpoint(s) dropped');
          if (rrep.bad) out.warnings.push('table "' + label + '": ' + rrep.bad + ' unreadable row axis value(s) ignored');
        }
        var low = toInt(childText(b, 'LowValueColor')), high = toInt(childText(b, 'HighValueColor'));
        out.tables.push({
          label: label,
          filterFunction: childText(b, 'FilterFunction') || '',
          cell: { pid: toInt(childText(b, 'ParameterID')), unitId: toInt(childText(b, 'Unit')) },
          column: { pid: toInt(childText(b, 'ColumnParameterID')), unitId: toInt(childText(b, 'ColumnUnit')), breakpoints: colBps },
          row: row,
          colors: { low: low == null ? -1 : low, high: high == null ? -1 : high }
        });
      }
    } catch (e) {
      out.warnings.push('layout parse failed: ' + String(e && e.message ? e.message : e));
    }
    return out;
  }

  /**
   * harvestLabels(text) -> { pid: { label, unitId } }
   * Every <Gauge> / <Series> (and any other non-Table block carrying an adjacent Label/ParameterID/
   * Unit triple) names an HPT parameter the way the tuner labelled it. First occurrence wins.
   */
  function harvestLabels(text) {
    var out = {};
    try {
      if (typeof text !== 'string' || !text) return out;
      var s = cleanText(text);
      // Table labels name the TABLE, not its parameter -- drop those blocks before looking.
      s = s.replace(/<Table(?:\s[^>]*)?>[\s\S]*?<\/Table\s*>/g, '');
      var addBlock = function (b) {
        var pid = toInt(childText(b, 'ParameterID'));
        var label = childText(b, 'Label');
        if (pid == null || !label) return;
        var key = String(pid);
        if (!has(out, key)) out[key] = { label: label, unitId: toInt(childText(b, 'Unit')) };
      };
      var kinds = ['Gauge', 'Series'], k, bs, i;
      for (k = 0; k < kinds.length; k++) { bs = blocks(s, kinds[k]); for (i = 0; i < bs.length; i++) addBlock(bs[i]); }
      // Any other block type (unknown widget kinds) with the same adjacent triple.
      var re = /<Label>([\s\S]*?)<\/Label>\s*<ParameterID>\s*(-?\d+)\s*<\/ParameterID>\s*(?:<Unit>\s*(-?\d+)\s*<\/Unit>)?/g, m;
      while ((m = re.exec(s)) !== null) {
        var key2 = String(parseInt(m[2], 10)), lbl = trim(decodeEntities(m[1]));
        if (lbl && !has(out, key2)) out[key2] = { label: lbl, unitId: m[3] == null ? null : parseInt(m[3], 10) };
      }
    } catch (e) { /* hints are best-effort */ }
    return out;
  }

  // ================================================================================================
  // 3. Known HPT ids -- HARVESTED FROM REAL LAYOUTS, DELIBERATELY PARTIAL.
  //    HP Tuners does not publish these tables. Everything below was read off Ken's own layouts
  //    (mapped point graphs.Layout.xml, zr1.Layout.xml) and the HPL decoder's PID name table
  //    (dev/hpl-decode.js HPL_PID_NAMES). `guess:true` marks an identity that rests on a user-typed
  //    gauge label or an inferred gauge range rather than a confirmed source. Unknown -> null.
  // ================================================================================================
  /** unitId -> BigData unit spelling (a UNIT_FAMILIES member, so the engine can convert axes). null = unknown, assume the log's unit. */
  var HPT_UNIT_IDS = {
    56: 'rpm',      // Engine RPM (confirmed)
    73: 'lb/min',   // Mass Airflow (confirmed)
    91: 'kPa',      // MAP gauge 0-250 on the ZR1 layout (guess: range fits kPa on a supercharged LT4)
    97: null,       // a second MAP unit, gauge 0-80 (inHg or psi -- undetermined)
    98: 'psi',      // fuel lift pump 20-100 / shift solenoid pressure 0-300 (guess from ranges)
    114: 'mph',     // Vehicle Speed (confirmed)
    120: null,      // torque (Desired Brake Torque) -- N·m vs lb·ft undetermined
    127: null,      // torque (Max Indicated Torque) -- N·m vs lb·ft undetermined
    150: null,      // unitless factor: seen on D Lambda, Desired Load, Inj DC and a Boost series -- NOT safely λ
    156: '%',       // percent (confirmed)
    161: '°',       // degrees: Spark, KR, cam angles, per-cyl knock (guess from usage)
    238: 'λ',       // lambda: WB 1/2, WB B1/B2, A Lambda 1/2 with 0.65-1.1 gauge ranges (guess from usage)
    242: '°F',      // temperature (confirmed)
    255: null       // MAF Period 200-400 (µs?) -- undetermined
  };

  /**
   * pid -> { label, unitId, role, roleMath, guess }
   *   role     : NORMALIZED_CHANNEL_ROLES id, used when that role resolves in the loaded log.
   *   roleMath : template over roles, e.g. '{stft_bank_1} + {ltft_bank_1}' -> a concrete math expression.
   *   unitId   : the unit the layout(s) used it with (informational; the XML always carries its own).
   * 5xxxx / 6xxxx ids are HP Tuners' generic / computed channels (not logged PIDs); 4-digit ids are
   * Ford PIDs named by the HPL decoder table; 2-digit ids are SAE modes.
   */
  var HPT_GENERIC_PIDS = {
    // ---- confirmed (Ken's layouts + brief) ------------------------------------------------------
    50070: { label: 'Engine RPM', unitId: 56, role: 'engine_rpm', guess: false },
    50020: { label: 'Vehicle Speed', unitId: 114, role: 'vehicle_speed', guess: false },
    50010: { label: 'Engine Coolant Temp', unitId: 242, role: 'engine_coolant_temp', guess: false },
    50040: { label: 'Mass Airflow', unitId: 73, role: null, guess: false },            // no MAF role exists yet
    60040: { label: 'LTFT + STFT', unitId: 156, role: null, roleMath: '{stft_bank_1} + {ltft_bank_1}', guess: false },
    67: { label: 'Absolute Load (SAE)', unitId: 156, role: 'actual_load', guess: false },
    2135: { label: 'Engine RPM', unitId: 56, role: 'engine_rpm', guess: false },
    // ---- 50091: CONFIRMED by Ken (2026-09-07) as pedal position, which is also what his zr1 layout
    //      labels it ("Accel Pedal" on a gauge, "Pedal" on a chart series) alongside 50090
    //      "Throttle", 7222 "Load" and 67 "Absol. Load". Not a guess. -----------------------------
    50091: { label: 'Accelerator Pedal Position', unitId: 156, role: 'accelerator_pedal_position', guess: false },
    // ---- generic ids read off zr1.Layout.xml gauge/series labels (guess: user-typed labels) -----
    50011: { label: 'Intake Air Temp', unitId: 242, role: 'manifold_charge_temp', guess: true },
    50030: { label: 'Manifold Absolute Pressure', unitId: 91, role: 'manifold_absolute_pressure', guess: true },
    50090: { label: 'Throttle Position', unitId: 156, role: 'throttle_position', guess: true },
    50110: { label: 'Spark Advance', unitId: 161, role: 'spark_advance', guess: true },
    50111: { label: 'Knock Retard', unitId: 161, role: 'total_knock', guess: true },
    50119: { label: 'Wideband 2', unitId: 238, role: 'lambda_bank_2', guess: true },
    50127: { label: 'Wideband 1', unitId: 238, role: 'lambda_bank_1', guess: true },
    50155: { label: 'Long Term Fuel Trim Bank 1', unitId: 156, role: 'ltft_bank_1', guess: true },
    50156: { label: 'Short Term Fuel Trim Bank 1', unitId: 156, role: 'stft_bank_1', guess: true },
    50157: { label: 'Long Term Fuel Trim Bank 2', unitId: 156, role: 'ltft_bank_2', guess: true },
    50158: { label: 'Short Term Fuel Trim Bank 2', unitId: 156, role: 'stft_bank_2', guess: true },
    60300: { label: 'Boost', unitId: 98, role: 'boost_pressure', guess: true },
    // ---- Ford PIDs named by the HPL decoder (names authoritative; roles via the alias table) ----
    2111: { label: 'Throttle Position', unitId: 156, role: 'throttle_position', guess: false },
    2114: { label: 'Accelerator Pedal Position', unitId: 156, role: 'accelerator_pedal_position', guess: false },
    2124: { label: 'Engine Coolant Temp', unitId: 242, role: 'engine_coolant_temp', guess: false },
    2127: { label: 'Intake Air Temp', unitId: 242, role: 'manifold_charge_temp', guess: false },
    2172: { label: 'Intake Cam Angle', unitId: 161, role: 'intake_cam', guess: false },
    2178: { label: 'Exhaust Cam Angle', unitId: 161, role: 'exhaust_cam', guess: false },
    2323: { label: 'Air Load', unitId: null, role: 'actual_load', guess: false },
    2331: { label: 'Manifold Absolute Pressure', unitId: 97, role: 'manifold_absolute_pressure', guess: false },
    2340: { label: 'Barometric Pressure', unitId: null, role: 'barometric_pressure', guess: false },
    2500: { label: 'Timing Advance', unitId: 161, role: 'spark_advance', guess: false },
    2630: { label: 'Knock Retard', unitId: 161, role: 'total_knock', guess: false },
    4100: { label: 'Trans Fluid Temp', unitId: 242, role: 'trans_temp', guess: false },
    4311: { label: 'TCC Slip', unitId: null, role: 'trans_slip', guess: false },
    6160: { label: 'WB EQ Ratio Bank 1', unitId: 238, role: 'lambda_bank_1', guess: false },
    6161: { label: 'WB EQ Ratio Bank 2', unitId: 238, role: 'lambda_bank_2', guess: false },
    6304: { label: 'Short Term Fuel Trim Bank 1', unitId: 156, role: 'stft_bank_1', guess: false },
    6305: { label: 'Long Term Fuel Trim Bank 1', unitId: 156, role: 'ltft_bank_1', guess: false },
    6306: { label: 'Short Term Fuel Trim Bank 2', unitId: 156, role: 'stft_bank_2', guess: false },
    6307: { label: 'Long Term Fuel Trim Bank 2', unitId: 156, role: 'ltft_bank_2', guess: false },
    8000: { label: 'Vehicle Speed', unitId: 114, role: 'vehicle_speed', guess: false },
    9312: { label: 'Fuel Lift Pump Pressure Actual', unitId: 98, role: 'fuel_pressure', guess: false },
    14100: { label: 'Trans Current Gear', unitId: null, role: 'current_gear', guess: false },
    14103: { label: 'Trans Commanded Gear', unitId: null, role: 'commanded_gear', guess: false },
    15021: { label: 'Fuel Rail Pressure Actual', unitId: null, role: null, guess: false },
    15022: { label: 'Fuel Rail Pressure Desired', unitId: null, role: 'desired_fuel_pressure', guess: false },
    17006: { label: 'Knock Cyl 1 (+Adv/-Ret)', unitId: 161, role: 'knock_cylinder_1', guess: false },
    17007: { label: 'Knock Cyl 2 (+Adv/-Ret)', unitId: 161, role: 'knock_cylinder_2', guess: false },
    17008: { label: 'Knock Cyl 3 (+Adv/-Ret)', unitId: 161, role: 'knock_cylinder_3', guess: false },
    17009: { label: 'Knock Cyl 4 (+Adv/-Ret)', unitId: 161, role: 'knock_cylinder_4', guess: false },
    17010: { label: 'Knock Cyl 5 (+Adv/-Ret)', unitId: 161, role: 'knock_cylinder_5', guess: false },
    17011: { label: 'Knock Cyl 6 (+Adv/-Ret)', unitId: 161, role: 'knock_cylinder_6', guess: false },
    17012: { label: 'Knock Cyl 7 (+Adv/-Ret)', unitId: 161, role: 'knock_cylinder_7', guess: false },
    17013: { label: 'Knock Cyl 8 (+Adv/-Ret)', unitId: 161, role: 'knock_cylinder_8', guess: false },
    19053: { label: 'VCT Exhaust Cam Phase Angle', unitId: 161, role: 'exhaust_cam', guess: false },
    19054: { label: 'VCT Intake Cam Phase Angle', unitId: 161, role: 'intake_cam', guess: false },
    19055: { label: 'Manifold Charge Temp', unitId: 242, role: 'manifold_charge_temp', guess: false },
    19076: { label: 'Desired Load', unitId: 150, role: 'desired_load', guess: false },
    // ---- SAE modes (2-digit ids; names from HPL_PID_NAMES) -------------------------------------
    5: { label: 'Engine Coolant Temp (SAE)', unitId: 242, role: 'engine_coolant_temp', guess: false },
    6: { label: 'Short Term Fuel Trim Bank 1 (SAE)', unitId: 156, role: 'stft_bank_1', guess: false },
    7: { label: 'Long Term Fuel Trim Bank 1 (SAE)', unitId: 156, role: 'ltft_bank_1', guess: false },
    8: { label: 'Short Term Fuel Trim Bank 2 (SAE)', unitId: 156, role: 'stft_bank_2', guess: false },
    9: { label: 'Long Term Fuel Trim Bank 2 (SAE)', unitId: 156, role: 'ltft_bank_2', guess: false },
    12: { label: 'Engine RPM (SAE)', unitId: 56, role: 'engine_rpm', guess: false },
    13: { label: 'Vehicle Speed (SAE)', unitId: 114, role: 'vehicle_speed', guess: false },
    14: { label: 'Timing Advance (SAE)', unitId: 161, role: 'spark_advance', guess: false },
    15: { label: 'Intake Air Temp (SAE)', unitId: 242, role: 'manifold_charge_temp', guess: false },
    16: { label: 'Mass Airflow (SAE)', unitId: 73, role: null, guess: false },
    17: { label: 'Throttle Position (SAE)', unitId: 156, role: 'throttle_position', guess: false },
    51: { label: 'Barometric Pressure (SAE)', unitId: null, role: 'barometric_pressure', guess: false },
    68: { label: 'Equivalence Ratio Commanded (SAE)', unitId: 238, role: 'commanded_lambda', guess: false }
  };

  function unitString(unitId) {
    if (unitId == null) return null;
    var key = String(unitId);
    return has(HPT_UNIT_IDS, key) && HPT_UNIT_IDS[key] ? HPT_UNIT_IDS[key] : null;
  }
  function genericEntry(pid) {
    if (pid == null) return null;
    var key = String(pid);
    return has(HPT_GENERIC_PIDS, key) ? HPT_GENERIC_PIDS[key] : null;
  }
  /** Roles named by a roleMath template, in order of appearance. */
  function templateRoles(tpl) {
    var roles = [], re = /\{([a-z0-9_]+)\}/g, m;
    while ((m = re.exec(tpl)) !== null) pushUnique(roles, m[1]);
    return roles;
  }

  // ================================================================================================
  // 4. Resolver: HPT (pid, unitId) -> BigData PARAM
  // ================================================================================================
  function normCtx(ctx) {
    ctx = isObj(ctx) ? ctx : {};
    var data = isObj(ctx.data) ? ctx.data : null;   // tolerate the viewer's data object being passed through
    var channels = Array.isArray(ctx.channels) ? ctx.channels : (data && Array.isArray(data.channels) ? data.channels : []);
    var channelIds = Array.isArray(ctx.channelIds) ? ctx.channelIds : (data && Array.isArray(data.channelIds) ? data.channelIds : null);
    var mapOf = function (o) { var out = {}; if (isObj(o)) Object.keys(o).forEach(function (k) { out[String(k)] = o[k]; }); return out; };
    return {
      channels: channels, channelIds: channelIds,
      unitByChannel: isObj(ctx.unitByChannel) ? ctx.unitByChannel : {},
      resolvedRoles: isObj(ctx.resolvedRoles) ? ctx.resolvedRoles : {},
      userMap: isObj(ctx.userMap) ? mapOf(ctx.userMap) : null,
      pidNames: isObj(ctx.pidNames) ? mapOf(ctx.pidNames) : null,
      labelHints: isObj(ctx.labelHints) ? mapOf(ctx.labelHints) : null
    };
  }

  /**
   * makeResolver(ctx) -> { param(pid, unitId, slot), unit(unitId), label(pid), channelFor(pid) }
   *   ctx = { channels, channelIds, unitByChannel, resolvedRoles, userMap, pidNames, labelHints }
   *   param() -> { param: PARAM, resolved, source:'log'|'user'|'generic'|'pidNames'|'hint'|'unresolved',
   *                guess, channelName: string|null, mathText: string|null }
   *   channelName / mathText are what the filter translator substitutes for `[pid.unit]`.
   */
  function makeResolver(ctx) {
    var c = normCtx(ctx);
    var byId = {}, channelSet = {}, channelByLower = {}, i;
    for (i = 0; i < c.channels.length; i++) {
      if (typeof c.channels[i] !== 'string') continue;
      channelSet[c.channels[i]] = true;
      var lowerKey = c.channels[i].trim().toLowerCase();
      if (!has(channelByLower, lowerKey)) channelByLower[lowerKey] = c.channels[i];
    }
    // Case-insensitive exact match, e.g. matching an HPT generic id's own label against this log's
    // real channel name regardless of how each side capitalised it.
    function exactChannelMatch(label) {
      if (typeof label !== 'string' || !label) return null;
      var hit = channelByLower[label.trim().toLowerCase()];
      return hit || null;
    }
    if (c.channelIds) {
      // channelIds[0] is the time column when the array is one longer than channels; tolerate an
      // already-aligned array too.
      var offset = c.channelIds.length === c.channels.length + 1 ? 1 : 0;
      for (i = offset; i < c.channelIds.length; i++) {
        var pid = c.channelIds[i], ch = c.channels[i - offset];
        if (pid == null || !isFin(Number(pid)) || typeof ch !== 'string' || !ch) continue;
        var key = String(Number(pid));
        if (!has(byId, key)) byId[key] = ch;
      }
    }
    var haveChannelList = c.channels.length > 0;
    function inLog(name) { return typeof name === 'string' && !!name && (!haveChannelList || !!channelSet[name]); }
    function unitOf(name, fallback) {
      var u = c.unitByChannel[name];
      return (typeof u === 'string' && u) ? u : fallback;
    }
    function paramOf(fields) {
      return { channel: fields.channel || null, role: fields.role || null, math: fields.math || null,
               unit: fields.unit || null, label: fields.label || fields.channel || fields.role || fields.math || '' };
    }
    /** Best human label for a pid without touching the log. */
    function bestLabel(pid) {
      var g = genericEntry(pid);
      if (g && g.label) return g.label;
      var key = String(pid);
      if (c.pidNames && typeof c.pidNames[key] === 'string' && c.pidNames[key]) return c.pidNames[key];
      if (c.labelHints && isObj(c.labelHints[key]) && c.labelHints[key].label) return String(c.labelHints[key].label);
      return placeholderName(pid);
    }

    function param(pid, unitId, slot) {
      var key = pid == null ? null : String(pid);
      var unit = unitString(unitId);
      var g = genericEntry(pid);
      var guess = !!(g && g.guess);
      var res = function (p, resolved, source, chName, mathText, gs) {
        return { param: p, resolved: resolved, source: source, guess: !!gs, channelName: chName || null, mathText: mathText || null, slot: slot || null };
      };
      if (key == null) return res(paramOf({ channel: placeholderName('?'), unit: unit, label: 'HPT parameter (missing id)' }), false, 'unresolved', null, null, false);

      // (1) the loaded log's PID row
      if (has(byId, key)) {
        var ch = byId[key];
        return res(paramOf({ channel: ch, unit: unit || unitOf(ch, null), label: ch }), true, 'log', ch, null, false);
      }
      // (2) the user's remembered mappings
      if (c.userMap && typeof c.userMap[key] === 'string' && c.userMap[key]) {
        var um = c.userMap[key];
        return res(paramOf({ channel: um, unit: unit || unitOf(um, null), label: um }), inLog(um), 'user', um, null, false);
      }
      // (2b) the generic entry's OWN label, matched EXACTLY (case-insensitive) against a channel this
      // log actually has. HIGH: several generic ids point at a role whose alias list is shared by more
      // than one physical channel -- e.g. manifold_charge_temp's aliases are
      // ["MCT","Manifold Charge Temp","Intake Air Temp","MAT"], so on a log that logs BOTH "Intake Air
      // Temp" and "Manifold Charge Temp" as separate channels, resolving PID 50011 ("Intake Air Temp")
      // via that role silently returned "Manifold Charge Temp" instead -- resolved:true, no warning,
      // wrong sensor. An exact name hit on the id's own label is unambiguous and always more specific
      // than a role's alias list, so it is tried first, ahead of the fuzzy role match.
      if (g && typeof g.label === 'string' && !g.roleMath && haveChannelList) {
        var exactCh = exactChannelMatch(g.label);
        // Keep the role too (when this id has one) for portability: a future log named slightly
        // differently still resolves via the role, exactly like the pure role-match branch below.
        if (exactCh) return res(paramOf({ channel: exactCh, role: g.role || null, unit: unit || unitOf(exactCh, null), label: exactCh }), true, 'generic-exact', exactCh, null, g.guess);
      }
      // (3) generic ids -> role / role-math, only when the log resolves the role(s)
      if (g) {
        if (g.roleMath) {
          var roles = templateRoles(g.roleMath), allOk = true, r;
          for (r = 0; r < roles.length; r++) if (!c.resolvedRoles[roles[r]]) { allOk = false; break; }
          if (allOk) {
            var math = g.roleMath.replace(/\{([a-z0-9_]+)\}/g, function (m, role) { return refText(c.resolvedRoles[role]); });
            return res(paramOf({ math: math, unit: unit, label: g.label }), true, 'generic', null, math, g.guess);
          }
        } else if (g.role && c.resolvedRoles[g.role]) {
          var rch = c.resolvedRoles[g.role];
          return res(paramOf({ role: g.role, unit: unit, label: g.label }), true, 'generic', rch, null, g.guess);
        }
      }
      // (4) decoder PID names / layout labels -> the exact channel when the log has it
      var pn = c.pidNames && typeof c.pidNames[key] === 'string' ? c.pidNames[key] : null;
      if (pn && inLog(pn) && haveChannelList) return res(paramOf({ channel: pn, unit: unit || unitOf(pn, null), label: pn }), true, 'pidNames', pn, null, false);
      var hint = c.labelHints && isObj(c.labelHints[key]) && c.labelHints[key].label ? String(c.labelHints[key].label) : null;
      if (hint && inLog(hint) && haveChannelList) return res(paramOf({ channel: hint, unit: unit || unitOf(hint, null), label: hint }), true, 'hint', hint, null, false);

      // unresolved: keep the generic role when there is one (validates + lets the UI suggest by role);
      // otherwise a placeholder channel name so the def still validates and lands in missing_parameter.
      var label = (g && g.label) || pn || hint || placeholderName(pid);
      var p = (g && g.role)
        ? paramOf({ role: g.role, unit: unit, label: label })
        : paramOf({ channel: placeholderName(pid), unit: unit, label: label });
      p.hptId = Number(pid);
      return res(p, false, 'unresolved', null, null, guess);
    }

    return {
      param: param,
      unit: unitString,
      label: bestLabel,
      channelFor: function (pid) { return has(byId, String(pid)) ? byId[String(pid)] : null; },
      ctx: c
    };
  }

  // ================================================================================================
  // 5. Filter translation: HPT FilterFunction -> BigData expression (+ simple clauses when possible)
  // ================================================================================================
  var HPT_KEYWORDS = { 'and': 'and', 'or': 'or', 'not': 'not', 'true': 'true', 'false': 'false' };
  /** Tokens after which a '-' is a unary minus (so "-5" stays one token). */
  var UNARY_AFTER = { 'and': 1, 'or': 1, 'not': 1, '(': 1, ',': 1, '<': 1, '<=': 1, '>': 1, '>=': 1, '==': 1, '!=': 1, '+': 1, '-': 1, '*': 1, '/': 1, '%': 1, '^': 1, '?': 1, ':': 1 };
  var NUM_RE = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;
  var IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

  /**
   * translateFilter(filterFunction, resolver) -> { expression, clauses, unresolved:[{pid,unitId}], warnings }
   *   `[PID.UNIT]` -> `[Channel Name]` (or `[HPT parameter PID]` when unresolved), `<>` -> `!=`,
   *   `=` -> `==`, AND/OR/NOT lowercased, whitespace normalised. The expression is checked with
   *   DatalogExpr.parse when that module is loaded; `clauses` come from parseSimpleFilter (null when
   *   the filter needs the advanced editor). An empty filter -> expression '' and clauses null.
   */
  function translateFilter(filterFunction, resolver) {
    var out = { expression: '', clauses: null, unresolved: [], warnings: [] };
    var src = trim(filterFunction);
    if (!src) return out;
    if (!resolver || typeof resolver.param !== 'function') resolver = makeResolver(null);
    var seenUnresolved = {};
    var parts = [], i = 0, n = src.length;
    try {
      while (i < n) {
        var ch = src.charAt(i);
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
        if (ch === '[') {
          var end = src.indexOf(']', i + 1);
          if (end < 0) { out.warnings.push('unterminated [ reference at position ' + i + '; rest of filter ignored'); break; }
          var body = src.slice(i + 1, end);
          var m = /^\s*(\d+)(?:\.(\d+))?\s*$/.exec(body);
          if (m) {
            var pid = parseInt(m[1], 10), unitId = m[2] == null ? null : parseInt(m[2], 10);
            var r = resolver.param(pid, unitId, 'filter');
            if (r.resolved && r.mathText) parts.push('(' + r.mathText + ')');
            else if (r.resolved && r.channelName) parts.push(refText(r.channelName));
            else {
              parts.push(refText(placeholderName(pid)));
              var k = pid + '.' + (unitId == null ? '' : unitId);
              if (!seenUnresolved[k]) { seenUnresolved[k] = true; out.unresolved.push({ pid: pid, unitId: unitId }); }
            }
          } else {
            parts.push(refText(body));   // a named reference: keep it, BigData may have that channel
            out.warnings.push('non-numeric reference [' + trim(body) + '] kept as a channel name');
          }
          i = end + 1; continue;
        }
        if (ch === '"' || ch === "'") {
          var close = src.indexOf(ch, i + 1);
          if (close < 0) { out.warnings.push('unterminated ' + ch + ' literal at position ' + i + '; rest of filter ignored'); break; }
          parts.push(src.slice(i, close + 1));
          i = close + 1; continue;
        }
        var two = src.substr(i, 2);
        if (two === '<>') { parts.push('!='); i += 2; continue; }
        if (two === '<=' || two === '>=' || two === '==' || two === '!=') { parts.push(two); i += 2; continue; }
        if (two === '&&') { parts.push('and'); i += 2; continue; }
        if (two === '||') { parts.push('or'); i += 2; continue; }
        if (ch === '=') { parts.push('=='); i += 1; continue; }
        if (ch === '&') { parts.push('and'); i += 1; continue; }
        if (ch === '|') { parts.push('or'); i += 1; continue; }
        if (ch === '!') { parts.push('not'); i += 1; continue; }
        if (ch === '-' && /^-(?:\d|\.\d)/.test(src.slice(i)) && (!parts.length || has(UNARY_AFTER, parts[parts.length - 1]))) {
          var neg = NUM_RE.exec(src.slice(i + 1));       // unary minus glued to its number: "- 1.5e1" -> "-1.5e1"
          parts.push('-' + neg[0]); i += 1 + neg[0].length; continue;
        }
        if ('<>()+-*/%^,?:'.indexOf(ch) >= 0) { parts.push(ch); i += 1; continue; }
        var rest = src.slice(i);
        var nm = NUM_RE.exec(rest);
        if (nm) { parts.push(nm[0]); i += nm[0].length; continue; }
        var im = IDENT_RE.exec(rest);
        if (im) {
          var low = im[0].toLowerCase();
          parts.push(has(HPT_KEYWORDS, low) ? HPT_KEYWORDS[low] : im[0]);
          i += im[0].length; continue;
        }
        out.warnings.push('unexpected character "' + ch + '" at position ' + i + ' dropped');
        i += 1;
      }
    } catch (e) {
      out.warnings.push('filter translation failed: ' + String(e && e.message ? e.message : e));
    }
    var expr = parts.join(' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')');
    out.expression = expr;
    var X = global.DatalogExpr;
    if (X && typeof X.parse === 'function') {
      var p = X.parse(expr);
      if (!p.ok) out.warnings.push('translated filter does not parse (' + (p.error && p.error.message) + '): ' + expr);
      else if (typeof X.parseSimpleFilter === 'function') out.clauses = X.parseSimpleFilter(expr);
    } else {
      out.warnings.push('DatalogExpr not loaded; filter kept as an advanced expression without validation');
    }
    return out;
  }

  // ================================================================================================
  // 6. Tables -> histogram definitions
  // ================================================================================================
  /** .NET ARGB int -> '#rrggbb'; -1 (Scanner's "default"), 0 (Color.Empty) and non-numbers -> null. */
  function argbToHex(v) {
    if (typeof v === 'string' && /^[+-]?\d+$/.test(trim(v))) v = parseInt(v, 10);
    if (!isFin(v) || v === -1 || v === 0) return null;
    var u = (v >>> 0) & 0xFFFFFF;
    var hex = u.toString(16);
    while (hex.length < 6) hex = '0' + hex;
    return '#' + hex;
  }

  /**
   * toHistogramDefs(tables, resolver, opts) -> { defs, unresolved:[{tableLabel, slot, pid, unitId, label}], warnings }
   *   One Histogram.makeDef per usable table. Unresolved parameters never block: the def carries a
   *   placeholder PARAM and the slot is listed in `unresolved`. opts: { minimumHits (5), statistic ('average') }.
   */
  function toHistogramDefs(tables, resolver, opts) {
    var out = { defs: [], unresolved: [], warnings: [] };
    var H = global.Histogram;
    if (!H || typeof H.makeDef !== 'function') { out.warnings.push('Histogram engine (datalog-histogram.js) is not loaded'); return out; }
    if (!Array.isArray(tables)) return out;
    if (!resolver || typeof resolver.param !== 'function') resolver = makeResolver(null);
    opts = isObj(opts) ? opts : {};
    var minHits = (isFin(opts.minimumHits) && opts.minimumHits >= 0) ? opts.minimumHits : 5;
    var statistic = typeof opts.statistic === 'string' && opts.statistic ? opts.statistic : 'average';
    var unitWarned = {};
    function noteUnit(unitId, what, label) {
      if (unitId == null || unitString(unitId) || unitWarned[unitId]) return;
      unitWarned[unitId] = true;
      out.warnings.push('unknown HPT unit id ' + unitId + ' (' + what + ' of "' + label + '"); assuming the log\'s unit');
    }
    function slotResult(label, slot, pid, unitId) {
      var r = resolver.param(pid, unitId, slot);
      if (!r.resolved) out.unresolved.push({ tableLabel: label, slot: slot, pid: pid, unitId: unitId, label: r.param.label, role: r.param.role || null, guess: !!r.guess });
      return r;
    }

    for (var i = 0; i < tables.length; i++) {
      var t = tables[i];
      if (!isObj(t)) continue;
      var label = typeof t.label === 'string' && t.label ? t.label : ('Table ' + (i + 1));
      var cell = isObj(t.cell) ? t.cell : {}, col = isObj(t.column) ? t.column : {}, row = isObj(t.row) ? t.row : null;
      if (cell.pid == null) { out.warnings.push('table "' + label + '" skipped: no cell parameter id'); continue; }
      if (col.pid == null) { out.warnings.push('table "' + label + '" skipped: no column parameter id'); continue; }
      var colBps = Array.isArray(col.breakpoints) ? col.breakpoints : [];
      if (!colBps.length) { out.warnings.push('table "' + label + '" skipped: no column breakpoints'); continue; }
      if (row) {
        var rowBps = Array.isArray(row.breakpoints) ? row.breakpoints : [];
        if (row.pid == null) { out.warnings.push('table "' + label + '": row axis has no parameter id; imported as a 1-D table'); row = null; }
        else if (!rowBps.length) { out.warnings.push('table "' + label + '": row axis has no breakpoints; imported as a 1-D table'); row = null; }
      }

      var cellR = slotResult(label, 'cell', cell.pid, cell.unitId);
      var colR = slotResult(label, 'column', col.pid, col.unitId);
      var rowR = row ? slotResult(label, 'row', row.pid, row.unitId) : null;
      noteUnit(cell.unitId, 'cell parameter', label);
      noteUnit(col.unitId, 'column axis', label);
      if (row) noteUnit(row.unitId, 'row axis', label);

      var filter = null, filterText = typeof t.filterFunction === 'string' ? trim(t.filterFunction) : '';
      if (filterText) {
        var tr = translateFilter(filterText, resolver);
        for (var w = 0; w < tr.warnings.length; w++) out.warnings.push('table "' + label + '" filter: ' + tr.warnings[w]);
        for (var u = 0; u < tr.unresolved.length; u++) {
          var up = tr.unresolved[u];
          out.unresolved.push({ tableLabel: label, slot: 'filter', pid: up.pid, unitId: up.unitId, label: resolver.label(up.pid), role: null, guess: false });
          noteUnit(up.unitId, 'filter reference', label);
        }
        filter = { mode: tr.clauses ? 'simple' : 'advanced', clauses: tr.clauses, expression: tr.expression || null };
      }

      var display = {
        hpt: {
          label: label, filterFunction: filterText, cellPid: cell.pid, cellUnitId: cell.unitId == null ? null : cell.unitId,
          columnPid: col.pid, columnUnitId: col.unitId == null ? null : col.unitId,
          rowPid: row ? row.pid : null, rowUnitId: row && row.unitId != null ? row.unitId : null
        }
      };
      var colors = isObj(t.colors) ? t.colors : {};
      var lowHex = argbToHex(colors.low), highHex = argbToHex(colors.high);
      if (lowHex && highHex) display.hptColors = { low: lowHex, high: highHex };

      var def = H.makeDef({
        name: label,
        description: 'Imported from HP Tuners VCM Scanner layout',
        type: 'table',
        cellParameter: cellR.param,
        columnAxis: { parameter: colR.param, unit: unitString(col.unitId), breakpoints: colBps.slice() },
        rowAxis: row ? { parameter: rowR.param, unit: unitString(row.unitId), breakpoints: row.breakpoints.slice() } : null,
        statistic: statistic,
        minimumHits: minHits,
        filter: filter || undefined,
        colorScale: { mode: 'auto' },
        display: display
      });
      // HPT ids on the params for the UI hook. NOTE: Histogram.makeParam/migrateDef rebuild params
      // with only {channel, role, math, unit, label}, so these are convenience copies -- the durable
      // record is def.display.hpt above.
      if (def.cellParameter) def.cellParameter.hptId = cell.pid;
      if (def.columnAxis && def.columnAxis.parameter) def.columnAxis.parameter.hptId = col.pid;
      if (def.rowAxis && def.rowAxis.parameter) def.rowAxis.parameter.hptId = row.pid;

      var v = H.validateDef(def);
      if (!v.ok) { out.warnings.push('table "' + label + '" skipped: ' + v.errors.join('; ')); continue; }
      out.defs.push(def);
    }
    return out;
  }

  /**
   * importLayout(text, ctx, opts) -> { defs, unresolved, warnings, tableCount }
   *   parseLayout + harvestLabels (merged under ctx.labelHints, the caller's own hints win) +
   *   makeResolver + toHistogramDefs. Never throws.
   */
  function importLayout(text, ctx, opts) {
    var parsed = parseLayout(text);
    var hints = harvestLabels(text);
    var c = isObj(ctx) ? ctx : {};
    var merged = {};
    Object.keys(hints).forEach(function (k) { merged[k] = hints[k]; });
    if (isObj(c.labelHints)) Object.keys(c.labelHints).forEach(function (k) { merged[String(k)] = c.labelHints[k]; });
    var ctx2 = {};
    Object.keys(c).forEach(function (k) { ctx2[k] = c[k]; });
    ctx2.labelHints = merged;
    var resolver = makeResolver(ctx2);
    var r = toHistogramDefs(parsed.tables, resolver, opts);
    return { defs: r.defs, unresolved: r.unresolved, warnings: parsed.warnings.concat(r.warnings), tableCount: parsed.tables.length };
  }

  // ================================================================================================
  // 7. Public API namespace (consumed by the viewer's Histograms import hook + dev/hpt-test.js)
  // ================================================================================================
  var HptConfig = {
    VERSION: VERSION,
    PLACEHOLDER_PREFIX: PLACEHOLDER_PREFIX,
    HPT_GENERIC_PIDS: HPT_GENERIC_PIDS,
    HPT_UNIT_IDS: HPT_UNIT_IDS,
    isLayoutXml: isLayoutXml,
    parseLayout: parseLayout,
    harvestLabels: harvestLabels,
    makeResolver: makeResolver,
    translateFilter: translateFilter,
    toHistogramDefs: toHistogramDefs,
    importLayout: importLayout,
    argbToHex: argbToHex,
    decodeEntities: decodeEntities,
    placeholderName: placeholderName
  };
  global.HptConfig = HptConfig;
  if (typeof module !== 'undefined' && module.exports) module.exports = HptConfig;
})(typeof window !== 'undefined' ? window : globalThis);
