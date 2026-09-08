// Public build-time constants. The Supabase values are public by design (they ship in every browser
// bundle of the website) and match apps/web/.env.production in the Alldatalogs repo.
export const SUPABASE_URL = 'https://nvkfhbfyrbifkbynjbsd.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_fpmjy5vxm416c04llHQ0dQ_oK9t2GZJ';
export const ENTITLEMENT_FUNCTION = 'issue-entitlement-token';
export const TOKEN_ISS = 'alldatalogs';
export const TOKEN_AUD = 'bigdata-mobile';
export const SITE_URL = 'https://alldatalogs.com';
export const PRICING_URL = 'https://alldatalogs.com/pricing/?src=mobile';
export const ACCOUNT_URL = 'https://alldatalogs.com/account/';
export const REMOTE_CONFIG_URL = 'https://alldatalogs.com/mobile-config.json';

// PUBLIC keys (SPKI, base64) that may sign entitlement tokens, keyed by kid. Same pair as the desktop
// app (main/entitlement-keys.js); rotation is additive.
export const ENTITLEMENT_KEYS: Record<string, string> = {
  '2026-09': 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEvgy18d1U0ma9EJtTAVW4Mpmw++OCevJRocdrZsQNTCUBQcd+YeqYqXOHtjgD3jlSgODINp+j5hw039bvw+rUnQ==',
};

// File-size caps in MB by device class and format. Phones get less than tablets: the worker hands
// the parsed arrays to the page by structured clone (peak = 2x), and iOS WebContent is jetsammed
// long before the desktop's 250 MB cap would be reached. Tunable remotely via mobile-config.json.
export interface Caps { free: number; phone: Record<string, number>; tablet: Record<string, number>; fullCellsPhone: number; fullCellsTablet: number }
export const DEFAULT_CAPS: Caps = {
  free: 15,
  phone: { CSV: 80, HPL: 25, MoTeC: 40, Holley: 40 },
  tablet: { CSV: 150, HPL: 50, MoTeC: 80, Holley: 80 },
  fullCellsPhone: 8_000_000,
  fullCellsTablet: 20_000_000,
};
export const MAX_POINTS = 12000;
