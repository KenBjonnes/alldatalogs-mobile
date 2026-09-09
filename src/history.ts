/*
 * history.ts — account history on the phone (Ken, 2026-09-09: the same History on every device). The
 * logic is the website's apps/web/lib/history.ts, bundled here through the @site alias; this file adds
 * the phone's own rules: a Wi-Fi-only default (an upload of a 40 MB log on cellular is nobody's idea of
 * "just open it"), the Pro + signed-in gate, and the preference that holds the choice.
 */
import { autoSaveLog, listHistory, openHistory, mergeHistory, type HistoryRow, type AutoSaveResult } from '@site/history';
import { sb, getSession } from './supabase.ts';
import { prefGet, prefSet, connectionType } from './native.ts';

export type SyncMode = 'wifi' | 'always' | 'off';
const KEY = 'bigdata.historySync';

export async function getSyncMode(): Promise<SyncMode> {
  const v = await prefGet(KEY);
  return v === 'always' || v === 'off' ? v : 'wifi';
}
export async function setSyncMode(m: SyncMode): Promise<void> { await prefSet(KEY, m); }

/** Wi-Fi only = anything that is not known to be cellular (the web dev build reports 'unknown'). */
export async function maySyncNow(): Promise<boolean> {
  const m = await getSyncMode();
  if (m === 'off') return false;
  if (m === 'always') return true;
  return (await connectionType()) !== 'cellular';
}

/** After a log opened from the picker / share sheet / a file: save it to the account (Pro, signed in, sync allowed). */
export async function autoSaveOpened(file: File, name: string, format: string, isPro: boolean): Promise<AutoSaveResult | null> {
  try {
    if (!isPro || !(await getSession()) || !(await maySyncNow())) return null;
    return await autoSaveLog(sb(), await file.arrayBuffer(), name, format);
  } catch { return null; }
}
export async function listAccountHistory(isPro: boolean): Promise<HistoryRow[]> {
  try { if (!isPro || !(await getSession())) return []; return await listHistory(sb()); } catch { return []; }
}
export async function openAccountLog(id: string): Promise<{ name: string; format: string; buffer: ArrayBuffer } | null> {
  try { return await openHistory(sb(), id); } catch { return null; }
}
export { mergeHistory };
export type { HistoryRow };
