// path.ts — path-tool geometry over absolute M L C Z commands (pure, no DOM).
//
// Addressing (what the path.* commands take):
//   - node `index` — the i-th anchor point: every M, L, C command ends at one (Z does not);
//   - `segment` — the i-th drawn segment: every L and C, plus the closing line of a Z when it has
//     length (the last anchor is not on the start point).
// A closed subpath whose last anchor sits on its M point (circles, most editors' output) treats
// the two as one node: moving either moves both, the in-handle of M is the last curve's.

import type { PathCmd } from '@trempel/scene/core';
import { fmt } from './num.js';

export type EditCmd = ['M', number, number] | ['L', number, number] | ['C', number, number, number, number, number, number] | ['Z'];

export interface Pt {
  x: number;
  y: number;
}

/** Thrown for a bad index / impossible edit; the command turns it into `ok: false`. */
export class PathEditError extends Error {}

/** True when `d` uses anything besides absolute M L C Z (relative, H V S T Q A). */
export function needsNormalize(d: string): boolean {
  const letters = d.match(/[A-DF-Za-df-z]/g) ?? [];
  return letters.some((c) => !'MLCZ'.includes(c));
}

/** Parsed (absolute M L C Q A Z) → M L C Z: Q exactly as a cubic, A approximated by cubics. */
export function toEditCmds(cmds: PathCmd[]): EditCmd[] {
  const out: EditCmd[] = [];
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  for (const c of cmds) {
    switch (c[0]) {
      case 'M':
        out.push(['M', c[1], c[2]]);
        cx = sx = c[1];
        cy = sy = c[2];
        break;
      case 'L':
        out.push(['L', c[1], c[2]]);
        cx = c[1];
        cy = c[2];
        break;
      case 'C':
        out.push(['C', c[1], c[2], c[3], c[4], c[5], c[6]]);
        cx = c[5];
        cy = c[6];
        break;
      case 'Q': {
        const [, qx, qy, x, y] = c;
        out.push(['C', cx + (2 / 3) * (qx - cx), cy + (2 / 3) * (qy - cy), x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), x, y]);
        cx = x;
        cy = y;
        break;
      }
      case 'A': {
        const [, rx, ry, rot, large, sweep, x, y] = c;
        out.push(...arcToCubics(cx, cy, rx, ry, rot, large, sweep, x, y));
        cx = x;
        cy = y;
        break;
      }
      case 'Z':
        out.push(['Z']);
        cx = sx;
        cy = sy;
        break;
    }
  }
  return out;
}

/** SVG elliptical arc (endpoint form, F.6.5) → cubic segments of ≤ 90° each. */
export function arcToCubics(
  x1: number,
  y1: number,
  rx: number,
  ry: number,
  rotDeg: number,
  large: number,
  sweep: number,
  x2: number,
  y2: number,
): EditCmd[] {
  if (x1 === x2 && y1 === y2) return [];
  if (rx === 0 || ry === 0) return [['L', x2, y2]];
  const phi = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const k = Math.sqrt(lambda);
    rx *= k;
    ry *= k;
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let coef = Math.sqrt(Math.max(0, num / den));
  if (large === sweep) coef = -coef;
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;

  const angle = (ux: number, uy: number, vx: number, vy: number): number => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const th1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dth = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dth > 0) dth -= 2 * Math.PI;
  else if (sweep && dth < 0) dth += 2 * Math.PI;

  const n = Math.max(1, Math.ceil(Math.abs(dth) / (Math.PI / 2) - 1e-9));
  const step = dth / n;
  const k = (4 / 3) * Math.tan(step / 4);
  const out: EditCmd[] = [];
  const pt = (t: number): Pt => ({
    x: cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin,
    y: cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos,
  });
  const dpt = (t: number): Pt => ({
    x: -rx * Math.sin(t) * cos - ry * Math.cos(t) * sin,
    y: -rx * Math.sin(t) * sin + ry * Math.cos(t) * cos,
  });
  for (let i = 0; i < n; i++) {
    const a = th1 + i * step;
    const b = a + step;
    const p0 = pt(a);
    const p3 = i === n - 1 ? { x: x2, y: y2 } : pt(b);
    const d0 = dpt(a);
    const d3 = dpt(b);
    out.push(['C', p0.x + k * d0.x, p0.y + k * d0.y, p3.x - k * d3.x, p3.y - k * d3.y, p3.x, p3.y]);
  }
  return out;
}

/** Commands → compact `d` ("M10 20L30 40C… Z"), numbers via fmt. */
export function printPath(cmds: EditCmd[]): string {
  return cmds
    .map((c) => c[0] + c.slice(1).map((v) => fmt(v as number)).join(' '))
    .join('');
}

/** Any parsed command list (M L C Q A Z) → `d`, numbers via fmt (node.move keeps arcs as arcs). */
export function printParsed(cmds: PathCmd[]): string {
  return cmds.map((c) => c[0] + c.slice(1).map((v) => fmt(v as number)).join(' ')).join('');
}

// ---- structure -----------------------------------------------------------------------------

interface Sub {
  /** Command index of M. */
  m: number;
  /** Index of the last non-Z command of the subpath. */
  last: number;
  /** Command index of the closing Z, or -1. */
  z: number;
}

function subpaths(cmds: EditCmd[]): Sub[] {
  const out: Sub[] = [];
  for (let i = 0; i < cmds.length; i++) {
    const c = cmds[i];
    if (c[0] === 'M') out.push({ m: i, last: i, z: -1 });
    else if (c[0] === 'Z') {
      if (out.length) out[out.length - 1].z = i;
    } else if (out.length) out[out.length - 1].last = i;
  }
  return out;
}

const endOf = (c: EditCmd): Pt => (c[0] === 'C' ? { x: c[5], y: c[6] } : c[0] === 'Z' ? { x: NaN, y: NaN } : { x: c[1], y: c[2] });

function setEnd(c: EditCmd, p: Pt): void {
  if (c[0] === 'C') {
    c[5] = p.x;
    c[6] = p.y;
  } else if (c[0] !== 'Z') {
    c[1] = p.x;
    c[2] = p.y;
  }
}

const same = (a: Pt, b: Pt): boolean => Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9;

/** Command indices of the anchors, in order. */
export function anchors(cmds: EditCmd[]): number[] {
  const out: number[] = [];
  cmds.forEach((c, i) => {
    if (c[0] !== 'Z') out.push(i);
  });
  return out;
}

export function anchorPoints(cmds: EditCmd[]): Pt[] {
  return anchors(cmds).map((i) => endOf(cmds[i]));
}

function locate(cmds: EditCmd[], index: number): { ci: number; sub: Sub } {
  const list = anchors(cmds);
  if (!Number.isInteger(index) || index < 0 || index >= list.length) {
    throw new PathEditError(`точки ${index} нет — у контура ${list.length} точек (0…${list.length - 1})`);
  }
  const ci = list[index];
  const sub = subpaths(cmds).filter((s) => s.m <= ci).pop()!;
  return { ci, sub };
}

/** The coincident partner of a closed subpath's start/last anchor (command index), or -1. */
function twin(cmds: EditCmd[], ci: number, sub: Sub): number {
  if (sub.z < 0 || sub.last === sub.m) return -1;
  if (!same(endOf(cmds[sub.m]), endOf(cmds[sub.last]))) return -1;
  if (ci === sub.m) return sub.last;
  if (ci === sub.last) return sub.m;
  return -1;
}

/** A handle slot: command index + which control point (1 = x1 y1, 2 = x2 y2). */
interface HandleRef {
  ci: number;
  slot: 1 | 2;
}

const getH = (cmds: EditCmd[], h: HandleRef): Pt => {
  const c = cmds[h.ci] as ['C', number, number, number, number, number, number];
  return h.slot === 1 ? { x: c[1], y: c[2] } : { x: c[3], y: c[4] };
};
const setH = (cmds: EditCmd[], h: HandleRef, p: Pt): void => {
  const c = cmds[h.ci] as ['C', number, number, number, number, number, number];
  if (h.slot === 1) {
    c[1] = p.x;
    c[2] = p.y;
  } else {
    c[3] = p.x;
    c[4] = p.y;
  }
};

/** Command index of the segment that ends at the anchor (the in side), or -1. */
function inSeg(cmds: EditCmd[], ci: number, sub: Sub): number {
  if (cmds[ci][0] !== 'M') return ci;
  const tw = twin(cmds, ci, sub);
  return tw >= 0 ? tw : -1;
}

/** Command index of the segment that starts at the anchor (the out side), or -1. */
function outSeg(cmds: EditCmd[], ci: number, sub: Sub): number {
  const next = cmds[ci + 1];
  if (next && (next[0] === 'L' || next[0] === 'C')) return ci + 1;
  const tw = twin(cmds, ci, sub);
  if (tw === sub.m) {
    const first = cmds[sub.m + 1];
    if (first && (first[0] === 'L' || first[0] === 'C')) return sub.m + 1;
  }
  return -1;
}

/** Start point of the segment at command index `si`. */
function segStart(cmds: EditCmd[], si: number): Pt {
  return endOf(cmds[si - 1]);
}

/** An L segment → the same line as a C (control points on the ends), in place. */
function lineToCurve(cmds: EditCmd[], si: number): void {
  const c = cmds[si];
  if (c[0] !== 'L') return;
  const a = segStart(cmds, si);
  cmds[si] = ['C', a.x, a.y, c[1], c[2], c[1], c[2]];
}

/**
 * A closed subpath whose closing Z draws a line: make that line an explicit segment ending on M,
 * so start and last become one node (needed to put a handle on it). True when it did.
 */
function explicitClose(cmds: EditCmd[], sub: Sub): boolean {
  if (sub.z < 0 || sub.last === sub.m) return false;
  const start = endOf(cmds[sub.m]);
  if (same(start, endOf(cmds[sub.last]))) return false;
  cmds.splice(sub.z, 0, ['L', start.x, start.y]);
  return true;
}

function handleRef(cmds: EditCmd[], ci: number, sub: Sub, which: 'in' | 'out', convert: boolean): HandleRef | null {
  const si = which === 'in' ? inSeg(cmds, ci, sub) : outSeg(cmds, ci, sub);
  if (si < 0) return null;
  if (cmds[si][0] === 'L') {
    if (!convert) return null;
    lineToCurve(cmds, si);
  }
  return { ci: si, slot: which === 'in' ? 2 : 1 };
}

// ---- edits (each returns a new command list) -------------------------------------------------

const copy = (cmds: EditCmd[]): EditCmd[] => cmds.map((c) => [...c] as EditCmd);

export function setPoint(src: EditCmd[], index: number, p: Pt): EditCmd[] {
  const cmds = copy(src);
  const { ci, sub } = locate(cmds, index);
  const old = endOf(cmds[ci]);
  const dx = p.x - old.x;
  const dy = p.y - old.y;
  const hin = handleRef(cmds, ci, sub, 'in', false);
  const hout = handleRef(cmds, ci, sub, 'out', false);
  for (const h of [hin, hout]) {
    if (!h) continue;
    const q = getH(cmds, h);
    setH(cmds, h, { x: q.x + dx, y: q.y + dy });
  }
  const tw = twin(cmds, ci, sub);
  setEnd(cmds[ci], p);
  if (tw >= 0) setEnd(cmds[tw], p);
  return cmds;
}

export function setHandle(src: EditCmd[], index: number, which: 'in' | 'out', p: Pt, linked: boolean): EditCmd[] {
  const cmds = copy(src);
  let { ci, sub } = locate(cmds, index);
  if (handleRef(copy(cmds), ci, sub, which, true) == null && explicitClose(cmds, sub)) {
    ({ ci, sub } = locate(cmds, index));
  }
  const h = handleRef(cmds, ci, sub, which, true);
  if (!h) {
    throw new PathEditError(
      which === 'in' ? `у точки ${index} нет входящего сегмента — ручке «in» не на чем быть` : `у точки ${index} нет исходящего сегмента — ручке «out» не на чем быть`,
    );
  }
  setH(cmds, h, p);
  if (linked) {
    const opp = handleRef(cmds, ci, sub, which === 'in' ? 'out' : 'in', true);
    if (opp) {
      const a = endOf(cmds[ci]);
      setH(cmds, opp, { x: 2 * a.x - p.x, y: 2 * a.y - p.y });
    }
  }
  return cmds;
}

export function setNodeType(src: EditCmd[], index: number, type: 'corner' | 'smooth'): EditCmd[] {
  const cmds = copy(src);
  if (type === 'corner') {
    locate(cmds, index);
    return cmds; // handles are independent already: SVG stores no node type
  }
  const { ci, sub } = locate(cmds, index);
  const siIn = inSeg(cmds, ci, sub);
  const siOut = outSeg(cmds, ci, sub);
  if (siIn < 0 || siOut < 0) return cmds; // an end point: nothing to align with
  const a = endOf(cmds[ci]);
  const prev = segStart(cmds, siIn);
  const next = endOf(cmds[siOut]);
  const hin = handleRef(cmds, ci, sub, 'in', true)!;
  const hout = handleRef(cmds, ci, sub, 'out', true)!;
  const pin = getH(cmds, hin);
  const pout = getH(cmds, hout);
  const vin = { x: a.x - pin.x, y: a.y - pin.y };
  const vout = { x: pout.x - a.x, y: pout.y - a.y };
  const len = (v: Pt): number => Math.hypot(v.x, v.y);
  const unit = (v: Pt): Pt => {
    const l = len(v);
    return l > 0 ? { x: v.x / l, y: v.y / l } : { x: 0, y: 0 };
  };
  let dir: Pt;
  if (len(vin) > 0 && len(vout) > 0) {
    const ui = unit(vin);
    const uo = unit(vout);
    dir = unit({ x: ui.x + uo.x, y: ui.y + uo.y });
    if (len(dir) === 0) dir = uo;
  } else if (len(vout) > 0) dir = unit(vout);
  else if (len(vin) > 0) dir = unit(vin);
  else dir = unit({ x: next.x - prev.x, y: next.y - prev.y });
  if (len(dir) === 0) return cmds;
  const lin = len(vin) > 0 ? len(vin) : Math.hypot(a.x - prev.x, a.y - prev.y) / 3;
  const lout = len(vout) > 0 ? len(vout) : Math.hypot(next.x - a.x, next.y - a.y) / 3;
  setH(cmds, hin, { x: a.x - dir.x * lin, y: a.y - dir.y * lin });
  setH(cmds, hout, { x: a.x + dir.x * lout, y: a.y + dir.y * lout });
  return cmds;
}

/** de Casteljau split of a cubic at t → two cubics (control points + ends). */
export function splitCubic(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): [Pt[], Pt[]] {
  const lerp = (a: Pt, b: Pt): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const a = lerp(p0, p1);
  const b = lerp(p1, p2);
  const c = lerp(p2, p3);
  const d = lerp(a, b);
  const e = lerp(b, c);
  const m = lerp(d, e);
  return [
    [p0, a, d, m],
    [m, e, c, p3],
  ];
}

/** Drawn segments: command index (L/C) or the Z index for a closing line with length. */
export function segments(cmds: EditCmd[]): number[] {
  const out: number[] = [];
  for (const sub of subpaths(cmds)) {
    for (let i = sub.m + 1; i <= sub.last; i++) out.push(i);
    if (sub.z >= 0 && !same(endOf(cmds[sub.m]), endOf(cmds[sub.last]))) out.push(sub.z);
  }
  return out;
}

export function insertPoint(src: EditCmd[], segment: number, t: number): EditCmd[] {
  const cmds = copy(src);
  const segs = segments(cmds);
  if (!Number.isInteger(segment) || segment < 0 || segment >= segs.length) {
    throw new PathEditError(`сегмента ${segment} нет — у контура ${segs.length} сегментов (0…${segs.length - 1})`);
  }
  if (!(t > 0 && t < 1)) throw new PathEditError(`t=${t} — ожидается число строго между 0 и 1`);
  const si = segs[segment];
  const c = cmds[si];
  const a = segStart(cmds, si);
  if (c[0] === 'Z') {
    const sub = subpaths(cmds).find((s) => s.z === si)!;
    const b = endOf(cmds[sub.m]);
    cmds.splice(si, 0, ['L', a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t]);
  } else if (c[0] === 'L') {
    cmds.splice(si, 0, ['L', a.x + (c[1] - a.x) * t, a.y + (c[2] - a.y) * t]);
  } else if (c[0] === 'C') {
    const [l, r] = splitCubic(a, { x: c[1], y: c[2] }, { x: c[3], y: c[4] }, { x: c[5], y: c[6] }, t);
    cmds.splice(si, 1, ['C', l[1].x, l[1].y, l[2].x, l[2].y, l[3].x, l[3].y], ['C', r[1].x, r[1].y, r[2].x, r[2].y, r[3].x, r[3].y]);
  }
  return cmds;
}

/** Two consecutive segments a→b→c joined into a→c (C when either was a curve). */
function joined(start: Pt, s1: EditCmd, s2: EditCmd): EditCmd {
  const end = endOf(s2);
  if (s1[0] === 'L' && s2[0] === 'L') return ['L', end.x, end.y];
  const c1 = s1[0] === 'C' ? { x: s1[1], y: s1[2] } : start;
  const c2 = s2[0] === 'C' ? { x: s2[3], y: s2[4] } : end;
  return ['C', c1.x, c1.y, c2.x, c2.y, end.x, end.y];
}

export function removePoint(src: EditCmd[], index: number): EditCmd[] {
  const cmds = copy(src);
  const { ci, sub } = locate(cmds, index);
  const tw = twin(cmds, ci, sub);
  if (tw >= 0) {
    // The merged start/last node of a closed subpath: the new start is the next anchor; the last
    // segment and the first one join into one that ends there.
    if (sub.last - sub.m < 2) {
      cmds.splice(sub.m, (sub.z >= 0 ? sub.z : sub.last) - sub.m + 1);
    } else {
      const first = cmds[sub.m + 1];
      const lastSeg = cmds[sub.last];
      const prevPt = endOf(cmds[sub.last - 1]);
      const join = joined(prevPt, lastSeg, first);
      const a1 = endOf(first);
      cmds.splice(sub.last, 1, join);
      cmds.splice(sub.m, 2, ['M', a1.x, a1.y]);
    }
  } else if (ci === sub.m) {
    const next = cmds[ci + 1];
    if (next && (next[0] === 'L' || next[0] === 'C')) {
      const p = endOf(next);
      cmds.splice(ci, 2, ['M', p.x, p.y]);
    } else {
      cmds.splice(ci, sub.z >= 0 ? sub.z - ci + 1 : 1);
    }
  } else {
    const next = cmds[ci + 1];
    if (next && (next[0] === 'L' || next[0] === 'C')) {
      cmds.splice(ci, 2, joined(segStart(cmds, ci), cmds[ci], next));
    } else {
      cmds.splice(ci, 1);
    }
  }
  if (!cmds.some((c) => c[0] !== 'Z')) throw new PathEditError('это последняя точка контура — удалите узел целиком (node.remove)');
  return cmds;
}

function subAt(cmds: EditCmd[], subpath: number | undefined): Sub {
  const subs = subpaths(cmds);
  const k = subpath ?? subs.length - 1;
  if (!Number.isInteger(k) || k < 0 || k >= subs.length) {
    throw new PathEditError(`подконтура ${subpath} нет — их ${subs.length} (0…${subs.length - 1})`);
  }
  return subs[k];
}

export function closePath(src: EditCmd[], subpath?: number): EditCmd[] {
  const cmds = copy(src);
  const sub = subAt(cmds, subpath);
  if (sub.z < 0) cmds.splice(sub.last + 1, 0, ['Z']);
  return cmds;
}

export function openPath(src: EditCmd[], subpath?: number): EditCmd[] {
  const cmds = copy(src);
  const sub = subAt(cmds, subpath);
  if (sub.z >= 0) cmds.splice(sub.z, 1);
  return cmds;
}

/** Every coordinate shifted by (dx, dy) — for parsed (M L C Q A Z) commands; arc radii stay. */
export function shiftParsed(cmds: PathCmd[], dx: number, dy: number): PathCmd[] {
  return cmds.map((c): PathCmd => {
    switch (c[0]) {
      case 'M':
      case 'L':
        return [c[0], c[1] + dx, c[2] + dy];
      case 'C':
        return ['C', c[1] + dx, c[2] + dy, c[3] + dx, c[4] + dy, c[5] + dx, c[6] + dy];
      case 'Q':
        return ['Q', c[1] + dx, c[2] + dy, c[3] + dx, c[4] + dy];
      case 'A':
        return ['A', c[1], c[2], c[3], c[4], c[5], c[6] + dx, c[7] + dy];
      default:
        return ['Z'];
    }
  });
}

// ---- reading (the path-tool UI draws from these) ---------------------------------------------

/** Bezier handles of anchor `index`: in — of the segment ending there, out — of the one starting; null for a line / none. */
export function handlesAt(cmds: EditCmd[], index: number): { in: Pt | null; out: Pt | null } {
  const { ci, sub } = locate(cmds, index);
  const si = inSeg(cmds, ci, sub);
  const so = outSeg(cmds, ci, sub);
  const ins = si >= 0 && cmds[si][0] === 'C' ? getH(cmds, { ci: si, slot: 2 }) : null;
  const out = so >= 0 && cmds[so][0] === 'C' ? getH(cmds, { ci: so, slot: 1 }) : null;
  return { in: ins, out };
}

/** smooth — both handles on one line through the anchor, pointing away from each other. */
export function nodeTypeAt(cmds: EditCmd[], index: number): 'corner' | 'smooth' {
  const h = handlesAt(cmds, index);
  const p = anchorPoints(cmds)[index];
  if (!h.in || !h.out) return 'corner';
  const ax = h.in.x - p.x;
  const ay = h.in.y - p.y;
  const bx = h.out.x - p.x;
  const by = h.out.y - p.y;
  const la = Math.hypot(ax, ay);
  const lb = Math.hypot(bx, by);
  if (la < 1e-9 || lb < 1e-9) return 'corner';
  return Math.abs(ax * by - ay * bx) / (la * lb) < 1e-3 && ax * bx + ay * by < 0 ? 'smooth' : 'corner';
}

/** Subpath number of anchor `index`, and whether that subpath is closed. */
export function subpathAt(cmds: EditCmd[], index: number): { subpath: number; closed: boolean } {
  const { sub } = locate(cmds, index);
  const subs = subpaths(cmds);
  return { subpath: subs.findIndex((s) => s.m === sub.m), closed: sub.z >= 0 };
}

/** Drawn segments in `segment` order (as path.insertPoint numbers them): line (no controls) or cubic. */
export function segmentCurves(cmds: EditCmd[]): { start: Pt; c1?: Pt; c2?: Pt; end: Pt }[] {
  return segments(cmds).map((si) => {
    const c = cmds[si];
    const start = segStart(cmds, si);
    if (c[0] === 'C') return { start, c1: { x: c[1], y: c[2] }, c2: { x: c[3], y: c[4] }, end: { x: c[5], y: c[6] } };
    if (c[0] === 'Z') {
      const sub = subpaths(cmds).find((s) => s.z === si)!;
      return { start, end: endOf(cmds[sub.m]) };
    }
    return { start, end: endOf(c) };
  });
}
