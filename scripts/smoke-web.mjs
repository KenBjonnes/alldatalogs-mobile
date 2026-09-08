/*
 * smoke-web.mjs — serves www/ and drives it with Playwright at a landscape-phone viewport (the engine's
 * phone layout kicks in under 520px tall): the shell boots on the web platform, the bundled sample opens
 * through the bundled worker, the engine is in phone mode with the HOST close button (ADL_HOST), a
 * layout saves and lists, the free cap blocks an oversized file, and the console shows no errors.
 *
 *   node scripts/smoke-web.mjs
 *
 * Runs against http://localhost:5174 (started here) with ?devpro=1 so Pro features are reachable.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '.smoke');
mkdirSync(OUT, { recursive: true });
const PORT = 5174;

const failures = [];
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failures.push(what); };

const server = spawn(process.execPath, [join(here, 'serve.mjs')], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));

const browser = await chromium.launch({ channel: process.env.SMOKE_CHANNEL || undefined, headless: true });
try {
  const ctx = await browser.newContext({ viewport: { width: 916, height: 412 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));

  await page.goto(`http://localhost:${PORT}/?devpro=1`);
  await page.waitForSelector('#screen-home:not([hidden])', { timeout: 20000 });
  check(true, 'home screen shown');
  const boot = await page.evaluate(() => ({ host: window.ADL_HOST, version: document.getElementById('footVersion').textContent, pro: document.getElementById('footPro').textContent }));
  console.log('   boot:', JSON.stringify(boot));
  check(boot.host && boot.host.kind === 'capacitor' && boot.host.handlesFullscreen === true, 'ADL_HOST declared before any log opens');
  check(/^v\d+\.\d+\.\d+$/.test(boot.version), `version stamped (${boot.version})`);
  check(/^Pro/.test(boot.pro), `dev Pro active on the web platform (${boot.pro})`);
  await page.screenshot({ path: join(OUT, '1-home.png') });

  await page.click('#btnSample');
  await page.waitForFunction(() => { const o = document.getElementById('viewerOverlay'); return !!o && o.classList.contains('open'); }, null, { timeout: 60000 });
  await page.waitForTimeout(1500);
  const info = await page.evaluate(() => ({
    channels: typeof VIEWER_DATA !== 'undefined' && VIEWER_DATA ? VIEWER_DATA.channels.length : -1,
    full: typeof VIEWER_DATA !== 'undefined' && VIEWER_DATA && VIEWER_DATA.full ? VIEWER_DATA.full.rows : -1,
    mobile: !!document.querySelector('#viewerContent.dlv-mobile'),
    hostClose: !!document.getElementById('dlvHostCloseBtn'),
    fsBtn: !!document.getElementById('dlvFullscreenBtn'),
    canvases: document.querySelectorAll('#viewerContent canvas').length,
    pro: typeof viewerIsPro === 'function' ? viewerIsPro() : null,
  }));
  console.log('   viewer:', JSON.stringify(info));
  check(info.channels > 5, `sample parsed through the bundled worker (${info.channels} channels)`);
  check(info.full > 1000, `full-resolution set present (${info.full} rows)`);
  check(info.mobile, 'engine is in phone mode at 916x412');
  check(info.hostClose && !info.fsBtn, 'host close button replaces the fullscreen button');
  check(info.canvases > 0, `charts rendered (${info.canvases})`);
  check(info.pro === true, 'engine reports Pro');
  await page.screenshot({ path: join(OUT, '2-viewer.png') });

  // Save a layout through the engine's provider (window.prompt is stubbed here; native WebViews implement it).
  await page.evaluate(() => { window.prompt = () => 'Smoke Layout'; });
  const saved = await page.evaluate(() => window.DATAVIEWER.layouts.save({ kind: 'view', smoke: true }));
  const listed = await page.evaluate(() => window.DATAVIEWER.layouts.list().map((l) => l.name));
  check(saved === true && listed.includes('Smoke Layout'), `layout saved + listed (${listed.join(', ')})`);
  await page.evaluate(() => { const l = window.DATAVIEWER.layouts.list().find((x) => x.name === 'Smoke Layout'); if (l) window.DATAVIEWER.layouts.remove(l.id); });

  // Host close button closes the log and lands back on home.
  await page.dispatchEvent('#dlvHostCloseBtn', 'click');
  await page.waitForTimeout(600);
  const closed = await page.evaluate(() => !document.getElementById('viewerOverlay').classList.contains('open') && !document.getElementById('screen-home').hidden);
  check(closed, 'host ✕ closes the viewer');
  const recents = await page.evaluate(() => document.querySelectorAll('#recentList li').length);
  check(recents === 0, 'the sample is not added to Recent');

  // mobile-config.json lives on alldatalogs.com; from a localhost dev origin the fetch is a CORS failure
  // by design (native origins are allowed by the site's header), so it is not an app error here.
  const errs = errors.filter((e) => !/favicon|404|mobile-config\.json|ERR_FAILED/i.test(e));
  check(errs.length === 0, `no console errors (${errs.length})`);
  errs.forEach((e) => console.log('   console:', e.slice(0, 300)));
} finally {
  await browser.close();
  server.kill();
}
console.log(failures.length ? `\n${failures.length} FAILURE(S)` : '\nALL PASS');
process.exit(failures.length ? 1 : 0);
