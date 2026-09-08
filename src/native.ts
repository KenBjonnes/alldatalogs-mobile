/*
 * native.ts — the only file that talks to Capacitor plugins. Everything is wrapped so a missing or
 * failing plugin degrades to a no-op (the web platform, used for development in a desktop browser,
 * has no orientation lock, no keep-awake, no secure keychain) instead of taking the app down.
 */
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Preferences } from '@capacitor/preferences';
import { Network } from '@capacitor/network';
import { ScreenOrientation } from '@capacitor/screen-orientation';
import { SplashScreen } from '@capacitor/splash-screen';
import { KeepAwake } from '@capacitor-community/keep-awake';
import { FilePicker } from '@capawesome/capacitor-file-picker';
import { SecureStorage } from '@aparajita/capacitor-secure-storage';

export type Platform = 'android' | 'ios' | 'web';
export type DeviceClass = 'phone' | 'tablet';

export const platform = Capacitor.getPlatform() as Platform;
export const isNative = Capacitor.isNativePlatform();

/** Phones get the engine's landscape-only layout and the smaller memory caps; tablets the desktop layout. */
export function deviceClass(): DeviceClass {
  const short = Math.min(window.screen.width || 0, window.screen.height || 0);
  return short >= 600 ? 'tablet' : 'phone';
}

const quiet = async <T>(p: Promise<T>, fallback: T): Promise<T> => { try { return await p; } catch { return fallback; } };

// ---- Preferences (plain, unencrypted key/value: licence store, install id, recents, markers) ----
export async function prefGet(key: string): Promise<string | null> {
  const r = await quiet(Preferences.get({ key }), { value: null as string | null });
  return r && typeof r.value === 'string' ? r.value : null;
}
export async function prefSet(key: string, value: string): Promise<void> { await quiet(Preferences.set({ key, value }), undefined); }
export async function prefRemove(key: string): Promise<void> { await quiet(Preferences.remove({ key }), undefined); }

// ---- Secure storage (Keychain / Android Keystore): the Supabase session only -------------------
// NOTE: never `return SecureStorage` from an async function or `await` the plugin object itself: a
// Capacitor plugin is a Proxy that turns ANY property (including `then`) into a native call, so awaiting
// it invokes "SecureStorage.then()" and throws on platforms without that method.
let securePrefix: Promise<void> | null = null;
function securePrefixed(): Promise<void> {
  if (!securePrefix) securePrefix = quiet(SecureStorage.setKeyPrefix('bigdata_'), undefined);
  return securePrefix;
}
export async function secureGet(key: string): Promise<string | null> {
  await securePrefixed();
  const v = await quiet(SecureStorage.get(key, false), null);
  return typeof v === 'string' ? v : v == null ? null : JSON.stringify(v);
}
export async function secureSet(key: string, value: string): Promise<boolean> {
  await securePrefixed();
  try { await SecureStorage.set(key, value); return true; } catch { return false; }
}
export async function secureRemove(key: string): Promise<void> { await securePrefixed(); await quiet(SecureStorage.remove(key), undefined); }

// ---- Links, orientation, wake lock, splash ---------------------------------------------------------
export async function openExternal(url: string): Promise<void> {
  if (isNative) await quiet(Browser.open({ url, presentationStyle: 'popover' }), undefined);
  else window.open(url, '_blank', 'noopener');
}
export async function lockLandscape(): Promise<void> {
  if (!isNative || deviceClass() !== 'phone') return;
  await quiet(ScreenOrientation.lock({ orientation: 'landscape' }), undefined);
}
export async function unlockOrientation(): Promise<void> {
  if (!isNative) return;
  await quiet(ScreenOrientation.unlock(), undefined);
}
export async function keepAwake(on: boolean): Promise<void> {
  if (!isNative) return;
  await quiet(on ? KeepAwake.keepAwake() : KeepAwake.allowSleep(), undefined);
}
export async function hideSplash(): Promise<void> { await quiet(SplashScreen.hide(), undefined); }
export async function exitApp(): Promise<void> { await quiet(App.exitApp(), undefined); }

// ---- App events ------------------------------------------------------------------------------------
export function onBackButton(cb: () => void): void {
  if (!isNative) return;
  void quiet(App.addListener('backButton', () => cb()), undefined);
}
export function onAppActive(cb: (active: boolean) => void): void {
  void quiet(App.addListener('appStateChange', (s) => cb(!!s.isActive)), undefined);
  if (!isNative) document.addEventListener('visibilitychange', () => cb(document.visibilityState === 'visible'));
}
export function onUrlOpen(cb: (url: string) => void): void {
  void quiet(App.addListener('appUrlOpen', (e) => { if (e && e.url) cb(e.url); }), undefined);
}
export async function launchUrl(): Promise<string | null> {
  const r = await quiet(App.getLaunchUrl(), null as { url?: string } | null);
  return r && typeof r.url === 'string' && r.url ? r.url : null;
}
export function onOnline(cb: () => void): void {
  void quiet(Network.addListener('networkStatusChange', (s) => { if (s.connected) cb(); }), undefined);
  window.addEventListener('online', cb);
}
export async function isOnline(): Promise<boolean> {
  const s = await quiet(Network.getStatus(), null as { connected?: boolean } | null);
  return s ? !!s.connected : navigator.onLine !== false;
}

// ---- Files -----------------------------------------------------------------------------------------
export interface PickedLog { name: string; size: number; blob?: Blob; webPath?: string; path?: string }

/** The system file picker, one file, no type filter (datalog extensions are not registered MIME types). */
export async function pickLog(): Promise<PickedLog | null> {
  try {
    const r = await FilePicker.pickFiles({ limit: 1, readData: false });
    const f = r && r.files && r.files[0];
    if (!f) return null;
    const webPath = (f as { webPath?: string }).webPath || (f.path ? Capacitor.convertFileSrc(f.path) : undefined);
    return { name: f.name || 'log', size: f.size || 0, blob: f.blob, webPath, path: f.path };
  } catch (e) {
    if (/cancel/i.test(String(e && (e as Error).message))) return null;
    throw e;
  }
}

/** Turn a content:// or file:// URL (Open with, share sheet, recents) into something fetch() can read. */
export function webPathOf(url: string): string {
  if (/^(https?|capacitor|blob):/i.test(url)) return url;
  try { return Capacitor.convertFileSrc(url); } catch { return url; }
}
