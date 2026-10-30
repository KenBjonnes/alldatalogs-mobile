/*
 * datalog-cam.js — cam timing for Ford Ti-VCT engines. Pure maths and data, no DOM.
 *
 * WHAT THIS IS FOR
 * On a Ti-VCT engine the camshafts move, so "the cam timing" is not one set of numbers — it is a
 * function of where the phasers are at that instant. This turns a cam's ground-in events plus a pair
 * of phaser positions into the real valve events, centrelines and overlap, which is what a tuner
 * actually wants to know while looking at a log or choosing a grind.
 *
 * It is a port of Ken's TiVCT-Worksheet-V11.xlsm, which was proofread formula by formula first
 * (2026-10-29) and found correct: every derived value re-computed independently matched, durations
 * came out properly invariant under phasing, and feeding it intake −50 / exhaust +50 reproduced all
 * seven published "phaser at maximum" figures for the stock Gen 1 cam exactly. The sheet's model is
 * therefore reproduced here rather than reinvented, down to the column meanings, so his own numbers
 * paste straight in.
 *
 * ---------------------------------------------------------------------------------------------
 * SIGN CONVENTION — the single thing most likely to be got wrong
 * ---------------------------------------------------------------------------------------------
 * Phaser position is in CRANK degrees, measured from PARK, and **positive is RETARD**.
 *
 * That is Ford's own convention, not a choice made here. Ford Racing's "Camshaft 5.0L Coyote Engine
 * Camshaft Timing Recommendations" publishes the production WOT tables for the 2011-13 Mustang GT and
 * the 2012-13 Boss 302 with both chart axes labelled, verbatim, "deg retard": every intake value is
 * negative and every exhaust value is zero or positive. It is corroborated twice over — the direction
 * of travel measured in 46 of Ken's own customer logs, and the published park/maximum centrelines,
 * which Ford's own −50° Boss command reproduces exactly (139 − 50 = 89° ATDC).
 *
 * TWO OTHER CONVENTIONS EXIST AND BOTH WILL CORRUPT A CALCULATION SILENTLY:
 *   * Comp's CY-r cam card writes the same motion with the OPPOSITE sign ("+20° (advance) and −50°
 *     (retard) from Park"). Anything read off that card must be negated before it comes in here.
 *   * Holley's Ti-VCT controller anchors its tables at a travel EXTREME rather than at park, so its
 *     zero is up to 50° away from this one. Holley numbers need re-zeroing, not just re-signing.
 *
 * ---------------------------------------------------------------------------------------------
 * CHECKING HEIGHT
 * ---------------------------------------------------------------------------------------------
 * A cam's events only mean something at a stated valve-lift (or lobe-lift) checking height, and
 * nothing in this file converts between heights — it cannot, without the lobe's actual profile. Each
 * cam therefore carries `height`, and a seat/advertised duration alongside, purely so the valve-event
 * diagram can show where the valve leaves and returns to its seat. Mixing a .050" event with a seat
 * event silently moves everything by 20-26 crank degrees, which is why the field is mandatory.
 */
(function (global) {
  'use strict';

  // ---- the model ------------------------------------------------------------------------------
  //
  // A cam is four events at the phasers' PARK position, in the same column meanings Ken's worksheet
  // uses, so a row from his Cam Master List transfers without reinterpretation:
  //
  //   ivo  degrees BTDC   (negative = ATDC)   "IVO BTDC (ATDC is -)"
  //   ivc  degrees ABDC                       "IVC ABDC"
  //   evo  degrees BBDC                       "EVO BBDC"
  //   evc  degrees ATDC   (negative = BTDC)   "EVC ATDC (BTDC is -)"
  //
  // Everything else is derived. Nothing is stored twice.

  function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : 0; }

  /**
   * The valve events with the phasers at (intakePos, exhaustPos), both in crank degrees from park,
   * positive = retard.
   *
   * Phasing ROTATES a cam; it does not regrind it. So a retard moves opening later and closing later
   * by the same amount, and `duration` comes out of this unchanged at every position — which is the
   * property dev/cam-test.js asserts, because getting a sign wrong here shows up as a duration that
   * breathes with the phaser.
   */
  function events(cam, intakePos, exhaustPos) {
    var ip = num(intakePos), ep = num(exhaustPos);
    var ivo = num(cam && cam.ivo) - ip;
    var ivc = num(cam && cam.ivc) + ip;
    var evo = num(cam && cam.evo) - ep;
    var evc = num(cam && cam.evc) + ep;
    var di = ivo + 180 + ivc;
    var de = evo + 180 + evc;
    return {
      ivo: ivo, ivc: ivc, evo: evo, evc: evc,
      intakeDuration: di,
      exhaustDuration: de,
      // Intake centreline, degrees ATDC. Equivalent to (180 + ivc − ivo) / 2.
      icl: di / 2 - ivo,
      // Exhaust centreline, degrees BTDC. Both centrelines are quoted toward the overlap TDC, which
      // is the convention every cam card uses.
      ecl: de / 2 - evc,
      // Overlap at this checking height: the crank degrees for which both valves are off their seats
      // by at least the checking height. Negative means a gap in which neither is.
      overlap: ivo + evc,
      intakePos: ip,
      exhaustPos: ep,
    };
  }

  /**
   * The INSTALLED lobe separation, (ICL + ECL) / 2.
   *
   * Deliberately not called LSA. On a single-cam engine lobe separation is ground into the billet and
   * cannot change; on Ti-VCT the two cams move independently, so this number walks around as the
   * phasers do — 131° at park on a stock Gen 1, 110.75° with the cams at a typical mid-range position.
   * It is a real and useful figure, it is just not a property of the grind, and quoting it as "the
   * cam's LSA" is how people end up comparing a Ti-VCT engine with a pushrod one and drawing nonsense.
   * Comp's own CY-r worksheet computes it exactly this way and calls it "Lobe Sep".
   */
  function separation(ev) { return (num(ev.icl) + num(ev.ecl)) / 2; }

  /**
   * The four events from what a cam card actually prints: duration at .050" and the two centrelines
   * at park (ICL degrees ATDC, ECL degrees BTDC). Exact inverse of events() at park, for a lobe that
   * is symmetric about its centreline:
   *   ivo = durI/2 − ICL      ivc = durI/2 − 180 + ICL
   *   evc = durE/2 − ECL      evo = durE/2 − 180 + ECL
   * e.g. Comp 243420, 227/229 at 118/136 → −4.5 / 51.5 / 70.5 / −21.5, which is its card.
   */
  function fromCard(durI, durE, icl, ecl) {
    return {
      ivo: durI / 2 - icl, ivc: durI / 2 - 180 + icl,
      evo: durE / 2 - 180 + ecl, evc: durE / 2 - ecl,
    };
  }

  /** Everything, in one call. */
  function solve(cam, intakePos, exhaustPos) {
    var ev = events(cam, intakePos, exhaustPos);
    ev.separation = separation(ev);
    return ev;
  }

  // ---- reading a cam out of a calibration -------------------------------------------------------
  //
  // From 2015 on, the Ford calibration carries the intake and exhaust events as ABSOLUTE crank angle
  // rather than as a phaser offset, and the frame it counts in is not stated anywhere in the tuning
  // software. Measured against two known park centrelines, the rule is simply: reduce the value into
  // one engine cycle and measure it from the nearest TDC or BDC. The displayed frame differs between
  // generations — a 2015-17 calibration folds into 0-360 while a 2018+ one runs the full 0-720, so
  // the same cam reads 239 on one and 599 on the other — and this is insensitive to that, because
  // 239 and 599 reduce to the same physical event.
  //
  // Proof it is right: run Ken's 2015-17 figures (intake open 340, intake close 239) through this and
  // the intake centreline comes out at 109.5° ATDC, against the 109.0° that Comp's CY-r cam card
  // publishes as the Gen 2 stock park ICL. An ECU calibration and a cam grinder's worksheet, agreeing
  // to half a degree by two entirely separate routes.
  //
  // A PRE-2015 calibration has nothing to read: that strategy commands the cams as degrees of phaser
  // retard against RPM instead (Ford's own production tables), so these fields sit at zero. Zeros
  // here are a strategy difference, not a fault, and are reported as such rather than decoded as 0°.

  /** Degrees BTDC (negative = ATDC) for a valve opening near the overlap TDC. */
  function calOpenBtdc(v) {
    var x = ((num(v) % 360) + 360) % 360;
    return x > 180 ? 360 - x : -x;
  }
  /** Degrees ABDC for a valve closing after BDC. */
  function calCloseAbdc(v) {
    return ((((num(v) % 360) + 360) % 360)) - 180;
  }
  /** Degrees ATDC (negative = BTDC) for a valve closing near the overlap TDC. */
  function calCloseAtdc(v) {
    var x = ((num(v) % 360) + 360) % 360;
    return x < 180 ? x : x - 360;
  }

  /**
   * Decode the calibration's cam fields.
   *
   * `cal` takes { intakeOpen, intakeClose, exhaustClose, exhaustOpen } as the tuning software shows
   * them. exhaustOpen is optional and in practice absent — Ford's calibration does not carry it — so
   * when it is missing the exhaust duration cannot be derived from the calibration alone and
   * `exhaustDurationFrom` says what it would take. Supply `parkEcl` (a cam card's park exhaust
   * centreline) and the exhaust closes out anyway.
   *
   * Returns null when every field is zero or absent, which is what a pre-2015 calibration looks like.
   */
  function fromCalibration(cal, parkEcl) {
    if (!cal) return null;
    var io = num(cal.intakeOpen), ic = num(cal.intakeClose);
    var ec = num(cal.exhaustClose), eo = num(cal.exhaustOpen);
    if (!io && !ic && !ec && !eo) return null;   // pre-2015 strategy: nothing stored here

    var out = { ivo: null, ivc: null, evo: null, evc: null, notes: [] };
    if (io) out.ivo = calOpenBtdc(io);
    if (ic) out.ivc = calCloseAbdc(ic);
    if (ec) out.evc = calCloseAtdc(ec);

    if (out.ivo != null && out.ivc != null) {
      out.intakeDuration = out.ivo + 180 + out.ivc;
      out.icl = out.intakeDuration / 2 - out.ivo;
    }
    if (eo) {
      // Exhaust opening is measured back from the overlap TDC through the whole exhaust stroke, so it
      // reduces as a closing-type angle and then has the 180 taken off it.
      out.evo = calCloseAbdc(eo) * -1;
      if (out.evc != null) {
        out.exhaustDuration = out.evo + 180 + out.evc;
        out.ecl = out.exhaustDuration / 2 - out.evc;
      }
    } else if (out.evc != null && typeof parkEcl === 'number' && isFinite(parkEcl)) {
      // No exhaust opening in the calibration, but a known park exhaust centreline pins it: the
      // centreline sits half a duration before the closing event, so the duration follows, and from
      // the duration the opening does too.
      out.ecl = parkEcl;
      out.exhaustDuration = 2 * (parkEcl + out.evc);
      out.evo = out.exhaustDuration - 180 - out.evc;
      out.notes.push('exhaust derived from a supplied park exhaust centreline of ' + parkEcl +
        '° BTDC, not from the calibration');
    } else if (out.evc != null) {
      out.exhaustDurationFrom = 'needs either the calibration’s exhaust opening or a known park ' +
        'exhaust centreline';
      out.notes.push('exhaust closing known, exhaust duration unknown');
    }
    return out;
  }

  // ---- engines --------------------------------------------------------------------------------
  //
  // What differs per engine is not only the stock grind but WHERE THE PHASERS PARK AND WHICH WAY THEY
  // CAN GO, and that is the part a single global model gets wrong.
  //
  //   Gen 1 (2011-14): the intake parks against a hard stop at its fully-retarded end and can only
  //     ADVANCE from there, so its position is never positive. ~51° of negative overlap at park,
  //     which is exactly what you want for cranking, and the reason it parks there.
  //   Gen 2 (2015-17): Ford put the intake phaser on a MID-TRAVEL LOCK PIN ("mid-lock intake" in
  //     Ford's own specification table), so park is no longer a stop and the intake can go either
  //     way. The park centreline moved 30° advanced of Gen 1's, to 109° ATDC.
  //   Gen 3 (2018-23): the mid-lock intake phaser carries over unchanged; the exhaust phaser is new
  //     (single bolt, oil-control-valve actuated, sealed cam journal). Its calibration reads out
  //     identically to Gen 2's, which is consistent with the carry-over.
  //   Gen 4 (2024+): the intake is centre-parked as well, so it too moves both ways. Its park
  //     centreline reads 140° ATDC out of the calibration, 30° retarded of Gen 2/3's 109.5°,
  //     which is a long way for a mid-travel lock to sit and is worth re-checking against a cam
  //     card if one ever appears -- the duration (260°) is frame-independent and agrees with
  //     Gen 2/3, but a centreline is only as good as the frame it is measured in.
  //
  // THE EXHAUST IS NOT CENTRE-PARKED ON ANY OF THEM: it parks fully advanced and only retards, so
  // its position is never negative. Only the intake changed.
  //
  // The travel limits are what make a position physically possible, so the UI clamps to them and the
  // log reader can flag a channel reading outside them — which is how a mis-scaled PID gets caught
  // rather than quietly producing impossible valve events.
  var ENGINES = {
    'coyote-gen1': {
      label: 'Coyote Gen 1 — 2011-14 Mustang GT',
      stockCam: 'coyote-gen1-stock',
      intake:  { min: -50, max: 0,  park: 'retarded' },
      exhaust: { min: 0,   max: 50, park: 'advanced' },
      source: 'park centrelines builder-endorsed; the 50° authority confirmed by Ford’s own ' +
              'Boss 302 production table reaching 89° ATDC',
    },
    'coyote-gen2': {
      label: 'Coyote Gen 2 — 2015-17 Mustang GT',
      stockCam: 'coyote-gen2-stock',
      intake:  { min: -20, max: 50, park: 'mid-lock' },
      exhaust: { min: 0,   max: 50, park: 'advanced' },
      source: 'Comp CY-r cam card (park ICL 109.0) and Ken’s own calibration (109.5), agreeing',
    },
    'coyote-gen3': {
      label: 'Coyote Gen 3 — 2018-23 Mustang GT',
      stockCam: 'coyote-gen3-stock-050',
      intake:  { min: -20, max: 50, park: 'mid-lock' },
      exhaust: { min: 0,   max: 50, park: 'advanced' },
      source: 'intake read from Ken’s calibration; exhaust park assumed unchanged from Gen 2',
    },
    'coyote-gen4': {
      label: 'Coyote Gen 4 — 2024+ Mustang GT',
      stockCam: 'coyote-gen4-stock-050',
      // Centre-parked intake like Gen 2 and Gen 3 (Ken, 2026-10-29). The travel figures are
      // Gen 2's, carried across on the strength of "Gen 2 and newer" rather than measured on a
      // Gen 4 -- no cam card for this engine exists yet, so treat the LIMITS as provisional even
      // though the direction is not.
      intake:  { min: -20, max: 50, park: 'mid-lock' },
      exhaust: { min: 0,   max: 50, park: 'advanced' },
      source: 'intake read from Ken’s calibration; centre-parked intake per Ken; travel limits ' +
              'assumed from Gen 2 and the exhaust duration not yet established',
    },
  };

  // ---- the cam library --------------------------------------------------------------------------
  //
  // `height` is the checking height the four events are quoted at and is not optional; `seatIntake` /
  // `seatExhaust` are the advertised/seat durations, used only to draw where the valve leaves its
  // seat on the diagram. `lobeIntake` / `lobeExhaust` are LOBE lift — the diagram multiplies by the
  // follower ratio to get valve lift.
  //
  // `provenance` is carried per cam on purpose. Ford publishes valve lift for these engines and
  // nothing else: no duration, no events, no centrelines, for any generation. So some of these rows
  // are off a cam card, some are derived from a calibration, and some rest on a builder-endorsed
  // figure that no factory document confirms. A tuner deciding whether to trust a number needs to see
  // which, and a row that says where it came from is worth more than one that looks authoritative.
  //
  // `valveIntake` / `valveExhaust`, where present, are VALVE lift as the maker printed it, and win
  // over lobe lift × ratio: the aftermarket prints valve lift, and dividing it by a guessed ratio
  // only to multiply it back would be a round trip that can only add error.
  var COMP3_NOTE = 'compcams.com: duration @ .050" and LSA only. Placed by the intake centreline from the cam ' +
    'card (ECL = 2 × LSA − ICL); advertised figures are compcams.com’s current ones (Summit prints 6-10° more).';
  var CAMS = {
    // --- factory ---------------------------------------------------------------------------------
    'coyote-gen1-stock': {
      label: 'Stock Coyote Gen 1 (2011-14)', engine: 'coyote-gen1', stock: true,
      ivo: -33.5, ivc: 64.5, evo: 48.5, evc: -17.5, height: '.050',
      seatIntake: 263, seatExhaust: 263, lobeIntake: 0.235, lobeExhaust: 0.216,
      provenance: 'builder-endorsed cam-card data; not in any Ford document. Reproduces the published ' +
                  'park/maximum centrelines 139/89 and 123/73 exactly.',
    },
    'coyote-gen2-stock': {
      label: 'Stock Coyote Gen 2 (2015-17)', engine: 'coyote-gen2', stock: true,
      ivo: -3.5, ivc: 34.5, evo: 48.5, evc: -17.5, height: '.050',
      seatIntake: 259, seatExhaust: 264, lobeIntake: 0.253, lobeExhaust: 0.253,
      provenance: 'Comp CY-r cam card: 211/211 @ .050", park ICL 109.0 / ECL 123.0. The seat figures ' +
                  'are the calibration’s own durations. Exhaust events are unchanged from Gen 1; ' +
                  'the intake is Gen 1’s lobe sitting 30° more advanced.',
    },
    'coyote-gen3-stock': {
      label: 'Stock Coyote Gen 3 (2018-23) — calibration events', engine: 'coyote-gen3', stock: true,
      // At the CALIBRATION's checking height, not .050" — Gen 3's .050" duration is unpublished.
      ivo: 20, ivc: 59, evo: 75, evc: 9, height: 'calibration',
      seatIntake: 259, seatExhaust: 264, lobeIntake: null, lobeExhaust: null,
      provenance: 'intake read from Ken’s calibration (open 340 / close 599 → 259°, ICL ' +
                  '109.5 ATDC); exhaust closing 369 → 9° ATDC, its duration set by the park ECL of ' +
                  '123° BTDC, which L&M’s 2018 tune sheet prints as the stock exhaust centreline. ' +
                  'Ford valve lift 14 mm; lobe lift unpublished.',
    },
    'coyote-gen4-stock': {
      label: 'Stock Coyote Gen 4 (2024+) — calibration events', engine: 'coyote-gen4', stock: true,
      ivo: -10, ivc: 90, evo: 80, evc: 14, height: 'calibration',
      seatIntake: 260, seatExhaust: 274, lobeIntake: null, lobeExhaust: null,
      provenance: 'intake read from Ken’s calibration (open 370 / close 630 → 260°, ICL ' +
                  '140.0 ATDC). The intake is centre-parked like Gen 2/3, so it moves both ways. Exhaust closing 374 ' +
                  '→ 14° ATDC; its duration ASSUMES a 123° BTDC park centreline carried ' +
                  'over, which Gen 4 may well have changed. Treat the exhaust as provisional.',
    },

    // --- stock Gen 3 / Gen 4 at .050", ESTIMATED -----------------------------------------------------
    // Ken, 2026-10-29: the Gen 3 durations are "way too high ... we need them at .050". They are: the
    // rows above are at the calibration's own (low, unstated) checking height. Nobody publishes a .050"
    // figure for either engine -- searched 2026-10-29: Ford, Comp, L&M, GSC, the forums; the one
    // ".050" figure in circulation (Summit's 260/263) is Gen 1's bare duration pair with no height.
    // So these are DERIVED, and say so in their names:
    //   * Gen 3's calibration events are IDENTICAL to Gen 2's (340 / 599 / 369 against 340 / 239 /
    //     369; 599 and 239 are the same event), and Gen 2's cam is MEASURED at 211/211 @ .050" (Comp's
    //     worksheet). The calibration-to-.050 gap on Gen 2 is 48° intake (259 → 211) and 53° exhaust
    //     (264 → 211).
    //   * Gen 3: 259 − 48 = 211 and 264 − 53 = 211, at the calibration's 109.5 ICL and L&M's printed
    //     123 park ECL. A LOWER bound: Gen 3 lifts 14 mm against Gen 2's 13, which spends a little
    //     more crank angle above .050".
    //   * Gen 4: the same gaps on its 260 / 274 → 212 / 221, at the calibration's 140 ICL and an
    //     assumed 123 ECL. Shakier -- different lift (Ford: 13 mm) and the exhaust is itself inferred.
    // One degreed stock cam replaces both rows.
    'coyote-gen3-stock-050': Object.assign({ label: 'Stock Coyote Gen 3 (2018-23) — .050 ESTIMATE', engine: 'coyote-gen3', stock: true },
      fromCard(211, 211, 109.5, 123), { height: '.050', seatIntake: 259, seatExhaust: 264,
      valveIntake: 0.551, valveExhaust: 0.551,
      provenance: 'ESTIMATE, not published anywhere: Gen 2’s measured 211/211 @ .050" carried across, because Gen 3’s ' +
                  'calibration events are identical to Gen 2’s. Park ICL 109.5 from the calibration, ECL 123 from L&M’s ' +
                  'tune sheet, valve lift Ford’s 14 mm. Likely a few degrees short (more lift than Gen 2). Degree a ' +
                  'stock cam to replace it.' }),
    'coyote-gen4-stock-050': Object.assign({ label: 'Stock Coyote Gen 4 (2024+) — .050 ESTIMATE', engine: 'coyote-gen4', stock: true },
      fromCard(212, 221, 140, 123), { height: '.050', seatIntake: 260, seatExhaust: 274,
      valveIntake: 0.512, valveExhaust: 0.512,
      provenance: 'ESTIMATE, not published anywhere: the calibration’s 260/274 less Gen 2’s measured calibration-to-.050 ' +
                  'gaps (48° / 53°). ICL 140 from the calibration; ECL 123 ASSUMED carried over. Valve lift 13 mm per ' +
                  'Ford’s Gen 4 tech sheet. Treat as rough until a stock cam is degreed.' }),

    // --- Comp, Gen 1 (191xxx NA / Blower series) --------------------------------------------------
    // From Ken's own master list, which the proofread checked against Comp's published @.050"
    // durations: every one reconciles, with a constant 40°/44° advertised-minus-.050 spread across
    // the whole family — the signature of one lobe family, and good evidence the events are right.
    'comp-191060': { label: 'Comp Stage I NA — 191060', engine: 'coyote-gen1',
      ivo: -19, ivc: 59, evo: 54, evc: -11, height: '.050', seatIntake: 260, seatExhaust: 267,
      lobeIntake: 0.244, lobeExhaust: 0.226, provenance: 'Comp catalogue, via Ken’s master list' },
    'comp-191100': { label: 'Comp Stage II NA — 191100', engine: 'coyote-gen1',
      ivo: -15, ivc: 63, evo: 58, evc: -7, height: '.050', seatIntake: 268, seatExhaust: 275,
      lobeIntake: 0.244, lobeExhaust: 0.226, provenance: 'Comp catalogue, via Ken’s master list' },
    'comp-191160': { label: 'Comp Stage III NA — 191160', engine: 'coyote-gen1',
      ivo: -11, ivc: 67, evo: 62, evc: -3, height: '.050', seatIntake: 276, seatExhaust: 283,
      lobeIntake: 0.244, lobeExhaust: 0.226, provenance: 'Comp catalogue, via Ken’s master list' },
    'comp-191260': { label: 'Comp Stage I Blower — 191260', engine: 'coyote-gen1',
      ivo: -23, ivc: 63, evo: 56, evc: -9, height: '.050', seatIntake: 260, seatExhaust: 271,
      lobeIntake: 0.244, lobeExhaust: 0.226, provenance: 'Comp catalogue, via Ken’s master list' },
    'comp-191360': { label: 'Comp Stage II Blower — 191360', engine: 'coyote-gen1',
      ivo: -19, ivc: 67, evo: 60, evc: -5, height: '.050', seatIntake: 268, seatExhaust: 279,
      lobeIntake: 0.244, lobeExhaust: 0.226, provenance: 'Comp catalogue, via Ken’s master list' },
    'comp-191460': { label: 'Comp Stage III Blower — 191460', engine: 'coyote-gen1',
      ivo: -15, ivc: 71, evo: 64, evc: -1, height: '.050', seatIntake: 276, seatExhaust: 287,
      lobeIntake: 0.244, lobeExhaust: 0.226, provenance: 'Comp catalogue, via Ken’s master list' },

    // --- Comp, Gen 2 (243xxx CY-r series) ---------------------------------------------------------
    // The card publishes duration @ .050" and the park centrelines rather than the four events, so
    // the events here are back-computed from those two: ivo = ICL − dur/2, and so on. That is exact
    // arithmetic on the card's own figures, not an estimate, and the test suite checks each row
    // round-trips back to the card's centrelines.
    'comp-243420': { label: 'Comp CY-r 243420', engine: 'coyote-gen2',
      ivo: -4.5, ivc: 51.5, evo: 70.5, evc: -21.5, height: '.050', seatIntake: 263, seatExhaust: 263,
      lobeIntake: 0.255, lobeExhaust: 0.254, provenance: 'Comp CY-r card: 227/229 @ .050", park ICL 118.0 / ECL 136.0' },
    'comp-243430': { label: 'Comp CY-r 243430', engine: 'coyote-gen2',
      ivo: -4.5, ivc: 55.5, evo: 74.5, evc: -21.5, height: '.050', seatIntake: 267, seatExhaust: 267,
      lobeIntake: 0.255, lobeExhaust: 0.254, provenance: 'Comp CY-r card: 231/233 @ .050", park ICL 120.0 / ECL 138.0' },
    'comp-243440': { label: 'Comp CY-r 243440', engine: 'coyote-gen2',
      ivo: -4.5, ivc: 59.5, evo: 78.5, evc: -21.5, height: '.050', seatIntake: 271, seatExhaust: 271,
      lobeIntake: 0.255, lobeExhaust: 0.254, provenance: 'Comp CY-r card: 235/237 @ .050", park ICL 122.0 / ECL 140.0' },
    'comp-243460': { label: 'Comp CY-r 243460', engine: 'coyote-gen2',
      ivo: -4.5, ivc: 55.5, evo: 78.5, evc: -21.5, height: '.050', seatIntake: 267, seatExhaust: 267,
      lobeIntake: 0.255, lobeExhaust: 0.254, provenance: 'Comp CY-r card: 231/237 @ .050", park ICL 120.0 / ECL 140.0' },
    'comp-243480': { label: 'Comp CY-r 243480', engine: 'coyote-gen2',
      ivo: -4.5, ivc: 63.5, evo: 86.5, evc: -21.5, height: '.050', seatIntake: 275, seatExhaust: 275,
      lobeIntake: 0.255, lobeExhaust: 0.254, provenance: 'Comp CY-r card: 239/245 @ .050", park ICL 124.0 / ECL 144.0' },

    // --- L&M Engines ------------------------------------------------------------------------------
    // L&M prints duration @ .050" and, for these, the centrelines "with Phasers Parked" in so many
    // words, which makes them the best-placed aftermarket Gen 3 cams found. Lift is printed with no
    // basis; .551" can only be valve lift on this follower, so it is carried as valve lift.
    'lm-c18-iope': Object.assign({ label: 'L&M LM-C18-IOPE (Intake Only + Paired Exhaust)', engine: 'coyote-gen3' },
      fromCard(232, 234, 117, 135), { height: '.050', valveIntake: 0.551, valveExhaust: 0.551,
      provenance: 'lmengines.com: 232/234 @ .050", "Parked Centerlines Intake - 117, Exhaust - 135". ' +
                  'Events computed from those, assuming symmetric lobes. Advertised duration unpublished.' }),
    'lm-c18-lm2': Object.assign({ label: 'L&M LM-C18-LM2', engine: 'coyote-gen3' },
      fromCard(239, 244, 117, 133), { height: '.050', valveIntake: 0.551, valveExhaust: 0.551,
      provenance: 'lmengines.com: 239/244 @ .050", "Parked Centerlines Intake - 117, Exhaust - 133". ' +
                  'Events computed from those, assuming symmetric lobes. Advertised duration unpublished.' }),
    // Intake-only: L&M gives the intake's two half-events about its centreline (an asymmetric lobe,
    // so these are exact rather than assumed), and the exhaust stays stock.
    'lm-c11-io': { label: 'L&M LM-C11-IO (Intake Only, stock exhaust)', engine: 'coyote-gen1',
      ivo: -(129 - 107), ivc: 129 + 120 - 180, evo: 48.5, evc: -17.5, height: '.050',
      valveIntake: 0.472, lobeExhaust: 0.216,
      provenance: 'lmengines.com: intake "asymmetrical 107 deg Open & 120 deg Close" @ .050" about a ' +
                  '129° parked centreline; the exhaust is the stock Gen 1 cam.' },

    // --- GSC Power-Division -----------------------------------------------------------------------
    // GSC prints a "Center Line" pair without saying what it is measured from. It is read here as
    // PARK, because that is the only reading that fits: Gen 3's 120/138 sits beside L&M's parked
    // 117/135 and Comp's parked Gen 2 118-124 / 136-144, and Gen 4's intake 142-146 lands next to the
    // 140° park centreline read independently out of Ken's Gen 4 calibration. Still an inference --
    // the provenance says so.
    'gsc-7073s1': { label: 'GSC S1 — 7073S1', engine: 'coyote-gen3',
      ivo: -5, ivc: 57, evo: 81, evc: -17, height: '.050', seatIntake: 290, seatExhaust: 300,
      valveIntake: 0.551, valveExhaust: 0.551,
      provenance: GSC_CARD('232/244') },
    'gsc-7073s2': { label: 'GSC S2 — 7073S2', engine: 'coyote-gen3',
      ivo: -2, ivc: 61, evo: 83, evc: -11, height: '.050', seatIntake: 292, seatExhaust: 316,
      valveIntake: 0.560, valveExhaust: 0.560,
      provenance: GSC_CARD('239/252') },
    'gsc-7073r2': { label: 'GSC R2 — 7073R2', engine: 'coyote-gen3',
      ivo: -2, ivc: 61, evo: 77, evc: -16, height: '.050', seatIntake: 292, seatExhaust: 304,
      valveIntake: 0.560, valveExhaust: 0.560,
      provenance: GSC_CARD('239/241') },
    'gsc-7073r3': { label: 'GSC R3 — 7073R3', engine: 'coyote-gen3',
      ivo: 1, ivc: 65, evo: 83, evc: -11, height: '.050', seatIntake: 300, seatExhaust: 316,
      valveIntake: 0.560, valveExhaust: 0.560,
      provenance: GSC_CARD('246/252') },
    'gsc-7079s1': Object.assign({ label: 'GSC S1 — 7079S1', engine: 'coyote-gen4' },
      fromCard(232, 235, 142, 134), { height: '.050', seatIntake: 290, seatExhaust: 292,
      valveIntake: 0.551, valveExhaust: 0.551, provenance: GSC_NOTE('232/235 @ .050", "Center Line" 142/134') }),
    'gsc-7079r2': Object.assign({ label: 'GSC R2 — 7079R2', engine: 'coyote-gen4' },
      fromCard(239, 241, 146, 138), { height: '.050', seatIntake: 292, seatExhaust: 304,
      valveIntake: 0.560, valveExhaust: 0.560, provenance: GSC_NOTE('239/241 @ .050", "Center Line" 146/138') }),
    'gsc-7079r3': Object.assign({ label: 'GSC R3 — 7079R3', engine: 'coyote-gen4' },
      fromCard(246, 252, 146, 138), { height: '.050', seatIntake: 300, seatExhaust: 316,
      valveIntake: 0.560, valveExhaust: 0.560, provenance: GSC_NOTE('246/252 @ .050", "Center Line" 146/138') }),

    // --- Comp, Gen 3 (433xxx) — the centreline comes off YOUR cam card ----------------------------
    // Comp publishes duration @ .050" and LSA for these and no centreline anywhere. On every Gen 2
    // card Comp's LSA is exactly the park separation ((ICL + ECL) / 2: 243420 is (118 + 136) / 2 =
    // 127, its LSA), so one number -- the intake centreline printed on the card in the box --
    // places the whole cam: ECL = 2 × LSA − ICL. Until it is typed in, the cam is drawn at Comp's
    // Gen 2 practice of an intake ground 9° advanced of the LSA, and says so on screen.
    'comp-433420': { label: 'Comp XFI NSR Stage 1 — 433420', engine: 'coyote-gen3', card: { durI: 228, durE: 230, lsa: 123 },
      height: '.050', seatIntake: 270, seatExhaust: 277, valveIntake: 0.550, valveExhaust: 0.550, provenance: COMP3_NOTE },
    'comp-433430': { label: 'Comp XFI NSR Stage 2 — 433430', engine: 'coyote-gen3', card: { durI: 232, durE: 234, lsa: 125 },
      height: '.050', seatIntake: 274, seatExhaust: 281, valveIntake: 0.550, valveExhaust: 0.550, provenance: COMP3_NOTE },
    'comp-433560': { label: 'Comp XFI VSR Stage 1 Blower/Turbo — 433560', engine: 'coyote-gen3', card: { durI: 232, durE: 238, lsa: 126 },
      height: '.050', seatIntake: 274, seatExhaust: 285, valveIntake: 0.580, valveExhaust: 0.580, provenance: COMP3_NOTE },
    'comp-433580': { label: 'Comp XFI VSR Stage 2 Blower/Turbo — 433580', engine: 'coyote-gen3', card: { durI: 240, durE: 246, lsa: 128 },
      height: '.050', seatIntake: 282, seatExhaust: 293, valveIntake: 0.590, valveExhaust: 0.590,
      provenance: COMP3_NOTE + ' Summit prints LSA 130 and .580" exhaust lift for this one; Comp’s own 128 / .590" is used.' },
    'comp-433700': { label: 'Comp Thumpr NSR Stage 1 — 433700', engine: 'coyote-gen3', card: { durI: 228, durE: 238, lsa: 124 },
      height: '.050', seatIntake: 270, seatExhaust: 300, valveIntake: 0.550, valveExhaust: 0.540, provenance: COMP3_NOTE },
    'comp-433710': { label: 'Comp Mutha’ Thumpr NSR Stage 2 — 433710', engine: 'coyote-gen3', card: { durI: 232, durE: 242, lsa: 126 },
      height: '.050', seatIntake: 274, seatExhaust: 304, valveIntake: 0.550, valveExhaust: 0.540, provenance: COMP3_NOTE },
  };

  // GSC's Gen 3 cam cards (power-division.com/pages/cam-cards) print all four events at .050" valve lift,
  // so those rows carry the card's events as printed. They put the centrelines a degree or two off the
  // printed 120/138 -- normal for an asymmetric lobe, whose peak is not midway between its .050 points.
  // R2's card prints exhaust 245 but its own events sum to 241, which is what the product page says.
  function GSC_CARD(durs) {
    return 'GSC cam card: ' + durs + ' @ .050", events as printed, centrelines printed 120 ATDC / 138 BTDC ' +
      '(LSA 129). The card does not say these are at park; read that way, as every other maker’s park ' +
      'centrelines for Gen 3 sit within a few degrees. GSC prints its follower ratio as 1.89.';
  }
  function GSC_NOTE(s) {
    return 'power-division.com: ' + s + '. GSC does not say what its centreline is measured from; it is ' +
      'read as phasers parked (see the note in the code). Events computed assuming symmetric lobes.';
  }
  // Comp's Gen 2 cards grind the intake 9-10° advanced of the LSA; with no Gen 3 card it is the
  // nearest published practice, and it is only ever a stand-in until the real card is typed in.
  var CARD_ASSUMED_ADVANCE = 9;

  /**
   * A cam ready to draw. Most rows already are; a row that needs its centreline from the user's
   * cam card (`card`) gets its events from the centreline supplied, or the stated stand-in.
   */
  function resolveCam(cam, icl) {
    if (!cam || !cam.card) return cam;
    var c = cam.card;
    var assumed = !(typeof icl === 'number' && isFinite(icl));
    var i = assumed ? c.lsa - CARD_ASSUMED_ADVANCE : icl;
    return Object.assign({}, cam, fromCard(c.durI, c.durE, i, 2 * c.lsa - i),
      { cardIcl: i, cardIclAssumed: assumed });
  }

  /**
   * "Your own cam card" for an engine: four numbers off any card -- duration @ .050" and the two
   * park centrelines -- for the cams nobody publishes (every Gen 4 aftermarket cam but GSC's, for one).
   */
  function customCam(engineId, c) {
    c = c || {};
    var e = ENGINES[engineId] ? engineId : 'coyote-gen1';
    var d = { durI: 230, durE: 234, icl: 118, ecl: 134 };
    var v = {};
    Object.keys(d).forEach(function (k) { v[k] = (typeof c[k] === 'number' && isFinite(c[k])) ? c[k] : d[k]; });
    return Object.assign({ label: 'Your own cam card', engine: e, custom: v },
      fromCard(v.durI, v.durE, v.icl, v.ecl),
      { height: '.050', provenance: 'typed in from a cam card: ' + v.durI + '/' + v.durE + ' @ .050", park ICL ' +
        v.icl + ' / ECL ' + v.ecl + '. Events computed assuming symmetric lobes.' });
  }

  // The roller finger follower's ratio. Nobody publishes it — not Ford, not the cam grinders, and
  // Comp notes that a finger follower's ratio "is never static" through the lift curve anyway. It is
  // derivable two ways and they disagree in the third decimal: Ford's 12.0 mm Gen 1 valve lift over a
  // .235" lobe gives 2.010, while Comp's own .253" lobe / .512" valve pairing gives 2.024. It is a
  // default here rather than a constant, and the UI exposes it, because the only honest version of
  // this number is one the user can replace with what they measured.
  var FOLLOWER_RATIO = 2.01;
  var SEAT_RAMP_ASSUMED = 20;

  /** Valve lift at full lift, or null when the cam's lobe lift is unknown. */
  function valveLift(lobeLift, ratio) {
    if (typeof lobeLift !== 'number' || !isFinite(lobeLift)) return null;
    return lobeLift * (typeof ratio === 'number' && isFinite(ratio) ? ratio : FOLLOWER_RATIO);
  }

  // ---- the valve-event diagram --------------------------------------------------------------------
  //
  // Five points per valve, in one crank-angle frame with 0 at the overlap TDC and before it negative,
  // which is the frame Ken's worksheet chart already draws in:
  //
  //   seat open · checking-height open · full lift at the centreline · checking-height close · seat close
  //
  // The seat points come from the seat/advertised duration, split evenly either side of the
  // checking-height event. That assumes a SYMMETRIC lobe, which is a real approximation and wrong by
  // a few degrees on an asymmetric grind — it is flagged on the returned object rather than hidden,
  // because the cams it is least true of are exactly the ones people reach for.
  function liftProfile(cam, intakePos, exhaustPos, ratio) {
    var ev = solve(cam, intakePos, exhaustPos);
    // No published seat duration: draw the ramp with the 20° a side (40° total) that every Comp
    // Coyote grind with both figures shows, and say it was assumed. The diagram is the only consumer.
    var hasSeat = function (v) { return typeof v === 'number' && isFinite(v); };
    var rampI = hasSeat(cam.seatIntake) ? (cam.seatIntake - ev.intakeDuration) / 2 : SEAT_RAMP_ASSUMED;
    var rampE = hasSeat(cam.seatExhaust) ? (cam.seatExhaust - ev.exhaustDuration) / 2 : SEAT_RAMP_ASSUMED;
    var liftI = hasSeat(cam.valveIntake) ? cam.valveIntake : valveLift(cam.lobeIntake, ratio);
    var liftE = hasSeat(cam.valveExhaust) ? cam.valveExhaust : valveLift(cam.lobeExhaust, ratio);
    // Intake: opens ev.ivo BTDC (so at −ivo in this frame) and closes ev.ivc ABDC (at 180 + ivc).
    var iOpen = -ev.ivo, iClose = 180 + ev.ivc;
    // Exhaust: opens ev.evo BBDC, i.e. a full stroke plus that before the overlap TDC, and closes
    // ev.evc ATDC.
    var eOpen = -(ev.evo + 180), eClose = ev.evc;
    return {
      events: ev,
      symmetricLobeAssumed: true,
      seatAssumed: !hasSeat(cam.seatIntake) || !hasSeat(cam.seatExhaust),
      intake: {
        seatOpen: iOpen - rampI, open: iOpen, peak: ev.icl, close: iClose, seatClose: iClose + rampI,
        peakLift: liftI,
      },
      exhaust: {
        seatOpen: eOpen - rampE, open: eOpen, peak: -ev.ecl, close: eClose, seatClose: eClose + rampE,
        peakLift: liftE,
      },
    };
  }

  // ---- helpers for the UI and the log reader -------------------------------------------------------

  /** Cams that belong to an engine, stock first, then by name. */
  function camsFor(engineId) {
    return Object.keys(CAMS)
      .filter(function (k) { return !engineId || CAMS[k].engine === engineId; })
      .sort(function (a, b) {
        var A = CAMS[a], B = CAMS[b];
        if (!!A.stock !== !!B.stock) return A.stock ? -1 : 1;
        return A.label < B.label ? -1 : A.label > B.label ? 1 : 0;
      })
      .map(function (k) { return { id: k, cam: CAMS[k] }; });
  }

  // ---- which engine a log came from ---------------------------------------------------------------
  //
  // Ken, 2026-10-29, opening a 2024 log: "its only showing the gen 3 cams as an option ... should be
  // gen4". The panel opened on whatever engine was picked last. The log itself rarely says -- the .hpl
  // decoder reads no vehicle block -- but HP Tuners names its logs with the VIN ("Log-0012-<VIN>.hpl",
  // "log-000011-<date>-<VIN>.hpl"), and a Mustang VIN carries the model year and the engine.
  //
  // Only a VIN whose CHECK DIGIT is right is believed: HP Tuners writes a placeholder VIN on some logs
  // (it starts "HPT"), and a year letter read out of that would be a confident wrong answer. Only a
  // Mustang (VIN line P8, 1ZV or 1FA) with a Coyote engine letter is placed -- F is the 5.0 GT, 0 the
  // Bullitt / Mach 1 / Dark Horse 5.0 -- because the truck generations split on different years and the
  // GT350 / GT500 / EcoBoost are not Coyotes. Anything else returns null and the last pick stands.
  var VIN_TR = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7,
    R: 9, S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9 };
  var VIN_W = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
  var VIN_YEARS = 'ABCDEFGHJKLMNPRSTVWXY123456789';   // 2010 .. 2039
  function vinValid(v) {
    var sum = 0;
    for (var i = 0; i < 17; i++) {
      var ch = v.charAt(i);
      var n = /\d/.test(ch) ? +ch : VIN_TR[ch];
      if (n === undefined) return false;
      sum += n * VIN_W[i];
    }
    var r = sum % 11;
    return v.charAt(8) === (r === 10 ? 'X' : String(r));
  }
  function mustangGen(year) {
    if (year >= 2024) return 'coyote-gen4';
    if (year >= 2018) return 'coyote-gen3';
    if (year >= 2015) return 'coyote-gen2';
    if (year >= 2011) return 'coyote-gen1';
    return null;
  }
  /** { engine, year, vin } from the first valid Coyote-Mustang VIN in `text` (a file name), or null. */
  function vinEngine(text) {
    var re = /(?:^|[^A-Z0-9])([A-HJ-NPR-Z0-9]{17})(?=$|[^A-Z0-9])/g, m;
    var s = String(text || '').toUpperCase();
    while ((m = re.exec(s))) {
      var v = m[1];
      if (!vinValid(v)) continue;
      if (!/^(1ZV|1FA)/.test(v) || v.substr(4, 2) !== 'P8') return null;   // a real VIN, not a Mustang
      if (v.charAt(7) !== 'F' && v.charAt(7) !== '0') return null;           // a Mustang, not a Coyote
      var yi = VIN_YEARS.indexOf(v.charAt(9));
      var year = yi < 0 ? null : 2010 + yi;
      var engine = year ? mustangGen(year) : null;
      return engine ? { engine: engine, year: year, vin: v } : null;
    }
    return null;
  }

  /**
   * Is a phaser position physically reachable on this engine? A log channel outside the limits is
   * the signature of a mis-scaled PID, not of a cam in an exotic place, so this is worth saying out
   * loud rather than computing valve events nobody's engine can produce.
   */
  function checkPosition(engineId, intakePos, exhaustPos) {
    var e = ENGINES[engineId];
    if (!e) return { ok: true, warnings: [] };
    var w = [];
    var band = function (v, lim, what) {
      if (typeof v !== 'number' || !isFinite(v)) return;
      if (v < lim.min - 0.5 || v > lim.max + 0.5) {
        w.push(what + ' position ' + v.toFixed(1) + '° is outside this engine’s travel (' +
          lim.min + '° to +' + lim.max + '°)');
      }
    };
    band(intakePos, e.intake, 'Intake');
    band(exhaustPos, e.exhaust, 'Exhaust');
    return { ok: !w.length, warnings: w };
  }

  function clampPosition(engineId, which, v) {
    var e = ENGINES[engineId];
    if (!e || !e[which] || typeof v !== 'number' || !isFinite(v)) return v;
    return Math.max(e[which].min, Math.min(e[which].max, v));
  }

  // Ford Racing's published production WOT cam timing, straight off its own "Camshaft Timing
  // Recommendations" sheet, in Ford's own units (deg retard, so intake negative). Held here so the
  // diagram can show what the factory actually commands next to what a car is doing. Note that Ford
  // schedules the two cams on DIFFERENT rpm breakpoints — they are stored as two separate curves
  // rather than one table of pairs, because flattening them would invent values Ford never published.
  var FORD_WOT = {
    'coyote-gen1': {
      label: '2011-13 Mustang GT, production WOT',
      intake: [[1000, -30], [1250, -30], [1500, -30], [1750, -40], [2000, -40], [2750, -40],
               [3000, -40], [4000, -40], [5500, -20], [6000, -16], [6500, -14]],
      exhaust: [[1000, 0], [1250, 0], [1500, 5], [1750, 5], [2000, 10], [2750, 10],
                [3000, 15], [4000, 15], [5500, 15], [6000, 15], [6500, 15]],
    },
    'boss302': {
      label: '2012-13 Boss 302, production WOT',
      intake: [[1000, -40], [1500, -40], [2500, -50], [4000, -50], [4500, -46], [4750, -42],
               [5250, -38], [5500, -32], [5750, -24.5], [7000, -17], [7500, -15]],
      exhaust: [[1000, 0], [1500, 0], [2000, 0], [2500, 15], [4000, 15], [4500, 15],
                [5000, 15], [5250, 15], [6000, 10], [6500, 10], [7200, 10]],
    },
  };

  /** Linear interpolation into one of the Ford curves; clamps outside its ends rather than extending. */
  function fordAt(curve, rpm) {
    if (!curve || !curve.length) return null;
    if (rpm <= curve[0][0]) return curve[0][1];
    if (rpm >= curve[curve.length - 1][0]) return curve[curve.length - 1][1];
    for (var i = 0; i < curve.length - 1; i++) {
      var a = curve[i], b = curve[i + 1];
      if (rpm >= a[0] && rpm <= b[0]) {
        if (b[0] === a[0]) return a[1];
        return a[1] + (b[1] - a[1]) * ((rpm - a[0]) / (b[0] - a[0]));
      }
    }
    return curve[curve.length - 1][1];
  }

  global.DatalogCam = {
    events: events,
    solve: solve,
    separation: separation,
    liftProfile: liftProfile,
    valveLift: valveLift,
    fromCalibration: fromCalibration,
    calOpenBtdc: calOpenBtdc,
    calCloseAbdc: calCloseAbdc,
    calCloseAtdc: calCloseAtdc,
    camsFor: camsFor,
    fromCard: fromCard,
    resolveCam: resolveCam,
    customCam: customCam,
    vinEngine: vinEngine,
    CARD_ASSUMED_ADVANCE: CARD_ASSUMED_ADVANCE,
    checkPosition: checkPosition,
    clampPosition: clampPosition,
    fordAt: fordAt,
    ENGINES: ENGINES,
    CAMS: CAMS,
    FORD_WOT: FORD_WOT,
    FOLLOWER_RATIO: FOLLOWER_RATIO,
    VERSION: 'cam@1.1.0',
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* ==============================================================================================
 * THE PANEL
 * ----------------------------------------------------------------------------------------------
 * Everything above is pure maths and data and is unit-tested by dev/cam-test.js. Everything below
 * only draws, and is loaded into the page lazily by datalog-viewer.js the first time the Cam Timing
 * item is used -- which is why this is one file rather than two: it keeps the whole feature out of
 * every host's script list, where a missed tag on one of five copies is the recurring failure.
 * ============================================================================================== */
/*
 * the Cam Timing panel: a valve-event diagram and a side-by-side comparison of
 * two camshafts on a Ti-VCT engine. All the arithmetic lives in datalog-cam.js; this file only draws.
 *
 * It replaces the chart in Ken's TiVCT worksheet, which plotted five points per valve — seat open,
 * checking-height open, full lift, checking-height close, seat close — against crank angle with the
 * overlap TDC at zero. Same frame here, so a reading taken off the sheet lands in the same place on
 * this diagram.
 *
 * WHY TWO CAMS AT ONCE. Choosing a grind is a comparison, never an absolute: what a tuner wants to
 * see is where the second cam's curve sits against the one in the engine, with the phasers somewhere
 * realistic rather than at park. So B is drawn over A in the same frame, dashed, which is the same
 * visual language the viewer already uses for a comparison log, and the numbers table shows the
 * difference rather than making anyone subtract two columns in their head.
 *
 * The panel opens with no log loaded — it is a calculator, not a log view.
 */
(function (global) {
  'use strict';

  var C = null;   // resolved lazily so load order between the two files cannot matter
  function cam() { return C || (C = global.DatalogCam); }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmt(v, dp) {
    if (typeof v !== 'number' || !isFinite(v)) return '—';
    return v.toFixed(dp === undefined ? 1 : dp);
  }
  /** A signed difference, with the sign always shown — the whole point of the column is the direction. */
  function delta(a, b, dp) {
    if (typeof a !== 'number' || typeof b !== 'number' || !isFinite(a) || !isFinite(b)) return '';
    var d = b - a;
    if (Math.abs(d) < 5e-4) return '—';
    return (d > 0 ? '+' : '') + d.toFixed(dp === undefined ? 1 : dp);
  }

  // The panel's own stylesheet, injected once. It used to live in datalog-viewer.css, which is fine
  // over the viewer but means nothing on a page that only loads this file -- and the reason the page
  // exists is that the tool should not need a log, and so should not need the viewer, to be used.
  var PANEL_CSS = [
    '/* ---- CAM TIMING panel (Ti-VCT), Ken 2026-10-29 -------------------------------------------------',
    '   Injected by datalog-cam.js itself, so the module works on a page that loads nothing else of the',
    '   engine (alldatalogs.com/cam-timing) as well as over the viewer. Every colour is a var() with a',
    '   fallback, so it renders properly whether or not the page defines the viewer\'s tokens.',
    '   A calculator rather than a log view, so it is a modal over whatever is on screen and works with no',
    '   log loaded at all. Two camshafts at once: A solid, B dashed, which is the same language the',
    '   comparison log already uses on the graphs. */',
    '.dlv-cam-ovl{position:fixed;inset:0;z-index:1100;background:rgba(0,0,0,.6);display:flex;',
    '  align-items:flex-start;justify-content:center;padding:28px 16px;overflow:auto;}',
    '.dlv-cam{width:min(1000px,100%);background:var(--card, #121216);color:var(--text, #e8e8ea);',
    '  border:1px solid var(--card-border, #26262c);border-radius:10px;box-shadow:0 18px 50px rgba(0,0,0,.6);}',
    '.dlv-cam-head{display:flex;align-items:center;gap:10px;padding:12px 14px;',
    '  border-bottom:1px solid var(--card-border, #26262c);}',
    '.dlv-cam-title{display:flex;flex-direction:column;line-height:1.15;}',
    '.dlv-cam-kicker{font-size:9px;font-weight:800;letter-spacing:1.2px;text-transform:uppercase;',
    '  color:var(--red, #d1132e);}',
    '.dlv-cam-title b{font-size:16px;}',
    '.dlv-cam-x{margin-left:auto;background:none;border:none;color:var(--text-faint, #5c5c66);',
    '  font-size:22px;line-height:1;cursor:pointer;padding:0 4px;}',
    '.dlv-cam-x:hover{color:var(--red, #d1132e);}',
    '.dlv-cam-body{padding:14px;}',
    '.dlv-cam-top{display:flex;align-items:flex-end;gap:14px;flex-wrap:wrap;margin-bottom:12px;}',
    '.dlv-cam-top label{display:flex;flex-direction:column;gap:3px;font-size:10px;font-weight:700;',
    '  letter-spacing:.4px;text-transform:uppercase;color:var(--text-dim, #9a9aa2);}',
    '.dlv-cam-top select,.dlv-cam-num{background:var(--bg-soft, #0d0d11);color:var(--text, #e8e8ea);',
    '  border:1px solid var(--card-border, #26262c);border-radius:5px;padding:5px 7px;font:inherit;font-size:12px;}',
    '.dlv-cam-eng select{min-width:250px;}',
    '.dlv-cam-ratio .dlv-cam-num{width:84px;}',
    '.dlv-cam-engnote{flex:1 1 220px;font-size:11px;color:var(--text-faint, #5c5c66);line-height:1.35;',
    '  text-transform:none;letter-spacing:0;}',
    '/* Two cam columns side by side; they stack on a phone. */',
    '.dlv-cam-cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));gap:12px;}',
    '.dlv-cam-col{background:var(--bg-soft, #0d0d11);border:1px solid var(--card-border, #26262c);',
    '  border-radius:8px;padding:10px;}',
    '.dlv-cam-colhead{display:flex;align-items:center;gap:7px;font-size:10px;font-weight:800;',
    '  letter-spacing:.8px;text-transform:uppercase;color:var(--text-dim, #9a9aa2);margin-bottom:7px;}',
    '.dlv-cam-swatch{width:16px;height:3px;border-radius:2px;background:var(--red, #d1132e);}',
    '.dlv-cam-swatch.b{background:var(--text-dim, #9a9aa2);',
    '  background-image:repeating-linear-gradient(90deg,currentColor 0 5px,transparent 5px 8px);}',
    '.dlv-cam-clearb{margin-left:auto;background:none;border:none;color:var(--text-faint, #5c5c66);',
    '  font-size:15px;line-height:1;cursor:pointer;}',
    '.dlv-cam-clearb:hover{color:var(--red, #d1132e);}',
    '.dlv-cam-sel{width:100%;background:var(--card, #121216);color:var(--text, #e8e8ea);',
    '  border:1px solid var(--card-border, #26262c);border-radius:5px;padding:5px 7px;font:inherit;font-size:12px;}',
    '.dlv-cam-engwhy{color:var(--text, #e8e8ea);font-weight:700;}',
    '/* The numbers off a cam card, for a grind whose timing is not published in full. */',
    '.dlv-cam-cardin{display:flex;flex-wrap:wrap;gap:6px 10px;margin-top:8px;align-items:flex-end;}',
    '.dlv-cam-cardin label{display:flex;flex-direction:column;gap:2px;font-size:9.5px;font-weight:700;',
    '  letter-spacing:.3px;text-transform:uppercase;color:var(--text-dim, #9a9aa2);}',
    '.dlv-cam-cardin .dlv-cam-num{width:76px;}',
    '.dlv-cam-cardin b{font-size:12px;color:var(--text, #e8e8ea);padding:5px 0;}',
    '.dlv-cam-cardin em{flex:1 1 100%;font-style:normal;font-size:9.5px;color:var(--text-faint, #5c5c66);}',
    '.dlv-cam-pos{display:grid;grid-template-columns:58px 1fr 68px;align-items:center;gap:7px;margin-top:8px;',
    '  font-size:10px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:var(--text-dim, #9a9aa2);}',
    '.dlv-cam-pos input[type=range]{width:100%;accent-color:var(--red, #d1132e);}',
    '.dlv-cam-pos em{grid-column:2 / span 2;font-style:normal;font-size:9.5px;font-weight:600;',
    '  letter-spacing:0;text-transform:none;color:var(--text-faint, #5c5c66);}',
    '/* A position the phasers cannot physically reach, or two cams measured at different heights: said',
    '   out loud rather than quietly computing events no engine can produce. */',
    '.dlv-cam-warn{margin-top:10px;padding:8px 10px;border-radius:6px;font-size:11.5px;line-height:1.45;',
    '  background:rgba(245,166,35,.1);border:1px solid rgba(245,166,35,.4);color:var(--amber, #f5a623);}',
    '.dlv-cam-chart{margin-top:12px;background:var(--bg-soft, #0d0d11);',
    '  border:1px solid var(--card-border, #26262c);border-radius:8px;padding:6px;}',
    '.dlv-cam-svg{display:block;width:100%;height:auto;}',
    '.dlv-cam-grid{stroke:var(--card-border, #26262c);stroke-width:1;}',
    '.dlv-cam-grid.tdc{stroke:var(--text-faint, #5c5c66);stroke-width:1.4;}',
    '.dlv-cam-ax{fill:var(--text-faint, #5c5c66);font-size:9.5px;font-variant-numeric:tabular-nums;}',
    '.dlv-cam-axlab{fill:var(--text-faint, #5c5c66);font-size:9.5px;letter-spacing:.4px;text-transform:uppercase;}',
    '.dlv-cam-curve{fill:none;stroke-width:2;}',
    '.dlv-cam-curve.intake{stroke:var(--red, #d1132e);}',
    '.dlv-cam-curve.exhaust{stroke:#3b82f6;}',
    '.dlv-cam-curve.b{stroke-dasharray:5 3;stroke-width:1.5;opacity:.8;}',
    '.dlv-cam-dot{fill:none;stroke-width:1.6;}',
    '.dlv-cam-dot.intake{stroke:var(--red, #d1132e);}',
    '.dlv-cam-dot.exhaust{stroke:#3b82f6;}',
    '.dlv-cam-dot.b{opacity:.75;}',
    '.dlv-cam-cl{stroke-width:1;stroke-dasharray:2 3;opacity:.5;}',
    '.dlv-cam-cl.intake{stroke:var(--red, #d1132e);}',
    '.dlv-cam-cl.exhaust{stroke:#3b82f6;}',
    '.dlv-cam-legend{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-top:7px;',
    '  font-size:10.5px;color:var(--text-dim, #9a9aa2);}',
    '.dlv-cam-legend span{display:flex;align-items:center;gap:5px;}',
    '.dlv-cam-key{width:16px;height:3px;border-radius:2px;display:inline-block;}',
    '.dlv-cam-key.intake{background:var(--red, #d1132e);}',
    '.dlv-cam-key.exhaust{background:#3b82f6;}',
    '.dlv-cam-key.dash{background:repeating-linear-gradient(90deg,var(--text-dim,#9a9aa2) 0 5px,transparent 5px 8px);}',
    '.dlv-cam-note{color:var(--text-faint, #5c5c66);}',
    '.dlv-cam-table{width:100%;border-collapse:collapse;margin-top:12px;font-size:12px;}',
    '.dlv-cam-table th{text-align:right;font-size:9.5px;font-weight:800;letter-spacing:.8px;',
    '  text-transform:uppercase;color:var(--text-dim, #9a9aa2);padding:4px 8px;',
    '  border-bottom:1px solid var(--card-border, #26262c);}',
    '.dlv-cam-table th:first-child{text-align:left;}',
    '.dlv-cam-table td{padding:4px 8px;border-bottom:1px solid rgba(38,38,44,.5);}',
    '.dlv-cam-table td.num{text-align:right;font-variant-numeric:tabular-nums;font-weight:700;}',
    '.dlv-cam-table td.num.b{color:var(--text-dim, #9a9aa2);}',
    '.dlv-cam-table td.num.d{color:var(--amber, #f5a623);}',
    '.dlv-cam-u{color:var(--text-faint, #5c5c66);font-weight:600;font-size:10px;}',
    '/* Ford publishes valve lift for these engines and nothing else, so where a number came from is part',
    '   of the answer. */',
    '.dlv-cam-prov{margin-top:12px;font-size:11px;line-height:1.5;color:var(--text-faint, #5c5c66);}',
    '.dlv-cam-prov p{margin:0 0 6px;}',
    '.dlv-cam-prov b{color:var(--text-dim, #9a9aa2);}',
    '.dlv-cam-sign{padding-top:6px;border-top:1px solid var(--card-border, #26262c);}',
    '@media (max-width:640px){',
    '  .dlv-cam-ovl{padding:10px 8px;}',
    '  .dlv-cam-body{padding:10px;}',
    '  .dlv-cam-eng select{min-width:0;width:100%;}',
    '}',
    '/* Inline on its own page: the same box, without the pop-up\'s backdrop and positioning. */',
    '.dlv-cam.dlv-cam-inline{width:100%;box-shadow:none;}'
,
    '/* DOCKED (a log is open): no backdrop and pinned to the right, so the graphs stay usable -- the',
    '   whole point of following the log is scrubbing it, and a full-screen pop-up would cover the very',
    '   graphs being scrubbed. Clicks outside pass straight through to the viewer. */',
    '.dlv-cam-ovl.dlv-cam-docked{z-index:950;background:none;pointer-events:none;justify-content:flex-end;',
    '  align-items:stretch;padding:0;overflow:visible;}',
    '.dlv-cam-docked .dlv-cam{pointer-events:auto;width:min(560px,46vw);height:100%;overflow:auto;',
    '  border-radius:0;border-width:0 0 0 1px;box-shadow:none;}',
    '@media (max-width:760px){ .dlv-cam-docked .dlv-cam{width:100vw;} }',
    '.dlv-cam-live{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px;',
    '  padding:8px 10px;border-radius:7px;background:rgba(209,19,46,.08);',
    '  border:1px solid rgba(209,19,46,.35);font-size:11.5px;line-height:1.4;}',
    '.dlv-cam-live label{display:flex;align-items:center;gap:6px;font-weight:800;cursor:pointer;',
    '  color:var(--text, #e8e8ea);}',
    '.dlv-cam-live input{accent-color:var(--red, #d1132e);}',
    '.dlv-cam-live .dlv-cam-livevals{color:var(--text-dim, #9a9aa2);font-variant-numeric:tabular-nums;}',
    '.dlv-cam-live .dlv-cam-livevals b{color:var(--text, #e8e8ea);}',
    '.dlv-cam-live.off{background:none;border-color:var(--card-border, #26262c);}',
    '.dlv-cam-pos input:disabled{opacity:.55;cursor:not-allowed;}',
    '.dlv-cam-fromlog{grid-column:2 / span 2;font-size:9.5px;font-weight:700;letter-spacing:.3px;',
    '  text-transform:uppercase;color:var(--red, #d1132e);}'
  ].join('\n');
  function ensureStyle() {
    if (document.getElementById('dlv-cam-style')) return;
    var st = document.createElement('style');
    st.id = 'dlv-cam-style';
    st.textContent = PANEL_CSS;
    document.head.appendChild(st);
  }

  // `root` is whatever element holds .dlv-cam-body: the pop-up's backdrop, or a page's container.
  // `modal` says which, so closing knows whether to remove an overlay or just empty a container.
  var state = null;

  function close() {
    var cb = state && state.onClose;
    if (state && state.modal && state.root && state.root.parentNode) state.root.parentNode.removeChild(state.root);
    if (state && !state.modal && state.root) state.root.innerHTML = '';
    document.removeEventListener('keydown', onKey);
    global.removeEventListener('pointerup', onRelease, true);
    state = null;
    if (cb) { try { cb(); } catch (e) {} }   // the viewer stops pushing cursor values
  }
  function onKey(e) { if (e.key === 'Escape' && state && state.modal) close(); }
  function onRelease() { if (state) state.dragging = false; }

  // ---- the diagram ------------------------------------------------------------------------------
  //
  // One hump per valve, drawn as a cubic through the five points. The curve is cosmetic — the five
  // points are the data and they are all that datalog-cam.js claims to know — so the control points
  // are placed to give a plausible ramp rather than to assert a profile. Marking the checking-height
  // points makes it obvious which part of the curve is measured and which is drawn.
  function humpPath(side, x, y) {
    var p = [];
    var midUp = (side.open + side.peak) / 2, midDn = (side.peak + side.close) / 2;
    p.push('M' + x(side.seatOpen) + ' ' + y(0));
    p.push('C' + x(side.seatOpen + (side.open - side.seatOpen) * 0.6) + ' ' + y(0) + ' ' +
                 x(side.open) + ' ' + y(0.02) + ' ' + x(side.open) + ' ' + y(0.05));
    p.push('C' + x(midUp) + ' ' + y(0.55) + ' ' + x(midUp) + ' ' + y(0.95) + ' ' + x(side.peak) + ' ' + y(1));
    p.push('C' + x(midDn) + ' ' + y(0.95) + ' ' + x(midDn) + ' ' + y(0.55) + ' ' + x(side.close) + ' ' + y(0.05));
    p.push('C' + x(side.close) + ' ' + y(0.02) + ' ' +
                 x(side.seatClose - (side.seatClose - side.close) * 0.6) + ' ' + y(0) + ' ' +
                 x(side.seatClose) + ' ' + y(0));
    return p.join(' ');
  }

  function diagramSvg(profiles) {
    var W = 920, H = 290, L = 46, R = 14, T = 16, B = 34;
    var xs = [], peak = 0;
    profiles.forEach(function (pr) {
      if (!pr) return;
      ['intake', 'exhaust'].forEach(function (k) {
        xs.push(pr[k].seatOpen, pr[k].seatClose);
        if (typeof pr[k].peakLift === 'number' && pr[k].peakLift > peak) peak = pr[k].peakLift;
      });
    });
    if (!xs.length) return '';
    var lo = Math.floor((Math.min.apply(null, xs) - 10) / 20) * 20;
    var hi = Math.ceil((Math.max.apply(null, xs) + 10) / 20) * 20;
    // With no published lobe lift there is no scale to draw, so the humps are normalised and the axis
    // says as much rather than implying inches nobody measured.
    var haveLift = peak > 0;
    var top = haveLift ? Math.ceil(peak * 20) / 20 : 1;
    var x = function (d) { return L + ((d - lo) / (hi - lo)) * (W - L - R); };
    var y = function (frac) { return T + (1 - frac) * (H - T - B); };
    var yLift = function (v) { return y(top ? v / top : 0); };

    var g = [];
    // vertical gridlines every 60 crank degrees, with TDC called out
    for (var d = lo; d <= hi; d += 60) {
      var isTdc = (d === 0);
      g.push('<line class="dlv-cam-grid' + (isTdc ? ' tdc' : '') + '" x1="' + x(d) + '" y1="' + T +
        '" x2="' + x(d) + '" y2="' + y(0) + '"/>');
      g.push('<text class="dlv-cam-ax" x="' + x(d) + '" y="' + (H - 12) + '" text-anchor="middle">' +
        (isTdc ? 'TDC' : d) + '</text>');
    }
    // horizontal lift gridlines
    var steps = haveLift ? 4 : 2;
    for (var i = 0; i <= steps; i++) {
      var f = i / steps;
      g.push('<line class="dlv-cam-grid" x1="' + L + '" y1="' + y(f) + '" x2="' + (W - R) + '" y2="' + y(f) + '"/>');
      g.push('<text class="dlv-cam-ax" x="' + (L - 6) + '" y="' + (y(f) + 3) + '" text-anchor="end">' +
        (haveLift ? (top * f).toFixed(3) : (f === 1 ? 'max' : f === 0 ? '0' : '')) + '</text>');
    }
    g.push('<text class="dlv-cam-axlab" x="' + (W / 2) + '" y="' + (H - 1) + '" text-anchor="middle">' +
      'crank degrees from TDC overlap</text>');

    profiles.forEach(function (pr, idx) {
      if (!pr) return;
      var cls = idx === 0 ? 'a' : 'b';
      ['exhaust', 'intake'].forEach(function (k) {
        var s = pr[k];
        var yy = (typeof s.peakLift === 'number') ? function (f) { return yLift(s.peakLift * f); } : y;
        g.push('<path class="dlv-cam-curve ' + cls + ' ' + k + '" d="' + humpPath(s, x, yy) + '"/>');
        // the two points that are actually measured
        [s.open, s.close].forEach(function (pt) {
          g.push('<circle class="dlv-cam-dot ' + cls + ' ' + k + '" cx="' + x(pt) + '" cy="' + yy(0.05) + '" r="2.6"/>');
        });
        g.push('<line class="dlv-cam-cl ' + cls + ' ' + k + '" x1="' + x(s.peak) + '" y1="' + yy(1) +
          '" x2="' + x(s.peak) + '" y2="' + y(0) + '"/>');
      });
    });
    return '<svg class="dlv-cam-svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet" ' +
      'role="img" aria-label="Valve lift against crank angle">' + g.join('') + '</svg>';
  }

  // ---- the numbers --------------------------------------------------------------------------------
  var ROWS = [
    { k: 'ivo', label: 'IVO', unit: '° BTDC' },
    { k: 'ivc', label: 'IVC', unit: '° ABDC' },
    { k: 'evo', label: 'EVO', unit: '° BBDC' },
    { k: 'evc', label: 'EVC', unit: '° ATDC' },
    { k: 'intakeDuration', label: 'Intake duration', unit: '°' },
    { k: 'exhaustDuration', label: 'Exhaust duration', unit: '°' },
    { k: 'icl', label: 'Intake centreline', unit: '° ATDC' },
    { k: 'ecl', label: 'Exhaust centreline', unit: '° BTDC' },
    { k: 'overlap', label: 'Overlap', unit: '°' },
    { k: 'separation', label: 'Installed separation', unit: '°' },
  ];

  function tableHtml(a, b) {
    var head = '<tr><th>Event</th><th>A</th>' + (b ? '<th>B</th><th>Δ</th>' : '') + '</tr>';
    var body = ROWS.map(function (r) {
      return '<tr><td>' + esc(r.label) + ' <span class="dlv-cam-u">' + r.unit + '</span></td>' +
        '<td class="num">' + fmt(a ? a[r.k] : null) + '</td>' +
        (b ? '<td class="num b">' + fmt(b[r.k]) + '</td><td class="num d">' + delta(a[r.k], b[r.k]) + '</td>' : '') +
        '</tr>';
    }).join('');
    return '<table class="dlv-cam-table"><thead>' + head + '</thead><tbody>' + body + '</tbody></table>';
  }

  // ---- one cam's controls ---------------------------------------------------------------------------
  function camColumnHtml(slot, engineId, sel, ip, ep, fromLog) {
    var K = cam();
    // Grouped, so the aftermarket grinds read as a list of their own rather than hiding under the
    // stock cam (Ken, 2026-10-29: "need to be able to select aftermarket cams if they are in the
    // list"), and the last entry is always the user's own card, for the cams nobody publishes.
    var opt = function (id, label) {
      return '<option value="' + esc(id) + '"' + (id === sel ? ' selected' : '') + '>' + esc(label) + '</option>';
    };
    var list = K.camsFor(engineId);
    var factory = list.filter(function (x) { return x.cam.stock; });
    var after = list.filter(function (x) { return !x.cam.stock; });
    var opts =
      '<optgroup label="Factory">' + factory.map(function (x) { return opt(x.id, x.cam.label); }).join('') + '</optgroup>' +
      '<optgroup label="Aftermarket">' + (after.length
        ? after.map(function (x) { return opt(x.id, x.cam.label + (x.cam.card ? ' (needs card ICL)' : '')); }).join('')
        : '<option disabled>none published with timing data yet</option>') + '</optgroup>' +
      '<optgroup label="Other">' + opt(CUSTOM_ID, 'Your own cam card…') + '</optgroup>';
    var e = K.ENGINES[engineId] || { intake: { min: -50, max: 50 }, exhaust: { min: -50, max: 50 } };
    // A position driven by the log is shown but not editable: typing into it would be overwritten
    // on the next cursor move, which reads as the box fighting you. The number box shows the RAW
    // logged value even beyond the slider's travel, because a value outside it is the evidence of a
    // mis-scaled channel and clamping it would hide exactly that.
    function pos(which, v, lim) {
      var live = !!(fromLog && fromLog[which.toLowerCase()]);
      var dis = live ? ' disabled' : '';
      var shown = (typeof v === 'number' && isFinite(v)) ? (Math.round(v * 10) / 10) : 0;
      return '<label class="dlv-cam-pos"><span>' + which + '</span>' +
        '<input type="range" data-slot="' + slot + '" data-pos="' + which.toLowerCase() + '" ' +
          'min="' + lim.min + '" max="' + lim.max + '" step="0.5" value="' + shown + '"' + dis + '>' +
        '<input type="number" class="dlv-cam-num" data-slot="' + slot + '" data-pos="' + which.toLowerCase() + '" ' +
          'min="' + lim.min + '" max="' + lim.max + '" step="0.5" value="' + shown + '"' + dis + '>' +
        (live ? '<span class="dlv-cam-fromlog">from the log</span>'
              : '<em>' + lim.min + '° to +' + lim.max + '°</em>') + '</label>';
    }
    return '<div class="dlv-cam-col' + (slot === 'b' ? ' is-b' : '') + '" data-slot="' + slot + '">' +
      '<div class="dlv-cam-colhead"><span class="dlv-cam-swatch ' + slot + '"></span>' +
        (slot === 'a' ? 'Camshaft A' : 'Camshaft B') +
        (slot === 'b' ? '<button type="button" class="dlv-cam-clearb" title="Stop comparing">&times;</button>' : '') +
      '</div>' +
      '<select class="dlv-cam-sel" data-slot="' + slot + '">' +
        (slot === 'b' ? '<option value="">— none —</option>' : '') + opts + '</select>' +
      cardInputsHtml(slot, sel) +
      pos('Intake', ip, e.intake) + pos('Exhaust', ep, e.exhaust) +
      '</div>';
  }

  // The numbers a cam needs from its card, under its picker: one (the intake centreline) for a
  // published grind whose centreline nobody prints, four for "your own cam card".
  function cardInputsHtml(slot, id) {
    if (!id) return '';
    var c = camById(id);
    if (!c) return '';
    var box = function (k, label, v, min, max) {
      return '<label><span>' + label + '</span><input type="number" class="dlv-cam-num dlv-cam-card" data-slot="' +
        slot + '" data-k="' + k + '" min="' + min + '" max="' + max + '" step="0.5" value="' + v + '"></label>';
    };
    if (c.custom) {
      var v = c.custom;
      return '<div class="dlv-cam-cardin">' +
        box('durI', 'Int dur @.050', v.durI, 150, 320) + box('durE', 'Exh dur @.050', v.durE, 150, 320) +
        box('icl', 'Int CL at park', v.icl, 60, 180) + box('ecl', 'Exh CL at park', v.ecl, 60, 180) +
        '<em>Off the cam card: durations at .050" and both centrelines with the phasers parked.</em></div>';
    }
    if (c.card) {
      return '<div class="dlv-cam-cardin">' +
        box('icl', 'Int CL at park', c.cardIcl, 60, 180) +
        '<label><span>Exh CL (from LSA ' + c.card.lsa + ')</span><b>' + (2 * c.card.lsa - c.cardIcl).toFixed(1) + '</b></label>' +
        '<em>' + (c.cardIclAssumed
          ? 'ASSUMED — Comp prints no centreline for this cam. Type the intake centreline from your cam card.'
          : 'From your cam card.') + '</em></div>';
    }
    return '';
  }

  var CUSTOM_ID = 'custom';
  // A cam ready to draw, by id, with the user's card numbers applied.
  function camById(id) {
    var K = cam();
    if (!id) return null;
    if (id === CUSTOM_ID) return K.customCam(state.engine, (state.custom || {})[state.engine]);
    var c = K.CAMS[id];
    return c ? K.resolveCam(c, (state.icl || {})[id]) : null;
  }

  function bodyHtml() {
    var K = cam();
    var s = state;
    var engOpts = Object.keys(K.ENGINES).map(function (k) {
      return '<option value="' + esc(k) + '"' + (k === s.engine ? ' selected' : '') + '>' +
        esc(K.ENGINES[k].label) + '</option>';
    }).join('');
    var camA = camById(s.a), camB = s.b ? camById(s.b) : null;
    var profA = camA ? K.liftProfile(camA, s.ipA, s.epA, s.ratio) : null;
    var profB = camB ? K.liftProfile(camB, s.ipB, s.epB, s.ratio) : null;
    var evA = profA ? profA.events : null, evB = profB ? profB.events : null;
    if (evA) evA.separation = K.separation(evA);
    if (evB) evB.separation = K.separation(evB);

    var warn = [].concat(
      K.checkPosition(s.engine, s.ipA, s.epA).warnings.map(function (w) { return 'A: ' + w; }),
      camB ? K.checkPosition(s.engine, s.ipB, s.epB).warnings.map(function (w) { return 'B: ' + w; }) : []
    );
    // A cam quoted at one checking height compared with one quoted at another is not a comparison,
    // and the difference is 20-26 crank degrees of silent error, so it is called out rather than
    // blocked -- the user may well know exactly what they are doing.
    if (camA && camB && camA.height !== camB.height) {
      warn.push('A is quoted at ' + camA.height + ' and B at ' + camB.height +
        ' — the two are not directly comparable');
    }
    [['A', camA], ['B', camB]].forEach(function (p) {
      if (p[1] && p[1].cardIclAssumed) {
        warn.push(p[0] + ': ' + p[1].label + ' is drawn at an ASSUMED intake centreline of ' + p[1].cardIcl.toFixed(1) +
          '° — enter the one on your cam card');
      }
    });

    return '<div class="dlv-cam-top">' +
        '<label class="dlv-cam-eng"><span>Engine</span><select class="dlv-cam-engsel">' + engOpts + '</select></label>' +
        '<label class="dlv-cam-ratio"><span>Follower ratio</span>' +
          '<input type="number" class="dlv-cam-num" id="dlvCamRatio" min="1.5" max="2.5" step="0.001" value="' + s.ratio + '">' +
        '</label>' +
        '<div class="dlv-cam-engnote">' +
          (s.engineWhy ? '<b class="dlv-cam-engwhy">' + esc(s.engineWhy) + '</b> ' : '') +
          esc((K.ENGINES[s.engine] || {}).source || '') + '</div>' +
      '</div>' +
      liveBarHtml() +
      '<div class="dlv-cam-cols">' + camColumnHtml('a', s.engine, s.a, s.ipA, s.epA, followingWhat()) +
        camColumnHtml('b', s.engine, s.b, s.ipB, s.epB) + '</div>' +
      (warn.length ? '<div class="dlv-cam-warn">' + warn.map(esc).join('<br>') + '</div>' : '') +
      '<div class="dlv-cam-chart">' + diagramSvg([profA, profB]) + '</div>' +
      '<div class="dlv-cam-legend">' +
        '<span><i class="dlv-cam-key intake"></i>intake</span>' +
        '<span><i class="dlv-cam-key exhaust"></i>exhaust</span>' +
        '<span><i class="dlv-cam-key dash"></i>camshaft B</span>' +
        '<span class="dlv-cam-note">dots mark the measured opening and closing; the curve between them is drawn, not measured</span>' +
      '</div>' +
      tableHtml(evA, evB) +
      '<div class="dlv-cam-prov">' +
        (camA ? '<p><b>A — ' + esc(camA.label) + '</b> (events at ' + esc(camA.height) + '). ' + esc(camA.provenance) + '</p>' : '') +
        (camB ? '<p><b>B — ' + esc(camB.label) + '</b> (events at ' + esc(camB.height) + '). ' + esc(camB.provenance) + '</p>' : '') +
        '<p class="dlv-cam-sign">Positions are crank degrees from park, <b>positive retards</b> — Ford’s own ' +
          'convention. A cam card that writes advance as positive, or a controller whose table is zeroed at a ' +
          'travel limit rather than at park, has to be converted before its numbers are typed in here.</p>' +
      '</div>';
  }

  // ---- following a log --------------------------------------------------------------------------
  //
  // Ken, 2026-10-29: "it will be nice to also have it for logs. so as you move through the log it will
  // update it". The viewer finds the cam-position channels and pushes their values at the cursor in
  // through updateLive(); while following, camshaft A's two positions ARE those values. Only A follows:
  // B is the what-if, and the useful question is how a different grind would sit at the phaser
  // positions this car is actually running.
  function followingWhat() {
    var L = state && state.live;
    if (!L || !L.follow) return null;
    return { intake: !!L.intakeCh, exhaust: !!L.exhaustCh };
  }
  function liveBarHtml() {
    var L = state && state.live;
    if (!L) return '';
    var parts = [];
    var deg = function (v) { return (typeof v === 'number' && isFinite(v)) ? ((v > 0 ? '+' : '') + v.toFixed(1) + '\u00b0') : '\u2014'; };
    if (L.intakeCh) parts.push(esc(L.intakeCh) + ' <b>' + deg(L.vi) + '</b>');
    else parts.push('no intake cam channel \u2014 intake held at park');
    if (L.exhaustCh) parts.push(esc(L.exhaustCh) + ' <b>' + deg(L.ve) + '</b>');
    else parts.push('no exhaust cam channel \u2014 exhaust held at park');
    if (typeof L.rpm === 'number' && isFinite(L.rpm)) parts.push('<b>' + Math.round(L.rpm).toLocaleString() + '</b> rpm');
    if (typeof L.time === 'number' && isFinite(L.time)) parts.push('<b>' + L.time.toFixed(2) + '</b> s');
    return '<div class="dlv-cam-live' + (L.follow ? '' : ' off') + '">' +
      '<label><input type="checkbox" id="dlvCamFollow"' + (L.follow ? ' checked' : '') + '> Follow the log</label>' +
      '<span class="dlv-cam-livevals">' + parts.join(' &middot; ') + '</span></div>';
  }

  // A mouse reports hundreds of positions a second and the viewer already coalesces its own cursor
  // work into one frame; the panel rebuilds a lot of markup, so it coalesces too, and skips the
  // rebuild entirely when nothing it shows has changed at the precision it shows it.
  var liveRaf = null;
  function updateLive(v) {
    var L = state && state.live;
    if (!L || !v) return;
    var r1 = function (x) { return (typeof x === 'number' && isFinite(x)) ? Math.round(x * 10) / 10 : null; };
    var vi = r1(v.intake), ve = r1(v.exhaust), rpm = (typeof v.rpm === 'number' && isFinite(v.rpm)) ? Math.round(v.rpm) : null;
    var t = (typeof v.time === 'number' && isFinite(v.time)) ? Math.round(v.time * 100) / 100 : null;
    if (vi === L.vi && ve === L.ve && rpm === L.rpm && t === L.time) return;
    L.vi = vi; L.ve = ve; L.rpm = rpm; L.time = t;
    if (L.follow) {
      state.ipA = (L.intakeCh && vi !== null) ? vi : 0;
      state.epA = (L.exhaustCh && ve !== null) ? ve : 0;
    }
    if (liveRaf !== null) return;
    var raf = global.requestAnimationFrame || function (f) { return setTimeout(f, 16); };
    var tick = function () {
      // Never rebuild while a slider is held: the values keep landing in state, and the repaint just
      // waits for the release.
      if (state && state.dragging) { liveRaf = raf(tick); return; }
      liveRaf = null;
      render();
    };
    liveRaf = raf(tick);
  }
  function isLive() { return !!(state && state.live); }

  function render() {
    if (!state) return;
    var body = state.root.querySelector('.dlv-cam-body');
    if (!body) return;
    body.innerHTML = bodyHtml();
    wireBody();
  }

  function wireBody() {
    var ovl = state.root;
    var follow = ovl.querySelector('#dlvCamFollow');
    if (follow) follow.addEventListener('change', function () {
      var L = state.live;
      L.follow = follow.checked;
      // Turning following back on snaps A to the cursor; turning it off leaves A where the log had it,
      // so you can then nudge from a real operating point rather than from park.
      if (L.follow) {
        state.ipA = (L.intakeCh && L.vi !== null) ? L.vi : 0;
        state.epA = (L.exhaustCh && L.ve !== null) ? L.ve : 0;
      }
      render();
    });
    var eng = ovl.querySelector('.dlv-cam-engsel');
    if (eng) eng.addEventListener('change', function () {
      var K = cam();
      state.engine = eng.value;
      state.engineWhy = '';   // a hand pick overrides what the log said
      try { if (global.localStorage) global.localStorage.setItem(ENGINE_KEY, state.engine); } catch (e) {}
      // Switching engine changes which cams exist and how far the phasers go, so the selection and
      // the positions are re-seeded rather than carried across into something impossible.
      var list = K.camsFor(state.engine);
      state.a = (K.ENGINES[state.engine] || {}).stockCam || (list[0] && list[0].id);
      state.b = '';
      state.ipA = state.epA = state.ipB = state.epB = 0;
      render();
    });
    var ratio = ovl.querySelector('#dlvCamRatio');
    if (ratio) ratio.addEventListener('change', function () {
      var v = parseFloat(ratio.value);
      if (isFinite(v) && v > 0) { state.ratio = v; render(); }
    });
    ovl.querySelectorAll('.dlv-cam-sel').forEach(function (sel) {
      sel.addEventListener('change', function () {
        var slot = sel.getAttribute('data-slot');
        if (slot === 'a') state.a = sel.value; else state.b = sel.value;
        render();
      });
    });
    // A card number edits the cam for both slots (it is a property of the grind, not of A or B), and
    // is remembered on this browser, so a card typed in once is there next time.
    ovl.querySelectorAll('input.dlv-cam-card').forEach(function (el) {
      el.addEventListener('change', function () {
        var v = parseFloat(el.value);
        if (!isFinite(v)) return;
        var id = el.getAttribute('data-slot') === 'a' ? state.a : state.b;
        var k = el.getAttribute('data-k');
        if (id === CUSTOM_ID) {
          state.custom = state.custom || {};
          var c = Object.assign({}, cam().customCam(state.engine, state.custom[state.engine]).custom);
          c[k] = v;
          state.custom[state.engine] = c;
          saveJson(CUSTOM_KEY, state.custom);
        } else if (k === 'icl') {
          state.icl = state.icl || {};
          state.icl[id] = v;
          saveJson(ICL_KEY, state.icl);
        }
        render();
      });
    });
    var clearB = ovl.querySelector('.dlv-cam-clearb');
    if (clearB) clearB.addEventListener('click', function () { state.b = ''; render(); });
    // The slider and the number box edit the same value.
    //
    // WHILE DRAGGING, ONLY THE NUMBER MOVES. The first version repainted on every 'input' event, and a
    // repaint rebuilds this whole body -- the slider included -- so the control under the pointer was
    // replaced after the first step and the drag died, leaving the thumb moving a notch at a time
    // (Ken, 2026-10-29: "you can only move them in very small increments ... when you click on a slider
    // you should be able to move it the entire way with just the number updating, then when you let go
    // it redoes the graph"). So 'input' only mirrors the value into its number box, and the commit and
    // repaint happen on 'change', which a range fires once, on release.
    function commit(el) {
      var K = cam();
      var slot = el.getAttribute('data-slot'), which = el.getAttribute('data-pos');
      var v = parseFloat(el.value);
      if (!isFinite(v)) return;
      v = K.clampPosition(state.engine, which, v);
      var key = (which === 'intake' ? 'ip' : 'ep') + slot.toUpperCase();
      state[key] = v;
      state.dragging = false;
      render();
    }
    ovl.querySelectorAll('input[type=range][data-pos]').forEach(function (el) {
      var twin = function () {
        return ovl.querySelector('input.dlv-cam-num[data-slot="' + el.getAttribute('data-slot') +
          '"][data-pos="' + el.getAttribute('data-pos') + '"]');
      };
      // A drag in progress also holds off a repaint from the log, which would rebuild the slider out
      // from under the pointer exactly the way the old per-step repaint did.
      el.addEventListener('pointerdown', function () { state.dragging = true; });
      el.addEventListener('input', function () { var n = twin(); if (n) n.value = el.value; });
      el.addEventListener('change', function () { commit(el); });
    });
    ovl.querySelectorAll('input.dlv-cam-num[data-pos]').forEach(function (el) {
      el.addEventListener('change', function () { commit(el); });
    });
  }

  var ENGINE_KEY = 'pbdDlvCamEngine.v1';
  var ICL_KEY = 'pbdDlvCamCardIcl.v1';      // { camId: intake centreline typed off its card }
  var CUSTOM_KEY = 'pbdDlvCamCustom.v1';    // { engineId: { durI, durE, icl, ecl } }
  function loadJson(key) {
    try {
      var v = global.localStorage ? JSON.parse(global.localStorage.getItem(key) || 'null') : null;
      return (v && typeof v === 'object') ? v : {};
    } catch (e) { return {}; }
  }
  function saveJson(key, v) {
    try { if (global.localStorage) global.localStorage.setItem(key, JSON.stringify(v)); } catch (e) {}
  }
  function rememberedEngine() {
    try { return global.localStorage ? global.localStorage.getItem(ENGINE_KEY) : null; } catch (e) { return null; }
  }
  function freshState(opts, root, modal) {
    var K = cam();
    var want = (opts && opts.engine) || rememberedEngine();
    var engine = (want && K.ENGINES[want]) ? want : 'coyote-gen1';
    var live = (opts && opts.live && (opts.live.intake || opts.live.exhaust)) ? {
      intakeCh: opts.live.intake || null, exhaustCh: opts.live.exhaust || null,
      follow: true, vi: null, ve: null, rpm: null, time: null,
    } : null;
    return {
      engine: engine,
      // Said on screen when the engine came from the log rather than from the last pick, so a wrong
      // guess is visible -- and only when the host's pick was actually used.
      engineWhy: (opts && opts.engine === engine && opts.engineWhy) ? String(opts.engineWhy) : '',
      icl: loadJson(ICL_KEY),
      custom: loadJson(CUSTOM_KEY),
      a: K.ENGINES[engine].stockCam,
      b: '',
      ipA: 0, epA: 0, ipB: 0, epB: 0,
      ratio: K.FOLLOWER_RATIO,
      root: root,
      modal: modal,
      live: live,
      onClose: (opts && typeof opts.onClose === 'function') ? opts.onClose : null,
    };
  }
  function shellHtml(modal) {
    return '<div class="dlv-cam' + (modal ? '' : ' dlv-cam-inline') + '"' +
      (modal ? ' role="dialog" aria-label="Cam timing"' : '') + '>' +
      '<div class="dlv-cam-head"><div class="dlv-cam-title">' +
        '<span class="dlv-cam-kicker">Ti-VCT</span><b>Cam Timing</b></div>' +
        (modal ? '<button type="button" class="dlv-cam-x" title="Close">&times;</button>' : '') +
      '</div><div class="dlv-cam-body"></div></div>';
  }

  /**
   * Open the panel as a pop-up over the page (the viewer's Analyze menu). `opts.docked` pins it to the
   * right with no backdrop, for following a log; `opts.live` names the cam channels it follows.
   */
  function open(opts) {
    var K = cam();
    if (!K) { if (global.showToast) global.showToast('Cam timing is not available on this page.'); return; }
    close();
    ensureStyle();
    var docked = !!(opts && opts.docked);
    var ovl = document.createElement('div');
    ovl.className = 'dlv-cam-ovl' + (docked ? ' dlv-cam-docked' : '');
    if (docked && typeof opts.top === 'number' && opts.top > 0) ovl.style.top = opts.top + 'px';
    ovl.innerHTML = shellHtml(true);
    document.body.appendChild(ovl);
    state = freshState(opts, ovl, true);
    // Docked, the backdrop takes no clicks at all, so clicking the graph scrubs the log rather than
    // closing the panel you are scrubbing it for.
    if (!docked) ovl.addEventListener('click', function (e) { if (e.target === ovl) close(); });
    ovl.querySelector('.dlv-cam-x').addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    global.addEventListener('pointerup', onRelease, true);
    render();
  }

  /**
   * Render the panel INTO a page element, as the page itself rather than a pop-up over it. This is the
   * no-log path: alldatalogs.com/cam-timing calls it directly, and never loads the viewer at all
   * (Ken, 2026-10-29: "I don't want this to require a log to look at"). One panel at a time, so mounting
   * replaces whatever was showing, pop-up or inline.
   */
  function mount(container, opts) {
    var K = cam();
    if (!K || !container) return false;
    close();
    ensureStyle();
    container.innerHTML = shellHtml(false);
    state = freshState(opts, container, false);
    global.addEventListener('pointerup', onRelease, true);
    render();
    return true;
  }

  global.DatalogCamUI = { open: open, mount: mount, close: close, updateLive: updateLive, isLive: isLive,
    VERSION: 'cam-ui@1.3.0' };
})(typeof globalThis !== 'undefined' ? globalThis : this);
