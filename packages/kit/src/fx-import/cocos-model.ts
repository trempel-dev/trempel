// cocos-model.ts — a reference model of a Cocos particle emitter (CCParticleSystem semantics as the
// format documents them, written independently: no engine code), in Cocos' own terms — points, y up,
// degrees, counter-clockwise angles — and the check of a converted config against it:
// the kit's ParticleSim and this model fed the same random values, compared at every frame.
//
// The model. Emission: the counter grows by dt while the emitter is not full, a particle comes out
// for every 1 / rate in it; the emitter stops when `duration` (−1 — never) is over. A particle: life
// ± var; start / end colour ± var per channel (clamped 0..1), start / end size ± var (≥ 0; end −1 —
// the start one), start / end rotation ± var (degrees, clockwise) — all linear over the life;
// gravity mode: the start point ± the source position variance, the velocity along angle ± var at
// speed ± var; every step the acceleration = radial (along the unit vector from the emitter to the
// particle) + tangential (that vector turned 90° counter-clockwise) + gravity, the velocity += a·dt,
// the position += v·dt; radius mode: θ = angle ± var turning at rotatePerSecond ± var, r from the
// start radius ± var to the end one ± var (−1 — the start one), the position = (−cos θ, −sin θ)·r.

import { ParticleSim } from '../fx/sim.js';
import type { ParticleConfig, RGBA } from '../fx/types.js';

/** An emitter as the file has it (Cocos units: points, y up, degrees CCW, colours 0..1). */
export interface CocosEmitter {
  mode: 'gravity' | 'radius';
  maxParticles: number;
  life: number;
  lifeVar: number;
  /** Seconds; −1 — infinite. */
  duration: number;
  /** Particles per second. */
  emissionRate: number;
  angle: number;
  angleVar: number;
  // gravity mode
  gravity: [number, number];
  speed: number;
  speedVar: number;
  radialAccel: number;
  radialAccelVar: number;
  tangentialAccel: number;
  tangentialAccelVar: number;
  // radius mode
  startRadius: number;
  startRadiusVar: number;
  /** −1 — the same as the start one. */
  endRadius: number;
  endRadiusVar: number;
  rotatePerSecond: number;
  rotatePerSecondVar: number;
  // particle
  startSize: number;
  startSizeVar: number;
  /** −1 — the same as the start one. */
  endSize: number;
  endSizeVar: number;
  startColor: RGBA;
  startColorVar: RGBA;
  endColor: RGBA;
  endColorVar: RGBA;
  startSpin: number;
  startSpinVar: number;
  endSpin: number;
  endSpinVar: number;
  sourcePosition: [number, number];
  posVar: [number, number];
  blend: [number, number] | null;
  /** 0 free, 1 relative, 2 grouped. */
  positionType: number;
  rotationIsDir: boolean;
  yCoordFlipped: number;
}

/** The random draws of a particle, by name. */
export type CocosDraw =
  | 'life' | 'posX' | 'posY' | 'startR' | 'startG' | 'startB' | 'startA' | 'endR' | 'endG' | 'endB' | 'endA'
  | 'startSize' | 'endSize' | 'startSpin' | 'endSpin' | 'angle' | 'speed' | 'radial' | 'tangential'
  | 'startRadius' | 'endRadius' | 'rotate';

/** A value in [−1, 1] for a draw. */
export type CocosRandom = (draw: CocosDraw) => number;

export interface CocosParticle {
  /** Spawn index. */
  index: number;
  x: number;
  y: number;
  dx: number;
  dy: number;
  ttl: number;
  color: RGBA;
  deltaColor: RGBA;
  size: number;
  deltaSize: number;
  rotation: number;
  deltaRotation: number;
  radialAccel: number;
  tangentialAccel: number;
  angle: number;
  degreesPerSecond: number;
  radius: number;
  deltaRadius: number;
}

const RAD = Math.PI / 180;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export class CocosModel {
  readonly particles: CocosParticle[] = [];
  spawned = 0;
  private emitCounter = 0;
  private elapsed = 0;
  active = true;

  constructor(
    readonly em: CocosEmitter,
    private readonly random: CocosRandom,
  ) {}

  /** A new particle (what the emitter does per due particle). */
  add(): CocosParticle {
    const e = this.em;
    const m = this.random;
    const ttl = Math.max(0, e.life + e.lifeVar * m('life'));
    const start: RGBA = [
      clamp01(e.startColor[0] + e.startColorVar[0] * m('startR')),
      clamp01(e.startColor[1] + e.startColorVar[1] * m('startG')),
      clamp01(e.startColor[2] + e.startColorVar[2] * m('startB')),
      clamp01(e.startColor[3] + e.startColorVar[3] * m('startA')),
    ];
    const end: RGBA = [
      clamp01(e.endColor[0] + e.endColorVar[0] * m('endR')),
      clamp01(e.endColor[1] + e.endColorVar[1] * m('endG')),
      clamp01(e.endColor[2] + e.endColorVar[2] * m('endB')),
      clamp01(e.endColor[3] + e.endColorVar[3] * m('endA')),
    ];
    const per = (a: number, b: number) => (ttl > 0 ? (b - a) / ttl : 0);
    const size = Math.max(0, e.startSize + e.startSizeVar * m('startSize'));
    const endSize = e.endSize === -1 ? size : Math.max(0, e.endSize + e.endSizeVar * m('endSize'));
    const spin0 = e.startSpin + e.startSpinVar * m('startSpin');
    const spin1 = e.endSpin + e.endSpinVar * m('endSpin');
    const a = (e.angle + e.angleVar * m('angle')) * RAD;
    const p: CocosParticle = {
      index: this.spawned++,
      x: e.posVar[0] * m('posX'),
      y: e.posVar[1] * m('posY'),
      dx: 0,
      dy: 0,
      ttl,
      color: start,
      deltaColor: [per(start[0], end[0]), per(start[1], end[1]), per(start[2], end[2]), per(start[3], end[3])],
      size,
      deltaSize: per(size, endSize),
      rotation: spin0,
      deltaRotation: per(spin0, spin1),
      radialAccel: 0,
      tangentialAccel: 0,
      angle: a,
      degreesPerSecond: 0,
      radius: 0,
      deltaRadius: 0,
    };
    if (e.mode === 'gravity') {
      const s = e.speed + e.speedVar * m('speed');
      p.dx = Math.cos(a) * s;
      p.dy = Math.sin(a) * s;
      p.radialAccel = e.radialAccel + e.radialAccelVar * m('radial');
      p.tangentialAccel = e.tangentialAccel + e.tangentialAccelVar * m('tangential');
    } else {
      p.radius = e.startRadius + e.startRadiusVar * m('startRadius');
      p.deltaRadius = e.endRadius === -1 ? 0 : per(p.radius, e.endRadius + e.endRadiusVar * m('endRadius'));
      p.degreesPerSecond = (e.rotatePerSecond + e.rotatePerSecondVar * m('rotate')) * RAD;
    }
    this.particles.push(p);
    return p;
  }

  /** One step: emission, then every particle (a dead one is removed, the order is kept). */
  update(dt: number): void {
    const e = this.em;
    if (this.active && e.emissionRate > 0) {
      const rate = 1 / e.emissionRate;
      if (this.particles.length < e.maxParticles) this.emitCounter += dt;
      while (this.particles.length < e.maxParticles && this.emitCounter > rate) {
        this.add();
        this.emitCounter -= rate;
      }
      this.elapsed += dt;
      if (e.duration !== -1 && e.duration < this.elapsed) this.active = false;
    }
    this.step(dt);
  }

  /** Move every particle by dt. */
  step(dt: number): void {
    const e = this.em;
    const ps = this.particles;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      p.ttl -= dt;
      if (!(p.ttl > 0)) {
        ps.splice(i--, 1);
        continue;
      }
      if (e.mode === 'gravity') {
        let rx = 0;
        let ry = 0;
        if (p.x || p.y) {
          const d = Math.hypot(p.x, p.y);
          rx = p.x / d;
          ry = p.y / d;
        }
        const ax = rx * p.radialAccel - ry * p.tangentialAccel + e.gravity[0];
        const ay = ry * p.radialAccel + rx * p.tangentialAccel + e.gravity[1];
        p.dx += ax * dt;
        p.dy += ay * dt;
        p.x += p.dx * dt;
        p.y += p.dy * dt;
      } else {
        p.angle += p.degreesPerSecond * dt;
        p.radius += p.deltaRadius * dt;
        p.x = -Math.cos(p.angle) * p.radius;
        p.y = -Math.sin(p.angle) * p.radius;
      }
      for (let k = 0; k < 4; k++) p.color[k] += p.deltaColor[k] * dt;
      p.size = Math.max(0, p.size + p.deltaSize * dt);
      p.rotation += p.deltaRotation * dt;
    }
  }
}

// ── the check ────────────────────────────────────────────────────────────────────────────────────

/** Tolerances of the check (the report prints them; the tests assert them). */
export const TOLERANCE = {
  /** Position, px. */
  position: 0.01,
  /** Size, px. */
  size: 0.01,
  /** Colour channel, 0..1. */
  color: 1e-4,
  /** Rotation, radians. */
  rotation: 1e-4,
};

export interface Verification {
  /** Max differences over the probes and the frames. */
  position: number;
  size: number;
  color: number;
  rotation: number;
  /** Max |count difference| of the whole emitter run, and what is allowed (a frame of emission each end). */
  count: number;
  countAllowed: number;
  /** Frames × probes compared. */
  samples: number;
  ok: boolean;
}

/** The kit's draw for a constant rng r, as the model's value in [−1, 1] (the box's y is flipped). */
const drawFor = (r: number): CocosRandom => (d) => (d === 'posY' ? 1 - 2 * r : 2 * r - 1);

/** Constant random values: min, middle, max of every variance. */
export const PROBES = [0, 0.5, 1 - 2 ** -20];

export const DT = 1 / 60;

/**
 * Check a converted config against the model: for every probe (the same random value in both), one
 * particle's position / size / colour / rotation at every frame of its life (≤ 10 s); then the whole
 * emitter (probe 0.5) — the particle count at every frame of a run (≤ 6 s).
 */
export function verifyCocos(em: CocosEmitter, config: ParticleConfig): Verification {
  const [ux, uy] = config.unit;
  const v: Verification = { position: 0, size: 0, color: 0, rotation: 0, count: 0, countAllowed: 0, samples: 0, ok: true };
  for (const r of PROBES) {
    const sim = new ParticleSim({ ...config, rate: 0, bursts: [], max: 1, loop: true, duration: 1, prewarm: false, startDelay: 0 }, () => r);
    sim.play();
    sim.emit(1);
    const model = new CocosModel(em, drawFor(r));
    model.add();
    const frames = Math.min(600, Math.ceil(Math.max(0, em.life + em.lifeVar) / DT) + 1);
    for (let f = 0; f < frames; f++) {
      sim.update(DT);
      model.step(DT);
      const p = sim.particles[0];
      const q = model.particles[0];
      if (!p || !q) {
        if (!!p !== !!q) v.count = Math.max(v.count, 1);
        break;
      }
      v.samples++;
      v.position = Math.max(v.position, Math.hypot(p.x * ux - q.x * ux, p.y * uy + q.y * uy));
      v.size = Math.max(v.size, Math.abs(p.outSize * ux - q.size * ux));
      for (let k = 0; k < 4; k++) v.color = Math.max(v.color, Math.abs(p.outColor[k] - clamp01(q.color[k])));
      v.rotation = Math.max(v.rotation, Math.abs(p.rotation - q.rotation * RAD));
    }
  }
  // The whole emitter: counts at every frame.
  const sim = new ParticleSim(config, () => 0.5);
  sim.play();
  const model = new CocosModel(em, drawFor(0.5));
  const run = Math.min(6, (em.duration > 0 ? em.duration : 2) + Math.max(0, em.life + em.lifeVar) + 0.5);
  for (let t = 0; t < run; t += DT) {
    sim.update(DT);
    model.update(DT);
    v.count = Math.max(v.count, Math.abs(sim.count - model.particles.length));
  }
  // Cocos stops after the frame its elapsed time passes the duration, the kit before it: up to two
  // frames of emission at the end; ±1 at a frame boundary.
  v.countAllowed = Math.ceil(2 * em.emissionRate * DT) + 1;
  v.ok = v.position <= TOLERANCE.position && v.size <= TOLERANCE.size && v.color <= TOLERANCE.color && v.rotation <= TOLERANCE.rotation && v.count <= v.countAllowed;
  return v;
}
