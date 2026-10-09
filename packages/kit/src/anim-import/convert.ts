// convert.ts — one Unity clip → md clip columns per target, the expected Trempel values (for the
// verification) and the report items.
//
// Units: Transform positions — world units × ppu; RectTransform (anchored or local position) —
// canvas pixels × uiScale; y-up → y-down (−y); Z rotation CCW degrees → Trempel clockwise (−z).
// x / y / rotation are OFFSETS from the rest pose, scale a MULTIPLIER of it; the rest pose comes from
// the prefab's Transform / RectTransform, else the scene node, else the clip's value at 0 (reported).
// alpha and tint are absolute: alpha = CanvasGroup m_Alpha × colour alpha × m_IsActive × m_Enabled
// (the ones the clip does not animate at their prefab values); tint = the colour's r g b.
// A rotation about X / Y (a card flip) is approximated by its orthographic projection: rotation +
// scaleX / scaleY of the projected axes (the shear it may leave is dropped and reported).

import { hexColor, heldKeys, bakeTimes, easeOfCubic, type ColKey, type EaseOut } from '../clip-import/index.js';
import type { UGameObject } from '../fx-import/project.js';
import { map, num, type Ref, type YamlMap } from '../fx-import/yaml.js';
import type { Binding, PBinding, UClip } from './clip.js';
import { bakedKeys, constantSeg, curveKeys, evalCurve, flatCurve, near, sameCurve, segmentCubic, unwrapped, weightedSeg, type BakeOpts, type UCurve } from './curve.js';

export type Cls = 'auto' | 'manual' | 'hard';

/** What the verification compares: the Trempel value of a column at t, from Unity's own evaluation. */
export type Expect =
  | { kind: 'num'; f: (t: number) => number }
  | { kind: 'tint'; f: (t: number) => [number, number, number] }
  | { kind: 'tex'; f: (t: number) => string };

export interface ColumnOut {
  target: string;
  col: string;
  keys: ColKey[];
  expect: Expect;
}

export interface PropItem {
  path: string;
  target: string | null;
  /** Unity attributes (m_LocalPosition.x, m_Color.a…). */
  attributes: string[];
  /** Trempel columns written. */
  columns: string[];
  cls: Cls;
  notes: string[];
  /** Weighted tangents: 'manual' unless the verification shows the columns exact. */
  weighted?: boolean;
}

export interface EventOut {
  t: number;
  name: string;
  /** Parameters Unity passes (not carried by `$events`). */
  params?: string;
}

export interface ClipConv {
  name: string;
  duration: number;
  loop: boolean;
  columns: ColumnOut[];
  events: EventOut[];
  items: PropItem[];
  notes: string[];
}

/** The rest pose and the appearance of a GameObject in its prefab (Unity units). */
export interface RestInfo {
  rect: boolean;
  pos: V3;
  anch: { x: number; y: number };
  size: { x: number; y: number };
  /** RectTransform anchors together (the size delta is the size). */
  anchorsTogether: boolean;
  quat: { x: number; y: number; z: number; w: number };
  euler: V3 | null;
  scale: V3;
  /** SpriteRenderer / Graphic colour (0..1). */
  color: [number, number, number, number] | null;
  groupAlpha: number | null;
  active: boolean;
  hasChildren: boolean;
}

/** A scene node's rest pose (Trempel units: px, radians). */
export interface SceneRest {
  x: number;
  y: number;
  rotation: number;
  sx: number;
  sy: number;
  /** An <image data-slices> (9-slice): width / height can be animated. */
  slices: boolean;
}

interface V3 {
  x: number;
  y: number;
  z: number;
}

export interface ConvertCtx {
  ppu: number;
  uiScale: number;
  fps: number;
  /** Path → target id; null — not matched (the path's curves are left out). */
  idOf(path: string): string | null;
  /** Has a prefab (rest poses can come from it). */
  prefab: boolean;
  /** The prefab's GameObject of a path (null — not found / no prefab). */
  goOf(path: string): UGameObject | null;
  sceneRest(id: string): SceneRest | null;
  /** The texture name of a sprite reference. */
  sprite(r: Ref | null): { name: string; note?: string };
  /** tex name → href (the md's `$tex`). */
  href(name: string): string;
  scriptName(guid: string | undefined): string;
}

const BAKE_TOL = { pos: 0.1, rot: 0.1, scale: 0.0005, alpha: 0.002, tint: 0.25 / 255 };

const v3 = (v: unknown, d = 0): V3 => {
  const m = map(v as YamlMap);
  return { x: num(m.x, d), y: num(m.y, d), z: num(m.z, d) };
};

/** The rest pose of a prefab GameObject. */
export function restOf(go: UGameObject): RestInfo {
  const t = go.transform?.body ?? {};
  const rect = go.transform?.type === 'RectTransform';
  const q = map(t.m_LocalRotation);
  const hint = t.m_LocalEulerAnglesHint;
  let color: RestInfo['color'] = null;
  let groupAlpha: number | null = null;
  for (const c of go.components) {
    if (c.type === 'CanvasGroup') groupAlpha = num(c.body.m_Alpha, 1);
    else if ((c.type === 'SpriteRenderer' || c.type === 'MonoBehaviour') && c.body.m_Color && !color) {
      const m = map(c.body.m_Color);
      color = [num(m.r, 1), num(m.g, 1), num(m.b, 1), num(m.a, 1)];
    }
  }
  const amin = v3(t.m_AnchorMin);
  const amax = v3(t.m_AnchorMax);
  return {
    rect,
    pos: v3(t.m_LocalPosition),
    anch: { x: num(map(t.m_AnchoredPosition).x), y: num(map(t.m_AnchoredPosition).y) },
    size: { x: num(map(t.m_SizeDelta).x), y: num(map(t.m_SizeDelta).y) },
    anchorsTogether: amin.x === amax.x && amin.y === amax.y,
    quat: { x: num(q.x), y: num(q.y), z: num(q.z), w: num(q.w, 1) },
    euler: hint ? v3(hint) : null,
    scale: v3(t.m_LocalScale, 1),
    color,
    groupAlpha,
    active: go.active,
    hasChildren: go.children.length > 0,
  };
}

// ── 3D rotation → 2D ──────────────────────────────────────────────────────────────────────────────

type M3 = number[]; // row-major 3×3

const mul3 = (A: M3, B: M3): M3 => {
  const r: number[] = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r.push(A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j]);
  return r;
};
const RAD = Math.PI / 180;

/** Unity's Euler order: Z first, then X, then Y (M = Ry · Rx · Rz). */
export function eulerMatrix(x: number, y: number, z: number): M3 {
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(x * RAD), Math.sin(x * RAD), Math.cos(y * RAD), Math.sin(y * RAD), Math.cos(z * RAD), Math.sin(z * RAD)];
  const Rx = [1, 0, 0, 0, cx, -sx, 0, sx, cx];
  const Ry = [cy, 0, sy, 0, 1, 0, -sy, 0, cy];
  const Rz = [cz, -sz, 0, sz, cz, 0, 0, 0, 1];
  return mul3(Ry, mul3(Rx, Rz));
}

export function quatMatrix(x: number, y: number, z: number, w: number): M3 {
  const n = Math.hypot(x, y, z, w) || 1;
  x /= n;
  y /= n;
  z /= n;
  w /= n;
  return [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)];
}

/** The orthographic projection of a rotation on the screen (y down): Trempel rotation (deg), scale of the axes, shear. */
export function project(M: M3): { deg: number; sx: number; sy: number; shear: number } {
  // Screen matrix S = F · L · F (F = diag(1, −1)), L — the XY block of M.
  const a = M[0];
  const b = -M[3];
  const c = -M[1];
  const d = M[4];
  const sx = Math.hypot(a, b);
  if (sx < 1e-12) return { deg: 0, sx: 0, sy: Math.hypot(c, d), shear: 0 };
  const sy = (a * d - b * c) / sx;
  return { deg: Math.atan2(b, a) / RAD, sx, sy, shear: Math.abs((a * c + b * d) / sx) };
}

// ── conversion ────────────────────────────────────────────────────────────────────────────────────

const POS = 'm_LocalPosition.';
const EULER = ['localEulerAnglesRaw.', 'localEulerAngles.', 'm_LocalEulerAngles.', 'localEulerAnglesBaked.', 'm_LocalEulerAnglesHint.'];
const TEXT_SCRIPTS = /^(Text|TextMeshProUGUI|TextMeshPro|TMP_Text)$/;
/** UI renderers whose m_Enabled shows / hides them. */
const GRAPHICS = /^(Image|RawImage|Text|TextMeshProUGUI|TextMeshPro|SVGImage)$/;

/** Convert a clip. `name` — the md clip's name. */
export function convertClip(clip: UClip, name: string, ctx: ConvertCtx): ClipConv {
  const D = clip.duration;
  const out: ClipConv = { name, duration: D, loop: clip.loop, columns: [], events: [], items: [], notes: [...clip.notes] };
  if (clip.legacy) out.notes.push(`legacy clip (m_Legacy): played by the Animation component${clip.wrapMode ? `, wrap mode ${clip.wrapMode} not carried (clamped)` : ''}`);
  else if (clip.wrapMode) out.notes.push(`m_WrapMode ${clip.wrapMode}: not carried (the clip holds its ends; $loop from m_LoopTime)`);
  const opts = (tol: number): BakeOpts => ({ duration: D, fps: ctx.fps, tol });

  const paths = [...new Set([...clip.floats.map((b) => b.path), ...clip.pptr.map((b) => b.path)])];
  for (const path of paths) {
    const target = ctx.idOf(path);
    const floats = clip.floats.filter((b) => b.path === path);
    const pptr = clip.pptr.filter((b) => b.path === path);
    if (target === null) {
      const attrs = [...floats, ...pptr].map((b) => b.attribute);
      out.items.push({ path, target: null, attributes: attrs, columns: [], cls: 'hard', notes: ['the path is not matched to a scene node (fill its id in anim-map.md, then --map)'] });
      continue;
    }
    convertTarget(path, target, floats, pptr, ctx, D, opts, out);
  }

  for (const e of clip.events) {
    const params = [e.data && `data "${e.data}"`, e.float && `float ${e.float}`, e.int && `int ${e.int}`, e.object && `object ${e.object.guid ?? ''}:${e.object.fileID}`].filter(Boolean).join(', ');
    if (!e.name) {
      out.notes.push(`an event at ${e.t} s has no function name — left out`);
      continue;
    }
    let t = e.t;
    if (t < 0 || t > D) {
      out.notes.push(`event ${e.name} at ${e.t} s is outside the clip — moved to ${t < 0 ? 0 : D} s`);
      t = Math.min(Math.max(t, 0), D);
    }
    out.events.push({ t, name: e.name, params: params || undefined });
  }
  if (out.events.some((e) => e.params)) out.notes.push('event parameters are not carried by $events (listed per event)');
  return out;
}

function convertTarget(path: string, target: string, floats: Binding[], pptr: PBinding[], ctx: ConvertCtx, D: number, opts: (tol: number) => BakeOpts, out: ClipConv): void {
  const go = ctx.goOf(path);
  const rest = go ? restOf(go) : null;
  const scene = ctx.sceneRest(target);
  const pathNote = ctx.prefab && !go ? 'the path is not in the prefab' : '';
  const used = new Set<Binding>();
  const take = (pred: (b: Binding) => boolean): Binding[] => {
    const r = floats.filter((b) => !used.has(b) && pred(b));
    for (const b of r) used.add(b);
    return r;
  };
  const one = (bs: Binding[], suffix: string): Binding | undefined => bs.find((b) => b.attribute.endsWith(suffix));
  const isTransform = (b: Binding): boolean => b.classID === 4 || b.classID === 224;
  const rect = rest ? rest.rect : floats.some((b) => b.classID === 224);
  const item = (attrs: Binding[] | string[], cls: Cls = 'auto'): PropItem => {
    const it: PropItem = { path, target, attributes: attrs.map((a) => (typeof a === 'string' ? a : a.attribute)), columns: [], cls, notes: pathNote ? [pathNote] : [] };
    out.items.push(it);
    return it;
  };
  const manual = (it: PropItem, note: string): void => {
    it.notes.push(note);
    if (it.cls === 'auto') it.cls = 'manual';
  };
  const add = (it: PropItem, col: string, keys: ColKey[], expect: Expect): void => {
    if (!keys.length) return;
    it.columns.push(col);
    out.columns.push({ target, col, keys, expect });
  };
  const affine = (it: PropItem, col: string, c: UCurve, a: number, b: number, tol: number): void => {
    const info = curveKeys(c, a, b, opts(tol));
    if (info.weighted) it.weighted = true;
    if (info.baked) it.notes.push(`${col}: ${info.baked} segment(s) with no Trempel ease baked into linear keys`);
    if (info.weighted) it.notes.push(`${col}: ${info.weighted} segment(s) with weighted tangents (converted as their cubic)`);
    add(it, col, info.keys, { kind: 'num', f: (t) => a * evalCurve(c, t) + b });
  };
  const restNote = (it: PropItem, what: string, src: 'prefab' | 'scene' | 'first key'): void => {
    if (src === 'first key') manual(it, `rest pose unknown, taken from the first key (${what})`);
    else if (src === 'scene') it.notes.push(`rest ${what} from the scene node`);
  };
  const moving = (b: Binding | undefined, restV: number): b is Binding => !!b && !(flatCurve(b.curve) && Math.abs((b.curve.keys[0]?.v ?? restV) - restV) < 1e-9);

  // ── position ──
  const anch = take((b) => isTransform(b) && b.attribute.startsWith('m_AnchoredPosition.'));
  const pos = take((b) => isTransform(b) && b.attribute.startsWith(POS));
  const posFrom = anch.some((b) => !b.attribute.endsWith('.z')) ? anch : pos;
  if (anch.length && pos.length) {
    const it = item(pos, 'hard');
    it.notes.push('m_LocalPosition and m_AnchoredPosition both animated — the anchored position is used');
  }
  if (posFrom.length) {
    const anchored = posFrom === anch;
    const unit = anchored || rect ? ctx.uiScale : ctx.ppu;
    const it = item(posFrom);
    it.notes.push(anchored ? `anchored position × ${ctx.uiScale} (canvas px)` : `${rect ? 'local position (RectTransform) ×' : 'world units ×'} ${unit}`);
    for (const axis of ['x', 'y'] as const) {
      const b = one(posFrom, `.${axis}`);
      if (!b) continue;
      let r: number;
      let src: 'prefab' | 'scene' | 'first key';
      if (rest) {
        r = anchored ? rest.anch[axis] : rest.pos[axis];
        src = 'prefab';
      } else if (scene) {
        r = axis === 'x' ? scene.x / unit : -scene.y / unit;
        src = 'scene';
      } else {
        r = evalCurve(b.curve, 0);
        src = 'first key';
      }
      if (!moving(b, r)) continue;
      restNote(it, axis, src);
      if (src === 'scene') manual(it, 'the rest position from the scene assumes Unity local coordinates × the unit');
      // x: (v − r)·unit; y: −(v − r)·unit.
      const s = axis === 'x' ? unit : -unit;
      affine(it, axis, b.curve, s, -s * r, BAKE_TOL.pos);
    }
    const z = one(posFrom, '.z');
    if (z && !flatCurve(z.curve)) it.notes.push('z animated — ignored (no depth in 2D)');
  }

  // ── size ──
  const size = take((b) => isTransform(b) && b.attribute.startsWith('m_SizeDelta.'));
  if (size.length) {
    const it = item(size);
    if (!scene?.slices) {
      it.cls = 'hard';
      it.notes.push('m_SizeDelta: Trempel animates width / height only on a 9-slice <image data-slices> or a resizable prefab instance — not converted');
    } else if (rest && !rest.anchorsTogether) {
      it.cls = 'hard';
      it.notes.push('m_SizeDelta with stretched anchors is not the size — not converted');
    } else {
      if (!rest) manual(it, 'anchors unknown (no prefab): the size delta is taken as the size');
      for (const [axis, col] of [['x', 'width'], ['y', 'height']] as const) {
        const b = one(size, `.${axis}`);
        if (b) affine(it, col, b.curve, ctx.uiScale, 0, BAKE_TOL.pos);
      }
    }
  }

  // ── rotation ──
  const eulerAll = take((b) => isTransform(b) && EULER.some((p) => b.attribute.startsWith(p)));
  const family = EULER.find((p) => eulerAll.some((b) => b.attribute.startsWith(p)));
  const euler = eulerAll.filter((b) => b.attribute.startsWith(family ?? '-'));
  const quat = take((b) => isTransform(b) && b.attribute.startsWith('m_LocalRotation.'));
  const scaleB = take((b) => isTransform(b) && b.attribute.startsWith('m_LocalScale.'));
  let flat3D: ((t: number) => { deg: number; sx: number; sy: number; shear: number }) | null = null;
  let restProj = { deg: 0, sx: 1, sy: 1, shear: 0 };
  let rotItem: PropItem | null = null;
  const restQuat = rest?.quat ?? null;
  const restEuler: V3 | null = rest ? (rest.euler ?? quatEuler(rest.quat)) : null;
  if (euler.length || quat.length) {
    rotItem = item(euler.length ? euler : quat);
    if (euler.length && quat.length) rotItem.notes.push('m_LocalRotation curves duplicate the Euler curves — the Euler curves are used');
    const ex = one(euler, '.x');
    const ey = one(euler, '.y');
    const ez = one(euler, '.z');
    if (euler.length) {
      const moves0 = (b: Binding | undefined, r: number): boolean => !!b && !(flatCurve(b.curve) && Math.abs(near(b.curve.keys[0]?.v ?? 0, 0)) < 1e-6 && Math.abs(near(r, 0)) < 1e-6);
      const rx = restEuler?.x ?? 0;
      const ry = restEuler?.y ?? 0;
      const tilted = moves0(ex, rx) || moves0(ey, ry) || (!ex && Math.abs(near(rx, 0)) > 1e-6) || (!ey && Math.abs(near(ry, 0)) > 1e-6);
      if (!tilted) {
        if (ez) {
          let r: number;
          let src: 'prefab' | 'scene' | 'first key';
          if (restEuler) {
            r = near(restEuler.z, evalCurve(ez.curve, 0));
            src = 'prefab';
          } else if (scene) {
            r = near(-scene.rotation / RAD, evalCurve(ez.curve, 0));
            src = 'scene';
          } else {
            r = evalCurve(ez.curve, 0);
            src = 'first key';
          }
          if (moving(ez, r)) {
            restNote(rotItem, 'rotation', src);
            affine(rotItem, 'rotation', ez.curve, -1, r, BAKE_TOL.rot);
          }
        }
      } else {
        const at = (b: Binding | undefined, r: number) => (t: number) => (b ? evalCurve(b.curve, t) : r);
        const fx = at(ex, rx);
        const fy = at(ey, ry);
        const fz = at(ez, restEuler?.z ?? 0);
        flat3D = (t) => project(eulerMatrix(fx(t), fy(t), fz(t)));
        restProj = restEuler ? project(eulerMatrix(restEuler.x, restEuler.y, restEuler.z)) : flat3D(0);
        if (!restEuler) restNote(rotItem, 'rotation', 'first key');
      }
    } else {
      const [qx, qy, qz, qw] = (['x', 'y', 'z', 'w'] as const).map((c) => {
        const b = one(quat, `.${c}`);
        const r = restQuat ? restQuat[c] : c === 'w' ? 1 : 0;
        return (t: number) => (b ? evalCurve(b.curve, t) : r);
      });
      const planar = [one(quat, '.x'), one(quat, '.y')].every((b) => !b || (flatCurve(b.curve) && Math.abs(b.curve.keys[0]?.v ?? 0) < 1e-6)) && (!restQuat || (Math.abs(restQuat.x) < 1e-6 && Math.abs(restQuat.y) < 1e-6));
      if (planar) {
        // A rotation about Z: the angle of the normalized quaternion, made continuous, baked.
        const deg = unwrapped((t) => (-2 * Math.atan2(qz(t), qw(t))) / RAD, D);
        let r: number;
        let src: 'prefab' | 'scene' | 'first key';
        if (restQuat) {
          r = near((-2 * Math.atan2(restQuat.z, restQuat.w)) / RAD, deg(0));
          src = 'prefab';
        } else if (scene) {
          r = near(scene.rotation / RAD, deg(0));
          src = 'scene';
        } else {
          r = deg(0);
          src = 'first key';
        }
        restNote(rotItem, 'rotation', src);
        const f = (t: number): number => deg(t) - r;
        const keys = bakedKeys(quat.map((b) => b.curve), f, opts(BAKE_TOL.rot));
        rotItem.notes.push(`quaternion curves: the Z angle baked into ${keys.length} key(s)`);
        add(rotItem, 'rotation', keys, { kind: 'num', f });
      } else {
        flat3D = (t) => project(quatMatrix(qx(t), qy(t), qz(t), qw(t)));
        restProj = restQuat ? project(quatMatrix(restQuat.x, restQuat.y, restQuat.z, restQuat.w)) : flat3D(0);
        if (!restQuat) restNote(rotItem, 'rotation', 'first key');
      }
    }
    if (flat3D) {
      const proj = flat3D;
      manual(rotItem, '3D rotation (about X / Y) approximated by its orthographic projection: rotation + scaleX / scaleY');
      const deg = unwrapped((t) => proj(t).deg, D);
      const r = near(restProj.deg, deg(0));
      const f = (t: number): number => deg(t) - r;
      const sources = [...euler, ...quat].map((b) => b.curve);
      add(rotItem, 'rotation', bakedKeys(sources, f, opts(BAKE_TOL.rot)), { kind: 'num', f });
      let shear = 0;
      for (let i = 0; i <= 200; i++) shear = Math.max(shear, proj((D * i) / 200).shear);
      if (shear > 0.01) rotItem.notes.push(`the projection's shear (up to ${Math.round(shear * 100)}% of the size) is dropped`);
      if (Math.abs(restProj.sx) < 1e-6 || Math.abs(restProj.sy) < 1e-6) {
        rotItem.cls = 'hard';
        rotItem.notes.push('the rest pose is edge-on (a zero projected scale): the scale cannot be a multiplier of it');
        flat3D = null;
      }
    }
  }

  // ── scale ──
  if (scaleB.length || flat3D) {
    const it = scaleB.length ? item(scaleB) : rotItem!;
    const bx = one(scaleB, '.x');
    const by = one(scaleB, '.y');
    let rx: number;
    let ry: number;
    let src: 'prefab' | 'scene' | 'first key';
    if (rest) {
      [rx, ry, src] = [rest.scale.x, rest.scale.y, 'prefab'];
    } else if (scene && (bx || by)) {
      [rx, ry, src] = [scene.sx, scene.sy, 'scene'];
    } else {
      [rx, ry, src] = [bx ? evalCurve(bx.curve, 0) : 1, by ? evalCurve(by.curve, 0) : 1, bx || by ? 'first key' : 'prefab'];
    }
    if ((bx && rx === 0) || (by && ry === 0)) {
      it.cls = 'hard';
      it.notes.push('the rest scale is 0: a multiplier of it does not exist — not converted');
    } else if (!flat3D) {
      const mx = moving(bx, rx);
      const my = moving(by, ry);
      if (mx || my) restNote(it, 'scale', src);
      if (mx && my && sameCurve(bx.curve, by.curve) && rx === ry) affine(it, 'scale', bx.curve, 1 / rx, 0, BAKE_TOL.scale);
      else {
        if (mx) affine(it, 'scaleX', bx.curve, 1 / rx, 0, BAKE_TOL.scale);
        if (my) affine(it, 'scaleY', by.curve, 1 / ry, 0, BAKE_TOL.scale);
      }
    } else {
      const proj = flat3D;
      const sx = (t: number): number => (bx ? evalCurve(bx.curve, t) / rx : 1) * (proj(t).sx / restProj.sx);
      const sy = (t: number): number => (by ? evalCurve(by.curve, t) / ry : 1) * (proj(t).sy / restProj.sy);
      const sources = [...scaleB, ...euler, ...quat].map((b) => b.curve);
      if (scaleB.length) restNote(it, 'scale', src);
      if (it !== rotItem) manual(it, 'combined with the projection of a 3D rotation');
      add(it, 'scaleX', bakedKeys(sources, sx, opts(BAKE_TOL.scale)), { kind: 'num', f: sx });
      add(it, 'scaleY', bakedKeys(sources, sy, opts(BAKE_TOL.scale)), { kind: 'num', f: sy });
    }
    const bz = one(scaleB, '.z');
    if (bz && !flatCurve(bz.curve)) it.notes.push('scale z animated — ignored (no depth in 2D)');
  }

  // ── alpha and tint ──
  const colorClass = (b: Binding): boolean => b.classID === 212 || (b.classID === 114 && !!b.script);
  const group = take((b) => b.classID === 225 && b.attribute === 'm_Alpha');
  const color = take((b) => colorClass(b) && /^m_Color\.[rgba]$/.test(b.attribute));
  const active = take((b) => b.classID === 1 && b.attribute === 'm_IsActive');
  const enabled = take((b) => (b.classID === 212 || (b.classID === 114 && GRAPHICS.test(ctx.scriptName(b.script)))) && b.attribute === 'm_Enabled');
  const ca = one(color, '.a');
  const alphaSrc = [...group, ...(ca ? [ca] : []), ...active, ...enabled];
  const scriptName = color[0] ? (color[0].classID === 212 ? 'SpriteRenderer' : ctx.scriptName(color[0].script)) : '';
  if (alphaSrc.length) {
    const it = item(alphaSrc);
    // Factors the clip does not animate, at their prefab values.
    let k = 1;
    if (rest) {
      if (!group.length && rest.groupAlpha !== null) k *= rest.groupAlpha;
      if (!ca && rest.color) k *= rest.color[3];
    }
    if (k !== 1) it.notes.push(`× ${+k.toFixed(4)} (the prefab's alpha the clip does not animate)`);
    const gates = [...active, ...enabled];
    if (active.length) manual(it, 'm_IsActive as alpha 0 / 1 (step): the node stays in the scene (input, layout)');
    if (enabled.length) manual(it, 'm_Enabled of the renderer as alpha 0 / 1 (step): hides the node’s subtree in Trempel');
    if ((ca || enabled.length) && rest?.hasChildren) manual(it, `the ${scriptName || 'renderer'}'s alpha applies to the node's subtree in Trempel (children have their own in Unity)`);
    if (group.length + (ca ? 1 : 0) === 1 && !gates.length) {
      const c = (group[0] ?? ca)!;
      affine(it, 'alpha', c.curve, k, 0, BAKE_TOL.alpha);
    } else {
      const fs = alphaSrc.map((b) => (gates.includes(b) ? (t: number) => (evalCurve(b.curve, t) >= 0.5 ? 1 : 0) : (t: number) => evalCurve(b.curve, t)));
      const f = (t: number): number => fs.reduce((p, g) => p * g(t), k);
      if (group.length + (ca ? 1 : 0) > 1) it.notes.push('CanvasGroup alpha × colour alpha: multiplied');
      add(it, 'alpha', bakedKeys(alphaSrc.map((b) => b.curve), f, opts(BAKE_TOL.alpha)), { kind: 'num', f });
    }
  }
  const rgb = (['r', 'g', 'b'] as const).map((c) => one(color, `.${c}`));
  if (rgb.some(Boolean)) {
    const it = item(color.filter((b) => !b.attribute.endsWith('.a')));
    const restC = rest?.color ?? null;
    if (!restC && rgb.some((b) => !b)) manual(it, 'colour channels the clip does not animate taken as 1 (no prefab)');
    if (TEXT_SCRIPTS.test(scriptName)) manual(it, `tint does not apply to text in Trempel (${scriptName})`);
    else if (rest?.hasChildren) manual(it, `the ${scriptName || 'renderer'}'s colour tints the images of the node's subtree in Trempel`);
    const fs = rgb.map((b, i) => (b ? (t: number) => evalCurve(b.curve, t) : () => restC?.[i] ?? 1));
    const f = (t: number): [number, number, number] => [fs[0](t), fs[1](t), fs[2](t)];
    const { keys, baked, weighted } = tintKeys(rgb.filter((b): b is Binding => !!b).map((b) => b.curve), f, opts(BAKE_TOL.tint));
    if (baked) it.notes.push(`tint: ${baked} segment(s) baked (the channels do not share an ease)`);
    if (weighted) {
      it.weighted = true;
      it.notes.push(`tint: ${weighted} segment(s) with weighted tangents`);
    }
    add(it, 'tint', keys, { kind: 'tint', f });
  }

  // ── sprites ──
  const usedP = new Set<PBinding>();
  const sprites = pptr.filter((b) => (b.classID === 212 || b.classID === 114) && b.attribute === 'm_Sprite');
  if (sprites.length) {
    const b = sprites[0];
    usedP.add(b);
    const it = item([b.attribute]);
    const names = b.keys.map((k) => ({ t: Math.min(Math.max(k.t, 0), D), v: ctx.sprite(k.ref) }));
    for (const n of new Set(names.map((x) => x.v.note).filter(Boolean))) manual(it, n!);
    const keys = heldKeys(names.map((x) => ({ t: x.t, v: x.v.name })));
    const f = (t: number): string => {
      let v = names[0]?.v.name ?? '';
      for (const n of names) if (n.t <= t) v = n.v.name;
      return ctx.href(v);
    };
    add(it, 'tex', keys, { kind: 'tex', f });
    if (sprites.length > 1) it.notes.push('several sprite curves on one node — the first is used');
  }

  // ── the rest: not transferred ──
  // Curves of the Animator itself (humanoid muscles, IK goals, root motion, parameters): one item.
  const animator = floats.filter((b) => !used.has(b) && b.classID === 95);
  if (animator.length) {
    for (const b of animator) used.add(b);
    const root = animator.filter((b) => /^(Root|Motion)[TQ]\./.test(b.attribute)).length;
    const what = [root && `${root} root motion`, animator.length - root && `${animator.length - root} humanoid muscle / IK / parameter`].filter(Boolean).join(' + ');
    out.items.push({ path, target, attributes: animator.map((b) => b.attribute), columns: [], cls: 'hard', notes: [`Animator curves (${what}) — not transferred`] });
  }
  for (const b of floats) {
    if (used.has(b)) continue;
    out.items.push({ path, target, attributes: [b.attribute], columns: [], cls: 'hard', notes: [hardReason(b.attribute, b.classID, ctx.scriptName(b.script))] });
  }
  for (const b of pptr) {
    if (usedP.has(b)) continue;
    out.items.push({ path, target, attributes: [b.attribute], columns: [], cls: 'hard', notes: [`object reference curve ${b.attribute} (classID ${b.classID}) — not transferred`] });
  }
}

function hardReason(attr: string, classID: number, script: string): string {
  if (attr.startsWith('material.')) return `material property ${attr} — not transferred`;
  if (attr === 'm_Enabled') return `m_Enabled of classID ${classID}${script ? ` (${script})` : ''} — not transferred`;
  if (/^m_(AnchorMin|AnchorMax|Pivot)\./.test(attr)) return `RectTransform ${attr} — not transferred`;
  return `${attr} (classID ${classID}${script ? `, ${script}` : ''}) — not transferred`;
}

/** Euler (degrees, Unity order) of a quaternion — for a rest pose without m_LocalEulerAnglesHint. */
export function quatEuler(q: { x: number; y: number; z: number; w: number }): V3 {
  const M = quatMatrix(q.x, q.y, q.z, q.w);
  // M = Ry · Rx · Rz: M[5] = −sin x; M[2] / M[8] → y; M[3] / M[4] → z.
  const x = Math.asin(Math.max(-1, Math.min(1, -M[5])));
  const y = Math.atan2(M[2], M[8]);
  const z = Math.atan2(M[3], M[4]);
  return { x: x / RAD, y: y / RAD, z: z / RAD };
}

/**
 * Tint keys of up to three colour channels: one ease per row, so the channels' segments are exact
 * when their key times agree and the channels that move share the ease; any other segment is baked.
 */
function tintKeys(curves: UCurve[], f: (t: number) => [number, number, number], o: BakeOpts): { keys: ColKey[]; baked: number; weighted: number } {
  const hex = (t: number): string => hexColor(...f(t));
  const k0 = curves[0].keys;
  const sameTimes = curves.every((c) => c.keys.length === k0.length && c.keys.every((k, i) => Math.abs(k.t - k0[i].t) < 1e-9));
  const D = o.duration;
  if (!sameTimes || k0.some((k) => k.t < 0 || k.t > D)) {
    const keys = bakedKeys(curves, (t) => {
      const [r, g, b] = f(t);
      return r * 65536 + g * 256 + b; // the breakpoints / steps; values replaced below
    }, { ...o, tol: Infinity });
    // Bake per channel and merge the times.
    const times = new Set<number>(keys.map((k) => k.t));
    const steps = new Set(keys.filter((k) => k.ease === 'step').map((k) => k.t));
    const ts = [...times].sort((a, b) => a - b);
    for (let i = 0; i + 1 < ts.length; i++) {
      if (steps.has(ts[i])) continue;
      for (let ch = 0; ch < 3; ch++) for (const t of bakeTimes(ts[i], ts[i + 1], (x) => f(x)[ch], o.fps, o.tol)) times.add(t);
    }
    const all = [...times].sort((a, b) => a - b);
    return { keys: dropTint(all.map((t) => ({ t, v: hex(t), ease: steps.has(t) ? 'step' : 'linear' }))), baked: Math.max(0, ts.length - 1 - steps.size), weighted: 0 };
  }
  const out: ColKey[] = [];
  let baked = 0;
  let weighted = 0;
  for (let i = 0; i < k0.length; i++) {
    const t = k0[i].t;
    if (i + 1 === k0.length) {
      out.push({ t, v: hex(t) });
      break;
    }
    const segs = curves.map((c) => [c.keys[i], c.keys[i + 1]] as const);
    if (segs.some(([a, b]) => weightedSeg(a, b))) weighted++;
    const consts = segs.map(([a, b]) => constantSeg(a, b) || (a.v === b.v && a.outSlope === 0 && b.inSlope === 0));
    if (segs.every(([a, b]) => constantSeg(a, b) || (a.v === b.v && a.outSlope === 0 && b.inSlope === 0))) {
      out.push({ t, v: hex(t), ease: 'step' });
      continue;
    }
    let ease: EaseOut | null | undefined;
    for (let c = 0; c < segs.length; c++) {
      const [a, b] = segs[c];
      if (consts[c] && a.v === b.v) continue;
      const e = constantSeg(a, b) ? 'step' : easeOfCubic(a.t, a.v, b.t, b.v, segmentCubic(a, b));
      if (ease === undefined) ease = e;
      else if (!sameEase(ease, e)) ease = null;
    }
    if (ease) {
      out.push({ t, v: hex(t), ease });
      continue;
    }
    baked++;
    out.push({ t, v: hex(t), ease: 'linear' });
    const inner = new Set<number>();
    for (let ch = 0; ch < 3; ch++) for (const x of bakeTimes(t, k0[i + 1].t, (y) => f(y)[ch], o.fps, o.tol)) inner.add(x);
    for (const x of [...inner].sort((a, b) => a - b)) out.push({ t: x, v: hex(x), ease: 'linear' });
  }
  return { keys: dropTint(out), baked, weighted };
}

const sameEase = (a: EaseOut | null, b: EaseOut | null): boolean => {
  if (a === null || b === null) return false;
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  return a.every((v, i) => Math.abs(v - b[i]) < 1e-4);
};

function dropTint(keys: ColKey[]): ColKey[] {
  const out: ColKey[] = [];
  for (const k of keys) {
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev.t - k.t) < 1e-9) continue;
    if (prev && prev.ease === 'step' && prev.v === k.v) continue;
    out.push(k);
  }
  if (out.length) out[out.length - 1].ease = undefined;
  return out;
}
