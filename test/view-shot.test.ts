// Headless snapshot (view/shot.mjs): the real page in Chromium via Playwright — PNG on disk, JSON
// with the scene's errors on stdout, exit code ≠ 0 when the scene has errors.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
let tmp = '';

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'tml-shot-'));
});
afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

interface ShotJson {
  scene: string;
  width: number;
  height: number;
  errors: { kind: string; message: string }[];
  warnings: { kind: string; message: string }[];
}

function shot(...args: string[]): { code: number | null; json: ShotJson } {
  const r = spawnSync(process.execPath, [join(root, 'view/shot.mjs'), ...args], { cwd: root, encoding: 'utf8', timeout: 120_000, env: { ...process.env, INIT_CWD: root } });
  try {
    return { code: r.status, json: JSON.parse(r.stdout) as ShotJson };
  } catch {
    throw new Error(`shot.mjs output is not JSON (exit ${r.status}):\n${r.stdout}\n${r.stderr}`);
  }
}

/** PNG width/height from the IHDR chunk. */
function pngSize(file: string): { w: number; h: number } {
  const b = readFileSync(file);
  expect(b.subarray(1, 4).toString('latin1')).toBe('PNG');
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

describe('view:shot — headless', () => {
  it('examples/prefabs (trempel.view.ts, <use> prefabs, menu.state.json): PNG, no errors, exit 0', () => {
    const out = join(tmp, 'menu.png');
    const { code, json } = shot('examples/prefabs/menu.tml.svg', '--out', out);
    expect(json.errors).toEqual([]);
    expect(code).toBe(0);
    expect(json.scene).toBe('menu');
    expect(pngSize(out)).toEqual({ w: json.width, h: json.height });
  }, 120_000);

  it('examples/motion (v0.7: defs, path/circle/ellipse/line, clip-path, rig images): no errors, exit 0', () => {
    const out = join(tmp, 'motion.png');
    const { code, json } = shot('examples/motion/scene.tml.svg', '--out', out);
    expect(json.errors).toEqual([]);
    expect(code).toBe(0);
    expect(json).toMatchObject({ scene: 'scene', width: 800, height: 500 });
    expect(pngSize(out)).toEqual({ w: 800, h: 500 });
  }, 120_000);

  it('--clip --t (v0.8): two times → two PNGs with the time as a suffix, poses differ; JSON lists frames', () => {
    const out = join(tmp, 'wave.png');
    const r = spawnSync(
      process.execPath,
      [join(root, 'view/shot.mjs'), 'examples/motion/scene.tml.svg', '--clip', 'wave', '--t', '0', '--t', '0.5', '--out', out],
      { cwd: root, encoding: 'utf8', timeout: 120_000, env: { ...process.env, INIT_CWD: root } },
    );
    const json = JSON.parse(r.stdout) as ShotJson & { clip: string; frames: { t: number; out: string }[] };
    expect(json.errors).toEqual([]);
    expect(r.status).toBe(0);
    expect(json.clip).toBe('wave');
    expect(json.frames).toEqual([
      { t: 0, out: join(tmp, 'wave-0.png') },
      { t: 0.5, out: join(tmp, 'wave-0.5.png') },
    ]);
    expect(pngSize(json.frames[0].out)).toEqual({ w: 800, h: 500 });
    expect(readFileSync(json.frames[0].out).equals(readFileSync(json.frames[1].out))).toBe(false);
    // one --t → --out as is; an unknown clip is an error naming the clips there are
    const one = shot('examples/motion/scene.tml.svg', '--clip', 'nope', '--t', '1', '--out', join(tmp, 'one.png'));
    expect(one.code).toBe(1);
    expect(one.json.errors.map((e) => e.kind)).toEqual(['clips']);
    expect(one.json.errors[0].message).toMatch(/клипа «nope» у сцены нет \(есть: fly, idle, wave/);
    expect(shot('examples/motion/scene.tml.svg', '--t', '1').json.errors[0].message).toMatch(/--t без --clip/);
  }, 120_000);

  it('examples/finddiff (v0.9.1: a folder stands for its scene; <use> prefab, hidden zones): no errors, exit 0', () => {
    const out = join(tmp, 'finddiff.png');
    const { code, json } = shot('examples/finddiff', '--out', out);
    expect(json.errors).toEqual([]);
    expect(code).toBe(0);
    expect(json).toMatchObject({ scene: 'scene', width: 800, height: 440 });
    expect(pngSize(out)).toEqual({ w: 800, h: 440 });
  }, 120_000);

  it('dashes (v0.9.1): the dashed scene and the same scene solid both draw, and differ', () => {
    const dash = join(tmp, 'dash.png');
    const solid = join(tmp, 'solid.png');
    expect(shot('test/fixtures/v091/dash.svg', '--out', dash).json.errors).toEqual([]);
    expect(shot('test/fixtures/v091/solid.svg', '--out', solid).json.errors).toEqual([]);
    expect(pngSize(dash)).toEqual({ w: 200, h: 120 });
    expect(readFileSync(dash).equals(readFileSync(solid))).toBe(false);
  }, 120_000);

  it('clips play from the md clip ($tex), a compiled .json next to it is ignored (v0.9.1)', () => {
    // anim/m.json points at stale/*.png that do not exist: reading it would be a texture error.
    const r = spawnSync(
      process.execPath,
      [join(root, 'view/shot.mjs'), 'test/fixtures/v091/clipjson', '--clip', 'swap', '--t', '0', '--t', '0.6', '--out', join(tmp, 'cj.png')],
      { cwd: root, encoding: 'utf8', timeout: 120_000, env: { ...process.env, INIT_CWD: root } },
    );
    const json = JSON.parse(r.stdout) as ShotJson & { frames: { t: number; out: string }[] };
    expect(json.errors).toEqual([]);
    expect(r.status).toBe(0);
    expect(readFileSync(json.frames[0].out).equals(readFileSync(json.frames[1].out))).toBe(false);
  }, 120_000);

  it('viewport preset and --state override', () => {
    const out = join(tmp, 'ok.png');
    const state = join(tmp, 's.json');
    writeFileSync(state, '{"title":"from --state"}');
    const { code, json } = shot('test/fixtures/view/nested/ok', '--dir', 'test/fixtures/view', '--viewport', '9:16', '--state', state, '--out', out);
    expect(code).toBe(0);
    expect(json).toMatchObject({ scene: 'nested/ok', width: 200, height: 356 });
    expect(pngSize(out)).toEqual({ w: 200, h: 356 });
  }, 120_000);

  it('a broken scene: errors in stdout JSON, exit 1, PNG still written', () => {
    const out = join(tmp, 'broken.png');
    const { code, json } = shot('test/fixtures/view/broken.svg', '--out', out);
    expect(code).toBe(1);
    expect(json.errors.map((e) => e.kind).sort()).toEqual(['contract', 'runtime']);
    expect(json.errors.find((e) => e.kind === 'runtime')!.message).toBe('#label tml:bind="state.box.n": чтение поля «n» у null');
    expect(json.warnings.map((w) => w.kind)).toEqual(['context']);
    expect(pngSize(out)).toEqual({ w: 400, h: 300 });
  }, 120_000);

  it('a missing scene is a usage failure (exit 2)', () => {
    const { code, json } = shot('test/fixtures/view/nope.svg');
    expect(code).toBe(2);
    expect(json.errors[0].kind).toBe('cli');
  });
});
