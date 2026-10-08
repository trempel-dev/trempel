// types.ts — ParticleConfig: the particle format of the kit — Unity Shuriken modules, normalized
// (a config converted from Shuriken — trempel-fx-import — plays here unchanged; 2.1: trails too).
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
  shape: { type: 'point' | 'circle' | 'sphere'; radius: number; thickness: number; arc: number; scale: [number, number] };
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
