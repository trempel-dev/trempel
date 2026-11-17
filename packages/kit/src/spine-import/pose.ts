// pose.ts — the reference Spine pose sampler: setup pose + timelines → local bone values → world
// transforms; slot colour (rgb + alpha), attachment and the draw order. Written from the Spine
// documentation (bone transforms, runtime skeletons), used to verify the transfer. Constraints are
// not applied.
//
// Local matrix of a bone (degrees, y up):
//   a = cos(rot + shearX)·scaleX   b = cos(rot + 90 + shearY)·scaleY
//   c = sin(rot + shearX)·scaleX   d = sin(rot + 90 + shearY)·scaleY
// world = parentWorld × local, world position = parentWorld · (x, y). Inherit modes other than
// `normal` are not modelled — such bones are excluded from the comparison by the caller.
// Timelines: rotate/translate/shear add to the setup value, scale multiplies it; before the
// first key the setup value holds (a fresh skeleton played from the setup pose).

import { valueAt } from './curve.js';
import { drawOrderOf, type AnimationData, type BoneData, type BoneProp, type SkeletonData } from './spine.js';

export interface World {
  a: number;
  b: number;
  c: number;
  d: number;
  x: number;
  y: number;
}

export interface Local {
  x: number;
  y: number;
  rotate: number;
  scaleX: number;
  scaleY: number;
  shearX: number;
  shearY: number;
}

const RAD = Math.PI / 180;

export function localOf(b: BoneData): Local {
  return { x: b.x, y: b.y, rotate: b.rotation, scaleX: b.scaleX, scaleY: b.scaleY, shearX: b.shearX, shearY: b.shearY };
}

export function worldOf(parent: World | null, l: Local): World {
  const la = Math.cos((l.rotate + l.shearX) * RAD) * l.scaleX;
  const lb = Math.cos((l.rotate + 90 + l.shearY) * RAD) * l.scaleY;
  const lc = Math.sin((l.rotate + l.shearX) * RAD) * l.scaleX;
  const ld = Math.sin((l.rotate + 90 + l.shearY) * RAD) * l.scaleY;
  if (!parent) return { a: la, b: lb, c: lc, d: ld, x: l.x, y: l.y };
  const p = parent;
  return {
    a: p.a * la + p.b * lc,
    b: p.a * lb + p.b * ld,
    c: p.c * la + p.d * lc,
    d: p.c * lb + p.d * ld,
    x: p.a * l.x + p.b * l.y + p.x,
    y: p.c * l.x + p.d * l.y + p.y,
  };
}

export interface Pose {
  local: Map<string, Local>;
  world: Map<string, World>;
  alpha: Map<string, number>;
  /** Slot → rgb 0..1. */
  color: Map<string, [number, number, number]>;
  /** Slot → attachment name shown (null — none). */
  attachment: Map<string, string | null>;
  /** Slot indices back to front. */
  drawOrder: number[];
}

const ADD: Record<BoneProp, 'add' | 'mul'> = {
  rotate: 'add',
  x: 'add',
  y: 'add',
  shearX: 'add',
  shearY: 'add',
  scaleX: 'mul',
  scaleY: 'mul',
};

/** The pose of `anim` at time t (null — the setup pose). */
export function samplePose(sk: SkeletonData, anim: AnimationData | null, t: number): Pose {
  const local = new Map<string, Local>();
  for (const b of sk.bones) local.set(b.name, localOf(b));
  if (anim) {
    for (const tl of anim.bones) {
      const l = local.get(tl.bone);
      if (!l) continue;
      const v = valueAt(tl.keys, t);
      if (v === undefined) continue;
      if (ADD[tl.prop] === 'add') l[tl.prop] += v;
      else l[tl.prop] *= v;
    }
  }
  const world = new Map<string, World>();
  for (const b of sk.bones) {
    const parent = b.parent ? (world.get(b.parent) ?? null) : null;
    world.set(b.name, worldOf(parent, local.get(b.name)!));
  }

  const alpha = new Map<string, number>();
  const color = new Map<string, [number, number, number]>();
  const attachment = new Map<string, string | null>();
  for (const s of sk.slots) {
    alpha.set(s.name, s.color.a);
    color.set(s.name, [s.color.r, s.color.g, s.color.b]);
    attachment.set(s.name, s.attachment);
  }
  let drawOrder = sk.slots.map((_, i) => i);
  if (anim) {
    for (const tl of anim.alpha) {
      const v = valueAt(tl.keys, t);
      if (v !== undefined) alpha.set(tl.slot, v);
    }
    for (const tl of anim.color) {
      const c = color.get(tl.slot);
      if (!c) continue;
      const r = valueAt(tl.r, t);
      const g = valueAt(tl.g, t);
      const b = valueAt(tl.b, t);
      if (r !== undefined && g !== undefined && b !== undefined) color.set(tl.slot, [r, g, b]);
    }
    for (const tl of anim.attachments) {
      if (!tl.keys.length || t < tl.keys[0].t) continue;
      let name = tl.keys[0].name;
      for (const k of tl.keys) if (k.t <= t) name = k.name;
      attachment.set(tl.slot, name);
    }
    let key: AnimationData['drawOrder'][number] | undefined;
    for (const k of anim.drawOrder) if (k.t <= t) key = k;
    if (key) drawOrder = drawOrderOf(sk, key.offsets);
  }
  return { local, world, alpha, color, attachment, drawOrder };
}

/** Position, rotation (degrees, x axis), signed scales of a world matrix (y up). */
export function decompose(w: World): { x: number; y: number; rotation: number; scaleX: number; scaleY: number } {
  const scaleX = Math.hypot(w.a, w.c);
  const det = w.a * w.d - w.b * w.c;
  return { x: w.x, y: w.y, rotation: Math.atan2(w.c, w.a) / RAD, scaleX, scaleY: scaleX > 1e-12 ? det / scaleX : Math.hypot(w.b, w.d) };
}
