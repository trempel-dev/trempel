// shuriken.ts — one Unity ParticleSystem (Shuriken, as serialized in YAML) → the kit's
// ParticleConfig, and what the kit plays of it: every system gets a class with the reasons —
//   auto   — every module it uses is played exactly;
//   manual — it plays, but something is approximated (look at it: limit-velocity dampen, stretched
//            billboards, a texture sheet, curves where the kit takes constants, trails as strokes, the
//            "soft additive" blend, a cone…);
//   hard   — something it relies on is not played at all (noise, collisions, forces, sub-emitters,
//            mesh rendering, a custom shader…).
// The logic of the normalization is a game's own converter (modules,
// curves, bursts, shapes, texture sheet, y-up → y-down, pixels per unit), now on the raw YAML.
//
// Units: one unit of a config = `unit` px of the space the effect is mounted in: a world system —
// pixels-per-unit × the scale chain of its GameObject; a uGUI one (GUI PRO Kit UIParticleSystem) —
// the scale chain (canvas px); a Coffee UIParticle one — its m_Scale3D.

import type { Blend, Burst, Curve, MinMax, ParticleConfig, RGBA, TrailConfig } from '../fx/types.js';
import { list, map, num, ref, type YamlMap, type YamlValue } from './yaml.js';

export type SystemClass = 'auto' | 'manual' | 'hard';

/** What the converter knows about a system besides its modules. */
export interface SystemContext {
  /** Px per unit along x / y (see the units above). */
  unit: [number, number];
  /** Position in its effect's root, units, y down. */
  pos: [number, number];
  /** The main material (renderer slot 0, or the uGUI graphic's material). */
  material: MaterialInfo | null;
  /** The trail material (renderer slot 1). */
  trailMaterial: MaterialInfo | null;
  /** The renderer draws (a uGUI / Coffee system draws through its component instead). */
  rendered: boolean;
  /** How it is drawn: 'world' | 'ugui' (UIParticleSystem) | 'coffee' (UIParticle). */
  space: 'world' | 'ugui' | 'coffee';
  /** A rotation of the GameObject (z, degrees) — ignored by the kit. */
  rotation?: number;
}

export interface MaterialInfo {
  /** Project path of the material. */
  path: string;
  /** Builtin shader id (Unity's built-in fileID), or null — a project shader. */
  builtin: number | null;
  /** Name of the shader ('Particles/Additive', 'UI/Additive'…). */
  shader: string;
  /** Project path of _MainTex, or null. */
  texture: string | null;
  colors: Record<string, RGBA>;
}

export interface Converted {
  config: ParticleConfig;
  cls: SystemClass;
  /** Played exactly / approximately / not at all. */
  exact: string[];
  approx: string[];
  unsupported: string[];
}

/** Built-in particle shaders of Unity (fileID in guid 0000000000000000f000000000000000). */
export const BUILTIN_SHADERS: Record<number, { name: string; blend: Blend | null; legacy: boolean }> = {
  200: { name: 'Particles/Additive', blend: 'add', legacy: true },
  201: { name: 'Particles/~Additive-Multiply', blend: null, legacy: true },
  202: { name: 'Particles/Additive (Soft)', blend: 'screen', legacy: true },
  203: { name: 'Particles/Alpha Blended', blend: 'normal', legacy: true },
  205: { name: 'Particles/Multiply', blend: null, legacy: true },
  206: { name: 'Particles/Multiply (Double)', blend: null, legacy: true },
  207: { name: 'Particles/Alpha Blended Premultiply', blend: 'normal', legacy: true },
  208: { name: 'Particles/VertexLit Blended', blend: 'normal', legacy: true },
  209: { name: 'Particles/Anim Alpha Blended', blend: 'normal', legacy: true },
  10720: { name: 'Mobile/Particles/Additive', blend: 'add', legacy: false },
  10721: { name: 'Mobile/Particles/Alpha Blended', blend: 'normal', legacy: false },
  10722: { name: 'Mobile/Particles/Multiply', blend: null, legacy: false },
  10723: { name: 'Mobile/Particles/VertexLit Blended', blend: 'normal', legacy: false },
  10753: { name: 'UI/Default', blend: 'normal', legacy: false },
  10770: { name: 'UI/Default', blend: 'normal', legacy: false },
};

/** A project shader by its name: what blend it is (the usual particle / UI ones). */
export function shaderBlendByName(name: string): Blend | null {
  const n = name.toLowerCase();
  if (/additive|\badd\b/.test(n)) return n.includes('soft') ? 'screen' : 'add';
  if (/alpha blended|\balpha\b|ui\/default|sprites\/default|unlit\/transparent/.test(n)) return 'normal';
  return null;
}

/** A texture name of the kit (and of the games): the file stem, lower-case, [a-z0-9_]. */
export function textureName(path: string): string {
  return (path.split('/').pop() ?? path)
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

// ── Shuriken values ───────────────────────────────────────────────────────────────────────────────

const curveOf = (v: YamlValue | undefined): Curve =>
  list(map(v).m_Curve).map((k) => {
    const m = map(k);
    return [num(m.time), num(m.value)] as [number, number];
  });

const key0 = (c: Curve): number => (c.length ? c[0][1] : 1);

/** A MinMaxCurve: 0 constant, 1 curve, 2 two curves, 3 two constants (legacy files: × key0 of the curves). */
export interface RawMinMax {
  state: number;
  /** The constants (legacy files: × key0 of the curves). */
  scalar: number;
  minScalar: number;
  /** The multiplier of the curves (the serialized scalar). */
  curveScalar: number;
  max: Curve;
  min: Curve;
}

export function readMinMax(v: YamlValue | undefined): RawMinMax {
  if (typeof v === 'string') return { state: 0, scalar: num(v), minScalar: num(v), curveScalar: num(v), max: [], min: [] };
  // Not serialized (an older file without the field): zero.
  if (v === undefined) return { state: 0, scalar: 0, minScalar: 0, curveScalar: 0, max: [], min: [] };
  const m = map(v);
  const max = curveOf(m.maxCurve);
  const min = curveOf(m.minCurve);
  const scalar = num(m.scalar, 1);
  // Legacy serialization (no minScalar): constants are scalar × key0 of the curves.
  const legacy = m.minScalar === undefined;
  return {
    state: num(m.minMaxState),
    scalar: legacy ? scalar * key0(max) : scalar,
    minScalar: legacy ? scalar * key0(min) : num(m.minScalar),
    curveScalar: scalar,
    max,
    min,
  };
}

interface Notes {
  exact: Set<string>;
  approx: Set<string>;
  unsupported: Set<string>;
}

/** A min-max value of the kit: constant / two constants exact, curves → mean (approx) or kept (startSize). */
function minMaxValue(r: RawMinMax, what: string, notes: Notes, mul = 1, keepCurves = false): MinMax {
  switch (r.state) {
    case 0:
      return r.scalar * mul;
    case 3:
      return [r.minScalar * mul, r.scalar * mul];
    case 2:
      if (keepCurves) {
        notes.approx.add(`${what}: random between two curves (over the emitter's duration)`);
        return { curves: [r.min, r.max], mul: r.curveScalar * mul };
      }
      notes.approx.add(`${what}: two curves → the range of their means`);
      return [mean(r.min) * r.curveScalar * mul, mean(r.max) * r.curveScalar * mul];
    default:
      notes.approx.add(`${what}: a curve → its mean`);
      return mean(r.max) * r.curveScalar * mul;
  }
}

const mean = (c: Curve): number => (c.length ? c.reduce((s, p) => s + p[1], 0) / c.length : 1);

/** A constant (two constants → their middle, approx). */
function constOf(r: RawMinMax, what: string, notes: Notes): number {
  const v = minMaxValue(r, what, notes);
  if (typeof v === 'number') return v;
  if (Array.isArray(v)) {
    if (v[0] !== v[1]) notes.approx.add(`${what}: random → the middle`);
    return (v[0] + v[1]) / 2;
  }
  return 0;
}

/** A curve of the kit (state 1: curve × scalar; a constant → flat; two curves → the max one, approx). */
function curveValue(r: RawMinMax, what: string, notes: Notes): Curve {
  if (r.state === 1) return r.max.map(([t, v]) => [t, v * r.curveScalar]);
  if (r.state === 2) {
    notes.approx.add(`${what}: random between two curves → the upper one`);
    return r.max.map(([t, v]) => [t, v * r.curveScalar]);
  }
  const c = r.state === 3 ? (r.minScalar + r.scalar) / 2 : r.scalar;
  if (r.state === 3 && r.minScalar !== r.scalar) notes.approx.add(`${what}: random between two constants → the middle`);
  return [
    [0, c],
    [1, c],
  ];
}

const rgba = (v: YamlValue | undefined): RGBA => {
  const m = map(v);
  return [num(m.r, 1), num(m.g, 1), num(m.b, 1), num(m.a, 1)];
};

/** A Gradient: colour keys [[t, r, g, b]] and alpha keys [[t, a]] (times 0..65535 → 0..1). */
export function readGradient(v: YamlValue | undefined): { color: [number, number, number, number][]; alpha: Curve } {
  const m = map(v);
  const nc = num(m.m_NumColorKeys, 2);
  const na = num(m.m_NumAlphaKeys, 2);
  const color: [number, number, number, number][] = [];
  const alpha: Curve = [];
  for (let i = 0; i < nc; i++) {
    const k = rgba(m[`key${i}`]);
    color.push([round(num(m[`ctime${i}`]) / 65535), k[0], k[1], k[2]]);
  }
  for (let i = 0; i < na; i++) alpha.push([round(num(m[`atime${i}`]) / 65535), rgba(m[`key${i}`])[3]]);
  return { color, alpha };
}

const round = (v: number) => Math.round(v * 1e4) / 1e4;

// ── one system ────────────────────────────────────────────────────────────────────────────────────

const on = (mod: YamlValue | undefined): boolean => map(mod).enabled === '1';

/** Shape types of Shuriken (ParticleSystemShapeType). */
const SHAPES: Record<number, string> = {
  0: 'sphere', 1: 'sphere shell', 2: 'hemisphere', 3: 'hemisphere shell', 4: 'cone', 5: 'box', 6: 'mesh', 7: 'cone shell', 8: 'cone volume',
  9: 'cone volume shell', 10: 'circle', 11: 'circle edge', 12: 'edge', 13: 'mesh renderer', 14: 'skinned mesh renderer', 15: 'box shell',
  16: 'box edge', 17: 'donut', 18: 'rectangle', 19: 'sprite', 20: 'sprite renderer',
};

/** Modules the kit does not play at all. */
const UNSUPPORTED_MODULES: [string, string][] = [
  ['NoiseModule', 'noise'],
  ['CollisionModule', 'collision'],
  ['TriggerModule', 'trigger'],
  ['ExternalForcesModule', 'external forces'],
  ['ForceModule', 'force over lifetime'],
  ['InheritVelocityModule', 'inherit velocity'],
  ['LifetimeByEmitterSpeedModule', 'lifetime by emitter speed'],
  ['SizeBySpeedModule', 'size by speed'],
  ['ColorBySpeedModule', 'colour by speed'],
  ['LightsModule', 'lights'],
  ['CustomDataModule', 'custom data'],
];

const RENDER_MODES = ['billboard', 'stretch', 'horizontal billboard', 'vertical billboard', 'mesh', 'none'];

/** Convert one ParticleSystem (its YAML body) and its renderer (ParticleSystemRenderer body). */
export function convertSystem(ps: YamlMap, renderer: YamlMap | null, ctx: SystemContext): Converted {
  const notes: Notes = { exact: new Set(), approx: new Set(), unsupported: new Set() };
  const main = map(ps.InitialModule);
  const exact = (s: string) => notes.exact.add(s);

  // main
  const lifetime = minMaxValue(readMinMax(main.startLifetime), 'start lifetime', notes);
  const speed = minMaxValue(readMinMax(main.startSpeed), 'start speed', notes);
  const size = minMaxValue(readMinMax(main.startSize), 'start size', notes, 1, true);
  if (main.size3D === '1') notes.approx.add('3D start size: x only');
  const rotation = minMaxValue(readMinMax(main.startRotation), 'start rotation', notes);
  if (main.rotation3D === '1') notes.approx.add('3D start rotation: z only');
  const gravity = constOf(readMinMax(main.gravityModifier), 'gravity modifier', notes) * 9.81;
  const startDelay = constOf(readMinMax(ps.startDelay), 'start delay', notes);
  exact('main: duration, loop, prewarm, lifetime, speed, size, rotation, gravity, max');
  const sc = map(main.startColor);
  const scState = num(sc.minMaxState);
  let color: RGBA | [RGBA, RGBA];
  if (scState === 2) color = [rgba(sc.minColor), rgba(sc.maxColor)];
  else if (scState === 0) color = rgba(sc.maxColor);
  else {
    const g = readGradient(scState === 3 ? sc.maxGradient : sc.maxGradient);
    const c0 = g.color[0] ?? [0, 1, 1, 1];
    color = [c0[1], c0[2], c0[3], g.alpha[0]?.[1] ?? 1];
    notes.approx.add('start colour: a gradient → its first key');
  }
  if (ps.moveWithTransform === '1') notes.approx.add('simulation space World: simulated in the effect\'s space');
  if (num(ps.simulationSpeed, 1) !== 1) notes.approx.add(`simulation speed ${num(ps.simulationSpeed, 1)}: ignored`);

  // emission
  const em = map(ps.EmissionModule);
  let rate = 0;
  const bursts: Burst[] = [];
  if (on(em)) {
    rate = constOf(readMinMax(em.rateOverTime), 'rate over time', notes);
    if (constOf(readMinMax(em.rateOverDistance), 'rate over distance', { exact: new Set(), approx: new Set(), unsupported: new Set() }) > 0) notes.unsupported.add('rate over distance');
    const count = em.m_BurstCount === undefined ? Infinity : num(em.m_BurstCount);
    for (const b of list(em.m_Bursts).slice(0, count)) {
      const bm = map(b);
      const cnt = bm.countCurve !== undefined ? constOf(readMinMax(bm.countCurve), 'burst count', notes) : (num(bm.minCount) + num(bm.maxCount)) / 2;
      bursts.push({ time: num(bm.time), count: cnt, cycles: num(bm.cycleCount, 1), interval: num(bm.repeatInterval, 0.01), prob: num(bm.probability, 1) });
    }
    exact('emission: rate, bursts');
  }

  // shape
  const sh = map(ps.ShapeModule);
  let shape: ParticleConfig['shape'] = { type: 'point', radius: 0, thickness: 1, arc: Math.PI * 2, scale: [0, 0] };
  if (on(sh)) {
    const type = num(sh.type);
    const name = SHAPES[type] ?? `type ${type}`;
    const radius = typeof sh.radius === 'object' ? num(map(sh.radius).value) : num(sh.radius);
    const arc = typeof sh.arc === 'object' ? num(map(sh.arc).value, 360) : num(sh.arc, 360);
    const s = map(sh.m_Scale);
    const scale: [number, number] = [num(s.x, 1), num(s.y, 1)];
    const thickness = num(sh.radiusThickness, 1);
    if ([0, 2].includes(type) || [10].includes(type)) {
      shape = { type: type === 10 ? 'circle' : 'sphere', radius, thickness, arc: (arc * Math.PI) / 180, scale };
      exact(`shape: ${name}`);
    } else if ([1, 3, 11].includes(type)) {
      shape = { type: type === 11 ? 'circle' : 'sphere', radius, thickness: 0, arc: (arc * Math.PI) / 180, scale };
      exact(`shape: ${name}`);
    } else if ([4, 7, 8, 9].includes(type)) {
      // A cone along +Z (out of the screen): on screen — directions spread around the axis.
      shape = { type: 'circle', radius, thickness, arc: Math.PI * 2, scale };
      notes.approx.add(`shape: ${name} → a circle of its radius`);
    } else notes.unsupported.add(`shape: ${name}`);
    if (num(sh.randomDirectionAmount) > 0 || num(sh.sphericalDirectionAmount) > 0) notes.approx.add('shape: random / spherical direction amount ignored');
    const pos = map(sh.m_Position);
    if (num(pos.x) !== 0 || num(pos.y) !== 0) notes.approx.add('shape: position offset ignored');
  }

  // over lifetime
  let sizeOverLifetime: Curve | undefined;
  const sol = map(ps.SizeModule);
  if (on(sol)) {
    sizeOverLifetime = curveValue(readMinMax(sol.curve), 'size over lifetime', notes);
    if (sol.separateAxes === '1') notes.approx.add('size over lifetime: separate axes → x');
    exact('size over lifetime');
  }
  let colorOverLifetime: ParticleConfig['colorOverLifetime'];
  const col = map(ps.ColorModule);
  if (on(col)) {
    const g = map(col.gradient);
    const st = num(g.minMaxState);
    if (st === 1 || st === 3 || st === 4) {
      colorOverLifetime = readGradient(g.maxGradient);
      if (st === 3) notes.approx.add('colour over lifetime: random between two gradients → the second');
      if (st === 4) notes.approx.add('colour over lifetime: random colour → the gradient');
    } else {
      const c = rgba(st === 2 ? g.maxColor : g.maxColor);
      colorOverLifetime = { color: [[0, c[0], c[1], c[2]], [1, c[0], c[1], c[2]]], alpha: [[0, c[3]], [1, c[3]]] };
      if (st === 2) notes.approx.add('colour over lifetime: random between two colours → the second');
    }
    exact('colour over lifetime');
  }
  let spin: MinMax | undefined;
  for (const [k, what] of [
    ['RotationModule', 'rotation over lifetime'],
    ['RotationBySpeedModule', 'rotation by speed'],
  ] as const) {
    const r = map(ps[k]);
    if (!on(r) || spin !== undefined) continue;
    spin = minMaxValue(readMinMax(r.curve), what, notes);
    if (k === 'RotationBySpeedModule' && !(typeof speed === 'number' && speed === 0)) notes.exact.add('rotation by speed: an angular speed (the particles keep their speed)');
    else exact(what);
  }
  let limitVelocity: ParticleConfig['limitVelocity'];
  const lv = map(ps.ClampVelocityModule);
  if (on(lv)) {
    const limit = constOf(readMinMax(lv.magnitude), 'limit velocity', notes);
    const moving = !(typeof speed === 'number' && speed === 0 && gravity === 0);
    limitVelocity = { limit, dampen: num(lv.dampen) };
    if (moving) notes.approx.add('limit velocity: dampen per frame at 60 fps');
    else exact('limit velocity: no speed, nothing to limit');
    if (lv.separateAxis === '1') notes.approx.add('limit velocity: separate axes → magnitude');
    if (constOf(readMinMax(lv.drag), 'drag', notes) > 0) notes.unsupported.add('limit velocity: drag');
  }
  const vel = map(ps.VelocityModule);
  if (on(vel)) notes.unsupported.add('velocity over lifetime');
  for (const [k, what] of UNSUPPORTED_MODULES) if (on(ps[k])) notes.unsupported.add(what);
  const sub = map(ps.SubModule);
  if (on(sub)) {
    const real = list(sub.subEmitters).some((e) => !!ref(map(e).emitter));
    if (real) notes.unsupported.add('sub-emitters');
    else exact('sub-emitters: the slot is empty — nothing to play');
  }
  let sheet: ParticleConfig['sheet'];
  const uv = map(ps.UVModule);
  if (on(uv)) {
    if (num(uv.mode) !== 0) notes.unsupported.add('texture sheet: sprites mode');
    const r = readMinMax(uv.frameOverTime);
    const fc = r.state === 1 || r.state === 2 ? r.max : ([[0, 0], [1, 1]] as Curve);
    sheet = { tilesX: num(uv.tilesX, 1), tilesY: num(uv.tilesY, 1), frameOverTime: fc, mul: r.state === 1 || r.state === 2 ? r.curveScalar : 1, cycles: num(uv.cycles, 1) };
    if (num(uv.animationType) === 1) notes.approx.add('texture sheet: a single row → the whole sheet');
    notes.approx.add('texture sheet: frames by the curve over lifetime');
  }

  // renderer
  const rnd = renderer ?? {};
  const mode = num(rnd.m_RenderMode);
  const render: ParticleConfig['render'] = { mode: mode === 1 ? 'stretch' : 'billboard', lengthScale: num(rnd.m_LengthScale, 2), velocityScale: num(rnd.m_VelocityScale) };
  if (mode === 1) notes.approx.add('render: stretched billboard (size × lengthScale + speed × velocityScale)');
  else if (mode === 0 || ctx.space === 'ugui') exact('render: billboard');
  else if (mode === 2 || mode === 3) notes.approx.add(`render: ${RENDER_MODES[mode]} → billboard`);
  else notes.unsupported.add(`render: ${RENDER_MODES[mode] ?? mode}`);
  if (!ctx.rendered) notes.approx.add('the renderer is off — nothing is drawn in the source');
  if (ctx.rotation) notes.approx.add(`GameObject rotated ${round(ctx.rotation)}° — ignored`);

  // material
  const m = ctx.material;
  let blend: Blend = 'normal';
  let tint: RGBA = [1, 1, 1, 1];
  let texture = 'circle';
  if (!m) notes.unsupported.add('no material — the kit draws a white circle');
  else if (m.path.startsWith('builtin:')) {
    // Unity's built-in particle material (Default-Particle): a soft white dot, alpha blended.
    notes.approx.add(`${m.shader} (Unity's default particle) → the kit's circle, blend normal`);
  } else {
    const b = materialBlend(m);
    if (b.blend === null) notes.unsupported.add(`shader ${m.shader}`);
    else {
      blend = b.blend;
      if (b.blend === 'screen') notes.approx.add(`shader ${m.shader} → blend screen`);
      else exact(`shader ${m.shader} → blend ${b.blend}`);
      if (b.custom) notes.approx.add(`project shader ${m.shader} → blend ${b.blend} by its name`);
    }
    tint = b.tint;
    if (m.texture) texture = textureName(m.texture);
    else notes.unsupported.add('material without _MainTex');
  }

  // trails
  let trails: TrailConfig | undefined;
  const tr = map(ps.TrailModule);
  if (on(tr)) {
    if (num(tr.mode) !== 0) notes.unsupported.add('trails: ribbon mode');
    const tm = ctx.trailMaterial;
    const tb = tm ? materialBlend(tm) : null;
    const tc = map(tr.colorOverLifetime);
    trails = {
      ratio: num(tr.ratio, 1),
      lifetime: constOf(readMinMax(tr.lifetime), 'trail lifetime', notes),
      minVertexDistance: num(tr.minVertexDistance, 0.2),
      width: constOf(readMinMax(tr.widthOverTrail), 'trail width', notes),
      color: num(tc.minMaxState) === 0 ? rgba(tc.maxColor) : [1, 1, 1, 1],
      texture: tm?.texture ? textureName(tm.texture) : undefined,
      blend: tb?.blend ?? blend,
      tint: tb?.tint ?? [1, 1, 1, 1],
    };
    notes.approx.add('trails: strokes along the path (the trail texture is not drawn)');
  }

  const config: ParticleConfig = {
    unit: ctx.unit,
    pos: ctx.pos,
    duration: num(ps.lengthInSec, 5),
    loop: ps.looping === '1',
    prewarm: ps.prewarm === '1',
    startDelay,
    lifetime,
    speed,
    size,
    color,
    rotation,
    flipRotation: num(main.randomizeRotationDirection),
    gravity,
    max: num(main.maxNumParticles, 1000),
    rate,
    bursts,
    shape,
    render,
    texture,
    blend,
    tint,
  };
  if (sizeOverLifetime) config.sizeOverLifetime = sizeOverLifetime;
  if (colorOverLifetime) config.colorOverLifetime = colorOverLifetime;
  if (spin !== undefined) config.spin = spin;
  if (limitVelocity) config.limitVelocity = limitVelocity;
  if (sheet) config.sheet = sheet;
  if (trails) config.trails = trails;
  const cls: SystemClass = notes.unsupported.size ? 'hard' : notes.approx.size ? 'manual' : 'auto';
  return { config, cls, exact: [...notes.exact], approx: [...notes.approx], unsupported: [...notes.unsupported] };
}

/** Blend and tint of a material: built-in shaders by id, project ones by name. */
export function materialBlend(m: MaterialInfo): { blend: Blend | null; tint: RGBA; custom: boolean } {
  const b = m.builtin !== null ? BUILTIN_SHADERS[m.builtin] : undefined;
  const legacy = b?.legacy ?? false;
  const blend = b ? b.blend : shaderBlendByName(m.shader);
  // Legacy particle shaders multiply by _TintColor × 2 (default 0.5 grey — no change).
  const t = m.colors._TintColor ?? [0.5, 0.5, 0.5, 0.5];
  const tint: RGBA = legacy ? [t[0] * 2, t[1] * 2, t[2] * 2, t[3] * 2] : [1, 1, 1, 1];
  return { blend, tint, custom: !b };
}
