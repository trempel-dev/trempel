// compare.ts — a converter run against configs a game has now (trempel-fx-import --compare): by `key`,
// the key parameters of every system the game has — same / different (with both values) / missing.
// What differs is not necessarily a regression: the old configs may have been converted by hand or
// by an older tool — the report says what, the reader decides.

import type { ParticleConfig } from '../fx/types.js';

/** The parameters compared (pos of an effect's root is not: the kit places only the children). */
export const COMPARED = [
  'unit', 'pos', 'duration', 'loop', 'prewarm', 'startDelay', 'lifetime', 'speed', 'size', 'color', 'rotation', 'flipRotation', 'gravity', 'max', 'rate',
  'bursts', 'shape', 'sizeOverLifetime', 'colorOverLifetime', 'spin', 'limitVelocity', 'sheet', 'render', 'texture', 'blend', 'tint', 'trails',
] as const;

export interface CompareRow {
  key: string;
  status: 'same' | 'different' | 'missing';
  diffs: { field: string; old: unknown; now: unknown }[];
}

/** Equal within a relative 1e-3 (numbers), deep for arrays / objects; undefined ≡ null. */
export function close(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return a == null && b == null;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 1e-3 * Math.max(1, Math.abs(a), Math.abs(b));
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => close(x, b[i]));
  if (typeof a === 'object' && typeof b === 'object') {
    const ka = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    return [...ka].every((k) => close((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return a === b;
}

/**
 * Compare: `old` — the game's configs (a flat list with `key`, or effects { name: [...] }); `now` —
 * the converter's effects. `roots` — keys of effect roots (their `pos` is not compared).
 */
export function compareConfigs(old: ParticleConfig[] | Record<string, ParticleConfig[]>, now: Record<string, ParticleConfig[]>): CompareRow[] {
  const flat = (e: Record<string, ParticleConfig[]>) => Object.values(e).flat();
  const oldList = Array.isArray(old) ? old : flat(old);
  const byKey = new Map<string, ParticleConfig>();
  const roots = new Set<string>();
  for (const cs of Object.values(now)) {
    if (cs[0]?.key) roots.add(cs[0].key);
    for (const c of cs) if (c.key && !byKey.has(c.key)) byKey.set(c.key, c);
  }
  const rows: CompareRow[] = [];
  for (const o of oldList) {
    const key = o.key ?? '?';
    const n = byKey.get(key);
    if (!n) {
      rows.push({ key, status: 'missing', diffs: [] });
      continue;
    }
    const diffs: CompareRow['diffs'] = [];
    for (const f of COMPARED) {
      if (f === 'pos' && roots.has(key)) continue;
      const a = (o as unknown as Record<string, unknown>)[f];
      const b = (n as unknown as Record<string, unknown>)[f];
      if (!close(a, b)) diffs.push({ field: f, old: a, now: b });
    }
    rows.push({ key, status: diffs.length ? 'different' : 'same', diffs });
  }
  return rows;
}

const j = (v: unknown) => '`' + JSON.stringify(v ?? null).replace(/\|/g, '\\|') + '`';

export function compareMd(rows: CompareRow[], oldName: string): string {
  const same = rows.filter((r) => r.status === 'same').length;
  const diff = rows.filter((r) => r.status === 'different');
  const missing = rows.filter((r) => r.status === 'missing');
  const byField = new Map<string, number>();
  for (const r of diff) for (const d of r.diffs) byField.set(d.field, (byField.get(d.field) ?? 0) + 1);
  const lines = [
    `# trempel-fx-import — compared with ${oldName}`,
    '',
    `${rows.length} systems of ${oldName}: **${same} same**, **${diff.length} different**, **${missing.length} missing** in the conversion.`,
    '',
  ];
  if (byField.size) lines.push(`Different fields: ${[...byField].sort((a, b) => b[1] - a[1]).map(([f, n]) => `${f} ×${n}`).join(', ')}.`, '');
  if (diff.length) {
    lines.push('| system | field | was | now |', '|---|---|---|---|');
    for (const r of diff) for (const d of r.diffs) lines.push(`| ${r.key.replace(/\|/g, '\\|')} | ${d.field} | ${j(d.old)} | ${j(d.now)} |`);
    lines.push('');
  }
  if (missing.length) lines.push('Missing:', '', ...missing.map((r) => `- ${r.key}`), '');
  return lines.join('\n');
}
