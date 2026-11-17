// verify.ts — the check of an import: the md as written is compiled by Trempel
// (compileClipsResult, against the scene — the given one or a synthetic one made from the targets)
// and played by Trempel's Animator on the headless backend; at N points of every clip each column is
// compared with Unity's own evaluation of its curves converted to Trempel units (convert.ts Expect).
// Tolerances: position / size ±0.5 px, rotation ±0.5°, scale ±0.5 % (of the rest), alpha ±0.01,
// tint ±1/255 per channel, tex exact; events by time and name. A clip that does not converge is a
// finding (the report), never a crash.

import { Animator, compileClipsResult, mountScene, parse, type AnimClip, type RendererBackend } from '@trempel/scene';
import { createHeadlessBackend, type HNode } from '../clip-import/index.js';
import type { ClipConv, ColumnOut, SceneRest } from './convert.js';

export interface ColumnCheck {
  target: string;
  col: string;
  /** The worst difference (px, degrees, multiplier, alpha, 0..255 per channel, mismatched samples for tex). */
  maxErr: number;
  /** Time of the worst difference. */
  at: number;
  tol: number;
  ok: boolean;
}

export interface ClipCheck {
  clip: string;
  points: number;
  converged: boolean;
  columns: ColumnCheck[];
  /** Events missing from the compiled clip (time / name). */
  events: string[];
  /** Why the clip could not be checked (compile errors, a play error). */
  error?: string;
}

const TOL: Record<string, number> = { x: 0.5, y: 0.5, width: 0.5, height: 0.5, rotation: 0.5, scale: 0.005, scaleX: 0.005, scaleY: 0.005, alpha: 0.01, tint: 1, tex: 0 };
const RAD = Math.PI / 180;

/** A scene with a node per target: `<image>` for sprite / size targets, `<g>` for the rest. */
export function syntheticScene(columns: ColumnOut[]): string {
  const kind = new Map<string, 'g' | 'image' | 'slices'>();
  for (const c of columns) {
    const k = c.col === 'width' || c.col === 'height' ? 'slices' : c.col === 'tex' ? 'image' : 'g';
    const was = kind.get(c.target);
    if (!was || was === 'g' || k === 'slices') kind.set(c.target, k);
  }
  const els = [...kind].map(([id, k]) =>
    k === 'g' ? `  <g id="${id}"/>` : `  <image id="${id}" href="none.png" width="10" height="10"${k === 'slices' ? ' data-slices="1"' : ''}/>`,
  );
  return ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">', ...els, '</svg>'].join('\n');
}

/** A headless backend that also keeps width / height (9-slice images). */
function sizedBackend(): RendererBackend {
  const base = createHeadlessBackend();
  const size = new WeakMap<object, Record<string, number>>();
  return {
    ...base,
    setProp(node, path, value) {
      if (path === 'width' || path === 'height') {
        const m = size.get(node as object) ?? {};
        m[path] = Number(value);
        size.set(node as object, m);
        return;
      }
      base.setProp(node, path, value);
    },
    getProp(node, path) {
      if (path === 'width' || path === 'height') return size.get(node as object)?.[path] ?? Number((node as HNode).attrs[path] ?? 0);
      return base.getProp!(node, path);
    },
  };
}

interface Player {
  node(id: string): HNode | undefined;
  backend: RendererBackend;
  at(t: number): void;
}

function play(svg: string, clip: AnimClip | null): Player {
  const backend = sizedBackend();
  const scene = mountScene(svg, { backend, context: {} });
  const clock = { ms: 0, now(): number { return this.ms; } };
  const animator = new Animator(backend, clock, (id) => scene.byId.get(id), { path: (id) => scene.path(id) });
  if (clip) animator.play(clip);
  return {
    node: (id) => scene.byId.get(id) as HNode | undefined,
    backend,
    at(t) {
      clock.ms = t * 1000;
      animator.tick();
    },
  };
}

/** The rest pose of the scene's nodes (Trempel units), or null when the scene does not mount. */
export function sceneRests(svg: string): Map<string, SceneRest> | null {
  let byId: Map<string, unknown>;
  try {
    byId = mountScene(svg, { backend: createHeadlessBackend(), context: {} }).byId as Map<string, unknown>;
  } catch {
    return null;
  }
  const out = new Map<string, SceneRest>();
  for (const [id, h] of byId) {
    const n = h as HNode;
    out.set(id, { x: n.x, y: n.y, rotation: n.rotation, sx: n.scale.x, sy: n.scale.y, slices: n.tag === 'image' && n.attrs['data-slices'] != null });
  }
  return out;
}

const hrefOf = (n: HNode): string | undefined => {
  if (n.tag === 'image') return n.href;
  const imgs: HNode[] = [];
  const visit = (c: HNode): void => {
    for (const ch of c.children) {
      if (ch.tag === 'image') imgs.push(ch);
      else visit(ch);
    }
  };
  visit(n);
  return imgs.length === 1 ? imgs[0].href : undefined;
};

/**
 * Compile `md` against `svg` and compare every clip of `convs` with its expectations at `points`
 * times (the middles of N equal steps: never on a key, where a step's two values meet).
 */
export function verifyMd(md: string, svg: string, convs: ClipConv[], points = 60): ClipCheck[] {
  let compiled: ReturnType<typeof compileClipsResult>;
  try {
    compiled = compileClipsResult(md, parse(svg));
  } catch (e) {
    return convs.map((c) => ({ clip: c.name, points: 0, converged: false, columns: [], events: [], error: (e as Error).message }));
  }
  const out: ClipCheck[] = [];
  for (const conv of convs) {
    const anim = compiled.clips[conv.name];
    const mine = compiled.errors.filter((e) => e.split(/[\s,:]+/).some((w, i, a) => w === conv.name && a[i - 1] === '$clip'));
    if (!anim || mine.length) {
      out.push({ clip: conv.name, points: 0, converged: false, columns: [], events: [], error: (mine.length ? mine : compiled.errors).join(' | ') || 'not compiled' });
      continue;
    }
    try {
      out.push(checkClip(conv, anim, svg, points));
    } catch (e) {
      out.push({ clip: conv.name, points: 0, converged: false, columns: [], events: [], error: (e as Error).message });
    }
  }
  return out;
}

function checkClip(conv: ClipConv, anim: AnimClip, svg: string, points: number): ClipCheck {
  const rest = play(svg, null);
  const p = play(svg, anim);
  const checks: ColumnCheck[] = conv.columns.map((c) => ({ target: c.target, col: c.col, maxErr: 0, at: 0, tol: TOL[c.col] ?? 0, ok: true }));
  const D = conv.duration;
  const n = D > 0 ? points : 1;
  for (let i = 0; i < n; i++) {
    const t = D > 0 ? (D * (i + 0.5)) / n : 0;
    p.at(t);
    conv.columns.forEach((c, j) => {
      const node = p.node(c.target);
      const r = rest.node(c.target);
      if (!node || !r) {
        checks[j].maxErr = Infinity;
        return;
      }
      const err = columnError(c, node, r, p.backend, t);
      if (err > checks[j].maxErr) {
        checks[j].maxErr = err;
        checks[j].at = t;
      }
    });
  }
  for (const c of checks) c.ok = c.maxErr <= c.tol + 1e-9;
  const markers = anim.markers ?? [];
  const events = conv.events.filter((e) => !markers.some((m) => m.name === e.name && Math.abs(m.t - e.t) < 1e-4)).map((e) => `${e.name} @ ${e.t}`);
  return { clip: conv.name, points: n, converged: checks.every((c) => c.ok) && !events.length, columns: checks, events };
}

function columnError(c: ColumnOut, node: HNode, rest: HNode, backend: RendererBackend, t: number): number {
  const e = c.expect;
  if (e.kind === 'tex') return hrefOf(node) === e.f(t) ? 0 : 1;
  if (e.kind === 'tint') {
    const want = e.f(t).map((v) => Math.min(1, Math.max(0, v)) * 255);
    const got = [(node.tint >> 16) & 0xff, (node.tint >> 8) & 0xff, node.tint & 0xff];
    return Math.max(...got.map((g, i) => Math.abs(g - want[i])));
  }
  const f = e.f(t);
  switch (c.col) {
    case 'x':
      return Math.abs(node.x - rest.x - f);
    case 'y':
      return Math.abs(node.y - rest.y - f);
    case 'rotation':
      return Math.abs((node.rotation - rest.rotation) / RAD - f);
    case 'scale':
      return Math.max(ratioErr(node.scale.x, rest.scale.x, f), ratioErr(node.scale.y, rest.scale.y, f));
    case 'scaleX':
      return ratioErr(node.scale.x, rest.scale.x, f);
    case 'scaleY':
      return ratioErr(node.scale.y, rest.scale.y, f);
    case 'alpha':
      return Math.abs(node.alpha - f);
    case 'width':
    case 'height':
      return Math.abs(Number(backend.getProp!(node, c.col)) - f);
    default:
      return Infinity;
  }
}

const ratioErr = (v: number, r: number, f: number): number => (r === 0 ? (v === 0 ? 0 : Infinity) : Math.abs(v / r - f));
