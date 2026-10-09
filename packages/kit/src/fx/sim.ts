// sim.ts — the particle simulation, renderer-free (headless-testable). Emission schedule (rate,
// bursts with cycles, duration/loop, startDelay, prewarm) and per-particle Shuriken semantics
// (start values, sphere/circle emission, gravity, limit-velocity dampen, size/colour over
// lifetime, angular speed `spin`, texture sheet, stretched billboards) — on plain Pixi, no
// particle library and no private API.
//
// 2.2: the Cocos particle model on top (all optional config fields — trempel-fx-import --cocos):
// gravity x, radial / tangential acceleration, an emission angle, the orbit mode, a box shape, end
// size / colour / rotation per particle, per-channel colour variance, emission that waits while full.
// Its random draws come after the 2.1 ones and only when a field is set: a 2.1 config draws and
// simulates exactly as before.

import type { Curve, MinMax, ParticleConfig, RGBA } from './types.js';

export interface SimParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  size: number;
  color: RGBA;
  rotation: number;
  spin: number;
  /** Output: current size multiplier, colour, sheet frame (0..frames-1), stretch length factor. */
  outSize: number;
  outColor: RGBA;
  frame: number;
  stretch: number;
  // 2.2 (set only when the config uses them):
  /** Radial / tangential acceleration of this particle, units/s². */
  radialAccel?: number;
  tangentialAccel?: number;
  /** End size and colour (linear from the start ones over the life). */
  endSize?: number;
  endColor?: RGBA;
  /** Rotation speed towards the end rotation, rad/s. */
  rotationSpeed?: number;
  /** Orbit mode: the centre, angle, angular speed, radius and its speed. */
  ox?: number;
  oy?: number;
  orbitAngle?: number;
  orbitSpeed?: number;
  radius?: number;
  radiusSpeed?: number;
}

export type Rng = () => number;

export function sampleCurve(c: Curve, t: number): number {
  if (!c.length) return 1;
  if (t <= c[0][0]) return c[0][1];
  for (let i = 1; i < c.length; i++) {
    if (t <= c[i][0]) {
      const [t0, v0] = c[i - 1];
      const [t1, v1] = c[i];
      return t1 === t0 ? v1 : v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
    }
  }
  return c[c.length - 1][1];
}

/** Sample a min-max value; `emitT` — normalized emitter time (for "random between two curves"). */
export function sampleMinMax(v: MinMax, emitT: number, rng: Rng): number {
  if (typeof v === 'number') return v;
  if (Array.isArray(v)) return v[0] + rng() * (v[1] - v[0]);
  const a = sampleCurve(v.curves[0], emitT);
  const b = sampleCurve(v.curves[1], emitT);
  return (a + rng() * (b - a)) * v.mul;
}

export function sampleGradient(g: NonNullable<ParticleConfig['colorOverLifetime']>, t: number, out: RGBA): RGBA {
  const cs = g.color;
  let [, r, gg, b] = cs[0];
  if (t >= cs[cs.length - 1][0]) [, r, gg, b] = cs[cs.length - 1];
  else if (t > cs[0][0]) {
    for (let i = 1; i < cs.length; i++) {
      if (t <= cs[i][0]) {
        const k = cs[i][0] === cs[i - 1][0] ? 1 : (t - cs[i - 1][0]) / (cs[i][0] - cs[i - 1][0]);
        r = cs[i - 1][1] + (cs[i][1] - cs[i - 1][1]) * k;
        gg = cs[i - 1][2] + (cs[i][2] - cs[i - 1][2]) * k;
        b = cs[i - 1][3] + (cs[i][3] - cs[i - 1][3]) * k;
        break;
      }
    }
  }
  out[0] = r;
  out[1] = gg;
  out[2] = b;
  out[3] = sampleCurve(g.alpha, t);
  return out;
}

/** Where a new particle starts and which way it goes (unit direction), per shape. */
export function spawnPoint(shape: ParticleConfig['shape'], rng: Rng): { x: number; y: number; dx: number; dy: number } {
  // Shuriken without a shape module emits along +Z — no velocity on screen.
  // For "random direction from a point" use { type: 'circle', radius: 0 }.
  if (shape.type === 'point') return { x: 0, y: 0, dx: 0, dy: 0 };
  // 2.2: a box (Cocos' source position variance) — a point, no direction (the config's `angle` gives it).
  if (shape.type === 'box') {
    const [bx, by] = shape.box ?? [0, 0];
    const x = bx * (rng() * 2 - 1);
    const y = by * (rng() * 2 - 1);
    return { x, y, dx: 0, dy: 0 };
  }
  const radius = shape.radius * (1 - shape.thickness * rng());
  let dx: number;
  let dy: number;
  if (shape.type === 'circle') {
    const a = rng() * shape.arc;
    dx = Math.cos(a);
    dy = -Math.sin(a);
  } else {
    const z = rng() * 2 - 1;
    const a = rng() * Math.PI * 2;
    const r = Math.sqrt(1 - z * z);
    dx = r * Math.cos(a);
    dy = r * Math.sin(a);
  }
  const [sx, sy] = shape.scale;
  return { x: dx * radius * sx, y: dy * radius * sy, dx: dx * sx, dy: dy * sy };
}

const DAMPEN_FPS = 60;

export class ParticleSim {
  readonly particles: SimParticle[] = [];
  private readonly pool: SimParticle[] = [];
  private time = 0;
  private playing = false;
  private emitting = false;
  private rateAcc = 0;
  private burstDone: number[] = [];
  private loopsDone = 0;
  /** Frames of the texture sheet (1 when none). */
  frames = 1;
  /** 2.2: particles spawned since the start (spawn index of the next one). */
  spawned = 0;
  /** 2.2: the config uses the Cocos model fields. */
  private readonly ext: boolean;

  constructor(
    readonly config: ParticleConfig,
    private readonly rng: Rng = Math.random,
  ) {
    if (config.sheet) this.frames = config.sheet.tilesX * config.sheet.tilesY;
    const c = config;
    this.ext =
      c.radialAccel !== undefined || c.tangentialAccel !== undefined || c.angle !== undefined || c.orbit !== undefined ||
      c.endSize !== undefined || c.endColor !== undefined || c.endRotation !== undefined;
  }

  get count(): number {
    return this.particles.length;
  }

  /** Emitting or still has live particles. */
  get alive(): boolean {
    return this.emitting || this.particles.length > 0;
  }

  play(): void {
    this.time = 0;
    this.rateAcc = 0;
    this.spawned = 0;
    this.burstDone = this.config.bursts.map(() => 0);
    this.loopsDone = 0;
    this.playing = true;
    this.emitting = true;
    if (this.config.prewarm && this.config.loop) {
      const step = 1 / 30;
      for (let t = 0; t < this.config.duration; t += step) this.update(step);
    }
  }

  /** Stop emitting; live particles finish their life. */
  stop(): void {
    this.emitting = false;
  }

  /** Remove everything now. */
  clear(): void {
    this.emitting = false;
    this.playing = false;
    while (this.particles.length) this.pool.push(this.particles.pop()!);
  }

  /** Emit n particles right now (manual effects: "burst of 20 at the head"). */
  emit(n: number): void {
    const c = this.config;
    const emitT = c.duration > 0 ? Math.min(1, Math.max(0, (this.time - c.startDelay) / c.duration) % 1) : 0;
    for (let i = 0; i < n && this.particles.length < c.max; i++) this.spawn(emitT);
    this.playing = true;
  }

  update(dt: number): void {
    if (!this.playing) return;
    if (this.emitting) this.schedule(dt);
    const c = this.config;
    const ps = this.particles;
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      p.age += dt;
      if (p.age >= p.life) {
        ps.splice(i, 1);
        this.pool.push(p);
        continue;
      }
      if (p.orbitAngle !== undefined) {
        // 2.2: orbit mode — the position is the orbit's (gravity, accelerations, speed do not apply).
        p.orbitAngle += p.orbitSpeed! * dt;
        p.radius! += p.radiusSpeed! * dt;
        const x = p.ox! + Math.cos(p.orbitAngle) * p.radius!;
        const y = p.oy! + Math.sin(p.orbitAngle) * p.radius!;
        p.vx = (x - p.x) / dt;
        p.vy = (y - p.y) / dt;
        p.x = x;
        p.y = y;
        p.rotation += p.spin * dt;
        if (p.rotationSpeed) p.rotation += p.rotationSpeed * dt;
        this.output(p);
        continue;
      }
      if (p.radialAccel !== undefined) {
        // 2.2: radial / tangential acceleration about the emitter's origin.
        const d = Math.hypot(p.x, p.y);
        const ux = d > 0 ? p.x / d : 0;
        const uy = d > 0 ? p.y / d : 0;
        const ra = p.radialAccel;
        const ta = p.tangentialAccel!;
        p.vx += (ux * ra + uy * ta) * dt;
        p.vy += (uy * ra - ux * ta) * dt;
      }
      if (c.gravityX) p.vx += c.gravityX * dt;
      p.vy += c.gravity * dt;
      if (c.limitVelocity) {
        const v = Math.hypot(p.vx, p.vy);
        if (v > c.limitVelocity.limit) {
          const keep = Math.pow(1 - c.limitVelocity.dampen, dt * DAMPEN_FPS);
          const nv = c.limitVelocity.limit + (v - c.limitVelocity.limit) * keep;
          p.vx *= nv / v;
          p.vy *= nv / v;
        }
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rotation += p.spin * dt;
      if (p.rotationSpeed) p.rotation += p.rotationSpeed * dt;
      this.output(p);
    }
  }

  private schedule(dt: number): void {
    const c = this.config;
    const prev = this.time;
    this.time += dt;
    const t0 = prev - c.startDelay;
    const t1 = this.time - c.startDelay;
    if (t1 < 0) return;
    const cycle = c.duration > 0 ? Math.floor(t1 / c.duration) : 0;
    if (!c.loop && t1 >= c.duration) {
      this.emitting = false;
      // Bursts scheduled exactly at the end still fire once.
    }
    if (cycle > this.loopsDone && c.loop) {
      this.loopsDone = cycle;
      this.burstDone = c.bursts.map(() => 0);
    }
    const local = c.loop ? t1 - cycle * c.duration : t1;
    if (c.rate > 0 && this.emitting) {
      if (c.whenFull === 'wait') {
        // 2.2 (Cocos): the emission clock runs only while there is room; what is due waits for it.
        if (this.particles.length < c.max) this.rateAcc += Math.min(dt, t1 - Math.max(0, t0)) * c.rate;
        const n = Math.min(Math.floor(this.rateAcc), c.max - this.particles.length);
        if (n > 0) {
          this.rateAcc -= n;
          this.emit(n);
        }
      } else {
        this.rateAcc += Math.min(dt, t1 - Math.max(0, t0)) * c.rate;
        const n = Math.floor(this.rateAcc);
        if (n > 0) {
          this.rateAcc -= n;
          this.emit(n);
        }
      }
    }
    c.bursts.forEach((b, i) => {
      while (this.burstDone[i] < Math.max(1, b.cycles) && local >= b.time + this.burstDone[i] * b.interval && (c.loop || b.time <= c.duration)) {
        this.burstDone[i]++;
        if (this.rng() <= b.prob) this.emit(Math.round(b.count));
      }
    });
  }

  private spawn(emitT: number): void {
    const c = this.config;
    const rng = this.rng;
    const p: SimParticle = this.pool.pop() ?? {
      x: 0, y: 0, vx: 0, vy: 0, age: 0, life: 1, size: 1, color: [1, 1, 1, 1], rotation: 0, spin: 0,
      outSize: 1, outColor: [1, 1, 1, 1], frame: 0, stretch: 1,
    };
    const sp = spawnPoint(c.shape, rng);
    const speed = sampleMinMax(c.speed, emitT, rng);
    p.x = sp.x;
    p.y = sp.y;
    p.vx = sp.dx * speed;
    p.vy = sp.dy * speed;
    p.age = 0;
    p.life = Math.max(1e-3, sampleMinMax(c.lifetime, emitT, rng));
    p.size = sampleMinMax(c.size, emitT, rng);
    if (c.colorPerChannel) pickColor(c.color, rng, true, p.color);
    else {
      const col = c.color;
      if (Array.isArray(col[0])) {
        const [a, b] = col as [RGBA, RGBA];
        const k = rng();
        for (let i = 0; i < 4; i++) p.color[i] = a[i] + (b[i] - a[i]) * k;
      } else for (let i = 0; i < 4; i++) p.color[i] = (col as RGBA)[i];
    }
    const flip = rng() < c.flipRotation ? -1 : 1;
    p.rotation = sampleMinMax(c.rotation, emitT, rng) * flip;
    p.spin = c.spin !== undefined ? sampleMinMax(c.spin, emitT, rng) * flip : 0;
    if (this.ext) this.spawnExt(p, emitT, flip, speed, sp.x, sp.y);
    this.spawned++;
    this.particles.push(p);
    this.output(p);
  }

  /** 2.2: the Cocos model's per-particle values (drawn after the 2.1 ones). */
  private spawnExt(p: SimParticle, emitT: number, flip: number, speed: number, x: number, y: number): void {
    const c = this.config;
    const rng = this.rng;
    const life = p.life;
    const angle = c.angle !== undefined ? sampleMinMax(c.angle, emitT, rng) : undefined;
    if (c.endSize !== undefined) {
      p.size = Math.max(0, p.size);
      p.endSize = Math.max(0, sampleMinMax(c.endSize, emitT, rng));
    } else p.endSize = undefined;
    if (c.endColor !== undefined) p.endColor = pickColor(c.endColor, rng, !!c.colorPerChannel, p.endColor ?? [1, 1, 1, 1]);
    else p.endColor = undefined;
    p.rotationSpeed = c.endRotation !== undefined ? (sampleMinMax(c.endRotation, emitT, rng) * flip - p.rotation) / life : undefined;
    if (c.orbit) {
      const o = c.orbit;
      const r0 = sampleMinMax(o.radius, emitT, rng);
      const r1 = o.endRadius !== undefined ? sampleMinMax(o.endRadius, emitT, rng) : r0;
      p.ox = x;
      p.oy = y;
      p.orbitAngle = angle ?? 0;
      p.orbitSpeed = sampleMinMax(o.speed, emitT, rng);
      p.radius = r0;
      p.radiusSpeed = (r1 - r0) / life;
      p.x = x + Math.cos(p.orbitAngle) * r0;
      p.y = y + Math.sin(p.orbitAngle) * r0;
      p.vx = 0;
      p.vy = 0;
      p.radialAccel = undefined;
      return;
    }
    p.orbitAngle = undefined;
    if (angle !== undefined) {
      p.vx = Math.cos(angle) * speed;
      p.vy = Math.sin(angle) * speed;
    }
    if (c.radialAccel !== undefined || c.tangentialAccel !== undefined) {
      p.radialAccel = c.radialAccel !== undefined ? sampleMinMax(c.radialAccel, emitT, rng) : 0;
      p.tangentialAccel = c.tangentialAccel !== undefined ? sampleMinMax(c.tangentialAccel, emitT, rng) : 0;
    } else p.radialAccel = undefined;
  }

  private output(p: SimParticle): void {
    const c = this.config;
    const t = Math.min(1, p.age / p.life);
    const size = p.endSize !== undefined ? p.size + (p.endSize - p.size) * t : p.size;
    p.outSize = size * (c.sizeOverLifetime ? sampleCurve(c.sizeOverLifetime, t) : 1);
    const g = c.colorOverLifetime ? sampleGradient(c.colorOverLifetime, t, [1, 1, 1, 1]) : null;
    const e = p.endColor;
    for (let i = 0; i < 4; i++) {
      const col = e ? p.color[i] + (e[i] - p.color[i]) * t : p.color[i];
      p.outColor[i] = Math.max(0, Math.min(1, col * (g ? g[i] : 1) * c.tint[i]));
    }
    if (c.render.mode === 'stretch') {
      const v = Math.hypot(p.vx, p.vy);
      p.stretch = p.outSize > 0 ? (p.outSize * c.render.lengthScale + v * c.render.velocityScale) / p.outSize : 1;
      if (v > 1e-6) p.rotation = Math.atan2(p.vy, p.vx) + Math.PI / 2;
    } else p.stretch = 1;
    if (c.sheet && this.frames > 1) {
      const k = sampleCurve(c.sheet.frameOverTime, (t * c.sheet.cycles) % 1) * c.sheet.mul;
      p.frame = Math.min(this.frames - 1, Math.max(0, Math.floor(k * this.frames)));
    } else p.frame = 0;
  }
}

/** A colour of a config (one, or random between two: one mix factor, or — perChannel — a draw per channel, clamped). */
function pickColor(col: RGBA | [RGBA, RGBA], rng: Rng, perChannel: boolean, out: RGBA): RGBA {
  if (!Array.isArray(col[0])) {
    for (let i = 0; i < 4; i++) out[i] = (col as RGBA)[i];
    return out;
  }
  const [a, b] = col as [RGBA, RGBA];
  if (perChannel) {
    for (let i = 0; i < 4; i++) out[i] = Math.max(0, Math.min(1, a[i] + (b[i] - a[i]) * rng()));
    return out;
  }
  const k = rng();
  for (let i = 0; i < 4; i++) out[i] = a[i] + (b[i] - a[i]) * k;
  return out;
}
