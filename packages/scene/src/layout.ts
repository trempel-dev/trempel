// layout.ts — v1.0: 9-slice, anchors, stretch, resizable boxes. Renderer-agnostic.
//
//   - data-slices="l t r b" on <image> (PNG pixels; 1 value = all four, 2 = "horizontal vertical"):
//     a 9-slice view — width/height are the panel's size, the borders stay 1:1 (the backend builds
//     it; slices that do not fit the texture are its load error). data-tile="x|y|xy" — a tiling
//     view by the same mechanism. Not both.
//   - Boxes: the root <svg> (its viewBox), an instance of a prefab (`<use>`: its width/height, or the
//     prefab's viewBox), a <g data-size="w h">. A box has a reference size (viewBox / the prefab's
//     minimum / data-size) — what the document is drawn for — and a current one (resize(), the
//     instance's width/height, a clip, a stretch of the box itself).
//   - data-anchor="ax ay" (0..1) on a direct child of a box: when the box is larger than its
//     reference the node moves by (extraW·ax, extraH·ay) — the node is at (ax·W, ay·H) plus its own
//     offset from (ax·W₀, ay·H₀), so at the reference size the document is exactly the vanilla SVG
//     (the kit's screen.ts semantics). The parent must be a box — otherwise an error.
//   - data-stretch="x|y|xy" on image / rect / a box child (g[data-size], an instance of a resizable
//     prefab): its size along the axis grows with the box (w₀ + extraW) — margins kept. With
//     data-slices — a 9-slice, without — a scale.
//   - data-resizable="x|y|xy" on a prefab's root: `<use width height>` along those axes (viewBox — the
//     minimum). Its background stretches: an <image data-slices> child of the root without its own
//     data-stretch / data-anchor stretches along the resizable axes by default. A resizable prefab
//     with nothing stretching — an error.
//
// Live layout (buildScene): every box gets a reactive size; the anchored / stretched children of
// a box follow it through effects (backend.setProp x / y / width / height; a box child — its box).
// Box handles are registered so the animator routes the `width` / `height` columns of an instance
// to its box (not to the renderer's container scale).
//
// @internal — `@trempel/scene/internal/layout`, for the kit and the editor: no stability promise.

import type { SceneNode } from './parser.js';
import { coded, within } from './codes.js';
import { trempelError } from './errors.js';
import { effect, reactive } from './reactive.js';
import type { NodeHandle, RendererBackend } from './render/backend.js';
import { localMatrix } from './transform.js';
import { walk } from './tree.js';

export type Axes = 'x' | 'y' | 'xy';
export interface Size {
  w: number;
  h: number;
}

const where = (n: SceneNode): string => (n.attrs.id ? `#${n.attrs.id}` : `<${n.tag}>`);
const NUM = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const numbers = (v: string): number[] | null => {
  const parts = v.trim().split(/[\s,]+/).filter(Boolean);
  return parts.length && parts.every((p) => NUM.test(p)) ? parts.map(Number) : null;
};

/** data-slices → [left, top, right, bottom]. @throws Error unless 1, 2 or 4 non-negative numbers. */
export function parseSlices(value: string): [number, number, number, number] {
  const p = numbers(value);
  if (!p || ![1, 2, 4].includes(p.length) || p.some((n) => n < 0)) {
    throw trempelError('E_SLICES', `data-slices="${value}" — expected "l t r b" (or one number for all borders, or "horizontal vertical"), pixels ≥ 0.`);
  }
  if (p.length === 1) return [p[0], p[0], p[0], p[0]];
  if (p.length === 2) return [p[0], p[1], p[0], p[1]];
  return p as [number, number, number, number];
}

/** data-anchor → { x, y } in 0..1. @throws Error unless two numbers. */
export function parseAnchor(value: string): { x: number; y: number } {
  const p = numbers(value);
  if (!p || p.length !== 2) throw trempelError('E_ANCHOR', `data-anchor="${value}" — expected "ax ay" (two numbers 0..1).`);
  return { x: p[0], y: p[1] };
}

/** data-stretch / data-tile / data-resizable → axes. @throws Error otherwise. */
export function parseAxes(name: string, value: string): Axes {
  const v = value.trim();
  if (v === 'x' || v === 'y' || v === 'xy') return v;
  if (v === 'yx') return 'xy';
  throw trempelError('E_AXES', `${name}="${value}" — expected x, y or xy.`);
}

/** data-size="w h" → size. @throws Error unless two positive numbers. */
export function parseSize(value: string): Size {
  const p = numbers(value);
  if (!p || p.length !== 2 || p.some((n) => !(n > 0))) throw trempelError('E_SIZE', `data-size="${value}" — a box size "w h" (two positive numbers).`);
  return { w: p[0], h: p[1] };
}

/** viewBox → its size, null when absent or malformed. */
export function viewBoxSize(viewBox: string | undefined): Size | null {
  const p = viewBox == null ? null : numbers(viewBox);
  return p && p.length === 4 && p[2] > 0 && p[3] > 0 ? { w: p[2], h: p[3] } : null;
}

const has = (axes: Axes | null | undefined, a: 'x' | 'y'): boolean => !!axes && axes.includes(a);
const safe = <T>(f: () => T): T | null => {
  try {
    return f();
  } catch {
    return null;
  }
};

/** Does any child of `n` ask for its parent's size (anchor / stretch)? */
const asksBox = (n: SceneNode): boolean =>
  n.children.some((c) => c.attrs['data-anchor'] != null || c.attrs['data-stretch'] != null);

/** The axes a box node resizes along when it is a resizable prefab (instance or the prefab opened as a scene). */
export function resizableAxes(n: SceneNode, isRoot: boolean): Axes | null {
  if (n.instance) return n.instance.resizable ?? null;
  const v = isRoot ? n.attrs['data-resizable'] : undefined;
  return v != null ? safe(() => parseAxes('data-resizable', v)) : null;
}

/**
 * The reference box of a node (null — not a box): the root's viewBox, an instance's prefab viewBox
 * (its minimum), a group's data-size.
 */
export function refBox(n: SceneNode, isRoot: boolean): Size | null {
  if (isRoot) return viewBoxSize(n.attrs.viewBox);
  if (n.instance) return n.instance.min ?? null;
  if (n.tag === 'g' && n.attrs['data-size'] != null) return safe(() => parseSize(n.attrs['data-size']));
  return null;
}

/** The size a box starts with (an instance — its width/height). */
const startSize = (n: SceneNode, ref: Size): Size => (n.instance?.size ? { ...n.instance.size } : { ...ref });

/**
 * The axes a child stretches along in its parent: its own data-stretch, or — the background of a
 * resizable box — an <image data-slices> without data-stretch / data-anchor takes the box's axes.
 */
export function stretchOf(c: SceneNode, parent: SceneNode, parentIsRoot: boolean): Axes | null {
  const own = c.attrs['data-stretch'];
  if (own != null) return safe(() => parseAxes('data-stretch', own));
  if (c.tag === 'image' && c.attrs['data-slices'] != null && c.attrs['data-anchor'] == null) return resizableAxes(parent, parentIsRoot);
  return null;
}

/** Is `c` a box itself (a stretch resizes its box, not a picture)? */
const isBox = (c: SceneNode): boolean => !!c.instance || (c.tag === 'g' && c.attrs['data-size'] != null);

/** All v1.0 layout attribute problems of a (composed) tree, phrased for a human. */
export function layoutErrors(tree: SceneNode): string[] {
  const errors: string[] = [];
  walk(tree, (n, parent) => {
    const w = where(n);
    const a = n.attrs;
    if (a['data-slices'] != null) {
      if (n.tag !== 'image') errors.push(coded('E_SLICES', `${w}: data-slices on <${n.tag}> — only an <image> is a 9-slice.`));
      else {
        try {
          parseSlices(a['data-slices']);
        } catch (e) {
          errors.push(within(w, (e as Error).message));
        }
      }
      if (a['data-tile'] != null) errors.push(coded('E_TILE', `${w}: data-slices and data-tile together — either a 9-slice or a tiling.`));
    }
    if (a['data-tile'] != null) {
      if (n.tag !== 'image') errors.push(coded('E_TILE', `${w}: data-tile on <${n.tag}> — only an <image> tiles.`));
      else {
        try {
          parseAxes('data-tile', a['data-tile']);
        } catch (e) {
          errors.push(within(w, (e as Error).message));
        }
      }
    }
    if (a['data-resizable'] != null && parent) errors.push(coded('E_RESIZABLE', `${w}: data-resizable is an attribute of a prefab's root (<svg>), not of a node.`));
    const boxNeeded = n.tag === 'g' && a['data-size'] != null && (asksBox(n) || a['data-stretch'] != null);
    if (boxNeeded) {
      try {
        parseSize(a['data-size']);
      } catch (e) {
        errors.push(within(w, (e as Error).message));
      }
    }
    const anchor = a['data-anchor'];
    const stretch = a['data-stretch'];
    if (anchor != null) {
      try {
        parseAnchor(anchor);
      } catch (e) {
        errors.push(within(w, (e as Error).message));
      }
    }
    if (stretch != null) {
      try {
        const axes = parseAxes('data-stretch', stretch);
        if (n.instance) {
          const r = n.instance.resizable;
          if (!r) errors.push(coded('E_STRETCH', `${w}: data-stretch on an instance of ${n.instance.href} — the prefab is not resizable (no data-resizable).`));
          else if ((has(axes, 'x') && !has(r, 'x')) || (has(axes, 'y') && !has(r, 'y'))) {
            errors.push(coded('E_STRETCH', `${w}: data-stretch="${stretch}" — ${n.instance.href} resizes only along ${r}.`));
          }
        } else if (n.tag !== 'image' && n.tag !== 'rect' && !(n.tag === 'g' && a['data-size'] != null)) {
          errors.push(coded('E_STRETCH', `${w}: data-stretch on <${n.tag}> — <image>, <rect>, <g data-size> and instances of resizable prefabs stretch.`));
        } else if (n.tag !== 'g' && (a.width == null || a.height == null)) {
          errors.push(coded('E_STRETCH', `${w}: data-stretch without width/height — stretch from which size?`));
        }
      } catch (e) {
        errors.push(within(w, (e as Error).message));
      }
    }
    if ((anchor != null || stretch != null) && parent && parent.tag !== 'defs' && parent.tag !== 'clipPath') {
      const isRoot = parent === tree;
      if (!refBox(parent, isRoot)) {
        const pw = isRoot ? 'the root (no viewBox)' : `${where(parent)}`;
        errors.push(
          coded('E_NO_BOX', `${w}: an anchor without the parent's size — ${pw}: ${isRoot ? 'give the root a viewBox' : 'give the group data-size="w h" (or move the node to the root / into a prefab)'}.`),
        );
      }
    }
  });
  return errors;
}

/** A prefab root's data-resizable problems: the axes, a viewBox (the minimum), a stretching background. */
export function resizableErrors(root: SceneNode): string[] {
  const raw = root.attrs['data-resizable'];
  if (raw == null) return [];
  try {
    parseAxes('data-resizable', raw);
  } catch (e) {
    return [within('root <svg>', (e as Error).message)];
  }
  if (!viewBoxSize(root.attrs.viewBox)) return [coded('E_RESIZABLE', 'root <svg>: data-resizable without a viewBox — the viewBox sets the minimum size.')];
  if (!root.children.some((c) => stretchOf(c, root, true))) {
    return [coded('E_RESIZABLE', 'root <svg>: data-resizable without a stretching background — it needs an <image data-slices> (or data-stretch on the background), else nothing stretches.')];
  }
  return [];
}

/** A live box: reference size and a reactive current one. */
export interface Box {
  readonly node: SceneNode;
  readonly ref: Size;
  readonly size: Size;
  /** Resizable axes (instance of a resizable prefab, or the resizable prefab opened as a scene). */
  readonly axes: Axes | null;
}

/** What layout did to a node now (hit tests, the editor): offset in its parent, its size. */
export interface Placed {
  dx: number;
  dy: number;
  w?: number;
  h?: number;
}

const BOXES = new WeakMap<NodeHandle, Box>();

/**
 * Write `width` / `height` of a box (instance, data-size group, the root) by its handle — what the
 * animator does with those columns. False when the handle is not a box (the backend gets it).
 */
export function setBoxProp(handle: NodeHandle, prop: string, value: number): boolean {
  if (prop !== 'width' && prop !== 'height') return false;
  const box = BOXES.get(handle);
  if (!box) return false;
  if (prop === 'width') box.size.w = value;
  else box.size.h = value;
  return true;
}

/** The live layout of a built scene. */
export interface SceneLayout {
  /** Box of a node (root, instance, data-size group); undefined — not a box. */
  box(node: SceneNode): Box | undefined;
  /** What layout did to a node (undefined — nothing). */
  placed(node: SceneNode): Placed | undefined;
}

/**
 * Lay out a built tree: a reactive size per box, effects that move anchored children and resize
 * stretched ones. `handles` — the built node of each SceneNode.
 */
export function layoutScene(tree: SceneNode, handles: Map<SceneNode, NodeHandle>, backend: RendererBackend): SceneLayout {
  const boxes = new Map<SceneNode, Box>();
  const placed = new Map<SceneNode, Placed>();

  const boxFor = (n: SceneNode, isRoot: boolean): Box | undefined => {
    let b = boxes.get(n);
    if (b) return b;
    const ref = refBox(n, isRoot);
    if (!ref) return undefined;
    b = { node: n, ref, size: reactive(startSize(n, ref)), axes: resizableAxes(n, isRoot) };
    boxes.set(n, b);
    const h = handles.get(n);
    if (h) BOXES.set(h, b);
    return b;
  };

  const rest = (c: SceneNode, h: NodeHandle): { x: number; y: number } => {
    if (backend.getProp) {
      const x = Number(backend.getProp(h, 'x'));
      const y = Number(backend.getProp(h, 'y'));
      if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
    }
    const m = localMatrix(c.attrs, c.tag === 'image' || c.tag === 'text' || c.tag === 'rect');
    return { x: m[4], y: m[5] };
  };

  const visit = (n: SceneNode, isRoot: boolean): void => {
    const box = boxFor(n, isRoot);
    if (box) {
      for (const c of n.children) {
        const anchor = c.attrs['data-anchor'] != null ? safe(() => parseAnchor(c.attrs['data-anchor'])) : null;
        const stretch = stretchOf(c, n, isRoot);
        if (!anchor && !stretch) continue;
        const h = handles.get(c);
        if (!h) continue;
        const child = isBox(c) ? boxFor(c, false) : undefined;
        const p0 = rest(c, h);
        const base = child ? { ...child.size } : { w: Number(c.attrs.width) || 0, h: Number(c.attrs.height) || 0 };
        const at: Placed = { dx: 0, dy: 0 };
        placed.set(c, at);
        effect(() => {
          const ex = box.size.w - box.ref.w;
          const ey = box.size.h - box.ref.h;
          if (has(stretch, 'x')) {
            if (child) child.size.w = base.w + ex;
            else backend.setProp(h, 'width', (at.w = base.w + ex));
          } else if (anchor) {
            at.dx = ex * anchor.x;
            backend.setProp(h, 'x', p0.x + at.dx);
          }
          if (has(stretch, 'y')) {
            if (child) child.size.h = base.h + ey;
            else backend.setProp(h, 'height', (at.h = base.h + ey));
          } else if (anchor) {
            at.dy = ey * anchor.y;
            backend.setProp(h, 'y', p0.y + at.dy);
          }
        });
      }
    }
    for (const c of n.children) visit(c, false);
  };
  visit(tree, true);

  return {
    box: (node) => boxes.get(node),
    placed: (node) => {
      const p = placed.get(node);
      const b = boxes.get(node);
      if (b && b.node.instance) return { dx: p?.dx ?? 0, dy: p?.dy ?? 0, w: b.size.w, h: b.size.h };
      return p;
    },
  };
}
