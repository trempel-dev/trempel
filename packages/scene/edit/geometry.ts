// geometry.ts — the editor's projection math (pure: no DOM, no Pixi).
//
// Spaces:
//   - user   — a node's own coordinates (x/y/d of its attributes), before its `transform`;
//   - parent — what the node's `transform` maps into; node.move / node.setTransform speak it;
//   - scene  — the root <svg>'s user space (viewBox units);
//   - screen — CSS px inside the stage box: the canvas at fitStage × zoom, overlays on top.
// A node's world matrix (user → scene) is the product of the transforms from the root down;
// screen = view × scene with view = zoom × (fit.scale, fit.x, fit.y) — no rotation, uniform.
//
// A gesture (an operator, ops.ts) is an affine map D of scene space (from screen space:
// D_scene = view⁻¹ · D_screen · view). It becomes core commands: a pure translation — node.move
// in parent space; anything else — node.setTransform from the new local matrix
// P⁻¹ · D · P · M (pivot at the gesture's centre), or the matrix itself when it has a skew.

import { IDENTITY, multiply, parseTransform, type Matrix, type SceneNode } from '../src/core.js';
import type { StageFit } from '../view/viewport';

export type { Matrix };
export { IDENTITY, multiply };

export interface Pt {
  x: number;
  y: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A command call as the core takes it (doc.exec / doc.batch). */
export interface Call {
  name: string;
  args: Record<string, unknown>;
}

export function invert(m: Matrix): Matrix {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) throw new Error('вырожденная матрица (масштаб 0)');
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

export const apply = (m: Matrix, p: Pt): Pt => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] });

/** The linear part applied to a vector (no translation). */
export const applyVec = (m: Matrix, v: Pt): Pt => ({ x: m[0] * v.x + m[2] * v.y, y: m[1] * v.x + m[3] * v.y });

export const translation = (x: number, y: number): Matrix => [1, 0, 0, 1, x, y];

/** scene → screen for a stage fitted by fitStage and shown at `zoom` (CSS px per canvas px). */
export function viewMatrix(fit: Pick<StageFit, 'scale' | 'x' | 'y'>, zoom: number): Matrix {
  const k = fit.scale * zoom;
  return [k, 0, 0, k, fit.x * zoom, fit.y * zoom];
}

/**
 * The stage view: translate(origin) · scale(zoom) · fit — scene → screen (CSS px in the stage area).
 * `origin` is where the canvas's top-left corner sits on the screen (the pan); the scene may leave it.
 */
export function stageView(fit: Pick<StageFit, 'scale' | 'x' | 'y'>, zoom: number, origin: Pt): Matrix {
  const v = viewMatrix(fit, zoom);
  return [v[0], 0, 0, v[3], v[4] + origin.x, v[5] + origin.y];
}

/** Canvas origin that centres a `w×h` canvas at `zoom` in an `area`, then shifted by `offset`. */
export function centredOrigin(area: { w: number; h: number }, size: { width: number; height: number }, zoom: number, offset: Pt = { x: 0, y: 0 }): Pt {
  return { x: (area.w - size.width * zoom) / 2 + offset.x, y: (area.h - size.height * zoom) / 2 + offset.y };
}

/** Zoom from `z0` to `z1` about a screen point `at`: the new canvas origin that keeps the point still. */
export function zoomAbout(origin: Pt, z0: number, z1: number, at: Pt): Pt {
  const k = z1 / z0;
  return { x: at.x - (at.x - origin.x) * k, y: at.y - (at.y - origin.y) * k };
}

/** Canvas px (what Pixi's getBounds reports) → scene units. */
export function canvasToScene(fit: Pick<StageFit, 'scale' | 'x' | 'y'>, b: Box): Box {
  return { x: (b.x - fit.x) / fit.scale, y: (b.y - fit.y) / fit.scale, w: b.w / fit.scale, h: b.h / fit.scale };
}

// ---- the tree ----------------------------------------------------------------------------

/** Element by index path ("" — the root, "0/3/1"); null when the path leads nowhere. */
export function nodeAt(root: SceneNode, path: string): SceneNode | null {
  let n: SceneNode | undefined = root;
  if (path === '') return root;
  for (const part of path.split('/')) {
    n = n?.children[Number(part)];
    if (!n) return null;
  }
  return n;
}

/** The node and its ancestors, root first. */
export function chainAt(root: SceneNode, path: string): SceneNode[] {
  const out: SceneNode[] = [root];
  if (path === '') return out;
  let n = root;
  for (const part of path.split('/')) {
    n = n.children[Number(part)];
    if (!n) throw new Error(`пути "${path}" в сцене нет`);
    out.push(n);
  }
  return out;
}

export const parentPath = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** True when `path` is `anc` or below it. */
export const isWithin = (path: string, anc: string): boolean => anc === '' || path === anc || path.startsWith(anc + '/');

/** The node's own `transform` (parent ← user). */
export const ownMatrix = (n: SceneNode): Matrix => parseTransform(n.attrs.transform);

/** Parent world (parent → scene): the transforms of the ancestors, root first. */
export function parentWorld(root: SceneNode, path: string): Matrix {
  const chain = chainAt(root, path);
  chain.pop();
  return chain.reduce<Matrix>((m, n) => multiply(m, ownMatrix(n)), IDENTITY);
}

/** World (user → scene): ancestors' transforms × the node's own. */
export function nodeWorld(root: SceneNode, path: string): Matrix {
  return chainAt(root, path).reduce<Matrix>((m, n) => multiply(m, ownMatrix(n)), IDENTITY);
}

/** A screen delta (drag) as a move in the node's parent space. */
export function screenDeltaToParent(dx: number, dy: number, view: Matrix, parent: Matrix): Pt {
  return applyVec(invert(multiply(view, parent)), { x: dx, y: dy });
}

/** Screen-space affine map → the same map in scene space. */
export function screenToSceneMap(dScreen: Matrix, view: Matrix): Matrix {
  return multiply(multiply(invert(view), dScreen), view);
}

/** Axis-aligned bounds of a box's corners mapped by m. */
export function mapBox(m: Matrix, b: Box): Box {
  const pts = [apply(m, { x: b.x, y: b.y }), apply(m, { x: b.x + b.w, y: b.y }), apply(m, { x: b.x, y: b.y + b.h }), apply(m, { x: b.x + b.w, y: b.y + b.h })];
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

export const boxCenter = (b: Box): Pt => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

export const isTranslation = (m: Matrix, eps = 1e-6): boolean =>
  Math.abs(m[0] - 1) < eps && Math.abs(m[1]) < eps && Math.abs(m[2]) < eps && Math.abs(m[3] - 1) < eps;

// ---- transform parts ---------------------------------------------------------------------

export interface TransformParts {
  translate: [number, number];
  /** Degrees. */
  rotate: number;
  scale: [number, number];
  pivot: [number, number];
}

/**
 * The parts node.setTransform takes for matrix m around pivot p (user space):
 * m = translate(t + p) · rotate · scale · translate(−p). null when m has a skew (or is degenerate).
 */
export function decompose(m: Matrix, pivot: Pt = { x: 0, y: 0 }): TransformParts | null {
  const [a, b, c, d, e, f] = m;
  const sx = Math.hypot(a, b);
  if (sx < 1e-12) return null;
  const det = a * d - b * c;
  const sy = det / sx;
  if (Math.abs(sy) < 1e-12) return null;
  // columns orthogonal ⇔ no skew
  if (Math.abs(a * c + b * d) > 1e-6 * sx * Math.abs(sy)) return null;
  const rotate = (Math.atan2(b, a) * 180) / Math.PI;
  const lp = applyVec(m, pivot);
  return { translate: [e + lp.x - pivot.x, f + lp.y - pivot.y], rotate, scale: [sx, sy], pivot: [pivot.x, pivot.y] };
}

/** Inverse of decompose: the matrix setTransform writes for these parts. */
export function compose(p: TransformParts): Matrix {
  const r = (p.rotate * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const [sx, sy] = p.scale;
  const lin: Matrix = [cos * sx, sin * sx, -sin * sy, cos * sy, 0, 0];
  const [px, py] = p.pivot;
  const lp = applyVec(lin, { x: px, y: py });
  return [lin[0], lin[1], lin[2], lin[3], p.translate[0] + px - lp.x, p.translate[1] + py - lp.y];
}

const round = (v: number, k: number): number => {
  const r = Math.round(v * 10 ** k) / 10 ** k;
  return Object.is(r, -0) ? 0 : r;
};

/** setTransform arguments: identity parts are left out (the core writes only what is there). */
export function transformArgs(node: string, p: TransformParts): Record<string, unknown> {
  const args: Record<string, unknown> = { node };
  const [sx, sy] = p.scale.map((v) => round(v, 6));
  const rot = round(((p.rotate + 540) % 360) - 180, 4);
  const linear = rot !== 0 || sx !== 1 || sy !== 1;
  const t: [number, number] = [round(p.translate[0], 4), round(p.translate[1], 4)];
  if (t[0] !== 0 || t[1] !== 0) args.translate = t;
  if (rot !== 0) args.rotate = rot;
  if (sx !== 1 || sy !== 1) args.scale = Math.abs(sx - sy) < 1e-6 ? sx : [sx, sy];
  // explicit even at (0, 0): without it the core takes the node's data-pivot (v0.8)
  if (linear) args.pivot = [round(p.pivot[0], 4), round(p.pivot[1], 4)];
  return args;
}

const fmt = (v: number, k: number): string => String(round(v, k));

/** matrix(…) text for a transform setTransform cannot express (a skew). */
export const matrixText = (m: Matrix): string =>
  `matrix(${[m[0], m[1], m[2], m[3]].map((v) => fmt(v, 6)).join(',')},${fmt(m[4], 2)},${fmt(m[5], 2)})`;

// ---- gestures → commands -----------------------------------------------------------------

export interface GestureTarget {
  /** id or index path. */
  ref: string;
  node: SceneNode;
  /** parent → scene. */
  parent: Matrix;
  /** Gesture box in scene space at its start (the node's bounds): rotation/scale pivot. */
  box: Box;
}

/**
 * Commands for a scene-space map D applied to a node: translation → node.move (parent space);
 * otherwise node.setTransform around the box centre (or node.setAttr transform=matrix(…) for a
 * skew). Empty when D is identity.
 */
export function gestureCommands(t: GestureTarget, D: Matrix): Call[] {
  if (isTranslation(D, 1e-6)) {
    if (Math.abs(D[4]) < 1e-6 && Math.abs(D[5]) < 1e-6) return [];
    const d = applyVec(invert(t.parent), { x: D[4], y: D[5] });
    return [{ name: 'node.move', args: { node: t.ref, dx: round(d.x, 4), dy: round(d.y, 4) } }];
  }
  const M = ownMatrix(t.node);
  const local = multiply(multiply(multiply(invert(t.parent), D), t.parent), M);
  const world = multiply(t.parent, M);
  const pivot = apply(invert(world), boxCenter(t.box));
  const parts = decompose(local, pivot);
  if (!parts) return [{ name: 'node.setAttr', args: { node: t.ref, name: 'transform', value: matrixText(local) } }];
  return [{ name: 'node.setTransform', args: transformArgs(t.ref, parts) }];
}

/**
 * Resize of an <image>/<rect> by attributes: D mapped into the node's user space must stay
 * axis-aligned (scale + translate); new x/y/width/height. null when it is not (rotated node —
 * use scale instead).
 */
export function resizeCommands(t: GestureTarget, D: Matrix): Call[] | null {
  const world = multiply(t.parent, ownMatrix(t.node));
  const Du = multiply(multiply(invert(world), D), world);
  if (Math.abs(Du[1]) > 1e-6 || Math.abs(Du[2]) > 1e-6) return null;
  const a = t.node.attrs;
  const x = Number(a.x ?? 0) || 0;
  const y = Number(a.y ?? 0) || 0;
  const w = Number(a.width ?? 0) || 0;
  const h = Number(a.height ?? 0) || 0;
  const b = mapBox(Du, { x, y, w, h });
  const out: Call[] = [];
  const set = (name: string, before: number, v: number): void => {
    const r = round(v, 2);
    if (Math.abs(r - before) > 1e-9) out.push({ name: 'node.setAttr', args: { node: t.ref, name, value: r } });
  };
  set('x', x, b.x);
  set('y', y, b.y);
  set('width', w, b.w);
  set('height', h, b.h);
  return out;
}

// ---- geometry bounds (service geometry is not drawn: the editor measures it itself) --------------

const n = (v: string | undefined, d = 0): number => {
  const x = v == null ? NaN : parseFloat(v);
  return Number.isFinite(x) ? x : d;
};

/** Bounds of a geometry element in its user space (path — of all its points, control points included). */
export function geometryBox(node: SceneNode, pathPoints?: (d: string) => Pt[]): Box | null {
  const a = node.attrs;
  switch (node.tag) {
    case 'rect':
    case 'image':
      return { x: n(a.x), y: n(a.y), w: n(a.width), h: n(a.height) };
    case 'circle':
      return { x: n(a.cx) - n(a.r), y: n(a.cy) - n(a.r), w: 2 * n(a.r), h: 2 * n(a.r) };
    case 'ellipse':
      return { x: n(a.cx) - n(a.rx), y: n(a.cy) - n(a.ry), w: 2 * n(a.rx), h: 2 * n(a.ry) };
    case 'line': {
      const x = Math.min(n(a.x1), n(a.x2));
      const y = Math.min(n(a.y1), n(a.y2));
      return { x, y, w: Math.abs(n(a.x2) - n(a.x1)), h: Math.abs(n(a.y2) - n(a.y1)) };
    }
    case 'path': {
      const pts = pathPoints?.(a.d ?? '') ?? [];
      if (!pts.length) return null;
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
    }
    default:
      return null;
  }
}

/** Union of boxes (null for none). */
export function unionBox(boxes: (Box | null | undefined)[]): Box | null {
  const bs = boxes.filter((b): b is Box => !!b);
  if (!bs.length) return null;
  const x = Math.min(...bs.map((b) => b.x));
  const y = Math.min(...bs.map((b) => b.y));
  return { x, y, w: Math.max(...bs.map((b) => b.x + b.w)) - x, h: Math.max(...bs.map((b) => b.y + b.h)) - y };
}
