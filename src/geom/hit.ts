// hit.ts — hit test by GEOMETRY (v0.9.1), renderer-agnostic: is a scene point inside a node's shape?
//
//   - path / circle / ellipse / rect: inside the outline (path — by its fill-rule; rect — with rx/ry);
//     the fill does not matter (fill="none" is still an area: a zone, a target);
//   - line: within half the stroke-width of it (at least 0.5);
//   - image: its x / y / width / height box (no width/height — the texture size is the renderer's,
//     so no hit);
//   - g / svg: any drawn descendant hits; text and components (tml:type) — no hit (their extent is
//     the renderer's / the component's).
//
// display="none" / visibility / opacity do not matter — a hidden zone is hit (FindDiff: the zone is
// invisible until found). Coordinates are the scene's (the root's user space = viewBox); the chain
// of `transform`s of the DOCUMENT is applied — a pose a clip or the host gives a node at run time is
// not (data-pivot does not change the SVG matrix, so it changes nothing here). v1.0: what the layout
// did (an anchor's offset, a stretched / resized image or rect) is — `adjust` (SceneLayout.placed).

import type { SceneNode } from '../parser.js';
import { parseZ } from '../props.js';
import { localMatrix, multiply, parseTransform, IDENTITY, type Matrix } from '../transform.js';
import { distanceToOutline, flatten, insideOutline, type Polyline } from './outline.js';
import { shapeCommands } from './pathdata.js';

const outlines = new WeakMap<SceneNode, Polyline[]>();

/** v1.0: the live layout of a node — offset in its parent, its current size (layout.ts `placed`). */
export type LayoutAdjust = (n: SceneNode) => { dx: number; dy: number; w?: number; h?: number } | undefined;

/** The node's local matrix with the layout's offset in its parent's space. */
const shifted = (m: Matrix, n: SceneNode, adjust?: LayoutAdjust): Matrix => {
  const p = adjust?.(n);
  return p && (p.dx || p.dy) ? multiply([1, 0, 0, 1, p.dx, p.dy], m) : m;
};

function outlineOf(node: SceneNode, adjust?: LayoutAdjust): Polyline[] {
  const p = node.tag === 'rect' ? adjust?.(node) : undefined;
  if (p && (p.w !== undefined || p.h !== undefined)) {
    try {
      return flatten(shapeCommands(node.tag, { ...node.attrs, width: String(p.w ?? node.attrs.width), height: String(p.h ?? node.attrs.height) }));
    } catch {
      return [];
    }
  }
  let o = outlines.get(node);
  if (!o) {
    try {
      o = flatten(shapeCommands(node.tag, node.attrs));
    } catch {
      o = []; // unreadable geometry is the checker's error; here it hits nothing
    }
    outlines.set(node, o);
  }
  return o;
}

const num = (v: string | undefined): number => {
  const n = v == null ? NaN : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

/** Never drawn, never hit. */
const SERVICE = new Set(['defs', 'clipPath']);

/**
 * Is the scene point (x, y) inside `node`'s geometry? `matrix` maps the node's own user space (where
 * its d / cx / x… live — its `transform` included) to the scene. Groups test their children.
 */
export function pointInNode(node: SceneNode, matrix: Matrix, x: number, y: number, adjust?: LayoutAdjust): boolean {
  if (SERVICE.has(node.tag)) return false;
  if (node.tag === 'g' || node.tag === 'svg') {
    if (node.tml.type) return false;
    return node.children.some((c) => pointInNode(c, multiply(matrix, shifted(parseTransform(c.attrs.transform), c, adjust)), x, y, adjust));
  }
  const [a, b, c, d, e, f] = matrix;
  const det = a * d - b * c;
  if (!det) return false;
  // The point in the node's user space.
  const px = (d * (x - e) - c * (y - f)) / det;
  const py = (-b * (x - e) + a * (y - f)) / det;
  switch (node.tag) {
    case 'image': {
      if (node.attrs.width == null || node.attrs.height == null) return false;
      const x0 = num(node.attrs.x);
      const y0 = num(node.attrs.y);
      const p = adjust?.(node);
      const w = p?.w ?? num(node.attrs.width);
      const h = p?.h ?? num(node.attrs.height);
      return px >= x0 && px <= x0 + w && py >= y0 && py <= y0 + h;
    }
    case 'line': {
      // Half the stroke in the node's space (a scaled line has a scaled stroke).
      const half = Math.max(num(node.attrs['stroke-width'] ?? '1') / 2, 0.5);
      return distanceToOutline(outlineOf(node), px, py) <= half;
    }
    case 'path':
    case 'circle':
    case 'ellipse':
    case 'rect': {
      const rule = node.tag === 'path' && node.attrs['fill-rule'] === 'evenodd' ? 'evenodd' : 'nonzero';
      return insideOutline(outlineOf(node, adjust), px, py, rule);
    }
    default:
      return false;
  }
}

/** The matrix of a node's user space in the scene: its ancestors' (from the root) and its own transform. */
export function nodeMatrix(chain: SceneNode[], adjust?: LayoutAdjust): Matrix {
  let m = IDENTITY;
  for (const n of chain) m = multiply(m, shifted(n.tag === 'g' || n.tag === 'svg' ? localMatrix(n.attrs, false) : parseTransform(n.attrs.transform), n, adjust));
  return m;
}

/** Tags hitTestAll reports (a node with its own geometry). */
const SHAPES = new Set(['path', 'circle', 'ellipse', 'line', 'rect', 'image']);

/** Children in paint order: data-z among siblings (stable), else document order. */
function painted(children: SceneNode[]): SceneNode[] {
  if (!children.some((c) => c.attrs['data-z'] != null)) return children;
  const z = (c: SceneNode, i: number): number => {
    try {
      return c.attrs['data-z'] != null ? parseZ(c.attrs['data-z']) : i;
    } catch {
      return i;
    }
  };
  return children
    .map((c, i) => ({ c, i, z: z(c, i) }))
    .sort((p, q) => p.z - q.z || p.i - q.i)
    .map((p) => p.c);
}

/**
 * Ids of the shapes (path, circle, ellipse, line, rect, image) with an id under the scene point,
 * topmost first (reverse paint order: document order, data-z among siblings). Hidden ones included;
 * <defs>, <clipPath> and components' subtrees are not entered.
 */
export function hitTestTree(tree: SceneNode, x: number, y: number, adjust?: LayoutAdjust): string[] {
  const hits: string[] = [];
  const visit = (n: SceneNode, parent: Matrix): void => {
    if (SERVICE.has(n.tag)) return;
    if (n.tag === 'g' || n.tag === 'svg') {
      if (n.tml.type) return;
      const m = multiply(parent, shifted(localMatrix(n.attrs, false), n, adjust));
      for (const c of painted(n.children)) visit(c, m);
      return;
    }
    if (!n.attrs.id || !SHAPES.has(n.tag)) return;
    if (pointInNode(n, multiply(parent, shifted(parseTransform(n.attrs.transform), n, adjust)), x, y, adjust)) hits.push(n.attrs.id);
  };
  visit(tree, IDENTITY);
  return hits.reverse();
}
