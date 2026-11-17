// fx.ts — effect player («эффект по имени к узлу»): one-shot effects are updated
// from the loop and destroyed when the last particle dies; attached effects live until their
// owner destroys them. Textures: built-in shapes generated once by the renderer ('circle',
// 'square', 'star', 'spark'), otherwise an asset href (loaded by the game beforehand).
//
// 2.1: a table of the game's effects and their textures (createGame({ fx: { effects, textures } })):
// `fx.play('fdFound', …)` by name, texture names → URLs. A texture of the table that is not loaded
// yet loads at the first play of an effect using it (a lazy bundle of effects): the Effect is
// returned at once, empty, and starts when its textures are in (`effect.ready`).
//
// 2.5: atlases — a texture of the table may be a sprite atlas: a Pixi `Spritesheet`, or an href of its
// TexturePacker .json (loaded lazily like a picture, by Pixi's spritesheet loader: trim and rotation
// are its). A config's `atlas` takes its frames by prefix; an atlas not in the table and not loaded —
// the config plays its `texture` (a warning once).

import { Assets, Container, Graphics, Texture, type Renderer, type Spritesheet } from 'pixi.js';
import { atlasFrameNames, atlasPrefixes } from './atlas.js';
import { ParticleEmitter } from './emitter.js';
import { PARTICLES, type ParticlePreset } from './presets.js';
import type { Rng } from './sim.js';
import type { ParticleConfig } from './types.js';

/** A preset, a config, a group of configs (one prefab: parent first) — or (2.1) a name of the effects table. */
export type EffectSpec = ParticlePreset | ParticleConfig | ParticleConfig[] | (string & {});

/** 2.1: the game's effects and textures (createGame({ fx })). */
export interface FxTables {
  /** Effects by name: a config or a group (parent first) — trempel-fx-import's effects.json fits as is. */
  effects?: Record<string, ParticleConfig | readonly ParticleConfig[]>;
  /**
   * Texture name (config.texture, 2.5: config.atlas.texture) → URL (a bundler table), or a function;
   * loaded at the first play that needs it. 2.5: an atlas — a `Spritesheet`, or the URL of its .json.
   */
  textures?: Record<string, FxTexture> | ((name: string) => FxTexture | undefined);
}

/** 2.5: a texture of the effects' table: a URL (a picture, or an atlas's .json) or a loaded atlas. */
export type FxTexture = string | Spritesheet;

/** 2.5: a Spritesheet (by shape — the game's Pixi may be another copy). */
export function isSpritesheet(v: unknown): v is Spritesheet {
  return !!v && typeof v === 'object' && 'textures' in v && 'data' in v && typeof (v as Spritesheet).textures === 'object';
}

export interface FxPlayOptions {
  /** Stop emitting after this many seconds (looping effects). */
  time?: number;
  /** Scale of the effect in its parent. */
  scale?: number;
  /** Tint multiplier applied to every particle colour, 0xRRGGBB. */
  tint?: number;
  /** 2.2: the random source of this effect (a seeded one — the same particles every time). */
  rng?: Rng;
}

/** A group of emitters played together (one prefab). */
export class Effect {
  readonly emitters: ParticleEmitter[];
  /** 2.1: resolves when the effect plays (at once, or when its lazy textures are in); never rejects. */
  ready: Promise<void> = Promise.resolve();
  private stopped = false;
  constructor(
    readonly view: Container,
    emitters: ParticleEmitter[],
  ) {
    this.emitters = emitters;
  }
  /** Waiting for its textures (2.1). */
  pending = false;
  /** 2.1: the emitters arrived (lazy textures) — a stop() asked while loading holds. */
  start(emitters: ParticleEmitter[]): void {
    this.pending = false;
    if (this.destroyed) {
      for (const e of emitters) e.destroy();
      return;
    }
    this.emitters.push(...emitters);
    for (const e of emitters) {
      this.view.addChild(e.view);
      e.play();
      if (this.stopped) e.stop();
    }
  }
  get alive(): boolean {
    return this.pending || this.emitters.some((e) => e.alive);
  }
  stop(): void {
    this.stopped = true;
    for (const e of this.emitters) e.stop();
  }
  update(dt: number): void {
    for (const e of this.emitters) e.update(dt);
  }
  /** Emit n more particles now (each emitter). */
  emit(n: number): void {
    for (const e of this.emitters) e.emit(n);
  }
  get destroyed(): boolean {
    return this.view.destroyed;
  }
  destroy(): void {
    if (!this.view.destroyed) this.view.destroy({ children: true });
  }
}

export class Fx {
  private readonly live = new Set<{ fx: Effect; stopAt: number; t: number; owned: boolean }>();
  private readonly shapes = new Map<string, Texture>();
  private effects: Record<string, ParticleConfig | readonly ParticleConfig[]> = {};
  private textures: (name: string) => FxTexture | undefined = () => undefined;
  /** 2.5: names of the textures given as tables (the inspector's atlas list). */
  private readonly textureTable = new Set<string>();
  private readonly loading = new Map<string, Promise<void>>();
  /** 2.5: atlases warned about (not at hand — the config played its texture). */
  private readonly warned = new Set<string>();

  constructor(
    private readonly renderer: Renderer | null,
    private readonly resolve: (href: string) => string = (h) => h,
    private readonly rng?: Rng,
  ) {}

  /** 2.1: the effects / textures tables (createGame({ fx }) sets them; a later call adds to them). */
  tables(t: FxTables): void {
    if (t.effects) this.effects = { ...this.effects, ...t.effects };
    if (t.textures) {
      const prev = this.textures;
      if (typeof t.textures !== 'function') for (const n of Object.keys(t.textures)) this.textureTable.add(n);
      const next = typeof t.textures === 'function' ? t.textures : ((tbl) => (n: string) => tbl[n])(t.textures);
      this.textures = (n) => next(n) ?? prev(n);
    }
  }

  /** 2.5: names of the textures given as tables (atlases among them). */
  textureNames(): string[] {
    return [...this.textureTable];
  }

  /**
   * 2.5: the atlas of a texture name — the table's Spritesheet, or the one loaded from its .json (by the
   * table's URL, or the name as an href); null — not an atlas, or not loaded yet.
   */
  atlas(name: string): Spritesheet | null {
    const v = this.textures(name);
    if (isSpritesheet(v)) return v;
    const key = typeof v === 'string' ? v : this.resolve(name);
    const hit = Assets.cache.has(key) ? Assets.get<unknown>(key) : null;
    return isSpritesheet(hit) ? hit : null;
  }

  /** 2.5: load an atlas of the table now (resolves its Spritesheet; null — not one). */
  async loadAtlas(name: string): Promise<Spritesheet | null> {
    const v = this.textures(name);
    if (typeof v === 'string' && !Assets.cache.has(v)) await this.loadUrls([v]);
    return this.atlas(name);
  }

  /** 2.5: an atlas's frame names (natural order) and their prefixes with counts; null — not loaded. */
  atlasInfo(name: string): { frames: string[]; prefixes: { prefix: string; count: number }[] } | null {
    const sheet = this.atlas(name);
    if (!sheet) return null;
    const frames = atlasFrameNames(Object.keys(sheet.textures));
    return { frames, prefixes: atlasPrefixes(frames) };
  }

  /** 2.5: the frames of a config's atlas, in natural order (null — no atlas at hand: the config plays its texture). */
  atlasFrames(c: ParticleConfig): Texture[] | null {
    const a = c.atlas;
    if (!a) return null;
    const sheet = this.atlas(a.texture);
    const names = sheet ? atlasFrameNames(Object.keys(sheet.textures), a.prefix ?? '') : [];
    if (!sheet || !names.length) {
      const key = `${a.texture}|${a.prefix ?? ''}`;
      if (!this.warned.has(key)) {
        this.warned.add(key);
        console.warn(`W_FX_ATLAS: ${sheet ? `the atlas "${a.texture}" has no frames "${a.prefix ?? ''}…"` : `no atlas "${a.texture}" (a Spritesheet or the URL of its .json in the effects' textures)`} — the effect plays its texture "${c.texture}"`);
      }
      return null;
    }
    return names.map((n) => sheet.textures[n]);
  }

  /** 2.1: names of the effects table. */
  names(): string[] {
    return Object.keys(this.effects);
  }

  /** 2.1: the configs of an effect spec (a name of the table, a preset, a config or a group). */
  configs(spec: EffectSpec): ParticleConfig[] {
    if (typeof spec !== 'string') return Array.isArray(spec) ? [...spec] : [spec as ParticleConfig];
    const e = this.effects[spec];
    if (e) return Array.isArray(e) ? [...e] : [e as ParticleConfig];
    return [presetOf(spec, Object.keys(this.effects))];
  }

  /** 2.1: load the textures of effects now (names of the table, specs; default — the whole table). */
  async preload(specs: EffectSpec[] = this.names()): Promise<void> {
    await Promise.all(specs.map((s) => this.load(this.configs(s))));
  }

  /** One-shot effect at (x, y) of `parent`; auto-destroyed when done. */
  play(spec: EffectSpec, parent: Container, x = 0, y = 0, opts: FxPlayOptions = {}): Effect {
    const fx = this.create(spec, parent, x, y, opts);
    this.live.add({ fx, stopAt: opts.time ?? Infinity, t: 0, owned: false });
    return fx;
  }

  /**
   * 2.2: an effect the caller updates itself (`effect.update(dt)`; not in the player's list) — an
   * effect node of a scene steps its own effects on fixed frames.
   */
  make(spec: EffectSpec, parent: Container, x = 0, y = 0, opts: FxPlayOptions = {}): Effect {
    return this.create(spec, parent, x, y, opts);
  }

  /** Effect owned by the caller (loops until you call .stop()/.destroy()). */
  attach(spec: EffectSpec, parent: Container, x = 0, y = 0, opts: FxPlayOptions = {}): Effect {
    const fx = this.create(spec, parent, x, y, opts);
    this.live.add({ fx, stopAt: opts.time ?? Infinity, t: 0, owned: true });
    return fx;
  }

  update(dt: number): void {
    for (const e of this.live) {
      if (e.fx.destroyed) {
        this.live.delete(e);
        continue;
      }
      // Its lazy textures are loading: its time starts when it plays.
      if (e.fx.pending) continue;
      e.t += dt;
      if (e.t >= e.stopAt) {
        e.stopAt = Infinity;
        e.fx.stop();
      }
      e.fx.update(dt);
      if (!e.owned && !e.fx.alive) {
        this.live.delete(e);
        e.fx.destroy();
      }
    }
  }

  get size(): number {
    return this.live.size;
  }

  /** Destroy everything (screen switch, restart). */
  clear(): void {
    for (const e of this.live) e.fx.destroy();
    this.live.clear();
  }

  texture(name: string): Texture {
    if (BUILTIN.has(name)) return this.shape(name);
    const t = Assets.get<Texture>(this.url(name));
    if (!t) throw new Error(`kit fx: texture "${name}" is not loaded (load it in a bundle, list it in createGame({ fx: { textures } }), or use a built-in shape: ${[...BUILTIN].join(', ')})`);
    return t;
  }

  /** The URL of a texture name: the textures table (2.1), else the game's href resolver. */
  private url(name: string): string {
    const v = this.textures(name);
    return typeof v === 'string' ? v : this.resolve(name);
  }

  /** Textures of the table not loaded yet (built-ins and loaded ones are not). */
  private missing(configs: ParticleConfig[]): string[] {
    const out = new Set<string>();
    for (const c of configs) {
      // 2.5: the atlas of a config — its .json by the table's URL
      const a = c.atlas ? this.textures(c.atlas.texture) : undefined;
      if (typeof a === 'string' && !Assets.cache.has(a)) out.add(a);
      if (BUILTIN.has(c.texture) || (c.atlas && this.atlas(c.atlas.texture))) continue;
      const url = this.textures(c.texture);
      if (typeof url === 'string' && !Assets.get(url)) out.add(url);
    }
    return [...out];
  }

  private load(configs: ParticleConfig[]): Promise<void> {
    return this.loadUrls(this.missing(configs));
  }

  private loadUrls(urls: string[]): Promise<void> {
    const jobs = urls.map((url) => {
      let p = this.loading.get(url);
      if (!p) {
        p = Assets.load(url).then(
          () => undefined,
          (e: unknown) => {
            this.loading.delete(url);
            console.warn(`kit fx: texture ${url} failed to load`, e);
          },
        );
        this.loading.set(url, p);
      }
      return p;
    });
    return Promise.all(jobs).then(() => undefined);
  }

  private create(spec: EffectSpec, parent: Container, x: number, y: number, opts: FxPlayOptions): Effect {
    const configs = this.configs(spec);
    const tint = opts.tint;
    const build = () =>
      configs.map((c0, i) => {
        const c = tint === undefined ? c0 : { ...c0, tint: mulTint(c0.tint, tint) };
        const frames = this.atlasFrames(c);
        const e = new ParticleEmitter(c, frames ? frames[0] : this.texture(c.texture), opts.rng ?? this.rng, frames ?? undefined);
        if (i > 0) e.view.position.set(c.pos[0] * configs[0].unit[0], c.pos[1] * configs[0].unit[1]);
        return e;
      });
    const view = new Container();
    view.eventMode = 'none';
    view.position.set(x, y);
    view.scale.set(opts.scale ?? 1);
    parent.addChild(view);
    const fx = new Effect(view, []);
    if (this.missing(configs).length) {
      // A lazy texture: the effect starts when it is in (a failed one — the effect stays empty).
      fx.pending = true;
      fx.ready = this.load(configs).then(() => {
        if (fx.destroyed) return void (fx.pending = false);
        try {
          fx.start(build());
        } catch (e) {
          fx.pending = false;
          console.warn((e as Error).message);
        }
      });
    } else fx.start(build());
    return fx;
  }

  private shape(name: string): Texture {
    const hit = this.shapes.get(name);
    if (hit) return hit;
    if (!this.renderer) {
      // 2.2: no renderer (the viewer, the editor) — the same shape drawn on a canvas
      const t = typeof document !== 'undefined' ? canvasShape(name) : Texture.WHITE;
      this.shapes.set(name, t);
      return t;
    }
    const g = new Graphics();
    const r = 16;
    if (name === 'circle') g.circle(r, r, r).fill(0xffffff);
    else if (name === 'square') g.rect(0, 0, r * 2, r * 2).fill(0xffffff);
    else if (name === 'spark') g.ellipse(r, r, r * 0.35, r).fill(0xffffff);
    else {
      const pts: number[] = [];
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
        const rr = i % 2 ? r * 0.42 : r;
        pts.push(r + Math.cos(a) * rr, r + Math.sin(a) * rr);
      }
      g.poly(pts).fill(0xffffff);
    }
    const t = this.renderer.generateTexture(g);
    g.destroy();
    this.shapes.set(name, t);
    return t;
  }
}

const BUILTIN = new Set(['circle', 'square', 'star', 'spark']);

/** A built-in shape on a 32×32 canvas (no renderer at hand). */
function canvasShape(name: string): Texture {
  const r = 16;
  const c = document.createElement('canvas');
  c.width = c.height = r * 2;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.beginPath();
  if (name === 'circle') g.arc(r, r, r, 0, Math.PI * 2);
  else if (name === 'square') g.rect(0, 0, r * 2, r * 2);
  else if (name === 'spark') g.ellipse(r, r, r * 0.35, r, 0, 0, Math.PI * 2);
  else
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
      const rr = i % 2 ? r * 0.42 : r;
      if (i) g.lineTo(r + Math.cos(a) * rr, r + Math.sin(a) * rr);
      else g.moveTo(r + Math.cos(a) * rr, r + Math.sin(a) * rr);
    }
  g.fill();
  return Texture.from(c);
}

function presetOf(name: string, effects: string[] = []): ParticleConfig {
  const c = (PARTICLES as Record<string, ParticleConfig>)[name];
  if (!c) throw new Error(`kit fx: unknown effect "${name}" (presets: ${Object.keys(PARTICLES).join(', ')}${effects.length ? `; effects: ${effects.join(', ')}` : ''})`);
  return c;
}

function mulTint(t: [number, number, number, number], rgb: number): [number, number, number, number] {
  return [t[0] * ((rgb >> 16) & 255) / 255, t[1] * ((rgb >> 8) & 255) / 255, t[2] * (rgb & 255) / 255, t[3]];
}
