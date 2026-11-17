// verify.ts — acceptance check without a renderer: the reference Spine sampler (pose.ts) against
// Trempel itself — scene.svg mounted by Trempel's mountScene on the headless backend, the md clips
// compiled by its compileClips and played by its Animator — at N points of every animation. Per
// bone (every group of it, clones included): world position ±0.5 px, rotation ±0.5°, scale ±0.5 %;
// per slot: alpha ±0.01, colour ±0.01 per channel (the tint of its images), the attachment shown,
// and the draw order of the slots (z-sorted siblings) — exact.
// Bones the transfer does not model are excluded with the reason (non-normal inheritance,
// constraints, shear), and so are their descendants.

import { compileClipsResult, parse } from '@trempel/scene';
import { drawOrder, worldOf, type HNode } from '../clip-import/headless.js';
import { playHeadless } from '../clip-import/play.js';
import { fmt } from '../clip-import/tables.js';
import type { ClipStats } from './clips.js';
import { decompose, samplePose, type World } from './pose.js';
import { defaultHref, type Rig } from './rig.js';
import { findAttachment, type AnimationData, type SkeletonData } from './spine.js';

export const TOL = { pos: 0.5, rot: 0.5, scale: 0.005, alpha: 0.01, color: 0.01 };

export interface AnimCheck {
  anim: string;
  clip: string;
  points: number;
  bones: number;
  slots: number;
  max: { pos: number; rot: number; scale: number; alpha: number; color: number };
  /** Samples (node × time) out of tolerance. */
  bad: number;
  attachmentBad: number;
  /** Samples whose slot draw order differs (draw order keys that are not representable are expected here). */
  orderBad: number;
  examples: string[];
  ok: boolean;
}

export interface VerifyResult {
  anims: AnimCheck[];
  excluded: { bone: string; reason: string }[];
  /** Compile errors of the clips (Trempel compileClips) — nothing was played. */
  compileErrors?: string[];
}

const ANGLE = (d: number): number => {
  let x = d % 360;
  if (x > 180) x -= 360;
  if (x < -180) x += 360;
  return Math.abs(x);
};

/** Ours (SVG, y down) → Spine frame (y up). */
function toSpine(m: [number, number, number, number, number, number]): World {
  const [a, b, c, d, e, f] = m;
  return { a, b: -c, c: -b, d, x: e, y: -f };
}

function excludedBones(sk: SkeletonData, anim: AnimationData | null): Map<string, string> {
  const why = new Map<string, string>();
  const mark = (b: string, r: string): void => {
    if (!why.has(b)) why.set(b, r);
  };
  for (const b of sk.bones) {
    if (b.inherit !== 'normal') mark(b.name, `inheritance ${b.inherit}`);
    if (b.shearX || b.shearY) mark(b.name, 'shear in the setup pose');
  }
  for (const [kind, list] of [['IK', sk.ik], ['transform constraint', sk.transform], ['path constraint', sk.path]] as const)
    for (const c of list) for (const b of c.bones) mark(b, `${kind} ${c.name}`);
  if (anim) for (const tl of anim.bones) if (tl.prop === 'shearX' || tl.prop === 'shearY') mark(tl.bone, 'animated shear');
  // Descendants inherit the difference.
  for (const b of sk.bones) if (b.parent && why.has(b.parent) && !why.has(b.name)) why.set(b.name, `child of ${b.parent}`);
  return why;
}

function sampleTimes(anim: AnimationData, duration: number, n: number): number[] {
  const keys: number[] = [];
  for (const tl of anim.bones) for (const k of tl.keys) keys.push(k.t);
  for (const tl of anim.alpha) for (const k of tl.keys) keys.push(k.t);
  for (const tl of anim.color) for (const k of tl.r) keys.push(k.t);
  for (const tl of anim.attachments) for (const k of tl.keys) keys.push(k.t);
  for (const k of anim.drawOrder) keys.push(k.t);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    let t = n === 1 ? 0 : (duration * i) / (n - 1);
    // A step jumps exactly on its key — keep samples off key times (rounding would pick a side).
    if (keys.some((k) => Math.abs(k - t) < 1e-3)) t = t + 2e-3 <= duration ? t + 2e-3 : t - 2e-3;
    out.push(Math.max(0, t));
  }
  return out.sort((a, b) => a - b);
}

export interface VerifyOptions {
  points?: number;
  skin?: string;
}

const rgbOf = (tint: number): [number, number, number] => [((tint >> 16) & 255) / 255, ((tint >> 8) & 255) / 255, (tint & 255) / 255];

export function verify(sk: SkeletonData, rig: Rig, svg: string, md: string, stats: ClipStats[], opts: VerifyOptions = {}): VerifyResult {
  const n = opts.points ?? 60;
  const skin = opts.skin ?? 'default';
  const compiled = compileClipsResult(md, parse(svg), { tex: defaultHref });
  if (compiled.errors.length) return { anims: [], excluded: [], compileErrors: compiled.errors };
  const clips = compiled.clips;
  const setupExcluded = excludedBones(sk, null);
  const anims: AnimCheck[] = [];
  const slotIndex = new Map(sk.slots.map((s, i) => [s.name, i]));
  const slotOfNode = new Map([...rig.slots.values()].map((rs) => [rs.id, slotIndex.get(rs.slot)!]));

  for (const anim of sk.animations) {
    const st = stats.find((s) => s.name === anim.name)!;
    const clip = clips[st.clip];
    const excluded = excludedBones(sk, anim);
    const play = playHeadless(svg, clip ?? null);
    const root = play.node(rig.rootId)!;
    const check: AnimCheck = { anim: anim.name, clip: st.clip, points: n, bones: 0, slots: 0, max: { pos: 0, rot: 0, scale: 0, alpha: 0, color: 0 }, bad: 0, attachmentBad: 0, orderBad: 0, examples: [], ok: true };
    const fail = (msg: string): void => {
      check.bad++;
      if (check.examples.length < 6) check.examples.push(msg);
    };

    for (const t of sampleTimes(anim, st.duration, n)) {
      play.at(t);
      const pose = samplePose(sk, anim, t);
      const at = `t=${fmt(t, 3)}`;

      for (const b of sk.bones) {
        if (excluded.has(b.name)) continue;
        const ref = decompose(pose.world.get(b.name)!);
        for (const id of rig.boneIds.get(b.name) ?? []) {
          const node = play.node(id);
          if (!node) continue;
          const got = decompose(toSpine(worldOf(node)));
          const dPos = Math.hypot(got.x - ref.x, got.y - ref.y);
          const dRot = Math.abs(ref.scaleX) < 1e-3 || Math.abs(ref.scaleY) < 1e-3 ? 0 : ANGLE(got.rotation - ref.rotation);
          const sx = Math.abs(got.scaleX - ref.scaleX) / Math.max(Math.abs(ref.scaleX), 0.02);
          const sy = Math.abs(got.scaleY - ref.scaleY) / Math.max(Math.abs(ref.scaleY), 0.02);
          const dScale = Math.max(sx, sy);
          check.max.pos = Math.max(check.max.pos, dPos);
          check.max.rot = Math.max(check.max.rot, dRot);
          check.max.scale = Math.max(check.max.scale, dScale);
          if (dPos > TOL.pos || dRot > TOL.rot || dScale > TOL.scale) {
            fail(`${at} #${id}: position Δ${fmt(dPos, 3)} px, rotation Δ${fmt(dRot, 3)}°, scale Δ${fmt(dScale * 100, 3)} %`);
          }
        }
      }

      for (const s of sk.slots) {
        if (excluded.has(s.bone)) continue;
        const rs = rig.slots.get(s.name);
        if (!rs) continue;
        const node = play.node(rs.id);
        if (!node) continue;
        const dA = Math.abs(node.alpha - (pose.alpha.get(s.name) ?? 1));
        check.max.alpha = Math.max(check.max.alpha, dA);
        if (dA > TOL.alpha) fail(`${at} #${rs.id}: alpha ${fmt(node.alpha, 3)} ≠ ${fmt(pose.alpha.get(s.name) ?? 1, 3)}`);

        // Attachment: the visual one Spine shows vs the image(s) with alpha > 0.
        const name = pose.attachment.get(s.name) ?? null;
        const a = name !== null ? findAttachment(sk, skin, s.name, name) : undefined;
        const want = a && (a.type === 'region' || a.type === 'mesh' || a.type === 'linkedmesh') && (rs.mode === 'single' || rs.images.some((i) => i.att === name)) ? a : null;
        const shown = rs.images.map((i) => ({ i, node: play.node(i.id)! })).filter((x) => x.node && x.node.visible && x.node.alpha > 0);
        let okAtt: boolean;
        if (!want) okAtt = shown.length === 0;
        else if (rs.mode === 'single') okAtt = shown.length === 1 && shown[0].node.href === defaultHref(want.path);
        else okAtt = shown.length === 1 && shown[0].i.att === want.name;
        if (!okAtt) {
          check.attachmentBad++;
          fail(`${at} #${rs.id}: attachment ${want ? want.name : '—'}, shown ${shown.map((x) => (rs.mode === 'single' ? x.node.href : x.i.att)).join(', ') || '—'}`);
        }

        // Colour: the slot's rgb × the attachment's vs the shown image's tint (lost colours are reported, not checked).
        if (want && shown.length === 1 && (rs.groupTint || !anim.tinted.includes(s.name))) {
          const slotRgb = pose.color.get(s.name)!;
          const ref = rs.groupTint ? slotRgb : [slotRgb[0] * want.color.r, slotRgb[1] * want.color.g, slotRgb[2] * want.color.b];
          const got = rgbOf(shown[0].node.tint);
          const dC = Math.max(...ref.map((v, i) => Math.abs(v - got[i])));
          check.max.color = Math.max(check.max.color, dC);
          if (dC > TOL.color) fail(`${at} #${rs.id}: colour ${got.map((v) => fmt(v, 3)).join(',')} ≠ ${ref.map((v) => fmt(v, 3)).join(',')}`);
        }
      }

      // Draw order: the slot groups in drawing order vs Spine's (excluded bones' slots kept: order is global).
      const drawn = drawOrder(root as HNode).flatMap((x) => (x.attrs.id && slotOfNode.has(x.attrs.id) ? [slotOfNode.get(x.attrs.id)!] : []));
      if (drawn.join(',') !== pose.drawOrder.join(',')) {
        check.orderBad++;
        if (st.drawOrder.lost === 0) fail(`${at}: draw order ${drawn.map((i) => sk.slots[i].name).join(' ')} ≠ ${pose.drawOrder.map((i) => sk.slots[i].name).join(' ')}`);
      }
    }
    check.bones = sk.bones.filter((b) => !excluded.has(b.name)).length;
    check.slots = sk.slots.filter((s) => !excluded.has(s.bone)).length;
    check.ok = check.bad === 0;
    anims.push(check);
  }
  return { anims, excluded: [...setupExcluded].map(([bone, reason]) => ({ bone, reason })) };
}
