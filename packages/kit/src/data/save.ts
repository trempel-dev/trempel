// save.ts — typed save on top of the platform's opaque string. Defensive parse: a missing/invalid
// field falls back to its default, an unparsable string resets to defaults; `migrate` upgrades
// older versions. Writes are
// coalesced (one platform.save per change burst) — Playables recommends small, rare saves.

import type { Platform } from '../platform/types.js';

export interface SaveOptions<T extends object> {
  /** Schema version, stored as `v`. */
  version: number;
  /** Default data (also the shape: fields of other types are replaced by these). */
  defaults: T;
  /** Upgrade raw data of an older version (gets the parsed object and its `v`). */
  migrate?: (raw: Record<string, unknown>, from: number) => Record<string, unknown>;
}

/** Pure: parse a stored string into T (null input → defaults). */
export function parseSave<T extends object>(raw: string | null, opts: SaveOptions<T>): T {
  const d = structuredClone(opts.defaults);
  if (raw == null || !raw.trim()) return d;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return d;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return d;
  let o = obj as Record<string, unknown>;
  const v = typeof o.v === 'number' ? o.v : 0;
  if (v !== opts.version && opts.migrate) o = opts.migrate(o, v);
  return merge(d, o) as T;
}

/** Keep `defaults`' shape: take a stored field only when its type matches the default's. */
function merge(def: unknown, got: unknown): unknown {
  if (got === undefined) return def;
  if (def === null || def === undefined) return got;
  if (Array.isArray(def)) return Array.isArray(got) ? got : def;
  if (typeof def === 'object') {
    if (!got || typeof got !== 'object' || Array.isArray(got)) return def;
    const out: Record<string, unknown> = {};
    const d = def as Record<string, unknown>;
    const g = got as Record<string, unknown>;
    // Records with no declared keys (e.g. per-level maps) keep every stored key.
    const keys = Object.keys(d).length ? Object.keys(d) : Object.keys(g);
    for (const k of keys) out[k] = merge(d[k], g[k]);
    return out;
  }
  if (typeof def === 'number') return typeof got === 'number' && Number.isFinite(got) ? got : def;
  return typeof got === typeof def ? got : def;
}

export class Save<T extends object> {
  private value: T;
  private pending: Promise<void> | null = null;
  private dirty = false;

  constructor(
    private readonly platform: Platform,
    private readonly opts: SaveOptions<T>,
  ) {
    this.value = structuredClone(opts.defaults);
  }

  /** Current data (read-only view; change through set/update). */
  get data(): Readonly<T> {
    return this.value;
  }

  /** Load from the platform (called once by createGame before the first screen). */
  async load(): Promise<T> {
    this.value = parseSave(await this.platform.load(), this.opts);
    return this.value;
  }

  /** Shallow-merge a patch and write. */
  set(patch: Partial<T>): Promise<void> {
    this.value = { ...this.value, ...patch };
    return this.flush();
  }

  /** Change with a function (returns the new data) and write. */
  update(fn: (d: T) => T): Promise<void> {
    this.value = fn(structuredClone(this.value));
    return this.flush();
  }

  /** Back to defaults (and write). */
  reset(): Promise<void> {
    this.value = structuredClone(this.opts.defaults);
    return this.flush();
  }

  serialize(): string {
    return JSON.stringify({ ...this.value, v: this.opts.version });
  }

  private flush(): Promise<void> {
    this.dirty = true;
    if (this.pending) return this.pending;
    this.pending = Promise.resolve().then(async () => {
      while (this.dirty) {
        this.dirty = false;
        await this.platform.save(this.serialize());
      }
      this.pending = null;
    });
    return this.pending;
  }
}
