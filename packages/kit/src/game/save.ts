// save.ts — the game's save file (2.0): one platform string, two spaces.
//
//   { "trempel": 2, "sfx": 1, "music": 1, "svc": { …contracts' store }, "game": { …the game's data, "v": n } }
//
// The kit's settings and the services' store (ctx.store: the wallet's balance…) live at the top; the
// game's data — `game.save` — in `game`. game.save.set / update / reset change only `game`: a game
// writing its whole data object can no longer overwrite `sfx` / `music` / `svc` (TRM-8b). A save of
// 1.x — one flat object — is split when it loads: the kit takes `sfx` / `music` / `svc`; the game's
// space is the object as the game saw it in 1.x (its fields, `sfx` / `music` too — a game that kept
// them as its own settings keeps them — and `v` for its migrate), without `svc`. Every write is the
// whole file (both spaces as loaded, defaults included); writes of both spaces are coalesced into one
// platform save.

import { Save, type SaveOptions, type SaveStorage } from '../data/save.js';
import type { Platform } from '../platform/types.js';
import type { ServiceStore } from '../services/services.js';

/** The kit's space of the save file. */
export interface KitSaveData {
  sfx: number;
  music: number;
  /** What contracts persist (ctx.store), by contract name. */
  svc: Record<string, unknown>;
}

/** The format marker of a 2.0 save file. */
export const SAVE_FORMAT = 2;
const KIT_KEYS = new Set(['sfx', 'music', 'svc']);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Split a stored string into the kit's and the game's spaces (a 1.x flat save included). */
export function splitSave(raw: string | null): { kit: Record<string, unknown>; game: Record<string, unknown> | null } {
  if (raw == null || !raw.trim()) return { kit: {}, game: null };
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return { kit: {}, game: null };
  }
  if (!isObject(o)) return { kit: {}, game: null };
  const kit: Record<string, unknown> = {};
  for (const k of KIT_KEYS) if (k in o) kit[k] = o[k];
  if (o.trempel === SAVE_FORMAT) return { kit, game: isObject(o.game) ? o.game : null };
  // 1.x: the kit's fields next to the game's — the game keeps its view of it (without the services' store).
  const game: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (k !== 'svc') game[k] = v;
  return { kit, game };
}

class SaveFile {
  private kit: Record<string, unknown> = {};
  private game: Record<string, unknown> | null = null;
  private pending: Promise<void> | null = null;
  private dirty = false;

  constructor(private readonly platform: Platform) {}

  async load(): Promise<void> {
    ({ kit: this.kit, game: this.game } = splitSave(await this.platform.load()));
  }

  /** One space as a Save's storage: it reads its JSON, writes its object back (then the file is written). */
  space(which: 'kit' | 'game'): SaveStorage {
    return {
      load: async () => {
        const v = which === 'kit' ? this.kit : this.game;
        return v ? JSON.stringify(v) : null;
      },
      save: (data) => {
        const v = JSON.parse(data) as Record<string, unknown>;
        if (which === 'kit') {
          delete v.v;
          this.kit = v;
        } else this.game = v;
        return this.flush();
      },
    };
  }

  /** Both spaces as their Saves hold them after load (defaults, migrated): every write is the whole file. */
  seed(kit: string, game: string): void {
    const k = JSON.parse(kit) as Record<string, unknown>;
    delete k.v;
    this.kit = k;
    this.game = JSON.parse(game) as Record<string, unknown>;
  }

  private flush(): Promise<void> {
    this.dirty = true;
    if (this.pending) return this.pending;
    this.pending = Promise.resolve().then(async () => {
      while (this.dirty) {
        this.dirty = false;
        await this.platform.save(JSON.stringify({ trempel: SAVE_FORMAT, ...this.kit, game: this.game ?? {} }));
      }
      this.pending = null;
    });
    return this.pending;
  }
}

export interface GameSaves<D extends object> {
  /** The game's space — game.save. */
  game: Save<D>;
  /** The kit's space: settings and the services' store. */
  kit: Save<KitSaveData>;
  /** ctx.store of the contracts over the kit's space. */
  store: ServiceStore;
}

/** Load the save file and make both spaces. */
export async function loadSaves<D extends object>(platform: Platform, opts: SaveOptions<D> | undefined): Promise<GameSaves<D>> {
  const file = new SaveFile(platform);
  await file.load();
  const game = new Save<D>(file.space('game'), { version: opts?.version ?? 1, defaults: opts?.defaults ?? ({} as D), migrate: opts?.migrate });
  const kit = new Save<KitSaveData>(file.space('kit'), { version: 1, defaults: { sfx: 1, music: 1, svc: {} } });
  await Promise.all([game.load(), kit.load()]);
  file.seed(kit.serialize(), game.serialize());
  const store: ServiceStore = {
    get: (name) => kit.data.svc[name],
    set: (name, v) => void kit.update((d) => ({ ...d, svc: { ...d.svc, [name]: JSON.parse(JSON.stringify(v ?? null)) } })),
  };
  return { game, kit, store };
}
