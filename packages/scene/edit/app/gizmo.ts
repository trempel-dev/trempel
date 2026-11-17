// gizmo.ts — the transform gizmo over the stage (an SVG in screen px), drawn in the LOCAL axes of
// the selected node (its world matrix × the view; several nodes — global axes at their common
// centre): arrows X (red) / Y (green) and the XY square at the pivot — move; the ring — rotate;
// squares at the arrows' ends — scale along an axis, the corner one — uniform; the small circle —
// the pivot itself (drag → node.setPivot keepWorld). All handles at once, small (Blender's «all
// transforms»); below 50 % zoom only the XY square and the ring. A handle starts the SAME modal
// operator as G/R/S with its axis preset (ops.ts): keys work mid-drag (type 90 while turning).

import { apply, applyVec, type Matrix, type Pt } from '../geometry';
import { opPivot, opTargets } from '../ops';
import type { Editor } from './editor';
import type { Operators } from './ops';

const NS = 'http://www.w3.org/2000/svg';
const RED = '#ff4d5e';
const GREEN = '#6bd96b';
const BLUE = '#5aa9ff';
const WHITE = '#f2f4f8';

export type GizmoHandle = 'move-x' | 'move-y' | 'move-xy' | 'rotate' | 'scale-x' | 'scale-y' | 'scale-xy' | 'pivot';

export interface GizmoLayout {
  /** Pivot on screen. */
  o: Pt;
  /** Unit axes on screen (local x / y of the node). */
  ax: Pt;
  ay: Pt;
  /** Only the XY square and the ring (zoom < 50 %). */
  compact: boolean;
  /** Handle centres (screen px). */
  at: Partial<Record<GizmoHandle, Pt>>;
  /** Arrow length / ring radius / scale squares' distance, px. */
  len: number;
  ring: number;
  far: number;
}

const unit = (v: Pt): Pt => {
  const l = Math.hypot(v.x, v.y);
  return l < 1e-12 ? { x: 1, y: 0 } : { x: v.x / l, y: v.y / l };
};
const add = (...ps: Pt[]): Pt => ps.reduce((s, p) => ({ x: s.x + p.x, y: s.y + p.y }), { x: 0, y: 0 });
const mul = (p: Pt, k: number): Pt => ({ x: p.x * k, y: p.y * k });

/**
 * Where the handles go: the pivot (scene) through the view, the axes — the node's world columns
 * through the view (null world — global axes).
 */
export function gizmoLayout(view: Matrix, world: Matrix | null, pivot: Pt, zoom: number): GizmoLayout {
  const o = apply(view, pivot);
  const ax = unit(applyVec(view, world ? { x: world[0], y: world[1] } : { x: 1, y: 0 }));
  const ay = unit(applyVec(view, world ? { x: world[2], y: world[3] } : { x: 0, y: 1 }));
  const compact = zoom < 0.5;
  const len = 72;
  const ring = 50;
  const far = 88;
  const at: GizmoLayout['at'] = { 'move-xy': add(o, mul(ax, 15), mul(ay, 15)), rotate: add(o, mul(unit(add(ax, mul(ay, -1))), ring)) };
  if (!compact) {
    at['move-x'] = add(o, mul(ax, len - 8));
    at['move-y'] = add(o, mul(ay, len - 8));
    at['scale-x'] = add(o, mul(ax, far));
    at['scale-y'] = add(o, mul(ay, far));
    at['scale-xy'] = add(o, mul(ax, far), mul(ay, far));
    at.pivot = o;
  }
  return { o, ax, ay, compact, at, len, ring, far };
}

const svg = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
};
const pts = (...ps: Pt[]): string => ps.map((p) => `${p.x},${p.y}`).join(' ');

export class Gizmo {
  /** The last drawn layout (tests, e2e: `window.tmlGizmo.layout`). */
  layout: GizmoLayout | null = null;

  constructor(
    private readonly ed: Editor,
    private readonly root: SVGSVGElement,
    private readonly ops: Operators,
    private readonly local: (e: { clientX: number; clientY: number }) => Pt,
  ) {
    for (const e of ['selection', 'render', 'layout', 'tool', 'op', 'readonly'] as const) ed.on(e, () => this.draw());
  }

  draw(): void {
    const ed = this.ed;
    const root = this.root;
    root.replaceChildren();
    this.layout = null;
    // mid-operator: only the snap guides and a dragged pivot
    if (ed.operating) {
      const g = this.ops.screenGuides();
      const W = ed.area.w;
      const H = ed.area.h;
      if (g.x != null) root.append(svg('line', { x1: g.x, y1: 0, x2: g.x, y2: H, class: 'guide' }));
      if (g.y != null) root.append(svg('line', { x1: 0, y1: g.y, x2: W, y2: g.y, class: 'guide' }));
      const p = this.ops.pickPoint();
      if (p) root.append(svg('circle', { cx: p.x, cy: p.y, r: 5, class: 'pivot-drag' }));
      return;
    }
    if (!ed.doc || ed.readOnly || ed.tool !== 'select') return;
    const targets = opTargets(ed.doc.scene, ed.selection.filter((p) => !ed.skipped(p)), ed.bounds, (p) => ed.ref(p), (r) => ed.doc?.instance(r) ?? null);
    if (!targets.length) return;
    const one = targets.length === 1 ? targets[0] : null;
    const L = gizmoLayout(ed.view(), one ? one.world : null, opPivot(targets), ed.zoomValue());
    this.layout = L;
    const { o, ax, ay, at } = L;
    const g = svg('g', { class: 'gizmo' });

    const handle = (kind: GizmoHandle, el: SVGElement, hit?: SVGElement): void => {
      for (const e of hit ? [hit, el] : [el]) {
        e.classList.add('gz');
        e.dataset.h = kind;
        e.addEventListener('pointerdown', (ev) => this.down(kind, ev as PointerEvent));
      }
      if (hit) g.append(hit);
      g.append(el);
    };

    // ring — rotate (a transparent wide stroke catches the pointer)
    handle('rotate', svg('circle', { cx: o.x, cy: o.y, r: L.ring, fill: 'none', stroke: BLUE, 'stroke-width': 1.5, 'stroke-opacity': 0.8 }), svg('circle', { cx: o.x, cy: o.y, r: L.ring, fill: 'none', stroke: 'transparent', 'stroke-width': 10 }));
    if (!L.compact) {
      const arrow = (kind: GizmoHandle, dir: Pt, color: string): void => {
        const a = add(o, mul(dir, 24));
        const b = add(o, mul(dir, L.len - 10));
        const tip = add(o, mul(dir, L.len));
        const n = { x: -dir.y, y: dir.x };
        const line = svg('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: color, 'stroke-width': 2 });
        const head = svg('polygon', { points: pts(tip, add(b, mul(n, 5)), add(b, mul(n, -5))), fill: color });
        const hit = svg('line', { x1: a.x, y1: a.y, x2: tip.x, y2: tip.y, stroke: 'transparent', 'stroke-width': 12 });
        handle(kind, line, hit);
        handle(kind, head);
      };
      arrow('move-x', ax, RED);
      arrow('move-y', ay, GREEN);
      const sq = (kind: GizmoHandle, c: Pt, color: string): void => {
        const s = 4;
        handle(kind, svg('polygon', { points: pts(add(c, mul(ax, -s), mul(ay, -s)), add(c, mul(ax, s), mul(ay, -s)), add(c, mul(ax, s), mul(ay, s)), add(c, mul(ax, -s), mul(ay, s))), fill: color, stroke: '#111', 'stroke-width': 0.75 }));
      };
      sq('scale-x', at['scale-x']!, RED);
      sq('scale-y', at['scale-y']!, GREEN);
      sq('scale-xy', at['scale-xy']!, WHITE);
    }
    // XY square at the pivot — free move
    const q0 = add(o, mul(ax, 9), mul(ay, 9));
    const q = (u: number, v: number): Pt => add(q0, mul(ax, u), mul(ay, v));
    handle('move-xy', svg('polygon', { points: pts(q(0, 0), q(12, 0), q(12, 12), q(0, 12)), fill: 'rgba(90,169,255,0.35)', stroke: BLUE, 'stroke-width': 1 }));
    if (!L.compact) handle('pivot', svg('circle', { cx: o.x, cy: o.y, r: 4, fill: '#111', stroke: WHITE, 'stroke-width': 1.5 }));
    root.append(g);
  }

  private down(kind: GizmoHandle, e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const at = this.local(e);
    const ops = this.ops;
    switch (kind) {
      case 'move-x':
        ops.start('G', { axis: 'x', drag: true, at });
        break;
      case 'move-y':
        ops.start('G', { axis: 'y', drag: true, at });
        break;
      case 'move-xy':
        ops.start('G', { drag: true, at });
        break;
      case 'rotate':
        ops.start('R', { drag: true, at });
        break;
      case 'scale-x':
        ops.start('S', { axis: 'x', drag: true, at });
        break;
      case 'scale-y':
        ops.start('S', { axis: 'y', drag: true, at });
        break;
      case 'scale-xy':
        ops.start('S', { drag: true, at });
        break;
      case 'pivot':
        ops.pickPivot({ drag: true, at });
        break;
    }
  }
}
