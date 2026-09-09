/* =================================================================================================
 * datalog-accel.js -- Estimated longitudinal acceleration from a datalog's speed channels.
 *
 * WHAT THIS IS
 *   A calculated-channel engine that turns whatever speed information a log carries into an
 *   accelerometer-like trace, with wheel spin identified and removed from the CHASSIS speed rather
 *   than reported as acceleration. Pure numeric code: no DOM, one global (`DatalogAccel`), loads as a
 *   plain <script> and under node require() (dev/accel-test.js).
 *
 *       raw speed sources -> chassis speed estimator -> smoothed velocity trend -> derivative -> G
 *
 * PIPELINE (see compute())
 *   1. discover()   which channels are speed: GPS, vehicle speed (VSS), individual wheels (with
 *                   position), driveline (output shaft / driveshaft), plus an actual longitudinal
 *                   accelerometer when logged (validation only). Units normalised to mph; rpm wheel /
 *                   driveshaft channels are calibrated against an mph source (constant ratio).
 *   2. time hygiene duplicate / reversed timestamps dropped, logging gaps split the log into segments
 *                   that no filter or derivative ever spans.
 *   3. per source   GPS sample-and-hold is turned back into its update instants (interpolated between,
 *                   dropouts blanked, lag against the wheels measured and removed).
 *   4. fusion       per sample, a confidence-weighted MEDIAN of the sources; wheels that run away from
 *                   the wheel consensus (spin) or stall against it (unloaded / lifted front) are
 *                   down-weighted; driven / driveline sources rank below non-driven / GPS.
 *   5. spin bridge  on the fused series (and so also on a VSS-only log) a spin excursion is found by
 *                   its RECOVERY: wheel speed falling faster than any road load could slow the car
 *                   while the pedal is still down, preceded by a rise above the trajectory the car
 *                   returns to. The chassis speed through the event is a cubic bridge between the
 *                   entry and exit trajectories. Long or ambiguous excursions are only FLAGGED (low
 *                   confidence), never rewritten, unless spin correction is 'aggressive'.
 *   6. derivative   a centred local-linear fit over a TIME window (not a sample count) gives both the
 *                   estimated chassis speed and its slope. The window is the only smoothing the
 *                   acceleration gets, so shifts, torque cuts and traction recovery stay visible.
 *   7. outputs      Estimated Acceleration (G, ft/s², m/s²), Acceleration Rate (mph/s), Estimated
 *                   Chassis Speed, Estimated Wheel Slip %, Driven Wheel Speed Delta, Wheel Spin
 *                   Detected, Wheel Spin Correction Active, Acceleration Estimate Confidence, plus a
 *                   meta block (sources used / rejected, events, window, sample rate) for the UI.
 *
 * UNITS  1 g = 21.936851 mph/s.  ft/s² = mph/s x 1.4666667.  m/s² = mph/s x 0.44704.
 * =============================================================================================== */
(function (global) {
  'use strict';

  var MPH_PER_S_PER_G = 21.936851, FT_PER_MPH = 1.4666667, M_PER_MPH = 0.44704;
  var PRESETS = { fast: 50, normal: 150, smooth: 250, verysmooth: 500 };
  var DEFAULT_SETTINGS = { source: 'auto', filter: 'auto', spin: 'auto' };
  var SOURCE_MODES = ['auto', 'gps', 'vss', 'wheels'];
  var SPIN_MODES = ['off', 'auto', 'aggressive'];

  /** The channels compute() can emit, in list order. `key` indexes result.series; `name` is the display name. */
  var CHANNELS = [
    { key: 'g',          name: 'Estimated Acceleration',          unit: 'G',       decimals: 2 },
    { key: 'ft',         name: 'Estimated Acceleration (ft/s²)',  unit: 'ft/s²',   decimals: 1 },
    { key: 'ms',         name: 'Estimated Acceleration (m/s²)',   unit: 'm/s²',    decimals: 2 },
    { key: 'rate',       name: 'Acceleration Rate',               unit: 'MPH/sec', decimals: 1 },
    { key: 'chassis',    name: 'Estimated Chassis Speed',         unit: 'mph',     decimals: 1 },
    { key: 'slip',       name: 'Estimated Wheel Slip',            unit: '%',       decimals: 1, optional: true },
    { key: 'delta',      name: 'Driven Wheel Speed Delta',        unit: 'mph',     decimals: 1, optional: true },
    { key: 'spin',       name: 'Wheel Spin Detected',             unit: '',        decimals: 0 },
    { key: 'corrected',  name: 'Wheel Spin Correction Active',    unit: '',        decimals: 0 },
    { key: 'confidence', name: 'Acceleration Estimate Confidence', unit: '%',      decimals: 0 }
  ];

  // ---- small numeric helpers -----------------------------------------------------------------------
  function isFin(v) { return typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity; }
  function sortedCopy(a) { var c = []; for (var i = 0; i < a.length; i++) if (isFin(a[i])) c.push(a[i]); c.sort(function (x, y) { return x - y; }); return c; }
  function medianSorted(s) { var n = s.length; if (!n) return NaN; return n % 2 ? s[(n - 1) >> 1] : 0.5 * (s[n / 2 - 1] + s[n / 2]); }
  function median(a) { return medianSorted(sortedCopy(a)); }
  function madScale(a, med) { var d = []; for (var i = 0; i < a.length; i++) if (isFin(a[i])) d.push(Math.abs(a[i] - med)); return 1.4826 * median(d); }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function fill(n, v) { var a = new Float64Array(n); if (v !== undefined && v !== 0) for (var i = 0; i < n; i++) a[i] = v; return a; }
  function normName(s) {
    var t = String(s == null ? '' : s);
    var bar = t.indexOf('|'); if (bar > 0) t = t.slice(0, bar);              // SCT "name|1|224|..." meta
    return t.toLowerCase().replace(/\(sae\)/g, ' ').replace(/[_\-\.]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  /** Weighted median of {v, w} candidates (w > 0). */
  function weightedMedian(c) {
    if (!c.length) return NaN;
    if (c.length === 1) return c[0].v;
    c.sort(function (a, b) { return a.v - b.v; });
    var tot = 0, i; for (i = 0; i < c.length; i++) tot += c[i].w;
    var acc = 0; for (i = 0; i < c.length; i++) { acc += c[i].w; if (acc >= tot / 2) return c[i].v; }
    return c[c.length - 1].v;
  }

  // ---- 1. SOURCE DISCOVERY ---------------------------------------------------------------------------
  // Words that mean a speed-named channel is NOT a measured vehicle / wheel speed.
  var EXCLUDE_RE = /\b(limit|limiting|target|desired|command|commanded|request|status|source|error|delta|slip|ratio|diff|difference|max|maximum|min|minimum|avg|average|cruise|set speed|idle|turbo|input shaft|engine|fan|pump|servo|valve|boost speed|predicted|filtered speed|threshold|cal\b|calc|scale|counts?|raw pulse|sensor volt|volt|volts|voltage|12v|5v|duty|pw|temp|pressure)\b/;
  var GPS_RE = /\b(gps|gnss|ground speed|satellite)\b/;
  var GPS_BAD_RE = /\b(status|sats|fix|quality|hdop|lat|lon|latitude|longitude|altitude|heading|course|time|date)\b/;
  var WHEEL_RE = /\b(wheel|whl|wss|traction speed|axle)\b/;
  var VSS_RE = /^(vehicle speed|road speed|vss|speed|vehicle speed sensor|veh speed|vspd|vehicle spd|ground speed|speed mph|speed kph|speed kmh|vehicle speed mph|vehicle speed kmh)$|\b(vehicle speed|road speed|vss)\b/;
  var DRIVELINE_RE = /\b(output shaft|oss|driveshaft|drive shaft|prop shaft|propshaft|tail shaft|tailshaft)\b/;
  var ACCEL_RE = /\b(accel g|accel x|x accel|longitudinal g|long g|longitudinal accel|accelerometer x|g force|gforce|acc x|ax)\b|^accel g|^g accel/;
  var ACCEL_BAD_RE = /\b(lateral|lat|y accel|z accel|vertical|raw|pedal|position|throttle|enrich|decay|fuel|rate)\b/;

  function unitFactor(unit, maxAbs) {
    var u = String(unit || '').toLowerCase().replace(/\s+/g, '');
    if (u === 'mph' || u === 'mi/h' || u === 'mile/h' || u === 'miles/h') return { mul: 1, kind: 'mph' };
    if (u === 'km/h' || u === 'kph' || u === 'kmh' || u === 'km/hr') return { mul: 0.6213711922, kind: 'mph' };
    if (u === 'm/s' || u === 'mps') return { mul: 2.2369362921, kind: 'mph' };
    if (u === 'ft/s' || u === 'fps') return { mul: 0.6818181818, kind: 'mph' };
    if (u === 'rpm' || u === 'r/min' || u === 'rev/min') return { mul: 1, kind: 'rpm' };
    if (u === 'hz') return { mul: 1, kind: 'rpm' };
    if (!u) return maxAbs > 400 ? { mul: 1, kind: 'rpm' } : { mul: 1, kind: 'mph' };   // blank unit: FuelTech / some CSVs
    return null;
  }
  function wheelPosition(n) {
    var toks = n.split(' '), front = false, rear = false, left = false, right = false, i, t;
    for (i = 0; i < toks.length; i++) {
      t = toks[i];
      if (t === 'front' || t === 'frt' || t === 'fnt' || t === 'f') front = true;
      else if (t === 'rear' || t === 'back' || t === 'bk' || t === 'r') rear = true;
      else if (t === 'left' || t === 'lft' || t === 'lh' || t === 'l') left = true;
      else if (t === 'right' || t === 'rt' || t === 'rh') right = true;
      else if (t === 'fl' || t === 'lf') { front = true; left = true; }
      else if (t === 'fr' || t === 'rf') { front = true; right = true; }
      else if (t === 'rl' || t === 'lr') { rear = true; left = true; }
      else if (t === 'rr') { rear = true; right = true; }
    }
    if (/\btraction\b/.test(n) && !front && !rear) return 'driven';
    var axle = front && !rear ? 'front' : rear && !front ? 'rear' : null;
    var side = left && !right ? 'left' : right && !left ? 'right' : null;
    if (axle && side) return axle === 'front' ? (side === 'left' ? 'fl' : 'fr') : (side === 'left' ? 'rl' : 'rr');
    return axle || null;   // 'front' / 'rear' = an axle average, null = unknown position
  }
  function seriesMaxAbs(s) { var m = 0; for (var i = 0; i < s.length; i++) { var v = s[i]; if (isFin(v) && Math.abs(v) > m) m = Math.abs(v); } return m; }

  /**
   * Find every speed source in a log. `data` = { channels, units?, series, textLevels? }, `roles` =
   * resolved role -> channel (optional), `unitByChannel` (optional), `vehicle` = host vehicle meta.
   * Returns { sources, accelRef, pedal, drivetrain }.
   */
  function discover(data, roles, unitByChannel, vehicle) {
    roles = roles || {}; unitByChannel = unitByChannel || {};
    var sources = [], accelRef = null, seen = {};
    var chans = data.channels || [], i;
    function unitOf(name, idx) { return unitByChannel[name] != null ? unitByChannel[name] : (data.units && data.units[idx] != null ? data.units[idx] : ''); }
    function add(name, kind, pos, idx) {
      if (seen[name]) return; seen[name] = true;
      var s = data.series[name]; if (!s) return;
      if (data.textLevels && data.textLevels[name]) return;
      var unit = unitOf(name, idx), f = unitFactor(unit, seriesMaxAbs(s));
      if (!f) return;
      sources.push({ name: name, kind: kind, pos: pos, unit: unit, mul: f.mul, rpm: f.kind === 'rpm', series: s });
    }
    // roles first (exact, curated), then names
    var roleMap = { gps_speed: ['gps', null], vehicle_speed: ['vss', null], wheel_speed_fl: ['wheel', 'fl'], wheel_speed_fr: ['wheel', 'fr'],
      wheel_speed_rl: ['wheel', 'rl'], wheel_speed_rr: ['wheel', 'rr'], output_shaft_speed: ['driveline', 'oss'], driveshaft_speed: ['driveline', 'shaft'] };
    Object.keys(roleMap).forEach(function (r) { if (roles[r]) add(roles[r], roleMap[r][0], roleMap[r][1], chans.indexOf(roles[r])); });
    for (i = 0; i < chans.length; i++) {
      var name = chans[i], n = normName(name);
      if (seen[name]) continue;
      if (!accelRef && ACCEL_RE.test(n) && !ACCEL_BAD_RE.test(n) && data.series[name]) {
        var au = String(unitOf(name, i) || '').toLowerCase();
        if (au === '' || au === 'g' || au === 'gs') accelRef = { name: name, series: data.series[name] };
      }
      if (EXCLUDE_RE.test(n)) continue;
      if (GPS_RE.test(n) && !GPS_BAD_RE.test(n) && /speed|velocity|mph|kph|km/.test(n)) { add(name, 'gps', null, i); continue; }
      if (WHEEL_RE.test(n) && /speed|rpm|whl|wss|wheel/.test(n) && !/\bwheel torque|wheelie|steer/.test(n)) { add(name, 'wheel', wheelPosition(n), i); continue; }
      if (DRIVELINE_RE.test(n)) { add(name, 'driveline', /output shaft|oss/.test(n) ? 'oss' : 'shaft', i); continue; }
      if (VSS_RE.test(n) && !/\bwheel|gps\b/.test(n)) { add(name, 'vss', null, i); continue; }
    }
    // a corrected accelerometer beats a raw one when both are logged
    if (!accelRef) for (i = 0; i < chans.length; i++) { var nn = normName(chans[i]); if (/accel/.test(nn) && /correct/.test(nn) && data.series[chans[i]]) { accelRef = { name: chans[i], series: data.series[chans[i]] }; break; } }
    var pedal = roles.accelerator_pedal_position && data.series[roles.accelerator_pedal_position] ? { name: roles.accelerator_pedal_position, series: data.series[roles.accelerator_pedal_position] }
      : roles.throttle_position && data.series[roles.throttle_position] ? { name: roles.throttle_position, series: data.series[roles.throttle_position] } : null;
    return { sources: sources, accelRef: accelRef, pedal: pedal, drivetrain: drivetrainOf(vehicle) };
  }
  function drivetrainOf(vehicle) {
    if (!vehicle) return null;
    var txt = [vehicle.drivetrain, vehicle.driveline, vehicle.drive, vehicle.platformCategory, vehicle.platform, vehicle.trim, vehicle.model, vehicle.notes].filter(Boolean).join(' ').toLowerCase();
    if (/\b(awd|4wd|4x4|all wheel|four wheel)\b/.test(txt)) return 'awd';
    if (/\b(fwd|front wheel drive)\b/.test(txt)) return 'fwd';
    if (/\b(rwd|rear wheel drive)\b/.test(txt)) return 'rwd';
    return null;
  }

  // ---- 2. TIME HYGIENE ---------------------------------------------------------------------------------
  /** Valid mask (finite, strictly increasing), segment ids across logging gaps, median dt, jitter. */
  function timeHygiene(time, gapSec) {
    var n = time.length, valid = new Uint8Array(n), seg = new Int32Array(n), dts = [], last = -Infinity, s = 0, i, dups = 0, revs = 0;
    for (i = 0; i < n; i++) {
      var t = time[i];
      if (!isFin(t)) { valid[i] = 0; seg[i] = s; continue; }
      if (t === last) { valid[i] = 0; seg[i] = s; dups++; continue; }
      if (t < last) { valid[i] = 0; seg[i] = s; revs++; continue; }
      if (isFin(last)) dts.push(t - last);
      valid[i] = 1; last = t; seg[i] = s;
    }
    var dtMed = median(dts) || 0.05, jitter = dtMed ? madScale(dts, dtMed) / dtMed : 0;
    var gap = gapSec != null ? gapSec : Math.max(1.0, 5 * dtMed), gaps = 0;
    last = -Infinity; s = 0;
    for (i = 0; i < n; i++) { if (!valid[i]) { seg[i] = s; continue; } if (isFin(last) && time[i] - last > gap) { s++; gaps++; } seg[i] = s; last = time[i]; }
    return { valid: valid, seg: seg, dtMed: dtMed, jitter: jitter, hz: dtMed ? 1 / dtMed : 0, dups: dups, reversals: revs, gaps: gaps, gapSec: gap };
  }

  // ---- 3. LOCAL LINEAR FIT (the one smoother / differentiator) ---------------------------------------
  /**
   * Centred, tricube-weighted local linear regression over a TIME window (halfW seconds each side),
   * never crossing a segment boundary. Returns the fitted value and slope at every valid sample.
   * O(n * samples-in-window). NaN inputs are skipped; a window with < 2 samples keeps the value and a
   * NaN slope (the caller decides what to do at the edges).
   */
  function localLinear(t, v, valid, seg, halfW) {
    var n = t.length, val = fill(n, NaN), slope = fill(n, NaN), cnt = new Int32Array(n);
    var lo = 0, hi = 0, i, j;
    for (i = 0; i < n; i++) {
      if (!valid[i]) continue;
      var ti = t[i], si = seg[i];
      while (lo < i && (!valid[lo] || seg[lo] !== si || ti - t[lo] > halfW)) lo++;
      if (hi < i) hi = i;
      while (hi + 1 < n && (!valid[hi + 1] ? true : (seg[hi + 1] === si && t[hi + 1] - ti <= halfW))) { hi++; if (!valid[hi] && hi + 1 < n && seg[hi + 1] !== si) break; }
      // trim hi back to the last sample that belongs to this window
      while (hi > i && (!valid[hi] || seg[hi] !== si || t[hi] - ti > halfW)) hi--;
      var Sw = 0, St = 0, Stt = 0, Sv = 0, Stv = 0, c = 0;
      for (j = lo; j <= hi; j++) {
        if (!valid[j] || seg[j] !== si) continue;
        var x = v[j]; if (!isFin(x)) continue;
        var tau = t[j] - ti, u = Math.abs(tau) / halfW; if (u > 1) continue;
        var w = 1 - u * u * u; w = w * w * w; if (w <= 0) w = 1e-6;
        Sw += w; St += w * tau; Stt += w * tau * tau; Sv += w * x; Stv += w * tau * x; c++;
      }
      cnt[i] = c;
      if (!c) continue;
      var det = Sw * Stt - St * St;
      if (c >= 2 && det > 1e-12) { var b = (Sw * Stv - St * Sv) / det; slope[i] = b; val[i] = (Sv - b * St) / Sw; }
      else val[i] = Sv / Sw;
    }
    return { val: val, slope: slope, cnt: cnt };
  }
  /** Plain least-squares line through the valid finite samples of v with t in [ta, tb]. */
  function lineFit(t, v, valid, seg, ta, tb, segId) {
    var Sx = 0, Sy = 0, Sxx = 0, Sxy = 0, c = 0, i;
    for (i = 0; i < t.length; i++) {
      if (!valid[i] || seg[i] !== segId || t[i] < ta || t[i] > tb || !isFin(v[i])) continue;
      Sx += t[i]; Sy += v[i]; Sxx += t[i] * t[i]; Sxy += t[i] * v[i]; c++;
    }
    if (c < 2) return c === 1 ? { a: Sy, b: 0, n: 1, at: function () { return Sy; } } : null;
    var det = c * Sxx - Sx * Sx; if (Math.abs(det) < 1e-12) return { a: Sy / c, b: 0, n: c, at: function () { return Sy / c; } };
    var b = (c * Sxy - Sx * Sy) / det, a = (Sy - b * Sx) / c;
    return { a: a, b: b, n: c, at: function (x) { return a + b * x; } };
  }
  /**
   * The channel's quantisation step (mph), 0 for continuous data. A quantised sensor sampled faster than
   * it changes REPEATS values (zero steps) and moves in multiples of one step; a continuous channel
   * almost never repeats exactly. So the step only counts when repeats are common.
   */
  function resolutionOf(v, valid) {
    var steps = [], last = NaN, i, zeros = 0, total = 0;
    for (i = 0; i < v.length; i++) {
      if (!valid[i] || !isFin(v[i])) continue;
      if (isFin(last)) { var d = Math.abs(v[i] - last); total++; if (d > 1e-6) steps.push(d); else zeros++; }
      last = v[i];
    }
    if (!steps.length || total < 20) return 0;
    if (zeros / total < 0.08) return 0;                                       // moves every sample: continuous
    var s = sortedCopy(steps), q = s[Math.floor(s.length * 0.1)];             // 10th percentile of the non-zero steps
    if (q < 0.04) return 0;
    var near = 0; for (i = 0; i < s.length; i++) { var m = s[i] / q; if (Math.abs(m - Math.round(m)) < 0.15) near++; }
    return near / s.length > 0.6 ? Math.round(q * 100) / 100 : 0;             // steps are multiples of q
  }

  // ---- 3b. DESPIKE -----------------------------------------------------------------------------------------
  /**
   * Sensor glitches -- a one- or two-sample spike, a dropout to zero, a hall-sensor miscount -- are not vehicle
   * dynamics. A sample that sits far from the median of its five nearest valid neighbours is blanked (NaN);
   * the short-hole fill downstream bridges it. Thresholds scale with speed so a 5 mph bobble at 150 mph is
   * left alone while a 40 mph step between two samples is not.
   */
  function despike(v, valid, seg) {
    var n = v.length, out = new Float64Array(v), idx = [], i, k, removed = 0;
    for (i = 0; i < n; i++) if (valid[i] && isFin(v[i])) idx.push(i);
    if (idx.length < 7) return { series: out, removed: 0 };
    for (k = 0; k < idx.length; k++) {
      i = idx[k];
      var win = [], a = Math.max(0, k - 3), b = Math.min(idx.length - 1, k + 3);
      for (var q = a; q <= b; q++) if (q !== k && seg[idx[q]] === seg[i]) win.push(v[idx[q]]);
      if (win.length < 3) continue;
      var med = median(win), dev = Math.abs(v[i] - med), tol = Math.max(6, 0.12 * Math.abs(med));
      if (dev > tol || (v[i] < 1 && med > 10)) { out[i] = NaN; removed++; }
    }
    return { series: out, removed: removed };
  }

  // ---- 4. GPS CLEANING -----------------------------------------------------------------------------------
  /** Sample-and-hold GPS: keep the update instants, interpolate between, blank dropouts, measure lag vs a reference. */
  function cleanGps(t, v, valid, seg, ref, hyg) {
    var n = t.length, out = fill(n, NaN), i, runs = [], run = 0, updates = [];
    for (i = 0; i < n; i++) {
      if (!valid[i] || !isFin(v[i])) { if (run) { runs.push(run); run = 0; } continue; }
      if (i > 0 && isFin(v[i - 1]) && v[i] === v[i - 1]) run++; else { if (run) runs.push(run + 1); run = 1; updates.push(i); }
    }
    var holdLen = median(runs) || 1, held = holdLen >= 2, upd = [], k;
    if (held) { for (k = 0; k < updates.length; k++) { i = updates[k]; if (isFin(v[i])) upd.push(i); } }
    else { for (i = 0; i < n; i++) if (valid[i] && isFin(v[i])) upd.push(i); }
    // dropout: zero / stale while the reference says the car is moving
    var updInterval = held ? holdLen * hyg.dtMed : hyg.dtMed;
    for (k = 0; k + 1 < upd.length; k++) {
      var a = upd[k], b = upd[k + 1];
      if (seg[a] !== seg[b] || t[b] - t[a] > Math.max(3 * updInterval, 1.0)) { out[a] = v[a]; continue; }   // gap: leave the hold blank
      for (i = a; i <= b; i++) { if (!valid[i] || seg[i] !== seg[a]) continue; var f = (t[i] - t[a]) / (t[b] - t[a]); out[i] = v[a] + f * (v[b] - v[a]); }
    }
    if (upd.length) out[upd[upd.length - 1]] = v[upd[upd.length - 1]];
    if (ref) for (i = 0; i < n; i++) if (isFin(out[i]) && out[i] < 0.5 && isFin(ref[i]) && ref[i] > 5) out[i] = NaN;
    // lag: shift that best aligns the GPS with the reference (GPS reports late)
    var lag = 0;
    if (ref) {
      var best = Infinity, bestK = 0, maxK = Math.max(1, Math.round(0.6 / hyg.dtMed));
      for (k = 0; k <= maxK; k++) {
        var err = 0, c = 0;
        for (i = k; i < n; i++) { if (!isFin(out[i]) || !isFin(ref[i - k]) || ref[i - k] < 10 || seg[i] !== seg[i - k]) continue; err += Math.abs(out[i] - ref[i - k]); c++; }
        if (c > 20 && err / c < best) { best = err / c; bestK = k; }
      }
      if (bestK > 0) { var sh = fill(n, NaN); for (i = bestK; i < n; i++) if (seg[i] === seg[i - bestK]) sh[i - bestK] = out[i]; out = sh; lag = bestK * hyg.dtMed; }
    }
    return { series: out, held: held, updateHz: updInterval ? 1 / updInterval : 0, lagSec: lag };
  }

  // ---- 5. SPIN EXCURSION DETECTION ON ONE SERIES (the VSS-only path, also run on the fused series) ------
  /**
   * Find wheel-spin excursions by their recovery: a fast FALL in wheel speed while the pedal is still down,
   * preceded by a rise above the trajectory the speed returns to. Returns events and a corrected copy.
   *   opts: { halfW, resStep, maxDur, pedal, mode ('auto'|'aggressive'), dtMed }
   */
  function findExcursions(t, v, valid, seg, opts) {
    var n = t.length, out = new Float64Array(v), events = [], mode = opts.mode || 'auto';
    var quickHalf = Math.max(0.1, 2 * opts.dtMed);
    var quick = localLinear(t, v, valid, seg, quickHalf);      // ~200 ms slope: what the wheels are doing now
    var trend = localLinear(t, v, valid, seg, 0.75);           // ~1.5 s slope: the trajectory the car is on
    var quantSlope = opts.resStep / Math.max(0.2, 2 * quickHalf);   // slope one quantisation step can fake
    var dropThresh = Math.max(6, 3 * quantSlope);              // mph/s BELOW the trajectory: a recovery, not road load
    var tolAbs = Math.max(1.0, 2.5 * opts.resStep);            // mph: "on the trajectory"
    var minFall = Math.max(2.0, 3 * opts.resStep);             // mph: a real recovery gives back at least this
    var maxDur = opts.maxDur || (mode === 'aggressive' ? 6 : 2.5);
    var pedal = opts.pedal ? opts.pedal.series : null;
    function pedalAt(i) { return pedal && isFin(pedal[i]) ? pedal[i] : NaN; }
    function relSlope(i) { var q = quick.slope[i]; if (!isFin(q)) return NaN; var tr = trend.slope[i]; return q - (isFin(tr) ? tr : 0); }
    var i = 0, q, corrected = new Uint8Array(n), flagged = new Uint8Array(n);
    while (i < n) {
      var rs = relSlope(i);
      if (!valid[i] || !isFin(rs) || rs > -dropThresh) { i++; continue; }
      // a recovery run: wheel speed falling away from the trajectory, until it stops falling
      var d0 = i, d1 = i, sid = seg[i];
      while (d1 + 1 < n && seg[d1 + 1] === sid && (!valid[d1 + 1] || (isFin(relSlope(d1 + 1)) && relSlope(d1 + 1) < -dropThresh / 2))) d1++;
      i = d1 + 1;
      var vTop = -Infinity, topI = d0;
      for (q = Math.max(0, d0 - 3); q <= d1; q++) if (valid[q] && isFin(v[q]) && v[q] > vTop) { vTop = v[q]; topI = q; }
      var vEnd = NaN, endI = d1; for (q = d1; q >= d0; q--) if (valid[q] && isFin(v[q])) { vEnd = v[q]; endI = q; break; }
      if (!isFin(vEnd) || !isFin(vTop)) continue;
      var trSl = isFin(trend.slope[topI]) ? trend.slope[topI] : 0;
      var relFall = trSl * (t[endI] - t[topI]) - (vEnd - vTop);   // how far the speed gave back against the trajectory
      if (relFall < minFall) continue;
      // pedal gate: a fall with the foot off is a lift or braking, not traction recovery
      var pedIn = pedalAt(Math.max(0, d0 - Math.round(0.1 / opts.dtMed)));
      if (mode !== 'aggressive' && isFin(pedIn) && pedIn < 20) continue;
      // exit trajectory: the line the car is on right after the recovery
      var tExit = t[endI], post = lineFit(t, v, valid, seg, tExit, tExit + 0.5, sid);
      if (post && post.n < 2) post = null;
      var excess = post ? vTop - post.at(t[topI]) : relFall;
      if (excess < Math.max(minFall, tolAbs)) continue;          // no hump above the exit line: a genuine slow-down
      // ...and above the ENTRY trajectory: a shift torque cut or a lift merely stops the speed rising, it
      // never lifts the speed above where the car was already heading
      var preFar = lineFit(t, v, valid, seg, t[d0] - 1.2, t[d0] - 0.4, sid);
      var excessPre = preFar && preFar.n >= 3 ? vTop - preFar.at(t[topI]) : excess;
      if (excessPre < Math.max(minFall, tolAbs)) continue;
      // walk back to where the speed was still on the exit trajectory
      var s = topI, reached = false, tStop = t[d0] - maxDur;
      while (s > 0 && seg[s - 1] === sid && t[s] >= tStop) {
        if (!valid[s] || !isFin(v[s])) { s--; continue; }
        if (post) { if (v[s] - post.at(t[s]) <= tolAbs) { reached = true; break; } }
        else { var pre0 = lineFit(t, v, valid, seg, t[s] - 0.4, t[s], sid); if (pre0 && pre0.n >= 2 && pre0.b < trSl + dropThresh) { reached = true; break; } }
        s--;
      }
      var ev = { t0: t[s], t1: t[endI], i0: s, i1: endI, peakExcess: excess, fall: relFall, kind: 'spin', corrected: false };
      var pre = lineFit(t, v, valid, seg, t[s] - 0.4, t[s], sid);
      var b0 = pre && pre.n >= 2 ? pre.b : trSl, b1 = post ? post.b : b0;
      // plausibility (auto): the car should still be on its way after the event -- a hard deceleration
      // after the fall is braking / a lift, not traction recovery; a walk that never met the exit line is ambiguous
      var implausible = !reached || (post && b1 < -dropThresh / 2 && b0 > 0);
      if (implausible && mode !== 'aggressive') {
        ev.kind = 'suspect'; ev.i0 = Math.max(s, d0 - Math.round(0.5 / opts.dtMed)); ev.t0 = t[ev.i0];
        for (q = ev.i0; q <= endI; q++) flagged[q] = 1;
        events.push(ev); continue;
      }
      // bridge: cubic Hermite from the entry trajectory to the exit trajectory
      var v0 = pre && pre.n >= 2 ? pre.at(t[s]) : v[s], v1 = post ? post.at(t[endI]) : vEnd;
      if (!isFin(v0)) v0 = v[s];
      var T = t[endI] - t[s]; if (T <= 0) continue;
      for (q = s; q <= endI; q++) {
        if (!valid[q]) continue;
        var x = (t[q] - t[s]) / T, x2 = x * x, x3 = x2 * x;
        var h00 = 2 * x3 - 3 * x2 + 1, h10 = x3 - 2 * x2 + x, h01 = -2 * x3 + 3 * x2, h11 = x3 - x2;
        var bridge = h00 * v0 + h10 * T * b0 + h01 * v1 + h11 * T * b1;
        if (isFin(v[q]) && v[q] - bridge > 0.5 * tolAbs) { out[q] = bridge; corrected[q] = 1; }
        flagged[q] = 1;
      }
      ev.corrected = true; events.push(ev);
    }
    return { series: out, events: events, corrected: corrected, flagged: flagged, dropThresh: dropThresh, tolAbs: tolAbs };
  }

  // ---- 6. THE ESTIMATOR ------------------------------------------------------------------------------------
  function chooseWindowMs(hyg, resStep, nSources, agree) {
    var dt = hyg.dtMed * 1000, w = 150;
    if (dt > 101) w = 500; else if (dt > 51) w = 250; else if (dt > 31) w = 200;
    if (resStep >= 0.5 && dt > 20) w = Math.max(w, 250);
    if (resStep >= 1 && dt > 20) w = Math.max(w, 300);
    if (dt <= 12 && resStep < 0.3 && nSources >= 2 && agree > 0.9) w = 100;
    if (hyg.jitter > 0.5) w += 50;
    return Math.max(w, Math.ceil(3 * dt));   // at least three samples
  }

  /**
   * compute(time, discovered, settings) -> { series: {key -> Float64Array}, meta }
   *   time        seconds (relative), may be irregular / have duplicates / gaps
   *   discovered  from discover()
   *   settings    { source: 'auto'|'gps'|'vss'|'wheels'|<channel name>, filter: 'auto'|'fast'|'normal'|'smooth'|'verysmooth'|<ms>, spin: 'off'|'auto'|'aggressive' }
   */
  function compute(time, discovered, settings) {
    settings = mergeSettings(settings);
    var n = time.length, hyg = timeHygiene(time), t = time, i, k;
    var all = discovered.sources || [], drivetrain = discovered.drivetrain || null;
    var meta = { sampleHz: Math.round(hyg.hz * 10) / 10, dtMs: Math.round(hyg.dtMed * 1000 * 10) / 10, jitterPct: Math.round(hyg.jitter * 100), duplicates: hyg.dups, reversals: hyg.reversals, gaps: hyg.gaps,
      drivetrain: drivetrain, sources: [], rejected: [], events: [], settings: settings, windowMs: null, sourceText: '', chassisSource: '' };
    if (!all.length || n < 3) { meta.sourceText = 'No speed channel found'; return { series: null, meta: meta }; }

    // ---- normalise every source to mph (rpm sources calibrated against the best mph source) --------
    var mphSources = all.filter(function (s) { return !s.rpm; });
    var prepared = [];
    all.forEach(function (s) {
      var vv = fill(n, NaN);
      for (i = 0; i < n; i++) { var x = s.series[i]; if (hyg.valid[i] && isFin(x)) vv[i] = x * s.mul; }
      prepared.push({ src: s, v: vv, res: 0, weight: 1, note: '', used: true });
    });
    // rpm calibration: median(mph / rpm) over moving samples against a reference mph source
    var refMph = null;
    (function () {
      var order = ['gps', 'wheel', 'vss', 'driveline'];
      for (var o = 0; o < order.length && !refMph; o++) for (k = 0; k < prepared.length; k++) {
        if (prepared[k].src.kind !== order[o] || prepared[k].src.rpm) continue;
        var mx = 0; for (i = 0; i < n; i++) if (isFin(prepared[k].v[i]) && prepared[k].v[i] > mx) mx = prepared[k].v[i];
        if (mx >= 15) { refMph = prepared[k].v; break; }
      }
    })();
    // No mph channel at all (a Holley drag log: driveshaft + front-wheel rpm, "Speed" never set up) but a
    // real accelerometer? Integrate it into a velocity SHAPE and scale each rpm channel to that shape by
    // least squares -- the accelerometer supplies only the scale factor, never the trace itself.
    var accelVel = null, accelName = null;
    if (!refMph && discovered.accelRef && discovered.accelRef.series) {
      var ar = discovered.accelRef.series, vv2 = fill(n, NaN), acc = 0, lastT = NaN, lastSeg = -1, moving = 0;
      for (i = 0; i < n; i++) {
        if (!hyg.valid[i] || !isFin(ar[i])) continue;
        if (hyg.seg[i] !== lastSeg) { acc = 0; lastT = t[i]; lastSeg = hyg.seg[i]; }
        acc += ar[i] * MPH_PER_S_PER_G * (t[i] - lastT); lastT = t[i];
        if (acc < 0) acc = 0;
        vv2[i] = acc; if (acc > 15) moving++;
      }
      if (moving >= 20) { accelVel = vv2; accelName = discovered.accelRef.name; }
    }
    prepared.forEach(function (p) {
      if (!p.src.rpm) return;
      var kr = NaN, how = '';
      var refV = refMph || accelVel, refMin = refMph ? 15 : 5;
      if (refV) {
        // scale by least squares, then drop the samples that do not fit (a frozen or spinning stretch) and refit
        var keep = new Uint8Array(n), pass;
        for (i = 0; i < n; i++) if (isFin(p.v[i]) && p.v[i] > 50 && isFin(refV[i]) && refV[i] > refMin) keep[i] = 1;
        for (pass = 0; pass < 3; pass++) {
          var sxy = 0, sxx = 0, c2 = 0;
          for (i = 0; i < n; i++) if (keep[i]) { sxy += p.v[i] * refV[i]; sxx += p.v[i] * p.v[i]; c2++; }
          if (c2 < 20 || sxx <= 0) { kr = NaN; break; }
          kr = sxy / sxx;
          var resid = []; for (i = 0; i < n; i++) if (keep[i]) resid.push(kr * p.v[i] - refV[i]);
          var rm = median(resid), rs = madScale(resid, rm); if (!(rs > 0)) break;
          var dropped = 0; for (i = 0; i < n; i++) if (keep[i] && Math.abs(kr * p.v[i] - refV[i] - rm) > 2.5 * rs) { keep[i] = 0; dropped++; }
          if (!dropped) break;
        }
        how = refMph ? 'rpm calibrated: ' : 'rpm calibrated against ' + accelName + ': ';
      }
      if (!isFin(kr) || kr <= 0) {
        p.used = false;
        p.note = refMph || accelVel ? 'rpm channel could not be calibrated (too little moving data)' : 'rpm channel with no mph speed channel (or accelerometer) to calibrate it against';
        return;
      }
      for (i = 0; i < n; i++) if (isFin(p.v[i])) p.v[i] *= kr;
      p.note = how + (Math.round(kr * 1e4) / 1e4) + ' mph per rpm';
    });
    // Two rpm channels calibrated independently (each against an integrated accelerometer) can land a few
    // percent apart; align every calibrated source to the best non-driven one (front wheel > GPS > VSS)
    // by the median ratio over moving samples, so the fusion compares like with like.
    (function () {
      var cal = prepared.filter(function (p) { return p.used && p.src.rpm; });
      if (cal.length < 2 && !(cal.length === 1 && prepared.some(function (p) { return p.used && !p.src.rpm; }))) return;
      var pick = null, order = [function (p) { return p.src.kind === 'wheel' && /^(fl|fr|front)$/.test(p.src.pos || ''); }, function (p) { return p.src.kind === 'gps'; }, function (p) { return p.src.kind === 'wheel'; }, function (p) { return p.src.kind === 'vss'; }];
      for (var o = 0; o < order.length && !pick; o++) for (k = 0; k < prepared.length; k++) if (prepared[k].used && order[o](prepared[k])) { pick = prepared[k]; break; }
      if (!pick) return;
      prepared.forEach(function (p) {
        if (!p.used || p === pick || !p.src.rpm) return;
        var ratios = [];
        for (i = 0; i < n; i++) if (isFin(p.v[i]) && p.v[i] > 15 && isFin(pick.v[i]) && pick.v[i] > 15) ratios.push(pick.v[i] / p.v[i]);
        if (ratios.length < 20) return;
        var r = median(ratios);
        if (isFin(r) && r > 0.5 && r < 2 && Math.abs(r - 1) > 0.01) { for (i = 0; i < n; i++) if (isFin(p.v[i])) p.v[i] *= r; p.note += '; scale aligned to ' + pick.src.name + ' (x' + (Math.round(r * 1000) / 1000) + ')'; }
      });
    })();
    prepared.forEach(function (p) {
      if (!p.used) return;
      var mx = 0; for (i = 0; i < n; i++) if (isFin(p.v[i]) && p.v[i] > mx) mx = p.v[i];
      if (mx < 3) { p.used = false; p.note = 'never moves (max ' + (Math.round(mx * 10) / 10) + ' mph) -- not wired or not set up'; return; }
      var ds = despike(p.v, hyg.valid, hyg.seg);
      p.v = ds.series; p.glitches = ds.removed;
      if (ds.removed) p.note = (p.note ? p.note + '; ' : '') + ds.removed + ' glitch sample' + (ds.removed === 1 ? '' : 's') + ' blanked';
      p.res = resolutionOf(p.v, hyg.valid);
    });

    // ---- the reference the fusion leans on (for GPS cleaning) -----------------------------------------
    var wheelPrepared = prepared.filter(function (p) { return p.used && p.src.kind === 'wheel'; });
    var vssPrepared = prepared.filter(function (p) { return p.used && p.src.kind === 'vss'; });
    var gpsPrepared = prepared.filter(function (p) { return p.used && p.src.kind === 'gps'; });
    var drvPrepared = prepared.filter(function (p) { return p.used && p.src.kind === 'driveline'; });
    var refForGps = null;
    if (wheelPrepared.length) { refForGps = fill(n, NaN); for (i = 0; i < n; i++) { var c = []; wheelPrepared.forEach(function (p) { if (isFin(p.v[i])) c.push(p.v[i]); }); if (c.length) refForGps[i] = median(c); } }
    else if (vssPrepared.length) refForGps = vssPrepared[0].v;
    gpsPrepared.forEach(function (p) {
      var g = cleanGps(t, p.v, hyg.valid, hyg.seg, refForGps, hyg);
      p.v = g.series; p.note = (g.held ? 'updates at ~' + (Math.round(g.updateHz * 10) / 10) + ' Hz, interpolated' : 'continuous') + (g.lagSec ? ', lag ' + Math.round(g.lagSec * 1000) + ' ms removed' : '');
    });

    // ---- source selection --------------------------------------------------------------------------------
    var mode = String(settings.source || 'auto').toLowerCase();
    var active = prepared.filter(function (p) { return p.used; });
    if (mode === 'gps') active = active.filter(function (p) { return p.src.kind === 'gps'; });
    else if (mode === 'vss') active = active.filter(function (p) { return p.src.kind === 'vss'; });
    else if (mode === 'wheels') active = active.filter(function (p) { return p.src.kind === 'wheel'; });
    else if (mode !== 'auto') { var pick = prepared.filter(function (p) { return p.used && normName(p.src.name) === normName(settings.source); }); if (pick.length) active = pick; }
    if (!active.length) active = prepared.filter(function (p) { return p.used; });
    if (!active.length) {
      prepared.forEach(function (p) { meta.rejected.push({ name: p.src.name, reason: p.note || 'not usable' }); });
      var rpmOnly = prepared.some(function (p) { return p.src.rpm; });
      meta.sourceText = rpmOnly ? 'No usable speed channel: only rpm speeds are logged and nothing in mph to calibrate them against' : 'No usable speed channel';
      return { series: null, meta: meta };
    }

    // baseline weights by what each source is
    function baseWeight(p) {
      var kd = p.src.kind, pos = p.src.pos;
      if (kd === 'gps') return 1.0;
      if (kd === 'wheel') {
        if (drivetrain === 'rwd') return (pos === 'fl' || pos === 'fr' || pos === 'front') ? 1.0 : (pos === 'driven' || pos === 'rl' || pos === 'rr' || pos === 'rear') ? 0.6 : 0.8;
        if (drivetrain === 'fwd') return (pos === 'rl' || pos === 'rr' || pos === 'rear') ? 1.0 : (pos === 'driven' || pos === 'fl' || pos === 'fr' || pos === 'front') ? 0.6 : 0.8;
        return pos === 'driven' ? 0.6 : 0.85;
      }
      if (kd === 'vss') return 0.8;
      return 0.45;   // driveline
    }
    function isDrivenSource(p) {
      var kd = p.src.kind, pos = p.src.pos;
      if (kd === 'driveline') return true;
      if (kd !== 'wheel') return false;
      if (pos === 'driven') return true;
      if (drivetrain === 'rwd') return pos === 'rl' || pos === 'rr' || pos === 'rear';
      if (drivetrain === 'fwd') return pos === 'fl' || pos === 'fr' || pos === 'front';
      if (drivetrain === 'awd') return true;
      return false;   // unknown drivetrain: decided per sample by behaviour
    }
    active.forEach(function (p) { p.weight = baseWeight(p); });
    var resStep = Math.min.apply(null, active.map(function (p) { return p.res || 0; }).concat([Infinity])); if (!isFin(resStep)) resStep = 0;
    var resMax = Math.max.apply(null, active.map(function (p) { return p.res || 0; }).concat([0]));
    var tolAbs = Math.max(1.0, 2.5 * resMax);

    // ---- per-source quick slopes (for wheel classification) -------------------------------------------
    var quickHalf = Math.max(0.1, 2 * hyg.dtMed);
    active.forEach(function (p) { p.quick = localLinear(t, p.v, hyg.valid, hyg.seg, quickHalf); });

    // ---- fusion: weighted median with per-sample spin / unloaded rejection -------------------------------
    var fused = fill(n, NaN), agree = new Float64Array(n), independent = new Uint8Array(n), drivenSpeed = fill(n, NaN), anyWheelSpin = new Uint8Array(n);
    var wheels = active.filter(function (p) { return p.src.kind === 'wheel'; });
    var perSampleWeight = active.map(function () { return new Float32Array(n); });
    // rolling prediction of the chassis speed from the last ~0.4 s of fused samples: velocity is continuous,
    // so whichever source group continues that trajectory is the one to trust when the groups split
    var ringT = [], ringV = [];
    function predictAt(ti) {
      while (ringT.length && ti - ringT[0] > 0.8) { ringT.shift(); ringV.shift(); }
      var m = ringT.length; if (m < 3) return NaN;
      var Sx = 0, Sy = 0, Sxx = 0, Sxy = 0, k2;
      for (k2 = 0; k2 < m; k2++) { Sx += ringT[k2]; Sy += ringV[k2]; Sxx += ringT[k2] * ringT[k2]; Sxy += ringT[k2] * ringV[k2]; }
      var det = m * Sxx - Sx * Sx; if (Math.abs(det) < 1e-12) return Sy / m;
      var b = (m * Sxy - Sx * Sy) / det, a = (Sy - b * Sx) / m;
      predSlope = b;
      return a + b * ti;
    }
    var predSlope = NaN;
    for (i = 0; i < n; i++) {
      if (!hyg.valid[i]) continue;
      var cands = [], ai;
      for (ai = 0; ai < active.length; ai++) { var p = active[ai]; if (isFin(p.v[i])) cands.push({ v: p.v[i], w: p.weight, p: p, idx: ai }); }
      if (!cands.length) continue;
      // wheel consensus first. A wheel far above the others and climbing is spinning; one far below and not
      // climbing while the others do is unloaded (a lifted front). When the wheels split into two groups
      // (both rears spinning, or both fronts frozen) the group that continues the recent chassis
      // trajectory is the one to keep -- velocity cannot jump, so the prediction breaks the tie.
      predSlope = NaN; var pred = predictAt(t[i]);
      if (wheels.length >= 2) {
        var wv = [], cw;
        for (cw = 0; cw < cands.length; cw++) if (cands[cw].p.src.kind === 'wheel') wv.push(cands[cw].v);
        if (wv.length >= 2) {
          var wmed = median(wv), tolW = Math.max(tolAbs, 0.03 * wmed), tolP = Math.max(tolAbs, 0.03 * Math.abs(isFin(pred) ? pred : wmed));
          var before = cands.map(function (c) { return c.w; }), anyKept = false;
          for (cw = 0; cw < cands.length; cw++) {
            var cp = cands[cw].p; if (cp.src.kind !== 'wheel') continue;
            var dev = cands[cw].v - wmed, sl = cp.quick.slope[i];
            if (isFin(pred)) {
              // value AND slope must continue the trajectory: a frozen front sits near the prediction for a
              // few samples but its slope is nowhere near the car's; a spinning rear is above it and climbing
              var dp = cands[cw].v - pred, slTol = Math.max(5, 0.5 * Math.abs(isFin(predSlope) ? predSlope : 0));
              var slopeOk = !isFin(sl) || !isFin(predSlope) || Math.abs(sl - predSlope) <= slTol;
              if (dp > tolP || (!slopeOk && sl > predSlope)) { cands[cw].w *= 0.05; cands[cw].spin = true; anyWheelSpin[i] = 1; }
              else if (dp < -tolP || (!slopeOk && sl < predSlope)) { cands[cw].w *= 0.05; cands[cw].unloaded = true; }
              else anyKept = true;
            } else {
              if (dev > tolW) { cands[cw].w *= 0.05; cands[cw].spin = true; anyWheelSpin[i] = 1; }
              else if (dev < -tolW && !(isFin(sl) && sl > 3)) { cands[cw].w *= 0.05; cands[cw].unloaded = true; }
              else anyKept = true;
            }
          }
          if (!anyKept) for (cw = 0; cw < cands.length; cw++) { cands[cw].w = before[cw]; cands[cw].spin = false; cands[cw].unloaded = false; }   // no verdict: keep the plain median
        }
      }
      // frozen sensor (a lifted front, a dropout that holds the last value): its slope is ~0 while the other
      // sources climb together -- judged against the PEERS, so it works with two sources of any kind
      if (cands.length >= 2) {
        var slopes = [], cq;
        for (cq = 0; cq < cands.length; cq++) { var sq = cands[cq].p.quick.slope[i]; if (isFin(sq)) slopes.push(sq); }
        if (slopes.length >= 2) {
          var medSl = median(slopes);
          for (cq = 0; cq < cands.length; cq++) {
            var cs = cands[cq].p.quick.slope[i];
            if (!isFin(cs) || cands[cq].spin || cands[cq].unloaded || cands[cq].w <= 0.1) continue;
            if (Math.abs(medSl) > 5 && Math.abs(cs) < 0.3 * Math.abs(medSl)) { cands[cq].w *= 0.05; cands[cq].unloaded = true; }
            // running away: climbing far faster than the peers (a tyre spinning up, a sensor step catching up)
            else if (cs - medSl > Math.max(20, 2 * Math.abs(medSl))) { cands[cq].w *= 0.05; cands[cq].spin = true; anyWheelSpin[i] = cands[cq].p.src.kind === 'wheel' ? 1 : anyWheelSpin[i]; }
          }
        }
      }
      var m1 = weightedMedian(cands.map(function (c) { return { v: c.v, w: c.w }; }));
      // anything (VSS / driveline / lone wheel) well above the consensus loses weight when an independent source exists
      var hasIndependent = cands.some(function (c) { return c.p.src.kind === 'gps' || (c.p.src.kind === 'wheel' && !c.spin && !c.unloaded && !isDrivenSource(c.p)); });
      for (var c2 = 0; c2 < cands.length; c2++) {
        var cc = cands[c2];
        if (hasIndependent && cc.v - m1 > tolAbs && (cc.p.src.kind !== 'gps')) cc.w *= 0.05;
        else if (hasIndependent && isFin(pred) && cc.v - pred > Math.max(tolAbs, 0.03 * Math.abs(pred)) && cc.p.src.kind !== 'gps' && !(cc.p.src.kind === 'wheel' && !isDrivenSource(cc.p))) cc.w *= 0.2;
        if (cc.p.src.kind === 'driveline' && cands.length > 1 && cc.v - m1 > tolAbs) cc.w *= 0.05;
      }
      fused[i] = weightedMedian(cands.map(function (c) { return { v: c.v, w: c.w }; }));
      if (isFin(fused[i])) { ringT.push(t[i]); ringV.push(fused[i]); }
      var na = 0, ni = 0;
      for (c2 = 0; c2 < cands.length; c2++) { cands[c2].p && (perSampleWeight[cands[c2].idx][i] = cands[c2].w); if (Math.abs(cands[c2].v - fused[i]) <= tolAbs) { na++; if (cands[c2].p.src.kind === 'gps' || (cands[c2].p.src.kind === 'wheel' && !isDrivenSource(cands[c2].p))) ni++; } }
      agree[i] = cands.length ? na / cands.length : 0; independent[i] = ni >= 1 && na >= 2 ? 1 : 0;
      // driven-wheel speed for slip: the driven wheels when known, else the fastest wheel / driveline source
      var dv = [];
      for (c2 = 0; c2 < cands.length; c2++) if (isDrivenSource(cands[c2].p)) dv.push(cands[c2].v);
      if (dv.length) drivenSpeed[i] = median(dv);
      else if (wheels.length >= 2 && drivetrain == null) { var mx = -Infinity; for (c2 = 0; c2 < cands.length; c2++) if (cands[c2].p.src.kind === 'wheel' && cands[c2].v > mx) mx = cands[c2].v; if (isFin(mx)) drivenSpeed[i] = mx; }
    }
    var haveDriven = false; for (i = 0; i < n; i++) if (isFin(drivenSpeed[i])) { haveDriven = true; break; }

    // ---- fill short holes inside a segment (so the fit windows see a continuous trace) -----------------
    var filled = new Float64Array(fused), interp = new Uint8Array(n);
    (function () {
      var lastI = -1;
      for (i = 0; i < n; i++) {
        if (!hyg.valid[i]) continue;
        if (isFin(filled[i])) {
          if (lastI >= 0 && i - lastI > 1 && hyg.seg[i] === hyg.seg[lastI] && t[i] - t[lastI] <= 0.5) {
            for (var q = lastI + 1; q < i; q++) { if (!hyg.valid[q]) continue; filled[q] = filled[lastI] + (filled[i] - filled[lastI]) * (t[q] - t[lastI]) / (t[i] - t[lastI]); interp[q] = 1; }
          }
          lastI = i;
        }
      }
    })();

    // ---- spin excursions on the fused trace (VSS-only logs live or die here) ---------------------------
    var spinMode = String(settings.spin || 'auto').toLowerCase();
    var exc = spinMode === 'off' ? { series: filled, events: [], corrected: new Uint8Array(n), flagged: new Uint8Array(n) }
      : findExcursions(t, filled, hyg.valid, hyg.seg, { dtMed: hyg.dtMed, resStep: resMax, pedal: discovered.pedal, mode: spinMode });
    var chassisRaw = exc.series;

    // ---- window + the derivative ------------------------------------------------------------------------
    var agreeAvg = 0, ac = 0; for (i = 0; i < n; i++) if (hyg.valid[i] && isFin(fused[i])) { agreeAvg += agree[i]; ac++; } agreeAvg = ac ? agreeAvg / ac : 0;
    var windowMs, f = String(settings.filter || 'auto').toLowerCase();
    if (PRESETS[f]) windowMs = PRESETS[f]; else if (isFin(parseFloat(f)) && parseFloat(f) > 0) windowMs = parseFloat(f); else windowMs = chooseWindowMs(hyg, resMax, active.length, agreeAvg);
    var fit = localLinear(t, chassisRaw, hyg.valid, hyg.seg, windowMs / 2000);
    var chassis = fit.val, rate = fill(n, NaN), blanked = 0;
    for (i = 0; i < n; i++) {
      if (!hyg.valid[i] || !isFin(chassis[i])) continue;
      var sl2 = fit.slope[i];
      if (!isFin(sl2)) { sl2 = 0; }
      // stopped / creeping: quantisation noise around 0-1 mph is not acceleration
      if (Math.abs(chassis[i]) < 1.0 && fit.cnt[i] >= 2) {
        var lo = Infinity, hi = -Infinity, j0 = Math.max(0, i - 3), j1 = Math.min(n - 1, i + 3);
        for (var jj = j0; jj <= j1; jj++) if (isFin(chassisRaw[jj])) { if (chassisRaw[jj] < lo) lo = chassisRaw[jj]; if (chassisRaw[jj] > hi) hi = chassisRaw[jj]; }
        if (hi - lo <= Math.max(2 * resMax, 0.6)) sl2 = 0;
      }
      rate[i] = sl2;
      if (Math.abs(sl2) > 8 * MPH_PER_S_PER_G) { rate[i] = NaN; blanked++; }   // nothing on wheels does 8 G: no estimate, not a wrong one
    }
    // ---- outputs ---------------------------------------------------------------------------------------------
    var g = fill(n, NaN), ft = fill(n, NaN), ms = fill(n, NaN), slip = fill(n, NaN), delta = fill(n, NaN), spin = fill(n, NaN), corr = fill(n, NaN), conf = fill(n, NaN);
    var indepSeen = false; for (i = 0; i < n; i++) if (independent[i]) { indepSeen = true; break; }
    var kinds = {}; active.forEach(function (p) { kinds[p.src.kind] = (kinds[p.src.kind] || 0) + 1; });
    var singleDriveline = active.length === 1 && active[0].src.kind === 'driveline';
    var allDriven = active.every(function (p) { return isDrivenSource(p) || p.src.kind === 'driveline'; });
    var measG = discovered.accelRef && discovered.accelRef.series ? discovered.accelRef.series : null, implausible = 0, disagree = 0, measN = 0;
    if (measG) for (i = 0; i < n; i++) if (hyg.valid[i] && isFin(measG[i])) measN++;
    for (i = 0; i < n; i++) {
      if (!hyg.valid[i] || !isFin(rate[i])) { if (hyg.valid[i]) { spin[i] = 0; corr[i] = 0; conf[i] = 0; } continue; }
      g[i] = rate[i] / MPH_PER_S_PER_G; ft[i] = rate[i] * FT_PER_MPH; ms[i] = rate[i] * M_PER_MPH;
      if (haveDriven && isFin(drivenSpeed[i])) { delta[i] = drivenSpeed[i] - chassis[i]; slip[i] = chassis[i] > 5 ? (drivenSpeed[i] / chassis[i] - 1) * 100 : NaN; }
      corr[i] = exc.corrected[i] ? 1 : 0;
      var c0 = independent[i] ? 97 : (active.length >= 2 && agree[i] >= 0.99 ? 92 : kinds.gps && active.length === 1 ? 88 : (kinds.wheel && !kinds.vss && !kinds.gps) ? 86 : kinds.vss ? 82 : singleDriveline ? 65 : 80);
      if (active.length >= 2 && agree[i] < 0.5) c0 -= 20;
      if (exc.corrected[i]) c0 = Math.min(c0, 45);
      else if (exc.flagged[i]) c0 = Math.min(c0, 30);
      if (interp[i]) c0 = Math.min(c0, 30);
      if (fit.cnt[i] < 3) c0 -= 10;
      if (allDriven) c0 = Math.min(c0, 65);                                   // only the driven tyres know this speed
      if (Math.abs(rate[i]) > 4 * MPH_PER_S_PER_G) c0 = Math.min(c0, 25);   // > 4 G: almost certainly tyre speed, not the car
      if (Math.abs(rate[i]) > 6 * MPH_PER_S_PER_G) { c0 = Math.min(c0, 10); implausible++; }
      if (measG && isFin(measG[i]) && Math.abs(rate[i] / MPH_PER_S_PER_G - measG[i]) > 0.5) { c0 = Math.min(c0, 30); disagree++; }
      if (Math.abs(chassis[i]) < 1.0 && rate[i] === 0) c0 = Math.max(c0, 90);
      conf[i] = clamp(Math.round(c0), 5, 100);
    }
    // wheel spin detected: hysteresis / debounce over the union of indicators
    (function () {
      var onFor = 0, offFor = 0, state = 0, minOn = Math.max(1, Math.round(0.1 / hyg.dtMed)), minOff = Math.max(1, Math.round(0.15 / hyg.dtMed));
      for (i = 0; i < n; i++) {
        if (!hyg.valid[i]) continue;
        var ind = exc.flagged[i] || anyWheelSpin[i] || (isFin(slip[i]) && slip[i] > 8) || (isFin(delta[i]) && delta[i] > 3);
        if (ind) { onFor++; offFor = 0; if (onFor >= minOn) state = 1; }
        else { offFor++; onFor = 0; if (offFor >= minOff) state = 0; }
        spin[i] = state;
      }
      // a debounced ON that started late: back-fill the leading samples of the run
      for (i = n - 1; i >= 0; i--) if (spin[i] === 1) { var b = i; while (b > 0 && (exc.flagged[b - 1] || anyWheelSpin[b - 1]) && spin[b - 1] === 0) { spin[b - 1] = 1; b--; } i = b; }
    })();

    // ---- meta / transparency ------------------------------------------------------------------------------
    var totalW = active.reduce(function (a, p) { return a + p.weight; }, 0);
    prepared.forEach(function (p) {
      var on = active.indexOf(p) !== -1;
      var rec = { name: p.src.name, kind: p.src.kind, position: p.src.pos, unit: p.src.unit, resolution: p.res, weight: on ? Math.round(p.weight * 100) / 100 : 0, used: on, note: p.note };
      if (on) meta.sources.push(rec); else meta.rejected.push({ name: p.src.name, reason: p.note || (mode === 'auto' ? 'not usable' : 'not in the selected source mode') });
    });
    exc.events.forEach(function (e) { meta.events.push({ t0: Math.round(e.t0 * 1000) / 1000, t1: Math.round(e.t1 * 1000) / 1000, kind: e.kind, corrected: !!e.corrected, peakExcessMph: Math.round(e.peakExcess * 10) / 10, fallMph: Math.round(e.fall * 10) / 10 }); });
    meta.windowMs = windowMs; meta.resolutionMph = resMax; meta.agreement = Math.round(agreeAvg * 100); meta.haveDriven = haveDriven; meta.accelReference = discovered.accelRef ? discovered.accelRef.name : null;
    meta.correctedSamples = 0; for (i = 0; i < n; i++) if (exc.corrected[i]) meta.correctedSamples++;
    meta.implausibleSamples = implausible; meta.blankedSamples = blanked;
    if (measG && measN) meta.accelCheck = { channel: discovered.accelRef.name, disagreePct: Math.round(100 * disagree / measN) };
    var extraTxt = '';
    if (implausible || blanked) extraTxt += ' · ' + (implausible + blanked) + ' sample' + (implausible + blanked === 1 ? '' : 's') + ' beyond 6 G (sensor glitch or tyre speed' + (blanked ? '; ' + blanked + ' beyond 8 G left blank' : '') + ')';
    if (measG && measN && disagree / measN > 0.2) extraTxt += ' · measured ' + discovered.accelRef.name + ' disagrees on ' + Math.round(100 * disagree / measN) + '% of samples';
    meta.sourceText = describeSources(active, kinds, exc.events, drivetrain, extraTxt);
    meta.chassisSource = meta.sourceText;
    var series = { g: g, ft: ft, ms: ms, rate: rate, chassis: chassis, spin: spin, corrected: corr, confidence: conf };
    if (haveDriven) { series.slip = slip; series.delta = delta; }
    series._raw = fused; series._driven = drivenSpeed;
    return { series: series, meta: meta };
  }
  function describeSources(active, kinds, events, drivetrain, extra) {
    var parts = [];
    if (kinds.gps) parts.push('GPS');
    var wheels = active.filter(function (p) { return p.src.kind === 'wheel'; });
    if (wheels.length >= 4) parts.push('four-wheel consensus');
    else if (wheels.length) parts.push(wheels.map(function (p) { return (p.src.pos ? p.src.pos.toUpperCase() : 'wheel'); }).join('/') + ' wheel speed');
    if (kinds.vss) parts.push(active.filter(function (p) { return p.src.kind === 'vss'; }).map(function (p) { return p.src.name; }).join(', '));
    if (kinds.driveline) parts.push(active.filter(function (p) { return p.src.kind === 'driveline'; }).map(function (p) { return p.src.name; }).join(', ') + ' (driveline)');
    var s = parts.join(' + ');
    var corrected = events.filter(function (e) { return e.corrected; }).length, suspect = events.length - corrected;
    if (corrected) s += ' — trend corrected (' + corrected + ' spin event' + (corrected === 1 ? '' : 's') + ')';
    if (suspect) s += ' — ' + suspect + ' suspect region' + (suspect === 1 ? '' : 's') + ' flagged';
    if (drivetrain) s += ' · ' + drivetrain.toUpperCase();
    if (extra) s += extra;
    if (active.length && active.every(function (p) { return p.src.kind === 'driveline' || p.src.pos === 'driven' || (drivetrain === 'rwd' && /^(rl|rr|rear)$/.test(p.src.pos || '')) || (drivetrain === 'fwd' && /^(fl|fr|front)$/.test(p.src.pos || '')); })) s += ' · driven wheels only';
    return s;
  }
  function mergeSettings(s) {
    var o = { source: DEFAULT_SETTINGS.source, filter: DEFAULT_SETTINGS.filter, spin: DEFAULT_SETTINGS.spin };
    if (s) { if (s.source != null && s.source !== '') o.source = String(s.source); if (s.filter != null && s.filter !== '') o.filter = String(s.filter); if (s.spin != null && SPIN_MODES.indexOf(String(s.spin).toLowerCase()) !== -1) o.spin = String(s.spin).toLowerCase(); }
    return o;
  }

  /** discover + compute + package as channel records: [{ key, name, unit, decimals, values }] plus meta. */
  function run(data, roles, unitByChannel, vehicle, settings) {
    var d = discover(data, roles, unitByChannel, vehicle);
    var r = compute(data.time, d, settings);
    var channels = [];
    if (r.series) CHANNELS.forEach(function (c) { if (r.series[c.key]) channels.push({ key: c.key, name: c.name, unit: c.unit, decimals: c.decimals, values: r.series[c.key] }); });
    return { channels: channels, meta: r.meta, discovered: d, series: r.series };
  }

  // ---- 7. VALIDATION against a logged accelerometer ------------------------------------------------------
  /** Compare an estimate with a measured G trace: RMSE, mean error, peak error, correlation, best lag (ms). */
  function validate(est, act, time, opts) {
    opts = opts || {};
    var n = Math.min(est.length, act.length, time.length), hyg = timeHygiene(time), maxLag = Math.max(1, Math.round((opts.maxLagSec || 0.5) / hyg.dtMed));
    function stats(lag) {
      var se = 0, sm = 0, pk = 0, c = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, i;
      for (i = Math.max(0, lag); i < n && i - lag < n; i++) {
        var e = est[i - lag], a = act[i]; if (!isFin(e) || !isFin(a)) continue;
        var d = e - a; se += d * d; sm += d; if (Math.abs(d) > pk) pk = Math.abs(d); c++;
        sx += e; sy += a; sxx += e * e; syy += a * a; sxy += e * a;
      }
      if (c < 5) return null;
      var cov = sxy / c - (sx / c) * (sy / c), vx = sxx / c - (sx / c) * (sx / c), vy = syy / c - (sy / c) * (sy / c);
      return { rmse: Math.sqrt(se / c), meanError: sm / c, peakError: pk, corr: vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : 0, n: c };
    }
    var best = null, bestLag = 0;
    for (var lag = -maxLag; lag <= maxLag; lag++) { var s = stats(lag); if (s && (!best || s.corr > best.corr)) { best = s; bestLag = lag; } }
    if (!best) return null;
    best.lagMs = Math.round(bestLag * hyg.dtMed * 1000); best.lagSamples = bestLag;
    var zero = stats(0); best.rmseNoLag = zero ? zero.rmse : null;
    return best;
  }

  var DatalogAccel = {
    CHANNELS: CHANNELS, PRESETS: PRESETS, DEFAULT_SETTINGS: DEFAULT_SETTINGS, SOURCE_MODES: SOURCE_MODES, SPIN_MODES: SPIN_MODES,
    MPH_PER_S_PER_G: MPH_PER_S_PER_G,
    discover: discover, compute: compute, run: run, validate: validate,
    // exposed for tests
    _localLinear: localLinear, _timeHygiene: timeHygiene, _findExcursions: findExcursions, _cleanGps: cleanGps, _resolutionOf: resolutionOf,
    _wheelPosition: wheelPosition, _unitFactor: unitFactor, _normName: normName, _chooseWindowMs: chooseWindowMs
  };
  global.DatalogAccel = DatalogAccel;
})(typeof window !== 'undefined' ? window : globalThis);
