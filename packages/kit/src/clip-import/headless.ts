// headless.ts — an in-memory RendererBackend with Pixi's transform semantics, for checking imported
// clips without a renderer (trempel-spine-import, trempel-anim-import): a node keeps position /
// rotation / skew / scale the way PixiBackend does after decomposing the SVG transform, the
// animation player writes and reads them by the same paths, and worldOf() composes them like
// Pixi's local transform T · R · Skew · S. Also kept: alpha, visibility, an image's href, tint (a
// group's tint goes to every image of its subtree, as in PixiBackend), z (order among siblings),
// mix-blend-mode. Image texture fit is not modelled (it does not move nodes).

import { localMatrix } from '@trempel/scene/internal/transform';
import type { NodeHandle, RendererBackend } from '@trempel/scene';

export interface HNode {
  tag: string;
  attrs: Record<string, string>;
  x: number;
  y: number;
  rotation: number;
  skew: { x: number; y: number };
  scale: { x: number; y: number };
  alpha: number;
  visible: boolean;
  href?: string;
  /** 0xRRGGBB multiply tint (white — none). */
  tint: number;
  /** Order among siblings (data-z / the `z` column); undefined — document order. */
  z?: number;
  blend?: string;
  parent: HNode | null;
  children: HNode[];
}

/** [a, b, c, d, e, f] — x' = a·x + c·y + e, y' = b·x + d·y + f (SVG order). */
export type M = [number, number, number, number, number, number];

/** Pixi's Matrix.decompose: rotation when the axes stay orthogonal, skew otherwise; scale = axis lengths. */
function place(n: HNode, m: M): void {
  const [a, b, c, d, e, f] = m;
  n.x = e;
  n.y = f;
  const skewX = -Math.atan2(-c, d);
  const skewY = Math.atan2(b, a);
  const delta = Math.abs(skewX + skewY);
  if (delta < 0.00001 || Math.abs(Math.PI * 2 - delta) < 0.00001) {
    n.rotation = skewY;
    n.skew = { x: 0, y: 0 };
  } else {
    n.rotation = 0;
    n.skew = { x: skewX, y: skewY };
  }
  n.scale = { x: Math.sqrt(a * a + b * b), y: Math.sqrt(c * c + d * d) };
}

/** The local matrix of a node as Pixi builds it. */
export function localOf(n: HNode): M {
  const r = n.rotation;
  return [
    Math.cos(r + n.skew.y) * n.scale.x,
    Math.sin(r + n.skew.y) * n.scale.x,
    -Math.sin(r - n.skew.x) * n.scale.y,
    Math.cos(r - n.skew.x) * n.scale.y,
    n.x,
    n.y,
  ];
}

export function mul(m1: M, m2: M): M {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [a1 * a2 + c1 * b2, b1 * a2 + d1 * b2, a1 * c2 + c1 * d2, b1 * c2 + d1 * d2, a1 * e2 + c1 * f2 + e1, b1 * e2 + d1 * f2 + f1];
}

/** World matrix: the chain of local transforms up to the root. */
export function worldOf(n: HNode): M {
  let m = localOf(n);
  for (let p = n.parent; p; p = p.parent) m = mul(localOf(p), m);
  return m;
}

/** Alpha as drawn: the product up the chain (a hidden node or ancestor — 0). */
export function worldAlpha(n: HNode): number {
  let a = 1;
  for (let p: HNode | null = n; p; p = p.parent) a *= p.visible ? p.alpha : 0;
  return a;
}

/** Children in drawing order: by z (siblings without one keep their index), stable. */
export function drawChildren(n: HNode): HNode[] {
  return n.children
    .map((c, i) => ({ c, i, z: c.z ?? i }))
    .sort((a, b) => a.z - b.z || a.i - b.i)
    .map((x) => x.c);
}

/** Every node of the subtree in drawing order (depth first, z-sorted siblings). */
export function drawOrder(root: HNode): HNode[] {
  const out: HNode[] = [];
  const visit = (n: HNode): void => {
    out.push(n);
    for (const c of drawChildren(n)) visit(c);
  };
  visit(root);
  return out;
}

function images(n: HNode): HNode[] {
  if (n.tag === 'image') return [n];
  const found: HNode[] = [];
  const visit = (c: HNode): void => {
    for (const ch of c.children) {
      if (ch.tag === 'image') found.push(ch);
      else visit(ch);
    }
  };
  visit(n);
  return found;
}

export function createHeadlessBackend(): RendererBackend {
  return {
    createNode(tag, attrs) {
      const n: HNode = { tag, attrs, x: 0, y: 0, rotation: 0, skew: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, alpha: 1, visible: true, tint: 0xffffff, parent: null, children: [] };
      place(n, localMatrix(attrs, tag === 'image' || tag === 'text' || tag === 'rect') as M);
      if (attrs.opacity != null) n.alpha = Number(attrs.opacity);
      if (attrs.display === 'none' || attrs.visibility === 'hidden') n.visible = false;
      if (tag === 'image') n.href = attrs.href;
      return n;
    },
    setProp(node, path, value) {
      const n = node as HNode;
      switch (path) {
        case 'href': {
          const imgs = images(n);
          if (imgs.length !== 1) throw new Error(`E_BACKEND: headless: href on a group with ${imgs.length} images`);
          imgs[0].href = String(value);
          return;
        }
        case 'tint':
          n.tint = Number(value);
          for (const img of images(n)) img.tint = Number(value);
          return;
        case 'z':
          n.z = Number(value);
          return;
        case 'mix-blend-mode':
          n.blend = String(value);
          return;
        case 'visible':
          n.visible = Boolean(value);
          return;
        case 'display':
          n.visible = value !== 'none';
          return;
        case 'scale.x':
          n.scale.x = Number(value);
          return;
        case 'scale.y':
          n.scale.y = Number(value);
          return;
        case 'skew.x':
          n.skew.x = Number(value);
          return;
        case 'skew.y':
          n.skew.y = Number(value);
          return;
        case 'x':
        case 'y':
        case 'rotation':
        case 'alpha':
          n[path] = Number(value);
          return;
        default:
          throw new Error(`E_BACKEND: headless: setProp "${path}" is not supported`);
      }
    },
    getProp(node, path) {
      const n = node as HNode;
      if (path === 'z') return n.z ?? 0;
      let t: unknown = n;
      for (const part of path.split('.')) t = (t as Record<string, unknown>)?.[part];
      return t;
    },
    onClick() {},
    addChild(parent, child) {
      (child as HNode).parent = parent as HNode;
      (parent as HNode).children.push(child as HNode);
    },
    mount() {},
    getBounds() {
      return { x: 0, y: 0, w: 0, h: 0 };
    },
  } satisfies RendererBackend;
}

export type { NodeHandle };
