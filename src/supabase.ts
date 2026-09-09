/*
 * supabase.ts — the app's only Supabase client. Auth (email + password, the same accounts as
 * alldatalogs.com), session persistence in the device keychain / keystore, the entitlement token
 * request, cloud layouts and the shared-library provider. Ported from the desktop app's
 * main/supabase.js and the site's apps/web/lib/library.ts.
 *
 * Sign-out is LOCAL scope on purpose: 'global' would also sign the user out of the website.
 */
import { createClient, type SupabaseClient, type Session } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY, ENTITLEMENT_FUNCTION } from './config.ts';
import { secureGet, secureSet, secureRemove, platform } from './native.ts';

declare const __APP_VERSION__: string;

let client: SupabaseClient | null = null;
const memory = new Map<string, string>();
let secureOk = true;

const storage = {
  async getItem(key: string) {
    if (memory.has(key)) return memory.get(key) as string;
    return secureGet(key);
  },
  async setItem(key: string, value: string) {
    memory.set(key, value);
    if (!(await secureSet(key, value))) secureOk = false;
  },
  async removeItem(key: string) {
    memory.delete(key);
    await secureRemove(key);
  },
};

export function sb(): SupabaseClient {
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storage, storageKey: 'bigdata-auth' },
      global: { headers: { 'x-client-info': `bigdata-mobile-${platform}/${__APP_VERSION__}` } },
    });
  }
  return client;
}
export function isSecureStorageOk(): boolean { return secureOk; }

export async function getSession(): Promise<Session | null> {
  try { const { data } = await sb().auth.getSession(); return data && data.session ? data.session : null; } catch { return null; }
}

function mapAuthError(err: unknown): string {
  const e = err as { message?: string; code?: string; name?: string } | null;
  const msg = (e && e.message) || '';
  const code = (e && (e.code || e.name)) || '';
  const all = code + msg;
  if (/email_not_confirmed/i.test(all)) return 'Please confirm your email address first (check your inbox), then sign in.';
  if (/invalid login credentials|invalid_credentials/i.test(all)) return 'Wrong email or password.';
  if (/fetch|network|ENOTFOUND|ECONN|timeout|Load failed/i.test(all)) return 'Could not reach alldatalogs.com. Check your internet connection.';
  if (/rate/i.test(all)) return 'Too many attempts. Please wait a minute and try again.';
  return msg || 'Sign-in failed.';
}

export async function signIn(email: string, password: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const { data, error } = await sb().auth.signInWithPassword({ email, password });
    if (error || !data || !data.session) return { ok: false, error: mapAuthError(error) };
    return { ok: true };
  } catch (e) { return { ok: false, error: mapAuthError(e) }; }
}
export async function signOut(): Promise<void> {
  try { await sb().auth.signOut({ scope: 'local' }); } catch { /* ignore */ }
  memory.clear();
  await secureRemove('bigdata-auth');
}

export type TokenResult =
  | { kind: 'ok'; token: string; pro: boolean; status: string | null }
  | { kind: 'unauthorized' | 'outdated' | 'server' | 'network'; error: string };

/** Ask the edge function for a signed entitlement token (aud bigdata-mobile). */
export async function fetchEntitlementToken(accessToken: string, installId: string): Promise<TokenResult> {
  const url = `${SUPABASE_URL}/functions/v1/${ENTITLEMENT_FUNCTION}`;
  let res: Response;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 20000);
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}`, apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify({ installId, appVersion: __APP_VERSION__, client: 'mobile', platform }),
      signal: ctl.signal,
    }).finally(() => clearTimeout(t));
  } catch (e) { return { kind: 'network', error: (e as Error)?.message || 'network' }; }
  let body: { token?: unknown; pro?: unknown; status?: string; error?: string; minVersion?: string } | null = null;
  try { body = await res.json(); } catch { body = null; }
  if (res.status === 200 && body && typeof body.token === 'string') return { kind: 'ok', token: body.token, pro: !!body.pro, status: body.status || null };
  if (res.status === 401) return { kind: 'unauthorized', error: (body && body.error) || 'unauthorized' };
  if (res.status === 426) return { kind: 'outdated', error: (body && body.minVersion) || 'update_required' };
  return { kind: 'server', error: `${res.status} ${(body && body.error) || ''}`.trim() };
}

/** Delete the signed-in account (Apple 5.1.1(v)); the edge function cancels billing and removes data. */
export async function deleteAccount(): Promise<{ ok: boolean; error?: string }> {
  try {
    const { data, error } = await sb().functions.invoke('delete-account', { body: {} });
    if (error) return { ok: false, error: error.message };
    return (data as { ok?: boolean; error?: string }) && (data as { ok?: boolean }).ok ? { ok: true } : { ok: false, error: (data as { error?: string })?.error || 'Could not delete the account.' };
  } catch (e) { return { ok: false, error: (e as Error)?.message || String(e) }; }
}

// ---- failed-log reporting (Ken, 2026-09-09) ---------------------------------------------------------
// A log that would not open: for PBD reporters (Ken's gmail, anyone @pbdyno.com) the original bytes and
// the error go to the private failed-logs bucket through the report-failed-log edge function, where the
// troubleshooting job on Ken's PC picks them up. Anyone else: no network call (the reporter check runs
// here first; the function enforces it again). Never throws.
const FAILED_LOG_REPORTERS = ['kenbjonnes@gmail.com'];
const FAILED_LOG_DOMAINS = ['pbdyno.com'];
export function isTroubleshootReporter(email: string | null | undefined): boolean {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return false;
  if (FAILED_LOG_REPORTERS.includes(e)) return true;
  return FAILED_LOG_DOMAINS.includes(e.split('@')[1] || '');
}
export async function reportFailedLog(r: { name: string; bytes: Blob | ArrayBuffer; error: string; format?: string; engine?: string }): Promise<'sent' | 'skipped' | 'failed'> {
  try {
    const s = await getSession();
    if (!s || !isTroubleshootReporter(s.user?.email)) return 'skipped';
    const blob = r.bytes instanceof Blob ? r.bytes : new Blob([new Uint8Array(r.bytes)], { type: 'application/octet-stream' });
    let headHex = '';
    try { headHex = Array.from(new Uint8Array(await blob.slice(0, 64).arrayBuffer())).map((x) => x.toString(16).padStart(2, '0')).join(''); } catch { /* ignore */ }
    const url = `${SUPABASE_URL}/functions/v1/report-failed-log`;
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${s.access_token}`, apikey: SUPABASE_ANON_KEY };
    const begin = await fetch(url, { method: 'POST', headers, body: JSON.stringify({
      action: 'begin', fileName: r.name, sizeBytes: blob.size, format: r.format || '', error: r.error,
      app: 'mobile-' + platform, appVersion: __APP_VERSION__, engine: r.engine || '', headHex }) });
    const b = await begin.json().catch(() => null);
    if (begin.status === 403) return 'skipped';
    if (!begin.ok || !b || !b.ok || !b.signedUrl) return 'failed';
    const put = await fetch(b.signedUrl, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', apikey: SUPABASE_ANON_KEY }, body: blob });
    if (!put.ok) return 'failed';
    await fetch(url, { method: 'POST', headers, body: JSON.stringify({ action: 'done', id: b.id }) }).catch(() => null);
    return 'sent';
  } catch { return 'failed'; }
}

// ---- cloud layouts (viewer_layouts, RLS owner-CRUD) ------------------------------------------------
export interface SavedLayout { id: string; name: string; state: Record<string, unknown>; updatedAt: number }

export async function pullLayouts(): Promise<{ ok: boolean; rows: SavedLayout[] }> {
  if (!(await getSession())) return { ok: false, rows: [] };
  const { data, error } = await sb().from('viewer_layouts').select('id,name,state,updated_at').order('updated_at', { ascending: false });
  if (error || !data) return { ok: false, rows: [] };
  return { ok: true, rows: (data as { id: string; name: string; state: Record<string, unknown>; updated_at: string | null }[]).map((r) => ({ id: r.id, name: r.name, state: r.state, updatedAt: r.updated_at ? Date.parse(r.updated_at) : Date.now() })) };
}
export async function pushLayout(entry: SavedLayout): Promise<void> {
  const s = await getSession();
  if (!s || !entry || !entry.id || !entry.name) return;
  await sb().from('viewer_layouts').upsert({ id: String(entry.id), user_id: s.user.id, name: String(entry.name), state: entry.state && typeof entry.state === 'object' ? entry.state : {}, updated_at: new Date(Number(entry.updatedAt) || Date.now()).toISOString() });
}
export async function removeLayout(id: string): Promise<void> {
  if (!(await getSession()) || !id) return;
  await sb().from('viewer_layouts').delete().eq('id', String(id));
}

// ---- shared library (library_items; browse is open to anyone, publish/remove need a session) -------
type Dict = Record<string, unknown>;
const LIB_COLS = 'id,kind,name,description,owner_id,author_name,is_official,status,thumb_svg,vehicle,vehicle_year,vehicle_make,vehicle_model,tags,pulls,created_at,updated_at';
const likeTerm = (q: unknown) => String(q || '').replace(/[,()%\\]/g, ' ').trim().slice(0, 60);
function vehicleCols(v: Dict) {
  const y = typeof v.vehicle_year === 'number' && isFinite(v.vehicle_year) ? Math.round(v.vehicle_year) : null;
  return { vehicle: String(v.vehicle || '').trim().slice(0, 120), vehicle_year: y && y >= 1900 && y <= 2100 ? y : null,
    vehicle_make: String(v.vehicle_make || '').trim().slice(0, 60), vehicle_model: String(v.vehicle_model || '').trim().slice(0, 60) };
}

async function adminCall(action: string, body: Dict) {
  if (!(await getSession())) return { ok: false, error: 'Sign in first.' };
  try {
    const { data, error } = await sb().functions.invoke('admin', { body: { action, ...body } });
    if (error) return { ok: false, error: error.message };
    return (data as Dict) || { ok: false, error: 'No response.' };
  } catch (e) { return { ok: false, error: (e as Error)?.message || String(e) }; }
}

/** The provider object the engine expects on window.DATAVIEWER.library. */
export function buildLibraryProvider(opts: { isPro: () => boolean }) {
  let adminKnown: boolean | null = null;
  return {
    async list(q: Dict = {}) {
      const size = Math.max(1, Math.min(60, Number(q.pageSize) || 30));
      const from = Math.max(0, Number(q.page) || 0) * size;
      let req = sb().from('library_items').select(LIB_COLS)
        .order('is_official', { ascending: false }).order('pulls', { ascending: false }).order('updated_at', { ascending: false })
        .range(from, from + size);
      if (q.kind) req = req.eq('kind', String(q.kind));
      const source = q.source || (q.official ? 'official' : 'all');
      if (source === 'official') req = req.eq('is_official', true);
      else if (source === 'user') req = req.eq('is_official', false);
      if (q.mine) {
        const s = await getSession();
        if (!s) return { items: [] as Dict[], hasMore: false };
        req = req.eq('owner_id', s.user.id);
      } else req = req.eq('status', 'published');
      const term = likeTerm(q.q);
      if (term) req = req.or(`name.ilike.%${term}%,description.ilike.%${term}%,vehicle.ilike.%${term}%,author_name.ilike.%${term}%`);
      const { data, error } = await req;
      if (error || !data) return { items: [] as Dict[], hasMore: false, error: error?.message };
      return { items: (data as Dict[]).slice(0, size), hasMore: data.length > size };
    },
    async get(id: string) {
      const { data } = await sb().from('library_items').select('*').eq('id', String(id)).maybeSingle();
      return (data as Dict) || null;
    },
    async publish(input: Dict) {
      const s = await getSession();
      if (!s) return { ok: false, error: 'Sign in to share to the library.' };
      if (!opts.isPro()) return { ok: false, error: 'Sharing to the library is part of Pro.' };
      const meta = (s.user.user_metadata || {}) as { display_name?: string };
      const author = String(meta.display_name || (s.user.email || '').split('@')[0] || 'AllDataLogs user').slice(0, 80);
      const row = {
        id: 'lib_' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36),
        kind: input.kind === 'histogram' ? 'histogram' : 'gauges',
        name: String(input.name || '').trim().slice(0, 120),
        description: String(input.description || '').trim().slice(0, 2000),
        owner_id: s.user.id,
        author_name: author,
        payload: input.payload && typeof input.payload === 'object' ? input.payload : {},
        thumb_svg: typeof input.thumb_svg === 'string' ? input.thumb_svg.slice(0, 60000) : null,
        ...vehicleCols(input),
        tags: Array.isArray(input.tags) ? input.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 12) : [],
      };
      if (!row.name) return { ok: false, error: 'Give it a name first.' };
      const { data, error } = await sb().from('library_items').insert(row).select(LIB_COLS).single();
      if (error) return { ok: false, error: error.message };
      const item = data as Dict;
      // Ours are System from the first moment they are visible.
      if (await this.isAdmin()) {
        const r = await adminCall('library_official', { itemId: item.id, value: true });
        if (r && (r as { ok?: boolean }).ok) item.is_official = true;
      }
      return { ok: true, item };
    },
    /** Replace one of the caller's own items in place (keeps id, use count and System mark). */
    async update(id: string, input: Dict) {
      const s = await getSession();
      if (!s) return { ok: false, error: 'Sign in to update library items.' };
      if (!opts.isPro()) return { ok: false, error: 'Sharing to the library is part of Pro.' };
      const patch: Dict = {};
      if (typeof input.name === 'string') { patch.name = input.name.trim().slice(0, 120); if (!patch.name) return { ok: false, error: 'Give it a name first.' }; }
      if (typeof input.description === 'string') patch.description = input.description.trim().slice(0, 2000);
      if (input.payload && typeof input.payload === 'object') patch.payload = input.payload;
      if (input.thumb_svg !== undefined) patch.thumb_svg = typeof input.thumb_svg === 'string' ? input.thumb_svg.slice(0, 60000) : null;
      if (input.vehicle !== undefined || input.vehicle_make !== undefined || input.vehicle_model !== undefined || input.vehicle_year !== undefined) Object.assign(patch, vehicleCols(input));
      const { data, error } = await sb().from('library_items').update(patch).eq('id', String(id)).eq('owner_id', s.user.id).select(LIB_COLS).maybeSingle();
      if (error) return { ok: false, error: error.message };
      if (!data) return { ok: false, error: 'That item is not yours or no longer exists.' };
      return { ok: true, item: data as Dict };
    },
    async remove(id: string) {
      const { error } = await sb().from('library_items').delete().eq('id', String(id));
      return error ? { ok: false, error: error.message } : { ok: true };
    },
    async pull(id: string) { try { await sb().rpc('library_pull', { item_id: String(id) }); } catch { /* counter only */ } },
    async me() { const s = await getSession(); return s ? { userId: s.user.id, email: s.user.email || null } : null; },
    async isAdmin() {
      if (adminKnown !== null) return adminKnown;
      if (!(await getSession())) return false;
      const r = await adminCall('whoami', {});
      adminKnown = !!(r && (r as { admin?: boolean }).admin);
      return adminKnown;
    },
    admin: {
      setOfficial: (id: string, value: boolean) => adminCall('library_official', { itemId: id, value }),
      hide: (id: string, value: boolean) => adminCall('library_hide', { itemId: id, value }),
      remove: (id: string) => adminCall('library_delete', { itemId: id }),
    },
  };
}
