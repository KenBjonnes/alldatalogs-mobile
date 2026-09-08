/*
 * license.ts — the licence decision, ported verbatim from the desktop app (alldatalogs-desktop
 * main/license.js evaluate()), plus the mobile plumbing around it.
 *
 * The truth is a signed token from the issue-entitlement-token edge function (aud 'bigdata-mobile'),
 * verified here with the embedded PUBLIC keys through the site's own _shared/jws.ts (WebCrypto only).
 * Its lifetime is the offline grace period. Principles: only a VERIFIED "not Pro" demotes; network
 * trouble, server errors, a dead session or a bad signature keep the last known state; a token is
 * bound to this install (mid) and to the signed-in account (sub).
 *
 * The one behavioural difference from the desktop: this app has a FREE tier. Every state may open
 * logs at the free cap; only `pro === true` states use the Pro caps and unlock Pro features.
 */

export type LicenseReason =
  | 'ok' | 'ok_offline' | 'expiring_soon' | 'session_lost'
  | 'not_pro' | 'wrong_account'
  | 'signed_out' | 'activate_offline' | 'limited' | 'clock_tamper' | 'app_outdated' | 'checking' | 'dev';

export interface LicenseState {
  pro: boolean | null;
  reason: LicenseReason;
  status: string | null;
  daysLeft: number | null;
  email: string | null;
  storageUnavailable: boolean;
}

export type LastResult = 'ok' | 'not_pro' | 'network' | 'server' | 'unauthorized' | 'outdated' | 'bad_token' | null;

export interface LicenseStore {
  token: string | null;
  fetchedAt: number | null;
  clockHighWater: number;
  lastResult: LastResult;
  lastResultAt: number | null;
}

export interface Claims { [k: string]: unknown; sub?: string; email?: string; pro?: boolean; status?: string; mid?: string; iat?: number; exp?: number }
export type Verified =
  | { ok: true; claims: Claims; kid: string }
  | { ok: false; error: 'expired'; claims: Claims; kid: string }
  | { ok: false; error: string };

export interface EvaluateInput {
  store: LicenseStore;
  verified: Verified | null;
  now: number;
  session: { userId: string; email: string | null } | null;
  installId: string;
  encryptionAvailable?: boolean;
}

export const DAY_MS = 86_400_000;
export const REFRESH_EVERY_MS = 6 * 3_600_000;
export const STALE_AFTER_MS = 6 * 3_600_000;
const TAMPER_SLACK_MS = DAY_MS;
const EXPIRING_DAYS = 7;

export function emptyStore(): LicenseStore {
  return { token: null, fetchedAt: null, clockHighWater: 0, lastResult: null, lastResultAt: null };
}

function mkState(pro: boolean | null, reason: LicenseReason, extra?: Partial<LicenseState>): LicenseState {
  return { pro, reason, status: null, daysLeft: null, email: null, storageUnavailable: false, ...(extra || {}) };
}

export function evaluate(input: EvaluateInput): LicenseState {
  const { store, verified, now, session, installId } = input;
  const storageUnavailable = input.encryptionAvailable === false;
  const claims: Claims | null = verified && (verified.ok || (verified as { error?: string }).error === 'expired') ? (verified as { claims: Claims }).claims : null;
  const live = !!(verified && verified.ok);
  const lastResult = store && store.lastResult ? store.lastResult : null;
  const refreshFailed = lastResult === 'network' || lastResult === 'server' || lastResult === 'bad_token';
  const email = (session && session.email) || (claims && typeof claims.email === 'string' ? claims.email : null);
  const withCommon = (s: LicenseState): LicenseState => ({ ...s, email: s.email || email, storageUnavailable });

  const foreignInstall = !!(claims && claims.mid !== installId);
  const wrongAccount = !!(claims && session && claims.sub !== session.userId);
  if (wrongAccount) return withCommon(mkState(false, 'wrong_account', { email: session!.email }));

  const usable = claims && !foreignInstall ? claims : null;

  if (lastResult === 'outdated') return withCommon(mkState(null, 'app_outdated'));
  if (!session && !usable) return withCommon(mkState(null, 'signed_out', { email: null }));

  if (usable && usable.pro === false) {
    return withCommon(mkState(false, 'not_pro', { status: typeof usable.status === 'string' ? usable.status : 'none' }));
  }

  const highWater = store && typeof store.clockHighWater === 'number' ? store.clockHighWater : 0;
  if (highWater && now < highWater - TAMPER_SLACK_MS) return withCommon(mkState(null, 'clock_tamper'));

  if (usable && usable.pro === true && live) {
    const daysLeft = Math.max(0, Math.ceil(((usable.exp as number) * 1000 - now) / DAY_MS));
    const base = { status: typeof usable.status === 'string' ? usable.status : 'active', daysLeft };
    if (!session || lastResult === 'unauthorized') return withCommon(mkState(true, 'session_lost', base));
    if (refreshFailed) return withCommon(mkState(true, daysLeft <= EXPIRING_DAYS ? 'expiring_soon' : 'ok_offline', base));
    return withCommon(mkState(true, 'ok', base));
  }

  if (usable && usable.pro === true && !live) {
    if (!session) return withCommon(mkState(null, 'signed_out', { email: null }));
    return withCommon(mkState(null, 'limited', { status: typeof usable.status === 'string' ? usable.status : null }));
  }

  return withCommon(mkState(null, 'activate_offline'));
}

/** Free tier: which cap applies. Pro states get the Pro cap; everything else the free cap. */
export function isProState(s: LicenseState): boolean { return s.pro === true; }
