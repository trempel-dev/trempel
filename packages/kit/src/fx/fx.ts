// fx.ts — effect player («эффект по имени к узлу»): one-shot effects are updated
// from the loop and destroyed when the last particle dies; attached effects live until their
// owner destroys them. Textures: built-in shapes generated once by the renderer ('circle',
// 'square', 'star', 'spark'), otherwise an asset href (loaded by the game beforehand).

import { Assets, Container, Graphics, Texture, type Renderer } from 'pixi.js';
import { ParticleEmitter } from './emitter.js';
import { PARTICLES, type ParticlePreset } from './presets.js';
import type { Rng } from './sim.js';
import type { ParticleConfig } from './types.js';

export type EffectSpec = ParticlePreset | ParticleConfig | ParticleConfig[];

export interface FxPlayOptions {
  /** Stop emitting after this many seconds (looping effects). */
  time?: number;
  /** Scale of the effect in its parent. */
  scale?: number;
  /** Tint multiplier applied to every particle colour, 0xRRGGBB. */
  tint?: number;
}

/** A group of emitters played together (one prefab). */
export class Effect {
  readonly emitters: ParticleEmitter[];
  constructor(
    readonly view: Container,
    emitters: ParticleEmitter[],
  ) {
    this.emitters = emitters;
  }
  get alive(): boolean {
    return this.emitters.some((e) => e.alive);
  }
  stop(): void {
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

  constructor(
    private readonly renderer: Renderer | null,
    private readonly resolve: (href: string) => string = (h) => h,
    private readonly rng?: Rng,
  ) {}

  /** One-shot effect at (x, y) of `parent`; auto-destroyed when done. */
  play(spec: EffectSpec, parent: Container, x = 0, y = 0, opts: FxPlayOptions = {}): Effect {
    const fx = this.create(spec, parent, x, y, opts);
    this.live.add({ fx, stopAt: opts.time ?? Infinity, t: 0, owned: false });
    return fx;
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
    const url = this.resolve(name);
    const t = Assets.get<Texture>(url);
    if (!t) throw new Error(`kit fx: texture "${name}" is not loaded (load it in a bundle, or use a built-in shape: ${[...BUILTIN].join(', ')})`);
    return t;
  }

  private create(spec: EffectSpec, parent: Container, x: number, y: number, opts: FxPlayOptions): Effect {
    const configs = typeof spec === 'string' ? [presetOf(spec)] : Array.isArray(spec) ? spec : [spec];
    const tint = opts.tint;
    const emitters = configs.map((c0, i) => {
      const c = tint === undefined ? c0 : { ...c0, tint: mulTint(c0.tint, tint) };
      const e = new ParticleEmitter(c, this.texture(c.texture), this.rng);
      if (i > 0) e.view.position.set(c.pos[0] * configs[0].unit[0], c.pos[1] * configs[0].unit[1]);
      return e;
    });
    const view = new Container();
    view.eventMode = 'none';
    view.position.set(x, y);
    view.scale.set(opts.scale ?? 1);
    for (const e of emitters) view.addChild(e.view);
    parent.addChild(view);
    const fx = new Effect(view, emitters);
    for (const e of emitters) e.play();
    return fx;
  }

  private shape(name: string): Texture {
    const hit = this.shapes.get(name);
    if (hit) return hit;
    if (!this.renderer) return Texture.WHITE;
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

function presetOf(name: string): ParticleConfig {
  const c = (PARTICLES as Record<string, ParticleConfig>)[name];
  if (!c) throw new Error(`kit fx: unknown preset "${name}" (known: ${Object.keys(PARTICLES).join(', ')})`);
  return c;
}

function mulTint(t: [number, number, number, number], rgb: number): [number, number, number, number] {
  return [t[0] * ((rgb >> 16) & 255) / 255, t[1] * ((rgb >> 8) & 255) / 255, t[2] * (rgb & 255) / 255, t[3]];
}
