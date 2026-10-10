// rec.ts — 2.3: recording (● Rec in the timeline). While a clip poses the scene with Rec on, an
// edit of a node — the gizmo, G/R/S, the inspector — does not change the base: the same commands
// run on a scratch copy of the base, the change of each node (its move, turn, scale, opacity,
// tint) is read off the copy, and it becomes keys of the clip at the playhead (key.set, one undo
// step), on top of what the clip shows there. A node without an id cannot be a track target.

import { coded, type AnimClip, type SceneNode } from '../../src/core.js';
import { sampleTrack } from '../../src/anim/player.js';
import { parseTransform } from '../../src/transform.js';
import { openDocument, type CommandResult, type EditorDocument } from '../../editor/index.js';
import { nodeAt, type Call } from '../geometry';

type M = [number, number, number, number, number, number];

const num = (v: string | undefined, d: number): number => {
  const n = v == null || v.trim() === '' ? NaN : Number(v.trim().replace(/px$/, ''));
  return Number.isFinite(n) ? n : d;
};

function matrixOf(n: SceneNode): M {
  try {
    return parseTransform(n.attrs.transform) as M;
  } catch {
    return [1, 0, 0, 1, 0, 0];
  }
}

/** Where the node's pivot lands in its parent, and its turn and scale. */
function poseOf(n: SceneNode): { x: number; y: number; rot: number; sx: number; sy: number; alpha: number; tint: string | null } {
  const m = matrixOf(n);
  const p = (n.attrs['data-pivot'] ?? '').trim().split(/[\s,]+/).map(Number);
  const [px, py] = p.length === 2 && p.every(Number.isFinite) ? p : [0, 0];
  // x / y of a shape without a transform (rect, image, use, text) move it too
  const ax = n.tag === 'circle' || n.tag === 'ellipse' ? num(n.attrs.cx, 0) : n.tag === 'g' || n.tag === 'path' || n.tag === 'line' ? 0 : num(n.attrs.x, 0);
  const ay = n.tag === 'circle' || n.tag === 'ellipse' ? num(n.attrs.cy, 0) : n.tag === 'g' || n.tag === 'path' || n.tag === 'line' ? 0 : num(n.attrs.y, 0);
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  return {
    x: a * px + c * py + e + ax,
    y: b * px + d * py + f + ay,
    rot: (Math.atan2(b, a) * 180) / Math.PI,
    sx: Math.hypot(a, b),
    sy: (det < 0 ? -1 : 1) * Math.hypot(c, d),
    alpha: num(n.attrs.opacity, 1),
    tint: n.attrs['data-tint'] ?? null,
  };
}

const near = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) < eps;
const r4 = (v: number): number => Math.round(v * 1e4) / 1e4;

export interface RecTarget {
  doc: EditorDocument;
  /** The clip posing the scene: its file, name, compiled form, the playhead and the preview params. */
  file: string;
  clip: string;
  compiled: AnimClip;
  t: number;
  params: Record<string, number>;
  /** How commands name a node (id or path) → its index path. */
  pathOf(ref: string): string | null;
}

/**
 * Turn base commands into keys at the playhead (one step). Returns the clip command's result, or
 * null when the commands changed nothing a clip can key.
 */
export function recordCalls(target: RecTarget, label: string, calls: Call[]): CommandResult | null {
  const { doc } = target;
  const clips = doc.clipsDoc(target.file);
  if (!clips) return { ok: false, errors: [coded('E_EDIT_CLIP', `Rec: no clip file ${target.file}`)], changed: [] };
  const scratch = openDocument(doc.serialize());
  const r = scratch.batch(label, calls);
  if (!r.ok) return r;
  const keys: Call[] = [];
  const errors: string[] = [];
  for (const ref of r.changed) {
    const path = target.pathOf(ref) ?? (/^\d+(\/\d+)*$/.test(ref) ? ref : null);
    const before = path != null ? nodeAt(doc.scene, path) : null;
    const after = path != null ? nodeAt(scratch.scene, path) : null;
    if (!before || !after) continue;
    const id = before.attrs.id;
    if (!id) {
      errors.push(coded('E_EDIT_REC', `Rec: <${before.tag}> at ${path} has no id — a clip track needs one (name the node first)`));
      continue;
    }
    const a = poseOf(before);
    const b = poseOf(after);
    const now = (prop: string, rest: number): number => {
      const tr = target.compiled.tracks.find((x) => x.target === id && x.property === prop);
      if (!tr) return rest;
      const v = sampleTrack(tr, target.t, target.params);
      return typeof v === 'number' && Number.isFinite(v) ? v : rest;
    };
    const set = (column: string, value: number | string): void => {
      keys.push({ name: 'key.set', args: { clip: target.clip, target: id, column, t: r4(target.t), value: typeof value === 'number' ? r4(value) : value } });
    };
    if (!near(a.x, b.x)) set('x', now('x', 0) + (b.x - a.x));
    if (!near(a.y, b.y)) set('y', now('y', 0) + (b.y - a.y));
    if (!near(a.rot, b.rot)) set('rotation', (now('rotation', 0) * 180) / Math.PI + (b.rot - a.rot));
    const kx = a.sx ? b.sx / a.sx : 1;
    const ky = a.sy ? b.sy / a.sy : 1;
    if (!near(kx, 1) || !near(ky, 1)) {
      const info = clips.clip(target.clip)?.tracks.find((tr) => tr.target === id && (tr.columns.includes('scale') || tr.columns.includes('scaleX') || tr.columns.includes('scaleY')));
      const uniform = info ? info.columns.includes('scale') : near(kx, ky);
      if (uniform) set('scale', now('scale.x', 1) * kx);
      else {
        if (!near(kx, 1)) set('scaleX', now('scale.x', 1) * kx);
        if (!near(ky, 1)) set('scaleY', now('scale.y', 1) * ky);
      }
    }
    if (!near(a.alpha, b.alpha)) set('alpha', b.alpha);
    if (a.tint !== b.tint && b.tint) set('tint', b.tint);
  }
  if (errors.length) return { ok: false, errors, changed: [] };
  if (!keys.length) return null;
  return keys.length === 1 ? clips.exec(keys[0].name, keys[0].args) : clips.batch(`rec: ${label}`, keys.map((k) => ({ name: k.name, args: k.args })));
}
