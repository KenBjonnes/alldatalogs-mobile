'use strict';
/*
 * datalog-viewer.js -- Full-width redesign of the PBD Control Center datalog viewer (#340 redesign,
 * 2026-07-20). Replaces the old centered-modal viewer that used to be inline in data-logs.html.
 *
 * PRESERVED FROM THE ORIGINAL, UNCHANGED IN BEHAVIOR (only moved/renamed where the new DOM
 * structure required it): Chart.js + chartjs-plugin-zoom setup, per-channel y-axis scaling, the
 * shared crosshair plugin, syncZoom (data-space, not pixel-space), nearestTimeIndex binary search,
 * zoomAtPoint arrow-key zoom, touch-vs-pan disambiguation (single-finger touch scrubs, two-finger
 * pans/pinches), and the Safari gesture-event blocking. None of that logic changes here -- it's
 * copied over close to verbatim and just re-wired to the new markup.
 *
 * NEW IN THIS PHASE (2 & 3 of the redesign): full-viewport layout, compact sticky-header channel
 * grid (replacing the old checkbox list), dynamic numeric cards (Default View), a bottom overview
 * scrubber, Presets/View selector wired to datalog-presets.js's normalized-role + preset registry,
 * and a first functional (generic-layout) pass at the gauge dashboard using datalog-gauges.js's
 * renderers -- the fixed V8/V6 mockup fascia positioning is Phase 4; today Gauge View lays gauges
 * out in grouped sections so the binding/update logic is real and testable ahead of that.
 *
 * Requires (loaded before this file): chart.js, chartjs-plugin-zoom, hammer.js, datalog-presets.js,
 * datalog-gauges.js. Requires from data-logs.html: apiCall(), escapeHtml(), the #viewerOverlay /
 * #viewerCloseBtn markup (see data-logs.html's viewer-overlay block), and CURRENT_VEHICLES /
 * CURRENT_VEHICLE_ID for vehicle metadata used by preset auto-selection.
 */

var CHANNEL_COLORS = ['#d1132e','#22c55e','#f5a623','#3b82f6','#a855f7','#14b8a6','#eab308','#ec4899','#84cc16','#06b6d4'];
// Two real naming conventions show up in Ken's HP Tuners exports -- PTDIAG short codes
// (ENGINE_SPEED, MAP, ...) and the human-readable names used by real "HP Tuners CSV Log File"
// exports (Engine RPM, Manifold Absolute Pressure, ...). Used as the fallback default-channel pick
// when the active preset doesn't specify defaultGraphs (Default View / Graph View, which are
// intentionally universal and don't hardcode any channel names).
var QUICK_CHANNELS = ['ENGINE_SPEED','Engine RPM','MAP','Manifold Absolute Pressure','APP_PCT_PEDAL','Throttle Position','Accelerator Pedal Position','VSPD','Vehicle Speed','SPKSAF_SA','Timing Advance','KNKKC_SA[2]','Knock Retard','FRP_ACTUAL','Fuel Rail Pressure Actual','LAMBSE[0]','Equivalence Ratio Commanded - Bank 1'];

// ---- Viewer state (kept as plain vars, same convention as the rest of the site's JS) --------
var VIEWER_DATA = null;
var VIEWER_FILE_NAME = '';
var VIEWER_DOWNLOAD_URL = null;
var VIEWER_VEHICLE_ID = null, VIEWER_CONFIG_ID = null;
// A host can hand the vehicle's identity straight to the viewer on open via meta.vehicle (year/make/
// model + the resolved platform fields: platformId, engine, fuelInjectionType, airflowSensorType). The
// ticket "View Log" path has no vehicleId in CURRENT_VEHICLES, so this is how a ticket supplies vehicle
// context; it also feeds vehicle-keyed config resolution (see BigData Configs). Null when not supplied.
var VIEWER_VEHICLE_META = null;
// A host can also hand the viewer a fully-resolved config to auto-load on open (meta.autoConfig) --
// e.g. a ticket's BigData Config resolved for the vehicle. Applied after the log loads, via the same
// path as picking a saved view, so it overrides the built-in auto-select. Null when not supplied.
var VIEWER_AUTO_CONFIG = null;
// The FULL set of PBD configs a host says apply to this vehicle (meta.vehicleConfigs) -- e.g. every view
// assigned to the car's platform. The one flagged `isDefault` (else the first) auto-loads on open; ALL of
// them are offered in the picker's "For this car" group so the user can switch. Each is [{id,name,kind,
// config,isDefault?}]. Read-only (PBD-owned). Cleared per open.
var VIEWER_VEHICLE_CONFIGS = [];
var VIEWER_SELECTED = [];
var VIEWER_PANEL_ASSIGN = {}; // channel name -> 1 (upper) or 2 (lower)
// [min,max] time range the panels were last built against. rebuildChart runs on every add/remove
// channel, panel reassign and view switch, and always rebuilt at the full range -- so zooming in and
// then adding a channel snapped back to the whole log (Ken, 2026-07-22). This lets a rebuild keep the
// current zoom window, but ONLY when the underlying log is unchanged; a genuinely new log (different
// range) resets to full as before.
var CHART_TIME_RANGE = null;
// BigData brand mark (the product name of THIS viewer, on every host it embeds in -- distinct from
// the parent site, e.g. alldatalogs.com). Inlined rather than an <img src> for two reasons: it ships
// self-contained to several sites with different asset roots and no extra fetch, and inline SVG can
// be recoloured by CSS. The source art is near-black + red, built for a light page; its dark strokes
// are driven off `currentColor` here so one CSS `color` renders them light on our near-black UI while
// the red stays red. Used in the header and, at reduced opacity, as an upper-graph watermark.
var BRAND_LOGO_SVG = "<svg xmlns=\"http://www.w3.org/2000/svg\" version=\"1.1\" viewBox=\"0 0 576.02 78.46\"><defs><style>\n      .bd0 {\n        fill:currentColor;\n      }\n\n      .bd1 {\n        fill: #ee2325;\n      }\n\n      .bd2 {\n        fill:currentColor;\n      }\n\n      .bd3 {\n        fill: #ee2626;\n      }\n\n      .bd4 {\n        fill:currentColor;\n      }\n    </style></defs><path class=\"bd2\" d=\"M213.38,33.64c4.19,2.5,1.15,10.78-1.68,15.41-3.01,4.93-8.88,8.93-15.02,8.94l-53.95.13,5.87-18.6,6.08-17.97,6.01-12.65h55.71c2.92-.01,6.05,1,7.21,3.67,1.37,3.16-.2,6.25-1.15,9.21-1.61,5.05-3.98,9.46-9.07,11.87ZM203.99,21.71l-1.39-.87h-29.87s-2.69,7.22-2.69,7.22l30.1-.05c2.55,0,4.64-5.8,3.85-6.3ZM192.56,45.72c2.96-.01,4.6-3.89,3.74-6.67l-30.58-.12-2.66,6.91,29.51-.12Z\"/><path class=\"bd2\" d=\"M300.04,38.98l-17.41-.03,4.62-10.88,35.81-.03-8.06,19.43c-2.57,6.2-9.4,9.7-15.83,10.68l-40.73-.16c-3.41-.01-6.86-2.28-8.48-4.72-2.15-3.23-.79-6.33.45-9.44l7.42-18.61c1.16-2.9,2.36-6.05,4.33-8.39,5.4-6.4,13.27-8.26,21.34-8.13l12.68.2,35.39-.16-5.43,12.08-44.68-.02c-2,0-4,1.39-4.95,2.85l-7.84,18.79.12,2.31c.03.5,1.17.84,1.83,1.08l24.58.02c1.18-.18,2.47-1.05,2.86-2.01l1.99-4.87Z\"/><path class=\"bd1\" d=\"M391.51,46.11c-2.45,6.38-10.55,11.89-16.24,11.9l-50.33.07,11.41-28.63,8.52-20.7,50.07.14c2.67,0,5.06,2.73,6.08,3.81,1.52,2.83,1.35,5.24.29,7.9l-9.79,25.52ZM377.79,41.11l6.78-17.12c.34-.86.12-2.38-.52-3.22h-28.78s-4.62,11.61-4.62,11.61l-5.13,13.39h27.86c2.48.01,3.6-2.62,4.41-4.65Z\"/><polygon class=\"bd1\" points=\"553.77 20.65 533.53 42.99 520.06 58.09 502.91 57.98 533.47 23.38 546.66 8.77 568.42 8.81 576.02 58.07 534.09 58.06 539.1 45.79 557.45 45.79 553.77 20.65\"/><polygon class=\"bd1\" points=\"439.87 20.87 421.39 41.62 413.74 50.21 406.76 58.05 389.84 58.04 399.43 46.7 412.57 31.8 433.19 8.71 454.46 8.82 460.03 46.73 461.91 58.06 421.01 58.08 425.71 45.81 443.9 45.78 439.87 20.87\"/><path class=\"bd3\" d=\"M111.09,46.07l.29.05,12.49.13-15.65,28.16c-1.12,2.01-2.72,4.02-5.32,4.02l-83.9.03c-3.07,0-4.26-1.56-5.24-4.1l-4.03-10.47,22.94-.04,4.28-3.7.95,2.54c.24.63,1.96,1.63,2.47,1.09l3.37-3.55,6.85,17.38,18.73-18.95,32.77-.04c1.79,0,2.78-1.01,3.55-2.44l5.44-10.1Z\"/><path class=\"bd2\" d=\"M13.4,27.17l7.2,18.65-6.33,1.73c-1.4.3-3.08.34-4.74.17L0,26.6,17.6,2.71C18.82,1.07,20.15-.03,22.42.04l97.07.03-16.17,9.36-74.03-.02c-1.77,0-3.46.66-4.4,1.95l-11.49,15.81Z\"/><polygon class=\"bd1\" points=\"490.1 58.06 473.76 58.05 488.38 20.76 466.27 20.74 470.77 8.81 531.4 8.75 526.34 20.73 504.13 20.77 494.02 47.77 490.1 58.06\"/><polygon class=\"bd2\" points=\"218.15 58.1 223.8 43.28 229.91 27.82 237.21 8.89 255.65 8.79 251.34 19.8 236.09 58.11 218.15 58.1\"/><path class=\"bd2\" d=\"M111.38,46.12l-.29-.05-4.81.26-4.08,7.29h-25.59s4.9-4.92,4.9-4.92l14.25.03c1.3,0,3.49-.58,4.44-1.44l16.25-30.11-7.44-.42c-.44-.74-.85-2.27-.77-3.12L135.38,0l-23.99,46.12Z\"/><path class=\"bd3\" d=\"M81.51,48.7l-4.9,4.92h-8.26s-15.56,15.31-15.56,15.31l-7.09-16.64-4.05,3.68-1.71-5.05-7.93,8.05H7.89s-2.17-5.04-2.17-5.04l13.72-.04,11.78-.05,10.55-11.72,2.45,5.88c1.13-1.42,3.99-2.03,4.53-.72l5.69,13.74,12.92-12.34,14.14.03Z\"/><polygon class=\"bd4\" points=\"33.53 25.02 27.38 24.95 27.89 19 34.22 19 33.53 25.02\"/><polygon class=\"bd4\" points=\"73.95 24.99 67.9 24.87 68.26 19.05 74.56 18.88 73.95 24.99\"/><polygon class=\"bd4\" points=\"87.18 24.95 81.11 24.88 81.59 19.09 87.84 18.89 87.18 24.95\"/><path class=\"bd4\" d=\"M47.3,24.58c-1.73.61-4.27.58-6.2.1l.65-5.78,6.04.05-.49,5.62Z\"/><path class=\"bd4\" d=\"M60.7,24.99h-5.88c.05-2.34.21-3.92.59-6.04h5.83s-.54,6.04-.54,6.04Z\"/><path class=\"bd4\" d=\"M100.38,24.43c-1.54.81-3.77.72-5.95.26l.53-5.69,5.97-.08-.54,5.5Z\"/><polygon class=\"bd4\" points=\"98.99 37.85 92.67 37.9 93.41 32.07 99.62 32.02 98.99 37.85\"/><polygon class=\"bd2\" points=\"45.82 37.87 39.57 37.84 40.24 32.02 46.37 32.02 45.82 37.87\"/><polygon class=\"bd2\" points=\"59.13 37.9 53.06 37.9 53.58 32.11 59.75 32.03 59.13 37.9\"/><polygon class=\"bd4\" points=\"72.46 37.85 66.47 37.95 66.95 32.09 73.1 32 72.46 37.85\"/><polygon class=\"bd2\" points=\"32.08 37.87 26.04 37.88 26.58 32.09 32.68 32 32.08 37.87\"/><polygon class=\"bd2\" points=\"85.8 37.85 79.74 37.92 80.3 32.14 86.33 32.01 85.8 37.85\"/><g><path class=\"bd0\" d=\"M142.54,74.09v-8.94h1.67v8.94h-1.67ZM144.1,74.09v-1.2h1.21c1.18,0,2.06-.26,2.65-.79.59-.52.89-1.31.89-2.36,0-1.14-.3-1.99-.89-2.55-.59-.56-1.48-.85-2.65-.85h-1.18l-.19-1.2h1.37c3.49,0,5.23,1.53,5.23,4.59,0,2.9-1.74,4.34-5.23,4.34h-1.21Z\"/><path class=\"bd0\" d=\"M151.44,74.09l3.3-8.94h2.33l3.3,8.94h-1.69l-2.71-7.85h-.15l-2.71,7.85h-1.69ZM152.97,71.91v-1.2h5.8v1.2h-5.8Z\"/><path class=\"bd0\" d=\"M161.38,66.35v-1.2h8.37v1.2h-8.37ZM164.73,74.09v-8.94h1.67v8.94h-1.67Z\"/><path class=\"bd0\" d=\"M170.76,74.09l3.3-8.94h2.33l3.3,8.94h-1.69l-2.71-7.85h-.15l-2.71,7.85h-1.69ZM172.29,71.91v-1.2h5.8v1.2h-5.8Z\"/><path class=\"bd0\" d=\"M191.01,74.09v-8.94h1.67v8.94h-1.67ZM191.01,74.09v-1.2h7.57v1.2h-7.57Z\"/><path class=\"bd0\" d=\"M204.22,74.21c-2.81,0-4.22-1.51-4.22-4.53s1.41-4.66,4.22-4.66,4.22,1.55,4.22,4.66-1.41,4.53-4.22,4.53ZM204.22,73.05c1.66,0,2.5-1.12,2.5-3.37s-.83-3.5-2.5-3.5-2.5,1.17-2.5,3.5.83,3.37,2.5,3.37Z\"/><path class=\"bd0\" d=\"M214.7,74.21c-1.71,0-2.99-.38-3.84-1.15-.85-.77-1.28-1.92-1.28-3.46,0-1.46.44-2.58,1.33-3.38s2.13-1.2,3.73-1.2c.8,0,1.5.1,2.1.29s1.04.47,1.33.83l-1.2.93c-.25-.29-.56-.5-.93-.66s-.77-.23-1.2-.23c-1.08,0-1.93.29-2.53.88-.6.59-.9,1.41-.9,2.48,0,1.17.3,2.05.9,2.63s1.5.88,2.69.88c.51,0,.96-.04,1.35-.12.39-.08.71-.14.95-.2l.63,1.09c-.23.05-.62.13-1.19.23-.57.1-1.21.15-1.94.15ZM213.96,70.81v-1.2h3.82v1.2h-3.82ZM216.23,73.83v-4.22h1.59v4.22h-1.59Z\"/><path class=\"bd0\" d=\"M231.96,74.09l-3.22-8.94h1.72l2.67,7.87h.15l2.67-7.87h1.72l-3.22,8.94h-2.5Z\"/><path class=\"bd0\" d=\"M239.39,66.35v-1.2h6.96v1.2h-6.96ZM239.39,74.09v-1.2h6.96v1.2h-6.96ZM242.02,74.09v-8.94h1.67v8.94h-1.67Z\"/><path class=\"bd0\" d=\"M248.99,74.09v-8.94h1.67v8.94h-1.67ZM248.99,66.35v-1.2h7.57v1.2h-7.57ZM248.99,70.21v-1.2h6.12v1.2h-6.12ZM248.99,74.09v-1.2h7.57v1.2h-7.57Z\"/><path class=\"bd0\" d=\"M258.81,74.09l-1.29-8.94h1.69l.97,7.93h.16l1.05-5.67h1.61l-.54,1.25h-.32l-.85,5.43h-2.49ZM263.08,74.09l-.85-5.43h-.32l-.52-1.25h1.61l1.04,5.67h.16l.97-7.93h1.69l-1.29,8.94h-2.49Z\"/><path class=\"bd0\" d=\"M268.31,74.09v-8.94h1.67v8.94h-1.67ZM268.31,66.35v-1.2h7.57v1.2h-7.57ZM268.31,70.21v-1.2h6.12v1.2h-6.12ZM268.31,74.09v-1.2h7.57v1.2h-7.57Z\"/><path class=\"bd0\" d=\"M277.81,74.09v-8.94h1.67v8.94h-1.67ZM279.37,70.69v-1.2h2.37c.64,0,1.14-.13,1.49-.4.36-.26.54-.64.54-1.11,0-.52-.18-.93-.54-1.21-.36-.28-.85-.42-1.49-.42h-2.33l-.19-1.2h2.53c1.19,0,2.1.24,2.75.71.65.47.97,1.14.97,2s-.32,1.59-.97,2.09c-.65.5-1.56.74-2.75.74h-2.37ZM283.95,74.09l-2.56-4.2h1.77l2.72,4.2h-1.93Z\"/><path class=\"bd0\" d=\"M297.46,74.09v-8.94h1.67v8.94h-1.67ZM297.46,66.35v-1.2h7.57v1.2h-7.57ZM297.46,70.59v-1.2h6.12v1.2h-6.12Z\"/><path class=\"bd0\" d=\"M310.5,74.21c-2.81,0-4.22-1.51-4.22-4.53s1.41-4.66,4.22-4.66,4.22,1.55,4.22,4.66-1.41,4.53-4.22,4.53ZM310.5,73.05c1.66,0,2.5-1.12,2.5-3.37s-.83-3.5-2.5-3.5-2.5,1.17-2.5,3.5.83,3.37,2.5,3.37Z\"/><path class=\"bd0\" d=\"M316.46,74.09v-8.94h1.67v8.94h-1.67ZM318.02,70.69v-1.2h2.37c.64,0,1.14-.13,1.49-.4.36-.26.54-.64.54-1.11,0-.52-.18-.93-.54-1.21-.36-.28-.85-.42-1.49-.42h-2.33l-.19-1.2h2.53c1.19,0,2.1.24,2.75.71.65.47.97,1.14.97,2s-.32,1.59-.97,2.09c-.65.5-1.56.74-2.75.74h-2.37ZM322.6,74.09l-2.56-4.2h1.77l2.72,4.2h-1.93Z\"/><path class=\"bd0\" d=\"M335.79,74.09v-8.94h1.67v8.94h-1.67ZM336.12,70.23v-1.2h6.77v1.2h-6.77ZM341.52,74.09v-8.94h1.67v8.94h-1.67Z\"/><path class=\"bd0\" d=\"M345.67,66.35v-1.2h6.96v1.2h-6.96ZM345.67,74.09v-1.2h6.96v1.2h-6.96ZM348.31,74.09v-8.94h1.67v8.94h-1.67Z\"/><path class=\"bd0\" d=\"M359.63,74.21c-1.71,0-2.99-.38-3.84-1.15-.85-.77-1.28-1.92-1.28-3.46,0-1.46.44-2.58,1.33-3.38s2.13-1.2,3.73-1.2c.8,0,1.5.1,2.1.29s1.04.47,1.33.83l-1.2.93c-.25-.29-.56-.5-.93-.66s-.77-.23-1.2-.23c-1.08,0-1.93.29-2.53.88-.6.59-.9,1.41-.9,2.48,0,1.17.3,2.05.9,2.63s1.5.88,2.69.88c.51,0,.96-.04,1.35-.12.39-.08.71-.14.95-.2l.63,1.09c-.23.05-.62.13-1.19.23-.57.1-1.21.15-1.94.15ZM358.89,70.81v-1.2h3.82v1.2h-3.82ZM361.17,73.83v-4.22h1.59v4.22h-1.59Z\"/><path class=\"bd0\" d=\"M364.77,74.09v-8.94h1.67v8.94h-1.67ZM365.11,70.23v-1.2h6.77v1.2h-6.77ZM370.5,74.09v-8.94h1.67v8.94h-1.67Z\"/><path class=\"bd0\" d=\"M374.11,70.21v-1.17h8.05v1.17h-8.05Z\"/><path class=\"bd0\" d=\"M384.26,74.09v-8.94h1.67v8.94h-1.67ZM385.74,71.32v-1.2h1.88c.88,0,1.55-.17,2-.51.45-.34.68-.84.68-1.5,0-.58-.23-1.02-.68-1.32-.45-.3-1.12-.45-2-.45h-1.85v-1.2h1.85c1.43,0,2.52.25,3.26.75s1.11,1.24,1.11,2.21c0,1.05-.37,1.85-1.11,2.4-.74.54-1.82.81-3.26.81h-1.88Z\"/><path class=\"bd0\" d=\"M393.92,74.09v-8.94h1.67v8.94h-1.67ZM393.92,66.35v-1.2h7.57v1.2h-7.57ZM393.92,70.21v-1.2h6.12v1.2h-6.12ZM393.92,74.09v-1.2h7.57v1.2h-7.57Z\"/><path class=\"bd0\" d=\"M403.42,74.09v-8.94h1.67v8.94h-1.67ZM404.98,70.69v-1.2h2.37c.64,0,1.14-.13,1.49-.4.36-.26.54-.64.54-1.11,0-.52-.18-.93-.54-1.21-.36-.28-.85-.42-1.49-.42h-2.33l-.19-1.2h2.53c1.19,0,2.1.24,2.75.71.65.47.97,1.14.97,2s-.32,1.59-.97,2.09c-.65.5-1.56.74-2.75.74h-2.37ZM409.56,74.09l-2.56-4.2h1.77l2.72,4.2h-1.93Z\"/><path class=\"bd0\" d=\"M413.41,74.09v-8.94h1.67v8.94h-1.67ZM413.41,66.35v-1.2h7.57v1.2h-7.57ZM413.41,70.59v-1.2h6.12v1.2h-6.12Z\"/><path class=\"bd0\" d=\"M426.45,74.21c-2.81,0-4.22-1.51-4.22-4.53s1.41-4.66,4.22-4.66,4.22,1.55,4.22,4.66-1.41,4.53-4.22,4.53ZM426.45,73.05c1.66,0,2.5-1.12,2.5-3.37s-.83-3.5-2.5-3.5-2.5,1.17-2.5,3.5.83,3.37,2.5,3.37Z\"/><path class=\"bd0\" d=\"M432.41,74.09v-8.94h1.67v8.94h-1.67ZM433.97,70.69v-1.2h2.37c.64,0,1.14-.13,1.49-.4.36-.26.54-.64.54-1.11,0-.52-.18-.93-.54-1.21-.36-.28-.85-.42-1.49-.42h-2.33l-.19-1.2h2.53c1.19,0,2.1.24,2.75.71.65.47.97,1.14.97,2s-.32,1.59-.97,2.09c-.65.5-1.56.74-2.75.74h-2.37ZM438.54,74.09l-2.56-4.2h1.77l2.72,4.2h-1.93Z\"/><path class=\"bd0\" d=\"M441.97,74.09v-8.94h1.61v8.94h-1.61ZM445.03,70.44l-1.24-3.7h-.47v-1.59h1.14l1.24,3.84h.06l.16,1.45h-.9ZM445.5,70.44l.24-1.45h.1l1.24-3.84h1.14v1.59h-.47l-1.24,3.7h-1.01ZM447.96,74.09v-8.94h1.61v8.94h-1.61Z\"/><path class=\"bd0\" d=\"M450.97,74.09l3.3-8.94h2.33l3.3,8.94h-1.69l-2.71-7.85h-.14l-2.71,7.85h-1.69ZM452.5,71.91v-1.2h5.8v1.2h-5.8Z\"/><path class=\"bd0\" d=\"M461.46,74.09v-8.94h1.67v8.94h-1.67ZM466.58,74.09l-3.29-6.8h-.74v-2.14h1.06l3.29,6.8h.4v2.14h-.72ZM467.06,74.09v-8.94h1.67v8.94h-1.67Z\"/><path class=\"bd0\" d=\"M475.95,74.21c-3.55,0-5.33-1.54-5.33-4.61,0-1.46.45-2.58,1.34-3.38s2.16-1.2,3.79-1.2c.79,0,1.48.1,2.06.29s1.01.47,1.28.83l-1.19.92c-.24-.29-.55-.5-.92-.66s-.78-.23-1.21-.23c-1.04,0-1.87.29-2.49.88s-.94,1.41-.94,2.49c0,2.34,1.29,3.51,3.88,3.51.78,0,1.55-.13,2.3-.38l.37,1.11c-.93.29-1.92.43-2.95.43Z\"/><path class=\"bd0\" d=\"M480.88,74.09v-8.94h1.67v8.94h-1.67ZM480.88,66.35v-1.2h7.57v1.2h-7.57ZM480.88,70.21v-1.2h6.12v1.2h-6.12ZM480.88,74.09v-1.2h7.57v1.2h-7.57Z\"/><path class=\"bd0\" d=\"M502.5,74.09l-3.22-8.94h1.72l2.67,7.87h.14l2.67-7.87h1.72l-3.22,8.94h-2.5Z\"/><path class=\"bd0\" d=\"M509.87,74.09v-8.94h1.67v8.94h-1.67ZM509.87,66.35v-1.2h7.57v1.2h-7.57ZM509.87,70.21v-1.2h6.12v1.2h-6.12ZM509.87,74.09v-1.2h7.57v1.2h-7.57Z\"/><path class=\"bd0\" d=\"M519.37,74.09v-8.94h1.67v8.94h-1.67ZM519.71,70.23v-1.2h6.77v1.2h-6.77ZM525.1,74.09v-8.94h1.67v8.94h-1.67Z\"/><path class=\"bd0\" d=\"M529.26,66.35v-1.2h6.96v1.2h-6.96ZM529.26,74.09v-1.2h6.96v1.2h-6.96ZM531.89,74.09v-8.94h1.67v8.94h-1.67Z\"/><path class=\"bd0\" d=\"M543.59,74.21c-3.55,0-5.33-1.54-5.33-4.61,0-1.46.45-2.58,1.34-3.38s2.16-1.2,3.79-1.2c.79,0,1.48.1,2.06.29s1.01.47,1.28.83l-1.19.92c-.24-.29-.55-.5-.92-.66s-.78-.23-1.21-.23c-1.04,0-1.87.29-2.49.88s-.94,1.41-.94,2.49c0,2.34,1.29,3.51,3.88,3.51.78,0,1.55-.13,2.3-.38l.37,1.11c-.93.29-1.92.43-2.95.43Z\"/><path class=\"bd0\" d=\"M548.52,74.09v-8.94h1.67v8.94h-1.67ZM548.52,74.09v-1.2h7.57v1.2h-7.57Z\"/><path class=\"bd0\" d=\"M558.18,74.09v-8.94h1.67v8.94h-1.67ZM558.18,66.35v-1.2h7.57v1.2h-7.57ZM558.18,70.21v-1.2h6.12v1.2h-6.12ZM558.18,74.09v-1.2h7.57v1.2h-7.57Z\"/><path class=\"bd0\" d=\"M570.99,74.21c-.65,0-1.26-.04-1.82-.12-.57-.08-1.09-.2-1.57-.37l.21-1.27c.59.2,1.16.35,1.71.45s1.09.15,1.61.15c.75,0,1.31-.1,1.67-.31.37-.21.55-.52.55-.94,0-.53-.35-.92-1.05-1.17l-1.98-.71c-.78-.28-1.38-.61-1.79-1-.42-.39-.62-.88-.62-1.45,0-.78.3-1.38.9-1.81.6-.43,1.45-.64,2.55-.64.77,0,1.45.09,2.04.26.59.18,1.16.46,1.71.86l-1.13.89c-.47-.3-.91-.52-1.33-.66-.41-.14-.84-.21-1.28-.21-.55,0-.98.1-1.28.31-.3.21-.46.52-.46.92,0,.29.1.53.3.71.2.18.49.35.88.49l1.67.62c.85.31,1.49.66,1.93,1.05.44.39.66.89.66,1.5,0,.81-.34,1.42-1.01,1.82s-1.69.61-3.06.61Z\"/></g></svg>";
var VIEWER_UNIT_BY_CHANNEL = {};
var VIEWER_RESOLVED_ROLES = {}; // roleId -> actual channel name, for this log
var VIEWER_CHANNEL_STATS = {}; // channel name -> {min,max,avg}, computed once per log
var viewerCharts = {}; // key "panel1"/"panel2" -> Chart instance
var viewerGaugeEls = {}; // gaugeId -> DOM element, for Gauge View updates
var CROSSHAIR_TIME = null;
var VIEWER_SYNCING = false;
// ---- Visible time range (the zoom window) ----------------------------------------------------
// Chart.js stays the store of record for the window (scales.x.min/max on the panels); nothing here
// caches it. These hold only the modules that asked to be told when it moves (Histograms/scorecards
// evaluate over the visible window) and the one guard that stops a listener which itself calls
// setVisibleRange from recursing. See getVisibleRange / setVisibleRange / notifyVisibleRangeChanged.
var VIEWER_RANGE_LISTENERS = [];
var VIEWER_RANGE_NOTIFYING = false;
// Never zoom past ~0.4% of the run, or the scrubber handles become ungrabbable. Was local to
// wireScrubberEvents; hoisted so setVisibleRange applies the same floor to callers outside it.
var MIN_WINDOW_FRAC = 0.004;
// How far the zoom window may hang past either end of the log, as a fraction of its own width, at a
// deep zoom -- tapering to nothing as the window grows to the whole log (see visibleRangeBounds).
// Ken (2026-09-09): a race log ends at the finish line (engine off), so the samples that matter sat
// hard against the graph's right edge and could not be dragged into the clear.
var VIEWER_OVERSCROLL_FRAC = 0.5;
var VIEWER_ACTIVE_PRESET = null;
var VIEWER_VIEW_MODE = 'default'; // 'default' | 'gauge' | 'graph' | 'histograms'
// Only meaningful while VIEWER_VIEW_MODE==='gauge' -- which of the two sub-views the Gauges tab is
// showing: the log's own auto-matched fascia, or the tuner's free-position Custom Dash. Replaces the
// old separate 'customdash' top-level mode (Ken, 2026-09-08: "only have graph, gauges, histograms...
// within the gauges tab it can show either default gauges or custom gauges").
var VIEWER_GAUGE_SUBMODE = 'default'; // 'default' | 'custom'
var VIEWER_SUBMODE_WANTED = null;     // the sub-view the last log open asked for, before Pro/dash clamps
var VIEWER_MANUAL_PRESET_OVERRIDE = null; // preset id, or null = Auto
var VIEWER_LEFT_COLLAPSED = false;
var VIEWER_GAUGE_U = null;     // gauge scale unit (px) set by dragging the splitter; null = automatic
var VIEWER_SEARCH = '';
var VIEWER_SORT = { col: 'name', dir: 1 };
var VIEWER_CARDS_EXPANDED = false;
var VIEWER_CARDS_MAX_COLLAPSED = 8;
var VIEWER_CHANNEL_VALUE_ELS = {}; // channel name -> the <span data-ch-value> currently in the DOM (only visible/filtered rows), refreshed after every table (re)render so updateAtCursor can just textContent= them with no re-render
// Per-panel (slot -> {top, right, scale}) in-graph legend position/size, set by dragging the legend
// block or its resize handle -- see wireGraphLegends(). Absent = the CSS default (top-right corner,
// scale 1). A workspace convenience like graphCount/gaugeU below, not saved-view content.
var VIEWER_LEGEND_POS = {};

// ---- Session persistence (per Ken: view mode + manual preset override should survive across
// logs opened in the same tab session, but not permanently; sessionStorage clears on tab close). --
var PREFS_KEY = 'pbdDatalogViewerPrefs';
function loadViewerPrefs(){
  try{
    var raw = sessionStorage.getItem(PREFS_KEY);
    if(!raw){
      // No session yet (fresh tab / app start): the Default-vs-Custom choice also lives in localStorage
      // so the desktop app comes back on the dash you had open (Ken, 2026-09-09).
      try { var m = window.localStorage ? localStorage.getItem('pbdDatalogViewerDashMode.v1') : null; if(m === 'custom' || m === 'default') VIEWER_GAUGE_SUBMODE = m; } catch(e2){}
      return;
    }
    var p = JSON.parse(raw);
    if(p.viewMode) VIEWER_VIEW_MODE = p.viewMode;
    if(p.presetOverride !== undefined) VIEWER_MANUAL_PRESET_OVERRIDE = p.presetOverride;
    if(p.leftCollapsed !== undefined) VIEWER_LEFT_COLLAPSED = p.leftCollapsed;
    if(p.gaugeU !== undefined) VIEWER_GAUGE_U = p.gaugeU;
    if(p.graphCount) VIEWER_GRAPH_COUNT = p.graphCount;
    if(p.legendPos) VIEWER_LEGEND_POS = p.legendPos;
    if(p.gaugeSubmode) VIEWER_GAUGE_SUBMODE = p.gaugeSubmode;
    if(p.lastSaved && p.lastSaved.id) VIEWER_LAST_SAVED = p.lastSaved;
  } catch(e){ /* sessionStorage unavailable (private mode etc.) -- just use defaults */ }
  // (The old clamp back to 'default' is gone: it existed only while Gauge/Graph View were disabled
  // in the picker. Views are selectable now, and openViewerCore sets the mode from the active view.)
}
function saveViewerPrefs(){
  try{
    sessionStorage.setItem(PREFS_KEY, JSON.stringify({
      viewMode: VIEWER_VIEW_MODE,
      presetOverride: VIEWER_MANUAL_PRESET_OVERRIDE,
      leftCollapsed: VIEWER_LEFT_COLLAPSED,
      gaugeU: VIEWER_GAUGE_U,
      graphCount: VIEWER_GRAPH_COUNT,
      legendPos: VIEWER_LEGEND_POS,
      gaugeSubmode: VIEWER_GAUGE_SUBMODE,
      lastSaved: VIEWER_LAST_SAVED,
    }));
  } catch(e){ /* ignore */ }
  try { if(window.localStorage) localStorage.setItem('pbdDatalogViewerDashMode.v1', VIEWER_GAUGE_SUBMODE); } catch(e){ /* ignore */ }
}

// A single Chart.js plugin instance, registered once, draws a shared vertical crosshair line on
// whichever panel(s) it's attached to -- CROSSHAIR_TIME is a data x-value (seconds), so each panel
// converts it to its own pixel position independently via that panel's own x scale.
// The crosshair is drawn on its OWN transparent canvas over each panel, not by a Chart.js plugin.
// As a plugin it could only move by redrawing the chart, and a redraw draws every trace: on a
// 524-channel, 3000-sample log with four panels (~6000 points each) that measured 39 ms a frame --
// 20 fps to move a one-pixel line (Ken, 2026-09-10: "it's better but still lag on the cursor line").
// On its own canvas a move is one clear and one stroke, and the traces are never touched.
//
// Everything else that a plugin draws (the perf markers, the log-edge wash, the highlight spans)
// changes only on a discrete action, so those stay plugins and still ride a chart repaint.
var VIEWER_XHAIR = {};              // wrapId -> canvas
function crosshairCanvasFor(wrap){
  if(!wrap) return null;
  var cv = wrap.querySelector('canvas.dlv-xhair');
  if(!cv){
    cv = document.createElement('canvas');
    cv.className = 'dlv-xhair';
    cv.setAttribute('aria-hidden', 'true');
    wrap.appendChild(cv);
  }
  return cv;
}
// Backing store in device pixels, CSS box from the wrap -- a 1px line has to stay 1px on a 150% display.
function sizeCrosshairCanvas(cv, wrap){
  var dpr = window.devicePixelRatio || 1;
  var w = Math.max(1, Math.round(wrap.clientWidth * dpr)), h = Math.max(1, Math.round(wrap.clientHeight * dpr));
  if(cv.width !== w || cv.height !== h){ cv.width = w; cv.height = h; }
  return dpr;
}
function drawCrosshairOverlays(){
  var slots = activeGraphSlots();
  for(var i = 0; i < slots.length; i++){
    var slot = slots[i];
    var wrap = document.getElementById('dlvCanvasWrap' + slot);
    if(!wrap) continue;
    var chart = viewerCharts['panel' + slot] || viewerCharts[slot];
    var cv = wrap.querySelector('canvas.dlv-xhair');
    if(!cv) continue;
    var dpr = sizeCrosshairCanvas(cv, wrap);
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cv.width / dpr, cv.height / dpr);
    if(CROSSHAIR_TIME == null || !chart || !chart.scales || !chart.scales.x || !chart.chartArea) continue;
    var area = chart.chartArea;
    var x = chart.scales.x.getPixelForValue(CROSSHAIR_TIME);
    if(!isFinite(x) || x < area.left || x > area.right) continue;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x, area.top);
    ctx.lineTo(x, area.bottom);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.setLineDash([4, 4]);
    ctx.stroke();
    ctx.restore();
  }
}

// When the window overhangs an end of the log (setVisibleRange lets it, by up to half its width) the
// empty part gets a faint wash, a dashed line where the log starts/ends and a small label, so the gap
// reads as "no more log" rather than a dropout. Only the viewer's own panels are touched.
var pbdLogEdgePlugin = {
  id: 'pbdLogEdge',
  afterDraw: function(chart){
    if(!VIEWER_DATA || !VIEWER_DATA.time || !VIEWER_DATA.time.length) return;
    var mine = false, k;
    for(k in viewerCharts){ if(viewerCharts[k] === chart){ mine = true; break; } }
    if(!mine) return;
    var xs = chart.scales.x, area = chart.chartArea;
    if(!xs || !area) return;
    var T = VIEWER_DATA.time, fullMin = T[0], fullMax = T[T.length - 1], eps = 1e-9, ctx = chart.ctx;
    function edge(t, beyondLeft){
      var px = xs.getPixelForValue(t);
      if(!(px > area.left + 0.5 && px < area.right - 0.5)) return;
      ctx.save();
      ctx.fillStyle = 'rgba(255,255,255,0.035)';
      if(beyondLeft) ctx.fillRect(area.left, area.top, px - area.left, area.bottom - area.top);
      else ctx.fillRect(px, area.top, area.right - px, area.bottom - area.top);
      ctx.beginPath(); ctx.moveTo(px, area.top); ctx.lineTo(px, area.bottom);
      ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,255,255,0.28)'; ctx.setLineDash([3, 5]); ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = '10px system-ui, -apple-system, Segoe UI, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.textBaseline = 'bottom';
      ctx.textAlign = beyondLeft ? 'right' : 'left';
      ctx.fillText(beyondLeft ? 'log start' : 'log end', beyondLeft ? px - 4 : px + 4, area.bottom - 3);
      ctx.restore();
    }
    if(xs.min < fullMin - eps) edge(fullMin, true);
    if(xs.max > fullMax + eps) edge(fullMax, false);
  }
};
if(window.Chart) Chart.register(pbdLogEdgePlugin);

function getCurrentVehicleMeta(){
  // Prefer a host-supplied vehicle object (meta.vehicle) -- it works on the ticket path (no vehicleId
  // in CURRENT_VEHICLES) and carries the resolved platform fields. Else fall back to the customer
  // path's CURRENT_VEHICLES lookup by VIEWER_VEHICLE_ID.
  if(VIEWER_VEHICLE_META) return VIEWER_VEHICLE_META;
  var entry = (window.CURRENT_VEHICLES || []).filter(function(v){ return v.vehicle.id === VIEWER_VEHICLE_ID; })[0];
  return entry ? entry.vehicle : {};
}

// ---- Analytics (optional host hook) -----------------------------------------------------------
// The engine stays analytics-AGNOSTIC (it also ships to the PBD Control Center): it fires events only
// through an optional host hook, window.ADL_ANALYTICS.track(name, props), which apps/web wires to
// posthog.capture. No dependency, never throws if the hook is absent. Event names/props are the contract
// in the PostHog spec. Host-only events (csv_exported, hpl_limit paywall, pageview/signup/checkout/
// pro_activated) are NOT emitted here.
function adlTrack(name, props){
  try {
    var a = window.ADL_ANALYTICS;
    if(a && typeof a.track === 'function') a.track(name, props || {});
  } catch(e){}
}
var ADL_LOG_OPENS = 0;   // per page-load, so is_first_open marks the first open in THIS session (the host
                         // also has person props for true first-ever; this is the engine's honest signal)
function adlLogFormat(){
  var n = (VIEWER_FILE_NAME || '').toLowerCase();
  if(/\.hpl$/.test(n)) return 'hpl';
  if(/\.ld$/.test(n))  return 'ld';
  if(/\.csv$/.test(n)) return 'csv';
  if(/\.msl$/.test(n) || /\.mlg$/.test(n)) return 'msl';   // MegaSquirt / TunerStudio text log
  var ext = n.indexOf('.') >= 0 ? n.split('.').pop() : '';
  return ext || 'unknown';
}

function openViewer(vehicleId, configId, fileName, downloadUrl){
  loadViewerPrefs();
  VIEWER_VEHICLE_ID = vehicleId; VIEWER_CONFIG_ID = configId;
  openViewerCore(
    apiCall('vehicle-files', { action:'view_log', vehicleId: vehicleId, configurationId: configId, fileName: fileName }),
    { fileName: fileName, downloadUrl: downloadUrl || null }
  );
}

// Generic staff/admin entry point (2026-07-20, ticket "View Log" button): shares the exact same
// rendering pipeline as the customer openViewer() above via openViewerCore, but the caller
// supplies its own already-in-flight fetch Promise (resolving to {ok, data}) instead of this file
// calling the customer-scoped apiCall('vehicle-files', {action:'view_log', vehicleId,
// configurationId, ...}) itself. Lets a host page like tickets-widget.js (staff auth, a raw
// Dropbox path resolved through a ticket rather than a vehicleId/configurationId) reuse every bit
// of the viewer's state/rendering logic without this file needing to know anything about staff
// auth headers, ticket ids, or Dropbox paths.
// While the full-viewport viewer is open, lock scrolling on the host page behind it so wheel/scroll
// chaining can't move the underlying page. Invisible on the short data-logs.html page, but visible
// when the viewer is embedded in a tall host (e.g. the staff ticket UI's "View Log"). Stash + restore
// the prior value rather than blanking it, so a host that set its own body overflow is left as found.
var VIEWER_PREV_BODY_OVERFLOW = '';
function openViewerFromPromise(fetchPromise, meta){
  loadViewerPrefs();
  VIEWER_VEHICLE_ID = null; VIEWER_CONFIG_ID = null;
  openViewerCore(fetchPromise, meta || {});
}

function openViewerCore(fetchPromise, meta){
  meta = meta || {};
  VIEWER_FILE_NAME = meta.fileName || '';
  VIEWER_DOWNLOAD_URL = meta.downloadUrl || null;
  VIEWER_VEHICLE_META = meta.vehicle || null;   // host-supplied vehicle identity (see getCurrentVehicleMeta)
  VIEWER_AUTO_CONFIG = meta.autoConfig || null; // host-resolved config to auto-load (applied at end of load)
  VIEWER_VEHICLE_CONFIGS = Array.isArray(meta.vehicleConfigs) ? meta.vehicleConfigs : [];  // all car configs
  var overlay = document.getElementById('viewerOverlay');
  overlay.classList.add('dlv-fullscreen');
  overlay.classList.toggle('dlv-header-pinned', hostPinsHeader());
  overlay.classList.add('open');
  // The floating support-chat bubble (chat-widget.js, #pbdChatPreview) is fixed bottom-right on
  // every page and would otherwise float on top of the full-viewport viewer -- hide it while open.
  var chatBubble = document.getElementById('pbdChatPreview');
  if(chatBubble) chatBubble.style.display = 'none';
  VIEWER_PREV_BODY_OVERFLOW = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  document.getElementById('viewerContent').innerHTML = '<div class="dlv-loading"><span class="spinner lg"></span>Parsing datalog&hellip; this can take a few seconds for large files.</div>';
  fetchPromise.then(function(res){
    if(!res.ok || (res.data && res.data.error)) throw new Error((res.data && res.data.error) || 'Could not load this datalog.');
    VIEWER_DATA = res.data;
    // Full-resolution samples, when the host kept them (data.full = { time, series, textLevels, rows,
    // decimated }): histograms bin EVERY sample, not the ~12k-point display set the graphs draw. Snapshot
    // the native units now, before the display pipeline below rewrites data.units in place, so the
    // full set can be put through the identical unit/load/derived treatment afterwards.
    var fullData = null;
    if(res.data.full && res.data.full.series && res.data.full.time){
      fullData = { channels: res.data.channels.slice(), units: res.data.units.slice(),
                   series: res.data.full.series, textLevels: res.data.full.textLevels || res.data.textLevels };
    }
    VIEWER_RACE_ZERO = null;   // a zero point belongs to one capture's timeline, never the next
    VIEWER_CURSOR_TIME = null;
    VIEWER_HIGHLIGHT_SPANS = [];   // histogram "show samples" marks index THIS log's samples, never the next
    // The histogram view remounts against the new data on render; unsubscribe the old controller
    // first or its range/document listeners outlive the log they were built for.
    if(VIEWER_HIST_CTL && VIEWER_HIST_CTL.destroy){ try { VIEWER_HIST_CTL.destroy(); } catch(err){} }
    VIEWER_HIST_CTL = null;
    // hpl-to-csv stores NATIVE units, so convert to US display units once here -- before stats,
    // charts or gauges touch the data -- rather than converting per frame while scrubbing. A log
    // that already arrived in US units (a genuine HP Tuners export) passes through untouched.
    if(typeof convertUnitsForDisplay === 'function') convertUnitsForDisplay(VIEWER_DATA);
    // Order matters: units first (so derived maths works in one unit), then resolve roles (so we
    // know what's missing), then derive (which may add channels and fill a role) -- and only then
    // build the unit map and stats, so they include anything derived.
    VIEWER_RESOLVED_ROLES = resolveChannelRoles(VIEWER_DATA.channels);
    // Load arrives as a ratio (1.2) on some vehicles and a percentage (120) on others, with no unit
    // string to tell them apart -- normalise to percent before anything measures or draws it.
    // When a full-resolution set exists the decision is made ONCE, on that superset, and the same
    // factor is applied to the display set: deciding per array would let one glitch sample the
    // decimator skipped leave the graph in % and the histogram in ratio (a 100x disagreement).
    var fullRoles = null, fullScaled = null;
    if(fullData){
      if(typeof convertUnitsForDisplay === 'function') convertUnitsForDisplay(fullData);
      fullRoles = resolveChannelRoles(fullData.channels);
      if(typeof normalizeLoadScale === 'function') fullScaled = normalizeLoadScale(fullData, fullRoles);
    }
    if(fullScaled){
      fullScaled.forEach(function(ch){
        var vals = VIEWER_DATA.series[ch];
        if(!vals) return;
        for(var j = 0; j < vals.length; j++){ if(vals[j] != null && isFinite(vals[j])) vals[j] = vals[j] * 100; }
        var uIdx = VIEWER_DATA.channels.indexOf(ch);
        if(uIdx !== -1) VIEWER_DATA.units[uIdx] = '%';
      });
    } else if(typeof normalizeLoadScale === 'function') normalizeLoadScale(VIEWER_DATA, VIEWER_RESOLVED_ROLES);
    if(typeof applyDerivedChannels === 'function') applyDerivedChannels(VIEWER_DATA, VIEWER_RESOLVED_ROLES);
    VIEWER_UNIT_BY_CHANNEL = {};
    VIEWER_DATA.channels.forEach(function(c, i){ VIEWER_UNIT_BY_CHANNEL[c] = VIEWER_DATA.units[i]; });
    VIEWER_CHANNEL_STATS = computeChannelStats(VIEWER_DATA);
    // Named math channels that resolve on THIS log join the channel list as if they were real columns
    // (see injectMathChannels) -- after units/stats above so it can safely append to both.
    VIEWER_MATH_CHANNEL_NAMES = [];   // a fresh log starts clean; the list itself is global, not per-log
    injectMathChannels();
    // Same three passes over the full-resolution set, in the same order, so a histogram never bins
    // native kPa while the graph beside it reads psi -- and derived channels (Boost) exist there too.
    if(fullData){
      // Units and load scale were handled above (once, for both sets); derived channels last.
      if(typeof applyDerivedChannels === 'function') applyDerivedChannels(fullData, fullRoles);
      VIEWER_DATA.full = { time: res.data.full.time, series: fullData.series, textLevels: fullData.textLevels,
                           channels: fullData.channels, units: fullData.units,
                           rows: res.data.full.time.length, decimated: !!res.data.full.decimated };
    }

    // Estimated acceleration / chassis speed / wheel slip (datalog-accel.js): computed on the full-resolution
    // set when the host kept one, sampled to the display set -- after the full set is attached so both
    // carry the channels (graphs draw the display set, histograms bin the full one).
    injectAccelChannels();
    VIEWER_RAW_SERIES = {}; VIEWER_RAW_FULL_SERIES = {};   // a new log: nothing smoothed yet
    applyAllSmoothing();

    var cylinderCount = detectCylinderCount(VIEWER_RESOLVED_ROLES);
    var matched = selectPreset({
      manualOverrideId: VIEWER_MANUAL_PRESET_OVERRIDE,
      cylinderCount: cylinderCount,
      vehicle: getCurrentVehicleMeta(),
    });
    // Adopt the auto-matched built-in as the active view. Deep-copied so per-gauge edits can never
    // write back into the shipped preset objects (which are shared across every opened log).
    VIEWER_ACTIVE_PRESET = {
      id: matched.id, name: matched.name,
      gauges: JSON.parse(JSON.stringify(matched.gauges || [])),
      defaultGraphs: matched.defaultGraphs || { upper: [], middle: [], lower: [] },
      layout: matched.layout,
    };
    // Let a gauge fall back to its alternate identity (e.g. the λ gauges become AFR gauges on a log
    // that logs AFR, not lambda). Operates on the deep copy above, so the shared preset is untouched.
    if(typeof applyAltRoles === 'function') applyAltRoles(VIEWER_ACTIVE_PRESET.gauges, VIEWER_RESOLVED_ROLES, VIEWER_CHANNEL_STATS, VIEWER_DATA);
    VIEWER_CURRENT_LAYOUT = { kind: 'builtin', id: matched.id, name: matched.name };
    VIEWER_LAYOUT_DIRTY = false;
    // A matched gauge view means the log has the channels for it -- land there, since that's the
    // whole point of the cylinder-count auto-detection.
    //
    // The ELSE matters just as much. VIEWER_VIEW_MODE is remembered across logs (sessionStorage),
    // so opening a gauge-capable log and then one that doesn't match V8/V6 left the mode on 'gauge'
    // while the active preset carried zero gauge definitions -- the gauge view rendered completely
    // empty and read as "the gauges are broken" (Ken, 2026-07-22, opening 76a.hpl after mile.csv;
    // that log has only a total-knock channel, no per-cylinder knock, so cylinder detection can't
    // match and it falls back to the Default preset). Setting the mode without ever clearing it is
    // the bug: a remembered mode has to be re-validated against what the new log can actually show.
    //
    // A remembered Custom Dash is DIFFERENT from a remembered mode: it's a real thing the tuner built
    // this session, worth carrying to the next log opened in the same tab (build once for this car,
    // flip between pulls) -- but only if it's actually FOR this car. If none of its gauges resolve a
    // channel in the newly-opened log, it's stale (leftover from a different vehicle) and showing it
    // would just be a broken dash with no explanation, so it's dropped rather than carried silently.
    if(VIEWER_DASH && VIEWER_DASH.gauges && VIEWER_DASH.gauges.length){
      var dashStillValid = VIEWER_DASH.gauges.some(function(g){ return !!gaugeChannelFor(g); });
      if(!dashStillValid){ VIEWER_DASH = null; VIEWER_CURRENT_GAUGES = null; VIEWER_GAUGES_DIRTY = false; }
    }
    // A fresh tab / app start, or a dash that was just dropped as stale: the last custom dash comes back
    // when it fits this log, so a remembered Custom sub-view shows the dash you had, not the builder.
    if(!(VIEWER_DASH && VIEWER_DASH.gauges && VIEWER_DASH.gauges.length) && viewerIsPro()) restoreLastDash();
    // The gauges behind the Histograms tab follow the same rule: a log opened mid-edit keeps the work
    // (restored silently; this flow renders on its own), a set none of whose gauges resolve is stale.
    if(VIEWER_DASH_TARGET === 'hist') finishHistGaugesEdit(true, true);
    if(!VIEWER_HIST_DASH) VIEWER_HIST_DASH = loadHistDashLocal();
    if(histDashGauges().length && !histDashGauges().some(function(g){ return !!gaugeChannelFor(g); })) VIEWER_HIST_DASH = null;
    if(VIEWER_ACTIVE_PRESET.gauges.length) VIEWER_VIEW_MODE = 'gauge';
    else if(VIEWER_VIEW_MODE === 'gauge' && !(VIEWER_DASH && VIEWER_DASH.gauges.length)) VIEWER_VIEW_MODE = 'default';
    // Remember the sub-view that was ASKED for before either clamp below denies it: when the licence
    // resolves a moment later (the app started BY a log file, so the viewer runs before Pro is known)
    // setViewerPro can honour it instead of leaving the tuner on the fascia.
    VIEWER_SUBMODE_WANTED = VIEWER_GAUGE_SUBMODE;
    if(VIEWER_GAUGE_SUBMODE === 'custom' && !viewerIsPro()) VIEWER_GAUGE_SUBMODE = 'default';
    if(VIEWER_GAUGE_SUBMODE === 'custom' && !(VIEWER_DASH && VIEWER_DASH.gauges.length)) VIEWER_GAUGE_SUBMODE = 'default';
    if(VIEWER_GAUGE_SUBMODE === 'default' && !VIEWER_ACTIVE_PRESET.gauges.length && VIEWER_DASH && VIEWER_DASH.gauges.length) VIEWER_GAUGE_SUBMODE = 'custom';
    // Same re-validation, Pro edition: a remembered 'histograms' mode (sessionStorage) for a user who
    // is no longer Pro renders neither cards nor tables -- showsHistograms() is already gated on
    // viewerIsPro(), but nothing here was, so the top pane came up completely blank with no way back.
    if(VIEWER_VIEW_MODE === 'histograms' && !viewerIsPro()) VIEWER_VIEW_MODE = 'default';

    pickDefaultChannels();
    // Phone opens with the graph owning the screen; the channel drawer is one big tap away. On
    // desktop the panel is a peer of the content, on mobile it covers it, so defaulting it open
    // would mean every log opens with the data hidden behind a list.
    if(isMobileViewer()) VIEWER_LEFT_COLLAPSED = true;
    VIEWER_HINT_DONE = false;    // one hint per opened log, not per re-render
    // A slip belongs to the run that was logged, so it must not survive into the next file --
    // carrying it over would draw one car's increments on another car's pull.
    VIEWER_PERF = null;
    VIEWER_RACE_ZERO = null;
    renderViewerBody();
    watchMobileBreakpoint();
    // Activation event (the North Star). is_first_open is per page-session here; the host refines
    // true-first via person properties. file_source: a stored/cloud file has a downloadUrl.
    ADL_LOG_OPENS++;
    adlTrack('log_opened', {
      format: adlLogFormat(),
      file_source: meta.source || (VIEWER_DOWNLOAD_URL ? 'cloud' : 'local'),
      device: isMobileViewer() ? 'mobile' : 'desktop',
      is_first_open: ADL_LOG_OPENS === 1,
      channel_count: (VIEWER_DATA && VIEWER_DATA.channels) ? VIEWER_DATA.channels.length : 0
    });
    // non-blocking: My Views populate into the selector as soon as they arrive
    loadSavedViews().then(refreshViewSelect);
    // The saved Layout / Custom Gauges the tuner picked last comes back on the next log (its graph
    // channels that exist here, its dash) unless a host config for this car takes over below.
    if(!VIEWER_VEHICLE_CONFIGS.length && !VIEWER_AUTO_CONFIG && !reapplyLastSaved()){
      // Not in the store at this instant -- retry once the pull settles, unless the tuner has since
      // picked something or changed anything (never yank a layout out from under them).
      loadSavedViews().then(function(){
        if(VIEWER_VEHICLE_CONFIGS.length || VIEWER_AUTO_CONFIG || VIEWER_LAYOUT_DIRTY) return;
        if(VIEWER_CURRENT_LAYOUT && VIEWER_CURRENT_LAYOUT.kind === 'saved') return;
        reapplyLastSaved();
      }).catch(function(){});
    }
    // A host-resolved config (e.g. a ticket's BigData Config for this vehicle) overrides the built-in
    // auto-select -- applied LAST, via the same path as choosing a saved view, so the log opens straight
    // into its intended gauges/graphs. Accepts either a bare config or a {id,name,kind,config} wrapper.
    // Cleared after use so it never sticks to the next log. Prefer the FULL vehicle-config list (auto-load
    // its default; the rest are offered in the picker's "For this car" group); fall back to a single
    // meta.autoConfig for hosts that only send one.
    if(VIEWER_VEHICLE_CONFIGS.length){
      var vdef = VIEWER_VEHICLE_CONFIGS.filter(function(c){ return c.isDefault; })[0] || VIEWER_VEHICLE_CONFIGS[0];
      applyVehicleConfig(vdef.id);
    } else if(VIEWER_AUTO_CONFIG){
      var ac = VIEWER_AUTO_CONFIG; VIEWER_AUTO_CONFIG = null;
      // readOnly: this is a PBD/host-pushed config the viewer is DISPLAYING (ticket/customer auto-load),
      // not the user's own saved view -- so closing it must NOT offer to save (customers can't; the write
      // is RLS-denied). Editing PBD configs happens in the admin authoring flow, not on ticket/log open.
      applyViewConfig(ac.config || ac, { kind: 'saved', id: ac.id != null ? ac.id : 'auto', name: ac.name || 'Vehicle config', readOnly: true });
    }
  }).catch(function(err){
    renderViewerError((err && err.message) || 'Something went wrong.');
  });
}
// A failed load must not be a dead end. This used to drop a bare message into #viewerContent, which
// also destroyed the header -- and the header holds the only Close button, so the overlay sat there
// covering the whole page with no way out (Ken, 2026-07-22, on the version-6 .hpl message). The
// error state now carries its own exit, and Escape works too.
// Build version: read the ?v=<deploy sha> off THIS file's own <script src> (stamped at deploy time on
// hosts that cache-bust the engine URLs). Shown in the header + appended to every error so "which build
// is this / is it stale / which parser rejected the file" is answerable at a glance. 'dev' when un-stamped.
var VIEWER_VERSION = (function(){
  try {
    var ss = document.getElementsByTagName('script'), i, m;
    for(i = 0; i < ss.length; i++){ m = ss[i].src && ss[i].src.match(/datalog-viewer\.js\?v=([^&"']+)/); if(m && m[1].indexOf('__') !== 0) return m[1]; }
  } catch(e){}
  return 'dev';
})();
var VIEWER_ERROR_OPEN = false;
function renderViewerError(msg){
  var el = document.getElementById('viewerContent');
  if(!el) return;
  el.innerHTML =
    '<div class="dlv-errwrap">' +
      '<div class="dlv-errbox">' +
        '<div class="dlv-err-title">Could not open this log</div>' +
        '<div class="dlv-err-msg">' + escapeHtml(msg) + '</div>' +
        '<div class="dlv-err-build">viewer build ' + escapeHtml(VIEWER_VERSION) + '</div>' +
        '<button type="button" class="dlv-btn dlv-err-back" id="dlvErrBack">&#8592; Back</button>' +
      '</div>' +
    '</div>';
  var b = document.getElementById('dlvErrBack');
  if(b) b.addEventListener('click', closeViewer);
  VIEWER_ERROR_OPEN = true;
}
// Escape only closes while the error state is showing. Binding it for the whole viewer would be a
// behaviour change on a working log, where Escape is what leaves fullscreen.
document.addEventListener('keydown', function(e){
  if(e.key === 'Escape' && VIEWER_ERROR_OPEN && document.getElementById('dlvErrBack')) closeViewer();
});
// Leaving fullscreen is not optional cleanup. #viewerOverlay is the fullscreen element, and if it
// is hidden (or navigated away from) while still fullscreen the browser is left holding a
// fullscreen root that renders nothing -- the page underneath looks normal but hit-testing is
// wrong, so nothing responds until some gesture forces a reflow. That matches Ken's report exactly:
// back to the homepage, everything visible, nothing clickable until he swiped a few times.
function exitViewerFullscreen(){
  if(!document.fullscreenElement) return;
  if(!document.exitFullscreen) return;
  try{
    var p = document.exitFullscreen();
    if(p && p.catch) p.catch(function(){});
  }catch(e){}
}

function closeViewer(){
  // Ask whether to save ONLY the slot(s) that are actually dirty (Ken, 2026-07-25 for the original
  // prompt-on-close behavior; the dirty check was added 2026-09-08 -- unconditionally asking every
  // time you close a saved item, whether or not you'd changed anything, is exactly the kind of
  // untrustworthy signal this whole redesign is meant to fix). Either answer still closes, so the
  // exit is never blocked. The VIEWER_DATA guard keeps this off the error-state / already-closed paths.
  var layout = VIEWER_CURRENT_LAYOUT || {}, gauges = VIEWER_CURRENT_GAUGES || {};
  var dirtyLayout = layout.kind === 'saved' && !layout.readOnly && VIEWER_LAYOUT_DIRTY;
  var dirtyGauges = gauges.kind === 'saved' && !gauges.readOnly && VIEWER_GAUGES_DIRTY;
  if((dirtyLayout || dirtyGauges) && VIEWER_DATA){
    var what = dirtyLayout && dirtyGauges
      ? 'the layout "' + layout.name + '" and the custom gauges "' + gauges.name + '"'
      : dirtyLayout ? 'the layout "' + layout.name + '"' : 'the custom gauges "' + gauges.name + '"';
    if(window.confirm('Save changes to ' + what + ' before closing?')){
      var proms = [];
      if(dirtyLayout) proms.push(saveConfig('view', false));
      if(dirtyGauges) proms.push(saveConfig('gauges', false));
      Promise.all(proms.map(function(p){ return (p && p.then) ? p : Promise.resolve(p); })).then(closeViewerNow, closeViewerNow);
      return;
    }
  }
  closeViewerNow();
}
function closeViewerNow(){
  var overlay = document.getElementById('viewerOverlay');
  exitViewerFullscreen();
  overlay.classList.remove('open');
  var chatBubble = document.getElementById('pbdChatPreview');
  if(chatBubble) chatBubble.style.display = '';
  document.body.style.overflow = VIEWER_PREV_BODY_OVERFLOW || '';
  Object.keys(viewerCharts).forEach(function(k){ if(viewerCharts[k]) viewerCharts[k].destroy(); });
  viewerCharts = {}; viewerGaugeEls = {};
  VIEWER_DATA = null; CROSSHAIR_TIME = null; VIEWER_SELECTED = []; VIEWER_PANEL_ASSIGN = {};
  VIEWER_HIGHLIGHT_SPANS = [];
  if(VIEWER_HIST_CTL && VIEWER_HIST_CTL.destroy){ try { VIEWER_HIST_CTL.destroy(); } catch(err){} }
  VIEWER_HIST_CTL = null;
  VIEWER_ERROR_OPEN = false;   // otherwise Escape stays armed after the overlay is gone
}
document.addEventListener('DOMContentLoaded', function(){
  var closeBtn = document.getElementById('viewerCloseBtn');
  if(closeBtn) closeBtn.addEventListener('click', closeViewer);
  var overlay = document.getElementById('viewerOverlay');
  if(overlay) overlay.addEventListener('click', function(e){ if(e.target.id === 'viewerOverlay') closeViewer(); });
});

// The viewer's own Close button is not the only way out -- the phone's back gesture and the host
// site's own navigation both bypass it entirely, and neither runs closeViewer(). Without this the
// viewer could be left "closed" by navigation while still holding fullscreen and its charts.
// popstate covers client-side routing and the back gesture; pagehide covers a real page unload
// (and fires reliably on mobile Safari/Chrome, where unload does not).
function teardownViewerOnNavigation(){
  var overlay = document.getElementById('viewerOverlay');
  if(!overlay) return;
  // While FULLSCREEN, a back gesture means "leave fullscreen", not "close the log". Android fires
  // popstate for that gesture, so closing the viewer here threw the user all the way out of their
  // log when they only wanted the address bar back -- which reads as "fullscreen doesn't work".
  // Exit fullscreen and stop; a second back can still close it.
  if(document.fullscreenElement){ exitViewerFullscreen(); return; }
  exitViewerFullscreen();
  if(overlay.classList.contains('open')) closeViewer();
}
window.addEventListener('popstate', teardownViewerOnNavigation);
window.addEventListener('pagehide', teardownViewerOnNavigation);

// Resolves default upper/lower channels for the current log: prefer the active preset's
// defaultGraphs (role-based) when it defines any; otherwise fall back to the old QUICK_CHANNELS
// heuristic so Default/Graph View (which intentionally carry no hardcoded channels) still start
// with something sensible plotted.
// ---- Graph panel slots -------------------------------------------------------------------------
// Slots are STABLE ids -- 1 = upper, 2 = middle, 3 = lower -- regardless of how many panels the
// current view renders. That matters because views without the gauge cluster show three graphs
// (U/M/L) while Gauge View only has room for two (U/L): if slots were just "panel 1..n", a channel
// assigned to "lower" would silently become "middle" when you switched views.
// 4 is a SECOND MIDDLE, not a new bottom (Ken, 2026-09-10: "when in graph mode, lets give the option
// for 4"). Inserting it above LOWER keeps every existing assignment meaning what it did: "lower" is
// the bottom panel whether you are showing two, three or four.
var GRAPH_SLOT_UPPER = 1, GRAPH_SLOT_MIDDLE = 2, GRAPH_SLOT_LOWER = 3, GRAPH_SLOT_MIDDLE2 = 4;
// The gauge cluster eats the vertical room, so Gauge View keeps two graphs; every other view gets
// the third (middle) one -- per Ken, 2026-07-21.
// ---------------------------------------------------------------------------------------------
// Mobile
// ---------------------------------------------------------------------------------------------
// Deliberately a stripped-back build rather than a shrunk desktop one (Ken, 2026-07-21): ONE graph,
// numeric cards, no gauges, no header, a very short scrubber, and the channel list as a large-type
// drawer. The brief was "start at the most basic level, hide everything else, then add back what we
// find we need after testing on a real phone" -- so everything omitted here is hidden, not deleted,
// and nearly all of it is a CSS rule away from coming back.
//
// LANDSCAPE ONLY (Ken, 2026-07-21): a portrait phone can't usefully show a time-series graph, so
// portrait gets a "rotate" prompt rather than a cramped layout nobody can read.
//
// Detection is by HEIGHT, not width, and that matters: a landscape iPhone is 844x390 or 932x430 --
// WIDER than any sensible "mobile" width breakpoint. Keying off width would have missed the exact
// orientation this build is for. A short viewport is the reliable phone-in-landscape signal; a
// desktop window is almost never under ~520px tall. The width test only catches portrait phones,
// which exist solely to be told to rotate.
//
// iPad stays on desktop by design: landscape 1024x768 is tall enough, portrait 768x1024 wide
// enough, that neither trips these.
var MOBILE_MAX_W = 620;   // portrait phone width
var MOBILE_MAX_H = 520;   // landscape phone height
function mq(q){
  return typeof window.matchMedia === 'function' ? window.matchMedia(q).matches : null;
}
function isMobileViewer(){
  var m = mq('(max-height: ' + MOBILE_MAX_H + 'px), (max-width: ' + MOBILE_MAX_W + 'px)');
  if(m !== null) return m;
  return window.innerHeight <= MOBILE_MAX_H || window.innerWidth <= MOBILE_MAX_W;
}
// Portrait *and* small enough to be a phone. Deliberately not orientation media-query alone: a tall
// narrow desktop window is portrait too, and shouldn't be told to rotate anything.
function isPortraitBlocked(){
  return isMobileViewer() && window.innerHeight > window.innerWidth;
}

// SINGLE SOURCE OF TRUTH for what the layout is showing. These exist because rendering and
// updating disagreed: renderViewerBody drew cards when `mode==='default' || mobile`, while
// updateAtCursor only filled them when `mode==='default'`. A log that matches a gauge preset sets
// the mode to 'gauge', so on mobile the cards were drawn and then never populated -- permanent
// dashes (Ken's .hpl, 2026-07-21). Anything asking "are cards/gauges on screen?" must ask here.
function showsCards(){ return VIEWER_VIEW_MODE === 'default' || isMobileViewer(); }
function showsGauges(){ return VIEWER_VIEW_MODE === 'gauge' && !isMobileViewer(); }

// How many graph panels are on screen. The UPPER graph is the master and is always present -- the
// count only says how many stack beneath it. User-chosen (see the 1/2/3 buttons in the upper
// graph's top-left) and remembered for the session, because the right answer is a property of the
// screen you're on: three panels are unusable on a 14" laptop and fine on a shop monitor.
// Defaults to 2, which was the old Gauge View behaviour and fits everywhere.
var VIEWER_GRAPH_COUNT = 2;
// Graph View has the whole pane to itself, so it can take a fourth panel; every other view keeps three
// because the cards / gauges / tables above the graphs already eat the height. A remembered count of 4
// is CLAMPED here rather than reset, so leaving Graph View and coming back gives the fourth panel again.
// Four graphs on the GRAPH TAB, three where the pane is shared with a dash or a histogram table.
// Both 'default' and 'graph' are that tab (see renderModeTabsHtml: 'graph' is the same tab with the
// numeric cards suppressed, reachable only from the old View picker) -- gating on 'graph' alone meant
// the tab Ken actually clicks never offered the fourth (Ken, 2026-09-10: "in graph mode, there isnt the
// option to add a 4th graph").
function graphsAreTheView(){ return VIEWER_VIEW_MODE === 'default' || VIEWER_VIEW_MODE === 'graph'; }
function maxGraphCount(){ return isMobileViewer() ? 1 : (graphsAreTheView() ? 4 : 3); }
function effectiveGraphCount(){ return Math.max(1, Math.min(VIEWER_GRAPH_COUNT || 2, maxGraphCount())); }
function activeGraphSlots(){
  if(isMobileViewer()) return [GRAPH_SLOT_UPPER];
  // 2 deliberately means UPPER+LOWER, not UPPER+MIDDLE: that's what Gauge View has always used, so
  // channels already assigned to "lower" stay where the user put them when toggling 3 -> 2.
  var n = effectiveGraphCount();
  if(n <= 1) return [GRAPH_SLOT_UPPER];
  if(n === 2) return [GRAPH_SLOT_UPPER, GRAPH_SLOT_LOWER];
  if(n === 3) return [GRAPH_SLOT_UPPER, GRAPH_SLOT_MIDDLE, GRAPH_SLOT_LOWER];
  return [GRAPH_SLOT_UPPER, GRAPH_SLOT_MIDDLE, GRAPH_SLOT_MIDDLE2, GRAPH_SLOT_LOWER];
}
function graphSlotLabel(slot){
  return slot === GRAPH_SLOT_UPPER ? 'UPPER GRAPH' : slot === GRAPH_SLOT_MIDDLE ? 'MIDDLE GRAPH'
    : slot === GRAPH_SLOT_MIDDLE2 ? 'MIDDLE GRAPH 2' : 'LOWER GRAPH';
}
// Channels drawn on a given slot. Anything assigned to a slot this view doesn't render (a middle
// assignment while in Gauge View) folds into the last visible panel rather than vanishing.
function channelsForSlot(slot, slots){
  var isLast = slot === slots[slots.length - 1];
  return VIEWER_SELECTED.filter(function(ch){
    var a = VIEWER_PANEL_ASSIGN[ch] || GRAPH_SLOT_UPPER;
    if(a === slot) return true;
    return isLast && slots.indexOf(a) === -1;
  });
}

function pickDefaultChannels(){
  VIEWER_SELECTED = []; VIEWER_PANEL_ASSIGN = {};
  var preset = VIEWER_ACTIVE_PRESET;
  var dg = (preset && preset.defaultGraphs) || {};
  var bySlot = [
    { slot: GRAPH_SLOT_UPPER, roles: dg.upper || [] },
    { slot: GRAPH_SLOT_MIDDLE, roles: dg.middle || [] },
    { slot: GRAPH_SLOT_LOWER, roles: dg.lower || [] },
  ];
  var any = false;
  bySlot.forEach(function(g){
    g.roles.map(function(r){ return VIEWER_RESOLVED_ROLES[r]; }).filter(Boolean).forEach(function(c){
      if(VIEWER_SELECTED.indexOf(c) === -1) VIEWER_SELECTED.push(c);
      VIEWER_PANEL_ASSIGN[c] = g.slot;
      any = true;
    });
  });
  if(any) return;
  var picks = QUICK_CHANNELS.filter(function(c){ return VIEWER_DATA.channels.indexOf(c) !== -1; }).slice(0, 4);
  picks.forEach(function(ch, i){
    VIEWER_SELECTED.push(ch);
    VIEWER_PANEL_ASSIGN[ch] = i < Math.ceil(picks.length / 2) ? GRAPH_SLOT_UPPER : GRAPH_SLOT_LOWER;
  });
}

function computeChannelStats(data){
  var stats = {};
  data.channels.forEach(function(ch){
    // Min/max/avg of a categorical channel's level indices would be arithmetic on arbitrary labels
    // ("average Spark Source" is meaningless), so those channels simply get no stats and the cards
    // omit the stats line for them.
    if(data.textLevels && data.textLevels[ch]) return;
    var vals = data.series[ch] || [];
    var min = Infinity, max = -Infinity, sum = 0, n = 0;
    for(var i = 0; i < vals.length; i++){
      var v = vals[i];
      if(v == null || !isFinite(v)) continue;
      if(v < min) min = v;
      if(v > max) max = v;
      sum += v; n++;
    }
    stats[ch] = n ? { min: min, max: max, avg: sum / n } : null;
  });
  return stats;
}

function channelColor(ch){
  var idx = VIEWER_SELECTED.indexOf(ch);
  return CHANNEL_COLORS[(idx < 0 ? 0 : idx) % CHANNEL_COLORS.length];
}

// Which raw channel names the ACTIVE preset's gauges are using -- drives the compact "Gauge"
// column dot in the channel grid. Empty for Default/Graph View (no gauges defined).
function gaugeChannelSet(){
  var set = {};
  if(VIEWER_ACTIVE_PRESET && VIEWER_ACTIVE_PRESET.gauges){
    VIEWER_ACTIVE_PRESET.gauges.forEach(function(g){
      var ch = gaugeChannelFor(g);
      if(ch) set[ch] = true;
    });
  }
  return set;
}

// ---------------------------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------------------------
function renderHeaderHtml(){
  var rows = VIEWER_DATA.returnedRows.toLocaleString() + ' of ' + VIEWER_DATA.totalRows.toLocaleString() + ' rows';
  var downsampleMsg = VIEWER_DATA.totalRows > VIEWER_DATA.returnedRows ? 'Downsampled for display -- download the file for full resolution' : '';
  // One selector, two groups (Built-in / My Views) -- replaces the old pair of disabled Preset and
  // View dropdowns, which overlapped: "Default"/"Graph" were really layouts masquerading as presets.
  return '' +
  '<div class="dlv-header">' +
    '<div class="dlv-header-brand dlv-brand" title="BigData">' + BRAND_LOGO_SVG + '</div>' +
    '<div class="dlv-header-info">' +
      '<span class="fname" title="' + escapeHtml(VIEWER_FILE_NAME) + '">' + escapeHtml(VIEWER_FILE_NAME) + '</span>' +
      '<span class="dlv-status-ok">&#10003;</span>' +
      '<span>' + rows + '</span>' +
      (downsampleMsg ? '<span>' + downsampleMsg + '</span>' : '') +
      '<span class="dlv-ver" title="Viewer build ' + escapeHtml(VIEWER_VERSION) + '">build ' + escapeHtml(VIEWER_VERSION) + '</span>' +
    '</div>' +
    // Primary controls stay as buttons on the left; occasional actions collapse into two labelled
    // dropdowns on the right (Ken, 2026-07-23) so the bar stops gaining a button per feature and
    // there's an obvious home for each new one. Compare + performance moved into Analyze; save /
    // manage views / New Custom Dash / download into Layout.
    '<div class="dlv-header-actions dlv-actions-primary">' +
      renderViewSelectHtml() +
      '<button type="button" class="dlv-btn" id="dlvResetZoomBtn">&#8635; Reset Zoom</button>' +
    '</div>' +
    '<div class="dlv-header-spacer"></div>' +
    '<div class="dlv-header-actions">' +
      '<button type="button" class="dlv-btn dlv-btn-menu" id="dlvAnalyzeBtn" title="Compare, performance data">Analyze &#9662;</button>' +
      '<button type="button" class="dlv-btn dlv-btn-menu" id="dlvLayoutBtn" title="Views, dashboards, download">Layout &#9662;</button>' +
      '<input type="file" id="dlvCompareFile" accept=".csv,.hpl,.ld,.dl,.msl,.mlg" hidden>' +
      '<button type="button" class="dlv-close" id="viewerCloseBtn2" title="Close">&times;</button>' +
    '</div>' +
  '</div>' +
  renderModeTabsHtml();
}

// ---- Mode tabs: Graph / Gauges / Histograms, with a Default/Custom sub-toggle inside Gauges ----
// The app's main views (VIEWER_VIEW_MODE) used to be reachable only by hunting through the Layout
// dropdown (Histograms, New Custom Dash) or, for the auto-matched preset's own gauges, not at all
// once you'd navigated away from them -- there was no button that led back short of reloading the
// log. A persistent one-click tab strip fixes both (Ken, 2026-09-07: "easier to switch between
// histogram and gauge view... maybe a tab interface"). Simplified again down to exactly 3 tabs
// (Ken, 2026-09-08: "it has become confusing... only have graph, gauges, histograms") -- Custom Dash
// is no longer a separate tab, it's a sub-view INSIDE Gauges, toggled by the Default/Custom pills.
function modeTabItem(mode, label, locked, on){
  return '<button type="button" class="dlv-mode-tab' + (on ? ' on' : '') +
    (locked ? ' dlv-pro-locked' : '') + '" data-mode="' + mode + '"' +
    (locked ? ' title="Pro feature -- ' + escapeHtml(PRO_LOCK_MSG) + '"' : '') + '>' + escapeHtml(label) + '</button>';
}
function renderModeTabsHtml(){
  var pro = viewerIsPro();
  var hasFascia = !!(VIEWER_ACTIVE_PRESET && VIEWER_ACTIVE_PRESET.gauges && VIEWER_ACTIVE_PRESET.gauges.length);
  var hasDash = !!(VIEWER_DASH && VIEWER_DASH.gauges && VIEWER_DASH.gauges.length);
  // 'graph' (cards-suppressed, reachable only via the View picker's built-in "Graph View") reads as
  // the same tab as 'default' -- they're both "the Graph tab", just with/without the numeric cards;
  // there's no separate tab for it, so it should highlight the one tab that IS about graphs rather
  // than leaving the strip showing nothing selected (Ken would otherwise see no tab highlighted the
  // moment a saved Graph View loaded).
  var tabs = modeTabItem('default', 'Graph', false, VIEWER_VIEW_MODE === 'default' || VIEWER_VIEW_MODE === 'graph');
  // Only offered when there's something to show under either sub-view -- a log with no gauge-capable
  // preset AND no custom dash built yet never had a gauge view, tab or otherwise.
  if(hasFascia || hasDash) tabs += modeTabItem('gauge', 'Gauges', false, VIEWER_VIEW_MODE === 'gauge');
  tabs += modeTabItem('histograms', 'Histograms', !pro, VIEWER_VIEW_MODE === 'histograms');
  if(VIEWER_VIEW_MODE === 'gauge'){
    tabs += '<span class="dlv-mode-tabs-sep"></span>' +
      '<button type="button" class="dlv-sub-pill' + (VIEWER_GAUGE_SUBMODE === 'default' ? ' on' : '') +
        (hasFascia ? '' : ' dlv-sub-pill-empty') + '" data-sub="default"' +
        (hasFascia ? '' : ' title="This log has no matching preset gauges"') + '>Default</button>' +
      '<button type="button" class="dlv-sub-pill' + (VIEWER_GAUGE_SUBMODE === 'custom' ? ' on' : '') +
        (pro ? '' : ' dlv-pro-locked') + '" data-sub="custom"' +
        (pro ? '' : ' title="Pro feature -- ' + escapeHtml(PRO_LOCK_MSG) + '"') + '>Custom</button>';
  }
  return '<div class="dlv-mode-tabs">' + tabs + '</div>';
}
function wireModeTabs(){
  var bar = document.querySelector('.dlv-mode-tabs');
  if(!bar) return;
  bar.addEventListener('click', function(e){
    var subBtn = e.target.closest ? e.target.closest('[data-sub]') : null;
    if(subBtn){
      if(VIEWER_DASH_TARGET === 'hist'){ finishHistGaugesEdit(true); return; }   // leaving the histogram-gauge designer keeps the work
      if(subBtn.classList.contains('dlv-pro-locked')){
        adlTrack('paywall_viewed', { feature: 'gauge_designer', trigger: 'gauge_subtabs' });
        if(window.showToast) showToast('Custom gauges are Pro -- ' + PRO_LOCK_MSG + '.');
        return;
      }
      if(subBtn.classList.contains('dlv-sub-pill-empty')) return;   // nothing to show, not a real toggle
      var sub = subBtn.getAttribute('data-sub');
      if(sub === VIEWER_GAUGE_SUBMODE) return;
      adlTrack('gauge_submode_click', { submode: sub });
      // 'custom' needs enterCustomGauges()'s own setup (ensure VIEWER_DASH exists, open in build mode
      // when it's still empty) -- just flipping the submode var would land on a blank finalized canvas
      // with no palette and no way to add a first gauge.
      if(sub === 'custom'){ enterCustomGauges(); return; }
      VIEWER_GAUGE_SUBMODE = sub;
      saveViewerPrefs();
      renderViewerBody();
      return;
    }
    var btn = e.target.closest ? e.target.closest('[data-mode]') : null;
    if(!btn) return;
    if(btn.classList.contains('dlv-pro-locked')){
      var mode0 = btn.getAttribute('data-mode');
      adlTrack('paywall_viewed', { feature: mode0, trigger: 'mode_tabs' });
      if(window.showToast) showToast('Histograms are Pro -- ' + PRO_LOCK_MSG + '.');
      return;
    }
    var mode = btn.getAttribute('data-mode');
    if(VIEWER_DASH_TARGET === 'hist'){ finishHistGaugesEdit(true); if(mode === 'histograms') return; }
    if(mode === VIEWER_VIEW_MODE) return;
    if(mode === 'histograms') return enterHistograms();
    adlTrack('mode_tab_click', { mode: mode });
    VIEWER_VIEW_MODE = mode;
    saveViewerPrefs();
    renderViewerBody();
  });
}

// ---------------------------------------------------------------------------------------------
// Left channel browser
// ---------------------------------------------------------------------------------------------
// ---- Compact on-screen keypad (mobile only) --------------------------------------------------
// The phone's own keyboard is the problem it solves: in landscape it eats well over half of a
// ~412px screen, so filtering channels meant typing blind. This is ~150px, alphabetical (a 6-wide
// grid can't honour QWERTY muscle memory anyway, and scanning A-Z in a grid is fast), and hidden
// until the search field is tapped so the channel list keeps the space by default.
// Most filters are two or three letters -- this isn't for prose.
var VIEWER_KEYPAD_OPEN = false;
function renderKeypadHtml(){
  var letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  var keys = letters.map(function(ch){
    return '<button type="button" class="dlv-key" data-k="' + ch + '">' + ch + '</button>';
  }).join('');
  // No space key: 26 letters + backspace + Done is exactly 4 rows of 7, and channel filters are
  // effectively always a single word fragment ("fuel", "knock"), so a space bar would cost a row
  // of height to serve almost nobody. Height is the scarce resource here.
  keys += '<button type="button" class="dlv-key" data-k="⌫">&#9003;</button>' +
          '<button type="button" class="dlv-key dlv-key-done" data-k="✓">Done</button>';
  return '<div class="dlv-keypad" id="dlvKeypad">' + keys + '</div>';
}
function setKeypadOpen(open){
  VIEWER_KEYPAD_OPEN = open;
  var panel = document.querySelector('.dlv-channel-panel');
  if(panel) panel.classList.toggle('dlv-keypad-open', open);
}
// Re-filters without rebuilding the panel, so the keypad doesn't flicker or lose its place.
function applySearch(next){
  VIEWER_SEARCH = next;
  var input = document.getElementById('dlvChannelSearch');
  if(input) input.value = next;
  // Show the clear (x) button only when there's a filter. applySearch is the one path for desktop
  // typing, the mobile keypad, and the x itself, so toggling here keeps the button in sync everywhere.
  var wrap = input && input.closest ? input.closest('.dlv-search-wrap') : null;
  if(wrap) wrap.classList.toggle('dlv-has-text', !!next);
  var body = document.getElementById('dlvChannelBody');
  if(body) body.innerHTML = renderChannelRowsHtml();
  refreshChannelValueRefs();
  updateAtCursor(CROSSHAIR_TIME);
}
function wireKeypad(){
  var pad = document.getElementById('dlvKeypad');
  var input = document.getElementById('dlvChannelSearch');
  if(input){
    // focus fires for taps and for programmatic focus; inputmode:none means no native keyboard
    input.addEventListener('focus', function(){ setKeypadOpen(true); });
    input.addEventListener('click', function(){ setKeypadOpen(true); });
  }
  if(!pad) return;
  pad.addEventListener('click', function(e){
    var btn = e.target.closest ? e.target.closest('.dlv-key') : null;
    if(!btn) return;
    var k = btn.getAttribute('data-k');
    if(k === '✓'){ setKeypadOpen(false); return; }
    if(k === '⌫'){ applySearch(VIEWER_SEARCH.slice(0, -1)); return; }
    applySearch(VIEWER_SEARCH + k.toLowerCase());
  });
}

// ---- CHANNEL LIST PROTOTYPE (Ken, 2026-07-22 -- NOT RELEASED) ---------------------------------
// Three ways to tame a 98-channel list, built together so they can be compared on a real log:
//   1. PIN (the up-arrow)  -- send a channel to a pinned block at the top.
//   2. DRAG                -- reorder by dragging a row.
//   3. GROUPS              -- auto-bucket into collapsible tuning-shaped sections.
//
// They are not three independent features; 1 and 2 both define a manual order and 3 defines an
// automatic one, so a design has to say which wins. The arrangement here: PINNED IS A BLOCK ABOVE
// THE GROUPS, and drag reorders within a block rather than across the whole list. That's what makes
// pinning and grouping composable -- free-form dragging through 98 rows would have to overrule the
// grouping entirely, which is why the two can't both be "on" in the same region.
//
// Modes are switchable at runtime (the button in the toolbar) precisely so this can be judged by
// feel rather than argued about.
// NOT RELEASED. Ken approved the performance-data features but not this ("don't go live with any of
// that ... just testing to see what works and what we like", 2026-07-22), and both live in the same
// files. Shipping it dormant beats reverting: the work stays intact and testable in the dev harness,
// while the sites render exactly the channel list they did before. Set to true to try it.
var VIEWER_CHAN_PROTOTYPE = false;

var VIEWER_CHAN_MODE = 'grouped';        // 'grouped' | 'flat'
var VIEWER_PINNED = [];                  // channel names, in pinned order
var VIEWER_GROUP_COLLAPSED = {};         // groupId -> true when collapsed
var VIEWER_CHAN_ORDER = null;            // flat mode: manual order from dragging, null until dragged

function chanModeGrouped(){ return VIEWER_CHAN_PROTOTYPE && VIEWER_CHAN_MODE === 'grouped'; }
function isPinned(ch){ return VIEWER_PINNED.indexOf(ch) !== -1; }
function togglePin(ch){
  var i = VIEWER_PINNED.indexOf(ch);
  // Unpinning restores the channel to its natural place rather than leaving it stranded at the top.
  if(i === -1) VIEWER_PINNED.unshift(ch); else VIEWER_PINNED.splice(i, 1);
  rerenderChannelRows();
}

// Search matches a GROUP NAME as well as channel names (Ken: "search for timing and that group
// shows up and shows all things for timing"). Without this, typing "timing" would return only
// "Timing Advance" -- the one channel with the literal word -- and hide the rest of the group,
// which is the opposite of what a group is for.
function groupsMatchingSearch(q){
  var hit = {};
  if(!q) return hit;
  CHANNEL_GROUPS.concat([CHANNEL_GROUP_OTHER]).forEach(function(g){
    if(g.label.toLowerCase().indexOf(q) !== -1 || g.id.indexOf(q) !== -1) hit[g.id] = true;
  });
  return hit;
}
// Channel KIND filter -- icon buttons under the search box (Ken, 2026-09-09: "some button filters that can
// sort by logged parameter, math channel or these new ones. use their icon as the filter button"). The icons
// are the row badges themselves: ◉ logged (recorded by the scanner), ƒ math channel, ≈ calculated (Vehicle
// Dynamics). Empty set = every kind; several lit together = their union. Session-only, like the search text,
// and applied on top of it.
var VIEWER_KIND_FILTER = {};
var CHANNEL_KINDS = [
  ['logged', '&#9673;', 'Logged channels -- recorded by the scanner'],
  ['math',   '&fnof;',  'Math channels -- computed from a formula, not logged'],
  ['calc',   '&asymp;', 'Calculated channels -- Vehicle Dynamics, estimated from this log\'s speed channels']
];
function channelKind(c){ return isMathChannel(c) ? 'math' : isAccelChannel(c) ? 'calc' : 'logged'; }
function kindFilterActive(){ return Object.keys(VIEWER_KIND_FILTER).some(function(k){ return !!VIEWER_KIND_FILTER[k]; }); }
function channelPassesKind(c){ return !kindFilterActive() || !!VIEWER_KIND_FILTER[channelKind(c)]; }
function kindCounts(){
  var n = { logged: 0, math: 0, calc: 0 };
  if(VIEWER_DATA && VIEWER_DATA.channels) VIEWER_DATA.channels.forEach(function(c){ n[channelKind(c)]++; });
  return n;
}
function renderKindBarHtml(){
  var n = kindCounts();
  return '<div class="dlv-kind-bar" id="dlvKindBar" role="group" aria-label="Show only">' + CHANNEL_KINDS.map(function(k){
    var on = !!VIEWER_KIND_FILTER[k[0]], cnt = n[k[0]];
    return '<button type="button" class="dlv-kind-btn dlv-kind-' + k[0] + (on ? ' active' : '') + '" data-kind="' + k[0] + '"' +
      (cnt ? '' : ' disabled') + ' aria-pressed="' + (on ? 'true' : 'false') + '" title="' + k[2] + (cnt ? ' (' + cnt + ')' : ' -- none in this log') +
      (cnt ? (on ? '. Click to show every kind again' : '. Click to show only these') : '') + '">' +
      '<span class="dlv-kind-ico">' + k[1] + '</span><span class="dlv-kind-n">' + cnt + '</span></button>';
  }).join('') + '</div>';
}
function toggleKindFilter(kind){
  if(VIEWER_KIND_FILTER[kind]) delete VIEWER_KIND_FILTER[kind]; else VIEWER_KIND_FILTER[kind] = true;
  var bar = document.getElementById('dlvKindBar');
  if(bar) Array.prototype.forEach.call(bar.querySelectorAll('[data-kind]'), function(b){
    var on = !!VIEWER_KIND_FILTER[b.getAttribute('data-kind')];
    b.classList.toggle('active', on); b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  rerenderChannelRows();
}
function wireKindBar(){
  var bar = document.getElementById('dlvKindBar'); if(!bar) return;
  bar.addEventListener('click', function(e){
    var b = e.target && e.target.closest ? e.target.closest('[data-kind]') : null;
    if(!b || b.disabled) return;
    toggleKindFilter(b.getAttribute('data-kind'));
  });
}

// ---- Favorites (star) + collapsible sections --------------------------------------------------
// Ken, 2026-09-10: "lets add a star next to every PID. if you star it, it becomes a favorite and shows
// up top. then lets add collapsable categories for PIDs, math channels or the calculated parameters."
//
// A star is stored by channel NAME in localStorage, exactly like per-channel smoothing: you watch the
// same handful of PIDs on every log, so the star has to survive opening the next one. A starred channel
// is LIFTED OUT of its kind section into "Favorites" at the top rather than drawn twice -- the same rule
// the prototype's pinned block follows, and the only one that keeps "shows up top" honest.
var VIEWER_FAVORITES = null;
var VIEWER_FAV_KEY = 'pbdDatalogViewerFavorites.v1';
function favoritesMap(){
  if(VIEWER_FAVORITES) return VIEWER_FAVORITES;
  var m = null;
  try { var raw = window.localStorage ? localStorage.getItem(VIEWER_FAV_KEY) : null; m = raw ? JSON.parse(raw) : null; } catch(e){ m = null; }
  VIEWER_FAVORITES = (m && typeof m === 'object') ? m : {};
  return VIEWER_FAVORITES;
}
function isFavoriteChannel(c){ return !!favoritesMap()[c]; }
function persistFavorites(){ try { if(window.localStorage) localStorage.setItem(VIEWER_FAV_KEY, JSON.stringify(favoritesMap())); } catch(e){} }
function toggleFavoriteChannel(c){
  if(!c) return;
  var m = favoritesMap();
  if(m[c]) delete m[c]; else m[c] = true;
  persistFavorites();
  rerenderChannelRows();
}

// The sections themselves, in render order. The three kinds are the ones the row badges and the kind
// filter already use (channelKind), so a section heading and its filter button always mean the same thing.
var CHAN_SECTIONS = [
  ['__fav',  'Favorites',        '&#9733;'],
  ['logged', 'Logged channels',  '&#9673;'],
  ['math',   'Math channels',    '&fnof;'],
  ['calc',   'Calculated',       '&asymp;']
];
var VIEWER_SECT_COLLAPSED = null;
var VIEWER_SECT_KEY = 'pbdDatalogViewerChanSections.v1';
function sectCollapsedMap(){
  if(VIEWER_SECT_COLLAPSED) return VIEWER_SECT_COLLAPSED;
  var m = null;
  try { var raw = window.localStorage ? localStorage.getItem(VIEWER_SECT_KEY) : null; m = raw ? JSON.parse(raw) : null; } catch(e){ m = null; }
  VIEWER_SECT_COLLAPSED = (m && typeof m === 'object') ? m : {};
  return VIEWER_SECT_COLLAPSED;
}
function sectCollapsed(id){ return !!sectCollapsedMap()[id]; }
function toggleSectCollapsed(id){
  var m = sectCollapsedMap();
  if(m[id]) delete m[id]; else m[id] = true;
  try { if(window.localStorage) localStorage.setItem(VIEWER_SECT_KEY, JSON.stringify(m)); } catch(e){}
  rerenderChannelRows();
}
// Column count for a section heading's colspan -- the prototype adds a pin column, so this can't be a
// literal (the phone also hides the last two columns, which a colspan may safely overshoot).
function chanColCount(){ return VIEWER_CHAN_PROTOTYPE ? 7 : 6; }
function renderSectHeaderHtml(id, label, count, collapsed){
  var ico = '';
  CHAN_SECTIONS.forEach(function(s){ if(s[0] === id) ico = s[2]; });
  return '<tr class="dlv-group-row dlv-sect-row' + (collapsed ? ' collapsed' : '') +
    (id === '__fav' ? ' dlv-sect-fav' : '') + '" data-section="' + id + '">' +
    '<td colspan="' + chanColCount() + '">' +
    '<span class="dlv-group-caret">' + (collapsed ? '&#9656;' : '&#9662;') + '</span>' +
    '<span class="dlv-sect-ico dlv-sect-ico-' + id.replace('__', '') + '">' + ico + '</span>' +
    '<span class="dlv-group-label">' + escapeHtml(label) + '</span>' +
    '<span class="dlv-group-count">' + count + '</span></td></tr>';
}
// Rows inside one section: a manual drag order wins where one exists, otherwise the column sort.
function orderSectRows(list){
  if(!VIEWER_CHAN_ORDER) return sortRows(list);
  return VIEWER_CHAN_ORDER.filter(function(c){ return list.indexOf(c) !== -1; })
    .concat(list.filter(function(c){ return VIEWER_CHAN_ORDER.indexOf(c) === -1; }));
}
function chanSectionsHtml(rows, q){
  var by = { __fav: [], logged: [], math: [], calc: [] };
  rows.forEach(function(c){ (isFavoriteChannel(c) ? by.__fav : by[channelKind(c)]).push(c); });
  var html = '';
  CHAN_SECTIONS.forEach(function(s){
    var list = by[s[0]];
    if(!list.length) return;                       // no empty headings -- most logs have no math channels
    // A search is a deliberate narrowing: never answer one with a collapsed heading and no rows.
    var collapsed = !q && sectCollapsed(s[0]);
    html += renderSectHeaderHtml(s[0], s[1], list.length, collapsed);
    if(!collapsed) html += orderSectRows(list).map(function(c){ return renderOneChannelRow(c, false, s[0]); }).join('');
  });
  return html;
}

function channelMatchesSearch(c, q, groupHits){
  if(!channelPassesKind(c)) return false;
  if(!q) return true;
  if(c.toLowerCase().indexOf(q) !== -1) return true;
  return !!groupHits[channelGroupFor(c).id];
}

function renderChannelRowsHtml(){
  var q = VIEWER_SEARCH.toLowerCase();
  var groupHits = groupsMatchingSearch(q);
  var all = VIEWER_DATA.channels.filter(function(c){ return channelMatchesSearch(c, q, groupHits); });

  var pinned = VIEWER_PINNED.filter(function(c){ return all.indexOf(c) !== -1; });
  var rest = all.filter(function(c){ return !isPinned(c); });

  var html = '';
  if(pinned.length){
    html += renderGroupHeaderHtml('__pinned', 'Pinned', pinned.length, false) +
            pinned.map(function(c){ return renderOneChannelRow(c, true, '__pinned'); }).join('');
  }
  if(!chanModeGrouped()){
    // Favorites first, then one collapsible section per kind. Ordering inside a section keeps the
    // existing column sort, unless dragging has established a manual order (orderSectRows).
    return html + chanSectionsHtml(rest, q);
  }
  groupChannels(rest).forEach(function(g){
    // A group the search matched by NAME opens automatically -- otherwise searching "timing" would
    // surface a collapsed heading and still show you nothing.
    var collapsed = VIEWER_GROUP_COLLAPSED[g.id] && !groupHits[g.id];
    html += renderGroupHeaderHtml(g.id, g.label, g.channels.length, collapsed);
    if(!collapsed) html += sortRows(g.channels).map(function(c){ return renderOneChannelRow(c, false, g.id); }).join('');
  });
  return html;
}
function renderGroupHeaderHtml(id, label, count, collapsed){
  return '<tr class="dlv-group-row' + (collapsed ? ' collapsed' : '') + (id === '__pinned' ? ' dlv-group-pinned' : '') +
    '" data-group="' + escapeHtml(id) + '"><td colspan="' + chanColCount() + '">' +
    '<span class="dlv-group-caret">' + (collapsed ? '&#9656;' : '&#9662;') + '</span>' +
    '<span class="dlv-group-label">' + escapeHtml(label) + '</span>' +
    '<span class="dlv-group-count">' + count + '</span></td></tr>';
}
// The channel list's scroll position, carried across a full body rebuild. Read/written on the wrap
// (.dlv-channel-table-wrap is the scrolling element -- the table itself doesn't scroll).
function channelListScrollTop(){
  var wrap = document.querySelector('.dlv-channel-table-wrap');
  return wrap ? wrap.scrollTop : 0;
}
function restoreChannelListScroll(y){
  if(!y) return;
  var wrap = document.querySelector('.dlv-channel-table-wrap');
  if(wrap) wrap.scrollTop = y;
}
function rerenderChannelRows(){
  var body = document.getElementById('dlvChannelBody');
  if(!body) return;
  body.innerHTML = renderChannelRowsHtml();
  refreshChannelValueRefs();
  updateAtCursor(CROSSHAIR_TIME);
}

// Drag-to-reorder, and drag onto a graph panel to add the channel there. Pointer events rather than
// HTML5 drag-and-drop: the latter has no touch support at all, and this list is also the phone
// drawer. A drag starts ONLY from the grip handle (Ken, 2026-09-07 shipped this for real, so it now
// has to coexist with scrolling the list on a phone -- if the whole row armed a drag, any vertical
// touch-scroll starting on a row would be indistinguishable from a reorder attempt).
//
// A drag is confined to the block it started in. In GROUPED mode that means only the pinned block
// can be dragged -- reordering a channel inside "Knock" says nothing, and dragging it OUT would
// have to overrule the grouping. In FLAT mode the whole unpinned list is one block. Dropping on a
// graph panel instead of another row escapes the block rule entirely -- it never reorders anything,
// it just assigns the channel to that panel, exactly like clicking its U/M/L button would.
function wireChannelDrag(body){
  var st = null;
  function panelHighlight(el){
    if(st.overPanel && st.overPanel !== el) st.overPanel.classList.remove('dlv-graph-drop-target');
    st.overPanel = el;
    if(el) el.classList.add('dlv-graph-drop-target');
  }
  body.addEventListener('pointerdown', function(e){
    if(e.button !== 0) return;
    if(!e.target.closest('.dlv-drag-handle')) return;
    var row = e.target.closest('tr[data-ch]');
    if(!row) return;
    var pinnedRow = row.classList.contains('dlv-row-pinned');
    if(chanModeGrouped() && !pinnedRow) return;
    st = { row: row, pinned: pinnedRow, sect: row.getAttribute('data-sect') || '',
           x: e.clientX, y: e.clientY, active: false, id: e.pointerId, overPanel: null };
    // Captured on DOWN, before any movement -- not just once slop is exceeded. A drop target (a
    // graph panel) lives in a completely different part of the DOM than this list, so the very
    // FIRST move event has to already be captured, or a fast/coarse first move that jumps straight
    // from the handle to a panel in one step gets hit-tested and delivered to the CANVAS instead of
    // redirected here, and every event after it keeps missing us the same way (no capture ever gets
    // the chance to start). Capturing early costs nothing -- st.active still gates everything else.
    try { body.setPointerCapture(e.pointerId); } catch(_){}
  });
  body.addEventListener('pointermove', function(e){
    if(!st || st.id !== e.pointerId) return;
    if(!st.active){
      // A few px of slop before this becomes a drag, so an ordinary click on the handle still reads
      // as a click rather than a one-pixel reorder.
      if(Math.abs(e.clientY - st.y) < 4 && Math.abs(e.clientX - st.x) < 4) return;
      st.active = true;
      st.row.classList.add('dlv-row-dragging');
      body.classList.add('dlv-dragging');
      var graphs = document.querySelector('.dlv-graphs');
      if(graphs) graphs.classList.add('dlv-graphs-droppable');
    }
    var over = document.elementFromPoint(e.clientX, e.clientY);
    var panel = over && over.closest ? over.closest('.dlv-graph-panel') : null;
    if(panel){ panelHighlight(panel); return; }        // over a graph: never reorder the list under it
    panelHighlight(null);
    var target = over && over.closest ? over.closest('tr[data-ch]') : null;
    if(!target || target === st.row) return;
    if(target.classList.contains('dlv-row-pinned') !== st.pinned) return;  // stay in the block
    if((target.getAttribute('data-sect') || '') !== st.sect) return;        // ...and in its section
    var r = target.getBoundingClientRect();
    target.parentNode.insertBefore(st.row, (e.clientY > r.top + r.height / 2) ? target.nextSibling : target);
  });
  function end(e){
    if(!st) return;
    if(st.active){
      st.row.classList.remove('dlv-row-dragging');
      body.classList.remove('dlv-dragging');
      var graphs = document.querySelector('.dlv-graphs');
      if(graphs) graphs.classList.remove('dlv-graphs-droppable');
      if(st.overPanel){
        var slot = Number(st.overPanel.getAttribute('data-slot'));   // read before clearing -- panelHighlight(null) nulls st.overPanel
        panelHighlight(null);
        addChannelToPanel(st.row.getAttribute('data-ch'), slot);
      } else {
        commitDragOrder(body, st.pinned);
      }
    }
    try { body.releasePointerCapture(st.id); } catch(_){}
    st = null;
  }
  body.addEventListener('pointerup', end);
  body.addEventListener('pointercancel', end);
}
// Same assignment a U/M/L button click makes (see wireChannelPanelEvents) -- selects the channel if
// it wasn't already, and puts it on this panel, toggling off only if it was already there.
function addChannelToPanel(ch, slot){
  if(!ch || isNaN(slot)) return;
  if(VIEWER_SELECTED.indexOf(ch) === -1) VIEWER_SELECTED.push(ch);
  VIEWER_PANEL_ASSIGN[ch] = (VIEWER_PANEL_ASSIGN[ch] === slot) ? undefined : slot;
  if(VIEWER_PANEL_ASSIGN[ch] === undefined) delete VIEWER_PANEL_ASSIGN[ch];
  markLayoutDirty();
  renderViewerBody();
}
// The DOM is the source of truth after a drag -- read the order back out of it rather than trying
// to model the moves.
function commitDragOrder(body, pinned){
  var sel = 'tr[data-ch]' + (pinned ? '.dlv-row-pinned' : ':not(.dlv-row-pinned)');
  var order = [].slice.call(body.querySelectorAll(sel)).map(function(tr){ return tr.getAttribute('data-ch'); });
  if(pinned){ VIEWER_PINNED = order; return; }
  // Only the currently-visible rows were dragged; anything filtered out keeps its relative place at
  // the end, so a drag performed while searching doesn't silently discard the rest of the list.
  var seen = {};
  order.forEach(function(c){ seen[c] = 1; });
  VIEWER_CHAN_ORDER = order.concat(VIEWER_DATA.channels.filter(function(c){ return !seen[c] && !isPinned(c); }));
}

function sortRows(rows){
  var gaugeSet = gaugeChannelSet();
  var col = VIEWER_SORT.col, dir = VIEWER_SORT.dir;
  return rows.slice().sort(function(a, b){
    var av, bv;
    if(col === 'name'){ av = a.toLowerCase(); bv = b.toLowerCase(); }
    else if(col === 'unit'){ av = (VIEWER_UNIT_BY_CHANNEL[a]||''); bv = (VIEWER_UNIT_BY_CHANNEL[b]||''); }
    else if(col === 'selected'){ av = VIEWER_SELECTED.indexOf(a) !== -1 ? 1 : 0; bv = VIEWER_SELECTED.indexOf(b) !== -1 ? 1 : 0; }
    else if(col === 'upper'){ av = VIEWER_PANEL_ASSIGN[a] === 1 ? 1 : 0; bv = VIEWER_PANEL_ASSIGN[b] === 1 ? 1 : 0; }
    else if(col === 'lower'){ av = VIEWER_PANEL_ASSIGN[a] === 2 ? 1 : 0; bv = VIEWER_PANEL_ASSIGN[b] === 2 ? 1 : 0; }
    else if(col === 'gauge'){ av = gaugeSet[a] ? 1 : 0; bv = gaugeSet[b] ? 1 : 0; }
    else { av = a; bv = b; }
    if(av < bv) return -1 * dir;
    if(av > bv) return 1 * dir;
    return a.localeCompare(b);
  });
}

function sortedFilteredChannels(){
  var q = VIEWER_SEARCH.toLowerCase();
  var gaugeSet = gaugeChannelSet();
  var rows = VIEWER_DATA.channels.filter(function(c){ return channelPassesKind(c) && (!q || c.toLowerCase().indexOf(q) !== -1); });
  var col = VIEWER_SORT.col, dir = VIEWER_SORT.dir;
  rows.sort(function(a, b){
    var av, bv;
    if(col === 'name'){ av = a.toLowerCase(); bv = b.toLowerCase(); }
    else if(col === 'unit'){ av = (VIEWER_UNIT_BY_CHANNEL[a]||''); bv = (VIEWER_UNIT_BY_CHANNEL[b]||''); }
    else if(col === 'selected'){ av = VIEWER_SELECTED.indexOf(a) !== -1 ? 1 : 0; bv = VIEWER_SELECTED.indexOf(b) !== -1 ? 1 : 0; }
    else if(col === 'upper'){ av = VIEWER_PANEL_ASSIGN[a] === 1 ? 1 : 0; bv = VIEWER_PANEL_ASSIGN[b] === 1 ? 1 : 0; }
    else if(col === 'lower'){ av = VIEWER_PANEL_ASSIGN[a] === 2 ? 1 : 0; bv = VIEWER_PANEL_ASSIGN[b] === 2 ? 1 : 0; }
    else if(col === 'gauge'){ av = gaugeSet[a] ? 1 : 0; bv = gaugeSet[b] ? 1 : 0; }
    else { av = a; bv = b; }
    if(av < bv) return -1 * dir;
    if(av > bv) return 1 * dir;
    return a.localeCompare(b);
  });
  return rows;
}

function renderChannelPanelHtml(){
  if(VIEWER_LEFT_COLLAPSED){
    return '<div class="dlv-channel-panel dlv-collapsed"><div class="dlv-channel-toolbar"><button type="button" class="dlv-channel-collapse-btn" id="dlvCollapseBtn" title="Expand">&#9656;</button></div></div>';
  }
  var rows = renderChannelRowsHtml();
  return '' +
  '<div class="dlv-channel-panel">' +
    '<div class="dlv-channel-toolbar">' +
      '<button type="button" class="dlv-channel-collapse-btn" id="dlvCollapseBtn" title="Collapse">&#9666;</button>' +
      // inputmode="none" suppresses the phone's own keyboard. On a 412px-tall landscape phone the
      // native keyboard covers well over half the screen, so you type a letter and can't see a
      // single result -- the exact thing you're filtering for (Ken, 2026-07-21). The compact keypad
      // below replaces it at about a third of the height.
      '<div class="dlv-search-wrap' + (VIEWER_SEARCH ? ' dlv-has-text' : '') + '">' +
        '<input type="text" class="dlv-channel-search" id="dlvChannelSearch" placeholder="Filter channels..."' +
          (isMobileViewer() ? ' inputmode="none" autocomplete="off" autocorrect="off" spellcheck="false"' : '') +
          ' value="' + escapeHtml(VIEWER_SEARCH) + '">' +
        '<button type="button" class="dlv-search-clear" id="dlvSearchClear" title="Clear filter" aria-label="Clear filter" tabindex="-1">&times;</button>' +
      '</div>' +
      // PROTOTYPE control -- lets the two list models be compared on the same log without a reload.
      (VIEWER_CHAN_PROTOTYPE
        ? '<button type="button" class="dlv-chanmode-btn" id="dlvChanModeBtn" title="' +
            (chanModeGrouped() ? 'Grouped list -- click for a flat list' : 'Flat list -- click to group') +
            '">' + (chanModeGrouped() ? '&#9776;' : '&#8801;') + '</button>'
        : '') +
      renderKindBarHtml() +
    '</div>' +
    (isMobileViewer() ? renderKeypadHtml() : '') +
    '<div class="dlv-channel-inner">' +
      '<div class="dlv-channel-table-wrap"><table class="dlv-channel-table"><colgroup>' +
        '<col style="width:18px">' +
        '<col style="width:30px">' + (VIEWER_CHAN_PROTOTYPE ? '<col style="width:22px">' : '') +
        '<col class="dlv-col-fav" style="width:22px">' +
        '<col><col style="width:28px"><col style="width:44px">' +
      '</colgroup><thead><tr>' +
        '<th class="dlv-th-center" title="Drag to reorder"></th>' +
        '<th class="dlv-th-center" data-sort="selected" title="Selected">Sel</th>' +
        (VIEWER_CHAN_PROTOTYPE ? '<th class="dlv-th-center" title="Pin to top"></th>' : '') +
        // Not sortable: the stars already sort themselves, into the Favorites section at the top.
        '<th class="dlv-th-center dlv-th-fav" title="Starred channels sit in Favorites at the top of the list">&#9733;</th>' +
        '<th data-sort="name">Channel</th>' +
        '<th class="dlv-th-center" data-sort="upper" title="Upper Graph (top) / Lower Graph (bottom)">U/L</th>' +
        '<th class="dlv-th-center" data-sort="gauge" title="Used by the active Gauge preset">Gauge</th>' +
      '</tr></thead><tbody id="dlvChannelBody">' + rows + '</tbody></table></div>' +
      '<div class="dlv-channel-footer"><span>' + VIEWER_SELECTED.length + ' of ' + VIEWER_DATA.channels.length + ' channels selected</span><button type="button" class="dlv-clear-all" id="dlvClearAllBtn">Clear All</button></div>' +
    '</div>' +
  '</div>';
}

// ---------------------------------------------------------------------------------------------
// Dynamic numeric cards (Default View)
// ---------------------------------------------------------------------------------------------
function renderCardsHtml(){
  var mobile = isMobileViewer();
  var visible = VIEWER_CARDS_EXPANDED ? VIEWER_SELECTED : VIEWER_SELECTED.slice(0, VIEWER_CARDS_MAX_COLLAPSED);
  var hiddenCount = VIEWER_SELECTED.length - visible.length;
  var cards = visible.map(function(ch){
    var color = channelColor(ch);
    var unit = VIEWER_UNIT_BY_CHANNEL[ch];
    var stats = VIEWER_CHANNEL_STATS[ch];
    // Phone cards get the short name; the title keeps the real one for a long-press. Desktop has
    // the width for the full name and reads better with it.
    var label = (mobile && typeof shortChannelName === 'function') ? shortChannelName(ch) : ch;
    return '<div class="dlv-card" style="border-left-color:' + color + '" data-card-ch="' + escapeHtml(ch) + '">' +
      '<div class="dlv-card-label" title="' + escapeHtml(ch) + '">' + escapeHtml(label) + '</div>' +
      '<div><span class="dlv-card-value' + (isTextChannel(ch) ? ' dlv-card-value-text' : '') + '" style="color:' + color + '" data-card-value>--</span>' + (unit && unit !== 'na' ? '<span class="dlv-card-unit">' + escapeHtml(unit) + '</span>' : '') + '</div>' +
      (stats ? '<div class="dlv-card-stats">Min ' + formatReadoutValue(stats.min) + ' &middot; Max ' + formatReadoutValue(stats.max) + ' &middot; Avg ' + formatReadoutValue(stats.avg) + '</div>' : '') +
    '</div>';
  }).join('');
  var more = hiddenCount > 0 ? '<div class="dlv-cards-more" id="dlvCardsMoreBtn">+ ' + hiddenCount + ' more selected channel' + (hiddenCount===1?'':'s') + '</div>' : (VIEWER_CARDS_EXPANDED && VIEWER_SELECTED.length > VIEWER_CARDS_MAX_COLLAPSED ? '<div class="dlv-cards-more" id="dlvCardsMoreBtn">Show fewer</div>' : '');
  // Density tier drives how small the cards get as you add channels. Chosen in JS because CSS can't
  // ask "how many children will there be?" -- it can only react once they've already overflowed,
  // which on a phone means after they've run under the channels button.
  var density = '';
  if(mobile) density = ' dlv-cards-d' + (visible.length <= 5 ? '1' : visible.length <= 10 ? '2' : '3');
  return '<div class="dlv-cards-row' + density + '" id="dlvCardsRow">' + cards + more + '</div>';
}

// ---------------------------------------------------------------------------------------------
// Text (categorical) channels
// ---------------------------------------------------------------------------------------------
// HP Tuners logs its "source" parameters as text -- Spark Source = "Borderline", Fuel System #1
// Status = "CL - Normal". The parsers encode those columns as integer level indices plus a label
// table (VIEWER_DATA.textLevels), so everything downstream still sees plain number arrays. These
// two helpers are the only places that need to know: a channel is categorical iff it has a level
// table, and its "value" is the label at that index, not the number.
// Above this many distinct states a channel is treated as text-that-happens-to-vary rather than a
// state channel: it still reads correctly everywhere, it just doesn't get one axis tick per level.
var MAX_LABELLED_LEVELS = 24;

function textLevelsFor(ch){
  return (VIEWER_DATA && VIEWER_DATA.textLevels && VIEWER_DATA.textLevels[ch]) || null;
}
function isTextChannel(ch){ return !!textLevelsFor(ch); }

// ---- Value labels (number -> text) for state channels logged as codes ---------------------------
// SCT logs Spark Source / Torque Source / ... as numbers where HP Tuners logs text. The user's own
// code -> label maps (per channel name, edited in a Table gauge's menu) live here, layered over the
// presets' built-in VALUE_LABEL_DEFAULTS, and apply everywhere a value is read out.
var VIEWER_VALUE_LABELS = null;
var VIEWER_VALUE_LABELS_KEY = 'pbdDatalogViewerValueLabels.v1';
function userValueLabels(){
  if(VIEWER_VALUE_LABELS) return VIEWER_VALUE_LABELS;
  try { var raw = window.localStorage ? localStorage.getItem(VIEWER_VALUE_LABELS_KEY) : null; VIEWER_VALUE_LABELS = raw ? (JSON.parse(raw) || {}) : {}; }
  catch(err){ VIEWER_VALUE_LABELS = {}; }
  return VIEWER_VALUE_LABELS;
}
function setUserValueLabels(ch, map){
  var all = userValueLabels();
  if(map && Object.keys(map).length) all[ch] = map; else delete all[ch];
  try { if(window.localStorage) localStorage.setItem(VIEWER_VALUE_LABELS_KEY, JSON.stringify(all)); } catch(err){}
}
function valueLabelsForChannel(ch){
  if(!ch || typeof valueLabelsFor !== 'function') return null;
  return valueLabelsFor(ch, userValueLabels()[ch] || null);
}
function formatReadoutValue(v, ch){
  var levels = ch ? textLevelsFor(ch) : null;
  if(levels){
    if(v == null || !isFinite(v)) return '--';
    return levels[Math.round(v)] != null ? levels[Math.round(v)] : '--';
  }
  if(v == null || !isFinite(v)) return '--';
  var vl = valueLabelsForChannel(ch), vt = (vl && typeof valueLabelText === 'function') ? valueLabelText(vl, v) : null;
  if(vt != null) return vt;
  // a state channel (it has a label table) whose code is not in the table: show the bare id, not "43.00"
  if(vl && Math.abs(v - Math.round(v)) < 1e-9) return String(Math.round(v));
  if(Math.abs(v) >= 1000) return v.toFixed(0);
  if(Math.abs(v) >= 100) return v.toFixed(1);
  return v.toFixed(2);
}

// ---------------------------------------------------------------------------------------------
// Graph panel headers (chips + controls) -- the actual <canvas> is built by rebuildChart()
// ---------------------------------------------------------------------------------------------
// The per-graph header bar is GONE (Ken, 2026-07-21). It cost a full bar of height on every panel
// and mostly held things that weren't doing anything -- a Line select with one option, a static
// "Auto Scale" label, and two data-soon placeholders. What it did carry that mattered was the
// channel list, which now lives INSIDE the graph, top-right, in the abbreviated form, with live
// values. Same information, no height.
//
// The × on each chip is preserved as click-to-remove on the legend row, so nothing became
// unreachable; "+ Add Channel" was already redundant with the U/M/L buttons in the channel list,
// which is where people actually assign channels.
// ---- PRO FEATURE GATING -----------------------------------------------------------------------
// One mechanism for every paid feature, so gating a new one is a two-line job rather than bespoke
// UI each time. A gated control is still RENDERED -- greyed, non-interactive, and explaining itself
// on hover. Hiding it would mean free users never discover what they'd be buying.
//
// DEFAULTS TO LOCKED (2026-07-25, Ken). A host must OPT IN to Pro by declaring the user IS Pro,
// either declaratively before the viewer loads:
//     window.DATAVIEWER = { isPro: true };
// or at any time afterwards (e.g. once auth resolves):
//     setViewerPro(true);
// Only an explicit `true` unlocks -- undefined/null/missing/false all stay LOCKED. This is
// fail-CLOSED on purpose. The old default was fail-OPEN, which handed every paid feature to anyone
// who loaded the viewer on a host that simply never set the flag -- trivially exploitable. Now a host
// that wants Pro has to say so. Hosts that grant it: alldatalogs (setViewerPro(isPro) from the account
// system), the staff ticket UI + the dev harness (isPro:true -- staff/dev always get everything).
// CAVEAT: this stops the accidental giveaway, but a client flag is still NOT enforcement -- a user can
// set isPro=true in devtools. Any feature with a real server cost must ALSO be gated server-side; this
// flag only decides what the UI offers.
var PRO_LOCK_MSG = 'Activate Pro for all features';
// The explicit Pro answer is cached in MODULE scope, not only on window.DATAVIEWER. A host's
// configureViewer() rebuilds window.DATAVIEWER wholesale, and some deployed runtime.js versions do NOT
// carry isPro across that rebuild -- so a Pro flag set via setViewerPro() gets wiped. That was invisible
// under the old fail-OPEN default (undefined read as unlocked), but fail-CLOSED turned the wipe into a
// silent RE-LOCK of a genuine Pro user (alldatalogs, 2026-07-25: the saved-layouts effect calls
// configureViewer right after setViewerPro on the same [ready,isPro] change). Module scope survives the
// rebuild. null = never set explicitly, so fall back to a declarative window.DATAVIEWER.isPro.
var VIEWER_PRO_EXPLICIT = null;
function viewerIsPro(){
  if(VIEWER_PRO_EXPLICIT !== null) return VIEWER_PRO_EXPLICIT;
  return (window.DATAVIEWER || {}).isPro === true;
}
// Entitlement usually resolves AFTER auth, which is after the viewer has already painted -- so a
// read-once flag would leave whatever state the first frame happened to guess. This lets the host
// answer late and repaints the affected controls.
window.setViewerPro = function(isPro){
  var d = window.DATAVIEWER || (window.DATAVIEWER = {});
  var was = viewerIsPro();
  VIEWER_PRO_EXPLICIT = (isPro === true);
  d.isPro = VIEWER_PRO_EXPLICIT;   // keep window in sync for any external reader; module cache is authoritative
  if(viewerIsPro() === was) return;
  // Losing Pro mid-session must also revoke what the feature already did, or a demoted user keeps
  // a working race axis they can no longer set.
  if(!viewerIsPro()) VIEWER_RACE_ZERO = null;
  // Same demotion, Histograms edition: showsHistograms() is gated, but the mode itself was not reset,
  // so a demoted user landed on a blank top pane (neither cards nor tables, since VIEWER_VIEW_MODE
  // still read 'histograms') until they happened to pick a different view.
  if(!viewerIsPro() && VIEWER_VIEW_MODE === 'histograms') VIEWER_VIEW_MODE = 'default';
  // Same demotion, Custom Gauges edition: the old 'customdash' mode had no equivalent clamp at all,
  // so a demoted user with it left in sessionStorage would still render the dash view on next load.
  if(!viewerIsPro() && VIEWER_GAUGE_SUBMODE === 'custom') VIEWER_GAUGE_SUBMODE = 'default';
  // Repaint EVERY gated control on a late entitlement change, not just the race block: the header's
  // Compare and performance-data buttons are gated the same way and were being left stale (they
  // happened to be correct only because entitlement usually resolves before the first log opens).
  // A full body repaint is safe now that rebuildChart preserves the zoom window across a rebuild;
  // fall back to the race-only refresh when there is no open log to rebuild.
  // A promotion that lands AFTER the log opened has to re-run the restores it gated. Starting the app
  // by double-clicking a log is exactly that order: the viewer opens, then the licence resolves -- and
  // the tuner's remembered dash and last saved Layout were both skipped a moment earlier, so the log
  // came up on the auto-matched fascia with the header naming a view that was never chosen.
  if(viewerIsPro() && VIEWER_DATA){
    if(!(VIEWER_DASH && VIEWER_DASH.gauges && VIEWER_DASH.gauges.length) && restoreLastDash() &&
       VIEWER_SUBMODE_WANTED === 'custom' && VIEWER_VIEW_MODE !== 'histograms'){
      VIEWER_GAUGE_SUBMODE = 'custom';
      VIEWER_VIEW_MODE = 'gauge';
    }
    if(!VIEWER_VEHICLE_CONFIGS.length && !VIEWER_AUTO_CONFIG && !VIEWER_LAYOUT_DIRTY &&
       !(VIEWER_CURRENT_LAYOUT && VIEWER_CURRENT_LAYOUT.kind === 'saved')) reapplyLastSaved();
  }
  if(VIEWER_DATA && document.getElementById('viewerContent')) renderViewerBody();
  else if(document.getElementById('dlvRace')) refreshRaceUi();
  closeGraphMenu();
};

// ---- Scorecard: INTERNAL-ONLY gate (fail-closed) ---------------------------------------------
// The Scorecard dash component is a PBD-internal feature, HIDDEN by default everywhere. A host enables
// it only for an internal context: the staff/ticket viewer, or a signed-in PBD-staff email domain.
// Gating is at the GAUGE level -- a dash that contains a scorecard still loads and shows every OTHER
// gauge; only the scorecard is withheld (not placed) for users without permission, and its saved config
// is preserved so it reappears for a permitted user. Default false = safe even if a host never sets it.
var VIEWER_SCORECARD_ENABLED = false;
function scorecardEnabled(){ return VIEWER_SCORECARD_ENABLED === true; }
var SCORECARD_STAFF_DOMAINS = ['pbdyno.com'];   // email domains treated as PBD-internal (confirm exact domain)
// Individual sign-ins treated as PBD-internal too (Ken, 2026-09-09: his personal account should see it).
var SCORECARD_STAFF_EMAILS = ['kenbjonnes@gmail.com'];
window.setScorecardEnabled = function(on){
  var was = VIEWER_SCORECARD_ENABLED;
  VIEWER_SCORECARD_ENABLED = (on === true);
  // Permission can resolve AFTER the dash has painted -- re-place gauges so the scorecard appears/hides.
  if(VIEWER_SCORECARD_ENABLED !== was && typeof showsCustomDash === 'function' && showsCustomDash() && document.getElementById('dlvDashCanvas')){
    renderCustomDashView();
  }
};
// Host convenience: enable when the signed-in email is a PBD-staff domain. Only ever turns it ON (the
// default is OFF/fail-closed), so a non-staff email never accidentally overrides a ticket-context enable.
window.setScorecardEnabledForEmail = function(email){
  var addr = (email && typeof email === 'string') ? email.trim().toLowerCase() : '';
  var dom = addr.split('@')[1] || '';
  var ok = SCORECARD_STAFF_DOMAINS.indexOf(dom) !== -1 || SCORECARD_STAFF_EMAILS.indexOf(addr) !== -1;
  if(ok) window.setScorecardEnabled(true);
  return ok;
};

// ---- Visible time range: host / sibling-module surface ------------------------------------------
// Histograms (a separate script that only sees globals) and scorecards evaluate over the VISIBLE
// window, not the whole log, and Histograms jumps the graphs to a cell's samples -- so the zoom
// window has to be readable, observable and settable from outside. The write used to be duplicated
// in four places in this file (arrow-key zoom, Reset Zoom, both scrubber drags); setVisibleRange is
// now the one path, and every change already funnels through updateScrubberWindow -> notify.
window.getVisibleRange = getVisibleRange;
window.setVisibleRange = setVisibleRange;
window.onVisibleRangeChange = onVisibleRangeChange;
window.offVisibleRangeChange = offVisibleRangeChange;

// Markup helpers -- `proLockClass()` on the control, `proLockTip()` inside it.
function proLockClass(){ return viewerIsPro() ? '' : ' dlv-pro-locked'; }
function proLockTip(){
  return viewerIsPro() ? '' :
    '<span class="dlv-pro-tip"><b>Pro feature</b>' + PRO_LOCK_MSG + '</span>';
}
// Wrap any handler so a locked feature can't fire it, wherever it's invoked from.
function proGuard(fn){
  return function(){
    if(!viewerIsPro()) return;
    return fn.apply(this, arguments);
  };
}

// ---- RACE TIME --------------------------------------------------------------------------------
// Drag-analysis mode: park the cursor at the launch (or any reference point), hit Set, and time is
// reported RELATIVE to that instant -- so "how long from launch to the 1-2 shift" is a number you
// read rather than a subtraction you do in your head.
//
// Deliberately an OFFSET over the untouched data, not a rewrite of the timebase: VIEWER_DATA.time
// keeps its original values, so charts, zoom, the scrubber and every existing calculation are
// unaffected, "Clear" is just setting this back to null, and nothing has to be re-parsed. The
// offset is in log seconds.
//
// Reset per log (openViewerCore) rather than persisted: a zero point is a statement about one
// specific capture's timeline and means nothing carried to the next file.
var VIEWER_RACE_ZERO = null;

// The last place the cursor was deliberately put, which OUTLIVES the mouse leaving the chart.
// CROSSHAIR_TIME can't serve this: handleChartLeave() nulls it, so the moment you move off the
// graph to click "Set 0" the position you just parked is gone and the button would quietly zero on
// the last sample instead of where you were pointing. Anything asking "where is the user looking?"
// after the pointer has moved away wants this, not CROSSHAIR_TIME.
var VIEWER_CURSOR_TIME = null;

// Signed, fixed 3dp, always with an explicit + so "before the zero point" is unmistakable at a
// glance. Drag times are read to the thousandth, so this doesn't use formatReadoutValue's
// magnitude-based precision.
function formatRaceTime(t){
  if(VIEWER_RACE_ZERO == null || t == null || !isFinite(t)) return '--';
  var d = t - VIEWER_RACE_ZERO;
  var s = Math.abs(d).toFixed(3);
  return (d < 0 ? '-' : '+') + s;
}
var RACE_HINT = 'Right-click anywhere on a graph to set the zero point there.';

function renderRaceTimeHtml(){
  var armed = VIEWER_RACE_ZERO != null;
  return '<div class="dlv-race' + (armed ? ' armed' : '') + '" id="dlvRace">' +
    '<div class="dlv-race-label">Race</div>' +
    '<div class="dlv-race-value" id="dlvRaceValue">' + (armed ? '+0.000' : '--') + '</div>' +
    '<div class="dlv-race-unit">s</div>' +
    '<button type="button" class="dlv-race-btn' + proLockClass() + '" id="dlvRaceSetBtn" title="' +
      (viewerIsPro() ? RACE_HINT : PRO_LOCK_MSG) + '">' +
      'Set 0' + (viewerIsPro() ? '<span class="dlv-race-tip">' + RACE_HINT + '</span>' : proLockTip()) +
    '</button>' +
    (armed ? '<button type="button" class="dlv-race-btn dlv-race-clear" id="dlvRaceClearBtn" title="Clear the zero point">&times;</button>' : '') +
  '</div>';
}

// Setting zero must NOT go through renderViewerBody: that rebuilds the charts, which throws away
// the current zoom/pan. Zooming in on the launch and then setting zero is the whole workflow, so
// losing the zoom at the moment you set it would be worse than useless. Repaint just this block.
function refreshRaceUi(){
  var el = document.getElementById('dlvRace');
  if(el){
    el.outerHTML = renderRaceTimeHtml();
    wireRaceTime();
  }
  updateRaceMarker();
  refreshTimeAxes();
  updateAtCursor(CROSSHAIR_TIME);
  // The comparison offset is derived from A's zero, so changing it MUST move the overlay. Without
  // this the alignment was order-dependent: setting A's zero first worked (B contributes nothing
  // until it has its own anchor), but setting B's zero first and then A's left B exactly where it
  // was, because nothing re-pointed its datasets (Ken, 2026-07-22: "I set zero times for both logs
  // ... but they didn't align").
  refreshCompareUi();
}

function setRaceZero(t){
  // Guarded at the entry point, not just at the button. UI-only gating is decoration -- anything
  // that can reach this (a keyboard shortcut, a saved view, a future host call) must hit the same
  // check, so there is exactly one place the answer is decided.
  if(!viewerIsPro()){ adlTrack('paywall_viewed', { feature: 'race_time', trigger: 'set_zero' }); return; }
  if(t == null || !isFinite(t)) return;
  VIEWER_RACE_ZERO = t;
  refreshRaceUi();
  adlTrack('race_time_used', {});
}

// ---- race-time axis ---------------------------------------------------------------------------
// With a zero point set, the x-axis switches to elapsed race time. Ticks are then generated
// RELATIVE TO ZERO rather than by Chart.js's own spacing, because the whole point is landing on
// round race numbers -- 0.0 / 0.5 / 1.0 -- not on round log times that read as 46.99 / 47.49.
//
// The step tightens automatically as you zoom: it's the smallest "nice" interval that still leaves
// room to label, so a hard zoom keeps subdividing past 0.1s down to hundredths, which is the
// resolution drag analysis actually needs.
// A strict 1-2-5 ladder. 0.25 was in here and had to go: raceTickDecimals gives it 1 decimal, so a
// tick at -1.25 rendered as "-1.3" -- a label that doesn't say what the gridline means, which on a
// timing axis is worse than a coarser step.
var RACE_TICK_STEPS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300];
// Minimum pixels between LABELS. 34, well under the ~58 a generic axis wants: race labels are
// short, fixed-width and drawn a size smaller than the normal axis, and the brief is that zooming
// must actually REACH 0.1s increments and keep subdividing past it.
var RACE_TICK_MIN_PX = 34;
// Unlabelled subdivisions drawn between each pair of labels. Gives the eye something to measure
// against between numbers -- the reason a real timing scale has fine gradations -- without printing
// a number every few pixels.
var RACE_MINOR_PER_MAJOR = 5;

function raceTickStep(span, pxWidth){
  var maxTicks = Math.max(2, Math.floor((pxWidth || 600) / RACE_TICK_MIN_PX));
  for(var i = 0; i < RACE_TICK_STEPS.length; i++){
    if(span / RACE_TICK_STEPS[i] <= maxTicks) return RACE_TICK_STEPS[i];
  }
  return RACE_TICK_STEPS[RACE_TICK_STEPS.length - 1];
}
// Decimals follow the step, so a 0.05s grid isn't labelled "1" four times in a row.
function raceTickDecimals(step){
  if(step < 0.1) return 2;
  if(step < 1) return 1;
  return 0;
}
function formatAxisTime(v, step){
  if(VIEWER_RACE_ZERO == null) return v;
  var d = v - VIEWER_RACE_ZERO;
  var dp = raceTickDecimals(step || 0.1);
  var s = Math.abs(d).toFixed(dp);
  return (d < 0 ? '-' : (d > 0 ? '+' : '')) + s;
}
function raceAxisTitle(){
  return VIEWER_RACE_ZERO != null ? 'Race time (s)' : 'Time (s)';
}
// Re-derives ticks/titles on every chart without rebuilding them, so switching race mode on or off
// never costs the current zoom.
function refreshTimeAxes(){
  Object.keys(viewerCharts).forEach(function(k){
    var c = viewerCharts[k];
    if(!c || !c.options || !c.options.scales || !c.options.scales.x) return;
    if(c.options.scales.x.title) c.options.scales.x.title.text = raceAxisTitle();
    c.update('none');
  });
}

// ---- graph right-click menu -------------------------------------------------------------------
// Right-click used to set the zero point immediately. It worked, but silently: the only
// confirmation was a toast, and showToast falls back to console.info in both the dev harness and
// the alldatalogs runtime unless the host supplies its own -- so in practice there was NO visible
// feedback and it read as "nothing happened" (Ken, 2026-07-22).
// A menu fixes that twice over: it names the action before it happens, and it shows the exact time
// you're about to zero on, so a click that lands a few pixels off is obvious before you commit.
var VIEWER_GRAPH_MENU = null;
function closeGraphMenu(){
  if(VIEWER_GRAPH_MENU){ VIEWER_GRAPH_MENU.remove(); VIEWER_GRAPH_MENU = null; }
}
document.addEventListener('click', closeGraphMenu);
document.addEventListener('keydown', function(e){ if(e.key === 'Escape') closeGraphMenu(); });
// The performance-data dropdown follows the same dismiss rules as the graph menu.
document.addEventListener('click', function(){ if(typeof closePerfMenu === 'function') closePerfMenu(); });
document.addEventListener('keydown', function(e){
  if(e.key === 'Escape' && typeof closePerfMenu === 'function') closePerfMenu();
});

function openGraphMenu(e, dataX, channels, chart){
  closeGraphMenu();
  closeGaugeMenu();
  var armed = VIEWER_RACE_ZERO != null;
  // Per-channel Y-axis min/max editor. Categorical channels are label-pinned (no numeric range), so
  // they're skipped. Inputs pre-fill from the axis's CURRENT range so the user tweaks rather than
  // guesses; Set stores an override (used in rebuildChart's scale config), Auto clears it.
  var axisRows = (channels || []).filter(function(ch){ return !isTextChannel(ch); }).map(function(ch){
    var sc = chart && chart.scales ? chart.scales[ch] : null;
    var lo = sc && isFinite(sc.min) ? +(+sc.min).toFixed(2) : '';
    var hi = sc && isFinite(sc.max) ? +(+sc.max).toFixed(2) : '';
    return '<div class="dlv-ctx-axis" data-ch="' + escapeHtml(ch) + '">' +
      '<span class="dlv-ctx-axis-name" title="' + escapeHtml(ch) + '">' + escapeHtml(shortChannelName(ch)) + '</span>' +
      '<input class="dlv-ctx-axis-in dlv-axis-min" type="number" step="any" value="' + lo + '" aria-label="min" placeholder="min">' +
      '<input class="dlv-ctx-axis-in dlv-axis-max" type="number" step="any" value="' + hi + '" aria-label="max" placeholder="max">' +
      '<button type="button" class="dlv-ctx-axis-btn" data-a="axis-set">Set</button>' +
      (VIEWER_AXIS_OVERRIDE[ch] ? '<button type="button" class="dlv-ctx-axis-btn dlv-ctx-axis-auto" data-a="axis-auto" title="Back to auto-scale">Auto</button>' : '') +
    '</div>';
  }).join('');
  var m = document.createElement('div');
  m.className = 'dlv-ctxmenu';
  m.addEventListener('click', function(ev){ ev.stopPropagation(); });
  m.addEventListener('contextmenu', function(ev){ ev.preventDefault(); ev.stopPropagation(); });
  // With a comparison loaded there are two logs you might be pointing at, so the menu names them
  // instead of assuming (Ken, 2026-07-22: "for the set zero on the right click just have both logs
  // as an option"). Without one, the wording stays as it was.
  var cmp = VIEWER_COMPARE;
  var setLabel = cmp ? 'Set zero here for A &mdash; ' + escapeHtml(shortLogName(VIEWER_FILE_NAME))
                     : 'Set race zero here';
  m.innerHTML =
    '<div class="dlv-ctx-head">' + dataX.toFixed(3) + ' s</div>' +
    '<button type="button" class="dlv-ctx-item' + proLockClass() + '" data-a="set"' +
      (viewerIsPro() ? '' : ' title="' + PRO_LOCK_MSG + '"') + '>' +
      '<span class="dlv-ctx-dot"></span>' + setLabel + proLockTip() + '</button>' +
    (cmp
      ? '<button type="button" class="dlv-ctx-item' + proLockClass() + '" data-a="setb"' +
          (viewerIsPro() ? '' : ' title="' + PRO_LOCK_MSG + '"') + '>' +
          '<span class="dlv-ctx-dot dlv-ctx-dot-b"></span>Set zero here for B &mdash; ' +
          escapeHtml(shortLogName(cmp.name)) + proLockTip() + '</button>' +
        // Both anchors are needed before anything moves: the offset is A's zero minus B's zero.
        '<div class="dlv-ctx-note">' +
          (VIEWER_RACE_ZERO == null ? 'A has no zero yet. ' : '') +
          (cmp.zero == null ? 'B has no zero yet. ' : '') +
          'Alignment uses both.</div>'
      : '') +
    (armed ? '<button type="button" class="dlv-ctx-item" data-a="clear">Clear race zero</button>' +
             '<div class="dlv-ctx-note">Currently zeroed at ' + VIEWER_RACE_ZERO.toFixed(3) + ' s</div>'
           : '') +
    (axisRows ? '<div class="dlv-ctx-sep"></div><div class="dlv-ctx-subhead">Y-axis range</div>' + axisRows : '') +
    '<button type="button" class="dlv-ctx-item dlv-ctx-cancel" data-a="cancel">Cancel</button>';
  document.body.appendChild(m);

  // Same rule as the gauge menu: measure after insertion and flip rather than hang off-screen.
  var mw = m.offsetWidth, mh = m.offsetHeight, pad = 8;
  var left = (e.clientX + mw + pad <= window.innerWidth) ? e.clientX
           : (e.clientX - mw - pad >= 0 ? e.clientX - mw : Math.max(pad, window.innerWidth - mw - pad));
  var top = (e.clientY + mh + pad <= window.innerHeight) ? e.clientY
          : Math.max(pad, window.innerHeight - mh - pad);
  m.style.left = Math.max(pad, left) + 'px';
  m.style.top = Math.max(pad, top) + 'px';
  // The Pro tooltip hangs off the menu's LEFT by default, which puts it off-screen whenever the
  // menu itself is near the left edge -- the same failure Ken hit with the race hint. The menu
  // flips to stay on screen; its tooltip has to flip too, and CSS can't see the menu's position.
  var tip = m.querySelector('.dlv-pro-tip');
  if(tip && Math.max(pad, left) < tip.offsetWidth + pad * 2) m.classList.add('dlv-tip-right');
  VIEWER_GRAPH_MENU = m;

  m.querySelectorAll('.dlv-ctx-item').forEach(function(btn){
    btn.addEventListener('click', function(){
      var a = btn.getAttribute('data-a');
      // A locked item stays on screen so free users can see what Pro buys, but it must not act --
      // and it must not close the menu either, or the click reads as "it worked, nothing happened".
      if(btn.classList.contains('dlv-pro-locked')) return;
      if(a === 'set') setRaceZero(dataX);
      else if(a === 'setb') setCompareZero(dataX);
      else if(a === 'clear'){ VIEWER_RACE_ZERO = null; refreshRaceUi(); }
      closeGraphMenu();
    });
  });

  // Y-axis range rows: Set stores an explicit min/max override, Auto clears it; both rebuild.
  function applyAxisRow(row, toAuto){
    var ch = row.getAttribute('data-ch');
    if(toAuto){ delete VIEWER_AXIS_OVERRIDE[ch]; }
    else {
      var mn = parseFloat(row.querySelector('.dlv-axis-min').value);
      var mx = parseFloat(row.querySelector('.dlv-axis-max').value);
      if(!isFinite(mn) || !isFinite(mx) || mx <= mn) return false;   // invalid -> keep the menu open
      VIEWER_AXIS_OVERRIDE[ch] = { min: mn, max: mx };
    }
    closeGraphMenu();
    rebuildChart();
    return true;
  }
  m.querySelectorAll('.dlv-ctx-axis-btn').forEach(function(btn){
    btn.addEventListener('click', function(){
      applyAxisRow(btn.closest('.dlv-ctx-axis'), btn.getAttribute('data-a') === 'axis-auto');
    });
  });
  // Enter in a min/max input applies that row's Set.
  m.querySelectorAll('.dlv-ctx-axis-in').forEach(function(inp){
    inp.addEventListener('keydown', function(ev){
      if(ev.key === 'Enter'){ ev.preventDefault(); applyAxisRow(inp.closest('.dlv-ctx-axis'), false); }
    });
  });
}

function wireRaceTime(){
  // The button EXPLAINS rather than sets. "Park the cursor, then travel to a button" can't work
  // here -- the crosshair follows the mouse, so by the time you reach the button the position you
  // wanted is gone and you'd be zeroing on wherever the pointer left the plot (Ken, 2026-07-22).
  // Right-click on the graph is the real gesture; this is how people discover it.
  // No toast fallback here: showToast is console-only on both hosts, so a click that "responds"
  // only in devtools is the same as no response. The hover tooltip is the whole affordance.
  var setBtn = document.getElementById('dlvRaceSetBtn');
  if(setBtn) setBtn.addEventListener('click', function(e){ e.preventDefault(); });
  var clearBtn = document.getElementById('dlvRaceClearBtn');
  if(clearBtn) clearBtn.addEventListener('click', function(){
    VIEWER_RACE_ZERO = null;
    refreshRaceUi();
  });
}
// A tick on the overview bar showing WHERE zero is, so the reference point stays visible once you
// zoom or pan away from it.
function updateRaceMarker(){
  var wrap = document.getElementById('dlvScrubberWrap');
  var mark = document.getElementById('dlvRaceMark');
  if(!wrap || !mark || !VIEWER_DATA || !VIEWER_DATA.time.length) return;
  if(VIEWER_RACE_ZERO == null){ mark.style.display = 'none'; return; }
  var fullMin = VIEWER_DATA.time[0], fullMax = VIEWER_DATA.time[VIEWER_DATA.time.length - 1];
  var range = fullMax - fullMin || 1;
  mark.style.display = '';
  mark.style.left = (((VIEWER_RACE_ZERO - fullMin) / range) * (wrap.clientWidth || 1)) + 'px';
}

// ---- COMPARE ----------------------------------------------------------------------------------
// Load a second log and overlay it DASHED on the same graphs (Ken, 2026-07-22: "load a 2nd log that
// is somehow shown differently. dashed lines usually work. and then you can set zero time on both to
// line them up but also nudge").
//
// ALIGNMENT IS THE WHOLE PROBLEM. Two runs never start at the same instant, so overlaying raw time
// puts the traces in unrelated places and the comparison is worthless. Alignment is therefore an
// explicit offset the user controls, seeded from whatever anchor is available:
//   * both logs have a race zero  -> align those (the launch, or wherever they marked it)
//   * otherwise                   -> align the two recordings' starts
// and then NUDGE adjusts from there, because no automatic anchor is ever quite right.
//
// The compare log is only ever DRAWN. It never enters VIEWER_DATA, the channel list, the gauges or
// the cursor readouts, so nothing downstream has to learn about a second dataset.
var VIEWER_COMPARE = null;   // { name, data, roles, zero, nudgeMs }

function compareOffsetMs(){
  if(!VIEWER_COMPARE) return 0;
  // Offset maps compare-time -> primary-time. Race zeros first; failing that, both recordings start
  // together (their own t=0), which is only a starting point for the nudge.
  var base = 0;
  if(VIEWER_RACE_ZERO != null && VIEWER_COMPARE.zero != null){
    base = VIEWER_RACE_ZERO - VIEWER_COMPARE.zero;
  }
  return base * 1000 + (VIEWER_COMPARE.nudgeMs || 0);
}

// Which channel of the SECOND log corresponds to `ch` in the primary? Two logs of the same car
// rarely carry identical channel names -- different HP Tuners templates, a "(SAE)" suffix on one
// side, PTDIAG short codes vs human names -- so an exact-name-only match would leave most
// comparisons empty and look broken (Ken, 2026-07-22: "just should be best effort to match them").
//
// Three passes, most trustworthy first. Returns null only when nothing plausible exists.
function compareChannelFor(ch){
  var cd = VIEWER_COMPARE && VIEWER_COMPARE.data;
  if(!cd) return null;
  // 1. same name. Unambiguous, so never second-guessed.
  if(cd.series[ch]) return { name: ch, exact: true };
  // 2. same ROLE. This is the good one: roles already resolve "Engine RPM" / "ENGINE_SPEED" /
  //    "Engine RPM (SAE)" onto one identity, which is exactly the mismatch we are bridging.
  var roles = VIEWER_RESOLVED_ROLES || {};
  var cRoles = VIEWER_COMPARE.roles || {};
  for(var r in roles){
    if(roles[r] === ch && cRoles[r] && cd.series[cRoles[r]]) return { name: cRoles[r], exact: false };
  }
  // 3. same name ignoring case and a trailing "(SAE)". Catches channels that carry no role at all,
  //    which is most of a 130-channel log.
  if(typeof normalizeChannelForRole === 'function'){
    var want = normalizeChannelForRole(ch);
    for(var i = 0; i < cd.channels.length; i++){
      var cand = cd.channels[i];
      if(normalizeChannelForRole(cand) === want && cd.series[cand]) return { name: cand, exact: false };
    }
  }
  return null;
}

// The comparison trace is drawn at 75% opacity as well as dashed (Ken, 2026-07-22). Two cues rather
// than one: dashes alone read as a different line style, which at a glance can look like a stepped
// or filtered channel, whereas fading it also makes it read as "behind" and secondary.
//
// The alpha is baked into the stroke colour rather than set on the canvas, because Chart.js has no
// per-dataset opacity and a global alpha would fade the primary traces too.
var COMPARE_ALPHA = 0.75;
function fadeColor(c, alpha){
  if(typeof c !== 'string') return c;
  var s = c.trim();
  var m = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if(m){
    var h = m[1];
    if(h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return 'rgba(' + parseInt(h.slice(0, 2), 16) + ',' + parseInt(h.slice(2, 4), 16) + ',' +
           parseInt(h.slice(4, 6), 16) + ',' + alpha + ')';
  }
  // Already rgb()/rgba(): re-alpha it rather than nesting another wrapper.
  var rgb = s.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  if(rgb) return 'rgba(' + rgb[1] + ',' + rgb[2] + ',' + rgb[3] + ',' + alpha + ')';
  return c;   // named colour or something exotic -- leave it, the dashes still distinguish it
}

// One dashed dataset per channel the primary is showing, using the best available match in the
// second log.
function compareDatasetsFor(channels){
  if(!VIEWER_COMPARE || !VIEWER_COMPARE.data) return [];
  var cd = VIEWER_COMPARE.data;
  var offSec = compareOffsetMs() / 1000;
  var out = [];
  channels.forEach(function(ch){
    var match = compareChannelFor(ch);
    if(!match) return;                      // nothing plausible in the second log -- skip
    var vals = cd.series[match.name];
    var levels = cd.textLevels && cd.textLevels[match.name];
    out.push({
      // An inexact match is NAMED in the legend. Silently plotting "Air Load" against
      // "Absolute Load (SAE)" as if they were the same channel would be a quiet lie; showing what
      // it actually matched lets you catch a wrong guess.
      label: ch + (match.exact ? ' (B)' : ' (B: ' + match.name + ')'),
      borderColor: fadeColor(channelColor(ch), COMPARE_ALPHA),
      backgroundColor: 'transparent',
      borderWidth: 1.2,
      // Dashed, dimmer, and BEHIND the primary (it is first in the dataset array). The second log is
      // the reference; the log you opened stays the one you read.
      borderDash: [5, 3],
      pointRadius: 0, pointHoverRadius: 0, hoverRadius: 0,
      stepped: levels ? 'before' : false,
      tension: levels ? 0 : 0.12,
      data: cd.time.map(function(t, i){ return { x: t + offSec, y: vals[i] }; }),
      yAxisID: ch,
      _compare: true,
    });
  });
  return out;
}

// A file name is often long and VIN-stamped ("Log-0009-1ZVBP8CF3D5246050.hpl"); the menu only needs
// enough to tell the two logs apart.
function shortLogName(n){
  n = String(n || 'log').replace(/\.(hpl|csv|ld)$/i, '');
  return n.length > 22 ? n.slice(0, 20) + '…' : n;
}

// Right-clicking on the DASHED trace points at a place on screen, which is primary-log time. The
// second log's own timestamp for that spot is that minus the offset currently applied to it.
//
// The nudge is cleared: it is a correction layered on top of an anchor, so re-anchoring with a stale
// nudge still applied would leave the alignment off by exactly the amount you had dialled in.
function setCompareZero(dataX){
  if(!viewerIsPro() || !VIEWER_COMPARE) return;
  if(dataX == null || !isFinite(dataX)) return;
  VIEWER_COMPARE.zero = dataX - (compareOffsetMs() / 1000);
  VIEWER_COMPARE.nudgeMs = 0;
  // Same reason setRaceZero avoids renderViewerBody: rebuilding the charts discards the zoom, and
  // you set this anchor while zoomed into the launch. Re-point the datasets in place instead.
  refreshCompareUi();
}

function renderCompareBarHtml(){
  if(!VIEWER_COMPARE) return '';
  var off = compareOffsetMs();
  var anchored = (VIEWER_RACE_ZERO != null && VIEWER_COMPARE.zero != null);
  return '' +
  '<div class="dlv-cmp" id="dlvCompareBar">' +
    '<span class="dlv-cmp-swatch"></span>' +
    '<span class="dlv-cmp-name" title="' + escapeHtml(VIEWER_COMPARE.name) + '">' +
      escapeHtml(VIEWER_COMPARE.name) + '</span>' +
    '<span class="dlv-cmp-anchor">' + (anchored ? 'aligned on race zero' : 'aligned on start') + '</span>' +
    '<button type="button" class="dlv-cmp-btn" data-nudge="-500">&laquo;</button>' +
    '<button type="button" class="dlv-cmp-btn" data-nudge="-50">&lsaquo;</button>' +
    '<span class="dlv-cmp-off">' + (off >= 0 ? '+' : '') + (off / 1000).toFixed(2) + 's</span>' +
    '<button type="button" class="dlv-cmp-btn" data-nudge="50">&rsaquo;</button>' +
    '<button type="button" class="dlv-cmp-btn" data-nudge="500">&raquo;</button>' +
    '<button type="button" class="dlv-cmp-btn" data-nudge="0" title="Reset the nudge">0</button>' +
    '<button type="button" class="dlv-cmp-btn dlv-cmp-close" id="dlvCompareClose" title="Remove the comparison">&times;</button>' +
  '</div>';
}

function wireCompareBar(){
  var bar = document.getElementById('dlvCompareBar');
  if(!bar) return;
  bar.addEventListener('click', function(e){
    var btn = e.target.closest('[data-nudge]');
    if(btn){
      var n = Number(btn.getAttribute('data-nudge'));
      VIEWER_COMPARE.nudgeMs = (n === 0) ? 0 : (VIEWER_COMPARE.nudgeMs || 0) + n;
      refreshCompareUi();
      return;
    }
    if(e.target.closest('#dlvCompareClose')){
      VIEWER_COMPARE = null;
      renderViewerBody();
    }
  });
}

// Rebuilding the charts would discard the current zoom, and comparing is precisely when you are
// zoomed in on a pull. So the dashed datasets are re-pointed in place instead.
function refreshCompareUi(){
  if(!VIEWER_COMPARE || !VIEWER_COMPARE.data) return;
  var offSec = compareOffsetMs() / 1000;
  Object.keys(viewerCharts).forEach(function(k){
    var c = viewerCharts[k];
    if(!c) return;
    var moved = false;
    c.data.datasets.forEach(function(ds){
      if(!ds._compare) return;
      // The dataset knows which channel of B it is drawing; re-derive it from the label rather than
      // guessing, since a best-effort match renames it to "A-name (B: B-name)".
      var m = /\(B: (.+)\)$/.exec(ds.label);
      var srcName = m ? m[1] : ds.label.replace(/ \(B\)$/, '');
      var vals = VIEWER_COMPARE.data.series[srcName];
      if(!vals) return;
      ds.data = VIEWER_COMPARE.data.time.map(function(t, i){ return { x: t + offSec, y: vals[i] }; });
      moved = true;
    });
    if(moved) c.update('none');
  });
  var bar = document.getElementById('dlvCompareBar');
  if(!bar) return;
  var off = compareOffsetMs();
  var el = bar.querySelector('.dlv-cmp-off');
  if(el) el.textContent = (off >= 0 ? '+' : '') + (off / 1000).toFixed(2) + 's';
  // The anchor wording is derived state too -- it changes the moment either zero is set.
  var anchorEl = bar.querySelector('.dlv-cmp-anchor');
  if(anchorEl){
    anchorEl.textContent = (VIEWER_RACE_ZERO != null && VIEWER_COMPARE.zero != null)
      ? 'aligned on race zero' : 'aligned on start';
  }
}

// Accepts the same { channels, time, series, textLevels } shape the primary log uses, so any host
// can feed a comparison from wherever it gets logs.
function setCompareLog(name, data){
  if(!data || !data.time || !data.time.length) return;
  var roles = (typeof resolveChannelRoles === 'function') ? resolveChannelRoles(data.channels) : {};
  if(typeof convertUnitsForDisplay === 'function') convertUnitsForDisplay(data);
  if(typeof applyDerivedChannels === 'function') applyDerivedChannels(data, roles);
  if(typeof normalizeLoadScale === 'function') normalizeLoadScale(data, roles);
  VIEWER_COMPARE = { name: name || 'Comparison', data: data, roles: roles, zero: null, nudgeMs: 0 };
  adlTrack('compare_used', { num_logs: 2 });   // primary + the overlaid comparison
  renderViewerBody();
}
window.setCompareLog = setCompareLog;

// Built-in comparison loader: decode a picked file with window.DVCore, the same datalog-core bundle
// the sites load and opened the primary log with. This mirrors the site's own primary pipeline
// (OpenLog.tsx openBytes -> openParsed) STEP FOR STEP so the comparison log is processed identically
// to the one already on screen:
//   * same decoder + options (convertHplToCsv wants pako.inflateRaw injected; interpolate + usUnits
//     match the primary so gaps and units agree),
//   * same MAX_POINTS decimation so both logs share a point density, and
//   * the same RAW shape { channels, units, time, series, totalRows, returnedRows } -- raw values,
//     no display transforms applied. setCompareLog runs convertUnitsForDisplay / applyDerivedChannels
//     / normalizeLoadScale exactly as the primary ingest does, so pre-applying them here would double
//     them up. The two logs must go through the identical transform path or they will not align.
// MAX_POINTS is duplicated from OpenLog.tsx (12000) on purpose: alignment is by time, not index, so a
// mismatch would not misalign, but keeping the density equal keeps the two traces visually consistent.
function builtinLoadLogFile(file){
  var DV = window.DVCore;
  if(!DV || typeof DV.parseDatalogCsv !== 'function'){
    return Promise.reject(new Error('This page has no decoder (window.DVCore) available.'));
  }
  var MAX_POINTS = 12000;
  return file.arrayBuffer().then(function(buf){
    var bytes = new Uint8Array(buf);
    var lower = (file.name || '').toLowerCase();
    var csvText;
    if(lower.slice(-4) === '.hpl'){
      if(typeof DV.convertHplToCsv !== 'function') throw new Error('This page cannot decode .hpl files.');
      var inflate = (window.pako && typeof window.pako.inflateRaw === 'function')
        ? function(d){ return window.pako.inflateRaw(d); } : null;
      csvText = DV.convertHplToCsv(bytes, inflate, { interpolate: true, usUnits: true });
    } else if(lower.slice(-3) === '.ld'){
      if(typeof DV.convertLdToCsv !== 'function') throw new Error('This page cannot decode .ld files.');
      csvText = DV.convertLdToCsv(bytes);
    } else if(lower.slice(-3) === '.dl'){
      if(typeof DV.convertHolleyDlToCsv !== 'function') throw new Error('This page cannot decode Holley .dl files.');
      csvText = DV.convertHolleyDlToCsv(bytes);
    } else {
      csvText = decodeCsvBytes(bytes);
    }
    var parsed = DV.parseDatalogCsv(csvText);
    if(!parsed || !parsed.channelNames || !parsed.channelNames.length){
      throw new Error('No numeric channels found in this file.');
    }
    var total = parsed.time.length;
    var keep = (typeof DV.bucketDecimate === 'function')
      ? DV.bucketDecimate(total, MAX_POINTS)
      : parsed.time.map(function(_, i){ return i; });
    var time = keep.map(function(i){ return parsed.time[i]; });
    var series = {};
    parsed.channelNames.forEach(function(name, ci){
      series[name] = keep.map(function(i){ return parsed.series[ci][i]; });
    });
    return { channels: parsed.channelNames, units: parsed.units, time: time, series: series,
             totalRows: total, returnedRows: time.length };
  });
}

// ---- PERFORMANCE DATA (time slip / lap times / Dragy) -----------------------------------------
// One system, three kinds, because all three are the same thing underneath: a list of elapsed times
// measured from a zero point, drawn as labelled markers so you can see what the engine was doing at
// each one. Keeping them as one model means the drawing, the clearing, the Pro gate and the
// race-mode rule are written once rather than three times.
//
// RACE MODE ONLY (Ken, 2026-07-22): these are elapsed times from a zero, and without a race zero
// there is nothing to measure them from.
//
// THE RECURRING TRAP IN ALL THREE IS "ELAPSED vs INTERVAL", and it bites differently each time:
//   * SLIP  -- reaction time is NOT part of ET. Track timing starts when the car rolls out of the
//              stage beams, not when the light goes green. Adding RT would push every marker late
//              by the reaction time and the overlay would look plausible while being wrong.
//   * LAPS  -- lap times are INTERVALS, so lap 3's marker is lap1+lap2+lap3 past zero, not lap3.
//              Plotting the raw values would stack every lap on top of the first minute.
//   * DRAGY -- roll-on tests (60-130) start when the car reaches the LOWER speed, not at a standing
//              launch, so zero means something different than it does for 0-60.
// Each is handled in perfMarks() below; none of them is handled by accident.
var VIEWER_PERF = null;   // { kind:'slip'|'laps'|'dragy', values:{}, laps:[], test:'' }

// Full drag-strip slip. Order matches the printed slip so entering one is a straight read-down.
var SLIP_FIELDS = [
  { key: 'rt',     label: 'Reaction',  ph: '0.052' },
  { key: 'ft60',   label: '60 ft',     ph: '1.412' },
  { key: 'ft330',  label: '330 ft',    ph: '3.921' },
  { key: 'et8',    label: '1/8 mile',  ph: '5.998' },
  { key: 'mph8',   label: '1/8 MPH',   ph: '118.4' },
  { key: 'ft1000', label: '1000 ft',   ph: '7.812' },
  { key: 'et4',    label: '1/4 mile',  ph: '9.284' },
  { key: 'mph4',   label: '1/4 MPH',   ph: '146.2' },
];
// Only elapsed-time fields get a marker. RT has no position on the track, and the two MPH figures
// are trap speeds that ride along on their ET marker's label rather than standing alone.
var SLIP_MARKS = [
  { key: 'ft60',   label: "60'"   },
  { key: 'ft330',  label: "330'"  },
  { key: 'et8',    label: '1/8',   mphKey: 'mph8' },
  { key: 'ft1000', label: "1000'" },
  { key: 'et4',    label: '1/4',   mphKey: 'mph4' },
];

// Dragy runs one test at a time, so the test is chosen FIRST and it decides the fields -- a single
// combined form would ask for a trap speed on a 0-60 run.
//
// A Dragy report is a LADDER, not one number (Ken, 2026-07-22): a 60-130 run prints 60-70, 60-80,
// 60-90, 60-100, 60-110, 60-120, 60-130. Asking only for the final time threw away everything
// interesting -- the whole point is seeing what the engine did between each step. Speed runs are
// therefore generated in 10 mph increments, all measured from the SAME start speed.
//
// `zeroIs` is not decoration. The user sets race zero wherever they judge the run began, and that
// point differs by test: a roll-on 60-130 starts when the car crosses 60 mph, not at a standing
// launch, so zeroing at a launch would be wrong by however long it took to get to 60.
function dragySpeedFields(from, to){
  var out = [];
  for(var v = from + 10; v <= to; v += 10){
    out.push({ key: 's' + v, label: from + '-' + v, ph: '0.00' });
  }
  return out;
}
var DRAGY_TESTS = [
  { id: '0-60',   label: '0-60 mph',   zeroIs: 'the launch', kind: 'speed',
    fields: dragySpeedFields(0, 60) },
  { id: '0-100',  label: '0-100 mph',  zeroIs: 'the launch', kind: 'speed',
    fields: dragySpeedFields(0, 100) },
  { id: '60-130', label: '60-130 mph', zeroIs: 'the moment you cross 60 mph', kind: 'speed',
    fields: dragySpeedFields(60, 130) },
  { id: '1-8',    label: '1/8 mile',   zeroIs: 'the launch', kind: 'dist',
    fields: [{ key: 'ft60',  label: '60 ft',  ph: '1.412' },
             { key: 'ft330', label: '330 ft', ph: '3.921' },
             { key: 'et8',   label: '1/8 ET', ph: '5.998' },
             { key: 'mph8',  label: '1/8 MPH',ph: '118.4' }] },
  { id: '1-4',    label: '1/4 mile',   zeroIs: 'the launch', kind: 'dist',
    fields: [{ key: 'ft60',   label: '60 ft',   ph: '1.412' },
             { key: 'ft330',  label: '330 ft',  ph: '3.921' },
             { key: 'et8',    label: '1/8 ET',  ph: '5.998' },
             { key: 'mph8',   label: '1/8 MPH', ph: '118.4' },
             { key: 'ft1000', label: '1000 ft', ph: '7.812' },
             { key: 'et4',    label: '1/4 ET',  ph: '9.284' },
             { key: 'mph4',   label: '1/4 MPH', ph: '146.2' }] },
  { id: '1-2',    label: '1/2 mile',   zeroIs: 'the launch', kind: 'dist',
    fields: [{ key: 'ft60',   label: '60 ft',   ph: '1.412' },
             { key: 'et8',    label: '1/8 ET',  ph: '5.998' },
             { key: 'et4',    label: '1/4 ET',  ph: '9.284' },
             { key: 'et2',    label: '1/2 ET',  ph: '13.90' },
             { key: 'mph2',   label: '1/2 MPH', ph: '171.5' }] },
];
// Which distance fields become markers, and which MPH rides on which. Mirrors SLIP_MARKS.
var DRAGY_DIST_MARKS = [
  { key: 'ft60',   label: "60'"   },
  { key: 'ft330',  label: "330'"  },
  { key: 'et8',    label: '1/8',   mphKey: 'mph8' },
  { key: 'ft1000', label: "1000'" },
  { key: 'et4',    label: '1/4',   mphKey: 'mph4' },
  { key: 'et2',    label: '1/2',   mphKey: 'mph2' },
];
function dragyTest(id){
  return DRAGY_TESTS.filter(function(t){ return t.id === id; })[0] || null;
}

function hasPerfData(){
  if(!VIEWER_PERF) return false;
  return perfMarksRaw().length > 0;
}
// Marks as {offset, label} relative to zero -- computed without needing a race zero, so the button
// can report whether there is anything to draw even before one is set.
function perfMarksRaw(){
  var p = VIEWER_PERF;
  if(!p) return [];
  var out = [];
  if(p.kind === 'slip'){
    SLIP_MARKS.forEach(function(m){
      var v = (p.values || {})[m.key];
      if(v == null || !isFinite(v)) return;
      var label = m.label;
      var mph = m.mphKey ? p.values[m.mphKey] : null;
      if(mph != null && isFinite(mph)) label += '  ' + mph + ' mph';
      out.push({ offset: v, label: label });          // NOT + reaction time
    });
  } else if(p.kind === 'laps'){
    // Cumulative: lap N's marker is the sum of laps 1..N past zero.
    var run = 0;
    (p.laps || []).forEach(function(v, i){
      if(v == null || !isFinite(v)) return;
      run += v;
      out.push({ offset: run, label: 'L' + (i + 1) + '  ' + formatLapTime(v) });
    });
  } else if(p.kind === 'dragy'){
    var t = dragyTest(p.test);
    var v = p.values || {};
    if(!t) return out;
    if(t.kind === 'speed'){
      // Every increment is measured from the SAME start speed, so these are already elapsed times
      // from zero -- no accumulation, unlike laps.
      t.fields.forEach(function(f){
        var x = v[f.key];
        if(x != null && isFinite(x)) out.push({ offset: x, label: f.label });
      });
    } else {
      DRAGY_DIST_MARKS.forEach(function(m){
        var x = v[m.key];
        if(x == null || !isFinite(x)) return;
        var label = m.label;
        var mph = m.mphKey ? v[m.mphKey] : null;
        if(mph != null && isFinite(mph)) label += '  ' + mph + ' mph';
        out.push({ offset: x, label: label });
      });
    }
  }
  return out;
}
// Drawn marks in LOG time. Empty unless a race zero exists.
function perfMarks(){
  if(VIEWER_RACE_ZERO == null) return [];
  return perfMarksRaw().map(function(m){
    return { t: VIEWER_RACE_ZERO + m.offset, label: m.label };
  });
}
// Laps run to minutes, where 92.4 seconds reads better as 1:32.40.
function formatLapTime(s){
  if(s < 60) return s.toFixed(2) + 's';
  var m = Math.floor(s / 60), rem = s - m * 60;
  return m + ':' + (rem < 10 ? '0' : '') + rem.toFixed(2);
}

var pbdPerfPlugin = {
  id: 'pbdPerf',
  // afterDatasetsDraw, not afterDraw: markers sit above the traces but below the crosshair, so the
  // cursor stays findable when parked on one.
  afterDatasetsDraw: function(chart){
    var marks = perfMarks();
    if(!marks.length) return;
    var xScale = chart.scales.x, ctx = chart.ctx;
    if(!xScale) return;
    var area = chart.chartArea;
    marks.forEach(function(mk){
      var x = xScale.getPixelForValue(mk.t);
      if(x < area.left || x > area.right) return;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(x, area.top);
      ctx.lineTo(x, area.bottom);
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(245,166,35,.75)';
      ctx.setLineDash([2,3]);
      ctx.stroke();
      ctx.setLineDash([]);
      // Label at the BOTTOM of the plot: the top is where the in-graph legend and graph controls
      // live, and a label there covered them on every panel.
      ctx.font = '700 10px system-ui, sans-serif';
      var w = ctx.measureText(mk.label).width;
      // Flip left when the label would run off the right edge.
      var lx = (x + w + 8 <= area.right) ? x + 3 : x - w - 5;
      var ly = area.bottom - 4;
      ctx.fillStyle = 'rgba(10,10,12,.82)';
      ctx.fillRect(lx - 2, ly - 10, w + 4, 12);
      ctx.fillStyle = '#f5a623';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(mk.label, lx, ly);
      ctx.restore();
    });
  }
};
if(window.Chart) Chart.register(pbdPerfPlugin);

// Decode a CSV log's bytes by what they actually are, not by assumption. Three real encodings turn
// up: UTF-8 (HP Tuners), UTF-16LE/BE (anything saved through PowerShell's default Out-File), and
// windows-1252 (Holley's exporter, which writes a lone 0xB0 for the degree sign). Decoding a Holley
// file as UTF-8 replaces every degree sign with U+FFFD, so its temperature units read as "�F"
// and no unit family can ever match them -- 167 columns across the sample logs. UTF-8 first with
// fatal:true, so only a file that genuinely is not UTF-8 falls back.
function decodeCsvBytes(bytes){
  if(bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if(bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch(err){
    try { return new TextDecoder('windows-1252').decode(bytes); }
    catch(err2){ return new TextDecoder().decode(bytes); }   // last resort: lossy UTF-8
  }
}

// ---- Histogram "show samples" highlight --------------------------------------------------------
// A histogram cell knows exactly which samples fed it; clicking "Highlight" paints those spans of the
// log on every graph so a tuner can see WHERE in the pull a cell's knock/error came from. Consecutive
// sample indices are merged into one span (setHighlightIndices), so a cell fed by a steady cruise
// paints one band, not thousands of slivers. Drawn like the performance markers: above the traces,
// below the crosshair. A zero-width span (one sample) still paints at least 1px so it is findable.
var VIEWER_HIGHLIGHT_SPANS = [];   // [{t0, t1}] in log seconds
var pbdHighlightPlugin = {
  id: 'pbdHighlight',
  afterDatasetsDraw: function(chart){
    if(!VIEWER_HIGHLIGHT_SPANS.length) return;
    var xScale = chart.scales.x, ctx = chart.ctx, area = chart.chartArea;
    if(!xScale) return;
    ctx.save();
    ctx.fillStyle = 'rgba(245,166,35,.18)';
    for(var i = 0; i < VIEWER_HIGHLIGHT_SPANS.length; i++){
      var s = VIEWER_HIGHLIGHT_SPANS[i];
      var x0 = xScale.getPixelForValue(s.t0), x1 = xScale.getPixelForValue(s.t1);
      if(x1 < area.left || x0 > area.right) continue;
      x0 = Math.max(area.left, x0); x1 = Math.min(area.right, x1);
      ctx.fillRect(x0, area.top, Math.max(1, x1 - x0), area.bottom - area.top);
    }
    ctx.restore();
  }
};
if(window.Chart) Chart.register(pbdHighlightPlugin);

// ---- the "Add Performance Data" menu ----------------------------------------------------------
var VIEWER_PERF_MENU = null;
function closePerfMenu(){
  if(VIEWER_PERF_MENU && VIEWER_PERF_MENU.parentNode) VIEWER_PERF_MENU.parentNode.removeChild(VIEWER_PERF_MENU);
  VIEWER_PERF_MENU = null;
}
function openPerfMenu(anchor){
  if(!viewerIsPro()) return;
  closePerfMenu();
  var m = document.createElement('div');
  m.className = 'dlv-ctxmenu dlv-perf-menu';
  m.addEventListener('click', function(ev){ ev.stopPropagation(); });
  m.innerHTML =
    '<button type="button" class="dlv-ctx-item" data-p="slip">Add time slip</button>' +
    '<button type="button" class="dlv-ctx-item" data-p="laps">Add lap times</button>' +
    '<button type="button" class="dlv-ctx-item" data-p="dragy">Add Dragy</button>' +
    (hasPerfData() ? '<button type="button" class="dlv-ctx-item" data-p="clear">Clear</button>' : '');
  document.body.appendChild(m);
  // Right-aligned under the button, clamped on screen -- the header actions sit at the far right,
  // so a left-aligned menu hangs off the window.
  var r = anchor.getBoundingClientRect(), pad = 8;
  m.style.top = (r.bottom + 4) + 'px';
  m.style.left = Math.max(pad, Math.min(r.right - m.offsetWidth, window.innerWidth - m.offsetWidth - pad)) + 'px';
  VIEWER_PERF_MENU = m;
  m.querySelectorAll('.dlv-ctx-item').forEach(function(btn){
    btn.addEventListener('click', function(){
      var a = btn.getAttribute('data-p');
      closePerfMenu();
      if(a === 'clear'){ VIEWER_PERF = null; refreshPerfUi(); return; }
      openPerfDialog(a);
    });
  });
}

// ---- the entry forms --------------------------------------------------------------------------
function closePerfDialog(){
  var el = document.getElementById('dlvPerfBack');
  if(el && el.parentNode) el.parentNode.removeChild(el);
}
function perfFieldHtml(key, label, ph, value){
  return '<label class="dlv-slip-field"><span>' + escapeHtml(label) + '</span>' +
    '<input type="text" inputmode="decimal" data-pf="' + escapeHtml(key) + '" placeholder="' + escapeHtml(ph) + '"' +
    ' value="' + (value == null ? '' : escapeHtml(String(value))) + '"></label>';
}
function openPerfDialog(kind, dragyTestId){
  if(!viewerIsPro()) return;
  closePerfDialog();
  var cur = (VIEWER_PERF && VIEWER_PERF.kind === kind) ? VIEWER_PERF : null;
  var wrap = document.createElement('div');
  wrap.className = 'dlv-slip-back';
  wrap.id = 'dlvPerfBack';
  wrap.innerHTML = '<div class="dlv-slip-modal" role="dialog" aria-label="Performance data">' +
    perfDialogInnerHtml(kind, dragyTestId, cur) + '</div>';
  document.body.appendChild(wrap);
  var first = wrap.querySelector('input');
  if(first) first.focus();

  wrap.addEventListener('click', function(e){
    if(e.target === wrap){ closePerfDialog(); return; }
    var pick = e.target.closest('[data-dragy-test]');
    if(pick){ openPerfDialog('dragy', pick.getAttribute('data-dragy-test')); return; }
    var btn = e.target.closest('[data-slip-a]');
    if(!btn) return;
    var a = btn.getAttribute('data-slip-a');
    if(a === 'cancel'){ closePerfDialog(); return; }
    if(a === 'back'){ openPerfDialog('dragy'); return; }
    if(a === 'addlap'){
      // Grow the form by one lap, preserving whatever is already typed.
      var vals = readLapInputs(wrap);
      vals.push(null);
      var box = wrap.querySelector('.dlv-slip-modal');
      box.innerHTML = perfDialogInnerHtml('laps', null, { kind:'laps', laps: vals });
      var inputs = box.querySelectorAll('input[data-pf]');
      if(inputs.length) inputs[inputs.length - 1].focus();
      return;
    }
    if(a === 'save'){
      commitPerfDialog(wrap, kind, dragyTestId);
      closePerfDialog();
      refreshPerfUi();
    }
  });
  wrap.addEventListener('keydown', function(e){
    if(e.key === 'Escape'){ closePerfDialog(); }
    else if(e.key === 'Enter'){ var s = wrap.querySelector('[data-slip-a="save"]'); if(s) s.click(); }
  });
}
function perfDialogInnerHtml(kind, dragyTestId, cur){
  var head, note, body, actions;
  var zeroNote = 'Increments draw on the graphs in race mode. Set a race zero first (right-click a graph).';
  if(kind === 'slip'){
    head = 'Time Slip';
    note = zeroNote + ' Zero should be the launch.';
    body = '<div class="dlv-slip-grid">' + SLIP_FIELDS.map(function(f){
      return perfFieldHtml(f.key, f.label, f.ph, cur && cur.values ? cur.values[f.key] : null);
    }).join('') + '</div>';
  } else if(kind === 'laps'){
    head = 'Lap Times';
    note = zeroNote + ' Zero is the start of lap 1. Enter each lap individually -- they are added up for you.';
    var laps = (cur && cur.laps && cur.laps.length) ? cur.laps : [null];
    body = '<div class="dlv-lap-list">' + laps.map(function(v, i){
      return perfFieldHtml('lap' + i, 'Lap ' + (i + 1), '92.40', v);
    }).join('') + '</div>' +
    '<button type="button" class="dlv-btn dlv-lap-add" data-slip-a="addlap">+ Add lap</button>';
  } else {
    var t = dragyTestId ? dragyTest(dragyTestId) : null;
    if(!t){
      // Step 1: which test. Dragy only runs one at a time and each has different fields.
      head = 'Dragy';
      note = 'Which run is this?';
      body = '<div class="dlv-dragy-picks">' + DRAGY_TESTS.map(function(d){
        return '<button type="button" class="dlv-btn dlv-dragy-pick" data-dragy-test="' + d.id + '">' +
          escapeHtml(d.label) + '</button>';
      }).join('') + '</div>';
      return '<div class="dlv-slip-head">' + head + '</div>' +
             '<div class="dlv-slip-note">' + note + '</div>' + body +
             '<div class="dlv-slip-actions"><div style="flex:1"></div>' +
             '<button type="button" class="dlv-btn" data-slip-a="cancel">Cancel</button></div>';
    }
    head = 'Dragy &mdash; ' + t.label;
    // Stated as an instruction rather than a hint: the user decides where the run began, and every
    // increment below is measured from that point. Get it wrong and the whole ladder shifts.
    note = 'Set your race zero at <b>' + t.zeroIs + '</b> &mdash; every time below is measured from ' +
           'there. Increments draw on the graphs in race mode.';
    var vals = (cur && cur.test === t.id && cur.values) ? cur.values : {};
    body = '<div class="dlv-slip-grid">' + t.fields.map(function(f){
      return perfFieldHtml(f.key, f.label, f.ph, vals[f.key]);
    }).join('') + '</div>';
    actions = '<button type="button" class="dlv-btn" data-slip-a="back">&#8592; Test</button>';
  }
  return '<div class="dlv-slip-head">' + head + '</div>' +
    '<div class="dlv-slip-note">' + note + '</div>' + body +
    '<div class="dlv-slip-actions">' + (actions || '') + '<div style="flex:1"></div>' +
    '<button type="button" class="dlv-btn" data-slip-a="cancel">Cancel</button>' +
    '<button type="button" class="dlv-btn dlv-slip-save" data-slip-a="save">Save</button></div>';
}
// Tolerate a stray quote from "60'", a leading + on reaction times, and 1:32.40 lap notation.
function parsePerfNumber(raw){
  var s = String(raw == null ? '' : raw).trim();
  if(!s) return null;
  var mm = s.match(/^(\d+):(\d+(?:\.\d+)?)$/);
  if(mm) return parseInt(mm[1], 10) * 60 + parseFloat(mm[2]);
  var n = parseFloat(s.replace(/[^0-9.\-+]/g, ''));
  return isFinite(n) ? n : null;
}
function readLapInputs(wrap){
  return [].slice.call(wrap.querySelectorAll('input[data-pf]')).map(function(inp){
    return parsePerfNumber(inp.value);
  });
}
function commitPerfDialog(wrap, kind, dragyTestId){
  if(kind === 'laps'){
    // Trailing blanks are just an unused "+ Add lap"; blanks in the MIDDLE would silently renumber
    // every following lap, so those are dropped too and the laps kept are contiguous.
    var laps = readLapInputs(wrap).filter(function(v){ return v != null; });
    VIEWER_PERF = laps.length ? { kind: 'laps', laps: laps } : null;
    return;
  }
  var values = {};
  wrap.querySelectorAll('input[data-pf]').forEach(function(inp){
    var n = parsePerfNumber(inp.value);
    if(n != null) values[inp.getAttribute('data-pf')] = n;
  });
  if(!Object.keys(values).length){ VIEWER_PERF = null; return; }
  VIEWER_PERF = (kind === 'dragy')
    ? { kind: 'dragy', test: dragyTestId, values: values }
    : { kind: 'slip', values: values };
}
// Markers are drawn by a plugin, so a chart update is all it takes -- rebuilding the body would
// drop the current zoom.
function refreshPerfUi(){
  // Markers are drawn by a plugin, so a repaint is all it takes. The perf state used to also
  // relabel a header button; that button now lives in the Analyze menu, which is rebuilt each open.
  repaintCharts();
}

// Lives in the UPPER graph's top-left, because that panel is the master and is always on screen --
// so the control never disappears with the thing it controls. Opposite corner from the legend.
function renderGraphCountHtml(){
  // 4 is offered on the Graph tab only (see maxGraphCount), and the highlighted button is the count
  // actually on screen, which is the remembered one clamped to what this view can show.
  var shown = effectiveGraphCount();
  var btns = [1, 2, 3, 4].slice(0, maxGraphCount()).map(function(n){
    return '<button type="button" class="dlv-gcount-btn' + (shown === n ? ' active' : '') +
      '" data-gcount="' + n + '" title="' + n + ' graph' + (n===1?'':'s') + '">' + n + '</button>';
  }).join('');
  return '<div class="dlv-graph-count" title="Number of graphs">' + btns + '</div>';
}

function renderGraphLegendHtml(panelNum){
  var chans = channelsForSlot(panelNum, activeGraphSlots());
  if(!chans.length) return '';
  var rows = chans.map(function(c){
    var color = channelColor(c);
    var label = (typeof shortChannelName === 'function') ? shortChannelName(c) : c;
    // Name + live value, then a dedicated remove "x" (only the x removes -- clicking the row itself
    // used to remove the channel, which was easy to trigger by accident). The x carries data-remove-ch,
    // which the generic remove handler (see wire below) already keys off.
    return '<div class="dlv-legend-row">' +
           '<span class="dlv-legend-name" style="color:' + color + '">' + escapeHtml(label) + '</span>' +
           '<span class="dlv-legend-val" style="color:' + color + '" data-legend-ch="' + escapeHtml(c) + '">--</span>' +
           '<button type="button" class="dlv-legend-x" data-remove-ch="' + escapeHtml(c) + '" ' +
             'title="Remove ' + escapeHtml(label) + ' from this graph" aria-label="Remove ' + escapeHtml(label) + '">&times;</button>' +
           '</div>';
  }).join('');
  // Drag the group to reposition it, or its resize handle to scale the whole thing (Ken, 2026-09-08).
  // pos is undefined until first touched -- the CSS default (top-right corner, scale 1) covers that.
  var pos = VIEWER_LEGEND_POS[panelNum];
  var style = pos ? (' style="top:' + pos.top + 'px;right:' + pos.right + 'px;transform:scale(' + pos.scale + ');"') : '';
  return '<div class="dlv-graph-legend" data-legend-panel="' + panelNum + '"' + style + '>' + rows +
         '<div class="dlv-legend-resize" title="Drag to resize · double-click to reset"></div></div>';
}
var LEGEND_SCALE_MIN = 0.6, LEGEND_SCALE_MAX = 2.2;
function clampNum(v, lo, hi){ return Math.max(lo, Math.min(hi, v)); }
// The legend's rendered top/right in ITS OWN (unscaled) layout space -- offsetLeft/Top/Width/Height
// are relative to the panel (its offsetParent) and, unlike getBoundingClientRect, are untouched by
// the transform:scale() used to resize it, so this always matches whatever `top`/`right` CSS the
// element actually has, whether that came from the stylesheet default or a previous drag.
function currentLegendPos(legend){
  var panel = legend.offsetParent;
  var panelW = panel ? panel.clientWidth : 0;
  return { top: legend.offsetTop, right: panelW - (legend.offsetLeft + legend.offsetWidth) };
}
function setLegendPos(panelNum, pos){ VIEWER_LEGEND_POS[panelNum] = pos; }
// Drag the legend block to reposition it, or its own resize handle to scale it as a whole -- each
// graph panel's legend is independent (Ken, 2026-09-08: "drag the group of parameter names and
// resize them as a group"). Position is stored as top/right (matching the CSS anchor corner) so
// resize's transform-origin (top right) and drag's delta math agree on which corner stays put.
function wireGraphLegends(){
  document.querySelectorAll('.dlv-graph-legend').forEach(function(legend){
    var panelNum = Number(legend.getAttribute('data-legend-panel'));
    var panel = legend.closest('.dlv-graph-panel');
    if(!panel) return;
    var moveSt = null, resizeSt = null;

    legend.addEventListener('pointerdown', function(e){
      if(e.button !== 0) return;
      if(e.target.closest('.dlv-legend-x') || e.target.closest('.dlv-legend-resize')) return;
      var pr = panel.getBoundingClientRect(), cur = currentLegendPos(legend);
      moveSt = { x: e.clientX, y: e.clientY, top: cur.top, right: cur.right, active: false,
                 panelW: pr.width, panelH: pr.height, id: e.pointerId };
      try { legend.setPointerCapture(e.pointerId); } catch(_){}
    });
    legend.addEventListener('pointermove', function(e){
      if(!moveSt || moveSt.id !== e.pointerId) return;
      var dx = e.clientX - moveSt.x, dy = e.clientY - moveSt.y;
      if(!moveSt.active){
        if(Math.abs(dx) < 4 && Math.abs(dy) < 4) return;   // slop: a plain click never nudges it
        moveSt.active = true;
        legend.classList.add('dlv-legend-dragging');
      }
      var top = clampNum(moveSt.top + dy, 0, Math.max(0, moveSt.panelH - 20));
      var right = clampNum(moveSt.right - dx, 0, Math.max(0, moveSt.panelW - 40));
      legend.style.top = top + 'px'; legend.style.right = right + 'px';
      setLegendPos(panelNum, { top: top, right: right, scale: (VIEWER_LEGEND_POS[panelNum] || {}).scale || 1 });
    });
    function endMove(e){
      if(!moveSt || moveSt.id !== e.pointerId) return;
      if(moveSt.active){ legend.classList.remove('dlv-legend-dragging'); saveViewerPrefs(); }
      try { legend.releasePointerCapture(moveSt.id); } catch(_){}
      moveSt = null;
    }
    legend.addEventListener('pointerup', endMove);
    legend.addEventListener('pointercancel', endMove);
    legend.addEventListener('dblclick', function(e){
      if(e.target.closest('.dlv-legend-x')) return;
      delete VIEWER_LEGEND_POS[panelNum];
      legend.style.top = ''; legend.style.right = ''; legend.style.transform = '';
      saveViewerPrefs();
    });

    var handle = legend.querySelector('.dlv-legend-resize');
    if(!handle) return;
    handle.addEventListener('pointerdown', function(e){
      if(e.button !== 0) return;
      e.stopPropagation();   // the container's own pointerdown would otherwise also arm a move-drag
      var r = legend.getBoundingClientRect();
      // transform-origin is top-right, so that corner is the FIXED point during resize -- its screen
      // position right now is the reference every subsequent move computes distance from.
      resizeSt = { anchorX: r.right, anchorY: r.top, naturalW: legend.offsetWidth, naturalH: legend.offsetHeight, id: e.pointerId };
      try { handle.setPointerCapture(e.pointerId); } catch(_){}
    });
    handle.addEventListener('pointermove', function(e){
      if(!resizeSt || resizeSt.id !== e.pointerId) return;
      var dx = resizeSt.anchorX - e.clientX;   // grows as the cursor moves away from the anchor, toward bottom-left
      var scale = clampNum(dx / resizeSt.naturalW, LEGEND_SCALE_MIN, LEGEND_SCALE_MAX);
      legend.style.transform = 'scale(' + scale.toFixed(3) + ')';
      var cur = currentLegendPos(legend);
      setLegendPos(panelNum, { top: cur.top, right: cur.right, scale: scale });
    });
    function endResize(e){
      if(!resizeSt || resizeSt.id !== e.pointerId) return;
      try { handle.releasePointerCapture(resizeSt.id); } catch(_){}
      resizeSt = null;
      saveViewerPrefs();
    }
    handle.addEventListener('pointerup', endResize);
    handle.addEventListener('pointercancel', endResize);
  });
}

// ---------------------------------------------------------------------------------------------
// Full body render
// ---------------------------------------------------------------------------------------------
function renderViewerBody(){
  cancelCursorPaint();   // the charts below are about to be destroyed; a queued frame must not paint them
  // A header dropdown is appended to <body>, outside the content we're about to replace, and is
  // anchored to a button that this rebuild destroys -- so close it, or it lingers pointing at nothing.
  if(typeof closeHdrMenu === 'function') closeHdrMenu();
  // A mounted histogram view listens for zoom changes; the rebuild below throws its DOM away, so let
  // it unsubscribe first or it keeps recomputing tables nobody can see.
  if(VIEWER_HIST_CTL && VIEWER_HIST_CTL.destroy){ try { VIEWER_HIST_CTL.destroy(); } catch(err){} VIEWER_HIST_CTL = null; }
  var container = document.getElementById('viewerContent');
  var mobile = isMobileViewer();
  // Ken, 2026-09-10: "when you pick a parameter, it scrolls the list to the top. don't need or want that
  // scroll". Checking a channel rebuilds the whole body (graphs, cards, footer count all change), which
  // built a fresh channel list scrolled to row one. It is the SAME list either side of the rebuild, so its
  // scroll position is carried across; the browser clamps it if the list is now shorter.
  var keepChanScroll = channelListScrollTop();
  // Mobile is always the cards-and-one-graph layout regardless of the saved view mode: the gauge
  // fascia is 29 tiles wide and has no meaningful phone form, and the view picker that would let
  // you switch back lives in the header, which is hidden. Forced here rather than by overwriting
  // VIEWER_VIEW_MODE so the user's real preference survives and reappears on desktop.
  var hasGauges = VIEWER_ACTIVE_PRESET && VIEWER_ACTIVE_PRESET.gauges && VIEWER_ACTIVE_PRESET.gauges.length;
  var showFascia = showsGauges() && VIEWER_GAUGE_SUBMODE === 'default' && hasGauges;
  var showDash = showsCustomDash();
  var showCards = showsCards();
  container.classList.toggle('dlv-mobile', mobile);

  // Portrait phone: don't render the viewer at all. Charts sized against a 390px-wide viewport come
  // back wrong when it rotates, and building them twice is wasted work -- the rotate handler
  // re-renders from scratch once there's a usable viewport.
  if(isPortraitBlocked()){
    // The way out matters more here than anywhere else in the app: this screen deliberately renders
    // nothing else, so without it a phone user in portrait has no control at all and no clue what
    // to do except close the tab (Ken, 2026-07-21).
    container.innerHTML =
      '<div class="dlv-rotate">' +
        '<button type="button" class="dlv-rotate-back" id="dlvRotateBackBtn">&#8592; ' + (viewerHost() ? 'Back' : 'Back to site') + '</button>' +
        '<div class="dlv-rotate-icon">&#128241;</div>' +
        '<div class="dlv-rotate-title">Rotate your phone</div>' +
        '<div class="dlv-rotate-sub">The datalog viewer needs landscape.</div>' +
      '</div>';
    var backBtn = document.getElementById('dlvRotateBackBtn');
    // Same exit the header's X uses, so the host page is left in exactly the state it expects.
    if(backBtn) backBtn.addEventListener('click', closeViewer);
    return;
  }

  container.innerHTML = '' +
    renderHeaderHtml() +
    '<div class="dlv-body">' +
      renderChannelPanelHtml() +
      // exists solely to be measured -- see currentGaugeUnit()
      '<div id="dlvUnitProbe" class="dlv-u-probe" aria-hidden="true"></div>' +
      '<div class="dlv-main">' +
        (showFascia
          ? '<div class="dlv-gauge-view" id="dlvGaugeView"></div>' +
            '<div class="dlv-splitter" id="dlvSplitter" title="Drag to resize · double-click to reset"></div>'
          : showDash
          ? '<div class="dlv-dash-view" id="dlvDashView"></div>' +
            // In BOTH edit and finalized: keeps the dash/graph height adjuster while USING a dash (Ken).
            // Finalized starts hugged (VIEWER_DASH_H null); dragging sets an explicit height, dbl-click re-hugs.
            '<div class="dlv-splitter" id="dlvSplitter" title="Drag to resize · double-click to reset"></div>'
          : showsHistograms()
          // Histograms (datalog-histogram-ui.js mounts into this host): the tuning tables sit ABOVE the
          // graphs like a dash does, with the same height adjuster, because the whole point is reading
          // a cell and then looking at the traces beneath it.
          ? '<div class="dlv-hist-view" id="dlvHistView"></div>' +
            '<div class="dlv-splitter" id="dlvSplitter" title="Drag to resize · double-click to reset"></div>'
          : (showCards ? renderCardsHtml() : '')) +
        '<div class="dlv-graphs">' +
          activeGraphSlots().map(function(slot){
            // legend is a SIBLING of the canvas wrap, not a child: rebuildChart() replaces the
            // wrap's innerHTML with a fresh <canvas>, which would wipe anything inside it.
            return '<div class="dlv-graph-panel" data-slot="' + slot + '">' +
              // BigData watermark, upper graph only, desktop only. A SIBLING of the canvas wrap (like
              // the legend, and for the same reason) so rebuildChart replacing the wrap's innerHTML
              // can't wipe it; positioned top-right and non-interactive over the plot.
              (slot === GRAPH_SLOT_UPPER && !mobile ? '<div class="dlv-graph-watermark dlv-brand" aria-hidden="true">' + BRAND_LOGO_SVG + '</div>' : '') +
              '<div class="dlv-graph-canvas-wrap" id="dlvCanvasWrap' + slot + '"></div>' +
              (slot === GRAPH_SLOT_UPPER && !mobile ? renderGraphCountHtml() : '') +
              renderGraphLegendHtml(slot) + '</div>';
          }).join('') +
        '</div>' +
        // Sits directly under the graphs and above the scrubber: alignment is something you adjust
        // while watching the traces, so the controls belong next to them.
        (mobile ? '' : renderCompareBarHtml()) +
        '<div class="dlv-scrubber-row">' +
          (mobile ? '' : renderRaceTimeHtml()) +
          '<div class="dlv-scrubber-wrap" id="dlvScrubberWrap"><canvas id="dlvScrubberCanvas"></canvas>' +
            // histogram "show samples" marks on the overview bar -- under the zoom window, above the trace
            '<div class="dlv-scrub-hl" id="dlvScrubHl"></div>' +
            '<div class="dlv-scrubber-window" id="dlvScrubberWindow">' +
              '<div class="dlv-scrub-handle dlv-scrub-handle-l" data-edge="lo" title="Drag to zoom"></div>' +
              '<div class="dlv-scrub-handle dlv-scrub-handle-r" data-edge="hi" title="Drag to zoom"></div>' +
            '</div>' +
            '<div class="dlv-scrubber-playhead" id="dlvScrubberPlayhead" style="display:none;"></div>' +
            '<div class="dlv-race-mark" id="dlvRaceMark" style="display:none;" title="Race zero"></div></div>' +
          '<div class="dlv-scrubber-controls">' +
            '<button type="button" class="dlv-icon-btn" id="dlvZoomOutBtn" title="Zoom out">&minus;</button>' +
            '<button type="button" class="dlv-icon-btn" id="dlvZoomInBtn" title="Zoom in">&plus;</button>' +
            // A native host (the BigData phone apps) is already edge-to-edge and has no address bar,
            // so the fullscreen button has nothing to do there. Its slot becomes the way OUT instead:
            // the phone layout hides the header (and its X), and an app has no back gesture / history
            // to fall back on the way the website does. See hostHandlesFullscreen().
            (hostHandlesFullscreen()
              ? '<button type="button" class="dlv-icon-btn dlv-host-close" id="dlvHostCloseBtn" title="Close log">&#10005;</button>'
              : '<button type="button" class="dlv-icon-btn" id="dlvFullscreenBtn" title="Fullscreen">&#9974;</button>') +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';

  wireHeaderEvents();
  wireChannelPanelEvents();
  refreshChannelValueRefs();
  if(showFascia) renderGaugeView();
  else if(showDash) renderCustomDashView();
  else if(showsHistograms()) renderHistogramView();
  wireSplitter();
  wireGraphLegends();
  rebuildChart();
  wireScrubberEvents();
  if(!mobile) wireRaceTime();
  if(!mobile) wireCompareBar();
  updateRaceMarker();
  if(mobile){
    wireMobileFullscreen();
    // The tour supersedes both hints -- running them together is what made first load a mess.
    if(!tourDone()) startTour();
    else { showChannelHint(); showFullscreenHint(); }
  }
  updateAtCursor(CROSSHAIR_TIME);
  restoreChannelListScroll(keepChanScroll);
  document.querySelectorAll('[data-soon]').forEach(function(el){
    el.addEventListener('click', function(e){ e.preventDefault(); if(window.showToast) showToast(el.getAttribute('data-soon') + ' is coming soon.'); });
  });
}

// ---- HEADER DROPDOWN MENUS (Analyze / Layout) -------------------------------------------------
// Two labelled menus replace six loose header buttons (Ken, 2026-07-23). Same floating pattern as
// the perf / view menus. Locked items are greyed with the lock glyph and ONE footer explains Pro,
// rather than a per-item hover tip -- which also retires the old bug where a locked header button's
// tip floated up off the top of the window (nothing locked lives at the top edge any more).

// Compare decoder resolution, hoisted to module scope so the Analyze menu can trigger it. The engine
// never bakes in its own parser (a private copy has mis-decoded real logs twice); it reaches the ONE
// shared decoder either via a host-supplied loadLogFile (the harness) or window.DVCore (the sites).
function compareLoader(){
  var host = (window.DATAVIEWER || {}).loadLogFile;
  if(typeof host === 'function') return host;
  if(window.DVCore && typeof window.DVCore.parseDatalogCsv === 'function') return builtinLoadLogFile;
  return null;
}
function triggerCompareOpen(){
  if(!viewerIsPro()) return;
  if(!compareLoader()){
    renderViewerError('Comparison needs a decoder on this page (window.DVCore or a host loadLogFile). Nothing was changed.');
    return;
  }
  var cmpFile = document.getElementById('dlvCompareFile');
  if(cmpFile) cmpFile.click();
}

var VIEWER_HDR_MENU = null;
function closeHdrMenu(){ if(VIEWER_HDR_MENU){ VIEWER_HDR_MENU.remove(); VIEWER_HDR_MENU = null; } }
document.addEventListener('click', closeHdrMenu);
document.addEventListener('keydown', function(e){ if(e.key === 'Escape') closeHdrMenu(); });

function hdrItem(action, label, locked, extraAttr){
  return '<button type="button" class="act clear' + (locked ? ' dlv-pro-locked' : '') + '" data-m="' +
    action + '"' + (extraAttr || '') + '>' + escapeHtml(label) + '</button>';
}
var HDR_PRO_FOOTER = '<div class="dlv-gmenu-hint dlv-menu-pro">&#128274; Compare, performance data and ' +
  'dashboards are <b>Pro</b> — ' + PRO_LOCK_MSG + '.</div>';

function openHdrMenu(anchor, which){
  var already = VIEWER_HDR_MENU && VIEWER_HDR_MENU.__which === which;
  closeHdrMenu();
  if(typeof closePerfMenu === 'function') closePerfMenu();
  if(typeof closeGaugeMenu === 'function') closeGaugeMenu();
  closeGraphMenu();
  if(already) return;   // a second click on the same button closes it
  var pro = viewerIsPro();
  var m = document.createElement('div');
  m.className = 'dlv-gmenu dlv-hdr-menu';
  m.__which = which;
  m.addEventListener('click', function(e){ e.stopPropagation(); });
  if(which === 'analyze'){
    var a = '';
    a += hdrItem('compare', VIEWER_COMPARE ? 'Comparing — load another log' : 'Compare a second log', !pro);
    a += '<div class="dlv-menu-sep"></div>';
    a += hdrItem('slip',  'Add time slip', !pro);
    a += hdrItem('laps',  'Add lap times', !pro);
    a += hdrItem('dragy', 'Add Dragy',     !pro);
    if(hasPerfData()) a += hdrItem('perfclear', 'Clear performance data', false);
    m.innerHTML = '<h4>Analyze</h4>' + a + (pro ? '' : HDR_PRO_FOOTER);
  } else {
    // Layout and Custom Gauges are independent saves now (Ken, 2026-09-08) -- each gets its own
    // Save item, and "Save Custom Gauges" only appears when there's actually a dash to save (there's
    // no fascia-as-gauges save path any more, see currentGaugesList). Delete is kind-specific too,
    // rather than one item whose wording and fallback used to be wrong half the time.
    var b = '';
    b += hdrItem('saveview',   'Save Layout', false);
    b += hdrItem('saveas',     'Save Layout As New…', false);
    var hasDashContent = !!(VIEWER_DASH && VIEWER_DASH.gauges && VIEWER_DASH.gauges.length);
    if(hasDashContent) b += hdrItem('savegauges', 'Save Custom Gauges', false);
    var canDeleteLayout = VIEWER_CURRENT_LAYOUT && VIEWER_CURRENT_LAYOUT.kind === 'saved' && !VIEWER_CURRENT_LAYOUT.readOnly;
    var canDeleteGauges = VIEWER_CURRENT_GAUGES && VIEWER_CURRENT_GAUGES.kind === 'saved' && !VIEWER_CURRENT_GAUGES.readOnly;
    if(canDeleteLayout || canDeleteGauges) b += '<div class="dlv-menu-sep"></div>';
    if(canDeleteLayout) b += hdrItem('deletelayout', 'Delete this Layout', false);
    if(canDeleteGauges) b += hdrItem('deletegauges', 'Delete these Custom Gauges', false);
    if(VIEWER_DOWNLOAD_URL){ b += '<div class="dlv-menu-sep"></div>'; b += '<a class="act clear" href="' + VIEWER_DOWNLOAD_URL + '" target="_blank" rel="noopener">&#8681; Download HPL</a>'; }
    // No Pro footer here (removed, Ken 2026-09-08) -- nothing in this menu is actually Pro-gated; the
    // real gates are Histograms and the Custom sub-pill, both up in the mode tabs.
    m.innerHTML = '<h4>Layout</h4>' + b;
  }
  document.body.appendChild(m);
  var r = anchor.getBoundingClientRect(), pad = 8;
  m.style.top = (r.bottom + 6) + 'px';
  m.style.left = Math.max(pad, Math.min(r.right - m.offsetWidth, window.innerWidth - m.offsetWidth - pad)) + 'px';
  VIEWER_HDR_MENU = m;
  m.querySelectorAll('[data-m]').forEach(function(btn){
    btn.addEventListener('click', function(){
      if(btn.classList.contains('dlv-pro-locked')){                  // locked -> no-op; footer explains
        var pf = { compare:'compare', slip:'slip', laps:'laps', dragy:'dragy' };
        var a = btn.getAttribute('data-m');
        adlTrack('paywall_viewed', { feature: pf[a] || a || 'pro', trigger: 'header_menu' });
        return;
      }
      if(btn.hasAttribute('data-soon')) return;                      // "coming soon" handled below
      var act = btn.getAttribute('data-m');
      closeHdrMenu();
      if(act === 'compare')   return triggerCompareOpen();
      if(act === 'slip' || act === 'laps' || act === 'dragy'){ if(viewerIsPro()) openPerfDialog(act); return; }
      if(act === 'perfclear'){ VIEWER_PERF = null; refreshPerfUi(); return; }
      if(act === 'saveview')     return saveConfig('view', false);
      if(act === 'saveas')       return saveConfig('view', true);
      if(act === 'savegauges')  return saveConfig('gauges', false);   // was hardcoded asNew=true -- always forked a new copy, even when updating one you'd just loaded
      if(act === 'deletelayout') return deleteCurrentLayout();
      if(act === 'deletegauges') return deleteCurrentGauges();
    });
  });
  // This menu is created after renderViewerBody's global data-soon wiring ran, so wire its own here.
  m.querySelectorAll('[data-soon]').forEach(function(el){
    el.addEventListener('click', function(e){ e.preventDefault(); closeHdrMenu(); if(window.showToast) showToast(el.getAttribute('data-soon') + ' is coming soon.'); });
  });
}

function wireHeaderEvents(){
  document.getElementById('viewerCloseBtn2').addEventListener('click', closeViewer);
  // COMPARE. The picker now lives in the Analyze menu (triggerCompareOpen); here we only wire the
  // hidden input's change. Decoder resolution is compareLoader() at module scope -- see it for why
  // the engine never bakes in its own parser, and why the comparison log decodes byte-identically to
  // the primary one.
  var cmpFile = document.getElementById('dlvCompareFile');
  if(cmpFile) cmpFile.addEventListener('change', function(){
    var f = cmpFile.files && cmpFile.files[0];
    if(!f) return;
    if(!viewerIsPro()){ cmpFile.value = ''; return; }   // gate the file path too, not just the menu item
    var loader = compareLoader();
    if(!loader){
      renderViewerError('Comparison needs a decoder on this page (window.DVCore or a host ' +
                        'loadLogFile). Nothing was changed.');
      cmpFile.value = '';
      return;
    }
    Promise.resolve(loader(f)).then(function(data){
      if(!data || !data.channels || !data.time) throw new Error('The loader returned no data.');
      setCompareLog(f.name, data);
    }).catch(function(e){
      renderViewerError('Could not open the comparison log: ' + ((e && e.message) || 'unknown error'));
    });
    cmpFile.value = '';   // so picking the same file twice still fires a change
  });

  var analyzeBtn = document.getElementById('dlvAnalyzeBtn');
  if(analyzeBtn) analyzeBtn.addEventListener('click', function(e){ e.stopPropagation(); openHdrMenu(analyzeBtn, 'analyze'); });
  var layoutBtn = document.getElementById('dlvLayoutBtn');
  if(layoutBtn) layoutBtn.addEventListener('click', function(e){ e.stopPropagation(); openHdrMenu(layoutBtn, 'layout'); });
  wireModeTabs();

  document.getElementById('dlvResetZoomBtn').addEventListener('click', function(){
    // Not using chartjs-plugin-zoom's own resetZoom() here -- syncZoom() (above) propagates
    // zoom/pan to the "follower" chart by writing scales.x.min/max directly rather than going
    // through the plugin's own zoom()/pan() calls, which left the plugin's internal
    // originalScaleLimits tracking for that chart out of sync and made resetZoom() a no-op on it.
    // Setting both charts back to the full data range the same way syncZoom does sidesteps that
    // entirely and is consistent with how every other zoom/pan change in this file is applied.
    if(!VIEWER_DATA || !VIEWER_DATA.time.length) return;
    setVisibleRange(VIEWER_DATA.time[0], VIEWER_DATA.time[VIEWER_DATA.time.length - 1]);
  });
  wireViewSelect();
  // Save / Save-as / Delete now live in the Layout menu (openHdrMenu 'layout'); Compare + performance
  // in Analyze. The old dlvSaveViewBtn / dlvViewMoreBtn are gone from the header.
}

function wireChannelPanelEvents(){
  var collapseBtn = document.getElementById('dlvCollapseBtn');
  if(collapseBtn) collapseBtn.addEventListener('click', function(){
    VIEWER_LEFT_COLLAPSED = !VIEWER_LEFT_COLLAPSED;
    saveViewerPrefs();
    renderViewerBody();
  });
  var searchEl = document.getElementById('dlvChannelSearch');
  if(searchEl) searchEl.addEventListener('input', function(e){ applySearch(e.target.value); });
  var clearEl = document.getElementById('dlvSearchClear');
  if(clearEl) clearEl.addEventListener('click', function(){ applySearch(''); if(searchEl) searchEl.focus(); });
  var modeBtn = document.getElementById('dlvChanModeBtn');
  if(modeBtn) modeBtn.addEventListener('click', function(){
    VIEWER_CHAN_MODE = chanModeGrouped() ? 'flat' : 'grouped';
    renderViewerBody();
  });
  wireKeypad();
  wireKindBar();
  // Tapping a channel means you've found what you were filtering for -- give the list its space
  // back without making the user hunt for Done.
  var bodyEl = document.getElementById('dlvChannelBody');
  if(bodyEl) bodyEl.addEventListener('click', function(){ if(VIEWER_KEYPAD_OPEN) setKeypadOpen(false); });
  document.querySelectorAll('table.dlv-channel-table thead th[data-sort]').forEach(function(th){
    th.addEventListener('click', function(){
      var col = th.dataset.sort;
      if(VIEWER_SORT.col === col) VIEWER_SORT.dir *= -1; else VIEWER_SORT = { col: col, dir: 1 };
      VIEWER_CHAN_ORDER = null;   // asking for a sort discards a manual drag order, or the click looks broken
      var body = document.getElementById('dlvChannelBody');
      if(body) body.innerHTML = renderChannelRowsHtml();
      refreshChannelValueRefs();
      updateAtCursor(CROSSHAIR_TIME);
    });
  });
  var clearBtn = document.getElementById('dlvClearAllBtn');
  if(clearBtn) clearBtn.addEventListener('click', function(){
    VIEWER_SELECTED = []; VIEWER_PANEL_ASSIGN = {};
    markLayoutDirty();
    renderViewerBody();
  });
  var body = document.getElementById('dlvChannelBody');
  if(body){
    body.addEventListener('change', function(e){
      if(!e.target.matches('input[type=checkbox]')) return;
      var ch = e.target.dataset.ch;
      var idx = VIEWER_SELECTED.indexOf(ch);
      if(e.target.checked && idx === -1){ VIEWER_SELECTED.push(ch); if(!(ch in VIEWER_PANEL_ASSIGN)) VIEWER_PANEL_ASSIGN[ch] = 1; }
      else if(!e.target.checked && idx !== -1){ VIEWER_SELECTED.splice(idx, 1); }
      markLayoutDirty();
      renderViewerBody();
    });
    // Star a channel / fold a section. Delegated, so both survive every row re-render.
    body.addEventListener('click', function(e){
      var fav = e.target.closest('.dlv-fav-btn');
      if(fav){ e.stopPropagation(); toggleFavoriteChannel(fav.getAttribute('data-fav-ch')); return; }
      // Before the prototype's group branch: a section heading carries dlv-group-row too (it reuses
      // that styling), and the prototype branch would read data-group off it and find nothing.
      var sect = e.target.closest('.dlv-sect-row');
      if(sect){ toggleSectCollapsed(sect.getAttribute('data-section')); return; }
      var pin = e.target.closest('.dlv-pin-btn');
      if(pin){ e.stopPropagation(); togglePin(pin.dataset.pinCh); return; }
      var grp = e.target.closest('.dlv-group-row');
      if(grp){
        var id = grp.dataset.group;
        if(id === '__pinned') return;                 // the pinned block is defined by its contents
        VIEWER_GROUP_COLLAPSED[id] = !VIEWER_GROUP_COLLAPSED[id];
        rerenderChannelRows();
      }
    });
    wireChannelDrag(body);
    body.addEventListener('click', function(e){
      var btn = e.target.closest('.dlv-cell-btn');
      if(!btn) return;
      addChannelToPanel(btn.dataset.panelCh, Number(btn.dataset.panelNum));   // click again to unassign
    });
  }
  document.querySelectorAll('[data-gcount]').forEach(function(btn){
    btn.addEventListener('click', function(){
      VIEWER_GRAPH_COUNT = Number(btn.getAttribute('data-gcount'));
      saveViewerPrefs();
      markLayoutDirty();   // graph count is part of a saved layout -- changing it is an unsaved edit
      renderViewerBody();
    });
  });
  // Graph-panel chip remove / add-channel buttons live outside the channel table but use the
  // same selection state, so they're wired here too.
  document.querySelectorAll('[data-remove-ch]').forEach(function(btn){
    btn.addEventListener('click', function(){
      var ch = btn.dataset.removeCh;
      var idx = VIEWER_SELECTED.indexOf(ch);
      if(idx !== -1) VIEWER_SELECTED.splice(idx, 1);
      delete VIEWER_PANEL_ASSIGN[ch];
      markLayoutDirty();
      renderViewerBody();
    });
  });
  document.querySelectorAll('[data-add-panel]').forEach(function(btn){
    btn.addEventListener('click', function(){
      if(searchEl) searchEl.focus();
      if(window.showToast) showToast('Check a channel on the left and use its U/L column to add it here.');
    });
  });
  var moreBtn = document.getElementById('dlvCardsMoreBtn');
  if(moreBtn) moreBtn.addEventListener('click', function(){ VIEWER_CARDS_EXPANDED = !VIEWER_CARDS_EXPANDED; renderViewerBody(); });
}
function renderOneChannelRow(c, pinnedRow, sectId){
  var gaugeSet = gaugeChannelSet();
  var checked = VIEWER_SELECTED.indexOf(c) !== -1;
  var unit = VIEWER_UNIT_BY_CHANNEL[c];
  var fav = isFavoriteChannel(c);
  // U / M / L stacked vertically -- the middle button only exists in views that render 3 graphs
  var slots = activeGraphSlots();
  // data-sect confines a drag to its own section (see wireChannelDrag): dragging a channel out of
  // "Math channels" and into "Logged channels" would be a claim about the log that isn't true.
  return '<tr class="' + (checked ? 'dlv-row-selected' : '') + (pinnedRow ? ' dlv-row-pinned' : '') +
      '" data-ch="' + escapeHtml(c) + '" data-sect="' + escapeHtml(sectId || '') + '">' +
    '<td class="dlv-cell-center"><span class="dlv-drag-handle" title="Drag to reorder, or onto a graph to add it there">&#8801;</span></td>' +
    '<td class="dlv-cell-center"><input type="checkbox" data-ch="' + escapeHtml(c) + '"' + (checked?' checked':'') + '></td>' +
    // Faint on every row rather than hover-only: a star nobody can see is a feature nobody finds, and
    // the phone drawer has no hover at all.
    '<td class="dlv-cell-center"><button type="button" class="dlv-fav-btn' + (fav ? ' on' : '') +
      '" data-fav-ch="' + escapeHtml(c) + '" aria-pressed="' + (fav ? 'true' : 'false') +
      '" title="' + (fav ? 'Remove from favorites' : 'Favorite -- keeps this channel at the top of the list') +
      '">' + (fav ? '&#9733;' : '&#9734;') + '</button></td>' +
    (VIEWER_CHAN_PROTOTYPE
      ? '<td class="dlv-cell-center"><button type="button" class="dlv-pin-btn' + (pinnedRow ? ' pinned' : '') +
          '" data-pin-ch="' + escapeHtml(c) + '" title="' + (pinnedRow ? 'Unpin' : 'Send to top') + '">' +
          (pinnedRow ? '&#9679;' : '&#8593;') + '</button></td>'
      : '') +
    '<td class="dlv-ch-cell">' +
      // Name row = [badge] [label ...ellipsis...] [tools]. The label is the only part that shrinks, so the ⚙ / ∿
      // buttons always sit at the right edge of the cell -- Ken, 2026-09-09: "the ~ doesn't show on longer
      // titles" (they used to be inline after the text, inside the ellipsis, so any long name clipped them).
      '<div class="dlv-ch-name" title="' + escapeHtml(c) + (isMathChannel(c) ? ' -- a math channel (computed, not logged)' : isAccelChannel(c) ? ' -- calculated (Vehicle Dynamics): estimated from this log\'s speed channels' : '') + '">' +
        (isMathChannel(c) ? '<span class="dlv-ch-math-badge" title="Math channel -- computed, not logged">&fnof;</span>' : '') +
        (isAccelChannel(c) ? '<span class="dlv-ch-calc-badge" title="Calculated · Vehicle Dynamics -- estimated from this log\'s speed channels">&asymp;</span>' : '') +
        '<span class="dlv-ch-label">' + escapeHtml(c) + '</span>' +
        '<span class="dlv-ch-tools">' +
          (isAccelChannel(c) ? '<button type="button" class="dlv-ch-cfg" data-accel-cfg="1" title="Estimated acceleration settings: speed source, filtering, wheel-spin correction">&#9881;</button>' : '') +
          (isTextChannel(c) ? '' : '<button type="button" class="dlv-ch-smooth' + (smoothingFor(c) ? ' on' : '') + '" data-smooth-ch="' + escapeHtml(c) + '" title="' + (smoothingFor(c) ? 'Smoothing: ' + smoothingFor(c) + ' ms' : 'Smooth this channel') + '">&#8767;' + (smoothingFor(c) ? '<small>' + (smoothingFor(c) >= 1000 ? (smoothingFor(c) / 1000) + 's' : smoothingFor(c)) + '</small>' : '') + '</button>') +
        '</span>' +
        '</div>' +
      '<div class="dlv-ch-value"><span class="dlv-ch-value-num' + (isTextChannel(c) ? ' dlv-ch-value-text' : '') + '" data-ch-value="' + escapeHtml(c) + '">--</span>' + (unit && unit !== 'na' ? '<span class="dlv-ch-value-unit">' + escapeHtml(unit) + '</span>' : '') + '</div>' +
    '</td>' +
    '<td class="dlv-cell-center dlv-ul-cell' + (slots.length > 3 ? ' dlv-ul-grid' : '') + '">' +
      slots.map(function(slot){
        var on = VIEWER_PANEL_ASSIGN[c] === slot;
        var letter = slot === GRAPH_SLOT_UPPER ? 'U' : slot === GRAPH_SLOT_MIDDLE ? 'M' : slot === GRAPH_SLOT_MIDDLE2 ? 'M2' : 'L';
        var cls = slot === GRAPH_SLOT_UPPER ? 'dlv-upper' : slot === GRAPH_SLOT_MIDDLE ? 'dlv-middle'
          : slot === GRAPH_SLOT_MIDDLE2 ? 'dlv-middle2' : 'dlv-lower';
        return '<button type="button" class="dlv-cell-btn ' + cls + (on ? ' active' : '') +
          '" data-panel-ch="' + escapeHtml(c) + '" data-panel-num="' + slot + '">' + letter + '</button>';
      }).join('') +
    '</td>' +
    '<td class="dlv-cell-center">' + (gaugeSet[c] ? '<span class="dlv-gauge-dot" title="Used by active gauge preset"></span>' : '') + '</td>' +
  '</tr>';
}

// Re-caches the data-ch-value <span> elements currently in the DOM (only rows that survived the
// active search filter are present) so updateAtCursor() can update every visible channel's live
// value with a plain textContent= per move -- no re-render, no querySelector per channel per frame.
function refreshChannelValueRefs(){
  VIEWER_CHANNEL_VALUE_ELS = {};
  document.querySelectorAll('#dlvChannelBody [data-ch-value]').forEach(function(el){
    VIEWER_CHANNEL_VALUE_ELS[el.getAttribute('data-ch-value')] = el;
  });
  watchVisibleRows();
}

// ---- Which rows are actually on screen --------------------------------------------------------
// The live value on every row is the point (Ken asked for it), but a real HP Tuners log can carry
// 524 channels and the panel shows about 17 of them. Rewriting all 524 text nodes per cursor move
// cost 1.3 ms of JS and 12.4 ms of LAYOUT -- the browser re-laying-out the whole list every frame,
// which is most of why the cursor felt heavy on a big log (Ken, 2026-09-10: "still lag on the cursor
// line"). An IntersectionObserver against the scrolling wrap keeps a set of the rows in view, and
// only those are written; a row scrolling in is filled by the observer's own callback, so nothing is
// ever seen stale. With no observer available (or before its first callback) every row is written,
// exactly as before.
var VIEWER_ROW_VIS = null;      // { channel: true } for rows in or near the viewport
var VIEWER_ROW_OBS = null;
function watchVisibleRows(){
  if(VIEWER_ROW_OBS){ try { VIEWER_ROW_OBS.disconnect(); } catch(e){} VIEWER_ROW_OBS = null; }
  VIEWER_ROW_VIS = null;
  var wrap = document.querySelector('.dlv-channel-table-wrap');
  if(!wrap || typeof IntersectionObserver !== 'function') return;
  var vis = {};
  VIEWER_ROW_OBS = new IntersectionObserver(function(entries){
    var changed = false;
    entries.forEach(function(en){
      var ch = en.target.getAttribute('data-ch-value');
      if(!ch) return;
      if(en.isIntersecting){ if(!vis[ch]){ vis[ch] = true; changed = true; } }
      else if(vis[ch]){ delete vis[ch]; changed = true; }
    });
    // A row that just scrolled in was not being written while it was hidden, so fill it now.
    if(changed) refreshVisibleRowValues();
  // A screen's worth of margin: rows are filled before they can be seen, so a fast scroll never
  // shows a blank or stale reading.
  }, { root: wrap, rootMargin: '200px 0px' });
  VIEWER_ROW_VIS = vis;
  Object.keys(VIEWER_CHANNEL_VALUE_ELS).forEach(function(ch){
    try { VIEWER_ROW_OBS.observe(VIEWER_CHANNEL_VALUE_ELS[ch]); } catch(e){}
  });
}
function rowValueChannels(){
  if(VIEWER_ROW_VIS){
    var keys = Object.keys(VIEWER_ROW_VIS);
    if(keys.length) return keys;
  }
  return Object.keys(VIEWER_CHANNEL_VALUE_ELS);   // first paint, or no observer
}
function cursorSampleIndex(dataX){
  if(!VIEWER_DATA || !VIEWER_DATA.time || !VIEWER_DATA.time.length) return 0;
  return dataX != null ? nearestTimeIndex(VIEWER_DATA.time, dataX) : VIEWER_DATA.time.length - 1;
}
// The row-value half of updateAtCursor, on its own so the observer can call it when rows scroll in.
function updateRowValues(idx, dataX){
  var els = VIEWER_CHANNEL_VALUE_ELS;
  rowValueChannels().forEach(function(ch){
    var el = els[ch];
    if(!el) return;
    var txt = formatReadoutValue(valueAtCursor(ch, idx, dataX), ch);
    el.textContent = txt;
    // Labels like "TQ Red. < Driver Demand" are wider than the column, so the row ellipsises them;
    // the title makes the full state readable on hover without widening the panel.
    if(isTextChannel(ch)) el.title = txt;
  });
}
function refreshVisibleRowValues(){
  if(!VIEWER_DATA) return;
  var dataX = (CROSSHAIR_TIME != null) ? CROSSHAIR_TIME : null;
  updateRowValues(cursorSampleIndex(dataX), dataX);
}

// ---------------------------------------------------------------------------------------------
// Gauge View (generic grouped layout -- Phase 4 replaces this with the fixed V8/V6 fascia)
// ---- CUSTOM DASH DESIGNER (Pro) ---------------------------------------------------------------
// Build-your-own gauge dashboard, launched from Layout > New Custom Dash. Deliberately a SEPARATE
// view mode from the fixed V8 / Standard fascia (Ken, 2026-07-22): those stay curated and untouched;
// this is a free-positioning canvas. It reuses the EXACT gauge renderers (createGaugeElement /
// updateGaugeElement) and the same channel resolution (gaugeChannelFor honours channelOverride), so
// a custom gauge looks and updates identically to a preset one -- only POSITION and SIZE are new.
// Desktop only (the viewer shows no gauges on mobile at all). Phase 1: place / move / assign / delete
// with live values; resize handles and saving a dash as a view come next.
var VIEWER_DASH = null;        // { gauges: [ gaugeDef + {x,y,w,h} ] }
var VIEWER_DASH_EDIT = false;  // build mode: palette + drag + move + right-click assign
var VIEWER_DASH_ELS = {};      // gauge id -> element
var VIEWER_DASH_MENU = null;   // the right-click assign menu
var VIEWER_DASH_H = null;      // EDIT-mode working-canvas height in px (null = the CSS default share); splitter-set
var VIEWER_DASH_ZOOM = null;   // FINALIZED-mode gauge zoom (null = 1 = authored size); splitter scales the
                               // gauges so the cluster stays welded to the divider (no gap / overlap, like the fascia)
var VIEWER_DASH_HUG = 0;       // last measured unscaled hug height (px), so the zoom splitter has a reference
var VIEWER_DASH_HUG_W = 0;     // last measured unscaled content width (rightmost gauge edge) -- caps zoom-IN
                               // so enlarged gauges never spill past the canvas width
var VIEWER_DASH_PALETTE_POS = null;   // {x,y} viewport pos of the floating gauge palette (draggable)
// ---- Gauges behind the Histograms tab -------------------------------------------------------------
// Ken (2026-09-09): "add gauges to the histogram tab, there is a lot of room to the right ... they would
// be the back layer, so if the table extended to the right it would just go over the gauges." A second,
// independent gauge set (VIEWER_HIST_DASH) painted into the table UI's back layer (HistogramUI
// ctl.backLayer(): under a transparent table wrap, no pointer events), anchored top-right and scaled
// down to fit. It is BUILT with the same designer as the custom dash: openHistGaugesEditor() parks the
// Gauges-tab dash, loads this set into VIEWER_DASH in edit mode with VIEWER_DASH_TARGET = 'hist', and
// Finalize / Remove / any tab click hands the result back (finishHistGaugesEdit). Carried across logs
// like the custom dash, mirrored to localStorage, saved in a Layout as `histGauges`.
var VIEWER_HIST_DASH = null;         // { gauges: [...] } -- same gauge shape as VIEWER_DASH
var VIEWER_HIST_DASH_ELS = {};       // gauge id -> element in the back layer
var VIEWER_DASH_TARGET = null;       // 'hist' while the designer is editing the histogram gauges
var VIEWER_DASH_STASH = null;        // the Gauges-tab state parked while that happens
var VIEWER_HIST_DASH_KEY = 'pbdDatalogViewerHistGauges.v1';
var VIEWER_HIST_DASH_RO = null;      // ResizeObserver on the back layer (re-fit when the pane resizes)
function histDashGauges(){ return (VIEWER_HIST_DASH && Array.isArray(VIEWER_HIST_DASH.gauges)) ? VIEWER_HIST_DASH.gauges : []; }
function loadHistDashLocal(){
  try {
    var raw = window.localStorage ? localStorage.getItem(VIEWER_HIST_DASH_KEY) : null;
    var p = raw ? JSON.parse(raw) : null;
    return (p && Array.isArray(p.gauges) && p.gauges.length) ? { gauges: dashAdoptGaugeIds(p.gauges) } : null;
  } catch(err){ return null; }
}
function saveHistDashLocal(){
  try {
    if(!window.localStorage) return;
    if(histDashGauges().length) localStorage.setItem(VIEWER_HIST_DASH_KEY, JSON.stringify({ gauges: VIEWER_HIST_DASH.gauges }));
    else localStorage.removeItem(VIEWER_HIST_DASH_KEY);
  } catch(err){}
}
function histDashGaugesForSave(){ return histDashGauges().length ? JSON.parse(JSON.stringify(VIEWER_HIST_DASH.gauges)) : null; }
function openHistGaugesEditor(){
  if(!viewerIsPro()) return;
  if(VIEWER_DASH_TARGET === 'hist') return;
  adlTrack('gauge_designer_used', { action: 'hist_open' });
  VIEWER_DASH_STASH = { dash: VIEWER_DASH, current: VIEWER_CURRENT_GAUGES, dirty: VIEWER_GAUGES_DIRTY, sub: VIEWER_GAUGE_SUBMODE, h: VIEWER_DASH_H, zoom: VIEWER_DASH_ZOOM };
  VIEWER_DASH = { gauges: histDashGauges().map(function(g){ return JSON.parse(JSON.stringify(g)); }) };
  VIEWER_CURRENT_GAUGES = null; VIEWER_GAUGES_DIRTY = false;
  VIEWER_DASH_TARGET = 'hist';
  VIEWER_DASH_EDIT = true; VIEWER_DASH_H = null; VIEWER_DASH_ZOOM = null;
  VIEWER_VIEW_MODE = 'gauge'; VIEWER_GAUGE_SUBMODE = 'custom';
  renderViewerBody();
  if(window.showToast) showToast('Building the gauges behind the Histograms tab -- Done (or any tab) takes you back.');
}
// Hand the designer's result back to the Histograms tab. keep=false discards the edit. silent=true
// restores state without rendering (a log opened mid-edit; the open flow renders on its own).
function finishHistGaugesEdit(keep, silent){
  if(VIEWER_DASH_TARGET !== 'hist') return;
  if(keep){
    dashNormalize();
    var gs = (VIEWER_DASH ? VIEWER_DASH.gauges : []).map(function(g){ var c = JSON.parse(JSON.stringify(g)); delete c._w; delete c._h; return c; });
    VIEWER_HIST_DASH = gs.length ? { gauges: gs } : null;
    saveHistDashLocal();
    markLayoutDirty();
  }
  var st = VIEWER_DASH_STASH || {};
  VIEWER_DASH = st.dash || null; VIEWER_CURRENT_GAUGES = st.current || null; VIEWER_GAUGES_DIRTY = !!st.dirty;
  VIEWER_DASH_EDIT = false; VIEWER_DASH_H = st.h == null ? null : st.h; VIEWER_DASH_ZOOM = st.zoom == null ? null : st.zoom;
  VIEWER_GAUGE_SUBMODE = st.sub || 'default';
  VIEWER_DASH_STASH = null; VIEWER_DASH_TARGET = null;
  VIEWER_VIEW_MODE = 'histograms';
  if(silent) return;
  saveViewerPrefs();
  renderViewerBody();
}
// Paint the set into the table UI's back layer: the gauges keep their designer geometry relative to
// each other; the cluster is anchored top-right and scaled DOWN (never up) to fit the pane -- and,
// since 2026-09-09, laid out AROUND the table (histGaugePlacement: beside it, else below it).
function renderHistGaugeLayer(){
  var layer = (VIEWER_HIST_CTL && typeof VIEWER_HIST_CTL.backLayer === 'function') ? VIEWER_HIST_CTL.backLayer() : null;
  if(!layer) return;
  if(VIEWER_HIST_DASH_RO){ try { VIEWER_HIST_DASH_RO.disconnect(); } catch(err){} VIEWER_HIST_DASH_RO = null; }
  layer.innerHTML = '';
  VIEWER_HIST_DASH_ELS = {};
  var gs = histDashGauges().filter(function(g){ return g && g.type !== 'scorecard'; });
  if(!gs.length) return;
  var minX = Infinity, minY = Infinity;
  gs.forEach(function(g){ minX = Math.min(minX, g.x || 0); minY = Math.min(minY, g.y || 0); });
  var cluster = document.createElement('div');
  cluster.className = 'dlv-hist-back-cluster';
  layer.appendChild(cluster);
  gs.forEach(function(g){
    var el = createGaugeElement(g, { text: DASH_TEXT_SCALE });
    el.classList.add('dlv-dash-gauge');
    var free = dashIsFreeSize(g.type);
    el.classList.toggle('dash-free', free);
    if(free){
      el.style.width = (g.w || 90) + 'px'; el.style.height = (g.h || 200) + 'px';
      el.classList.toggle('dlv-bar-narrow', (g.w || 90) < DASH_BAR_NARROW_W);
    } else el.style.setProperty('--dlv-gauge-u', (g.scale || 1) + 'px');
    el.style.left = ((g.x || 0) - minX) + 'px'; el.style.top = ((g.y || 0) - minY) + 'px';
    cluster.appendChild(el);
    VIEWER_HIST_DASH_ELS[g.id] = el;
  });
  fitHistGaugeLayer();
  if(typeof ResizeObserver !== 'undefined'){
    VIEWER_HIST_DASH_RO = new ResizeObserver(function(){ fitHistGaugeLayer(); });
    VIEWER_HIST_DASH_RO.observe(layer);
  }
  if(VIEWER_DATA) updateHistDashGauges(VIEWER_DATA.time.length - 1);
}
// Where the gauge cluster sits relative to the painted table (Ken, 2026-09-09: "a large 1D histogram
// collides with the gauges I have to the right ... need to prevent collision there and move gauges down
// if needed"). Sizes are back-layer pixels; the cluster is right-anchored and scales from its top-right.
//   right -- beside the table, scaled so its left edge clears the table (the default whenever it fits)
//   below -- under the table, still right-aligned, scaled to the strip that is left
//   cover -- no useful room either way (the table nearly fills the pane): fit to the pane as before and
//            let the table paint over them
// The larger of the two collision-free scales wins; a scale under MIN_K is not worth reading.
var HIST_GAUGE_PAD = 12, HIST_GAUGE_MIN_K = 0.35;
function histGaugePlacement(clW, clH, paneW, paneH, tableW, tableH){
  var PAD = HIST_GAUGE_PAD;
  function kFor(aw, ah){ return (clW > 0 && clH > 0 && aw > 0 && ah > 0) ? Math.min(1, aw / clW, ah / clH) : 0; }
  var kFull = kFor(paneW - 2 * PAD, paneH - 2 * PAD);
  if(!(tableW > 0 && tableH > 0)) return { place: 'right', k: kFull, top: PAD };
  var kRight = kFor(paneW - tableW - 2 * PAD, paneH - 2 * PAD);
  var kBelow = kFor(paneW - 2 * PAD, paneH - tableH - 2 * PAD);
  if(kRight >= kBelow && kRight >= HIST_GAUGE_MIN_K) return { place: 'right', k: kRight, top: PAD };
  if(kBelow > kRight && kBelow >= HIST_GAUGE_MIN_K) return { place: 'below', k: kBelow, top: tableH + PAD };
  return { place: 'cover', k: kFull, top: PAD };
}
function fitHistGaugeLayer(){
  var layer = (VIEWER_HIST_CTL && typeof VIEWER_HIST_CTL.backLayer === 'function') ? VIEWER_HIST_CTL.backLayer() : null;
  var cluster = layer ? layer.querySelector('.dlv-hist-back-cluster') : null;
  if(!cluster) return;
  var maxR = 0, maxB = 0;
  Object.keys(VIEWER_HIST_DASH_ELS).forEach(function(id){ var el = VIEWER_HIST_DASH_ELS[id]; maxR = Math.max(maxR, el.offsetLeft + el.offsetWidth); maxB = Math.max(maxB, el.offsetTop + el.offsetHeight); });
  var fp = (VIEWER_HIST_CTL && typeof VIEWER_HIST_CTL.tableFootprint === 'function') ? VIEWER_HIST_CTL.tableFootprint() : null;
  var p = histGaugePlacement(maxR, maxB, layer.clientWidth, layer.clientHeight, fp ? fp.w : 0, fp ? fp.h : 0);
  var k = p.k > 0 ? p.k : 1;   // nothing measurable yet (hidden pane / no gauges): leave the natural size
  cluster.style.width = maxR + 'px'; cluster.style.height = maxB + 'px';
  cluster.style.top = p.top + 'px';
  cluster.style.transform = k < 1 ? 'scale(' + k.toFixed(3) + ')' : '';
  cluster.setAttribute('data-place', p.place);
}
function updateHistDashGauges(idx, dataX){
  var gs = histDashGauges();
  if(!gs.length || !VIEWER_DATA) return;
  gs.forEach(function(g){
    var el = VIEWER_HIST_DASH_ELS[g.id];
    if(!el) return;
    if(g.type === 'table'){ updateGaugeElement(el, g, dashTableCells(g, idx, dataX)); return; }
    var ch = gaugeChannelFor(g);
    var val = ch ? valueAtCursor(ch, idx, dataX) : null;
    var val2;
    if(g.type === 'combo' && g.sub && g.sub.channelOverride){ val2 = valueAtCursor(g.sub.channelOverride, idx, dataX); }
    updateGaugeElement(el, g, val, val2);
  });
}
var VIEWER_DASH_COLOR = '#22c55e';    // default gauge accent; per-gauge overridable, "apply to all" resets it
var DASH_ID = 1;

// ---- Gauge ids -------------------------------------------------------------------------------
// A gauge id has to be unique across the whole dash: VIEWER_DASH_ELS is keyed by it, so two gauges
// sharing one id share ONE element -- the newer gauge takes the entry and the older one is left
// orphaned on the canvas, frozen, while everything else keeps moving. Ken, 2026-09-10: "every time I
// add a gauge or change something, a different gauge stops working ... lamba stopped working after I
// added a fuel pressure gauge", then "I just added MAP and it messed up the spark gauge".
//
// DASH_ID was a plain per-session counter starting at 1, and nothing reseeded it from a dash that was
// LOADED. So opening the app, loading a saved dash whose gauges were minted in an earlier session
// (dash-1, dash-2, dash-3 ...) and adding one more handed the new gauge "dash-1" -- an id the dash
// already had. Two rules close it: every new id comes from dashNextId(), which never hands out one
// that is in use, and every gauge list that arrives from outside this session goes through
// dashAdoptGaugeIds(), which reseeds the minter and repairs a collision that was already saved.
function dashIdsInUse(){
  var used = {};
  function scan(list){ if(Array.isArray(list)) list.forEach(function(g){ if(g && g.id) used[g.id] = true; }); }
  scan(VIEWER_DASH && VIEWER_DASH.gauges);
  scan(VIEWER_HIST_DASH && VIEWER_HIST_DASH.gauges);
  // The Gauges-tab dash parked while the histogram back-gauges are being edited: it comes back, so its
  // ids are still taken even though nothing is rendering them right now.
  scan(VIEWER_DASH_STASH && VIEWER_DASH_STASH.dash && VIEWER_DASH_STASH.dash.gauges);
  return used;
}
function dashNextId(){
  var used = dashIdsInUse(), id;
  do { id = 'dash-' + (DASH_ID++); } while(used[id]);
  return id;
}
function dashAdoptGaugeIds(list){
  if(!Array.isArray(list)) return list;
  // Reseed FIRST, over the whole list, so a repaired id can never collide with one further down it.
  list.forEach(function(g){
    var m = (g && typeof g.id === 'string') ? /^dash-(\d+)$/.exec(g.id) : null;
    if(m && Number(m[1]) >= DASH_ID) DASH_ID = Number(m[1]) + 1;
  });
  var seen = {};
  list.forEach(function(g){
    if(!g) return;
    if(!g.id || seen[g.id]) g.id = dashNextId();   // missing, or a duplicate saved by the old code
    seen[g.id] = true;
  });
  return list;
}

// Bar park point: where the fill grows FROM. 'auto' lets gaugeAnchor decide (0 for a signed range,
// else the min = end-parked); 'center' forces 0; 'end' forces the min. Stored as g.parked; g.anchor
// is derived so the renderer (gaugeAnchor) picks it up.
function dashApplyParked(g){
  if(g.parked === 'center') g.anchor = 0;
  else if(g.parked === 'end') g.anchor = g.min;
  else delete g.anchor;   // auto
}
var DASH_GRID = 20;            // snap step in px; hold Alt while dragging for free placement
// Default scale per type. The gauge system sizes EVERY dimension as base*--dlv-gauge-u, so one
// number scales a gauge whole (text and all) and keeps its aspect -- which is exactly the
// aspect-locked resize Ken asked for. 1 == natural size. Tuned so a fresh gauge of each type reads
// at a similar, sensible size.
// Keyed by PALETTE type ('tach' is a round dial with a redline, so it scales like a dial).
var DASH_SCALES = { 'round': 1.0, 'tach': 1.05, 'combo': 1.5, 'digital': 1.6, 'light': 1.4 };
// Bars are FREE-SIZE (Ken): explicit w x h, resized independently, not aspect-locked like the dials.
var DASH_BAR_SIZES = { 'vertical-bar': { w: 92, h: 210 }, 'horizontal-bar': { w: 220, h: 76 }, 'table': { w: 240, h: 0 } };   // a table's height hugs its rows
function dashIsFreeSize(type){ return type === 'vertical-bar' || type === 'horizontal-bar' || type === 'scorecard' || type === 'table'; }
var DASH_PALETTE = [
  { type:'round', label:'Dial' },
  { type:'tach', label:'Tach' },
  { type:'combo', label:'RPM+MPH' },
  { type:'vertical-bar', label:'Bar' },
  { type:'horizontal-bar', label:'H-Bar' },
  { type:'digital', label:'Number' },
  { type:'light', label:'Light' },
  { type:'table', label:'Table' },      // label | value rows, for state (text) fields
  { type:'scorecard', label:'Scorecard' }   // renders as a table (datalog-scorecard.js), not an SVG gauge
];

function showsCustomDash(){ return VIEWER_VIEW_MODE === 'gauge' && VIEWER_GAUGE_SUBMODE === 'custom' && !isMobileViewer(); }

// ---- Histograms view state (the tables themselves live in datalog-histogram*.js) ---------------
// VIEWER_HIST is the session's histogram SET -- the definitions a tuner built or loaded. It outlives
// view switches on purpose (a dash and a histogram layout are two ways of looking at one log), is
// embedded in any saved 'view' (buildConfig) so a car's PBD config carries its tables, and is mirrored
// to localStorage so nobody rebuilds their knock/fueling tables every session (Ken's spec §25).
var VIEWER_HIST = null;         // { defs: [histogram definitions -- see Histogram.makeDef] }
var VIEWER_HIST_CTL = null;     // HistogramUI controller while the view is mounted
var VIEWER_HIST_H = null;       // splitter-set pane height in px (null = the CSS default share)
var VIEWER_HIST_LOCAL_KEY = 'pbdDatalogViewerHistograms.v1';
// Pro-gated HERE, not only at the menu: a remembered view mode, a saved layout or a mid-session
// entitlement change would otherwise land a free user in the full view.
function showsHistograms(){ return VIEWER_VIEW_MODE === 'histograms' && !isMobileViewer() && viewerIsPro(); }
var VIEWER_DASH_SNAP = true;   // grid snapping for move AND bar-resize (Ken); toggled in the palette
function dashSnap(v, free){ return free ? Math.round(v) : Math.round(v / DASH_GRID) * DASH_GRID; }
// Snapping is ON when the toggle is on; Alt temporarily INVERTS it (Alt = free when on, Alt = snap when off).
function dashSnapActive(altKey){ var on = VIEWER_DASH_SNAP !== false; return altKey ? !on : on; }
function dashNumericChannels(){
  return (VIEWER_DATA && VIEWER_DATA.channels ? VIEWER_DATA.channels : []).filter(function(c){ return VIEWER_CHANNEL_STATS[c]; });
}
// Auto-assign a fresh gauge to the first numeric channel not already on the dash (cycling when all
// are used), so a dropped gauge shows a live value immediately -- reassign via right-click.
function dashNextChannel(){
  var nums = dashNumericChannels();
  if(!nums.length) return null;
  var used = {}; (VIEWER_DASH ? VIEWER_DASH.gauges : []).forEach(function(g){ if(g.channelOverride) used[g.channelOverride] = 1; });
  for(var i = 0; i < nums.length; i++){ if(!used[nums[i]]) return nums[i]; }
  return nums[(VIEWER_DASH ? VIEWER_DASH.gauges.length : 0) % nums.length];
}
function dashRangeFor(ch){
  var st = VIEWER_CHANNEL_STATS[ch], lo = 0, hi = 100;
  if(st && isFinite(st.min) && isFinite(st.max)){
    var range = st.max - st.min, pad = range > 0 ? range * 0.08 : Math.max(1, Math.abs(st.max) * 0.08);
    lo = st.min - pad; hi = st.max + pad;
    if(st.min >= 0 && lo < 0) lo = 0;
    lo = Math.floor(lo); hi = Math.ceil(hi); if(hi <= lo) hi = lo + 1;
  }
  return { min: lo, max: hi };
}
// A tach is always RPM if the log has it (Ken), even when RPM is already on the dash -- so it ignores
// the "first unused" rule dashNextChannel follows. Resolves via the engine_rpm role; null if absent.
function dashRpmChannel(){
  var rpm = (typeof VIEWER_RESOLVED_ROLES === 'object' && VIEWER_RESOLVED_ROLES) ? VIEWER_RESOLVED_ROLES['engine_rpm'] : null;
  return (rpm && VIEWER_CHANNEL_STATS[rpm]) ? rpm : null;
}
// Speed channel via the vehicle_speed role (for the combo's inset dial); null if the log has none.
function dashSpeedChannel(){
  var s = (typeof VIEWER_RESOLVED_ROLES === 'object' && VIEWER_RESOLVED_ROLES) ? VIEWER_RESOLVED_ROLES['vehicle_speed'] : null;
  return (s && VIEWER_CHANNEL_STATS[s]) ? s : null;
}
function dashCleanMax(v, step){ return Math.max(step, Math.ceil((isFinite(v) ? v : step) / step) * step); }
// Seed the combo's PRIMARY (RPM) dial: a clean 0..N tach scale (0-8 x1000) with a redline, off the
// channel's range. Kept in a helper so a channel reassign re-seeds it the same way dashMakeCombo does.
function dashSeedComboMain(g, ch){
  var st = ch ? VIEWER_CHANNEL_STATS[ch] : null;
  var cmax = dashCleanMax(st && isFinite(st.max) ? st.max : 8000, 1000);
  g.min = 0; g.max = cmax;
  g.tickDivisor = 1000; g.majors = Math.max(4, Math.min(12, Math.round(cmax / 1000))); g.minorsPer = 1;
  g.decimals = 0; g.unit = '';
  g.label = ch ? (typeof shortChannelName === 'function' ? shortChannelName(ch) : ch) : 'RPM';
  g.thresholds = { warn: Math.round(cmax * 0.8), red: Math.round(cmax * 0.9) };
}
// Seed the combo's INSET (speed) dial from a channel: 0..N clean scale, own label/unit/colour.
function dashSeedComboSub(g, ch){
  if(!g.sub) g.sub = {};
  g.sub.channelOverride = ch || null;
  var st = ch ? VIEWER_CHANNEL_STATS[ch] : null;
  g.sub.min = 0; g.sub.max = dashCleanMax(st && isFinite(st.max) ? st.max : 160, 20);
  g.sub.decimals = 0;
  g.sub.label = ch ? (typeof shortChannelName === 'function' ? shortChannelName(ch) : ch) : 'SPEED';
  g.sub.unit = (VIEWER_DATA && VIEWER_DATA.units && ch) ? (VIEWER_DATA.units[ch] || 'MPH') : 'MPH';
  g.sub.color = g.sub.color || '#e6e6ea';
  g.sub.majors = 4;
}
// RPM tach + inset speed dial (Ken's Speedhut-style dual gauge). Primary defaults to RPM, inset to
// the vehicle-speed channel (else the next numeric channel that isn't the RPM one).
function dashMakeCombo(x, y){
  var rpm = dashRpmChannel() || dashNextChannel();
  var g = { id: dashNextId(), type: 'combo', color: VIEWER_DASH_COLOR, scale: DASH_SCALES.combo || 1.5, x: x, y: y };
  dashSeedComboMain(g, rpm);
  g.channelOverride = rpm || null;
  dashStampRole(g, rpm);
  var sp = dashSpeedChannel();
  if(!sp){ var nums = dashNumericChannels(); for(var i = 0; i < nums.length; i++){ if(nums[i] !== rpm){ sp = nums[i]; break; } } }
  dashSeedComboSub(g, sp);
  dashStampRole(g.sub, sp);
  return g;
}
// A custom-dash gauge binds to a literal channel name (channelOverride). Remember which ROLE that
// channel satisfies on this log too, so the same dashboard shared to another car (whose log calls
// RPM "Engine RPM (SAE)") still finds its channels by meaning -- see resolveGaugeChannel's
// roleFallback. Any channel with no role keeps override-only behaviour, exactly as before.
function dashStampRole(g, ch){
  if(!g) return;
  var role = (typeof roleForChannel === 'function') ? roleForChannel(ch, VIEWER_RESOLVED_ROLES) : null;
  if(role){ g.role = role; g.roleFallback = true; }
  else { delete g.role; delete g.roleFallback; }
}
// Table gauge: label | value rows, seeded with the log's state (text) channels -- the "Source"
// fields a Ford log carries -- else its first numeric channels. Rows bind like gauges
// (channelOverride + stamped role), so a shared dash still finds them on another car's log.
function dashTextChannels(){
  return (VIEWER_DATA && VIEWER_DATA.channels ? VIEWER_DATA.channels : []).filter(function(c){ return isTextChannel(c); });
}
function dashMakeTableRow(ch){
  var r = { channelOverride: ch || null, label: ch ? (typeof shortChannelName === 'function' ? shortChannelName(ch) : ch) : 'Row', decimals: null, unit: null };
  dashStampRole(r, ch);
  return r;
}
function dashMakeTable(x, y){
  var texts = dashTextChannels().slice();
  texts.sort(function(a, b){ return (/source/i.test(b) ? 1 : 0) - (/source/i.test(a) ? 1 : 0); });   // Source fields first
  var seed = texts.slice(0, 4);
  if(!seed.length) seed = dashNumericChannels().slice(0, 3);
  return { id: dashNextId(), type: 'table', label: '', color: VIEWER_DASH_COLOR, fontScale: 1, rows: seed.map(dashMakeTableRow), x: x, y: y, w: DASH_BAR_SIZES.table.w, h: 0 };
}
// One display cell per row: a text channel's level, a value-label lookup for a numeric state code,
// or the number (row decimals/unit, else the gauge's, else the standard readout format).
// A table row may read a TEXT channel -- the whole point of the gauge -- so it resolves without the
// text guard gaugeChannelFor applies to needle/bar gauges (which can only draw a magnitude).
function dashTableRowChannel(r){
  if(typeof resolveGaugeChannel !== 'function') return VIEWER_RESOLVED_ROLES[r.role] || r.channelOverride || null;
  return resolveGaugeChannel(r, VIEWER_RESOLVED_ROLES, VIEWER_DATA && VIEWER_DATA.channels, null);
}
function dashTableCells(g, idx, dataX){
  return (Array.isArray(g.rows) ? g.rows : []).map(function(r){
    var ch = dashTableRowChannel(r);
    if(!ch) return { text: '--', missing: true };
    var v = valueAtCursor(ch, idx, dataX);
    if(v == null || !isFinite(v)) return { text: '--', missing: true };
    if(isTextChannel(ch)) return { text: formatReadoutValue(v, ch), missing: false };
    var vl = valueLabelsForChannel(ch), vt = (vl && typeof valueLabelText === 'function') ? valueLabelText(vl, v) : null;
    if(vt != null) return { text: vt, missing: false };
    var dec = (r.decimals != null && isFinite(r.decimals)) ? r.decimals : ((g.decimals != null && isFinite(g.decimals)) ? g.decimals : null);
    var text = dec != null ? v.toFixed(dec) : formatReadoutValue(v, ch);
    var unit = r.unit != null ? r.unit : ((VIEWER_DATA && VIEWER_DATA.units) ? (VIEWER_DATA.units[ch] || '') : '');
    return { text: text + (unit ? ' ' + unit : ''), missing: false };
  });
}
function dashMakeGauge(ptype, x, y){
  if(ptype === 'scorecard'){ return (scorecardEnabled() && typeof Scorecard !== 'undefined') ? Scorecard.makeDef(x, y) : null; }
  if(ptype === 'combo') return dashMakeCombo(x, y);
  if(ptype === 'table') return dashMakeTable(x, y);
  var ch = (ptype === 'tach' ? dashRpmChannel() : null) || dashNextChannel();
  var rng = ch ? dashRangeFor(ch) : { min:0, max:100 };
  var unit = (VIEWER_DATA && VIEWER_DATA.units && ch) ? (VIEWER_DATA.units[ch] || '') : '';
  var type = ptype === 'tach' ? 'round' : ptype;   // a tach is a round dial that carries a redline
  var g = {
    id: dashNextId(), type: type,
    label: ch ? (typeof shortChannelName === 'function' ? shortChannelName(ch) : ch) : 'Gauge',
    unit: unit, min: rng.min, max: rng.max, color: VIEWER_DASH_COLOR, decimals: (rng.max - rng.min) <= 20 ? 1 : 0,
    channelOverride: ch || null,
    x: x, y: y
  };
  dashStampRole(g, ch);
  if(dashIsFreeSize(type)){ var sz = DASH_BAR_SIZES[type]; g.w = sz.w; g.h = sz.h; g.parked = 'auto'; }
  else g.scale = DASH_SCALES[ptype] || 1;
  // A Tach reads like a real automotive tach (Ken): ticks divided by 1000 (1, 2, 3 …) with a "× 1000"
  // note in the middle, a clean 0..N range, and a redline. A Light just carries the warn/red pair.
  if(ptype === 'tach'){
    var tmax = dashCleanMax(ch && VIEWER_CHANNEL_STATS[ch] ? VIEWER_CHANNEL_STATS[ch].max : 8000, 1000);
    g.min = 0; g.max = tmax; g.unit = ''; g.decimals = 0;
    g.tickDivisor = 1000; g.scaleNote = '× 1000'; g.minorsPer = 1;
    g.majors = Math.max(4, Math.min(12, Math.round(tmax / 1000)));
    g.thresholds = { warn: Math.round(tmax * 0.8), red: Math.round(tmax * 0.9) };
  } else if(ptype === 'light'){
    var span = rng.max - rng.min;
    g.thresholds = { warn: dashRound(rng.min + span * 0.8, span), red: dashRound(rng.min + span * 0.9, span) };
  }
  return g;
}
function dashRound(v, span){ return span >= 40 ? Math.round(v) : +v.toFixed(1); }

// Enter the Gauges tab's Custom sub-view. An existing dash is reused, not cleared, and opens
// FINALIZED (you're coming back to look at/tweak something you already built) -- only a still-empty
// dash opens straight into build mode, since there's nothing to look at yet (Ken, 2026-09-08: this
// used to always force build mode, even for a dash you'd already finished).
// ---- Last custom dash: remembered across logs AND app restarts (localStorage) ---------------------
// Ken, 2026-09-09: "it should remember what dash you had open. And, if you switch from default to
// custom dash, it should go to the last custom dash you used. right now it goes to the builder."
// The dash itself (its gauges + which saved set it is) is stored whenever it is finalized, saved or
// loaded; enterCustomGauges() and the log-open flow bring it back when it is empty, provided at least
// one of its gauges resolves a channel in the open log (same test the open flow already applies to a
// carried-over dash). Deleting / discarding the dash forgets it.
var VIEWER_LAST_DASH_KEY = 'pbdDatalogViewerLastDash.v1';
function rememberLastDash(){
  if(VIEWER_DASH_TARGET === 'hist') return;
  if(!VIEWER_DASH || !VIEWER_DASH.gauges || !VIEWER_DASH.gauges.length) return;
  try {
    if(window.localStorage) localStorage.setItem(VIEWER_LAST_DASH_KEY, JSON.stringify({
      gauges: VIEWER_DASH.gauges, current: VIEWER_CURRENT_GAUGES || null, savedAt: Date.now() }));
  } catch(e){}
}
function forgetLastDash(){ try { if(window.localStorage) localStorage.removeItem(VIEWER_LAST_DASH_KEY); } catch(e){} }
function loadLastDash(){
  try {
    var raw = window.localStorage ? localStorage.getItem(VIEWER_LAST_DASH_KEY) : null;
    var o = raw ? JSON.parse(raw) : null;
    return (o && Array.isArray(o.gauges) && o.gauges.length) ? o : null;
  } catch(e){ return null; }
}
// Returns true when the remembered dash was put back (VIEWER_DASH / VIEWER_CURRENT_GAUGES set).
function restoreLastDash(){
  var o = loadLastDash(); if(!o) return false;
  var gauges = o.gauges.map(function(g){ return JSON.parse(JSON.stringify(g)); });
  if(typeof dashMigrateScorecards === 'function') dashMigrateScorecards(gauges);
  if(!gauges.some(function(g){ return !!gaugeChannelFor(g); })) return false;   // not for this car
  VIEWER_DASH = { gauges: dashAdoptGaugeIds(gauges) };
  VIEWER_CURRENT_GAUGES = (o.current && o.current.kind) ? o.current : null;
  VIEWER_GAUGES_DIRTY = false;
  return true;
}
function enterCustomGauges(){
  if(!viewerIsPro()) return;
  adlTrack('gauge_designer_used', { action: 'open' });
  // Which gauges are showing is part of a saved Layout now, so changing the sub-view is an unsaved
  // edit -- same rule as the graph count. Without this the header kept claiming the built-in view it
  // was on before, with no hint that what you are looking at is no longer that view.
  markLayoutDirty();
  if(!VIEWER_DASH) VIEWER_DASH = { gauges: [] };
  if(!VIEWER_DASH.gauges.length) restoreLastDash();   // the last custom dash, not the builder
  VIEWER_DASH_PALETTE_POS = null;   // a fresh dash re-centres the palette (Ken); drags still stick after
  VIEWER_VIEW_MODE = 'gauge';
  VIEWER_GAUGE_SUBMODE = 'custom';
  VIEWER_DASH_EDIT = !VIEWER_DASH.gauges.length;
  saveViewerPrefs();
  renderViewerBody();
}

function renderCustomDashView(){
  var host = document.getElementById('dlvDashView');
  if(!host) return;
  var edit = VIEWER_DASH_EDIT;
  host.classList.toggle('finalized', !edit);
  // Height. EDIT: a splitter-resizable working area (VIEWER_DASH_H, or the CSS default share).
  // FINALIZED: dashApplyHug sizes it to the gauges × the zoom, so it always hugs and the divider stays
  // welded to the cluster (no gap / overlap). The splitter there SCALES the gauges, it doesn't set a
  // container height — matching the fascia gauge view (Ken).
  host.style.width = '';
  host.style.height = (edit && VIEWER_DASH_H) ? VIEWER_DASH_H + 'px' : '';
  host.innerHTML =
    '<div class="dlv-dash-body">' +
      // Controls, top-right corner, out of flow so they cost no vertical room (Ken). While EDITING they
      // are VISIBLE buttons (Finalize / Delete) since you're actively building; once FINALIZED they tuck
      // into a small ⋯ pop-out (Edit / Delete) so the finished dash stays clean.
      (edit
        ? '<div class="dlv-dash-editbtns">' +
            '<button type="button" class="dlv-btn dlv-btn-menu" id="dlvDashLoadGauges" title="Replace these gauges with a saved gauge dashboard (keeps your graphs)">&#8681; Load gauges &#9662;</button>' +
            (VIEWER_DASH_TARGET === 'hist'
              ? '<button type="button" class="dlv-btn dlv-btn-accent" id="dlvDashFinalize" title="Place these gauges behind the histogram table and go back">&#10003; Done &rarr; Histograms</button>' +
                '<button type="button" class="dlv-btn" id="dlvDashDelete" title="Remove the gauges behind the histogram table">&#128465; Remove gauges</button>'
              : '<button type="button" class="dlv-btn dlv-btn-accent" id="dlvDashFinalize" title="Fit the canvas to your gauges and save">&#10003; Finalize</button>' +
                '<button type="button" class="dlv-btn" id="dlvDashDelete" title="Delete this dashboard">&#128465; Delete</button>') +
          '</div>'
        : '<button type="button" class="dlv-dash-menu-btn" id="dlvDashMenuBtn" title="Dashboard options" aria-label="Dashboard options">&#8943;</button>') +
      (edit ? '<div class="dlv-dash-palette" id="dlvDashPalette">' +
        '<div class="dlv-dash-palette-drag" title="Drag to move this panel">&#9776; ' + (VIEWER_DASH_TARGET === 'hist' ? 'Histogram gauges' : 'Gauges') + '<span>drag to move</span></div>' +
        '<label class="dlv-dash-snap" title="Snap moves and bar-resizes to the grid (hold Alt to invert)"><input type="checkbox" id="dlvDashSnap"' + (VIEWER_DASH_SNAP !== false ? ' checked' : '') + '> Snap to grid</label>' +
        DASH_PALETTE.filter(function(p){ return p.type !== 'scorecard' || scorecardEnabled(); }).map(function(p){ return '<div class="dlv-dash-chip" draggable="true" data-dash-type="' + p.type + '"><span class="dlv-dash-chip-ico dash-ico-' + p.type + '"></span>' + p.label + '</div>'; }).join('') +
        '<button type="button" class="dlv-dash-chip dlv-dash-paste" id="dlvDashPaste" title="Paste the copied gauge (Ctrl+V also works)">&#10064; Paste gauge</button>' +
        '<div class="dlv-dash-palette-hint">Drag a gauge onto the grid. Right-click a gauge to assign its channel, set its range, warnings, label &amp; more, copy or duplicate it, or delete it. <b>Snap to grid</b> also snaps bar resizes so two bars line up; Alt inverts it. Hit <b>&#10003; Finalize</b> (top-right) when you\'re done.</div>' +
      '</div>' : '') +
      '<div class="dlv-dash-canvas' + (edit ? ' editing' : '') + '" id="dlvDashCanvas">' +
        (edit && (!VIEWER_DASH || !VIEWER_DASH.gauges.length) ? '<div class="dlv-dash-empty">Drag a gauge here to start</div>' : '') +
      '</div>' +
    '</div>';
  var canvas = document.getElementById('dlvDashCanvas');
  VIEWER_DASH_ELS = {};
  (VIEWER_DASH ? VIEWER_DASH.gauges : []).forEach(function(g){ dashPlaceGauge(canvas, g); });
  evaluateDashScorecards();   // scorecards evaluate over the log once their elements are placed
  if(edit){
    wireDashPalette(canvas);
    var palette = document.getElementById('dlvDashPalette');
    if(palette){
      // Floating + draggable (fixed to the viewport), so it can be parked anywhere -- including over
      // the channel list -- and never blocks where you want to drop a gauge (Ken). Default: the MIDDLE
      // of the workspace (Ken), then wherever the user leaves it. Measured now it's in the DOM.
      if(!VIEWER_DASH_PALETTE_POS){
        var cr = canvas.getBoundingClientRect();
        var pw = palette.offsetWidth || 126, ph = palette.offsetHeight || 220;
        // 25% in from the RIGHT border (Ken) -- dead-centre overlapped the canvas' "drag a gauge here"
        // directions. This is CSS right:25% (right edge a quarter-width from the right), clamped on-screen.
        var x = Math.round(cr.left + cr.width * 0.75 - pw);
        x = Math.max(cr.left + 8, Math.min(x, cr.right - pw - 8));
        VIEWER_DASH_PALETTE_POS = { x: x, y: Math.round(cr.top + Math.max(8, (cr.height - ph) / 2)) };
      }
      palette.style.left = VIEWER_DASH_PALETTE_POS.x + 'px';
      palette.style.top = VIEWER_DASH_PALETTE_POS.y + 'px';
      wireDashPaletteDrag(palette);
    }
    var snapCb = document.getElementById('dlvDashSnap');
    if(snapCb) snapCb.addEventListener('change', function(){ VIEWER_DASH_SNAP = snapCb.checked; });
    var pasteBtn = document.getElementById('dlvDashPaste');
    if(pasteBtn) pasteBtn.addEventListener('click', function(){
      // Ask the system clipboard first (a gauge copied in another window); fall back to ours.
      var fromMem = function(){ dashPaste(null, null); };
      try {
        if(navigator.clipboard && navigator.clipboard.readText){
          navigator.clipboard.readText().then(function(text){ var src = dashGaugeFromClipboardText(text); if(src) dashPaste(src, null); else fromMem(); }, fromMem);
          return;
        }
      } catch(err){}
      fromMem();
    });
  } else {
    dashApplyHug(host, canvas);   // shrink the canvas to fit the gauges (unless a dragged height overrides)
  }
  wireDashSplitter();   // both modes now: the splitter/adjuster is rendered in edit AND finalized (Ken)
  // Lifecycle controls: visible Finalize / Delete buttons while editing; a ⋯ pop-out (Edit / Delete)
  // once finalized. Only the relevant elements exist per mode, so the null-guarded wiring picks each.
  var finBtn = document.getElementById('dlvDashFinalize');
  if(finBtn) finBtn.addEventListener('click', dashFinalize);
  var loadgBtn = document.getElementById('dlvDashLoadGauges');
  if(loadgBtn) loadgBtn.addEventListener('click', function(e){ e.stopPropagation(); openDashLoadGaugesMenu(loadgBtn); });
  var editDelBtn = document.getElementById('dlvDashDelete');
  if(editDelBtn) editDelBtn.addEventListener('click', dashDeleteCurrent);
  var menuBtn = document.getElementById('dlvDashMenuBtn');
  if(menuBtn) menuBtn.addEventListener('click', function(e){ e.stopPropagation(); openDashCtrlMenu(menuBtn); });
  if(VIEWER_DATA) updateDashGauges(VIEWER_DATA.time.length - 1);
}

// ---- Histograms view ---------------------------------------------------------------------------
// The engine (datalog-histogram.js), expression engine (datalog-expr.js), table UI
// (datalog-histogram-ui.js) and editor (datalog-histogram-editor.js) are separate scripts that only
// see globals; this is the glue that hands them the viewer's data, roles, units, the zoom window and
// the navigation primitives, and takes their definition changes back for saving. Everything the UI
// needs from the viewer goes through histogramGlue() so the contract stays in one place.
function loadHistogramDefsLocal(){
  try {
    var raw = window.localStorage ? localStorage.getItem(VIEWER_HIST_LOCAL_KEY) : null;
    var arr = raw ? JSON.parse(raw) : null;
    if(!Array.isArray(arr)) return [];
    if(typeof Histogram !== 'undefined' && Histogram.migrateDef) arr.forEach(function(d){ try { Histogram.migrateDef(d); } catch(err){} });
    return arr;
  } catch(err){ return []; }
}
function saveHistogramDefsLocal(defs){
  try { if(window.localStorage) localStorage.setItem(VIEWER_HIST_LOCAL_KEY, JSON.stringify(defs || [])); } catch(err){}
}
// HP Tuners layout import (datalog-hpt.js). HPT refers to channels by numeric ParameterID; a tuner
// who maps "HPT parameter 19043" to a channel once should never be asked again, so the mapping is
// remembered per browser and handed to every later import ahead of the generic tables.
var VIEWER_HPT_MAP_KEY = 'pbdHptPidMap.v1';
function loadHptPidMap(){
  try {
    var raw = window.localStorage ? localStorage.getItem(VIEWER_HPT_MAP_KEY) : null;
    var m = raw ? JSON.parse(raw) : null;
    return (m && typeof m === 'object' && !Array.isArray(m)) ? m : {};
  } catch(err){ return {}; }
}
function saveHptPidMap(map){
  try { if(window.localStorage) localStorage.setItem(VIEWER_HPT_MAP_KEY, JSON.stringify(map || {})); } catch(err){}
}
function rememberHptMapping(pid, channelName){
  if(pid == null || !channelName) return;
  var map = loadHptPidMap();
  map[String(pid)] = channelName;
  saveHptPidMap(map);
}
// Resolution order is the importer's: this log's own PID row, then the remembered map, then the
// generic HPT ids (RPM, pedal, trims...), then the HPL decoder's harvested names. Unresolved ids come
// back as placeholder parameters so the table shows "Missing parameter" and offers a mapping.
function importHptLayoutText(text, opts){
  if(typeof HptConfig === 'undefined' || !HptConfig.importLayout){
    return { defs: [], unresolved: [], warnings: ['HP Tuners import module (datalog-hpt.js) is not loaded.'], tableCount: 0 };
  }
  var d = VIEWER_DATA || {};
  var ctx = {
    channels: d.channels || [], channelIds: d.channelIds || null,
    unitByChannel: VIEWER_UNIT_BY_CHANNEL || {}, resolvedRoles: VIEWER_RESOLVED_ROLES || {},
    textLevels: d.textLevels || null, userMap: loadHptPidMap(),
    pidNames: (window.DVCore && DVCore.HPL_PID_NAMES) || null, labelHints: null
  };
  return HptConfig.importLayout(text, ctx, opts || {});
}
function ensureHist(){
  if(!VIEWER_HIST) VIEWER_HIST = { defs: loadHistogramDefsLocal() };
  if(!VIEWER_HIST.defs) VIEWER_HIST.defs = [];
  return VIEWER_HIST;
}
// The histogram set as pure data for a saved view (null when there is nothing to carry).
function histogramDefsForSave(){
  if(!VIEWER_HIST || !VIEWER_HIST.defs || !VIEWER_HIST.defs.length) return null;
  return JSON.parse(JSON.stringify(VIEWER_HIST.defs));
}
// Shared by histograms and math channels (both are a named-def list a tuner builds up and expects to
// persist across logs). Loading a saved view must never silently discard something built since that
// view was last saved -- CRITICAL bug, fixed 2026-09-07: picking any saved view, even just to change
// graph layout, used to replace this store (and its localStorage mirror) unconditionally. If the
// incoming set is missing something the CURRENT set has, ask; declining MERGES rather than replacing,
// so nothing is ever lost either way.
function mergeNamedDefsOnLoad(currentDefs, incomingDefs, viewName, noun, plural){
  var incomingIds = {};
  incomingDefs.forEach(function(d){ incomingIds[d.id] = true; });
  var wouldDrop = currentDefs.filter(function(d){ return !incomingIds[d.id]; });
  if(!wouldDrop.length) return incomingDefs;
  var what = plural || (noun + 's');
  var msg = wouldDrop.length === 1
    ? 'Loading "' + viewName + '" will replace your ' + what + ' -- "' + (wouldDrop[0].name || 'Untitled') + '" is not part of it and would be lost. Replace anyway?\n\n(Cancel keeps it alongside the loaded set instead.)'
    : 'Loading "' + viewName + '" will replace your ' + what + ' -- ' + wouldDrop.length + ' ' + noun + '(s) are not part of it and would be lost. Replace anyway?\n\n(Cancel keeps them alongside the loaded set instead.)';
  if(window.confirm(msg)) return incomingDefs;
  return incomingDefs.concat(wouldDrop);
}
// ---- Math channels: named, reusable calculated channels --------------------------------------
// {id, name, expression, unit}. A histogram's cell/axis parameter references one by id
// (param.mathChannelId) instead of copying the expression, so editing the definition here (via
// HistogramEditor.openMathManager) updates every histogram that uses it -- the entire point of a
// named channel over a one-off "ƒ Math…" expression typed inline per parameter.
var VIEWER_MATH = null;
var VIEWER_MATH_LOCAL_KEY = 'pbdDatalogViewerMathChannels.v1';
function loadMathDefsLocal(){
  try {
    var raw = window.localStorage ? localStorage.getItem(VIEWER_MATH_LOCAL_KEY) : null;
    var arr = raw ? JSON.parse(raw) : null;
    return Array.isArray(arr) ? arr : [];
  } catch(err){ return []; }
}
function saveMathDefsLocal(defs){
  try { if(window.localStorage) localStorage.setItem(VIEWER_MATH_LOCAL_KEY, JSON.stringify(defs || [])); } catch(err){}
}
function ensureMath(){
  if(!VIEWER_MATH) VIEWER_MATH = { defs: loadMathDefsLocal() };
  if(!VIEWER_MATH.defs) VIEWER_MATH.defs = [];
  return VIEWER_MATH;
}
function mathChannelsForSave(){
  if(!VIEWER_MATH || !VIEWER_MATH.defs || !VIEWER_MATH.defs.length) return null;
  return JSON.parse(JSON.stringify(VIEWER_MATH.defs));
}
// Names of math channels currently injected into VIEWER_DATA (see injectMathChannels) -- tracked so a
// re-run (after editing the manager) can cleanly remove stale entries before adding fresh ones, rather
// than accumulating duplicates or leaving a renamed/deleted channel's old name behind.
var VIEWER_MATH_CHANNEL_NAMES = [];
// Makes a math channel behave like a real log channel in the left list/graphs (Ken, 2026-09-08:
// "math channels are not showing up in the channels list to the left" -- they never had, this is
// what wires them in). Mirrors applyDerivedChannels' own injection shape (name pushed into .channels/
// .units/.channelIds, values into .series) so every consumer keyed on "name -> series[name]"
// (renderOneChannelRow, channelColor, rebuildChart, valueAtCursor, computeChannelStats, dash gauges)
// works on a math channel with no changes of its own.
//
// Reuses HistogramUI.makeParamResolver -- the exact same expression-compile pipeline a histogram's
// mathChannelId parameter already goes through -- rather than re-implementing expression evaluation
// here. Computed against the DISPLAY-resolution VIEWER_DATA (what the graphs actually draw), not the
// full-resolution set histograms bin; a math channel used as a histogram parameter is unaffected and
// keeps computing against the full set exactly as it already does via glue.mathChannels.
//
// A math channel whose formula can't resolve on this log (missing role/channel) is simply left OUT of
// the list rather than shown with a blank/NaN trace -- same as how a histogram already treats a
// mathChannelId that fails to resolve. A math channel whose NAME collides with a real log column is
// also skipped: the real channel wins, never shadowed.
function injectMathChannels(){
  if(!VIEWER_DATA) return;
  if(VIEWER_MATH_CHANNEL_NAMES.length){
    VIEWER_MATH_CHANNEL_NAMES.forEach(function(name){
      var idx = VIEWER_DATA.channels.indexOf(name);
      if(idx !== -1){
        VIEWER_DATA.channels.splice(idx, 1);
        if(Array.isArray(VIEWER_DATA.units)) VIEWER_DATA.units.splice(idx, 1);
        if(Array.isArray(VIEWER_DATA.channelIds)) VIEWER_DATA.channelIds.splice(idx, 1);
      }
      delete VIEWER_DATA.series[name];
      delete VIEWER_UNIT_BY_CHANNEL[name];
      // A math channel that got renamed/deleted out from under an active selection would otherwise
      // leave a dead entry behind -- real log channels never disappear mid-session, so nothing else
      // in the app has ever needed to handle this case.
      var selIdx = VIEWER_SELECTED.indexOf(name);
      if(selIdx !== -1) VIEWER_SELECTED.splice(selIdx, 1);
      delete VIEWER_PANEL_ASSIGN[name];
    });
    VIEWER_MATH_CHANNEL_NAMES = [];
  }
  var defs = ensureMath().defs;
  if(!defs.length || typeof HistogramUI === 'undefined' || !HistogramUI.makeParamResolver) return;
  var resolver = HistogramUI.makeParamResolver(VIEWER_DATA, VIEWER_RESOLVED_ROLES, VIEWER_UNIT_BY_CHANNEL,
    function(){ return ensureMath().defs; });
  defs.forEach(function(def){
    if(!def || !def.name || VIEWER_DATA.channels.indexOf(def.name) !== -1) return;
    var resolved = resolver({ mathChannelId: def.id, unit: def.unit, label: def.name });
    if(!resolved || !resolved.values) return;
    VIEWER_DATA.channels.push(def.name);
    if(Array.isArray(VIEWER_DATA.units)) VIEWER_DATA.units.push(resolved.unit || '');
    if(Array.isArray(VIEWER_DATA.channelIds)) VIEWER_DATA.channelIds.push(null);
    VIEWER_DATA.series[def.name] = resolved.values;
    VIEWER_UNIT_BY_CHANNEL[def.name] = resolved.unit || null;
    VIEWER_MATH_CHANNEL_NAMES.push(def.name);
  });
  VIEWER_CHANNEL_STATS = computeChannelStats(VIEWER_DATA);
}
function isMathChannel(ch){ return VIEWER_MATH_CHANNEL_NAMES.indexOf(ch) !== -1; }

// ---- Estimated acceleration (datalog-accel.js) ---------------------------------------------------
// Calculated "Vehicle Dynamics" channels -- Estimated Acceleration (G / ft/s² / m/s²), Acceleration
// Rate, Estimated Chassis Speed, Estimated Wheel Slip, Wheel Spin Detected / Correction Active and the
// estimate's Confidence -- injected into VIEWER_DATA exactly like math channels, so every consumer keyed
// on "name -> series[name]" (list, graphs, cursor, tooltips, stats, gauges, histograms) just works.
// Settings (speed source / filtering / wheel-spin correction) live in localStorage; a change recomputes.
var VIEWER_ACCEL = null;                 // { settings, result }
var VIEWER_ACCEL_KEY = 'pbdDatalogViewerAccel.v1';
var VIEWER_ACCEL_NAMES = [];             // names currently injected (display + full sets)
function accelSettings(){
  if(VIEWER_ACCEL && VIEWER_ACCEL.settings) return VIEWER_ACCEL.settings;
  var s = null;
  try { var raw = window.localStorage ? localStorage.getItem(VIEWER_ACCEL_KEY) : null; s = raw ? JSON.parse(raw) : null; } catch(e){ s = null; }
  s = s && typeof s === 'object' ? s : {};
  var d = (typeof DatalogAccel !== 'undefined') ? DatalogAccel.DEFAULT_SETTINGS : { source: 'auto', filter: 'auto', spin: 'auto' };
  var out = { source: s.source || d.source, filter: s.filter || d.filter, spin: s.spin || d.spin };
  VIEWER_ACCEL = VIEWER_ACCEL || {};
  VIEWER_ACCEL.settings = out;
  return out;
}
function setAccelSettings(patch){
  var s = accelSettings();
  Object.keys(patch || {}).forEach(function(k){ s[k] = patch[k]; });
  try { if(window.localStorage) localStorage.setItem(VIEWER_ACCEL_KEY, JSON.stringify(s)); } catch(e){}
}
function isAccelChannel(ch){ return VIEWER_ACCEL_NAMES.indexOf(ch) !== -1; }
function accelAddChannel(data, name, unit, values){
  data.channels.push(name);
  if(Array.isArray(data.units)) data.units.push(unit || '');
  if(Array.isArray(data.channelIds)) data.channelIds.push(null);   // no HP Tuners PID, keep the rows aligned
  data.series[name] = values;
}
function accelRemoveChannel(data, name){
  var idx = data.channels.indexOf(name);
  if(idx !== -1){ data.channels.splice(idx, 1); if(Array.isArray(data.units)) data.units.splice(idx, 1); if(Array.isArray(data.channelIds)) data.channelIds.splice(idx, 1); }
  delete data.series[name];
}
// The display set is a SUBSET of the full set's rows: pick, for every display timestamp, the full sample
// at (or nearest to) that time. Linear walk, both axes ascending.
function accelSampleToDisplay(fullT, dispT, arr){
  var out = new Float64Array(dispT.length), j = 0, n = fullT.length;
  for(var i = 0; i < dispT.length; i++){
    var t = dispT[i];
    while(j + 1 < n && fullT[j] < t) j++;
    var k = j;
    if(j > 0 && Math.abs(fullT[j - 1] - t) < Math.abs(fullT[j] - t)) k = j - 1;
    out[i] = arr[k];
  }
  return out;
}
function injectAccelChannels(){
  if(!VIEWER_DATA) return;
  var full = (VIEWER_DATA.full && VIEWER_DATA.full.series && VIEWER_DATA.full.time) ? VIEWER_DATA.full : null;
  // A recompute (⚙ change) replaces the series but must NOT change what is on the graphs -- Ken,
  // 2026-09-09: "if I change the filtering on a parameter that is graphed, it removes it from the graph".
  // Remember each estimated channel's selection + panel and put it back once the channel is re-injected;
  // only a channel that does not come back (e.g. the speed source vanished) loses its place.
  var keepSel = {}, keepPanel = {};
  VIEWER_ACCEL_NAMES.forEach(function(name){
    accelRemoveChannel(VIEWER_DATA, name);
    if(full) accelRemoveChannel(full, name);
    delete VIEWER_UNIT_BY_CHANNEL[name];
    delete VIEWER_RAW_SERIES[name]; delete VIEWER_RAW_FULL_SERIES[name];   // the series are being replaced
    var si = VIEWER_SELECTED.indexOf(name);
    if(si !== -1){ keepSel[name] = si; VIEWER_SELECTED.splice(si, 1); }
    if(VIEWER_PANEL_ASSIGN[name] !== undefined) keepPanel[name] = VIEWER_PANEL_ASSIGN[name];
    delete VIEWER_PANEL_ASSIGN[name];
  });
  VIEWER_ACCEL_NAMES = [];
  if(typeof DatalogAccel === 'undefined' || !DatalogAccel.run) return;
  var base = full ? { channels: full.channels, units: full.units, series: full.series, time: full.time, textLevels: full.textLevels } : VIEWER_DATA;
  var roles = full ? resolveChannelRoles(full.channels) : VIEWER_RESOLVED_ROLES;
  var unitMap = {};
  base.channels.forEach(function(c, i){ unitMap[c] = base.units ? base.units[i] : ''; });
  var res = null;
  try { res = DatalogAccel.run(base, roles, unitMap, getCurrentVehicleMeta(), accelSettings()); }
  catch(err){ if(window.console) console.warn('Estimated acceleration failed', err); res = null; }
  VIEWER_ACCEL = VIEWER_ACCEL || {};
  VIEWER_ACCEL.result = res;
  if(!res || !res.channels || !res.channels.length) return;
  res.channels.forEach(function(c){
    if(VIEWER_DATA.channels.indexOf(c.name) !== -1) return;   // a real logged column of that name wins
    var vals = c.values;
    if(full){ accelAddChannel(full, c.name, c.unit, c.values); vals = accelSampleToDisplay(full.time, VIEWER_DATA.time, c.values); }
    accelAddChannel(VIEWER_DATA, c.name, c.unit, vals);
    VIEWER_UNIT_BY_CHANNEL[c.name] = c.unit || null;
    VIEWER_ACCEL_NAMES.push(c.name);
    if(keepSel[c.name] !== undefined && VIEWER_SELECTED.indexOf(c.name) === -1) VIEWER_SELECTED.splice(Math.min(keepSel[c.name], VIEWER_SELECTED.length), 0, c.name);
    if(keepPanel[c.name] !== undefined) VIEWER_PANEL_ASSIGN[c.name] = keepPanel[c.name];
  });
  VIEWER_CHANNEL_STATS = computeChannelStats(VIEWER_DATA);
  applyAllSmoothing();   // a smoothed estimated channel stays smoothed after a recompute
}
// Developer console: how the estimate was built (sources used / rejected, spin events, window, rate).
window.DatalogAccelDebug = function(){ return (VIEWER_ACCEL && VIEWER_ACCEL.result) ? VIEWER_ACCEL.result.meta : null; };
// The small settings popover behind the ⚙ on any estimated-acceleration row.
function openAccelSettings(anchor){
  closeHdrMenu();
  var s = accelSettings(), res = VIEWER_ACCEL && VIEWER_ACCEL.result, meta = res ? res.meta : null;
  var m = document.createElement('div');
  m.className = 'dlv-gmenu dlv-hdr-menu dlv-accel-menu';
  m.__which = 'accel';
  var srcOpts = [['auto', 'Auto'], ['gps', 'GPS'], ['vss', 'Vehicle speed'], ['wheels', 'Wheel speed fusion']];
  if(res && res.discovered && res.discovered.sources) res.discovered.sources.forEach(function(x){ srcOpts.push([x.name, x.name]); });
  var filtOpts = [['auto', 'Auto'], ['fast', 'Fast (50 ms)'], ['normal', 'Normal (150 ms)'], ['smooth', 'Smooth (250 ms)'], ['verysmooth', 'Very smooth (500 ms)']];
  var spinOpts = [['off', 'Off'], ['auto', 'Auto'], ['aggressive', 'Aggressive']];
  function sel(key, label, opts, cur){
    return '<label class="dlv-accel-row"><span>' + label + '</span><select data-accel="' + key + '">' + opts.map(function(o){
      return '<option value="' + escapeHtml(o[0]) + '"' + (String(cur).toLowerCase() === String(o[0]).toLowerCase() ? ' selected' : '') + '>' + escapeHtml(o[1]) + '</option>'; }).join('') + '</select></label>';
  }
  var html = '<h4>Estimated Acceleration</h4>' +
    sel('source', 'Speed source', srcOpts, s.source) + sel('filter', 'Filtering', filtOpts, s.filter) + sel('spin', 'Wheel spin correction', spinOpts, s.spin);
  if(meta){
    html += '<div class="dlv-accel-info">' +
      '<div><b>Chassis speed:</b> ' + escapeHtml(meta.sourceText || '—') + '</div>' +
      '<div><b>Window:</b> ' + meta.windowMs + ' ms · <b>Sample rate:</b> ' + meta.sampleHz + ' Hz' + (meta.resolutionMph ? ' · <b>Resolution:</b> ' + meta.resolutionMph + ' mph' : '') + '</div>' +
      (meta.windowNote ? '<div><b>Note:</b> ' + escapeHtml(meta.windowNote) + '</div>' : '') +
      (meta.rejected && meta.rejected.length ? '<div><b>Not used:</b> ' + escapeHtml(meta.rejected.map(function(r){ return r.name; }).join(', ')) + '</div>' : '') +
      (meta.events && meta.events.length ? '<div><b>Events:</b> ' + meta.events.slice(0, 6).map(function(e){ return escapeHtml(e.kind) + ' ' + e.t0.toFixed(1) + '–' + e.t1.toFixed(1) + ' s' + (e.corrected ? ' (corrected)' : ''); }).join('; ') + (meta.events.length > 6 ? ' …' : '') + '</div>' : '<div><b>Events:</b> no wheel spin found</div>') +
      '</div>';
  } else html += '<div class="dlv-gmenu-hint">No speed channel in this log — nothing to estimate.</div>';
  m.innerHTML = html;
  m.addEventListener('mousedown', function(e){ e.stopPropagation(); });
  m.addEventListener('click', function(e){ e.stopPropagation(); });
  document.body.appendChild(m);
  positionHdrMenu(m, anchor);
  VIEWER_HDR_MENU = m;
  m.querySelectorAll('[data-accel]').forEach(function(el){
    el.addEventListener('change', function(){
      var patch = {}; patch[el.getAttribute('data-accel')] = el.value;
      setAccelSettings(patch);
      closeHdrMenu();
      injectAccelChannels();
      renderViewerBody();
      if(window.showToast) showToast('Estimated acceleration recalculated.');
    });
  });
}
document.addEventListener('click', function(e){
  var b = e.target && e.target.closest ? e.target.closest('[data-accel-cfg]') : null;
  if(!b) return;
  e.stopPropagation(); e.preventDefault();
  openAccelSettings(b);
}, true);

// ---- Per-channel smoothing (Ken, 2026-09-09: "for things like the g meter, or maybe even any parameter,
// we need a way to control smoothing") ----------------------------------------------------------------
// A channel's smoothing is a centred moving average over a TIME window (ms, so it means the same thing
// at 25 Hz and 200 Hz). The raw series is kept aside and the smoothed copy takes its place in
// VIEWER_DATA (and the full-resolution set), so graphs, cursor readouts, gauges, stats and histograms all
// see the same smoothed trace with no per-consumer changes. Settings live in localStorage (per channel
// name, across logs) and ride along in a saved Layout.
var VIEWER_SMOOTHING = null;
var VIEWER_SMOOTHING_KEY = 'pbdDatalogViewerSmoothing.v1';
var VIEWER_RAW_SERIES = {};        // channel -> raw display series while a smoothed copy is installed
var VIEWER_RAW_FULL_SERIES = {};   // same for the full-resolution set
var SMOOTHING_OPTIONS = [[0, 'Off'], [50, '50 ms'], [100, '100 ms'], [150, '150 ms'], [250, '250 ms'], [500, '500 ms'], [1000, '1 s'], [2000, '2 s']];
function smoothingMap(){
  if(VIEWER_SMOOTHING) return VIEWER_SMOOTHING;
  var m = null;
  try { var raw = window.localStorage ? localStorage.getItem(VIEWER_SMOOTHING_KEY) : null; m = raw ? JSON.parse(raw) : null; } catch(e){ m = null; }
  VIEWER_SMOOTHING = (m && typeof m === 'object') ? m : {};
  return VIEWER_SMOOTHING;
}
function smoothingFor(ch){ var m = smoothingMap(); var v = m[ch]; return (typeof v === 'number' && isFinite(v) && v > 0) ? v : 0; }
function smoothingForSave(){ var m = smoothingMap(), out = {}, any = false; Object.keys(m).forEach(function(k){ if(m[k] > 0 && VIEWER_DATA && VIEWER_DATA.series[k]){ out[k] = m[k]; any = true; } }); return any ? out : null; }
function persistSmoothing(){ try { if(window.localStorage) localStorage.setItem(VIEWER_SMOOTHING_KEY, JSON.stringify(smoothingMap())); } catch(e){} }
// Centred mean over [t - ms/2, t + ms/2], finite samples only, O(n) with a sliding window.
function smoothSeries(time, vals, ms){
  var n = time.length, half = ms / 2000, out = new Float64Array(n), lo = 0, hi = -1, sum = 0, cnt = 0, i;
  for(i = 0; i < n; i++){
    var t = time[i];
    while(hi + 1 < n && time[hi + 1] <= t + half){ hi++; var a = vals[hi]; if(a != null && isFinite(a)){ sum += a; cnt++; } }
    while(lo <= hi && time[lo] < t - half){ var r = vals[lo]; if(r != null && isFinite(r)){ sum -= r; cnt--; } lo++; }
    out[i] = cnt > 0 ? sum / cnt : NaN;
  }
  return out;
}
function applySmoothing(ch){
  if(!VIEWER_DATA || !VIEWER_DATA.series[ch] || isTextChannel(ch)) return;
  var ms = smoothingFor(ch);
  var sets = [[VIEWER_DATA, VIEWER_RAW_SERIES]];
  if(VIEWER_DATA.full && VIEWER_DATA.full.series && VIEWER_DATA.full.series[ch]) sets.push([VIEWER_DATA.full, VIEWER_RAW_FULL_SERIES]);
  sets.forEach(function(pair){
    var set = pair[0], rawStore = pair[1];
    if(!rawStore[ch]) rawStore[ch] = set.series[ch];
    var raw = rawStore[ch];
    if(ms > 0) set.series[ch] = smoothSeries(set.time, raw, ms);
    else { set.series[ch] = raw; delete rawStore[ch]; }
  });
  var st = computeChannelStats({ channels: [ch], series: VIEWER_DATA.series, textLevels: VIEWER_DATA.textLevels });
  VIEWER_CHANNEL_STATS[ch] = st[ch];
}
function applyAllSmoothing(){
  if(!VIEWER_DATA) return;
  var m = smoothingMap();
  Object.keys(m).forEach(function(ch){ if(m[ch] > 0 && VIEWER_DATA.series[ch]) applySmoothing(ch); });
}
function setSmoothing(ch, ms){
  var m = smoothingMap();
  if(ms > 0) m[ch] = ms; else delete m[ch];
  persistSmoothing();
  applySmoothing(ch);
}
// A saved Layout's smoothing map replaces the per-channel settings for the channels it names.
function setSmoothingMap(map){
  var m = smoothingMap();
  Object.keys(map || {}).forEach(function(ch){ var v = parseFloat(map[ch]); if(isFinite(v) && v > 0) m[ch] = v; else delete m[ch]; });
  persistSmoothing();
  applyAllSmoothing();
}
function openSmoothingMenu(anchor, ch){
  closeHdrMenu();
  var cur = smoothingFor(ch);
  var m = document.createElement('div');
  m.className = 'dlv-gmenu dlv-hdr-menu dlv-smooth-menu';
  m.__which = 'smooth';
  m.innerHTML = '<h4>' + escapeHtml(ch) + '</h4>' +
    '<label class="dlv-accel-row"><span>Smoothing</span><select data-smooth-ms>' + SMOOTHING_OPTIONS.map(function(o){
      return '<option value="' + o[0] + '"' + (o[0] === cur ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></label>' +
    '<div class="dlv-accel-info">A centred moving average over that much time. Applies to the graphs, cursor readouts, gauges, stats and histograms; the raw data is kept and comes back with Off. Saved with a Layout.' +
    (isAccelChannel(ch) ? ' The ⚙ on this row sets the estimator\'s own filter; this smoothing goes on top.' : '') + '</div>';
  m.addEventListener('mousedown', function(e){ e.stopPropagation(); });
  m.addEventListener('click', function(e){ e.stopPropagation(); });
  document.body.appendChild(m);
  positionHdrMenu(m, anchor);
  VIEWER_HDR_MENU = m;
  m.querySelector('[data-smooth-ms]').addEventListener('change', function(){
    var ms = parseFloat(this.value) || 0;
    closeHdrMenu();
    setSmoothing(ch, ms);
    markLayoutDirty();
    renderViewerBody();
    if(window.showToast) showToast(ms ? escapeHtml(ch) + ': ' + ms + ' ms smoothing' : escapeHtml(ch) + ': smoothing off');
  });
}
document.addEventListener('click', function(e){
  var b = e.target && e.target.closest ? e.target.closest('[data-smooth-ch]') : null;
  if(!b) return;
  e.stopPropagation(); e.preventDefault();
  openSmoothingMenu(b, b.getAttribute('data-smooth-ch'));
}, true);
// Which saved item (Layout or Custom Gauges) the tuner picked last, remembered for the session so the
// next log opened in the same tab comes up with it (Ken, 2026-09-09: a saved layout should carry the graph
// channels to the next log -- those that exist in it). Host-pushed vehicle configs still win.
var VIEWER_LAST_SAVED = null;   // { kind: 'view'|'gauges', id, name }
function rememberLastSaved(kind, id, name){ VIEWER_LAST_SAVED = { kind: kind, id: id, name: name }; saveViewerPrefs(); }
function reapplyLastSaved(){
  var last = VIEWER_LAST_SAVED; if(!last || !last.id) return false;
  var lp = viewsProvider(); if(!lp) return false;
  var state = null;
  try { state = lp.apply(last.id); } catch(e){ state = null; }
  if(!state){
    // A miss here usually means the provider's store has not filled YET (a cloud pull that settles
    // after the log opens -- the normal case when the app is started BY a log file). Forgetting the
    // memory then meant the layout never came back at all, so only forget it when the store is loaded
    // and this id is genuinely gone (deleted on another device).
    var loaded = VIEWER_SAVED_VIEWS && VIEWER_SAVED_VIEWS.length;
    var stillThere = loaded && VIEWER_SAVED_VIEWS.some(function(r){ return String(r.id) === String(last.id); });
    if(loaded && !stillThere) VIEWER_LAST_SAVED = null;
    return false;
  }
  applyViewConfig(state, { kind: 'saved', id: last.id, name: last.name });
  if(window.showToast) showToast('Layout "' + last.name + '" applied.');
  return true;
}
function enterHistograms(){
  if(!viewerIsPro()) return;
  adlTrack('histograms_used', { action: 'open' });
  ensureHist();
  VIEWER_VIEW_MODE = 'histograms';
  saveViewerPrefs();
  renderViewerBody();
}
// The zoom window as sample indices into the FULL-resolution set (the array histograms bin), when
// one exists. getVisibleRange() walks the display set -- ~12k points -- so on any real pull log its
// startIdx/endIdx address a different, shorter array; re-walk the same t0/t1 over full.time with the
// identical nearest-index rules (half-open corrections, repeated-timestamp walk-out, collapse) so a
// "Selection" table bins exactly the span the graphs show.
function histogramRange(){
  var r = getVisibleRange();
  if(!r || !VIEWER_DATA || !VIEWER_DATA.full || !VIEWER_DATA.full.time) return r;
  var T = VIEWER_DATA.full.time, n = T.length;
  if(!n) return r;
  var i0 = nearestTimeIndex(T, r.t0); if(T[i0] < r.t0) i0++;
  var i1 = nearestTimeIndex(T, r.t1); if(T[i1] > r.t1) i1--;
  while(i0 > 0 && T[i0 - 1] >= r.t0) i0--;
  while(i1 < n - 1 && T[i1 + 1] <= r.t1) i1++;
  i0 = Math.max(0, Math.min(n - 1, i0));
  i1 = Math.max(0, Math.min(n - 1, i1));
  if(i1 < i0){ i0 = i1 = nearestTimeIndex(T, (r.t0 + r.t1) / 2); }
  return { t0: r.t0, t1: r.t1, startIdx: i0, endIdx: i1, isFull: r.isFull };
}
function histogramGlue(){
  var g = {
    data: function(){
      var d = VIEWER_DATA;
      if(!d) return null;
      // Identity-stable per log: the UI keys its resolver / compiled-filter / result caches on this
      // object, so a fresh object per call would recompile every filter and recompute every table
      // on each interaction. Rebuilt only when a new log replaces VIEWER_DATA.
      if(d._histData) return d._histData;
      var total = d.totalRows || d.time.length, kept = d.returnedRows || d.time.length;
      // Prefer the full-resolution set the host kept (see openViewerCore); fall back to the display
      // set and say so -- a histogram's hit counts are counts of the samples it actually saw.
      var full = (d.full && d.full.series && d.full.time) ? d.full : null;
      d._histData = {
        channels: full ? full.channels : d.channels, units: full ? full.units : d.units,
        time: full ? full.time : d.time, series: full ? full.series : d.series,
        textLevels: full ? full.textLevels : d.textLevels, channelIds: d.channelIds || null,
        sampleInfo: { isDecimated: full ? !!full.decimated : total > kept, totalRows: total,
                      returnedRows: full ? full.time.length : kept }
      };
      return d._histData;
    },
    resolvedRoles: function(){ return VIEWER_RESOLVED_ROLES || {}; },
    unitByChannel: function(){ return VIEWER_UNIT_BY_CHANNEL || {}; },
    // Indexed against the array the tables actually bin (see histogramRange): getVisibleRange()
    // indexes the DISPLAY set, which is a different, shorter array than data() hands out when a
    // full-resolution set exists -- passing its indices through would slice the wrong span.
    getRange: histogramRange,
    onRangeChange: function(fn){
      if(typeof fn !== 'function') return;
      var wrap = function(){ fn(histogramRange()); };
      fn.__histRangeWrap = wrap;
      onVisibleRangeChange(wrap);
    },
    offRangeChange: function(fn){ offVisibleRangeChange((fn && fn.__histRangeWrap) || fn); },
    navigate: {
      setRange: function(t0, t1){ setVisibleRange(t0, t1); },
      setCursor: setCursorTime,
      highlightIndices: setHighlightIndices
    },
    convertValue: (typeof convertValue === 'function') ? convertValue : null,
    // HP Tuners layout import: the UI sniffs a dropped/chosen file and hands the text here.
    hpt: {
      available: typeof HptConfig !== 'undefined' && !!HptConfig.importLayout,
      isLayoutXml: function(text){ return typeof HptConfig !== 'undefined' && !!HptConfig.isLayoutXml && HptConfig.isLayoutXml(text); },
      importLayout: importHptLayoutText,
      rememberMapping: rememberHptMapping,
      userMap: loadHptPidMap
    },
    defsChanged: function(defs){
      ensureHist().defs = defs || [];
      saveHistogramDefsLocal(VIEWER_HIST.defs);
      markLayoutDirty();
    },
    // Named, reusable calculated channels -- list() is read fresh by the resolver on every call (so
    // an edit in the manager takes effect immediately, no re-render needed), save() persists the
    // whole list the SAME way histogram defs do (session + localStorage mirror + dirty flag).
    mathChannels: {
      list: function(){ return ensureMath().defs; },
      save: function(defs){
        ensureMath().defs = defs || [];
        saveMathDefsLocal(VIEWER_MATH.defs);
        markLayoutDirty();
        // A math channel's expression can change with NO histogram def itself touched, so the table's
        // own per-def compute cache has no way to know it needs to recompute -- force it, or an open
        // table keeps showing stale numbers after "Edit this definition..." (caught live, 2026-09-07).
        if(VIEWER_HIST_CTL && typeof VIEWER_HIST_CTL.refresh === 'function'){ try { VIEWER_HIST_CTL.refresh(); } catch(err){} }
        // Re-sync the left channel list (and anything graphing one) with the edited/added/removed
        // math channels -- a full re-render rather than just the channel rows, since a renamed or
        // deleted math channel that was actively graphed needs the GRAPH to drop it too, not just its
        // row in the list.
        injectMathChannels();
        renderViewerBody();
      }
    },
    isPro: viewerIsPro(),
    // Gauges behind the table: the list menu offers the designer; the UI keeps a back layer for them.
    editBackGauges: function(){ openHistGaugesEditor(); },
    hasBackGauges: function(){ return histDashGauges().length > 0; },
    // Every paint of the active view (a wider table, a page flip, a state panel) re-lays the gauges out
    // around the table's new footprint.
    onTableLayout: function(){ fitHistGaugeLayer(); },
    toast: function(msg){ if(window.showToast) showToast(msg); },
    escapeHtml: escapeHtml
  };
  // The editor is optional at runtime (a host may ship the tables without it); when present, fill in
  // whatever the table UI didn't pass so the editor always sees the full viewer context.
  if(typeof HistogramEditor !== 'undefined' && HistogramEditor.open){
    g.openEditor = function(def, opts){
      var o = opts || {};
      return HistogramEditor.open(def, {
        data: o.data || g.data(),
        resolvedRoles: o.resolvedRoles || g.resolvedRoles(),
        unitByChannel: o.unitByChannel || g.unitByChannel(),
        resolver: o.resolver || null,
        focusSlot: o.focusSlot || null,
        isNew: !!o.isNew,
        mathChannels: g.mathChannels,
        onSave: o.onSave, onCancel: o.onCancel,
        toast: g.toast, escapeHtml: escapeHtml
      });
    };
  }
  if(typeof HistogramEditor !== 'undefined' && HistogramEditor.openMathManager){
    g.openMathManager = function(opts){
      var o = opts || {};
      return HistogramEditor.openMathManager({
        list: g.mathChannels.list, onSave: g.mathChannels.save,
        data: o.data || g.data(), resolvedRoles: o.resolvedRoles || g.resolvedRoles(),
        unitByChannel: o.unitByChannel || g.unitByChannel(),
        toast: g.toast, escapeHtml: escapeHtml
      });
    };
  }
  return g;
}
function renderHistogramView(){
  var host = document.getElementById('dlvHistView');
  if(!host) return;
  ensureHist();
  host.style.height = VIEWER_HIST_H ? VIEWER_HIST_H + 'px' : '';
  if(typeof HistogramUI === 'undefined' || !HistogramUI.mount){
    host.innerHTML = '<div class="dlv-hist-unavailable">The Histograms module (datalog-histogram-ui.js) is not loaded on this page.</div>';
    return;
  }
  if(VIEWER_HIST_CTL && VIEWER_HIST_CTL.destroy){ try { VIEWER_HIST_CTL.destroy(); } catch(err){} }
  // HIGH: HistogramUI.mount() adds its OWN sizing class (.dlv-hist: width/height 100%) directly onto
  // the element it is given. Mounting straight into #dlvHistView collided with THAT element's own
  // .dlv-hist-view rule (height: 52% of the main column, set above) -- same specificity, so whichever
  // stylesheet loaded later won the tie and the histogram pane took 100% of the main column, pushing
  // the graphs/scrubber/splitter off screen. A dedicated child sidesteps the collision entirely:
  // #dlvHistView keeps its own sizing and HistogramUI just fills that box.
  host.innerHTML = '<div class="dlv-hist-mount" style="width:100%;height:100%;min-width:0;min-height:0;"></div>';
  var histMountEl = host.firstElementChild;
  VIEWER_HIST_CTL = HistogramUI.mount(histMountEl, histogramGlue());
  if(VIEWER_HIST_CTL && VIEWER_HIST_CTL.setDefs) VIEWER_HIST_CTL.setDefs(VIEWER_HIST.defs);
  renderHistGaugeLayer();   // the gauges behind the table (none = empty layer)
  // Prime the live cursor mark with wherever the cursor was already parked (e.g. arrow-keyed mid-log
  // before switching tabs) instead of leaving it pinned to the last sample until the next mouse move.
  if(VIEWER_HIST_CTL && typeof VIEWER_HIST_CTL.setCursor === 'function') VIEWER_HIST_CTL.setCursor(VIEWER_CURSOR_TIME);
  wireHistSplitter();
}
// Same adjuster the dash has in edit mode: drag the divider to trade table height for graph height,
// double-click to go back to the default share.
function wireHistSplitter(){
  var sp = document.getElementById('dlvSplitter'), hv = document.getElementById('dlvHistView');
  if(!sp || !hv) return;
  sp.addEventListener('pointerdown', function(e){
    if(e.button !== 0) return;
    e.preventDefault();
    sp.classList.add('dragging');
    try { sp.setPointerCapture(e.pointerId); } catch(err){}
    var startY = e.clientY, startH = hv.getBoundingClientRect().height;
    var main = document.querySelector('.dlv-main');
    var mainH = main ? main.getBoundingClientRect().height : window.innerHeight;
    function move(ev){
      var h = Math.max(160, Math.min(startH + (ev.clientY - startY), mainH - 130));
      VIEWER_HIST_H = Math.round(h);
      hv.style.height = VIEWER_HIST_H + 'px';
      resizeViewerCharts();
    }
    function up(){
      sp.classList.remove('dragging');
      sp.removeEventListener('pointermove', move);
      sp.removeEventListener('pointerup', up);
      sp.removeEventListener('pointercancel', up);
    }
    sp.addEventListener('pointermove', move);
    sp.addEventListener('pointerup', up);
    sp.addEventListener('pointercancel', up);
  });
  sp.addEventListener('dblclick', function(){ VIEWER_HIST_H = null; hv.style.height = ''; resizeViewerCharts(); });
}
// Park the cursor on the sample nearest t -- the same three steps arrow-key stepping does, so the
// cards, gauges, channel values and scrubber playhead all follow.
function setCursorTime(t){
  if(!VIEWER_DATA || !VIEWER_DATA.time.length || !isFinite(t)) return;
  var idx = nearestTimeIndex(VIEWER_DATA.time, +t);
  CROSSHAIR_TIME = VIEWER_DATA.time[idx];
  VIEWER_CURSOR_TIME = CROSSHAIR_TIME;
  // Synchronous, unlike hover: this is one discrete jump (a histogram cell, a scorecard evidence
  // link, a host calling navigate.setCursor) and callers read the cursor straight afterwards. It
  // still only repaints -- the frame coalescing is for streams of pointer moves, not single actions.
  cancelCursorPaint();
  updateAtCursor(CROSSHAIR_TIME);
  drawCrosshairOverlays();
}
// Paint the given sample indices (a histogram cell's contributors) on the graphs and the overview
// bar. Runs of consecutive indices become one span; null/empty clears. Repaints only -- never a rebuild.
function setHighlightIndices(indices){
  VIEWER_HIGHLIGHT_SPANS = [];
  if(indices && indices.length && VIEWER_DATA && VIEWER_DATA.time.length){
    // The indices come from the histogram engine, which binned the FULL-resolution set when one
    // exists -- map them through that same array, or the bands land at the wrong times.
    var T = (VIEWER_DATA.full && VIEWER_DATA.full.time) ? VIEWER_DATA.full.time : VIEWER_DATA.time, n = T.length;
    var sorted = Array.prototype.slice.call(indices).sort(function(a, b){ return a - b; });
    var s = sorted[0], p = sorted[0];
    for(var i = 1; i <= sorted.length; i++){
      var v = sorted[i];
      if(i < sorted.length && v === p + 1){ p = v; continue; }
      if(s >= 0 && p < n) VIEWER_HIGHLIGHT_SPANS.push({ t0: T[s], t1: T[p] });
      s = p = v;
    }
  }
  repaintCharts();   // the spans are a plugin draw -- no scale or dataset changed
  updateScrubberHighlights();
}
// Overview-bar marks, positioned in PERCENT of the run so a window resize needs no re-layout. Spans
// closer than a tenth of a percent are merged: a cell fed by scattered samples becomes a few dozen
// marks, not thousands of 0px divs.
function updateScrubberHighlights(){
  var box = document.getElementById('dlvScrubHl');
  if(!box) return;
  if(!VIEWER_HIGHLIGHT_SPANS.length || !VIEWER_DATA || !VIEWER_DATA.time.length){ box.innerHTML = ''; return; }
  var T = VIEWER_DATA.time, fullMin = T[0], fullRange = (T[T.length - 1] - fullMin) || 1;
  var pct = VIEWER_HIGHLIGHT_SPANS.map(function(sp){
    return [(sp.t0 - fullMin) / fullRange * 100, (sp.t1 - fullMin) / fullRange * 100];
  }).sort(function(a, b){ return a[0] - b[0]; });
  var merged = [];
  pct.forEach(function(p){
    var last = merged[merged.length - 1];
    if(last && p[0] <= last[1] + 0.1) last[1] = Math.max(last[1], p[1]);
    else merged.push([p[0], p[1]]);
  });
  box.innerHTML = merged.map(function(m){
    return '<div class="dlv-scrub-hl-mark" style="left:' + m[0].toFixed(3) + '%;width:' + Math.max(0.15, m[1] - m[0]).toFixed(3) + '%"></div>';
  }).join('');
}

// Fetch a saved config's full data by id, from whichever store backs it (host provider or the local/API
// list rows that already carry `config`). Used by "Load gauges" below.
function getSavedConfigById(id){
  var lp = viewsProvider();
  if(lp){ try { return lp.apply(id); } catch(e){ return null; } }
  var row = VIEWER_SAVED_VIEWS.filter(function(r){ return String(r.id) === String(id); })[0];
  return row ? row.config : null;
}
// Replace the gauges on the dash you're EDITING with a saved gauge set's gauges -- keeping the
// layout's graphs (unlike picking a saved gauge from the header, which now also keeps them, since
// applyGaugesConfig is scoped to gauges only either way -- but this path stays in BUILD mode and
// marks the load dirty, since it's the admin authoring move: open a dash, load the right saved set
// into it, keep tweaking (Ken, 2026-07-25)).
function loadGaugesIntoDash(id){
  var cfg = getSavedConfigById(id);
  var _srow = VIEWER_SAVED_VIEWS.filter(function(r){ return String(r.id) === String(id); })[0];
  applyGaugesConfig(cfg, { kind: 'saved', id: id, name: _srow ? _srow.name : 'Gauges' },
    { edit: true, dirty: true, toast: 'Loaded gauges into this dash.' });
}
// Menu of saved gauge dashboards to load into the dash being edited. Anchored to the "Load gauges"
// button in the dash editor (always reachable in edit mode, unlike the auto-hiding header picker).
function openDashLoadGaugesMenu(anchor){
  var already = VIEWER_HDR_MENU && VIEWER_HDR_MENU.__which === 'dashload';
  closeHdrMenu();
  if(already) return;
  var gauges = VIEWER_SAVED_VIEWS.filter(function(r){ return savedRowKind(r) === 'gauges'; });
  var m = document.createElement('div');
  m.className = 'dlv-gmenu dlv-hdr-menu dlv-vpick-menu';
  m.__which = 'dashload';
  m.addEventListener('click', function(e){ e.stopPropagation(); });
  m.innerHTML = '<h4>Load saved gauges</h4>' + (gauges.length
    ? gauges.map(function(r){ return '<div class="dlv-vrow"><button type="button" class="act clear dlv-vrow-pick" data-loadg="' + escapeHtml(String(r.id)) + '">' + escapeHtml(r.name) + '</button></div>'; }).join('')
    : '<div class="dlv-gmenu-hint">No saved gauge dashes yet.</div>') +
    (libraryAvailable() ? '<div class="dlv-menu-sep"></div><div class="dlv-vrow"><button type="button" class="act clear dlv-vrow-pick" data-library="gauges">Browse the library…</button></div>' : '');
  document.body.appendChild(m);
  var r = anchor.getBoundingClientRect(), pad = 8;
  m.style.top = (r.bottom + 6) + 'px';
  m.style.left = Math.max(pad, Math.min(r.right - m.offsetWidth, window.innerWidth - m.offsetWidth - pad)) + 'px';
  VIEWER_HDR_MENU = m;
  m.querySelectorAll('[data-loadg]').forEach(function(btn){
    btn.addEventListener('click', function(){ closeHdrMenu(); loadGaugesIntoDash(btn.getAttribute('data-loadg')); });
  });
  m.querySelectorAll('[data-library]').forEach(function(btn){
    btn.addEventListener('click', function(){ closeHdrMenu(); openLibrary('gauges', { edit: true }); });
  });
}

// ---- Shared library (datalog-library.js + a host provider on DATAVIEWER.library) -------------------
function libraryAvailable(){ return typeof Library !== 'undefined' && !!Library.available && Library.available(); }
// Browse and, on "Use", load the item. A gauge dashboard lands like a PBD vehicle config: read-only
// meta (so nothing is marked dirty and the next Save prompts for the user's OWN name -- pulling never
// overwrites one of their saved sets), finalized unless the caller was authoring (the dash "Load
// gauges" menu, where the loaded set is the starting point for more editing). A histogram is handed
// to the tables' own importer, which merges the math channels it depends on.
function openLibrary(kind, opts){
  if(!libraryAvailable()) return;
  opts = opts || {};
  Library.open({ kind: kind, onUse: function(item){
    if(!item || !item.payload) return;
    var pl = item.payload;
    if(item.kind === 'gauges'){
      var gauges = Array.isArray(pl.gauges) ? pl.gauges : [];
      if(!gauges.length){ if(window.showToast) showToast('That dashboard is empty.'); return; }
      if(!viewerIsPro()) return;
      applyGaugesConfig({ kind: 'gauges', gauges: gauges }, { kind: 'library', id: item.id, name: item.name, readOnly: true },
        { edit: !!opts.edit, dirty: !!opts.edit, toast: 'Loaded "' + item.name + '" from the library.' });
      if(VIEWER_CURRENT_GAUGES){
        VIEWER_CURRENT_GAUGES.libraryId = item.id;
        VIEWER_CURRENT_GAUGES.vehicle = (typeof Library !== 'undefined' && Library.vehicleOf) ? Library.vehicleOf(item) : null;
      }
      return;
    }
    if(item.kind === 'histogram'){
      if(!pl.def){ if(window.showToast) showToast('That histogram is empty.'); return; }
      enterHistograms();
      if(VIEWER_HIST_CTL && typeof VIEWER_HIST_CTL.importPackage === 'function'){
        // Stamp the def with where it came from so "Share to library" can offer to update that entry.
        var def = Object.assign({}, pl.def, { libraryId: item.id, vehicle: (typeof Library !== 'undefined' && Library.vehicleOf) ? Library.vehicleOf(item) : null });
        VIEWER_HIST_CTL.importPackage({ kind: 'datalog-histograms', histograms: [def], mathChannels: Array.isArray(pl.mathChannels) ? pl.mathChannels : [] }, 'library item');
      }
    }
  } });
}
// Share the dash on screen as a whole dashboard: its gauge defs (roles stamped by dashStampRole so
// it binds by meaning on another car; scorecards stripped -- staff-only) + a schematic thumbnail.
function shareDashToLibrary(){
  if(!libraryAvailable()) return;
  var gauges = currentGaugesList().filter(function(g){ return g && g.type !== 'scorecard'; });
  if(!gauges.length){ if(window.showToast) showToast('Add a gauge before sharing.'); return; }
  var cur = VIEWER_CURRENT_GAUGES || {};
  // A dash that came from the library (pulled, or shared earlier this session) remembers its item,
  // so the dialog can offer "Update" instead of a duplicate (Ken, 2026-09-08).
  var libraryId = cur.libraryId || (cur.kind === 'library' ? cur.id : null);
  Library.share({
    kind: 'gauges', name: cur.name || 'My Gauges',
    payload: { kind: 'gauges', gauges: gauges },
    thumbSvg: (typeof gaugesThumbnailSvg === 'function') ? gaugesThumbnailSvg(gauges) : null,
    vehicle: cur.vehicle || null,
    libraryId: libraryId,
    onDone: function(item){
      if(!item || !VIEWER_CURRENT_GAUGES) return;
      VIEWER_CURRENT_GAUGES.libraryId = item.id;
      VIEWER_CURRENT_GAUGES.vehicle = (typeof Library !== 'undefined' && Library.vehicleOf) ? Library.vehicleOf(item) : null;
    }
  });
}

// The Custom Dash lifecycle controls as a small pop-out anchored to the ⋯ button, styled like the
// header dropdowns (reuses hdrItem + VIEWER_HDR_MENU, so the document-click / Escape closers already
// wired for the header menus dismiss this too, and a second click on ⋯ toggles it shut).
function openDashCtrlMenu(anchor){
  var already = VIEWER_HDR_MENU && VIEWER_HDR_MENU.__which === 'dashctrl';
  closeHdrMenu();
  if(already) return;
  var m = document.createElement('div');
  m.className = 'dlv-gmenu dlv-hdr-menu dlv-dash-ctrl-menu';
  m.__which = 'dashctrl';
  m.addEventListener('click', function(e){ e.stopPropagation(); });
  // Raw glyphs (✓ ✎ 🗑) rather than HTML entities: hdrItem runs escapeHtml on the label, so a &#..;
  // would show literally. The file is served UTF-8 and released with Copy-Item, so the bytes survive.
  var del = hdrItem('dashdelete', '🗑 Delete dash', false);
  var share = libraryAvailable() ? hdrItem('dashshare', '⇪ Share to library…', !viewerIsPro()) : '';
  m.innerHTML = VIEWER_DASH_EDIT
    ? hdrItem('dashfinalize', '✓ Finalize dash', false) + share + del
    : hdrItem('dashedit',     '✎ Edit dash',     false) + share + del;
  document.body.appendChild(m);
  var r = anchor.getBoundingClientRect(), pad = 8;
  m.style.top = (r.bottom + 6) + 'px';
  m.style.left = Math.max(pad, Math.min(r.right - m.offsetWidth, window.innerWidth - m.offsetWidth - pad)) + 'px';
  VIEWER_HDR_MENU = m;
  m.querySelectorAll('[data-m]').forEach(function(btn){
    btn.addEventListener('click', function(){
      var act = btn.getAttribute('data-m');
      closeHdrMenu();
      if(act === 'dashfinalize') return dashFinalize();
      if(act === 'dashedit'){ if(viewerIsPro()){ VIEWER_DASH_EDIT = true; renderViewerBody(); } return; }
      if(act === 'dashshare'){ if(viewerIsPro()) shareDashToLibrary(); return; }
      if(act === 'dashdelete') return dashDeleteCurrent();
    });
  });
}

// Finalize fixes the VERTICAL only (Ken): shift the cluster up so it starts at a small top margin,
// removing leading empty space. Horizontal X is left exactly as placed -- no shifting, no centring.
function dashNormalize(){
  if(!VIEWER_DASH || !VIEWER_DASH.gauges.length) return;
  var M = 12, minY = Infinity;
  VIEWER_DASH.gauges.forEach(function(g){ minY = Math.min(minY, g.y); });
  var dy = M - minY;
  if(dy) VIEWER_DASH.gauges.forEach(function(g){ g.y = Math.round(g.y + dy); });
}
// Finalized view only: size the dash to the bounding box of its gauges (+margin) and centre it, so a
// finished dashboard doesn't float in a huge empty box. Gauges were normalised to the top-left at
// finalize, so this is just the far edge.
function dashApplyHug(host, canvas){
  host.style.width = '';
  if(!canvas) return;
  canvas.style.width = '';   // full width, same as edit -- gauges keep their horizontal position (Ken)
  if(!VIEWER_DASH || !VIEWER_DASH.gauges.length){ canvas.style.height = ''; canvas.style.transform = ''; host.style.height = ''; VIEWER_DASH_HUG = 0; return; }
  // VERTICAL hug only: canvas height = the lowest gauge edge + margin. X is untouched.
  var M = 12, maxB = 0, maxR = 0;
  VIEWER_DASH.gauges.forEach(function(g){
    var el = VIEWER_DASH_ELS[g.id];
    var h = el ? el.offsetHeight : (g._h || 100);
    var w = el ? el.offsetWidth : (g._w || 100);
    maxB = Math.max(maxB, g.y + h);
    maxR = Math.max(maxR, g.x + w);
  });
  var hug = maxB + M;
  canvas.style.height = hug + 'px';
  VIEWER_DASH_HUG = hug;         // reference for the zoom splitter
  VIEWER_DASH_HUG_W = maxR + M;  // content width -> caps zoom-in so gauges don't spill past the canvas
  // Zoom (splitter-set): scale the whole cluster and hug the SCALED height, so the divider stays welded
  // to the gauges — no empty gap below, no gauges spilling into the graphs. z=1 is the authored size.
  var z = VIEWER_DASH_ZOOM || 1;
  if(z !== 1){
    canvas.style.transformOrigin = 'top left';
    canvas.style.transform = 'scale(' + z + ')';
    host.style.height = Math.round(hug * z) + 'px';
  } else {
    canvas.style.transform = '';
    host.style.height = '';   // auto = hug the (unscaled) content
  }
}
// Ken's finalize flow: fit the canvas to the gauges, leave edit mode, and persist. A brand-new dash
// prompts for a name; editing an existing saved one updates it in place. Always saves as Custom
// Gauges now (Ken, 2026-09-08) -- Layout and Custom Gauges are independent slots, so there's no more
// "which one was I inside" ambiguity deciding the save kind (that used to mean two people doing
// identical dash work could get a different row type depending on what they'd clicked ten minutes
// earlier).
function dashFinalize(){
  if(VIEWER_DASH_TARGET === 'hist'){
    adlTrack('gauge_designer_used', { action: 'hist_save' });
    finishHistGaugesEdit(true);
    if(window.showToast) showToast(histDashGauges().length ? 'Gauges placed behind the table.' : 'No gauges behind the table.');
    return;
  }
  if(!VIEWER_DASH || !VIEWER_DASH.gauges.length){ if(window.showToast) showToast('Add a gauge before finalizing.'); return; }
  adlTrack('gauge_designer_used', { action: 'save' });
  dashNormalize();
  VIEWER_DASH_EDIT = false;
  rememberLastDash();
  VIEWER_DASH_H = null;      // start finalized hugged (Ken's design); the splitter re-adjusts from there
  VIEWER_DASH_ZOOM = null;   // and at authored gauge size (zoom 1)
  renderViewerBody();
  saveConfigPrompt('gauges');
}
// Delete this dashboard: a saved one goes through the normal Custom Gauges delete (confirm + drop back
// to Default gauges/Graph); an unsaved in-memory one is just discarded, never touching the Layout.
function dashDeleteCurrent(){
  if(VIEWER_DASH_TARGET === 'hist'){
    if(!window.confirm('Remove the gauges behind the Histograms tab?')) return;
    VIEWER_DASH = { gauges: [] };
    finishHistGaugesEdit(true);
    return;
  }
  var cur = VIEWER_CURRENT_GAUGES || {};
  if(cur.kind === 'saved'){ deleteCurrentGauges(); return; }
  if(!window.confirm('Discard this dashboard?')) return;
  clearCurrentGauges();
}

// The dash's splitter behaves DIFFERENTLY per mode. EDIT: it resizes the working-canvas height (you want
// a bigger area to place gauges in). FINALIZED/using: it SCALES the gauges (like the fascia gauge view's
// splitter) so the cluster stays welded to the divider — dragging never leaves a gap below the gauges or
// lets the graphs ride up over them (Ken). wireSplitter() bails in dash mode (needs dlvGaugeView), so the
// dash gets its own. Double-click resets.
function wireDashSplitter(){
  var sp = document.getElementById('dlvSplitter');
  var dv = document.getElementById('dlvDashView');
  if(!sp || !dv) return;
  var canvas = document.getElementById('dlvDashCanvas');
  sp.addEventListener('pointerdown', function(e){
    if(e.button !== 0) return;
    e.preventDefault();
    sp.classList.add('dragging');
    try { sp.setPointerCapture(e.pointerId); } catch(err){}
    var startY = e.clientY;
    var main = document.querySelector('.dlv-main');
    var mainH = main ? main.getBoundingClientRect().height : window.innerHeight;
    var move;
    if(VIEWER_DASH_EDIT){
      // Working area: taller/shorter canvas to build in.
      var startH = dv.getBoundingClientRect().height;
      move = function(ev){
        var h = Math.max(150, Math.min(startH + (ev.clientY - startY), mainH - 130));
        VIEWER_DASH_H = Math.round(h);
        dv.style.height = VIEWER_DASH_H + 'px';
        resizeViewerCharts();
      };
    } else {
      // Zoom the gauges. Drag DOWN enlarges them (graph shrinks); drag UP shrinks them (graph grows).
      // The whole cluster scales, so the dash always hugs its scaled content -- no gap, no overlap.
      // 1 drag-pixel == 1 unscaled hug-pixel, so it tracks the pointer. Zoom-IN is capped so the enlarged
      // gauges never spill past the canvas WIDTH and always leave the graphs a floor of room.
      var Hc = VIEWER_DASH_HUG || (dv.getBoundingClientRect().height / (VIEWER_DASH_ZOOM || 1)) || 1;
      var Wc = VIEWER_DASH_HUG_W || (canvas ? canvas.clientWidth : 0) || 1;
      var cw = canvas ? canvas.clientWidth : Wc;
      var widthCap = cw / Wc;                         // gauges just reach the canvas width
      var heightCap = (mainH - 130) / Hc;             // keep >=130px for the graphs
      var zMax = Math.max(1, Math.min(widthCap, heightCap, 3));   // always allow returning to authored size (1)
      var startZoom = VIEWER_DASH_ZOOM || 1;
      move = function(ev){
        var z = Math.max(0.35, Math.min(zMax, startZoom + (ev.clientY - startY) / Hc));
        VIEWER_DASH_ZOOM = z;
        if(canvas){ canvas.style.transformOrigin = 'top left'; canvas.style.transform = z !== 1 ? 'scale(' + z + ')' : ''; }
        dv.style.height = z !== 1 ? Math.round(Hc * z) + 'px' : '';
        resizeViewerCharts();
      };
    }
    function up(ev){
      sp.classList.remove('dragging');
      try { sp.releasePointerCapture(ev.pointerId); } catch(err){}
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      resizeViewerCharts();
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  sp.addEventListener('dblclick', function(){
    if(VIEWER_DASH_EDIT){ VIEWER_DASH_H = null; dv.style.height = ''; }
    else { VIEWER_DASH_ZOOM = null; if(canvas){ canvas.style.transform = ''; } dv.style.height = ''; }
    resizeViewerCharts();
  });
}

function dashDropEmptyHint(canvas){
  var hint = canvas.querySelector('.dlv-dash-empty');
  if(hint && VIEWER_DASH && VIEWER_DASH.gauges.length) hint.remove();
}
// ---- Scorecard integration -------------------------------------------------------------------
// Scorecards evaluate over a RANGE of the log (not per-cursor). We build the shared data context
// once and let the Scorecard module (datalog-scorecard.js) run its evaluator pipeline + render.
function dashScorecardRange(def, time){
  var n = time.length;
  var full = { mode: 'entire', startIdx: 0, endIdx: Math.max(0, n - 1), startTime: n ? time[0] : 0, endTime: n ? time[n - 1] : 0 };
  full.mode = (def && def.range && def.range.mode) || 'entire';
  if(full.mode === 'entire') return full;
  // 'visible' = the zoom window. 'selection' is an alias of it for now: there is no separate
  // selection concept in the viewer yet, and a mode that silently scored the whole log while its
  // radio said otherwise was worse than sharing the window. 'auto' = the window when zoomed in,
  // the whole log otherwise (the operating-region detectors it was scaffolded for are not wired).
  var vis = getVisibleRange();
  if(!vis || (full.mode === 'auto' && vis.isFull)) return full;
  full.startIdx = vis.startIdx; full.endIdx = vis.endIdx;
  full.startTime = vis.t0; full.endTime = vis.t1;
  return full;
}
function dashScorecardContext(def){
  var time = (VIEWER_DATA && VIEWER_DATA.time) ? VIEWER_DATA.time : [];
  return {
    data: VIEWER_DATA, resolvedRoles: VIEWER_RESOLVED_ROLES, channelStats: VIEWER_CHANNEL_STATS,
    unitByChannel: (typeof VIEWER_UNIT_BY_CHANNEL === 'object' ? VIEWER_UNIT_BY_CHANNEL : {}),
    vehicle: (typeof getCurrentVehicleMeta === 'function') ? getCurrentVehicleMeta() : null,
    fileName: (typeof VIEWER_FILE_NAME === 'string') ? VIEWER_FILE_NAME : null,
    // what the card's Type / Fuel auto-detection can lean on: the auto-matched preset (v6-gauge = an
    // EcoBoost fascia) and how many per-cylinder knock channels the log carries
    presetId: (VIEWER_ACTIVE_PRESET && VIEWER_ACTIVE_PRESET.id) || null,
    cylinderCount: (typeof detectCylinderCount === 'function') ? detectCylinderCount(VIEWER_RESOLVED_ROLES) : null,
    profile: def && def.profile ? def.profile : null,
    range: dashScorecardRange(def, time)
  };
}
// The scorecard's evidence rows jump the graphs to their moment, and its Type / Fuel pulldowns
// re-evaluate the card -- both go through this host hook (the module itself knows no viewer state).
if(typeof Scorecard !== 'undefined' && typeof Scorecard.setHost === 'function'){
  Scorecard.setHost({
    navigate: {
      setCursor: function(t){ setCursorTime(t); },
      setRange: function(t0, t1){ setVisibleRange(t0, t1); },
      highlightIndices: function(idx){ setHighlightIndices(idx); }
    },
    onDefChanged: function(){ markGaugesDirty(); evaluateDashScorecards(); }
  });
}
function evaluateDashScorecards(){
  if(!VIEWER_DASH || typeof Scorecard === 'undefined' || !Scorecard.runScorecard) return;
  VIEWER_DASH.gauges.forEach(function(g){
    if(g.type !== 'scorecard') return;
    var el = VIEWER_DASH_ELS[g.id]; if(!el || !el._scCard) return;
    if(!VIEWER_DATA){ Scorecard.renderResults(el._scCard, g, { state: 'no_data', results: [], overall: { score: null, status: 'not_evaluated' }, evaluatedCount: 0, totalCount: 0 }); return; }
    try { Scorecard.renderResults(el._scCard, g, Scorecard.runScorecard(g, dashScorecardContext(g))); }
    catch(err){ if(window.console) console.warn('Scorecard render failed', err); }
  });
}
// A scorecard in any non-'entire' range mode follows the zoom window, so it has to re-evaluate when
// the window moves. Guarded hard: nothing runs unless the custom dash is actually showing AND some
// scorecard on it asked for a sub-range -- a plain zoom on a dash of gauges costs nothing extra.
// Trailing-timer coalesced rather than run per notification: a wheel zoom or scrubber drag notifies
// on every tick, and an evaluator pass over a long log is far heavier than a drag frame should be.
var VIEWER_DASH_RANGE_TIMER = null;
onVisibleRangeChange(function(){
  if(!showsCustomDash() || !VIEWER_DASH || !VIEWER_DASH.gauges) return;
  var wants = VIEWER_DASH.gauges.some(function(g){
    return g.type === 'scorecard' && g.range && g.range.mode && g.range.mode !== 'entire';
  });
  if(!wants) return;
  if(VIEWER_DASH_RANGE_TIMER) clearTimeout(VIEWER_DASH_RANGE_TIMER);
  VIEWER_DASH_RANGE_TIMER = setTimeout(function(){ VIEWER_DASH_RANGE_TIMER = null; evaluateDashScorecards(); }, 100);
});
function dashMigrateScorecards(gauges){
  if(typeof Scorecard === 'undefined' || !Scorecard.migrateDef) return;
  (gauges || []).forEach(function(g){ if(g && g.type === 'scorecard') Scorecard.migrateDef(g); });
}
// Custom-dash text: names and tick numerals at roughly three-quarters of the fascia size, readouts
// nearly untouched. The whole dash is zoomed as one block by the splitter, so text drawn at the
// fascia's sizes grew with the bars until it dominated them (Ken, 2026-09-08).
var DASH_TEXT_SCALE = { label: 0.72, tick: 0.75, value: 0.9 };
// A vertical bar narrower than this has no room for a numeral gutter beside its track (see CSS). 32, not 48: at
// 40px the gutter is 20px, which still fits a three-digit numeral at the dash text size (Ken, 2026-09-08:
// APP / TP lost their scale at 48).
var DASH_BAR_NARROW_W = 32;
function dashPlaceGauge(canvas, g){
  // Internal-only: a scorecard is simply not placed for users without permission -- the rest of the
  // dash renders normally, and the scorecard's config stays in VIEWER_DASH.gauges (preserved on save).
  if(g.type === 'scorecard' && !scorecardEnabled()) return;
  var el = createGaugeElement(g, { text: DASH_TEXT_SCALE });
  el.classList.add('dlv-dash-gauge');
  var free = dashIsFreeSize(g.type);
  el.classList.toggle('dash-free', free);
  if(free){
    // Bars fill an explicit box (free-resize); dials/etc. scale by unit (aspect-locked).
    el.style.removeProperty('--dlv-gauge-u');
    el.style.width = (g.w || 90) + 'px';
    el.style.height = g.type === 'table' ? '' : (g.h || 200) + 'px';   // a table hugs its rows
    el.classList.toggle('dlv-bar-narrow', (g.w || 90) < DASH_BAR_NARROW_W);   // no room for scale numerals
  } else {
    el.style.setProperty('--dlv-gauge-u', (g.scale || 1) + 'px');   // sizes the WHOLE gauge, aspect intact
  }
  el.style.left = g.x + 'px'; el.style.top = g.y + 'px';
  canvas.appendChild(el);
  VIEWER_DASH_ELS[g.id] = el;
  g._w = el.offsetWidth; g._h = el.offsetHeight;   // rendered bounds, cached for hit/clamp (not persisted)
  // Right-click to change a gauge's settings works while USING a finalized dash too (Ken), not just
  // in edit mode. Move + resize stay edit-only.
  el.addEventListener('contextmenu', function(e){ e.preventDefault(); e.stopPropagation(); dashAssignMenu(e, g); });
  if(VIEWER_DASH_EDIT){
    dashMakeDraggable(el, g, canvas);
    dashMakeResizable(el, g, canvas);
  }
  dashDropEmptyHint(canvas);
}

// Resize from the bottom-right corner. Bars (free-size) resize WIDTH and HEIGHT independently -- any
// shape (Ken). Everything else drives the gauge's scale (--dlv-gauge-u), which keeps its aspect
// locked automatically (a dial stays square). stopPropagation so grabbing the handle never also
// starts a move.
function dashMakeResizable(el, g, canvas){
  var handle = document.createElement('div');
  handle.className = 'dlv-dash-resize';
  el.appendChild(handle);
  var free = dashIsFreeSize(g.type);
  handle.addEventListener('pointerdown', function(e){
    if(e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    var startX = e.clientX, startY = e.clientY;
    var startScale = g.scale || 1, startW = g._w || el.offsetWidth || 1, startH = g._h || el.offsetHeight || 1;
    try { handle.setPointerCapture(e.pointerId); } catch(_){}
    el.classList.add('resizing');
    function move(ev){
      if(free){
        // Snap the size to the grid too (Ken) -- with a snapped position, a grid-multiple w/h lands the
        // far edges on grid lines, so two bars can be resized to match and align. Alt / toggle as for moves.
        var freeSz = !dashSnapActive(ev.altKey);
        var w = dashSnap(startW + (ev.clientX - startX), freeSz);
        var h = dashSnap(startH + (ev.clientY - startY), freeSz);
        g.w = Math.max(40, Math.min(w, canvas.clientWidth - g.x));
        g.h = Math.max(30, Math.min(h, canvas.clientHeight - g.y));
        el.style.width = g.w + 'px'; el.style.height = g.type === 'table' ? '' : g.h + 'px';
        el.classList.toggle('dlv-bar-narrow', g.w < DASH_BAR_NARROW_W);
        g._w = g.w; g._h = g.h;
      } else {
        var nw = Math.max(56, startW + (ev.clientX - startX));
        g.scale = Math.max(0.5, Math.min(4, startScale * (nw / startW)));
        el.style.setProperty('--dlv-gauge-u', g.scale + 'px');
        g._w = el.offsetWidth; g._h = el.offsetHeight;
        if(g.x + g._w > canvas.clientWidth){ g.x = Math.max(0, canvas.clientWidth - g._w); el.style.left = g.x + 'px'; }
        if(g.y + g._h > canvas.clientHeight){ g.y = Math.max(0, canvas.clientHeight - g._h); el.style.top = g.y + 'px'; }
      }
    }
    function up(){
      try { handle.releasePointerCapture(e.pointerId); } catch(_){}
      el.classList.remove('resizing');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
    }
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
}

// Drag the whole gauge palette around the screen by its header. position:fixed, so it can go
// anywhere (over the canvas or the channel list). Position is remembered for the session.
function wireDashPaletteDrag(palette){
  var handle = palette.querySelector('.dlv-dash-palette-drag');
  if(!handle) return;
  handle.addEventListener('pointerdown', function(e){
    if(e.button !== 0) return;
    e.preventDefault();
    try { handle.setPointerCapture(e.pointerId); } catch(err){}
    var rect = palette.getBoundingClientRect();
    var offX = e.clientX - rect.left, offY = e.clientY - rect.top;
    function move(ev){
      var x = Math.max(4, Math.min(ev.clientX - offX, window.innerWidth - palette.offsetWidth - 4));
      var y = Math.max(4, Math.min(ev.clientY - offY, window.innerHeight - palette.offsetHeight - 4));
      VIEWER_DASH_PALETTE_POS = { x: Math.round(x), y: Math.round(y) };
      palette.style.left = x + 'px'; palette.style.top = y + 'px';
    }
    function up(ev){ try { handle.releasePointerCapture(ev.pointerId); } catch(err){}
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}
function wireDashPalette(canvas){
  document.querySelectorAll('#dlvDashPalette .dlv-dash-chip').forEach(function(chip){
    chip.addEventListener('dragstart', function(e){ e.dataTransfer.setData('text/x-dash-type', chip.getAttribute('data-dash-type')); e.dataTransfer.effectAllowed = 'copy'; });
  });
  canvas.addEventListener('dragover', function(e){ e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; canvas.classList.add('drop-hot'); });
  canvas.addEventListener('dragleave', function(e){ if(e.target === canvas) canvas.classList.remove('drop-hot'); });
  canvas.addEventListener('drop', function(e){
    e.preventDefault(); canvas.classList.remove('drop-hot');
    var type = e.dataTransfer.getData('text/x-dash-type'); if(!type) return;
    var r = canvas.getBoundingClientRect();
    var g = dashMakeGauge(type, 0, 0);
    if(!g) return;   // gated component (e.g. scorecard without permission) -- nothing to add
    VIEWER_DASH.gauges.push(g);
    dashPlaceGauge(canvas, g);   // renders + measures g._w / g._h at this gauge's scale
    var x = dashSnap(e.clientX - r.left - g._w / 2, !dashSnapActive(e.altKey));
    var y = dashSnap(e.clientY - r.top - g._h / 2, !dashSnapActive(e.altKey));
    g.x = Math.max(0, Math.min(x, canvas.clientWidth - g._w));
    g.y = Math.max(0, Math.min(y, canvas.clientHeight - g._h));
    var el = VIEWER_DASH_ELS[g.id];
    if(el){ el.style.left = g.x + 'px'; el.style.top = g.y + 'px'; }
    if(VIEWER_DATA) updateDashGauges(VIEWER_DATA.time.length - 1);
  });
}

// Drag a placed gauge to move it (snapped; Alt for free). Left button only; the resize handle added
// in the next phase will stopPropagation so it doesn't also start a move.
function dashMakeDraggable(el, g, canvas){
  el.addEventListener('pointerdown', function(e){
    if(e.button !== 0) return;
    e.preventDefault();
    var startX = e.clientX, startY = e.clientY, ox = g.x, oy = g.y;
    el.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
    function move(ev){
      var nx = dashSnap(ox + (ev.clientX - startX), !dashSnapActive(ev.altKey));
      var ny = dashSnap(oy + (ev.clientY - startY), !dashSnapActive(ev.altKey));
      nx = Math.max(0, Math.min(nx, canvas.clientWidth - g._w));
      ny = Math.max(0, Math.min(ny, canvas.clientHeight - g._h));
      g.x = nx; g.y = ny;
      el.style.left = nx + 'px'; el.style.top = ny + 'px';
    }
    function up(){
      try { el.releasePointerCapture(e.pointerId); } catch(_){}
      el.classList.remove('dragging');
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    }
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  });
}

function closeDashMenu(){ if(VIEWER_DASH_MENU){ VIEWER_DASH_MENU.remove(); VIEWER_DASH_MENU = null; } }
document.addEventListener('click', closeDashMenu);
document.addEventListener('keydown', function(e){ if(e.key === 'Escape') closeDashMenu(); });

function dashAssignMenu(e, g){
  closeDashMenu();
  // Scorecard has a rich config UI (categories/evaluators/overall/range) rather than the gauge
  // channel/range/warning menu -- open its own modal (datalog-scorecard.js).
  if(g.type === 'scorecard'){
    if(typeof Scorecard !== 'undefined' && Scorecard.openConfig){
      Scorecard.openConfig(g, function(){ evaluateDashScorecards(); });
    }
    return;
  }
  var chans = (VIEWER_DATA && VIEWER_DATA.channels) ? VIEWER_DATA.channels : [];
  var isLight = g.type === 'light', isTable = g.type === 'table';
  // Warnings (Yellow/Red at) on every gauge: dials & bars draw the band + recolour, a light IS its
  // threshold state, and a plain Number gauge -- which has no band -- recolours its digits and tints
  // its tile when tripped (see updateGaugeElement). So every type gets the warnings editor (Ken,
  // 2026-07-24: "warnings settings for number gauges").
  var canWarn = !isTable;   // a table has no single value to threshold
  var m = document.createElement('div');
  m.className = 'dlv-gmenu dlv-dash-assign';
  m.addEventListener('click', function(ev){ ev.stopPropagation(); });
  // Two columns (Ken: the single stack was too tall). LEFT = the tall channel picker, untouched.
  // RIGHT = everything else (settings / warnings / colour / park / delete) stacked beside it.
  var chanCol = isTable ? dashTableRowsHtml(g, chans) :
    '<div class="dlv-dash-assign-chan">' +
      // On a combo the left list assigns the MAIN (RPM) dial; the inset has its own picker on the right.
      '<h4>' + (g.type === 'combo' ? 'Main dial (RPM)' : 'Assign channel') + '</h4>' +
      '<input type="text" class="dlv-dash-search" placeholder="Filter channels…">' +
      '<div class="dlv-dash-chanlist">' +
        chans.map(function(c){ return '<button type="button" class="act clear dlv-dash-chan' + (g.channelOverride === c ? ' on' : '') + '" data-ch="' + escapeHtml(c) + '">' + escapeHtml(c) + '</button>'; }).join('') +
      '</div>' +
    '</div>';
  var setCol =
    '<div class="dlv-dash-assign-set">' +
      '<h4>Gauge settings</h4>' +
      // Label, scale range (min/max), value precision, unit -- Min/Max hidden for a light (it fires off
      // its trigger values, not a range).
      '<div class="dlv-dash-thr dlv-dash-set">' +
        '<label>' + (isTable ? 'Header' : 'Label') + ' <input type="text" class="dlv-dash-set-in" data-set="label" value="' + escapeHtml(g.label != null ? String(g.label) : '') + '"' + (isTable ? ' placeholder="optional"' : '') + '></label>' +
        (isLight || isTable ? '' :
          '<label>Min <input type="number" step="any" class="dlv-dash-thr-in" data-set="min" value="' + (g.min != null ? g.min : '') + '"></label>' +
          '<label>Max <input type="number" step="any" class="dlv-dash-thr-in" data-set="max" value="' + (g.max != null ? g.max : '') + '"></label>') +
        '<label>Decimals <input type="number" min="0" max="3" step="1" class="dlv-dash-thr-in" data-set="decimals" value="' + (g.decimals != null ? g.decimals : (isTable ? '' : 0)) + '"' + (isTable ? ' placeholder="auto"' : '') + '></label>' +
        (isTable ? '' : '<label>Unit <input type="text" class="dlv-dash-set-in" data-set="unit" value="' + escapeHtml(g.unit != null ? String(g.unit) : '') + '"></label>') +
        // Font size on every gauge (Ken, 2026-09-09: "make the font / table size adjustable").
        '<label>Font &times; <input type="number" min="0.5" max="3" step="0.1" class="dlv-dash-thr-in" data-set="fontScale" value="' + (g.fontScale != null ? g.fontScale : 1) + '"></label>' +
      '</div>' +
      // Warnings (yellow band + redline) on every gauge that renders zones -- a plain dial or bar can
      // carry a redline too, not just the tach/light that seed one by default.
      (canWarn ?
        '<div class="dlv-menu-sep"></div>' +
        '<div class="dlv-dash-thr">' +
          '<div class="dlv-dash-thr-h">' + (isLight ? 'Light triggers' : 'Warnings') + '</div>' +
          '<label><b class="thr-y">Yellow</b> at <input type="number" step="any" class="dlv-dash-thr-in" data-thr="warn" value="' + (g.thresholds && g.thresholds.warn != null ? g.thresholds.warn : '') + '"></label>' +
          '<label><b class="thr-r">Red</b> at <input type="number" step="any" class="dlv-dash-thr-in" data-thr="red" value="' + (g.thresholds && g.thresholds.red != null ? g.thresholds.red : '') + '"></label>' +
        '</div>' : '') +
      // Combo only: the INSET (speed) dial -- its own channel, label and range. The left channel list
      // still assigns the PRIMARY (RPM) dial; this picks the second one.
      (g.type === 'combo' ?
        '<div class="dlv-menu-sep"></div>' +
        '<div class="dlv-dash-thr dlv-dash-set">' +
          '<div class="dlv-dash-thr-h">Inset dial (speed)</div>' +
          '<label>Channel <select class="dlv-dash-sub-ch">' +
            '<option value="">&mdash; none &mdash;</option>' +
            chans.map(function(c){ return '<option value="' + escapeHtml(c) + '"' + ((g.sub && g.sub.channelOverride === c) ? ' selected' : '') + '>' + escapeHtml(c) + '</option>'; }).join('') +
          '</select></label>' +
          '<label>Label <input type="text" class="dlv-dash-set-in" data-sub="label" value="' + escapeHtml(g.sub && g.sub.label != null ? String(g.sub.label) : '') + '"></label>' +
          '<label>Min <input type="number" step="any" class="dlv-dash-thr-in" data-sub="min" value="' + (g.sub && g.sub.min != null ? g.sub.min : '') + '"></label>' +
          '<label>Max <input type="number" step="any" class="dlv-dash-thr-in" data-sub="max" value="' + (g.sub && g.sub.max != null ? g.sub.max : '') + '"></label>' +
        '</div>' : '') +
      // Colour: per-gauge, or apply to every gauge + set the default for new ones. (A light's colour is
      // its threshold state, so it has no picker.)
      (g.type !== 'light' ?
        '<div class="dlv-menu-sep"></div>' +
        '<div class="dlv-dash-color">' +
          '<label>Colour <input type="color" class="dlv-dash-color-in" value="' + (g.color || VIEWER_DASH_COLOR) + '"></label>' +
          '<button type="button" class="act clear dlv-dash-color-all" data-color-all="1">Apply to all</button>' +
        '</div>' : '') +
      // Bar fill park point (bars only): Auto / End / Center.
      (dashIsFreeSize(g.type) ?
        '<div class="dlv-menu-sep"></div>' +
        '<div class="dlv-dash-thr-h" style="margin-bottom:4px">Bar fills from</div>' +
        '<div class="dlv-dash-parked">' +
          ['auto', 'end', 'center'].map(function(p){ return '<button type="button" class="dlv-dash-park-btn' + ((g.parked || 'auto') === p ? ' on' : '') + '" data-park="' + p + '">' + (p === 'auto' ? 'Auto' : p === 'end' ? 'End' : 'Center') + '</button>'; }).join('') +
        '</div>' : '') +
      '<div class="dlv-menu-sep"></div>' +
      // Copy / Duplicate: the fastest way to build a cluster of similar gauges (Ken, 2026-09-08).
      '<div class="dlv-dash-copyrow">' +
        '<button type="button" class="act clear" data-dash-dup="1" title="Add an identical gauge next to this one">&#10697; Duplicate</button>' +
        '<button type="button" class="act clear" data-dash-copy="1" title="Copy this gauge; paste with Ctrl+V or the palette\'s Paste">&#10064; Copy gauge</button>' +
      '</div>' +
      '<button type="button" class="act clear dlv-dash-del" data-dash-del="1">&#128465; Delete gauge</button>' +
    '</div>';
  m.innerHTML = '<div class="dlv-dash-assign-cols">' + chanCol + setCol + '</div>';
  document.body.appendChild(m);
  var pad = 8;
  m.style.left = Math.max(pad, Math.min(e.clientX, window.innerWidth - m.offsetWidth - pad)) + 'px';
  m.style.top = Math.max(pad, Math.min(e.clientY, window.innerHeight - m.offsetHeight - pad)) + 'px';
  VIEWER_DASH_MENU = m;
  var search = m.querySelector('.dlv-dash-search');
  if(search){
    search.focus();
    search.addEventListener('input', function(){
      var q = search.value.toLowerCase();
      m.querySelectorAll('.dlv-dash-chan').forEach(function(b){ b.style.display = b.getAttribute('data-ch').toLowerCase().indexOf(q) >= 0 ? '' : 'none'; });
    });
  }
  m.querySelectorAll('.dlv-dash-chan').forEach(function(b){
    b.addEventListener('click', function(){ dashAssign(g, b.getAttribute('data-ch')); closeDashMenu(); });
  });
  // Threshold edits keep the menu open (you usually set both); the gauge redraws live.
  m.querySelectorAll('.dlv-dash-thr-in[data-thr]').forEach(function(inp){
    inp.addEventListener('change', function(){
      var v = parseFloat(inp.value);
      if(!g.thresholds) g.thresholds = {};
      g.thresholds[inp.getAttribute('data-thr')] = isFinite(v) ? v : null;
      dashRebuildGauge(g);
    });
  });
  // Gauge settings (label / min / max / decimals / unit). Numeric fields commit on change and are
  // validated; the label renames live as you type. Min<Max is enforced by reverting a bad entry.
  m.querySelectorAll('[data-set]').forEach(function(inp){
    var key = inp.getAttribute('data-set');
    inp.addEventListener(key === 'label' ? 'input' : 'change', function(){
      if(key === 'label'){ g.label = inp.value; }
      else if(key === 'unit'){ g.unit = inp.value; }
      else if(key === 'decimals'){
        var d = parseInt(inp.value, 10);
        if(!isFinite(d)){ if(g.type === 'table'){ g.decimals = null; inp.value = ''; dashRebuildGauge(g); return; } d = 0; }
        d = Math.max(0, Math.min(3, d));
        g.decimals = d; inp.value = d;
      } else if(key === 'fontScale'){
        var f = parseFloat(inp.value);
        if(!isFinite(f)) f = 1;
        f = Math.max(0.5, Math.min(3, Math.round(f * 10) / 10));
        g.fontScale = f; inp.value = f;
      } else {   // min / max
        var v = parseFloat(inp.value);
        if(!isFinite(v)){ inp.value = g[key]; return; }
        if(key === 'min' && v >= g.max){ inp.value = g.min; return; }
        if(key === 'max' && v <= g.min){ inp.value = g.max; return; }
        g[key] = v;
      }
      dashRebuildGauge(g);
    });
  });
  // Combo inset (speed) dial: channel select re-seeds its range/label (then refresh the fields);
  // label/min/max edit g.sub with the same Min<Max validation as the main settings.
  var subCh = m.querySelector('.dlv-dash-sub-ch');
  if(subCh) subCh.addEventListener('change', function(){
    dashSeedComboSub(g, subCh.value || null);
    dashStampRole(g.sub, subCh.value || null);
    var lbl = m.querySelector('[data-sub="label"]'); if(lbl) lbl.value = g.sub.label || '';
    var mn = m.querySelector('[data-sub="min"]'); if(mn) mn.value = g.sub.min;
    var mx = m.querySelector('[data-sub="max"]'); if(mx) mx.value = g.sub.max;
    dashRebuildGauge(g);
  });
  m.querySelectorAll('[data-sub]').forEach(function(inp){
    var key = inp.getAttribute('data-sub');
    inp.addEventListener(key === 'label' ? 'input' : 'change', function(){
      if(!g.sub) g.sub = {};
      if(key === 'label'){ g.sub.label = inp.value; }
      else {
        var v = parseFloat(inp.value);
        if(!isFinite(v)){ inp.value = g.sub[key]; return; }
        if(key === 'min' && v >= g.sub.max){ inp.value = g.sub.min; return; }
        if(key === 'max' && v <= g.sub.min){ inp.value = g.sub.max; return; }
        g.sub[key] = v;
      }
      dashRebuildGauge(g);
    });
  });
  var colorIn = m.querySelector('.dlv-dash-color-in');
  if(colorIn) colorIn.addEventListener('input', function(){ g.color = colorIn.value; dashRebuildGauge(g); });
  var colorAll = m.querySelector('.dlv-dash-color-all');
  if(colorAll) colorAll.addEventListener('click', function(){
    var c = colorIn ? colorIn.value : g.color;
    VIEWER_DASH_COLOR = c;   // becomes the default for new gauges too
    VIEWER_DASH.gauges.forEach(function(x){ if(x.type !== 'light') x.color = c; });
    dashRebuildAll();
  });
  m.querySelectorAll('.dlv-dash-park-btn').forEach(function(b){
    b.addEventListener('click', function(){
      g.parked = b.getAttribute('data-park');
      dashApplyParked(g);
      m.querySelectorAll('.dlv-dash-park-btn').forEach(function(x){ x.classList.toggle('on', x === b); });
      dashRebuildGauge(g);
    });
  });
  if(isTable) wireTableRowsEditor(m, g);
  m.querySelector('[data-dash-del]').addEventListener('click', function(){ dashDelete(g); closeDashMenu(); });
  var dupBtn = m.querySelector('[data-dash-dup]');
  if(dupBtn) dupBtn.addEventListener('click', function(){ dashDuplicate(g); closeDashMenu(); });
  var copyBtn = m.querySelector('[data-dash-copy]');
  if(copyBtn) copyBtn.addEventListener('click', function(){ dashCopy(g); closeDashMenu(); });
}

// ---- Table gauge: rows editor (the left column of its right-click menu) -------------------------
// Each row picks a channel (text/state channels listed first) and a label; rows reorder and delete;
// "Value labels" edits the code -> text map for one of the table's channels (kept per channel name,
// shared by every readout of that channel).
function dashTableRowsHtml(g, chans){
  var rows = Array.isArray(g.rows) ? g.rows : (g.rows = []);
  var texts = chans.filter(function(c){ return isTextChannel(c); }), nums = chans.filter(function(c){ return !isTextChannel(c); });
  var one = function(sel){ return function(c){ return '<option value="' + escapeHtml(c) + '"' + (c === sel ? ' selected' : '') + '>' + escapeHtml(c) + '</option>'; }; };
  var opts = function(sel){
    return '<option value="">&mdash; channel &mdash;</option>' +
      (texts.length ? '<optgroup label="Text / state">' + texts.map(one(sel)).join('') + '</optgroup>' : '') +
      '<optgroup label="Numeric">' + nums.map(one(sel)).join('') + '</optgroup>';
  };
  var chList = [];
  rows.forEach(function(r){ if(r.channelOverride && chList.indexOf(r.channelOverride) < 0) chList.push(r.channelOverride); });
  var vlCh = chList.filter(function(c){ return !isTextChannel(c); })[0] || chList[0] || '';
  return '<div class="dlv-dash-assign-chan dlv-dash-rows">' +
    '<h4>Rows</h4>' +
    '<div class="dlv-dash-rowlist">' + rows.map(function(r, i){
      return '<div class="dlv-dash-rowedit" data-row="' + i + '">' +
        '<select class="dlv-dash-row-ch" data-row="' + i + '" title="Channel">' + opts(r.channelOverride) + '</select>' +
        '<input type="text" class="dlv-dash-row-label" data-row="' + i + '" placeholder="label" title="Label" value="' + escapeHtml(r.label || '') + '">' +
        '<button type="button" class="dlv-dash-row-btn" data-row-up="' + i + '" title="Move up">&#9650;</button>' +
        '<button type="button" class="dlv-dash-row-btn" data-row-down="' + i + '" title="Move down">&#9660;</button>' +
        '<button type="button" class="dlv-dash-row-btn x" data-row-del="' + i + '" title="Remove row">&times;</button>' +
      '</div>';
    }).join('') + (rows.length ? '' : '<div class="dlv-gmenu-hint">No rows yet.</div>') + '</div>' +
    '<button type="button" class="act clear dlv-dash-row-add" data-row-add="1">+ Add row</button>' +
    '<div class="dlv-menu-sep"></div>' +
    '<div class="dlv-dash-thr-h">Value labels</div>' +
    '<div class="dlv-gmenu-hint">Number &rarr; text, one per line (SCT logs state fields as codes): <span class="mono">0 = Base / MBT</span></div>' +
    '<select class="dlv-dash-vl-ch" title="Which channel the labels are for">' + (chList.length ? chList.map(function(c){ return '<option value="' + escapeHtml(c) + '"' + (c === vlCh ? ' selected' : '') + '>' + escapeHtml(c) + (isTextChannel(c) ? ' (already text)' : '') + '</option>'; }).join('') : '<option value="">&mdash; add a row first &mdash;</option>') + '</select>' +
    '<textarea class="dlv-dash-vl" rows="4" spellcheck="false" placeholder="0 = Base / MBT&#10;1 = Torque Control&#10;2 = Borderline">' + escapeHtml(vlCh ? formatValueLabels(userValueLabels()[vlCh] || null) : '') + '</textarea>' +
    '</div>';
}
function wireTableRowsEditor(m, g){
  var rows = Array.isArray(g.rows) ? g.rows : (g.rows = []);
  var rerender = function(){ dashRebuildGauge(g); };
  // Structural changes (add / remove / reorder) re-open the menu in place so the row list matches.
  var reopen = function(){ var rc = m.getBoundingClientRect(); closeDashMenu(); dashAssignMenu({ clientX: rc.left, clientY: rc.top }, g); };
  m.querySelectorAll('.dlv-dash-row-ch').forEach(function(sel){
    sel.addEventListener('change', function(){
      var r = rows[parseInt(sel.getAttribute('data-row'), 10)];
      if(!r) return;
      var ch = sel.value || null;
      r.channelOverride = ch; dashStampRole(r, ch);
      if(ch){
        r.label = (typeof shortChannelName === 'function') ? shortChannelName(ch) : ch;
        var lab = m.querySelector('.dlv-dash-row-label[data-row="' + sel.getAttribute('data-row') + '"]');
        if(lab) lab.value = r.label;
      }
      rerender();
    });
  });
  m.querySelectorAll('.dlv-dash-row-label').forEach(function(inp){
    inp.addEventListener('input', function(){ var r = rows[parseInt(inp.getAttribute('data-row'), 10)]; if(!r) return; r.label = inp.value; rerender(); });
  });
  m.querySelectorAll('[data-row-del]').forEach(function(b){ b.addEventListener('click', function(){ rows.splice(parseInt(b.getAttribute('data-row-del'), 10), 1); rerender(); reopen(); }); });
  m.querySelectorAll('[data-row-up]').forEach(function(b){ b.addEventListener('click', function(){ var i = parseInt(b.getAttribute('data-row-up'), 10); if(i > 0){ var t = rows[i - 1]; rows[i - 1] = rows[i]; rows[i] = t; rerender(); reopen(); } }); });
  m.querySelectorAll('[data-row-down]').forEach(function(b){ b.addEventListener('click', function(){ var i = parseInt(b.getAttribute('data-row-down'), 10); if(i < rows.length - 1){ var t = rows[i + 1]; rows[i + 1] = rows[i]; rows[i] = t; rerender(); reopen(); } }); });
  var add = m.querySelector('[data-row-add]');
  if(add) add.addEventListener('click', function(){
    var used = {}; rows.forEach(function(r){ if(r.channelOverride) used[r.channelOverride] = 1; });
    var pick = dashTextChannels().filter(function(c){ return !used[c]; })[0] || dashNumericChannels().filter(function(c){ return !used[c]; })[0] || null;
    rows.push(dashMakeTableRow(pick)); rerender(); reopen();
  });
  var vlCh = m.querySelector('.dlv-dash-vl-ch'), vlTa = m.querySelector('.dlv-dash-vl');
  if(vlCh && vlTa){
    vlCh.addEventListener('change', function(){ vlTa.value = formatValueLabels(userValueLabels()[vlCh.value] || null); });
    vlTa.addEventListener('change', function(){
      var ch = vlCh.value;
      if(!ch) return;
      var map = parseValueLabels(vlTa.value);
      setUserValueLabels(ch, map);
      if(VIEWER_DATA){ updateDashGauges(VIEWER_DATA.time.length - 1); updateAtCursor(VIEWER_CURSOR_TIME); }
      if(window.showToast) showToast(map ? 'Value labels saved for ' + ch : 'Value labels cleared for ' + ch);
    });
  }
}
// Rebuild one gauge element in place (its ticks/labels/zones/redline are baked in at build time).
function dashRebuildGauge(g){
  var canvas = document.getElementById('dlvDashCanvas');
  var old = VIEWER_DASH_ELS[g.id];
  if(old && old.parentNode) old.parentNode.removeChild(old);
  if(canvas) dashPlaceGauge(canvas, g);
  if(VIEWER_DATA) updateDashGauges(VIEWER_DATA.time.length - 1);
}
// Rebuild every gauge (after a universal colour change). Re-hugs when viewing a finalized dash.
function dashRebuildAll(){
  var canvas = document.getElementById('dlvDashCanvas');
  if(!canvas || !VIEWER_DASH) return;
  Object.keys(VIEWER_DASH_ELS).forEach(function(id){ var el = VIEWER_DASH_ELS[id]; if(el && el.parentNode) el.parentNode.removeChild(el); });
  VIEWER_DASH_ELS = {};
  VIEWER_DASH.gauges.forEach(function(g){ dashPlaceGauge(canvas, g); });
  if(!VIEWER_DASH_EDIT) dashApplyHug(document.getElementById('dlvDashView'), canvas);
  if(VIEWER_DATA) updateDashGauges(VIEWER_DATA.time.length - 1);
}
function dashAssign(g, ch){
  // Combo: the left channel list assigns the PRIMARY (RPM) dial; re-seed its tach scale + redline.
  if(g.type === 'combo'){ dashSeedComboMain(g, ch); g.channelOverride = ch; dashStampRole(g, ch); dashRebuildGauge(g); return; }
  g.channelOverride = ch;
  dashStampRole(g, ch);
  g.label = (typeof shortChannelName === 'function') ? shortChannelName(ch) : ch;
  g.unit = (VIEWER_DATA && VIEWER_DATA.units) ? (VIEWER_DATA.units[ch] || '') : '';
  var rng = dashRangeFor(ch);
  g.min = rng.min; g.max = rng.max; g.decimals = (rng.max - rng.min) <= 20 ? 1 : 0;
  // Re-seed thresholds proportionally to the new channel's range (tach/light).
  if(g.thresholds){ var span = rng.max - rng.min; g.thresholds = { warn: dashRound(rng.min + span * 0.8, span), red: dashRound(rng.min + span * 0.9, span) }; }
  dashApplyParked(g);   // 'end' anchor follows the new min
  dashRebuildGauge(g);
}

function dashDelete(g){
  if(VIEWER_DASH) VIEWER_DASH.gauges = VIEWER_DASH.gauges.filter(function(x){ return x !== g; });
  var el = VIEWER_DASH_ELS[g.id];
  if(el && el.parentNode) el.parentNode.removeChild(el);
  delete VIEWER_DASH_ELS[g.id];
}

// ---- Copy / paste / duplicate gauges (Ken, 2026-09-08: "make things quicker to setup") ------------
// Right-click a gauge -> Copy gauge (or Duplicate). Paste with Ctrl+V while building, or the palette's
// Paste button. The copy goes to the system clipboard as JSON too, so a gauge can be pasted into a
// dash in another window/host; the in-memory copy is the fallback where the clipboard is off-limits.
var VIEWER_DASH_CLIPBOARD = null;
var DASH_CLIP_MARK = 'dlv-gauge/1';
function dashGaugeSnapshot(g){
  var copy = JSON.parse(JSON.stringify(g));
  delete copy.id;
  return copy;
}
function dashCopy(g){
  if(!g) return;
  VIEWER_DASH_CLIPBOARD = dashGaugeSnapshot(g);
  var text = JSON.stringify({ kind: DASH_CLIP_MARK, gauge: VIEWER_DASH_CLIPBOARD });
  try { if(navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(function(){}); } catch(err){}
  if(window.showToast) showToast('Gauge copied — Ctrl+V (or the palette\'s Paste) adds it to the dash');
}
// Accepts a pasted TEXT (from the clipboard event) or falls back to the in-memory copy.
function dashGaugeFromClipboardText(text){
  if(typeof text !== 'string' || !text) return null;
  try {
    var o = JSON.parse(text);
    if(o && o.kind === DASH_CLIP_MARK && o.gauge && typeof o.gauge === 'object') return o.gauge;
  } catch(err){}
  return null;
}
function dashPaste(src, at){
  if(!VIEWER_DASH_EDIT || !VIEWER_DASH) return false;
  src = src || VIEWER_DASH_CLIPBOARD;
  if(!src){ if(window.showToast) showToast('Nothing to paste — right-click a gauge and choose Copy gauge first'); return false; }
  if(src.type === 'scorecard' && !scorecardEnabled()) return false;
  var canvas = document.getElementById('dlvDashCanvas');
  if(!canvas) return false;
  var g = JSON.parse(JSON.stringify(src));
  g.id = dashNextId();
  var free = dashIsFreeSize(g.type);
  if(at){ g.x = dashSnap(at.x, free); g.y = dashSnap(at.y, free); }
  else { g.x = dashSnap((g.x || 0) + DASH_GRID * 2, free); g.y = dashSnap((g.y || 0) + DASH_GRID * 2, free); }
  // Keep the paste on the canvas when the source sat at the right/bottom edge.
  var cw = canvas.clientWidth || 0, chh = canvas.clientHeight || 0;
  if(cw && g.x > cw - 40) g.x = Math.max(0, cw - 120);
  if(chh && g.y > chh - 40) g.y = Math.max(0, chh - 80);
  VIEWER_DASH.gauges.push(g);
  dashDropEmptyHint(canvas);
  dashPlaceGauge(canvas, g);
  if(VIEWER_DATA) updateDashGauges(VIEWER_DATA.time.length - 1);
  if(g.type === 'scorecard') evaluateDashScorecards();
  markGaugesDirty();
  return true;
}
function dashDuplicate(g){
  if(!g) return;
  dashPaste(dashGaugeSnapshot(g), null);
}
// Ctrl+V while building: prefer the clipboard's text (works across windows), else the in-memory copy.
document.addEventListener('paste', function(e){
  if(!VIEWER_DASH_EDIT) return;
  var t = e.target;
  if(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  var text = e.clipboardData ? e.clipboardData.getData('text') : '';
  var src = dashGaugeFromClipboardText(text) || VIEWER_DASH_CLIPBOARD;
  if(!src) return;
  e.preventDefault();
  dashPaste(src, null);
});

function updateDashGauges(idx, dataX){
  if(!VIEWER_DASH) return;
  VIEWER_DASH.gauges.forEach(function(g){
    var el = VIEWER_DASH_ELS[g.id];
    if(!el) return;
    if(g.type === 'scorecard') return;   // evaluated over a range, not updated per-cursor (see evaluateDashScorecards)
    if(g.type === 'table'){ updateGaugeElement(el, g, dashTableCells(g, idx, dataX)); return; }
    var ch = gaugeChannelFor(g);
    var val = ch ? valueAtCursor(ch, idx, dataX) : null;
    // Combo gauges carry a second (inset) channel -- resolve + pass its value too.
    var val2;
    if(g.type === 'combo' && g.sub && g.sub.channelOverride){ val2 = valueAtCursor(g.sub.channelOverride, idx, dataX); }
    updateGaugeElement(el, g, val, val2);
  });
}

// ---------------------------------------------------------------------------------------------
function renderGaugeView(){
  var host = document.getElementById('dlvGaugeView');
  if(!host || !VIEWER_ACTIVE_PRESET) return;
  // Fixed V8/V6 fascia (matches the approved 8cyl.png mockup), keyed off each gauge def's `group`.
  // renderGaugeGrid stays as the generic fallback for any preset without fascia groups.
  var builder = (typeof renderGaugeFascia === 'function') ? renderGaugeFascia : renderGaugeGrid;
  var built = builder(VIEWER_ACTIVE_PRESET.gauges);
  host.innerHTML = '';
  host.appendChild(built.container);
  viewerGaugeEls = built.gaugeEls;
  // edit button / right-click editor / drag handles are attached here rather than inside
  // datalog-gauges.js, so that file stays pure rendering with no viewer-state knowledge.
  Object.keys(viewerGaugeEls).forEach(function(id){
    wireGaugeEditing(viewerGaugeEls[id], gaugeDefById(id));
  });
  updateGaugesAtIndex(VIEWER_DATA.time.length - 1);
}
// `dataX` is the exact cursor time; without it the needles step from sample to sample and sit dead
// still between them, which is very visible on a round gauge when zoomed in.
function updateGaugesAtIndex(idx, dataX){
  if(!VIEWER_ACTIVE_PRESET || !VIEWER_ACTIVE_PRESET.gauges) return;
  VIEWER_ACTIVE_PRESET.gauges.forEach(function(def){
    var el = viewerGaugeEls[def.id];
    if(!el) return;
    // honours a manual right-click mapping before the auto-resolved role
    var ch = gaugeChannelFor(def);
    var val = ch ? valueAtCursor(ch, idx, dataX) : null;
    updateGaugeElement(el, def, val);
  });
}
// Single place the viewer asks "which channel does this gauge read?" -- manual override first,
// then the auto-mapped role. Auto-mapping is only the default (per Ken, 2026-07-21).
function gaugeChannelFor(def){
  if(typeof resolveGaugeChannel === 'function'){
    return resolveGaugeChannel(def, VIEWER_RESOLVED_ROLES, VIEWER_DATA && VIEWER_DATA.channels,
      VIEWER_DATA && VIEWER_DATA.textLevels);
  }
  return VIEWER_RESOLVED_ROLES[def.role] || null;
}

// ---------------------------------------------------------------------------------------------
// Draggable divider between the gauge cluster and the graphs.
//
// The cluster is content-sized by default, which is only a guess at how the space should be split:
// how much room gauges deserve versus graphs depends on the screen, the log and what you're looking
// for. Dragging pins an explicit height (and drops the max-height cap, which would otherwise fight
// it); double-click clears it and returns to auto. The choice rides in the session prefs alongside
// the panel-collapsed state.
// ---------------------------------------------------------------------------------------------
function resizeViewerCharts(){
  Object.keys(viewerCharts).forEach(function(k){ if(viewerCharts[k]) viewerCharts[k].resize(); });
  drawCrosshairOverlays();   // new plot area, new pixel for the same time
}
// The effective gauge unit, read back by measuring a known element. --dlv-gauge-u is an
// unregistered custom property holding a clamp() expression, so getComputedStyle returns the
// expression text rather than a resolved length -- but a bar track is exactly 120 * u tall.
// Reads the CURRENT value of --dlv-gauge-u by measuring a dedicated probe element that is exactly
// 100 units wide. It used to measure the bar track and divide by a hardcoded 120 -- then the bars
// were rescaled to 90 units on 2026-07-22 and this silently began reporting the scale 25% low, so
// the splitter clamped instantly and wouldn't drag at all.
//
// The probe can't drift: it has no purpose except to be measured, so nothing will ever "resize" it
// for design reasons. getComputedStyle on the custom property is NOT usable here -- it returns the
// specified value, which is a clamp() expression, not a resolved length.
function currentGaugeUnit(){
  var p = document.getElementById('dlvUnitProbe');
  if(!p) return 1;
  var w = p.getBoundingClientRect().width;
  return w > 0 ? w / 100 : 1;
}
// Dragging resizes the GAUGES, not the container. Setting a fixed height on the cluster meant that
// dragging it taller just grew an empty box -- the gauges stayed their own size, leaving a gap with
// the splitter stranded at the bottom of it. Driving the scale instead keeps the cluster
// content-sized, so the divider stays welded to the gauges and both sides genuinely scale.
function applyGaugeScale(){
  var ov = document.getElementById('viewerOverlay');
  if(!ov) return;
  if(VIEWER_GAUGE_U) ov.style.setProperty('--dlv-gauge-u', VIEWER_GAUGE_U + 'px');
  else ov.style.removeProperty('--dlv-gauge-u');
}
function wireSplitter(){
  applyGaugeScale();
  var sp = document.getElementById('dlvSplitter');
  var gv = document.getElementById('dlvGaugeView');
  if(!sp || !gv) return;
  sp.addEventListener('pointerdown', function(e){
    if(e.button !== 0) return;
    e.preventDefault();
    sp.classList.add('dragging');
    // capture so the drag can't be lost when the pointer crosses a chart canvas
    try { sp.setPointerCapture(e.pointerId); } catch(err){}
    var startY = e.clientY;
    var startH = gv.getBoundingClientRect().height;
    var startU = currentGaugeUnit();
    var main = document.querySelector('.dlv-main');
    var mainH = main ? main.getBoundingClientRect().height : window.innerHeight;
    if(!(startH > 0) || !(startU > 0)) return;
    // Keep the drag 1:1 with the pointer: growing the cluster by dy means scaling by
    // (startH + dy) / startH. Clamped so gauges stay legible and the graphs keep real estate.
    var minU = 0.6, maxU = startU * Math.max(0.2, (mainH * 0.78) / startH);
    function move(ev){
      var target = startH + (ev.clientY - startY);
      var u = startU * (target / startH);
      VIEWER_GAUGE_U = Math.round(Math.max(minU, Math.min(maxU, u)) * 1000) / 1000;
      applyGaugeScale();
      resizeViewerCharts();
    }
    function up(ev){
      sp.classList.remove('dragging');
      try { sp.releasePointerCapture(ev.pointerId); } catch(err){}
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      saveViewerPrefs();
      resizeViewerCharts();
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  sp.addEventListener('dblclick', function(){
    VIEWER_GAUGE_U = null;
    applyGaugeScale();
    saveViewerPrefs();
    resizeViewerCharts();
    if(window.showToast) showToast('Gauge size reset to automatic.');
  });
}

// ---------------------------------------------------------------------------------------------
// Layouts and Custom Gauges: two independent saveable things, tracked in two independent slots
// (Ken, 2026-09-08: "needs standardized and clear where custom stuff is when you save it --
// difference between a layout and a custom gauge"). They used to share one slot (VIEWER_CURRENT_VIEW)
// with a configKind discriminator, which meant loading one silently forgot the other and the header
// could only ever show the name of whichever was loaded most recently -- see buildConfig/
// applyViewConfig below for the save-side half of this split.
//
// A LAYOUT ("view" on the wire, unchanged for backward compatibility with existing saved rows) is:
// which tab it opens on (Graph/Gauges/Histograms -- but NOT which gauges show there, that's not its
// job any more), graph count, channel->graph assignment, histogram tables, math channels. It still
// carries a `gauges` field on the wire (old rows have one, and PBD's per-vehicle configs use it to
// compose a specific dash into a specific layout in one host-supplied record) but that field is now
// ALWAYS the Custom Dash's own gauges, never mode-dependent, and loading a Layout only ever SEEDS the
// dash with it -- it never touches VIEWER_ACTIVE_PRESET.gauges (the log's own auto-matched fascia)
// and never forces the Custom sub-view open.
//
// CUSTOM GAUGES ("gauges" on the wire, unchanged) is just the dash's gauge definitions. Built-in
// presets are never mutated: editing a gauge while one is active marks the session dirty and Save
// forks it into a new saved item. Saved items live in Supabase (table datalog_views, edge function
// datalog-views) keyed on auth.uid(), so they follow the user rather than dying with the tab the way
// the old sessionStorage-only state did.
// ---------------------------------------------------------------------------------------------
var VIEWER_SAVED_VIEWS = [];        // rows from datalog-views
var VIEWER_CURRENT_LAYOUT = null;   // {kind:'builtin'|'saved', id, name, readOnly?}
var VIEWER_CURRENT_GAUGES = null;   // {kind:'saved', id, name, readOnly?} | null = no saved custom gauges loaded
var VIEWER_LAYOUT_DIRTY = false;
var VIEWER_GAUGES_DIRTY = false;

// The viewer runs on three hosts with different auth: the customer Data Logs page (global
// apiCall), the staff ticket overlay (PBD_AUTH headers), and the offline dev harness (neither).
// Rather than teach this file about any of them, a host can install its own caller; otherwise we
// fall back to apiCall, and if that's missing My Views simply stays empty and the built-ins work.
function callViewsApi(body){
  if(typeof window.PBD_DATALOG_VIEWS_API === 'function') return window.PBD_DATALOG_VIEWS_API(body);
  if(typeof apiCall === 'function') return apiCall('datalog-views', body);
  return localViewsApi(body);   // no cloud backend wired -> save/reload still works, per-browser (localStorage)
}

// Client-only fallback so a Pro user can actually save & reload their dashboards where no cloud backend
// is wired (the dev harness, or a host that hasn't installed PBD_DATALOG_VIEWS_API / apiCall). Stored
// per-browser; when a real backend IS present it wins and this never runs. Cross-device / cross-browser
// sync still needs the cloud API (backend + the on-hold Supabase rebuild, not deployed from here). Same
// request/response shape as the edge function: list -> {views:[{id,name,config}]}, save -> {view:{id,name}}.
var VIEWER_LOCAL_VIEWS_KEY = 'pbd_datalog_views_v1';
function localViewsRead(){
  try { var a = JSON.parse(window.localStorage.getItem(VIEWER_LOCAL_VIEWS_KEY) || '[]'); return Array.isArray(a) ? a : []; }
  catch(e){ return []; }
}
function localViewsWrite(arr){
  try { window.localStorage.setItem(VIEWER_LOCAL_VIEWS_KEY, JSON.stringify(arr)); return true; } catch(e){ return false; }
}
function localViewsApi(body){
  body = body || {};
  var views = localViewsRead();
  if(body.action === 'list') return Promise.resolve({ ok: true, data: { views: views } });
  if(body.action === 'save'){
    var row = body.id != null ? views.filter(function(r){ return String(r.id) === String(body.id); })[0] : null;
    if(row){ row.name = body.name; row.config = body.config; row.updated = Date.now(); }
    else { row = { id: 'loc-' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36), name: body.name, config: body.config, updated: Date.now() }; views.push(row); }
    if(!localViewsWrite(views)) return Promise.resolve({ ok: false, data: { error: 'This browser\'s storage is full or blocked.' } });
    return Promise.resolve({ ok: true, data: { view: { id: row.id, name: row.name } } });
  }
  if(body.action === 'delete'){
    localViewsWrite(views.filter(function(r){ return String(r.id) !== String(body.id); }));
    return Promise.resolve({ ok: true, data: {} });
  }
  return Promise.resolve({ ok: false, data: { error: 'Unknown action.' } });
}

// Strip transient per-session flags so a saved config is pure data.
function sanitizeGaugeDef(g){
  var out = {};
  Object.keys(g).forEach(function(k){ if(k.charAt(0) !== '_') out[k] = g[k]; });
  return out;
}
// The Custom Dash's gauges as pure data (sanitizeGaugeDef drops the transient _w/_h bounds) --
// ALWAYS the dash, never the log's auto-matched fascia (Ken, 2026-09-08). This used to depend on
// which tab was active when you saved: build a dash, switch to Graph or Histograms, then Save --
// your dash silently vanished from the save with no warning, because this returned the FASCIA
// instead. Empty when no dash has been built yet.
function currentGaugesList(){
  return (VIEWER_DASH && VIEWER_DASH.gauges ? VIEWER_DASH.gauges : []).map(sanitizeGaugeDef);
}
// WHICH gauges a Layout was showing, recorded as a choice rather than only a copy (Ken, 2026-09-10:
// "the layout should also save what gauges are being used ... if I go to holley layout, it changes to
// holley gauges with that. if I go to standard layout, it goes to the V8 gauges"). Layouts already
// carried the custom dash's own gauges; what was missing is which sub-view was showing and which
// built-in fascia was on, so loading a layout left the gauges exactly as the last one had them.
function gaugeSelectionForSave(){
  var sel = { submode: VIEWER_GAUGE_SUBMODE === 'custom' ? 'custom' : 'default', preset: null, ref: null };
  if(VIEWER_ACTIVE_PRESET && VIEWER_ACTIVE_PRESET.id){
    sel.preset = { id: VIEWER_ACTIVE_PRESET.id, name: VIEWER_ACTIVE_PRESET.name || '' };
  }
  var cur = VIEWER_CURRENT_GAUGES;
  if(cur && cur.kind) sel.ref = { kind: cur.kind, id: cur.id || null, name: cur.name || '', readOnly: !!cur.readOnly };
  return sel;
}
// Put a built-in fascia back the way picking it from the Gauges menu does. Returns false and changes
// NOTHING for an unknown id, a fascia with no gauges, or one whose gauges resolve to no channel on
// this log -- the log's own auto-matched fascia is left alone rather than replaced by an empty one.
function applyPresetFascia(id){
  if(!id || typeof getPresetById !== 'function') return false;
  var p = getPresetById(id);
  if(!p || !Array.isArray(p.gauges) || !p.gauges.length) return false;
  // Deep copy: per-gauge edits must never write back into the shipped preset, which every log shares.
  var gauges = JSON.parse(JSON.stringify(p.gauges));
  if(typeof applyAltRoles === 'function'){
    try { applyAltRoles(gauges, VIEWER_RESOLVED_ROLES, VIEWER_CHANNEL_STATS, VIEWER_DATA); } catch(e){}
  }
  if(!gauges.some(function(g){ return !!gaugeChannelFor(g); })) return false;
  VIEWER_ACTIVE_PRESET = {
    id: p.id, name: p.name, gauges: gauges,
    defaultGraphs: p.defaultGraphs || { upper: [], middle: [], lower: [] },
    layout: (p.layout === 'v8-gauge' || p.layout === 'v6-gauge') ? 'gauge' : p.layout,
  };
  return true;
}
// The LIVE graph state -- which channels are on which of the 3 panels right now. This is what a saved
// VIEW remembers. (The old code stored the preset's role-based defaultGraphs, so a view never actually
// remembered the user's graph edits -- Ken's fix.) Stored as literal channel names per panel.
function currentGraphsSnapshot(){
  var out = { upper: [], middle: [], middle2: [], lower: [] };
  VIEWER_SELECTED.forEach(function(ch){
    var slot = VIEWER_PANEL_ASSIGN[ch] || GRAPH_SLOT_UPPER;
    (slot === GRAPH_SLOT_MIDDLE ? out.middle : slot === GRAPH_SLOT_MIDDLE2 ? out.middle2
      : slot === GRAPH_SLOT_LOWER ? out.lower : out.upper).push(ch);
  });
  return out;
}
// Restore a saved graph snapshot into the live panel state, skipping channels this log doesn't have.
function applyGraphsSnapshot(graphs){
  VIEWER_SELECTED = []; VIEWER_PANEL_ASSIGN = {};
  var chans = (VIEWER_DATA && VIEWER_DATA.channels) || [];
  [[GRAPH_SLOT_UPPER, graphs.upper], [GRAPH_SLOT_MIDDLE, graphs.middle],
   [GRAPH_SLOT_MIDDLE2, graphs.middle2], [GRAPH_SLOT_LOWER, graphs.lower]].forEach(function(pair){
    (pair[1] || []).forEach(function(ch){
      if(chans.indexOf(ch) === -1) return;
      if(VIEWER_SELECTED.indexOf(ch) === -1) VIEWER_SELECTED.push(ch);
      VIEWER_PANEL_ASSIGN[ch] = pair[0];
    });
  });
}
// Savable configs carry a KIND: 'gauges' (Custom Gauges -- just the dash) and 'view' (a Layout; the
// name stays 'view' ON THE WIRE for backward compatibility with rows saved before this split, even
// though a Layout no longer OWNS the gauges the way it used to -- see currentGaugesList and
// applyViewConfig below for the read side of this).
function buildConfig(kind){
  // A Custom Gauges set remembers the graph channels too (Ken, 2026-09-09): loading it restores the
  // ones the log has, the dash itself is unchanged by that.
  if(kind === 'gauges') return { kind: 'gauges', gauges: currentGaugesList(), graphs: currentGraphsSnapshot(), graphCount: VIEWER_GRAPH_COUNT };
  return {
    kind: 'view',
    layout: VIEWER_VIEW_MODE,
    gaugeSubmode: VIEWER_GAUGE_SUBMODE,
    graphCount: VIEWER_GRAPH_COUNT,   // 1-4 (4 = Graph View only) -- how many graph panels this layout shows
    graphs: currentGraphsSnapshot(),
    // Still carried on the wire (unchanged shape) so a PBD vehicle config can compose a specific
    // layout with specific gauges in one host-supplied record -- but always the DASH's own gauges now,
    // never mode-dependent, and loading a Layout only ever SEEDS the dash with it (see below); it
    // never overwrites the log's own auto-matched fascia and never forces the Custom sub-view open.
    gauges: currentGaugesList(),
    gaugeSet: gaugeSelectionForSave(),    // WHICH gauges were showing: Default fascia (which one) or the Custom dash
    histograms: histogramDefsForSave(),   // the session's tuning tables ride along with the layout
    mathChannels: mathChannelsForSave(),  // the named calculated channels those tables reference
    histGauges: histDashGaugesForSave(),  // the gauges behind the Histograms tab (null when none)
    smoothing: smoothingForSave(),        // per-channel smoothing windows (ms), null when none
  };
}
// Back-compat alias for the single composite save.
function currentViewConfig(){ return buildConfig('view'); }
// Applies a saved/built-in LAYOUT config, or delegates to applyGaugesConfig for a Custom Gauges one.
// A Layout restores which tab it opens on, graph count, channel->graph assignment, histogram tables
// and math channels -- but never which gauges display; VIEWER_ACTIVE_PRESET.gauges (the log's own
// auto-matched fascia) is left completely untouched here (Ken, 2026-09-08 -- it used to be wholesale
// overwritten, so there was no way back to the log's own gauges short of reloading it).
//
// cfg.kind === undefined means this came from selectBuiltinView (or the log-open auto-match) with a
// REAL fascia to apply -- that's the one case where overwriting VIEWER_ACTIVE_PRESET.gauges is right,
// since picking a built-in preset IS how you restore/switch the fascia.
//
// Legacy rows saved before this split need a one-time remap: 'customdash' WAS the dash itself (its
// `gauges` field held the dash's own positioned gauges, back when currentGaugesList was mode-
// dependent), so restoring one faithfully means seeding the dash AND landing on the Custom sub-view,
// not dropping it. 'v8-gauge'/'v6-gauge' rows approximated the fascia as a saved gauge set; the log's
// own auto-match already supplies that, so their `gauges` are simply discarded.
function applyViewConfig(cfg, meta){
  cfg = cfg || {};
  if(cfg.kind === 'gauges'){ applyGaugesConfig(cfg, meta, { edit: false, dirty: false }); return; }

  var isBuiltin = cfg.kind === undefined;
  var rawLayout = cfg.layout, layout = rawLayout || 'default';
  var seedDash = false, forceCustomSubmode = false;
  if(!isBuiltin){
    if(rawLayout === 'customdash'){ layout = 'gauge'; forceCustomSubmode = true; seedDash = true; }
    else if(rawLayout === 'v8-gauge' || rawLayout === 'v6-gauge') layout = 'gauge';
    else seedDash = true;   // current-model Layout: `gauges` is always the dash's own, safe to seed
  }

  if(isBuiltin){
    var gauges = (cfg.gauges || []).map(function(g){ return JSON.parse(JSON.stringify(g)); });
    VIEWER_ACTIVE_PRESET = {
      id: meta.id, name: meta.name, gauges: gauges,
      defaultGraphs: cfg.defaultGraphs || { upper: [], middle: [], lower: [] }, layout: layout,
    };
    VIEWER_GAUGE_SUBMODE = 'default';
  } else if(seedDash && Array.isArray(cfg.gauges) && cfg.gauges.length){
    VIEWER_DASH = { gauges: cfg.gauges.map(function(g){ return JSON.parse(JSON.stringify(g)); }) };
    dashAdoptGaugeIds(VIEWER_DASH.gauges);
    dashMigrateScorecards(VIEWER_DASH.gauges);
    // A current-model layout remembers which sub-view it was showing (unlike the legacy customdash
    // remap above, this isn't a forced reinterpretation -- it's literally what was true when saved).
    if(cfg.gaugeSubmode === 'custom') forceCustomSubmode = true;
  }
  // The gauge choice this layout was saved with (Ken, 2026-09-10). cfg.gauges above only restores the
  // custom dash's CONTENTS; this is what makes switching Layouts switch gauges -- a layout saved on the
  // Custom dash comes back on Custom under the name it was saved with, and one saved on a built-in
  // fascia puts that fascia back instead of leaving whatever the previous layout or this log's
  // auto-match had. Layouts saved before this field existed carry no gaugeSet and behave exactly as
  // they did (dash seeded if they have one, fascia untouched).
  var gsel = (!isBuiltin && cfg.gaugeSet && typeof cfg.gaugeSet === 'object') ? cfg.gaugeSet : null;
  if(gsel){
    if(gsel.submode === 'custom'){
      forceCustomSubmode = true;
      VIEWER_CURRENT_GAUGES = (gsel.ref && gsel.ref.kind)
        ? { kind: gsel.ref.kind, id: gsel.ref.id || null, name: gsel.ref.name || '', readOnly: !!gsel.ref.readOnly }
        : null;
      VIEWER_GAUGES_DIRTY = false;
      rememberLastDash();   // the next log opens on the dash this layout brought, not the previous one
    } else {
      forceCustomSubmode = false;
      VIEWER_GAUGE_SUBMODE = 'default';
      applyPresetFascia(gsel.preset && gsel.preset.id);
    }
  }
  if(forceCustomSubmode) VIEWER_GAUGE_SUBMODE = 'custom';
  VIEWER_VIEW_MODE = layout;
  // Restore how many graph panels this layout showed (1/2/3). Falls through to the current count when
  // a config predates this or is a built-in.
  if(cfg.graphCount) VIEWER_GRAPH_COUNT = cfg.graphCount;
  // A layout that carries histogram definitions restores them (migrated to the current schema); one
  // that doesn't leaves the session's set alone, so switching between plain layouts never wipes a
  // tuner's tables.
  // Math channels first: ids are minted per creation, so the layout's copy of a channel that also
  // exists here (same name, different id) is reconciled onto the LIVE id before anything references
  // it. Otherwise loading a layout could orphan every histogram built since -- their mathChannelId
  // pointing at an id that no longer exists while a channel of that name sits in the list (Ken,
  // 2026-09-08: "missing or deleted, but it's right there").
  var mathIdMap = {};
  var incomingMath = null;
  if(Array.isArray(cfg.mathChannels) && cfg.mathChannels.length){
    ensureMath();
    incomingMath = cfg.mathChannels.map(function(d){ return JSON.parse(JSON.stringify(d)); });
    var normName = (typeof Histogram !== 'undefined' && Histogram.normChannelName) ? Histogram.normChannelName
      : function(s){ return String(s == null ? '' : s).toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim(); };
    var liveByName = {};
    VIEWER_MATH.defs.forEach(function(d){ if(d && d.name) liveByName[normName(d.name)] = d; });
    incomingMath.forEach(function(d){
      if(!d || !d.name) return;
      var live = liveByName[normName(d.name)];
      if(live && live.id && d.id !== live.id){ mathIdMap[d.id] = live.id; d.id = live.id; }
    });
  }
  // Gauges behind the Histograms tab: a layout that carries them restores them; one without leaves
  // the session's set alone (nothing built since is ever silently dropped -- remove them from the
  // designer instead).
  if(!isBuiltin && Array.isArray(cfg.histGauges) && cfg.histGauges.length){
    VIEWER_HIST_DASH = { gauges: cfg.histGauges.map(function(g){ return JSON.parse(JSON.stringify(g)); }) };
    dashAdoptGaugeIds(VIEWER_HIST_DASH.gauges);
    saveHistDashLocal();
  }
  if(Array.isArray(cfg.histograms) && cfg.histograms.length){
    var incoming = cfg.histograms.map(function(d){
      var c = JSON.parse(JSON.stringify(d));
      if(typeof Histogram !== 'undefined' && Histogram.migrateDef){ try { Histogram.migrateDef(c); } catch(err){} }
      return c;
    });
    if(Object.keys(mathIdMap).length && typeof Histogram !== 'undefined' && Histogram.remapMathChannelIds){
      incoming = Histogram.remapMathChannelIds(incoming, mathIdMap);
    }
    // A PBD vehicle config or built-in auto-applied on log open must never clobber the tuner's own
    // tables: it seeds the session only when the set is empty and never touches the local mirror.
    // Loading one's OWN saved layout is a choice -- its tables become the session set and the mirror
    // (which is what "reuse on the next log" reads).
    var histReadOnly = !meta || !!meta.readOnly || meta.kind !== 'saved';
    if(histReadOnly){
      if(!ensureHist().defs.length) VIEWER_HIST.defs = incoming;
    } else {
      ensureHist();
      var nextHistDefs = mergeNamedDefsOnLoad(VIEWER_HIST.defs, incoming, meta.name, 'histogram', 'table');
      VIEWER_HIST = { defs: nextHistDefs };
      saveHistogramDefsLocal(nextHistDefs);
    }
  }
  // Same store, same clobber hazard, same fix -- see mergeNamedDefsOnLoad. Math channels are the
  // reusable building block a histogram's cell/axis parameter can reference by id (mathChannelId), so
  // losing one silently would leave every histogram that used it showing "missing parameter".
  if(incomingMath){
    var mathReadOnly = !meta || !!meta.readOnly || meta.kind !== 'saved';
    if(mathReadOnly){
      if(!ensureMath().defs.length) VIEWER_MATH.defs = incomingMath;
    } else {
      ensureMath();
      var nextMathDefs = mergeNamedDefsOnLoad(VIEWER_MATH.defs, incomingMath, meta.name, 'math channel', 'channel');
      VIEWER_MATH = { defs: nextMathDefs };
      saveMathDefsLocal(nextMathDefs);
    }
  }
  VIEWER_CURRENT_LAYOUT = { kind: meta.kind, id: meta.id, name: meta.name, readOnly: !!meta.readOnly };
  VIEWER_LAYOUT_DIRTY = false;
  if(meta.kind === 'saved' && !meta.readOnly) rememberLastSaved('view', meta.id, meta.name);
  if(cfg.smoothing && typeof cfg.smoothing === 'object') setSmoothingMap(cfg.smoothing);
  // A layout remembers its literal graph channels; restore them (those this log has). A legacy/built-in
  // config with no graph snapshot -- or one none of whose channels exist here -- falls back to the
  // role-based defaults.
  if(cfg.graphs){ applyGraphsSnapshot(cfg.graphs); if(!VIEWER_SELECTED.length) pickDefaultChannels(); }
  else pickDefaultChannels();
  renderViewerBody();
}
// Loads a Custom Gauges config into the dash. Shared by the header's Custom Gauges picker (a
// consumption move: land on the finalized dash, nothing marked dirty) and the in-dash "Load gauges"
// button (loadGaugesIntoDash, an authoring move: stay in build mode, mark it dirty since you're
// presumably about to keep editing before re-saving under this dash's own name). Neither touches
// graphs/channels/histograms -- unlike a Layout, Custom Gauges is scoped to gauges only.
function applyGaugesConfig(cfg, meta, opts){
  opts = opts || {};
  if(!cfg || !Array.isArray(cfg.gauges)){ if(window.showToast) showToast('Could not load that gauge set.'); return; }
  VIEWER_DASH = VIEWER_DASH || { gauges: [] };
  VIEWER_DASH.gauges = cfg.gauges.map(function(g){ return JSON.parse(JSON.stringify(g)); });
  dashMigrateScorecards(VIEWER_DASH.gauges);
  dashAdoptGaugeIds(VIEWER_DASH.gauges);   // ids were minted in whatever session saved this set
  // The graph channels saved with the set come back too (only those this log has); a set saved before
  // that existed leaves the graphs as they are.
  if(cfg.graphs){ applyGraphsSnapshot(cfg.graphs); if(!VIEWER_SELECTED.length) pickDefaultChannels(); }
  if(cfg.graphCount) VIEWER_GRAPH_COUNT = cfg.graphCount;
  if(meta && meta.kind === 'saved' && !meta.readOnly) rememberLastSaved('gauges', meta.id, meta.name);
  VIEWER_VIEW_MODE = 'gauge';
  VIEWER_GAUGE_SUBMODE = 'custom';
  VIEWER_DASH_EDIT = VIEWER_DASH_TARGET === 'hist' ? true : !!opts.edit;   // "Load gauges" while building the histogram set stays in the designer
  VIEWER_CURRENT_GAUGES = { kind: meta.kind, id: meta.id, name: meta.name, readOnly: !!meta.readOnly };
  VIEWER_GAUGES_DIRTY = !!opts.dirty;
  markLayoutDirty();   // the layout on screen now shows different gauges than the one that was loaded
  rememberLastDash();
  saveViewerPrefs();
  renderViewerBody();
  if(opts.toast && window.showToast) showToast(opts.toast);
}
function selectBuiltinView(id){
  var p = getPresetById(id);
  if(!p) return;
  // deep copy so gauge edits never mutate the shipped built-in
  applyViewConfig({ layout: p.layout === 'v8-gauge' || p.layout === 'v6-gauge' ? 'gauge' : p.layout,
                    gauges: p.gauges, defaultGraphs: p.defaultGraphs },
                  { kind: 'builtin', id: p.id, name: p.name });
}
// A host can install a saved-layouts provider on window.DATAVIEWER.layouts (via configureViewer):
// list/save/apply/remove. On alldatalogs that provider stores to localStorage for everyone AND upserts
// to the Supabase `viewer_layouts` table for signed-in Pro users (cross-device). Prefer it when present
// so a saved Custom Dash lands in the DATABASE; else fall back to callViewsApi (host API / localStorage).
// Its shape differs from callViewsApi: list() returns {id,name} only (config comes from apply(id)), and
// save(state) prompts for the name itself + returns a boolean.
function viewsProvider(){
  var d = window.DATAVIEWER, lp = d && d.layouts;
  return (lp && typeof lp.list === 'function' && typeof lp.save === 'function' &&
          typeof lp.apply === 'function' && typeof lp.remove === 'function') ? lp : null;
}
function selectSavedView(rowId){
  var row = VIEWER_SAVED_VIEWS.filter(function(r){ return String(r.id) === String(rowId); })[0];
  var lp = viewsProvider();
  if(lp){
    var state = lp.apply(rowId);   // the provider owns the config; fetch it on demand
    if(!state) return;
    applyViewConfig(state, { kind: 'saved', id: rowId, name: row ? row.name : 'Saved view' });
    return;
  }
  if(!row) return;
  applyViewConfig(row.config || {}, { kind: 'saved', id: row.id, name: row.name });
}
function loadSavedViews(){
  var lp = viewsProvider();
  if(lp){
    try { VIEWER_SAVED_VIEWS = (lp.list() || []).map(function(x){ return { id: x.id, name: x.name, kind: x.kind }; }); }
    catch(e){ VIEWER_SAVED_VIEWS = []; }
    return Promise.resolve();   // provider list is synchronous; each config is fetched lazily via apply()
  }
  return callViewsApi({ action: 'list' }).then(function(res){
    if(res && res.ok && res.data && res.data.views) VIEWER_SAVED_VIEWS = res.data.views;
    else VIEWER_SAVED_VIEWS = [];
  }).catch(function(){ VIEWER_SAVED_VIEWS = []; });
}
function refreshViewSelect(){
  var sel = document.getElementById('dlvViewSelect');
  if(sel) sel.outerHTML = renderViewSelectHtml();
  wireViewSelect();
}
// Host hook: re-list the saved views after a LATE async change to the layouts provider's store. The
// viewer lists once at init (and after each save/delete); but a host's cloud layer can populate that
// store AFTER that -- on alldatalogs, a Pro user's cloud layouts are pulled into localStorage only
// once entitlement resolves, which is after auth, i.e. after the viewer already listed. Without a way
// to re-list, those DB-synced dashes wouldn't appear in My Views until the next save/delete or a full
// reload. The host calls this once its pull settles. Safe no-op before init (loadSavedViews guards its
// own store); returns the loadSavedViews() promise so the host can chain.
window.reloadViewerLayouts = function(){
  return loadSavedViews().then(refreshViewSelect);
};
function markLayoutDirty(){
  if(VIEWER_LAYOUT_DIRTY) return;
  VIEWER_LAYOUT_DIRTY = true;
  refreshViewSelect();
}
function markGaugesDirty(){
  if(VIEWER_GAUGES_DIRTY) return;
  VIEWER_GAUGES_DIRTY = true;
  refreshViewSelect();
}

// A saved row's kind, from whichever source populated it (localStorage/API rows carry config.kind; the
// host provider surfaces it as x.kind once it does -- see loadSavedViews). Default 'view'.
function savedRowKind(r){ return r.kind || (r.config && r.config.kind) || 'view'; }
// TWO independent pickers (Ken, 2026-09-08): a Layout menu (built-ins + saved layouts) and a Custom
// Gauges menu (saved dashes). Each button ALWAYS shows its own fixed category, with the active item's
// name underneath -- unlike the old single-slot version, where exactly one button ever showed a name
// and which one flipped depending on whichever kind you'd loaded most recently.
function renderViewSelectHtml(){
  var layout = VIEWER_CURRENT_LAYOUT || {}, gauges = VIEWER_CURRENT_GAUGES || {};
  var layoutName = layout.name || 'Default View';
  var gaugesName = gauges.name || 'None';
  return '<div class="dlv-vpick" id="dlvViewSelect">' +
    '<button type="button" class="dlv-btn dlv-btn-menu dlv-vpick-btn" id="dlvViewBtn" title="Built-in + saved layouts">' +
      '<span class="dlv-vpick-cat">Layout</span>' +
      '<span class="dlv-vpick-name">' + escapeHtml(layoutName) + (VIEWER_LAYOUT_DIRTY ? ' *' : '') + '</span>' +
    '</button>' +
    '<button type="button" class="dlv-btn dlv-btn-menu dlv-vpick-btn" id="dlvGaugesBtn" title="Saved custom gauge dashboards">' +
      '<span class="dlv-vpick-cat">Custom Gauges</span>' +
      '<span class="dlv-vpick-name">' + escapeHtml(gaugesName) + (VIEWER_GAUGES_DIRTY ? ' *' : '') + '</span>' +
    '</button>' +
    '</div>';
}
// One saved row inside a picker menu: click the name to load it, the trash to delete it. `which`
// ('view'|'gauges') says which independent slot to compare against for the active-row highlight.
function viewPickRowHtml(r, which){
  var cur = (which === 'gauges' ? VIEWER_CURRENT_GAUGES : VIEWER_CURRENT_LAYOUT) || {};
  var on = cur.kind === 'saved' && String(cur.id) === String(r.id);
  return '<div class="dlv-vrow">' +
    '<button type="button" class="act clear dlv-vrow-pick' + (on ? ' dlv-vrow-on' : '') + '" data-pick="s:' + escapeHtml(String(r.id)) + '">' + escapeHtml(r.name) + '</button>' +
    '<button type="button" class="dlv-vrow-del" data-del="' + escapeHtml(String(r.id)) + '" data-delname="' + escapeHtml(r.name) + '" title="Delete">&#128465;</button>' +
    '</div>';
}
// One "For this car" (PBD, read-only) row in a picker: click to load it; no delete (users can't remove
// PBD configs). Highlighted when it's the active item in that slot. Its id is namespaced 'veh:' to not
// collide with the user's own saved-item ids.
function vehPickRowHtml(c, which){
  var cur = (which === 'gauges' ? VIEWER_CURRENT_GAUGES : VIEWER_CURRENT_LAYOUT) || {};
  var on = cur.kind === 'saved' && String(cur.id) === 'veh:' + String(c.id);
  return '<div class="dlv-vrow"><button type="button" class="act clear dlv-vrow-pick' + (on ? ' dlv-vrow-on' : '') +
    '" data-veh="' + escapeHtml(String(c.id)) + '">' + escapeHtml(c.name || 'Config') + '</button></div>';
}
// Load one of the vehicle's PBD configs. Read-only (so closing it never prompts to save -- see closeViewer).
function applyVehicleConfig(id){
  var vc = VIEWER_VEHICLE_CONFIGS.filter(function(c){ return String(c.id) === String(id); })[0];
  if(!vc) return;
  applyViewConfig(vc.config || vc, { kind: 'saved', id: 'veh:' + vc.id, name: vc.name || 'Vehicle config', readOnly: true });
}
// Layout / Custom Gauges pickers -- a native <select> can't carry a per-item delete button. Reuses the
// header-menu shell (VIEWER_HDR_MENU + its document-click / Escape closers).
// Which account the host's layouts provider syncs to, for the picker's account line. A provider may
// expose account() -> { email, synced } | null (null = not signed in). Ken, 2026-09-09: layouts saved
// at home under one sign-in "weren't there" at the shop under another -- the picker now says whose
// cloud it is showing, so an account mismatch is visible instead of looking like a lost save.
function viewsAccountLine(){
  var lp = viewsProvider();
  if(!lp || typeof lp.account !== 'function') return '';
  var a = null; try { a = lp.account(); } catch(e){ a = null; }
  if(a && a.email){
    return '<div class="dlv-vpick-account" title="' + (a.synced ? 'Saved layouts sync to this account across your devices' : 'Sign in with Pro to sync saved layouts across devices') + '">' +
      (a.synced ? 'Synced to <b>' + escapeHtml(a.email) + '</b>' : 'This device only · <b>' + escapeHtml(a.email) + '</b> (not Pro)') + '</div>';
  }
  return '<div class="dlv-vpick-account" title="Sign in with Pro to sync saved layouts across devices">This device only · not signed in</div>';
}
// True when the tuner's own dash is the thing on screen. A built-in view row is then NOT "the current
// view", however the fascia underneath was auto-matched -- the Layout menu used to tick "V8 Gauge"
// while a Holley dash was displaying (Ken, 2026-09-10).
function customDashShowing(){
  return VIEWER_VIEW_MODE === 'gauge' && VIEWER_GAUGE_SUBMODE === 'custom' &&
         !!(VIEWER_DASH && VIEWER_DASH.gauges && VIEWER_DASH.gauges.length);
}
function viewPickerHtml(which){
  var cur = (which === 'gauges' ? VIEWER_CURRENT_GAUGES : VIEWER_CURRENT_LAYOUT) || {};
  var dashShowing = customDashShowing();
  var html = '';
  if(which === 'view'){
    html += '<h4>Layout</h4>' + viewsAccountLine();
    // PBD layouts assigned to this vehicle -- the default is auto-loaded; the rest are switchable here.
    var vveh = VIEWER_VEHICLE_CONFIGS.filter(function(c){ return (c.kind || 'view') !== 'gauges'; });
    if(vveh.length){
      html += '<div class="dlv-vpick-grouplabel">For this car</div>';
      html += vveh.map(function(c){ return vehPickRowHtml(c, 'view'); }).join('') + '<div class="dlv-menu-sep"></div>';
    }
    html += DATALOG_PRESETS.map(function(p){
      var on = cur.kind === 'builtin' && cur.id === p.id && !dashShowing;
      return '<div class="dlv-vrow"><button type="button" class="act clear dlv-vrow-pick' + (on ? ' dlv-vrow-on' : '') + '" data-pick="b:' + p.id + '">' + escapeHtml(p.name) + '</button></div>';
    }).join('');
    var saved = VIEWER_SAVED_VIEWS.filter(function(r){ return savedRowKind(r) !== 'gauges'; });
    html += '<div class="dlv-menu-sep"></div>';
    html += saved.length ? saved.map(function(r){ return viewPickRowHtml(r, 'view'); }).join('') : '<div class="dlv-gmenu-hint">No saved layouts yet.</div>';
  } else {
    html += '<h4>Custom Gauges</h4>' + viewsAccountLine();
    var gveh = VIEWER_VEHICLE_CONFIGS.filter(function(c){ return (c.kind || 'view') === 'gauges'; });
    if(gveh.length){
      html += '<div class="dlv-vpick-grouplabel">For this car</div>';
      html += gveh.map(function(c){ return vehPickRowHtml(c, 'gauges'); }).join('') + '<div class="dlv-menu-sep"></div>';
    }
    var g = VIEWER_SAVED_VIEWS.filter(function(r){ return savedRowKind(r) === 'gauges'; });
    html += g.length ? g.map(function(r){ return viewPickRowHtml(r, 'gauges'); }).join('') : '<div class="dlv-gmenu-hint">No saved custom gauges yet.</div>';
    html += '<div class="dlv-menu-sep"></div>';
    html += '<div class="dlv-vrow"><button type="button" class="act clear dlv-vrow-pick' + (viewerIsPro() ? '' : ' dlv-pro-locked') + '" data-newdash="1">+ Build custom gauges</button></div>';
    if(libraryAvailable()) html += '<div class="dlv-vrow"><button type="button" class="act clear dlv-vrow-pick" data-library="gauges">Browse the library…</button></div>';
  }
  return html;
}
// The anchor can be STALE by the time this runs: refreshViewSelect() rewrites the header buttons with
// outerHTML, so the element captured when the menu opened is detached and measures 0x0 at 0,0 -- which
// parked the menu against the left edge of the window instead of under its button (Ken, 2026-09-10:
// "sometimes when I click on the layout menu it opens under the button but other times it is all the
// way to the left"). Re-resolve the live button by id, and if there is nothing measurable, leave the
// menu where it is rather than throwing it into the corner.
function positionHdrMenu(m, anchor){
  var el = anchor;
  if(el && el.id){
    var live = (el.isConnected === false || !document.body.contains(el)) ? document.getElementById(el.id) : el;
    if(live) el = live;
  }
  var rc = el ? el.getBoundingClientRect() : null;
  if(!rc || (!rc.width && !rc.height)) return;
  var pad = 8;
  m.style.top = (rc.bottom + 6) + 'px';
  m.style.left = Math.max(pad, Math.min(rc.left, window.innerWidth - m.offsetWidth - pad)) + 'px';
}
function openViewPicker(anchor, which){
  var key = 'vpick:' + which;
  var already = VIEWER_HDR_MENU && VIEWER_HDR_MENU.__which === key;
  closeHdrMenu();
  if(typeof closePerfMenu === 'function') closePerfMenu();
  if(typeof closeGaugeMenu === 'function') closeGaugeMenu();
  closeGraphMenu();
  if(already) return;   // second click on the same button closes it
  var m = document.createElement('div');
  m.className = 'dlv-gmenu dlv-hdr-menu dlv-vpick-menu';
  m.__which = key;
  m.innerHTML = viewPickerHtml(which);
  document.body.appendChild(m);
  positionHdrMenu(m, anchor);
  VIEWER_HDR_MENU = m;
  wireViewPicker(m, which);
  // Cloud refresh on open: the host pulled its cloud layouts when it started, but a save made since
  // then on another device (or in another browser) only shows up after another pull. A provider that
  // exposes refresh() (a throttled pull; resolves true when rows arrived) gets called here, and the
  // still-open picker is re-rendered in place with the fresh list.
  var lp = viewsProvider();
  if(lp && typeof lp.refresh === 'function'){
    var p = null;
    try { p = lp.refresh(); } catch(e){ p = null; }
    if(p && typeof p.then === 'function'){
      p.then(function(changed){
        if(changed === false) return;
        return loadSavedViews().then(function(){
          refreshViewSelect();
          if(VIEWER_HDR_MENU !== m || !m.parentNode) return;   // closed meanwhile
          m.innerHTML = viewPickerHtml(which);
          wireViewPicker(m, which);
          positionHdrMenu(m, anchor);
        });
      }).catch(function(){});
    }
  }
}
function wireViewPicker(m, which){
  m.querySelectorAll('[data-pick]').forEach(function(btn){
    btn.addEventListener('click', function(){
      var v = btn.getAttribute('data-pick'); closeHdrMenu();
      if(v.indexOf('s:') === 0) selectSavedView(v.slice(2)); else selectBuiltinView(v.slice(2));
    });
  });
  m.querySelectorAll('[data-veh]').forEach(function(btn){
    btn.addEventListener('click', function(){ closeHdrMenu(); applyVehicleConfig(btn.getAttribute('data-veh')); });
  });
  m.querySelectorAll('[data-newdash]').forEach(function(btn){
    btn.addEventListener('click', function(){ closeHdrMenu(); if(viewerIsPro()) enterCustomGauges(); });
  });
  m.querySelectorAll('[data-library]').forEach(function(btn){
    btn.addEventListener('click', function(){ closeHdrMenu(); openLibrary(btn.getAttribute('data-library')); });
  });
  m.querySelectorAll('[data-del]').forEach(function(btn){
    btn.addEventListener('click', function(e){
      e.stopPropagation();   // keep the menu open through the confirm; we re-open it refreshed
      deleteSavedById(btn.getAttribute('data-del'), btn.getAttribute('data-delname'), which);
    });
  });
}
// Drops the dash and its saved-gauges slot back to "nothing loaded" -- used when the currently-loaded
// Custom Gauges set is deleted, or an unsaved dash is discarded. Never touches the Layout.
function clearCurrentGauges(){
  forgetLastDash();
  VIEWER_DASH = null;
  VIEWER_CURRENT_GAUGES = null;
  VIEWER_GAUGES_DIRTY = false;
  VIEWER_GAUGE_SUBMODE = 'default';
  if(!(VIEWER_ACTIVE_PRESET && VIEWER_ACTIVE_PRESET.gauges && VIEWER_ACTIVE_PRESET.gauges.length)) VIEWER_VIEW_MODE = 'default';
  saveViewerPrefs();
  renderViewerBody();
}
// Delete a specific saved item by id (a picker trash button). `which` says whether it came from the
// Layout or Custom Gauges picker, so the right slot gets cleared if it was the active one.
function deleteSavedById(id, name, which){
  if(!window.confirm('Delete "' + (name || 'this item') + '"?')) return;
  var slot = which === 'gauges' ? VIEWER_CURRENT_GAUGES : VIEWER_CURRENT_LAYOUT;
  var wasActive = slot && slot.kind === 'saved' && String(slot.id) === String(id);
  var reopen = function(){
    closeHdrMenu();   // clear the still-open menu so re-open isn't toggled off
    if(wasActive){
      if(which === 'gauges') clearCurrentGauges(); else selectBuiltinView('default');
    } else {
      refreshViewSelect();
      var btn = document.getElementById(which === 'gauges' ? 'dlvGaugesBtn' : 'dlvViewBtn');
      if(btn) openViewPicker(btn, which);
    }
    if(window.showToast) showToast('Deleted.');
  };
  var lp = viewsProvider();
  if(lp){ try { lp.remove(id); } catch(e){} loadSavedViews().then(reopen); return; }
  callViewsApi({ action: 'delete', id: id }).then(function(res){
    if(!res || !res.ok || (res.data && res.data.error)){ if(window.showToast) showToast('Could not delete.'); return; }
    loadSavedViews().then(reopen);
  });
}
function wireViewSelect(){
  // Use onclick (NOT addEventListener) so repeat calls REPLACE the handler instead of STACKING duplicates.
  // wireViewSelect runs more than once per open: at header build, then again after
  // loadSavedViews().then(refreshViewSelect) resolves (and on markLayoutDirty/markGaugesDirty /
  // reloadViewerLayouts). onclick is idempotent, so any number of re-wires leaves exactly one handler.
  var vb = document.getElementById('dlvViewBtn');
  if(vb) vb.onclick = function(e){ e.stopPropagation(); openViewPicker(vb, 'view'); };
  var gb = document.getElementById('dlvGaugesBtn');
  if(gb) gb.onclick = function(e){ e.stopPropagation(); openViewPicker(gb, 'gauges'); };
}

// Save the current state as a config of `kind` ('view' = Layout, 'gauges' = Custom Gauges). Both kinds
// use the SAME rule now (Ken, 2026-09-08 -- "Save gauges" used to always fork a new copy, even when
// updating one you'd just loaded, while "Save view" updated in place; standardized on the latter):
// asNew forces a new entry; otherwise the already-loaded saved item of that exact kind is updated in
// place, silently. Returns a Promise that settles once the save is done (so save-on-close can save
// THEN close).
function saveConfig(kind, asNew){
  var cur = (kind === 'gauges' ? VIEWER_CURRENT_GAUGES : VIEWER_CURRENT_LAYOUT) || {};
  var updating = !asNew && cur.kind === 'saved';
  if(updating) return persistConfig(kind, cur.name, cur.id);
  var noun = kind === 'gauges' ? 'custom gauge dashboard' : 'layout';
  var name = window.prompt('Save this ' + noun + ' as:', (cur.name || (kind === 'gauges' ? 'My Gauges' : 'My Layout')) + (cur.kind === 'builtin' ? ' (custom)' : ''));
  if(!name) return Promise.resolve(false);
  return persistConfig(kind, name, null);
}
// Like saveConfig but ALWAYS prompts, defaulted to the current/loaded item's name -- so hitting Enter
// resaves it (an edit) and typing a new name forks a new one. Used by dash Finalize: after "Load
// gauges", Finalize defaults to the loaded gauge's name (Ken, 2026-07-26).
function saveConfigPrompt(kind){
  var cur = (kind === 'gauges' ? VIEWER_CURRENT_GAUGES : VIEWER_CURRENT_LAYOUT) || {};
  var isSame = cur.kind === 'saved';
  var def = isSame ? cur.name : (kind === 'gauges' ? 'My Gauges' : 'My Layout');
  var name = window.prompt('Save as:', def);
  if(!name) return Promise.resolve(false);
  // Same name as what we're editing -> overwrite it; a new name -> a new entry.
  var updateId = (isSame && name === cur.name) ? cur.id : null;
  return persistConfig(kind, name, updateId);
}
// The actual save under an explicit name. The host provider dedups by name (same name overwrites); the
// fallback API needs updateId to overwrite. Returns a Promise; sets the saved item as the current
// Layout or Custom Gauges (whichever `kind` says) -- the two slots never interfere with each other.
function persistConfig(kind, name, updateId){
  var cfg = buildConfig(kind);
  var setCurrent = function(id, savedName){
    if(kind === 'gauges'){ VIEWER_CURRENT_GAUGES = { kind: 'saved', id: id, name: savedName }; VIEWER_GAUGES_DIRTY = false; rememberLastDash(); }
    else { VIEWER_CURRENT_LAYOUT = { kind: 'saved', id: id, name: savedName }; VIEWER_LAYOUT_DIRTY = false; }
    // Only LOADING one used to count as "the one I'm using", so saving a layout and then opening the
    // next log came up on the auto-matched built-in -- the header naming a view the tuner never chose
    // while their own dash was on screen (Ken, 2026-09-10). Saving is just as much a choice as loading.
    rememberLastSaved(kind === 'gauges' ? 'gauges' : 'view', id, savedName);
  };
  var lp = viewsProvider();
  if(lp){
    var ok = false;
    try { ok = lp.save(cfg, name); } catch(e){ ok = false; }   // name given -> silent save under it
    if(!ok) return Promise.resolve(false);
    return loadSavedViews().then(function(){
      var row = VIEWER_SAVED_VIEWS.filter(function(r){ return r.name === name; })[0] || VIEWER_SAVED_VIEWS[0];
      if(row) setCurrent(row.id, row.name);
      refreshViewSelect();
      adlTrack('preset_saved', {});
      if(window.showToast) showToast('Saved.');
      return true;
    });
  }
  var body = { action: 'save', name: name, config: cfg };
  if(updateId) body.id = updateId;
  return callViewsApi(body).then(function(res){
    if(!res || !res.ok || (res.data && res.data.error)){
      if(window.showToast) showToast((res && res.data && res.data.error) || 'Could not save that.');
      return false;
    }
    var row = res.data.view;
    return loadSavedViews().then(function(){
      setCurrent(row.id, row.name);
      refreshViewSelect();
      adlTrack('preset_saved', {});
      if(window.showToast) showToast('Saved "' + row.name + '".');
      return true;
    });
  });
}
function deleteCurrentLayout(){
  var cur = VIEWER_CURRENT_LAYOUT;
  if(!cur || cur.kind !== 'saved'){ if(window.showToast) showToast('Built-in layouts cannot be deleted.'); return; }
  if(cur.readOnly){ if(window.showToast) showToast('This layout is provided for this car and can\'t be deleted.'); return; }
  if(!window.confirm('Delete the layout "' + cur.name + '"?')) return;
  var lp = viewsProvider();
  var finish = function(){ selectBuiltinView('default'); if(window.showToast) showToast('Deleted.'); };
  if(lp){ try { lp.remove(cur.id); } catch(e){} loadSavedViews().then(finish); return; }
  callViewsApi({ action: 'delete', id: cur.id }).then(function(res){
    if(!res || !res.ok || (res.data && res.data.error)){ if(window.showToast) showToast((res && res.data && res.data.error) || 'Could not delete that layout.'); return; }
    return loadSavedViews().then(finish);
  });
}
function deleteCurrentGauges(){
  var cur = VIEWER_CURRENT_GAUGES;
  if(!cur || cur.kind !== 'saved'){ if(window.showToast) showToast('Nothing saved to delete.'); return; }
  if(cur.readOnly){ if(window.showToast) showToast('These custom gauges are provided for this car and can\'t be deleted.'); return; }
  if(!window.confirm('Delete the custom gauge dashboard "' + cur.name + '"?')) return;
  var lp = viewsProvider();
  var finish = function(){ clearCurrentGauges(); if(window.showToast) showToast('Deleted.'); };
  if(lp){ try { lp.remove(cur.id); } catch(e){} loadSavedViews().then(finish); return; }
  callViewsApi({ action: 'delete', id: cur.id }).then(function(res){
    if(!res || !res.ok || (res.data && res.data.error)){ if(window.showToast) showToast((res && res.data && res.data.error) || 'Could not delete that.'); return; }
    return loadSavedViews().then(finish);
  });
}

// ---------------------------------------------------------------------------------------------
// Gauge edit mode + right-click editor
//
// Gauges are LOCKED by default: nothing drags or changes until that gauge is put into edit mode,
// so a working dashboard can't be knocked out of alignment by a stray drag. Entry is either the
// small button in the gauge's corner or right-click -> "Edit mode" (which is the only thing the
// menu offers while locked).
//
// When a gauge's channel didn't resolve, the menu LEADS with guidance on how to make it work
// (explainUnresolvedRole) instead of just showing a dead N/A -- e.g. "Boost can be calculated from
// MAP - Barometric Pressure; add Barometric Pressure to your next log." Auto-mapping is only the
// default: any gauge can be pointed at any channel from the Mapping tab.
// ---------------------------------------------------------------------------------------------
var VIEWER_GAUGE_MENU = null;

function gaugeDefById(id){
  var gs = (VIEWER_ACTIVE_PRESET && VIEWER_ACTIVE_PRESET.gauges) || [];
  for(var i = 0; i < gs.length; i++){ if(gs[i].id === id) return gs[i]; }
  return null;
}
function closeGaugeMenu(){
  if(VIEWER_GAUGE_MENU){ VIEWER_GAUGE_MENU.remove(); VIEWER_GAUGE_MENU = null; }
}
document.addEventListener('click', closeGaugeMenu);

// Re-render the gauge cluster in place and refresh values at the current cursor. Any gauge edit
// routes through here. These are edits to the log's own auto-matched FASCIA gauges (Default sub-view)
// -- session-only, not saveable (Ken, 2026-09-08): "Custom Gauges" now always means the dash, so there
// is no longer a save path for fascia tweaks to land in, and marking the layout dirty for an edit that
// can't actually be saved would just be a dirty marker you can never make go away by saving.
function rerenderGauges(){
  renderGaugeView();
  updateAtCursor(CROSSHAIR_TIME);
}

// Attaches the edit button, context menu and (in edit mode) drag handles to one rendered gauge.
function wireGaugeEditing(el, def){
  if(!el || !def) return;
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'dlv-gauge-editbtn' + (def.type === 'vertical-bar' ? ' sm' : '') + (def._edit ? ' on' : '');
  btn.textContent = '✎';
  btn.title = def._edit ? 'Done editing' : 'Edit this gauge';
  btn.addEventListener('click', function(ev){
    ev.stopPropagation();
    def._edit = !def._edit;
    rerenderGauges();
  });
  el.appendChild(btn);
  if(def._edit) el.classList.add('dlv-gauge-editing');
  el.addEventListener('contextmenu', function(ev){ openGaugeMenu(ev, def); });
  if(def._edit) enableGaugeDrags(el, def);
}

// Range-end and zone-edge dragging, using the refs datalog-gauges.js stashed on the element.
function enableGaugeDrags(el, def){
  var refs = el._pbdRefs;
  if(!refs) return;
  var snap = function(v){ return (typeof gaugeSnapValue === 'function') ? gaugeSnapValue(def, v) : v; };

  (refs.endNums || []).forEach(function(numEl, i){
    var which = (i === 0) ? 'min' : 'max';
    // on dials the first tick is min; on bars the tick list runs max..min, so flip
    if(refs.kind === 'bar') which = (i === 0) ? 'max' : 'min';
    numEl.classList.add('dlv-gauge-endnum');
    numEl.addEventListener('pointerdown', function(e){
      if(e.button !== 0) return;   // right-click must fall through to the context menu, not drag
      e.preventDefault(); e.stopPropagation();
      var startX = e.clientX, startY = e.clientY, sMin = def.min, sMax = def.max, span = def.max - def.min;
      function move(ev){
        // dials read horizontally, bars read vertically (their numbers stack)
        var delta = (refs.kind === 'bar')
          ? -(ev.clientY - startY) * (span / 160)
          : (ev.clientX - startX) * (span / 200);
        if(which === 'min') def.min = Math.min(snap(sMin + delta), def.max - span * 0.05);
        else def.max = Math.max(snap(sMax + delta), def.min + span * 0.05);
        clampGaugeThresholds(def);
        rerenderGauges();
      }
      function up(){ window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); }
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    });
  });

  // Draggable warn/redline edges on a dial. These ARE visible now: they were invisible when gauges
  // were always draggable (a permanent handle on every dial was too loud), but edit mode gates them
  // now, so an unfindable grab target is just friction -- you can only see them while editing.
  if(def.thresholds && refs.kind === 'dial' && refs.svg){
    var handles = {};
    function placeHandle(key){
      var span = def.max - def.min;
      var pct = clampGauge(span ? (def.thresholds[key] - def.min) / span : 0, 0, 1);
      var p = gaugePolar(refs.cx, refs.cy, refs.rRing || 88, -135 + 270 * pct);
      handles[key].setAttribute('cx', p[0]);
      handles[key].setAttribute('cy', p[1]);
    }
    ['warn', 'red'].forEach(function(key){
      var hit = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      hit.setAttribute('r', 7.5);
      hit.setAttribute('fill', '#12121a');
      hit.setAttribute('stroke', key === 'warn' ? '#f5a623' : '#d1132e');
      hit.setAttribute('stroke-width', 3);
      hit.setAttribute('class', 'dlv-zone-handle');
      hit.setAttribute('style', 'cursor:ew-resize;pointer-events:all;');
      handles[key] = hit;
      refs.svg.appendChild(hit);
      placeHandle(key);
      hit.addEventListener('pointerdown', function(e){
        if(e.button !== 0) return;   // let right-click reach the context menu
        e.preventDefault(); e.stopPropagation();
        try { hit.setPointerCapture(e.pointerId); } catch(err){}
        function move(ev){
          // Deliberately NOT rerenderGauges(): that rebuilds this SVG, after which refs.svg is
          // detached, its rect reads 0x0 and every angle below turns to nonsense -- which is what
          // made the handle jump and the drag die after one move. Update in place instead.
          var rect = refs.svg.getBoundingClientRect();
          if(!rect.width || !rect.height) return;
          var lx = (ev.clientX - rect.left) / rect.width * 200;
          var ly = (ev.clientY - rect.top) / rect.height * 200;
          var ang = clampGauge(Math.atan2(lx - refs.cx, -(ly - refs.cy)) * 180 / Math.PI, -135, 135);
          var v = snap(def.min + (def.max - def.min) * ((ang + 135) / 270));
          var pad = (def.max - def.min) * 0.02;
          if(key === 'warn') def.thresholds.warn = clampGauge(v, def.min, def.thresholds.red - pad);
          else def.thresholds.red = clampGauge(v, def.thresholds.warn + pad, def.max);
          if(typeof redrawGaugeZones === 'function') redrawGaugeZones(el, def);
          placeHandle('warn'); placeHandle('red');
          updateAtCursor(CROSSHAIR_TIME);   // recolours needle/readout, no DOM rebuild
        }
        function up(ev){
          try { hit.releasePointerCapture(ev.pointerId); } catch(err){}
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
        }
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      });
    });
  }
}
function clampGaugeThresholds(def){
  if(!def.thresholds) return;
  def.thresholds.warn = clampGauge(def.thresholds.warn, def.min, def.max);
  def.thresholds.red = clampGauge(def.thresholds.red, def.thresholds.warn, def.max);
}

function openGaugeMenu(e, def){
  e.preventDefault(); e.stopPropagation();
  closeGaugeMenu();
  var m = document.createElement('div');
  m.className = 'dlv-gmenu';
  m.addEventListener('click', function(ev){ ev.stopPropagation(); });
  m.addEventListener('contextmenu', function(ev){ ev.preventDefault(); ev.stopPropagation(); });

  var resolvedCh = gaugeChannelFor(def);
  var html = '<h4>' + escapeHtml(def.label) + '</h4>';

  // Guidance first when the gauge has nothing to show -- how to fix it, not just "N/A".
  if(!resolvedCh && typeof explainUnresolvedRole === 'function'){
    var info = explainUnresolvedRole(def.role, { channels: VIEWER_DATA.channels, resolvedRoles: VIEWER_RESOLVED_ROLES });
    html += '<div class="dlv-gmenu-help"><b>Not available in this log</b>' + escapeHtml(info.message) + '</div>';
    if(info.suggestions && info.suggestions.length){
      html += '<div class="dlv-gmenu-sugg"><span>Map one of these instead:</span>' +
        info.suggestions.map(function(s){
          return '<button type="button" class="dlv-gmenu-map" data-ch="' + escapeHtml(s) + '">' + escapeHtml(s) + '</button>';
        }).join('') + '</div>';
    }
  }

  // The settings tabs are what the FIRST right-click shows (Ken, 2026-07-22). It used to open a
  // near-empty menu whose only offer was "Edit mode", so changing a channel or a warning took two
  // right-clicks and a mode you had to know about. Drag-to-edit is the niche path -- fiddly on a
  // 42-unit bar and something most people will never use -- so it's demoted to a toggle at the
  // bottom rather than being the gate in front of everything.
  {
    var chOpts = ['<option value="">Auto' + (VIEWER_RESOLVED_ROLES[def.role] ? ' (' + escapeHtml(VIEWER_RESOLVED_ROLES[def.role]) + ')' : ' — unresolved') + '</option>']
      // Categorical channels are deliberately absent: a dial or bar can only render a magnitude, and
      // pointing one at "Spark Source" would show the level index as if it were a measurement. They
      // are readable in the channel list, on a card, and on a graph -- just not on a gauge.
      .concat((VIEWER_DATA.channels || []).filter(function(c){ return !isTextChannel(c); }).map(function(c){
        return '<option value="' + escapeHtml(c) + '"' + (def.channelOverride === c ? ' selected' : '') + '>' + escapeHtml(c) + '</option>';
      })).join('');
    html += '<div class="dlv-gtabs">' +
        '<button data-t="map" class="active">Mapping</button>' +
        '<button data-t="warn">Warnings</button>' +
        '<button data-t="scale">Scale</button>' +
      '</div>' +
      '<div class="dlv-gpane active" data-p="map">' +
        '<div class="fld"><label>Channel</label><select id="gm-ch">' + chOpts + '</select></div>' +
        '<div class="dlv-gmenu-hint">Auto-mapping is just the default — point this gauge at any channel.</div>' +
        '<div class="acts"><button class="act save" data-s="map">Apply</button></div>' +
      '</div>' +
      '<div class="dlv-gpane" data-p="warn">' +
        '<div class="fld"><label>Warn above</label><input type="number" step="any" id="gm-wa"></div>' +
        '<div class="fld"><label>Warn below</label><input type="number" step="any" id="gm-wb"></div>' +
        '<div class="fld"><label>Crit above</label><input type="number" step="any" id="gm-ca"></div>' +
        '<div class="fld"><label>Crit below</label><input type="number" step="any" id="gm-cb"></div>' +
        '<div class="acts"><button class="act clear" data-s="warnclear">Clear</button><button class="act save" data-s="warn">Save</button></div>' +
      '</div>' +
      '<div class="dlv-gpane" data-p="scale">' +
        '<div class="fld"><label>Range min</label><input type="number" step="any" id="gm-min"></div>' +
        '<div class="fld"><label>Range max</label><input type="number" step="any" id="gm-max"></div>' +
        '<div class="fld"><label>Break pts</label><input type="number" step="1" min="1" max="24" id="gm-bp"></div>' +
        '<div class="fld"><label>Snap step</label><input type="number" step="any" id="gm-snap"></div>' +
        '<div class="fld"><label>Font size</label><input type="number" step="0.05" min="0.5" max="2.5" id="gm-fs"></div>' +
        (def.thresholds ? '<div class="fld"><label>Warn zone</label><input type="number" step="any" id="gm-tw"></div>' +
                          '<div class="fld"><label>Redline</label><input type="number" step="any" id="gm-tr"></div>' : '') +
        '<div class="acts"><button class="act save" data-s="scale">Apply</button></div>' +
      '</div>' +
      // Drag handles are now an opt-in extra rather than the gate in front of the settings.
      '<div class="acts">' +
        (def._edit
          ? '<button class="act clear dlv-gmenu-done">✓ Done dragging</button>'
          : '<button class="act clear dlv-gmenu-edit">✎ Drag handles on gauge</button>') +
      '</div>';
  }
  m.innerHTML = html;
  document.body.appendChild(m);

  // Position AFTER insertion, using the menu's real measured size. The old code clamped against a
  // hardcoded 268 while the menu is 300 wide, so a right-click near the right edge left it hanging
  // ~32px off-screen (Ken, 2026-07-22). Now it flips to the LEFT of the cursor when there isn't
  // room on the right -- which is what a context menu is expected to do -- and only falls back to
  // clamping if it fits on neither side.
  var mw = m.offsetWidth, mh = m.offsetHeight;
  var pad = 8;
  var left;
  if(e.clientX + mw + pad <= window.innerWidth) left = e.clientX;          // fits to the right
  else if(e.clientX - mw - pad >= 0) left = e.clientX - mw;                // flip to the left
  else left = Math.max(pad, window.innerWidth - mw - pad);                 // too narrow for either
  var top = e.clientY;
  if(top + mh + pad > window.innerHeight) top = Math.max(pad, window.innerHeight - mh - pad);
  m.style.left = Math.max(pad, left) + 'px';
  m.style.top = Math.max(pad, top) + 'px';
  VIEWER_GAUGE_MENU = m;

  // quick "map this instead" buttons from the guidance block
  m.querySelectorAll('.dlv-gmenu-map').forEach(function(b){
    b.addEventListener('click', function(){
      def.channelOverride = b.getAttribute('data-ch');
      closeGaugeMenu(); rerenderGauges();
    });
  });
  var editBtn = m.querySelector('.dlv-gmenu-edit');
  if(editBtn) editBtn.addEventListener('click', function(){ def._edit = true; closeGaugeMenu(); rerenderGauges(); });
  var doneBtn = m.querySelector('.dlv-gmenu-done');
  if(doneBtn) doneBtn.addEventListener('click', function(){ def._edit = false; closeGaugeMenu(); rerenderGauges(); });
  // (No early return on def._edit any more: the tabs are always rendered now, so their fields,
  // tab switching and Apply/Save handlers must always be wired. Bailing here left a fully drawn
  // settings panel where nothing responded.)

  var w = def.warnings || {};
  var set = function(id, v){ var el2 = m.querySelector(id); if(el2) el2.value = (v == null ? '' : v); };
  set('#gm-wa', w.above); set('#gm-wb', w.below); set('#gm-ca', w.critAbove); set('#gm-cb', w.critBelow);
  set('#gm-min', def.min); set('#gm-max', def.max);
  set('#gm-bp', def.type === 'vertical-bar' ? (def.ticks || 4) : (def.majors || 10));
  set('#gm-snap', (typeof gaugeSnapStep === 'function') ? gaugeSnapStep(def) : '');
  set('#gm-fs', def.fontScale || 1);
  if(def.thresholds){ set('#gm-tw', def.thresholds.warn); set('#gm-tr', def.thresholds.red); }

  m.querySelectorAll('.dlv-gtabs button').forEach(function(b){
    b.addEventListener('click', function(){
      m.querySelectorAll('.dlv-gtabs button').forEach(function(x){ x.classList.remove('active'); });
      m.querySelectorAll('.dlv-gpane').forEach(function(x){ x.classList.remove('active'); });
      b.classList.add('active');
      m.querySelector('.dlv-gpane[data-p="' + b.dataset.t + '"]').classList.add('active');
    });
  });
  var num = function(id){ var el2 = m.querySelector(id); if(!el2 || el2.value === '') return null; return parseFloat(el2.value); };
  m.querySelectorAll('.act').forEach(function(btn){
    btn.addEventListener('click', function(){
      var kind = btn.dataset.s;
      if(kind === 'map'){
        var v = m.querySelector('#gm-ch').value;
        def.channelOverride = v || null;
      } else if(kind === 'warn'){
        def.warnings = { above: num('#gm-wa'), below: num('#gm-wb'), critAbove: num('#gm-ca'), critBelow: num('#gm-cb') };
        // no longer a shipped default -- the ⚑ marker should come back so this gauge reads as
        // "someone set this deliberately" rather than factory
        delete def.warnDefault;
      } else if(kind === 'warnclear'){
        def.warnings = null;
        delete def.warnDefault;
      } else if(kind === 'scale'){
        var mn = num('#gm-min'), mx = num('#gm-max');
        if(mn != null && mx != null && mx > mn){ def.min = mn; def.max = mx; }
        var bp = num('#gm-bp');
        if(bp != null && bp >= 1){ if(def.type === 'vertical-bar') def.ticks = Math.round(bp); else def.majors = Math.round(bp); }
        var sp = num('#gm-snap'); if(sp != null && sp > 0) def.snap = sp;
        var f = num('#gm-fs'); if(f != null) def.fontScale = clampGauge(f, 0.5, 2.5);
        if(def.thresholds){
          var tw = num('#gm-tw'), tr = num('#gm-tr');
          if(tw != null) def.thresholds.warn = tw;
          if(tr != null) def.thresholds.red = tr;
          clampGaugeThresholds(def);
        }
      } else { return; }
      closeGaugeMenu(); rerenderGauges();
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Binary search for the index of the closest time value -- VIEWER_DATA.time is always ascending.
// ---------------------------------------------------------------------------------------------
function nearestTimeIndex(arr, x){
  var lo = 0, hi = arr.length - 1;
  if(x <= arr[0]) return 0;
  if(x >= arr[hi]) return hi;
  while(lo < hi){
    var mid = (lo + hi) >> 1;
    if(arr[mid] === x) return mid;
    if(arr[mid] < x) lo = mid + 1; else hi = mid;
  }
  if(lo > 0 && Math.abs(arr[lo-1]-x) <= Math.abs(arr[lo]-x)) return lo - 1;
  return lo;
}

// Single entry point for "the cursor moved to time X (or null = latest)" -- updates cards and/or
// gauges from the SAME resolved index, so we never do more than one nearest-point search per move
// no matter how many cards/gauges are on screen.
// Value of one channel AT the cursor, linearly interpolated between the two surrounding samples.
//
// Reading the nearest sample instead is what made the cursor feel "locked" (Ken, 2026-07-22): the
// crosshair line follows the mouse exactly, but every NUMBER came from the nearest row, so zoomed in
// -- where one sample can be 17+ px wide -- you could move the mouse half an inch and watch nothing
// change, then see everything jump at once. The line was free; the readouts were quantised, and the
// readouts are what you actually watch.
//
// TEXT channels are deliberately excluded: there is no value between "Hard Lock" and "Fixed Lock",
// so those keep the nearest sample.
function valueAtCursor(ch, idx, dataX){
  var series = VIEWER_DATA.series[ch] || [];
  var v = series[idx];
  if(dataX == null || isTextChannel(ch)) return v;
  var t = VIEWER_DATA.time;
  // nearestTimeIndex can land either side of the cursor, so pick the bracketing pair explicitly.
  var i0 = (t[idx] <= dataX) ? idx : idx - 1;
  var i1 = i0 + 1;
  if(i0 < 0 || i1 >= t.length) return v;
  var v0 = series[i0], v1 = series[i1];
  if(v0 == null || v1 == null || !isFinite(v0) || !isFinite(v1)) return v;
  var span = t[i1] - t[i0];
  if(!(span > 0)) return v0;
  return v0 + (v1 - v0) * ((dataX - t[i0]) / span);
}

function updateAtCursor(dataX){
  if(!VIEWER_DATA) return;
  var idx = cursorSampleIndex(dataX);
  if(showsCards()){
    VIEWER_SELECTED.forEach(function(ch){
      var card = document.querySelector('.dlv-card[data-card-ch="' + cssEscape(ch) + '"] [data-card-value]');
      if(!card) return;
      card.textContent = formatReadoutValue(valueAtCursor(ch, idx, dataX), ch);
    });
  }
  // showsGauges() is tab-level (mode==='gauge') regardless of sub-view, so it has to be paired with
  // the submode check here or the Default branch would fire even while Custom is what's on screen.
  if(showsGauges() && VIEWER_GAUGE_SUBMODE === 'default') updateGaugesAtIndex(idx, dataX);
  else if(showsCustomDash()) updateDashGauges(idx, dataX);
  else if(showsHistograms()){
    if(VIEWER_HIST_CTL && typeof VIEWER_HIST_CTL.setCursor === 'function') VIEWER_HIST_CTL.setCursor(dataX);
    updateHistDashGauges(idx, dataX);
  }
  // Live per-channel values in the left panel -- every channel rendered in the (possibly
  // search-filtered) table gets its value refreshed, not just the selected/graphed ones, per Ken's
  // request that every channel's value be visible at a glance without selecting it. Only the rows on
  // screen are written per move; see updateRowValues / watchVisibleRows.
  updateRowValues(idx, dataX);
  // In-graph legends (they replaced the per-graph header bar). Queried live rather than cached
  // because rebuildChart / renderViewerBody can replace these nodes underneath us.
  document.querySelectorAll('[data-legend-ch]').forEach(function(el){
    var lch = el.getAttribute('data-legend-ch');
    el.textContent = formatReadoutValue(valueAtCursor(lch, idx, dataX), lch);
  });
  // Race time and the scrubber playhead follow the CURSOR, not the nearest row -- snapping these to
  // sample times froze the playhead completely while the mouse crossed a sample's width, and made
  // the race clock read the same value for several pixels of travel.
  var cursorT = (dataX != null) ? dataX : VIEWER_DATA.time[idx];
  var raceEl = document.getElementById('dlvRaceValue');
  if(raceEl) raceEl.textContent = formatRaceTime(cursorT);
  updateScrubberPlayhead(cursorT);
}
function cssEscape(s){
  return (window.CSS && CSS.escape) ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

// ---- Cursor repaints ---------------------------------------------------------------------------
// A mouse reports 125-1000 positions a second, and each hover used to run updateAtCursor() plus a
// full chart.update('none') on EVERY panel -- measured at 20.4 ms with four panels, so the handler
// queue outran the frame budget and the whole window, pointer included, felt heavy (Ken, 2026-09-10:
// "moving my mouse around, there seems to be lag now ... need to make sure it's not overhead from
// the app slowing things down"; median frame 31 ms, worst 190 ms during an ordinary sweep).
//
// Two changes. The work is COALESCED into one animation frame, so a burst of moves paints once and
// intermediate positions are dropped (the last one is the only one anybody can see). And it calls
// render() instead of update(): the crosshair, the perf markers, the log-edge wash and the highlight
// spans are all drawn by plugins in afterDraw from module state, and nothing about the datasets or
// the scales changes when the cursor moves -- update('none') recomputes both at 18.2 ms for four
// panels against render()'s 0.58 ms. Anything that really does change a scale (setVisibleRange) or a
// dataset still calls update, as before.
function repaintCharts(){
  Object.keys(viewerCharts).forEach(function(k){
    var c = viewerCharts[k];
    if(c && c.ctx) c.render();   // ctx is nulled by destroy(); a pending frame must not touch that
  });
}
var CURSOR_PAINT_RAF = null;
var CURSOR_PAINT_AT = null;      // { x } while a paint is queued -- an OBJECT, because null is a real cursor value

// The CROSSHAIR and the READOUTS are paced separately, because they cost wildly different amounts.
// Moving the line is one clear and one stroke on its own canvas (0.12 ms), so it runs every frame and
// stays glued to the pointer. Refreshing the readouts writes into the channel table, and a table
// re-lays-out as a WHOLE -- with a real 524-channel HP Tuners log that is ~25 ms a frame even though
// only the ~20 rows on screen are written, because CSS containment does not apply to table rows
// (measured: 524 rows in the DOM = 25 ms, 3 rows = 4 ms; the list is next in line to render only what
// is visible, which removes this entirely).
//
// So the readouts are given a floor between refreshes, and only when they are actually expensive on
// this log: a cheap list keeps updating every frame exactly as before. A trailing refresh always runs
// when the pointer settles, so the numbers you read are never the ones from four frames ago.
var READOUT_COST_MS = 0;         // rolling estimate of one readout refresh
var READOUT_LAST_AT = 0;
var READOUT_TRAILER = null;
var READOUT_EXPENSIVE_MS = 6;    // above this, pace them
var READOUT_MIN_GAP_MS = 55;     // ~18 refreshes a second, which reads as live for numbers
function readoutsAreExpensive(){ return READOUT_COST_MS > READOUT_EXPENSIVE_MS; }
function runReadouts(dataX){
  var t0 = (window.performance && performance.now) ? performance.now() : 0;
  updateAtCursor(dataX);
  if(t0){
    var dt = performance.now() - t0;
    // Weighted so one slow frame (a GC pause, a background tab waking) cannot latch the pacing on.
    READOUT_COST_MS = READOUT_COST_MS ? (READOUT_COST_MS * 0.7 + dt * 0.3) : dt;
    READOUT_LAST_AT = performance.now();
  }
}
function paceReadouts(dataX){
  if(READOUT_TRAILER){ clearTimeout(READOUT_TRAILER); READOUT_TRAILER = null; }
  var now = (window.performance && performance.now) ? performance.now() : 0;
  if(!readoutsAreExpensive() || !now || (now - READOUT_LAST_AT) >= READOUT_MIN_GAP_MS){ runReadouts(dataX); return; }
  // Too soon: let the line move on its own and catch the numbers up when the pointer settles.
  READOUT_TRAILER = setTimeout(function(){
    READOUT_TRAILER = null;
    runReadouts(dataX);
  }, READOUT_MIN_GAP_MS - (now - READOUT_LAST_AT));
}
function runCursorPaint(){
  CURSOR_PAINT_RAF = null;
  var at = CURSOR_PAINT_AT;
  CURSOR_PAINT_AT = null;
  if(!at) return;
  drawCrosshairOverlays();   // the line, every frame -- the traces have not changed
  paceReadouts(at.x);        // the numbers, as fast as this log can afford
}
function paintCursor(dataX){
  CURSOR_PAINT_AT = { x: dataX };
  if(CURSOR_PAINT_RAF !== null) return;
  CURSOR_PAINT_RAF = (typeof requestAnimationFrame === 'function')
    ? requestAnimationFrame(runCursorPaint) : setTimeout(runCursorPaint, 16);
}
// Drag handlers get the same treatment for a different reason. setVisibleRange writes both scales and
// updates every panel -- measured at 9.8 ms with four -- which is real work it has to do; but a drag
// fires pointermove at the mouse's report rate, and no intermediate position of a drag is ever seen.
// So the newest value is applied once per frame and the rest are dropped. flush() exists for
// pointerup: the release must never be the position that gets discarded.
function frameCoalescer(apply){
  var raf = null, pending = null;
  function run(){
    raf = null;
    var p = pending; pending = null;
    if(p) apply.apply(null, p);
  }
  return {
    set: function(){
      pending = Array.prototype.slice.call(arguments);
      if(raf !== null) return;
      raf = (typeof requestAnimationFrame === 'function') ? requestAnimationFrame(run) : setTimeout(run, 16);
    },
    flush: function(){
      if(raf === null) return;
      if(typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf); else clearTimeout(raf);
      run();
    }
  };
}
// Called before the charts are destroyed / rebuilt, so a queued frame can't render a dead chart.
function cancelCursorPaint(){
  if(READOUT_TRAILER){ clearTimeout(READOUT_TRAILER); READOUT_TRAILER = null; }
  if(CURSOR_PAINT_RAF === null) return;
  if(typeof cancelAnimationFrame === 'function') cancelAnimationFrame(CURSOR_PAINT_RAF);
  else clearTimeout(CURSOR_PAINT_RAF);
  CURSOR_PAINT_RAF = null; CURSOR_PAINT_AT = null;
}
function handleChartHover(chart, e){
  var rect = chart.canvas.getBoundingClientRect();
  var dataX = chart.scales.x.getValueForPixel(e.clientX - rect.left);
  if(dataX == null || !isFinite(dataX)) return;
  CROSSHAIR_TIME = dataX;
  VIEWER_CURSOR_TIME = dataX;   // sticky: survives the pointer leaving the chart
  paintCursor(dataX);
}
function handleChartLeave(){
  CROSSHAIR_TIME = null;
  paintCursor(null);
}

// Propagates a zoom/pan change on one panel to the other, in data-value (seconds) space.
function syncZoom(sourceChart){
  if(VIEWER_SYNCING) return;
  VIEWER_SYNCING = true;
  try {
    // Through the one writer, so a plugin pan / wheel zoom gets the same bounds (overhang past the
    // ends, never wider than the log) as every other path. minFrac 0 keeps whatever depth the
    // wheel reached, as before.
    setVisibleRange(sourceChart.scales.x.min, sourceChart.scales.x.max, { minFrac: 0 });
  } finally { VIEWER_SYNCING = false; }
}

// ---------------------------------------------------------------------------------------------
// Visible time range -- the zoom window as one readable/settable/observable thing.
// The window lives in Chart.js (scales.x.min/max, kept identical across panels by syncZoom); these
// read it from the same panel updateScrubberWindow reads, so the API and the scrubber always agree.
// Returns { t0, t1, startIdx, endIdx, isFull } or null with no log open. Before the charts exist
// (no channel plotted yet) the window IS the whole log, so that is what is reported. startIdx/endIdx
// are the inclusive sample span with t0 <= time[i] <= t1 -- what a histogram or scorecard slices --
// derived from nearestTimeIndex (nearest, ties earlier) with the half-open corrections, and never
// inverted: a window that falls between two samples collapses to the single nearest one.
// ---------------------------------------------------------------------------------------------
function getVisibleRange(){
  if(!VIEWER_DATA || !VIEWER_DATA.time || !VIEWER_DATA.time.length) return null;
  var T = VIEWER_DATA.time, n = T.length;
  var fullMin = T[0], fullMax = T[n - 1];
  var t0 = fullMin, t1 = fullMax;
  // Any live panel will do (syncZoom keeps them identical) -- not just panel1/panel2, or a layout
  // with every channel on the lower graph reports the whole log while that graph is zoomed.
  var anyChart = null;
  Object.keys(viewerCharts).forEach(function(k){ if(!anyChart && viewerCharts[k]) anyChart = viewerCharts[k]; });
  if(anyChart && anyChart.scales && anyChart.scales.x){
    var m0 = anyChart.scales.x.min, m1 = anyChart.scales.x.max;
    if(m0 != null && m1 != null && isFinite(m0) && isFinite(m1)){ t0 = m0; t1 = m1; }
  }
  var i0 = nearestTimeIndex(T, t0); if(T[i0] < t0) i0++;
  var i1 = nearestTimeIndex(T, t1); if(T[i1] > t1) i1--;
  // Repeated timestamps: the search lands on ANY of the equal samples, so walk to the outermost.
  while(i0 > 0 && T[i0 - 1] >= t0) i0--;
  while(i1 < n - 1 && T[i1 + 1] <= t1) i1++;
  i0 = Math.max(0, Math.min(n - 1, i0));
  i1 = Math.max(0, Math.min(n - 1, i1));
  if(i1 < i0){ i0 = i1 = nearestTimeIndex(T, (t0 + t1) / 2); }
  var isFull = t0 <= fullMin + 1e-9 && t1 >= fullMax - 1e-9;   // the whole log is in view
  return { t0: t0, t1: t1, startIdx: i0, endIdx: i1, isFull: isFull };
}

// The ONE place the zoom window is written. Sorts, clamps to the log, floors the width (expanding
// about the centre, pushed back inside the log at either end), writes every panel and refreshes the
// scrubber -- which is also what notifies listeners. opts.minFrac overrides the width floor: the
// arrow-key zoom has always allowed a deeper zoom (0.0005) than the scrubber handles (0.004), and
// the scrubber pan must keep whatever width the wheel left it (0 = no floor), so each caller passes
// the floor it always had and its numbers do not change. Returns what the viewer now shows.
// The span a window of width w may occupy: the log plus an overhang at each end. The overhang is
// VIEWER_OVERSCROLL_FRAC of the width at a deep zoom (the last sample can be dragged to the middle
// of the graph) and tapers to zero as the window grows to the whole log, so a full zoom-out is
// always exactly the log and nothing ever jumps.
function visibleRangeBounds(w){
  var T = VIEWER_DATA.time, fullMin = T[0], fullMax = T[T.length - 1], R = fullMax - fullMin;
  var pad = (R > 0 && w > 0) ? VIEWER_OVERSCROLL_FRAC * w * Math.max(0, 1 - w / R) : 0;
  return { min: fullMin - pad, max: fullMax + pad, pad: pad };
}
function setVisibleRange(t0, t1, opts){
  if(!VIEWER_DATA || !VIEWER_DATA.time || !VIEWER_DATA.time.length) return null;
  var T = VIEWER_DATA.time, fullMin = T[0], fullMax = T[T.length - 1];
  var fullRange = fullMax - fullMin;
  t0 = +t0; t1 = +t1;
  if(!isFinite(t0) || !isFinite(t1)) return getVisibleRange();
  if(t1 < t0){ var swap = t0; t0 = t1; t1 = swap; }
  var minFrac = (opts && opts.minFrac != null) ? opts.minFrac : MIN_WINDOW_FRAC;
  var minW = fullRange * Math.max(0, Math.min(1, minFrac));
  // Width first: never wider than the log, never narrower than the floor (about the centre).
  var w = t1 - t0, mid = (t0 + t1) / 2;
  if(fullRange > 0 && w > fullRange) w = fullRange;
  if(fullRange > 0 && w < minW) w = minW;
  if(!(fullRange > 0)) w = 0;
  t0 = mid - w / 2; t1 = mid + w / 2;
  // Then position: inside the log plus the overhang this width earns (see visibleRangeBounds).
  var b = visibleRangeBounds(w);
  if(t0 < b.min){ t0 = b.min; t1 = t0 + w; }
  if(t1 > b.max){ t1 = b.max; t0 = t1 - w; }
  Object.keys(viewerCharts).forEach(function(k){
    var c = viewerCharts[k];
    if(!c) return;
    c.options.scales.x.min = t0;
    c.options.scales.x.max = t1;
    // The zoom plugin clamps its own drags/wheels against these; kept in step with the width so a
    // pan can overhang exactly as far as this function allows and no further.
    var lim = c.options.plugins && c.options.plugins.zoom && c.options.plugins.zoom.limits;
    if(lim && lim.x){ lim.x.min = b.min; lim.x.max = b.max; }
    c.update('none');
  });
  updateScrubberWindow();
  drawCrosshairOverlays();   // the window moved, so the cursor's pixel did too
  return getVisibleRange();
}

// Listeners get the getVisibleRange() result (null once the log is gone). Synchronous and
// un-debounced on purpose -- a drag notifies per pointer move -- so consumers coalesce themselves.
// A throwing listener is logged and skipped: a broken histogram must never break zooming.
function onVisibleRangeChange(fn){
  if(typeof fn === 'function' && VIEWER_RANGE_LISTENERS.indexOf(fn) === -1) VIEWER_RANGE_LISTENERS.push(fn);
}
function offVisibleRangeChange(fn){
  var i = VIEWER_RANGE_LISTENERS.indexOf(fn);
  if(i !== -1) VIEWER_RANGE_LISTENERS.splice(i, 1);
}
function notifyVisibleRangeChanged(){
  // A listener that calls setVisibleRange re-enters here via updateScrubberWindow; that nested
  // notify is dropped rather than fanned out again, or two such listeners would ping-pong forever.
  if(VIEWER_RANGE_NOTIFYING || !VIEWER_RANGE_LISTENERS.length) return;
  VIEWER_RANGE_NOTIFYING = true;
  try {
    var range = getVisibleRange();
    VIEWER_RANGE_LISTENERS.slice().forEach(function(fn){
      try { fn(range); }
      catch(err){ if(window.console) console.warn('Visible-range listener failed', err); }
    });
  } finally { VIEWER_RANGE_NOTIFYING = false; }
}

// Arrow-key zoom: Up zooms in, Down zooms out, centered on the last hovered cursor position.
function zoomAtPoint(factor){
  var anyChart = viewerCharts['panel1'] || viewerCharts['panel2'];
  if(!anyChart || !VIEWER_DATA || !VIEWER_DATA.time.length) return;
  var xScale = anyChart.scales.x;
  var curMin = xScale.min, curMax = xScale.max;
  var fullMin = VIEWER_DATA.time[0], fullMax = VIEWER_DATA.time[VIEWER_DATA.time.length - 1];
  var fullRange = fullMax - fullMin;
  if(fullRange <= 0) return;
  var center = (CROSSHAIR_TIME != null) ? CROSSHAIR_TIME : (curMin + curMax) / 2;
  var newRange = (curMax - curMin) * factor;
  if(newRange > fullRange) newRange = fullRange;
  if(newRange < fullRange * 0.0005) newRange = fullRange * 0.0005;
  var newMin = center - newRange / 2;
  var newMax = center + newRange / 2;
  // No clamp to the log here any more: setVisibleRange bounds the result (an overhang past the ends
  // is allowed, shrinking as the window grows), so zooming about a point near the finish line no
  // longer yanks the window back inside the log.
  // Own floor kept above (deeper than the scrubber's) and handed on, so the write path can't widen it.
  setVisibleRange(newMin, newMax, { minFrac: 0.0005 });
}
document.addEventListener('keydown', function(e){
  var overlay = document.getElementById('viewerOverlay');
  if(!overlay || !overlay.classList.contains('open')) return;
  // HIGH: this used to preventDefault() every arrow key unconditionally whenever the overlay was
  // open, so the caret could never move inside ANY text field while a log was open -- most visibly
  // the histogram editor's breakpoints/math/filter textareas and the toolbar's Min Hits input, where
  // typing a number was impossible. Arrow keys belong to the field the user is in, not to zoom/scrub.
  var t = e.target;
  if(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  if(e.key === 'ArrowUp'){ e.preventDefault(); zoomAtPoint(0.8); }
  else if(e.key === 'ArrowDown'){ e.preventDefault(); zoomAtPoint(1.25); }
  else if(e.key === 'ArrowLeft'){ e.preventDefault(); scrubCursorBySample(-1); }
  else if(e.key === 'ArrowRight'){ e.preventDefault(); scrubCursorBySample(1); }
});

// Left/Right arrow keys step the shared crosshair cursor one data sample at a time (rather than
// zooming, which is Up/Down) -- moves CROSSHAIR_TIME to the next/prev row's timestamp, updates the
// cards/gauges/channel-values/scrubber playhead via the same updateAtCursor() path as mouse hover,
// and nudges the crosshair plugin's redraw on both charts.
function scrubCursorBySample(dir){
  if(!VIEWER_DATA || !VIEWER_DATA.time.length) return;
  var idx = (CROSSHAIR_TIME != null) ? nearestTimeIndex(VIEWER_DATA.time, CROSSHAIR_TIME) : VIEWER_DATA.time.length - 1;
  idx += dir;
  if(idx < 0) idx = 0;
  if(idx > VIEWER_DATA.time.length - 1) idx = VIEWER_DATA.time.length - 1;
  CROSSHAIR_TIME = VIEWER_DATA.time[idx];
  VIEWER_CURSOR_TIME = CROSSHAIR_TIME;   // arrow-key stepping counts as placing the cursor
  cancelCursorPaint();
  updateAtCursor(CROSSHAIR_TIME);
  drawCrosshairOverlays();
}
['gesturestart', 'gesturechange', 'gestureend'].forEach(function(evt){
  document.addEventListener(evt, function(e){
    var overlay = document.getElementById('viewerOverlay');
    if(overlay && overlay.classList.contains('open')) e.preventDefault();
  });
});

// ---- Graph Y-axis: shared plot-area alignment + user min/max override -------------------------
// ALIGNMENT: each panel auto-fits its y-axis to its own label widths, so a wide-label channel (RPM
// "9000") and a narrow one ("100") give the panels different chartArea.left/right -- and the shared
// crosshair, drawn per-panel at getPixelForValue(time), then lands at a slightly different x on each
// graph (Ken, 2026-07-24, most visible on the 3-graph view). Fix: pin every panel's left and right
// y-axis to fixed widths via afterFit (set at config time, so no post-render re-layout that Chart.js
// recurses on), and reserve the same right margin on 1-channel panels (which have no right axis) via
// layout padding. Widths are generous enough for any realistic datalog label. Result: identical plot
// areas across panels, so the crosshair lines up.
var VIEWER_AXIS_W_L = 56, VIEWER_AXIS_W_R = 46;
function forceAxisWidth(scale){
  if(!scale.options || !scale.options.display) return;   // hidden axes (3rd+ channel) take no space
  if(scale.position === 'left')  scale.width = VIEWER_AXIS_W_L;
  else if(scale.position === 'right') scale.width = VIEWER_AXIS_W_R;
}

// USER MIN/MAX OVERRIDE: the y-axis auto-scales to a channel's full-log range, but on a launch log
// where the car was already on 2-step the RPM never drops, so the auto min sits too high (Ken,
// 2026-07-24). Right-click a graph -> set an explicit min/max per channel; stored here (keyed by raw
// channel name so it's stable) and used in the scale config, cleared back to auto on demand.
var VIEWER_AXIS_OVERRIDE = {};   // channel -> { min, max }

// Builds the two Chart.js panels (Upper=panel1, Lower=panel2), splitting selected channels by
// VIEWER_PANEL_ASSIGN. Kept close to the original implementation -- only the container ids and a
// call into updateScrubberWindow()/renderGraphHeadHtml() are new.
function rebuildChart(){
  cancelCursorPaint();   // same reason as renderViewerBody: the charts are destroyed a few lines down
  // Capture the zoom window BEFORE the old charts are destroyed, so a rebuild triggered by a layout
  // change (add channel, reassign panel, add a comparison) can restore it rather than snapping to full.
  var prevMin = null, prevMax = null;
  var prevAny = viewerCharts['panel1'] || viewerCharts['panel2'];
  if(prevAny && prevAny.scales && prevAny.scales.x){ prevMin = prevAny.scales.x.min; prevMax = prevAny.scales.x.max; }
  Object.keys(viewerCharts).forEach(function(k){ if(viewerCharts[k]) viewerCharts[k].destroy(); });
  viewerCharts = {};
  var slots = activeGraphSlots();
  if(!VIEWER_DATA || !VIEWER_SELECTED.length){
    slots.forEach(function(slot){ var el = document.getElementById('dlvCanvasWrap' + slot); if(el) el.innerHTML = '<div class="dlv-loading">Select a channel to plot.</div>'; });
    updateAtCursor(null);
    drawScrubber();
    return;
  }
  var fullMin = VIEWER_DATA.time[0], fullMax = VIEWER_DATA.time[VIEWER_DATA.time.length - 1];
  // Same log (range unchanged) + a real prior zoom (inside the range, narrower than full) => keep it.
  // A different range means a new log was loaded, where full-range is correct.
  var viewMin = fullMin, viewMax = fullMax;
  var sameLog = CHART_TIME_RANGE && CHART_TIME_RANGE[0] === fullMin && CHART_TIME_RANGE[1] === fullMax;
  if(sameLog && prevMin != null && prevMax != null && isFinite(prevMin) && isFinite(prevMax) &&
     (prevMax - prevMin) > 0 && (prevMax - prevMin) < (fullMax - fullMin) - 1e-9){
    viewMin = Math.max(fullMin, prevMin);
    viewMax = Math.min(fullMax, prevMax);
  }
  CHART_TIME_RANGE = [fullMin, fullMax];
  var panelDefs = slots.map(function(slot){
    return { num: slot, wrapId: 'dlvCanvasWrap' + slot, channels: channelsForSlot(slot, slots) };
  });
  var lastNonEmptyPanelNum = 0;
  panelDefs.forEach(function(p){ if(p.channels.length) lastNonEmptyPanelNum = p.num; });

  panelDefs.forEach(function(panelDef){
    var wrap = document.getElementById(panelDef.wrapId);
    if(!wrap) return;
    if(!panelDef.channels.length){ wrap.innerHTML = '<div class="dlv-loading">No channels assigned.</div>'; return; }
    wrap.innerHTML = '<canvas></canvas>';
    var canvas = wrap.querySelector('canvas');
    crosshairCanvasFor(wrap);   // the crosshair's own layer, above the traces (see drawCrosshairOverlays)

    var datasets = compareDatasetsFor(panelDef.channels).concat(panelDef.channels.map(function(ch){
      var color = channelColor(ch);
      var vals = VIEWER_DATA.series[ch] || [];
      var levels = textLevelsFor(ch);
      return {
        label: ch, borderColor: color, backgroundColor: color, borderWidth: 1.4, pointRadius: 0,
        // pointRadius:0 only hides points at REST. Chart.js still draws the hovered one at its
        // default hoverRadius of 4, and "hovered" means NEAREST SAMPLE -- so a dot appeared on each
        // trace and jumped sample to sample while the crosshair line moved smoothly. It read as the
        // cursor being broken even though the readouts were fine (Ken, 2026-07-22). The crosshair
        // line IS the cursor here; a second, snapping indicator only contradicts it.
        pointHoverRadius: 0,
        hoverRadius: 0,
        // A categorical channel holds a state until it changes -- it does not ramp between states.
        // Drawing it stepped (and un-smoothed) is the difference between "the ECU switched to
        // Borderline at 42.3s" and a diagonal line implying a gradual transition that never happened.
        stepped: levels ? 'before' : false,
        tension: levels ? 0 : 0.12,
        data: VIEWER_DATA.time.map(function(t, idx){ return { x: t, y: vals[idx] }; }),
        yAxisID: ch,
      };
    }));
    var scales = {
      x: {
        type: 'linear', min: viewMin, max: viewMax,
        // Minor gridlines are drawn dimmer than the labelled ones, so the numbered lines still read
        // as the structure and the subdivisions sit behind them.
        grid: {
          color: function(ctx){
            var t = ctx.tick;
            return (t && t.$minor) ? '#191920' : '#26262c';
          },
          tickLength: 6,
          tickColor: function(ctx){
            var t = ctx.tick;
            return (t && t.$minor) ? '#33333d' : '#4a4a54';
          },
        },
        title: { display: panelDef.num === lastNonEmptyPanelNum, text: raceAxisTitle(), color: '#9a9aa2' },
        ticks: {
          color: '#9a9aa2', maxTicksLimit: 8, autoSkip: true,
          // Race labels are one size down: they're denser than a normal axis by design, and the
          // smaller face is what buys the extra label slots without crowding.
          font: function(ctx){ return { size: (VIEWER_RACE_ZERO != null) ? 10 : 12 }; },
          // Reads VIEWER_RACE_ZERO at draw time, so toggling race mode needs only chart.update().
          // Minor subdivisions carry no label -- they exist to be measured against, not read.
          callback: function(v, i){
            if(VIEWER_RACE_ZERO == null){
              // Plain seconds, formatted to a span-based decimal count. The raw axis value here is a
              // full-precision float -- a wheel-zoom leaves min/max like 43.7183329999995 -- and
              // returning it printed a 15-digit label at the axis edge (Ken, 2026-07-22). Beyond just
              // looking broken, the width that giant label reserved shifted the plot for a frame on
              // the first zoom in and out. A bounded label keeps the axis width stable.
              var sp = this.chart.scales.x.max - this.chart.scales.x.min;
              var dec = sp >= 20 ? 0 : sp >= 4 ? 1 : sp >= 0.4 ? 2 : 3;
              return (+v).toFixed(dec);
            }
            var t = this.chart.scales.x.ticks[i];
            if(t && t.$minor) return '';
            return formatAxisTime(v, this.chart.$raceStep);
          },
        },
        // Only takes over when a zero point exists; otherwise Chart.js's own ticks are left alone.
        afterBuildTicks: function(axis){
          if(VIEWER_RACE_ZERO == null){
            axis.chart.$raceStep = null;
            axis.options.ticks.autoSkip = true;      // hand spacing back to Chart.js
            axis.options.ticks.maxTicksLimit = 8;
            return;
          }
          var span = axis.max - axis.min;
          if(!(span > 0)) return;
          // autoSkip and maxTicksLimit MUST be off here. They thin an already-deliberate set --
          // which halved the spacing and, worse, dropped the 0.0 tick, so the one line you actually
          // navigate by was missing from the race axis. raceTickStep already guarantees the labels
          // have room, so there is nothing left to skip.
          axis.options.ticks.autoSkip = false;
          axis.options.ticks.maxTicksLimit = undefined;
          var step = raceTickStep(span, axis.width);
          axis.chart.$raceStep = step;
          // Walk outward from the zero point so ticks land on round RACE values. Emitted at the
          // MINOR interval, with every Nth flagged as a labelled major -- one tick list gives both
          // the numbers and the gradations between them.
          var minor = step / RACE_MINOR_PER_MAJOR;
          var firstIdx = Math.ceil((axis.min - VIEWER_RACE_ZERO) / minor);
          var out = [];
          for(var k = firstIdx; VIEWER_RACE_ZERO + k * minor <= axis.max + 1e-9; k++){
            out.push({
              value: VIEWER_RACE_ZERO + k * minor,
              // exact because k is an integer count of minors, not an accumulated float sum
              $minor: (k % RACE_MINOR_PER_MAJOR) !== 0,
            });
            if(out.length > 600) break;   // guard against a pathological span/step
          }
          axis.ticks = out;
        },
      },
    };
    panelDef.channels.forEach(function(ch, i){
      var color = channelColor(ch);
      var levels = textLevelsFor(ch);
      scales[ch] = { type: 'linear', position: i % 2 === 0 ? 'left' : 'right', display: i < 2, afterFit: forceAxisWidth, ticks: { color: color, maxTicksLimit: 5, font: { size: 10 } }, grid: { drawOnChartArea: i === 0, color: '#20202a' } };
      if(levels){
        // Pin the axis to the level range and print the labels instead of the indices -- the raw
        // numbers are an implementation detail and mean nothing to a tuner. Padded by half a step
        // so the top and bottom states aren't drawn on the axis edge.
        scales[ch].min = -0.5;
        scales[ch].max = levels.length - 0.5;
        scales[ch].ticks.callback = function(v){
          return (Number.isInteger(v) && levels[v] != null) ? levels[v] : '';
        };
        // One tick per state is right for a real state channel (a handful of levels) and wrong for
        // a column that merely happens to be non-numeric. A free-text column -- a session tag, a
        // timestamp -- can have a distinct value on every row: forcing a tick per level asked
        // Chart.js for 3,197 axis labels and took ~2.6s to lay out. Above the cap, fall back to
        // normal auto-skipped ticks; the labels still print, there are just fewer of them.
        if(levels.length <= MAX_LABELLED_LEVELS){
          scales[ch].ticks.stepSize = 1;
          scales[ch].ticks.autoSkip = false;
          scales[ch].ticks.maxTicksLimit = undefined;
          scales[ch].afterBuildTicks = function(axis){
            axis.ticks = levels.map(function(_, li){ return { value: li }; });
          };
        }
      } else {
        // Lock the numeric axis to the channel's FULL-log range (padded), so zooming the x-axis
        // does NOT rescale y (Ken, 2026-07-22): the auto-fit-to-visible behaviour made RPM and every
        // other trace jump scale on every zoom, which reads as the graph breaking. VIEWER_CHANNEL_STATS
        // is the whole-log min/max computed once at load, so the axis a channel gets zoomed OUT is the
        // axis it keeps zoomed in. (Drag-to-adjust the axis is a separate, later step.)
        var ov = VIEWER_AXIS_OVERRIDE[ch];
        if(ov && isFinite(ov.min) && isFinite(ov.max) && ov.max > ov.min){
          // The user pinned this axis (right-click -> Set range). Their numbers win over auto-scale.
          scales[ch].min = ov.min;
          scales[ch].max = ov.max;
        } else {
          var st = VIEWER_CHANNEL_STATS[ch];
          if(st && isFinite(st.min) && isFinite(st.max)){
            var range = st.max - st.min;
            var base = range > 0 ? range : (Math.abs(st.max) || 1);
            // MORE headroom above the max than below (Ken): the peak (e.g. max RPM) shouldn't sit jammed
            // against the top margin. 12% over the top, 5% under the bottom.
            var lo = st.min - base * 0.05, hi = st.max + base * 0.12;
            if(st.min >= 0 && lo < 0) lo = 0;   // don't invent negative space for a non-negative channel
            scales[ch].min = lo;
            scales[ch].max = hi;
          }
        }
      }
    });

    var chart = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: { datasets: datasets },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        // A 1-channel panel has no right axis; reserve the same right margin a right axis would take
        // so its plot area (and the crosshair) lines up with 2-channel panels. See forceAxisWidth.
        layout: { padding: { right: panelDef.channels.length >= 2 ? 0 : VIEWER_AXIS_W_R } },
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: { enabled: false },
          zoom: {
            // Refreshed on every range write (setVisibleRange): the window may overhang the log's ends
            // by up to half its width, so these move with the zoom depth. maxRange (plugin v2.1+) stops
            // a wheel zoom-out from ever showing more than the log; the writer caps the width anyway.
            limits: { x: { min: fullMin, max: fullMax, maxRange: (fullMax - fullMin) || undefined } },
            pan: {
              enabled: true, mode: 'x',
              onPanStart: function(ctx){
                var evt = ctx.event;
                if(evt && evt.pointerType === 'touch' && (!evt.pointers || evt.pointers.length < 2)) return false;
              },
              // The crosshair marks a TIME, so while the traces slide under a pan its pixel moves.
              // Redrawing the overlay per pan event keeps the line welded to the data instead of to
              // the screen (it costs 0.12 ms; the range write still waits for the drag to finish).
              onPan: function(){ drawCrosshairOverlays(); },
              onPanComplete: function(ctx){ syncZoom(ctx.chart); },
            },
            zoom: {
              wheel: { enabled: true },
              drag: { enabled: true, modifierKey: 'shift', backgroundColor: 'rgba(209,19,46,0.15)' },
              pinch: { enabled: true },
              mode: 'x',
              onZoom: function(){ drawCrosshairOverlays(); },
              onZoomComplete: function(ctx){ syncZoom(ctx.chart); },
            },
          },
        },
        scales: scales,
      },
    });
    viewerCharts['panel' + panelDef.num] = chart;
    canvas.addEventListener('mousemove', function(e){ handleChartHover(chart, e); });
    canvas.addEventListener('mouseleave', handleChartLeave);
    // Right-click sets the RACE ZERO exactly where you point -- no travel to a button, so the
    // crosshair can't drift off the spot you meant on the way there. Mobile is excluded: the
    // feature is desktop-only and a long-press there would fight the chart's own touch handling.
    canvas.addEventListener('contextmenu', function(e){
      if(isMobileViewer()) return;
      e.preventDefault();
      var rect = chart.canvas.getBoundingClientRect();
      var dataX = chart.scales.x.getValueForPixel(e.clientX - rect.left);
      if(dataX == null || !isFinite(dataX)) return;
      openGraphMenu(e, dataX, panelDef.channels, chart);
    });
    canvas.addEventListener('touchstart', function(e){ if(e.touches && e.touches[0]) handleChartHover(chart, e.touches[0]); }, { passive: true });
    canvas.addEventListener('touchmove', function(e){ if(e.touches && e.touches[0]) handleChartHover(chart, e.touches[0]); }, { passive: true });
  });
  updateAtCursor(null);
  drawScrubber();
  // drawScrubber reaches updateScrubberWindow (and so the notify) ONLY when the scrubber markup is
  // in the DOM. Notify here just for the layout where it is not, rather than unconditionally --
  // otherwise every rebuild told listeners twice and each one recomputed its tables twice.
  if(!document.getElementById('dlvScrubberWrap')) notifyVisibleRangeChanged();
}

// ---------------------------------------------------------------------------------------------
// Bottom overview scrubber -- new in this redesign. A decimated sparkline of one representative
// selected channel across the FULL time range, with a shaded rect showing the current zoom window
// (kept in sync with the main charts via updateScrubberWindow, called from syncZoom/zoomAtPoint/
// Reset Zoom) and a thin playhead line at the current cursor time. Dragging the window pans both
// main charts; the +/- buttons reuse the exact same zoomAtPoint used for arrow-key zoom.
// ---------------------------------------------------------------------------------------------
function scrubberRepresentativeChannel(){
  // Categorical channels are skipped: the overview trace is meant to show the shape of the run at a
  // glance, and a staircase of level indices reads as noise. Falls back to one only if that's all
  // the user has selected.
  var numeric = VIEWER_SELECTED.filter(function(c){ return !isTextChannel(c); });
  var pool = numeric.length ? numeric : VIEWER_SELECTED;
  var upperFirst = pool.filter(function(c){ return (VIEWER_PANEL_ASSIGN[c]||1) === 1; })[0];
  return upperFirst || pool[0] || null;
}
function drawScrubber(){
  var canvas = document.getElementById('dlvScrubberCanvas');
  if(!canvas || !VIEWER_DATA) return;
  var wrap = document.getElementById('dlvScrubberWrap');
  var w = wrap.clientWidth || 600, h = wrap.clientHeight || 56;
  canvas.width = w; canvas.height = h;
  var ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  var ch = scrubberRepresentativeChannel();
  if(!ch){ updateScrubberWindow(); return; }
  var vals = VIEWER_DATA.series[ch] || [];
  var min = Infinity, max = -Infinity;
  for(var i = 0; i < vals.length; i++){ var v = vals[i]; if(v!=null && isFinite(v)){ if(v<min)min=v; if(v>max)max=v; } }
  if(!isFinite(min) || !isFinite(max) || min === max){ min = 0; max = 1; }
  ctx.beginPath();
  ctx.strokeStyle = channelColor(ch);
  ctx.lineWidth = 1;
  var n = vals.length;
  var step = Math.max(1, Math.floor(n / w));
  for(var x = 0; x < n; x += step){
    var v2 = vals[x]; if(v2 == null || !isFinite(v2)) continue;
    var px = (x / (n - 1)) * w;
    var py = h - ((v2 - min) / (max - min)) * h;
    if(x === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.stroke();
  updateScrubberWindow();
}
function updateScrubberWindow(){
  // Every zoom/pan/reset/rebuild in this file ends here, which makes it the one place to tell range
  // listeners -- BEFORE the DOM check, so they still hear it in a layout with no scrubber.
  notifyVisibleRangeChanged();
  var wrap = document.getElementById('dlvScrubberWrap');
  var winEl = document.getElementById('dlvScrubberWindow');
  if(!wrap || !winEl || !VIEWER_DATA || !VIEWER_DATA.time.length) return;
  var anyChart = viewerCharts['panel1'] || viewerCharts['panel2'];
  var fullMin = VIEWER_DATA.time[0], fullMax = VIEWER_DATA.time[VIEWER_DATA.time.length - 1];
  var fullRange = fullMax - fullMin || 1;
  var w = wrap.clientWidth || 600;
  var curMin = fullMin, curMax = fullMax;
  if(anyChart && anyChart.scales && anyChart.scales.x){ curMin = anyChart.scales.x.min; curMax = anyChart.scales.x.max; }
  var left = ((curMin - fullMin) / fullRange) * w;
  var right = ((curMax - fullMin) / fullRange) * w;
  // Floor the drawn width so a hard zoom always leaves a grabbable body between the two edge
  // handles -- at the true width the window can be 2px and there is nothing left to drag.
  // Applied HERE, not as a CSS min-width: the floor has to push the LEFT edge back when the window
  // is against the right end, or it overflows the wrap, gets clipped by overflow:hidden, and stops
  // being hit-testable exactly where it was widened to stay usable.
  var MIN_PX = 36;
  var width = Math.max(2, right - left);
  if(width < MIN_PX){
    width = Math.min(MIN_PX, w);
    if(left + width > w) left = Math.max(0, w - width);
  }
  // A window overhanging the log (setVisibleRange) is drawn where it is -- partly outside the bar,
  // clipped by the wrap's overflow -- rather than shoved back inside, so the bar agrees with the graph.
  winEl.style.left = left + 'px';
  winEl.style.width = width + 'px';
}
function updateScrubberPlayhead(t){
  var wrap = document.getElementById('dlvScrubberWrap');
  var ph = document.getElementById('dlvScrubberPlayhead');
  if(!wrap || !ph || !VIEWER_DATA || !VIEWER_DATA.time.length || t == null) { if(ph) ph.style.display = 'none'; return; }
  var fullMin = VIEWER_DATA.time[0], fullMax = VIEWER_DATA.time[VIEWER_DATA.time.length - 1];
  var fullRange = fullMax - fullMin || 1;
  var w = wrap.clientWidth || 600;
  ph.style.display = '';
  ph.style.left = (((t - fullMin) / fullRange) * w) + 'px';
}
// Crossing the mobile breakpoint changes the layout AND the graph count, neither of which a plain
// chart resize can produce -- rotating a phone, or dragging a desktop window narrow, has to rebuild
// the body. Only fires on an actual crossing, so ordinary resizing stays cheap.
// ---- Mobile fullscreen ----------------------------------------------------------------------
// Chrome's address bar costs ~15% of an already-412px-tall landscape phone, so fullscreen is worth
// real effort. It CANNOT be forced: requestFullscreen() needs transient user activation, and an
// orientationchange/resize handler carries none -- the browser rejects it. (Deliberate: otherwise
// any page could seize the screen on load.)
//
// So we piggyback on the first tap the user makes anyway. That is a genuine gesture, so it is
// allowed, and it feels automatic because nobody has to find a button. If they then LEAVE
// fullscreen we take that as a decision and stop asking -- re-grabbing the screen after someone
// deliberately escaped it is hostile.
//
// iOS Safari does not implement the Fullscreen API for non-video elements at all, so on iPhone
// this silently does nothing and the small button remains the only (also non-working) route --
// nothing breaks, the address bar just stays.
// ---- "View channels" hint --------------------------------------------------------------------
// The drawer opens collapsed so the graph owns the screen, which means nothing on screen says the
// channel list exists -- and picking channels is the main thing a user came to do. A brief pointer
// at the button on load solves that without permanent chrome. Shown once per opened log (not per
// re-render, or every filter keystroke would re-summon it) and dismissed early by the first tap of
// the button, since at that point it has done its job.
var VIEWER_HINT_DONE = false;
function showChannelHint(){
  if(VIEWER_HINT_DONE || isPortraitBlocked() || !VIEWER_LEFT_COLLAPSED) return;
  VIEWER_HINT_DONE = true;
  var body = document.querySelector('.dlv-body');
  if(!body) return;
  var hint = document.createElement('div');
  hint.className = 'dlv-channel-hint';
  hint.id = 'dlvChannelHint';
  hint.innerHTML = '<span class="dlv-channel-hint-arrow">&#8592;</span> View channels';
  body.appendChild(hint);
  var kill = function(){
    if(!hint.parentNode) return;
    hint.classList.add('dlv-hint-out');
    // must outlast the .4s fade-out transition, or it vanishes mid-fade
    setTimeout(function(){ if(hint.parentNode) hint.parentNode.removeChild(hint); }, 500);
  };
  // Erring short on purpose (Ken): it's a hint, not a notice. Two words don't need dwell time, and
  // an overstaying hint on a 412px screen is worse than one you half-catch -- the button it points
  // at is red and permanent, so anyone who misses this still finds it.
  setTimeout(kill, 1500);
  var btn = document.getElementById('dlvCollapseBtn');
  if(btn) btn.addEventListener('click', kill, { once: true });
}

// ---- Mobile fullscreen: BUTTON ONLY ----------------------------------------------------------
// An earlier build entered fullscreen on the user's first tap anywhere. It was technically neat --
// requestFullscreen() needs a real user gesture and rotating the phone doesn't provide one, so
// piggybacking on a tap was the only way to make it feel automatic -- but it read as the app
// seizing the screen unprompted. Removed: the user asks, or it doesn't happen (Ken, 2026-07-21).
//
// Once fullscreen, the button hides itself. There's nothing left for it to do (the system swipe /
// back gesture is how you leave), and on a 412px-tall screen any control not earning its place is
// costing graph.
//
// iOS Safari doesn't implement the Fullscreen API for non-video elements, so there the button is
// hidden rather than offered and silently doing nothing.
var VIEWER_FS_WIRED = false;
function wireMobileFullscreen(){
  function sync(){
    var c = document.getElementById('viewerContent');
    if(!c) return;
    c.classList.toggle('dlv-fs-on', !!document.fullscreenElement);
    // no Fullscreen API (iOS) -> don't offer a button that can't work
    c.classList.toggle('dlv-fs-unsupported', !document.documentElement.requestFullscreen);
  }
  sync();
  if(VIEWER_FS_WIRED) return;
  VIEWER_FS_WIRED = true;
  document.addEventListener('fullscreenchange', sync);
}

// ---- First-run walkthrough --------------------------------------------------------------------
// The mobile build is deliberately stripped -- no header, no labels -- which is right for a 412px
// screen but leaves nothing explaining itself. Ken missed the fullscreen button entirely, and he
// designed it. This is the honest fix: four paced steps, once ever, instead of an ever-growing pile
// of one-off hints firing at each other on load (the channels and fullscreen hints used to appear
// simultaneously at opposite corners -- this replaces both).
//
// Order follows use, not importance: pick channels -> zoom in -> now move around -> more room.
// The slider step sits right after pinch because it answers the question pinch creates.
//
// Every target is measured at runtime rather than positioned from constants: this layout moves
// (drawer, keypad, fullscreen), and coach marks pinned to hardcoded coordinates would drift.
var TOUR_KEY = 'pbdDlvTourDone';
var VIEWER_TOUR_ACTIVE = false;
function tourDone(){
  try{ return localStorage.getItem(TOUR_KEY) === '1'; }catch(e){ return false; }
}
function markTourDone(){
  try{ localStorage.setItem(TOUR_KEY, '1'); }catch(e){}
}
function tourSteps(){
  return [
    { sel:'#dlvCollapseBtn', pad:8,
      title:'Pick your channels',
      body:'Tap here to open the channel list and choose what to graph.' },
    { sel:'#dlvCanvasWrap1', pad:0,
      title:'Pinch to zoom',
      body:'Use two fingers on the graph to zoom in and out. Drag with one finger to move the cursor.' },
    { sel:'#dlvScrubberWrap', pad:6,
      title:'Slide to move',
      body:'Once zoomed in, drag the red bar to move along the log.' },
    { sel:'#dlvFullscreenBtn', pad:8,
      title:'Go full screen',
      body:'Hides the address bar and gives the graph more room.' }
  ];
}
function endTour(el){
  VIEWER_TOUR_ACTIVE = false;
  markTourDone();
  // The tour already covered fullscreen, so the standalone reminder would just be a repeat. Also
  // true when skipped -- skipping means "stop telling me things", and honouring that is the point.
  markFsHintDone();
  if(el && el.parentNode) el.parentNode.removeChild(el);
}
function startTour(){
  if(tourDone() || VIEWER_TOUR_ACTIVE) return;
  if(!isMobileViewer() || isPortraitBlocked()) return;
  var body = document.querySelector('.dlv-body');
  if(!body) return;
  // Drop steps whose target isn't on screen -- e.g. the fullscreen button is hidden on iOS, and a
  // spotlight on nothing is worse than one step fewer.
  var steps = tourSteps().filter(function(s){
    var t = document.querySelector(s.sel);
    return t && t.getBoundingClientRect().width > 0 && getComputedStyle(t).display !== 'none';
  });
  if(!steps.length) return;

  VIEWER_TOUR_ACTIVE = true;
  var root = document.createElement('div');
  root.className = 'dlv-tour';
  root.id = 'dlvTour';
  root.innerHTML =
    '<div class="dlv-tour-spot" id="dlvTourSpot"></div>' +
    '<div class="dlv-tour-card" id="dlvTourCard">' +
      '<div class="dlv-tour-step" id="dlvTourStep"></div>' +
      '<div class="dlv-tour-title" id="dlvTourTitle"></div>' +
      '<div class="dlv-tour-body" id="dlvTourBody"></div>' +
      '<div class="dlv-tour-acts">' +
        '<button type="button" class="dlv-tour-skip" id="dlvTourSkip">Skip</button>' +
        '<button type="button" class="dlv-tour-next" id="dlvTourNext">Next</button>' +
      '</div>' +
    '</div>';
  body.appendChild(root);

  var i = 0;
  var spot = root.querySelector('#dlvTourSpot');
  var card = root.querySelector('#dlvTourCard');
  function paint(){
    var s = steps[i];
    var t = document.querySelector(s.sel);
    if(!t){ endTour(root); return; }
    var b = t.getBoundingClientRect();
    var host = body.getBoundingClientRect();
    var pad = s.pad || 0;
    var top = b.top - host.top - pad, left = b.left - host.left - pad;
    spot.style.top = top + 'px';
    spot.style.left = left + 'px';
    spot.style.width = (b.width + pad * 2) + 'px';
    spot.style.height = (b.height + pad * 2) + 'px';

    root.querySelector('#dlvTourStep').textContent = (i + 1) + ' of ' + steps.length;
    root.querySelector('#dlvTourTitle').textContent = s.title;
    root.querySelector('#dlvTourBody').textContent = s.body;
    root.querySelector('#dlvTourNext').textContent = (i === steps.length - 1) ? 'Done' : 'Next';

    // The card sits NEXT TO the thing it describes, not in the opposite corner (Ken, 2026-07-22).
    // Parking it in the far half meant your eye had to cross the screen to connect the words to the
    // highlight -- and on step 1 the channels button is a 52px target in the corner, so the link
    // was easy to miss entirely. Preference order: below the spot, then above, then beside; each
    // only if it actually fits, then clamped on screen.
    card.style.top = ''; card.style.bottom = ''; card.style.left = ''; card.style.right = '';
    card.classList.remove('dlv-arrow-up','dlv-arrow-down','dlv-arrow-left','dlv-arrow-right');
    var sw = b.width + pad * 2, sh = b.height + pad * 2;
    var cw = card.offsetWidth || 260, ch = card.offsetHeight || 120;
    var gap = 14;
    var cx, cy, dir;
    if(top + sh + gap + ch <= host.height){            // below the spot
      cy = top + sh + gap; cx = left + sw / 2 - cw / 2; dir = 'up';
    } else if(top - gap - ch >= 0){                     // above it
      cy = top - gap - ch; cx = left + sw / 2 - cw / 2; dir = 'down';
    } else if(left + sw + gap + cw <= host.width){      // to its right
      cx = left + sw + gap; cy = top + sh / 2 - ch / 2; dir = 'left';
    } else {                                            // to its left
      cx = left - gap - cw; cy = top + sh / 2 - ch / 2; dir = 'right';
    }
    card.style.left = Math.max(8, Math.min(cx, host.width - cw - 8)) + 'px';
    card.style.top = Math.max(8, Math.min(cy, host.height - ch - 8)) + 'px';
    card.classList.add('dlv-arrow-' + dir);             // arrow points back at the spotlight
  }
  root.querySelector('#dlvTourSkip').addEventListener('click', function(){ endTour(root); });
  // Tapping the dimmed area advances too. Partly because it's what people instinctively do, and
  // partly as a safety valve: this scrim covers the whole screen, so if anything ever went wrong
  // with the buttons the app would be unusable with no way out. Any tap must lead somewhere.
  root.addEventListener('click', function(e){
    if(card.contains(e.target)) return;
    i++;
    if(i >= steps.length){ endTour(root); return; }
    paint();
  });
  root.querySelector('#dlvTourNext').addEventListener('click', function(){
    i++;
    if(i >= steps.length){ endTour(root); return; }
    paint();
  });
  paint();
  // Layout can move under us (rotation, address bar collapsing) -- re-measure rather than drift.
  window.addEventListener('resize', function(){ if(VIEWER_TOUR_ACTIVE) paint(); });
}

// ---- First-run fullscreen reminder ------------------------------------------------------------
// The button is 38x26 in the bottom-right corner and Ken missed it entirely -- reasonable, since
// nothing about a small glyph beside the scrubber says "reclaim a fifth of your screen". This calls
// it out once, hard, then never again: it's remembered in localStorage keyed on having actually
// USED fullscreen, so a user who ignores it still gets reminded next time, and one who uses it is
// never nagged. Bigger and longer-lived than the channels hint because it's genuinely once-ever.
var FS_HINT_KEY = 'pbdDlvFullscreenHintDone';
function fsHintDone(){
  try{ return localStorage.getItem(FS_HINT_KEY) === '1'; }catch(e){ return false; }   // private mode
}
function markFsHintDone(){
  try{ localStorage.setItem(FS_HINT_KEY, '1'); }catch(e){}
}
function showFullscreenHint(){
  if(fsHintDone() || isPortraitBlocked()) return;
  if(!document.documentElement.requestFullscreen) return;   // iOS: nothing to point at
  if(document.fullscreenElement) return;
  var btn = document.getElementById('dlvFullscreenBtn');
  var main = document.querySelector('.dlv-main');
  if(!btn || !main) return;
  var hint = document.createElement('div');
  hint.className = 'dlv-fs-hint';
  hint.id = 'dlvFsHint';
  hint.innerHTML = '<div class="dlv-fs-hint-text">Tap for full screen</div>' +
                   '<div class="dlv-fs-hint-sub">Hides the address bar</div>' +
                   '<div class="dlv-fs-hint-arrow">&#8600;</div>';
  main.appendChild(hint);
  var kill = function(){
    if(!hint.parentNode) return;
    hint.classList.add('dlv-hint-out');
    setTimeout(function(){ if(hint.parentNode) hint.parentNode.removeChild(hint); }, 500);
  };
  setTimeout(kill, 5000);
  // Using it is the real dismissal -- that's when the user has learned it exists.
  btn.addEventListener('click', function(){ markFsHintDone(); kill(); }, { once: true });
}

var VIEWER_LAYOUT_KEY = null;
function currentLayoutKey(){
  return (isMobileViewer() ? 'm' : 'd') + (isPortraitBlocked() ? 'p' : 'l');
}
function watchMobileBreakpoint(){
  VIEWER_LAYOUT_KEY = currentLayoutKey();
  function check(){
    if(!VIEWER_DATA) return;
    var k = currentLayoutKey();
    if(k === VIEWER_LAYOUT_KEY) return;   // ordinary resizes stay cheap
    var wasBlocked = VIEWER_LAYOUT_KEY.charAt(1) === 'p';
    VIEWER_LAYOUT_KEY = k;
    if(k.charAt(0) === 'm') VIEWER_LEFT_COLLAPSED = true;
    renderViewerBody();
    // Coming back from the portrait prompt there were no charts to resize, and Chart.js sized
    // itself against whatever the container was mid-rotation -- one more pass once the browser has
    // settled on the new viewport.
    if(wasBlocked) setTimeout(function(){ resizeViewerCharts(); drawScrubber(); }, 120);
  }
  window.addEventListener('resize', check);
  // iOS Safari fires orientationchange before resize settles, and sometimes reports stale
  // dimensions in the handler itself -- defer past the rotation animation.
  window.addEventListener('orientationchange', function(){ setTimeout(check, 180); });
}

function wireScrubberEvents(){
  var wrap = document.getElementById('dlvScrubberWrap');
  var winEl = document.getElementById('dlvScrubberWindow');
  if(!wrap) return;
  window.addEventListener('resize', drawScrubber);

  var dragging = false, dragStartX = 0, dragStartLeftFrac = 0;
  function windowWidthFrac(){
    var anyChart = viewerCharts['panel1'] || viewerCharts['panel2'];
    if(!anyChart || !VIEWER_DATA) return 1;
    var fullMin = VIEWER_DATA.time[0], fullMax = VIEWER_DATA.time[VIEWER_DATA.time.length - 1];
    var fullRange = fullMax - fullMin || 1;
    return (anyChart.scales.x.max - anyChart.scales.x.min) / fullRange;
  }
  // Sets BOTH edges of the visible window, i.e. pan and zoom in one operation. The edge handles
  // need this because dragging an edge changes the window's width, which setWindowLeftFrac (pan
  // only, fixed width) can't express. (MIN_WINDOW_FRAC is module-scope now; same 0.004.)
  function setWindowFracs(loFrac, hiFrac){
    if(!VIEWER_DATA || !VIEWER_DATA.time.length) return;
    var fullMin = VIEWER_DATA.time[0], fullMax = VIEWER_DATA.time[VIEWER_DATA.time.length - 1];
    var fullRange = fullMax - fullMin;
    if(!(fullRange > 0)) return;
    lo = Math.max(0, Math.min(1, loFrac));
    hi = Math.max(0, Math.min(1, hiFrac));
    if(hi - lo < MIN_WINDOW_FRAC){
      // keep the edge the user is NOT dragging still by only pushing the collapsing one back
      if(loFrac > hiFrac - MIN_WINDOW_FRAC) lo = Math.max(0, hi - MIN_WINDOW_FRAC);
      else hi = Math.min(1, lo + MIN_WINDOW_FRAC);
    }
    // minFrac 0: the floor was applied above, one-sided (the held edge stays put), and against the
    // ends of the log it deliberately lets the window go narrower rather than shove the held edge.
    // setVisibleRange's own centred floor would undo both, so it is switched off here.
    setVisibleRange(fullMin + lo * fullRange, fullMin + hi * fullRange, { minFrac: 0 });
  }
  var lo, hi;   // scratch, reused by setWindowFracs
  // One range write per frame while a handle is being dragged (see frameCoalescer).
  var fracsDrag = frameCoalescer(setWindowFracs);

  function setWindowLeftFrac(leftFrac){
    if(!VIEWER_DATA || !VIEWER_DATA.time.length) return;
    var fullMin = VIEWER_DATA.time[0], fullMax = VIEWER_DATA.time[VIEWER_DATA.time.length - 1];
    var fullRange = fullMax - fullMin;
    var widthFrac = windowWidthFrac();
    // Not clamped to [0, 1 - width] here: setVisibleRange bounds it, overhang included, so the bar can
    // be dragged past the ends exactly as far as the graph can.
    var newMin = fullMin + leftFrac * fullRange;
    // minFrac 0: a pan keeps whatever width the wheel/keys left (which can be far below the
    // handle floor) -- flooring here would silently zoom out on the first drag after a deep zoom.
    setVisibleRange(newMin, newMin + widthFrac * fullRange, { minFrac: 0 });
  }
  // POINTER events, not mouse events. These were mousedown/mousemove/mouseup, which a touchscreen
  // never fires during a drag -- a browser only synthesises mouse events *after* a tap completes,
  // so on a phone the scrubber window simply could not be dragged (Ken, 2026-07-21). Pointer events
  // cover mouse, touch and pen with one path, so desktop behaviour is unchanged.
  // ---- edge handles: drag either end of the red window to ZOOM ---------------------------------
  // Panning was the only thing the window could do, so changing the visible range meant pinching or
  // the +/- buttons. Grabbing an edge is the obvious gesture and matches every other timeline UI.
  // Registered BEFORE the window's own pan handler and stops propagation, or a handle drag would
  // start a pan at the same time and the window would slide while it resized.
  wrap.querySelectorAll('.dlv-scrub-handle').forEach(function(handle){
    handle.addEventListener('pointerdown', function(e){
      if(e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      var edge = handle.getAttribute('data-edge');
      var w = wrap.clientWidth || 1;
      var startX = e.clientX;
      var startLo = winEl.offsetLeft / w;
      var startHi = (winEl.offsetLeft + winEl.offsetWidth) / w;
      try { handle.setPointerCapture(e.pointerId); } catch(err){}
      handle.classList.add('dragging');
      function move(ev){
        var d = (ev.clientX - startX) / w;
        if(edge === 'lo') fracsDrag.set(startLo + d, startHi);
        else fracsDrag.set(startLo, startHi + d);
      }
      function up(ev){
        fracsDrag.flush();   // the position the user released on is the one that counts
        handle.classList.remove('dragging');
        try { handle.releasePointerCapture(ev.pointerId); } catch(err){}
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
      }
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
  });

  var dragPointerId = null;
  if(winEl) winEl.addEventListener('pointerdown', function(e){
    if(e.button !== 0) return;                 // never start a drag on right/middle click
    if(e.target && e.target.classList && e.target.classList.contains('dlv-scrub-handle')) return;
    dragging = true; dragStartX = e.clientX;
    dragStartLeftFrac = winEl.offsetLeft / (wrap.clientWidth || 1);
    dragPointerId = e.pointerId;
    // Capture so the drag survives the finger leaving the 16px-tall bar, which on a phone it
    // immediately does.
    if(winEl.setPointerCapture){ try{ winEl.setPointerCapture(e.pointerId); }catch(err){} }
    e.preventDefault();
  });
  var panDrag = frameCoalescer(setWindowLeftFrac);
  document.addEventListener('pointermove', function(e){
    if(!dragging || (dragPointerId !== null && e.pointerId !== dragPointerId)) return;
    var dx = e.clientX - dragStartX;
    panDrag.set(dragStartLeftFrac + dx / (wrap.clientWidth || 1));
  });
  function endDrag(){ panDrag.flush(); dragging = false; dragPointerId = null; }
  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', endDrag);   // touch drags get cancelled, mouse ones don't
  wrap.addEventListener('click', function(e){
    // A click on the window OR ITS HANDLES is the tail of a drag, not a request to re-centre. The
    // handles are children of the window, so `target === winEl` alone let a handle-drag's release
    // jump the window to wherever the pointer came up (found while wiring the histogram range API).
    if(e.target === winEl || (winEl && e.target && winEl.contains(e.target)) || dragging) return;
    var rect = wrap.getBoundingClientRect();
    var clickFrac = (e.clientX - rect.left) / rect.width;
    setWindowLeftFrac(clickFrac - windowWidthFrac() / 2);
  });

  var zoomInBtn = document.getElementById('dlvZoomInBtn');
  var zoomOutBtn = document.getElementById('dlvZoomOutBtn');
  if(zoomInBtn) zoomInBtn.addEventListener('click', function(){ zoomAtPoint(0.7); });
  if(zoomOutBtn) zoomOutBtn.addEventListener('click', function(){ zoomAtPoint(1.4); });
  var fsBtn = document.getElementById('dlvFullscreenBtn');
  if(fsBtn) fsBtn.addEventListener('click', function(){
    var overlay = document.getElementById('viewerOverlay');
    if(document.fullscreenElement){ document.exitFullscreen(); }
    else if(overlay.requestFullscreen){ overlay.requestFullscreen().catch(function(){}); }
  });
  // Same exit as the header X and the rotate screen's Back, so the host is left in the state it expects.
  var hostCloseBtn = document.getElementById('dlvHostCloseBtn');
  if(hostCloseBtn) hostCloseBtn.addEventListener('click', closeViewer);
}

// ---- Native host hook ----------------------------------------------------------------------------
// The BigData phone/tablet apps (Capacitor) load this same engine and declare themselves before it
// renders:  window.ADL_HOST = { kind:'capacitor', platform:'android'|'ios', handlesFullscreen:true }.
// Everything else about the phone layout is unchanged; a host only changes what the engine cannot
// know on its own -- that there is no address bar to hide and no site to go back to.
function viewerHost(){
  var h = window.ADL_HOST;
  return h && typeof h === 'object' ? h : null;
}
function hostHandlesFullscreen(){
  var h = viewerHost();
  return !!(h && h.handlesFullscreen);
}
// A host with room to spare (BigData for Windows: no browser chrome, 920px+ windows) keeps the header
// bar open instead of the hover strip -- Ken, 2026-09-09: "get rid of the auto hide on that top menu.
// it's annoying. there is plenty of room to leave it expanded". window.ADL_HOST.pinHeader = true.
function hostPinsHeader(){
  var h = viewerHost();
  return !!(h && h.pinHeader);
}
