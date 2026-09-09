/*
 * build-payload.mjs — assembles www/ (the web app Capacitor ships inside the Android and iOS apps)
 * from its canonical sources and records exactly what shipped in www/BUNDLED.json.
 *
 * Same discipline as the desktop app: copies are never made by hand, the decoder is REBUILT from
 * source, everything is hashed, and `--check` fails loudly when the committed www/ is stale or
 * inconsistent. www/ mirrors the site's apps/web/public layout (/vendor, /viewer-engine, /sample).
 *
 * Differences from the desktop builder:
 *   * the parse worker is BUNDLED (pako + dvcore inlined) instead of using importScripts(): only the
 *     top-level worker script has to load under capacitor://; the message contract is the site's,
 *     verbatim (the site file is read and its single importScripts line replaced with imports);
 *   * the app version is stamped into www/index.html at build time (Capacitor has no serve hook);
 *   * src/app.css is copied in; there is no shim.js (native WebViews implement window.prompt).
 *
 *   node scripts/build-payload.mjs           refresh from source (needs the source folders: Ken's PC)
 *   node scripts/build-payload.mjs --check   no writes; exit 1 on drift (manifest-only in CI)
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const WWW = join(ROOT, 'www');
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

const RELEASE_DIR = process.env.BIGDATA_RELEASE_DIR || 'C:/Users/kenbj/Code/datalog viewer';
const SITE = process.env.BIGDATA_SITE_REPO || 'C:/websites/Alldatalogs';

// The DataViewer-owned engine files (keep in step with the work folder's release.ps1 $files).
const ENGINE = [
  'datalog-viewer.css',
  'datalog-histogram.css',
  'datalog-histogram-editor.css',
  'datalog-presets.js',
  'datalog-gauges.js',
  'datalog-scorecard.js',
  'datalog-scorecard-evaluators.js',
  'datalog-accel.js',
  'datalog-expr.js',
  'datalog-histogram.js',
  'datalog-histogram-ui.js',
  'datalog-histogram-editor.js',
  'datalog-hpt.js',
  'datalog-library.js',
  'datalog-library.css',
  'datalog-vehicles.js',
  'datalog-viewer.js',
];

const COPIES = [
  ...ENGINE.map((f) => [join(RELEASE_DIR, f), `viewer-engine/${f}`]),
  [join(SITE, 'packages/viewer-engine/src/runtime.js'), 'viewer-engine/runtime.js'],
  [join(SITE, 'apps/web/public/vendor/chart.umd.js'), 'vendor/chart.umd.js'],
  [join(SITE, 'apps/web/public/vendor/hammer.min.js'), 'vendor/hammer.min.js'],
  [join(SITE, 'apps/web/public/vendor/chartjs-plugin-zoom.min.js'), 'vendor/chartjs-plugin-zoom.min.js'],
  [join(SITE, 'apps/web/public/vendor/pako.min.js'), 'vendor/pako.min.js'],
  [join(SITE, 'apps/web/public/sample/mile.hpl'), 'sample/mile.hpl'],
  [join(ROOT, 'src/app.css'), 'app.css'],
];

const ALIASES = {
  '@site/viewerPayload': join(SITE, 'apps/web/lib/viewerPayload.ts'),
  '@site/jws': join(SITE, 'supabase/functions/_shared/jws.ts'),
  '@site/history': join(SITE, 'apps/web/lib/history.ts'),
  '@site/dvcore': join(SITE, 'packages/datalog-core/browser/entry.ts'),
};

const BUILDS = [
  { dest: 'viewer-engine/dvcore.js', from: join(SITE, 'packages/datalog-core/browser/entry.ts'),
    options: { format: 'iife', globalName: 'DVCore', platform: 'browser' } },
  { dest: 'glue.js', from: join(ROOT, 'src/glue.ts'),
    options: { format: 'iife', platform: 'browser', target: ['es2020'], define: { 'process.env.NODE_ENV': '"production"', __APP_VERSION__: JSON.stringify(PKG.version) }, alias: ALIASES } },
  { dest: 'parse-worker.js', stdin: workerSource, resolveDir: join(SITE, 'apps/web/public'),
    options: { format: 'iife', platform: 'browser', target: ['es2020'], alias: ALIASES } },
];

// The site's worker verbatim, with its one importScripts() line turned into bundler imports.
function workerSource() {
  const src = readFileSync(join(SITE, 'apps/web/public/parse-worker.js'), 'utf8');
  const lines = src.split('\n');
  const hits = lines.map((l, i) => (/^\s*importScripts\(/.test(l) ? i : -1)).filter((i) => i >= 0);
  if (hits.length !== 1) throw new Error(`parse-worker.js: expected exactly one importScripts line, found ${hits.length}`);
  lines[hits[0]] = `import pako from ${JSON.stringify(pathToFileURL(join(SITE, 'apps/web/public/vendor/pako.min.js')).pathname.replace(/^\//, '') ? join(SITE, 'apps/web/public/vendor/pako.min.js').replace(/\\/g, '/') : '')};\n` +
    `import * as DVCore from '@site/dvcore';\nself.pako = pako; self.DVCore = DVCore;`;
  return lines.join('\n');
}

// The order www/index.html must load the scripts in (the site's OpenLog.tsx order + library).
export const SCRIPT_ORDER = [
  '/vendor/chart.umd.js',
  '/vendor/hammer.min.js',
  '/vendor/chartjs-plugin-zoom.min.js',
  '/vendor/pako.min.js',
  '/viewer-engine/dvcore.js',
  '/viewer-engine/runtime.js',
  '/viewer-engine/datalog-presets.js',
  '/viewer-engine/datalog-gauges.js',
  '/viewer-engine/datalog-scorecard.js',
  '/viewer-engine/datalog-scorecard-evaluators.js',
  '/viewer-engine/datalog-accel.js',
  '/viewer-engine/datalog-expr.js',
  '/viewer-engine/datalog-histogram.js',
  '/viewer-engine/datalog-histogram-ui.js',
  '/viewer-engine/datalog-histogram-editor.js',
  '/viewer-engine/datalog-hpt.js',
  '/viewer-engine/datalog-vehicles.js',
  '/viewer-engine/datalog-library.js',
  '/viewer-engine/datalog-viewer.js',
  '/glue.js',
];

const check = process.argv.includes('--check');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const short = (h) => h.slice(0, 12);
const rel = (p) => relative(ROOT, p).replace(/\\/g, '/');

function gitHead(dir) {
  try { return execSync('git rev-parse --short HEAD', { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return null; }
}
async function buildOne(b) {
  const common = { bundle: true, write: false, logLevel: 'warning', ...b.options };
  const r = b.stdin
    ? await build({ ...common, stdin: { contents: b.stdin(), resolveDir: b.resolveDir, loader: 'js', sourcefile: 'parse-worker.js' } })
    : await build({ ...common, entryPoints: [b.from] });
  return Buffer.from(r.outputFiles[0].contents);
}
function indexHtml() {
  return Buffer.from(readFileSync(join(ROOT, 'src/index.html'), 'utf8').split('__APP_VERSION__').join(PKG.version));
}
function scriptOrderProblems(html) {
  const found = [...html.matchAll(/<script[^>]*\ssrc="([^"?]+)(?:\?[^"]*)?"/g)].map((m) => m[1]);
  if (found.length !== SCRIPT_ORDER.length || found.some((s, i) => s !== SCRIPT_ORDER[i])) {
    return [`src/index.html script order differs from SCRIPT_ORDER:\n  have: ${found.join(' ')}\n  want: ${SCRIPT_ORDER.join(' ')}`];
  }
  return [];
}

async function main() {
  const sourcesPresent = existsSync(RELEASE_DIR) && existsSync(SITE);
  const manifestPath = join(WWW, 'BUNDLED.json');
  const problems = scriptOrderProblems(readFileSync(join(ROOT, 'src/index.html'), 'utf8'));
  const expectedKeys = ['index.html', ...COPIES.map((c) => c[1]), ...BUILDS.map((b) => b.dest)];

  if (check) {
    if (!existsSync(manifestPath)) { console.error('MISSING www/BUNDLED.json — run: node scripts/build-payload.mjs'); process.exit(1); }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    for (const [key, meta] of Object.entries(manifest.files)) {
      const p = join(WWW, key);
      if (!existsSync(p)) { problems.push(`MISSING www/${key}`); continue; }
      const h = sha(readFileSync(p));
      if (h !== meta.sha256) problems.push(`MODIFIED www/${key} (manifest ${short(meta.sha256)} vs disk ${short(h)})`);
    }
    for (const want of expectedKeys) if (!manifest.files[want]) problems.push(`NOT IN MANIFEST: ${want}`);
    if (manifest.version !== PKG.version) problems.push(`STALE version stamp: www built for ${manifest.version}, package.json is ${PKG.version}`);
    if (sourcesPresent) {
      for (const [src, dest] of COPIES) {
        if (!existsSync(src)) { problems.push(`MISSING SOURCE ${src}`); continue; }
        const a = readFileSync(src), p = join(WWW, dest), b = existsSync(p) ? readFileSync(p) : null;
        if (!b || !a.equals(b)) problems.push(`STALE www/${dest} (source ${short(sha(a))} vs bundled ${b ? short(sha(b)) : 'missing'})`);
      }
      for (const b of BUILDS) {
        if (b.from && !existsSync(b.from)) { problems.push(`MISSING SOURCE ${b.from}`); continue; }
        const out = await buildOne(b), p = join(WWW, b.dest), have = existsSync(p) ? readFileSync(p) : null;
        if (!have || !out.equals(have)) problems.push(`STALE www/${b.dest} (rebuilt ${short(sha(out))} vs bundled ${have ? short(sha(have)) : 'missing'})`);
      }
      const idx = indexHtml(), pi = join(WWW, 'index.html');
      if (!existsSync(pi) || !readFileSync(pi).equals(idx)) problems.push('STALE www/index.html');
    } else {
      console.log('build-payload --check: source folders not present, verified www/ against BUNDLED.json only.');
    }
    if (problems.length) { console.error(problems.join('\n')); console.error(`\n${problems.length} problem(s). Run: node scripts/build-payload.mjs`); process.exit(1); }
    console.log(`build-payload --check: ${Object.keys(manifest.files).length} bundled files OK, script order OK, version ${manifest.version}.`);
    return;
  }

  if (!sourcesPresent) { console.error(`Source folders not found:\n  RELEASE_DIR=${RELEASE_DIR}\n  SITE=${SITE}`); process.exit(1); }
  if (problems.length) { console.error(problems.join('\n')); process.exit(1); }

  const files = {};
  const put = (dest, buf, from) => {
    const p = join(WWW, dest);
    mkdirSync(dirname(p), { recursive: true });
    const same = existsSync(p) && readFileSync(p).equals(buf);
    if (!same) writeFileSync(p, buf);
    files[dest] = { sha256: sha(buf), bytes: buf.length, from: from.replace(/\\/g, '/') };
    console.log(`  ${same ? '=' : '+'} ${dest.padEnd(46)} ${String(buf.length).padStart(8)} B  ${short(files[dest].sha256)}`);
  };
  for (const [src, dest] of COPIES) {
    if (!existsSync(src)) { console.error(`MISSING SOURCE: ${src}`); process.exit(1); }
    put(dest, readFileSync(src), src);
  }
  for (const b of BUILDS) {
    if (b.from && !existsSync(b.from)) { console.error(`MISSING SOURCE: ${b.from}`); process.exit(1); }
    put(b.dest, await buildOne(b), (b.from || 'apps/web/public/parse-worker.js') + ' (esbuild)');
  }
  put('index.html', indexHtml(), join(ROOT, 'src/index.html') + ' (version stamped)');
  const manifest = { builtAt: new Date().toISOString(), version: PKG.version,
    sources: { releaseDir: RELEASE_DIR, siteRepo: SITE, siteCommit: gitHead(SITE) }, files };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`\nWrote ${rel(manifestPath)} (${Object.keys(files).length} files, v${PKG.version}, site @ ${manifest.sources.siteCommit || '?'}).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
