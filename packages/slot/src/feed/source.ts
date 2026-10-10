// source.ts — where rounds come from. The client asks for the next round's feed (bet, buy) and plays
// it; the kit knows three sources, a slot and a viewer differ only in the one their config names:
//   fixtureSource(files) — recorded feeds: in order round-robin, one by name, or pinned (the viewer);
//   httpSource(url)      — POST the request as JSON, the response is the feed (a server);
//   fnSource(fn)         — a function in the same process (anything that makes feeds).

import type { RoundFeed, Transform } from './types.js';

export interface RoundRequest {
  /** Bet in currency (the feed is in credits per bet; a source may ignore it). */
  bet: number;
  /** Bought feature, null — a normal spin. */
  buy: string | null;
}

export interface RoundSource {
  next(req: RoundRequest): Promise<RoundFeed>;
}

/** A recorded round: a feed with its name (`fixtures/*.json`). */
export interface FixtureFile {
  name: string;
  note?: string;
  /** Bought feature of the round (absent / null — a normal spin). */
  buy?: string | null;
  transforms: Transform[];
}

/** A fixture → the feed it holds; `buyOf` reads the buy of fixtures of another shape. */
export function feedOf(f: FixtureFile, buyOf?: (f: FixtureFile) => string | null): RoundFeed {
  if (!f || typeof f.name !== 'string' || !Array.isArray(f.transforms)) throw new Error(`E_SOURCE_FIXTURE: not a fixture (${JSON.stringify(f)?.slice(0, 120)})`);
  return { name: f.name, buy: buyOf ? buyOf(f) : (f.buy ?? null), transforms: f.transforms };
}

export interface FixtureSourceOptions {
  /** Serve only this fixture. */
  pin?: string;
  /**
   * 'match' (default): a normal spin takes the next fixture without a buy, a buy — the next of that
   * buy; 'all': a normal spin takes the next fixture of any kind (a viewer walking every round).
   */
  walk?: 'match' | 'all';
  buyOf?: (f: FixtureFile) => string | null;
}

export interface FixtureSource extends RoundSource {
  readonly names: string[];
  /** Serve this fixture next (then continue the order after it), or pin it for every round. */
  select(name: string, pin?: boolean): void;
}

/** Fixtures in a fixed order (by name). */
export function fixtureSource(files: FixtureFile[], opts: FixtureSourceOptions = {}): FixtureSource {
  const list = [...files].sort((a, b) => a.name.localeCompare(b.name));
  if (!list.length) throw new Error('E_SOURCE_FIXTURE: no fixtures');
  const feeds = list.map((f) => feedOf(f, opts.buyOf));
  const names = feeds.map((f) => f.name);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) throw new Error(`E_SOURCE_FIXTURE: two fixtures named "${dup}"`);
  let cursor = 0;
  let pinned: string | null = null;
  const index = (name: string) => {
    const i = names.indexOf(name);
    if (i < 0) throw new Error(`E_SOURCE_FIXTURE: no fixture "${name}" (known: ${names.join(', ')})`);
    return i;
  };
  const copy = (f: RoundFeed): RoundFeed => ({ ...f, transforms: f.transforms.map((t) => ({ ...t })) });
  const src: FixtureSource = {
    names,
    select(name, pin = false) {
      cursor = index(name);
      pinned = pin ? name : null;
    },
    async next(req) {
      if (pinned) return copy(feeds[index(pinned)]);
      for (let k = 0; k < feeds.length; k++) {
        const f = feeds[(cursor + k) % feeds.length];
        if (req.buy ? f.buy !== req.buy : opts.walk !== 'all' && f.buy !== null) continue;
        cursor = (cursor + k + 1) % feeds.length;
        return copy(f);
      }
      throw new Error(`E_SOURCE_FIXTURE: no fixture for buy=${req.buy}`);
    },
  };
  if (opts.pin) src.select(opts.pin, true);
  return src;
}

export interface HttpSourceOptions {
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  /** The request body (default: the request itself, as JSON). */
  body?: (req: RoundRequest) => unknown;
}

/**
 * Rounds from a server: POST `{ bet, buy }` (JSON) → the feed — `{ name?, buy?, transforms }` or a bare
 * list of transforms. Not for YouTube Playables builds (no network there).
 */
export function httpSource(url: string, opts: HttpSourceOptions = {}): RoundSource {
  const get = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  let rounds = 0;
  return {
    async next(req) {
      const res = await get(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...opts.headers },
        body: JSON.stringify(opts.body ? opts.body(req) : req),
      });
      if (!res.ok) throw new Error(`E_SOURCE_HTTP: ${res.status} ${res.statusText} — ${url}`);
      const r = (await res.json()) as unknown;
      rounds++;
      if (Array.isArray(r)) return { name: `${url}#${rounds}`, buy: req.buy, transforms: r as Transform[] };
      const o = r as Partial<RoundFeed> | null;
      if (!o || !Array.isArray(o.transforms)) throw new Error(`E_SOURCE_HTTP: no feed in the response (${JSON.stringify(r)?.slice(0, 200)})`);
      return { name: o.name ?? `${url}#${rounds}`, buy: o.buy === undefined ? req.buy : o.buy, transforms: o.transforms };
    },
  };
}

/** Rounds from a function in the same process (a game's own round maker). */
export function fnSource(fn: (req: RoundRequest) => RoundFeed | Promise<RoundFeed>): RoundSource {
  return { next: async (req) => fn(req) };
}
