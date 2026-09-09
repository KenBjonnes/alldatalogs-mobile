/*
 * glue.ts — the web side of BigData for Android / iPhone / iPad.
 *
 * A port of the desktop renderer glue (alldatalogs-desktop renderer/src/glue.ts): the worker-first /
 * sync-fallback open path, the saved-layouts provider, the configure → ensureDom → setViewerPro boot
 * order, the licence screens — plus what a phone adds: the native file paths (picker, Open with,
 * share sheet), landscape lock and wake lock while a log is open, the Android back button, the free
 * tier's file-size caps, and an out-of-memory marker so a WebView that was killed mid-open can say so
 * on relaunch. Everything native goes through native.ts; everything Supabase through supabase.ts.
 */
import { buildViewerPayload } from '@site/viewerPayload';
import * as native from './native.ts';
import * as lic from './licensing.ts';
import { buildLibraryProvider, pullLayouts, pushLayout, removeLayout, deleteAccount, reportFailedLog } from './supabase.ts';
import { openFromPicker, openFromUrl, openSample, listRecents, noteRecent, type LogSource, type RecentRow } from './files.ts';
import { autoSaveOpened, listAccountHistory, openAccountLog, getSyncMode, setSyncMode, type SyncMode } from './history.ts';
import { capBytes, fullBudgetCells, mergeCaps, fmtOf, fmtBytes, isLogName } from './caps.ts';
import { DEFAULT_CAPS, MAX_POINTS, REMOTE_CONFIG_URL, ACCOUNT_URL, PRICING_URL, type Caps } from './config.ts';
import type { LicenseState } from './license.ts';

declare const __APP_VERSION__: string;
type Dict = Record<string, unknown>;
interface SavedLayout { id: string; name: string; state: Dict; updatedAt: number }

declare global {
  interface Window {
    DVCore: any;
    pako: any;
    ADL_HOST: Dict;
    configureViewer: (cfg: Dict) => Dict;
    ensureViewerDom: () => void;
    setViewerPro?: (pro: boolean) => void;
    setScorecardEnabledForEmail?: (email: string) => boolean;
    reloadViewerLayouts?: () => Promise<unknown>;
    openViewerFromPromise: (p: Promise<unknown>, opts: Dict) => void;
    closeViewer?: () => void;
    showToast: (msg: string) => void;
    __bigdata: Dict;
  }
}

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const errMsg = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);
const device = native.deviceClass();
let caps: Caps = DEFAULT_CAPS;
let remote: { proLinkIOS?: boolean; minVersion?: string; message?: string } = {};
let license: LicenseState = lic.getState();
const log: string[] = [];
function note(s: string) { log.push(new Date().toISOString().slice(11, 19) + ' ' + s); if (log.length > 200) log.shift(); }

// Tell the engine it is inside a native app BEFORE any log renders (it reads this at render time).
window.ADL_HOST = { kind: 'capacitor', platform: native.platform, handlesFullscreen: true, device };

// The engine's "saved" / "loaded" / "copied" feedback: runtime.js only installs a console fallback
// when the host has none, so the real toast must exist before the engine looks (glue.js loads last,
// but the check happens lazily at call time, so defining it here is in time).
let toastTimer: ReturnType<typeof setTimeout> | null = null;
window.showToast = (msg: string) => {
  const el = document.getElementById('toast');
  if (!el) { try { console.info('[BigData] ' + msg); } catch { /* ignore */ } return; }
  el.textContent = String(msg == null ? '' : msg);
  el.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
};

// ---- Saved layouts: local-first provider (same as the desktop) ----------------------------------------
const LS_KEY = 'alldatalogs.viewerLayouts.v1';
function readLocal(): SavedLayout[] {
  try { const arr = JSON.parse(localStorage.getItem(LS_KEY) || '[]'); return Array.isArray(arr) ? arr.filter((x) => x && x.id && x.name) : []; } catch { return []; }
}
function writeLocal(list: SavedLayout[]) { try { localStorage.setItem(LS_KEY, JSON.stringify(list.slice(0, 200))); } catch { /* full */ } }
function genId(): string { return 'ly_' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36); }
// owner = the account (lower-case email) an entry is synced under; absent = saved while signed out. One
// local list per device, so two sign-ins must not see / overwrite each other's rows (a push of another
// account's row is refused by RLS and the save silently never reaches the cloud -- Ken, 2026-09-09).
function ownerKey(): string | null { const e = (license.email || '').trim().toLowerCase(); return e || null; }
function visibleLayouts(list: SavedLayout[]): SavedLayout[] { const o = ownerKey(); return list.filter((l) => !l.owner || l.owner === o); }
function saveLayout(name: string, state: Dict): SavedLayout {
  const list = readLocal(), now = Date.now(), owner = ownerKey();
  const existing = visibleLayouts(list).find((l) => l.name.toLowerCase() === name.toLowerCase());
  let entry: SavedLayout;
  if (existing) { existing.state = state; existing.updatedAt = now; if (owner) existing.owner = owner; entry = existing; }
  else { entry = owner ? { id: genId(), name, state, updatedAt: now, owner } : { id: genId(), name, state, updatedAt: now }; list.push(entry); }
  writeLocal(list);
  return entry;
}
let lastPullAt = 0;
const PULL_THROTTLE_MS = 8000;
function mergeCloudRows(rows: SavedLayout[]) {
  const owner = ownerKey();
  const byId = new Map(readLocal().map((l) => [l.id, l]));
  for (const row of rows) byId.set(row.id, owner ? { ...row, owner } : row);
  writeLocal([...byId.values()]);
}
const layoutProvider = {
  list() { return visibleLayouts(readLocal()).sort((a, b) => b.updatedAt - a.updatedAt).map((l) => ({ id: l.id, name: l.name, kind: typeof (l.state as { kind?: unknown }).kind === 'string' ? (l.state as { kind: string }).kind : undefined })); },
  save(state: Dict, name?: string): boolean {
    const chosen = name != null && name !== '' ? name : (window.prompt('Name this layout:', '') || '');
    const trimmed = chosen.trim();
    if (!trimmed) return false;
    const entry = saveLayout(trimmed, state);
    if (lic.isPro()) pushLayout(entry).catch(() => {});
    return true;
  },
  apply(id: string): Dict | undefined { return readLocal().find((l) => l.id === id)?.state; },
  remove(id: string): void { writeLocal(readLocal().filter((l) => l.id !== id)); if (lic.isPro()) removeLayout(id).catch(() => {}); },
  // On-demand cloud pull when the layout picker opens (throttled); resolves true when rows arrived.
  refresh(): Promise<boolean> {
    if (!lic.isPro() || !license.email) return Promise.resolve(false);
    const now = Date.now();
    if (now - lastPullAt < PULL_THROTTLE_MS) return Promise.resolve(false);
    lastPullAt = now;
    return pullLayouts().then((r) => { if (r.ok && r.rows.length) { mergeCloudRows(r.rows); return true; } return false; }).catch(() => false);
  },
  account(): { email: string; synced: boolean } | null { return license.email ? { email: license.email, synced: lic.isPro() } : null; },
};
let pulledFor: string | null = null;
function maybePullLayouts(s: LicenseState) {
  if (s.pro !== true || !s.email || pulledFor === s.email) return;
  pulledFor = s.email;
  lastPullAt = Date.now();
  pullLayouts().then((r) => {
    if (r.ok && r.rows.length) mergeCloudRows(r.rows);
    return window.reloadViewerLayouts?.();   // re-list either way: the visible set is per account
  }).catch(() => {});
}

// ---- Open path (worker-first, sync fallback; a FRESH worker per open so its heap is released) ---------
interface Job { id: number; src: LogSource; fmt: string }
let worker: Worker | null = null;
let workerBroken = false;
let jobSeq = 0;
let pending: Job | null = null;
let cancelled = false;
const OPEN_MARK = 'bigdata.opening';

function openParsed(parsed: any, src: LogSource): boolean {
  if (!parsed || !Array.isArray(parsed.channelNames) || !parsed.channelNames.length) { showError('No numeric channels found in this file.'); return false; }
  const data = buildViewerPayload(parsed, { maxPoints: MAX_POINTS, budgetCells: fullBudgetCells(device, caps), bucketDecimate: window.DVCore.bucketDecimate });
  window.openViewerFromPromise(Promise.resolve({ ok: true, data }), { fileName: src.name, source: src.origin === 'sample' ? 'sample' : src.origin === 'cloud' ? 'cloud' : 'local' });
  void noteRecent(src, lic.currentUserId()).then(refreshRecents);
  // Account history (Pro): the log goes to the account so it shows up in History on every device.
  if (src.origin !== 'sample' && src.origin !== 'cloud') void autoSaveOpened(src.file, src.name, fmtOf(src.name), lic.isPro()).then((r) => { if (r && r.ok) void refreshRecents(); });
  return true;
}
function decodeSync(fmt: string, buf: ArrayBuffer): any {
  const bytes = new Uint8Array(buf), D = window.DVCore;
  let csv: string;
  if (fmt === 'HPL') csv = D.convertHplToCsv(bytes, (d: Uint8Array) => window.pako.inflateRaw(d), { interpolate: true, usUnits: true });
  else if (fmt === 'MoTeC') csv = D.convertLdToCsv(bytes);
  else if (fmt === 'Holley') csv = D.convertHolleyDlToCsv(bytes);
  else csv = new TextDecoder().decode(bytes);
  return D.parseDatalogCsv(csv);
}
async function runSyncJob(job: Job) {
  await new Promise((r) => setTimeout(r, 30));
  if (cancelled || job.id !== jobSeq) { hideLoader(); return; }
  let ab: ArrayBuffer;
  try { ab = await job.src.file.arrayBuffer(); } catch { showError('Could not read that file.'); hideLoader(); return; }
  if (cancelled || job.id !== jobSeq) { hideLoader(); return; }
  try { openParsed(decodeSync(job.fmt, ab), job.src); }
  catch (e) { const msg = errMsg(e, 'Could not open this file.'); showError(msg); void reportOpenFailure(job.src, job.fmt, msg); }
  finishJob();
}
// A log that would not open: PBD reporters (Ken, anyone @pbdyno.com) send the bytes + error to the
// failed-logs queue for troubleshooting; everyone else just sees the error (Ken, 2026-09-09).
async function reportOpenFailure(src: LogSource, fmt: string, msg: string) {
  if (src.origin === 'sample') return;
  const engine = (window.DVCore && (window.DVCore as { HPL_CONVERTER_VERSION?: string }).HPL_CONVERTER_VERSION) || '';
  const r = await reportFailedLog({ name: src.name, bytes: src.file, error: msg, format: fmt, engine });
  if (r === 'sent') window.showToast('Sent to PBD for troubleshooting.');
}
function finishJob() { hideLoader(); void native.prefRemove(OPEN_MARK); dropWorker(); }
function dropWorker() { if (worker) { try { worker.terminate(); } catch { /* ignore */ } worker = null; } }
function onWorkerMessage(data: any) {
  if (!data || cancelled || data.jobId !== jobSeq) return;
  const p = pending; pending = null;
  if (!p) return;
  if (data.ok) openParsed(data.parsed, p.src);
  else { const msg = data.error || 'Could not open this file.'; showError(msg); void reportOpenFailure(p.src, p.fmt, msg); }
  finishJob();
}
function getWorker(): Worker | null {
  if (workerBroken || typeof Worker === 'undefined') return null;
  dropWorker();
  try {
    const w = new Worker('/parse-worker.js');
    w.onmessage = (ev) => onWorkerMessage(ev.data);
    w.onerror = (ev) => {
      note('worker error: ' + (ev && (ev as ErrorEvent).message));
      workerBroken = true; dropWorker();
      const p = pending; pending = null;
      if (p && p.id === jobSeq && !cancelled) void runSyncJob(p);
    };
    worker = w;
    return w;
  } catch (e) { note('worker unavailable: ' + errMsg(e, '?')); workerBroken = true; return null; }
}
function startJob(src: LogSource) {
  cancelled = false;
  const id = ++jobSeq, job: Job = { id, src, fmt: fmtOf(src.name) };
  clearError();
  showLoader(src.name);
  void native.prefSet(OPEN_MARK, JSON.stringify({ name: src.name, size: src.size, at: Date.now() }));
  const w = getWorker();
  if (!w) { void runSyncJob(job); return; }
  pending = job;
  try { w.postMessage({ jobId: id, name: src.name, fmt: job.fmt, file: src.file }); }
  catch (e) { note('postMessage failed: ' + errMsg(e, '?')); workerBroken = true; dropWorker(); pending = null; void runSyncJob(job); }
}
function cancelLoad() { cancelled = true; jobSeq++; pending = null; dropWorker(); hideLoader(); void native.prefRemove(OPEN_MARK); }

/** Size gate, then open. The free tier and the phone caps are enforced here, before any bytes are decoded. */
function handleSource(src: LogSource) {
  const fmt = fmtOf(src.name), pro = lic.isPro();
  const cap = capBytes({ pro, device, fmt, caps });
  if (src.size > cap) {
    const why = pro
      ? `This ${fmt} log is ${fmtBytes(src.size)}; the limit on a ${device} is ${fmtBytes(cap)} so it can be opened without running out of memory. Open it on the website or BigData for Windows.`
      : `This log is ${fmtBytes(src.size)}, above the free limit of ${fmtBytes(cap)}. AllDataLogs Pro opens logs up to ${fmtBytes(capBytes({ pro: true, device, fmt, caps }))} on this ${device}.`;
    showError(why);
    return;
  }
  startJob(src);
}
async function openWith(fn: () => Promise<LogSource | null>) {
  try { const src = await fn(); if (src) handleSource(src); }
  catch (e) { showError(errMsg(e, 'Could not open that file.')); }
}
let booted = false;
const queuedUrls: string[] = [];
function openUrl(url: string) {
  if (!url || /^(https?|bigdata|alldatalogs):/i.test(url)) return; // deep links are not files
  if (!booted) { queuedUrls.push(url); return; }
  note('open url ' + url.slice(0, 120));
  void openWith(() => openFromUrl(url, 'open-with'));
}

// ---- Screens ---------------------------------------------------------------------------------------
type Screen = 'home' | 'account' | 'diag';
let screen: Screen = 'home';
function showScreen(name: Screen) {
  screen = name;
  for (const s of ['home', 'account', 'diag'] as Screen[]) $(`screen-${s}`).hidden = s !== name;
  if (name === 'diag') renderDiag();
  if (name === 'account') renderAccount();
}
function showLoader(name: string) { $('loaderName').textContent = `Opening ${name}…`; $('loader').hidden = false; }
function hideLoader() { $('loader').hidden = true; }
function showError(msg: string) { const el = $('homeError'); el.textContent = msg; el.hidden = false; window.showToast(msg); note('error: ' + msg); }
function clearError() { const el = $('homeError'); el.textContent = ''; el.hidden = true; }
function fmtWhen(iso: string) {
  const d = new Date(iso); if (isNaN(d.getTime())) return '';
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : days < 30 ? `${days} days ago` : d.toLocaleDateString();
}
async function refreshRecents() {
  let rows: RecentRow[] = [];
  try { rows = await listRecents(lic.currentUserId()); } catch { rows = []; }
  const cloud = await listAccountHistory(lic.isPro());
  const seen = new Set(cloud.map((c) => (c.name || '').toLowerCase() + '|' + (c.sizeBytes || 0)));
  rows = rows.filter((r) => !seen.has((r.name || '').toLowerCase() + '|' + (r.size || 0)));
  const ul = $('recentList'); ul.textContent = '';
  $('recentEmpty').hidden = cloud.length + rows.length > 0;
  for (const c of cloud) {
    const li = document.createElement('li');
    li.className = 'cloud';
    const name = document.createElement('div'); name.className = 'rname'; name.textContent = c.name;
    const meta = document.createElement('div'); meta.className = 'rmeta';
    meta.textContent = [c.format, fmtBytes(c.sizeBytes || 0), 'account', fmtWhen(c.lastOpenedAt)].filter(Boolean).join(' · ');
    li.append(name, meta);
    li.addEventListener('click', () => {
      void openWith(async () => {
        showLoader(c.name);
        const r = await openAccountLog(c.id);
        if (!r) { hideLoader(); showError('Could not open that log from your account.'); return null; }
        return { name: r.name, size: r.buffer.byteLength, file: new File([r.buffer], r.name), origin: 'cloud' as const };
      }).catch(() => {});
    });
    ul.appendChild(li);
  }
  for (const r of rows) {
    const li = document.createElement('li');
    const name = document.createElement('div'); name.className = 'rname'; name.textContent = r.name;
    const meta = document.createElement('div'); meta.className = 'rmeta';
    meta.textContent = [r.format, fmtBytes(r.size || 0), fmtWhen(r.openedAt)].filter(Boolean).join(' · ');
    li.append(name, meta);
    li.addEventListener('click', () => {
      if (!r.uri) { window.showToast('Open it again from your files or the share sheet.'); return; }
      void openWith(() => openFromUrl(r.uri as string, 'recent', r.name)).catch(() => {});
    });
    ul.appendChild(li);
  }
}
function capNote() {
  const pro = lic.isPro();
  const hpl = fmtBytes(capBytes({ pro, device, fmt: 'HPL', caps })), csv = fmtBytes(capBytes({ pro, device, fmt: 'CSV', caps }));
  $('capNote').textContent = pro ? `Pro on this ${device}: .hpl up to ${hpl}, .csv up to ${csv}.` : `Free: logs up to ${fmtBytes(capBytes({ pro: false, device, fmt: 'CSV', caps }))}. Pro on this ${device} opens .hpl up to ${fmtBytes(capBytes({ pro: true, device, fmt: 'HPL', caps }))} and .csv up to ${fmtBytes(capBytes({ pro: true, device, fmt: 'CSV', caps }))}.`;
}

const BANNERS: Record<string, { text: (s: LicenseState) => string; bad?: boolean }> = {
  dev: { text: () => 'Developer build: Pro forced on (?devpro=1).' },
  ok_offline: { text: (s) => `Offline. Pro stays active for ${s.daysLeft ?? '?'} more days without a connection.` },
  expiring_soon: { text: (s) => `Couldn't verify your Pro membership. ${s.daysLeft ?? '?'} day(s) left. Connect to the internet to keep Pro active.` },
  session_lost: { text: () => 'You were signed out on this device. Sign in again to keep Pro verified.' },
  limited: { text: () => 'Your Pro membership could not be verified for over 30 days. Pro features are locked until you reconnect.', bad: true },
  clock_tamper: { text: () => 'This device\'s clock moved backwards. Check the date and time, then reconnect to verify Pro.', bad: true },
  app_outdated: { text: () => 'This version of BigData is too old to verify your membership. Please update it from the store.', bad: true },
  activate_offline: { text: () => 'Connect to the internet once so BigData can check your membership.' },
};
function planLine(s: LicenseState): string {
  if (s.pro === true) return s.reason === 'ok' ? `AllDataLogs Pro · active${s.daysLeft != null ? ` · verified, ${s.daysLeft} days of offline grace` : ''}` : 'AllDataLogs Pro · ' + s.reason.replace(/_/g, ' ');
  if (s.pro === false) return s.reason === 'wrong_account' ? 'This account is not the one Pro was activated for on this device.' : `Free · no active Pro membership${s.status && s.status !== 'none' ? ` (${s.status})` : ''}`;
  return 'Free · ' + s.reason.replace(/_/g, ' ');
}
function applyLicense(s: LicenseState) {
  const switched = license.email !== s.email;
  license = s;
  window.setViewerPro?.(s.pro === true);
  // Scorecard is a PBD-internal dash gauge, hidden by default; the viewer unlocks it for staff sign-ins
  // (the same rule the website applies). Only ever turns it on.
  window.setScorecardEnabledForEmail?.(s.email ?? '');
  maybePullLayouts(s);
  if (switched) void refreshRecents(); // recents are per account
  $('checking').hidden = s.reason !== 'checking';
  const b = BANNERS[s.reason];
  for (const id of ['banner', 'accountBanner']) {
    const el = $(id);
    if (b) { el.textContent = b.text(s); el.classList.toggle('bad', !!b.bad); el.hidden = false; } else el.hidden = true;
  }
  $('footAccount').textContent = s.email || '';
  const pro = $('footPro');
  pro.className = s.pro === true ? 'pro' : s.pro === null && s.reason !== 'signed_out' ? 'warn' : '';
  pro.textContent = s.pro === true ? (s.reason === 'ok' ? 'Pro' : 'Pro · ' + s.reason.replace(/_/g, ' ')) : s.email ? 'Free' : '';
  $('btnAccount').textContent = s.email ? 'Account' : 'Sign in';
  capNote();
  if (screen === 'account') renderAccount();
}
function proLinkAllowed(): boolean {
  // Web-only Pro: no purchase link inside the app except where the store rules allow one (US App
  // Store storefront, switched remotely). Android never shows one in v1.
  if (native.platform !== 'ios') return false;
  return remote.proLinkIOS === true && (window.__bigdata.storefront === 'USA');
}
function renderAccount() {
  const signedIn = !!license.email && license.reason !== 'signed_out';
  $('signinCard').hidden = signedIn;
  $('accountCard').hidden = !signedIn;
  document.querySelectorAll<HTMLElement>('[data-pro-link]').forEach((el) => { el.hidden = !proLinkAllowed(); });
  if (!signedIn) { $('signinIntro').textContent = license.reason === 'activate_offline' ? 'Connect to the internet and sign in so BigData can check your membership.' : 'Sign in with your alldatalogs.com account to unlock Pro on this device.'; return; }
  $('accountEmail').textContent = license.email || '';
  $('accountPlan').textContent = planLine(license);
  void getSyncMode().then((m) => { const sel = document.getElementById('historySync') as HTMLSelectElement | null; if (sel) sel.value = m; });
  $('btnGetPro').hidden = !(license.pro !== true && proLinkAllowed());
}
function renderDiag() {
  const snap = lic.debugSnapshot();
  $('diagText').textContent = [
    `BigData ${__APP_VERSION__} · ${native.platform} · ${device} · ${window.screen.width}x${window.screen.height} @${window.devicePixelRatio}`,
    `viewport ${window.innerWidth}x${window.innerHeight} · online ${navigator.onLine} · worker ${workerBroken ? 'BROKEN (sync fallback)' : 'ok'}`,
    `caps ${JSON.stringify(caps)}`,
    `remote ${JSON.stringify(remote)} · storefront ${window.__bigdata.storefront || '?'}`,
    `licence ${JSON.stringify(snap.state)}`,
    `store ${JSON.stringify(snap.store)} · install ${snap.installId}`,
    `engine ${typeof (window as any).VIEWER_VERSION !== 'undefined' ? (window as any).VIEWER_VERSION : '?'} · DVCore ${!!window.DVCore} · library ${!!(window as any).Library}`,
    '', 'log:', ...log.slice(-60),
  ].join('\n');
}

// ---- Viewer open/close side effects (landscape lock, wake lock, back button) ---------------------------
function watchViewer() {
  const overlay = document.getElementById('viewerOverlay');
  if (!overlay) return;
  let open = overlay.classList.contains('open');
  const sync = () => {
    const now = overlay.classList.contains('open');
    if (now === open) return;
    open = now;
    if (now) { void native.lockLandscape(); void native.keepAwake(true); note('viewer open'); }
    else { void native.unlockOrientation(); void native.keepAwake(false); note('viewer closed'); void refreshRecents(); }
  };
  new MutationObserver(sync).observe(overlay, { attributes: true, attributeFilter: ['class'] });
  sync();
}
function viewerIsOpen() { const o = document.getElementById('viewerOverlay'); return !!o && o.classList.contains('open'); }

// ---- Wiring --------------------------------------------------------------------------------------------
function wire() {
  document.querySelectorAll<HTMLElement>('[data-ext]').forEach((el) => el.addEventListener('click', () => { void native.openExternal(el.dataset.ext || ''); }));
  document.querySelectorAll<HTMLElement>('[data-nav]').forEach((el) => el.addEventListener('click', () => showScreen((el.dataset.nav as Screen) || 'home')));
  $('btnOpen').addEventListener('click', () => { void openWith(openFromPicker); });
  $('btnSample').addEventListener('click', () => { void openWith(openSample); });
  $('btnCancelLoad').addEventListener('click', cancelLoad);
  $('btnAccount').addEventListener('click', () => showScreen('account'));
  $('btnDiag').addEventListener('click', () => showScreen('diag'));
  $('btnDiagCopy').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('diagText').textContent || ''); window.showToast('Copied.'); } catch { window.showToast('Could not copy.'); } });
  $('btnRefresh').addEventListener('click', async () => { applyLicense(await lic.refresh()); window.showToast('Membership checked.'); });
  $('btnSignOut').addEventListener('click', async () => { await lic.signOut(); applyLicense(lic.getState()); showScreen('home'); });
  $('btnDeleteAccount').addEventListener('click', async () => {
    if (!window.confirm('Delete your AllDataLogs account? This cancels any subscription, removes your uploaded logs and layouts, and cannot be undone.')) return;
    if (!window.confirm('Really delete the account ' + (license.email || '') + '?')) return;
    const r = await deleteAccount();
    if (!r.ok) { window.showToast(r.error || 'Could not delete the account.'); return; }
    await lic.signOut(); applyLicense(lic.getState()); showScreen('home'); window.showToast('Your account has been deleted.');
  });
  const form = $<HTMLFormElement>('signinForm'), err = $('signinError'), btn = $<HTMLButtonElement>('signinBtn');
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); err.hidden = true; btn.disabled = true;
    try {
      const r = await lic.signIn($<HTMLInputElement>('signinEmail').value.trim(), $<HTMLInputElement>('signinPassword').value);
      if (!r.ok) { err.textContent = r.error || 'Sign-in failed.'; err.hidden = false; }
      else { $<HTMLInputElement>('signinPassword').value = ''; applyLicense(lic.getState()); showScreen('home'); }
    } catch (ex) { err.textContent = errMsg(ex, 'Sign-in failed.'); err.hidden = false; }
    finally { btn.disabled = false; }
  });
  $('footVersion').textContent = 'v' + __APP_VERSION__;
  native.onBackButton(() => {
    if (viewerIsOpen()) { window.closeViewer?.(); return; }
    if (!$('loader').hidden) { cancelLoad(); return; }
    if (screen !== 'home') { showScreen('home'); return; }
    void native.exitApp();
  });
  native.onAppActive((active) => { if (active) lic.refreshIfStale(); });
  native.onOnline(() => { lic.refresh().catch(() => {}); });
  native.onUrlOpen(openUrl);
  window.addEventListener('error', (e) => note('error: ' + (e.message || '?')));
  window.addEventListener('unhandledrejection', (e) => note('rejection: ' + errMsg((e as PromiseRejectionEvent).reason, '?')));
}

async function loadRemoteConfig() {
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 6000);
    const res = await fetch(REMOTE_CONFIG_URL, { cache: 'no-store', signal: ctl.signal }).finally(() => clearTimeout(t));
    if (!res.ok) return;
    const j = await res.json();
    if (j && typeof j === 'object') { remote = { proLinkIOS: !!j.proLinkIOS, minVersion: j.minVersion, message: j.message }; if (j.caps) caps = mergeCaps(j.caps); capNote(); }
  } catch { /* offline: defaults */ }
}
async function oomCheck() {
  const raw = await native.prefGet(OPEN_MARK);
  if (!raw) return;
  await native.prefRemove(OPEN_MARK);
  try { const m = JSON.parse(raw); note('previous open did not finish: ' + m.name); showError(`BigData ran out of memory opening ${m.name} (${fmtBytes(m.size || 0)}) last time. Try a smaller log, or open it on the website or BigData for Windows.`); } catch { /* ignore */ }
}

// ---- Boot -----------------------------------------------------------------------------------------------
async function boot() {
  window.__bigdata = { version: __APP_VERSION__, platform: native.platform, device, storefront: null };
  // Order matters (runtime.js rebuilds window.DATAVIEWER; the engine caches Pro separately):
  // configure → inject the overlay DOM → then tell the engine about Pro, and again on every change.
  window.configureViewer({ brand: { mark: 'B', name: 'BigData', sub: 'DATALOG VIEWER' }, layouts: layoutProvider, library: buildLibraryProvider({ isPro: () => lic.isPro() }) });
  window.ensureViewerDom();
  wire();
  watchViewer();
  showScreen('home');
  applyLicense(await lic.initLicensing());
  lic.onChange(applyLicense);
  void refreshRecents();
  const syncSel = document.getElementById('historySync') as HTMLSelectElement | null;
  if (syncSel) syncSel.addEventListener('change', () => { void setSyncMode(syncSel.value as SyncMode); });
  void loadRemoteConfig();
  await native.hideSplash();
  booted = true;
  const launch = await native.launchUrl();
  if (launch) openUrl(launch);
  for (const u of queuedUrls.splice(0)) openUrl(u);
  await oomCheck();
  note(`booted ${native.platform}/${device}`);
}

boot().catch((e) => { console.error(e); showError('BigData failed to start: ' + errMsg(e, String(e))); });
