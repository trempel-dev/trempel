// types.ts — ParticleConfig: the particle format of the kit — Unity Shuriken modules, normalized
// (a config converted from Shuriken — trempel-fx-import — plays here unchanged; 2.1: trails too;
// 2.2: what Cocos particles need — gravity x, radial / tangential acceleration, an emission angle, an
// orbit ("radius") mode, end size / colour / rotation per particle, a box shape — all optional: a
// config without them plays exactly as before).
//
// Units: one "unit" = `unit` pixels of the space the effect is mounted in. Curves: [[t, v], …]
// linear. Angles in radians. y is DOWN. Bookkeeping fields of the converter (key, feature, cls)
// are optional here.

export type Curve = [number, number][];
/** Constant, random between two constants, or random between two curves over the emitter duration. */
export type MinMax = number | [number, number] | { curves: [Curve, Curve]; mul: number };
export type RGBA = [number, number, number, number];
export type Blend = 'add' | 'screen' | 'normal';

export interface Burst {
  time: number;
  count: number;
  cycles: number;
  interval: number;
  prob: number;
}

export interface ParticleConfig {
  key?: string;
  feature?: string;
  cls?: string;
  /** Pixels per unit along x / y. */
  unit: [number, number];
  /** Local position in a parent effect, units, y down. */
  pos: [number, number];
  duration: number;
  loop: boolean;
  prewarm: boolean;
  startDelay: number;
  lifetime: MinMax;
  speed: MinMax;
  size: MinMax;
  color: RGBA | [RGBA, RGBA];
  rotation: MinMax;
  /** Fraction of particles spinning the other way. */
  flipRotation: number;
  /** Gravity, units/s², y down. */
  gravity: number;
  max: number;
  /** Particles per second. */
  rate: number;
  bursts: Burst[];
  shape: ParticleShape;
  sizeOverLifetime?: Curve;
  colorOverLifetime?: { color: [number, number, number, number][]; alpha: Curve };
  /** Angular velocity, rad/s. */
  spin?: MinMax;
  limitVelocity?: { limit: number; dampen: number };
  sheet?: { tilesX: number; tilesY: number; frameOverTime: Curve; mul: number; cycles: number };
  render: { mode: 'billboard' | 'stretch'; lengthScale: number; velocityScale: number };
  /** 2.1: Shuriken trails — a stroke along each particle's recent path (drawn under the particles). */
  trails?: TrailConfig;
  /** Texture: a built-in shape ('circle' | 'square' | 'star' | 'spark') or an asset href. */
  texture: string;
  blend: Blend;
  /** Material tint multiplier. */
  tint: RGBA;

  // ── 2.2: the Cocos particle model (all optional; absent — the simulation is the 2.1 one) ──────────

  /** 2.2: gravity along x, units/s² (`gravity` is along y, down). */
  gravityX?: number;
  /**
   * 2.2: acceleration along the line from the emitter's origin to the particle, units/s² (positive —
   * away from the origin, negative — towards it). Sampled per particle.
   */
  radialAccel?: MinMax;
  /**
   * 2.2: acceleration perpendicular to that line, units/s² (positive — counter-clockwise on screen).
   * Sampled per particle.
   */
  tangentialAccel?: MinMax;
  /**
   * 2.2: the direction of the start velocity, radians, y down (0 — right, π/2 — down); replaces the
   * shape's direction (the shape still gives the start point). In `orbit` mode — the start angle.
   */
  angle?: MinMax;
  /** 2.2: the orbit ("radius") mode — particles circle the emitter's origin instead of flying. */
  orbit?: OrbitConfig;
  /**
   * 2.2: the end size per particle — the size goes linearly from the start one (`size`) to this over
   * the particle's life (then × `sizeOverLifetime` if any). Both are clamped at 0.
   */
  endSize?: MinMax;
  /**
   * 2.2: the end colour per particle — the colour goes linearly from the start one (`color`) to this
   * over the particle's life (then × `colorOverLifetime` if any). Random between two colours like `color`.
   */
  endColor?: RGBA | [RGBA, RGBA];
  /**
   * 2.2: "random between two colours" (`color`, `endColor`) draws every channel on its own (Cocos'
   * colour variance) instead of one mix factor for all four; the drawn colours are clamped to 0..1.
   */
  colorPerChannel?: boolean;
  /** 2.2: the end rotation per particle, radians — the rotation goes linearly from `rotation` to this over the life (plus `spin`). */
  endRotation?: MinMax;
  /**
   * 2.2: emission while the emitter has `max` particles: 'skip' (default, Shuriken) — the particles due
   * then are not emitted, the schedule goes on; 'wait' (Cocos) — the emission clock stops while full,
   * what was due comes out as room frees, and the schedule shifts.
   */
  whenFull?: 'skip' | 'wait';
}

/** Where particles start (and which way they go unless `angle` is set). */
export interface ParticleShape {
  /** 2.2: 'box' — a point uniformly in [−box[0], box[0]] × [−box[1], box[1]], no direction of its own. */
  type: 'point' | 'circle' | 'sphere' | 'box';
  radius: number;
  thickness: number;
  arc: number;
  scale: [number, number];
  /** 2.2: the half-size of the 'box' shape, units. */
  box?: [number, number];
}

/**
 * 2.2: the orbit mode of a config (Cocos "radius" mode): a particle sits at (cos θ, sin θ) × r from its
 * start point (the shape's), θ starting at `angle` and turning at `speed`, r going linearly from
 * `radius` to `endRadius` over the life. Speed, gravity and accelerations do not apply.
 */
export interface OrbitConfig {
  /** Start radius, units. */
  radius: MinMax;
  /** End radius, units (default: the start one, per particle). */
  endRadius?: MinMax;
  /** Angular speed, rad/s (positive — clockwise on screen, y down). */
  speed: MinMax;
}

/**
 * 2.1: a trail behind each particle (Shuriken Trails module, "particles" mode): a polyline of the
 * particle's recent positions, thinning and fading towards the tail. Everything has a default.
 */
export interface TrailConfig {
  /** Fraction of the particles that leave a trail, 0..1 (default 1). */
  ratio?: number;
  /** Length of the trail as a fraction of the particle's life (default 1). */
  lifetime?: number;
  /** A new point after the particle moved this far, units (default 0 — every frame). */
  minVertexDistance?: number;
  /** Width at the head, × the particle's size (default 1). */
  width?: number;
  /** Colour multiplier (× the particle's start colour, default white). */
  color?: RGBA;
  /** The trail material's texture in the source (strokes ignore it; kept for the report). */
  texture?: string;
  /** Blend of the trail (default: the particles'). */
  blend?: Blend;
  /** Material tint multiplier (default 1). */
  tint?: RGBA;
}

/** A config with defaults for everything but what you name (authoring by hand). */
export function particleConfig(partial: Partial<ParticleConfig>): ParticleConfig {
  return {
    unit: [1, 1],
    pos: [0, 0],
    duration: 1,
    loop: false,
    prewarm: false,
    startDelay: 0,
    lifetime: 1,
    speed: 100,
    size: 16,
    color: [1, 1, 1, 1],
    rotation: 0,
    flipRotation: 0,
    gravity: 0,
    max: 200,
    rate: 0,
    bursts: [],
    shape: { type: 'point', radius: 0, thickness: 1, arc: Math.PI * 2, scale: [1, 1] },
    render: { mode: 'billboard', lengthScale: 1, velocityScale: 0 },
    texture: 'circle',
    blend: 'normal',
    tint: [1, 1, 1, 1],
    ...partial,
  };
}
