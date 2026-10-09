// cocos.ts — trempel-fx-import --cocos: Cocos particles (Particle Designer / Particle2dx: an XML
// .plist, or the .json variant with the same keys) → the kit's effects. One file = one emitter = one
// effect named after the file. Both emitter modes: gravity (gravity x / y, speed, angle, radial and
// tangential acceleration) and radius (start / end radius, rotation per second) — the kit's 2.2
// config fields (orbit, radialAccel, tangentialAccel, angle, endSize / endColor / endRotation,
// colorPerChannel, a box shape, whenFull 'wait'). Cocos is y up with counter-clockwise degrees; the
// kit — y down, radians. Units: points = config units, `unit` = [scale, scale] px.
//
// Texture: textureFileName next to the file (what Cocos loads first), else textureImageData (base64,
// gzip or zlib or raw → PNG; a TIFF payload is not read → the built-in circle). Every emitter is
// checked against a reference model of Cocos (cocos-model.ts) — the differences go into the report.
//
// Output (writeCocosImport): effects.json — { name: [ParticleConfig] }, createGame({ fx: { effects } })
// as is; textures/<name>.png without metadata; report.md / report.json — every emitter auto / manual
// / hard with what is exact, approximated, not played and the check.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { gunzipSync, inflateSync } from 'node:zlib';
import type { Blend, MinMax, ParticleConfig, RGBA } from '../fx/types.js';
import { particleConfig } from '../fx/types.js';
import { isPng, stripPng } from '../vite/metadata.js';
import { TOLERANCE, verifyCocos, type CocosEmitter, type Verification } from './cocos-model.js';
import { texturePng } from './image.js';
import { parsePlist, type PlistDict, type PlistValue } from './plist.js';
import { textureName } from './shuriken.js';

export type CocosClass = 'auto' | 'manual' | 'hard';

export interface CocosImportOptions {
  /** .plist / .json files, or folders (every particle .plist / .json under them). */
  inputs: string[];
  /** Pixels per Cocos point (default 1). */
  scale?: number;
  /** Only effects whose name starts with one of these. */
  only?: string[];
}

export interface CocosSystemReport {
  key: string;
  file: string;
  cls: CocosClass;
  mode: CocosEmitter['mode'];
  texture: string;
  /** Source blend pair (GL constants) → the kit's blend. */
  blend: string;
  positionType: string;
  exact: string[];
  approx: string[];
  unsupported: string[];
  verification: Verification;
}

export interface CocosImportResult {
  /** The common folder of the inputs (paths in the report are relative to it). */
  root: string;
  effects: Record<string, ParticleConfig[]>;
  systems: CocosSystemReport[];
  /** Texture name → PNG bytes (metadata stripped). */
  textures: Map<string, Uint8Array>;
  /** Texture name → where it came from. */
  textureSources: Map<string, string>;
  warnings: string[];
  files: number;
}

// ── reading ───────────────────────────────────────────────────────────────────────────────────────

/** A file's emitter dict (plist or JSON), or an error with E_FX_IMPORT_COCOS. `null` — not a particle file. */
export function readCocosFile(file: string): PlistDict | null {
  const text = readFileSync(file, 'utf8');
  let v: PlistValue | unknown;
  if (/\.json$/i.test(file)) {
    try {
      v = JSON.parse(text);
    } catch (e) {
      throw new Error(`E_FX_IMPORT_COCOS: ${basename(file)}: not JSON (${(e as Error).message})`);
    }
  } else v = parsePlist(text, basename(file));
  if (!v || typeof v !== 'object' || Array.isArray(v) || v instanceof Uint8Array) return null;
  const d = v as PlistDict;
  return 'maxParticles' in d || 'emitterType' in d || 'particleLifespan' in d ? d : null;
}

const num = (d: PlistDict, key: string | string[], def = 0): number => {
  for (const k of Array.isArray(key) ? key : [key]) {
    const v = d[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
    if (typeof v === 'boolean') return v ? 1 : 0;
  }
  return def;
};
const has = (d: PlistDict, key: string) => d[key] !== undefined && d[key] !== '';
const rgba = (d: PlistDict, pre: string): RGBA => [num(d, `${pre}Red`), num(d, `${pre}Green`), num(d, `${pre}Blue`), num(d, `${pre}Alpha`)];

/** The emitter of a Cocos dict (Particle Designer keys; both spellings of the finish size variance). */
export function cocosEmitter(d: PlistDict): CocosEmitter {
  const max = Math.max(0, Math.round(num(d, 'maxParticles')));
  const life = num(d, 'particleLifespan');
  const explicit = num(d, 'emissionRate', -1);
  return {
    mode: num(d, 'emitterType') === 1 ? 'radius' : 'gravity',
    maxParticles: max,
    life,
    lifeVar: num(d, 'particleLifespanVariance'),
    duration: num(d, 'duration', -1),
    emissionRate: explicit > 0 ? explicit : life > 0 ? max / life : 0,
    angle: num(d, 'angle'),
    angleVar: num(d, 'angleVariance'),
    gravity: [num(d, 'gravityx'), num(d, 'gravityy')],
    speed: num(d, 'speed'),
    speedVar: num(d, 'speedVariance'),
    radialAccel: num(d, 'radialAcceleration'),
    radialAccelVar: num(d, 'radialAccelVariance'),
    tangentialAccel: num(d, 'tangentialAcceleration'),
    tangentialAccelVar: num(d, 'tangentialAccelVariance'),
    startRadius: num(d, 'maxRadius'),
    startRadiusVar: num(d, 'maxRadiusVariance'),
    endRadius: num(d, 'minRadius'),
    endRadiusVar: num(d, 'minRadiusVariance'),
    rotatePerSecond: num(d, 'rotatePerSecond'),
    rotatePerSecondVar: num(d, 'rotatePerSecondVariance'),
    startSize: num(d, 'startParticleSize'),
    startSizeVar: num(d, 'startParticleSizeVariance'),
    endSize: num(d, 'finishParticleSize', -1),
    endSizeVar: num(d, ['finishParticleSizeVariance', 'FinishParticleSizeVariance']),
    startColor: rgba(d, 'startColor'),
    startColorVar: rgba(d, 'startColorVariance'),
    endColor: rgba(d, 'finishColor'),
    endColorVar: rgba(d, 'finishColorVariance'),
    startSpin: num(d, 'rotationStart'),
    startSpinVar: num(d, 'rotationStartVariance'),
    endSpin: num(d, 'rotationEnd'),
    endSpinVar: num(d, 'rotationEndVariance'),
    sourcePosition: [num(d, 'sourcePositionx'), num(d, 'sourcePositiony')],
    posVar: [num(d, 'sourcePositionVariancex'), num(d, 'sourcePositionVariancey')],
    blend: has(d, 'blendFuncSource') || has(d, 'blendFuncDestination') ? [num(d, 'blendFuncSource', 1), num(d, 'blendFuncDestination', 771)] : null,
    positionType: num(d, 'positionType', 0),
    rotationIsDir: num(d, 'rotationIsDir') !== 0,
    yCoordFlipped: num(d, 'yCoordFlipped', 1),
  };
}

// ── converting ────────────────────────────────────────────────────────────────────────────────────

const GL: Record<number, string> = {
  0: 'ZERO', 1: 'ONE', 768: 'SRC_COLOR', 769: 'ONE_MINUS_SRC_COLOR', 770: 'SRC_ALPHA', 771: 'ONE_MINUS_SRC_ALPHA',
  772: 'DST_ALPHA', 773: 'ONE_MINUS_DST_ALPHA', 774: 'DST_COLOR', 775: 'ONE_MINUS_DST_COLOR', 776: 'SRC_ALPHA_SATURATE',
};
const glName = (v: number) => GL[v] ?? String(v);

/** A blend pair (GL constants) → the kit's blend; `exact` — the same equation. */
export function cocosBlend(src: number, dst: number): { blend: Blend; exact: boolean } {
  if (dst === 1 && (src === 1 || src === 770)) return { blend: 'add', exact: true };
  if (dst === 771 && (src === 770 || src === 1)) return { blend: 'normal', exact: true };
  if (src === 1 && dst === 769) return { blend: 'screen', exact: false };
  if (dst === 1) return { blend: 'add', exact: false };
  return { blend: 'normal', exact: false };
}

const RAD = Math.PI / 180;
const r6 = (v: number) => Math.round(v * 1e9) / 1e9 || 0;

/**
 * value ± var, × k + off → MinMax ordered so that the kit's draw r and the model's (2r − 1) give the
 * same value: [off + k(v − var), off + k(v + var)] (a constant when var is 0).
 */
export function mm(v: number, variance: number, k = 1, off = 0): MinMax {
  return variance ? [r6(off + k * (v - variance)), r6(off + k * (v + variance))] : r6(off + k * v);
}

const colorOf = (c: RGBA, v: RGBA): RGBA | [RGBA, RGBA] =>
  v.some((x) => x !== 0) ? [c.map((x, i) => r6(x - v[i])) as RGBA, c.map((x, i) => r6(x + v[i])) as RGBA] : (c.map(r6) as RGBA);

export interface CocosConversion {
  config: ParticleConfig;
  cls: CocosClass;
  exact: string[];
  approx: string[];
  unsupported: string[];
}

/** An emitter → a kit config (texture name given) with the notes of what is exact / approximated / not played. */
export function convertCocos(e: CocosEmitter, texture: string, scale = 1): CocosConversion {
  const exact: string[] = [];
  const approx: string[] = [];
  const unsupported: string[] = [];
  const c: Partial<ParticleConfig> = { unit: [scale, scale], pos: [0, 0], texture, tint: [1, 1, 1, 1], max: e.maxParticles, rate: r6(e.emissionRate), whenFull: 'wait' };
  exact.push(`emission: ${r6(e.emissionRate)}/s, max ${e.maxParticles}`);
  // duration
  if (e.duration === -1 || e.duration < 0) {
    c.loop = true;
    c.duration = 1;
    exact.push('duration −1: emits until stopped');
  } else if (e.duration === 0) {
    c.loop = false;
    c.duration = 1 / 30;
    approx.push('duration 0: Cocos emits for one frame — one frame at 60 fps here');
  } else {
    c.loop = false;
    c.duration = r6(e.duration);
  }
  c.lifetime = mm(e.life, e.lifeVar);
  // size, colour, rotation
  c.size = mm(e.startSize, e.startSizeVar);
  if (e.endSize !== -1) c.endSize = mm(e.endSize, e.endSizeVar);
  else if (e.startSize - e.startSizeVar < 0) approx.push('start size below 0 for some particles: Cocos draws them at 0, here mirrored');
  c.color = colorOf(e.startColor, e.startColorVar);
  const endColor = colorOf(e.endColor, e.endColorVar);
  if (JSON.stringify(endColor) !== JSON.stringify(c.color) || Array.isArray(endColor[0])) c.endColor = endColor;
  if ([...e.startColorVar, ...e.endColorVar].some((x) => x !== 0)) c.colorPerChannel = true;
  c.rotation = mm(e.startSpin, e.startSpinVar, RAD);
  if (e.endSpin !== e.startSpin || e.endSpinVar !== 0 || e.startSpinVar !== 0) c.endRotation = mm(e.endSpin, e.endSpinVar, RAD);
  if (e.rotationIsDir) approx.push('rotationIsDir: the rotation does not follow the direction');
  // motion
  if (e.mode === 'gravity') {
    c.speed = mm(e.speed, e.speedVar);
    c.angle = mm(e.angle, e.angleVar, -RAD);
    c.gravityX = r6(e.gravity[0]);
    c.gravity = r6(-e.gravity[1]);
    if (e.radialAccel || e.radialAccelVar || e.tangentialAccel || e.tangentialAccelVar) {
      c.radialAccel = mm(e.radialAccel, e.radialAccelVar);
      c.tangentialAccel = mm(e.tangentialAccel, e.tangentialAccelVar);
    }
    c.shape = e.posVar[0] || e.posVar[1]
      ? { type: 'box', radius: 0, thickness: 1, arc: Math.PI * 2, scale: [1, 1], box: [r6(Math.abs(e.posVar[0])), r6(Math.abs(e.posVar[1]))] }
      : { type: 'point', radius: 0, thickness: 1, arc: Math.PI * 2, scale: [1, 1] };
    exact.push('gravity mode: gravity, speed, angle, radial / tangential acceleration, source position variance');
  } else {
    c.speed = 0;
    c.angle = mm(e.angle, e.angleVar, -RAD, Math.PI);
    c.orbit = { radius: mm(e.startRadius, e.startRadiusVar), speed: mm(e.rotatePerSecond, e.rotatePerSecondVar, -RAD) };
    if (e.endRadius !== -1) c.orbit.endRadius = mm(e.endRadius, e.endRadiusVar);
    c.shape = { type: 'point', radius: 0, thickness: 1, arc: Math.PI * 2, scale: [1, 1] };
    exact.push('radius mode: start / end radius, rotation per second');
    if (e.posVar[0] || e.posVar[1]) exact.push('source position variance: not used in radius mode (as in Cocos)');
  }
  // blend
  let blendNote = 'default';
  if (e.blend) {
    const [s, d] = e.blend;
    const b = cocosBlend(s, d);
    c.blend = b.blend;
    blendNote = `${glName(s)}/${glName(d)} → ${b.blend}`;
    if (b.exact) exact.push(`blend ${blendNote}`);
    else approx.push(`blend ${blendNote} (nearest)`);
  } else c.blend = 'normal';
  // where
  if (e.sourcePosition[0] || e.sourcePosition[1]) exact.push(`source position (${r6(e.sourcePosition[0])}, ${r6(e.sourcePosition[1])}): the designer's canvas — the effect plays where the game puts it`);
  if (e.positionType === 2) exact.push('positionType grouped: particles move with the effect');
  else approx.push(`positionType ${e.positionType === 1 ? 'relative' : 'free'}: particles move with the effect (Cocos leaves them where they were born) — the same while it stands still`);
  if (e.yCoordFlipped === -1) unsupported.push('yCoordFlipped −1');
  if (e.maxParticles === 0 || e.emissionRate === 0) approx.push('emits nothing (max particles or rate is 0)');
  const config = particleConfig(c);
  const cls: CocosClass = unsupported.length ? 'hard' : approx.length ? 'manual' : 'auto';
  return { config, cls, exact, approx, unsupported };
}

// ── textures ──────────────────────────────────────────────────────────────────────────────────────

/** The bytes of textureImageData: base64 (or <data>) → gzip / zlib / raw. */
export function textureData(v: PlistValue | undefined): Uint8Array | null {
  let b: Uint8Array;
  if (v instanceof Uint8Array) b = v;
  else if (typeof v === 'string' && v.trim()) b = new Uint8Array(Buffer.from(v.replace(/\s+/g, ''), 'base64'));
  else return null;
  if (b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b) return new Uint8Array(gunzipSync(b));
  if (b.length >= 2 && b[0] === 0x78 && (b[0] * 256 + b[1]) % 31 === 0) {
    try {
      return new Uint8Array(inflateSync(b));
    } catch {
      return b;
    }
  }
  return b;
}

const isTiff = (b: Uint8Array) => b.length >= 4 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 0x2a));

/** A PNG of embedded texture bytes, or why not. */
export function embeddedPng(b: Uint8Array): { png: Uint8Array } | { error: string } {
  if (isPng(b)) return { png: stripPng(b).data };
  if (isTiff(b)) return { error: 'TIFF texture data is not read (PNG is)' };
  return { error: 'texture data is not a PNG' };
}

// ── importing ─────────────────────────────────────────────────────────────────────────────────────

/** The .plist / .json files under a folder: its own first, then its subfolders' (sorted). */
function particleFiles(dir: string): string[] {
  const out: string[] = [];
  const subs: string[] = [];
  for (const n of readdirSync(dir).sort()) {
    if (n.startsWith('.') || n === 'node_modules') continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) subs.push(p);
    else if (/\.(plist|json)$/i.test(n)) out.push(p);
  }
  for (const p of subs) out.push(...particleFiles(p));
  return out;
}

const stem = (f: string) => basename(f).replace(/\.[^.]+$/, '');

export function importCocos(opts: CocosImportOptions): CocosImportResult {
  if (!opts.inputs.length) throw new Error('E_FX_IMPORT_INPUT: nothing to import (Cocos .plist / .json files or folders)');
  const scale = opts.scale ?? 1;
  if (!(scale > 0)) throw new Error('E_FX_IMPORT_INPUT: the scale must be a positive number');
  const files: { file: string; explicit: boolean }[] = [];
  const roots: string[] = [];
  for (const i of opts.inputs) {
    const p = resolve(i);
    if (!existsSync(p)) throw new Error(`E_FX_IMPORT_INPUT: ${i} not found`);
    if (statSync(p).isDirectory()) {
      roots.push(p);
      for (const f of particleFiles(p)) files.push({ file: f, explicit: false });
    } else if (/\.(plist|json)$/i.test(p)) {
      roots.push(dirname(p));
      files.push({ file: p, explicit: true });
    } else throw new Error(`E_FX_IMPORT_INPUT: ${i}: not a .plist / .json`);
  }
  const root = commonDir(roots);
  const effects: Record<string, ParticleConfig[]> = {};
  const systems: CocosSystemReport[] = [];
  const textures = new Map<string, Uint8Array>();
  const textureSources = new Map<string, string>();
  const warnings: string[] = [];
  const rel = (f: string) => relative(root, f) || basename(f);
  let read = 0;
  for (const { file, explicit } of files) {
    let d: PlistDict | null;
    try {
      d = readCocosFile(file);
    } catch (e) {
      if (explicit) throw e;
      warnings.push((e as Error).message);
      continue;
    }
    if (!d) {
      if (explicit) throw new Error(`E_FX_IMPORT_COCOS: ${rel(file)}: not a particle emitter (no maxParticles / emitterType / particleLifespan)`);
      if (/\.plist$/i.test(file)) warnings.push(`W_FX_IMPORT_COCOS: ${rel(file)}: not a particle emitter — skipped`);
      continue;
    }
    read++;
    let name = stem(file);
    if (opts.only?.length && !opts.only.some((o) => name.startsWith(o))) continue;
    if (effects[name]) name = rel(file).replace(/\.[^.]+$/, '');
    for (let k = 2; effects[name]; k++) name = `${stem(file)}#${k}`;
    const em = cocosEmitter(d);
    // texture: the file next to it first (as Cocos), then the embedded data
    const notes: string[] = [];
    let tex = 'circle';
    let png: Uint8Array | null = null;
    let source = '';
    const fileName = typeof d.textureFileName === 'string' ? d.textureFileName.trim() : '';
    const nextTo = fileName ? join(dirname(file), fileName) : '';
    let data: Uint8Array | null = null;
    try {
      data = textureData(d.textureImageData);
    } catch (e) {
      notes.push(`textureImageData: ${(e as Error).message}`);
    }
    if (nextTo && existsSync(nextTo) && statSync(nextTo).isFile()) {
      const res = texturePng(new Uint8Array(readFileSync(nextTo)), nextTo);
      if ('png' in res) {
        png = res.png;
        source = rel(nextTo);
      } else notes.push(`texture ${fileName}: ${res.error}`);
    }
    if (!png && data) {
      const res = embeddedPng(data);
      if ('png' in res) {
        png = res.png;
        source = `${rel(file)}#textureImageData`;
      } else notes.push(`textureImageData: ${res.error}`);
    }
    if (!png && !data && fileName && !(nextTo && existsSync(nextTo))) notes.push(`texture ${fileName} not found next to the file`);
    if (png) {
      const base = textureName(fileName || stem(file)) || 'texture';
      tex = base;
      for (let k = 2; textures.has(tex) && !sameBytes(textures.get(tex)!, png); k++) tex = `${base}_${k}`;
      textures.set(tex, png);
      if (!textureSources.has(tex)) textureSources.set(tex, source);
    }
    const conv = convertCocos(em, tex, scale);
    if (!png) conv.approx.push(...(notes.length ? notes : ['no texture']).map((n) => `${n} — the built-in circle`));
    else conv.exact.push(`texture ${tex} (${source})`);
    const verification = verifyCocos(em, conv.config);
    if (!verification.ok) conv.unsupported.push('the check against the Cocos model is out of tolerance');
    const cls: CocosClass = conv.unsupported.length ? 'hard' : conv.approx.length ? 'manual' : 'auto';
    const config: ParticleConfig = { key: name, cls, ...conv.config };
    effects[name] = [config];
    systems.push({
      key: name,
      file: rel(file),
      cls,
      mode: em.mode,
      texture: tex,
      blend: em.blend ? `${glName(em.blend[0])}/${glName(em.blend[1])} → ${config.blend}` : `default → ${config.blend}`,
      positionType: ['free', 'relative', 'grouped'][em.positionType] ?? String(em.positionType),
      exact: conv.exact,
      approx: conv.approx,
      unsupported: conv.unsupported,
      verification,
    });
  }
  return { root, effects, systems, textures, textureSources, warnings: [...new Set(warnings)], files: read };
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

function commonDir(dirs: string[]): string {
  let common = dirs[0] ?? '.';
  for (const d of dirs.slice(1)) while (common !== dirname(common) && d !== common && !d.startsWith(common.endsWith('/') ? common : common + '/')) common = dirname(common);
  return common;
}

// ── writing ───────────────────────────────────────────────────────────────────────────────────────

export function cocosCounts(systems: CocosSystemReport[]): Record<CocosClass | 'total', number> {
  const c = { auto: 0, manual: 0, hard: 0, total: systems.length };
  for (const s of systems) c[s.cls]++;
  return c;
}

export function writeCocosImport(r: CocosImportResult, out: string, opts: { textures?: boolean } = {}): { effects: string; report: string; textures: string[] } {
  mkdirSync(out, { recursive: true });
  const effectsFile = join(out, 'effects.json');
  writeFileSync(effectsFile, JSON.stringify(r.effects, null, 1) + '\n');
  const written: string[] = [];
  if (opts.textures !== false && r.textures.size) {
    const dir = join(out, 'textures');
    mkdirSync(dir, { recursive: true });
    for (const [name, png] of [...r.textures].sort(([a], [b]) => a.localeCompare(b))) {
      const f = join(dir, `${name}.png`);
      writeFileSync(f, png);
      written.push(f);
    }
  }
  const json = {
    source: 'cocos',
    root: r.root,
    files: r.files,
    counts: cocosCounts(r.systems),
    tolerance: TOLERANCE,
    systems: r.systems,
    textures: Object.fromEntries([...r.textureSources].map(([n, s]) => [n, { source: s, written: opts.textures !== false }])),
    warnings: r.warnings,
  };
  writeFileSync(join(out, 'report.json'), JSON.stringify(json, null, 1) + '\n');
  const report = join(out, 'report.md');
  writeFileSync(report, cocosReportMd(r));
  return { effects: effectsFile, report, textures: written };
}

const cell = (s: string) => s.replace(/\|/g, '\\|');
const sci = (v: number) => (v === 0 ? '0' : v < 1e-3 ? v.toExponential(1) : String(Math.round(v * 1e4) / 1e4));

function cocosReportMd(r: CocosImportResult): string {
  const c = cocosCounts(r.systems);
  const t = TOLERANCE;
  const lines = [
    '# trempel-fx-import --cocos — report',
    '',
    `Folder: \`${r.root}\` · ${r.files} particle files read · ${c.total} emitters: **auto ${c.auto}**, **manual ${c.manual}**, **hard ${c.hard}**.`,
    '',
    '- `auto` — played exactly; `manual` — played, something approximated (look at it); `hard` — something it uses is not played.',
    `- check — the converted config in the kit's simulation against a model of Cocos' particles, the same random values (min, middle, max of every variance), every frame at 60 fps: max differences of position (px), size (px), colour (0..1), rotation (rad) of a particle; the particle count of a whole run (allowed: two frames of emission). Tolerances: position ${t.position} px, size ${t.size} px, colour ${t.color}, rotation ${t.rotation} rad.`,
    '',
    '| emitter | file | class | mode | texture | blend | position type | check: pos / size / colour / rot / count | approximated | not played |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const s of r.systems) {
    const v = s.verification;
    const check = `${v.ok ? 'ok' : '**out**'}: ${sci(v.position)} / ${sci(v.size)} / ${sci(v.color)} / ${sci(v.rotation)} / ${v.count} (≤ ${v.countAllowed})`;
    lines.push(`| ${cell(s.key)} | ${cell(s.file)} | ${s.cls} | ${s.mode} | ${s.texture} | ${cell(s.blend)} | ${s.positionType} | ${check} | ${cell(s.approx.join('; ')) || '—'} | ${cell(s.unsupported.join('; ')) || '—'} |`);
  }
  if (r.warnings.length) {
    lines.push('', '## Warnings', '');
    for (const w of r.warnings) lines.push(`- ${cell(w)}`);
  }
  return lines.join('\n') + '\n';
}
