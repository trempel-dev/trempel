// trails.ts — particle trails (2.1), renderer-free: a history of positions per live particle of a
// ParticleSim and the segments to stroke along it. The emitter strokes them with one Graphics under
// its particles (emitter.ts). Taken from FindCat's trail layer (a port of the Shuriken Trails module
// in "particles" mode): a point is added when the particle moved `minVertexDistance`, the trail keeps
// `lifetime` × the particle's life worth of frames, and every segment is thinner and more transparent
// towards the tail (0 at the tail → 1 at the head).

import { sampleCurve, type Rng, type SimParticle } from './sim.js';
import type { ParticleConfig, RGBA, TrailConfig } from './types.js';

export interface TrailSegment {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Units (the emitter's space). */
  width: number;
  /** 0xRRGGBB. */
  color: number;
  alpha: number;
}

interface History {
  age: number;
  pts: number[];
  on: boolean;
}

const to255 = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
const WHITE: RGBA = [1, 1, 1, 1];

/** The trail settings with their defaults. */
export function trailOf(c: ParticleConfig): Required<Omit<TrailConfig, 'texture'>> | null {
  const t = c.trails;
  if (!t) return null;
  return {
    ratio: t.ratio ?? 1,
    lifetime: t.lifetime ?? 1,
    minVertexDistance: t.minVertexDistance ?? 0,
    width: t.width ?? 1,
    color: t.color ?? WHITE,
    blend: t.blend ?? c.blend,
    tint: t.tint ?? WHITE,
  };
}

export class TrailSim {
  readonly trail: NonNullable<ReturnType<typeof trailOf>>;
  /** Per particle (the sim pools particle objects: a reused one is younger than its history). */
  private hist = new WeakMap<SimParticle, History>();

  constructor(
    private readonly config: ParticleConfig,
    private readonly rng: Rng = Math.random,
  ) {
    const t = trailOf(config);
    if (!t) throw new Error('kit fx: TrailSim of a config without trails');
    this.trail = t;
  }

  /** After the sim's update: record this frame's positions. */
  update(particles: readonly SimParticle[], dt: number): void {
    const tr = this.trail;
    for (const p of particles) {
      let h = this.hist.get(p);
      if (!h || p.age < h.age) {
        h = { age: p.age, pts: [p.x, p.y], on: tr.ratio >= 1 || this.rng() < tr.ratio };
        this.hist.set(p, h);
      }
      h.age = p.age;
      if (!h.on || dt <= 0) continue;
      const pts = h.pts;
      if (Math.hypot(p.x - pts[pts.length - 2], p.y - pts[pts.length - 1]) >= tr.minVertexDistance) pts.push(p.x, p.y);
      const maxPts = Math.max(2, Math.round((p.life * tr.lifetime) / Math.max(dt, 1 / 60)));
      if (pts.length > maxPts * 2) pts.splice(0, pts.length - maxPts * 2);
    }
  }

  /** Points of a particle's trail (x, y pairs, tail first), or null. */
  points(p: SimParticle): readonly number[] | null {
    const h = this.hist.get(p);
    return h?.on ? h.pts : null;
  }

  /** The segments to stroke this frame, tail → head of every trail. */
  segments(particles: readonly SimParticle[], out: (s: TrailSegment) => void): void {
    const c = this.config;
    const tr = this.trail;
    const seg: TrailSegment = { x0: 0, y0: 0, x1: 0, y1: 0, width: 0, color: 0, alpha: 0 };
    for (const p of particles) {
      const pts = this.points(p);
      if (!pts || pts.length < 4) continue;
      const t = Math.min(1, p.age / p.life);
      const size = p.size * (c.sizeOverLifetime ? sampleCurve(c.sizeOverLifetime, t) : 1);
      const alpha = c.colorOverLifetime ? sampleCurve(c.colorOverLifetime.alpha, t) : 1;
      const col = p.color;
      seg.color = (to255(col[0] * tr.color[0] * tr.tint[0]) << 16) | (to255(col[1] * tr.color[1] * tr.tint[1]) << 8) | to255(col[2] * tr.color[2] * tr.tint[2]);
      const a = col[3] * tr.color[3] * tr.tint[3] * alpha;
      const n = pts.length / 2;
      for (let i = 0; i < n; i++) {
        const k = (i + 1) / n;
        seg.x0 = pts[i * 2];
        seg.y0 = pts[i * 2 + 1];
        seg.x1 = i + 1 < n ? pts[i * 2 + 2] : p.x;
        seg.y1 = i + 1 < n ? pts[i * 2 + 3] : p.y;
        seg.width = Math.max(0.001, size * tr.width * k);
        seg.alpha = Math.min(1, a * k);
        out(seg);
      }
    }
  }
}
