// Kit 2.2 (TRM-12): trempel-anim-import — Unity AnimationClips / Animator controllers → md clips.
// Every Unity file here is SYNTHETIC, written by this test into a temp project: a prefab "Hero"
// (Animator → Hero.controller; body with a SpriteRenderer, arm, panel — a RectTransform with a
// CanvasGroup and an Image, eyes — inactive), clips Idle / Jump / Flip and a loose clip, a sprite sheet
// .meta. A corpus run over real projects only with TREMPEL_UNITY_CORPUS (a folder of Unity projects).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { bezierAt } from '../src/clip-import/index.js';
import { constantIn, curveKeys, evalCurve, evalSegment, readCurve, segmentCubic, unwrapped, type UKey } from '../src/anim-import/curve.js';
import { eulerMatrix, project, quatEuler, quatMatrix } from '../src/anim-import/convert.js';
import { counts, importAnim, mapMd, readMap, resolveIds, verifyCounts, writeAnimImport, type AnimImportResult } from '../src/anim-import/import.js';
import { syntheticScene, verifyMd } from '../src/anim-import/verify.js';
import { readController } from '../src/anim-import/controller.js';
import { readClip } from '../src/anim-import/clip.js';
import { parseUnityYaml } from '../src/fx-import/yaml.js';
import { main } from '../src/cli/anim-import.js';

const tmp = mkdtempSync(join(tmpdir(), 'anim-import-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// ── synthetic Unity YAML ───────────────────────────────────────────────────────────────────────────

const HEAD = '%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n';
const G = {
  ctl: 'c0000000000000000000000000000001',
  idle: 'a0000000000000000000000000000001',
  jump: 'a0000000000000000000000000000002',
  flip: 'a0000000000000000000000000000003',
  loose: 'a0000000000000000000000000000004',
  sheet: 'b0000000000000000000000000000001',
  prefab: 'd0000000000000000000000000000001',
  image: 'fe87c0e1cc204ed48ad3b37840f39efc',
};

interface K {
  t: number;
  v: number;
  i?: number | string;
  o?: number | string;
  wm?: number;
  iw?: number;
  ow?: number;
}

const fkey = (k: K, pad: string): string =>
  [
    `${pad}- serializedVersion: 3`,
    `${pad}  time: ${k.t}`,
    `${pad}  value: ${k.v}`,
    `${pad}  inSlope: ${k.i ?? 0}`,
    `${pad}  outSlope: ${k.o ?? 0}`,
    `${pad}  tangentMode: 0`,
    `${pad}  weightedMode: ${k.wm ?? 0}`,
    `${pad}  inWeight: ${k.iw ?? 0.33333334}`,
    `${pad}  outWeight: ${k.ow ?? 0.33333334}`,
  ].join('\n');

const curveBody = (keys: string): string => ['  - curve:', '      serializedVersion: 2', '      m_Curve:', keys, '      m_PreInfinity: 2', '      m_PostInfinity: 2', '      m_RotationOrder: 4'].join('\n');

const floatCurve = (attr: string, path: string, classID: number, keys: K[], script = ''): string =>
  [curveBody(keys.map((k) => fkey(k, '      ')).join('\n')), `    attribute: ${attr}`, `    path: ${path}`, `    classID: ${classID}`, `    script: {fileID: ${script ? `11500000, guid: ${script}, type: 3` : '0'}}`].join('\n');

/** A vector / quaternion curve: per key the components' values and slopes. */
const vecCurve = (path: string, keys: { t: number; v: number[]; i?: number[]; o?: number[]; wm?: number; iw?: number[]; ow?: number[] }[]): string => {
  const names = ['x', 'y', 'z', 'w'];
  const vec = (a: number[]): string => `{${a.map((x, i) => `${names[i]}: ${x}`).join(', ')}}`;
  const zero = (a: number[]): number[] => a.map(() => 0);
  const third = (a: number[]): number[] => a.map(() => 0.33333334);
  const ks = keys
    .map((k) =>
      [
        '      - serializedVersion: 3',
        `        time: ${k.t}`,
        `        value: ${vec(k.v)}`,
        `        inSlope: ${vec(k.i ?? zero(k.v))}`,
        `        outSlope: ${vec(k.o ?? zero(k.v))}`,
        '        tangentMode: 0',
        `        weightedMode: ${k.wm ?? 0}`,
        `        inWeight: ${vec(k.iw ?? third(k.v))}`,
        `        outWeight: ${vec(k.ow ?? third(k.v))}`,
      ].join('\n'),
    )
    .join('\n');
  return [curveBody(ks), `    path: ${path}`].join('\n');
};

interface AnimSpec {
  name: string;
  stop: number;
  loop?: boolean;
  position?: string[];
  euler?: string[];
  rotation?: string[];
  scale?: string[];
  floats?: string[];
  pptr?: string[];
  events?: string[];
}

const list = (key: string, items: string[] | undefined): string => (items?.length ? `  ${key}:\n${items.join('\n')}` : `  ${key}: []`);

function animYaml(a: AnimSpec): string {
  return [
    HEAD + '--- !u!74 &7400000',
    'AnimationClip:',
    `  m_Name: ${a.name}`,
    '  serializedVersion: 6',
    '  m_Legacy: 0',
    '  m_Compressed: 0',
    list('m_RotationCurves', a.rotation),
    '  m_CompressedRotationCurves: []',
    list('m_EulerCurves', a.euler),
    list('m_PositionCurves', a.position),
    list('m_ScaleCurves', a.scale),
    list('m_FloatCurves', a.floats),
    list('m_PPtrCurves', a.pptr),
    '  m_SampleRate: 60',
    '  m_WrapMode: 0',
    '  m_AnimationClipSettings:',
    '    serializedVersion: 2',
    '    m_StartTime: 0',
    `    m_StopTime: ${a.stop}`,
    `    m_LoopTime: ${a.loop ? 1 : 0}`,
    '  m_EditorCurves:',
    floatCurve('m_LocalPosition.x', 'ignored', 4, [{ t: 0, v: 99 }]),
    '  m_EulerEditorCurves: []',
    list('m_Events', a.events),
  ].join('\n') + '\n';
}

const meta = (guid: string, extra = ''): string => `fileFormatVersion: 2\nguid: ${guid}\n${extra}`;

function write(root: string, rel: string, text: string, guid?: string, metaExtra = ''): string {
  const p = join(root, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, text);
  if (guid) writeFileSync(`${p}.meta`, meta(guid, metaExtra));
  return p;
}

function controllerYaml(): string {
  const state = (id: number, name: string, motion: string, transitions: number[], speed = 1): string =>
    [
      `--- !u!1102 &${id}`,
      'AnimatorState:',
      `  m_Name: ${name}`,
      `  m_Speed: ${speed}`,
      transitions.length ? `  m_Transitions:\n${transitions.map((t) => `  - {fileID: ${t}}`).join('\n')}` : '  m_Transitions: []',
      `  m_Motion: {fileID: 7400000, guid: ${motion}, type: 2}`,
    ].join('\n');
  const tr = (id: number, dst: number, conds: string[], exit: number | null): string =>
    [
      `--- !u!1101 &${id}`,
      'AnimatorStateTransition:',
      '  m_Name: ',
      conds.length ? `  m_Conditions:\n${conds.join('\n')}` : '  m_Conditions: []',
      `  m_DstState: {fileID: ${dst}}`,
      '  m_TransitionDuration: 0.25',
      '  m_HasFixedDuration: 1',
      `  m_ExitTime: ${exit ?? 0}`,
      `  m_HasExitTime: ${exit === null ? 0 : 1}`,
    ].join('\n');
  return (
    HEAD +
    [
      '--- !u!91 &9100000',
      'AnimatorController:',
      '  m_Name: Hero',
      '  m_AnimatorParameters:',
      '  - m_Name: Jump',
      '    m_Type: 9',
      '  - m_Name: Speed',
      '    m_Type: 1',
      '  m_AnimatorLayers:',
      '  - serializedVersion: 5',
      '    m_Name: Base Layer',
      '    m_StateMachine: {fileID: 1107000}',
      '--- !u!1107 &1107000',
      'AnimatorStateMachine:',
      '  m_Name: Base Layer',
      '  m_ChildStates:',
      '  - serializedVersion: 1',
      '    m_State: {fileID: 1}',
      '  - serializedVersion: 1',
      '    m_State: {fileID: 2}',
      '  - serializedVersion: 1',
      '    m_State: {fileID: 3}',
      '  m_ChildStateMachines: []',
      '  m_AnyStateTransitions:',
      '  - {fileID: 13}',
      '  m_EntryTransitions: []',
      '  m_DefaultState: {fileID: 1}',
      state(1, 'Idle', G.idle, [11]),
      state(2, 'Jump', G.jump, [12], 2),
      state(3, 'Flip', G.flip, []),
      tr(11, 2, ['  - m_ConditionMode: 1', '    m_ConditionEvent: Jump', '    m_EventTreshold: 0'], null),
      tr(12, 1, [], 0.9),
      tr(13, 3, ['  - m_ConditionMode: 3', '    m_ConditionEvent: Speed', '    m_EventTreshold: 0.5'], null),
    ].join('\n') +
    '\n'
  );
}

function prefabYaml(): string {
  const go = (id: number, name: string, comps: number[], active = 1): string =>
    [`--- !u!1 &${id}`, 'GameObject:', '  m_Component:', ...comps.map((c) => `  - component: {fileID: ${c}}`), `  m_Name: ${name}`, `  m_IsActive: ${active}`].join('\n');
  const tf = (id: number, goId: number, father: number, children: number[], o: { pos?: string; rot?: string; hint?: string; scale?: string }): string =>
    [
      `--- !u!4 &${id}`,
      'Transform:',
      `  m_GameObject: {fileID: ${goId}}`,
      `  m_LocalRotation: ${o.rot ?? '{x: 0, y: 0, z: 0, w: 1}'}`,
      `  m_LocalPosition: ${o.pos ?? '{x: 0, y: 0, z: 0}'}`,
      `  m_LocalScale: ${o.scale ?? '{x: 1, y: 1, z: 1}'}`,
      ...(o.hint ? [`  m_LocalEulerAnglesHint: ${o.hint}`] : []),
      children.length ? `  m_Children:\n${children.map((c) => `  - {fileID: ${c}}`).join('\n')}` : '  m_Children: []',
      `  m_Father: {fileID: ${father}}`,
    ].join('\n');
  const s15 = Math.sin((15 * Math.PI) / 180);
  const c15 = Math.cos((15 * Math.PI) / 180);
  return (
    HEAD +
    [
      go(100, 'Hero', [101, 102]),
      tf(101, 100, 0, [111, 121, 131, 141], {}),
      '--- !u!95 &102',
      'Animator:',
      '  m_GameObject: {fileID: 100}',
      `  m_Controller: {fileID: 9100000, guid: ${G.ctl}, type: 2}`,
      '  m_ApplyRootMotion: 0',
      go(110, 'body', [111, 112]),
      tf(111, 110, 101, [], { pos: '{x: 0.1, y: 0.2, z: 0}' }),
      '--- !u!212 &112',
      'SpriteRenderer:',
      '  m_GameObject: {fileID: 110}',
      '  m_Color: {r: 1, g: 0.8, b: 0.6, a: 1}',
      go(120, 'arm', [121]),
      tf(121, 120, 101, [], { rot: `{x: 0, y: 0, z: ${s15}, w: ${c15}}`, hint: '{x: 0, y: 0, z: 30}', scale: '{x: 2, y: 2, z: 1}' }),
      go(130, 'panel', [131, 132, 133]),
      '--- !u!224 &131',
      'RectTransform:',
      '  m_GameObject: {fileID: 130}',
      '  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}',
      '  m_LocalPosition: {x: 0, y: 0, z: 0}',
      '  m_LocalScale: {x: 1, y: 1, z: 1}',
      '  m_Children: []',
      '  m_Father: {fileID: 101}',
      '  m_AnchorMin: {x: 0.5, y: 0.5}',
      '  m_AnchorMax: {x: 0.5, y: 0.5}',
      '  m_AnchoredPosition: {x: 10, y: -20}',
      '  m_SizeDelta: {x: 100, y: 50}',
      '--- !u!225 &132',
      'CanvasGroup:',
      '  m_GameObject: {fileID: 130}',
      '  m_Alpha: 1',
      '--- !u!114 &133',
      'MonoBehaviour:',
      '  m_GameObject: {fileID: 130}',
      `  m_Script: {fileID: 11500000, guid: ${G.image}, type: 3}`,
      '  m_Color: {r: 1, g: 1, b: 1, a: 0.5}',
      go(140, 'eyes', [141], 0),
      tf(141, 140, 101, [], {}),
    ].join('\n') +
    '\n'
  );
}

const INF = 'Infinity';

function makeProject(root: string): void {
  write(root, 'Assets/Hero/Hero.prefab', prefabYaml(), G.prefab);
  write(root, 'Assets/Hero/Hero.controller', controllerYaml(), G.ctl);
  // Idle: Hermite position (x moves, y stays at rest), Z Euler rotation, m_IsActive steps, events.
  write(
    root,
    'Assets/Hero/idle.anim',
    animYaml({
      name: 'idle',
      stop: 2,
      loop: true,
      position: [
        vecCurve('body', [
          { t: 0, v: [0.1, 0.2, 0], o: [1.5, 0, 0] },
          { t: 1, v: [0.6, 0.2, 0], i: [-0.5, 0, 0], o: [0, 0, 0] },
          { t: 2, v: [0.1, 0.2, 0] },
        ]),
      ],
      euler: [
        vecCurve('arm', [
          { t: 0, v: [0, 0, 30], o: [0, 0, 90] },
          { t: 1.2, v: [0, 0, 75] },
          { t: 2, v: [0, 0, 30] },
        ]),
      ],
      floats: [floatCurve('m_IsActive', 'eyes', 1, [{ t: 0, v: 0, i: INF, o: INF }, { t: 0.5, v: 1, i: INF, o: INF }, { t: 1.5, v: 0, i: INF, o: INF }])],
      events: [
        '  - time: 0.5\n    functionName: footstep\n    data: left\n    objectReferenceParameter: {fileID: 0}\n    floatParameter: 2\n    intParameter: 0\n    messageOptions: 0',
        '  - time: 1\n    functionName: land\n    data: \n    objectReferenceParameter: {fileID: 0}\n    floatParameter: 0\n    intParameter: 0\n    messageOptions: 0',
      ],
    }),
    G.idle,
  );
  // Jump: weighted scale, quaternion Z, anchored position, CanvasGroup alpha, Image / SpriteRenderer colour, sprites, a material curve.
  write(
    root,
    'Assets/Hero/jump.anim',
    animYaml({
      name: 'jump',
      stop: 1,
      scale: [
        vecCurve('arm', [
          { t: 0, v: [2, 2, 1], o: [4, 4, 0], wm: 2, ow: [0.6, 0.6, 0.6] },
          { t: 1, v: [3, 3, 1], i: [1, 1, 0], wm: 1, iw: [0.2, 0.2, 0.2] },
        ]),
      ],
      rotation: [
        vecCurve('body', [
          { t: 0, v: [0, 0, 0, 1] },
          { t: 1, v: [0, 0, Math.SQRT1_2, Math.SQRT1_2] },
        ]),
      ],
      floats: [
        floatCurve('m_AnchoredPosition.x', 'panel', 224, [{ t: 0, v: 10 }, { t: 1, v: 30 }]),
        floatCurve('m_AnchoredPosition.y', 'panel', 224, [{ t: 0, v: -20, o: 100 }, { t: 1, v: 40 }]),
        floatCurve('m_Alpha', 'panel', 225, [{ t: 0, v: 1 }, { t: 1, v: 0 }]),
        floatCurve('m_Color.r', 'panel', 114, [{ t: 0, v: 1 }, { t: 1, v: 0 }], G.image),
        floatCurve('m_Color.g', 'panel', 114, [{ t: 0, v: 1 }, { t: 1, v: 0.5 }], G.image),
        floatCurve('m_Color.b', 'panel', 114, [{ t: 0, v: 1 }, { t: 1, v: 1 }], G.image),
        floatCurve('m_Color.r', 'body', 212, [{ t: 0, v: 1, o: 3 }, { t: 1, v: 0.2 }]),
        floatCurve('material._Glow', 'body', 212, [{ t: 0, v: 0 }, { t: 1, v: 1 }]),
      ],
      pptr: [
        `  - curve:\n    - time: 0\n      value: {fileID: 21300000, guid: ${G.sheet}, type: 3}\n    - time: 0.5\n      value: {fileID: 21300002, guid: ${G.sheet}, type: 3}\n    attribute: m_Sprite\n    path: body\n    classID: 212\n    script: {fileID: 0}`,
      ],
    }),
    G.jump,
  );
  // Flip: a rotation about Y (a card flip) — 3D, approximated.
  write(
    root,
    'Assets/Hero/flip.anim',
    animYaml({
      name: 'flip',
      stop: 1,
      euler: [
        vecCurve('arm', [
          { t: 0, v: [0, 0, 30] },
          { t: 1, v: [0, 180, 30] },
        ]),
      ],
    }),
    G.flip,
  );
  // A clip no controller uses: paths relative to an unknown root.
  write(
    root,
    'Assets/Loose/loose.anim',
    animYaml({ name: 'loose', stop: 1, floats: [floatCurve('m_LocalPosition.x', 'a/LEAF', 4, [{ t: 0, v: 0 }, { t: 1, v: 1 }]), floatCurve('m_LocalScale.x', '', 4, [{ t: 0, v: 1 }, { t: 1, v: 2 }])] }),
    G.loose,
  );
  write(
    root,
    'Assets/Art/hero.png',
    'not a png',
    G.sheet,
    'TextureImporter:\n  internalIDToNameTable:\n  - first:\n      213: 21300000\n    second: hero_0\n  - first:\n      213: 21300002\n    second: hero_1\n  spriteMode: 2\n',
  );
}

const PROJECT = join(tmp, 'Game');
makeProject(PROJECT);

const closeTo = (got: unknown, want: number[]): void => {
  expect(Array.isArray(got)).toBe(true);
  (got as number[]).forEach((v, i) => expect(v).toBeCloseTo(want[i], 9));
};
const clipOf = (r: AnimImportResult, group: string, clip: string) => r.groups.find((g) => g.name === group)!.clips.find((c) => c.clip === clip)!;
const itemOf = (r: AnimImportResult, group: string, clip: string, path: string, attr: string) => clipOf(r, group, clip).items.find((i) => i.path === path && i.attributes.some((a) => a.startsWith(attr)))!;

// ── curves ─────────────────────────────────────────────────────────────────────────────────────────

describe('anim-import: Unity curves', () => {
  const k = (t: number, v: number, inSlope: number, outSlope: number, weightedMode = 0, inWeight = 1 / 3, outWeight = 1 / 3): UKey => ({ t, v, inSlope, outSlope, weightedMode, inWeight, outWeight });

  it('a Hermite segment IS the cubic Bézier with control points at dt/3 along the slopes', () => {
    const a = k(0.2, 1, 0, 3);
    const b = k(1.4, -2, -1, 0);
    const c = segmentCubic(a, b);
    expect(c.cx1).toBeCloseTo(0.2 + 1.2 / 3, 12);
    expect(c.cy1).toBeCloseTo(1 + 3 * 0.4, 12);
    expect(c.cx2).toBeCloseTo(1.4 - 0.4, 12);
    expect(c.cy2).toBeCloseTo(-2 + 0.4, 12);
    for (let t = 0.2; t <= 1.4; t += 0.05) expect(evalSegment(a, b, t)).toBeCloseTo(bezierAt(t, 0.2, 1, 1.4, -2, c), 6);
  });

  it('weighted tangents: the Bézier of the weights; constant (infinite) tangents hold the value', () => {
    const a = k(0, 0, 0, 2, 2, 1 / 3, 0.7);
    const b = k(1, 1, 0.5, 0, 1, 0.1, 1 / 3);
    const c = segmentCubic(a, b);
    expect(c).toEqual({ cx1: 0.7, cy1: 1.4, cx2: 0.9, cy2: 1 - 0.05 });
    for (const t of [0.1, 0.35, 0.8]) expect(evalSegment(a, b, t)).toBeCloseTo(bezierAt(t, 0, 0, 1, 1, c), 6);
    const s = k(0, 5, 0, Infinity);
    expect(evalSegment(s, k(1, 9, 0, 0), 0.99)).toBe(5);
    expect(evalSegment(s, k(1, 9, 0, 0), 1)).toBe(9);
    const curve = readCurve({ m_Curve: [{ time: '0', value: '1', inSlope: '-Infinity', outSlope: 'Infinity' }, { time: '1', value: '2', inSlope: '0', outSlope: '0' }] });
    expect(curve.keys[0]).toMatchObject({ outSlope: Infinity, inSlope: -Infinity, weightedMode: 0, inWeight: 1 / 3 });
    expect(evalCurve(curve, -1)).toBe(1);
    expect(evalCurve(curve, 0.5)).toBe(1);
    expect(evalCurve(curve, 5)).toBe(2);
    expect(constantIn(curve, 0, 1)).toBe(true);
  });

  it('curve keys: Hermite → [x1, y1, x2, y2] eases, constant → step, flat-but-moving → baked, cut at the clip end', () => {
    const c = { keys: [k(0, 0, 0, 3), k(1, 1, 0, 0), k(2, 1, 4, Infinity), k(3, 0, 0, 0), k(4, 0, 2, 0)], pre: 2, post: 2 };
    const info = curveKeys(c, 10, 5, { duration: 3.5, fps: 30, tol: 0.01 });
    const ks = info.keys;
    expect(ks[0]).toMatchObject({ t: 0, v: 5 });
    closeTo(ks[0].ease, [1 / 3, 1, 2 / 3, 1]);
    expect(info.steps).toBe(1);
    // 1 → 2: equal values with a non-flat in-tangent at 2 — no ease: baked.
    expect(info.baked).toBeGreaterThan(0);
    expect(ks.find((x) => x.t === 2)?.ease).toBe('step');
    expect(ks[ks.length - 1].t).toBe(3.5);
    // The keys played linearly between baked times match Unity within the tolerance.
    const unwrap = unwrapped((t) => ((t * 400) % 360) - 180, 2);
    expect(unwrap(1.9) - unwrap(0.1)).toBeCloseTo(720, 0);
  });

  it('3D rotations: Unity Euler order, quaternions, the orthographic projection on a y-down screen', () => {
    const z = project(eulerMatrix(0, 0, 30));
    expect(z.deg).toBeCloseTo(-30, 9);
    expect(z.sx).toBeCloseTo(1, 9);
    expect(z.sy).toBeCloseTo(1, 9);
    const flip = project(eulerMatrix(0, 60, 0));
    expect(flip.sx).toBeCloseTo(0.5, 9);
    expect(flip.sy).toBeCloseTo(1, 9);
    const q = quatMatrix(0, 0, Math.sin(Math.PI / 8), Math.cos(Math.PI / 8));
    expect(project(q).deg).toBeCloseTo(-45, 9);
    const e = quatEuler({ x: 0.1, y: 0.2, z: 0.3, w: Math.sqrt(1 - 0.14) });
    const back = eulerMatrix(e.x, e.y, e.z);
    const m = quatMatrix(0.1, 0.2, 0.3, Math.sqrt(1 - 0.14));
    back.forEach((v, i) => expect(v).toBeCloseTo(m[i], 9));
  });
});

// ── reading ────────────────────────────────────────────────────────────────────────────────────────

describe('anim-import: clips and controllers', () => {
  it('reads a clip: vector curves split into components, settings, events; editor curves ignored', () => {
    const docs = parseUnityYaml(readFileSync(join(PROJECT, 'Assets/Hero/idle.anim'), 'utf8'));
    const c = readClip(docs[0].body);
    expect(c).toMatchObject({ name: 'idle', duration: 2, loop: true });
    expect(c.floats.map((b) => b.attribute)).toEqual(['m_LocalPosition.x', 'm_LocalPosition.y', 'm_LocalPosition.z', 'localEulerAnglesRaw.x', 'localEulerAnglesRaw.y', 'localEulerAnglesRaw.z', 'm_IsActive']);
    expect(c.events).toEqual([
      { t: 0.5, name: 'footstep', data: 'left', float: 2, int: 0, object: null },
      { t: 1, name: 'land', data: '', float: 0, int: 0, object: null },
    ]);
    expect(() => readClip({ m_Name: 'x' }, 'x')).toThrow(/^E_ANIM_IMPORT_CLIP: /);
  });

  it('reads a controller: states (default, speed), transitions as text, parameters', () => {
    const ctl = readController(parseUnityYaml(controllerYaml()), 'Hero.controller');
    expect(ctl.states.map((s) => [s.name, s.speed, s.isDefault])).toEqual([
      ['Idle', 1, true],
      ['Jump', 2, false],
      ['Flip', 1, false],
    ]);
    expect(ctl.transitions).toEqual(['Idle → Jump: if Jump; blend 0.25 s', 'Jump → Idle: no condition; exit time 0.9; blend 0.25 s', 'Any State → Flip: Speed > 0.5; blend 0.25 s']);
    expect(ctl.parameters).toEqual(['Jump', 'Speed']);
    expect(() => readController(parseUnityYaml(HEAD + '--- !u!1 &1\nGameObject:\n  m_Name: x\n'), 'x')).toThrow(/^E_ANIM_IMPORT_CONTROLLER: /);
  });
});

// ── import ─────────────────────────────────────────────────────────────────────────────────────────

describe('anim-import: a prefab, its controller, its clips', () => {
  const r = importAnim({ inputs: [PROJECT] });

  it('groups: the prefab (states → clips) and the loose clip; transitions only in the report', () => {
    expect(r.groups.map((g) => [g.name, g.kind])).toEqual([
      ['Hero', 'prefab'],
      ['loose', 'clip'],
    ]);
    const hero = r.groups[0];
    expect(hero.clips.map((c) => [c.clip, c.state])).toEqual([
      ['Idle', 'Idle'],
      ['Jump', 'Jump'],
      ['Flip', 'Flip'],
    ]);
    expect(hero.transitions).toHaveLength(3);
    expect(hero.md).toContain('# $clip Idle\n$duration: 2\n$loop: true');
    expect(hero.md).not.toContain('Jump →');
    expect(hero.json).not.toBe(null);
    expect(hero.compileErrors).toEqual([]);
    expect(Object.keys(hero.json!)).toEqual(['Idle', 'Jump', 'Flip']);
  });

  it('every clip converges: the md played by Trempel = Unity’s evaluation (Hermite, weighted, steps, quaternions, colours, sprites)', () => {
    for (const c of r.clips) expect([c.clip, c.verification?.converged, c.verification?.error]).toEqual([c.clip, true, undefined]);
    expect(verifyCounts(r.clips)).toEqual({ checked: 4, converged: 4 });
  });

  it('units and rest poses: positions × ppu with y down, rotation clockwise, scale a multiplier, from the prefab', () => {
    const idle = r.groups[0].convs[0];
    const x = idle.columns.find((c) => c.target === 'body' && c.col === 'x')!;
    expect(x.keys.map((k) => [k.t, +(+k.v).toFixed(6)])).toEqual([
      [0, 0],
      [1, 50],
      [2, 0],
    ]);
    // Hermite: control points at dt/3 along the slopes, normalized to the segment.
    closeTo(x.keys[0].ease, [1 / 3, 1, 2 / 3, 4 / 3]); // y2 = 1 − m1·(dt/3) / dv
    expect(idle.columns.some((c) => c.target === 'body' && c.col === 'y')).toBe(false); // y stays at rest
    const rot = idle.columns.find((c) => c.target === 'arm' && c.col === 'rotation')!;
    expect(rot.keys.map((k) => k.v)).toEqual([0, -45, 0]);
    expect(itemOf(r, 'Hero', 'Idle', 'arm', 'localEulerAngles').cls).toBe('auto');
    const jump = r.groups[0].convs[1];
    const ax = jump.columns.find((c) => c.target === 'panel' && c.col === 'x')!;
    const ay = jump.columns.find((c) => c.target === 'panel' && c.col === 'y')!;
    expect([ax.keys[0].v, ax.keys[1].v, ay.keys[0].v, ay.keys[1].v]).toEqual([0, 20, 0, -60]);
    const scale = jump.columns.find((c) => c.target === 'arm' && c.col === 'scale')!;
    expect(scale.keys.map((k) => k.v)).toEqual([1, 1.5]);
  });

  it('weighted tangents: verified exact → auto, said in the report', () => {
    const it = itemOf(r, 'Hero', 'Jump', 'arm', 'm_LocalScale');
    expect(it.weighted).toBe(true);
    expect(it.cls).toBe('auto');
    expect(it.notes.join(' ')).toMatch(/verified exact/);
    const off = importAnim({ inputs: [join(PROJECT, 'Assets/Hero/Hero.prefab')], verify: false });
    expect(itemOf(off, 'Hero', 'Jump', 'arm', 'm_LocalScale').cls).toBe('manual');
  });

  it('quaternion Z → a baked rotation; alpha (CanvasGroup × the Image’s rest alpha), tint per channel; sprites → tex', () => {
    const jump = r.groups[0].convs[1];
    const rot = jump.columns.find((c) => c.target === 'body' && c.col === 'rotation')!;
    expect(rot.keys[0].v).toBe(0);
    expect(rot.keys[rot.keys.length - 1].v).toBeCloseTo(-90, 6);
    expect(itemOf(r, 'Hero', 'Jump', 'body', 'm_LocalRotation').notes.join(' ')).toMatch(/quaternion curves: the Z angle baked/);
    const alpha = jump.columns.find((c) => c.target === 'panel' && c.col === 'alpha')!;
    expect(alpha.keys.map((k) => k.v)).toEqual([0.5, 0]);
    const tint = jump.columns.find((c) => c.target === 'panel' && c.col === 'tint')!;
    expect(tint.keys.map((k) => [k.t, k.v])).toEqual([
      [0, '#ffffff'],
      [1, '#0080ff'],
    ]);
    closeTo(tint.keys[0].ease, [1 / 3, 0, 2 / 3, 1]);
    const bodyTint = jump.columns.find((c) => c.target === 'body' && c.col === 'tint')!;
    expect(bodyTint.keys[0].v).toBe('#ffcc99'); // g, b at the SpriteRenderer's colour
    const tex = jump.columns.find((c) => c.target === 'body' && c.col === 'tex')!;
    expect(tex.keys.map((k) => [k.t, k.v])).toEqual([
      [0, 'hero_0'],
      [0.5, 'hero_1'],
    ]);
    expect(r.groups[0].md).toContain('$tex: {}.png');
    expect(itemOf(r, 'Hero', 'Jump', 'body', 'material.').cls).toBe('hard');
    expect(clipOf(r, 'Hero', 'Jump').cls).toBe('hard');
    expect(clipOf(r, 'Hero', 'Jump').notes).toContain('state speed 2 — play with { speed: 2 }');
  });

  it('m_IsActive → alpha 0 / 1 with steps (manual); events → $events, parameters in the report', () => {
    const idle = r.groups[0].convs[0];
    const a = idle.columns.find((c) => c.target === 'eyes' && c.col === 'alpha')!;
    expect(a.keys.map((k) => [k.t, k.v, k.ease])).toEqual([
      [0, 0, 'step'],
      [0.5, 1, 'step'],
      [1.5, 0, undefined],
    ]);
    expect(itemOf(r, 'Hero', 'Idle', 'eyes', 'm_IsActive').cls).toBe('manual');
    expect(clipOf(r, 'Hero', 'Idle').cls).toBe('manual');
    expect(r.groups[0].md).toContain('## $events\n| t | event |\n| --- | --- |\n| 0.5 | footstep |\n| 1 | land |');
    expect(clipOf(r, 'Hero', 'Idle').events[0]).toEqual({ t: 0.5, name: 'footstep', params: 'data "left", float 2' });
  });

  it('a rotation about Y → its projection: rotation + scaleX (manual), verified against the same projection', () => {
    const it = itemOf(r, 'Hero', 'Flip', 'arm', 'localEulerAngles');
    expect(it.cls).toBe('manual');
    expect(it.columns).toEqual(['rotation', 'scaleX', 'scaleY']);
    const flip = r.groups[0].convs[2];
    // At 180° about Y the arm is mirrored: rotation −150°, scaleY −1.
    const sx = flip.columns.find((c) => c.col === 'scaleX')!;
    const sy = flip.columns.find((c) => c.col === 'scaleY')!;
    expect(Math.min(...sx.keys.map((k) => Math.abs(Number(k.v))))).toBeCloseTo(0.5, 2); // the X axis turned 30° in Z keeps sin 30°
    expect(Number(sy.keys[sy.keys.length - 1].v)).toBeCloseTo(-1, 3);
    expect(clipOf(r, 'Hero', 'Flip').verification?.converged).toBe(true);
  });

  it('without a scene: ids are the idified last segments; the loose clip’s rest pose is guessed (manual)', () => {
    expect(r.ids).toBe('names');
    expect(r.map.map((m) => [m.path, m.id])).toEqual([
      ['body', 'body'],
      ['arm', 'arm'],
      ['eyes', 'eyes'],
      ['panel', 'panel'],
      ['a/LEAF', 'LEAF'],
      ['(root)', 'root'],
    ]);
    const loose = clipOf(r, 'loose', 'loose');
    expect(loose.cls).toBe('manual');
    expect(loose.items[0].notes.join(' ')).toMatch(/rest pose unknown, taken from the first key/);
  });

  it('writes md, json, anim-map.md, report.md / report.json; the md compiles with the scene package', () => {
    const out = join(tmp, 'out');
    const w = writeAnimImport(r, out);
    expect(readdirSync(out).sort()).toEqual(['Hero.anim.json', 'Hero.anim.md', 'anim-map.md', 'loose.anim.json', 'loose.anim.md', 'report.json', 'report.md']);
    expect(w.md).toHaveLength(2);
    const report = readFileSync(join(out, 'report.md'), 'utf8');
    expect(report).toContain('**auto 0**, **manual 3**, **hard 1**');
    expect(report).toContain('Idle → Jump: if Jump');
    expect(report).toContain('4 of 4 converged');
    const json = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
    expect(json.counts).toEqual(counts(r.clips));
    expect(json.groups[0].clips[0].verification.converged).toBe(true);
    expect(readFileSync(join(out, 'anim-map.md'), 'utf8')).toContain('| a/LEAF | LEAF | the idified name (no scene) |');
  });
});

describe('anim-import: the verification catches what is wrong', () => {
  const r = importAnim({ inputs: [join(PROJECT, 'Assets/Hero/Hero.prefab')] });
  const g = r.groups[0];
  const svg = syntheticScene(g.convs.flatMap((c) => c.columns));
  const rows = (md: string, clip: string, track: string): { at: number; lines: string[] } => {
    const lines = md.split('\n');
    const c = lines.indexOf(`# $clip ${clip}`);
    const at = lines.indexOf(`## $track ${track}`, c) + 3;
    return { at, lines };
  };
  const mutate = (clip: string, track: string, fn: (cells: string[], i: number) => string[] | null): string => {
    const { at, lines } = rows(g.md, clip, track);
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (i >= at && lines[i].startsWith('|')) {
        const cells = lines[i].split('|').slice(1, -1).map((s) => s.trim());
        const m = fn(cells, i - at);
        if (m) out.push(`| ${m.join(' | ')} |`);
        continue;
      }
      out.push(lines[i]);
      if (i >= at && !lines[i].startsWith('|')) {
        out.push(...lines.slice(i + 1));
        break;
      }
    }
    return out.join('\n');
  };
  const check = (md: string, clip: string) => verifyMd(md, svg, g.convs).find((c) => c.clip === clip)!;

  it('the md as written converges', () => {
    expect(verifyMd(g.md, svg, g.convs).every((c) => c.converged)).toBe(true);
  });

  it('a wrong value', () => {
    const md = mutate('Idle', 'body', (c, i) => (i === 1 ? [c[0], '45', ...c.slice(2)] : c));
    const v = check(md, 'Idle');
    expect(v.converged).toBe(false);
    expect(v.columns.find((x) => x.target === 'body' && x.col === 'x')).toMatchObject({ ok: false });
    expect(v.columns.find((x) => x.target === 'arm')).toMatchObject({ ok: true });
  });

  it('a wrong sign', () => {
    const md = mutate('Idle', 'arm', (c) => [c[0], String(-Number(c[1])), ...c.slice(2)]);
    const v = check(md, 'Idle');
    expect(v.columns.find((x) => x.target === 'arm' && x.col === 'rotation')).toMatchObject({ ok: false });
  });

  it('a lost key', () => {
    const md = mutate('Idle', 'eyes', (c, i) => (i === 1 ? null : c));
    const v = check(md, 'Idle');
    expect(v.columns.find((x) => x.target === 'eyes' && x.col === 'alpha')).toMatchObject({ ok: false });
  });

  it('a wrong ease, a wrong sprite, a lost event', () => {
    const ease = mutate('Jump', 'arm', (c, i) => (i === 0 ? [...c.slice(0, -1), 'linear'] : c));
    expect(check(ease, 'Jump').columns.find((x) => x.target === 'arm' && x.col === 'scale')).toMatchObject({ ok: false });
    const tex = g.md.replace('| hero_1 |', '| hero_0 |');
    expect(check(tex, 'Jump').columns.find((x) => x.col === 'tex')).toMatchObject({ ok: false });
    const ev = g.md.replace('| 1 | land |\n', '');
    expect(check(ev, 'Idle').events).toEqual(['land @ 1']);
  });

  it('an md that does not compile is a finding, not a crash', () => {
    const v = check(g.md.replace('# $clip Idle\n$duration: 2', '# $clip Idle\n$duration: 2\n$bogus: 1'), 'Idle');
    expect(v.converged).toBe(false);
    expect(v.error).toMatch(/E_ANIM/);
  });
});

describe('anim-import: a scene, the map', () => {
  const scene = write(
    tmp,
    'scene/hero.svg',
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">
  <g id="Hero" transform="translate(200 200)">
    <image id="body" href="art/hero_0.png" x="-20" y="-20" width="40" height="40" transform="translate(10 -20)"/>
    <g id="arm" transform="rotate(-30) scale(2)"/>
    <g id="panel" transform="translate(10 20)"/>
    <g id="eyesNode"/>
    <g id="leaf"/>
    <g id="Leaf"/>
  </g>
</svg>`,
  );

  it('ids by node name; missing and ambiguous paths unmatched (left out), listed in anim-map.md', () => {
    const r = importAnim({ inputs: [PROJECT], scene, tex: 'art/{}.png' });
    expect(r.ids).toBe('scene');
    const byPath = Object.fromEntries(r.map.map((m) => [m.path, [m.id, m.note]]));
    expect(byPath.body).toEqual(['body', 'matched by name']);
    expect(byPath.eyes[0]).toBe('');
    expect(byPath.eyes[1]).toMatch(/^unmatched: no node named "eyes"/);
    expect(byPath['a/LEAF'][1]).toMatch(/^unmatched: ambiguous — #leaf, #Leaf/);
    expect(byPath['(root)'][1]).toMatch(/^unmatched: the Animator root/);
    expect(itemOf(r, 'Hero', 'Idle', 'eyes', 'm_IsActive').cls).toBe('hard');
    expect(r.groups[0].md).not.toContain('$track eyes');
    expect(r.groups[0].md).toContain('$tex: art/{}.png');
    expect(r.groups[0].verifiedOn).toBe('scene');
    for (const c of clipOf(r, 'Hero', 'Idle') ? r.groups[0].clips : []) expect([c.clip, c.verification?.converged]).toEqual([c.clip, true]);
    expect(mapMd(r.map)).toContain('| eyes |  | unmatched: no node named "eyes" in the scene |');
  });

  it('--map wins over the names: an edited anim-map.md fills the unmatched ids', () => {
    const r0 = importAnim({ inputs: [PROJECT], scene });
    const edited = mapMd(r0.map).replace('| eyes |  |', '| eyes | eyesNode |').replace('| a/LEAF |  |', '| a/LEAF | #leaf |').replace('| (root) |  |', '| (root) | Hero |');
    const mp = write(tmp, 'scene/anim-map.md', edited);
    expect(readMap(edited).find((x) => x.path === 'a/LEAF')?.id).toBe('leaf');
    const r = importAnim({ inputs: [PROJECT], scene, map: mp });
    expect(r.map.find((m) => m.path === 'eyes')).toEqual({ path: 'eyes', id: 'eyesNode', note: 'from the map' });
    expect(r.groups[0].md).toContain('## $track eyesNode');
    expect(r.clips.every((c) => c.verification?.converged)).toBe(true);
    // The map also wins without a scene; two paths on one scene node are both unmatched.
    expect(resolveIds(['a/x', 'b/x'], { mapped: new Map([['b/x', 'bx']]), sceneIds: null }).map((x) => x.id)).toEqual(['x', 'bx']);
    expect(resolveIds(['a/x', 'b/x'], { mapped: new Map(), sceneIds: new Set(['x']) }).map((x) => x.note)).toEqual([
      'unmatched: ambiguous — a/x, b/x all match #x',
      'unmatched: ambiguous — a/x, b/x all match #x',
    ]);
  });

  it('a controller alone: its states, no rest pose (first keys)', () => {
    const r = importAnim({ inputs: [join(PROJECT, 'Assets/Hero/Hero.controller')] });
    expect(r.groups.map((g) => [g.name, g.kind])).toEqual([['Hero', 'controller']]);
    expect(clipOf(r, 'Hero', 'Idle').items.find((i) => i.path === 'body')!.notes.join(' ')).toMatch(/rest pose unknown/);
    expect(r.clips.every((c) => c.verification?.converged)).toBe(true);
  });
});

// ── the rarer shapes: an override controller over a two-layer base, sub-state machines, a clip
// stored in the controller, a BlendTree, a clip of a model file, a legacy Animation, a 9-slice size,
// colour channels keyed apart, CanvasGroup × colour alpha, m_Enabled, a tilted quaternion, odd events
// and sprites ──────────────────────────────────────────────────────────────────────────────────────

const X = {
  base: 'e0000000000000000000000000000001',
  over: 'e0000000000000000000000000000002',
  orig: 'e0000000000000000000000000000003',
  swap: 'e0000000000000000000000000000004',
  legacy: 'e0000000000000000000000000000005',
  model: 'e0000000000000000000000000000006',
  single: 'e0000000000000000000000000000007',
  prefab: 'e0000000000000000000000000000008',
};

function extrasProject(root: string): void {
  const s45 = Math.SQRT1_2;
  write(
    root,
    'Assets/Extra/Extra.prefab',
    HEAD +
      [
        '--- !u!1 &100',
        'GameObject:',
        '  m_Component:',
        '  - component: {fileID: 101}',
        '  m_Name: Extra',
        '  m_IsActive: 1',
        '--- !u!4 &101',
        'Transform:',
        '  m_GameObject: {fileID: 100}',
        '  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}',
        '  m_LocalPosition: {x: 0, y: 0, z: 0}',
        '  m_LocalScale: {x: 1, y: 1, z: 1}',
        '  m_Children:',
        '  - {fileID: 111}',
        '  - {fileID: 121}',
        '  m_Father: {fileID: 0}',
        '--- !u!95 &102',
        'Animator:',
        '  m_GameObject: {fileID: 100}',
        `  m_Controller: {fileID: 22100000, guid: ${X.over}, type: 2}`,
        '  m_ApplyRootMotion: 1',
        '--- !u!1 &110',
        'GameObject:',
        '  m_Name: card',
        '  m_IsActive: 1',
        '--- !u!224 &111',
        'RectTransform:',
        '  m_GameObject: {fileID: 110}',
        '  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}',
        '  m_LocalPosition: {x: 0, y: 0, z: 0}',
        '  m_LocalScale: {x: 1, y: 1, z: 1}',
        '  m_Children:',
        '  - {fileID: 116}',
        '  m_Father: {fileID: 101}',
        '  m_AnchorMin: {x: 0.5, y: 0.5}',
        '  m_AnchorMax: {x: 0.5, y: 0.5}',
        '  m_AnchoredPosition: {x: 0, y: 0}',
        '  m_SizeDelta: {x: 100, y: 50}',
        '--- !u!114 &112',
        'MonoBehaviour:',
        '  m_GameObject: {fileID: 110}',
        `  m_Script: {fileID: 11500000, guid: ${G.image}, type: 3}`,
        '  m_Color: {r: 1, g: 1, b: 1, a: 1}',
        '--- !u!225 &113',
        'CanvasGroup:',
        '  m_GameObject: {fileID: 110}',
        '  m_Alpha: 1',
        '--- !u!1 &115',
        'GameObject:',
        '  m_Name: icon',
        '  m_IsActive: 1',
        '--- !u!4 &116',
        'Transform:',
        '  m_GameObject: {fileID: 115}',
        '  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}',
        '  m_LocalPosition: {x: 0, y: 0, z: 0}',
        '  m_LocalScale: {x: 1, y: 1, z: 1}',
        '  m_Children: []',
        '  m_Father: {fileID: 111}',
        '--- !u!1 &120',
        'GameObject:',
        '  m_Name: old',
        '  m_IsActive: 1',
        '--- !u!4 &121',
        'Transform:',
        '  m_GameObject: {fileID: 120}',
        '  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}',
        '  m_LocalPosition: {x: 1, y: 0, z: 0}',
        '  m_LocalScale: {x: 1, y: 1, z: 1}',
        '  m_Children: []',
        '  m_Father: {fileID: 101}',
        '--- !u!111 &122',
        'Animation:',
        '  m_GameObject: {fileID: 120}',
        '  m_Animations:',
        `  - {fileID: 7400000, guid: ${X.legacy}, type: 2}`,
        '  - {fileID: 7400000, guid: 00000000000000000000000000000bad, type: 2}',
      ].join('\n') +
      '\n',
    X.prefab,
  );
  // The base controller: layer 1 — Show (a clip stored in the controller), Blend (a BlendTree), a
  // sub-state machine with Model (a clip of a model file) and Swap (overridden); layer 2 — Pulse.
  write(
    root,
    'Assets/Extra/Base.controller',
    HEAD +
      [
        '--- !u!91 &9100000',
        'AnimatorController:',
        '  m_Name: Base',
        '  m_AnimatorParameters: []',
        '  m_AnimatorLayers:',
        '  - serializedVersion: 5',
        '    m_Name: Base Layer',
        '    m_StateMachine: {fileID: 1107001}',
        '  - serializedVersion: 5',
        '    m_Name: Overlay',
        '    m_StateMachine: {fileID: 1107002}',
        '--- !u!1107 &1107001',
        'AnimatorStateMachine:',
        '  m_ChildStates:',
        '  - serializedVersion: 1',
        '    m_State: {fileID: 1}',
        '  - serializedVersion: 1',
        '    m_State: {fileID: 2}',
        '  m_ChildStateMachines:',
        '  - serializedVersion: 1',
        '    m_StateMachine: {fileID: 1107003}',
        '  m_AnyStateTransitions: []',
        '  m_EntryTransitions:',
        '  - {fileID: 21}',
        '  m_DefaultState: {fileID: 1}',
        '--- !u!1107 &1107003',
        'AnimatorStateMachine:',
        '  m_ChildStates:',
        '  - serializedVersion: 1',
        '    m_State: {fileID: 3}',
        '  - serializedVersion: 1',
        '    m_State: {fileID: 4}',
        '  m_ChildStateMachines: []',
        '--- !u!1107 &1107002',
        'AnimatorStateMachine:',
        '  m_ChildStates:',
        '  - serializedVersion: 1',
        '    m_State: {fileID: 5}',
        '--- !u!1102 &1',
        'AnimatorState:',
        '  m_Name: Show',
        '  m_Speed: 1',
        '  m_Transitions:',
        '  - {fileID: 22}',
        '  m_Motion: {fileID: 7400001}',
        '--- !u!1102 &2',
        'AnimatorState:',
        '  m_Name: Blend',
        '  m_Speed: 1',
        '  m_Transitions: []',
        '  m_Motion: {fileID: 20600000}',
        '--- !u!1102 &3',
        'AnimatorState:',
        '  m_Name: Model',
        '  m_Speed: 1',
        '  m_Transitions: []',
        `  m_Motion: {fileID: 7400000, guid: ${X.model}, type: 3}`,
        '--- !u!1102 &4',
        'AnimatorState:',
        '  m_Name: Swap',
        '  m_Speed: 1',
        '  m_Transitions: []',
        `  m_Motion: {fileID: 7400000, guid: ${X.orig}, type: 2}`,
        '--- !u!1102 &5',
        'AnimatorState:',
        '  m_Name: Show',
        '  m_Speed: 1',
        '  m_Transitions: []',
        '  m_Motion: {fileID: 7400001}',
        '--- !u!1109 &21',
        'AnimatorTransition:',
        '  m_Conditions: []',
        '  m_DstStateMachine: {fileID: 1107003}',
        '--- !u!1101 &22',
        'AnimatorStateTransition:',
        '  m_Conditions:',
        '  - m_ConditionMode: 6',
        '    m_ConditionEvent: Mode',
        '    m_EventTreshold: 2',
        '  m_DstState: {fileID: 0}',
        '  m_IsExit: 1',
        '  m_TransitionDuration: 0.5',
        '  m_HasFixedDuration: 0',
        '  m_HasExitTime: 0',
        '  m_Mute: 1',
        '--- !u!206 &20600000',
        'BlendTree:',
        '  m_Name: Moves',
        // The clip stored in the controller: a 9-slice size, colour channels keyed apart, two alphas, m_StartTime.
        animYaml({
          name: 'show',
          stop: 1.5,
          floats: [
            floatCurve('m_SizeDelta.x', 'card', 224, [{ t: 0.5, v: 100 }, { t: 1.5, v: 200 }]),
            floatCurve('m_Color.r', 'card', 114, [{ t: 0.5, v: 1 }, { t: 1.5, v: 0 }], G.image),
            floatCurve('m_Color.g', 'card', 114, [{ t: 0.5, v: 1 }, { t: 1, v: 0, o: -2 }, { t: 1.5, v: 1 }], G.image),
            floatCurve('m_Color.a', 'card', 114, [{ t: 0.5, v: 1 }, { t: 1.5, v: 0.5 }], G.image),
            floatCurve('m_Alpha', 'card', 225, [{ t: 0.5, v: 0 }, { t: 1, v: 1 }]),
            floatCurve('m_AnchorMin.x', 'card', 224, [{ t: 0.5, v: 0 }, { t: 1, v: 1 }]),
          ],
        })
          .replace(HEAD, '')
          .replace('--- !u!74 &7400000', '--- !u!74 &7400001')
          .replace('    m_StartTime: 0', '    m_StartTime: 0.5')
          .trimEnd(),
      ].join('\n') +
      '\n',
    X.base,
  );
  write(
    root,
    'Assets/Extra/Extra.overrideController',
    HEAD +
      [
        '--- !u!221 &22100000',
        'AnimatorOverrideController:',
        '  m_Name: Extra',
        `  m_Controller: {fileID: 9100000, guid: ${X.base}, type: 2}`,
        '  m_Clips:',
        `  - m_OriginalClip: {fileID: 7400000, guid: ${X.orig}, type: 2}`,
        `    m_OverrideClip: {fileID: 7400000, guid: ${X.swap}, type: 2}`,
      ].join('\n') +
      '\n',
    X.over,
  );
  write(root, 'Assets/Extra/orig.anim', animYaml({ name: 'orig', stop: 1 }), X.orig);
  write(
    root,
    'Assets/Extra/swap.anim',
    animYaml({
      name: 'swap',
      stop: 1,
      rotation: [
        vecCurve('card/icon', [
          { t: 0, v: [0, 0, 0, 1] },
          { t: 1, v: [s45, 0, 0, s45] },
        ]),
      ],
      floats: [floatCurve('m_Enabled', 'card', 114, [{ t: 0, v: 1, i: INF, o: INF }, { t: 0.5, v: 0, i: INF, o: INF }], G.image)],
      pptr: [
        `  - curve:\n    - time: 0\n      value: {fileID: 0}\n    - time: 0.25\n      value: {fileID: 21300000, guid: ${X.single}, type: 3}\n    - time: 0.5\n      value: {fileID: 21300000, guid: 0000000000000000000000000000dead, type: 3}\n    attribute: m_Sprite\n    path: card\n    classID: 114\n    script: {fileID: 11500000, guid: ${G.image}, type: 3}`,
        `  - curve:\n    - time: 0\n      value: {fileID: 2100000, guid: ${X.single}, type: 2}\n    attribute: m_Material\n    path: card\n    classID: 114\n    script: {fileID: 0}`,
      ],
      events: [
        '  - time: 0.2\n    functionName: \n    data: \n    floatParameter: 0\n    intParameter: 0',
        '  - time: 5\n    functionName: late\n    data: \n    floatParameter: 0\n    intParameter: 3',
        `  - time: 0.3\n    functionName: spawn\n    data: \n    objectReferenceParameter: {fileID: 100100000, guid: ${X.prefab}, type: 3}\n    floatParameter: 0\n    intParameter: 0`,
      ],
    }),
    X.swap,
  );
  const legacy = animYaml({ name: 'legacy', stop: 1, floats: [floatCurve('m_LocalPosition.x', '', 4, [{ t: 0, v: 1 }, { t: 1, v: 2 }])] })
    .replace('  m_Legacy: 0', '  m_Legacy: 1')
    .replace('  m_WrapMode: 0', '  m_WrapMode: 2');
  write(root, 'Assets/Extra/legacy.anim', legacy, X.legacy);
  write(root, 'Assets/Extra/model.fbx', 'binary', X.model);
  write(root, 'Assets/Extra/single.png', 'png', X.single, 'TextureImporter:\n  spriteMode: 1\n');
}

describe('anim-import: override controllers, layers, embedded clips, legacy, 9-slice size, odd curves', () => {
  const EXTRA = join(tmp, 'Extra');
  extrasProject(EXTRA);
  const scene = write(
    tmp,
    'extra/extra.svg',
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">
  <g id="Extra">
    <image id="card" href="card.png" width="100" height="50" data-slices="8">
    </image>
    <g id="icon"/>
    <g id="old" transform="translate(100 0)"/>
  </g>
</svg>`,
  );
  const r = importAnim({ inputs: [join(EXTRA, 'Assets/Extra/Extra.prefab'), join(EXTRA, 'Assets/Extra/orig.anim')], scene });
  const extra = r.groups.find((g) => g.name === 'Extra_Extra')!;

  it('the override controller over its base: states of both layers and sub-state machines, swapped clips, what is not read', () => {
    expect(r.groups.map((g) => [g.name, g.kind])).toEqual([
      ['Extra_Extra', 'prefab'],
      ['Extra_old', 'prefab'],
      ['orig', 'clip'],
    ]);
    expect(extra.clips.map((c) => [c.clip, c.state, c.layer])).toEqual([
      ['Show', 'Show', 'Base Layer'],
      ['Swap', 'Swap', 'Base Layer'],
      ['Show_2', 'Show', 'Overlay'],
    ]);
    const notes = extra.notes.join('\n');
    expect(notes).toMatch(/Apply Root Motion is on/);
    expect(notes).toMatch(/override controller over Assets\/Extra\/Base\.controller: 1 clip\(s\) swapped/);
    expect(notes).toMatch(/layers: Base Layer, Overlay/);
    expect(notes).toMatch(/state Blend: BlendTree "Moves" — not transferred/);
    expect(notes).toMatch(/state Model: the clip is inside Assets\/Extra\/model\.fbx/);
    expect(extra.transitions).toEqual(['Show → Exit: Mode == 2; blend 0.5 (normalized); muted', 'Entry → #1107003 (state machine): no condition']);
    expect(clipOf(r, 'Extra_Extra', 'Show').source).toBe('Assets/Extra/Base.controller#7400001');
    expect(clipOf(r, 'Extra_Extra', 'Show_2').notes).toContain('layer Overlay: Unity plays it over the base layer');
    expect(r.groups[1].notes.join('\n')).toMatch(/legacy Animation component[\s\S]*clip 00000000000000000000000000000bad not found/);
  });

  it('a 9-slice node animates width; channels keyed apart are baked; CanvasGroup × colour alpha; m_StartTime moves the keys', () => {
    const show = extra.convs[0];
    expect(show.duration).toBe(1);
    const w = show.columns.find((c) => c.col === 'width')!;
    expect(w.keys.map((k) => [k.t, k.v])).toEqual([
      [0, 100],
      [1, 200],
    ]);
    expect(itemOf(r, 'Extra_Extra', 'Show', 'card', 'm_Color.r').notes.join(' ')).toMatch(/tint: \d+ segment\(s\) baked/);
    expect(itemOf(r, 'Extra_Extra', 'Show', 'card', 'm_Color.r').notes.join(' ')).toMatch(/tints the images of the node's subtree/);
    expect(itemOf(r, 'Extra_Extra', 'Show', 'card', 'm_Alpha').notes.join(' ')).toMatch(/CanvasGroup alpha × colour alpha: multiplied/);
    expect(itemOf(r, 'Extra_Extra', 'Show', 'card', 'm_AnchorMin').cls).toBe('hard');
    expect(clipOf(r, 'Extra_Extra', 'Show').notes).toContain('m_StartTime 0.5: times moved to start at 0');
    expect(clipOf(r, 'Extra_Extra', 'Show').verification?.converged).toBe(true);
    expect(extra.verifiedOn).toBe('scene');
  });

  it('m_Enabled of an Image → alpha; a tilted quaternion → its projection; odd events and sprites are reported', () => {
    const swap = clipOf(r, 'Extra_Extra', 'Swap');
    expect(swap.source).toBe('Assets/Extra/swap.anim');
    expect(itemOf(r, 'Extra_Extra', 'Swap', 'card', 'm_Enabled').notes.join(' ')).toMatch(/m_Enabled of the renderer as alpha/);
    const tilt = itemOf(r, 'Extra_Extra', 'Swap', 'card/icon', 'm_LocalRotation');
    expect(tilt.cls).toBe('manual');
    expect(tilt.columns).toEqual(['rotation', 'scaleX', 'scaleY']);
    expect(swap.notes).toEqual(expect.arrayContaining(['an event at 0.2 s has no function name — left out', 'event late at 5 s is outside the clip — moved to 1 s', 'event parameters are not carried by $events (listed per event)']));
    expect(swap.events.map((e) => [e.name, e.params])).toEqual([
      ['late', 'int 3'],
      ['spawn', `object ${X.prefab}:100100000`],
    ]);
    const tex = extra.convs[1].columns.find((c) => c.col === 'tex')!;
    expect(tex.keys.map((k) => k.v)).toEqual(['none', 'single', '00000000_21300000']);
    const spr = itemOf(r, 'Extra_Extra', 'Swap', 'card', 'm_Sprite');
    expect(spr.notes.join(' ')).toMatch(/a key with no sprite[\s\S]*not found in the project/);
    expect(itemOf(r, 'Extra_Extra', 'Swap', 'card', 'm_Material').cls).toBe('hard');
    expect(swap.verification?.converged).toBe(true);
  });

  it('a legacy clip: wrap mode reported; the loose clip with no curves still writes and compiles', () => {
    const legacy = clipOf(r, 'Extra_old', 'legacy');
    expect(legacy.notes.join(' ')).toMatch(/legacy clip \(m_Legacy\).*wrap mode 2 not carried/);
    expect(legacy.cls).toBe('manual');
    expect(legacy.verification?.converged).toBe(true);
    const orig = r.groups[2];
    expect(orig.md).toContain('# $clip orig');
    expect(orig.json).not.toBe(null);
  });

  it('without the 9-slice scene the size is hard', () => {
    const plain = importAnim({ inputs: [join(EXTRA, 'Assets/Extra/Extra.prefab')], verify: false });
    expect(itemOf(plain, 'Extra_Extra', 'Show', 'card', 'm_SizeDelta').cls).toBe('hard');
    expect(plain.clips.every((c) => !c.verification)).toBe(true);
  });
});

describe('anim-import: the CLI', () => {
  it('writes the outputs and exits 0', () => {
    const out = join(tmp, 'cli');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(main([PROJECT, '--out', out, '--ppu', '50', '--points', '20'])).toBe(0);
    expect(log.mock.calls[0][0]).toMatch(/^trempel-anim-import: 2 md, 4 clips \(auto 0, manual 3, hard 1\), verification 4\/4 converged/);
    expect(existsSync(join(out, 'Hero.anim.md'))).toBe(true);
    expect(readFileSync(join(out, 'Hero.anim.md'), 'utf8')).toContain('| 1 | 25 |');
    expect(main(['--help'])).toBe(0);
    log.mockRestore();
    warn.mockRestore();
  });

  it('usage and input errors exit 2 with a code; a broken clip is E_ANIM_IMPORT_CLIP', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const codes = (args: string[]): string => {
      err.mockClear();
      expect(main(args)).toBe(2);
      return String(err.mock.calls[0][0]).split(':')[0];
    };
    expect(codes([PROJECT])).toBe('E_ANIM_IMPORT_USAGE');
    expect(codes(['--out', 'x'])).toBe('E_ANIM_IMPORT_USAGE');
    expect(codes([PROJECT, '--out', 'x', '--bogus'])).toBe('E_ANIM_IMPORT_USAGE');
    expect(codes([PROJECT, '--out', 'x', '--ppu', '0'])).toBe('E_ANIM_IMPORT_USAGE');
    expect(codes([PROJECT, '--out', 'x', '--verify', 'maybe'])).toBe('E_ANIM_IMPORT_USAGE');
    expect(codes([PROJECT, '--out', 'x', '--tex', 'art/x.png'])).toBe('E_ANIM_IMPORT_USAGE');
    expect(codes([join(PROJECT, 'nope.anim'), '--out', 'x'])).toBe('E_ANIM_IMPORT_INPUT');
    expect(codes([join(PROJECT, 'Assets/Art/hero.png'), '--out', 'x'])).toBe('E_ANIM_IMPORT_INPUT');
    expect(codes([PROJECT, '--out', 'x', '--scene', join(tmp, 'none.svg')])).toBe('E_ANIM_IMPORT_SCENE');
    const broken = write(PROJECT, 'Assets/Broken/broken.anim', 'this is not YAML');
    expect(codes([broken, '--out', join(tmp, 'b')])).toBe('E_ANIM_IMPORT_CLIP');
    const notClip = write(PROJECT, 'Assets/Broken/other.anim', HEAD + '--- !u!1 &1\nGameObject:\n  m_Name: x\n');
    expect(codes([notClip, '--out', join(tmp, 'b')])).toBe('E_ANIM_IMPORT_CLIP');
    const emptyClip = write(PROJECT, 'Assets/Broken/empty.anim', HEAD + '--- !u!74 &7400000\nAnimationClip:\n  m_Name: empty\n');
    expect(codes([emptyClip, '--out', join(tmp, 'b')])).toBe('E_ANIM_IMPORT_CLIP');
    rmSync(join(PROJECT, 'Assets/Broken'), { recursive: true });
    err.mockRestore();
  });
});

// ── corpus (local only) ────────────────────────────────────────────────────────────────────────────

const CORPUS = process.env.TREMPEL_UNITY_CORPUS;

describe.skipIf(!CORPUS)('anim-import: corpus (TREMPEL_UNITY_CORPUS)', () => {
  it('imports every Unity project of the corpus without crashing; the counts are reported', { timeout: 30 * 60_000 }, () => {
    const projects = readdirSync(CORPUS!)
      .map((n) => join(CORPUS!, n))
      .filter((p) => statSync(p).isDirectory());
    const found = projects.flatMap((p) => (existsSync(join(p, 'Assets')) ? [p] : readdirSync(p).map((n) => join(p, n)).filter((q) => existsSync(join(q, 'Assets')))));
    for (const p of found) {
      const r = importAnim({ inputs: [p], points: 20 });
      const c = counts(r.clips);
      const v = verifyCounts(r.clips);
      expect(c.total).toBe(c.auto + c.manual + c.hard);
      console.log(`${p}: ${c.total} clips (auto ${c.auto}, manual ${c.manual}, hard ${c.hard}), ${v.converged}/${v.checked} converged`);
    }
  });
});
