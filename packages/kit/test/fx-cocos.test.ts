// Kit 2.2: trempel-fx-import --cocos — Cocos particles (Particle Designer / Particle2dx .plist, the
// .json variant) → the kit's effects, and the check against a model of Cocos' particles. Fixtures are
// synthetic only: the plists, the JSON and the textures are built here.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync, gzipSync } from 'node:zlib';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { parsePlist, unescapeXml, type PlistDict, type PlistValue } from '../src/fx-import/plist.js';
import { cocosBlend, cocosEmitter, convertCocos, embeddedPng, importCocos, mm, readCocosFile, textureData, writeCocosImport } from '../src/fx-import/cocos.js';
import { CocosModel, PROBES, TOLERANCE, verifyCocos } from '../src/fx-import/cocos-model.js';
import { encodePng } from '../src/fx-import/image.js';
import { ParticleSim } from '../src/fx/sim.js';
import { seededRandom } from '../src/qa/random.js';
import { isPng, stripPng } from '../src/vite/metadata.js';
import { main } from '../src/cli/fx-import.js';

const tmp = mkdtempSync(join(tmpdir(), 'fx-cocos-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return /^([EW]_[A-Z0-9_]+):/.exec((e as Error).message)?.[1] ?? 'none';
  }
  return 'no error';
};

// ── synthetic files ─────────────────────────────────────────────────────────────────────────────

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function plistValue(v: PlistValue, ind = ''): string {
  if (typeof v === 'boolean') return `${ind}<${v}/>`;
  if (typeof v === 'number') return Number.isInteger(v) ? `${ind}<integer>${v}</integer>` : `${ind}<real>${v}</real>`;
  if (typeof v === 'string') return `${ind}<string>${esc(v)}</string>`;
  if (v instanceof Uint8Array) return `${ind}<data>\n${Buffer.from(v).toString('base64').replace(/(.{60})/g, '$1\n')}\n${ind}</data>`;
  if (Array.isArray(v)) return `${ind}<array>\n${v.map((x) => plistValue(x, ind + '\t')).join('\n')}\n${ind}</array>`;
  return `${ind}<dict>\n${Object.entries(v)
    .map(([k, x]) => `${ind}\t<key>${esc(k)}</key>\n${plistValue(x, ind + '\t')}`)
    .join('\n')}\n${ind}</dict>`;
}
const plist = (d: PlistDict) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n${plistValue(d)}\n</plist>\n`;

/** A 2×2 PNG with a tEXt chunk (metadata the output must not keep). */
function pngWithText(): Uint8Array {
  const png = encodePng(2, 2, new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 128]));
  const body = Buffer.concat([Buffer.from('tEXt'), Buffer.from('prompt\0secret words')]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length - 4);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return new Uint8Array(Buffer.concat([png.subarray(0, 33), len, body, crc, png.subarray(33)]));
}

/** A gravity-mode emitter with every motion parameter (Particle Designer keys). */
const GRAVITY: PlistDict = {
  emitterType: 0, maxParticles: 37, particleLifespan: 1.23, particleLifespanVariance: 0.31, duration: -1,
  angle: 70, angleVariance: 25, speed: 140, speedVariance: 35, gravityx: 20, gravityy: -90,
  radialAcceleration: -30, radialAccelVariance: 12, tangentialAcceleration: 45, tangentialAccelVariance: 9,
  startParticleSize: 32, startParticleSizeVariance: 6, finishParticleSize: 8, FinishParticleSizeVariance: 3,
  startColorRed: 1, startColorGreen: 0.6, startColorBlue: 0.2, startColorAlpha: 0.9,
  startColorVarianceRed: 0, startColorVarianceGreen: 0.2, startColorVarianceBlue: 0.1, startColorVarianceAlpha: 0.1,
  finishColorRed: 0.4, finishColorGreen: 0.1, finishColorBlue: 0, finishColorAlpha: 0,
  finishColorVarianceRed: 0.1, finishColorVarianceGreen: 0, finishColorVarianceBlue: 0, finishColorVarianceAlpha: 0,
  rotationStart: 10, rotationStartVariance: 20, rotationEnd: 200, rotationEndVariance: 40,
  sourcePositionx: 160, sourcePositiony: 240, sourcePositionVariancex: 14, sourcePositionVariancey: 6,
  blendFuncSource: 770, blendFuncDestination: 1, positionType: 2,
};

/** A radius-mode emitter. */
const RADIUS: PlistDict = {
  emitterType: 1, maxParticles: 23, particleLifespan: 2.07, particleLifespanVariance: 0.4, duration: 1.37,
  angle: 30, angleVariance: 40, maxRadius: 90, maxRadiusVariance: 15, minRadius: 12, minRadiusVariance: 4,
  rotatePerSecond: 120, rotatePerSecondVariance: 30, speed: 999, gravityy: -500,
  startParticleSize: 20, startParticleSizeVariance: 0, finishParticleSize: -1, finishParticleSizeVariance: 0,
  startColorRed: 0.2, startColorGreen: 0.4, startColorBlue: 1, startColorAlpha: 1,
  finishColorRed: 0.2, finishColorGreen: 0.4, finishColorBlue: 1, finishColorAlpha: 1,
  rotationStart: 0, rotationEnd: 0, sourcePositionVariancex: 50, sourcePositionVariancey: 50,
  blendFuncSource: 770, blendFuncDestination: 771, positionType: 0,
};

const gz64 = (b: Uint8Array) => Buffer.from(gzipSync(b)).toString('base64');

describe('cocos: the plist reader', () => {
  it('dict / array / key / string / real / integer / true / false / data / date; entities, comments, a doctype', () => {
    const v = parsePlist(`<?xml version="1.0"?><!-- c --><!DOCTYPE plist SYSTEM "x"><plist version="1.0"><dict>
      <key>s</key><string>a &amp; b &lt;c&gt; &#65;&#x42; &bogus;</string><key>r</key><real>-1.5e2</real><key>i</key><integer>7</integer>
      <key>t</key><true/><key>f</key><false></false><key>d</key><data>AQID</data><key>when</key><date>2026-10-09T00:00:00Z</date>
      <key>a</key><array><string/><dict/><array/><real>inf</real><real>nan</real></array><key>e</key><string><![CDATA[<x>]]></string>
    </dict></plist>`) as PlistDict;
    expect(v.s).toBe('a & b <c> AB &bogus;');
    expect(v.r).toBe(-150);
    expect(v.i).toBe(7);
    expect([v.t, v.f]).toEqual([true, false]);
    expect([...(v.d as Uint8Array)]).toEqual([1, 2, 3]);
    expect(v.when).toBe('2026-10-09T00:00:00Z');
    const a = v.a as PlistValue[];
    expect(a.slice(0, 3)).toEqual(['', {}, []]);
    expect(a[3]).toBe(Infinity);
    expect(Number.isNaN(a[4])).toBe(true);
    expect(v.e).toBe('<x>');
    expect(parsePlist('<array><integer>1</integer></array>')).toEqual([1]);
    expect(unescapeXml('&#xZZ;')).toBe('&#xZZ;');
  });

  it('a malformed plist: E_FX_IMPORT_COCOS', () => {
    for (const bad of [
      '<plist><dict><key>a</key></dict></plist>', // no value
      '<plist><dict><string>x</string></dict></plist>', // no key
      '<plist><dict><key>a</key><real>x</real></dict></plist>',
      '<plist><dict><key>a</key><foo/></dict></plist>',
      '<plist><dict><key>a</key><string>x</dict></plist>',
      '<plist><dict><key>a</key><data>!!</data></dict></plist>',
      '<plist><dict></dict></plist><extra/>',
      '<plist><dict></dict>',
      '<plist/>',
      '<plist><true>x</true></plist>',
      '<!-- open',
      'text',
      '<dict/>junk',
      '<plist><dict><key>a</key><string>a<b/></string></dict></plist>',
      '</dict>',
      '<?xml',
      '<!DOCTYPE x',
      '<plist',
      '<>',
    ])
      expect(code(() => parsePlist(bad, 'bad.plist')), bad).toBe('E_FX_IMPORT_COCOS');
  });
});

describe('cocos: conversion', () => {
  it('gravity mode: y up → y down, CCW degrees → radians, ± var → ranges, Cocos fields → the 2.2 config', () => {
    const e = cocosEmitter(GRAVITY);
    const { config: c, cls, exact } = convertCocos(e, 'spark', 2);
    expect(c.unit).toEqual([2, 2]);
    expect(c.loop).toBe(true); // duration −1
    expect(c.rate).toBeCloseTo(37 / 1.23, 6); // totalParticles / particleLifespan
    expect(c.max).toBe(37);
    expect(c.whenFull).toBe('wait');
    expect(c.lifetime).toEqual([0.92, 1.54]);
    expect(c.speed).toEqual([105, 175]);
    const [a0, a1] = c.angle as [number, number];
    expect(a0).toBeCloseTo((-45 * Math.PI) / 180, 9);
    expect(a1).toBeCloseTo((-95 * Math.PI) / 180, 9);
    expect(c.gravityX).toBe(20);
    expect(c.gravity).toBe(90);
    expect(c.radialAccel).toEqual([-42, -18]);
    expect(c.tangentialAccel).toEqual([36, 54]);
    expect(c.size).toEqual([26, 38]);
    expect(c.endSize).toEqual([5, 11]); // FinishParticleSizeVariance (the capital spelling)
    expect(c.colorPerChannel).toBe(true);
    expect(c.color).toEqual([
      [1, 0.4, 0.1, 0.8],
      [1, 0.8, 0.3, 1],
    ]);
    expect(c.endColor).toEqual([
      [0.3, 0.1, 0, 0],
      [0.5, 0.1, 0, 0],
    ]);
    expect(c.shape).toMatchObject({ type: 'box', box: [14, 6] });
    expect(c.blend).toBe('add');
    expect(cls).toBe('auto'); // grouped, an exact blend
    expect(exact.join(' ')).toMatch(/designer's canvas/);
  });

  it('radius mode: the orbit (θ = π − angle, clockwise speed), end radius, −1 end size, no gravity / speed', () => {
    const { config: c, approx } = convertCocos(cocosEmitter(RADIUS), 'circle');
    expect(c.loop).toBe(false);
    expect(c.duration).toBe(1.37);
    expect(c.speed).toBe(0);
    expect(c.gravity).toBe(0);
    expect(c.orbit).toEqual({ radius: [75, 105], endRadius: [8, 16], speed: [-(90 * Math.PI) / 180, -(150 * Math.PI) / 180].map((v) => Math.round(v * 1e9) / 1e9) });
    expect((c.angle as number[])[0]).toBeCloseTo(Math.PI + (10 * Math.PI) / 180, 9);
    expect(c.endSize).toBeUndefined();
    expect(c.endColor).toBeUndefined();
    expect(c.shape.type).toBe('point');
    expect(approx.join(' ')).toMatch(/positionType free/);
    // −1 end radius → the start one
    expect(convertCocos(cocosEmitter({ ...RADIUS, minRadius: -1 }), 'x').config.orbit!.endRadius).toBeUndefined();
  });

  it('blend pairs: ONE/ONE, SRC_ALPHA/ONE → add; SRC_ALPHA/1−SRC_ALPHA, ONE/1−SRC_ALPHA → normal; others nearest (manual)', () => {
    expect(cocosBlend(1, 1)).toEqual({ blend: 'add', exact: true });
    expect(cocosBlend(770, 1)).toEqual({ blend: 'add', exact: true });
    expect(cocosBlend(770, 771)).toEqual({ blend: 'normal', exact: true });
    expect(cocosBlend(1, 771)).toEqual({ blend: 'normal', exact: true });
    expect(cocosBlend(1, 769)).toEqual({ blend: 'screen', exact: false });
    expect(cocosBlend(774, 1)).toEqual({ blend: 'add', exact: false });
    expect(cocosBlend(774, 771)).toEqual({ blend: 'normal', exact: false });
    const m = convertCocos(cocosEmitter({ ...GRAVITY, blendFuncSource: 774, blendFuncDestination: 0 }), 't');
    expect(m.cls).toBe('manual');
    expect(m.approx.join(' ')).toMatch(/blend DST_COLOR\/ZERO → normal \(nearest\)/);
    expect(convertCocos(cocosEmitter({ ...GRAVITY, blendFuncSource: undefined as never, blendFuncDestination: undefined as never }), 't').config.blend).toBe('normal');
  });

  it('positionType, duration 0, yCoordFlipped, rotationIsDir, negative start sizes, explicit emissionRate', () => {
    expect(convertCocos(cocosEmitter({ ...GRAVITY, positionType: 1 }), 't').approx.join(' ')).toMatch(/positionType relative/);
    const z = convertCocos(cocosEmitter({ ...GRAVITY, duration: 0 }), 't');
    expect(z.config).toMatchObject({ loop: false, duration: 1 / 30 });
    expect(z.approx.join(' ')).toMatch(/duration 0/);
    expect(convertCocos(cocosEmitter({ ...GRAVITY, yCoordFlipped: -1 }), 't').cls).toBe('hard');
    expect(convertCocos(cocosEmitter({ ...GRAVITY, rotationIsDir: true }), 't').approx.join(' ')).toMatch(/rotationIsDir/);
    expect(convertCocos(cocosEmitter({ ...RADIUS, startParticleSizeVariance: 30 }), 't').approx.join(' ')).toMatch(/below 0/);
    expect(cocosEmitter({ ...GRAVITY, emissionRate: 12 }).emissionRate).toBe(12);
    expect(cocosEmitter({ ...GRAVITY, particleLifespan: 0 }).emissionRate).toBe(0);
    expect(convertCocos(cocosEmitter({ ...GRAVITY, maxParticles: 0 }), 't').approx.join(' ')).toMatch(/emits nothing/);
    // strings as numbers (some exporters), booleans
    expect(cocosEmitter({ maxParticles: '12' as never, rotationIsDir: true }).maxParticles).toBe(12);
    expect(mm(1, 0)).toBe(1);
    expect(mm(1, 2, -1, 10)).toEqual([11, 7]);
  });
});

describe('cocos: the check against the model of Cocos particles', () => {
  it('gravity mode: the same random values → the same particle at every frame (tolerances), counts within two frames', () => {
    const e = cocosEmitter(GRAVITY);
    const v = verifyCocos(e, convertCocos(e, 't', 2).config);
    expect(v.ok).toBe(true);
    expect(v.position).toBeLessThanOrEqual(TOLERANCE.position);
    expect(v.size).toBeLessThanOrEqual(TOLERANCE.size);
    expect(v.color).toBeLessThanOrEqual(TOLERANCE.color);
    expect(v.rotation).toBeLessThanOrEqual(TOLERANCE.rotation);
    expect(v.count).toBeLessThanOrEqual(v.countAllowed);
    expect(v.samples).toBeGreaterThan(PROBES.length * 50);
    // In fact far below the tolerance: the same integration.
    expect(v.position).toBeLessThan(1e-6);
  });

  it('radius mode: the orbit matches', () => {
    const e = cocosEmitter(RADIUS);
    const v = verifyCocos(e, convertCocos(e, 't', 1.5).config);
    expect(v.ok).toBe(true);
    expect(v.position).toBeLessThan(1e-6);
    expect(v.count).toBeLessThanOrEqual(v.countAllowed);
  });

  it('a wrong conversion is caught (y not flipped, the angle not negated, tangential sign)', () => {
    const e = cocosEmitter(GRAVITY);
    const c = convertCocos(e, 't').config;
    expect(verifyCocos(e, { ...c, gravity: -c.gravity }).ok).toBe(false);
    expect(verifyCocos(e, { ...c, angle: (c.angle as number[]).map((x) => -x) as [number, number] }).ok).toBe(false);
    expect(verifyCocos(e, { ...c, tangentialAccel: (c.tangentialAccel as number[]).map((x) => -x) as [number, number] }).ok).toBe(false);
    expect(verifyCocos(e, { ...c, whenFull: 'skip' }).count).toBeGreaterThan(0);
    const r = cocosEmitter(RADIUS);
    const rc = convertCocos(r, 't').config;
    expect(verifyCocos(r, { ...rc, orbit: { ...rc.orbit!, speed: 2 } }).ok).toBe(false);
  });

  it('variance with a real seeded rng: every particle of the kit inside the Cocos ranges', () => {
    const e = cocosEmitter(GRAVITY);
    const c = convertCocos(e, 't').config;
    const sim = new ParticleSim(c, seededRandom(5));
    sim.play();
    for (let i = 0; i < 90; i++) sim.update(1 / 60);
    expect(sim.count).toBeGreaterThan(20);
    for (const p of sim.particles) {
      expect(p.life).toBeGreaterThanOrEqual(e.life - e.lifeVar);
      expect(p.life).toBeLessThanOrEqual(e.life + e.lifeVar);
      expect(p.size).toBeGreaterThanOrEqual(26);
      expect(p.size).toBeLessThanOrEqual(38);
      expect(p.endSize!).toBeGreaterThanOrEqual(5);
      expect(p.endSize!).toBeLessThanOrEqual(11);
      expect(p.color[1]).toBeGreaterThanOrEqual(0.4);
      expect(p.color[1]).toBeLessThanOrEqual(0.8);
      expect(p.color[3]).toBeLessThanOrEqual(1); // 0.9 + 0.1: clamped
    }
    // The model on the same seed draws inside the same ranges too.
    const m = new CocosModel(e, () => seededRandom(9)() * 2 - 1);
    for (let i = 0; i < 90; i++) m.update(1 / 60);
    expect(m.particles.length).toBeGreaterThan(20);
    for (const q of m.particles) expect(q.size).toBeGreaterThanOrEqual(0);
  });
});

describe('cocos: files, textures, the report', () => {
  const dir = join(tmp, 'in');
  mkdirSync(join(dir, 'sub'), { recursive: true });
  const png = pngWithText();
  // embedded gzip + base64 PNG
  writeFileSync(join(dir, 'fire.plist'), plist({ ...GRAVITY, textureFileName: 'fire.png', textureImageData: gz64(png) }));
  // textureFileName next to the file
  writeFileSync(join(dir, 'sub/spark.png'), png);
  writeFileSync(join(dir, 'sub/ring.plist'), plist({ ...RADIUS, textureFileName: 'spark.png' }));
  // the JSON variant (Particle2dx), embedded raw (not compressed) PNG
  writeFileSync(join(dir, 'smoke.json'), JSON.stringify({ ...GRAVITY, duration: 2.5, textureFileName: 'smoke.png', textureImageData: Buffer.from(png).toString('base64') }));
  // a TIFF payload → the circle, manual
  const tiff = new Uint8Array([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0]);
  writeFileSync(join(dir, 'tiff.plist'), plist({ ...GRAVITY, textureFileName: 'tiff.tiff', textureImageData: gz64(tiff) }));
  // not particles: skipped (a warning for a plist), a JSON silently
  writeFileSync(join(dir, 'atlas.plist'), plist({ frames: {}, metadata: { format: 2 } }));
  writeFileSync(join(dir, 'package.json'), '{"name":"x"}');

  it('a folder: every particle file, textures (file next to it first, then the embedded data), names, classes', () => {
    const r = importCocos({ inputs: [dir], scale: 2 });
    expect(Object.keys(r.effects).sort()).toEqual(['fire', 'ring', 'smoke', 'tiff']);
    expect(r.files).toBe(4);
    expect(r.root).toBe(dir);
    const sys = (k: string) => r.systems.find((s) => s.key === k)!;
    expect(sys('fire')).toMatchObject({ cls: 'auto', mode: 'gravity', texture: 'fire', file: 'fire.plist', positionType: 'grouped' });
    expect(sys('ring')).toMatchObject({ mode: 'radius', texture: 'spark', file: join('sub', 'ring.plist'), cls: 'manual' });
    expect(sys('smoke').texture).toBe('smoke');
    expect(r.effects.smoke[0]).toMatchObject({ loop: false, duration: 2.5, key: 'smoke', cls: 'auto' });
    expect(sys('tiff')).toMatchObject({ cls: 'manual', texture: 'circle' });
    expect(sys('tiff').approx.join(' ')).toMatch(/TIFF .* the built-in circle/);
    expect(r.effects.fire[0].unit).toEqual([2, 2]);
    expect(r.warnings.join('\n')).toMatch(/W_FX_IMPORT_COCOS: atlas\.plist: not a particle emitter/);
    for (const s of r.systems) expect(s.verification.ok).toBe(true);
    // One PNG, three names; no metadata.
    for (const n of ['fire', 'spark', 'smoke']) {
      const b = r.textures.get(n)!;
      expect(isPng(b)).toBe(true);
      expect(stripPng(b).removed).toEqual([]);
    }
    expect(r.textureSources.get('fire')).toBe('fire.plist#textureImageData');
    expect(r.textureSources.get('spark')).toBe(join('sub', 'spark.png'));
  });

  it('writes effects.json (createGame-ready), textures/*.png without metadata, report.md / report.json with the check', () => {
    const r = importCocos({ inputs: [dir] });
    const out = join(tmp, 'out');
    const w = writeCocosImport(r, out);
    const effects = JSON.parse(readFileSync(w.effects, 'utf8'));
    expect(Object.keys(effects).sort()).toEqual(['fire', 'ring', 'smoke', 'tiff']);
    expect(effects.ring[0].orbit).toBeDefined();
    expect(w.textures.map((f) => f.split('/').pop()).sort()).toEqual(['fire.png', 'smoke.png', 'spark.png']);
    const t = new Uint8Array(readFileSync(join(out, 'textures/fire.png')));
    expect(Buffer.from(t).includes('secret')).toBe(false);
    const md = readFileSync(w.report, 'utf8');
    expect(md).toMatch(/4 emitters: \*\*auto 2\*\*, \*\*manual 2\*\*, \*\*hard 0\*\*/);
    expect(md).toMatch(/Tolerances: position 0\.01 px/);
    expect(md).toMatch(/\| fire \| fire\.plist \| auto \| gravity \| fire \| SRC_ALPHA\/ONE → add \| grouped \| ok: /);
    const json = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
    expect(json.counts).toEqual({ auto: 2, manual: 2, hard: 0, total: 4 });
    expect(json.tolerance).toEqual(TOLERANCE);
    expect(json.systems[0].verification.ok).toBe(true);
    expect(writeCocosImport(r, join(tmp, 'bare'), { textures: false }).textures).toEqual([]);
  });

  it('a file: explicit inputs, --only, name clashes, missing textures, errors with codes', () => {
    const one = importCocos({ inputs: [join(dir, 'sub/ring.plist'), join(dir, 'fire.plist')], only: ['ri'] });
    expect(Object.keys(one.effects)).toEqual(['ring']);
    expect(one.root).toBe(dir);
    // the same stem twice → the second by its path
    mkdirSync(join(tmp, 'twice/a'), { recursive: true });
    writeFileSync(join(tmp, 'twice/fire.plist'), plist({ ...GRAVITY, textureFileName: 'gone.png' }));
    writeFileSync(join(tmp, 'twice/a/fire.plist'), plist(RADIUS));
    const two = importCocos({ inputs: [join(tmp, 'twice')] });
    expect(Object.keys(two.effects).sort()).toEqual(['a/fire', 'fire']);
    expect(two.systems.find((s) => s.key === 'fire')!.approx.join(' ')).toMatch(/texture gone\.png not found next to the file — the built-in circle/);
    expect(two.systems.find((s) => s.key === 'a/fire')!.approx.join(' ')).toMatch(/no texture — the built-in circle/);
    expect(Object.keys(importCocos({ inputs: [join(tmp, 'twice/fire.plist'), join(tmp, 'twice/fire.plist')] }).effects)).toEqual(['fire', 'fire#2']);
    // errors
    expect(code(() => importCocos({ inputs: [] }))).toBe('E_FX_IMPORT_INPUT');
    expect(code(() => importCocos({ inputs: [join(tmp, 'nope.plist')] }))).toBe('E_FX_IMPORT_INPUT');
    expect(code(() => importCocos({ inputs: [join(dir, 'sub/spark.png')] }))).toBe('E_FX_IMPORT_INPUT');
    expect(code(() => importCocos({ inputs: [dir], scale: 0 }))).toBe('E_FX_IMPORT_INPUT');
    writeFileSync(join(tmp, 'broken.plist'), '<plist><dict><key>maxParticles</key><real>oops</real></dict></plist>');
    expect(code(() => importCocos({ inputs: [join(tmp, 'broken.plist')] }))).toBe('E_FX_IMPORT_COCOS');
    writeFileSync(join(tmp, 'broken.json'), '{ "maxParticles": ');
    expect(code(() => importCocos({ inputs: [join(tmp, 'broken.json')] }))).toBe('E_FX_IMPORT_COCOS');
    expect(code(() => importCocos({ inputs: [join(dir, 'atlas.plist')] }))).toBe('E_FX_IMPORT_COCOS');
    // a malformed file in a folder: a warning, the rest is imported
    mkdirSync(join(tmp, 'mixed'), { recursive: true });
    writeFileSync(join(tmp, 'mixed/broken.plist'), '<plist><dict>');
    writeFileSync(join(tmp, 'mixed/ok.plist'), plist(GRAVITY));
    const mixed = importCocos({ inputs: [join(tmp, 'mixed')] });
    expect(Object.keys(mixed.effects)).toEqual(['ok']);
    expect(mixed.warnings.join('\n')).toMatch(/^E_FX_IMPORT_COCOS: broken\.plist/);
    expect(readCocosFile(join(dir, 'package.json'))).toBe(null);
  });

  it('texture data: gzip, zlib, raw, <data> bytes; TIFF and other payloads refused', () => {
    const png = pngWithText();
    expect(textureData(gz64(png))).toEqual(png);
    expect(textureData(Buffer.from(deflateSync(png)).toString('base64'))).toEqual(png);
    expect(textureData(png)).toEqual(png);
    expect(textureData('')).toBe(null);
    expect(textureData(undefined)).toBe(null);
    expect(textureData(new Uint8Array([0x78, 0x9c, 1, 2]))).toEqual(new Uint8Array([0x78, 0x9c, 1, 2])); // not zlib after all
    expect(embeddedPng(new Uint8Array([0x4d, 0x4d, 0, 0x2a]))).toEqual({ error: 'TIFF texture data is not read (PNG is)' });
    expect(embeddedPng(new Uint8Array([1, 2, 3]))).toEqual({ error: 'texture data is not a PNG' });
    expect('png' in embeddedPng(png)).toBe(true);
  });

  it('the bin: --cocos writes; --ppu / --scale misuse, a bad scale, a malformed file exit 2', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = join(tmp, 'cli');
    expect(main(['--cocos', dir, '--out', out, '--scale', '2'])).toBe(0);
    expect(log.mock.calls.flat().join('\n')).toMatch(/trempel-fx-import --cocos: 4 emitters \(auto 2, manual 2, hard 0\), 3 textures/);
    expect(warn.mock.calls.flat().join('\n')).toMatch(/W_FX_IMPORT: 1 warning/);
    expect(JSON.parse(readFileSync(join(out, 'effects.json'), 'utf8')).fire[0].unit).toEqual([2, 2]);
    // --compare against itself
    expect(main(['--cocos', dir, '--out', join(tmp, 'cli2'), '--compare', join(out, 'effects.json'), '--scale', '2'])).toBe(0);
    expect(readFileSync(join(tmp, 'cli2/compare.md'), 'utf8')).toMatch(/0 different/);
    expect(main(['--cocos', dir, '--out', out, '--ppu', '100'])).toBe(2);
    expect(main([dir, '--out', out, '--scale', '2'])).toBe(2);
    expect(main(['--cocos', dir, '--out', out, '--scale', '-1'])).toBe(2);
    expect(main(['--cocos', join(tmp, 'broken.plist'), '--out', out])).toBe(2);
    expect(err.mock.calls.flat().join('\n')).toMatch(/E_FX_IMPORT_COCOS: broken\.plist/);
    expect(err.mock.calls.flat().join('\n')).toMatch(/E_FX_IMPORT_USAGE: --ppu is for Unity/);
    expect(main(['--help'])).toBe(0);
    expect(log.mock.calls.flat().join('\n')).toMatch(/--cocos <X\.plist/);
    err.mockRestore();
    log.mockRestore();
    warn.mockRestore();
  });
});
