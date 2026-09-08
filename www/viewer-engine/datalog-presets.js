'use strict';
/*
 * datalog-presets.js -- Normalized channel-role layer + data-driven view/preset registry for the
 * PBD Control Center datalog viewer (see datalog-viewer.js for the UI that consumes this).
 *
 * Why this file exists separately: the viewer UI should never reference a raw log column name
 * directly for anything preset/gauge related -- different HP Tuners exports name the same signal
 * differently (PTDIAG short codes like "ENGINE_SPEED" vs. human-readable "Engine RPM" vs. our own
 * hpl-to-csv.js converter's own labels). This file resolves whatever names a given log actually
 * uses into a small set of stable "roles" (engine_rpm, boost_pressure, knock_cylinder_3, ...), and
 * everything else (presets, gauge definitions, default graph channels) is written against those
 * roles instead of raw names. That resolution happens once per opened log (resolveChannelRoles),
 * not per gauge/per frame -- datalog-viewer.js caches the result and gauges just read from it.
 *
 * Preset auto-selection (per Ken, 2026-07-20): the vehicles table currently has no structured
 * engine/cylinder-count/induction columns -- only free-text year/make/model. Rather than guess
 * induction type from a product-name string, the reliable signal we DO have is the log itself: if
 * Knock Cylinder 7/8 resolve to real channels, it's an 8-cylinder log; if only up to 6 resolve,
 * it's a 6-cylinder log. detectCylinderCount() below drives automatic V8/V6 gauge selection from
 * that. Customers can freely override the auto pick via the Presets dropdown (selectPreset()
 * honors a manual override id first, every time). Ken's plan is to eventually pre-assign a
 * specific preset per vehicle model as more presets are built -- the `match` block on each preset
 * (see DATALOG_PRESETS) is already structured to support that later without changing this file's
 * public shape, it just isn't populated/consulted yet since there's nowhere for that assignment to
 * live in the DB today.
 */

// ---- Normalized channel roles --------------------------------------------------------------
// Each role lists every raw channel name we've actually seen (or reasonably expect) for it, in
// both PTDIAG short-code and human-readable HP Tuners forms, matched case-insensitively with
// whitespace collapsed. Extend this list freely -- it's pure data, no code changes needed
// elsewhere to teach the viewer a new raw name for an existing role.
// Holley aliases (appended per role, 2026-07-24): Holley's ECU logs the same signals under its own
// terse names -- RPM (not "Engine RPM"), TPS, CTS, MAT, Ignition Timing, ... None of those matched
// the HP Tuners/Ford vocabulary, so a Holley .dl/.csv opened with the tach and most gauges dead
// even though the data was all there. Appended (never prepended) so an exact HPT/MoTeC name always
// keeps priority; on a Holley log the HPT names simply don't exist and the Holley alias is the only
// hit. Holley does NOT log per-cylinder knock or bank lambda-as-λ (it logs AFR) -- those roles stay
// unresolved on Holley and their gauges read N/A, which is correct rather than mis-scaled.
var NORMALIZED_CHANNEL_ROLES = {
  engine_rpm:              { label: 'Engine RPM',        aliases: ['ENGINE_SPEED', 'Engine RPM', 'Engine Speed', 'RPM'] },
  vehicle_speed:           { label: 'Speed',              aliases: ['VSPD', 'Vehicle Speed', 'Speed', 'vehicle speed mph'] },
  boost_pressure:          { label: 'Boost',              aliases: ['BOOST', 'Boost Pressure', 'Boost PSIG'] },
  manifold_absolute_pressure: { label: 'MAP',             aliases: ['MAP', 'Manifold Absolute Pressure'] },
  barometric_pressure:     { label: 'Baro',               aliases: ['BARO', 'Barometric Pressure', 'Baro Pressure', 'Ambient Pressure'] },
  throttle_position:       { label: 'Throttle',           aliases: ['TPS_PCT', 'Throttle Position', 'Throttle Angle', 'TPS', 'throttle position absolute'] },
  accelerator_pedal_position: { label: 'Pedal',           aliases: ['APP_PCT_PEDAL', 'Accelerator Pedal Position', 'Throttle Pedal', 'Pedal Position', 'accel pedal position relative'] },
  spark_advance:           { label: 'Spark',              aliases: ['SPKSAF_SA', 'Timing Advance', 'Spark Advance', 'Ignition Timing'] },
  trans_temp:              { label: 'Trans Temp',         aliases: ['TFT', 'Trans Fluid Temp', 'Trans Temp', 'Transmission Fluid Temp', 'Line Temp', 'Transmission temperature'] },
  engine_coolant_temp:     { label: 'ECT',                aliases: ['ECT', 'Engine Coolant Temp', 'CTS', 'Engine temp.', 'engine coolant temp F'] },
  manifold_charge_temp:    { label: 'MCT',                aliases: ['MCT', 'Manifold Charge Temp', 'Intake Air Temp', 'MAT'] },
  // ORDER IS THE POINT HERE, not just membership. Aliases are tried in order and the first hit
  // wins, and the Fuel Pressure gauge is a 0-100 psi gauge -- a LOW-side reading.
  // On a direct-injection Ford both channels exist and mean very different things:
  //   Fuel Rail Pressure Actual        800-2,959 psi  (high side -- pegs a 0-100 gauge)
  //   Fuel Lift Pump Pressure Actual   340-676 kPa = 49-98 psi  (low side -- what we want)
  // Measured across Ken's log1/2/3; log5 logs the lift pump directly in psi at 38-48.
  // Lift pump therefore goes FIRST: DI logs bind to the low side, and port-injection logs (which
  // don't have a lift-pump channel at all) still fall through to rail pressure, which IS their
  // low-side reading. Appending it instead would have left the gauge pegged on every DI log.
  // Guarded by dev/alias-check.js -- reordering this will fail the suite.
  // 'Fuel Pressure' (Holley) sits LAST for the same reason it's a low-side gauge: on a Ford DI log
  // the lift-pump alias wins; a Holley log has none of the Ford names and this is its low-side psi.
  fuel_pressure:           { label: 'Fuel Pressure',      aliases: ['Fuel Lift Pump Pressure Actual', 'FRP_ACTUAL', 'Fuel Rail Pressure Actual', 'Fuel Rail Pressure', 'Fuel Pressure'] },
  // 'WB EQ Ratio 1'/'5' are HP Tuners' numbered wideband inputs (sensor 1 = bank 1, sensor 5 = bank 2);
  // the CC edge decoder emits these (PIDs 52/56, often "... (SAE)") where the client decoder emits "Bank 1/2".
  // The explicit "Bank N" alias is listed first so it wins when a log carries both.
  // SCT (Livewire/X4) LABELS its wideband "measured afr bank N" but LOGS it in lambda (~0.8-1.1), not
  // AFR (~10-18) -- so it belongs on the lambda roles, NOT afr_bank_N (which would mis-scale it).
  lambda_bank_1:           { label: 'Lambda Bank 1',      aliases: ['LAMBSE[0]', 'WB EQ Ratio Bank 1', 'WB EQ Ratio 1', 'Equivalence Ratio Commanded - Bank 1', 'Equivalence Ratio Commanded Bank 1', 'measured afr bank 1'] },
  lambda_bank_2:           { label: 'Lambda Bank 2',      aliases: ['LAMBSE[1]', 'WB EQ Ratio Bank 2', 'WB EQ Ratio 5', 'Equivalence Ratio Commanded - Bank 2', 'Equivalence Ratio Commanded Bank 2', 'measured afr bank 2'] },
  // AFR (air/fuel ratio) roles. Holley and other standalones log wideband as AFR, not lambda -- so
  // the λ gauges resolve to nothing on those logs. These roles let the two lambda gauge slots fall
  // back to AFR (see the altRole/alt block on the lambda defs + applyAltRoles). 'AFR Average' backs
  // up 'AFR Left' so a single-sensor Holley (which logs Average, sometimes not Left/Right) still
  // fills bank 1. Kept OUT of the λ roles on purpose: AFR (~10-18) and λ (~0.7-1.2) share no scale,
  // so they must never resolve into the same 0.7-1.2 gauge.
  // FuelTech logs wideband as AFR under "O2 ..." names: O2 General is the measured wideband (what a
  // tuner watches); O2 Closed Loop is the corrected value; O2 Target is the target (NOT mapped -- it's
  // not a measurement). These feed the AFR gauge, which auto-ranges per fuel (this car runs methanol).
  afr_bank_1:              { label: 'AFR Bank 1',         aliases: ['AFR Left', 'AFR Bank 1', 'AFR Average', 'Air Fuel Ratio Bank 1', 'O2 General'] },
  afr_bank_2:              { label: 'AFR Bank 2',         aliases: ['AFR Right', 'AFR Bank 2', 'Air Fuel Ratio Bank 2'] },
  ltft_bank_1:             { label: 'LTFT Bank 1',        aliases: ['LTFT_B1', 'Long Term Fuel Trim Bank 1', 'LTFT Bank 1'] },
  ltft_bank_2:             { label: 'LTFT Bank 2',        aliases: ['LTFT_B2', 'Long Term Fuel Trim Bank 2', 'LTFT Bank 2'] },
  // Holley 'CL Comp' (closed-loop compensation, %) is Holley's short-term fuel trim -- the live
  // correction the ECU is applying to hit target AFR -- so it maps to STFT bank 1 (Ken, 2026-07-24).
  // Holley logs a single closed-loop comp, so bank 2 stays N/A.
  stft_bank_1:             { label: 'STFT Bank 1',        aliases: ['STFT_B1', 'Short Term Fuel Trim Bank 1', 'STFT Bank 1', 'CL Comp', 'O2 Closed Loop'] },
  stft_bank_2:             { label: 'STFT Bank 2',        aliases: ['STFT_B2', 'Short Term Fuel Trim Bank 2', 'STFT Bank 2'] },
  exhaust_cam:             { label: 'Exhaust Cam',        aliases: ['EX_CAM', 'Exhaust Cam', 'Exhaust Camshaft Position', 'VCT Exhaust Cam Phase Angle', 'Exhaust Cam Angle', 'VTC Exhaust Bank 1 Position', 'variable valve timing exhaust bank 1 actual'] },
  intake_cam:              { label: 'Intake Cam',         aliases: ['IN_CAM', 'Intake Cam', 'Intake Camshaft Position', 'VCT Intake Cam Phase Angle', 'Intake Cam Angle', 'VTC Intake Bank 1 Position', 'variable valve timing intake bank 1 actual'] },
  desired_load:            { label: 'Desired Load',       aliases: ['LOAD_DES', 'Desired Load'] },
  // "Absolute Load (SAE)" is the generic SAE load PID and sits LAST on purpose (Ken, 2026-07-22):
  // where a vehicle logs a real Air/Actual Load it should win, and the SAE PID is the fallback for
  // logs that have nothing else. Alias order IS priority -- see resolveChannelRoles.
  actual_load:             { label: 'Load',               aliases: ['LOAD_ACT', 'Air Load', 'Actual Load', 'Absolute Load (SAE)', 'load'] },
  // ---- Scorecard roles (added 2026-07-27): concepts the Scorecard evaluators request that had no
  // role yet. APPENDED (never reordered) so dev/alias-check.js keeps passing. Aliases are best-effort
  // across HP Tuners / Holley / FuelTech naming; individual evaluators degrade to Not Evaluated when
  // a role stays unresolved on a given log.
  commanded_lambda:        { label: 'Commanded Lambda',   aliases: ['LAMBSE_DES', 'Commanded Equivalence Ratio', 'Equivalence Ratio Commanded (SAE)', 'AFR Target', 'O2 Target', 'Lambda Target', 'Commanded Lambda'] },
  desired_boost:           { label: 'Desired Boost',      aliases: ['BOOST_DES', 'Desired Boost', 'Boost Target', 'Target Boost', 'Wastegate Desired'] },
  desired_fuel_pressure:   { label: 'Desired Fuel Pressure', aliases: ['FRP_DES', 'Fuel Rail Pressure Desired', 'Desired Fuel Rail Pressure', 'Fuel Pressure Target'] },
  current_gear:            { label: 'Current Gear',       aliases: ['GEAR', 'Current Gear', 'Trans Current Gear', 'Gear'] },
  commanded_gear:          { label: 'Commanded Gear',     aliases: ['GEAR_CMD', 'Commanded Gear', 'Trans Commanded Gear', 'Desired Gear'] },
  trans_slip:              { label: 'Trans Slip',         aliases: ['TCC_SLIP', 'TCC Slip', 'Transmission Slip', 'Torque Converter Slip', 'Trans Slip'] },
  // SCT 'knock Sensor' maps here on the assumption it's knock retard (degrees, 0 = none) -- verify on a
  // log with a real knock event; if it's a raw sensor voltage/count instead, drop this alias.
  total_knock:             { label: 'Total Knock',        aliases: ['KNOCK_TOTAL', 'Knock Retard', 'Total Knock', 'Total Knock Retard', 'Knock Retard Total', 'knock Sensor'] },
  knock_cylinder_1:        { label: 'Knock Cyl 1',        aliases: ['KNKKC_SA[0]', 'Knock Cyl 1 (+Adv/-Ret)', 'Knock Cylinder 1'] },
  knock_cylinder_2:        { label: 'Knock Cyl 2',        aliases: ['KNKKC_SA[1]', 'Knock Cyl 2 (+Adv/-Ret)', 'Knock Cylinder 2'] },
  knock_cylinder_3:        { label: 'Knock Cyl 3',        aliases: ['KNKKC_SA[2]', 'Knock Cyl 3 (+Adv/-Ret)', 'Knock Cylinder 3'] },
  knock_cylinder_4:        { label: 'Knock Cyl 4',        aliases: ['KNKKC_SA[3]', 'Knock Cyl 4 (+Adv/-Ret)', 'Knock Cylinder 4'] },
  knock_cylinder_5:        { label: 'Knock Cyl 5',        aliases: ['KNKKC_SA[4]', 'Knock Cyl 5 (+Adv/-Ret)', 'Knock Cylinder 5'] },
  knock_cylinder_6:        { label: 'Knock Cyl 6',        aliases: ['KNKKC_SA[5]', 'Knock Cyl 6 (+Adv/-Ret)', 'Knock Cylinder 6'] },
  knock_cylinder_7:        { label: 'Knock Cyl 7',        aliases: ['KNKKC_SA[6]', 'Knock Cyl 7 (+Adv/-Ret)', 'Knock Cylinder 7'] },
  knock_cylinder_8:        { label: 'Knock Cyl 8',        aliases: ['KNKKC_SA[7]', 'Knock Cyl 8 (+Adv/-Ret)', 'Knock Cylinder 8'] },
};
var KNOCK_CYLINDER_ROLES = ['knock_cylinder_1','knock_cylinder_2','knock_cylinder_3','knock_cylinder_4','knock_cylinder_5','knock_cylinder_6','knock_cylinder_7','knock_cylinder_8'];

// Underscores collapse to spaces so a channel named with underscores matches an alias written with
// spaces (and vice-versa). FuelTech names every channel this way -- "Ignition_timing", "Fuel_pressure",
// "Pedal_position" -- and HP Tuners' own PTDIAG short codes ("ENGINE_SPEED", "TPS_PCT") already carry
// underscores too; since BOTH the alias and the channel run through here, the match stays consistent
// either way. It also makes "ENGINE_SPEED" and "Engine Speed" resolve to the same role, which is what
// we want. dev/alias-check.js guards against two roles' aliases colliding after this.
function normalizeForMatch(s){
  return (s || '').toString().toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

// A trailing "(SAE)" marks a channel as the SAE-standard PID for the same signal -- "Engine RPM
// (SAE)" IS Engine RPM. Some Ford logs name nearly every core channel that way (log3.hpl: Engine
// RPM (SAE), Throttle Position (SAE), Engine Coolant Temp (SAE), Vehicle Speed (SAE) ...), so
// without this the log opens with almost every gauge dead. Handled as a matching rule rather than
// by hand-adding an "(SAE)" twin for every alias, which would double the table and still miss the
// next log that uses a suffix we haven't seen.
//
// Deliberately scoped to role matching only -- normalizeForMatch is also used for unit lookups,
// and this has no business there. Exact names always win: the suffix is only stripped as a second
// pass, so a log carrying BOTH "Engine RPM" and "Engine RPM (SAE)" binds to the plain one.
function normalizeChannelForRole(s){
  return normalizeForMatch(s).replace(/\s*\(sae\)$/, '');
}

// Resolves every role in NORMALIZED_CHANNEL_ROLES against the actual channel names present in an
// opened log. Returns { roleId: actualChannelName } -- roles with no match are simply omitted
// (never guessed/substituted), so callers must always check for presence before using a role.
function resolveChannelRoles(channelNames){
  var byNormalized = {};
  var bySuffixStripped = {};
  (channelNames || []).forEach(function(name){
    byNormalized[normalizeForMatch(name)] = name;
    var k = normalizeChannelForRole(name);
    // first writer wins, so the earliest column keeps the slot if two names collapse together
    if(bySuffixStripped[k] === undefined) bySuffixStripped[k] = name;
  });
  var resolved = {};
  Object.keys(NORMALIZED_CHANNEL_ROLES).forEach(function(roleId){
    var aliases = NORMALIZED_CHANNEL_ROLES[roleId].aliases;
    // Pass 1: exact matches across ALL aliases before any fuzzy match is considered, so alias
    // order still means what it says and an exact hit can never lose to a suffix-stripped one.
    for(var i = 0; i < aliases.length; i++){
      var hit = byNormalized[normalizeForMatch(aliases[i])];
      if(hit){ resolved[roleId] = hit; return; }
    }
    for(var j = 0; j < aliases.length; j++){
      var loose = bySuffixStripped[normalizeChannelForRole(aliases[j])];
      if(loose){ resolved[roleId] = loose; return; }
    }
  });
  return resolved;
}

// Counts how many of the 8 possible cylinder-knock roles actually resolved to a real channel in
// this log -- the primary signal for automatic V8 vs V6 gauge-preset selection (see file header).
function detectCylinderCount(resolvedRoles){
  var n = 0;
  KNOCK_CYLINDER_ROLES.forEach(function(r){ if(resolvedRoles[r]) n++; });
  return n;
}

// ---- Display unit conversion -------------------------------------------------------------------
// hpl-to-csv now writes the log's NATIVE units (see its 2026-07-21 header note): VCM Scanner's own
// display units are a per-channel setting from Ken's tune and aren't stored in the .hpl, so the CSV
// keeps native values with the real unit in row 2 and the VIEWER converts for display. Genuine HP
// Tuners CSV exports, meanwhile, already arrive in whatever units Scanner was set to (usually US),
// so a log can show up either way -- conversion therefore keys off the unit STRING, never off an
// assumption about where the file came from, and is a no-op for anything already in US units.
//
// Multipliers mirror hpl-to-csv's own table exactly, so a file converted with usUnits:true and one
// converted natively then displayed here land on identical numbers.
var UNIT_CONVERSIONS = {
  '°c':    { to: '°F',     mul: 1.8,          add: 32 },
  'c':     { to: '°F',     mul: 1.8,          add: 32 },
  'km/h':  { to: 'mph',    mul: 0.6213711922, add: 0 },
  'kph':   { to: 'mph',    mul: 0.6213711922, add: 0 },
  'kpa':   { to: 'psi',    mul: 0.1450377377, add: 0 },
  'mpa':   { to: 'psi',    mul: 145.0377377,  add: 0 },
  'inhg':  { to: 'psi',    mul: 0.4911541474, add: 0 },
  'bar':   { to: 'psi',    mul: 14.503773773, add: 0 },
  'g/s':   { to: 'lb/min', mul: 0.1322773573, add: 0 },
  'n m':   { to: 'lb·ft',  mul: 0.7375621493, add: 0 },
  'n·m':   { to: 'lb·ft',  mul: 0.7375621493, add: 0 },
  'nm':    { to: 'lb·ft',  mul: 0.7375621493, add: 0 },
};
// Family-known metric spellings BEYOND hpl-to-csv's table (MoTeC "kPa a", a Kelvin or m/s channel,
// mbar boost, kg/hr fuel flow). Derived from the entries above rather than typed again, so a MoTeC
// "kPa a" channel and an HP Tuners "kPa" channel land on bit-identical psi. The loader looks every
// unit up through loadTimeConversionFor() below, which also folds UNIT_SPELLINGS ("deg C", "kpaa").
// Deliberately NOT here: lb/hr, lb/s, psig/psia (already US -- Holley logs fuel flow in lb/hr and
// nobody wants that in lb/min), and every time unit (HP Tuners' own US export keeps injector pulse
// width in µs, so µs IS the display unit). dev/units-test.js pins both lists.
UNIT_CONVERSIONS['kpa a'] = { to: 'psi',    mul: UNIT_CONVERSIONS['kpa'].mul,               add: 0 };
UNIT_CONVERSIONS['mbar']  = { to: 'psi',    mul: UNIT_CONVERSIONS['kpa'].mul / 10,          add: 0 };  // 1 mbar = 0.1 kPa
UNIT_CONVERSIONS['k']     = { to: '°F',     mul: UNIT_CONVERSIONS['°c'].mul, add: UNIT_CONVERSIONS['°c'].add - 273.15 * UNIT_CONVERSIONS['°c'].mul };
UNIT_CONVERSIONS['m/s']   = { to: 'mph',    mul: UNIT_CONVERSIONS['km/h'].mul * 3.6,        add: 0 };  // 1 m/s = 3.6 km/h
UNIT_CONVERSIONS['kg/hr'] = { to: 'lb/min', mul: UNIT_CONVERSIONS['g/s'].mul * 1000 / 3600, add: 0 };  // 1 kg/hr = 1000/3600 g/s
UNIT_CONVERSIONS['kg/h']  = { to: 'lb/min', mul: UNIT_CONVERSIONS['g/s'].mul * 1000 / 3600, add: 0 };

// ---- Unit families: bidirectional VALUE conversion ---------------------------------------------
// UNIT_CONVERSIONS above is deliberately one-way and in-place: it turns a freshly opened log into
// US units, once, and that is all it does. Histograms need the opposite shape of thing -- an axis
// or filter saved in one unit (breakpoints in kPa, a threshold in °C) applied to a log that is now
// displayed in another (psi, °F) -- so a NUMBER has to move between units in either direction
// while the log itself is left alone. UNIT_FAMILIES groups every unit spelling we recognise under
// a family, each member carrying a factor/offset to that family's BASE unit; convertValue goes
// source -> base -> target, so every pair inside a family works without listing each pair.
//
// Members are keyed by their normalizeUnit() spelling. `mul`/`add` take a value in that member TO
// the base (v * mul + add); the reverse is derived. The base member is always mul 1 / add 0.
// `label` is the pretty spelling displayUnitFor() hands the UI. `us: true` marks a member that is
// already a US display unit (lb/hr, lb/s): it converts freely inside its family for histogram axes
// but must never get a load-time entry -- dev/units-test.js enforces that both ways.
//
// The two tables MUST agree. Any pair that also lives in UNIT_CONVERSIONS (kpa->psi, °c->°F,
// nm->lb·ft ...) is READ from it here rather than typed a second time, so a histogram axis
// converted through this path lands on exactly the numbers a channel got at load time;
// dev/units-test.js asserts that stays true. Cross-family pairs (psi -> mph) return null.
var UNIT_FAMILIES = {
  temperature: { base: '°f', members: {
    '°f': { mul: 1, add: 0, label: '°F' },
    '°c': { mul: UNIT_CONVERSIONS['°c'].mul, add: UNIT_CONVERSIONS['°c'].add, label: '°C' },
    // K -> °C is a flat -273.15 offset, so K -> °F collapses to one linear step (x1.8 - 459.67)
    'k':  { mul: UNIT_CONVERSIONS['k'].mul, add: UNIT_CONVERSIONS['k'].add, label: 'K' },
  } },
  pressure: { base: 'psi', members: {
    'psi':   { mul: 1, add: 0, label: 'psi' },
    'kpa':   { mul: UNIT_CONVERSIONS['kpa'].mul,   add: 0, label: 'kPa' },
    'kpa a': { mul: UNIT_CONVERSIONS['kpa a'].mul, add: 0, label: 'kPa a' },   // MoTeC absolute kPa
    'mpa':   { mul: UNIT_CONVERSIONS['mpa'].mul,   add: 0, label: 'MPa' },
    'bar':   { mul: UNIT_CONVERSIONS['bar'].mul,   add: 0, label: 'bar' },
    'inhg':  { mul: UNIT_CONVERSIONS['inhg'].mul,  add: 0, label: 'inHg' },
    'mbar':  { mul: UNIT_CONVERSIONS['mbar'].mul,  add: 0, label: 'mbar' },
    // Gauge / absolute psi (Holley "psig", MoTeC "psi g"): same scale as psi, different zero. The
    // family tracks SCALE only, so these convert 1:1 -- the g/a reference is the tuner's business.
    'psig':  { mul: 1, add: 0, label: 'psig' },
    'psia':  { mul: 1, add: 0, label: 'psia' },
  } },
  speed: { base: 'mph', members: {
    'mph':  { mul: 1, add: 0, label: 'mph' },
    'km/h': { mul: UNIT_CONVERSIONS['km/h'].mul, add: 0, label: 'km/h' },
    'kph':  { mul: UNIT_CONVERSIONS['kph'].mul,  add: 0, label: 'km/h' },
    'm/s':  { mul: UNIT_CONVERSIONS['m/s'].mul,  add: 0, label: 'm/s' },
  } },
  airflow: { base: 'lb/min', members: {
    'lb/min': { mul: 1, add: 0, label: 'lb/min' },
    'g/s':    { mul: UNIT_CONVERSIONS['g/s'].mul,   add: 0, label: 'g/s' },
    'kg/hr':  { mul: UNIT_CONVERSIONS['kg/hr'].mul, add: 0, label: 'kg/hr' },
    'kg/h':   { mul: UNIT_CONVERSIONS['kg/h'].mul,  add: 0, label: 'kg/hr' },
    'lb/hr':  { mul: 1 / 60, add: 0, label: 'lb/hr', us: true },
    // HP Tuners logs Fuel Flow Rate in lb/s in one file (889.csv) and lb/min in another -- same
    // family so a saved axis follows either; left as logged at load like lb/hr.
    'lb/s':   { mul: 60, add: 0, label: 'lb/s', us: true },
  } },
  torque: { base: 'lb·ft', members: {
    'lb·ft': { mul: 1, add: 0, label: 'lb·ft' },
    'lb-ft': { mul: 1, add: 0, label: 'lb·ft' },
    'lbft':  { mul: 1, add: 0, label: 'lb·ft' },
    'ft-lb': { mul: 1, add: 0, label: 'ft·lb' },
    'ft·lb': { mul: 1, add: 0, label: 'ft·lb' },
    'n m':   { mul: UNIT_CONVERSIONS['n m'].mul, add: 0, label: 'N·m' },
    'n·m':   { mul: UNIT_CONVERSIONS['n·m'].mul, add: 0, label: 'N·m' },
    'nm':    { mul: UNIT_CONVERSIONS['nm'].mul,  add: 0, label: 'N·m' },
  } },
  mass_per_cyl: { base: 'g/cyl', members: {
    'g/cyl':  { mul: 1, add: 0, label: 'g/cyl' },
    'mg/cyl': { mul: 0.001, add: 0, label: 'mg/cyl' },
  } },
  angle: { base: '°', members: {
    '°':     { mul: 1, add: 0, label: '°' },
    'deg':   { mul: 1, add: 0, label: '°' },
    'dbtdc': { mul: 1, add: 0, label: '°BTDC' },   // MoTeC ignition timing, degrees before TDC
    'rad':   { mul: 180 / Math.PI, add: 0, label: 'rad' },
  } },
  percent: { base: '%',   members: { '%':   { mul: 1, add: 0, label: '%' } } },
  rpm:     { base: 'rpm', members: { 'rpm': { mul: 1, add: 0, label: 'rpm' } } },
  time: { base: 's', members: {
    's':   { mul: 1, add: 0, label: 's' },
    'ms':  { mul: 0.001, add: 0, label: 'ms' },
    'µs':  { mul: 0.000001, add: 0, label: 'µs' },   // U+00B5 MICRO SIGN, as HP Tuners writes it
    'min': { mul: 60, add: 0, label: 'min' },
  } },
  // AFR is lambda x stoich and stoich is fuel-dependent (gas 14.7, E85 ~9.8, methanol ~6.45), so
  // 'afr' has no fixed factor: `stoich: true` tells convertValue to use opts.stoich, falling back to
  // RATIO_STOICH_DEFAULT (and saying so through opts.warn) when none is given or it isn't a number.
  ratio: { base: 'λ', members: {
    'λ':      { mul: 1, add: 0, label: 'λ' },
    'lambda': { mul: 1, add: 0, label: 'λ' },
    'afr':    { stoich: true, label: 'AFR' },
  } },
};
// Gasoline stoich. The ONLY stoich the conversion knows on its own -- E85 (~9.8) or methanol (~6.45)
// must arrive via opts.stoich, which is why the default is announced through opts.warn.
var RATIO_STOICH_DEFAULT = 14.7;
var DEFAULT_STOICH = RATIO_STOICH_DEFAULT;   // earlier name, kept for anything already reading it

// Resolves the stoich a lambda<->AFR conversion uses. Accepts a finite positive number (or a numeric
// string -- saved settings come back through JSON); anything else, including nothing at all, falls
// back to RATIO_STOICH_DEFAULT and is flagged so the caller can tell the user which stoich was used.
function resolveStoich(opts){
  var raw = opts ? opts.stoich : undefined;
  var n = (typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '')) ? Number(raw) : NaN;
  if(isFinite(n) && n > 0) return { stoich: n, defaulted: false, invalid: false, raw: raw };
  return { stoich: RATIO_STOICH_DEFAULT, defaulted: true, invalid: raw !== undefined && raw !== null, raw: raw };
}

// Tells opts.warn (when the caller gave one) that a stoich-dependent conversion ran on the default.
// Fires only for a conversion that actually used the stoich -- kPa->psi never mentions it. The
// callback gets a ready-to-show message plus the facts, and any exception it throws is the
// caller's own (nothing is swallowed).
function notifyStoichDefault(opts, st, from, to){
  if(!st.defaulted || !opts || typeof opts.warn !== 'function') return;
  var msg = (st.invalid ? 'ignored invalid stoich ' + JSON.stringify(st.raw) + '; ' : '') +
            'converted ' + from + ' -> ' + to + ' with default stoich ' + RATIO_STOICH_DEFAULT;
  opts.warn(msg, { stoich: st.stoich, defaulted: true, invalid: st.invalid, from: from, to: to });
}

// Reverse index (normalized spelling -> family + member) built once so lookups don't walk the table.
var UNIT_INDEX = {};
Object.keys(UNIT_FAMILIES).forEach(function(fam){
  var members = UNIT_FAMILIES[fam].members;
  Object.keys(members).forEach(function(u){ UNIT_INDEX[u] = { family: fam, m: members[u] }; });
});

// Unit spellings seen in the wild that normalizeForMatch alone doesn't fold onto a table key.
// Kept deliberately short: a bare "f"/"c" only means a temperature when it IS the whole unit, and
// anything not listed simply stays as normalizeForMatch left it (and then fails the family lookup
// rather than being guessed at). Sources: HP Tuners (µs), Holley CSV/.dl de-bracketed units
// ([A/F], [sec], [msec], [psig]), MoTeC i2 exports (LA, kPa a, psi g), HP Tuners lb/s vs lb/min.
var UNIT_SPELLINGS = {
  'deg f': '°f', 'degf': '°f', '° f': '°f', 'f': '°f',
  'deg c': '°c', 'degc': '°c', '° c': '°c', 'c': '°c',
  'sec': 's', 'secs': 's', 'msec': 'ms',
  'μs': 'µs', 'us': 'µs', 'usec': 'µs',            // Greek mu (U+03BC) / plain ASCII -> MICRO SIGN
  'a/f': 'afr', 'a/f ratio': 'afr', 'la': 'lambda',
  'kpaa': 'kpa a', 'psi g': 'psig', 'psi a': 'psia',
  'lbs/min': 'lb/min', 'lb/m': 'lb/min',
};
function normalizeUnit(u){
  var n = normalizeForMatch(u);
  return UNIT_SPELLINGS[n] || n;
}

// The load-time entry for a raw unit string, or null. The exact normalizeForMatch() key is tried
// first, so every spelling convertUnitsForDisplay converted before this existed still hits the very
// same entry; only then the UNIT_SPELLINGS fold ("deg C" -> °c, "kpaa" -> kpa a), so a family-known
// spelling isn't left in metric just because it was written differently.
function loadTimeConversionFor(raw){
  return UNIT_CONVERSIONS[normalizeForMatch(raw)] || UNIT_CONVERSIONS[normalizeUnit(raw)] || null;
}

// Family id ('pressure', 'temperature', ...) for a unit spelling, or null when it isn't one we know.
function unitFamilyFor(u){
  var hit = UNIT_INDEX[normalizeUnit(u)];
  return hit ? hit.family : null;
}

// True only when both units are known AND share a family -- the precondition for convertValue.
function canConvertUnit(from, to){
  var a = UNIT_INDEX[normalizeUnit(from)], b = UNIT_INDEX[normalizeUnit(to)];
  return !!(a && b && a.family === b.family);
}

// True when converting between these two (already normalized) units multiplies or divides by
// stoich, i.e. exactly one side is an AFR spelling. Blank, identical and unknown pairs never do.
function usesStoich(a, b){
  if(!a || !b || a === b) return false;
  var ia = UNIT_INDEX[a], ib = UNIT_INDEX[b];
  return !!(ia && ib && ia.family === ib.family && !!ia.m.stoich !== !!ib.m.stoich);
}

// Converts one number from `from` to `to`. Returns v UNCHANGED (no conversion) when either unit is
// blank or both normalise to the same spelling -- a saved axis with no unit is taken at face value.
// Returns null when the units are unknown, in different families, or v isn't a finite number
// (NaN in -> null out, so a caller can never mistake a failed conversion for a value).
// opts: { stoich, warn } -- stoich for lambda<->AFR (see resolveStoich); warn(message, info) is
// called when that conversion had to fall back to RATIO_STOICH_DEFAULT. A bad stoich never refuses
// the conversion -- it converts on the default and says so.
function convertValue(v, from, to, opts){
  var a = normalizeUnit(from), b = normalizeUnit(to);
  if(!a || !b || a === b) return v;
  var ia = UNIT_INDEX[a], ib = UNIT_INDEX[b];
  if(!ia || !ib || ia.family !== ib.family) return null;
  if(v == null || !isFinite(v)) return null;
  var ma = ia.m, mb = ib.m;
  // Spelling variants of one unit ("kph" / "km/h", two AFR spellings) share a factor -- skip the
  // round trip so they come back bit-identical instead of a float-rounding hair off.
  if(ma.stoich && mb.stoich) return v;
  if(!ma.stoich && !mb.stoich){
    if(ma.mul === mb.mul && ma.add === mb.add) return v;
    var fixed = v * ma.mul + ma.add;
    return (fixed - mb.add) / mb.mul;
  }
  // Exactly one side is AFR: lambda x stoich.
  var st = resolveStoich(opts);
  notifyStoichDefault(opts, st, a, b);
  var base = ma.stoich ? v / st.stoich : v * ma.mul + ma.add;
  return mb.stoich ? base * st.stoich : (base - mb.add) / mb.mul;
}

// Array form for axis breakpoints / bin edges. Always a NEW array of the same length: every finite
// element converted, anything non-finite (null, NaN) carried through as NaN so positions are kept.
// Returns null when the pair can't be converted at all; a plain copy when no conversion applies
// (blank or identical units). Stoich is resolved ONCE for the whole array, so opts.warn hears about
// a defaulted stoich once per axis -- not once per breakpoint.
function convertArray(arr, from, to, opts){
  if(!arr) return null;
  var a = normalizeUnit(from), b = normalizeUnit(to);
  if(a && b && a !== b && !canConvertUnit(a, b)) return null;
  var st = resolveStoich(opts);
  var elemOpts = { stoich: st.stoich };
  var out = new Array(arr.length);
  var converted = 0;
  for(var i = 0; i < arr.length; i++){
    var v = arr[i];
    if(v == null || !isFinite(v)){ out[i] = NaN; continue; }
    var c = convertValue(v, a, b, elemOpts);
    if(c == null){ out[i] = NaN; continue; }
    out[i] = c;
    converted++;
  }
  if(converted && usesStoich(a, b)) notifyStoichDefault(opts, st, a, b);
  return out;
}

// Pretty spelling for a unit the UI is about to label an axis with ("kpa" -> "kPa", "deg f" ->
// "°F", "lambda" -> "λ"). Unknown units come back as written (trimmed), never blank or lower-cased.
function displayUnitFor(u){
  var hit = UNIT_INDEX[normalizeUnit(u)];
  return hit ? hit.m.label : (u == null ? '' : String(u).trim());
}

// Converts a parsed datalog IN PLACE to US display units. Done once per opened log, right after
// fetch, so everything downstream (charts, cards, gauges, channel readouts, stats) is already in
// display units and no per-frame conversion is needed while scrubbing. Channels whose unit isn't in
// the table (see loadTimeConversionFor) are left untouched -- never guessed. Returns the list of
// channels actually converted.
function convertUnitsForDisplay(data){
  if(!data || !data.channels) return [];
  var converted = [];
  data.channels.forEach(function(ch, i){
    // Categorical channels hold level indices, not measurements -- scaling them would silently
    // point every label at the wrong state. They have no unit anyway, so this is belt and braces.
    if(data.textLevels && data.textLevels[ch]) return;
    var raw = (data.units && data.units[i]) || '';
    var conv = loadTimeConversionFor(raw);
    if(!conv) return;
    var vals = data.series && data.series[ch];
    if(vals){
      for(var j = 0; j < vals.length; j++){
        var v = vals[j];
        if(v != null && isFinite(v)) vals[j] = v * conv.mul + conv.add;
      }
    }
    data.units[i] = conv.to;
    converted.push(ch);
  });
  return converted;
}

// ---- Derived / virtual channels ------------------------------------------------------------
// Some signals we want to gauge simply aren't logged as their own PID. Per Ken (2026-07-21): Boost
// should map to a real boost channel when the log has one, and otherwise be DERIVED as
// MAP - Barometric Pressure. Rather than special-case that in the gauge layer, a derived channel is
// synthesised into the dataset as a real channel and the role is pointed at it, so every consumer
// (gauges, graphs, channel browser, cursor readouts) treats it identically to a logged channel.
//
// Must run AFTER convertUnitsForDisplay so both inputs are already in the same unit (psi), and
// AFTER resolveChannelRoles so we know what's missing. Only fills genuinely absent roles -- a real
// logged boost channel always wins. Mutates `data` and `resolvedRoles`; returns what it added.
var DERIVED_CHANNELS = [
  {
    role: 'boost_pressure',
    name: 'Boost (derived)',
    unit: 'psi',
    from: ['manifold_absolute_pressure', 'barometric_pressure'],
    compute: function(map, baro){ return map - baro; },
  },
];
function applyDerivedChannels(data, resolvedRoles){
  if(!data || !data.channels || !resolvedRoles) return [];
  var added = [];
  DERIVED_CHANNELS.forEach(function(spec){
    if(resolvedRoles[spec.role]) return;                       // a real logged channel wins
    var srcNames = spec.from.map(function(r){ return resolvedRoles[r]; });
    if(srcNames.some(function(n){ return !n; })) return;       // inputs missing -> leave role unresolved
    var srcSeries = srcNames.map(function(n){ return data.series[n]; });
    if(srcSeries.some(function(s){ return !s; })) return;
    var len = data.time ? data.time.length : srcSeries[0].length;
    var out = new Array(len);
    for(var i = 0; i < len; i++){
      var args = srcSeries.map(function(s){ return s[i]; });
      var bad = args.some(function(v){ return v == null || !isFinite(v); });
      out[i] = bad ? NaN : spec.compute.apply(null, args);
    }
    // de-dupe defensively so re-opening a log can't stack duplicate derived columns
    var name = spec.name;
    if(data.channels.indexOf(name) !== -1){
      resolvedRoles[spec.role] = name;
      data.series[name] = out;
      return;
    }
    data.channels.push(name);
    if(data.units) data.units.push(spec.unit);
    // Keep the HP Tuners PID row aligned: a derived channel has no ParameterID, and a channels[]
    // that outgrows channelIds[] by one would shift every later PID->name pairing on import.
    if(Array.isArray(data.channelIds)) data.channelIds.push(null);
    data.series[name] = out;
    resolvedRoles[spec.role] = name;
    added.push(name);
  });
  // Last resort for boost: a log with MAP but no Barometric Pressure can't derive boost (MAP - Baro),
  // so show the MAP channel itself on the boost gauge rather than leaving it blank (Ken, 2026-07-24).
  // The boost gauge auto-ranges, so an absolute-MAP reading still fits.
  if(!resolvedRoles['boost_pressure'] && resolvedRoles['manifold_absolute_pressure']){
    resolvedRoles['boost_pressure'] = resolvedRoles['manifold_absolute_pressure'];
  }
  return added;
}

// ---- Gauge channel resolution: auto-map, with a manual override ------------------------------
// Auto-mapping (role -> channel) is only the DEFAULT. Per Ken 2026-07-21 the user can right-click
// any gauge and point it at whatever channel they like, which is also the escape hatch whenever a
// role fails to resolve or resolves to the wrong thing on an unusual log. An override is stored on
// the gauge def as a raw channel name, so it travels with a saved view like any other setting.
// Precedence: manual override > auto-resolved role > nothing (gauge shows N/A, never a guess).
// `textLevels` is the parsed log's categorical label table (see the parsers). A gauge can only
// render a magnitude, so a categorical channel must resolve to null -- otherwise the dial paints the
// level INDEX as if it were a measurement: an RPM gauge pointed at "Spark Source" reads a confident
// "1" with no hint that it's meaningless. The Mapping picker already hides these, but that isn't
// enough on its own -- a view saved against a log where a channel was numeric can be re-opened on a
// log where the same channel is text, and the override is already stored by then.
function resolveGaugeChannel(def, resolvedRoles, channelNames, textLevels){
  if(!def) return null;
  var isText = function(ch){ return !!(textLevels && textLevels[ch]); };
  var byRole = (resolvedRoles && def.role && resolvedRoles[def.role]) || null;
  if(def.channelOverride){
    if(isText(def.channelOverride)) return null;
    if(!channelNames || channelNames.indexOf(def.channelOverride) !== -1) return def.channelOverride;
    // The override names a channel this log doesn't have. A preset gauge must not guess -- but a
    // custom-dash gauge that ALSO carries the role it was built from (stamped since 2026-09-08 so a
    // shared dashboard works on a car whose log names its channels differently) may follow the role,
    // which is the same channel by meaning. Presets never set channelOverride+role together on their
    // own; only user dashes do.
    if(def.roleFallback && byRole && !isText(byRole)) return byRole;
    return null;
  }
  return isText(byRole) ? null : byRole;
}
// Reverse lookup: which role does this channel satisfy on the current log (null if none)? Used to
// stamp `role` + `roleFallback` on custom-dash gauges so they stay meaningful on other cars.
function roleForChannel(channel, resolvedRoles){
  if(!channel || !resolvedRoles) return null;
  for(var role in resolvedRoles){ if(Object.prototype.hasOwnProperty.call(resolvedRoles, role) && resolvedRoles[role] === channel) return role; }
  return null;
}

// A gauge def may carry an alternate identity: `altRole` + an `alt` presentation block. When the
// primary role can't resolve for this log but the alt role can, the gauge BECOMES the alt (label,
// scale, unit, warnings) and binds to the alt role. This is how the two λ gauges turn into AFR
// gauges on a Holley/standalone log (which logs AFR, not lambda) with no per-vehicle preset and no
// "is this a Holley file" flag -- purely on what actually resolved. Mutates the passed gauge list
// (callers pass the per-log DEEP COPY, never the shared preset) and strips the alt scaffolding so it
// never travels into a saved view. A def whose primary role resolves keeps it and simply drops the
// scaffolding; a def where NEITHER resolves stays on its primary role and reads N/A as before.
// A nice, padded, fuel-agnostic range for an AFR gauge derived from the channel's own min/max/avg
// (see the AFR alt block). Anchored at the lean (top) end so a fuller bar = richer. Returns the
// gauge fields to overwrite, or null if there are no usable stats (caller keeps the fallback range).
function niceAfrRange(st){
  if(!st || !isFinite(st.min) || !isFinite(st.max)) return null;
  var lo = st.min, hi = st.max, span = hi - lo;
  if(span < 0.5){ var c = isFinite(st.avg) ? st.avg : hi; lo = c - 1; hi = c + 1; span = 2; }  // near-constant: give it room
  var step = span > 8 ? 2 : (span > 3 ? 1 : 0.5);
  var pad = Math.max(step, span * 0.15);
  var min = Math.max(0, Math.floor((lo - pad) / step) * step);
  var max = Math.ceil((hi + pad) / step) * step;
  var ticks = Math.min(6, Math.max(3, Math.round((max - min) / step)));
  return { min: min, max: max, anchor: max, decimals: 1, ticks: ticks, snap: step };
}

// Robust {min,max} for auto-ranging: the 2nd/98th percentile of a channel's finite values, so a
// handful of extreme samples (AFR spiking to 27 on a decel fuel-cut, a sensor glitch) don't blow the
// scale out and cost resolution where the needle actually lives. Falls back to plain stats min/max.
function robustBounds(series, st){
  if(series && series.length){
    var f = [];
    for(var i = 0; i < series.length; i++){ var v = series[i]; if(v != null && isFinite(v)) f.push(v); }
    if(f.length >= 20){
      f.sort(function(a, b){ return a - b; });
      var lo = f[Math.floor(f.length * 0.02)], hi = f[Math.floor(f.length * 0.98)];
      return { min: lo, max: hi, avg: st ? st.avg : (lo + hi) / 2 };
    }
  }
  return st ? { min: st.min, max: st.max, avg: st.avg } : null;
}

// A padded range fitted to a channel's own data (robust p2/p98 bounds), 0-anchored, including vacuum
// when the data goes negative. For gauges whose real scale is set-dependent and shouldn't be a fixed
// guess: boost (a methanol car sees ~72 psi, a stock turbo ~15) and load-as-pressure-ratio (~1-6). So
// a fixed scale never pegs the needle or wastes the dial.
function niceDataRange(st, series){
  var b = robustBounds(series, st);
  if(!b || !isFinite(b.min) || !isFinite(b.max)) return null;
  var lo = b.min, hi = b.max, span = hi - lo;
  if(span < 1){ hi = lo + 1; span = 1; }
  var step = span > 120 ? 25 : span > 60 ? 10 : span > 24 ? 5 : span > 8 ? 2 : span > 3 ? 1 : 0.5;
  var pad = Math.max(step, span * 0.1);
  var min = lo < 0 ? Math.floor((lo - pad) / step) * step : 0;
  var max = Math.ceil((hi + pad) / step) * step;
  var ticks = Math.min(8, Math.max(3, Math.round((max - min) / step)));
  return { min: min, max: max, ticks: ticks, snap: step, decimals: max >= 100 ? 0 : 1 };
}

function applyAltRoles(gauges, resolvedRoles, channelStats, data){
  if(!Array.isArray(gauges)) return gauges || [];
  var roles = resolvedRoles || {};
  var stats = channelStats || {};
  var series = (data && data.series) || {};
  gauges.forEach(function(def){
    if(!def) return;
    // Alternate identity: primary role unresolved but the alt role resolves -> become the alt.
    if(def.altRole && def.alt && !roles[def.role] && roles[def.altRole]){
      def.role = def.altRole;
      Object.keys(def.alt).forEach(function(k){ def[k] = def.alt[k]; });
    }
    // Auto-range to the resolved channel's data. 'data' = 0-anchored fit (boost, load); anything else
    // (the AFR alt's `true`) = tight, lean-anchored AFR range.
    if(def.autoRange){
      var ch = def.channelOverride || roles[def.role];
      var st = ch ? stats[ch] : null;
      if(st){
        var r = def.autoRange === 'data' ? niceDataRange(st, series[ch])
                                         : niceAfrRange(robustBounds(series[ch], st));
        if(r) Object.keys(r).forEach(function(k){ def[k] = r[k]; });
      }
    }
    delete def.altRole;
    delete def.alt;
    delete def.autoRange;
  });
  return gauges;
}

// ---- "Why is this gauge N/A, and how do I fix it?" --------------------------------------------
// Rather than leaving an unresolved gauge as a dead N/A, the right-click menu leads with concrete
// guidance: what's missing and what to add to the next log. Ken's example: Boost can be computed
// from MAP - Baro, so if a log has MAP but no Barometric Pressure, say exactly that.

function tokensOf(s){
  return normalizeForMatch(s).split(/[^a-z0-9]+/).filter(function(t){ return t && t.length > 1; });
}
// Channels in this log whose names look like the role we wanted -- offered as "map one of these
// manually". Catches the common real case of a near-miss (a log carrying "Fuel Rail Pressure
// Desired" when the gauge wants "...Actual").
function suggestChannelsForRole(roleId, channelNames, limit){
  var role = NORMALIZED_CHANNEL_ROLES[roleId];
  if(!role || !channelNames) return [];
  var wanted = {};
  role.aliases.forEach(function(a){ tokensOf(a).forEach(function(t){ wanted[t] = true; }); });
  tokensOf(role.label).forEach(function(t){ wanted[t] = true; });
  var wantedList = Object.keys(wanted);
  if(!wantedList.length) return [];
  var scored = [];
  channelNames.forEach(function(name){
    var toks = tokensOf(name);
    if(!toks.length) return;
    var hits = toks.filter(function(t){ return wanted[t]; }).length;
    if(!hits) return;
    // score against the shorter side so a long channel name isn't unfairly penalised
    var score = hits / Math.min(wantedList.length, toks.length);
    if(score >= 0.5) scored.push({ name: name, score: score });
  });
  scored.sort(function(a, b){ return b.score - a.score; });
  return scored.slice(0, limit || 3).map(function(s){ return s.name; });
}

function derivedSpecForRole(roleId){
  for(var i = 0; i < DERIVED_CHANNELS.length; i++){
    if(DERIVED_CHANNELS[i].role === roleId) return DERIVED_CHANNELS[i];
  }
  return null;
}
function roleLabel(roleId){
  var r = NORMALIZED_CHANNEL_ROLES[roleId];
  return r ? r.label : roleId;
}
// The name to show when TELLING someone what to log. Gauge labels are deliberately terse ("Baro",
// "MCT") because dial faces are tiny, but "add Baro to your next log" is a poor instruction -- so
// prefer the first human-readable alias (skipping ALL-CAPS PTDIAG short codes like BARO/FRP_ACTUAL).
function roleLogName(roleId){
  var r = NORMALIZED_CHANNEL_ROLES[roleId];
  if(!r) return roleId;
  for(var i = 0; i < r.aliases.length; i++){
    var a = r.aliases[i];
    if(/[a-z]/.test(a) && /\s/.test(a)) return a;   // mixed-case with a space = human readable
  }
  return r.label;
}

// Returns structured guidance for a role that didn't resolve, so the UI can render it however it
// likes. `ctx` = { channels: [...], resolvedRoles: {...} }.
function explainUnresolvedRole(roleId, ctx){
  ctx = ctx || {};
  var channels = ctx.channels || [];
  var resolved = ctx.resolvedRoles || {};
  var label = roleLabel(roleId);
  var role = NORMALIZED_CHANNEL_ROLES[roleId];
  var suggestions = suggestChannelsForRole(roleId, channels, 3);

  var spec = derivedSpecForRole(roleId);
  if(spec){
    // derivable -- say which inputs are present and which are missing, by name
    var have = [], missing = [];
    spec.from.forEach(function(r){
      (resolved[r] ? have : missing).push({ role: r, label: roleLabel(r), channel: resolved[r] || null });
    });
    if(missing.length){
      var msg = label + ' isn\'t logged directly, but it can be calculated from ' +
        spec.from.map(roleLogName).join(' − ') + '. ';
      if(have.length){
        msg += 'This log has ' + have.map(function(h){ return '"' + h.channel + '"'; }).join(' and ') + ', but ' +
               missing.map(function(m){ return roleLogName(m.role); }).join(' and ') + ' ' + (missing.length > 1 ? 'are' : 'is') + ' missing. ';
      }
      msg += 'Add ' + missing.map(function(m){ return roleLogName(m.role); }).join(' and ') +
             ' to your next log and ' + label + ' will fill in automatically.';
      return {
        role: roleId, label: label, status: 'derivable-missing-inputs',
        message: msg, missingInputs: missing, haveInputs: have,
        aliases: (role && role.aliases) || [], suggestions: suggestions,
      };
    }
  }

  var m2 = 'No channel in this log matches ' + label + '.';
  if(role && role.aliases.length){
    m2 += ' Add one of these to your next log: ' + role.aliases.join(', ') + '.';
  }
  return {
    role: roleId, label: label, status: 'not-logged',
    message: m2, missingInputs: [], haveInputs: [],
    aliases: (role && role.aliases) || [], suggestions: suggestions,
  };
}

// ---- Preset registry -------------------------------------------------------------------------
// Built-in, vehicle-agnostic presets. Vehicle-specific entries (Mustang GT FI, GT500, Explorer ST,
// Raptor R, ...) get appended to this same array later -- selectPreset()'s matching hierarchy
// already checks `match` (vehicle metadata) before falling back to cylinder-count-only presets, so
// adding those later requires no changes here, only new array entries with a higher `priority`.
// ---- Default warning thresholds (Ken, 2026-07-22) ---------------------------------------------
// Ken's numbers for a boosted Ford. They drive three things at once: the amber/red shading in a
// bar's background, the tile tint + "!" badge when a value actually trips, and the colour of the
// readout. Every one is a limit you'd want to notice without hunting for it.
//
// Only ONE side is guarded on the trims and lambda, deliberately: lean is what hurts, and a
// negative short-term trim isn't the same kind of problem as a positive one. Mirroring them is one
// extra key each if that turns out to be wanted.
//
// `warnDefault: true` marks these as shipped rather than chosen, so the ⚑ "a rule is set here"
// marker stays meaningful -- with factory thresholds on eight gauges, a flag on all of them would
// say nothing. The flag returns the moment a user edits that gauge's warnings.
//
// MUST be declared above DATALOG_PRESETS: that array calls buildV8GaugeDefs() at module scope, so
// anything it reads has to be assigned by then. `var` hoists the declaration but not the value --
// defining this next to buildCoreGaugeDefs (which reads it) left it undefined at call time.
var WARN = {
  lambda:       { above: 1.04, critAbove: 1.08 },
  ect:          { above: 200,  critAbove: 215 },
  mct:          { above: 140,  critAbove: 160 },
  stft:         { above: 4,    critAbove: 8 },
  transTemp:    { above: 200,  critAbove: 225 },
  fuelPressure: { below: 35,   critBelow: 25 },
};

// ---- Channel grouping (PROTOTYPE, Ken 2026-07-22 -- not released) ------------------------------
// A 97-channel log is a wall of names. These rules bucket every channel into a tuning-shaped group
// so the list can be collapsed to ~13 headings, and so searching "timing" can surface the whole
// Timing group rather than only the channels with that literal word in them.
//
// Keyword rules, not a per-channel table, because HP Tuners names channels differently per vehicle
// and a hand-maintained list of 97 exact names would be stale on the next car. Rules generalise;
// anything unmatched lands in "Other", which is the signal that a rule is missing.
//
// ORDER IS SIGNIFICANT -- FIRST MATCH WINS, and several channels legitimately match two rules:
//   "Spark Source"   -> Sources, not Spark   (Ken asked specifically that sources group together)
//   "Torque Source"  -> Sources, not Torque
//   "Trans Input Shaft RPM" -> Transmission, not Engine (both match /rpm/)
//   "Short Term Fuel Trim"  -> Fuel Trim, not Fuel      (both match /fuel/)
//   "Engine Brake Torque"   -> Torque, not Engine
// So Sources sits first and the broad catch-alls (Engine) sit last. Reordering this array
// silently re-buckets channels -- dev/group-check.js pins the cases above.
var CHANNEL_GROUPS = [
  { id: 'sources',  label: 'Sources & Status', tests: [/\bsource\b/i, /\bstatus\b/i, /limiting/i, /\blimit\b.*\bsource\b/i, /schedule mode/i] },
  { id: 'mapped',   label: 'Mapped Points',    tests: [/^mapped point/i] },
  { id: 'knock',    label: 'Knock',            tests: [/knock/i] },
  { id: 'cams',     label: 'Cams (VCT)',       tests: [/\bcam\b/i, /\bvct\b/i] },
  { id: 'trims',    label: 'Fuel Trim & Lambda', tests: [/fuel trim/i, /eq ratio/i, /equivalence/i, /lambda/i] },
  { id: 'fuel',     label: 'Fuel',             tests: [/fuel/i, /injector/i] },
  { id: 'air',      label: 'Air & Boost',      tests: [/boost/i, /manifold absolute/i, /barometric/i, /supercharger/i, /intake air/i, /charge temp/i, /airmass/i, /\bmap\b/i] },
  { id: 'load',     label: 'Load',             tests: [/\bload\b/i] },
  { id: 'spark',    label: 'Spark & Timing',   tests: [/timing/i, /spark/i, /advance/i] },
  { id: 'throttle', label: 'Throttle & Pedal', tests: [/throttle/i, /pedal/i] },
  { id: 'torque',   label: 'Torque',           tests: [/torque/i, /^tr /i] },
  { id: 'trans',    label: 'Transmission',     tests: [/\btrans\b/i, /transmission/i, /clutch/i] },
  { id: 'engine',   label: 'Engine',           tests: [/\brpm\b/i, /engine/i, /coolant/i, /cylinder head/i, /voltage/i, /speed/i] },
];
var CHANNEL_GROUP_OTHER = { id: 'other', label: 'Other', tests: [] };

function channelGroupFor(name){
  var s = String(name || '');
  for(var i = 0; i < CHANNEL_GROUPS.length; i++){
    var g = CHANNEL_GROUPS[i];
    for(var j = 0; j < g.tests.length; j++){
      if(g.tests[j].test(s)) return g;
    }
  }
  return CHANNEL_GROUP_OTHER;
}
// Groups present in THIS log, in the declared order, each with its channels. Empty groups are
// dropped so a log never shows a heading with nothing under it.
function groupChannels(channels){
  var byId = {}, out = [];
  (channels || []).forEach(function(c){
    var g = channelGroupFor(c);
    if(!byId[g.id]){ byId[g.id] = { id: g.id, label: g.label, channels: [] }; }
    byId[g.id].channels.push(c);
  });
  CHANNEL_GROUPS.concat([CHANNEL_GROUP_OTHER]).forEach(function(g){
    if(byId[g.id]) out.push(byId[g.id]);
  });
  return out;
}

// The top graph opens on the same three channels in every built-in view (Ken, 2026-07-22): RPM,
// Boost, Speed -- the three that say what the car was actually doing, so a log reads at a glance
// before anyone touches the channel list. Roles, not channel names, so it resolves across HP
// Tuners' different naming per vehicle. A loaded custom view supplies its own defaultGraphs and is
// never affected by this.
var DEFAULT_UPPER_GRAPH = ['engine_rpm', 'boost_pressure', 'vehicle_speed'];
// Default View / Graph View previously left BOTH graphs empty here and fell through to the
// QUICK_CHANNELS name-matching heuristic in datalog-viewer.js, which filled upper AND lower. Now
// that upper is specified, that fallback no longer runs -- so lower has to be stated explicitly or
// those two views would open with an empty lower graph. Same pair the gauge views use.
var DEFAULT_LOWER_GRAPH = ['throttle_position', 'accelerator_pedal_position'];

var DATALOG_PRESETS = [
  {
    id: 'default',
    name: 'Default View',
    match: {},
    layout: 'default',
    gauges: [],
    defaultGraphs: { upper: DEFAULT_UPPER_GRAPH.slice(), lower: DEFAULT_LOWER_GRAPH.slice() },
    defaultCards: [],
    priority: 0,
  },
  {
    id: 'graph',
    name: 'Graph View',
    match: {},
    layout: 'graph',
    gauges: [],
    defaultGraphs: { upper: DEFAULT_UPPER_GRAPH.slice(), lower: DEFAULT_LOWER_GRAPH.slice() },
    defaultCards: [],
    priority: 0,
  },
  {
    id: 'v8-gauge',
    name: 'V8 Gauge',
    match: { cylinderCount: 8 },
    layout: 'v8-gauge',
    gauges: buildV8GaugeDefs(),
    defaultGraphs: { upper: DEFAULT_UPPER_GRAPH.slice(), lower: ['throttle_position', 'accelerator_pedal_position'] },
    defaultCards: [],
    priority: 10,
  },
  {
    id: 'v6-gauge',
    name: 'V6 Gauge',
    match: { cylinderCount: 6 },
    layout: 'v6-gauge',
    gauges: buildV6GaugeDefs(),
    defaultGraphs: { upper: DEFAULT_UPPER_GRAPH.slice(), lower: ['throttle_position', 'accelerator_pedal_position'] },
    defaultCards: [],
    priority: 10,
  },
  // The catch-all. `match: {}` means it fits every log, so a car whose ECU logs no per-cylinder
  // knock still gets a gauge cluster instead of an empty screen.
  //
  // PRIORITY 5 is chosen against how selectPreset scores: a cylinderCount match adds 5 on top of
  // V8/V6's priority 10, so those score 15 and win whenever they apply. When they don't apply they
  // are filtered out entirely and this is the only candidate left. Anything >= 15 here would
  // override the richer clusters on the cars that can actually fill them.
  {
    id: 'standard-gauge',
    name: 'Standard Dash',
    match: {},
    layout: 'v8-gauge',   // 'gauge' mode; the fascia renderer keys off each def's `group`, not this
    gauges: buildStandardGaugeDefs(),
    defaultGraphs: { upper: DEFAULT_UPPER_GRAPH.slice(), lower: ['throttle_position', 'accelerator_pedal_position'] },
    defaultCards: [],
    priority: 5,
  },
];

// Gauge definition shape (see datalog-gauges.js for the renderers that consume these):
//   { id, role, label, type: 'round'|'compact-round'|'vertical-bar'|'number', unit, min, max,
//     color, decimals, group }
// `group` is a purely presentational hint used by the fixed V8/V6 layouts in datalog-gauges.js
// (e.g. 'knock-bars', 'lambda', 'temps-right', 'lower-left', 'lower-bars', 'trims') to place each
// gauge in the right region of the fixed mockup layout -- editing this later to build a real
// layout editor only means changing `group`/order, not the gauge's data binding.
function buildV8GaugeDefs(){
  return buildCoreGaugeDefs(8);
}
function buildV6GaugeDefs(){
  return buildCoreGaugeDefs(6);
}
// The generic fallback cluster (Ken, 2026-07-22: "just a default most basic dash ... figured we
// should have a fallback"). The V8/V6 clusters are built around eight per-cylinder knock bars, and
// measured across Ken's real logs those resolve in only 5 of 8 -- 51.hpl, 76a.hpl and log3.hpl have
// none, so those cars matched no gauge preset at all and opened with an EMPTY gauge view.
//
// Built by REUSING buildCoreGaugeDefs rather than redefining the gauges: passing 0 cylinders skips
// the per-cylinder knock loop, and the two cam dials are dropped because cam phasing is a newer
// feature the V8/V6 clusters already cover. Everything else -- ranges, warning thresholds, sizes,
// and crucially the `group` names the fixed fascia lays out -- stays exactly as approved, so this
// renders as the familiar dash minus the parts a simpler car doesn't log.
//
// Coverage on Ken's logs: every remaining gauge resolves in 8/8 except fuel pressure (7/8) and
// trans temp (4/8), which simply read N/A when absent.
function buildStandardGaugeDefs(){
  return buildCoreGaugeDefs(0).filter(function(d){
    return d.id !== 'intake-cam' && d.id !== 'exhaust-cam';
  });
}
// Gauge ranges/colours track the approved 8cyl.png mockup. Conventions (see
// docs/redesign-requirements.md):
//   color        = the NORMAL / in-range colour. Zones recolour it amber -> red on their own.
//   thresholds   = a draggable {warn, red} pair (the tach redline). Mutually exclusive with zones.
//   snap         = drag/edit step; omitted means "derive a nice step from the range".
//   tickDivisor  = scale numbers are divided by this (tach reads 0..10 with a "x 1000" note).
function buildCoreGaugeDefs(cylCount){
  var defs = [
    { id: 'rpm', role: 'engine_rpm', label: 'ENGINE RPM', type: 'round', unit: '', min: 0, max: 10000,
      color: '#22c55e', decimals: 0, group: 'rpm', majors: 10, minorsPer: 1,
      tickDivisor: 1000, scaleNote: '× 1000 rpm', snap: 100, thresholds: { warn: 6500, red: 7200 } },
    // "KR" (knock retard) + a bare cylinder number: these labels sit above narrow bars, and the old
    // "KNOCK CYL 1" wrapped to two lines and forced every knock bar wide. It's a cylinder column --
    // the word adds nothing.
    { id: 'total-knock', role: 'total_knock', label: 'TOTAL KR', type: 'vertical-bar', unit: '°', min: -3, max: 3, color: '#22c55e', decimals: 1, group: 'knock-bars' },
  ];
  for(var i = 1; i <= cylCount; i++){
    defs.push({ id: 'knock-cyl-' + i, role: 'knock_cylinder_' + i, label: 'KR ' + i, type: 'vertical-bar', unit: '°', min: -3, max: 3, color: '#22c55e', decimals: 1, group: 'knock-bars' });
  }
  // abbreviated so the label fits one line and the bars stay narrow (the unit is already λ)
  // 0.7-1.2 resting at 1.0 (Ken, 2026-07-21). The old 0.2-1.2 scale meant a normal reading sat ~70%
  // full at all times and both banks looked identical at a glance -- the bar carried no information
  // until you read the number. Anchored at stoich, the bar is empty when nothing is happening and
  // any fill reads directly as "how far off, and which way": rich hangs below the line, lean rises
  // above it, exactly like the fuel trims. More travel rich (0.3) than lean (0.2) on purpose --
  // that's where the useful range is on a boosted engine.
  // altRole/alt = "if the primary role (λ) doesn't resolve but AFR does, become an AFR gauge instead"
  // (applyAltRoles swaps it in per-log). AFR is an ABSOLUTE ratio, so its scale is fuel-dependent
  // (methanol stoich ~6.45, E85 ~9.8, gas ~14.7) -- a fixed gasoline scale pegs a methanol car at the
  // bottom (Ken races methanol). So `autoRange` derives min/max from the actual data per log
  // (niceAfrRange), anchored at the lean/top end: a fuller bar reads as richer, and the bar collapsing
  // toward empty is the lean-danger signal on a boost pull. (λ itself needs none of this -- 1.0 is
  // stoich for every fuel, so the primary λ gauge stays fixed 0.7-1.2.) The min/max here are only a
  // fallback for when channel stats aren't available. No default lean warning -- fuel/boost dependent.
  var AFR_ALT_1 = { label: 'AFR L', unit: '', min: 8, max: 16, anchor: 16, decimals: 1, ticks: 4, snap: 0.5, warnings: null, warnDefault: false, autoRange: true };
  var AFR_ALT_2 = Object.assign({}, AFR_ALT_1, { label: 'AFR R' });
  defs.push({ id: 'lambda-1', role: 'lambda_bank_1', label: 'LAM B1', type: 'vertical-bar', unit: 'λ', min: 0.7, max: 1.2, anchor: 1.0, color: '#22c55e', decimals: 2, group: 'lambda', ticks: 5, snap: 0.05, warnings: WARN.lambda, warnDefault: true, altRole: 'afr_bank_1', alt: AFR_ALT_1 });
  defs.push({ id: 'lambda-2', role: 'lambda_bank_2', label: 'LAM B2', type: 'vertical-bar', unit: 'λ', min: 0.7, max: 1.2, anchor: 1.0, color: '#22c55e', decimals: 2, group: 'lambda', ticks: 5, snap: 0.05, warnings: WARN.lambda, warnDefault: true, altRole: 'afr_bank_2', alt: AFR_ALT_2 });
  // Square digital, not a dial: coolant and charge temps move slowly and you read the number, never
  // the sweep. Dropping the needle roughly doubles the digit size in less space than the dial used.
  // (The cams stay round -- their value swings fast, so there the sweep IS the information.)
  defs.push({ id: 'ect', role: 'engine_coolant_temp', label: 'ECT', type: 'digital', unit: '°F', min: 100, max: 300, color: '#22c55e', decimals: 0, group: 'temps-right', warnings: WARN.ect, warnDefault: true });
  defs.push({ id: 'mct', role: 'manifold_charge_temp', label: 'MCT', type: 'digital', unit: '°F', min: 100, max: 300, color: '#22c55e', decimals: 0, group: 'temps-right', warnings: WARN.mct, warnDefault: true });
  // cams get their own stacked, small zone; boost stays full size beside them
  defs.push({ id: 'exhaust-cam', role: 'exhaust_cam', label: 'EXH CAM', type: 'compact-round', unit: '°', min: -30, max: 30, color: '#22c55e', decimals: 1, group: 'cams', dialWidth: 74, readoutScale: 2.2 });
  defs.push({ id: 'intake-cam', role: 'intake_cam', label: 'INT CAM', type: 'compact-round', unit: '°', min: -30, max: 30, color: '#22c55e', decimals: 1, group: 'cams', dialWidth: 74, readoutScale: 2.2 });
  // Boost + Speed ride stacked INSIDE the knock panel: that zone had spare width, and moving them
  // out of row 2 is what lets row 2 come up. Sized to fit two-high within the row.
  // -10..30 rather than -15..30 so the 4 divisions land on clean numbers (-10, 0, 10, 20, 30);
  // -15 gave -3.8 / 7.5 / 18.8. Idle vacuum on these runs about -8 psi, so -10 still covers it.
  // Grown 80 -> 104 now that the bars are at 75%: these were sized around the old bar height, not
  // around how much they matter. Boost is the gauge a tuner watches most (Ken, 2026-07-21).
  // Sized to its NEIGHBOURS, not picked by eye: a compact dial's height is dialWidth + ~18 units of
  // label/readout overhead, and the knock bars beside it are 134 units tall -- so 116 makes Boost
  // exactly as tall as the bars it sits with. Speed does the same against the 145-unit row-2 bars.
  defs.push({ id: 'boost', role: 'boost_pressure', label: 'BOOST', type: 'compact-round', unit: 'psi', min: -10, max: 30, color: '#22c55e', decimals: 1, group: 'knock-bars', stackGroup: 'boost-speed', dialWidth: 116, readoutScale: 2.0, autoRange: 'data' });
  // Speed moved out of the boost stack and down beside Spark in row 2 (Ken, 2026-07-22). It isn't a
  // knock-panel signal, and pairing it with Boost only ever made sense as a way to fill that zone's
  // spare width. Boost now has the stack to itself, which is why it can be the biggest thing there.
  defs.push({ id: 'speed', role: 'vehicle_speed', label: 'SPEED', type: 'compact-round', unit: 'mph', min: 0, max: 200, color: '#22c55e', decimals: 0, group: 'lower-bars', dialWidth: 127, readoutScale: 2.0 });
  defs.push({ id: 'spark', role: 'spark_advance', label: 'SPARK', type: 'vertical-bar', unit: '°', min: -50, max: 50, color: '#22c55e', decimals: 1, group: 'lower-bars' });
  defs.push({ id: 'trans-temp', role: 'trans_temp', label: 'TRANS TEMP', type: 'vertical-bar', unit: '°F', min: 100, max: 300, color: '#22c55e', decimals: 0, group: 'lower-bars', warnings: WARN.transTemp, warnDefault: true });
  defs.push({ id: 'pedal', role: 'accelerator_pedal_position', label: 'PEDAL', type: 'vertical-bar', unit: '%', min: 0, max: 100, color: '#22c55e', decimals: 0, group: 'lower-bars' });
  defs.push({ id: 'throttle', role: 'throttle_position', label: 'THROTTLE', type: 'vertical-bar', unit: '%', min: 0, max: 100, color: '#22c55e', decimals: 0, group: 'lower-bars' });
  // 0-200%, not 0-100: load is normalised to percent (see normalizeLoadScale) and a boosted engine
  // runs well past 100 -- Ken's mile log peaks at 213% VE. A 0-100 scale pegged for most of a pull.
  defs.push({ id: 'desired-load', role: 'desired_load', label: 'DESIRED LOAD', type: 'vertical-bar', unit: '%', min: 0, max: 200, color: '#22c55e', decimals: 0, group: 'lower-bars' });
  defs.push({ id: 'load', role: 'actual_load', label: 'LOAD', type: 'vertical-bar', unit: '%', min: 0, max: 200, color: '#22c55e', decimals: 0, group: 'lower-bars' });
  // mockup renders fuel pressure as a full-size dial (the large 0-100 gauge), not a compact one
  defs.push({ id: 'fuel-pressure', role: 'fuel_pressure', label: 'FUEL PRESSURE', type: 'round', unit: 'psi', min: 0, max: 100, color: '#22c55e', decimals: 0, group: 'fuel-pressure', majors: 10, minorsPer: 1, warnings: WARN.fuelPressure, warnDefault: true });
  // abbreviated like the knock/lambda bars so the label fits one line and the trims pack tight
  defs.push({ id: 'ltft-1', role: 'ltft_bank_1', label: 'LTFT 1', type: 'vertical-bar', unit: '%', min: -25, max: 25, color: '#22c55e', decimals: 1, group: 'trims' });
  defs.push({ id: 'ltft-2', role: 'ltft_bank_2', label: 'LTFT 2', type: 'vertical-bar', unit: '%', min: -25, max: 25, color: '#22c55e', decimals: 1, group: 'trims' });
  defs.push({ id: 'stft-1', role: 'stft_bank_1', label: 'STFT 1', type: 'vertical-bar', unit: '%', min: -25, max: 25, color: '#22c55e', decimals: 1, group: 'trims', warnings: WARN.stft, warnDefault: true });
  defs.push({ id: 'stft-2', role: 'stft_bank_2', label: 'STFT 2', type: 'vertical-bar', unit: '%', min: -25, max: 25, color: '#22c55e', decimals: 1, group: 'trims', warnings: WARN.stft, warnDefault: true });
  return defs;
}

// Matching hierarchy: a manual override always wins outright. Otherwise: vehicle-metadata matches
// (once populated -- none ship yet, see file header) beat cylinder-count-only presets, which beat
// the Default View fallback. Presets are never auto-switched mid-session unless `forceReauto` is
// passed (used when a new log is opened) -- datalog-viewer.js is responsible for calling this only
// at the right times, this function itself is a pure lookup with no session-state awareness.
function selectPreset(ctx){
  ctx = ctx || {};
  var manualId = ctx.manualOverrideId;
  if(manualId){
    var manual = DATALOG_PRESETS.filter(function(p){ return p.id === manualId; })[0];
    if(manual) return manual;
  }
  var vehicle = ctx.vehicle || {};
  var cylinderCount = ctx.cylinderCount || 0;
  var candidates = DATALOG_PRESETS.filter(function(p){ return p.id !== 'default' && p.id !== 'graph'; });
  var scored = candidates.map(function(p){
    var score = 0;
    var m = p.match || {};
    var matched = true;
    if(m.make && normalizeForMatch(m.make) !== normalizeForMatch(vehicle.make)) matched = false;
    if(m.model && normalizeForMatch(m.model) !== normalizeForMatch(vehicle.model)) matched = false;
    if(m.yearMin && Number(vehicle.year) < m.yearMin) matched = false;
    if(m.yearMax && Number(vehicle.year) > m.yearMax) matched = false;
    if(m.cylinderCount && m.cylinderCount !== cylinderCount) matched = false;
    if(!matched) return null;
    if(m.make) score += 40;
    if(m.model) score += 40;
    if(m.yearMin || m.yearMax) score += 10;
    if(m.cylinderCount) score += 5;
    score += p.priority || 0;
    return { preset: p, score: score };
  }).filter(Boolean);
  if(scored.length){
    scored.sort(function(a, b){ return b.score - a.score; });
    return scored[0].preset;
  }
  return DATALOG_PRESETS.filter(function(p){ return p.id === 'default'; })[0];
}

function getPresetById(id){
  return DATALOG_PRESETS.filter(function(p){ return p.id === id; })[0] || null;
}

// ---- Short channel labels --------------------------------------------------------------------
// HP Tuners' own channel names are written for a desktop grid, not a phone: "Manifold Absolute
// Pressure", "Accelerator Pedal Position", "Equivalence Ratio Commanded (SAE)". On a numeric card
// the name is also what sets the card's width, so a long name doesn't just read badly -- it pushes
// the row wide enough to run under the channels button (Ken, 2026-07-21).
//
// The vocabulary deliberately matches the gauge labels already used in DATALOG_PRESETS (MAP, ECT,
// LTFT 1, KR 3, LAM B1) so the same signal reads the same everywhere in the app.
//
// Explicit map first, because a generic algorithm can't know MAP or that "Timing Advance" is what
// a tuner calls Spark. Anything not listed falls through to the word-level rules below, which only
// shorten -- they never invent an acronym, since "Clutch A Temp" -> "CAT" would be actively
// misleading. The full name is always kept in the element's title.
var CHANNEL_SHORT_NAMES = {
  'manifold absolute pressure':'MAP',
  'barometric pressure':'BARO',
  'boost (derived)':'BOOST',
  'throttle position':'TP',
  'relative throttle position (sae)':'REL TP',
  'commanded throttle actuator (sae)':'CMD TA',
  'accelerator pedal position':'PEDAL',
  'throttle pedal':'PEDAL',
  'engine rpm':'RPM',
  'vehicle speed':'SPEED',
  'engine coolant temp':'ECT',
  'intake air temp':'IAT',
  'manifold charge temp':'MCT',
  'cylinder head temp':'CHT',
  'trans temp':'TRANS T',
  'timing advance':'SPARK',
  'knock retard':'KR',
  'borderline knock':'BDL KNOCK',
  'absolute load (sae)':'LOAD',
  'desired load':'DES LOAD',
  'air load':'AIR LOAD',
  'control module voltage':'VOLTS',
  'equivalence ratio commanded (sae)':'EQ CMD',
  'fuel rail pressure actual':'FRP',
  'fuel rail pressure desired':'FRP DES',
  'fuel lift pump pressure actual':'LP FUEL',
  'fuel lift pump pressure desired':'LP DES',
  'fuel pump commanded dc':'FP DC',
  'fuel flow rate':'FUEL FLOW',
  'engine brake torque':'BRK TQ',
  'engine indicated torque reference':'IND TQ',
  'scheduled torque':'SCHED TQ',
  'etc torque request':'ETC TQ',
  'trans input shaft rpm':'TISS',
  'supercharger inlet pressure':'SC INLET',
  'desired airmass':'DES AIR',
  'vct intake cam phase angle':'INT CAM',
  'vct exhaust cam phase angle':'EXH CAM',
  'vtc intake bank 1 position':'INT CAM',
  'vtc exhaust bank 1 position':'EXH CAM',
  'intake cam angle':'INT CAM',
  'exhaust cam angle':'EXH CAM',
  'intake cam des angle':'INT CAM DES',
  'exhaust cam des angle':'EXH CAM DES',
  'spark source':'SPK SRC',
  'fuel source':'FUEL SRC',
  'torque source':'TQ SRC',
  'throttle angle source':'TA SRC',
  'rpm limit source':'RPM LIM',
  'fuel system #1 status (sae)':'FUEL SYS',
  'vct schedule mode':'VCT MODE'
};

// Word-level shorteners for everything not in the map. Order matters: longer phrases first.
var CHANNEL_SHORT_RULES = [
  [/\s*\(sae\)\s*/gi, ''],                 // a spec reference, never useful on a card
  [/\(\+adv\/-ret\)/gi, ''],
  // HP Tuners qualifiers that don't change which signal it is. Deliberately an explicit list, not
  // "strip any trailing parenthetical" -- "(derived)" on Boost DOES matter, and blanket-stripping
  // would quietly merge it with a real logged Boost channel in the label.
  [/\s*\((corrected|calculated|estimated|filtered)\)\s*/gi, ' '],
  [/\bshort term fuel trim\b/gi, 'STFT'],
  [/\blong term fuel trim\b/gi, 'LTFT'],
  [/\bwb eq ratio\b/gi, 'LAM'],
  [/\bknock cyl\b/gi, 'KR'],
  [/\bbank (\d)\b/gi, 'B$1'],
  [/\bcylinder\b/gi, 'CYL'],
  [/\bcommanded\b/gi, 'CMD'],
  [/\bdesired\b/gi, 'DES'],
  [/\bactual\b/gi, 'ACT'],
  [/\babsolute\b/gi, 'ABS'],
  [/\brelative\b/gi, 'REL'],
  [/\bmanifold\b/gi, 'MAN'],
  [/\bpressure\b/gi, 'PRESS'],
  [/\btemperature\b/gi, 'TEMP'],
  [/\bposition\b/gi, 'POS'],
  [/\bmaximum\b/gi, 'MAX'],
  [/\bminimum\b/gi, 'MIN'],
  [/\bpercentage\b/gi, '%'],
  [/\s{2,}/g, ' ']
];

// ---- Load scale normalisation (Ken, 2026-07-22) -----------------------------------------------
// The same signal arrives in two conventions depending on the vehicle/PID set: as a RATIO where
// 1.2 means 120% VE, or already as a PERCENT where the value is 120. Measured across Ken's logs:
//   mile.csv   Desired Load 0.13-2.01, Air Load 0.08-2.13   (ratio)
//   any log    Absolute Load (SAE)     7.84-214.90          (percent)
// On a fixed 0-100 gauge a ratio log is an invisible sliver reading "0.2".
//
// This cannot be keyed on the unit string the way convertUnitsForDisplay is -- these channels ship
// with NO unit at all, which is exactly why they slipped through. So it's a magnitude test: load
// expressed as a percentage is never realistically below ~3, and a ratio never above it, so the
// two populations don't overlap and the test is unambiguous.
//
// Normalising the DATA (rather than only rescaling the gauge) is deliberate: it makes the readout
// say 213 where a tuner expects 213, instead of a correctly-scaled bar next to the number 2.13.
var LOAD_ROLES = ['desired_load', 'actual_load'];
var LOAD_RATIO_MAX = 3;   // above this it must already be a percentage
// Beyond the two roles, any OTHER engine-load channel by name -- "Load Maximum Achievable (Current
// Conditions)" sat next to a normalised Air Load at 0.08-2.13 while Air Load read 8-213, so a math
// channel or histogram mixing the two was off by 100x (Ken, 2026-09-08: "smart enough to adjust on
// its own"). Only channels whose unit is blank or % qualify; a load in lb, N or g is a different
// quantity, and alternator / transmission / injector "load" are not engine load at all.
var LOAD_NAME_RE = /\bload\b/i;
var LOAD_NAME_EXCLUDE_RE = /\b(alt|alternator|trans|transmission|injector|fuel|battery|electrical|cpu|a\/?c)\b/i;
function isEngineLoadName(name){
  return !!name && LOAD_NAME_RE.test(String(name)) && !LOAD_NAME_EXCLUDE_RE.test(String(name));
}

function normalizeLoadScale(data, resolvedRoles){
  if(!data || !data.series) return [];
  var scaled = [], done = {};
  function scaleChannel(ch){
    if(!ch || done[ch]) return;
    done[ch] = true;
    var vals = data.series[ch];
    if(!vals || !vals.length) return;
    var max = -Infinity;
    for(var i = 0; i < vals.length; i++){
      var v = vals[i];
      if(v != null && isFinite(v) && v > max) max = v;
    }
    if(!isFinite(max) || max > LOAD_RATIO_MAX) return;   // already a percentage, leave alone
    for(var j = 0; j < vals.length; j++){
      if(vals[j] != null && isFinite(vals[j])) vals[j] = vals[j] * 100;
    }
    var idx = data.channels.indexOf(ch);
    if(idx !== -1 && data.units) data.units[idx] = '%';
    scaled.push(ch);
  }
  LOAD_ROLES.forEach(function(role){ scaleChannel(resolvedRoles && resolvedRoles[role]); });
  (data.channels || []).forEach(function(ch, idx){
    if(!isEngineLoadName(ch)) return;
    var unit = data.units && data.units[idx] != null ? normalizeForMatch(String(data.units[idx])) : '';
    if(unit !== '' && unit !== '%') return;
    scaleChannel(ch);
  });
  return scaled;
}

function shortChannelName(name){
  if(!name) return '';
  var hit = CHANNEL_SHORT_NAMES[String(name).trim().toLowerCase()];
  if(hit) return hit;
  var out = String(name);
  for(var i = 0; i < CHANNEL_SHORT_RULES.length; i++){
    out = out.replace(CHANNEL_SHORT_RULES[i][0], CHANNEL_SHORT_RULES[i][1]);
  }
  return out.trim();
}
