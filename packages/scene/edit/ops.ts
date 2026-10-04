// ops.ts — the transform operators' math (pure: no DOM, no Pixi), Blender-style: G move, R rotate,
// S scale, each around one pivot for the whole selection, with an axis constraint in the global or
// the active node's local axes. The modal state (edit/app/ops.ts), the gizmo and tml.op() all end
// here: targets → new own matrices → core commands (one batch = one undo entry).
//
//   - G: a scene-space delta d; each node: M' = T(P⁻¹·d) · M → node.move in its parent space.
//   - R: θ about the pivot c (scene): D = T(c)·R(θ)·T(−c); M' = P⁻¹·D·P·M → node.setTransform.
//   - S global axes: D = T(c)·diag·T(−c) as R (a rotated node gets a skew — matrix(…));
//     S local axes: in each node's own user space about c: M' = M·T(u)·diag·T(−u), u = W⁻¹·c —
//     no skew whatever the rotation. Axis-aligned <image>/<rect> resize by attributes instead;
//     v1.0: an <image data-slices|data-tile> always does (its own axes), an instance of a resizable
//     prefab changes width/height (node.resize, not below its viewBox) and moves to keep the pivot.
// setTransform parts are taken about the node's pivot (data-pivot, else its bounds' centre), so
// the written translate means what the inspector shows.

import type { SceneNode } from '../src/core.js';
import {
  apply,
  applyVec,
  boxCenter,
  decompose,
  invert,
  isTranslation,
  matrixText,
  multiply,
  ownMatrix,
  parentWorld,
  resizeCommands,
  transformArgs,
  translation,
  unionBox,
  type Box,
  type Call,
  type Matrix,
  type Pt,
} from './geometry';

export type OpKind = 'G' | 'R' | 'S';
export type Axis = 'x' | 'y';
export type AxisSpace = 'local' | 'global';

/** What an operator transforms: a base node with its matrices at the start. */
export interface OpTarget {
  path: string;
  /** id or index path (how commands address it). */
  ref: string;
  node: SceneNode;
  /** parent → scene. */
  parent: Matrix;
  /** The node's own transform (parent ← user). */
  own: Matrix;
  /** user → scene. */
  world: Matrix;
  /** Scene bounds at the start (null — nothing drawn). */
  box: Box | null;
  /** The node's pivot in its user space: data-pivot, else the bounds' centre, else (0, 0). */
  pivot: Pt;
  /** data-pivot is set. */
  ownPivot: boolean;
  /** v1.0: an instance of a resizable prefab — S changes its width/height (along these axes), not the transform. */
  sized?: { w: number; h: number; min: { w: number; h: number }; axes: 'x' | 'y' | 'xy' };
}

/** v1.0: what opTargets needs to know of an instance (EditorDocument.instance). */
export type InstanceLookup = (ref: string) => { size?: { w: number; h: number }; min?: { w: number; h: number }; resizable?: 'x' | 'y' | 'xy' } | null;

/** One operator application, everything resolved to numbers. */
export interface OpParams {
  kind: OpKind;
  /** G: scene-space delta. */
  delta?: Pt;
  /** R: degrees (SVG: clockwise on screen). */
  angle?: number;
  /** S: factors along the axes of `space`. */
  factor?: [number, number];
  space: AxisSpace;
  /** Rotation / scale centre, scene units. */
  pivot: Pt;
}

const NOT_MOVABLE = new Set(['svg', 'defs', 'clipPath']);
const RESIZABLE = new Set(['image', 'rect']);
const r4 = (v: number): number => {
  const r = Math.round(v * 10000) / 10000;
  return Object.is(r, -0) ? 0 : r;
};

/** data-pivot="x y" → point (null — absent or unreadable). */
export function pivotAttr(n: SceneNode): Pt | null {
  const raw = n.attrs['data-pivot'];
  if (raw == null) return null;
  const v = raw.trim().split(/[\s,]+/).map(Number);
  return v.length === 2 && v.every(Number.isFinite) ? { x: v[0], y: v[1] } : null;
}

/**
 * Targets for paths (a selection): the root, <defs>, <clipPath> and nodes under another selected
 * node are left out (the ancestor carries them).
 */
export function opTargets(scene: SceneNode, paths: string[], bounds: Map<string, Box>, ref: (path: string) => string, instance?: InstanceLookup): OpTarget[] {
  const out: OpTarget[] = [];
  const nodeAt = (p: string): SceneNode | null => {
    let n: SceneNode | undefined = scene;
    if (p === '') return scene;
    for (const k of p.split('/')) {
      n = n?.children[Number(k)];
      if (!n) return null;
    }
    return n;
  };
  for (const path of paths) {
    if (path === '') continue;
    if (paths.some((q) => q !== path && (q === '' || path.startsWith(q + '/')))) continue;
    const node = nodeAt(path);
    if (!node || NOT_MOVABLE.has(node.tag)) continue;
    let parent: Matrix;
    let own: Matrix;
    try {
      parent = parentWorld(scene, path);
      own = ownMatrix(node);
    } catch {
      continue; // a transform the parser rejects: not operable
    }
    const world = multiply(parent, own);
    const box = bounds.get(path) ?? null;
    const attr = pivotAttr(node);
    let pivot: Pt = attr ?? { x: 0, y: 0 };
    if (!attr && box) {
      try {
        pivot = apply(invert(world), boxCenter(box));
      } catch {
        // degenerate: (0, 0)
      }
    }
    const t: OpTarget = { path, ref: ref(path), node, parent, own, world, box, pivot, ownPivot: !!attr };
    if (node.tag === 'use' && instance) {
      const info = instance(t.ref);
      if (info?.resizable && info.size && info.min) t.sized = { ...info.size, min: info.min, axes: info.resizable };
    }
    out.push(t);
  }
  return out;
}

/** The operator's centre: one node — its pivot; several — the centre of their bounds together. */
export function opPivot(targets: OpTarget[]): Pt {
  if (targets.length === 1) return apply(targets[0].world, targets[0].pivot);
  const u = unionBox(targets.map((t) => t.box));
  if (u) return boxCenter(u);
  const ps = targets.map((t) => apply(t.world, t.pivot));
  return ps.length ? { x: ps.reduce((s, p) => s + p.x, 0) / ps.length, y: ps.reduce((s, p) => s + p.y, 0) / ps.length } : { x: 0, y: 0 };
}

/** Unit axes in the scene: global — x/y; local — the node's world x and y columns. */
export function axesOf(space: AxisSpace, target?: OpTarget): [Pt, Pt] {
  if (space === 'global' || !target) return [{ x: 1, y: 0 }, { x: 0, y: 1 }];
  const w = target.world;
  const lx = Math.hypot(w[0], w[1]);
  const ly = Math.hypot(w[2], w[3]);
  if (lx < 1e-12 || ly < 1e-12) return [{ x: 1, y: 0 }, { x: 0, y: 1 }];
  return [{ x: w[0] / lx, y: w[1] / lx }, { x: w[2] / ly, y: w[3] / ly }];
}

const rotation = (deg: number): Matrix => {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c, s, -s, c, 0, 0];
};

/** The scene-space map of a global operator about c (R, S global; G — a translation). */
function sceneMap(p: OpParams): Matrix {
  if (p.kind === 'G') return translation(p.delta?.x ?? 0, p.delta?.y ?? 0);
  const c = p.pivot;
  const lin: Matrix = p.kind === 'R' ? rotation(p.angle ?? 0) : [p.factor?.[0] ?? 1, 0, 0, p.factor?.[1] ?? 1, 0, 0];
  return multiply(multiply(translation(c.x, c.y), lin), translation(-c.x, -c.y));
}

/** The node's new own matrix under the operator. */
export function targetMatrix(t: OpTarget, p: OpParams): Matrix {
  if (p.kind === 'G') {
    const d = applyVec(invert(t.parent), p.delta ?? { x: 0, y: 0 });
    return multiply(translation(d.x, d.y), t.own);
  }
  if (p.kind === 'S' && p.space === 'local') {
    const u = apply(invert(t.world), p.pivot);
    const [sx, sy] = p.factor ?? [1, 1];
    return multiply(t.own, multiply(multiply(translation(u.x, u.y), [sx, 0, 0, sy, 0, 0]), translation(-u.x, -u.y)));
  }
  return multiply(multiply(multiply(invert(t.parent), sceneMap(p)), t.parent), t.own);
}

/** Whether the parameters change nothing (no command, no undo entry). */
export function isIdentityOp(p: OpParams): boolean {
  if (p.kind === 'G') return Math.abs(p.delta?.x ?? 0) < 1e-9 && Math.abs(p.delta?.y ?? 0) < 1e-9;
  if (p.kind === 'R') return Math.abs(p.angle ?? 0) < 1e-9;
  return Math.abs((p.factor?.[0] ?? 1) - 1) < 1e-9 && Math.abs((p.factor?.[1] ?? 1) - 1) < 1e-9;
}

/** World axis-aligned with positive scales (an <image>/<rect> resizes by attributes then). */
const axisAligned = (m: Matrix): boolean => Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9 && m[0] > 0 && m[3] > 0;

/** Core commands for one target: node.move / node.setTransform / resize attributes / matrix(…). */
export function targetCommands(t: OpTarget, next: Matrix, kind: OpKind): Call[] {
  const Dp = multiply(next, invert(t.own)); // parent-space map
  if (kind === 'G' || isTranslation(Dp, 1e-9)) {
    if (Math.abs(Dp[4]) < 1e-9 && Math.abs(Dp[5]) < 1e-9) return [];
    return [{ name: 'node.move', args: { node: t.ref, dx: r4(Dp[4]), dy: r4(Dp[5]) } }];
  }
  if (kind === 'S' && t.sized) {
    const r = instanceResize(t, multiply(invert(t.own), next));
    if (r) return r;
  }
  // v1.0: a 9-slice / tiled image is resized by its box in its own axes, rotated or not.
  const ownSized = t.node.tag === 'image' && (t.node.attrs['data-slices'] != null || t.node.attrs['data-tile'] != null);
  if (kind === 'S' && RESIZABLE.has(t.node.tag) && (ownSized || axisAligned(t.world))) {
    const D = multiply(multiply(t.parent, Dp), invert(t.parent));
    const r = resizeCommands({ ref: t.ref, node: t.node, parent: t.parent, box: t.box ?? { x: 0, y: 0, w: 0, h: 0 } }, D);
    if (r) return r;
  }
  const parts = decompose(next, t.pivot);
  if (!parts) return [{ name: 'node.setAttr', args: { node: t.ref, name: 'transform', value: matrixText(next) } }];
  return [{ name: 'node.setTransform', args: transformArgs(t.ref, parts) }];
}

/**
 * v1.0: S on an instance of a resizable prefab — `Du` (the map in the instance's user space) must be
 * a scale about some point: width/height along the allowed axes (not below the minimum), the
 * instance moved so that point stays; a disallowed axis does not change. null — not a pure scale.
 */
function instanceResize(t: OpTarget, Du: Matrix): Call[] | null {
  const s = t.sized!;
  if (Math.abs(Du[1]) > 1e-6 || Math.abs(Du[2]) > 1e-6 || Du[0] <= 0 || Du[3] <= 0) return null;
  // The box lives at the <use>'s x/y in the space of its transform (where Du is).
  const axis = (k: number, size: number, min: number, on: boolean): { size: number; off: number } => {
    const f = Du[k === 0 ? 0 : 3];
    const tr = Du[k === 0 ? 4 : 5];
    if (!on || Math.abs(f - 1) < 1e-9) return { size, off: 0 };
    const o = Number(t.node.attrs[k === 0 ? 'x' : 'y'] ?? 0) || 0;
    const u = tr / (1 - f); // the fixed point of v → f·v + tr
    const next = Math.max(min, size * f);
    return { size: next, off: (u - o) * (1 - next / size) };
  };
  const x = axis(0, s.w, s.min.w, s.axes.includes('x'));
  const y = axis(1, s.h, s.min.h, s.axes.includes('y'));
  const out: Call[] = [];
  const args: Record<string, unknown> = { node: t.ref };
  if (Math.abs(r4(x.size) - s.w) > 1e-9) args.width = Math.round(x.size * 100) / 100;
  if (Math.abs(r4(y.size) - s.h) > 1e-9) args.height = Math.round(y.size * 100) / 100;
  if (args.width === undefined && args.height === undefined) return out;
  out.push({ name: 'node.resize', args });
  const d = applyVec(t.own, { x: x.off, y: y.off });
  if (Math.abs(d.x) > 1e-6 || Math.abs(d.y) > 1e-6) out.push({ name: 'node.move', args: { node: t.ref, dx: r4(d.x), dy: r4(d.y) } });
  return out;
}

export const OP_LABEL: Record<OpKind, string> = { G: 'сдвиг', R: 'поворот', S: 'масштаб' };

/** Every target's commands (one batch): empty when the operator changes nothing. */
export function opCommands(targets: OpTarget[], p: OpParams): Call[] {
  if (isIdentityOp(p)) return [];
  return targets.flatMap((t) => targetCommands(t, targetMatrix(t, p), p.kind));
}

// ---- value → parameters ------------------------------------------------------------------------

/** What a user (keys, the gizmo, tml.op) asks for: an axis and/or a typed value. */
export interface OpRequest {
  kind: OpKind;
  /** null — free (G: both axes, S: uniform). */
  axis: Axis | null;
  /** Shift+X: everything but this axis (2D: the other one). */
  exclude?: boolean;
  space: AxisSpace;
  /** Typed value: G — scene units along the axis (x when none), R — degrees, S — factor. */
  value?: number;
}

/** Axes of a constraint by default: one node — its local axes (the gizmo's), several — global. */
export const defaultSpace = (targets: OpTarget[]): AxisSpace => (targets.length === 1 ? 'local' : 'global');

/** The effective single axis of a request (exclude flips it in 2D), null — free. */
export function activeAxis(r: Pick<OpRequest, 'axis' | 'exclude'>): Axis | null {
  if (!r.axis) return null;
  return r.exclude ? (r.axis === 'x' ? 'y' : 'x') : r.axis;
}

/** Parameters for a typed value (tml.op, numeric input). */
export function paramsForValue(r: OpRequest & { value: number }, targets: OpTarget[]): OpParams {
  const pivot = opPivot(targets);
  const active = targets[targets.length - 1];
  const axis = activeAxis(r);
  if (r.kind === 'G') {
    const [ax, ay] = axesOf(r.space, active);
    const dir = axis === 'y' ? ay : ax;
    return { kind: 'G', delta: { x: dir.x * r.value, y: dir.y * r.value }, space: r.space, pivot };
  }
  if (r.kind === 'R') return { kind: 'R', angle: r.value, space: r.space, pivot };
  const f = r.value;
  return { kind: 'S', factor: axis === 'x' ? [f, 1] : axis === 'y' ? [1, f] : [f, f], space: r.space, pivot };
}

/**
 * Parameters from a pointer gesture in scene units: `from` → `to` (G — the delta projected on the
 * axis; R — the angle swept about the pivot, `turns` the accumulated one; S — distance ratio).
 */
export function paramsForPointer(r: OpRequest, targets: OpTarget[], from: Pt, to: Pt, sweep?: number): OpParams {
  const pivot = opPivot(targets);
  const active = targets[targets.length - 1];
  const axis = activeAxis(r);
  if (r.kind === 'G') {
    const d = { x: to.x - from.x, y: to.y - from.y };
    if (!axis) return { kind: 'G', delta: d, space: r.space, pivot };
    const [ax, ay] = axesOf(r.space, active);
    const dir = axis === 'x' ? ax : ay;
    const k = d.x * dir.x + d.y * dir.y;
    return { kind: 'G', delta: { x: dir.x * k, y: dir.y * k }, space: r.space, pivot };
  }
  if (r.kind === 'R') {
    const a = sweep ?? ((Math.atan2(to.y - pivot.y, to.x - pivot.x) - Math.atan2(from.y - pivot.y, from.x - pivot.x)) * 180) / Math.PI;
    return { kind: 'R', angle: a, space: r.space, pivot };
  }
  const d0 = Math.hypot(from.x - pivot.x, from.y - pivot.y);
  const f = d0 < 1e-9 ? 1 : Math.hypot(to.x - pivot.x, to.y - pivot.y) / d0;
  return { kind: 'S', factor: axis === 'x' ? [f, 1] : axis === 'y' ? [1, f] : [f, f], space: r.space, pivot };
}

/** Ctrl: steps — G 10 units (along the axis, or each component), R 15°, S 0.1. */
export function stepped(p: OpParams, axis: Axis | null, axes: [Pt, Pt]): OpParams {
  const snap = (v: number, s: number): number => Math.round(v / s) * s;
  if (p.kind === 'G' && p.delta) {
    if (!axis) return { ...p, delta: { x: snap(p.delta.x, 10), y: snap(p.delta.y, 10) } };
    const dir = axis === 'x' ? axes[0] : axes[1];
    const k = snap(p.delta.x * dir.x + p.delta.y * dir.y, 10);
    return { ...p, delta: { x: dir.x * k, y: dir.y * k } };
  }
  if (p.kind === 'R') return { ...p, angle: snap(p.angle ?? 0, 15) };
  if (p.kind === 'S' && p.factor) return { ...p, factor: [snap(p.factor[0], 0.1), snap(p.factor[1], 0.1)] };
  return p;
}

/** The status line's value part: «Сдвиг X: 120 px», «Поворот: −45°», «Масштаб Y: 1.5». */
export function opStatus(r: OpRequest, p: OpParams, typed: string | null, axes: [Pt, Pt] = [{ x: 1, y: 0 }, { x: 0, y: 1 }]): string {
  const axis = activeAxis(r);
  const ax = axis ? ` ${axis.toUpperCase()} ${r.space === 'local' ? '(лок.)' : '(мир.)'}` : '';
  const n = (v: number): string => String(Math.round(v * 100) / 100).replace('-', '−');
  const shown = (v: number): string => (typed != null ? `${typed.replace('-', '−') || '…'}` : n(v));
  if (p.kind === 'G') {
    const d = p.delta ?? { x: 0, y: 0 };
    if (axis || typed != null) {
      const dir = axis === 'y' ? axes[1] : axes[0];
      return `Сдвиг${ax || ' X'}: ${shown(d.x * dir.x + d.y * dir.y)} px`;
    }
    return `Сдвиг: ${n(d.x)}, ${n(d.y)} px`;
  }
  if (p.kind === 'R') return `Поворот: ${shown(p.angle ?? 0)}°`;
  const f = p.factor ?? [1, 1];
  return `Масштаб${ax}: ${shown(axis === 'y' ? f[1] : f[0])}`;
}

/** Numeric input of an operator (Blender): digits, «.», «-» flips the sign, Backspace. */
export function typeKey(typed: string | null, key: string): string | null | undefined {
  const t = typed ?? '';
  if (/^[0-9]$/.test(key)) return t.replace(/^(-?)0(?=\d)/, '$1') + key;
  if (key === '.' || key === ',') return t.includes('.') ? t : `${t.replace(/^-?$/, (m) => `${m}0`)}.`;
  if (key === '-') return t.startsWith('-') ? t.slice(1) : `-${t}`;
  if (key === 'Backspace') return t.length ? (t.slice(0, -1) === '-' ? '' : t.slice(0, -1)) || null : null;
  return undefined; // not a numeric key
}

export const typedValue = (typed: string | null): number | null => {
  if (typed == null) return null;
  const v = Number(typed);
  return typed !== '' && typed !== '-' && Number.isFinite(v) ? v : null;
};

/** Pivot commands: each node's data-pivot at a scene point (keepWorld — nothing moves). */
export function pivotCommands(targets: OpTarget[], at: Pt | 'centre'): Call[] {
  const out: Call[] = [];
  for (const t of targets) {
    let u: Pt;
    try {
      u = at === 'centre' ? (t.box ? apply(invert(t.world), boxCenter(t.box)) : t.pivot) : apply(invert(t.world), at);
    } catch {
      continue;
    }
    out.push({ name: 'node.setPivot', args: { node: t.ref, x: r4(u.x), y: r4(u.y) } });
  }
  return out;
}


// ---- one call: tml.op() and the palette ----------------------------------------------------------

/** What applyOp needs of the editor (the Editor; a stand-in in tests). */
export interface OpHost {
  doc: { scene: SceneNode } | null;
  bounds: Map<string, Box>;
  selection: string[];
  ref(path: string): string;
  pathOfId(id: string): string | null;
  batch(label: string, calls: Call[]): { ok: boolean; changed: unknown[]; errors?: string[] } | null;
  /** v1.0: instance info (resizable prefabs scale by width/height). */
  instance?: InstanceLookup;
}

export interface OpOptions {
  axis?: Axis | null;
  /** Shift+X: all but this axis. */
  exclude?: boolean;
  /** Axes of the constraint (default: one node — local, the gizmo's; several — global). */
  space?: AxisSpace;
  /** G — scene units along the axis (x when none), R — degrees, S — factor. Required for G/R/S. */
  value?: number;
  /** For `.`: the scene point. */
  x?: number;
  y?: number;
  /** Nodes (id or index path); default — the selection. */
  nodes?: string[];
}

export type OpName = OpKind | '.' | 'ctrl+.';

/** Resolve node names (id / index path) to paths. */
export function opPaths(host: OpHost, nodes: string[] | undefined): string[] {
  if (!nodes) return [...host.selection];
  return nodes.map((n) => {
    const p = /^\d+(\/\d+)*$/.test(n) ? n : host.pathOfId(n.replace(/^#/, ''));
    if (p == null) throw new Error(`tml.op: узла «${n}» нет`);
    return p;
  });
}

/**
 * An operator without interaction: `G`/`R`/`S` with a value (and an axis), `.` — the pivot at
 * {x, y}, `ctrl+.` — the pivot at the bounds' centre. One undo entry; null — nothing to do.
 */
export function applyOp(host: OpHost, name: OpName, opts: OpOptions = {}): ReturnType<OpHost['batch']> {
  const doc = host.doc;
  if (!doc) throw new Error('tml.op: сцена не открыта');
  const targets = opTargets(doc.scene, opPaths(host, opts.nodes), host.bounds, (p) => host.ref(p), host.instance?.bind(host));
  if (!targets.length) throw new Error('tml.op: нечего трансформировать — выделите узел или передайте nodes');
  if (name === '.' || name === 'ctrl+.') {
    if (name === '.' && (!Number.isFinite(opts.x) || !Number.isFinite(opts.y))) throw new Error("tml.op('.'): нужна точка { x, y } в единицах сцены");
    return host.batch('пивот', pivotCommands(targets, name === '.' ? { x: opts.x!, y: opts.y! } : 'centre'));
  }
  if (name !== 'G' && name !== 'R' && name !== 'S') throw new Error(`tml.op: оператора «${String(name)}» нет (G, R, S, ., ctrl+.)`);
  if (!Number.isFinite(opts.value)) throw new Error(`tml.op('${name}'): нужно число value`);
  const req = { kind: name, axis: opts.axis ?? null, exclude: opts.exclude, space: opts.space ?? defaultSpace(targets), value: opts.value! } as const;
  const calls = opCommands(targets, paramsForValue(req, targets));
  return calls.length ? host.batch(OP_LABEL[name], calls) : null;
}
