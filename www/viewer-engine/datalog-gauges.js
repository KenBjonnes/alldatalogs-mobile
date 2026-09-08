'use strict';
/*
 * datalog-gauges.js -- Gauge rendering primitives for the PBD Control Center datalog viewer.
 *
 * This is the "normalized gauge binding layer": every function here takes a gauge definition (see
 * buildCoreGaugeDefs in datalog-presets.js) plus a raw numeric value already resolved from the
 * shared cursor index -- it never does its own nearest-point search or touches VIEWER_DATA
 * directly. datalog-viewer.js resolves the cursor's row index once per update and hands every
 * gauge the same resolved values, so scrubbing performance doesn't degrade as more gauges are on
 * screen. No SVG/DOM library dependency -- everything is built with plain SVG elements and CSS.
 *
 * 2026-07-21 rewrite (prototyped in dev/gauge-lab.html, see docs/redesign-requirements.md):
 *   - Real gauge anatomy. The old dials drew only a bare circle + a straight line needle, which is
 *     why they looked unfinished. Dials now draw a ring groove, a coloured bezel, graduated major
 *     and minor ticks, numeric scale labels, an optional scale note ("x 1000 rpm"), a tapered
 *     needle with a two-tone hub, and a digital readout.
 *   - Warning zones + colour coding. A gauge can carry `zones` (or `thresholds` for a draggable
 *     warn/redline pair); the needle and readout recolour green -> amber -> red as the value
 *     crosses into a zone.
 *   - User warnings, which are deliberately a SEPARATE visual channel from the zone colours: a
 *     tripped rule tints the whole gauge tile and shows a badge, leaving the needle/readout colours
 *     alone so a user warning still reads on a gauge whose colours already mean something else.
 *   - renderGaugeFascia(): the fixed V8/V6 layout matching the approved mockup (8cyl.png), keyed
 *     off each def's `group`. renderGaugeGrid() is kept as a generic fallback.
 *
 * BUGFIX in this rewrite: createGaugeElement() used to return the outer wrapper while _pbdRefs was
 * stashed on the inner box, so updateGaugeElement()'s `wrap._pbdRefs` lookup was always undefined
 * and every gauge silently never updated. Refs now live on the element that is actually returned.
 * (Not previously visible because Gauge View ships disabled.)
 *
 * Only the needle rotation and the readout text change per cursor move -- all the static art
 * (ticks, labels, zone arcs) is built once -- so rich gauges cost nothing while scrubbing.
 */

var GAUGE_NS = 'http://www.w3.org/2000/svg';

// Dial sweep: 270 degrees with the gap at the bottom. Angles are "0 = straight up, clockwise
// positive", so min sits at 7:30 and max at 4:30.
var GAUGE_A0 = -135, GAUGE_A1 = 135, GAUGE_SWEEP = GAUGE_A1 - GAUGE_A0;

// Compact-dial rim marker geometry, in viewBox units (so it scales with the dial automatically).
// The ring sits at r88; ticks occupy r73..r84. The line spans r68..r99 so it crosses the ENTIRE
// tick band -- that crossing is what makes the reading precise. r99 is the outer limit that still
// fits inside the 200-unit viewBox at every angle of the sweep, so nothing gets clipped.
var GAUGE_MARK_RING = 88, GAUGE_MARK_R = 10, GAUGE_MARK_STROKE = 3;
var GAUGE_MARK_IN = 68, GAUGE_MARK_OUT = 99, GAUGE_MARK_LINE_W = 2;

function clampGauge(v, min, max){
  if(v < min) return min;
  if(v > max) return max;
  return v;
}
function fmtGaugeValue(v, decimals){
  if(v == null || !isFinite(v)) return 'N/A';
  return v.toFixed(decimals == null ? 1 : decimals);
}
function gaugeFontScale(def){ return def.fontScale || 1; }

// Tick label: divided by def.tickDivisor when set, so a tach can read 0..10 with a "x 1000" note
// instead of 0..10000 crowding the dial.
function fmtGaugeTick(v, def){
  var d = def.tickDivisor || 1;
  var x = v / d;
  return (Math.abs(x) >= 100 ? x.toFixed(0) : (Math.abs(x % 1) < 0.001 ? x.toFixed(0) : x.toFixed(1)));
}

// ---- Snapping ---------------------------------------------------------------------------------
// Dragged/edited values snap to a step so a range always lands on clean numbers. The step is
// per-gauge because "clean" depends on the signal: RPM wants 100, but lambda (which lives around
// 1.0) wants 0.1. def.snap sets it explicitly; otherwise a 1/2/5-style "nice" step is derived from
// the range so a new gauge behaves sensibly with no config at all.
function gaugeNiceStep(span){
  if(!(span > 0)) return 0;
  var raw = span / 100;
  var mag = Math.pow(10, Math.floor(Math.log10(raw)));
  var norm = raw / mag;
  var s = norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10;
  return s * mag;
}
function gaugeSnapStep(def){ return def.snap != null ? def.snap : gaugeNiceStep(def.max - def.min); }
function gaugeSnapValue(def, v){
  var s = gaugeSnapStep(def);
  if(!s || !isFinite(s)) return v;
  var r = Math.round(v / s) * s;
  var dec = Math.max(0, Math.ceil(-Math.log10(s)));   // kill float fuzz (0.30000000004 -> 0.3)
  return parseFloat(r.toFixed(dec));
}

// ---- Zones (gauge colour coding) --------------------------------------------------------------
// Either an explicit def.zones=[{from,to,color}] or, for a gauge with a draggable redline,
// def.thresholds={warn,red} which is expanded here so the bands can be edited live.
function gaugeZones(def){
  if(def.thresholds){
    var t = def.thresholds;
    return [
      { from: t.warn, to: t.red, color: '#f5a623', kind: 'warn' },
      { from: t.red, to: def.max, color: '#d1132e', kind: 'red' },
    ];
  }
  return def.zones || [];
}
// Where a bar's fill grows FROM. Default keeps the old behaviour (zero if the range crosses it,
// otherwise the bottom), but a gauge can name its own resting value -- lambda rests at 1.0, so at
// stoich the bar shows nothing and any fill is a direct read of "how far off, and which way".
// A 0.2-1.2 lambda bar sat ~70% full at all times and every bank looked identical (Ken, 2026-07-21).
function gaugeAnchor(def){
  if(def.anchor != null) return def.anchor;
  return (def.min < 0 && def.max > 0) ? 0 : def.min;
}

// Warning thresholds as shaded bands, so a bar shows how close it is to a limit without anyone
// reading the number. Derived from the USER's warn rules (def.warnings), which is the half that was
// invisible on bars -- gaugeZones() below only covers built-in thresholds, which bars don't define.
function gaugeWarnBands(def){
  var w = def.warnings;
  if(!w) return [];
  var out = [];
  var AMBER = 'rgba(245,166,35,0.16)', RED = 'rgba(209,19,46,0.20)';
  if(w.above != null) out.push({ from: w.above, to: (w.critAbove != null ? w.critAbove : def.max), color: AMBER });
  if(w.critAbove != null) out.push({ from: w.critAbove, to: def.max, color: RED });
  if(w.below != null) out.push({ from: (w.critBelow != null ? w.critBelow : def.min), to: w.below, color: AMBER });
  if(w.critBelow != null) out.push({ from: def.min, to: w.critBelow, color: RED });
  return out.filter(function(b){ return b.to > b.from; });
}

// The colour of the zone containing the value, else the gauge's normal accent. Drives the needle
// and the digital readout, so the value visibly "pops" as it crosses a threshold.
function gaugeActiveColor(def, v){
  if(v == null || !isFinite(v)) return def.color;
  var zs = gaugeZones(def);
  for(var i = 0; i < zs.length; i++){
    if(v >= zs[i].from && v <= zs[i].to) return zs[i].color;
  }
  return def.color;
}

// Warning-light colour by value: green normally, amber past the warn threshold, red past red.
// Uses the same def.thresholds {warn, red} as a dial's redline, so one config drives both. Missing
// value or no thresholds -> unlit grey.
function lightColor(def, v){
  if(v == null || !isFinite(v)) return null;
  var t = def.thresholds || {};
  if(t.red != null && v >= t.red) return '#d1132e';
  if(t.warn != null && v >= t.warn) return '#f5a623';
  return '#22c55e';
}

// ---- User warnings ----------------------------------------------------------------------------
// Per-parameter alert rules (set via right-click in the viewer). Independent of zone colours: a
// trip tints the tile + shows a badge rather than recolouring the needle, so the rule still reads
// on a gauge whose colours already mean something. Same model works for any parameter.
// def.warnings = { above, below, critAbove, critBelow }  (any may be null)
function gaugeWarnState(def, v){
  var w = def.warnings;
  if(!w || v == null || !isFinite(v)) return null;
  if((w.critAbove != null && v > w.critAbove) || (w.critBelow != null && v < w.critBelow)) return 'crit';
  if((w.above != null && v > w.above) || (w.below != null && v < w.below)) return 'warn';
  return null;
}
// Drives the small ⚑ "a warning rule is set here" marker only -- NOT the shading or the badge.
// Shipped defaults deliberately don't count: eight gauges now carry factory thresholds, and a flag
// on all of them would say nothing at all. The flag is for "someone changed this one", so it comes
// back the moment a user edits that gauge's warnings (the Warnings tab clears warnDefault).
function gaugeHasWarnRule(def){
  var w = def.warnings;
  if(!w || def.warnDefault) return false;
  return w.above != null || w.below != null || w.critAbove != null || w.critBelow != null;
}

// ---- SVG helpers ------------------------------------------------------------------------------
function svgEl(tag, attrs){
  var el = document.createElementNS(GAUGE_NS, tag);
  Object.keys(attrs || {}).forEach(function(k){ el.setAttribute(k, attrs[k]); });
  return el;
}
// angle in degrees, 0 = up (12 o'clock), clockwise positive
function gaugePolar(cx, cy, r, aDeg){
  var a = aDeg * Math.PI / 180;
  return [cx + r * Math.sin(a), cy - r * Math.cos(a)];
}
function gaugeArcPath(cx, cy, r, a0, a1){
  var p0 = gaugePolar(cx, cy, r, a0), p1 = gaugePolar(cx, cy, r, a1);
  var large = (Math.abs(a1 - a0) > 180) ? 1 : 0;
  return 'M ' + p0[0].toFixed(2) + ' ' + p0[1].toFixed(2) +
         ' A ' + r + ' ' + r + ' 0 ' + large + ' 1 ' + p1[0].toFixed(2) + ' ' + p1[1].toFixed(2);
}

// ---- Round dial (type 'round' = hero w/ full scale; 'compact-round' = small w/ end labels) ------
function buildRoundDial(def){
  var isRound = def.type === 'round';
  var fs = gaugeFontScale(def);
  var box = document.createElement('div');
  box.className = 'pbd-dial-box';
  // def.dialWidth shrinks the dial without shrinking its readout -- paired with def.readoutScale it
  // trades dial size for a bigger number, which is what saves vertical space in stacked zones.
  // Set as a custom property rather than a hard width so the responsive --dlv-gauge-scale can
  // multiply it; a literal width here would pin the gauge and defeat scaling on large displays.
  // UNITLESS on purpose: the CSS is calc(var(--dial-w) * var(--dlv-gauge-u)), and --dlv-gauge-u is
  // itself a length, so a "px" here would make it px*px -- invalid, and the dial silently falls
  // back to auto width and balloons to fill its zone.
  if(def.dialWidth) box.style.setProperty('--dial-w', String(def.dialWidth));

  var label = document.createElement('div');
  label.className = 'pbd-dial-label';
  label.style.fontSize = (11 * fs) + 'px';
  label.textContent = def.label;
  label.title = def.label;   // full name on hover when the label is clipped to fit
  box.appendChild(label);

  var svg = svgEl('svg', { viewBox: '0 0 200 200', class: 'pbd-dial-svg' });
  var cx = 100, cy = 102;
  var rRing = 88, rTick = 84, rTickIn = isRound ? 74 : 73, rMinorIn = 79;
  // labels sit close to the ticks so the middle of the dial stays clear for the readout -- further
  // in, a wide value like "10000" collides with the bottom-corner numbers.
  var rLabel = isRound ? 68 : 63;
  var hasZones = gaugeZones(def).length > 0;

  svg.appendChild(svgEl('path', { d: gaugeArcPath(cx, cy, rRing, GAUGE_A0, GAUGE_A1), class: 'pbd-dial-groove', 'stroke-width': 10, 'stroke-linecap': 'round' }));
  // The bezel is ALWAYS neutral grey (matching the RPM dial). Colouring it per-gauge made the
  // cluster read as a wall of green; colour now means something -- the pointer and readout carry
  // the in-range/warn/critical state, and zone bands are the only other coloured thing on the ring.
  svg.appendChild(svgEl('path', { d: gaugeArcPath(cx, cy, rRing, GAUGE_A0, GAUGE_A1), fill: 'none',
    stroke: '#4a4a54', 'stroke-width': 4, 'stroke-linecap': 'round', opacity: 0.9 }));

  // zone arcs
  var zoneG = svgEl('g', {});
  svg.appendChild(zoneG);
  function angleForVal(v){ return GAUGE_A0 + GAUGE_SWEEP * clampGauge((v - def.min) / (def.max - def.min), 0, 1); }
  gaugeZones(def).forEach(function(z){
    zoneG.appendChild(svgEl('path', { d: gaugeArcPath(cx, cy, rRing, angleForVal(z.from), angleForVal(z.to)),
      fill: 'none', stroke: z.color, 'stroke-width': 8, 'stroke-linecap': 'butt' }));
  });

  // Compact dials use the SAME tick/label treatment as the hero dial -- just fewer divisions.
  // They used to show only a bare min and max, which read as a different (and cheaper) design;
  // 4 divisions gives a centre mark plus two between centre and each end.
  var endNums = [];
  var majors = def.majors || (isRound ? 10 : 4);
  var minorsPer = def.minorsPer || 0;
  var labelSize = (isRound ? 11 : 11.5) * fs;   // compact labels sit closer in, so nudge them up
  for(var i = 0; i <= majors; i++){
    var a = GAUGE_A0 + GAUGE_SWEEP * (i / majors);
    var o = gaugePolar(cx, cy, rTick, a), ii = gaugePolar(cx, cy, rTickIn, a);
    svg.appendChild(svgEl('line', { x1: o[0], y1: o[1], x2: ii[0], y2: ii[1], class: 'pbd-dial-tick', 'stroke-width': isRound ? 2.4 : 3 }));
    var lv = def.min + (def.max - def.min) * (i / majors);
    var lp = gaugePolar(cx, cy, rLabel, a);
    var tl = svgEl('text', { x: lp[0], y: lp[1], class: 'pbd-dial-ticklabel', 'font-size': labelSize });
    tl.textContent = fmtGaugeTick(lv, def);
    svg.appendChild(tl);
    if(i === 0 || i === majors) endNums.push(tl);
    if(i < majors && minorsPer > 0){
      for(var m = 1; m <= minorsPer; m++){
        var am = a + (GAUGE_SWEEP / majors) * (m / (minorsPer + 1));
        var mo = gaugePolar(cx, cy, rTick, am), mi = gaugePolar(cx, cy, rMinorIn, am);
        svg.appendChild(svgEl('line', { x1: mo[0], y1: mo[1], x2: mi[0], y2: mi[1], class: 'pbd-dial-tick-minor', 'stroke-width': 1.4 }));
      }
    }
  }

  // scale note ("x 1000 rpm") -- baseline-positioned (unlike the radial tick labels, which are
  // dominant-baseline:middle); that difference is what used to make it collide with the readout.
  if(def.scaleNote && isRound){
    var sn = svgEl('text', { x: cx, y: 118, class: 'pbd-dial-scalenote', 'font-size': (10 * fs) });
    sn.textContent = def.scaleNote;
    svg.appendChild(sn);
  }

  // Hero dials keep a classic hub-mounted needle.
  //
  // Compact dials use a RIM MARKER: a hollow circle straddling the outer ring with a radial line
  // through its centre. Their readout is scaled way up, so a hub-mounted needle sweeps straight
  // through the number; and a solid wedge (the first attempt) was visible but had no exact point of
  // intersection with the scale. Splitting the job fixes both -- the circle is what you catch
  // peripherally, the line is what you read. The line deliberately reaches inward across the whole
  // tick band (ticks span r73..r84) so it registers unambiguously against a division.
  var needle = null, markerLine = null, markerRing = null, hub = null;
  if(isRound){
    needle = svgEl('polygon', { points: '', fill: def.color, class: 'pbd-dial-needle' });
    svg.appendChild(needle);
    hub = svgEl('circle', { cx: cx, cy: cy, r: 6, fill: def.color });
    svg.appendChild(hub);
    svg.appendChild(svgEl('circle', { cx: cx, cy: cy, r: 2.6, fill: '#0e0e11' }));
  } else {
    markerLine = svgEl('line', { x1: cx, y1: cy, x2: cx, y2: cy, stroke: def.color,
      'stroke-width': GAUGE_MARK_LINE_W, 'stroke-linecap': 'round', class: 'pbd-dial-marker-line' });
    markerRing = svgEl('circle', { cx: cx, cy: cy, r: GAUGE_MARK_R, fill: 'none', stroke: def.color,
      'stroke-width': GAUGE_MARK_STROKE, class: 'pbd-dial-marker-ring' });
    svg.appendChild(markerLine);
    svg.appendChild(markerRing);
  }

  var vy = isRound ? 151 : 132;
  var rs = def.readoutScale || 1;
  var valueEl = svgEl('text', { x: cx, y: vy, class: 'pbd-dial-value', fill: def.color, 'font-size': ((isRound ? 25 : 19) * fs * rs) });
  var unitEl = svgEl('text', { x: cx, y: vy + (isRound ? 17 : 15) * Math.max(1, rs * 0.8), class: 'pbd-dial-unit', 'font-size': ((isRound ? 11 : 10) * fs * Math.min(rs, 1.3)) });
  unitEl.textContent = def.unit || '';
  svg.appendChild(valueEl); svg.appendChild(unitEl);

  box.appendChild(svg);
  // zoneG + rRing are kept so the warn/redline bands can be redrawn IN PLACE while dragging --
  // rebuilding the gauge mid-drag detaches the SVG and its getBoundingClientRect() goes to zero,
  // which corrupts the pointer-to-angle maths.
  return { box: box, refs: { kind: 'dial', isRound: isRound, needle: needle, hub: hub, valueEl: valueEl,
    markerLine: markerLine, markerRing: markerRing,
    cx: cx, cy: cy, rRing: rRing, zoneG: zoneG, endNums: endNums, svg: svg } };
}

// ---- Vertical bar -----------------------------------------------------------------------------
function buildVerticalBar(def){
  var fs = gaugeFontScale(def);
  var box = document.createElement('div');
  box.className = 'pbd-bar-box';

  var label = document.createElement('div');
  label.className = 'pbd-bar-label';
  label.style.fontSize = (10 * fs) + 'px';
  label.textContent = def.label;
  label.title = def.label;   // full name on hover when the label is clipped to fit
  box.appendChild(label);

  // The track clips its own contents (overflow:hidden, so the fill's corners stay inside), so the
  // scale numbers CANNOT live inside it -- they did, and were silently clipped away entirely.
  // They're a sibling inside a positioned wrapper instead.
  var trackWrap = document.createElement('div');
  trackWrap.className = 'pbd-bar-trackwrap';

  var track = document.createElement('div');
  track.className = 'pbd-bar-track';

  // Built-in zones first, then the user's warning bands on top -- the two are independent and a
  // gauge can have either, both, or neither.
  gaugeZones(def).concat(gaugeWarnBands(def)).forEach(function(z){
    var topPct = (def.max - Math.max(z.from, z.to)) / (def.max - def.min);
    var botPct = (def.max - Math.min(z.from, z.to)) / (def.max - def.min);
    var band = document.createElement('div');
    band.className = 'pbd-bar-zone';
    band.style.top = (Math.max(0, topPct) * 100) + '%';
    band.style.height = ((Math.min(1, botPct) - Math.max(0, topPct)) * 100) + '%';
    band.style.background = z.color;
    track.appendChild(band);
  });

  // Rest line -- only meaningful when the anchor sits inside the range (a bar that fills from the
  // bottom has nothing to mark).
  var anchorVal = gaugeAnchor(def);
  if(anchorVal > def.min && anchorVal < def.max){
    var zero = document.createElement('div');
    zero.className = 'pbd-bar-zero';
    zero.style.top = (((def.max - anchorVal) / (def.max - def.min)) * 100) + '%';
    track.appendChild(zero);
  }

  var fill = document.createElement('div');
  fill.className = 'pbd-bar-fill';
  fill.style.background = def.color;
  track.appendChild(fill);

  var ticks = document.createElement('div');
  ticks.className = 'pbd-bar-ticks';
  var divs = def.ticks || 4;
  var endNums = [];
  for(var i = 0; i <= divs; i++){
    var tv = def.max - (def.max - def.min) * (i / divs);
    var row = document.createElement('div');
    row.className = 'pbd-bar-tick';
    row.style.top = ((i / divs) * 100) + '%';
    row.style.fontSize = (9.5 * fs) + 'px';
    row.textContent = (Math.abs(def.max) < 10 ? tv.toFixed(1) : tv.toFixed(0));
    ticks.appendChild(row);
    if(i === 0 || i === divs) endNums.push(row);
  }
  trackWrap.appendChild(track);
  trackWrap.appendChild(ticks);   // sibling of the track, so it isn't clipped by its overflow
  box.appendChild(trackWrap);

  var valueEl = document.createElement('div');
  valueEl.className = 'pbd-bar-value';
  valueEl.style.color = def.color;
  valueEl.style.fontSize = (15 * fs) + 'px';
  box.appendChild(valueEl);

  return { box: box, refs: { kind: 'bar', fill: fill, valueEl: valueEl, endNums: endNums } };
}

// ---- Plain number card ------------------------------------------------------------------------
function buildNumberCard(def){
  var fs = gaugeFontScale(def);
  var box = document.createElement('div');
  box.className = 'pbd-number-box';
  box.style.borderLeftColor = def.color;
  var isDigital = def.type === 'digital';
  var label = document.createElement('div');
  label.className = 'pbd-number-label';
  // 'digital' sizes ITS type in CSS, from --dlv-gauge-u, because its box is also sized in gauge
  // units. Setting a fixed px font here meant the box grew and shrank with the fascia while the
  // digits stayed put -- overflowing the box at small scales and rattling around inside it at
  // large ones. Anything sized in gauge units must have its text sized the same way.
  if(!isDigital) label.style.fontSize = (10 * fs) + 'px';
  label.textContent = def.label;
  label.title = def.label;   // full name on hover when the label is clipped to fit
  var valueEl = document.createElement('div');
  valueEl.className = 'pbd-number-value';
  valueEl.style.color = def.color;
  // 'digital' is the square big-number treatment used where a needle earns nothing -- a coolant
  // temperature moves slowly and you read the number, not the sweep (Ken, 2026-07-21). Cams
  // deliberately stayed round: their value swings fast and the sweep IS the information.
  if(!isDigital) valueEl.style.fontSize = (18 * fs) + 'px';
  box.appendChild(label); box.appendChild(valueEl);
  if(def.type === 'digital' && def.unit){
    var unitEl = document.createElement('div');
    unitEl.className = 'pbd-number-unit';
    unitEl.textContent = def.unit;
    box.appendChild(unitEl);
  }
  return { box: box, refs: { kind: 'number', valueEl: valueEl } };
}

// ---- Horizontal bar ---------------------------------------------------------------------------
// Same model as the vertical bar, laid out left-to-right. Fill and zones are % of the track WIDTH,
// so the whole thing stretches to whatever size the container gives it (dashboard bars are free-size).
function buildHBar(def){
  var fs = gaugeFontScale(def);
  var box = document.createElement('div');
  box.className = 'pbd-hbar-box';
  var head = document.createElement('div');
  head.className = 'pbd-hbar-head';
  var label = document.createElement('div');
  label.className = 'pbd-hbar-label';
  label.style.fontSize = (10 * fs) + 'px';
  label.textContent = def.label;
  label.title = def.label;   // full name on hover when the label is clipped to fit
  var valueEl = document.createElement('div');
  valueEl.className = 'pbd-hbar-value';
  valueEl.style.color = def.color;
  valueEl.style.fontSize = (13 * fs) + 'px';
  head.appendChild(label); head.appendChild(valueEl);
  box.appendChild(head);

  var track = document.createElement('div');
  track.className = 'pbd-hbar-track';
  var span = (def.max - def.min) || 1;
  gaugeZones(def).concat(gaugeWarnBands(def)).forEach(function(z){
    var l = (Math.min(z.from, z.to) - def.min) / span, r = (Math.max(z.from, z.to) - def.min) / span;
    var band = document.createElement('div');
    band.className = 'pbd-hbar-zone';
    band.style.left = (Math.max(0, l) * 100) + '%';
    band.style.width = ((Math.min(1, r) - Math.max(0, l)) * 100) + '%';
    band.style.background = z.color;
    track.appendChild(band);
  });
  var anchorVal = gaugeAnchor(def);
  if(anchorVal > def.min && anchorVal < def.max){
    var zero = document.createElement('div');
    zero.className = 'pbd-hbar-zero';
    zero.style.left = (((anchorVal - def.min) / span) * 100) + '%';
    track.appendChild(zero);
  }
  var fill = document.createElement('div');
  fill.className = 'pbd-hbar-fill';
  fill.style.background = def.color;
  track.appendChild(fill);
  box.appendChild(track);

  // Scale increments below the track (the vertical bar has these; the h-bar had none -- Ken). A sibling
  // of the track, so the track's overflow:hidden doesn't clip them. min at left, max at right; the two
  // end labels anchor to their edges instead of centring so they don't hang off the ends.
  var ticks = document.createElement('div');
  ticks.className = 'pbd-hbar-ticks';
  var divs = def.ticks || 4;
  for(var i = 0; i <= divs; i++){
    var tv = def.min + (def.max - def.min) * (i / divs);
    var t = document.createElement('div');
    t.className = 'pbd-hbar-tick';
    t.style.left = ((i / divs) * 100) + '%';
    t.style.fontSize = (8.5 * fs) + 'px';
    if(i === 0) t.style.transform = 'translateX(0)';
    else if(i === divs) t.style.transform = 'translateX(-100%)';
    t.textContent = (Math.abs(def.max) < 10 ? tv.toFixed(1) : String(Math.round(tv)));
    ticks.appendChild(t);
  }
  box.appendChild(ticks);
  return { box: box, refs: { kind: 'hbar', fill: fill, valueEl: valueEl } };
}

// ---- Warning light ----------------------------------------------------------------------------
// A single indicator that glows green / amber / red by value (lightColor + def.thresholds). Meant
// for "is this parameter in trouble" -- assign it to knock, set a warn/red level, done.
function buildWarnLight(def){
  var fs = gaugeFontScale(def);
  var box = document.createElement('div');
  box.className = 'pbd-light-box';
  var label = document.createElement('div');
  label.className = 'pbd-light-label';
  label.style.fontSize = (10 * fs) + 'px';
  label.textContent = def.label;
  label.title = def.label;   // full name on hover when the label is clipped to fit
  var lamp = document.createElement('div');
  lamp.className = 'pbd-light-lamp';
  var valueEl = document.createElement('div');
  valueEl.className = 'pbd-light-value';
  valueEl.style.fontSize = (12 * fs) + 'px';
  box.appendChild(label); box.appendChild(lamp); box.appendChild(valueEl);
  return { box: box, refs: { kind: 'light', lamp: lamp, valueEl: valueEl } };
}

// ---- Combo: hero RPM tach + small inset speed dial (Ken's Speedhut-style dual gauge) ----------
// Reuses the hero dial for the primary (RPM): its centre readout is suppressed -- RPM reads off the
// needle/ticks, as on the reference. A small second dial (def.sub) is drawn into the SAME svg, in the
// lower-centre CLEAR ZONE: the 90deg gap at the bottom that the 270deg RPM sweep never reaches, so the
// two needles never collide. def.sub = { channelOverride, label, unit, min, max, decimals, color }.
function subAngle(sub, v){
  var lo = sub.min != null ? sub.min : 0, hi = sub.max != null ? sub.max : 1;
  return GAUGE_A0 + GAUGE_SWEEP * clampGauge((v - lo) / ((hi - lo) || 1), 0, 1);
}
function buildCombo(def){
  var mainDef = {}; for(var k in def) mainDef[k] = def[k];
  mainDef.type = 'round';                 // force the hero (needle) dial, not the compact rim marker
  var main = buildRoundDial(mainDef);
  var box = main.box, mref = main.refs, svg = mref.svg;
  // Suppress the main centre readout + unit so the inset owns the lower-centre area.
  if(mref.valueEl && mref.valueEl.parentNode) mref.valueEl.parentNode.removeChild(mref.valueEl);
  var mu = box.querySelector('.pbd-dial-unit'); if(mu && mu.parentNode) mu.parentNode.removeChild(mu);

  var sub = def.sub || {};
  var icx = 100, icy = 143, iR = 25, iRtick = 23.5, iRin = 18.5;
  var subColor = sub.color || '#e6e6ea';
  var gg = svgEl('g', { class: 'pbd-combo-inset' });
  gg.appendChild(svgEl('path', { d: gaugeArcPath(icx, icy, iR, GAUGE_A0, GAUGE_A1), fill: 'none', stroke: '#242430', 'stroke-width': 6, 'stroke-linecap': 'round' }));
  gg.appendChild(svgEl('path', { d: gaugeArcPath(icx, icy, iR, GAUGE_A0, GAUGE_A1), fill: 'none', stroke: '#4a4a54', 'stroke-width': 2.4, 'stroke-linecap': 'round' }));
  gaugeZones(sub).forEach(function(z){
    gg.appendChild(svgEl('path', { d: gaugeArcPath(icx, icy, iR, subAngle(sub, z.from), subAngle(sub, z.to)), fill: 'none', stroke: z.color, 'stroke-width': 4.5, 'stroke-linecap': 'butt' }));
  });
  var im = sub.majors || 4;
  for(var i = 0; i <= im; i++){
    var a = GAUGE_A0 + GAUGE_SWEEP * (i / im);
    var o = gaugePolar(icx, icy, iRtick, a), ii = gaugePolar(icx, icy, iRin, a);
    gg.appendChild(svgEl('line', { x1: o[0], y1: o[1], x2: ii[0], y2: ii[1], class: 'pbd-dial-tick', 'stroke-width': 1.5 }));
  }
  var needle = svgEl('polygon', { points: '', fill: subColor, class: 'pbd-dial-needle' });
  gg.appendChild(needle);
  gg.appendChild(svgEl('circle', { cx: icx, cy: icy, r: 3, fill: subColor }));
  gg.appendChild(svgEl('circle', { cx: icx, cy: icy, r: 1.3, fill: '#0e0e11' }));
  var valueEl = svgEl('text', { x: icx, y: icy + 11, class: 'pbd-dial-value pbd-combo-val', fill: subColor, 'font-size': 11.5 });
  var unitEl = svgEl('text', { x: icx, y: icy + 20, class: 'pbd-combo-unit', 'font-size': 6.5, fill: '#8a8a92' });
  unitEl.setAttribute('text-anchor', 'middle');
  unitEl.textContent = sub.unit || 'MPH';
  gg.appendChild(valueEl); gg.appendChild(unitEl);
  svg.appendChild(gg);

  return { box: box, refs: { kind: 'combo', main: mref, sub: { needle: needle, valueEl: valueEl, icx: icx, icy: icy } } };
}

// ---- Public: build one gauge ------------------------------------------------------------------
// Returns the wrapper element. Refs are stashed on the RETURNED element (see BUGFIX note up top) so
// updateGaugeElement can find them.
function createGaugeElement(def){
  // Scorecard is a table component, not an SVG gauge -- delegate to its module (datalog-scorecard.js).
  if(def.type === 'scorecard' && typeof Scorecard !== 'undefined' && Scorecard.buildElement){ return Scorecard.buildElement(def); }
  var wrap = document.createElement('div');
  wrap.className = 'pbd-gauge pbd-gauge-' + def.type;
  wrap.dataset.gaugeId = def.id;

  var built;
  if(def.type === 'round' || def.type === 'compact-round') built = buildRoundDial(def);
  else if(def.type === 'combo') built = buildCombo(def);
  else if(def.type === 'vertical-bar') built = buildVerticalBar(def);
  else if(def.type === 'horizontal-bar') built = buildHBar(def);
  else if(def.type === 'light') built = buildWarnLight(def);
  else built = buildNumberCard(def);

  wrap.appendChild(built.box);
  wrap._pbdRefs = built.refs;

  if(gaugeHasWarnRule(def)){
    var flag = document.createElement('div');
    flag.className = 'pbd-gauge-flag';
    flag.textContent = '⚑';
    flag.title = 'This parameter has a warning rule';
    wrap.appendChild(flag);
  }
  var badge = document.createElement('div');
  badge.className = 'pbd-gauge-badge';
  badge.textContent = '!';
  wrap.appendChild(badge);

  return wrap;
}

// ---- Public: update one gauge in place --------------------------------------------------------
// `rawValue` is null/undefined when the gauge's role didn't resolve to any channel in this log --
// shown as a dimmed "N/A", never substituted or guessed. A real value outside [min,max] clamps the
// needle/fill visually while the digital readout still shows the true number.
function updateGaugeElement(wrap, def, rawValue, rawValue2){
  var refs = wrap && wrap._pbdRefs;
  if(!refs) return;
  var missing = rawValue == null || !isFinite(rawValue);
  wrap.classList.toggle('pbd-gauge-missing', missing);

  var col = gaugeActiveColor(def, rawValue);

  if(refs.kind === 'dial'){
    var pct = missing ? 0 : clampGauge((rawValue - def.min) / (def.max - def.min), 0, 1);
    var a = GAUGE_A0 + GAUGE_SWEEP * pct;
    var cx = refs.cx, cy = refs.cy, isRound = refs.isRound;
    if(isRound){
      // classic tapered needle pivoting on the hub
      var pts = [gaugePolar(cx, cy, 72, a), gaugePolar(cx, cy, 4.2, a - 90),
                 gaugePolar(cx, cy, 14, a + 180), gaugePolar(cx, cy, 4.2, a + 90)];
      refs.needle.setAttribute('points', pts.map(function(p){
        return p[0].toFixed(1) + ',' + p[1].toFixed(1);
      }).join(' '));
      refs.needle.setAttribute('fill', col);
      if(refs.hub) refs.hub.setAttribute('fill', col);
    } else {
      // rim marker: hollow circle on the ring + a radial line through it across the ticks
      var pIn = gaugePolar(cx, cy, GAUGE_MARK_IN, a);
      var pOut = gaugePolar(cx, cy, GAUGE_MARK_OUT, a);
      var pRing = gaugePolar(cx, cy, GAUGE_MARK_RING, a);
      refs.markerLine.setAttribute('x1', pIn[0].toFixed(1));
      refs.markerLine.setAttribute('y1', pIn[1].toFixed(1));
      refs.markerLine.setAttribute('x2', pOut[0].toFixed(1));
      refs.markerLine.setAttribute('y2', pOut[1].toFixed(1));
      refs.markerLine.setAttribute('stroke', col);
      refs.markerRing.setAttribute('cx', pRing[0].toFixed(1));
      refs.markerRing.setAttribute('cy', pRing[1].toFixed(1));
      refs.markerRing.setAttribute('stroke', col);
    }
    refs.valueEl.setAttribute('fill', col);
    refs.valueEl.textContent = fmtGaugeValue(rawValue, def.decimals);
  } else if(refs.kind === 'bar'){
    if(missing){
      refs.fill.style.height = '0%';
      refs.fill.style.bottom = '0%';
    } else {
      var c = clampGauge(rawValue, def.min, def.max);
      var span = (def.max === def.min) ? 1 : (def.max - def.min);
      var zeroPct = (clampGauge(gaugeAnchor(def), def.min, def.max) - def.min) / span;
      var valPct = (def.max === def.min) ? 0 : (c - def.min) / span;
      var top = Math.max(zeroPct, valPct), bot = Math.min(zeroPct, valPct);
      refs.fill.style.bottom = (bot * 100) + '%';
      refs.fill.style.height = ((top - bot) * 100) + '%';
      refs.fill.style.background = col;
    }
    refs.valueEl.style.color = col;
    refs.valueEl.textContent = fmtGaugeValue(rawValue, def.decimals);
  } else if(refs.kind === 'hbar'){
    if(missing){ refs.fill.style.width = '0%'; }
    else {
      var hc = clampGauge(rawValue, def.min, def.max);
      var hspan = (def.max === def.min) ? 1 : (def.max - def.min);
      var hzero = (clampGauge(gaugeAnchor(def), def.min, def.max) - def.min) / hspan;
      var hval = (hc - def.min) / hspan;
      var left = Math.min(hzero, hval), right = Math.max(hzero, hval);
      refs.fill.style.left = (left * 100) + '%';
      refs.fill.style.width = ((right - left) * 100) + '%';
      refs.fill.style.background = col;
    }
    refs.valueEl.style.color = col;
    refs.valueEl.textContent = missing ? 'N/A' : (fmtGaugeValue(rawValue, def.decimals) + (def.unit ? ' ' + def.unit : ''));
  } else if(refs.kind === 'light'){
    var lc = lightColor(def, rawValue);   // green / amber / red, or null when missing
    var lit = !missing && lc;
    refs.lamp.classList.toggle('lit', !!lit);
    refs.lamp.style.background = lit ? lc : '';
    refs.lamp.style.boxShadow = lit ? ('0 0 14px ' + lc + ', inset 0 0 6px rgba(255,255,255,.35)') : '';
    refs.valueEl.style.color = lit ? lc : '';
    refs.valueEl.textContent = missing ? 'N/A' : (fmtGaugeValue(rawValue, def.decimals) + (def.unit ? ' ' + def.unit : ''));
  } else if(refs.kind === 'combo'){
    // Main RPM needle (hero-dial math on the primary value); colour follows its redline zone.
    var m = refs.main;
    var pctM = missing ? 0 : clampGauge((rawValue - def.min) / ((def.max - def.min) || 1), 0, 1);
    var aM = GAUGE_A0 + GAUGE_SWEEP * pctM;
    var ptsM = [gaugePolar(m.cx, m.cy, 72, aM), gaugePolar(m.cx, m.cy, 4.2, aM - 90),
                gaugePolar(m.cx, m.cy, 14, aM + 180), gaugePolar(m.cx, m.cy, 4.2, aM + 90)];
    m.needle.setAttribute('points', ptsM.map(function(p){ return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' '));
    m.needle.setAttribute('fill', col);
    if(m.hub) m.hub.setAttribute('fill', col);
    // Inset speed needle + digital, driven by the SECOND channel's value (rawValue2).
    var s = refs.sub, sub = def.sub || {};
    var miss2 = rawValue2 == null || !isFinite(rawValue2);
    var lo = sub.min != null ? sub.min : 0, hi = sub.max != null ? sub.max : 1;
    var pctS = miss2 ? 0 : clampGauge((rawValue2 - lo) / ((hi - lo) || 1), 0, 1);
    var aS = GAUGE_A0 + GAUGE_SWEEP * pctS;
    var ptsS = [gaugePolar(s.icx, s.icy, 17, aS), gaugePolar(s.icx, s.icy, 2, aS - 90),
                gaugePolar(s.icx, s.icy, 5, aS + 180), gaugePolar(s.icx, s.icy, 2, aS + 90)];
    s.needle.setAttribute('points', ptsS.map(function(p){ return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' '));
    s.valueEl.textContent = miss2 ? 'N/A' : fmtGaugeValue(rawValue2, sub.decimals != null ? sub.decimals : 0);
  } else {
    refs.valueEl.style.color = col;
    // 'digital' renders its unit as its own element underneath, so appending it here too printed
    // it twice ("176 °F" with another "°F" below) AND made the value string wide enough to blow
    // the box open. Plain number cards keep the inline unit.
    var suffix = (def.type === 'digital' || !def.unit) ? '' : ' ' + def.unit;
    refs.valueEl.textContent = missing ? 'N/A' : (fmtGaugeValue(rawValue, def.decimals) + suffix);
  }

  // user warning: tints the whole tile + badge, deliberately separate from the zone colours above
  var st = gaugeWarnState(def, rawValue);
  // A number/digital gauge draws no band or needle, so a threshold trip would only recolour the
  // digits -- easy to miss. Tint the whole tile too, from its warn/red thresholds (Ken, 2026-07-24).
  if(!st && def.type === 'digital' && def.thresholds && rawValue != null && isFinite(rawValue)){
    var td = def.thresholds;
    if(td.red != null && rawValue >= td.red) st = 'crit';
    else if(td.warn != null && rawValue >= td.warn) st = 'warn';
  }
  wrap.classList.toggle('pbd-gauge-warned', st === 'warn');
  wrap.classList.toggle('pbd-gauge-warned-crit', st === 'crit');
}

// ---- Public: redraw a dial's warn/redline bands without rebuilding the gauge -------------------
// Used while dragging a threshold handle. A full re-render would destroy the very SVG the drag is
// measuring against, so the bands are repainted into the existing zone group instead.
function redrawGaugeZones(wrap, def){
  var refs = wrap && wrap._pbdRefs;
  if(!refs || refs.kind !== 'dial' || !refs.zoneG) return;
  while(refs.zoneG.firstChild) refs.zoneG.removeChild(refs.zoneG.firstChild);
  var span = def.max - def.min;
  function angleFor(v){ return GAUGE_A0 + GAUGE_SWEEP * clampGauge(span ? (v - def.min) / span : 0, 0, 1); }
  gaugeZones(def).forEach(function(z){
    refs.zoneG.appendChild(svgEl('path', {
      d: gaugeArcPath(refs.cx, refs.cy, refs.rRing, angleFor(z.from), angleFor(z.to)),
      fill: 'none', stroke: z.color, 'stroke-width': 8, 'stroke-linecap': 'butt',
    }));
  });
}

// ---- Public: fixed V8/V6 fascia layout (matches the approved 8cyl.png mockup) ------------------
// Two rows of four regions, keyed off each def's `group` -- which is exactly what `group` was
// designed for. Anything with an unrecognised group lands in a trailing "extra" region rather than
// being dropped, so adding a gauge can never make it silently disappear.
//   row 1: [ rpm ] [ knock bars ] [ lambda ] [ temps ]
//   row 2: [ cams/boost/speed ] [ lower bars ] [ fuel pressure ] [ trims ]
//   row 1: [ rpm ] [ knock bars + Boost/Speed stacked ] [ lambda ] [ ECT/MCT ]
//   row 2: [ cams side-by-side ] [ lower bars ] [ fuel pressure ] [ trims ]
// Boost/Speed live inside the knock panel (as a stackGroup) because that zone had spare width and
// row 2 needed the height back.
var GAUGE_FASCIA_ROWS = [
  ['rpm', 'knock-bars', 'lambda', 'temps-right'],
  ['cams', 'lower-bars', 'fuel-pressure', 'trims']
];
function renderGaugeFascia(gaugeDefs){
  var container = document.createElement('div');
  container.className = 'pbd-fascia';

  var byGroup = {};
  (gaugeDefs || []).forEach(function(def){
    var g = def.group || 'extra';
    (byGroup[g] = byGroup[g] || []).push(def);
  });

  var gaugeEls = {};
  var placed = {};
  function addGauge(zone, def, stacks){
    var el = createGaugeElement(def);
    // Defs sharing a `stackGroup` are wrapped in a vertical sub-column INSIDE the zone, so a pair
    // like Boost/Speed can sit stacked alongside the knock bars in the same panel rather than
    // needing a panel of their own (which would just add dead width to the row).
    var host = zone;
    if(def.stackGroup){
      if(!stacks[def.stackGroup]){
        var col = document.createElement('div');
        col.className = 'pbd-fascia-substack pbd-fascia-substack-' + def.stackGroup;
        zone.appendChild(col);
        stacks[def.stackGroup] = col;
      }
      host = stacks[def.stackGroup];
    }
    host.appendChild(el);
    gaugeEls[def.id] = el;
  }

  GAUGE_FASCIA_ROWS.forEach(function(groups){
    var row = document.createElement('div');
    row.className = 'pbd-fascia-row';
    groups.forEach(function(g){
      var defs = byGroup[g];
      if(!defs || !defs.length) return;
      placed[g] = true;
      var zone = document.createElement('div');
      zone.className = 'pbd-fascia-zone pbd-fascia-zone-' + g;
      // Grow in proportion to gauge count so no single zone swallows a whole row's spare width.
      // All-dial zones don't grow -- stretching them only pads fixed-size SVGs.
      var allDials = defs.every(function(d){ return d.type === 'round' || d.type === 'compact-round'; });
      zone.style.flexGrow = allDials ? '0' : String(defs.length);
      var stacks = {};
      defs.forEach(function(def){ addGauge(zone, def, stacks); });
      row.appendChild(zone);
    });
    if(row.children.length) container.appendChild(row);
  });

  // any group the fascia doesn't know about still gets rendered
  var leftovers = Object.keys(byGroup).filter(function(g){ return !placed[g]; });
  if(leftovers.length){
    var extraRow = document.createElement('div');
    extraRow.className = 'pbd-fascia-row';
    leftovers.forEach(function(g){
      var zone = document.createElement('div');
      zone.className = 'pbd-fascia-zone pbd-fascia-zone-extra';
      var xstacks = {};
      byGroup[g].forEach(function(def){ addGauge(zone, def, xstacks); });
      extraRow.appendChild(zone);
    });
    container.appendChild(extraRow);
  }

  return { container: container, gaugeEls: gaugeEls };
}

// ---- Public: schematic SVG thumbnail of a custom-gauge dashboard --------------------------------
// For the shared library: a small picture of the LAYOUT (types, positions, sizes, colours, labels)
// drawn from the saved defs alone -- no log, no DOM, no CSS -- so it can be generated at publish time
// and shown anywhere as a string. Real gauges are DOM+SVG+CSS hybrids sized by --dlv-gauge-u, so this
// is a deliberate schematic, not a screenshot. Base boxes mirror the CSS at scale 1 (.pbd-dial-box
// 172u wide for a dial, 96u tiles for number/light) plus label room.
var GAUGE_THUMB_BASE = { 'round': { w: 172, h: 206 }, 'combo': { w: 177, h: 212 }, 'digital': { w: 96, h: 92 }, 'light': { w: 96, h: 92 } };
function gaugeThumbBox(g){
  var t = g.type === 'tach' ? 'round' : g.type;
  if(t === 'vertical-bar' || t === 'horizontal-bar' || t === 'scorecard'){
    var d = t === 'vertical-bar' ? { w: 92, h: 210 } : t === 'horizontal-bar' ? { w: 220, h: 76 } : { w: 260, h: 160 };
    return { w: (+g.w > 0 ? +g.w : d.w), h: (+g.h > 0 ? +g.h : d.h) };
  }
  var b = GAUGE_THUMB_BASE[t] || GAUGE_THUMB_BASE.round, s = (+g.scale > 0 ? +g.scale : 1);
  return { w: b.w * s, h: b.h * s };
}
function gaugesThumbnailSvg(gauges){
  var esc = function(s){ return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
  var n = function(v){ return (Math.round(v * 10) / 10).toString(); };
  var list = (gauges || []).filter(function(g){ return g && g.type && g.type !== 'scorecard'; });
  var M = 16, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  var boxes = list.map(function(g){
    var b = gaugeThumbBox(g), x = +g.x || 0, y = +g.y || 0;
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x + b.w); maxY = Math.max(maxY, y + b.h);
    return { g: g, x: x, y: y, w: b.w, h: b.h };
  });
  if(!boxes.length){ minX = minY = 0; maxX = 320 - 2 * M; maxY = 180 - 2 * M; }   // 320x180 placeholder
  var W = Math.max(160, maxX - minX + 2 * M), Hh = Math.max(90, maxY - minY + 2 * M);
  var out = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + n(W) + ' ' + n(Hh) + '" preserveAspectRatio="xMidYMid meet">',
    '<rect width="100%" height="100%" rx="10" fill="#0d0d11"/>'];
  var font = 'system-ui,sans-serif';
  boxes.forEach(function(b){
    var g = b.g, x = b.x - minX + M, y = b.y - minY + M, col = g.color || '#e5322d', t = g.type === 'tach' ? 'round' : g.type;
    var label = esc(String(g.label || g.channelOverride || '').slice(0, 18));
    var tile = function(){ out.push('<rect x="' + n(x) + '" y="' + n(y) + '" width="' + n(b.w) + '" height="' + n(b.h) + '" rx="8" fill="#15151b" stroke="#2c2c34"/>'); };
    var caption = function(fs){ out.push('<text x="' + n(x + b.w / 2) + '" y="' + n(y + b.h - 7) + '" text-anchor="middle" font-family="' + font + '" font-size="' + n(fs) + '" fill="#a8a8b2">' + label + '</text>'); };
    if(t === 'round' || t === 'combo'){
      var r = Math.min(b.w, b.h * 0.86) / 2, cx = x + b.w / 2, cy = y + r + 4, rr = r * 0.82;
      var a0 = -225 * Math.PI / 180, a1 = 45 * Math.PI / 180, rl0 = 5 * Math.PI / 180, an = (-225 + 0.4 * 270) * Math.PI / 180;
      out.push('<circle cx="' + n(cx) + '" cy="' + n(cy) + '" r="' + n(r) + '" fill="#15151b" stroke="#2c2c34" stroke-width="' + n(r * 0.06) + '"/>');
      out.push('<path d="M ' + n(cx + rr * Math.cos(a0)) + ' ' + n(cy + rr * Math.sin(a0)) + ' A ' + n(rr) + ' ' + n(rr) + ' 0 1 1 ' + n(cx + rr * Math.cos(a1)) + ' ' + n(cy + rr * Math.sin(a1)) + '" fill="none" stroke="#3a3a44" stroke-width="' + n(r * 0.09) + '"/>');
      out.push('<path d="M ' + n(cx + rr * Math.cos(rl0)) + ' ' + n(cy + rr * Math.sin(rl0)) + ' A ' + n(rr) + ' ' + n(rr) + ' 0 0 1 ' + n(cx + rr * Math.cos(a1)) + ' ' + n(cy + rr * Math.sin(a1)) + '" fill="none" stroke="' + esc(col) + '" stroke-width="' + n(r * 0.09) + '"/>');
      out.push('<line x1="' + n(cx) + '" y1="' + n(cy) + '" x2="' + n(cx + rr * 0.9 * Math.cos(an)) + '" y2="' + n(cy + rr * 0.9 * Math.sin(an)) + '" stroke="' + esc(col) + '" stroke-width="' + n(r * 0.07) + '" stroke-linecap="round"/>');
      out.push('<circle cx="' + n(cx) + '" cy="' + n(cy) + '" r="' + n(r * 0.1) + '" fill="#d0d0d6"/>');
      if(t === 'combo'){ var sr = r * 0.33; out.push('<circle cx="' + n(cx) + '" cy="' + n(cy + r * 0.5) + '" r="' + n(sr) + '" fill="#101015" stroke="#3a3a44" stroke-width="' + n(sr * 0.1) + '"/>'); }
      caption(Math.max(9, r * 0.16));
    } else if(t === 'vertical-bar'){
      tile();
      var tw = b.w * 0.34, tx = x + (b.w - tw) / 2, ty = y + 14, th = b.h - 40;
      out.push('<rect x="' + n(tx) + '" y="' + n(ty) + '" width="' + n(tw) + '" height="' + n(th) + '" rx="3" fill="#0a0a0d" stroke="#3a3a44"/>');
      out.push('<rect x="' + n(tx) + '" y="' + n(ty + th * 0.45) + '" width="' + n(tw) + '" height="' + n(th * 0.55) + '" rx="3" fill="' + esc(col) + '"/>');
      caption(Math.max(9, b.w * 0.12));
    } else if(t === 'horizontal-bar'){
      tile();
      var hw = b.w - 24, hx = x + 12, hy = y + b.h * 0.42, hh = b.h * 0.28;
      out.push('<rect x="' + n(hx) + '" y="' + n(hy) + '" width="' + n(hw) + '" height="' + n(hh) + '" rx="3" fill="#0a0a0d" stroke="#3a3a44"/>');
      out.push('<rect x="' + n(hx) + '" y="' + n(hy) + '" width="' + n(hw * 0.6) + '" height="' + n(hh) + '" rx="3" fill="' + esc(col) + '"/>');
      out.push('<text x="' + n(hx) + '" y="' + n(y + b.h * 0.3) + '" font-family="' + font + '" font-size="' + n(Math.max(9, b.h * 0.18)) + '" fill="#a8a8b2">' + label + '</text>');
    } else if(t === 'light'){
      tile();
      var lr = Math.min(b.w, b.h) * 0.24;
      out.push('<circle cx="' + n(x + b.w / 2) + '" cy="' + n(y + b.h * 0.42) + '" r="' + n(lr) + '" fill="#22c55e" stroke="#0a0a0d" stroke-width="' + n(lr * 0.15) + '"/>');
      caption(Math.max(9, b.w * 0.12));
    } else {
      tile();
      out.push('<text x="' + n(x + b.w / 2) + '" y="' + n(y + b.h * 0.62) + '" text-anchor="middle" font-family="ui-monospace,monospace" font-weight="700" font-size="' + n(Math.max(12, b.h * 0.42)) + '" fill="' + esc(col) + '">88.8</text>');
      caption(Math.max(9, b.w * 0.12));
    }
  });
  out.push('</svg>');
  return out.join('');
}

// ---- Public: generic grouped-flex layout (fallback for presets with no fascia mapping) ---------
function renderGaugeGrid(gaugeDefs){
  var container = document.createElement('div');
  container.className = 'pbd-gauge-grid';
  var groups = {};
  var order = [];
  (gaugeDefs || []).forEach(function(def){
    var g = def.group || 'default';
    if(!groups[g]){ groups[g] = []; order.push(g); }
    groups[g].push(def);
  });
  var gaugeEls = {};
  order.forEach(function(g){
    var section = document.createElement('div');
    section.className = 'pbd-gauge-section pbd-gauge-section-' + g;
    groups[g].forEach(function(def){
      var el = createGaugeElement(def);
      section.appendChild(el);
      gaugeEls[def.id] = el;
    });
    container.appendChild(section);
  });
  return { container: container, gaugeEls: gaugeEls };
}
