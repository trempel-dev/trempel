// types.ts — ParticleConfig: the particle format of the kit — Unity Shuriken modules, normalized
// (a config converted from Shuriken plays here unchanged, except `trails`, not supported by the
// kit runtime — warned once).
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
  /** Shuriken trails — not played by the kit runtime. */
  trails?: unknown;
  /** Texture: a built-in shape ('circle' | 'square' | 'star' | 'spark') or an asset href. */
  texture: string;
  blend: Blend;
  /** Material tint multiplier. */
  tint: RGBA;
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
