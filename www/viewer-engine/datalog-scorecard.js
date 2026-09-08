/* =================================================================================================
 * datalog-scorecard.js -- the BigData "Scorecard" custom-dash component.
 *
 * WHAT THIS IS
 *   A dashboard component (added through the same Custom Dash Builder as gauges/cards/bars) that
 *   renders as a compact TABLE, not an SVG gauge. It evaluates up to 10 aspects of a tune, each on a
 *   0-100 scale, via a modular EVALUATOR REGISTRY so real scoring algorithms can be dropped in one
 *   category at a time without touching the UI.
 *
 * HOW IT PLUGS INTO THE EXISTING ENGINE (see architecture notes in the review)
 *   - registered as a palette type via DASH_PALETTE (datalog-viewer.js)
 *   - built by createGaugeElement()'s scorecard branch (datalog-gauges.js) -> Scorecard.buildElement
 *   - its def lives in VIEWER_DASH.gauges[] like any gauge, so it saves/restores for free (JSON)
 *   - channels are requested as NORMALIZED ROLE IDs (datalog-presets.js NORMALIZED_CHANNEL_ROLES),
 *     resolved per-log by resolveChannelRoles() -> VIEWER_RESOLVED_ROLES. Evaluators never hardcode
 *     one exact channel name.
 *
 * DESIGN RULES (from the spec, enforced here)
 *   - Missing data is NEVER a score of 0. Unavailable -> status 'not_evaluated' with a reason.
 *   - Placeholder evaluators return not_evaluated; they must not imply a finished PBD standard.
 *   - One failing evaluator must not break the rest (per-category error isolation).
 *   - Business logic (scoring, thresholds, overall) lives in pure functions, testable in node
 *     (see dev/scorecard-test.js). The DOM renderer is a thin layer over those results.
 *
 * Style: ES5 vanilla JS to match datalog-gauges.js / datalog-viewer.js (loaded as a plain <script>,
 * exposes a single global `Scorecard`). Types are documented with JSDoc @typedef (no TS in this repo).
 * =============================================================================================== */
(function (global) {
  'use strict';

  /** Bump when the persisted scorecard def shape changes; migrateDef() upgrades older defs. */
  var SCORECARD_SCHEMA_VERSION = 1;
  var MAX_CATEGORIES = 10;

  // ------------------------------------------------------------------------------------------------
  // Types (JSDoc only -- documents the contract the same way the spec's TS interfaces would).
  // ------------------------------------------------------------------------------------------------
  /**
   * @typedef {'not_evaluated'|'critical'|'concern'|'review'|'good'|'excellent'|'error'} ScoreStatus
   * @typedef {Object} ScoreThreshold  @property {number} min @property {string} status @property {string} statusId
   * @typedef {Object} ScorecardCategoryConfig
   *   @property {string} id                 stable per-category id (survives reorder/rename)
   *   @property {string} evaluatorId        which evaluator computes it
   *   @property {string} label
   *   @property {string} [shortLabel]
   *   @property {string} [description]
   *   @property {boolean} enabled
   *   @property {number} weight             relative weight for weighted-average overall
   *   @property {number} order
   *   @property {Object} settings           evaluator-specific settings (opaque to the UI)
   * @typedef {Object} ScorecardEvidence
   *   @property {number} startTime @property {number} [endTime]
   *   @property {'info'|'warning'|'critical'} severity
   *   @property {string} label @property {string} message
   *   @property {string[]} [channelIds] @property {Object.<string,(number|string)>} [values]
   * @typedef {Object} ScorecardEvaluationDetail  @property {string} label @property {(string|number)} value
   * @typedef {Object} ScorecardEvaluationResult
   *   @property {string} categoryId @property {string} evaluatorId
   *   @property {number|null} score              0-100, or null when not evaluated
   *   @property {ScoreStatus} status
   *   @property {number} [confidence]            0-1
   *   @property {string} [summary]
   *   @property {ScorecardEvaluationDetail[]} [details]
   *   @property {ScorecardEvidence[]} [evidence]
   *   @property {string[]} [warnings]
   *   @property {number} [evaluatedSampleCount]
   *   @property {{start:number,end:number}} [evaluatedTimeRange]
   *   @property {string} [unavailableReason]
   *   @property {string[]} [missingRoles]        normalized roleIds that were required but absent
   *   @property {string} [evaluatorVersion]      traces a score to the exact algorithm version
   * @typedef {Object} ChannelRequirement  @property {string} role  @property {string} [label]
   * @typedef {Object} ScorecardEvaluator
   *   @property {string} id @property {string} name @property {string} description
   *   @property {'implemented'|'experimental'|'placeholder'|'unavailable'} status
   *   @property {string} evaluatorVersion
   *   @property {ChannelRequirement[]} requiredChannels
   *   @property {ChannelRequirement[]} [optionalChannels]
   *   @property {Object} defaultSettings
   *   @property {function(ScorecardEvaluationContext):ScorecardEvaluationResult} evaluate
   */

  // ================================================================================================
  // 1. SCORE THRESHOLDS + STATUS  (configuration, not hardcoded visual logic -- extensible later)
  // ================================================================================================
  /** Ordered high->low. statusId is the machine key; status is the human label. color is restrained. */
  var DEFAULT_SCORE_THRESHOLDS = [
    { min: 90, statusId: 'excellent', status: 'Excellent', color: '#22c55e' },
    { min: 80, statusId: 'good',      status: 'Good',      color: '#3fb27f' },
    { min: 60, statusId: 'review',    status: 'Review',    color: '#f5a623' },
    { min: 40, statusId: 'concern',   status: 'Concern',   color: '#f2711c' },
    { min: 0,  statusId: 'critical',  status: 'Critical',  color: '#d1132e' }
  ];
  var NOT_EVALUATED_META = { statusId: 'not_evaluated', status: 'Not Evaluated', color: '#8a8a92' };
  var ERROR_META = { statusId: 'error', status: 'Evaluation Error', color: '#d1132e' };

  /** @returns {number} clamped to [0,100]; NaN/Infinity -> 0. Decimals preserved. */
  function clampScore(v) {
    if (v == null || typeof v !== 'number' || !isFinite(v)) return 0;
    return v < 0 ? 0 : v > 100 ? 100 : v;
  }
  /** @returns {number} whole-number display value (rounded, clamped). */
  function roundScore(v, precision) {
    var p = precision || 0, f = Math.pow(10, p);
    return Math.round(clampScore(v) * f) / f;
  }
  /** Resolve a numeric score to its threshold meta. `thresholds` defaults to DEFAULT_SCORE_THRESHOLDS. */
  function statusForScore(score, thresholds) {
    var t = thresholds || DEFAULT_SCORE_THRESHOLDS;
    if (score == null || !isFinite(score)) return NOT_EVALUATED_META;
    var s = clampScore(score);
    for (var i = 0; i < t.length; i++) { if (s >= t[i].min) return t[i]; }
    return t[t.length - 1];
  }
  /** Meta for any status key (score bands + not_evaluated + error), for colors/labels in the UI. */
  function statusMetaById(statusId, thresholds) {
    if (statusId === 'not_evaluated') return NOT_EVALUATED_META;
    if (statusId === 'error') return ERROR_META;
    var t = thresholds || DEFAULT_SCORE_THRESHOLDS;
    for (var i = 0; i < t.length; i++) { if (t[i].statusId === statusId) return t[i]; }
    return NOT_EVALUATED_META;
  }

  // ================================================================================================
  // 2. OVERALL SCORE  (pure calculation; excludes not-evaluated categories by default)
  // ================================================================================================
  var OVERALL_MODES = ['weighted', 'average', 'lowest', 'disabled'];
  /**
   * @param {ScorecardEvaluationResult[]} results
   * @param {ScorecardCategoryConfig[]} categories   (parallel-ish; matched by categoryId)
   * @param {{mode?:string, includeNotEvaluatedAsZero?:boolean}} opts
   * @returns {{score:number|null, status:ScoreStatus, evaluatedCount:number, totalCount:number, mode:string}}
   */
  function computeOverall(results, categories, opts) {
    opts = opts || {};
    var mode = OVERALL_MODES.indexOf(opts.mode) !== -1 ? opts.mode : 'weighted';
    var total = results.length;
    if (mode === 'disabled') return { score: null, status: 'not_evaluated', evaluatedCount: 0, totalCount: total, mode: mode };
    var catById = {};
    (categories || []).forEach(function (c) { catById[c.id] = c; });
    // Only VALID, evaluated categories count -- a not_evaluated category must NOT drag the score to 0
    // (unless the config explicitly opts in, which we don't expose by default).
    var valid = results.filter(function (r) {
      if (r.score == null || !isFinite(r.score)) return !!opts.includeNotEvaluatedAsZero;
      return r.status !== 'error';
    });
    var evaluated = valid.length;
    if (!evaluated) return { score: null, status: 'not_evaluated', evaluatedCount: 0, totalCount: total, mode: mode };
    var score;
    if (mode === 'lowest') {
      score = Math.min.apply(null, valid.map(function (r) { return clampScore(r.score); }));
    } else if (mode === 'average') {
      score = valid.reduce(function (a, r) { return a + clampScore(r.score); }, 0) / evaluated;
    } else { // weighted
      var wsum = 0, num = 0;
      valid.forEach(function (r) {
        var w = catById[r.categoryId] ? Math.max(0, +catById[r.categoryId].weight || 0) : 1;
        if (w <= 0) w = 0; // a 0-weight category contributes nothing but is still "evaluated"
        num += clampScore(r.score) * w; wsum += w;
      });
      score = wsum > 0 ? num / wsum
        : valid.reduce(function (a, r) { return a + clampScore(r.score); }, 0) / evaluated; // all weights 0 -> average
    }
    return { score: clampScore(score), status: statusForScore(score).statusId, evaluatedCount: evaluated, totalCount: total, mode: mode };
  }

  // ================================================================================================
  // 3. EVALUATOR REGISTRY
  // ================================================================================================
  /** @type {Object.<string, ScorecardEvaluator>} */
  var EVALUATORS = {};
  /** Register an evaluator. Later registrations override (so a real impl can replace a placeholder). */
  function registerEvaluator(ev) {
    if (!ev || !ev.id || typeof ev.evaluate !== 'function') throw new Error('Scorecard: invalid evaluator');
    if (!ev.status) ev.status = 'placeholder';
    if (!ev.evaluatorVersion) ev.evaluatorVersion = '0.0.0';
    if (!ev.requiredChannels) ev.requiredChannels = [];
    // requiredAnyOf: groups where AT LEAST ONE role must resolve (e.g. total knock OR any per-cylinder
    // knock). Each group is { label, roles:[roleId,...] }. Distinct from requiredChannels, which is AND.
    if (!ev.requiredAnyOf) ev.requiredAnyOf = [];
    if (!ev.defaultSettings) ev.defaultSettings = {};
    EVALUATORS[ev.id] = ev;
    return ev;
  }
  function getEvaluator(id) { return EVALUATORS[id] || null; }
  /** Evaluators offered in the config picker (dev-only one hidden unless SCORECARD_DEV is on). */
  function listEvaluators() {
    return Object.keys(EVALUATORS).map(function (k) { return EVALUATORS[k]; })
      .filter(function (e) { return e.id !== '_dev' || global.SCORECARD_DEV === true; });
  }

  // ================================================================================================
  // 4. EVALUATION CONTEXT  (controlled, read-only access to the log for an evaluator)
  // ================================================================================================
  /**
   * Builds the SHARED data context once per evaluation pass (spec: don't re-scan channels per category).
   * @param {Object} dl  { data, resolvedRoles, channelStats, vehicle, range }
   *   data          = VIEWER_DATA ({channels, units, time, series})
   *   resolvedRoles = VIEWER_RESOLVED_ROLES (roleId -> channel name)
   *   channelStats  = VIEWER_CHANNEL_STATS
   *   vehicle       = VIEWER_VEHICLE_META (or null)
   *   range         = {mode, startIdx, endIdx, startTime, endTime}
   */
  function buildSharedContext(dl) {
    var data = dl.data || { channels: [], units: [], time: [], series: {} };
    var roles = dl.resolvedRoles || {};
    var stats = dl.channelStats || {};
    var time = data.time || [];
    var r = dl.range || { mode: 'entire', startIdx: 0, endIdx: Math.max(0, time.length - 1) };
    var sampleRateHz = null;
    if (time.length > 1) { var dt = (time[time.length - 1] - time[0]) / (time.length - 1); if (dt > 0) sampleRateHz = 1 / dt; }
    return {
      data: data, roles: roles, stats: stats, time: time, range: r,
      unitByChannel: dl.unitByChannel || {},
      meta: {
        fileName: dl.fileName || null,
        channelCount: (data.channels || []).length,
        sampleCount: time.length,
        rangeSampleCount: Math.max(0, r.endIdx - r.startIdx + 1),
        timeRange: time.length ? { start: time[0], end: time[time.length - 1] } : { start: 0, end: 0 },
        evaluatedTimeRange: time.length ? { start: time[r.startIdx] || 0, end: time[r.endIdx] || 0 } : { start: 0, end: 0 },
        sampleRateHz: sampleRateHz
      },
      vehicle: dl.vehicle || null
    };
  }
  /**
   * Per-category context handed to evaluate(). Wraps the shared context with role lookup + a slice view.
   * `channelFor(role)` / `series(role)` return null when unresolved so evaluators degrade to not_evaluated.
   */
  function makeEvalContext(shared, category, evaluator) {
    var roles = shared.roles, data = shared.data, r = shared.range;
    function channelFor(role) { return roles[role] || null; }
    function series(role) {
      var ch = channelFor(role); if (!ch) return null;
      return data.series[ch] || null;
    }
    /** Samples within the current evaluation range only (spec: evaluators score relevant regions). */
    function rangeSeries(role) {
      var s = series(role); if (!s) return null;
      return s.slice(r.startIdx, r.endIdx + 1);
    }
    function statsFor(role) { var ch = channelFor(role); return ch ? (shared.stats[ch] || null) : null; }
    function unitFor(role) { var ch = channelFor(role); return ch ? (shared.unitByChannel[ch] || '') : ''; }
    // Which of a role LIST actually resolved on this log (e.g. the available per-cylinder knock channels),
    // and the first resolved channel among them -- so an evaluator can aggregate whatever the log provides.
    function rolesResolved(roles) { return (roles || []).filter(function (rl) { return !!channelFor(rl); }); }
    function anyRole(roles) { var m = rolesResolved(roles); return m.length ? channelFor(m[0]) : null; }
    return {
      meta: shared.meta, vehicle: shared.vehicle, range: r, time: shared.time,
      category: category, settings: category.settings || {}, evaluatorId: evaluator.id,
      channelFor: channelFor, series: series, rangeSeries: rangeSeries, statsFor: statsFor, unitFor: unitFor,
      rolesResolved: rolesResolved, anyRole: anyRole,
      hasRole: function (role) { return !!channelFor(role); }
    };
  }

  // ================================================================================================
  // 5. EVALUATION PIPELINE  (error isolation + missing-channel handling per category)
  // ================================================================================================
  /** Standard result for "the algorithm hasn't been built yet". */
  function notEvaluated(category, evaluator, reason, missingRoles) {
    return {
      categoryId: category.id, evaluatorId: evaluator ? evaluator.id : category.evaluatorId,
      score: null, status: 'not_evaluated',
      unavailableReason: reason || 'Scoring algorithm has not been configured.',
      missingRoles: missingRoles || [], evaluatorVersion: evaluator ? evaluator.evaluatorVersion : undefined
    };
  }
  /** Evaluate ONE category. Never throws -- wraps evaluate() so a bad evaluator can't sink the pass. */
  function evaluateCategory(shared, category) {
    var evaluator = getEvaluator(category.evaluatorId);
    if (!evaluator) return notEvaluated(category, null, 'Unknown evaluator "' + category.evaluatorId + '".');
    // Missing-channel gate: required roles must resolve in THIS log, else -> not_evaluated (not 0).
    var missing = [];
    (evaluator.requiredChannels || []).forEach(function (req) { if (!shared.roles[req.role]) missing.push(req.role); });
    // any-of groups: at least one role in each group must resolve (e.g. total OR per-cylinder knock).
    (evaluator.requiredAnyOf || []).forEach(function (grp) {
      var roles = grp.roles || grp;
      var anyPresent = roles.some(function (r) { return !!shared.roles[r]; });
      if (!anyPresent) missing.push(grp.label || ('one of: ' + roles.join(', ')));
    });
    if (missing.length) {
      var res = notEvaluated(category, evaluator, 'Required channels are not assigned.', missing);
      res.warnings = ['Missing normalized channels: ' + missing.join(', ')];
      return res;
    }
    try {
      var ctx = makeEvalContext(shared, category, evaluator);
      var out = evaluator.evaluate(ctx) || {};
      return normalizeResult(out, category, evaluator, shared);
    } catch (err) {
      if (global.console && console.warn) console.warn('Scorecard evaluator "' + evaluator.id + '" failed:', err);
      return {
        categoryId: category.id, evaluatorId: evaluator.id, score: null, status: 'error',
        unavailableReason: 'This category could not be evaluated.', evaluatorVersion: evaluator.evaluatorVersion,
        warnings: ['Evaluator error: ' + (err && err.message ? err.message : String(err))]
      };
    }
  }
  /** Coerce an evaluator's raw return into a valid, clamped result. */
  function normalizeResult(out, category, evaluator, shared) {
    var hasScore = out.score != null && isFinite(out.score);
    var status = out.status;
    if (hasScore) { status = statusForScore(out.score).statusId; }
    else if (!status || status === 'not_evaluated') {
      // Not evaluated, but KEEP any explanation the evaluator provided (summary / details / evidence /
      // warnings) -- e.g. knock reporting which source it found, or why there wasn't enough data.
      var ne = notEvaluated(category, evaluator, out.unavailableReason, out.missingRoles);
      if (out.summary) ne.summary = out.summary;
      if (out.details && out.details.length) ne.details = out.details;
      if (out.evidence && out.evidence.length) ne.evidence = out.evidence;
      if (out.warnings && out.warnings.length) ne.warnings = out.warnings;
      if (out.confidence != null) ne.confidence = out.confidence;
      return ne;
    }
    return {
      categoryId: category.id, evaluatorId: evaluator.id,
      score: hasScore ? clampScore(out.score) : null, status: status || 'not_evaluated',
      confidence: out.confidence, summary: out.summary, details: out.details || [], evidence: out.evidence || [],
      warnings: out.warnings || [], unavailableReason: out.unavailableReason,
      evaluatedSampleCount: out.evaluatedSampleCount != null ? out.evaluatedSampleCount : shared.meta.rangeSampleCount,
      evaluatedTimeRange: out.evaluatedTimeRange || shared.meta.evaluatedTimeRange,
      evaluatorVersion: evaluator.evaluatorVersion
    };
  }
  /**
   * Run a full scorecard evaluation. Returns per-category results + overall + a summary state.
   * @param {ScorecardDef} def
   * @param {Object} dl  the data-load context (see buildSharedContext)
   * @returns {{results:ScorecardEvaluationResult[], overall:Object, state:string, evaluatedCount:number, totalCount:number}}
   */
  function runScorecard(def, dl) {
    var cats = enabledCategories(def);
    if (!dl || !dl.data || !(dl.data.time || []).length) {
      return { results: [], overall: { score: null, status: 'not_evaluated' }, state: 'no_data', evaluatedCount: 0, totalCount: cats.length };
    }
    if (!cats.length) {
      return { results: [], overall: { score: null, status: 'not_evaluated' }, state: 'empty', evaluatedCount: 0, totalCount: 0 };
    }
    var shared = buildSharedContext(dl);
    var results = cats.map(function (c) { return evaluateCategory(shared, c); });
    var scored = results.filter(function (r) { return r.score != null; }).length;
    var overall = computeOverall(results, cats, {
      mode: (def.overall && def.overall.enabled === false) ? 'disabled' : (def.overall ? def.overall.mode : 'weighted')
    });
    var state = scored === 0 ? 'none_evaluated' : scored < results.length ? 'partial' : 'complete';
    return { results: results, overall: overall, state: state, evaluatedCount: scored, totalCount: results.length };
  }

  // ================================================================================================
  // 6. CONFIG MODEL + FACTORY + MIGRATION
  // ================================================================================================
  /** The 10 recommended categories (equal weight). evaluatorId maps to the registry below. */
  var RECOMMENDED_CATEGORIES = [
    { evaluatorId: 'knock',        label: 'Knock' },
    { evaluatorId: 'fueling_wot',  label: 'WOT Fueling' },          // open-loop power enrichment (Ken 2026-07-28)
    { evaluatorId: 'fueling_part', label: 'Part-Throttle Fueling' },// closed-loop cruise + fuel trims
    { evaluatorId: 'idle',         label: 'Idle Quality' },
    { evaluatorId: 'shift',        label: 'Shift Quality' },
    { evaluatorId: 'fuel_pressure',label: 'Fuel Pressure' },
    { evaluatorId: 'boost',        label: 'Boost Control' },
    { evaluatorId: 'throttle',     label: 'Throttle Control' },
    { evaluatorId: 'temps',        label: 'Temperature Management' },
    { evaluatorId: 'consistency',  label: 'Overall Consistency' }
  ];
  var _cid = 1;
  function newCategoryId() { return 'sc-cat-' + (Date.now().toString(36)) + '-' + (_cid++); }
  function makeCategory(seed, order) {
    var ev = getEvaluator(seed.evaluatorId);
    return {
      id: seed.id || newCategoryId(), evaluatorId: seed.evaluatorId,
      label: seed.label || (ev ? ev.name : seed.evaluatorId), shortLabel: seed.shortLabel || '',
      description: seed.description || (ev ? ev.description : ''), enabled: seed.enabled !== false,
      weight: seed.weight != null ? seed.weight : 1, order: seed.order != null ? seed.order : (order || 0),
      settings: seed.settings || (ev ? JSON.parse(JSON.stringify(ev.defaultSettings)) : {})
    };
  }
  function recommendedCategories() { return RECOMMENDED_CATEGORIES.map(function (s, i) { return makeCategory(s, i); }); }
  /** @returns {ScorecardDef} a fresh scorecard component def (goes straight into VIEWER_DASH.gauges). */
  function makeDef(x, y) {
    return {
      id: 'dash-sc-' + (Date.now().toString(36)),
      type: 'scorecard',
      x: x || 0, y: y || 0, w: 320, h: 300,
      scHubVersion: SCORECARD_SCHEMA_VERSION,
      title: 'Scorecard', subtitle: 'Tune Performance Evaluation',
      display: {
        showSubtitle: true, showOverall: true, showScoreBars: true, showStatusLabels: true,
        showDescriptions: false, showDetails: true, precision: 0, density: 'comfortable'
      },
      overall: { enabled: true, mode: 'weighted' },
      range: { mode: 'entire' }, // entire | visible | selection | auto
      categories: recommendedCategories()
    };
  }
  /** Upgrade an older persisted def to the current schema. Never mutates the input reference's identity. */
  function migrateDef(def) {
    if (!def || def.type !== 'scorecard') return def;
    var v = def.scHubVersion || 0;
    if (v >= SCORECARD_SCHEMA_VERSION) return def;
    // v0 -> v1: ensure display/overall/range/categories exist with defaults; stamp version.
    var base = makeDef(def.x, def.y);
    def.display = mergeDefaults(def.display, base.display);
    def.overall = mergeDefaults(def.overall, base.overall);
    def.range = mergeDefaults(def.range, base.range);
    if (!Array.isArray(def.categories)) def.categories = recommendedCategories();
    def.categories.forEach(function (c, i) {
      if (!c.id) c.id = newCategoryId();
      if (c.weight == null) c.weight = 1;
      if (c.order == null) c.order = i;
      if (!c.settings) c.settings = {};
      if (c.enabled == null) c.enabled = true;
    });
    if (!def.title) def.title = base.title;
    def.scHubVersion = SCORECARD_SCHEMA_VERSION;
    return def;
  }
  function mergeDefaults(obj, defaults) {
    obj = obj || {}; Object.keys(defaults).forEach(function (k) { if (obj[k] === undefined) obj[k] = defaults[k]; });
    return obj;
  }
  /** Enabled categories, ordered, capped at MAX_CATEGORIES (safety). */
  function enabledCategories(def) {
    return (def.categories || []).filter(function (c) { return c.enabled; })
      .sort(function (a, b) { return (a.order || 0) - (b.order || 0); })
      .slice(0, MAX_CATEGORIES);
  }
  function enabledCount(def) { return (def.categories || []).filter(function (c) { return c.enabled; }).length; }

  // ================================================================================================
  // 7. Public API namespace (consumed by the viewer integration + the node tests)
  // ================================================================================================
  var Scorecard = {
    SCHEMA_VERSION: SCORECARD_SCHEMA_VERSION, MAX_CATEGORIES: MAX_CATEGORIES,
    DEFAULT_SCORE_THRESHOLDS: DEFAULT_SCORE_THRESHOLDS, OVERALL_MODES: OVERALL_MODES,
    clampScore: clampScore, roundScore: roundScore, statusForScore: statusForScore, statusMetaById: statusMetaById,
    computeOverall: computeOverall, registerEvaluator: registerEvaluator, getEvaluator: getEvaluator,
    listEvaluators: listEvaluators, evaluateCategory: evaluateCategory, runScorecard: runScorecard,
    buildSharedContext: buildSharedContext, notEvaluated: notEvaluated,
    makeDef: makeDef, migrateDef: migrateDef, makeCategory: makeCategory, recommendedCategories: recommendedCategories,
    enabledCategories: enabledCategories, enabledCount: enabledCount, RECOMMENDED_CATEGORIES: RECOMMENDED_CATEGORIES,
    // buildElement / openConfig / renderResults are attached by the DOM layer below (browser only).
    _evaluators: EVALUATORS
  };
  global.Scorecard = Scorecard;

  // ================================================================================================
  // 8. EVALUATORS -- 10 category placeholders + a dev evaluator. Real algorithms replace these later.
  //    Each declares requiredChannels as normalized ROLE IDs (extend NORMALIZED_CHANNEL_ROLES to add).
  //    Placeholders return not_evaluated on purpose: better than a misleading number. They still declare
  //    their channels so the pipeline can show the correct missing-channel vs not-configured state.
  // ================================================================================================
  // Every per-cylinder knock role the presets define (V8). A knock source = total OR any of these.
  var KNOCK_CYL_ROLES = ['knock_cylinder_1', 'knock_cylinder_2', 'knock_cylinder_3', 'knock_cylinder_4',
    'knock_cylinder_5', 'knock_cylinder_6', 'knock_cylinder_7', 'knock_cylinder_8'];
  function placeholder(id, name, description, required, optional, anyOf) {
    return registerEvaluator({
      id: id, name: name, description: description, status: 'placeholder', evaluatorVersion: '0.1.0-placeholder',
      requiredChannels: required || [], optionalChannels: optional || [], requiredAnyOf: anyOf || [], defaultSettings: {},
      evaluate: function (ctx) {
        // Required roles already verified present by the pipeline; the algorithm itself isn't built yet.
        return {
          score: null, status: 'not_evaluated',
          unavailableReason: 'Scoring algorithm not configured yet for "' + name + '".',
          summary: 'Placeholder category. Channels are available; the real ' + name + ' algorithm will be added in a later phase.'
        };
      }
    });
  }
  // Knock is special: it needs a knock SOURCE, which is total knock retard OR any per-cylinder knock
  // channel (some logs only have per-cylinder). requiredAnyOf models that. The placeholder reports which
  // source it found (detection only -- no score yet) so the any-of + per-cylinder wiring is visible.
  registerEvaluator({
    id: 'knock', name: 'Knock', status: 'placeholder', evaluatorVersion: '0.1.0-placeholder',
    description: 'Scores knock/detonation under meaningful load. Uses total knock retard, or aggregates per-cylinder knock when total is not logged.',
    requiredChannels: [], optionalChannels: [{ role: 'engine_rpm' }, { role: 'actual_load' }, { role: 'desired_load' }, { role: 'spark_advance' }],
    requiredAnyOf: [{ label: 'Knock Retard (total or per-cylinder)', roles: ['total_knock'].concat(KNOCK_CYL_ROLES) }],
    defaultSettings: {},
    evaluate: function (ctx) {
      var hasTotal = ctx.hasRole('total_knock');
      var cyls = ctx.rolesResolved(KNOCK_CYL_ROLES);
      var src = hasTotal ? 'total knock retard' : (cyls.length + ' per-cylinder knock channel' + (cyls.length === 1 ? '' : 's'));
      return {
        score: null, status: 'not_evaluated',
        unavailableReason: 'Knock scoring algorithm not configured yet.',
        summary: 'Knock source detected (' + src + '). The real knock algorithm will be added in a later phase.',
        details: [{ label: 'Total knock', value: hasTotal ? 'yes' : 'no' }, { label: 'Per-cylinder channels', value: cyls.length }]
      };
    }
  });
  // Fueling is split by operating region into two line items, both real evaluators in
  // datalog-scorecard-evaluators.js (these placeholders only stand in when that file isn't loaded, e.g.
  // the framework unit tests). Both need a fuel signal: lambda OR AFR, either bank (requiredAnyOf).
  var FUEL_ANYOF = [{ label: 'Lambda or AFR (either bank)', roles: ['lambda_bank_1', 'lambda_bank_2', 'afr_bank_1', 'afr_bank_2'] }];
  placeholder('fueling_wot', 'WOT Fueling', 'Scores open-loop power-enrichment lambda at WOT against the induction target window.',
    [], [{ role: 'commanded_lambda' }, { role: 'engine_rpm' }, { role: 'throttle_position' }, { role: 'actual_load' }, { role: 'boost_pressure' }], FUEL_ANYOF);
  placeholder('fueling_part', 'Part-Throttle Fueling', 'Scores closed-loop cruise lambda near stoich plus fuel trims.',
    [], [{ role: 'stft_bank_1' }, { role: 'ltft_bank_1' }, { role: 'stft_bank_2' }, { role: 'ltft_bank_2' }, { role: 'commanded_lambda' }, { role: 'engine_rpm' }, { role: 'throttle_position' }, { role: 'actual_load' }], FUEL_ANYOF);
  placeholder('idle', 'Idle Quality', 'Scores idle stability from RPM variation in idle regions.',
    [{ role: 'engine_rpm', label: 'Engine Speed' }], [{ role: 'throttle_position' }, { role: 'engine_coolant_temp' }]);
  placeholder('shift', 'Shift Quality', 'Scores transmission shift smoothness from gear + slip during shifts.',
    [{ role: 'current_gear', label: 'Current Gear' }], [{ role: 'commanded_gear' }, { role: 'trans_slip' }, { role: 'engine_rpm' }]);
  placeholder('fuel_pressure', 'Fuel Pressure', 'Compares actual vs desired fuel rail pressure under demand.',
    [{ role: 'fuel_pressure', label: 'Fuel Rail Pressure' }], [{ role: 'desired_fuel_pressure' }, { role: 'engine_rpm' }]);
  placeholder('boost', 'Boost Control', 'Compares actual vs desired boost during boosted operation.',
    [{ role: 'boost_pressure', label: 'Boost' }], [{ role: 'desired_boost' }, { role: 'throttle_position' }]);
  placeholder('throttle', 'Throttle Control', 'Scores throttle tracking vs pedal request.',
    [{ role: 'throttle_position', label: 'Throttle Position' }], [{ role: 'accelerator_pedal_position' }]);
  placeholder('temps', 'Temperature Management', 'Scores coolant and charge-air temperature control.',
    [{ role: 'engine_coolant_temp', label: 'Engine Coolant Temp' }], [{ role: 'manifold_charge_temp' }, { role: 'trans_temp' }]);
  placeholder('consistency', 'Overall Consistency', 'Scores overall run-to-run consistency across key channels.',
    [{ role: 'engine_rpm', label: 'Engine Speed' }], [{ role: 'throttle_position' }, { role: 'vehicle_speed' }]);

  // Development-only evaluator: returns a controlled result so every visual state can be exercised
  // without a real log. Hidden from the config picker unless global.SCORECARD_DEV === true, and it
  // registers itself so tests can use it directly. NOT a tuning algorithm.
  registerEvaluator({
    id: '_dev', name: 'Dev / Test', description: 'Returns a controlled result for UI/state testing. Development only.',
    status: 'experimental', evaluatorVersion: 'dev', requiredChannels: [], defaultSettings: { mode: '92' },
    evaluate: function (ctx) {
      var mode = String((ctx.settings && ctx.settings.mode) || '92');
      if (mode === 'not_evaluated') return { score: null, status: 'not_evaluated', unavailableReason: 'Dev: forced Not Evaluated.' };
      if (mode === 'error') throw new Error('Dev: forced evaluator error.');
      var n = parseFloat(mode); if (!isFinite(n)) n = 92;
      return {
        score: n, status: statusForScore(n).statusId, confidence: 0.5,
        summary: 'Dev evaluator returned a fixed score of ' + n + ' for state testing.',
        details: [{ label: 'Mode', value: mode }, { label: 'Samples in range', value: ctx.meta.rangeSampleCount }],
        evidence: n < 60 ? [{ startTime: ctx.meta.evaluatedTimeRange.start, endTime: ctx.meta.evaluatedTimeRange.end,
          severity: n < 40 ? 'critical' : 'warning', label: 'Demo event', message: 'Synthetic evidence for state testing.' }] : []
      };
    }
  });

  // ================================================================================================
  // 9. DOM LAYER (browser only) -- table renderer + config UI. Kept thin over the pure results above.
  //    Attaches Scorecard.buildElement / renderResults / openConfig when a document is present.
  // ================================================================================================
  if (typeof document !== 'undefined') { attachDomLayer(Scorecard); }

  function attachDomLayer(SC) {
    function esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;';
      });
    }

    /** Build the positioned dash element (called by createGaugeElement's scorecard branch). */
    SC.buildElement = function (def) {
      migrateDef(def);
      var wrap = document.createElement('div');
      wrap.className = 'pbd-gauge pbd-gauge-scorecard';
      wrap.dataset.gaugeId = def.id;
      wrap.style.width = (def.w || 320) + 'px';
      wrap.style.height = (def.h || 300) + 'px';
      var card = document.createElement('div');
      card.className = 'dlv-sc-card' + (def.display && def.display.density === 'compact' ? ' dlv-sc-compact' : '');
      card.setAttribute('role', 'region');
      card.setAttribute('aria-label', (def.title || 'Scorecard') + ' scorecard');
      wrap.appendChild(card);
      wrap._scCard = card;
      // Selection/move badge parity with gauges (dash edit-mode expects a .pbd-gauge-badge).
      var badge = document.createElement('div'); badge.className = 'pbd-gauge-badge'; badge.textContent = '!'; wrap.appendChild(badge);
      renderPlaceholderBody(card, def, 'no_data');
      return wrap;
    };

    /** Render a "state" body (no data / evaluating / etc.) before/without results. */
    function renderPlaceholderBody(card, def, state) {
      var msg = {
        no_data: 'No datalog loaded', loading: 'Datalog loading…', evaluating: 'Evaluating scorecard…',
        empty: 'No categories configured', none_evaluated: 'No categories could be evaluated'
      }[state] || 'No datalog loaded';
      card.innerHTML = headerHtml(def, null) + '<div class="dlv-sc-state" role="status">' + esc(msg) + '</div>';
    }
    // One combined header ROW: title/subtitle on the left, the Overall Score on the right (when shown).
    // Keeps the title and score off separate rows so the card wastes no vertical space up top.
    function headerHtml(def, run) {
      var d = def.display || {};
      var left = '<div class="dlv-sc-head-l"><div class="dlv-sc-title">' + esc(def.title || 'Scorecard') + '</div>' +
        (d.showSubtitle && def.subtitle ? '<div class="dlv-sc-sub">' + esc(def.subtitle) + '</div>' : '') + '</div>';
      var showOv = run && run.overall && d.showOverall !== false && def.overall && def.overall.enabled !== false;
      var right = '';
      if (showOv) {
        var o = run.overall, m = statusMetaById(o.status, def.thresholds || DEFAULT_SCORE_THRESHOLDS), prec = d.precision || 0;
        var scoreTxt = o.score == null ? '—' : String(roundScore(o.score, prec));
        var aria = o.score == null ? 'Overall not evaluated'
          : ('Overall score ' + roundScore(o.score, 0) + ' out of 100, ' + m.status + ', ' + o.evaluatedCount + ' of ' + o.totalCount + ' categories evaluated');
        right = '<div class="dlv-sc-head-r" aria-label="' + esc(aria) + '">' +
          '<div class="dlv-sc-ov-score" style="color:' + m.color + '">' + scoreTxt + '<span class="dlv-sc-ov-max">/100</span></div>' +
          '<div class="dlv-sc-ov-meta"><span class="dlv-sc-ov-status" style="color:' + m.color + '">' + esc(m.status) + '</span>' +
          '<span class="dlv-sc-ov-count">' + o.evaluatedCount + '/' + o.totalCount + ' evaluated</span></div></div>';
      }
      return '<div class="dlv-sc-head' + (showOv ? ' has-ov' : '') + '">' + left + right + '</div>';
    }

    /** Full render given evaluation results (called after runScorecard). */
    SC.renderResults = function (card, def, run) {
      if (!card) return;
      if (run.state === 'no_data' || run.state === 'loading' || run.state === 'evaluating') { return renderPlaceholderBody(card, def, run.state); }
      var d = def.display || {}, prec = d.precision || 0, thresholds = def.thresholds || DEFAULT_SCORE_THRESHOLDS;
      var html = headerHtml(def, run);
      if (!run.results.length) {
        html += '<div class="dlv-sc-state" role="status">' + (run.state === 'empty' ? 'No categories configured' : 'No categories could be evaluated') + '</div>';
        card.innerHTML = html; return;
      }
      // Rows
      html += '<div class="dlv-sc-rows" role="table" aria-label="Scorecard categories">';
      html += '<div class="dlv-sc-rowhead" role="row"><span role="columnheader">Category</span><span role="columnheader" class="dlv-sc-c-score">Score</span><span role="columnheader" class="dlv-sc-c-status">Status</span></div>';
      var catById = {}; (def.categories || []).forEach(function (c) { catById[c.id] = c; });
      run.results.forEach(function (r) {
        html += rowHtml(r, catById[r.categoryId] || { label: r.categoryId }, d, prec, thresholds);
      });
      html += '</div>';
      // Footer only when the Overall (which already shows the count) is hidden -- no duplicate row.
      var ovShown = run.overall && d.showOverall !== false && def.overall && def.overall.enabled !== false;
      if (!ovShown) html += '<div class="dlv-sc-foot">' + run.evaluatedCount + ' of ' + run.totalCount + ' categories evaluated</div>';
      card.innerHTML = html;
      wireDetails(card);
    };

    function rowHtml(r, cat, d, prec, thresholds) {
      var m = statusMetaById(r.status, thresholds);
      var scored = r.score != null;
      var scoreTxt = scored ? String(roundScore(r.score, prec)) : '—';
      var expandable = d.showDetails !== false && (r.summary || (r.details && r.details.length) || (r.evidence && r.evidence.length) || (r.missingRoles && r.missingRoles.length) || (r.warnings && r.warnings.length));
      var aria = cat.label + ' score: ' + (scored ? (roundScore(r.score, 0) + ' out of 100, ' + m.status) : m.status);
      var bar = (d.showScoreBars !== false && scored)
        ? '<span class="dlv-sc-bar"><span class="dlv-sc-bar-fill" style="width:' + roundScore(r.score, 0) + '%;background:' + m.color + '"></span></span>' : '';
      return '<div class="dlv-sc-row' + (expandable ? ' dlv-sc-expandable' : '') + '" role="row"' +
        (expandable ? ' tabindex="0" aria-expanded="false"' : '') + ' aria-label="' + esc(aria) + '">' +
        '<span class="dlv-sc-cat" role="cell">' + esc(cat.shortLabel || cat.label) +
        (d.showDescriptions && cat.description ? '<span class="dlv-sc-desc">' + esc(cat.description) + '</span>' : '') + '</span>' +
        '<span class="dlv-sc-score" role="cell">' + bar + '<b style="color:' + (scored ? m.color : NOT_EVALUATED_META.color) + '">' + scoreTxt + '</b>' +
        (scored ? '<span class="dlv-sc-max">/100</span>' : '') + '</span>' +
        '<span class="dlv-sc-status" role="cell" style="color:' + m.color + '">' +
        '<span class="dlv-sc-dot" style="background:' + m.color + '" aria-hidden="true"></span>' +
        (d.showStatusLabels !== false ? esc(m.status) : '') +
        (expandable ? '<span class="dlv-sc-caret" aria-hidden="true">›</span>' : '') + '</span>' +
        (expandable ? detailHtml(r) : '') + '</div>';
    }

    function detailHtml(r) {
      var parts = [];
      if (r.summary) parts.push('<div class="dlv-sc-d-summary">' + esc(r.summary) + '</div>');
      if (r.unavailableReason && r.score == null) parts.push('<div class="dlv-sc-d-reason">' + esc(r.unavailableReason) + '</div>');
      if (r.missingRoles && r.missingRoles.length) parts.push('<div class="dlv-sc-d-missing">Missing channels: ' + esc(r.missingRoles.join(', ')) + '</div>');
      if (r.details && r.details.length) {
        parts.push('<div class="dlv-sc-d-grid">' + r.details.map(function (x) {
          return '<span class="dlv-sc-d-k">' + esc(x.label) + '</span><span class="dlv-sc-d-v">' + esc(x.value) + '</span>'; }).join('') + '</div>');
      }
      if (r.evidence && r.evidence.length) {
        parts.push('<div class="dlv-sc-d-ev">' + r.evidence.slice(0, 5).map(function (e) {
          return '<div class="dlv-sc-ev sev-' + esc(e.severity) + '"><b>' + esc(e.label) + '</b> ' + esc(e.message) +
            ' <span class="dlv-sc-ev-t">' + fmtT(e.startTime) + (e.endTime != null ? '–' + fmtT(e.endTime) : '') + 's</span></div>'; }).join('') + '</div>');
      }
      if (r.confidence != null) parts.push('<div class="dlv-sc-d-conf">Confidence: ' + Math.round(r.confidence * 100) + '%</div>');
      if (r.warnings && r.warnings.length) parts.push('<div class="dlv-sc-d-warn">' + esc(r.warnings.join(' · ')) + '</div>');
      return '<div class="dlv-sc-detail" role="region" hidden>' + parts.join('') + '</div>';
    }
    function fmtT(t) { return (Math.round(t * 100) / 100).toFixed(2); }

    /** Keyboard + click row expansion (accessible). */
    function wireDetails(card) {
      card.querySelectorAll('.dlv-sc-expandable').forEach(function (row) {
        function toggle() {
          var det = row.querySelector('.dlv-sc-detail'); if (!det) return;
          var open = row.getAttribute('aria-expanded') === 'true';
          row.setAttribute('aria-expanded', open ? 'false' : 'true');
          if (open) det.setAttribute('hidden', ''); else det.removeAttribute('hidden');
          row.classList.toggle('open', !open);
        }
        row.addEventListener('click', function (e) { if (!e.target.closest('a')) toggle(); });
        row.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
      });
    }

    // ---- Config UI ------------------------------------------------------------------------------
    // Opened from dashAssignMenu when the component is a scorecard. Sections: General / Categories /
    // Range. Kept functional + compact; reuses the viewer's overlay/menu styling classes.
    SC.openConfig = function (def, onChange) {
      migrateDef(def);
      var ovl = document.createElement('div');
      ovl.className = 'dlv-sc-cfg-ovl';
      ovl.innerHTML = configHtml(def);
      document.body.appendChild(ovl);
      function close() { if (ovl.parentNode) ovl.parentNode.removeChild(ovl); }
      function commit() { def.scHubVersion = SCORECARD_SCHEMA_VERSION; if (onChange) onChange(def); }
      ovl.addEventListener('click', function (e) { if (e.target === ovl || e.target.closest('[data-sc-close]')) close(); });
      wireConfig(ovl, def, function () { rerenderConfigBody(ovl, def); commit(); }, commit);
      return { close: close };
    };

    function configHtml(def) {
      return '<div class="dlv-sc-cfg" role="dialog" aria-label="Scorecard settings">' +
        '<div class="dlv-sc-cfg-head"><b>Scorecard settings</b><button type="button" class="dlv-sc-cfg-x" data-sc-close aria-label="Close">×</button></div>' +
        '<div class="dlv-sc-cfg-tabs"><button type="button" class="on" data-sc-tab="general">General</button>' +
        '<button type="button" data-sc-tab="categories">Categories</button>' +
        '<button type="button" data-sc-tab="range">Evaluation range</button></div>' +
        '<div class="dlv-sc-cfg-body" data-sc-body></div></div>';
    }
    function rerenderConfigBody(ovl, def) {
      var tab = ovl.querySelector('.dlv-sc-cfg-tabs .on');
      var body = ovl.querySelector('[data-sc-body]');
      var which = tab ? tab.getAttribute('data-sc-tab') : 'general';
      body.innerHTML = which === 'categories' ? categoriesTab(def) : which === 'range' ? rangeTab(def) : generalTab(def);
    }
    function chk(id, label, on) { return '<label class="dlv-sc-cfg-row"><input type="checkbox" data-sc="' + id + '"' + (on ? ' checked' : '') + '> ' + esc(label) + '</label>'; }
    function generalTab(def) {
      var d = def.display;
      return '<label class="dlv-sc-cfg-row">Title <input type="text" data-sc="title" value="' + esc(def.title || '') + '"></label>' +
        '<label class="dlv-sc-cfg-row">Subtitle <input type="text" data-sc="subtitle" value="' + esc(def.subtitle || '') + '"></label>' +
        chk('display.showSubtitle', 'Show subtitle', d.showSubtitle) +
        chk('display.showOverall', 'Show Overall Score', d.showOverall) +
        '<label class="dlv-sc-cfg-row">Overall calculation <select data-sc="overall.mode">' +
        ['weighted', 'average', 'lowest', 'disabled'].map(function (m) { return '<option value="' + m + '"' + ((def.overall.mode === m || (m === 'disabled' && def.overall.enabled === false)) ? ' selected' : '') + '>' + m + '</option>'; }).join('') + '</select></label>' +
        chk('display.showScoreBars', 'Show score bars', d.showScoreBars) +
        chk('display.showStatusLabels', 'Show status labels', d.showStatusLabels) +
        chk('display.showDescriptions', 'Show category descriptions', d.showDescriptions) +
        chk('display.showDetails', 'Show expandable details', d.showDetails) +
        '<label class="dlv-sc-cfg-row">Score precision <select data-sc="display.precision"><option value="0"' + (d.precision === 0 ? ' selected' : '') + '>whole (92)</option><option value="1"' + (d.precision === 1 ? ' selected' : '') + '>1 decimal (92.4)</option></select></label>' +
        '<label class="dlv-sc-cfg-row">Row density <select data-sc="display.density"><option value="comfortable"' + (d.density !== 'compact' ? ' selected' : '') + '>Comfortable</option><option value="compact"' + (d.density === 'compact' ? ' selected' : '') + '>Compact</option></select></label>';
    }
    function categoriesTab(def) {
      var evs = listEvaluators();
      var rows = (def.categories || []).slice().sort(function (a, b) { return (a.order || 0) - (b.order || 0); }).map(function (c) {
        return '<div class="dlv-sc-cfg-cat" data-cat="' + esc(c.id) + '">' +
          '<span class="dlv-sc-cfg-drag" title="Reorder">≡</span>' +
          '<input type="checkbox" data-sc-cat="enabled" title="Enabled"' + (c.enabled ? ' checked' : '') + '>' +
          '<input type="text" class="dlv-sc-cfg-lbl" data-sc-cat="label" value="' + esc(c.label) + '">' +
          '<select class="dlv-sc-cfg-ev" data-sc-cat="evaluatorId">' + evs.map(function (e) {
            return '<option value="' + esc(e.id) + '"' + (e.id === c.evaluatorId ? ' selected' : '') + '>' + esc(e.name) + (e.status === 'placeholder' ? ' (placeholder)' : '') + '</option>'; }).join('') + '</select>' +
          '<input type="number" class="dlv-sc-cfg-w" data-sc-cat="weight" min="0" step="0.5" value="' + (c.weight != null ? c.weight : 1) + '" title="Weight">' +
          '<button type="button" class="dlv-sc-cfg-catx" data-sc-cat="remove" title="Remove">×</button></div>';
      }).join('');
      var count = enabledCount(def);
      return '<div class="dlv-sc-cfg-cats">' + rows + '</div>' +
        '<div class="dlv-sc-cfg-catbtns">' +
        '<button type="button" data-sc-act="add"' + (count >= MAX_CATEGORIES ? ' disabled' : '') + '>+ Add category</button>' +
        '<button type="button" data-sc-act="recommend">Restore recommended</button>' +
        '<button type="button" data-sc-act="reset">Reset scorecard</button>' +
        '<span class="dlv-sc-cfg-count">' + count + ' / ' + MAX_CATEGORIES + ' enabled</span></div>';
    }
    function rangeTab(def) {
      var opts = [['entire', 'Entire datalog'], ['visible', 'Current visible graph range'], ['selection', 'Current selection'], ['auto', 'Automatically detected operating regions']];
      return '<div class="dlv-sc-cfg-help">Which part of the log each category evaluates. Individual evaluators can further narrow to relevant regions (idle, shifts, boosted pulls) as those detectors are built.</div>' +
        opts.map(function (o) {
          return '<label class="dlv-sc-cfg-row"><input type="radio" name="sc-range" data-sc="range.mode" value="' + o[0] + '"' + (def.range.mode === o[0] ? ' checked' : '') + '> ' + esc(o[1]) + (o[0] === 'auto' ? ' <span class="dlv-sc-cfg-soon">(scaffolded)</span>' : '') + '</label>';
        }).join('');
    }
    function setPath(obj, path, val) { var parts = path.split('.'), o = obj; for (var i = 0; i < parts.length - 1; i++) { o = o[parts[i]] = o[parts[i]] || {}; } o[parts[parts.length - 1]] = val; }
    function wireConfig(ovl, def, changed, commit) {
      rerenderConfigBody(ovl, def);
      ovl.querySelectorAll('.dlv-sc-cfg-tabs button').forEach(function (b) {
        b.addEventListener('click', function () {
          ovl.querySelectorAll('.dlv-sc-cfg-tabs button').forEach(function (x) { x.classList.remove('on'); });
          b.classList.add('on'); rerenderConfigBody(ovl, def);
        });
      });
      ovl.addEventListener('change', function (e) {
        var t = e.target, path = t.getAttribute('data-sc'), catField = t.getAttribute('data-sc-cat');
        if (path) {
          var val = t.type === 'checkbox' ? t.checked : t.value;
          if (path === 'display.precision') val = parseInt(val, 10);
          if (path === 'overall.mode') { if (val === 'disabled') { def.overall.enabled = false; } else { def.overall.enabled = true; def.overall.mode = val; } changed(); return; }
          setPath(def, path, val); changed(); return;
        }
        if (catField && catField !== 'remove') {
          var id = t.closest('[data-cat]').getAttribute('data-cat');
          var cat = def.categories.filter(function (c) { return c.id === id; })[0]; if (!cat) return;
          if (catField === 'enabled') {
            if (t.checked && enabledCount(def) >= MAX_CATEGORIES) { t.checked = false; alertOnce('Up to ' + MAX_CATEGORIES + ' enabled categories.'); return; }
            cat.enabled = t.checked;
          } else if (catField === 'weight') { cat.weight = Math.max(0, parseFloat(t.value) || 0); }
          else if (catField === 'evaluatorId') { cat.evaluatorId = t.value; var ev = getEvaluator(t.value); if (ev) cat.settings = JSON.parse(JSON.stringify(ev.defaultSettings)); }
          else cat[catField] = t.value;
          commit();
        }
      });
      ovl.addEventListener('click', function (e) {
        var act = e.target.getAttribute('data-sc-act');
        if (act === 'add') { if (enabledCount(def) < MAX_CATEGORIES) { def.categories.push(makeCategory({ evaluatorId: '_dev', label: 'New category' }, def.categories.length)); rerenderConfigBody(ovl, def); commit(); } }
        else if (act === 'recommend') { def.categories = recommendedCategories(); rerenderConfigBody(ovl, def); commit(); }
        else if (act === 'reset') { var fresh = makeDef(def.x, def.y); ['title', 'subtitle', 'display', 'overall', 'range', 'categories'].forEach(function (k) { def[k] = fresh[k]; }); rerenderConfigBody(ovl, def); commit(); }
        else if (e.target.getAttribute('data-sc-cat') === 'remove') {
          var id = e.target.closest('[data-cat]').getAttribute('data-cat');
          def.categories = def.categories.filter(function (c) { return c.id !== id; }); rerenderConfigBody(ovl, def); commit();
        }
      });
    }
    var _alerted = false;
    function alertOnce(msg) { if (!_alerted && global.alert) { global.alert(msg); } }
  }
})(typeof window !== 'undefined' ? window : globalThis);
