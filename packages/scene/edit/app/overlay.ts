// overlay.ts — the editor's own drawing over the canvas (an SVG in screen space): frames of the
// selection and the scope, the hovered node, and service geometry — <defs> content dashed (paths
// as lines, clipPath shapes as outlines, drawn in the space of every node that uses them). The
// runtime never draws these; the layer does, and a click on a dashed stroke selects that element.
// v1.0: the slice lines of a selected <image data-slices> (the borders that do not stretch).

import { type SceneNode } from '../../src/core.js';
import { parseClipRef } from '../../src/geom/check.js';
import { parseSlices } from '../../src/layout.js';
import { mapBox, multiply, nodeWorld, ownMatrix, type Matrix } from '../geometry';
import type { Editor } from './editor';

const NS = 'http://www.w3.org/2000/svg';
const SHAPES = new Set(['path', 'line', 'rect', 'circle', 'ellipse']);
const GEOM_ATTRS = ['d', 'x', 'y', 'width', 'height', 'rx', 'ry', 'cx', 'cy', 'r', 'x1', 'y1', 'x2', 'y2', 'transform'];

const svg = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
};

const mtx = (m: Matrix): string => `matrix(${m.join(' ')})`;

export class Overlay {
  hover: string | null = null;

  constructor(
    private readonly ed: Editor,
    private readonly root: SVGSVGElement,
  ) {
    for (const e of ['selection', 'render', 'layout', 'tool', 'op'] as const) ed.on(e, () => this.draw());
  }

  setHover(path: string | null): void {
    if (path === this.hover) return;
    this.hover = path;
    this.draw();
  }

  draw(): void {
    const ed = this.ed;
    const root = this.root;
    root.replaceChildren();
    const doc = ed.doc;
    if (!doc || ed.readOnly) return; // a clip poses the stage: the frames would be the rest pose's
    const V = ed.view();

    if (ed.showService) this.service(doc.scene, V);

    const frame = (path: string, cls: string, color: string, dash: string): void => {
      const b = ed.bounds.get(path);
      if (!b) return;
      const s = mapBox(V, b);
      root.append(svg('rect', { x: s.x - 0.5, y: s.y - 0.5, width: s.w + 1, height: s.h + 1, fill: 'none', stroke: color, 'stroke-width': 1, 'stroke-dasharray': dash, class: cls }));
    };
    if (ed.scope !== '') frame(ed.scope, 'scope', '#8a909c', '2 3');
    if (this.hover && !ed.selection.includes(this.hover)) frame(this.hover, 'hover', '#6aa8ff', '');
    // selection frames (the gizmo shows the axes); hidden while an operator moves the nodes
    // v0.9: an instance's border is dashed — it is one node, its inside is the prefab's
    if (!ed.operating) for (const p of ed.selection) frame(p, ed.node(p)?.tag === 'use' ? 'sel instance' : 'sel', '#4af2c8', ed.tool === 'path' || ed.node(p)?.tag === 'use' ? '4 3' : '');
    if (!ed.operating && ed.selection.length === 1) this.slices(doc.scene, ed.selection[0], V);
  }

  /** v1.0: the four slice lines of a selected 9-slice image, in its own space. */
  private slices(scene: SceneNode, path: string, V: Matrix): void {
    const n = this.ed.node(path);
    const raw = n?.tag === 'image' ? n.attrs['data-slices'] : undefined;
    if (!n || raw == null) return;
    let l: number, t: number, r: number, b: number;
    try {
      [l, t, r, b] = parseSlices(raw);
    } catch {
      return;
    }
    const num = (v: string | undefined): number => (v == null ? 0 : Number(v) || 0);
    const x = num(n.attrs.x);
    const y = num(n.attrs.y);
    const w = num(n.attrs.width);
    const h = num(n.attrs.height);
    if (!(w > 0 && h > 0)) return;
    const g = svg('g', { transform: mtx(multiply(V, nodeWorld(scene, path))), class: 'slices', 'data-path': path });
    const line = (x1: number, y1: number, x2: number, y2: number, side: string): void => {
      g.append(
        svg('line', { x1, y1, x2, y2, stroke: '#ffb347', 'stroke-width': 1, 'stroke-dasharray': '5 3', 'vector-effect': 'non-scaling-stroke', class: `slice ${side}`, 'pointer-events': 'none' }),
      );
    };
    line(x + l, y, x + l, y + h, 'l');
    line(x + w - r, y, x + w - r, y + h, 'r');
    line(x, y + t, x + w, y + t, 't');
    line(x, y + h - b, x + w, y + h - b, 'b');
    this.root.append(g);
  }

  /** <defs> content dashed: geometry in its own space, clip shapes in each user's space. */
  private service(scene: SceneNode, V: Matrix): void {
    const ed = this.ed;
    const defsIdx = scene.children.findIndex((c) => c.tag === 'defs');
    if (defsIdx < 0) return;
    const defs = scene.children[defsIdx];
    const users = new Map<string, string[]>();
    const visit = (n: SceneNode, path: string): void => {
      const id = parseClipRef(n.attrs['clip-path']);
      if (id) users.set(id, [...(users.get(id) ?? []), path]);
      n.children.forEach((c, i) => visit(c, path === '' ? String(i) : `${path}/${i}`));
    };
    visit(scene, '');
    const draw = (n: SceneNode, path: string, space: Matrix, color: string): void => {
      if (SHAPES.has(n.tag)) {
        const attrs: Record<string, string> = {};
        for (const k of GEOM_ATTRS) if (n.attrs[k] != null) attrs[k] = n.attrs[k];
        const g = svg('g', { transform: mtx(space) });
        const sel = ed.selection.includes(path);
        const shape = svg(n.tag as 'path', {
          ...attrs,
          fill: 'none',
          stroke: color,
          'stroke-width': sel ? 2.5 : 1.5,
          'stroke-dasharray': '6 4',
          'vector-effect': 'non-scaling-stroke',
          class: 'service',
          'data-path': path,
        });
        shape.addEventListener('pointerdown', (e) => {
          if (ed.tool !== 'select') return;
          e.stopPropagation();
          ed.select([path], { add: e.shiftKey, scope: path.slice(0, path.lastIndexOf('/')) });
        });
        g.append(shape);
        this.root.append(g);
        return;
      }
      n.children.forEach((c, i) => draw(c, `${path}/${i}`, n.tag === 'g' ? multiply(space, transformOf(n)) : space, color));
    };
    defs.children.forEach((c, i) => {
      const path = `${defsIdx}/${i}`;
      if (c.tag === 'clipPath') {
        const spaces = (users.get(c.attrs.id ?? '') ?? []).map((u) => nodeWorld(scene, u));
        if (!spaces.length) spaces.push([1, 0, 0, 1, 0, 0]);
        for (const s of spaces) {
          const own = multiply(multiply(V, s), transformOf(c));
          c.children.forEach((k, j) => draw(k, `${path}/${j}`, own, '#ff7ad9'));
        }
      } else {
        draw(c, path, multiply(V, nodeWorld(scene, String(defsIdx))), '#6ae0ff');
      }
    });
  }
}

function transformOf(n: SceneNode): Matrix {
  try {
    return ownMatrix(n);
  } catch {
    return [1, 0, 0, 1, 0, 0];
  }
}
