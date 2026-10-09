// node.ts — 2.2: a particle effect as a node of a scene (the kit's `fx` component) and effects fired
// by clips (`fx:<name>@<node>` markers) — deterministic, so the viewer, the editor and view:shot draw
// the same particles every time.
//
//   base:  <g id="sparkle" transform="translate(360 640)" data-effect="sparkle" data-scale="1.5">
//            <circle r="8" fill="#ffd54a" opacity="0.5"/>   ← a placeholder: plain SVG shows a dot
//          </g>
//   heir:  <tml:ref id="sparkle" tml:type="fx"/>
//
// Parameters (data-* in the base, tml:* in the heir): `effect` — a name of the effects table or a
// preset; `autostart` (default true) — plays from the mount; `loop` — starts again when it ends;
// `scale`; `seed` — of the particles' random source (with the node id). The base's data-tint tints
// the node like any other (the scene does it).
//
// Time: an effect host steps its effects on fixed frames of 1/60 s from a seeded random source, so
// an effect `age` seconds old is the same picture whatever the frame rate; `seek(age)` replays from
// the start. In a game the kit's loop ticks the hosts (pause / speed of the loop apply); in the
// viewer the kit's view module ticks them on the page's frames (virtual time in view:shot).

import { Container } from 'pixi.js';
import type { ComponentContext, ComponentFactory, MountedScene, NodeHandle } from '@trempel/scene';
import { seededRandom } from '../qa/random.js';
import type { Effect, EffectSpec, Fx } from './fx.js';

/** One fixed frame of an effect host. */
export const FX_STEP = 1 / 60;

/** A stable 32-bit seed of a string (FNV-1a). */
export function seedOf(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface FxRunOptions {
  /** Starts again when it ends. */
  loop?: boolean;
  scale?: number;
  /** 0xRRGGBB multiplier. */
  tint?: number;
  /** Seconds already played (the run is replayed up to it). */
  age?: number;
  /** Moved only by `seek` (clip time), not by the host's real time. */
  manual?: boolean;
}

/** One effect playing on a host. */
export interface FxRun {
  readonly key: string;
  readonly spec: EffectSpec;
  effect: Effect | null;
  /** Seconds played. */
  age: number;
  readonly opts: FxRunOptions;
  readonly seed: number;
}

/**
 * Effects on one container, stepped on fixed frames from seeded random sources. `update(dt)` —
 * real time (the loop, the page's frames); `seek(key, age)` — a run replayed to an age (clip time).
 */
export class FxHost {
  private readonly runs = new Map<string, FxRun>();
  private acc = 0;
  private n = 0;

  constructor(
    private readonly fx: Fx,
    readonly parent: Container,
    private readonly seed = 0,
  ) {}

  get size(): number {
    return this.runs.size;
  }

  run(key: string): FxRun | undefined {
    return this.runs.get(key);
  }

  keys(): string[] {
    return [...this.runs.keys()];
  }

  /** Start `spec` (again, from the start) under `key` (default — a new one). */
  fire(spec: EffectSpec, opts: FxRunOptions = {}, key = `#${++this.n}`): FxRun {
    this.drop(key);
    const run: FxRun = { key, spec, effect: null, age: 0, opts, seed: (this.seed ^ seedOf(key)) >>> 0 };
    this.runs.set(key, run);
    this.start(run);
    if (opts.age) this.advance(run, opts.age);
    return run;
  }

  /** Put a run at `age` seconds: forward — stepped on; back — replayed from the start. */
  seek(key: string, age: number): void {
    const run = this.runs.get(key);
    if (!run) return;
    if (age + 1e-9 < run.age) {
      this.start(run);
      run.age = 0;
    }
    this.advance(run, age - run.age);
  }

  /** Real time: every run steps on whole fixed frames. */
  update(dt: number): void {
    this.acc += dt;
    const frames = Math.floor(this.acc / FX_STEP + 1e-6);
    if (frames <= 0) return;
    this.acc -= frames * FX_STEP;
    for (const run of [...this.runs.values()]) if (!run.opts.manual) this.advance(run, frames * FX_STEP);
  }

  /** Stop emitting (live particles finish). */
  stop(key?: string): void {
    for (const r of key ? [this.runs.get(key)].filter(Boolean) : this.runs.values()) r!.effect?.stop();
  }

  drop(key: string): void {
    const r = this.runs.get(key);
    if (!r) return;
    r.effect?.destroy();
    this.runs.delete(key);
  }

  clear(): void {
    for (const k of [...this.runs.keys()]) this.drop(k);
  }

  private start(run: FxRun): void {
    run.effect?.destroy();
    run.effect = this.fx.make(run.spec, this.parent, 0, 0, { scale: run.opts.scale, tint: run.opts.tint, rng: seededRandom(run.seed) });
    // lazy textures: the effect starts when they are in — then it catches up to the age asked
    if (run.effect.pending) {
      const e = run.effect;
      void e.ready.then(() => {
        if (run.effect !== e || e.destroyed) return;
        const age = run.age;
        run.age = 0;
        this.advance(run, age);
      });
    }
  }

  private advance(run: FxRun, dt: number): void {
    const frames = Math.round(dt / FX_STEP);
    for (let i = 0; i < frames; i++) {
      const e = run.effect;
      if (!e) return;
      if (e.pending) {
        run.age += FX_STEP;
        continue;
      }
      e.update(FX_STEP);
      run.age += FX_STEP;
      if (!e.alive) {
        if (run.opts.loop) {
          this.start(run);
          continue;
        }
        if (!run.opts.loop && run.key.startsWith('#')) {
          // a one-shot fired without a key ends with its particles
          this.drop(run.key);
          return;
        }
      }
    }
  }
}

/** The `fx` component: an effect at its node. */
export class FxNode {
  readonly root = new Container();
  readonly host: FxHost;
  /** The node's own effect (`effect` parameter) — the run key. */
  static readonly MAIN = 'main';

  constructor(
    fx: Fx,
    readonly id: string,
    readonly effect: string,
    readonly opts: { autostart?: boolean; loop?: boolean; scale?: number; seed?: number; tint?: number } = {},
  ) {
    this.root.eventMode = 'none';
    if (id) this.root.label = id;
    this.host = new FxHost(fx, this.root, (seedOf(id) ^ (opts.seed ?? 0)) >>> 0);
    if (opts.autostart !== false) this.play();
  }

  /** (Re)start the node's effect from its start. */
  play(): FxRun {
    return this.host.fire(this.effect, { loop: this.opts.loop, scale: this.opts.scale, tint: this.opts.tint }, FxNode.MAIN);
  }

  /** Another effect at this node (a clip marker, a choreography step): a one-shot. */
  fire(spec: EffectSpec, opts: FxRunOptions = {}, key?: string): FxRun {
    return this.host.fire(spec, { scale: this.opts.scale, ...opts }, key);
  }

  stop(): void {
    this.host.stop();
  }

  /** The node's effect at `age` seconds (replayed — the same picture every time). */
  seek(age: number): void {
    if (!this.host.run(FxNode.MAIN)) this.play();
    this.host.seek(FxNode.MAIN, age);
  }

  update(dt: number): void {
    this.host.update(dt);
  }

  clear(): void {
    this.host.clear();
  }

  destroy(): void {
    this.host.clear();
    if (!this.root.destroyed) this.root.destroy({ children: true });
  }
}

const bool = (v: string | undefined, d: boolean): boolean => (v == null || v === '' ? d : v !== 'false' && v !== '0');
const numOr = (v: string | undefined, d: number): number => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

export interface FxNodeDeps {
  fx: Fx;
  /** Subscribe to real time (dt seconds); returns an unsubscribe. */
  tick: (fn: (dt: number) => void) => () => void;
  /** The placement of the node (the scene's transform on the root) — the kit's `adopt`. */
  place?: (root: Container, ctx: ComponentContext) => void;
}

/** The kit's effect components (`fx`), registered by createGame and the kit's view module. */
export function fxComponents(deps: FxNodeDeps): Record<string, ComponentFactory> {
  return {
    fx: (ctx) => {
      const effect = ctx.param('effect');
      if (!effect) throw new Error(`E_FX_NODE: #${ctx.attrs.id ?? '?'}: no effect (data-effect="<name>" in the base, or tml:effect in the heir)`);
      const node = new FxNode(deps.fx, ctx.attrs.id ?? '', effect, {
        autostart: bool(ctx.param('autostart'), true),
        loop: bool(ctx.param('loop'), false),
        scale: numOr(ctx.param('scale'), 1),
        seed: numOr(ctx.param('seed'), 0),
      });
      deps.place?.(node.root, ctx);
      const off = deps.tick((dt) => {
        if (node.root.destroyed) return off();
        node.update(dt);
      });
      node.root.on('destroyed', () => {
        off();
        node.host.clear();
      });
      return { root: node.root, node, play: () => node.play(), stop: () => node.stop(), seek: (t: number) => node.seek(t), fire: (spec: EffectSpec, o?: FxRunOptions) => node.fire(spec, o) };
    },
  };
}

/** `fx:<name>@<node>` / `fx:<name>` → its parts (null — not an effect marker). */
export function parseFxMarker(name: string): { effect: string; node?: string } | null {
  const m = /^fx:([^@\s]+)(?:@(\S+))?$/.exec(name);
  return m ? { effect: m[1], node: m[2] } : null;
}

/** The effect node at a scene node id (the `fx` component), if it is one. */
export function fxNodeOf(scene: Pick<MountedScene, 'components'> | undefined, id: string): FxNode | undefined {
  const c = scene?.components?.get(id) as { node?: unknown } | undefined;
  return c?.node instanceof FxNode ? c.node : undefined;
}

/**
 * Clip time → the effects its markers fired, deterministically (the viewer / editor posing a scene
 * by a clip, view:shot --clip --t): every `fx:` marker at or before `t` has its run at age t − marker
 * time; runs of markers no longer crossed are dropped. An effect node plays it; any other node gets
 * a host in its container.
 */
export class FxClipTime {
  private readonly hosts = new Map<string, FxHost>();
  private readonly fired = new Map<string, { host: FxHost; key: string }>();

  constructor(private readonly fx: Fx) {}

  apply(scene: Pick<MountedScene, 'byId' | 'components'>, t: number, markers: { t: number; name: string }[]): void {
    const live = new Set<string>();
    for (const m of markers) {
      const p = parseFxMarker(m.name);
      if (!p || m.t > t + 1e-9) continue;
      const key = `${m.t}|${m.name}`;
      live.add(key);
      const host = this.hostOf(scene, p.node);
      if (!host) continue;
      const age = t - m.t;
      const have = this.fired.get(key);
      if (!have || have.host !== host || !host.run(key)) {
        host.fire(p.effect, { age, manual: true }, key);
        this.fired.set(key, { host, key });
      } else host.seek(key, age);
    }
    for (const [key, f] of [...this.fired]) {
      if (live.has(key)) continue;
      f.host.drop(f.key);
      this.fired.delete(key);
    }
  }

  clear(): void {
    for (const f of this.fired.values()) f.host.drop(f.key);
    this.fired.clear();
    for (const h of this.hosts.values()) h.clear();
    this.hosts.clear();
  }

  private hostOf(scene: Pick<MountedScene, 'byId' | 'components'>, id: string | undefined): FxHost | undefined {
    if (!id) return undefined;
    const node = fxNodeOf(scene, id);
    if (node) return node.host;
    const c = scene.byId.get(id) as NodeHandle | undefined;
    if (!(c instanceof Container) || c.destroyed) return undefined;
    let h = this.hosts.get(id);
    if (!h || h.parent !== c) {
      h = new FxHost(this.fx, c, seedOf(id));
      this.hosts.set(id, h);
    }
    return h;
  }
}

/**
 * A game's clip marker: `fx:<name>@<node>` plays the effect at that node of the clip's scene (an
 * effect node fires it, another node gets a one-shot in its container); without a node — a warning.
 * Returns whether the marker was an effect.
 */
export function playFxMarker(fx: Fx, name: string, scene: { byId: Map<string, NodeHandle>; components?: Map<string, unknown> } | null | undefined): boolean {
  const p = parseFxMarker(name);
  if (!p) return false;
  if (!scene) return true;
  if (p.node) {
    const node = fxNodeOf(scene as Pick<MountedScene, 'components'>, p.node);
    if (node) {
      node.fire(p.effect);
      return true;
    }
    const c = scene.byId.get(p.node);
    if (c instanceof Container && !c.destroyed) fx.play(p.effect, c);
    else console.warn(`W_FX_MARKER: ${name}: no node "${p.node}" in the clip's scene`);
  } else console.warn(`W_FX_MARKER: ${name}: where? fx:<effect>@<node>`);
  return true;
}
