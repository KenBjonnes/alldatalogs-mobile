'use strict';
/*
 * runtime.js -- DataViewer viewer-engine runtime shim. Makes the engine self-sufficient and
 * configurable, so ANY consumer (the standalone app, the PBD Control Center, a future embed) can
 * load it without providing page globals of its own.
 *
 * Provides:
 *   - window.escapeHtml  (only if the host hasn't already defined one)
 *   - configureViewer(cfg)   -> sets window.DATAVIEWER (brand, prefsKey, vehicleMetaProvider, ...)
 *   - ensureViewerDom()      -> injects the #viewerOverlay/#viewerContent/#viewerCloseBtn contract
 *   - showToast fallback     (console-based, only if the host hasn't defined one)
 *
 * Load ORDER on a consumer page:
 *   1) Chart.js, chartjs-plugin-zoom, hammer.js (CDN)   2) runtime.js   3) datalog-presets.js
 *   4) datalog-gauges.js   5) datalog-viewer.js
 * Then call configureViewer({...}); ensureViewerDom(); and open a log via openViewerFromPromise().
 */
(function () {
  // --- escapeHtml (self-sufficient; host may override by defining its own before this loads) ---
  if (typeof window.escapeHtml !== 'function') {
    window.escapeHtml = function (s) {
      if (s == null) return '';
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    };
  }

  // --- optional showToast fallback (host may provide a nicer one) ---
  if (typeof window.showToast !== 'function') {
    window.showToast = function (msg) {
      try { console.info('[DataViewer] ' + msg); } catch (e) {}
    };
  }

  // --- configuration ---
  window.DATAVIEWER = window.DATAVIEWER || {
    brand: { mark: 'D', name: 'DataViewer', sub: 'DATALOG VIEWER' },
    prefsKey: 'dataviewerViewerPrefs',
    vehicleMetaProvider: null,
  };
  window.configureViewer = function (cfg) {
    cfg = cfg || {};
    var cur = window.DATAVIEWER || {};
    window.DATAVIEWER = {
      brand: Object.assign({}, cur.brand, cfg.brand),
      prefsKey: cfg.prefsKey || cur.prefsKey || 'dataviewerViewerPrefs',
      vehicleMetaProvider: cfg.vehicleMetaProvider || cur.vehicleMetaProvider || null,
      // Optional host layout provider (list/save/apply/remove) for saved viewer layouts.
      layouts: cfg.layouts !== undefined ? cfg.layouts : (cur.layouts || null),
      // Optional host provider for the shared gauge/histogram library (async list/get/publish/
      // remove/pull + admin). Carried across a reconfigure for the same reason as isPro below.
      library: cfg.library !== undefined ? cfg.library : (cur.library || null),
      // Pro entitlement must SURVIVE a reconfigure. This rebuilds DATAVIEWER wholesale, so without
      // carrying isPro across, any host calling configureViewer() after setViewerPro() would revert
      // to the unlocked default -- fail-open, so nothing looks broken while the gate quietly stops
      // applying. Only an explicit cfg.isPro may change it here.
      isPro: cfg.isPro !== undefined ? cfg.isPro : cur.isPro,
      // Host hook the Compare feature calls to turn a picked File into viewer data. Decoding stays
      // with the host (DVCore on the sites, HplDecode/DatalogIO in the harness) so the engine never
      // carries a second copy of the decoders. Carried across a reconfigure for the same reason as
      // isPro: rebuilding this object wholesale would silently drop it and Compare would just stop
      // working with no error anywhere.
      loadLogFile: cfg.loadLogFile !== undefined ? cfg.loadLogFile : cur.loadLogFile,
    };
    return window.DATAVIEWER;
  };

  // --- DOM contract injection ---
  // Injects the overlay markup the engine renders into, if the host page doesn't already have it.
  window.ensureViewerDom = function () {
    if (document.getElementById('viewerOverlay')) return;
    var overlay = document.createElement('div');
    overlay.id = 'viewerOverlay';
    overlay.className = 'viewer-overlay';
    overlay.innerHTML =
      '<div class="viewer-modal"><div id="viewerContent"></div>' +
      '<button id="viewerCloseBtn" type="button" style="display:none">close</button></div>';
    document.body.appendChild(overlay);
  };
})();
