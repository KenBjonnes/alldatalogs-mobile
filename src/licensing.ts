/*
 * licensing.ts — the runtime around the pure decision in license.ts: persistence (Preferences), the
 * install id, the server refresh, timers, and change notification. Port of the desktop app's
 * main/license.js plumbing.
 */
import { verifyJws } from '@site/jws';
import { evaluate, emptyStore, REFRESH_EVERY_MS, STALE_AFTER_MS, type LicenseState, type LicenseStore, type Verified } from './license.ts';
import { ENTITLEMENT_KEYS, TOKEN_ISS, TOKEN_AUD } from './config.ts';
import { prefGet, prefSet, isNative, platform } from './native.ts';
import { getSession, signIn as sbSignIn, signOut as sbSignOut, fetchEntitlementToken, isSecureStorageOk } from './supabase.ts';

const STORE_KEY = 'bigdata.license.v1';
const INSTALL_KEY = 'bigdata.installId';

// Developer convenience for the web platform ONLY (npm run web → http://localhost:5174/?devpro=1).
// Never honoured in a native build.
const DEV_PRO = !isNative && platform === 'web' && /[?&]devpro=1/.test(location.search);

let store: LicenseStore = emptyStore();
let installId = '';
let state: LicenseState = DEV_PRO
  ? { pro: true, reason: 'dev', status: 'active', daysLeft: null, email: 'dev@localhost', storageUnavailable: false }
  : { pro: null, reason: 'signed_out', status: null, daysLeft: null, email: null, storageUnavailable: false };
let refreshing: Promise<LicenseState> | null = null;
let inFlight = false;
const listeners = new Set<(s: LicenseState) => void>();

export function getState(): LicenseState { return state; }
export function isPro(): boolean { return state.pro === true; }
export function onChange(cb: (s: LicenseState) => void): () => void { listeners.add(cb); return () => listeners.delete(cb); }

async function readStore(): Promise<LicenseStore> {
  try { const o = JSON.parse((await prefGet(STORE_KEY)) || 'null'); if (o && typeof o === 'object') return { ...emptyStore(), ...o }; } catch { /* none */ }
  return emptyStore();
}
async function writeStore(): Promise<void> { await prefSet(STORE_KEY, JSON.stringify(store)); }
async function loadInstallId(): Promise<string> {
  const v = (await prefGet(INSTALL_KEY)) || '';
  if (/^[a-f0-9-]{36}$/i.test(v)) return v;
  const id = (crypto && 'randomUUID' in crypto) ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 3) | 8).toString(16); });
  await prefSet(INSTALL_KEY, id);
  return id;
}

function broadcast() { for (const cb of listeners) { try { cb(state); } catch { /* listener error */ } } }

async function verifyStored(now: number): Promise<Verified | null> {
  if (!store.token) return null;
  try { return await verifyJws(store.token, { keys: ENTITLEMENT_KEYS, iss: TOKEN_ISS, aud: TOKEN_AUD, now: Math.floor(now / 1000) }) as Verified; }
  catch { return { ok: false, error: 'malformed' }; }
}
async function sessionInfo() {
  const s = await getSession();
  return s && s.user ? { userId: s.user.id, email: s.user.email || null, accessToken: s.access_token } : null;
}

async function recompute(): Promise<LicenseState> {
  if (DEV_PRO) return state;
  const now = Date.now();
  if (now > (store.clockHighWater || 0)) { store.clockHighWater = now; await writeStore(); }
  const session = await sessionInfo();
  const verified = await verifyStored(now);
  const next = evaluate({ store, verified, now, session, installId, encryptionAvailable: isSecureStorageOk() });
  if (inFlight && next.reason === 'activate_offline') next.reason = 'checking';
  const changed = JSON.stringify(next) !== JSON.stringify(state);
  state = next;
  if (changed) broadcast();
  return state;
}

/** Contact the server for a fresh token (never throws; never demotes on failure). */
export async function refresh(): Promise<LicenseState> {
  if (DEV_PRO) return state;
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      inFlight = true;
      const session = await sessionInfo();
      if (!session) { inFlight = false; return recompute(); }
      await recompute();
      const r = await fetchEntitlementToken(session.accessToken, installId);
      const now = Date.now();
      if (r.kind === 'ok') {
        const v = await verifyJws(r.token, { keys: ENTITLEMENT_KEYS, iss: TOKEN_ISS, aud: TOKEN_AUD, now: Math.floor(now / 1000) });
        if (v.ok && v.claims.mid === installId && v.claims.sub === session.userId) {
          store.token = r.token;
          store.fetchedAt = now;
          store.clockHighWater = Math.max(now, (Number(v.claims.iat) || 0) * 1000);
          store.lastResult = v.claims.pro === true ? 'ok' : 'not_pro';
        } else store.lastResult = 'bad_token';
      } else store.lastResult = r.kind;
      store.lastResultAt = now;
      await writeStore();
      inFlight = false;
      return recompute();
    } catch {
      inFlight = false;
      return recompute();
    } finally {
      inFlight = false;
      refreshing = null;
    }
  })();
  return refreshing;
}

export async function signIn(email: string, password: string): Promise<{ ok: boolean; error?: string }> {
  if (DEV_PRO) return { ok: true };
  const r = await sbSignIn(String(email || '').trim(), String(password || ''));
  if (!r.ok) return r;
  await refresh();
  return { ok: true };
}
export async function signOut(): Promise<void> {
  if (DEV_PRO) return;
  await sbSignOut();
  store = { ...emptyStore(), clockHighWater: store.clockHighWater || 0 };
  await writeStore();
  await recompute();
}
export function refreshIfStale(): void {
  const at = store.lastResultAt || 0;
  if (Date.now() - at > STALE_AFTER_MS) refresh().catch(() => {});
}

/** Boot: decide from what is on the device immediately, then go online for a fresh answer. */
export async function initLicensing(): Promise<LicenseState> {
  installId = await loadInstallId();
  store = await readStore();
  setInterval(() => { refresh().catch(() => {}); }, REFRESH_EVERY_MS);
  const s = await recompute();
  refresh().catch(() => {});
  return s;
}
export function getInstallId(): string { return installId; }
export function debugSnapshot() {
  return { installId, state, store: { ...store, token: store.token ? store.token.slice(0, 24) + '…' : null }, devPro: DEV_PRO };
}
