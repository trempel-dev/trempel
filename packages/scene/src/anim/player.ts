// player.ts — Animator: clip playback over an injectable clock.
// In production the clock is driven by requestAnimationFrame; in tests it's stepped manually.
// Call tick() once per frame after advancing the clock.
//
// v0.7:
//   - relative tracks (compiled md clips): the player remembers each node's rest pose the first
//     time a relative track touches it (backend.getProp — the pose the scene built) and writes
//     rest + v (x, y, rotation) or rest × v (scale.x, scale.y); v0.5 tracks stay absolute;
//   - motion tracks: keys are fractions of a path's length (uniform speed), the node gets the
//     path point as x/y (absolute, in its parent's space — like animateMotion), rotation from the
//     tangent with orient 'auto', plus an offset; a closed path wraps, an open one clamps;
//   - string keys (href) hold until the next key and are written only when they change;
//   - clip duration / loop.
//
// v0.8: skew.x / skew.y are relative like rotation (added to the rest pose); tint (0xRRGGBB keys) is
// interpolated per RGB channel; z is an ordinary absolute number track (the compiler makes it step).
//
// v1.0: width / height (absolute) — on an instance's box (layout.ts: its anchored content follows), on
// an image (a 9-slice panel's size) through the backend.

import type { ScenePath } from '../geom/path.js';
import { trempelError } from '../errors.js';
import { setBoxProp } from '../layout.js';
import type { NodeHandle, RendererBackend } from '../render/backend.js';
import { resolveEase } from './easing.js';
import type { AnimClip, Keyframe, Marker, Track } from './types.js';

/** Monotonic time source in milliseconds. */
export interface Clock {
  now(): number;
}

/** Speed factor: a constant, or a getter read every frame (turbo-on-the-fly). */
export type SpeedSource = number | (() => number);

export interface PlayOptions {
  /** Resolves `$param` track targets to concrete node handle(s). */
  targets?: Record<string, NodeHandle | NodeHandle[]>;
  /** Playback speed multiplier, read live each frame. */
  speed?: SpeedSource;
  /** Emitted when a marker's time is crossed. */
  onMarker?: (name: string) => void;
}

/** A running (or composed) playback. */
export interface Handle {
  abort(): void;
  readonly done: Promise<void>;
}

export interface ClipSpec {
  clip: AnimClip;
  opts?: PlayOptions;
}

/** Animator services beyond the backend and node resolver (v0.7). */
export interface AnimatorOptions {
  /** Geometry by id for motion tracks — usually `(id) => scene.path(id)`; throws for an unknown id. */
  path?: (id: string) => ScenePath;
}

interface ResolvedTrack {
  nodes: NodeHandle[];
  property: string;
  keys: Keyframe[];
  kind: 'number' | 'string' | 'motion';
  /** Rest pose per node (relative tracks). */
  rest?: number[];
  /** add (x/y/rotation) or multiply (scale.*) the rest pose. */
  combine?: 'add' | 'mul';
  path?: ScenePath;
  src?: Track;
  /** Last string written (string tracks write on change only). */
  last?: string;
}

const ADD = new Set(['x', 'y', 'rotation', 'skew.x', 'skew.y']);
const MUL = new Set(['scale.x', 'scale.y']);

interface Playback {
  tracks: ResolvedTrack[];
  markers: Marker[];
  onMarker?: (name: string) => void;
  speed: SpeedSource;
  duration: number;
  loop: boolean;
  localTime: number;
  lastMarker: number;
  aborted: boolean;
  finished: boolean;
  resolve: () => void;
  done: Promise<void>;
}

function resolveSpeed(speed: SpeedSource): number {
  return typeof speed === 'function' ? speed() : speed;
}

/** Interpolate a track's value at time t (seconds). Segment ease belongs to the destination key. */
function interp(keys: Keyframe[], t: number): number {
  const first = keys[0];
  const last = keys[keys.length - 1];
  if (t <= first.t) return Number(first.v);
  if (t >= last.t) return Number(last.v);

  let i = 0;
  while (i < keys.length - 1 && !(t >= keys[i].t && t < keys[i + 1].t)) i++;
  const a = keys[i];
  const b = keys[i + 1];
  const span = b.t - a.t;
  const p = span <= 0 ? 1 : (t - a.t) / span;
  const eased = resolveEase(b.ease)(p);
  return Number(a.v) + (Number(b.v) - Number(a.v)) * eased;
}

/** A colour track (0xRRGGBB keys) at time t: each channel interpolated on its own. */
function interpColor(keys: Keyframe[], t: number): number {
  const channel = (shift: number): number =>
    interp(
      keys.map((k) => ({ ...k, v: (Number(k.v) >> shift) & 0xff })),
      t,
    );
  const c = (shift: number): number => Math.max(0, Math.min(255, Math.round(channel(shift))));
  return (c(16) << 16) | (c(8) << 8) | c(0);
}

/** The value of a held (string) track at time t: the last key at or before t (the first before it). */
function held(keys: Keyframe[], t: number): string {
  let v = keys[0].v;
  for (const k of keys) {
    if (k.t <= t) v = k.v;
    else break;
  }
  return String(v);
}

export class Animator {
  private active = new Set<Playback>();
  private lastNow: number | null = null;
  /** Rest pose per node and property, captured the first time a relative track touches it. */
  private rest = new WeakMap<NodeHandle, Map<string, number>>();

  constructor(
    private backend: RendererBackend,
    private clock: Clock,
    /** Optional resolver for non-`$` (scene id) track targets. */
    private resolver?: (id: string) => NodeHandle | undefined,
    private options: AnimatorOptions = {},
  ) {}

  /**
   * Start a clip. Throws (before anything moves) when a motion track's path cannot be resolved or
   * a relative track's rest pose cannot be read.
   */
  play(clip: AnimClip, opts: PlayOptions = {}): Handle {
    const tracks: ResolvedTrack[] = clip.tracks
      .filter((tr) => tr.keys.length > 0)
      .map((tr) => this.resolveTrack(tr, opts.targets));

    let duration = 0;
    for (const tr of clip.tracks) {
      const lastKey = tr.keys[tr.keys.length - 1];
      if (lastKey) duration = Math.max(duration, lastKey.t);
    }
    for (const m of clip.markers ?? []) duration = Math.max(duration, m.t);
    if (clip.duration != null && clip.duration > 0) duration = clip.duration;

    let resolve!: () => void;
    const done = new Promise<void>((r) => (resolve = r));

    const pb: Playback = {
      tracks,
      markers: clip.markers ?? [],
      onMarker: opts.onMarker,
      speed: opts.speed ?? 1,
      duration,
      loop: clip.loop === true && duration > 0,
      localTime: 0,
      lastMarker: -Infinity,
      aborted: false,
      finished: false,
      resolve,
      done,
    };

    if (this.lastNow === null) this.lastNow = this.clock.now();
    this.active.add(pb);
    this.sample(pb, 0);
    if (duration <= 0) this.finish(pb);

    return {
      abort: () => this.abort(pb),
      done,
    };
  }

  /** Run several playbacks concurrently; done resolves when all complete. */
  parallel(...handles: Handle[]): Handle {
    return {
      abort: () => handles.forEach((h) => h.abort()),
      done: Promise.all(handles.map((h) => h.done)).then(() => undefined),
    };
  }

  /** Run clips one after another; done resolves after the last. */
  sequence(specs: ClipSpec[]): Handle {
    let current: Handle | null = null;
    let aborted = false;

    const run = async (): Promise<void> => {
      for (const spec of specs) {
        if (aborted) break;
        current = this.play(spec.clip, spec.opts);
        await current.done;
      }
    };

    return {
      abort: () => {
        aborted = true;
        current?.abort();
      },
      done: run(),
    };
  }

  /** Advance every active playback by the elapsed wall time. Call once per frame. */
  tick(): void {
    const now = this.clock.now();
    if (this.lastNow === null) this.lastNow = now;
    const dt = (now - this.lastNow) / 1000;
    this.lastNow = now;
    if (dt <= 0) return;

    for (const pb of [...this.active]) {
      if (pb.aborted || pb.finished) continue;
      pb.localTime += dt * resolveSpeed(pb.speed);
      if (pb.loop) {
        while (pb.localTime >= pb.duration) {
          this.sample(pb, pb.duration); // close the cycle: its last markers fire
          pb.localTime -= pb.duration;
          pb.lastMarker = -Infinity;
        }
        this.sample(pb, pb.localTime);
        continue;
      }
      this.sample(pb, Math.min(pb.localTime, pb.duration));
      if (pb.localTime >= pb.duration) this.finish(pb);
    }
  }

  private resolveTrack(tr: Track, targets?: Record<string, NodeHandle | NodeHandle[]>): ResolvedTrack {
    const nodes = this.resolveTargets(tr.target, targets);
    if (tr.property === 'motion') {
      if (!tr.path) throw trempelError('E_ANIM_PLAY', `the motion track #${tr.target} has no path.`);
      if (!this.options.path) {
        throw trempelError('E_ANIM_PLAY', `the motion track #${tr.target} — the Animator was created without path (new Animator(…, { path: (id) => scene.path(id) })).`);
      }
      return { nodes, property: tr.property, keys: tr.keys, kind: 'motion', path: this.options.path(tr.path), src: tr };
    }
    const kind = tr.keys.some((k) => typeof k.v === 'string') ? 'string' : 'number';
    const out: ResolvedTrack = { nodes, property: tr.property, keys: tr.keys, kind };
    if (tr.relative && kind === 'number') {
      const combine = ADD.has(tr.property) ? 'add' : MUL.has(tr.property) ? 'mul' : null;
      if (!combine) {
        throw trempelError('E_ANIM_PLAY', `#${tr.target}.${tr.property} — only x, y, rotation, skew.x, skew.y, scale.x, scale.y can be relative.`);
      }
      out.combine = combine;
      out.rest = nodes.map((n) => this.restOf(n, tr.property, tr.target));
    }
    return out;
  }

  private restOf(node: NodeHandle, property: string, target: string): number {
    let m = this.rest.get(node);
    if (!m) this.rest.set(node, (m = new Map()));
    const hit = m.get(property);
    if (hit !== undefined) return hit;
    if (!this.backend.getProp) {
      throw trempelError('E_BACKEND', `the relative track #${target}.${property} — the backend has no getProp, the rest pose cannot be read.`);
    }
    const v = Number(this.backend.getProp(node, property));
    if (!Number.isFinite(v)) throw trempelError('E_ANIM_PLAY', `#${target}.${property} — the rest pose is not a number.`);
    m.set(property, v);
    return v;
  }

  private sample(pb: Playback, t: number): void {
    for (const tr of pb.tracks) {
      if (tr.kind === 'string') {
        const value = held(tr.keys, t);
        if (value === tr.last) continue;
        tr.last = value;
        for (const node of tr.nodes) this.backend.setProp(node, tr.property, value);
        continue;
      }
      const value = tr.property === 'tint' ? interpColor(tr.keys, t) : interp(tr.keys, t);
      if (tr.kind === 'motion') {
        this.move(tr, value);
        continue;
      }
      tr.nodes.forEach((node, i) => {
        const v = !tr.rest ? value : tr.combine === 'add' ? tr.rest[i] + value : tr.rest[i] * value;
        // v1.0: width / height of a box (an instance of a resizable prefab) resize the box, not the view.
        if (!setBoxProp(node, tr.property, v)) this.backend.setProp(node, tr.property, v);
      });
    }
    for (const m of pb.markers) {
      if (m.t > pb.lastMarker && m.t <= t) pb.onMarker?.(m.name);
    }
    pb.lastMarker = t;
  }

  /** Put the track's nodes at fraction `f` of the path (closed — wraps, open — clamps). */
  private move(tr: ResolvedTrack, f: number): void {
    const path = tr.path!;
    const src = tr.src!;
    const s = path.closed ? f * path.length : Math.min(Math.max(f, 0), 1) * path.length;
    const p = path.pointAt(s);
    let x = p.x;
    let y = p.y;
    let angle: number | null = null;
    if (src.orient === 'auto') {
      const t = path.tangentAt(s);
      angle = Math.atan2(t.y, t.x) + (src.orientOffset ?? 0);
    }
    if (src.offset) {
      const [dx, dy] = src.offset;
      if (angle == null) {
        x += dx;
        y += dy;
      } else {
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        x += dx * cos - dy * sin;
        y += dx * sin + dy * cos;
      }
    }
    for (const node of tr.nodes) {
      this.backend.setProp(node, 'x', x);
      this.backend.setProp(node, 'y', y);
      if (angle != null) this.backend.setProp(node, 'rotation', angle);
    }
  }

  private finish(pb: Playback): void {
    if (pb.finished) return;
    pb.finished = true;
    this.active.delete(pb);
    pb.resolve();
  }

  private abort(pb: Playback): void {
    if (pb.finished) return;
    pb.aborted = true;
    pb.finished = true;
    this.active.delete(pb);
    pb.resolve();
  }

  private resolveTargets(
    target: string,
    targets?: Record<string, NodeHandle | NodeHandle[]>,
  ): NodeHandle[] {
    let found: NodeHandle | NodeHandle[] | undefined;
    if (target.startsWith('$')) {
      found = targets?.[target] ?? targets?.[target.slice(1)];
    } else {
      found = this.resolver?.(target) ?? targets?.[target];
    }
    if (found == null) return [];
    return Array.isArray(found) ? found : [found];
  }
}
