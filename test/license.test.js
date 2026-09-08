// license.test.js — the desktop's licence cases (alldatalogs-desktop test/license.test.js) against the
// TypeScript port. Node 24 strips types, so the .ts module is imported directly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, DAY_MS } from '../src/license.ts';

const NOW = Date.UTC(2026, 8, 7, 12, 0, 0);
const sec = (ms) => Math.floor(ms / 1000);
const SESSION = { userId: 'u1', email: 'ken@example.com' };
const INSTALL = 'inst-1';
const claims = (o) => ({ v: 1, iss: 'alldatalogs', aud: 'bigdata-mobile', sub: 'u1', email: 'tok@example.com', pro: true, status: 'active', mid: INSTALL, iat: sec(NOW) - 60, exp: sec(NOW) + 30 * 86400, ...o });
const live = (o) => ({ ok: true, claims: claims(o), kid: 'k' });
const expired = (o) => ({ ok: false, error: 'expired', claims: claims({ exp: sec(NOW) - 5, ...o }), kid: 'k' });
const store = (o) => ({ token: 'tok', fetchedAt: NOW - 3600_000, clockHighWater: NOW - 60_000, lastResult: 'ok', lastResultAt: NOW - 3600_000, ...o });
const run = (o) => evaluate({ store: store(), verified: null, now: NOW, session: SESSION, installId: INSTALL, encryptionAvailable: true, ...o });

test('signed out: no session, no token', () => {
  const s = run({ session: null, store: store({ token: null, lastResult: null }) });
  assert.equal(s.pro, null); assert.equal(s.reason, 'signed_out');
});
test('signed in, never fetched / fetch failed: must activate online', () => {
  assert.equal(run({ store: store({ token: null, lastResult: null }) }).reason, 'activate_offline');
  assert.equal(run({ store: store({ token: null, lastResult: 'network' }) }).reason, 'activate_offline');
});
test('live pro token, fresh refresh -> ok with daysLeft', () => {
  const s = run({ verified: live() });
  assert.equal(s.pro, true); assert.equal(s.reason, 'ok'); assert.equal(s.daysLeft, 30); assert.equal(s.email, 'ken@example.com');
});
test('live pro token, last refresh failed -> ok_offline, then expiring_soon', () => {
  assert.equal(run({ verified: live(), store: store({ lastResult: 'network' }) }).reason, 'ok_offline');
  const s = run({ verified: live({ exp: sec(NOW) + 5 * 86400 }), store: store({ lastResult: 'server' }) });
  assert.equal(s.reason, 'expiring_soon'); assert.equal(s.daysLeft, 5);
});
test('session gone or rejected -> still pro, session_lost', () => {
  assert.equal(run({ verified: live(), session: null }).reason, 'session_lost');
  assert.equal(run({ verified: live(), store: store({ lastResult: 'unauthorized' }) }).reason, 'session_lost');
});
test('expired pro token -> limited when signed in, signed_out otherwise', () => {
  assert.equal(run({ verified: expired(), store: store({ lastResult: 'network' }) }).reason, 'limited');
  assert.equal(run({ verified: expired(), session: null }).reason, 'signed_out');
});
test('signed negative is definitive, expired or not', () => {
  const a = run({ verified: live({ pro: false, status: 'expired' }), store: store({ lastResult: 'not_pro' }) });
  assert.equal(a.pro, false); assert.equal(a.reason, 'not_pro'); assert.equal(a.status, 'expired');
  assert.equal(run({ verified: expired({ pro: false, status: 'billing_issue' }), store: store({ lastResult: 'network' }) }).reason, 'not_pro');
});
test('token bound to another install is ignored', () => {
  assert.equal(run({ verified: live({ mid: 'other' }) }).reason, 'activate_offline');
  assert.equal(run({ verified: live({ mid: 'other' }), session: null }).reason, 'signed_out');
});
test('token for another account -> wrong_account', () => {
  const s = run({ verified: live({ sub: 'u2' }) });
  assert.equal(s.pro, false); assert.equal(s.reason, 'wrong_account');
});
test('clock moved backwards beyond a day -> clock_tamper; within a day tolerated', () => {
  assert.equal(run({ verified: live(), store: store({ clockHighWater: NOW + 3 * DAY_MS }) }).reason, 'clock_tamper');
  assert.equal(run({ verified: live(), store: store({ clockHighWater: NOW + 12 * 3600_000 }) }).reason, 'ok');
});
test('server said the app is too old -> app_outdated', () => {
  assert.equal(run({ verified: live(), store: store({ lastResult: 'outdated' }) }).reason, 'app_outdated');
});
test('bad signature counts as no token', () => {
  assert.equal(run({ verified: { ok: false, error: 'bad_signature' } }).reason, 'activate_offline');
});
test('storage unavailable is reported alongside the state', () => {
  const s = run({ verified: live(), encryptionAvailable: false });
  assert.equal(s.reason, 'ok'); assert.equal(s.storageUnavailable, true);
});
