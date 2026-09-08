/*
 * files.ts — getting a datalog into memory from wherever a phone can hand it to us: the system
 * picker, an "Open with" / share-sheet launch URL, or the recents list. Files are read with fetch()
 * over Capacitor's local server (never base64 through the bridge), and only ever as a Blob until the
 * worker asks for the bytes.
 */
import { pickLog, webPathOf, prefGet, prefSet } from './native.ts';
import { fmtOf, isLogName } from './caps.ts';

export interface LogSource { name: string; size: number; file: File; origin: 'picker' | 'open-with' | 'share' | 'recent' | 'sample'; uri?: string }
export interface RecentRow { name: string; size: number; format: string; openedAt: string; uri?: string }

const RECENTS_KEY = 'bigdata.recents.v1';
const RECENTS_MAX = 12;

async function blobFromWebPath(webPath: string): Promise<Blob> {
  const res = await fetch(webPath);
  if (!res.ok) throw new Error(`Could not read the file (${res.status}).`);
  return res.blob();
}

/** The system file picker. Returns null when the user cancels. */
export async function openFromPicker(): Promise<LogSource | null> {
  const p = await pickLog();
  if (!p) return null;
  if (!isLogName(p.name)) throw new Error(`"${p.name}" is not a datalog. BigData opens .hpl, .csv, .ld and .dl files.`);
  const blob = p.blob || (p.webPath ? await blobFromWebPath(p.webPath) : null);
  if (!blob) throw new Error('The picker returned no file data.');
  return { name: p.name, size: blob.size || p.size, file: new File([blob], p.name), origin: 'picker', uri: p.path || p.webPath };
}

/** A content:// or file:// URL from "Open with", the share sheet or a recent entry. */
export async function openFromUrl(url: string, origin: LogSource['origin'] = 'open-with', nameHint?: string): Promise<LogSource> {
  const name = nameHint || decodeURIComponent((url.split('?')[0].split('/').pop() || 'log')).replace(/^.*[:]/, '') || 'log';
  const blob = await blobFromWebPath(webPathOf(url));
  const finalName = isLogName(name) ? name : `${name}.csv`;
  return { name: finalName, size: blob.size, file: new File([blob], finalName), origin, uri: url };
}

export async function openSample(): Promise<LogSource> {
  const res = await fetch('/sample/mile.hpl');
  if (!res.ok) throw new Error('Sample log missing from this build.');
  const blob = await res.blob();
  return { name: 'mile.hpl', size: blob.size, file: new File([blob], 'mile.hpl'), origin: 'sample' };
}

// ---- recents ---------------------------------------------------------------------------------------
// Scoped by the signed-in account (`who` = user id, or 'anon' while signed out): a shared phone must
// not show one person's logs to the next (Ken, 2026-09-08, reported on the Windows app first).
function recentsKey(who: string | null) { return RECENTS_KEY + ':' + (who || 'anon'); }
export async function listRecents(who: string | null): Promise<RecentRow[]> {
  try { const a = JSON.parse((await prefGet(recentsKey(who))) || '[]'); return Array.isArray(a) ? a.filter((r) => r && r.name) : []; } catch { return []; }
}
export async function noteRecent(src: LogSource, who: string | null): Promise<void> {
  if (src.origin === 'sample') return;
  const rows = (await listRecents(who)).filter((r) => !(r.name === src.name && r.size === src.size));
  rows.unshift({ name: src.name, size: src.size, format: fmtOf(src.name), openedAt: new Date().toISOString(), uri: src.uri });
  await prefSet(recentsKey(who), JSON.stringify(rows.slice(0, RECENTS_MAX)));
}
export async function clearRecents(who: string | null): Promise<void> { await prefSet(recentsKey(who), '[]'); }
