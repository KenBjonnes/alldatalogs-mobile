/* =================================================================================================
 * datalog-scorecard-evaluators.js -- REAL Scorecard evaluator algorithms (domain logic), kept separate
 * from the framework (datalog-scorecard.js). Loaded AFTER it; each evaluator self-registers and, sharing
 * the same id, OVERRIDES the framework's placeholder. As real category algorithms are built they land
 * here (or split into per-category files) -- the framework never contains tuning math.
 *
 * IMPLEMENTED
 *   knock (experimental v0.9) -- see below.
 *
 * NOT a finalized PBD tuning standard. The scoring curve + thresholds are a defensible first pass exposed
 * as `settings` so they can be validated and tuned on real logs before promotion to status 'implemented'.
 * ES5 to match the engine; exposes pure helpers on `global.ScorecardEvaluators` for unit tests.
 * =============================================================================================== */
(function (global) {
  'use strict';
  var SC = global.Scorecard;
  if (!SC || !SC.registerEvaluator) { if (global.console) console.warn('Scorecard framework not loaded before evaluators'); return; }

  function extend(a, b) { var o = {}, k; for (k in a) o[k] = a[k]; if (b) for (k in b) if (b[k] !== undefined) o[k] = b[k]; return o; }
  function round1(v) { return Math.round(v * 10) / 10; }
  function grp(n) { return (n | 0).toLocaleString(); }

  // ===============================================================================================
  // KNOCK
  //   A knock SOURCE is total knock retard (positive deg pulled) OR any per-cylinder knock channel
  //   (labelled +Adv/-Ret, so retard is NEGATIVE). We take the worst (max) retard magnitude per sample
  //   across whatever sources the log has.
  //
  //   Knock is only meaningful under LOAD. We gate on throttle / engine load / boost (above an RPM
  //   floor); samples at idle or on decel are excluded so knock-sensor noise there ("false knock")
  //   never counts. When no load channel exists we score every above-idle sample and warn.
  //
  //   Score (0-100): start at 100, subtract a PEAK-severity penalty (deg of worst knock beyond a noise
  //   deadband) and a PREVALENCE penalty (how much of the load region knocked). All weights are settings.
  // ===============================================================================================
  var KNOCK_CYL_ROLES = ['knock_cylinder_1', 'knock_cylinder_2', 'knock_cylinder_3', 'knock_cylinder_4',
    'knock_cylinder_5', 'knock_cylinder_6', 'knock_cylinder_7', 'knock_cylinder_8'];

  var KNOCK_DEFAULTS = {
    loadThreshold: 65,        // % -- throttle OR engine load at/above this counts as "under load"
    boostThreshold: 2,        // psi -- boosted operation also counts as under load
    rpmFloor: 1500,           // rpm -- exclude below this (idle / off-idle)
    deadbandDeg: 0.3,         // deg -- ignore |knock| below this (sensor noise floor)
    eventThresholdDeg: 1.0,   // deg -- a knock "event" starts at this magnitude
    peakPointsPerDeg: 9,      // score penalty per deg of PEAK knock beyond the deadband
    prevalencePenaltyMax: 30, // max score penalty from how OFTEN knock occurs under load
    criticalDeg: 6,           // deg -- knock at/above this is flagged critical in evidence
    minLoadSamples: 40        // fewer high-load samples than this -> lower confidence + warning
  };

  /** Per-sample knock retard magnitude (deg): total (positive=retard) and per-cyl (negative=retard). */
  function knockMagAt(total, cyls, i) {
    var m = 0, v, k;
    if (total) { v = total[i]; if (v != null && isFinite(v) && v > 0) m = v; }
    for (k = 0; k < cyls.length; k++) { v = cyls[k][i]; if (v != null && isFinite(v) && v < 0 && -v > m) m = -v; }
    return m;
  }

  /** Pure score from aggregate metrics -- unit-testable and tunable. */
  function scoreFromMetrics(peakDeg, prevalence, s) {
    var peakPen = Math.max(0, peakDeg - s.deadbandDeg) * s.peakPointsPerDeg;
    var prevPen = Math.max(0, Math.min(1, prevalence)) * s.prevalencePenaltyMax;
    var sc = 100 - peakPen - prevPen;
    return sc < 0 ? 0 : sc > 100 ? 100 : sc;
  }

  function computeKnock(ctx) {
    var s = extend(KNOCK_DEFAULTS, ctx.settings);
    var startIdx = ctx.range.startIdx || 0;
    var total = ctx.rangeSeries('total_knock');
    var cyls = ctx.rolesResolved(KNOCK_CYL_ROLES).map(function (r) { return ctx.rangeSeries(r); }).filter(Boolean);
    var rpm = ctx.rangeSeries('engine_rpm');
    var thr = ctx.rangeSeries('throttle_position');
    var load = ctx.rangeSeries('actual_load');
    var boost = ctx.rangeSeries('boost_pressure');
    var haveLoadSignal = !!(thr || load || boost);
    var N = total ? total.length : (cyls[0] ? cyls[0].length : 0);

    function underLoad(i) {
      if (rpm && rpm[i] != null && isFinite(rpm[i]) && rpm[i] < s.rpmFloor) return false;
      if (!haveLoadSignal) return true; // can't isolate load -> score all above-idle samples (warned)
      if (thr && thr[i] != null && thr[i] >= s.loadThreshold) return true;
      if (load && load[i] != null && isFinite(load[i])) { var lp = load[i] <= 1.5 ? load[i] * 100 : load[i]; if (lp >= s.loadThreshold) return true; }
      if (boost && boost[i] != null && boost[i] >= s.boostThreshold) return true;
      return false;
    }

    var loadN = 0, knockingN = 0, peak = 0, events = [], cur = null;
    for (var i = 0; i < N; i++) {
      if (!underLoad(i)) { if (cur) { events.push(cur); cur = null; } continue; }
      loadN++;
      var mag = knockMagAt(total, cyls, i);
      if (mag > s.deadbandDeg) knockingN++;
      if (mag > peak) peak = mag;
      if (mag >= s.eventThresholdDeg) {
        if (!cur) cur = { startI: i, endI: i, peak: mag, peakI: i };
        else { cur.endI = i; if (mag > cur.peak) { cur.peak = mag; cur.peakI = i; } }
      } else if (cur) { events.push(cur); cur = null; }
    }
    if (cur) events.push(cur);

    if (loadN < 1) {
      return { score: null, status: 'not_evaluated',
        unavailableReason: 'No meaningful high-load operation found to evaluate knock.',
        summary: 'Knock is only scored under load (WOT / high load / boost); none was found in the selected range.' };
    }

    var prevalence = knockingN / loadN;
    var score = scoreFromMetrics(peak, prevalence, s);
    var absT = function (i) { return ctx.time[startIdx + i]; };
    var byPeak = events.slice().sort(function (a, b) { return b.peak - a.peak; });
    var evidence = byPeak.slice(0, 3).map(function (e) {
      return { startTime: absT(e.startI), endTime: absT(e.endI),
        severity: e.peak >= s.criticalDeg ? 'critical' : 'warning',
        label: 'Knock event', message: 'Peak ' + round1(e.peak) + '° knock retard',
        channelIds: total ? ['total_knock'] : undefined,
        values: rpm && rpm[e.peakI] != null ? { rpm: Math.round(rpm[e.peakI]), knockDeg: round1(e.peak) } : { knockDeg: round1(e.peak) } };
    });
    var details = [
      { label: 'Peak knock', value: round1(peak) + '°' },
      { label: 'High-load samples', value: grp(loadN) },
      { label: 'Samples with knock', value: grp(knockingN) },
      { label: 'Knock events', value: events.length },
      { label: 'Source', value: total ? 'total knock retard' : (cyls.length + ' per-cylinder channel' + (cyls.length === 1 ? '' : 's')) }
    ];
    var warnings = [];
    if (!haveLoadSignal) warnings.push('No throttle/load/boost channel; knock scored across all above-idle samples (may include false knock).');
    if (loadN < s.minLoadSamples) warnings.push('Only ' + loadN + ' high-load samples in range; limited data.');
    var confidence = Math.max(0.3, Math.min(1, loadN / (s.minLoadSamples * 10)));
    var summary = peak <= s.deadbandDeg
      ? 'No knock detected across ' + grp(loadN) + ' high-load samples.'
      : 'Peak knock ' + round1(peak) + '° in ' + events.length + ' event' + (events.length === 1 ? '' : 's') + ' across ' + grp(loadN) + ' high-load samples.';

    return {
      score: score, confidence: confidence, summary: summary, details: details, evidence: evidence, warnings: warnings,
      evaluatedSampleCount: loadN,
      evaluatedTimeRange: { start: ctx.time[startIdx], end: ctx.time[startIdx + N - 1] }
    };
  }

  SC.registerEvaluator({
    id: 'knock', name: 'Knock',
    description: 'Scores knock/detonation under meaningful load. Uses total knock retard, or per-cylinder knock when total is not logged. First-pass model -- validate and tune thresholds on real logs.',
    status: 'experimental', evaluatorVersion: '0.9.0',
    requiredChannels: [],
    requiredAnyOf: [{ label: 'Knock Retard (total or per-cylinder)', roles: ['total_knock'].concat(KNOCK_CYL_ROLES) }],
    optionalChannels: [{ role: 'engine_rpm' }, { role: 'throttle_position' }, { role: 'actual_load' }, { role: 'boost_pressure' }, { role: 'spark_advance' }],
    defaultSettings: extend(KNOCK_DEFAULTS, null),
    evaluate: computeKnock
  });

  // ===============================================================================================
  // FUELING (AFR / Lambda + Fuel Trims)  -- one "fueling" category, since measured lambda, commanded
  // lambda and fuel trims are the same story. Rough targets from Ken (2026-07-28), all in LAMBDA:
  //   - Low load / closed-loop cruise -> near 1.0 (stoich), and fuel trims (STFT+LTFT) near 0.
  //   - WOT window by induction type (leanest 'top' .. richest 'floor'):
  //       FI/boosted  0.82 .. 0.75      NA  0.86 .. 0.80      EcoBoost  0.83 .. 0.77
  //   - Leaner than 'top' at WOT is DANGEROUS (detonation) -> steep penalty; richer than 'floor' is
  //     safe-but-wasteful -> mild. Compare to COMMANDED lambda when it's logged.
  // Rough first pass -- everything is a setting; validate + tune on real logs. Handles AFR-only logs by
  // converting with stoichAFR (gasoline default; wrong fuel -> set stoichAFR).
  // ===============================================================================================
  var FUELING_DEFAULTS = {
    profile: 'auto',                 // 'auto' | 'fi' | 'na' | 'ecoboost'
    fiTop: 0.82, fiFloor: 0.75, naTop: 0.86, naFloor: 0.80, ecoTop: 0.83, ecoFloor: 0.77,
    cruiseTarget: 1.0, cruiseTol: 0.04,   // lambda target + deadband at cruise
    trimTolPct: 8, trimPenaltyMax: 70,    // |STFT+LTFT| at STEADY cruise: tolerance + penalty cap. Driven by the
                                          // WORST steady trim (a tuner reads the peak): ~18% -> ~73, ~25% -> ~54, ~30% -> ~40.
    commandedTol: 0.03, commandedPenaltyMax: 25,
    wotLoadThreshold: 80, cruiseLoadMin: 5, cruiseLoadMax: 45, rpmFloor: 1200, boostThreshold: 2,
    wotSettleSec: 0.5,               // ignore the first N s after WOT onset -- the power-enrichment
                                     // transition (lambda still falling from cruise stoich) + wideband lag
    cruiseSettleSec: 0.5,            // ignore the first N s after entering cruise (tip-out still settling)
    steadyWindowSec: 0.2, steadyRatePct: 5,   // "steady" = throttle/load moved <= steadyRatePct over the window;
                                              // trims + cruise lambda are only scored when steady (transients swing wildly)
    stoichAFR: 14.7,                 // AFR->lambda fallback when only AFR is logged (gasoline)
    minValidLambda: 0.5, maxValidLambda: 1.5,   // ignore sensor sentinels / decel fuel cutoff (lambda pegs ~2.0)
    wotLeanPct: 0.95, wotRichPct: 0.05,         // score SUSTAINED WOT lambda (percentile), not single transients
    wotLeanPerLambda: 500,           // lean at WOT is dangerous -> steep
    wotRichPerLambda: 60, cruisePerLambda: 350, trimPerPct: 2.7, commandedPerLambda: 200,
    imbalanceTol: 0.05, imbalancePerLambda: 250, imbalancePenaltyMax: 15,   // bank1 vs bank2 spread
    minSamples: 20
  };
  function pct(sortedAsc, p) { if (!sortedAsc.length) return null; return sortedAsc[Math.min(sortedAsc.length - 1, Math.max(0, Math.floor(p * (sortedAsc.length - 1))))]; }

  /** Lambda at sample i: measured lambda if present, else AFR/stoich. */
  function fuelLambdaAt(lam, afr, i, stoich) {
    var v; if (lam) { v = lam[i]; if (v != null && isFinite(v) && v > 0) return v; }
    if (afr) { v = afr[i]; if (v != null && isFinite(v) && v > 0) return v / stoich; }
    return null;
  }
  /** Resolve the induction profile + its WOT lambda window. */
  function fuelProfile(settingProfile, vehiclePlatformCategory, peakBoost, s) {
    var p = String(settingProfile || 'auto').toLowerCase();
    if (p !== 'fi' && p !== 'na' && p !== 'ecoboost') {
      var pc = String(vehiclePlatformCategory || '').toLowerCase();
      if (/eco/.test(pc)) p = 'ecoboost';
      else if (/turbo|super|boost|forced|\bfi\b/.test(pc)) p = 'fi';
      else if (/\bna\b|natural|aspir/.test(pc)) p = 'na';
      else p = peakBoost > s.boostThreshold ? 'fi' : 'na';   // last resort: boosted => FI
    }
    var top = p === 'ecoboost' ? s.ecoTop : p === 'na' ? s.naTop : s.fiTop;
    var floor = p === 'ecoboost' ? s.ecoFloor : p === 'na' ? s.naFloor : s.fiFloor;
    return { profile: p, top: top, floor: floor };
  }

  function fAsc(a, b) { return a - b; }
  function fClamp(x) { return x < 0 ? 0 : x > 100 ? 100 : x; }
  function lam2(v) { return v == null ? 'n/a' : (Math.round(v * 100) / 100).toFixed(2); }   // lambda display: 2 dp (0.76 != 0.80)
  function fBanks(c) { return ((c.haveB1 ? 'B1' : '') + (c.haveB1 && c.haveB2 ? ' + ' : '') + (c.haveB2 ? 'B2' : '')) || 'n/a'; }
  var FUEL_ANYOF = [{ label: 'Lambda or AFR', roles: ['lambda_bank_1', 'lambda_bank_2', 'afr_bank_1', 'afr_bank_2'] }];

  // Shared pass: resolve channels once, classify EVERY sample into settled-WOT / cruise / (skipped:
  // PE-transition or part-throttle), and accumulate the stats BOTH line items need. WOT (open-loop power
  // enrichment) and part-throttle (closed-loop cruise + trims) are then scored by separate evaluators.
  function collectFueling(ctx) {
    var s = extend(FUELING_DEFAULTS, ctx.settings);
    var startIdx = ctx.range.startIdx || 0;
    var lam1 = ctx.rangeSeries('lambda_bank_1'), lam2 = ctx.rangeSeries('lambda_bank_2');
    var afr1 = ctx.rangeSeries('afr_bank_1'), afr2 = ctx.rangeSeries('afr_bank_2');
    var haveB1 = !!(lam1 || afr1), haveB2 = !!(lam2 || afr2), usedAfr = !lam1 && !lam2 && !!(afr1 || afr2);
    var cmd = ctx.rangeSeries('commanded_lambda');
    var stft1 = ctx.rangeSeries('stft_bank_1'), ltft1 = ctx.rangeSeries('ltft_bank_1');
    var stft2 = ctx.rangeSeries('stft_bank_2'), ltft2 = ctx.rangeSeries('ltft_bank_2');
    var haveTrim = !!(stft1 || ltft1 || stft2 || ltft2);
    var rpm = ctx.rangeSeries('engine_rpm'), thr = ctx.rangeSeries('throttle_position'),
        load = ctx.rangeSeries('actual_load'), boost = ctx.rangeSeries('boost_pressure');
    var N = (lam1 || afr1 || lam2 || afr2 || []).length;
    var peakBoost = 0; if (boost) for (var b = 0; b < boost.length; b++) if (boost[b] > peakBoost) peakBoost = boost[b];
    var prof = fuelProfile(s.profile, ctx.vehicle && ctx.vehicle.platformCategory, peakBoost, s);

    function loadPct(i) {
      if (thr && thr[i] != null && isFinite(thr[i])) return thr[i];
      if (load && load[i] != null && isFinite(load[i])) return load[i] <= 1.5 ? load[i] * 100 : load[i];
      return null;
    }
    function aboveIdle(i) { return !(rpm && rpm[i] != null && isFinite(rpm[i]) && rpm[i] < s.rpmFloor); }
    // Power enrichment is a THROTTLE/load event. When throttle/load is logged it's authoritative -- boost
    // alone is NOT WOT (a car can make 2+ psi at 40% throttle while building boost, still in closed loop
    // near stoich). Falling back to boost only when there's no throttle/load channel at all.
    function isWOT(i) { if (!aboveIdle(i)) return false; var lp = loadPct(i); if (lp != null) return lp >= s.wotLoadThreshold; return boost && boost[i] != null && boost[i] >= s.boostThreshold; }
    function isCruise(i) { if (!aboveIdle(i)) return false; if (boost && boost[i] != null && boost[i] >= s.boostThreshold) return false; var lp = loadPct(i); return lp != null && lp >= s.cruiseLoadMin && lp <= s.cruiseLoadMax; }
    function valid(L) { return L != null && isFinite(L) && L >= s.minValidLambda && L <= s.maxValidLambda; }   // drop sensor sentinels / DFCO
    function bankLambda(l, a, i) { var L = fuelLambdaAt(l, a, i, s.stoichAFR); return valid(L) ? L : null; }
    var dt = (ctx.time[startIdx + 1] - ctx.time[startIdx]) || 0.05;
    var stWin = Math.max(1, Math.round(s.steadyWindowSec / dt));
    // "steady" = the operating point isn't moving. Trims + cruise lambda swing hard during any transition
    // (tip-in/out, load change) as closed loop chases the change; only steady-state reflects the base table.
    function steady(i) { if (i < stWin) return false; var a = loadPct(i), b = loadPct(i - stWin); if (a == null || b == null) return true; return Math.abs(a - b) <= s.steadyRatePct; }

    var wot = { lean: [], rich: [], worstLeanVal: 0, worstLeanI: -1, cmdExcSum: 0, cmdN: 0, imbalWorst: 0, imbalWorstI: -1, transitionSkipped: 0 };
    var cru = { n: 0, excSum: 0, trims: [], cmdExcSum: 0, cmdN: 0, imbalWorst: 0, imbalWorstI: -1, transitionSkipped: 0 };
    var k, wotRunStart = null, cruiseRunStart = null;
    for (var i = 0; i < N; i++) {
      // Classify first (run-lengths must track continuously even across invalid-lambda samples). A WOT sample
      // only counts once held past the settle time (the power-enrichment transition reads lean but isn't a fault);
      // a cruise sample only counts once held past its settle time AND the throttle/load is steady.
      var tAbs = ctx.time[startIdx + i], settledWot = false, steadyCruise = false;
      if (isWOT(i)) {
        cruiseRunStart = null;
        if (wotRunStart == null) wotRunStart = tAbs;
        if (tAbs - wotRunStart >= s.wotSettleSec) settledWot = true;
      } else if (isCruise(i)) {
        wotRunStart = null;
        if (cruiseRunStart == null) cruiseRunStart = tAbs;
        if (tAbs - cruiseRunStart >= s.cruiseSettleSec && steady(i)) steadyCruise = true;
      } else {
        wotRunStart = null; cruiseRunStart = null;
      }
      var L1 = bankLambda(lam1, afr1, i), L2 = bankLambda(lam2, afr2, i);
      var vals = []; if (L1 != null) vals.push(L1); if (L2 != null) vals.push(L2);
      if (!vals.length) continue;
      if (isWOT(i) && !settledWot) { wot.transitionSkipped++; continue; }   // PE transition -- not scored
      if (isCruise(i) && !steadyCruise) { cru.transitionSkipped++; continue; } // cruise transition -- not scored
      if (!(settledWot || steadyCruise)) continue;                          // part-throttle / spool -- not scored
      var leanest = vals[0], richest = vals[0];
      for (k = 1; k < vals.length; k++) { if (vals[k] > leanest) leanest = vals[k]; if (vals[k] < richest) richest = vals[k]; }
      var imb = (L1 != null && L2 != null) ? Math.abs(L1 - L2) : null;
      // Only LEANER-than-commanded matters (richer than commanded is safe); compare the leanest bank.
      var cmdExc = (cmd && cmd[i] != null && isFinite(cmd[i]) && cmd[i] > 0) ? Math.max(0, (leanest - cmd[i]) - s.commandedTol) : null;
      if (settledWot) {
        wot.lean.push(leanest); wot.rich.push(richest);
        if (leanest > wot.worstLeanVal) { wot.worstLeanVal = leanest; wot.worstLeanI = i; }
        if (imb != null && imb > wot.imbalWorst) { wot.imbalWorst = imb; wot.imbalWorstI = i; }
        if (cmdExc != null) { wot.cmdExcSum += cmdExc; wot.cmdN++; }
      } else {
        cru.n++;
        var avg = 0; for (k = 0; k < vals.length; k++) avg += vals[k]; avg /= vals.length;
        cru.excSum += Math.max(0, Math.abs(avg - s.cruiseTarget) - s.cruiseTol);
        if (imb != null && imb > cru.imbalWorst) { cru.imbalWorst = imb; cru.imbalWorstI = i; }
        if (cmdExc != null) { cru.cmdExcSum += cmdExc; cru.cmdN++; }
        if (haveTrim) {
          var t1 = (stft1 && stft1[i] != null ? stft1[i] : 0) + (ltft1 && ltft1[i] != null ? ltft1[i] : 0);
          var t2 = (stft2 && stft2[i] != null ? stft2[i] : 0) + (ltft2 && ltft2[i] != null ? ltft2[i] : 0);
          cru.trims.push(Math.max(Math.abs(t1), Math.abs(t2)));
        }
      }
    }
    return { s: s, startIdx: startIdx, N: N, prof: prof, usedAfr: usedAfr, haveB1: haveB1, haveB2: haveB2,
      haveTrim: haveTrim, hasCmd: !!cmd, wot: wot, cru: cru,
      absT: function (i) { return ctx.time[startIdx + i]; },
      range: { start: ctx.time[startIdx], end: ctx.time[startIdx + N - 1] } };
  }

  // ---- WOT Fueling: open-loop power enrichment vs the induction lambda window -------------------
  function computeFuelingWot(ctx) {
    var c = collectFueling(ctx), s = c.s, prof = c.prof, w = c.wot, both = c.haveB1 && c.haveB2;
    if (!w.lean.length) {
      return { score: null, status: 'not_evaluated',
        unavailableReason: w.transitionSkipped ? 'Only brief WOT tip-ins found — all within the power-enrichment transition (nothing held past ' + s.wotSettleSec + 's).' : 'No wide-open-throttle / power-enrichment operation found in the selected range.',
        summary: 'WOT Fueling scores open-loop power enrichment; no settled WOT was found here.' };
    }
    var sL = w.lean.slice().sort(fAsc), sR = w.rich.slice().sort(fAsc);
    var p95 = pct(sL, s.wotLeanPct), p50 = pct(sL, 0.5), p05 = pct(sR, s.wotRichPct);
    var leanPen = Math.max(0, p95 - prof.top) * s.wotLeanPerLambda;   // leaner than the window at WOT = detonation risk
    var richPen = Math.max(0, prof.floor - p05) * s.wotRichPerLambda; // richer than needed = safe-but-wasteful
    var cmdPen = w.cmdN ? Math.min(s.commandedPenaltyMax, (w.cmdExcSum / w.cmdN) * s.commandedPerLambda) : 0;
    var imbalPen = (both && w.imbalWorst > s.imbalanceTol) ? Math.min(s.imbalancePenaltyMax, (w.imbalWorst - s.imbalanceTol) * s.imbalancePerLambda) : 0;
    var score = fClamp(100 - leanPen - richPen - cmdPen - imbalPen);

    var evidence = [], isLean = p95 > prof.top, isRich = p05 < prof.floor;
    if (isLean) evidence.push({ startTime: c.absT(w.worstLeanI >= 0 ? w.worstLeanI : 0), severity: (p95 - prof.top) > 0.04 ? 'critical' : 'warning',
      label: 'Lean at WOT', message: 'WOT lambda (leanest 5%) ' + lam2(p95) + ' vs target ≤' + lam2(prof.top) + ' for ' + prof.profile.toUpperCase(), values: { leanLambda: +lam2(p95), target: prof.top } });
    if (both && w.imbalWorst > s.imbalanceTol) evidence.push({ startTime: c.absT(w.imbalWorstI >= 0 ? w.imbalWorstI : 0), severity: w.imbalWorst > 0.1 ? 'critical' : 'warning',
      label: 'Bank imbalance at WOT', message: 'Bank 1 / Bank 2 lambda differ by ' + lam2(w.imbalWorst) + ' at WOT', values: { spread: +lam2(w.imbalWorst) } });

    var details = [
      { label: 'Profile', value: prof.profile.toUpperCase() + ' (WOT ' + lam2(prof.floor) + '–' + lam2(prof.top) + ')' },
      { label: 'Banks', value: fBanks(c) },
      { label: 'WOT lambda (median / leanest)', value: lam2(p50) + ' / ' + lam2(p95) },
      { label: 'WOT samples', value: grp(w.lean.length) + (w.transitionSkipped ? ' (' + grp(w.transitionSkipped) + ' transition skipped)' : '') },
      { label: 'Fuel source', value: c.usedAfr ? 'AFR (converted @' + s.stoichAFR + ')' : 'measured lambda' },
      { label: 'Commanded', value: w.cmdN ? 'compared (' + grp(w.cmdN) + ' samples)' : 'not logged' }
    ];
    if (both) details.push({ label: 'Worst bank spread', value: lam2(w.imbalWorst) });
    var warnings = [];
    if (c.usedAfr) warnings.push('No lambda channel; converted AFR using stoich ' + s.stoichAFR + ' (set stoichAFR for non-gasoline fuel).');
    if (s.profile === 'auto' && !(ctx.vehicle && ctx.vehicle.platformCategory)) warnings.push('Induction auto-detected as ' + prof.profile.toUpperCase() + ' from boost; set the profile if wrong.');
    if (!c.hasCmd) warnings.push('Commanded lambda not logged — measured-vs-commanded check skipped.');
    var summary = (isLean
      ? 'Runs lean at WOT (leanest lambda ' + lam2(p95) + ' vs ≤' + lam2(prof.top) + ' for ' + prof.profile.toUpperCase() + ').'
      : 'WOT lambda in the ' + prof.profile.toUpperCase() + ' window (median ' + lam2(p50) + ') over ' + grp(w.lean.length) + ' samples.')
      + (isRich ? ' Richer than needed at times (down to ' + lam2(p05) + ').' : '')
      + (both && w.imbalWorst > s.imbalanceTol ? ' Bank spread up to ' + lam2(w.imbalWorst) + '.' : '');
    return { score: score, confidence: Math.max(0.3, Math.min(1, w.lean.length / (s.minSamples * 5))), summary: summary,
      details: details, evidence: evidence, warnings: warnings, evaluatedSampleCount: w.lean.length, evaluatedTimeRange: c.range };
  }

  // ---- Part-Throttle Fueling: closed-loop cruise near stoich + fuel trims -----------------------
  function computeFuelingPart(ctx) {
    var c = collectFueling(ctx), s = c.s, cr = c.cru, both = c.haveB1 && c.haveB2;
    if (!cr.n) {
      return { score: null, status: 'not_evaluated',
        unavailableReason: 'No steady closed-loop cruise found in the selected range.',
        summary: 'Part-Throttle Fueling scores closed-loop cruise lambda + fuel trims; no cruise was found here.' };
    }
    // Trims are scored off the WORST steady-cruise trim (a tuner reads the peak, not the average). The steady
    // filter has already dropped transition swings, so a high value here is a real base-table error.
    var trimN = cr.trims.length, trimWorst = 0, trimTyp = 0;
    if (trimN) { var st = cr.trims.slice().sort(fAsc); trimWorst = st[trimN - 1]; trimTyp = pct(st, 0.9); }
    var cruisePen = (cr.excSum / cr.n) * s.cruisePerLambda;
    var trimPen = trimN ? Math.min(s.trimPenaltyMax, Math.max(0, trimWorst - s.trimTolPct) * s.trimPerPct) : 0;
    var cmdPen = cr.cmdN ? Math.min(s.commandedPenaltyMax, (cr.cmdExcSum / cr.cmdN) * s.commandedPerLambda) : 0;
    var imbalPen = (both && cr.imbalWorst > s.imbalanceTol) ? Math.min(s.imbalancePenaltyMax, (cr.imbalWorst - s.imbalanceTol) * s.imbalancePerLambda) : 0;
    var score = fClamp(100 - cruisePen - trimPen - cmdPen - imbalPen);

    var offStoich = (cr.excSum / cr.n) > 0.005, highTrim = trimN && trimWorst > s.trimTolPct;
    var evidence = [];
    if (highTrim) evidence.push({ startTime: c.absT(0), severity: trimWorst > 20 ? 'critical' : 'warning',
      label: 'High fuel trims', message: 'Steady-cruise fuel trim (STFT+LTFT) reaches ' + round1(trimWorst) + '% vs tol ' + s.trimTolPct + '%', values: { worstTrimPct: round1(trimWorst), typicalTrimPct: round1(trimTyp) } });
    var details = [
      { label: 'Cruise lambda target', value: lam2(s.cruiseTarget) + ' ±' + s.cruiseTol },
      { label: 'Banks', value: fBanks(c) },
      { label: 'Steady-cruise samples', value: grp(cr.n) + (cr.transitionSkipped ? ' (' + grp(cr.transitionSkipped) + ' transition skipped)' : '') },
      { label: 'Fuel trims', value: trimN ? 'typical ' + round1(trimTyp) + '%, worst ' + round1(trimWorst) + '%' : 'not logged' },
      { label: 'Fuel source', value: c.usedAfr ? 'AFR (converted @' + s.stoichAFR + ')' : 'measured lambda' },
      { label: 'Commanded', value: cr.cmdN ? 'compared (' + grp(cr.cmdN) + ' samples)' : 'not logged' }
    ];
    if (both) details.push({ label: 'Worst bank spread', value: lam2(cr.imbalWorst) });
    var warnings = [];
    if (c.usedAfr) warnings.push('No lambda channel; converted AFR using stoich ' + s.stoichAFR + ' (set stoichAFR for non-gasoline fuel).');
    if (!c.haveTrim) warnings.push('Fuel trims not logged — part-throttle scored from lambda only. Log STFT/LTFT for a fuller picture.');
    if (!c.hasCmd) warnings.push('Commanded lambda not logged — measured-vs-commanded check skipped.');
    var summary = (offStoich ? 'Cruise runs off stoich (target ' + lam2(s.cruiseTarget) + ').' : 'Cruise holds near stoich.')
      + (trimN ? ' Fuel trims worst ' + round1(trimWorst) + '% (typical ' + round1(trimTyp) + '%).' : ' Fuel trims not logged.')
      + (both && cr.imbalWorst > s.imbalanceTol ? ' Bank spread up to ' + lam2(cr.imbalWorst) + '.' : '');
    return { score: score, confidence: Math.max(0.3, Math.min(1, cr.n / (s.minSamples * 5))), summary: summary,
      details: details, evidence: evidence, warnings: warnings, evaluatedSampleCount: cr.n, evaluatedTimeRange: c.range };
  }

  SC.registerEvaluator({
    id: 'fueling_wot', name: 'WOT Fueling',
    description: 'Open-loop power enrichment: WOT lambda vs the induction target window (FI/NA/EcoBoost), leaner-than-window = detonation risk. Uses both banks (leanest drives it + flags bank imbalance), skips the PE transition, and compares vs commanded when logged. First-pass model -- validate + tune on real logs.',
    status: 'experimental', evaluatorVersion: '0.9.0',
    requiredChannels: [],
    requiredAnyOf: FUEL_ANYOF,
    optionalChannels: [{ role: 'commanded_lambda' }, { role: 'engine_rpm' }, { role: 'throttle_position' }, { role: 'actual_load' }, { role: 'boost_pressure' }],
    defaultSettings: extend(FUELING_DEFAULTS, null),
    evaluate: computeFuelingWot
  });
  SC.registerEvaluator({
    id: 'fueling_part', name: 'Part-Throttle Fueling',
    description: 'Closed-loop cruise: lambda held near stoich with small fuel trims (STFT+LTFT, both banks). Large trims mean the base fuel table is off. First-pass model -- validate + tune on real logs.',
    status: 'experimental', evaluatorVersion: '0.9.0',
    requiredChannels: [],
    requiredAnyOf: FUEL_ANYOF,
    optionalChannels: [{ role: 'stft_bank_1' }, { role: 'ltft_bank_1' }, { role: 'stft_bank_2' }, { role: 'ltft_bank_2' }, { role: 'commanded_lambda' }, { role: 'engine_rpm' }, { role: 'throttle_position' }, { role: 'actual_load' }],
    defaultSettings: extend(FUELING_DEFAULTS, null),
    evaluate: computeFuelingPart
  });

  // Pure helpers for tests (dev/knock-test.js, dev/fueling-test.js).
  global.ScorecardEvaluators = {
    knockMagAt: knockMagAt, scoreFromMetrics: scoreFromMetrics, computeKnock: computeKnock,
    KNOCK_DEFAULTS: KNOCK_DEFAULTS, KNOCK_CYL_ROLES: KNOCK_CYL_ROLES,
    fuelLambdaAt: fuelLambdaAt, fuelProfile: fuelProfile, collectFueling: collectFueling,
    computeFuelingWot: computeFuelingWot, computeFuelingPart: computeFuelingPart, FUELING_DEFAULTS: FUELING_DEFAULTS
  };
})(typeof window !== 'undefined' ? window : globalThis);
