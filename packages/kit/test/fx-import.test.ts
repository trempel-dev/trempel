// Kit 2.1 (TRM-10): trempel-fx-import — Unity particle systems straight from YAML. A tiny Unity
// project in fixtures/unity-fx: Spark.prefab (a firework with trails + a child with a texture sheet,
// noise and a legacy material), Panel.prefab (Spark nested with overrides, a uGUI UIParticleSystem,
// a Coffee UIParticle ×80), materials of the old and the new serialization, a PNG with a tEXt chunk,
// an RLE TGA.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { parseUnityYaml, parseYaml, num, ref, isRepeated } from '../src/fx-import/yaml.js';
import { derivedId, setPath, UnityProject } from '../src/fx-import/project.js';
import { importUnity, writeImport } from '../src/fx-import/import.js';
import { compareConfigs, compareMd, close } from '../src/fx-import/compare.js';
import { decodeTga, encodePng, texturePng } from '../src/fx-import/image.js';
import { convertSystem, readMinMax, readGradient, shaderBlendByName, textureName, materialBlend } from '../src/fx-import/shuriken.js';
import { main } from '../src/cli/fx-import.js';
import { isPng, stripPng } from '../src/vite/metadata.js';

const PROJECT = join(import.meta.dirname, 'fixtures/unity-fx');
const tmp = mkdtempSync(join(tmpdir(), 'fx-import-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('fx-import: Unity YAML', () => {
  it('documents, block maps / lists at the key indent, flow maps, quoted and wrapped scalars, 64-bit ids as strings', () => {
    const docs = parseUnityYaml(`%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!1 &9007199254740993
GameObject:
  m_Component:
  - component: {fileID: 4}
  - component: {fileID: 5}
  m_Name: 'it''s a
    name'
  m_Text: "a\\nb"
  m_Long: one
    two
  m_Empty:
  m_List: []
  v: {x: 1, y: -2.5, z: 0}
--- !u!4 &7 stripped
Transform:
  m_CorrespondingSourceObject: {fileID: 3, guid: abc, type: 3}
`);
    expect(docs).toHaveLength(2);
    const go = docs[0];
    expect(go).toMatchObject({ classId: 1, fileID: '9007199254740993', stripped: false, type: 'GameObject' });
    expect(go.body.m_Component).toEqual([{ component: { fileID: '4' } }, { component: { fileID: '5' } }]);
    expect(go.body.m_Name).toBe("it's a name");
    expect(go.body.m_Text).toBe('a\nb');
    expect(go.body.m_Long).toBe('one two');
    expect(go.body.m_Empty).toBe('');
    expect(go.body.m_List).toEqual([]);
    expect(num((go.body.v as Record<string, string>).y)).toBe(-2.5);
    expect(docs[1]).toMatchObject({ stripped: true, type: 'Transform' });
    expect(ref(docs[1].body.m_CorrespondingSourceObject)).toEqual({ fileID: '3', guid: 'abc', type: '3' });
    expect(ref({ fileID: '0' })).toBe(null);
    // A repeated key (old materials) becomes a list.
    const m = parseYaml('a:\n  data: 1\n  data: 2\n  data: 3\n');
    expect((m.a as Record<string, unknown>).data).toEqual(['1', '2', '3']);
    expect(isRepeated((m.a as Record<string, never>).data)).toBe(true);
  });

  it('nested prefab ids: (instance ^ source) & 2^63−1; property paths with arrays', () => {
    expect(derivedId('5000', '102')).toBe((5000n ^ 102n).toString());
    expect(derivedId('9223372036854775807', '1')).toBe('9223372036854775806');
    const body: Record<string, unknown> = { m: { Array: [] }, list: [] };
    setPath(body as never, 'a.b', '1');
    setPath(body as never, 'list.Array.data[1].x', '2');
    setPath(body as never, 'list.Array.size', '3');
    expect(body.a).toEqual({ b: '1' });
    expect(body.list).toEqual([{}, { x: '2' }, {}]);
  });
});

describe('fx-import: Shuriken values', () => {
  it('min-max curves (the four modes, legacy constants), gradients, blends, names', () => {
    expect(readMinMax('3')).toMatchObject({ state: 0, scalar: 3 });
    expect(readMinMax(undefined)).toMatchObject({ state: 0, scalar: 0, minScalar: 0 }); // a field the file does not have
    // Legacy (no minScalar): constants = scalar × key0 of the curves; curves keep the scalar.
    const legacy = readMinMax({ minMaxState: '3', scalar: '2', maxCurve: { m_Curve: [{ time: '0', value: '0.5' }] }, minCurve: { m_Curve: [{ time: '0', value: '0.25' }] } });
    expect(legacy).toMatchObject({ scalar: 1, minScalar: 0.5, curveScalar: 2 });
    const g = readGradient({ key0: { r: '1', g: '0', b: '0', a: '0.5' }, key1: { r: '0', g: '1', b: '0', a: '1' }, ctime0: '0', ctime1: '65535', atime0: '0', atime1: '32768', m_NumColorKeys: '2', m_NumAlphaKeys: '2' });
    expect(g.color).toEqual([
      [0, 1, 0, 0],
      [1, 0, 1, 0],
    ]);
    expect(g.alpha[1][0]).toBeCloseTo(0.5, 3);
    expect(shaderBlendByName('UI/Additive')).toBe('add');
    expect(shaderBlendByName('Custom/Additive Soft')).toBe('screen');
    expect(shaderBlendByName('UI/Default')).toBe('normal');
    expect(shaderBlendByName('Hidden/Wobble')).toBe(null);
    expect(textureName('Assets/Tex/CFX_T_Star Add.png')).toBe('cfx_t_star_add');
    expect(materialBlend({ path: 'x', builtin: 200, shader: 'Particles/Additive', texture: null, colors: { _TintColor: [0.5, 0.5, 0.5, 0.25] } })).toEqual({ blend: 'add', tint: [1, 1, 1, 0.5], custom: false });
  });
});

describe('fx-import: materials', () => {
  const ctx = { unit: [100, 100] as [number, number], pos: [0, 0] as [number, number], trailMaterial: null, rendered: true, space: 'world' as const };
  const ps = { lengthInSec: '1', InitialModule: { enabled: '1', startSize: '1' } };
  it("Unity's built-in particle material: the kit's circle, approximated (not 'hard'); no material at all — hard", () => {
    const c = convertSystem(ps, { m_RenderMode: '0' }, { ...ctx, material: { path: 'builtin:10301', builtin: null, shader: 'built-in material 10301', texture: null, colors: {} } });
    expect(c.config.texture).toBe('circle');
    expect(c.cls).toBe('manual');
    expect(convertSystem(ps, null, { ...ctx, material: null }).cls).toBe('hard');
    // A project shader known by its name; an unknown one is not played.
    expect(convertSystem(ps, null, { ...ctx, material: { path: 'm.mat', builtin: null, shader: 'UI/Additive', texture: 'Assets/t.png', colors: {} } }).config.blend).toBe('add');
    expect(convertSystem(ps, null, { ...ctx, material: { path: 'm.mat', builtin: null, shader: 'Hidden/Wobble', texture: 'Assets/t.png', colors: {} } }).unsupported).toContain('shader Hidden/Wobble');
  });
});

describe('fx-import: a Unity project', () => {
  const r = importUnity({ inputs: [PROJECT] });
  const sys = (key: string) => r.systems.find((s) => s.key === key)!;
  const cfg = (effect: string, i = 0) => r.effects[effect][i];

  it('effects: a particle system with none above it + the systems under it, parent first; keys are GameObject paths', () => {
    expect(Object.keys(r.effects).sort()).toEqual(['Panel/Coffee/CoffeePs', 'Panel/SparkX', 'Panel/UiSparkle', 'Spark']);
    expect(r.effects.Spark.map((c) => c.key)).toEqual(['Spark', 'Spark/Glow']);
    expect(r.assets).toBe(2);
    expect(r.project).toBe(PROJECT);
  });

  it('a world system: units = ppu × the scale chain; main, emission, shape, over-lifetime; y down; trails with their material', () => {
    const c = cfg('Spark');
    expect(c.unit).toEqual([50, 50]);
    expect(c.lifetime).toEqual([0.3, 0.6]);
    expect(c.speed).toBe(20);
    expect(c.color).toEqual([
      [1, 0.85, 0, 0.5],
      [1, 0.9, 0.4, 0.8],
    ]);
    expect(c.gravity).toBeCloseTo(19.62, 6);
    expect(c.flipRotation).toBe(0.5);
    expect(c.bursts).toEqual([{ time: 0, count: 70, cycles: 1, interval: 0.01, prob: 1 }]);
    expect(c.shape).toMatchObject({ type: 'sphere', radius: 0.01, thickness: 0 });
    expect(c.sizeOverLifetime).toEqual([
      [0, 1],
      [1, 0],
    ]);
    expect(c.colorOverLifetime!.alpha).toEqual([
      [0, 1],
      [1, 0],
    ]);
    expect(c.spin).toEqual([3.49, 6.98]);
    expect(c.limitVelocity).toEqual({ limit: 0.5, dampen: 0.2 });
    expect(c.texture).toBe('spark');
    expect(c.blend).toBe('add');
    expect(c.tint).toEqual([1, 1, 1, 0.5]); // legacy: _TintColor × 2
    expect(c.trails).toMatchObject({ ratio: 1, lifetime: 1, minVertexDistance: 0.2, width: 1, blend: 'add' });
    expect(sys('Spark').cls).toBe('manual'); // dampen, trails as strokes
    expect(sys('Spark').approx.join(' ')).toMatch(/trails: strokes/);
    expect(sys('Spark').exact.join(' ')).toMatch(/sub-emitters: the slot is empty/);
  });

  it('a child: pos in the root space (y down), a texture sheet, a stretched billboard, a legacy material, noise → hard', () => {
    const c = cfg('Spark', 1);
    expect(c.pos).toEqual([1, -2]);
    expect(c.unit).toEqual([50, 50]); // the chain includes the root's 0.5
    expect(c.shape.type).toBe('circle');
    expect(c.loop).toBe(true);
    expect(c.sheet).toMatchObject({ tilesX: 2, tilesY: 2, mul: 0.9999 });
    expect(c.render).toEqual({ mode: 'stretch', lengthScale: 5, velocityScale: 0 });
    expect(c.texture).toBe('smoke');
    expect(c.blend).toBe('screen');
    expect(c.tint).toEqual([1, 1, 1, 1]);
    const s = sys('Spark/Glow');
    expect(s.cls).toBe('hard');
    expect(s.unsupported).toContain('noise');
    expect(s.approx.join(' ')).toMatch(/rotated 45°/);
  });

  it('a nested prefab: overrides applied (size, a burst count, a material, a name, active), unused overrides counted', () => {
    const c = cfg('Panel/SparkX');
    expect(c.size).toBe(2);
    expect(c.bursts[0].count).toBe(12);
    expect(c.texture).toBe('smoke'); // m_Materials.Array.data[0] → Legacy.mat
    expect(c.unit).toEqual([100 * 0.5 * 2, 100 * 0.5 * 2]); // Panel ×2 × Spark ×0.5
    expect(sys('Panel/SparkX').active).toBe(true);
    expect(sys('Panel/SparkX/Glow').active).toBe(false);
    expect(r.warnings.join('\n')).toMatch(/1 unused override\(s\) of Assets\/Fx\/Spark\.prefab/);
  });

  it('uGUI UIParticleSystem: the chain scale, its graphic material; Coffee UIParticle: m_Scale3D', () => {
    expect(sys('Panel/UiSparkle')).toMatchObject({ space: 'ugui', unit: [100, 100] });
    expect(cfg('Panel/UiSparkle').texture).toBe('spark');
    expect(sys('Panel/Coffee/CoffeePs')).toMatchObject({ space: 'coffee', unit: [80, 80] });
  });

  it('writes effects.json, PNG textures without metadata (TGA decoded), report.md / report.json', () => {
    const out = join(tmp, 'out');
    const w = writeImport(r, out);
    const effects = JSON.parse(readFileSync(w.effects, 'utf8'));
    expect(Object.keys(effects)).toHaveLength(4);
    const spark = new Uint8Array(readFileSync(join(out, 'textures/spark.png')));
    expect(isPng(spark)).toBe(true);
    expect(stripPng(spark).removed).toEqual([]); // the tEXt chunk is gone
    const smoke = new Uint8Array(readFileSync(join(out, 'textures/smoke.png')));
    expect(isPng(smoke)).toBe(true);
    const report = readFileSync(w.report, 'utf8');
    expect(report).toMatch(/6 particle systems: \*\*auto 0\*\*, \*\*manual 4\*\*, \*\*hard 2\*\*/);
    expect(report).toMatch(/\| Spark\/Glow \| Assets\/Fx\/Spark\.prefab \| hard \|/);
    const json = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
    expect(json.counts.total).toBe(r.systems.length);
    // --no-textures
    expect(writeImport(r, join(tmp, 'bare'), { textures: false }).textures).toEqual([]);
  });

  it('only: effects by a prefix; inputs: one prefab', () => {
    expect(Object.keys(importUnity({ inputs: [join(PROJECT, 'Assets/UI/Panel.prefab')], only: ['Panel/Ui'] }).effects)).toEqual(['Panel/UiSparkle']);
    expect(() => importUnity({ inputs: [] })).toThrow(/E_FX_IMPORT_INPUT/);
    expect(() => importUnity({ inputs: [tmp] })).toThrow(/not inside a Unity project/);
    expect(() => importUnity({ inputs: [join(PROJECT, 'Assets/Mat/Spark.mat')] })).toThrow(/not a \.prefab/);
    expect(UnityProject.rootOf(join(PROJECT, 'Assets/Fx'))).toBe(PROJECT);
  });
});

describe('fx-import: compare, images, the CLI', () => {
  it('compare: by key — same / different (both values) / missing; an effect root\'s pos is not compared', () => {
    const r = importUnity({ inputs: [PROJECT] });
    const old = r.effects.Spark.map((c) => ({ ...c }));
    old[0] = { ...old[0], pos: [9, 9] };
    old[1] = { ...old[1], speed: 99 };
    const rows = compareConfigs([...old, { ...old[0], key: 'Nope' }], r.effects);
    expect(rows.map((x) => x.status)).toEqual(['same', 'different', 'missing']);
    expect(rows[1].diffs).toEqual([{ field: 'speed', old: 99, now: 20 }]);
    expect(compareMd(rows, 'systems.json')).toMatch(/1 same\*\*, \*\*1 different\*\*, \*\*1 missing/);
    expect(compareConfigs({ e: old }, r.effects)[0].status).toBe('same');
    expect(close(1, 1.0000001)).toBe(true);
    expect(close(null, undefined)).toBe(true);
    expect(close([1], [1, 2])).toBe(false);
  });

  it('images: an RLE TGA bottom-up → top-down RGBA; PNG round trip; other formats refused', () => {
    const tga = new Uint8Array(readFileSync(join(PROJECT, 'Assets/Tex/smoke.tga')));
    const img = decodeTga(tga);
    expect(img.width).toBe(2);
    // Bottom row of the file (red, red) is the last row of the picture.
    expect([...img.rgba.subarray(8, 12)]).toEqual([255, 0, 0, 255]);
    expect([...img.rgba.subarray(0, 4)]).toEqual([0, 0, 255, 255]);
    expect([...img.rgba.subarray(4, 8)]).toEqual([0, 255, 0, 128]);
    expect(isPng(encodePng(2, 2, img.rgba))).toBe(true);
    expect(texturePng(new Uint8Array([1, 2, 3]), 'x.psd')).toEqual({ error: 'PSD textures are not converted (PNG and TGA are)' });
    expect('error' in texturePng(new Uint8Array(18), 'bad.tga')).toBe(true);
  });

  it('the bin: --out required, usage errors exit 2; a run writes and compares', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(main([PROJECT])).toBe(2);
    expect(main(['--bogus'])).toBe(2);
    expect(main([PROJECT, '--out', tmp, '--ppu', '-1'])).toBe(2);
    expect(main(['--help'])).toBe(0);
    expect(main([join(tmp, 'nothing'), '--out', tmp])).toBe(2);
    const old = join(tmp, 'old.json');
    writeFileSync(old, JSON.stringify(importUnity({ inputs: [PROJECT] }).effects));
    expect(main([PROJECT, '--out', join(tmp, 'cli'), '--compare', old, '--ppu', '100'])).toBe(0);
    expect(readFileSync(join(tmp, 'cli/compare.md'), 'utf8')).toMatch(/0 different/);
    expect(log.mock.calls.flat().join('\n')).toMatch(/trempel-fx-import: 4 effects/);
    err.mockRestore();
    log.mockRestore();
  });
});
