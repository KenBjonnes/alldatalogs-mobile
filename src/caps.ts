// caps.ts — pure file-size / memory budget rules (unit-tested in test/caps.test.js).
import { DEFAULT_CAPS, type Caps } from './config.ts';
import type { DeviceClass } from './native.ts';

export type Fmt = 'CSV' | 'HPL' | 'MoTeC' | 'Holley';

export function fmtOf(name: string): Fmt {
  const l = String(name || '').toLowerCase();
  return l.endsWith('.hpl') ? 'HPL' : l.endsWith('.ld') ? 'MoTeC' : l.endsWith('.dl') ? 'Holley' : 'CSV';
}

export function isLogName(name: string): boolean {
  return /\.(hpl|csv|ld|dl|msl|mlg)$/i.test(String(name || ''));
}

/** Largest file (bytes) this tier + device may open. */
export function capBytes(opts: { pro: boolean; device: DeviceClass; fmt: Fmt; caps?: Caps }): number {
  const caps = opts.caps || DEFAULT_CAPS;
  const mb = opts.pro ? (opts.device === 'tablet' ? caps.tablet : caps.phone)[opts.fmt] ?? caps.free : caps.free;
  return Math.max(1, Math.round(mb * 1048576));
}

/** Full-resolution set budget the payload builder gets (cells = rows × channels). */
export function fullBudgetCells(device: DeviceClass, caps?: Caps): number {
  const c = caps || DEFAULT_CAPS;
  return device === 'tablet' ? c.fullCellsTablet : c.fullCellsPhone;
}

/** Merge a remote mobile-config.json `caps` object over the defaults; ignores junk. */
export function mergeCaps(remote: unknown): Caps {
  const r = (remote && typeof remote === 'object' ? remote : {}) as Partial<Caps>;
  const num = (v: unknown, d: number) => (typeof v === 'number' && isFinite(v) && v > 0 ? v : d);
  const table = (v: unknown, d: Record<string, number>) => {
    const out = { ...d };
    if (v && typeof v === 'object') for (const k of Object.keys(d)) out[k] = num((v as Record<string, unknown>)[k], d[k]);
    return out;
  };
  return {
    free: num(r.free, DEFAULT_CAPS.free),
    phone: table(r.phone, DEFAULT_CAPS.phone),
    tablet: table(r.tablet, DEFAULT_CAPS.tablet),
    fullCellsPhone: num(r.fullCellsPhone, DEFAULT_CAPS.fullCellsPhone),
    fullCellsTablet: num(r.fullCellsTablet, DEFAULT_CAPS.fullCellsTablet),
  };
}

export function fmtBytes(n: number): string {
  return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
}
