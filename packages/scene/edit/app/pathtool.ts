// pathtool.ts — the contour tool for <path> (and the two ends of a <line>): an SVG layer in screen
// space with the anchors (square — corner, circle — smooth) and the selected anchor's Bezier
// handles. Feedback while dragging is this overlay (the pure path edits of editor/path.ts on a
// copy); the release is one core command — path.setPoint / path.setHandle (Alt — break the link),
// Alt+click on the contour — path.insertPoint at the nearest t, Delete — path.removePoint, double
// click on an anchor — path.setNodeType, C / O — path.close / path.open, Esc / Enter — leave.

import { parsePathData } from '../../src/core.js';
import { anchorPoints, handlesAt, nodeTypeAt, segmentCurves, setHandle, setPoint, subpathAt, toEditCmds, type EditCmd } from '../../editor/path.js';
import { apply, invert, multiply, nodeWorld, type Matrix, type Pt } from '../geometry';
import type { Editor } from './editor';

const NS = 'http://www.w3.org/2000/svg';
const el = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
};
const r2 = (v: number): number => Math.round(v * 100) / 100;

interface Drag {
  kind: 'point' | 'handle';
  index: number;
  which?: 'in' | 'out';
  linked: boolean;
  moved: boolean;
  to?: Pt;
}

export class PathTool {
  /** Selected anchor. */
  index: number | null = null;
  private drag: Drag | null = null;
  private preview: EditCmd[] | null = null;
  /** After an insert: select the anchor nearest to this screen point on the next draw. */
  private selectNear: Pt | null = null;

  constructor(
    private readonly ed: Editor,
    private readonly root: SVGSVGElement,
  ) {
    for (const e of ['selection', 'render', 'layout', 'tool'] as const) ed.on(e, () => this.draw());
    root.addEventListener('pointerdown', (e) => this.down(e));
    root.addEventListener('pointermove', (e) => this.move(e));
    root.addEventListener('pointerup', (e) => this.up(e));
    root.addEventListener('dblclick', (e) => this.dbl(e));
    let last = '';
    ed.on('tool', () => {
      const p = ed.tool === 'path' ? ed.selection[0] : '';
      if (p !== last) this.index = null;
      last = p;
    });
  }

  get active(): boolean {
    return this.ed.tool === 'path' && this.ed.selection.length === 1;
  }

  private target(): { path: string; tag: string; cmds: EditCmd[]; S: Matrix } | null {
    const ed = this.ed;
    if (!this.active || !ed.doc) return null;
    const path = ed.selection[0];
    const n = ed.node(path);
    if (!n) return null;
    let cmds: EditCmd[];
    try {
      if (n.tag === 'path') cmds = toEditCmds(parsePathData(n.attrs.d ?? ''));
      else if (n.tag === 'line') {
        const v = (k: string): number => Number(n.attrs[k] ?? 0) || 0;
        cmds = [['M', v('x1'), v('y1')], ['L', v('x2'), v('y2')]];
      } else return null;
      return { path, tag: n.tag, cmds, S: multiply(ed.view(), nodeWorld(ed.doc.scene, path)) };
    } catch {
      return null;
    }
  }

  draw(): void {
    const root = this.root;
    root.toggleAttribute('hidden', !this.active);
    root.replaceChildren();
    const t = this.target();
    if (!t) return;
    const cmds = this.preview ?? t.cmds;
    const S = t.S;
    const P = (p: Pt): Pt => apply(S, p);
    const d = cmds
      .map((c) => {
        if (c[0] === 'Z') return 'Z';
        if (c[0] === 'C') {
          const [a, b, e] = [P({ x: c[1], y: c[2] }), P({ x: c[3], y: c[4] }), P({ x: c[5], y: c[6] })];
          return `C${a.x} ${a.y} ${b.x} ${b.y} ${e.x} ${e.y}`;
        }
        const p = P({ x: c[1], y: c[2] });
        return `${c[0]}${p.x} ${p.y}`;
      })
      .join('');
    root.append(el('path', { d, fill: 'none', stroke: '#000', 'stroke-opacity': 0.5, 'stroke-width': 4 }));
    root.append(el('path', { d, fill: 'none', stroke: '#4af2c8', 'stroke-width': 1.5, class: 'contour' }));
    const pts = anchorPoints(cmds);
    if (this.selectNear && !this.preview) {
      const m = this.selectNear;
      let best = -1;
      let dist = Infinity;
      pts.forEach((p, i) => {
        const s = P(p);
        const dd = Math.hypot(s.x - m.x, s.y - m.y);
        if (dd < dist) [best, dist] = [i, dd];
      });
      if (best >= 0 && dist < 3) {
        this.index = best;
        this.selectNear = null;
      }
    }
    if (this.index != null && this.index >= pts.length) this.index = null;
    if (this.index != null && t.tag === 'path') {
      const h = handlesAt(cmds, this.index);
      const a = P(pts[this.index]);
      for (const which of ['in', 'out'] as const) {
        const hp = h[which];
        if (!hp) continue;
        const s = P(hp);
        root.append(el('line', { x1: a.x, y1: a.y, x2: s.x, y2: s.y, stroke: '#ffd25e', 'stroke-width': 1 }));
        root.append(el('circle', { cx: s.x, cy: s.y, r: 4, fill: '#ffd25e', stroke: '#000', 'stroke-width': 1, 'data-handle': which, class: 'handle' }));
      }
    }
    pts.forEach((p, i) => {
      const s = P(p);
      const on = i === this.index;
      const smooth = t.tag === 'path' && nodeTypeAt(cmds, i) === 'smooth';
      const common = { fill: on ? '#4af2c8' : '#15171c', stroke: '#4af2c8', 'stroke-width': 1.5, 'data-index': i, class: 'anchor' };
      root.append(smooth ? el('circle', { cx: s.x, cy: s.y, r: 5, ...common }) : el('rect', { x: s.x - 4.5, y: s.y - 4.5, width: 9, height: 9, ...common }));
    });
  }

  private local(e: PointerEvent | MouseEvent, S: Matrix): Pt {
    const r = this.root.getBoundingClientRect();
    return apply(invert(S), { x: e.clientX - r.left, y: e.clientY - r.top });
  }

  private down(e: PointerEvent): void {
    const t = this.target();
    if (!t) return;
    const tgt = e.target as SVGElement;
    const idx = tgt.getAttribute('data-index');
    const which = tgt.getAttribute('data-handle') as 'in' | 'out' | null;
    if (idx != null) {
      this.index = Number(idx);
      this.drag = { kind: 'point', index: this.index, linked: false, moved: false };
    } else if (which && this.index != null) {
      const smooth = nodeTypeAt(t.cmds, this.index) === 'smooth';
      this.drag = { kind: 'handle', index: this.index, which, linked: smooth && !e.altKey, moved: false };
    } else if (e.altKey) {
      this.insertAt(e, t);
      return;
    } else {
      // on the contour — drop the anchor selection; anywhere else — leave the tool (as Esc)
      const r = this.root.getBoundingClientRect();
      const near = nearestOnContour(t.cmds, t.S, { x: e.clientX - r.left, y: e.clientY - r.top });
      this.index = null;
      if (near && near.dist <= 6) this.draw();
      else this.ed.setTool('select');
      return;
    }
    this.root.setPointerCapture(e.pointerId);
    e.preventDefault();
    this.draw();
  }

  private move(e: PointerEvent): void {
    const d = this.drag;
    const t = d && this.target();
    if (!d || !t) return;
    const p = this.local(e, t.S);
    d.moved = true;
    d.to = p;
    try {
      this.preview = d.kind === 'point' ? setPoint(t.cmds, d.index, p) : setHandle(t.cmds, d.index, d.which!, p, d.linked);
    } catch {
      this.preview = null;
    }
    this.draw();
  }

  private up(e: PointerEvent): void {
    const d = this.drag;
    this.drag = null;
    this.preview = null;
    if (this.root.hasPointerCapture(e.pointerId)) this.root.releasePointerCapture(e.pointerId);
    const t = this.target();
    if (!d || !t || !d.moved || !d.to) {
      this.draw();
      return;
    }
    const ref = this.ed.ref(t.path);
    const x = r2(d.to.x);
    const y = r2(d.to.y);
    if (t.tag === 'line') {
      const [kx, ky] = d.index === 0 ? ['x1', 'y1'] : ['x2', 'y2'];
      this.ed.batch('точка линии', [
        { name: 'node.setAttr', args: { node: ref, name: kx, value: x } },
        { name: 'node.setAttr', args: { node: ref, name: ky, value: y } },
      ]);
    } else if (d.kind === 'point') this.ed.exec('path.setPoint', { node: ref, index: d.index, x, y });
    else this.ed.exec('path.setHandle', { node: ref, index: d.index, which: d.which, x, y, linked: d.linked });
    this.draw();
  }

  /** Alt+click on the contour: a point at the nearest t of the nearest segment. */
  private insertAt(e: PointerEvent, t: NonNullable<ReturnType<PathTool['target']>>): void {
    if (t.tag !== 'path') {
      this.ed.log('warn', 'у <line> только две точки — для изгиба нужен <path>');
      return;
    }
    const r = this.root.getBoundingClientRect();
    const m = { x: e.clientX - r.left, y: e.clientY - r.top };
    const hit = nearestOnContour(t.cmds, t.S, m);
    if (!hit || hit.dist > 10) return;
    e.preventDefault();
    const res = this.ed.exec('path.insertPoint', { node: this.ed.ref(t.path), segment: hit.segment, t: hit.t });
    if (res?.ok) this.selectNear = m;
  }

  private dbl(e: MouseEvent): void {
    const t = this.target();
    const idx = (e.target as SVGElement).getAttribute?.('data-index');
    if (!t || idx == null || t.tag !== 'path') return;
    const i = Number(idx);
    const type = nodeTypeAt(t.cmds, i) === 'smooth' ? 'corner' : 'smooth';
    this.ed.exec('path.setNodeType', { node: this.ed.ref(t.path), index: i, type });
  }

  /** Keys while the tool is on; true — handled. */
  key(e: KeyboardEvent): boolean {
    const t = this.target();
    if (!t) return false;
    const ref = this.ed.ref(t.path);
    if (e.key === 'Escape' || e.key === 'Enter') {
      this.ed.setTool('select');
      return true;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.index != null) {
      if (t.tag !== 'path') return true;
      const res = this.ed.exec('path.removePoint', { node: ref, index: this.index });
      if (res?.ok) this.index = null;
      return true;
    }
    if ((e.key === 'c' || e.key === 'C' || e.key === 'o' || e.key === 'O') && !e.metaKey && !e.ctrlKey && t.tag === 'path') {
      const sub = this.index != null ? subpathAt(t.cmds, this.index).subpath : undefined;
      this.ed.exec(e.key.toLowerCase() === 'c' ? 'path.close' : 'path.open', sub == null ? { node: ref } : { node: ref, subpath: sub });
      return true;
    }
    return false;
  }
}

/** Nearest point of the contour to a screen point: segment number (path.insertPoint's), t, distance (px). */
export function nearestOnContour(cmds: EditCmd[], S: Matrix, m: Pt): { segment: number; t: number; dist: number } | null {
  const segs = segmentCurves(cmds);
  let best: { segment: number; t: number; dist: number } | null = null;
  const at = (s: (typeof segs)[number], t: number): Pt => {
    if (!s.c1 || !s.c2) return { x: s.start.x + (s.end.x - s.start.x) * t, y: s.start.y + (s.end.y - s.start.y) * t };
    const u = 1 - t;
    return {
      x: u * u * u * s.start.x + 3 * u * u * t * s.c1.x + 3 * u * t * t * s.c2.x + t * t * t * s.end.x,
      y: u * u * u * s.start.y + 3 * u * u * t * s.c1.y + 3 * u * t * t * s.c2.y + t * t * t * s.end.y,
    };
  };
  segs.forEach((s, k) => {
    const N = 200;
    for (let i = 1; i < N; i++) {
      const t = i / N;
      const p = apply(S, at(s, t));
      const dist = Math.hypot(p.x - m.x, p.y - m.y);
      if (!best || dist < best.dist) best = { segment: k, t, dist };
    }
  });
  if (!best) return null;
  const b = best as { segment: number; t: number; dist: number };
  return { ...b, t: Math.round(b.t * 10000) / 10000 };
}
