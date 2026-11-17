// clips.ts — Spine animations → Trempel md clips (scene format §9, `<name>.anim.md`).
//
// One `# $clip` per animation, `## $track <id>` tables per node, `## $events`.
//   bone rotate → rotation (−value: clockwise on screen), translate → x, y (y negated),
//   scale → scaleX / scaleY (multipliers, as Spine's); slot alpha → alpha of the slot group;
//   slot colour → tint of the slot group (`#rrggbb`, per channel); attachment → tex of the slot group
//   (one image) or alpha 0/1 per attachment image; draw order timeline → z of the siblings it
//   reorders (when the new order is a reordering of siblings — else reported).
// Columns whose keys share times and eases go into one table; others get their own table of
// the same target (an ease belongs to a row).
// Curves: stepped → step, bezier → [x1, y1, x2, y2] (the clip's cubic-bezier ease is the same
// curve normalized), a segment with no normalized form → baked into linear keys every 1/fps s.
// Before the first key Spine shows the setup pose → a key at 0 with the setup value and `step`.

import type { EaseOut } from '../clip-import/bezier.js';
import { bakeTimes, eventsTable, fmt, hexColor, heldKeys, idify, strictTimes, trackTables, type ColKey, type Column } from '../clip-import/tables.js';
import { easeOf, segmentAt } from './curve.js';
import type { Rig, RigBone, RigSlot } from './rig.js';
import { drawOrderOf, findAttachment, type AnimationData, type ColorTimeline, type Key, type SkeletonData } from './spine.js';

export interface ClipStats {
  name: string;
  clip: string;
  duration: number;
  tracks: number;
  bezier: number;
  baked: number;
  stepped: number;
  /** Draw order keys transferred as z / not representable. */
  drawOrder: { keys: number; z: number; lost: number };
  warnings: string[];
}

export interface ClipsOut {
  md: string;
  stats: ClipStats[];
}

export interface ClipsOptions {
  fps?: number;
  skin?: string;
}

/** Bake tolerance per column (in its units): px / degrees vs multipliers and alpha / colour. */
const BAKE_TOL: Record<string, number> = { x: 0.05, y: 0.05, rotation: 0.05, scaleX: 0.00005, scaleY: 0.00005, alpha: 0.002, tint: 0.002 };

/** Spine keys → column keys: map values, eases, bake, setup key at 0. */
function columnKeys(keys: Key[], setup: number, map: (v: number) => number, fps: number, st: ClipStats, tol: number): ColKey[] {
  const out: ColKey[] = [];
  if (!keys.length) return out;
  if (keys[0].t > 1e-9) out.push({ t: 0, v: map(setup), ease: 'step' });
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const next = keys[i + 1];
    const v = map(k.v);
    if (!next) {
      out.push({ t: k.t, v });
      break;
    }
    const e = easeOf(k, next);
    if (e === null) {
      st.baked++;
      out.push({ t: k.t, v, ease: 'linear' });
      for (const t of bakeTimes(k.t, next.t, (x) => segmentAt(k, next, x), fps, tol)) out.push({ t, v: map(segmentAt(k, next, t)), ease: 'linear' });
      continue;
    }
    if (e === 'step') st.stepped++;
    else if (Array.isArray(e)) st.bezier++;
    out.push({ t: k.t, v, ease: e });
  }
  return out;
}

const sameEase = (a: EaseOut, b: EaseOut): boolean =>
  a === b || (Array.isArray(a) && Array.isArray(b) && a.every((x, i) => Math.abs(x - b[i]) < 1e-6));

/** A colour timeline → the `tint` column (one ease per row: channels that agree, else baked). */
function tintKeys(tl: ColorTimeline, setup: [number, number, number], fps: number, st: ClipStats): ColKey[] {
  const ch = [tl.r, tl.g, tl.b];
  const n = tl.r.length;
  if (!n || tl.g.length !== n || tl.b.length !== n) return [];
  const color = (i: number): string => hexColor(tl.r[i].v, tl.g[i].v, tl.b[i].v);
  const at = (i: number, t: number): string => hexColor(...(ch.map((c) => segmentAt(c[i], c[i + 1], t)) as [number, number, number]));
  const out: ColKey[] = [];
  if (tl.r[0].t > 1e-9) out.push({ t: 0, v: hexColor(...setup), ease: 'step' });
  for (let i = 0; i < n; i++) {
    const t = tl.r[i].t;
    if (i === n - 1) {
      out.push({ t, v: color(i) });
      break;
    }
    // Channels that change decide; a flat one follows any ease.
    const eases = ch.map((c) => ({ flat: Math.abs(c[i + 1].v - c[i].v) <= 1e-9, e: easeOf(c[i], c[i + 1]) })).filter((x) => !x.flat || x.e !== 'linear').map((x) => x.e);
    const first = eases[0] ?? 'linear';
    const one = eases.every((e) => e !== null && first !== null && sameEase(e, first)) ? first : null;
    if (one === null) {
      st.baked++;
      out.push({ t, v: color(i), ease: 'linear' });
      const times = new Set<number>();
      for (const c of ch) for (const x of bakeTimes(c[i].t, c[i + 1].t, (y) => segmentAt(c[i], c[i + 1], y), fps, BAKE_TOL.tint)) times.add(Math.round(x * 1e5) / 1e5);
      for (const x of [...times].sort((a, b) => a - b)) if (x > t && x < tl.r[i + 1].t) out.push({ t: x, v: at(i, x), ease: 'linear' });
      continue;
    }
    if (one === 'step') st.stepped++;
    else if (Array.isArray(one)) st.bezier++;
    out.push({ t, v: color(i), ease: one });
  }
  return out;
}

/** Every container of the rig (the root list and each bone group) with its children's slot indices. */
function containers(sk: SkeletonData, rig: Rig): { id: string; children: { id: string; slots: number[] }[] }[] {
  const index = new Map(sk.slots.map((s, i) => [s.name, i]));
  const out: { id: string; children: { id: string; slots: number[] }[] }[] = [];
  const slotsUnder = (n: RigBone | RigSlot): number[] => (n.kind === 'slot' ? [index.get(n.slot)!] : n.children.flatMap(slotsUnder));
  const visit = (id: string, list: (RigBone | RigSlot)[]): void => {
    out.push({ id, children: list.map((c) => ({ id: c.id, slots: slotsUnder(c) })) });
    for (const c of list) if (c.kind === 'bone') visit(c.id, c.children);
  };
  visit(rig.rootId, rig.children);
  return out;
}

/**
 * Draw order timeline → `z` keys of the siblings it reorders. A key is representable when, in every
 * container, the children's slot ranges do not interleave under the new order; such children get
 * z = their place. Containers whose order never changes get nothing.
 */
function drawOrderColumns(sk: SkeletonData, rig: Rig, anim: AnimationData, st: ClipStats): Map<string, Column> {
  const out = new Map<string, Column>();
  if (!anim.drawOrder.length) return out;
  const keys = [...anim.drawOrder];
  if (keys[0].t > 1e-9) keys.unshift({ t: 0, offsets: null });
  st.drawOrder.keys = anim.drawOrder.length;
  const conts = containers(sk, rig);
  // container → per key: z of each child (null — not representable at that key: setup order kept)
  const plans = conts.map(() => [] as (number[] | null)[]);
  let lostKeys = 0;
  keys.forEach((k) => {
    const order = drawOrderOf(sk, k.offsets);
    const rank = new Array<number>(order.length);
    order.forEach((slot, place) => (rank[slot] = place));
    let lost = false;
    conts.forEach((c, ci) => {
      const ranged = c.children.map((ch, i) => ({ i, lo: Math.min(...ch.slots.map((s) => rank[s])), hi: Math.max(...ch.slots.map((s) => rank[s])) }));
      const drawn = ranged.filter((r) => Number.isFinite(r.lo)).sort((a, b) => a.lo - b.lo);
      const ok = drawn.every((r, j) => j === 0 || drawn[j - 1].hi < r.lo);
      if (!ok) {
        lost = true;
        plans[ci].push(null);
        return;
      }
      const z = c.children.map((_, i) => i);
      const empties = ranged.filter((r) => !Number.isFinite(r.lo)).map((r) => r.i);
      // children that draw nothing keep their place relative to the start; the drawn ones follow their order
      let place = 0;
      for (const i of empties) z[i] = place++;
      for (const r of drawn) z[r.i] = place++;
      plans[ci].push(z);
    });
    if (lost) lostKeys++;
  });
  st.drawOrder.lost = lostKeys;
  if (lostKeys) st.warnings.push(`draw order timeline: ${lostKeys} key(s) reorder across bone groups — not representable with sibling z, the setup order is kept there.`);
  conts.forEach((c, ci) => {
    const plan = plans[ci].map((z) => z ?? c.children.map((_, i) => i));
    const changes = plan.some((z) => z.some((v, i) => v !== i));
    if (!changes) return;
    c.children.forEach((ch, i) => {
      const col = heldKeys(keys.map((k, j) => ({ t: k.t, v: plan[j][i] })));
      out.set(ch.id, { col: 'z', keys: col.map((x) => ({ t: x.t, v: x.v })) });
    });
  });
  st.drawOrder.z = anim.drawOrder.length - lostKeys;
  return out;
}

function slotColumns(sk: SkeletonData, anim: AnimationData, rs: RigSlot, skin: string, fps: number, st: ClipStats): Map<string, Column[]> {
  const out = new Map<string, Column[]>();
  const add = (id: string, c: Column): void => {
    if (!c.keys.length) return;
    out.set(id, [...(out.get(id) ?? []), c]);
  };
  const slot = sk.slots.find((s) => s.name === rs.slot)!;

  for (const tl of anim.alpha.filter((a) => a.slot === rs.slot)) {
    if (tl.keys.every((k) => k.v === slot.color.a && (k.curve.kind !== 'bezier' || (k.curve.cy1 === k.v && k.curve.cy2 === k.v)))) continue; // an rgba timeline that keeps the alpha
    const keys = columnKeys(tl.keys, slot.color.a, (v) => v, fps, st, BAKE_TOL.alpha);
    nudged(keys, st, `${rs.slot}.alpha`);
    add(rs.id, { col: 'alpha', keys });
  }
  for (const tl of anim.color.filter((c) => c.slot === rs.slot)) {
    if (!rs.groupTint || !anim.tinted.includes(rs.slot)) continue;
    const keys = tintKeys(tl, [slot.color.r, slot.color.g, slot.color.b], fps, st);
    nudged(keys, st, `${rs.slot}.tint`);
    add(rs.id, { col: 'tint', keys });
  }

  const tl = anim.attachments.find((a) => a.slot === rs.slot);
  if (!tl || !rs.images.length) return out;
  // Multi: one image per visual attachment. Single: every visual attachment shares the image.
  const visual = (name: string | null): string | null =>
    name === null ? null : rs.mode === 'multi' ? (rs.images.some((i) => i.att === name) ? name : null) : isVisual(sk, skin, rs.slot, name) ? name : null;
  // Shown attachment over time: setup until the first key, then each key.
  const points: { t: number; name: string | null }[] = [];
  if (tl.keys[0].t > 1e-9) points.push({ t: 0, name: rs.setup });
  for (const k of tl.keys) points.push({ t: k.t, name: visual(k.name) });

  if (rs.mode === 'single') {
    const img = rs.images[0];
    const regionOf = (name: string): string => findAttachment(sk, skin, rs.slot, name)?.path ?? name;
    const tex = points.filter((p) => p.name !== null).map((p) => ({ t: p.t, v: regionOf(p.name!) }));
    const texKeys = heldKeys(tex);
    if (texKeys.length > 1 || (texKeys.length === 1 && texKeys[0].v !== img.region)) {
      if (texKeys[0].t > 1e-9) texKeys.unshift({ t: 0, v: texKeys[0].v });
      add(rs.id, { col: 'tex', keys: texKeys });
    }
    if (rs.hides) {
      const vis = heldKeys(points.map((p) => ({ t: p.t, v: p.name === null ? 0 : img.geom.alpha })));
      if (vis.length > 1 || (vis.length === 1 && vis[0].v !== (rs.setup !== null ? img.geom.alpha : 0))) add(img.id, { col: 'alpha', keys: vis });
    }
    return out;
  }
  for (const img of rs.images) {
    const vis = heldKeys(points.map((p) => ({ t: p.t, v: p.name === img.att ? img.geom.alpha : 0 })));
    const rest = rs.setup === img.att ? img.geom.alpha : 0;
    if (vis.length > 1 || (vis.length === 1 && vis[0].v !== rest)) add(img.id, { col: 'alpha', keys: vis });
  }
  return out;
}

function nudged(keys: ColKey[], st: ClipStats, where: string): void {
  const n = strictTimes(keys);
  if (n) st.warnings.push(`${where}: ${n} key(s) at the same time — moved 0.1 ms apart.`);
}

/** The attachment exists in the skin and draws something (region or mesh stub). */
function isVisual(sk: SkeletonData, skin: string, slot: string, name: string): boolean {
  const a = findAttachment(sk, skin, slot, name);
  return !!a && (a.type === 'region' || a.type === 'mesh' || a.type === 'linkedmesh');
}

export function buildClips(sk: SkeletonData, rig: Rig, opts: ClipsOptions = {}): ClipsOut {
  const fps = opts.fps ?? 30;
  const skin = opts.skin ?? 'default';
  const bones = new Map(sk.bones.map((b) => [b.name, b]));
  const blocks: string[] = [];
  const stats: ClipStats[] = [];
  const names = new Set<string>();

  for (const anim of sk.animations) {
    let clip = idify(anim.name);
    for (let n = 2; names.has(clip); n++) clip = `${idify(anim.name)}_${n}`;
    names.add(clip);
    const st: ClipStats = { name: anim.name, clip, duration: anim.duration, tracks: 0, bezier: 0, baked: 0, stepped: 0, drawOrder: { keys: 0, z: 0, lost: 0 }, warnings: [] };
    const byTarget = new Map<string, Column[]>();
    const add = (id: string, c: Column): void => {
      if (c.keys.length) byTarget.set(id, [...(byTarget.get(id) ?? []), c]);
    };

    for (const tl of anim.bones) {
      const b = bones.get(tl.bone);
      const ids = rig.boneIds.get(tl.bone);
      if (!b || !ids) {
        st.warnings.push(`bone ${tl.bone} of a timeline is not in the skeleton — skipped.`);
        continue;
      }
      if (tl.prop === 'shearX' || tl.prop === 'shearY') {
        st.warnings.push(`bone ${tl.bone}: animated shear — bones carry no skew, lost.`);
        continue;
      }
      const col = { rotate: 'rotation', x: 'x', y: 'y', scaleX: 'scaleX', scaleY: 'scaleY' }[tl.prop];
      const neutral = tl.prop === 'scaleX' || tl.prop === 'scaleY' ? 1 : 0;
      const sign = tl.prop === 'rotate' || tl.prop === 'y' ? -1 : 1;
      const keys = columnKeys(tl.keys, neutral, (v) => sign * v, fps, st, BAKE_TOL[col]);
      nudged(keys, st, `${tl.bone}.${col}`);
      for (const id of ids) add(id, { col, keys: keys.map((k) => ({ ...k })) });
    }

    for (const rs of rig.slots.values()) {
      for (const [id, cols] of slotColumns(sk, anim, rs, skin, fps, st)) for (const c of cols) add(id, c);
    }
    for (const [id, c] of drawOrderColumns(sk, rig, anim, st)) add(id, c);

    const dark = [...new Set(anim.dark)];
    if (dark.length) st.warnings.push(`dark colour (two-colour tint) of slots ${dark.join(', ')} — not transferred, the light colour is.`);
    const lostTint = [...new Set(anim.tinted)].filter((s) => !rig.slots.get(s)?.groupTint);
    if (lostTint.length) st.warnings.push(`colour of slots ${lostTint.join(', ')} — not transferred.`);
    for (const u of anim.unsupported) st.warnings.push(`not transferred — ${u}.`);
    if (anim.events.some((e) => e.payload)) st.warnings.push('events carry int/float/string/audio — $events has only the name.');

    const lines: string[] = [`# $clip ${clip}`];
    let duration = anim.duration;
    for (const cols of byTarget.values()) for (const c of cols) for (const k of c.keys) duration = Math.max(duration, k.t);
    if (duration > 0) lines.push(`$duration: ${fmt(duration, 5)}`);
    lines.push('');
    if (clip !== anim.name) lines.push(`Spine: "${anim.name}".`, '');
    for (const [id, cols] of byTarget) {
      for (const t of trackTables(id, cols)) {
        lines.push(t, '');
        st.tracks++;
      }
    }
    if (anim.events.length) lines.push(eventsTable(anim.events), '');
    st.duration = duration;
    blocks.push(lines.join('\n'));
    stats.push(st);
  }
  const header = `Clips of the skeleton ${sk.name} (Spine ${sk.version || '?'}), made by trempel-spine-import. tex — the region name, href — art/<name>.png.\n$tex: art/{}.png\n\n`;
  return { md: header + blocks.join('\n'), stats };
}
