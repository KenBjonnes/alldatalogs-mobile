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
    var ped = ctx.rangeSeries('accelerator_pedal_position');   // driver demand: a torque-managed throttle blade closes under boost
    var load = ctx.rangeSeries('actual_load');
    var boost = ctx.rangeSeries('boost_pressure');
    var haveLoadSignal = !!(thr || ped || load || boost);
    var N = total ? total.length : (cyls[0] ? cyls[0].length : 0);

    function underLoad(i) {
      if (rpm && rpm[i] != null && isFinite(rpm[i]) && rpm[i] < s.rpmFloor) return false;
      if (!haveLoadSignal) return true; // can't isolate load -> score all above-idle samples (warned)
      if (ped && ped[i] != null && ped[i] >= s.loadThreshold) return true;
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
      return { startTime: absT(e.startI), endTime: absT(e.endI), peakTime: absT(e.peakI),
        severity: e.peak >= s.criticalDeg ? 'critical' : 'warning',
        label: 'Knock event', message: 'Peak ' + round1(e.peak) + '° knock retard',
        channelIds: total ? ['total_knock'] : undefined,
        values: rpm && rpm[e.peakI] != null ? { rpm: Math.round(rpm[e.peakI]), knockDeg: round1(e.peak) } : { knockDeg: round1(e.peak) } };
    });
    var peakI = -1; for (var pk = 0; pk < events.length; pk++) if (peakI < 0 || events[pk].peak > events[peakI].peak) peakI = pk;
    var details = [
      peakI >= 0 ? { label: 'Peak knock', value: round1(peak) + '°', time: absT(events[peakI].peakI), startTime: absT(events[peakI].startI), endTime: absT(events[peakI].endI) } : { label: 'Peak knock', value: round1(peak) + '°' },
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
    optionalChannels: [{ role: 'engine_rpm' }, { role: 'throttle_position' }, { role: 'accelerator_pedal_position' }, { role: 'actual_load' }, { role: 'boost_pressure' }, { role: 'spark_advance' }],
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
  // WOT lambda targets, "or richer" (Ken, 2026-09-09): NA .85 pump / .88 E or race; EcoBoost .82 / .86;
  // FI .80 / .83. The card's pulldowns (ctx.profile) pick the row; `targetOverride` forces a number.
  var WOT_TARGETS = { na: { pump: 0.85, e: 0.88, race: 0.88 }, eco: { pump: 0.82, e: 0.86, race: 0.86 }, fi: { pump: 0.80, e: 0.83, race: 0.83 } };
  var FUELING_DEFAULTS = {
    profile: 'auto',                 // legacy per-category override: 'auto' | 'fi' | 'na' | 'ecoboost' (the card's pulldown is the normal way)
    targetOverride: null,            // force one WOT lambda target (or richer) regardless of profile
    richMargin: 0.10,                // richer than target - richMargin = richer than needed (mild)
    cruiseTarget: 1.0, cruiseTol: 0.04,   // lambda target + deadband at cruise
    cmdStoichTol: 0.05,              // cruise is only scored while the PCM commands stoich: a lean decel command
                                     // (1.2-1.3) or cat-protect enrichment makes the trims chase the command, not the base table
    wotPedalThreshold: 80,           // driver demand (accelerator pedal) is WOT-authoritative: a torque-managed throttle
                                     // blade closes to 60-75% under boost while the pedal is floored
    wotAirLoadThreshold: 95,         // no pedal: air load at/above this (%) also counts as WOT
    cruisePedalMin: 2, cruisePedalMax: 45,
    wotMinRunSec: 0.6,               // a WOT run must last this long AFTER settling to carry the score
    leanSpikeMargin: 0.06, spikePenaltyMax: 15,   // brief lean spikes inside settled WOT: listed, mildly penalised
    peDelaySec: 0.4, peDelayPerSec: 10, peDelayPenaltyMax: 10,   // commanded lambda still ~stoich this long after WOT onset
    trimTolPct: 8, trimPenaltyMax: 70,    // |STFT+LTFT| at STEADY cruise: tolerance + penalty cap. Driven by the
                                          // WORST steady trim (a tuner reads the peak): ~18% -> ~73, ~25% -> ~54, ~30% -> ~40.
    commandedTol: 0.03, commandedPenaltyMax: 25,
    wotLoadThreshold: 80, cruiseLoadMin: 5, cruiseLoadMax: 45, rpmFloor: 1200, boostThreshold: 2,
    wotSettleSec: 0.8,               // ignore the first N s after WOT onset -- the power-enrichment
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
  /** The WOT lambda target ("or richer") for an induction + fuel, from the settings table. */
  function wotTargetFor(induction, fuel, s) {
    if (s && s.targetOverride != null && isFinite(s.targetOverride) && s.targetOverride > 0) return s.targetOverride;
    var tbl = (s && s.targets) || WOT_TARGETS, row = tbl[induction] || tbl.fi || WOT_TARGETS.fi;
    var t = row[fuel]; if (t == null) t = row.pump;
    return t;
  }
  /** Resolve the induction profile + WOT window. `cardProfile` (ctx.profile, from the card's pulldowns)
   *  wins over the legacy per-category setting, which wins over the last-resort boost guess. */
  function fuelProfile(settingProfile, vehiclePlatformCategory, peakBoost, s, cardProfile) {
    var p = String(settingProfile || 'auto').toLowerCase();
    if (p === 'ecoboost') p = 'eco';
    var fuel = 'pump', source = 'setting';
    if (cardProfile && cardProfile.induction && (p === 'auto' || !p)) { p = cardProfile.induction; source = cardProfile.inductionAuto ? 'auto' : 'card'; }
    if (cardProfile && cardProfile.fuel) fuel = cardProfile.fuel;
    if (p !== 'fi' && p !== 'na' && p !== 'eco') {
      var pc = String(vehiclePlatformCategory || '').toLowerCase();
      if (/eco/.test(pc)) p = 'eco';
      else if (/turbo|super|boost|forced|\bfi\b/.test(pc)) p = 'fi';
      else if (/\bna\b|natural|aspir/.test(pc)) p = 'na';
      else p = peakBoost > s.boostThreshold ? 'fi' : 'na';   // last resort: boosted => FI
      source = 'auto';
    }
    var top = wotTargetFor(p, fuel, s);
    return { profile: p, fuel: fuel, top: top, floor: Math.round((top - (s.richMargin != null ? s.richMargin : 0.10)) * 100) / 100, source: source,
      label: (p === 'eco' ? 'EcoBoost' : p.toUpperCase()) + ' · ' + (fuel === 'e' ? 'ethanol' : fuel === 'race' ? 'race gas' : 'pump gas') };
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
        ped = ctx.rangeSeries('accelerator_pedal_position'),
        load = ctx.rangeSeries('actual_load'), boost = ctx.rangeSeries('boost_pressure');
    var N = (lam1 || afr1 || lam2 || afr2 || []).length;
    var peakBoost = 0; if (boost) for (var b = 0; b < boost.length; b++) if (boost[b] > peakBoost) peakBoost = boost[b];
    var prof = fuelProfile(s.profile, ctx.vehicle && ctx.vehicle.platformCategory, peakBoost, s, ctx.profile || null);

    function loadPct(i) {
      if (thr && thr[i] != null && isFinite(thr[i])) return thr[i];
      if (load && load[i] != null && isFinite(load[i])) return load[i] <= 1.5 ? load[i] * 100 : load[i];
      return null;
    }
    function airLoadPct(i) { if (!load || load[i] == null || !isFinite(load[i])) return null; return load[i] <= 1.5 ? load[i] * 100 : load[i]; }
    function demandPct(i) { return (ped && ped[i] != null && isFinite(ped[i])) ? ped[i] : null; }
    function aboveIdle(i) { return !(rpm && rpm[i] != null && isFinite(rpm[i]) && rpm[i] < s.rpmFloor); }
    // Power enrichment follows DRIVER DEMAND. The accelerator pedal is authoritative when logged: on a
    // torque-managed engine (EcoBoost) the throttle blade closes to 60-75% under boost while the pedal
    // is floored, so throttle alone chops a 6 s pull into 0.1 s fragments (Ken's "drive home popcorn"
    // log, 2026-09-09). Without a pedal: throttle, then air load, and boost only as the last resort
    // (boost alone is NOT WOT -- a car can make 2+ psi at 40% throttle while spooling).
    function isWOT(i) {
      if (!aboveIdle(i)) return false;
      var d = demandPct(i); if (d != null) return d >= s.wotPedalThreshold;
      var lp = loadPct(i);
      if (lp != null) { if (lp >= s.wotLoadThreshold) return true; var al = airLoadPct(i); return al != null && al >= s.wotAirLoadThreshold; }
      return boost && boost[i] != null && boost[i] >= s.boostThreshold;
    }
    // Closed-loop cruise: the PCM must be commanding stoich (a lean decel command or cat-protect
    // enrichment makes the trims chase the COMMAND, not the base table -- that is where the 28.9 % trim
    // on the popcorn log came from: foot off, throttle blade 5.7 %, commanded 1.2), boost off, and the
    // driver's foot on the pedal (or, without a pedal, throttle in the cruise band).
    function cmdStoich(i) { if (!cmd) return true; var c = cmd[i]; if (c == null || !isFinite(c) || c <= 0) return true; return Math.abs(c - s.cruiseTarget) <= s.cmdStoichTol; }
    function isCruise(i) {
      if (!aboveIdle(i)) return false;
      if (boost && boost[i] != null && boost[i] >= s.boostThreshold) return false;
      if (!cmdStoich(i)) return false;
      var d = demandPct(i); if (d != null) return d >= s.cruisePedalMin && d <= s.cruisePedalMax;
      var lp = loadPct(i); return lp != null && lp >= s.cruiseLoadMin && lp <= s.cruiseLoadMax;
    }
    function valid(L) { return L != null && isFinite(L) && L >= s.minValidLambda && L <= s.maxValidLambda; }   // drop sensor sentinels / DFCO
    function bankLambda(l, a, i) { var L = fuelLambdaAt(l, a, i, s.stoichAFR); return valid(L) ? L : null; }
    var dt = (ctx.time[startIdx + 1] - ctx.time[startIdx]) || 0.05;
    var stWin = Math.max(1, Math.round(s.steadyWindowSec / dt));
    // "steady" = the operating point isn't moving. Trims + cruise lambda swing hard during any transition
    // (tip-in/out, load change) as closed loop chases the change; only steady-state reflects the base table.
    function steadySig(i) { var d = demandPct(i); return d != null ? d : loadPct(i); }
    function steady(i) { if (i < stWin) return false; var a = steadySig(i), b = steadySig(i - stWin); if (a == null || b == null) return true; return Math.abs(a - b) <= s.steadyRatePct; }

    var wot = { lean: [], rich: [], leanI: [], worstLeanVal: 0, worstLeanI: -1, cmdExcSum: 0, cmdN: 0, imbalWorst: 0, imbalWorstI: -1, transitionSkipped: 0,
      runs: [], onsets: [] };
    var cru = { n: 0, excSum: 0, excWorst: 0, excWorstI: -1, trims: [], trimWorst: 0, trimWorstI: -1, cmdExcSum: 0, cmdN: 0, imbalWorst: 0, imbalWorstI: -1, transitionSkipped: 0 };
    var k, wotRunStart = null, cruiseRunStart = null, curRun = null, onset = null;
    for (var i = 0; i < N; i++) {
      // Classify first (run-lengths must track continuously even across invalid-lambda samples). A WOT sample
      // only counts once held past the settle time (the power-enrichment transition reads lean but isn't a fault);
      // a cruise sample only counts once held past its settle time AND the throttle/load is steady.
      var tAbs = ctx.time[startIdx + i], settledWot = false, steadyCruise = false;
      if (isWOT(i)) {
        cruiseRunStart = null;
        if (wotRunStart == null) {
          wotRunStart = tAbs;
          // PE delay: how long the PCM keeps commanding ~stoich after the pedal goes down
          onset = { i: i, t: tAbs, cmdStoichUntil: null, done: !cmd };
          wot.onsets.push(onset);
        }
        if (onset && !onset.done) {
          var oc = cmd[i];
          if (oc != null && isFinite(oc) && oc > 0 && oc < s.cruiseTarget - s.cmdStoichTol) { onset.done = true; onset.cmdStoichUntil = tAbs; }
        }
        if (tAbs - wotRunStart >= s.wotSettleSec) {
          settledWot = true;
          if (!curRun) { curRun = { startI: i, endI: i, lams: [], startT: tAbs, endT: tAbs }; wot.runs.push(curRun); }
          curRun.endI = i; curRun.endT = tAbs;
        }
      } else if (isCruise(i)) {
        wotRunStart = null; curRun = null; onset = null;
        if (cruiseRunStart == null) cruiseRunStart = tAbs;
        if (tAbs - cruiseRunStart >= s.cruiseSettleSec && steady(i)) steadyCruise = true;
      } else {
        wotRunStart = null; cruiseRunStart = null; curRun = null; onset = null;
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
        wot.lean.push(leanest); wot.rich.push(richest); wot.leanI.push(i);
        if (curRun) curRun.lams.push(leanest);
        if (leanest > wot.worstLeanVal) { wot.worstLeanVal = leanest; wot.worstLeanI = i; }
        if (imb != null && imb > wot.imbalWorst) { wot.imbalWorst = imb; wot.imbalWorstI = i; }
        if (cmdExc != null) { wot.cmdExcSum += cmdExc; wot.cmdN++; }
      } else {
        cru.n++;
        var avg = 0; for (k = 0; k < vals.length; k++) avg += vals[k]; avg /= vals.length;
        var exc = Math.max(0, Math.abs(avg - s.cruiseTarget) - s.cruiseTol);
        cru.excSum += exc;
        if (exc > cru.excWorst) { cru.excWorst = exc; cru.excWorstI = i; }
        if (imb != null && imb > cru.imbalWorst) { cru.imbalWorst = imb; cru.imbalWorstI = i; }
        if (cmdExc != null) { cru.cmdExcSum += cmdExc; cru.cmdN++; }
        if (haveTrim) {
          var t1 = (stft1 && stft1[i] != null ? stft1[i] : 0) + (ltft1 && ltft1[i] != null ? ltft1[i] : 0);
          var t2 = (stft2 && stft2[i] != null ? stft2[i] : 0) + (ltft2 && ltft2[i] != null ? ltft2[i] : 0);
          var tw = Math.max(Math.abs(t1), Math.abs(t2));
          cru.trims.push(tw);
          if (tw > cru.trimWorst) { cru.trimWorst = tw; cru.trimWorstI = i; }
        }
      }
    }
    return { s: s, startIdx: startIdx, N: N, prof: prof, usedAfr: usedAfr, haveB1: haveB1, haveB2: haveB2,
      haveTrim: haveTrim, hasCmd: !!cmd, wot: wot, cru: cru,
      absT: function (i) { return ctx.time[startIdx + i]; },
      range: { start: ctx.time[startIdx], end: ctx.time[startIdx + N - 1] } };
  }

  // ---- WOT Fueling: open-loop power enrichment vs the induction lambda window -------------------
  function median(sortedAsc) { return pct(sortedAsc, 0.5); }
  function computeFuelingWot(ctx) {
    var c = collectFueling(ctx), s = c.s, prof = c.prof, w = c.wot, both = c.haveB1 && c.haveB2;
    if (!w.lean.length) {
      return { score: null, status: 'not_evaluated',
        unavailableReason: w.transitionSkipped ? 'Only brief WOT tip-ins found — all within the power-enrichment transition (nothing held past ' + s.wotSettleSec + 's).' : 'No wide-open-throttle / power-enrichment operation found in the selected range.',
        summary: 'WOT Fueling scores open-loop power enrichment; no settled WOT was found here.' };
    }
    var target = prof.top;
    // Score SUSTAINED runs: each settled WOT stretch that lasts >= wotMinRunSec gets a median; the worst
    // run median carries the lean check. A lone lean sample (a percentile of 45 samples is 2 samples) no
    // longer decides the score -- it is listed as a spike instead (Ken's popcorn log: p95 0.99 = 0).
    var runs = w.runs.map(function (r) { var sl = r.lams.slice().sort(fAsc); return { startT: r.startT, endT: r.endT, startI: r.startI, endI: r.endI, n: sl.length, med: median(sl), max: sl.length ? sl[sl.length - 1] : null, dur: r.endT - r.startT }; })
      .filter(function (r) { return r.n > 0; });
    var scored = runs.filter(function (r) { return r.dur >= s.wotMinRunSec; });
    var brief = runs.length - scored.length, usedRuns = scored.length ? scored : runs;
    var worstRun = null; usedRuns.forEach(function (r) { if (!worstRun || r.med > worstRun.med) worstRun = r; });
    var sL = w.lean.slice().sort(fAsc), sR = w.rich.slice().sort(fAsc);
    var p50 = median(sL), p05 = pct(sR, s.wotRichPct), leanest = sL[sL.length - 1];
    var leanPen = Math.max(0, worstRun.med - target) * s.wotLeanPerLambda;   // leaner than target at WOT = detonation risk
    var richPen = Math.max(0, prof.floor - p05) * s.wotRichPerLambda;         // richer than needed = safe-but-wasteful
    var cmdPen = w.cmdN ? Math.min(s.commandedPenaltyMax, (w.cmdExcSum / w.cmdN) * s.commandedPerLambda) : 0;
    var imbalPen = (both && w.imbalWorst > s.imbalanceTol) ? Math.min(s.imbalancePenaltyMax, (w.imbalWorst - s.imbalanceTol) * s.imbalancePerLambda) : 0;
    // lean spikes inside settled WOT (individual samples well above target)
    var spikes = [], spikeLimit = target + s.leanSpikeMargin;
    for (var q = 0; q < w.lean.length; q++) if (w.lean[q] > spikeLimit) spikes.push({ i: w.leanI[q], v: w.lean[q] });
    var spikePen = spikes.length ? Math.min(s.spikePenaltyMax, (spikes.length / w.lean.length) * 100) : 0;
    // PE delay: the PCM kept commanding ~stoich after the pedal went down (lean under rising boost)
    var delays = w.onsets.filter(function (o) { return o.cmdStoichUntil != null && (o.cmdStoichUntil - o.t) > s.peDelaySec; })
      .map(function (o) { return { t: o.t, until: o.cmdStoichUntil, i: o.i, dur: o.cmdStoichUntil - o.t }; });
    var worstDelay = null; delays.forEach(function (d) { if (!worstDelay || d.dur > worstDelay.dur) worstDelay = d; });
    var delayPen = worstDelay ? Math.min(s.peDelayPenaltyMax, (worstDelay.dur - s.peDelaySec) * s.peDelayPerSec) : 0;
    var score = fClamp(100 - leanPen - richPen - cmdPen - imbalPen - spikePen - delayPen);

    var evidence = [], isLean = worstRun.med > target, isRich = p05 < prof.floor;
    if (isLean) evidence.push({ startTime: worstRun.startT, endTime: worstRun.endT, peakTime: c.absT(w.worstLeanI >= 0 ? w.worstLeanI : worstRun.startI), severity: (worstRun.med - target) > 0.04 ? 'critical' : 'warning',
      label: 'Lean at WOT', message: 'WOT run median lambda ' + lam2(worstRun.med) + ' vs target ≤' + lam2(target) + ' (' + prof.label + ')', values: { runMedian: +lam2(worstRun.med), target: target } });
    spikes.slice().sort(function (a, b) { return b.v - a.v; }).slice(0, 2).forEach(function (sp) {
      evidence.push({ startTime: c.absT(sp.i), peakTime: c.absT(sp.i), severity: 'warning', label: 'Lean spike at WOT', message: 'lambda ' + lam2(sp.v) + ' for a moment (' + spikes.length + ' sample' + (spikes.length === 1 ? '' : 's') + ' over ' + lam2(spikeLimit) + ')', values: { lambda: +lam2(sp.v) } });
    });
    if (worstDelay) evidence.push({ startTime: worstDelay.t, endTime: worstDelay.until, peakTime: worstDelay.until, severity: worstDelay.dur > 1 ? 'critical' : 'warning',
      label: 'Slow into power enrichment', message: 'Commanded lambda stayed near stoich for ' + (Math.round(worstDelay.dur * 10) / 10) + ' s after WOT onset' + (delays.length > 1 ? ' (' + delays.length + ' times)' : ''), values: { delaySec: Math.round(worstDelay.dur * 10) / 10 } });
    if (both && w.imbalWorst > s.imbalanceTol) evidence.push({ startTime: c.absT(w.imbalWorstI >= 0 ? w.imbalWorstI : 0), peakTime: c.absT(w.imbalWorstI >= 0 ? w.imbalWorstI : 0), severity: w.imbalWorst > 0.1 ? 'critical' : 'warning',
      label: 'Bank imbalance at WOT', message: 'Bank 1 / Bank 2 lambda differ by ' + lam2(w.imbalWorst) + ' at WOT', values: { spread: +lam2(w.imbalWorst) } });

    var details = [
      { label: 'Target', value: '≤ ' + lam2(target) + ' (' + prof.label + ')' },
      { label: 'Banks', value: fBanks(c) },
      { label: 'WOT lambda (median / leanest)', value: lam2(p50) + ' / ' + lam2(leanest), time: c.absT(w.worstLeanI >= 0 ? w.worstLeanI : 0) },
      { label: 'WOT runs', value: usedRuns.length + ' scored (worst median ' + lam2(worstRun.med) + ', ' + (Math.round(worstRun.dur * 10) / 10) + ' s)' + (brief ? ', ' + brief + ' too brief' : ''), time: worstRun.startT, startTime: worstRun.startT, endTime: worstRun.endT },
      { label: 'WOT samples', value: grp(w.lean.length) + (w.transitionSkipped ? ' (' + grp(w.transitionSkipped) + ' transition skipped)' : '') },
      { label: 'Fuel source', value: c.usedAfr ? 'AFR (converted @' + s.stoichAFR + ')' : 'measured lambda' },
      { label: 'Commanded', value: w.cmdN ? 'compared (' + grp(w.cmdN) + ' samples)' : 'not logged' }
    ];
    if (both) details.push({ label: 'Worst bank spread', value: lam2(w.imbalWorst), time: c.absT(w.imbalWorstI >= 0 ? w.imbalWorstI : 0) });
    var warnings = [];
    if (c.usedAfr) warnings.push('No lambda channel; converted AFR using stoich ' + s.stoichAFR + ' (set stoichAFR for non-gasoline fuel).');
    if (prof.source === 'auto') warnings.push('Engine type auto-detected as ' + prof.label + '; use the Type / Fuel pulldowns if that is wrong.');
    if (!c.hasCmd) warnings.push('Commanded lambda not logged — measured-vs-commanded check skipped.');
    if (!scored.length) warnings.push('Only brief WOT bursts (none held ' + s.wotMinRunSec + ' s past settling); low confidence.');
    var summary = (isLean
      ? 'Runs lean at WOT (run median ' + lam2(worstRun.med) + ' vs ≤' + lam2(target) + ' for ' + prof.label + ').'
      : 'WOT lambda at or richer than the ' + lam2(target) + ' target for ' + prof.label + ' (median ' + lam2(p50) + ') over ' + usedRuns.length + ' run' + (usedRuns.length === 1 ? '' : 's') + '.')
      + (spikes.length ? ' ' + spikes.length + ' lean spike' + (spikes.length === 1 ? '' : 's') + '.' : '')
      + (worstDelay ? ' Slow into power enrichment (' + (Math.round(worstDelay.dur * 10) / 10) + ' s).' : '')
      + (isRich ? ' Richer than needed at times (down to ' + lam2(p05) + ').' : '')
      + (both && w.imbalWorst > s.imbalanceTol ? ' Bank spread up to ' + lam2(w.imbalWorst) + '.' : '');
    var conf = Math.max(0.3, Math.min(1, w.lean.length / (s.minSamples * 5))) * (scored.length ? 1 : 0.6);
    return { score: score, confidence: conf, summary: summary,
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
    var evidence = [], tWorst = cr.trimWorstI >= 0 ? c.absT(cr.trimWorstI) : null;
    if (highTrim) evidence.push({ startTime: tWorst != null ? tWorst : c.absT(0), peakTime: tWorst, severity: trimWorst > 20 ? 'critical' : 'warning',
      label: 'High fuel trims', message: 'Steady-cruise fuel trim (STFT+LTFT) reaches ' + round1(trimWorst) + '% vs tol ' + s.trimTolPct + '%', values: { worstTrimPct: round1(trimWorst), typicalTrimPct: round1(trimTyp) } });
    if (offStoich && cr.excWorstI >= 0) evidence.push({ startTime: c.absT(cr.excWorstI), peakTime: c.absT(cr.excWorstI), severity: cr.excWorst > 0.1 ? 'critical' : 'warning',
      label: 'Cruise off stoich', message: 'Cruise lambda ' + (Math.round((cr.excWorst + s.cruiseTol) * 100) / 100) + ' away from ' + lam2(s.cruiseTarget) + ' at worst', values: { worstExcess: round1(cr.excWorst) } });
    if (both && cr.imbalWorst > s.imbalanceTol && cr.imbalWorstI >= 0) evidence.push({ startTime: c.absT(cr.imbalWorstI), peakTime: c.absT(cr.imbalWorstI), severity: cr.imbalWorst > 0.1 ? 'critical' : 'warning',
      label: 'Bank imbalance at cruise', message: 'Bank 1 / Bank 2 lambda differ by ' + lam2(cr.imbalWorst) + ' at steady cruise', values: { spread: +lam2(cr.imbalWorst) } });
    var details = [
      { label: 'Cruise lambda target', value: lam2(s.cruiseTarget) + ' ±' + s.cruiseTol },
      { label: 'Banks', value: fBanks(c) },
      { label: 'Steady-cruise samples', value: grp(cr.n) + (cr.transitionSkipped ? ' (' + grp(cr.transitionSkipped) + ' transition skipped)' : '') },
      trimN ? { label: 'Fuel trims', value: 'typical ' + round1(trimTyp) + '%, worst ' + round1(trimWorst) + '%', time: tWorst } : { label: 'Fuel trims', value: 'not logged' },
      { label: 'Fuel source', value: c.usedAfr ? 'AFR (converted @' + s.stoichAFR + ')' : 'measured lambda' },
      { label: 'Commanded', value: cr.cmdN ? 'compared (' + grp(cr.cmdN) + ' samples)' : 'not logged' }
    ];
    if (both) details.push({ label: 'Worst bank spread', value: lam2(cr.imbalWorst), time: cr.imbalWorstI >= 0 ? c.absT(cr.imbalWorstI) : null });
    var warnings = [];
    if (c.usedAfr) warnings.push('No lambda channel; converted AFR using stoich ' + s.stoichAFR + ' (set stoichAFR for non-gasoline fuel).');
    if (!c.haveTrim) warnings.push('Fuel trims not logged — part-throttle scored from lambda only. Log STFT/LTFT for a fuller picture.');
    if (c.hasCmd) warnings.push('Samples where the PCM commanded off stoich (decel lean, enrichment) are not scored as cruise.');
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
    optionalChannels: [{ role: 'commanded_lambda' }, { role: 'engine_rpm' }, { role: 'accelerator_pedal_position' }, { role: 'throttle_position' }, { role: 'actual_load' }, { role: 'boost_pressure' }],
    defaultSettings: extend(FUELING_DEFAULTS, null),
    evaluate: computeFuelingWot
  });
  SC.registerEvaluator({
    id: 'fueling_part', name: 'Part-Throttle Fueling',
    description: 'Closed-loop cruise: lambda held near stoich with small fuel trims (STFT+LTFT, both banks). Large trims mean the base fuel table is off. First-pass model -- validate + tune on real logs.',
    status: 'experimental', evaluatorVersion: '0.9.0',
    requiredChannels: [],
    requiredAnyOf: FUEL_ANYOF,
    optionalChannels: [{ role: 'stft_bank_1' }, { role: 'ltft_bank_1' }, { role: 'stft_bank_2' }, { role: 'ltft_bank_2' }, { role: 'commanded_lambda' }, { role: 'engine_rpm' }, { role: 'accelerator_pedal_position' }, { role: 'throttle_position' }, { role: 'actual_load' }],
    defaultSettings: extend(FUELING_DEFAULTS, null),
    evaluate: computeFuelingPart
  });

  // Pure helpers for tests (dev/knock-test.js, dev/fueling-test.js).
  // ===============================================================================================
  // SHARED REGION HELPERS for the remaining categories (idle, shift, fuel pressure, boost, throttle,
  // temps, consistency). Every threshold below is a `settings` entry so it can be tuned from the card's
  // configuration dialog (Ken, 2026-09-09: "add some basic parameters to the other categories so we can
  // fine tune those"). First-pass, status 'experimental' -- not a finalized PBD standard.
  // ===============================================================================================
  function fin(v) { return v != null && isFinite(v); }
  function mean(a) { var s = 0, n = 0; for (var i = 0; i < a.length; i++) if (fin(a[i])) { s += a[i]; n++; } return n ? s / n : null; }
  function stdev(a) { var m = mean(a); if (m == null) return null; var s = 0, n = 0; for (var i = 0; i < a.length; i++) if (fin(a[i])) { s += (a[i] - m) * (a[i] - m); n++; } return n > 1 ? Math.sqrt(s / n) : 0; }
  function rangeOf(ctx) {
    var startIdx = ctx.range.startIdx || 0;
    return { startIdx: startIdx, absT: function (i) { return ctx.time[startIdx + i]; },
      range: { startIdx: startIdx, endIdx: ctx.range.endIdx, startTime: ctx.time[startIdx], endTime: ctx.time[ctx.range.endIdx] } };
  }
  function notEval(reason, summary) { return { score: null, status: 'not_evaluated', unavailableReason: reason, summary: summary || '' }; }
  /** Driver demand: pedal preferred (a torque-managed blade lies under boost), throttle, then air load. */
  function demandSeries(ctx) {
    var ped = ctx.rangeSeries('accelerator_pedal_position'), thr = ctx.rangeSeries('throttle_position'), load = ctx.rangeSeries('actual_load');
    return { ped: ped, thr: thr, load: load, source: ped ? 'pedal' : thr ? 'throttle' : load ? 'engine load' : null,
      at: function (i) {
        if (ped && fin(ped[i])) return ped[i];
        if (thr && fin(thr[i])) return thr[i];
        if (load && fin(load[i])) return load[i] <= 1.5 ? load[i] * 100 : load[i];
        return null;
      } };
  }
  /** Contiguous stretches where pred(i) holds. Each run is trimmed by settleSec at its start; `brief` runs
   *  never settled or lasted < minRunSec after settling. */
  function runsWhere(N, pred, absT, settleSec, minRunSec) {
    var runs = [], start = -1;
    function push(a, b) {
      var t0 = absT(a), k = a;
      while (k <= b && absT(k) - t0 < settleSec) k++;
      if (k > b) { runs.push({ startI: a, endI: b, settledI: -1, onsetT: t0, startT: t0, endT: absT(b), dur: 0, brief: true }); return; }
      var r = { startI: a, endI: b, settledI: k, onsetT: t0, startT: absT(k), endT: absT(b), dur: absT(b) - absT(k), brief: false };
      if (r.dur < minRunSec) r.brief = true;
      runs.push(r);
    }
    for (var i = 0; i <= N; i++) {
      var on = i < N && pred(i);
      if (on && start < 0) start = i;
      if (!on && start >= 0) { push(start, i - 1); start = -1; }
    }
    return runs;
  }
  function tempIsC(ctx, role) { var u = String(ctx.unitFor(role) || '').toLowerCase(); return u.indexOf('c') >= 0 && u.indexOf('f') < 0; }
  function toF(v, isC) { return isC ? v * 9 / 5 + 32 : v; }
  function degF(v) { return Math.round(v) + ' °F'; }
  function rpmFloorOk(rpm, i, floor) { return !(rpm && fin(rpm[i]) && rpm[i] < floor); }

  // ===============================================================================================
  // IDLE QUALITY -- RPM stability while idling (foot off, stopped, in the idle band). The worst idle
  //   period's std-dev carries the score; dips (stall risk) add up across periods. Cold idle (ECT below
  //   coldEct) is reported but not scored.
  // ===============================================================================================
  var IDLE_DEFAULTS = {
    pedalMax: 1, throttleMax: 4, speedMax: 1, rpmMin: 400, rpmMax: 1400,
    settleSec: 1.5, minRunSec: 3,
    stdTolRpm: 15, stdPerRpm: 1.2, stdPenaltyMax: 50,
    rangeTolRpm: 80, rangePerRpm: 0.25, rangePenaltyMax: 30,
    dipRpm: 120, dipPoints: 6, dipPenaltyMax: 30,
    coldEct: 140
  };
  var IDLE_META = {
    pedalMax: ['Foot-off pedal', '%', 'Pedal at/below this = foot off'], throttleMax: ['Foot-off throttle', '%', 'Used when no pedal is logged'],
    speedMax: ['Stopped speed', 'mph', 'Speed at/below this = stopped'], rpmMin: ['Idle band low', 'rpm'], rpmMax: ['Idle band high', 'rpm'],
    settleSec: ['Settle', 's', 'Ignore the first seconds of each idle period'], minRunSec: ['Minimum period', 's', 'Shorter idle periods are not scored'],
    stdTolRpm: ['Std-dev free', 'rpm'], stdPerRpm: ['Points per rpm std-dev', 'pts'], stdPenaltyMax: ['Std-dev penalty cap', 'pts'],
    rangeTolRpm: ['Swing free', 'rpm', 'Peak-to-peak within a period'], rangePerRpm: ['Points per rpm swing', 'pts'], rangePenaltyMax: ['Swing penalty cap', 'pts'],
    dipRpm: ['Dip depth', 'rpm', 'Drop below the period median that counts as a dip'], dipPoints: ['Points per dip', 'pts'], dipPenaltyMax: ['Dip penalty cap', 'pts'],
    coldEct: ['Cold idle below', '°F', 'Colder samples are skipped']
  };
  function computeIdle(ctx) {
    var s = extend(IDLE_DEFAULTS, ctx.settings), R = rangeOf(ctx);
    var rpm = ctx.rangeSeries('engine_rpm'); if (!rpm) return notEval('Engine RPM not logged.');
    var N = rpm.length;
    var ped = ctx.rangeSeries('accelerator_pedal_position'), thr = ctx.rangeSeries('throttle_position'), spd = ctx.rangeSeries('vehicle_speed'), ect = ctx.rangeSeries('engine_coolant_temp');
    var ectC = !!(ect && tempIsC(ctx, 'engine_coolant_temp'));
    function footOff(i) { if (ped) return fin(ped[i]) && ped[i] <= s.pedalMax; if (thr) return fin(thr[i]) && thr[i] <= s.throttleMax; return true; }
    function stopped(i) { return !spd || !fin(spd[i]) || spd[i] <= s.speedMax; }
    function isIdle(i) { var v = rpm[i]; return fin(v) && v >= s.rpmMin && v <= s.rpmMax && footOff(i) && stopped(i); }
    var runs = runsWhere(N, isIdle, R.absT, s.settleSec, s.minRunSec).filter(function (r) { return !r.brief; });
    if (!runs.length) return notEval('No idle period held ' + round1(s.settleSec + s.minRunSec) + ' s (foot off' + (spd ? ', stopped' : '') + ', ' + s.rpmMin + '–' + s.rpmMax + ' rpm).', 'Idle Quality scores RPM stability while idling; no settled idle found here.');
    var per = [], cold = 0;
    runs.forEach(function (r) {
      var vals = [], coldN = 0, i;
      for (i = r.settledI; i <= r.endI; i++) { if (!fin(rpm[i])) continue; if (ect && fin(ect[i]) && toF(ect[i], ectC) < s.coldEct) { coldN++; continue; } vals.push(rpm[i]); }
      cold += coldN;
      if (vals.length < 10) return;
      var sorted = vals.slice().sort(fAsc), med = pct(sorted, 0.5), mn = sorted[0], mx = sorted[sorted.length - 1];
      var dips = 0, dipI = -1, dipV = Infinity, inDip = false;
      for (i = r.settledI; i <= r.endI; i++) { var v = rpm[i]; if (!fin(v)) continue; var low = v < med - s.dipRpm; if (low && !inDip) dips++; inDip = low; if (v < dipV) { dipV = v; dipI = i; } }
      // std-dev over the samples NOT in a dip: a stall-dip is scored once, as a dip, not again as spread
      var steadyVals = vals.filter(function (v) { return v >= med - s.dipRpm; });
      if (steadyVals.length < 10) steadyVals = vals;
      var smn = Math.min.apply(null, steadyVals), smx = Math.max.apply(null, steadyVals);
      per.push({ r: r, n: vals.length, med: med, sd: stdev(steadyVals), range: smx - smn, min: smn, max: smx, dips: dips, dipI: dipI, dipV: dipV });
    });
    if (!per.length) return notEval('Idle found only while cold (ECT below ' + s.coldEct + ' °F); warm idle not reached.', 'Idle Quality scores warm idle; this log only idles cold.');
    var worst = per[0], worstRange = per[0], totalDips = 0, worstDip = null, totalN = 0, totalDur = 0;
    per.forEach(function (p) { if (p.sd > worst.sd) worst = p; if (p.range > worstRange.range) worstRange = p; totalDips += p.dips; if (p.dips && (!worstDip || p.dipV < worstDip.dipV)) worstDip = p; totalN += p.n; totalDur += p.r.dur; });
    var stdPen = Math.min(s.stdPenaltyMax, Math.max(0, worst.sd - s.stdTolRpm) * s.stdPerRpm);
    var rangePen = Math.min(s.rangePenaltyMax, Math.max(0, worstRange.range - s.rangeTolRpm) * s.rangePerRpm);
    var dipPen = Math.min(s.dipPenaltyMax, totalDips * s.dipPoints);
    var score = fClamp(100 - stdPen - rangePen - dipPen);
    var evidence = [];
    if (stdPen > 0) evidence.push({ startTime: worst.r.startT, endTime: worst.r.endT, peakTime: R.absT(worst.dipI >= 0 ? worst.dipI : worst.r.settledI), severity: worst.sd > s.stdTolRpm * 3 ? 'critical' : 'warning',
      label: 'Unsteady idle', message: 'RPM ±' + round1(worst.sd) + ' (std-dev) around ' + Math.round(worst.med) + ' rpm over ' + round1(worst.r.dur) + ' s', values: { stdRpm: round1(worst.sd), medianRpm: Math.round(worst.med) } });
    if (worstDip) evidence.push({ startTime: R.absT(worstDip.dipI), peakTime: R.absT(worstDip.dipI), severity: worstDip.dipV < worstDip.med - 2 * s.dipRpm ? 'critical' : 'warning',
      label: 'Idle dip', message: 'RPM fell to ' + Math.round(worstDip.dipV) + ' (' + Math.round(worstDip.med - worstDip.dipV) + ' below the ' + Math.round(worstDip.med) + ' rpm idle)' + (totalDips > 1 ? ', ' + totalDips + ' dips in all' : ''), values: { dipRpm: Math.round(worstDip.dipV) } });
    if (rangePen > 0 && worstRange !== worst) evidence.push({ startTime: worstRange.r.startT, endTime: worstRange.r.endT, peakTime: worstRange.r.startT, severity: 'warning',
      label: 'Wide idle swing', message: Math.round(worstRange.min) + '–' + Math.round(worstRange.max) + ' rpm within one idle period', values: { rangeRpm: Math.round(worstRange.range) } });
    var meds = per.map(function (p) { return p.med; }).sort(fAsc);
    var details = [
      { label: 'Idle periods', value: per.length + ' scored (' + round1(totalDur) + ' s)' + (cold ? ', cold samples skipped' : '') },
      { label: 'Idle speed (median)', value: Math.round(pct(meds, 0.5)) + ' rpm' + (meds.length > 1 ? ' (' + Math.round(meds[0]) + '–' + Math.round(meds[meds.length - 1]) + ')' : '') },
      { label: 'Worst std-dev', value: '±' + round1(worst.sd) + ' rpm', time: worst.r.startT, startTime: worst.r.startT, endTime: worst.r.endT },
      { label: 'Worst swing', value: Math.round(worstRange.range) + ' rpm', time: worstRange.r.startT, startTime: worstRange.r.startT, endTime: worstRange.r.endT },
      { label: 'Dips', value: totalDips ? totalDips + ' (lowest ' + Math.round(worstDip.dipV) + ' rpm)' : 'none', time: worstDip ? R.absT(worstDip.dipI) : null },
      { label: 'Idle detected by', value: (ped ? 'pedal ≤ ' + s.pedalMax + ' %' : thr ? 'throttle ≤ ' + s.throttleMax + ' %' : 'RPM band only') + (spd ? ', speed ≤ ' + s.speedMax : '') }
    ];
    var warnings = [];
    if (!ped && !thr) warnings.push('No pedal or throttle channel — idle taken as any ' + s.rpmMin + '–' + s.rpmMax + ' rpm while stopped.');
    if (!spd) warnings.push('Vehicle speed not logged — coasting in gear at idle rpm may be counted as idle.');
    if (!ect) warnings.push('ECT not logged — cold idle cannot be separated from warm idle.');
    var summary = (score >= 90 ? 'Steady idle' : score >= 70 ? 'Some idle instability' : 'Unstable idle') + ' — ±' + round1(worst.sd) + ' rpm at worst around ' + Math.round(worst.med) + ' rpm' +
      (totalDips ? ', ' + totalDips + ' dip' + (totalDips === 1 ? '' : 's') : '') + ' over ' + per.length + ' period' + (per.length === 1 ? '' : 's') + '.';
    return { score: score, confidence: Math.min(1, 0.5 + per.length * 0.15), summary: summary, details: details, evidence: evidence, warnings: warnings, evaluatedSampleCount: totalN, evaluatedTimeRange: R.range };
  }
  SC.registerEvaluator({
    id: 'idle', name: 'Idle Quality', status: 'experimental', evaluatorVersion: '0.9.0',
    description: 'RPM stability while idling: std-dev and swing of the worst idle period, plus dips toward a stall.',
    requiredChannels: [{ role: 'engine_rpm', label: 'Engine Speed' }],
    optionalChannels: [{ role: 'accelerator_pedal_position' }, { role: 'throttle_position' }, { role: 'vehicle_speed' }, { role: 'engine_coolant_temp' }],
    defaultSettings: extend(IDLE_DEFAULTS, null), settingsMeta: IDLE_META, evaluate: computeIdle
  });

  // ===============================================================================================
  // SHIFT QUALITY -- every change of current gear is a shift. Scored on RPM flare after a power
  //   upshift (clutches slipping), commanded -> current lag (when commanded gear is logged) and converter
  //   slip spikes through the shift while the converter was locked (when TCC slip is logged).
  // ===============================================================================================
  var SHIFT_DEFAULTS = {
    windowSec: 1.0, preWindowSec: 0.5, powerPedalMin: 25,
    flareTolRpm: 150, flarePerRpm: 0.06, flarePenaltyMax: 40,
    lagTolSec: 0.6, lagPerSec: 25, lagPenaltyMax: 30,
    slipTolRpm: 150, slipPerRpm: 0.05, slipPenaltyMax: 30,
    minShifts: 2
  };
  var SHIFT_META = {
    windowSec: ['Shift window', 's', 'How long after a gear change to look for flare / slip'], preWindowSec: ['Pre-shift window', 's', 'RPM peak before the change is the flare reference'], powerPedalMin: ['Power-shift pedal', '%', 'Flare is only judged on shifts made at/above this pedal'],
    flareTolRpm: ['Flare free', 'rpm', 'RPM rise after an upshift that is allowed'], flarePerRpm: ['Points per rpm flare', 'pts'], flarePenaltyMax: ['Flare penalty cap', 'pts'],
    lagTolSec: ['Shift time free', 's', 'Commanded → current gear delay that is allowed'], lagPerSec: ['Points per second of lag', 'pts'], lagPenaltyMax: ['Lag penalty cap', 'pts'],
    slipTolRpm: ['Converter slip free', 'rpm', 'Locked-converter slip spike through a shift that is allowed'], slipPerRpm: ['Points per rpm slip', 'pts'], slipPenaltyMax: ['Slip penalty cap', 'pts'],
    minShifts: ['Minimum shifts', '', 'Fewer shifts than this = low confidence']
  };
  function computeShift(ctx) {
    var s = extend(SHIFT_DEFAULTS, ctx.settings), R = rangeOf(ctx);
    var gear = ctx.rangeSeries('current_gear'); if (!gear) return notEval('Current gear not logged.');
    var N = gear.length, cmd = ctx.rangeSeries('commanded_gear'), slip = ctx.rangeSeries('trans_slip'), rpm = ctx.rangeSeries('engine_rpm'), dem = demandSeries(ctx);
    function g(i) { var v = gear[i]; return fin(v) ? Math.round(v) : 0; }
    function cg(i) { var v = cmd ? cmd[i] : null; return fin(v) ? Math.round(v) : 0; }
    var shifts = [], prev = g(0), i, k;
    for (i = 1; i < N; i++) {
      var cur = g(i);
      if (cur === prev) continue;
      if (cur > 0 && prev > 0) {
        var t = R.absT(i), end = i; while (end + 1 < N && R.absT(end + 1) - t <= s.windowSec) end++;
        var sh = { i: i, t: t, from: prev, to: cur, up: cur > prev, endI: end, pedal: dem.at(i), flare: null, lag: null, slipPeak: null, slipLocked: false };
        if (rpm && sh.up && (sh.pedal == null || sh.pedal >= s.powerPedalMin) && fin(rpm[i])) {
          // flare = rpm climbing PAST the pre-shift peak after the gear change (clutches not holding). The
          // reference is the rpm peak in the half-second before the change, so a gear channel that flips at
          // the end of the shift (rpm already falling) cannot fake a flare out of normal acceleration.
          var ref = rpm[i]; for (k = i - 1; k >= 0 && t - R.absT(k) <= s.preWindowSec; k--) if (fin(rpm[k]) && rpm[k] > ref) ref = rpm[k];
          var mx = ref, mxI = i; for (k = i; k <= end; k++) if (fin(rpm[k]) && rpm[k] > mx) { mx = rpm[k]; mxI = k; }
          sh.flare = mx - ref; sh.flareI = mxI;
        }
        if (cmd) {
          // the most recent commanded change to this gear, up to 3 s before the current-gear change
          for (k = i; k >= 0 && t - R.absT(k) <= 3; k--) { if (cg(k) === cur && (k === 0 || cg(k - 1) !== cur)) { sh.lag = t - R.absT(k); sh.cmdI = k; break; } }
        }
        if (slip) {
          var before = []; for (k = i - 1; k >= 0 && t - R.absT(k) <= s.windowSec; k--) if (fin(slip[k])) before.push(Math.abs(slip[k]));
          var medBefore = before.length ? pct(before.sort(fAsc), 0.5) : null;
          if (medBefore != null && medBefore <= s.slipTolRpm) {
            sh.slipLocked = true; var sp = 0, spI = i; for (k = i; k <= end; k++) if (fin(slip[k]) && Math.abs(slip[k]) > sp) { sp = Math.abs(slip[k]); spI = k; }
            sh.slipPeak = sp; sh.slipI = spI;
          }
        }
        shifts.push(sh);
      }
      prev = cur;
    }
    if (!shifts.length) return notEval('No gear changes found in the selected range.', 'Shift Quality scores every gear change; none happened here.');
    var ups = shifts.filter(function (x) { return x.up; }), downs = shifts.length - ups.length;
    var flares = shifts.filter(function (x) { return x.flare != null; }), lags = shifts.filter(function (x) { return x.lag != null; }), slips = shifts.filter(function (x) { return x.slipPeak != null; });
    var worstFlare = null; flares.forEach(function (x) { if (!worstFlare || x.flare > worstFlare.flare) worstFlare = x; });
    var worstLag = null; lags.forEach(function (x) { if (!worstLag || x.lag > worstLag.lag) worstLag = x; });
    var worstSlip = null; slips.forEach(function (x) { if (!worstSlip || x.slipPeak > worstSlip.slipPeak) worstSlip = x; });
    var flarePen = worstFlare ? Math.min(s.flarePenaltyMax, Math.max(0, worstFlare.flare - s.flareTolRpm) * s.flarePerRpm) : 0;
    var lagPen = worstLag ? Math.min(s.lagPenaltyMax, Math.max(0, worstLag.lag - s.lagTolSec) * s.lagPerSec) : 0;
    var slipPen = worstSlip ? Math.min(s.slipPenaltyMax, Math.max(0, worstSlip.slipPeak - s.slipTolRpm) * s.slipPerRpm) : 0;
    var score = fClamp(100 - flarePen - lagPen - slipPen);
    function shiftName(x) { return x.from + '→' + x.to; }
    var evidence = [];
    if (flarePen > 0) evidence.push({ startTime: worstFlare.t, endTime: R.absT(worstFlare.endI), peakTime: R.absT(worstFlare.flareI), severity: worstFlare.flare > s.flareTolRpm * 2 ? 'critical' : 'warning',
      label: 'Shift flare', message: 'RPM rose ' + Math.round(worstFlare.flare) + ' after the ' + shiftName(worstFlare) + ' upshift' + (worstFlare.pedal != null ? ' at ' + Math.round(worstFlare.pedal) + ' % pedal' : ''), values: { flareRpm: Math.round(worstFlare.flare) } });
    if (lagPen > 0) evidence.push({ startTime: R.absT(worstLag.cmdI), endTime: worstLag.t, peakTime: worstLag.t, severity: worstLag.lag > s.lagTolSec * 2 ? 'critical' : 'warning',
      label: 'Slow shift', message: shiftName(worstLag) + ' took ' + round1(worstLag.lag) + ' s from command to gear', values: { lagSec: round1(worstLag.lag) } });
    if (slipPen > 0) evidence.push({ startTime: worstSlip.t, endTime: R.absT(worstSlip.endI), peakTime: R.absT(worstSlip.slipI), severity: worstSlip.slipPeak > s.slipTolRpm * 3 ? 'critical' : 'warning',
      label: 'Converter slip through shift', message: Math.round(worstSlip.slipPeak) + ' rpm slip during the ' + shiftName(worstSlip) + ' shift with the converter locked', values: { slipRpm: Math.round(worstSlip.slipPeak) } });
    var flareCount = flares.filter(function (x) { return x.flare > s.flareTolRpm; }).length;
    var details = [
      { label: 'Shifts', value: shifts.length + ' (' + ups.length + ' up, ' + downs + ' down)' },
      worstFlare ? { label: 'Worst flare', value: Math.round(worstFlare.flare) + ' rpm (' + shiftName(worstFlare) + ')' + (flareCount ? ', ' + flareCount + ' over tolerance' : ''), time: R.absT(worstFlare.flareI), startTime: worstFlare.t, endTime: R.absT(worstFlare.endI) } : { label: 'Flare', value: rpm ? 'no power upshifts' : 'RPM not logged' },
      cmd ? (worstLag ? { label: 'Shift time', value: 'avg ' + round1(mean(lags.map(function (x) { return x.lag; }))) + ' s, worst ' + round1(worstLag.lag) + ' s', time: worstLag.t, startTime: R.absT(worstLag.cmdI), endTime: worstLag.t } : { label: 'Shift time', value: 'no matching commands' }) : { label: 'Shift time', value: 'commanded gear not logged' },
      slip ? (worstSlip ? { label: 'Converter slip', value: 'peak ' + Math.round(worstSlip.slipPeak) + ' rpm over ' + slips.length + ' locked shift' + (slips.length === 1 ? '' : 's'), time: R.absT(worstSlip.slipI) } : { label: 'Converter slip', value: 'converter unlocked through every shift' }) : { label: 'Converter slip', value: 'not logged' },
      { label: 'Gears seen', value: (function () { var seen = {}; shifts.forEach(function (x) { seen[x.from] = 1; seen[x.to] = 1; }); return Object.keys(seen).sort(fAsc).join(', '); })() }
    ];
    var warnings = [];
    if (shifts.length < s.minShifts) warnings.push('Only ' + shifts.length + ' shift' + (shifts.length === 1 ? '' : 's') + ' in range — low confidence.');
    if (!rpm) warnings.push('Engine RPM not logged — flare cannot be judged.');
    if (!cmd) warnings.push('Commanded gear not logged — shift time cannot be judged.');
    if (!dem.source) warnings.push('No pedal / throttle — every upshift treated as a power shift.');
    var summary = (score >= 90 ? 'Clean shifts' : score >= 70 ? 'Some rough shifts' : 'Rough shifting') + ' over ' + shifts.length + ' gear change' + (shifts.length === 1 ? '' : 's') +
      (worstFlare && flarePen > 0 ? '; flare up to ' + Math.round(worstFlare.flare) + ' rpm' : '') + (lagPen > 0 ? '; slowest shift ' + round1(worstLag.lag) + ' s' : '') + (slipPen > 0 ? '; converter slip to ' + Math.round(worstSlip.slipPeak) + ' rpm' : '') + '.';
    return { score: score, confidence: Math.min(1, 0.4 + shifts.length * 0.1) * (rpm ? 1 : 0.6), summary: summary, details: details, evidence: evidence, warnings: warnings, evaluatedSampleCount: shifts.length, evaluatedTimeRange: R.range };
  }
  SC.registerEvaluator({
    id: 'shift', name: 'Shift Quality', status: 'experimental', evaluatorVersion: '0.9.0',
    description: 'Every gear change: RPM flare on power upshifts, commanded-to-actual shift time, converter slip through the shift.',
    requiredChannels: [{ role: 'current_gear', label: 'Current Gear' }],
    optionalChannels: [{ role: 'commanded_gear' }, { role: 'trans_slip' }, { role: 'engine_rpm' }, { role: 'accelerator_pedal_position' }, { role: 'throttle_position' }],
    defaultSettings: extend(SHIFT_DEFAULTS, null), settingsMeta: SHIFT_META, evaluate: computeShift
  });

  // ===============================================================================================
  // FUEL PRESSURE -- rail pressure vs DESIRED under demand (sag = pump / injector duty running out,
  //   overshoot = regulator / control), plus pressure noise within a steady run. Without a desired
  //   channel: the drop from the idle/cruise baseline under demand. Percent-based so DI rails (2,000+ psi)
  //   and port rails (40-60 psi) read on the same scale.
  // ===============================================================================================
  var FUELP_DEFAULTS = {
    demandMin: 50, baselineDemandMax: 25, rpmFloor: 1000, settleSec: 0.3,
    sagTolPct: 4, sagPerPct: 4, sagPenaltyMax: 60,
    overTolPct: 8, overPerPct: 1.5, overPenaltyMax: 20,
    noiseTolPct: 3, noisePerPct: 3, noisePenaltyMax: 20,
    dropTolPct: 10, dropPerPct: 3, dropPenaltyMax: 60,
    minPressure: 0, minPressurePoints: 30,
    minSamples: 20
  };
  var FUELP_META = {
    demandMin: ['Demand threshold', '%', 'Pedal / throttle at/above this = under demand'], baselineDemandMax: ['Baseline below', '% demand', 'Idle / cruise samples that set the baseline (no desired channel)'], rpmFloor: ['RPM floor', 'rpm'], settleSec: ['Settle', 's'],
    sagTolPct: ['Sag free', '% of desired'], sagPerPct: ['Points per % sag', 'pts'], sagPenaltyMax: ['Sag penalty cap', 'pts'],
    overTolPct: ['Overshoot free', '% of desired'], overPerPct: ['Points per % over', 'pts'], overPenaltyMax: ['Overshoot penalty cap', 'pts'],
    noiseTolPct: ['Noise free', '% std-dev', 'Pressure std-dev within a steady demand run'], noisePerPct: ['Points per % noise', 'pts'], noisePenaltyMax: ['Noise penalty cap', 'pts'],
    dropTolPct: ['Drop from baseline free', '%', 'Used when desired pressure is not logged'], dropPerPct: ['Points per % drop', 'pts'], dropPenaltyMax: ['Drop penalty cap', 'pts'],
    minPressure: ['Hard floor', 'log unit', '0 = off. Below this under demand is critical'], minPressurePoints: ['Hard-floor penalty', 'pts'],
    minSamples: ['Minimum samples', '', 'Fewer demand samples = low confidence']
  };
  function computeFuelPressure(ctx) {
    var s = extend(FUELP_DEFAULTS, ctx.settings), R = rangeOf(ctx);
    var fp = ctx.rangeSeries('fuel_pressure'); if (!fp) return notEval('Fuel pressure not logged.');
    var N = fp.length, des = ctx.rangeSeries('desired_fuel_pressure'), rpm = ctx.rangeSeries('engine_rpm'), dem = demandSeries(ctx), unit = ctx.unitFor('fuel_pressure') || 'psi';
    function underDemand(i) { var d = dem.at(i); return fin(fp[i]) && rpmFloorOk(rpm, i, s.rpmFloor) && (d == null ? true : d >= s.demandMin); }
    var runs = runsWhere(N, underDemand, R.absT, s.settleSec, 0).filter(function (r) { return !r.brief; });
    var idx = []; runs.forEach(function (r) { for (var i = r.settledI; i <= r.endI; i++) idx.push(i); });
    if (idx.length < 5) return notEval('No fuel-pressure samples under demand (' + (dem.source || 'demand') + ' ≥ ' + s.demandMin + ' %).', 'Fuel Pressure scores the rail under demand; nothing held long enough here.');
    var evidence = [], details = [], warnings = [], penalties = 0, i;
    var minI = idx[0]; idx.forEach(function (k) { if (fp[k] < fp[minI]) minI = k; });
    if (des) {
      var errs = [], errI = [];
      idx.forEach(function (k) { if (fin(des[k]) && des[k] > 0) { errs.push((fp[k] - des[k]) / des[k] * 100); errI.push(k); } });
      if (errs.length < 5) { warnings.push('Desired fuel pressure logged but never > 0 under demand — scored against the baseline instead.'); des = null; }
      else {
        var order = errs.map(function (e, k) { return k; }).sort(function (a, b) { return errs[a] - errs[b]; });
        var sagK = order[Math.floor(order.length * 0.05)], overK = order[Math.floor(order.length * 0.95)], worstK = order[0];
        var sagPct = -errs[sagK], overPct = errs[overK];
        var sagPen = Math.min(s.sagPenaltyMax, Math.max(0, sagPct - s.sagTolPct) * s.sagPerPct);
        var overPen = Math.min(s.overPenaltyMax, Math.max(0, overPct - s.overTolPct) * s.overPerPct);
        penalties += sagPen + overPen;
        if (sagPen > 0) evidence.push({ startTime: R.absT(errI[worstK]), peakTime: R.absT(errI[worstK]), severity: sagPct > s.sagTolPct * 3 ? 'critical' : 'warning',
          label: 'Fuel pressure sag', message: 'Rail ' + round1(-errs[worstK]) + ' % below desired at worst (' + round1(fp[errI[worstK]]) + ' vs ' + round1(des[errI[worstK]]) + ' ' + unit + '), 5th percentile ' + round1(sagPct) + ' % low', values: { sagPct: round1(sagPct) } });
        if (overPen > 0) evidence.push({ startTime: R.absT(errI[order[order.length - 1]]), peakTime: R.absT(errI[order[order.length - 1]]), severity: 'warning',
          label: 'Fuel pressure overshoot', message: 'Rail ' + round1(overPct) + ' % above desired (95th percentile) under demand', values: { overPct: round1(overPct) } });
        details.push({ label: 'Tracking vs desired', value: 'median ' + round1(errs[order[Math.floor(order.length / 2)]]) + ' %, worst sag ' + round1(-errs[worstK]) + ' %', time: R.absT(errI[worstK]) });
      }
    }
    if (!des) {
      var base = []; for (i = 0; i < N; i++) { var d = dem.at(i); if (fin(fp[i]) && (d == null || d <= s.baselineDemandMax) && rpmFloorOk(rpm, i, 400)) base.push(fp[i]); }
      var baseline = base.length >= 10 ? pct(base.sort(fAsc), 0.5) : pct(idx.map(function (k) { return fp[k]; }).sort(fAsc), 0.5);
      var drops = idx.map(function (k) { return (baseline - fp[k]) / baseline * 100; }).sort(fAsc), dropP95 = drops[Math.floor(drops.length * 0.95)];
      var dropPen = Math.min(s.dropPenaltyMax, Math.max(0, dropP95 - s.dropTolPct) * s.dropPerPct);
      penalties += dropPen;
      if (dropPen > 0) evidence.push({ startTime: R.absT(minI), peakTime: R.absT(minI), severity: dropP95 > s.dropTolPct * 3 ? 'critical' : 'warning',
        label: 'Fuel pressure drop under demand', message: 'Rail fell to ' + round1(fp[minI]) + ' ' + unit + ' (' + round1((baseline - fp[minI]) / baseline * 100) + ' % below the ' + round1(baseline) + ' ' + unit + ' baseline)', values: { dropPct: round1(dropP95) } });
      details.push({ label: 'Baseline (idle / cruise)', value: round1(baseline) + ' ' + unit });
      details.push({ label: 'Drop under demand (95th pct)', value: round1(dropP95) + ' %', time: R.absT(minI) });
      if (ctx.hasRole('desired_fuel_pressure') === false) warnings.push('Desired fuel pressure not logged — scored as the drop from the idle/cruise baseline.');
    }
    // noise within each steady demand run
    var worstNoise = null;
    runs.forEach(function (r) { var v = []; for (var k = r.settledI; k <= r.endI; k++) if (fin(fp[k])) v.push(fp[k]); if (v.length < 10) return; var m = mean(v); if (!m) return; var n = stdev(v) / m * 100; if (!worstNoise || n > worstNoise.n) worstNoise = { n: n, r: r }; });
    if (worstNoise) {
      var noisePen = Math.min(s.noisePenaltyMax, Math.max(0, worstNoise.n - s.noiseTolPct) * s.noisePerPct);
      penalties += noisePen;
      if (noisePen > 0) evidence.push({ startTime: worstNoise.r.startT, endTime: worstNoise.r.endT, peakTime: worstNoise.r.startT, severity: 'warning', label: 'Fuel pressure hunting', message: 'Rail pressure std-dev ' + round1(worstNoise.n) + ' % of mean within one demand run', values: { noisePct: round1(worstNoise.n) } });
      details.push({ label: 'Noise (worst run)', value: round1(worstNoise.n) + ' % std-dev', time: worstNoise.r.startT, startTime: worstNoise.r.startT, endTime: worstNoise.r.endT });
    }
    if (s.minPressure > 0 && fp[minI] < s.minPressure) {
      penalties += s.minPressurePoints;
      evidence.push({ startTime: R.absT(minI), peakTime: R.absT(minI), severity: 'critical', label: 'Below hard floor', message: round1(fp[minI]) + ' ' + unit + ' under demand (floor ' + s.minPressure + ')', values: { pressure: round1(fp[minI]) } });
    }
    var score = fClamp(100 - penalties);
    details.unshift({ label: 'Demand samples', value: grp(idx.length) + ' over ' + runs.length + ' run' + (runs.length === 1 ? '' : 's') + ' (' + (dem.source || 'all') + (dem.source ? ' ≥ ' + s.demandMin + ' %' : '') + ')' });
    details.push({ label: 'Lowest under demand', value: round1(fp[minI]) + ' ' + unit, time: R.absT(minI) });
    if (idx.length < s.minSamples) warnings.push('Only ' + idx.length + ' demand samples — low confidence.');
    if (!dem.source) warnings.push('No pedal / throttle / load — every above-idle sample treated as demand.');
    var summary = (score >= 90 ? 'Rail pressure holds under demand' : score >= 70 ? 'Some fuel-pressure sag under demand' : 'Fuel pressure falls away under demand') + ' (lowest ' + round1(fp[minI]) + ' ' + unit + ').';
    return { score: score, confidence: Math.min(1, idx.length / (s.minSamples * 3)) * (des ? 1 : 0.7), summary: summary, details: details, evidence: evidence, warnings: warnings, evaluatedSampleCount: idx.length, evaluatedTimeRange: R.range };
  }
  SC.registerEvaluator({
    id: 'fuel_pressure', name: 'Fuel Pressure', status: 'experimental', evaluatorVersion: '0.9.0',
    description: 'Rail pressure vs desired under demand (sag, overshoot, hunting); drop from baseline when no desired channel is logged.',
    requiredChannels: [{ role: 'fuel_pressure', label: 'Fuel Rail Pressure' }],
    optionalChannels: [{ role: 'desired_fuel_pressure' }, { role: 'engine_rpm' }, { role: 'accelerator_pedal_position' }, { role: 'throttle_position' }, { role: 'actual_load' }],
    defaultSettings: extend(FUELP_DEFAULTS, null), settingsMeta: FUELP_META, evaluate: computeFuelPressure
  });

  // ===============================================================================================
  // BOOST CONTROL -- on boosted pulls (demand at/above threshold, settled): actual vs DESIRED boost
  //   (overshoot / undershoot at the 95th / 5th percentile), oscillation around the local trend (surge /
  //   wastegate hunting) and an optional hard ceiling. Without a desired channel only oscillation and the
  //   ceiling are scored.
  // ===============================================================================================
  var BOOST_DEFAULTS = {
    demandThreshold: 80, boostFloor: 3, settleSec: 0.8, minRunSec: 0.5,
    overTolPsi: 1.5, overPerPsi: 10, overPenaltyMax: 45,
    underTolPsi: 2.0, underPerPsi: 5, underPenaltyMax: 30,
    oscTolPsi: 0.8, oscPerPsi: 15, oscPenaltyMax: 30, oscWindowSec: 0.5,
    maxBoostPsi: 0, maxBoostPoints: 25,
    minSamples: 15
  };
  var BOOST_META = {
    demandThreshold: ['Pull demand', '%', 'Pedal / throttle at/above this = a pull'], boostFloor: ['Boost floor', 'psi', 'Region when no demand channel; also the least boost a pull must reach'],
    settleSec: ['Settle', 's', 'Spool time ignored after the pedal goes down'], minRunSec: ['Minimum run', 's'],
    overTolPsi: ['Overshoot free', 'psi over desired'], overPerPsi: ['Points per psi over', 'pts'], overPenaltyMax: ['Overshoot penalty cap', 'pts'],
    underTolPsi: ['Undershoot free', 'psi under desired'], underPerPsi: ['Points per psi under', 'pts'], underPenaltyMax: ['Undershoot penalty cap', 'pts'],
    oscTolPsi: ['Oscillation free', 'psi std-dev', 'Boost wobble around its local trend'], oscPerPsi: ['Points per psi oscillation', 'pts'], oscPenaltyMax: ['Oscillation penalty cap', 'pts'], oscWindowSec: ['Trend window', 's'],
    maxBoostPsi: ['Hard ceiling', 'psi', '0 = off. Boost above this anywhere is critical'], maxBoostPoints: ['Ceiling penalty', 'pts'],
    minSamples: ['Minimum samples', '']
  };
  function computeBoost(ctx) {
    var s = extend(BOOST_DEFAULTS, ctx.settings), R = rangeOf(ctx);
    var boost = ctx.rangeSeries('boost_pressure'); if (!boost) return notEval('Boost pressure not logged.');
    var N = boost.length, des = ctx.rangeSeries('desired_boost'), dem = demandSeries(ctx), unit = ctx.unitFor('boost_pressure') || 'psi';
    function inPull(i) { if (!fin(boost[i])) return false; var d = dem.at(i); return d != null ? d >= s.demandThreshold : boost[i] >= s.boostFloor; }
    var runs = runsWhere(N, inPull, R.absT, s.settleSec, s.minRunSec).filter(function (r) { return !r.brief; });
    // a pull has to actually make boost
    runs = runs.filter(function (r) { var mx = -Infinity; for (var k = r.settledI; k <= r.endI; k++) if (boost[k] > mx) mx = boost[k]; r.peak = mx; return mx >= s.boostFloor; });
    if (!runs.length) return notEval('No boosted pull found (' + (dem.source ? dem.source + ' ≥ ' + s.demandThreshold + ' % and ' : '') + 'boost ≥ ' + s.boostFloor + ' ' + unit + ' held past ' + s.settleSec + ' s).', 'Boost Control scores actual vs desired boost on settled pulls; none here.');
    var evidence = [], details = [], warnings = [], penalties = 0, idx = [];
    runs.forEach(function (r) { for (var k = r.settledI; k <= r.endI; k++) idx.push(k); });
    var peakI = idx[0]; idx.forEach(function (k) { if (boost[k] > boost[peakI]) peakI = k; });
    var haveDes = false;
    if (des) {
      var errs = [], errI = [];
      idx.forEach(function (k) { if (fin(des[k]) && des[k] >= s.boostFloor * 0.5) { errs.push(boost[k] - des[k]); errI.push(k); } });
      if (errs.length >= 5) {
        haveDes = true;
        var order = errs.map(function (e, k) { return k; }).sort(function (a, b) { return errs[a] - errs[b]; });
        var overK = order[Math.floor(order.length * 0.95)], underK = order[Math.floor(order.length * 0.05)];
        var over = errs[overK], under = -errs[underK];
        var overPen = Math.min(s.overPenaltyMax, Math.max(0, over - s.overTolPsi) * s.overPerPsi);
        var underPen = Math.min(s.underPenaltyMax, Math.max(0, under - s.underTolPsi) * s.underPerPsi);
        penalties += overPen + underPen;
        var maxK = order[order.length - 1], minK = order[0];
        if (overPen > 0) evidence.push({ startTime: R.absT(errI[maxK]), peakTime: R.absT(errI[maxK]), severity: over > s.overTolPsi * 2 ? 'critical' : 'warning',
          label: 'Boost overshoot', message: round1(errs[maxK]) + ' ' + unit + ' over desired at worst (' + round1(boost[errI[maxK]]) + ' vs ' + round1(des[errI[maxK]]) + '), 95th percentile +' + round1(over), values: { overPsi: round1(over) } });
        if (underPen > 0) evidence.push({ startTime: R.absT(errI[minK]), peakTime: R.absT(errI[minK]), severity: 'warning',
          label: 'Boost under target', message: round1(-errs[minK]) + ' ' + unit + ' under desired at worst (' + round1(boost[errI[minK]]) + ' vs ' + round1(des[errI[minK]]) + ')', values: { underPsi: round1(under) } });
        details.push({ label: 'Error vs desired', value: 'median ' + (errs[order[Math.floor(order.length / 2)]] >= 0 ? '+' : '') + round1(errs[order[Math.floor(order.length / 2)]]) + ', over +' + round1(over) + ', under −' + round1(under) + ' ' + unit, time: R.absT(errI[maxK]) });
      } else warnings.push('Desired boost logged but no target during the pulls — over/undershoot not scored.');
    } else warnings.push('Desired boost not logged — only oscillation' + (s.maxBoostPsi > 0 ? ' and the hard ceiling' : '') + ' scored.');
    // oscillation: residual std-dev around a centred moving average, worst run
    var worstOsc = null;
    runs.forEach(function (r) {
      var res = [], k, j;
      for (k = r.settledI; k <= r.endI; k++) {
        var sum = 0, n = 0, tk = R.absT(k);
        for (j = k; j >= r.settledI && tk - R.absT(j) <= s.oscWindowSec / 2; j--) if (fin(boost[j])) { sum += boost[j]; n++; }
        for (j = k + 1; j <= r.endI && R.absT(j) - tk <= s.oscWindowSec / 2; j++) if (fin(boost[j])) { sum += boost[j]; n++; }
        if (n >= 3) res.push(boost[k] - sum / n);
      }
      if (res.length < 8) return;
      var sd = stdev(res); if (!worstOsc || sd > worstOsc.sd) worstOsc = { sd: sd, r: r };
    });
    if (worstOsc) {
      var oscPen = Math.min(s.oscPenaltyMax, Math.max(0, worstOsc.sd - s.oscTolPsi) * s.oscPerPsi);
      penalties += oscPen;
      if (oscPen > 0) evidence.push({ startTime: worstOsc.r.startT, endTime: worstOsc.r.endT, peakTime: worstOsc.r.startT, severity: worstOsc.sd > s.oscTolPsi * 2 ? 'critical' : 'warning',
        label: 'Boost oscillation', message: 'Boost wobbles ±' + round1(worstOsc.sd) + ' ' + unit + ' around its trend on one pull', values: { oscPsi: round1(worstOsc.sd) } });
      details.push({ label: 'Oscillation (worst pull)', value: '±' + round1(worstOsc.sd) + ' ' + unit, time: worstOsc.r.startT, startTime: worstOsc.r.startT, endTime: worstOsc.r.endT });
    }
    if (s.maxBoostPsi > 0) {
      var ceilI = -1; for (var q = 0; q < N; q++) if (fin(boost[q]) && boost[q] > s.maxBoostPsi && (ceilI < 0 || boost[q] > boost[ceilI])) ceilI = q;
      if (ceilI >= 0) { penalties += s.maxBoostPoints; evidence.push({ startTime: R.absT(ceilI), peakTime: R.absT(ceilI), severity: 'critical', label: 'Over the boost ceiling', message: round1(boost[ceilI]) + ' ' + unit + ' (ceiling ' + s.maxBoostPsi + ')', values: { boost: round1(boost[ceilI]) } }); }
    }
    var score = fClamp(100 - penalties);
    details.unshift({ label: 'Pulls', value: runs.length + ' (' + grp(idx.length) + ' settled samples), peaks ' + runs.map(function (r) { return round1(r.peak); }).join(' / ') + ' ' + unit });
    details.push({ label: 'Peak boost', value: round1(boost[peakI]) + ' ' + unit, time: R.absT(peakI) });
    if (idx.length < s.minSamples) warnings.push('Only ' + idx.length + ' settled pull samples — low confidence.');
    var summary = (haveDes ? (score >= 90 ? 'Boost tracks its target' : score >= 70 ? 'Boost strays from target at times' : 'Boost control off target') : (score >= 90 ? 'Boost is steady on the pulls' : 'Boost is unsteady on the pulls')) +
      ' — peak ' + round1(boost[peakI]) + ' ' + unit + ' over ' + runs.length + ' pull' + (runs.length === 1 ? '' : 's') + '.';
    return { score: score, confidence: Math.min(1, idx.length / (s.minSamples * 3)) * (haveDes ? 1 : 0.6), summary: summary, details: details, evidence: evidence, warnings: warnings, evaluatedSampleCount: idx.length, evaluatedTimeRange: R.range };
  }
  SC.registerEvaluator({
    id: 'boost', name: 'Boost Control', status: 'experimental', evaluatorVersion: '0.9.0',
    description: 'Actual vs desired boost on settled pulls (overshoot, undershoot), oscillation, optional hard ceiling.',
    requiredChannels: [{ role: 'boost_pressure', label: 'Boost' }],
    optionalChannels: [{ role: 'desired_boost' }, { role: 'accelerator_pedal_position' }, { role: 'throttle_position' }, { role: 'actual_load' }],
    defaultSettings: extend(BOOST_DEFAULTS, null), settingsMeta: BOOST_META, evaluate: computeBoost
  });

  // ===============================================================================================
  // THROTTLE CONTROL -- with the pedal flat the blade should be open: closure under boost = torque /
  //   boost limiting (the popcorn log: blade to 31 % at 17 psi with the pedal floored). Part-throttle
  //   tracking (|throttle - pedal|, off boost) is judged loosely because pedal maps are deliberately
  //   non-linear.
  // ===============================================================================================
  var THROTTLE_DEFAULTS = {
    wotPedalMin: 95, wotThrottleMin: 85, settleSec: 0.3,
    closureOnEcoBoost: false,   // Ken 2026-09-09: on EcoBoost the blade IS a boost / torque control actuator, so a
                                // part-open blade at WOT is normal and not a criterion (tracking still scored)
    closurePerPct: 0.8, closurePenaltyMax: 50, deepClosurePct: 70,
    trackPedalMin: 5, trackPedalMax: 70, trackBoostMax: 1, trackTolPct: 15, trackPerPct: 2, trackPenaltyMax: 25,
    rpmFloor: 900, minSamples: 20
  };
  var THROTTLE_META = {
    wotPedalMin: ['Flat pedal', '%', 'Pedal at/above this = wide open'], wotThrottleMin: ['Blade open enough', '%', 'Throttle below this with the pedal flat = closure'], settleSec: ['Settle', 's', 'Blade travel time after the pedal goes down'],
    closureOnEcoBoost: ['Judge closure on EcoBoost', '', 'Off: EcoBoost uses the blade for boost / torque control, so closure at WOT is normal and not scored'],
    closurePerPct: ['Points per % of WOT time closed', 'pts'], closurePenaltyMax: ['Closure penalty cap', 'pts'], deepClosurePct: ['Deep closure below', '%', 'Critical when the blade falls under this at WOT'],
    trackPedalMin: ['Tracking band low', '% pedal'], trackPedalMax: ['Tracking band high', '% pedal'], trackBoostMax: ['Tracking only below', 'psi', 'Off boost the blade should follow the pedal'],
    trackTolPct: ['Tracking error free', '%', '95th percentile |throttle − pedal|'], trackPerPct: ['Points per % error', 'pts'], trackPenaltyMax: ['Tracking penalty cap', 'pts'],
    rpmFloor: ['RPM floor', 'rpm'], minSamples: ['Minimum samples', '']
  };
  function computeThrottle(ctx) {
    var s = extend(THROTTLE_DEFAULTS, ctx.settings), R = rangeOf(ctx);
    var thr = ctx.rangeSeries('throttle_position'), ped = ctx.rangeSeries('accelerator_pedal_position');
    if (!thr) return notEval('Throttle position not logged.');
    if (!ped) return notEval('Accelerator pedal not logged — the blade cannot be judged against driver demand.', 'Throttle Control compares the throttle blade with the pedal; log Accelerator Pedal Position.');
    var N = thr.length, boost = ctx.rangeSeries('boost_pressure'), rpm = ctx.rangeSeries('engine_rpm');
    // EcoBoost (card Type): the blade closes under boost by design -- closure is reported, never penalised
    var isEco = !!(ctx.profile && ctx.profile.induction === 'eco'), judgeClosure = !(isEco && !s.closureOnEcoBoost);
    function flat(i) { return fin(ped[i]) && fin(thr[i]) && ped[i] >= s.wotPedalMin && rpmFloorOk(rpm, i, s.rpmFloor); }
    var runs = runsWhere(N, flat, R.absT, s.settleSec, 0).filter(function (r) { return !r.brief; });
    var settled = 0, closed = 0, deep = 0, worstI = -1, closedRuns = 0, i;
    runs.forEach(function (r) { var any = false; for (var k = r.settledI; k <= r.endI; k++) { settled++; if (thr[k] < s.wotThrottleMin) { closed++; any = true; } if (thr[k] < s.deepClosurePct) deep++; if (worstI < 0 || thr[k] < thr[worstI]) worstI = k; } if (any) closedRuns++; });
    // part-throttle tracking, off boost
    var errs = [], errI = [];
    for (i = 0; i < N; i++) {
      if (!fin(ped[i]) || !fin(thr[i]) || ped[i] < s.trackPedalMin || ped[i] > s.trackPedalMax || !rpmFloorOk(rpm, i, s.rpmFloor)) continue;
      if (boost && fin(boost[i]) && boost[i] >= s.trackBoostMax) continue;
      errs.push(Math.abs(thr[i] - ped[i])); errI.push(i);
    }
    if (!settled && errs.length < s.minSamples) return notEval('Neither a flat-pedal run nor enough part-throttle driving in range.', 'Throttle Control needs flat-pedal runs or part-throttle driving off boost.');
    if (!judgeClosure && errs.length < s.minSamples) return notEval('Blade closure at WOT is not scored on EcoBoost (boost / torque control), and there is not enough part-throttle driving off boost to judge tracking.', 'Throttle Control on EcoBoost scores part-throttle tracking only; none found here.');
    var evidence = [], details = [], warnings = [], penalties = 0;
    var closedPct = settled ? closed / settled * 100 : 0;
    if (settled && !judgeClosure) {
      // informational only
      details.push({ label: 'Flat-pedal time', value: grp(settled) + ' samples over ' + runs.length + ' run' + (runs.length === 1 ? '' : 's') });
      details.push({ label: 'Blade at WOT', value: 'not scored on EcoBoost (boost / torque control); lowest ' + round1(thr[worstI]) + ' %', time: R.absT(worstI) });
    } else if (settled) {
      var closurePen = Math.min(s.closurePenaltyMax, closedPct * s.closurePerPct);
      penalties += closurePen;
      if (closurePen > 0) {
        var wr = null; runs.forEach(function (r) { if (worstI >= r.startI && worstI <= r.endI) wr = r; });
        evidence.push({ startTime: wr ? wr.onsetT : R.absT(worstI), endTime: wr ? wr.endT : R.absT(worstI), peakTime: R.absT(worstI), severity: deep ? 'critical' : 'warning',
          label: 'Throttle closing at WOT', message: 'Blade down to ' + round1(thr[worstI]) + ' % with the pedal at ' + Math.round(ped[worstI]) + ' %' + (boost && fin(boost[worstI]) ? ' and ' + round1(boost[worstI]) + ' psi' : '') + '; closed for ' + Math.round(closedPct) + ' % of flat-pedal time (' + closedRuns + ' of ' + runs.length + ' runs)', values: { closedPct: Math.round(closedPct), worstThrottle: round1(thr[worstI]) } });
      }
      details.push({ label: 'Flat-pedal time', value: grp(settled) + ' samples over ' + runs.length + ' run' + (runs.length === 1 ? '' : 's') });
      details.push({ label: 'Blade below ' + s.wotThrottleMin + ' % at WOT', value: Math.round(closedPct) + ' % of the time' + (deep ? ', ' + Math.round(deep / settled * 100) + ' % below ' + s.deepClosurePct : ''), time: worstI >= 0 ? R.absT(worstI) : null });
      details.push({ label: 'Lowest blade at WOT', value: round1(thr[worstI]) + ' %', time: R.absT(worstI) });
    } else warnings.push('No flat-pedal run in range — throttle closure at WOT not judged.');
    if (errs.length >= s.minSamples) {
      var order = errs.map(function (e, k) { return k; }).sort(function (a, b) { return errs[a] - errs[b]; });
      var p95 = errs[order[Math.floor(order.length * 0.95)]], maxK = order[order.length - 1];
      var trackPen = Math.min(s.trackPenaltyMax, Math.max(0, p95 - s.trackTolPct) * s.trackPerPct);
      penalties += trackPen;
      if (trackPen > 0) evidence.push({ startTime: R.absT(errI[maxK]), peakTime: R.absT(errI[maxK]), severity: 'warning', label: 'Throttle not following pedal', message: '|throttle − pedal| ' + round1(p95) + ' % (95th percentile) at part throttle off boost; worst ' + round1(errs[maxK]) + ' %', values: { p95: round1(p95) } });
      details.push({ label: 'Part-throttle tracking', value: 'median ' + round1(errs[order[Math.floor(order.length / 2)]]) + ' %, 95th pct ' + round1(p95) + ' % (' + grp(errs.length) + ' samples)', time: R.absT(errI[maxK]) });
    } else warnings.push('Not enough part-throttle driving off boost to judge tracking.');
    var score = fClamp(100 - penalties);
    if (!boost) warnings.push('Boost not logged — tracking judged on all part-throttle samples.');
    var trackTxt = errs.length >= s.minSamples ? (penalties > 0 && !settled ? 'Blade does not follow the pedal at part throttle.' : 'Blade follows the pedal at part throttle.') : '';
    var summary = !judgeClosure
      ? (trackTxt || 'Part-throttle tracking only.') + ' WOT closure not scored on EcoBoost (boost / torque control).'
      : settled
        ? (closedPct <= 5 ? 'Blade stays open with the pedal flat' : closedPct <= 30 ? 'Blade closes at WOT some of the time' : 'Blade closes at WOT most of the time') + ' (lowest ' + round1(thr[worstI]) + ' %' + (deep ? ', torque / boost limiting' : '') + ').'
        : 'Part-throttle tracking only (no flat-pedal run).';
    return { score: score, confidence: Math.min(1, (settled + errs.length) / (s.minSamples * 5)), summary: summary, details: details, evidence: evidence, warnings: warnings, evaluatedSampleCount: settled + errs.length, evaluatedTimeRange: R.range };
  }
  SC.registerEvaluator({
    id: 'throttle', name: 'Throttle Control', status: 'experimental', evaluatorVersion: '0.9.0',
    description: 'Throttle blade vs pedal: closure at wide-open pedal (torque / boost limiting; not scored on EcoBoost) and part-throttle tracking off boost.',
    requiredChannels: [{ role: 'throttle_position', label: 'Throttle Position' }, { role: 'accelerator_pedal_position', label: 'Accelerator Pedal' }],
    optionalChannels: [{ role: 'boost_pressure' }, { role: 'engine_rpm' }],
    defaultSettings: extend(THROTTLE_DEFAULTS, null), settingsMeta: THROTTLE_META, evaluate: computeThrottle
  });

  // ===============================================================================================
  // TEMPERATURE MANAGEMENT -- coolant peak + time hot, charge-air (MCT / IAT) peak under demand,
  //   transmission fluid peak. Thresholds in °F (Ken logs US units); °C channels are converted.
  // ===============================================================================================
  var TEMPS_DEFAULTS = {
    ectWarm: 160, ectHot: 225, ectCritical: 240, ectPerDeg: 2.5, ectPenaltyMax: 50, ectTimePenaltyMax: 15,
    mctHot: 130, mctCritical: 160, mctPerDeg: 1.2, mctPenaltyMax: 35, mctDemandMin: 50,
    transHot: 220, transCritical: 250, transPerDeg: 1.5, transPenaltyMax: 35,
    minSamples: 20
  };
  var TEMPS_META = {
    ectWarm: ['Warm ECT', '°F', 'Below this the engine is still warming'], ectHot: ['Hot ECT', '°F'], ectCritical: ['Critical ECT', '°F'], ectPerDeg: ['Points per °F over hot', 'pts'], ectPenaltyMax: ['ECT penalty cap', 'pts'], ectTimePenaltyMax: ['Time-hot penalty cap', 'pts', 'Extra for the share of the log above hot'],
    mctHot: ['Hot charge air', '°F', 'MCT / IAT under demand'], mctCritical: ['Critical charge air', '°F'], mctPerDeg: ['Points per °F over', 'pts'], mctPenaltyMax: ['Charge-air penalty cap', 'pts'], mctDemandMin: ['Charge air judged above', '% pedal'],
    transHot: ['Hot trans fluid', '°F'], transCritical: ['Critical trans fluid', '°F'], transPerDeg: ['Points per °F over', 'pts'], transPenaltyMax: ['Trans penalty cap', 'pts'],
    minSamples: ['Minimum samples', '']
  };
  function computeTemps(ctx) {
    var s = extend(TEMPS_DEFAULTS, ctx.settings), R = rangeOf(ctx);
    var ect = ctx.rangeSeries('engine_coolant_temp'); if (!ect) return notEval('Engine coolant temperature not logged.');
    var N = ect.length, mct = ctx.rangeSeries('manifold_charge_temp'), tft = ctx.rangeSeries('trans_temp'), dem = demandSeries(ctx);
    var ectC = tempIsC(ctx, 'engine_coolant_temp'), mctC = !!(mct && tempIsC(ctx, 'manifold_charge_temp')), tftC = !!(tft && tempIsC(ctx, 'trans_temp'));
    var evidence = [], details = [], warnings = [], penalties = 0, i;
    // ECT
    var peakI = -1, hotN = 0, n = 0, maxF = -Infinity, firstWarmI = -1;
    for (i = 0; i < N; i++) { if (!fin(ect[i])) continue; var f = toF(ect[i], ectC); n++; if (f > maxF) { maxF = f; peakI = i; } if (f >= s.ectHot) hotN++; if (firstWarmI < 0 && f >= s.ectWarm) firstWarmI = i; }
    if (n < 5) return notEval('Coolant temperature has no usable samples in range.');
    var ectPen = Math.min(s.ectPenaltyMax, Math.max(0, maxF - s.ectHot) * s.ectPerDeg);
    var hotShare = hotN / n, timePen = Math.min(s.ectTimePenaltyMax, hotShare * 100 * 0.3);
    penalties += ectPen + timePen;
    if (ectPen > 0) evidence.push({ startTime: R.absT(peakI), peakTime: R.absT(peakI), severity: maxF >= s.ectCritical ? 'critical' : 'warning', label: 'Coolant hot', message: 'ECT peaked at ' + degF(maxF) + (hotShare > 0 ? ', above ' + s.ectHot + ' °F for ' + Math.round(hotShare * 100) + ' % of the log' : ''), values: { peakF: Math.round(maxF), hotPct: Math.round(hotShare * 100) } });
    details.push({ label: 'ECT peak', value: degF(maxF) + (hotShare > 0 ? ' (' + Math.round(hotShare * 100) + ' % above ' + s.ectHot + ')' : ''), time: R.absT(peakI) });
    if (firstWarmI < 0) warnings.push('Engine never reached ' + s.ectWarm + ' °F — the whole log is a warm-up.');
    else if (firstWarmI > 0) details.push({ label: 'Warm (' + s.ectWarm + ' °F) reached', value: 'at ' + Math.round(R.absT(firstWarmI)) + ' s', time: R.absT(firstWarmI) });
    // charge air under demand
    if (mct) {
      var mPeakI = -1, mMax = -Infinity, mN = 0;
      for (i = 0; i < N; i++) { if (!fin(mct[i])) continue; var d = dem.at(i); if (d != null && d < s.mctDemandMin) continue; mN++; var mf = toF(mct[i], mctC); if (mf > mMax) { mMax = mf; mPeakI = i; } }
      if (mN >= 5) {
        var mctPen = Math.min(s.mctPenaltyMax, Math.max(0, mMax - s.mctHot) * s.mctPerDeg);
        penalties += mctPen;
        if (mctPen > 0) evidence.push({ startTime: R.absT(mPeakI), peakTime: R.absT(mPeakI), severity: mMax >= s.mctCritical ? 'critical' : 'warning', label: 'Charge air hot', message: 'MCT / IAT reached ' + degF(mMax) + ' under demand (heat soak / intercooler)', values: { peakF: Math.round(mMax) } });
        details.push({ label: 'Charge air peak' + (dem.source ? ' (' + dem.source + ' ≥ ' + s.mctDemandMin + ' %)' : ''), value: degF(mMax), time: R.absT(mPeakI) });
      } else details.push({ label: 'Charge air', value: 'no samples under demand' });
    } else details.push({ label: 'Charge air', value: 'not logged' });
    // trans
    if (tft) {
      var tPeakI = -1, tMax = -Infinity;
      for (i = 0; i < N; i++) { if (!fin(tft[i])) continue; var tf = toF(tft[i], tftC); if (tf > tMax) { tMax = tf; tPeakI = i; } }
      if (tPeakI >= 0) {
        var transPen = Math.min(s.transPenaltyMax, Math.max(0, tMax - s.transHot) * s.transPerDeg);
        penalties += transPen;
        if (transPen > 0) evidence.push({ startTime: R.absT(tPeakI), peakTime: R.absT(tPeakI), severity: tMax >= s.transCritical ? 'critical' : 'warning', label: 'Transmission hot', message: 'Trans fluid reached ' + degF(tMax), values: { peakF: Math.round(tMax) } });
        details.push({ label: 'Trans fluid peak', value: degF(tMax), time: R.absT(tPeakI) });
      }
    } else details.push({ label: 'Trans fluid', value: 'not logged' });
    var score = fClamp(100 - penalties);
    if (n < s.minSamples) warnings.push('Only ' + n + ' samples — low confidence.');
    var summary = (score >= 90 ? 'Temperatures in check' : score >= 70 ? 'Running warm' : 'Running hot') + ' — ECT peak ' + degF(maxF) + (mct && isFinite(mMax) && mMax > -Infinity ? ', charge air ' + degF(mMax) : '') + (tft && tMax > -Infinity ? ', trans ' + degF(tMax) : '') + '.';
    return { score: score, confidence: Math.min(1, n / (s.minSamples * 3)), summary: summary, details: details, evidence: evidence, warnings: warnings, evaluatedSampleCount: n, evaluatedTimeRange: R.range };
  }
  SC.registerEvaluator({
    id: 'temps', name: 'Temperature Management', status: 'experimental', evaluatorVersion: '0.9.0',
    description: 'Coolant peak and time hot, charge-air temperature under demand, transmission fluid peak.',
    requiredChannels: [{ role: 'engine_coolant_temp', label: 'Engine Coolant Temp' }],
    optionalChannels: [{ role: 'manifold_charge_temp' }, { role: 'trans_temp' }, { role: 'accelerator_pedal_position' }, { role: 'throttle_position' }],
    defaultSettings: extend(TEMPS_DEFAULTS, null), settingsMeta: TEMPS_META, evaluate: computeTemps
  });

  // ===============================================================================================
  // OVERALL CONSISTENCY -- run-to-run: peak boost, median WOT lambda and peak knock across the pulls in
  //   the log (spread beyond tolerance = the tune behaves differently pull to pull: heat soak, fuel,
  //   control). Plus logging quality: time gaps and blank samples in the key channels.
  // ===============================================================================================
  var CONSIST_DEFAULTS = {
    demandThreshold: 80, settleSec: 0.8, minRunSec: 1.5,
    boostTolPsi: 1.5, boostPerPsi: 8, boostPenaltyMax: 30,
    lambdaTol: 0.03, lambdaPerLambda: 400, lambdaPenaltyMax: 30,
    knockTolDeg: 0.5, knockPerDeg: 8, knockPenaltyMax: 20,
    gapSec: 1.0, gapPoints: 5, gapPenaltyMax: 20,
    missingTolPct: 2, missingPerPct: 4, missingPenaltyMax: 20
  };
  var CONSIST_META = {
    demandThreshold: ['Pull demand', '%', 'Pedal / throttle at/above this = a pull'], settleSec: ['Settle', 's'], minRunSec: ['Minimum pull', 's', 'Shorter pulls are not compared'],
    boostTolPsi: ['Peak-boost spread free', 'psi', 'Across pulls'], boostPerPsi: ['Points per psi spread', 'pts'], boostPenaltyMax: ['Boost spread penalty cap', 'pts'],
    lambdaTol: ['WOT lambda spread free', 'λ', 'Across pull medians'], lambdaPerLambda: ['Points per λ spread', 'pts'], lambdaPenaltyMax: ['Lambda spread penalty cap', 'pts'],
    knockTolDeg: ['Peak-knock spread free', '°'], knockPerDeg: ['Points per ° spread', 'pts'], knockPenaltyMax: ['Knock spread penalty cap', 'pts'],
    gapSec: ['Logging gap', 's', 'A longer pause between samples is a dropout'], gapPoints: ['Points per gap', 'pts'], gapPenaltyMax: ['Gap penalty cap', 'pts'],
    missingTolPct: ['Blank samples free', '%', 'Worst key channel'], missingPerPct: ['Points per % blank', 'pts'], missingPenaltyMax: ['Blank penalty cap', 'pts']
  };
  function computeConsistency(ctx) {
    var s = extend(CONSIST_DEFAULTS, ctx.settings), R = rangeOf(ctx);
    var rpm = ctx.rangeSeries('engine_rpm'); if (!rpm) return notEval('Engine RPM not logged.');
    var N = rpm.length, dem = demandSeries(ctx), boost = ctx.rangeSeries('boost_pressure'), lam = ctx.rangeSeries('lambda_bank_1') || ctx.rangeSeries('lambda_bank_2'), knock = ctx.rangeSeries('total_knock');
    var evidence = [], details = [], warnings = [], penalties = 0, i;
    // logging quality
    var gaps = [], missWorst = null;
    for (i = 1; i < N; i++) { var dt = R.absT(i) - R.absT(i - 1); if (dt > s.gapSec) gaps.push({ i: i, dt: dt }); }
    var keyRoles = ['engine_rpm', 'accelerator_pedal_position', 'throttle_position', 'boost_pressure', 'lambda_bank_1', 'total_knock'];
    keyRoles.forEach(function (role) { var ser = ctx.rangeSeries(role); if (!ser) return; var miss = 0; for (var k = 0; k < ser.length; k++) if (!fin(ser[k])) miss++; var p = miss / ser.length * 100; if (!missWorst || p > missWorst.p) missWorst = { role: role, p: p, channel: ctx.channelFor(role) }; });
    var gapPen = Math.min(s.gapPenaltyMax, gaps.length * s.gapPoints), missPen = missWorst ? Math.min(s.missingPenaltyMax, Math.max(0, missWorst.p - s.missingTolPct) * s.missingPerPct) : 0;
    penalties += gapPen + missPen;
    if (gapPen > 0) { var g0 = gaps[0]; gaps.forEach(function (g) { if (g.dt > g0.dt) g0 = g; }); evidence.push({ startTime: R.absT(g0.i - 1), endTime: R.absT(g0.i), peakTime: R.absT(g0.i), severity: 'warning', label: 'Logging gap', message: gaps.length + ' gap' + (gaps.length === 1 ? '' : 's') + ' longer than ' + s.gapSec + ' s; longest ' + round1(g0.dt) + ' s', values: { gaps: gaps.length } }); }
    if (missPen > 0) evidence.push({ startTime: R.range.startTime, severity: 'warning', label: 'Blank samples', message: round1(missWorst.p) + ' % of ' + missWorst.channel + ' is blank', values: { missingPct: round1(missWorst.p) } });
    // pulls
    function inPull(i) { var d = dem.at(i); return d != null && d >= s.demandThreshold && fin(rpm[i]); }
    var pulls = dem.source ? runsWhere(N, inPull, R.absT, s.settleSec, s.minRunSec).filter(function (r) { return !r.brief; }) : [];
    pulls.forEach(function (r) {
      var pb = -Infinity, lams = [], pk = 0, pr = -Infinity;
      for (var k = r.settledI; k <= r.endI; k++) {
        if (boost && fin(boost[k]) && boost[k] > pb) pb = boost[k];
        if (lam && fin(lam[k]) && lam[k] > 0.5 && lam[k] < 1.5) lams.push(lam[k]);
        if (knock && fin(knock[k]) && Math.abs(knock[k]) > pk) pk = Math.abs(knock[k]);
        if (fin(rpm[k]) && rpm[k] > pr) pr = rpm[k];
      }
      r.peakBoost = isFinite(pb) ? pb : null; r.lam = lams.length >= 5 ? pct(lams.sort(fAsc), 0.5) : null; r.knock = knock ? pk : null; r.peakRpm = pr;
    });
    function spread(key) { var v = pulls.map(function (r) { return r[key]; }).filter(function (x) { return x != null; }); if (v.length < 2) return null; var mn = Math.min.apply(null, v), mx = Math.max.apply(null, v); var lo = null, hi = null; pulls.forEach(function (r) { if (r[key] === mn && !lo) lo = r; if (r[key] === mx && !hi) hi = r; }); return { n: v.length, min: mn, max: mx, span: mx - mn, lo: lo, hi: hi }; }
    var sb = spread('peakBoost'), sl = spread('lam'), sk = spread('knock');
    if (sb) { var bp = Math.min(s.boostPenaltyMax, Math.max(0, sb.span - s.boostTolPsi) * s.boostPerPsi); penalties += bp;
      if (bp > 0) evidence.push({ startTime: sb.lo.onsetT, endTime: sb.lo.endT, peakTime: sb.lo.startT, severity: sb.span > s.boostTolPsi * 3 ? 'critical' : 'warning', label: 'Boost varies pull to pull', message: 'Peak boost ' + round1(sb.min) + '–' + round1(sb.max) + ' psi across ' + sb.n + ' pulls (lowest pull shown)', values: { spanPsi: round1(sb.span) } });
      details.push({ label: 'Peak boost per pull', value: pulls.map(function (r) { return r.peakBoost == null ? '–' : round1(r.peakBoost); }).join(' / ') + ' psi', time: sb.lo.startT, startTime: sb.lo.onsetT, endTime: sb.lo.endT }); }
    if (sl) { var lp = Math.min(s.lambdaPenaltyMax, Math.max(0, sl.span - s.lambdaTol) * s.lambdaPerLambda); penalties += lp;
      if (lp > 0) evidence.push({ startTime: sl.hi.onsetT, endTime: sl.hi.endT, peakTime: sl.hi.startT, severity: sl.span > s.lambdaTol * 3 ? 'critical' : 'warning', label: 'WOT lambda varies pull to pull', message: 'Pull medians ' + lam2(sl.min) + '–' + lam2(sl.max) + ' across ' + sl.n + ' pulls (leanest pull shown)', values: { span: +lam2(sl.span) } });
      details.push({ label: 'WOT lambda per pull', value: pulls.map(function (r) { return r.lam == null ? '–' : lam2(r.lam); }).join(' / '), time: sl.hi.startT, startTime: sl.hi.onsetT, endTime: sl.hi.endT }); }
    if (sk) { var kp = Math.min(s.knockPenaltyMax, Math.max(0, sk.span - s.knockTolDeg) * s.knockPerDeg); penalties += kp;
      if (kp > 0) evidence.push({ startTime: sk.hi.onsetT, endTime: sk.hi.endT, peakTime: sk.hi.startT, severity: 'warning', label: 'Knock varies pull to pull', message: 'Peak knock ' + round1(sk.min) + '–' + round1(sk.max) + '° across ' + sk.n + ' pulls', values: { spanDeg: round1(sk.span) } });
      details.push({ label: 'Peak knock per pull', value: pulls.map(function (r) { return r.knock == null ? '–' : round1(r.knock); }).join(' / ') + '°', time: sk.hi.startT, startTime: sk.hi.onsetT, endTime: sk.hi.endT }); }
    var score = fClamp(100 - penalties);
    details.unshift({ label: 'Pulls compared', value: pulls.length + (pulls.length ? ' (' + pulls.map(function (r) { return round1(r.dur) + ' s'; }).join(', ') + ')' : '') + (dem.source ? '' : ' — no pedal / throttle') });
    details.push({ label: 'Logging', value: grp(N) + ' samples, ' + gaps.length + ' gap' + (gaps.length === 1 ? '' : 's') + (missWorst ? ', blanks up to ' + round1(missWorst.p) + ' %' : '') });
    if (pulls.length < 2) warnings.push(pulls.length === 0 ? 'No pull ' + (dem.source ? '(' + dem.source + ' ≥ ' + s.demandThreshold + ' % for ' + (s.settleSec + s.minRunSec) + ' s)' : '(no pedal / throttle channel)') + ' — only logging quality scored.' : 'Only one pull — run-to-run spread needs at least two.');
    var summary = pulls.length >= 2
      ? ((score >= 90 ? 'Consistent pull to pull' : score >= 70 ? 'Some pull-to-pull drift' : 'Pulls differ markedly') + ' over ' + pulls.length + ' pulls' + (sb ? ' (boost ' + round1(sb.min) + '–' + round1(sb.max) + ' psi)' : '') + '.')
      : ('Logging quality only: ' + gaps.length + ' gap' + (gaps.length === 1 ? '' : 's') + (missWorst ? ', ' + round1(missWorst.p) + ' % blank at worst' : '') + '.');
    return { score: score, confidence: pulls.length >= 2 ? Math.min(1, 0.5 + pulls.length * 0.15) : 0.4, summary: summary, details: details, evidence: evidence, warnings: warnings, evaluatedSampleCount: N, evaluatedTimeRange: R.range };
  }
  SC.registerEvaluator({
    id: 'consistency', name: 'Overall Consistency', status: 'experimental', evaluatorVersion: '0.9.0',
    description: 'Pull-to-pull spread of peak boost, WOT lambda and peak knock, plus logging gaps and blank samples.',
    requiredChannels: [{ role: 'engine_rpm', label: 'Engine Speed' }],
    optionalChannels: [{ role: 'accelerator_pedal_position' }, { role: 'throttle_position' }, { role: 'boost_pressure' }, { role: 'lambda_bank_1' }, { role: 'total_knock' }],
    defaultSettings: extend(CONSIST_DEFAULTS, null), settingsMeta: CONSIST_META, evaluate: computeConsistency
  });

  // Settings labels for the three original evaluators (tunable from the card's configuration dialog).
  var KNOCK_META = {
    loadThreshold: ['Load threshold', '%', 'Pedal / throttle / load at/above this = under load'], boostThreshold: ['Boost threshold', 'psi', 'Boosted also counts as under load'], rpmFloor: ['RPM floor', 'rpm'],
    deadbandDeg: ['Noise deadband', '°', 'Ignore knock below this'], eventThresholdDeg: ['Event threshold', '°', 'A knock event starts here'], peakPointsPerDeg: ['Points per ° peak knock', 'pts'],
    prevalencePenaltyMax: ['Prevalence penalty cap', 'pts', 'How often knock occurs under load'], criticalDeg: ['Critical knock', '°'], minLoadSamples: ['Minimum load samples', '']
  };
  var FUELING_META = {
    profile: ['Legacy profile override', '', 'auto / na / fi / eco — the card pulldowns are the normal way'], targetOverride: ['WOT target override', 'λ', 'Blank = use the Type / Fuel pulldowns'], richMargin: ['Richer than needed below target −', 'λ'],
    cruiseTarget: ['Cruise lambda target', 'λ'], cruiseTol: ['Cruise tolerance', 'λ'], cmdStoichTol: ['Commanded-stoich tolerance', 'λ', 'Cruise only counts while the PCM commands within this of 1.00'],
    wotPedalThreshold: ['WOT pedal', '%'], wotLoadThreshold: ['WOT throttle / load', '%', 'Used when no pedal is logged'], wotAirLoadThreshold: ['WOT air load', '%'],
    cruisePedalMin: ['Cruise pedal low', '%'], cruisePedalMax: ['Cruise pedal high', '%'], cruiseLoadMin: ['Cruise throttle low', '%', 'No pedal'], cruiseLoadMax: ['Cruise throttle high', '%', 'No pedal'],
    wotSettleSec: ['WOT settle', 's', 'Power-enrichment transition skipped'], wotMinRunSec: ['WOT run minimum', 's'], cruiseSettleSec: ['Cruise settle', 's'], steadyWindowSec: ['Steady window', 's'], steadyRatePct: ['Steady demand change', '%'],
    boostThreshold: ['Boost threshold', 'psi'], rpmFloor: ['RPM floor', 'rpm'], minValidLambda: ['Lambda valid low', 'λ'], maxValidLambda: ['Lambda valid high', 'λ'],
    wotLeanPerLambda: ['Points per λ lean at WOT', 'pts'], leanSpikeMargin: ['Lean spike above target', 'λ'], spikePenaltyMax: ['Spike penalty cap', 'pts'],
    peDelaySec: ['PE delay free', 's', 'Commanded still near stoich after WOT onset'], peDelayPerSec: ['Points per s of PE delay', 'pts'], peDelayPenaltyMax: ['PE delay penalty cap', 'pts'],
    wotRichPct: ['Rich percentile', ''], wotRichPerLambda: ['Points per λ too rich', 'pts'], wotLeanPct: ['Lean percentile (legacy)', ''],
    commandedPerLambda: ['Points per λ off command', 'pts'], commandedPenaltyMax: ['Off-command penalty cap', 'pts'],
    imbalanceTol: ['Bank spread free', 'λ'], imbalancePerLambda: ['Points per λ bank spread', 'pts'], imbalancePenaltyMax: ['Bank spread penalty cap', 'pts'],
    trimTolPct: ['Fuel trim free', '%', 'STFT + LTFT at steady cruise'], trimPerPct: ['Points per % trim', 'pts'], trimPenaltyMax: ['Trim penalty cap', 'pts'],
    cruisePerLambda: ['Points per λ off stoich', 'pts'], cruisePenaltyMax: ['Off-stoich penalty cap', 'pts'], stoichAFR: ['Stoich AFR', '', 'For AFR-only logs'], minSamples: ['Minimum samples', '']
  };
  if (SC.getEvaluator('knock')) SC.getEvaluator('knock').settingsMeta = KNOCK_META;
  if (SC.getEvaluator('fueling_wot')) SC.getEvaluator('fueling_wot').settingsMeta = FUELING_META;
  if (SC.getEvaluator('fueling_part')) SC.getEvaluator('fueling_part').settingsMeta = FUELING_META;

  global.ScorecardEvaluators = {
    computeIdle: computeIdle, IDLE_DEFAULTS: IDLE_DEFAULTS, computeShift: computeShift, SHIFT_DEFAULTS: SHIFT_DEFAULTS,
    computeFuelPressure: computeFuelPressure, FUELP_DEFAULTS: FUELP_DEFAULTS, computeBoost: computeBoost, BOOST_DEFAULTS: BOOST_DEFAULTS,
    computeThrottle: computeThrottle, THROTTLE_DEFAULTS: THROTTLE_DEFAULTS, computeTemps: computeTemps, TEMPS_DEFAULTS: TEMPS_DEFAULTS,
    computeConsistency: computeConsistency, CONSIST_DEFAULTS: CONSIST_DEFAULTS, runsWhere: runsWhere, demandSeries: demandSeries,
    knockMagAt: knockMagAt, scoreFromMetrics: scoreFromMetrics, computeKnock: computeKnock,
    KNOCK_DEFAULTS: KNOCK_DEFAULTS, KNOCK_CYL_ROLES: KNOCK_CYL_ROLES,
    fuelLambdaAt: fuelLambdaAt, fuelProfile: fuelProfile, wotTargetFor: wotTargetFor, WOT_TARGETS: WOT_TARGETS, collectFueling: collectFueling,
    computeFuelingWot: computeFuelingWot, computeFuelingPart: computeFuelingPart, FUELING_DEFAULTS: FUELING_DEFAULTS
  };
})(typeof window !== 'undefined' ? window : globalThis);
