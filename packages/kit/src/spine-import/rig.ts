// rig.ts — Spine skeleton → the Trempel rig: a tree of bone groups and slot groups in draw order,
// and the scene.svg text (a sterile base).
//
// Coordinates: Spine is y-up with counter-clockwise degrees, SVG/Trempel is y-down with clockwise
// rotation. Conjugating by the y flip maps translate(x, y) → translate(x, −y), rotate(r) → rotate(−r),
// scale and the texture's "up" unchanged.
//
// Draw order vs hierarchy: SVG draws in tree order, Spine draws slots in draw order regardless of
// the bone tree. Slots are walked in draw order with the chain of bone groups kept open; when a
// slot needs a bone group that was already closed, a clone of that bone group is opened
// (`<bone>--2`) — every clone gets the bone's tracks, so it moves identically. When draw order
// agrees with the hierarchy there are no clones. `data-z` orders siblings only, so it cannot replace
// a clone for the setup draw order (a clone is needed exactly when two sibling subtrees interleave);
// it carries the draw order TIMELINES instead (clips.ts: the `z` column).
//
// Slot: <g id="<slot>-slot" opacity=alpha data-tint=rgb style="mix-blend-mode: …"> with its images.
// If every attachment the slot ever shows has the same geometry, one <image id="<slot>-img"> whose
// href the clips swap (tex) — the frame animation case; otherwise one <image id="<slot>-img-<att>">
// per attachment, shown by alpha. Mesh attachments become a region stub: the same texture stretched
// over the mesh's bounding box. Colour: the slot's rgb is the group's tint (the `tint` column
// animates it); an attachment's own colour is the image's tint when the slot colour does not change.

import { fmt, hexColor, Ids } from '../clip-import/tables.js';
import { samplePose, type World } from './pose.js';
import { findAttachment, isWhite, type AttachmentData, type Rgba, type SkeletonData } from './spine.js';

export interface Geom {
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  width: number;
  height: number;
  /** Attachment colour alpha (multiplies the slot's). */
  alpha: number;
}

export interface RigImage {
  id: string;
  /** Attachment name (skin key). */
  att: string;
  region: string;
  geom: Geom;
  stub: boolean;
  /** `#rrggbb` of the image (attachment colour × the setup slot colour), when not white. */
  tint?: string;
}

export interface RigSlot {
  kind: 'slot';
  id: string;
  slot: string;
  alpha: number;
  mode: 'single' | 'multi';
  images: RigImage[];
  /** Attachment name shown in setup (null — none / not visual). */
  setup: string | null;
  /** single mode: the image is hidden at some point (null attachment) → it needs a visibility track. */
  hides: boolean;
  /** `#rrggbb` of the group (the setup slot colour), when not white. */
  tint?: string;
  /** The slot colour is on the group (the `tint` column may animate it). */
  groupTint: boolean;
  /** mix-blend-mode of the group (Spine additive → plus-lighter, multiply, screen). */
  blend?: string;
}

export interface RigBone {
  kind: 'bone';
  id: string;
  bone: string;
  children: (RigBone | RigSlot)[];
}

export interface Rig {
  rootId: string;
  children: (RigBone | RigSlot)[];
  /** Bone → ids of its groups (the first is the bone, the rest — draw-order clones). */
  boneIds: Map<string, string[]>;
  slots: Map<string, RigSlot>;
  /** Region names the scene shows. */
  regions: Set<string>;
  viewBox: [number, number, number, number];
  warnings: string[];
  /** Kinds of non-region content found (mesh stubs, clipping…) — the skeleton is not region-only. */
  nonRegion: string[];
}

const VISUAL = new Set(['region', 'mesh', 'linkedmesh']);

/** Spine blend → the base's mix-blend-mode. */
export const BLEND: Record<string, string> = { additive: 'plus-lighter', multiply: 'multiply', screen: 'screen' };

const geomKey = (g: Geom): string =>
  [g.x, g.y, g.rotation, g.scaleX, g.scaleY, g.width, g.height, g.alpha].map((v) => fmt(v, 3)).join(',');

const hex = (c: { r: number; g: number; b: number }): string => hexColor(c.r, c.g, c.b);

/** Mesh → bounding box in its bone's space (setup pose for weighted vertices). */
function meshBox(sk: SkeletonData, a: AttachmentData, slotBone: string, world: Map<string, World>): Geom | null {
  const v = a.vertices ?? [];
  const pts: [number, number][] = [];
  if (a.uvCount !== undefined && v.length === a.uvCount) {
    for (let i = 0; i + 1 < v.length; i += 2) pts.push([v[i], v[i + 1]]);
  } else {
    const bw = world.get(slotBone);
    if (!bw) return null;
    const det = bw.a * bw.d - bw.b * bw.c;
    if (Math.abs(det) < 1e-12) return null;
    let i = 0;
    while (i < v.length) {
      const n = v[i++];
      let wx = 0;
      let wy = 0;
      for (let j = 0; j < n; j++) {
        const b = sk.bones[v[i]];
        const w = b ? world.get(b.name) : undefined;
        const bx = v[i + 1];
        const by = v[i + 2];
        const weight = v[i + 3];
        i += 4;
        if (!w) continue;
        wx += (w.a * bx + w.b * by + w.x) * weight;
        wy += (w.c * bx + w.d * by + w.y) * weight;
      }
      const dx = wx - bw.x;
      const dy = wy - bw.y;
      pts.push([(bw.d * dx - bw.b * dy) / det, (-bw.c * dx + bw.a * dy) / det]);
    }
  }
  if (!pts.length) return null;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, rotation: 0, scaleX: 1, scaleY: 1, width: Math.max(x1 - x0, 1), height: Math.max(y1 - y0, 1), alpha: a.color.a };
}

export interface RigOptions {
  skin?: string;
  /** Root group id (default — the skeleton name). */
  rootId?: string;
}

/** Every attachment name a slot shows: setup + attachment timelines of all animations. */
function usedAttachments(sk: SkeletonData): Map<string, Set<string | null>> {
  const m = new Map<string, Set<string | null>>();
  for (const s of sk.slots) m.set(s.name, new Set([s.attachment]));
  for (const a of sk.animations)
    for (const tl of a.attachments) {
      const set = m.get(tl.slot);
      if (set) for (const k of tl.keys) set.add(k.name);
    }
  return m;
}

const mulRgb = (a: Rgba, b: Rgba): Rgba => ({ r: a.r * b.r, g: a.g * b.g, b: a.b * b.b, a: a.a * b.a });

export function buildRig(sk: SkeletonData, opts: RigOptions = {}): Rig {
  const skin = opts.skin ?? 'default';
  const warnings: string[] = [];
  const nonRegion = new Set<string>();
  const ids = new Ids();
  const rootId = ids.take(opts.rootId ?? sk.name);
  const setup = samplePose(sk, null, 0);

  if (skin !== 'default' && !sk.skins.has(skin)) throw new Error(`E_SPINE_IMPORT_USAGE: ${sk.name}: no skin "${skin}" (skins: ${[...sk.skins.keys()].join(', ')})`);
  const otherSkins = [...sk.skins.keys()].filter((s) => s !== 'default' && s !== skin);
  if (otherSkins.length) warnings.push(`skins ${otherSkins.join(', ')} not transferred (the scene is skin ${skin}${skin === 'default' ? '' : ' over default'}; another — --skin).`);

  // Bone ids are reserved first, in bone order: the bone's own group always has its plain name.
  const boneBase = new Map<string, string>();
  for (const b of sk.bones) boneBase.set(b.name, ids.take(b.name));
  const boneIds = new Map<string, string[]>();
  const parents = new Map(sk.bones.map((b) => [b.name, b.parent]));
  const chainOf = (bone: string): string[] => {
    const out: string[] = [];
    for (let b: string | null | undefined = bone; b; b = parents.get(b)) out.unshift(b);
    return out;
  };
  const newBone = (bone: string): RigBone => {
    const list = boneIds.get(bone) ?? [];
    const id = list.length === 0 ? boneBase.get(bone)! : ids.take(`${boneBase.get(bone)}--${list.length + 1}`);
    list.push(id);
    boneIds.set(bone, list);
    return { kind: 'bone', id, bone, children: [] };
  };

  for (const b of sk.bones) {
    if (b.inherit !== 'normal') warnings.push(`bone ${b.name}: inheritance "${b.inherit}" is not supported — transferred as normal.`);
    if (b.shearX || b.shearY) warnings.push(`bone ${b.name}: shear (${fmt(b.shearX)}, ${fmt(b.shearY)}) in the setup pose — dropped (bones carry no skew).`);
  }

  const colorTracks = new Set(sk.animations.flatMap((a) => a.color.map((c) => c.slot)));
  const used = usedAttachments(sk);
  const regions = new Set<string>();
  const slots = new Map<string, RigSlot>();
  const children: (RigBone | RigSlot)[] = [];
  let stack: RigBone[] = [];

  for (const s of sk.slots) {
    const blend = s.blend !== 'normal' ? BLEND[s.blend] : undefined;
    if (s.blend !== 'normal' && !blend) warnings.push(`slot ${s.name}: blend ${s.blend} — no such mode, drawn normal.`);
    if (s.dark) warnings.push(`slot ${s.name}: a dark colour (two-colour tint) — not transferred, the light colour is.`);

    // Visual attachments of the slot.
    const atts = new Map<string, { a: AttachmentData; geom: Geom; stub: boolean }>();
    for (const name of used.get(s.name) ?? []) {
      if (name === null) continue;
      const a = findAttachment(sk, skin, s.name, name);
      if (!a) {
        warnings.push(`slot ${s.name}: no attachment "${name}" in skin ${skin} — not shown.`);
        continue;
      }
      if (!VISUAL.has(a.type)) {
        if (a.type === 'clipping') {
          nonRegion.add('clipping');
          warnings.push(`slot ${s.name}: clipping "${name}" is not transferred (a polygon mask — a clipPath candidate).`);
        }
        continue;
      }
      if (a.sequence) {
        nonRegion.add('sequence');
        warnings.push(`attachment ${s.name}/${name}: sequence — the setup frame (${a.path}) is transferred, frame changes are not.`);
      }
      if (a.type === 'region') {
        atts.set(name, { a, geom: { x: a.x, y: a.y, rotation: a.rotation, scaleX: a.scaleX, scaleY: a.scaleY, width: a.width, height: a.height, alpha: a.color.a }, stub: false });
        continue;
      }
      let mesh = a;
      if (a.type === 'linkedmesh') {
        const p = a.parent ? findAttachment(sk, skin, s.name, a.parent) : undefined;
        if (p) mesh = { ...p, path: a.path, color: a.color };
      }
      const box = meshBox(sk, mesh, s.bone, setup.world);
      nonRegion.add('mesh');
      if (!box) {
        warnings.push(`mesh ${s.name}/${name}: vertices unreadable — skipped.`);
        continue;
      }
      warnings.push(`mesh ${s.name}/${name}: replaced by a region stub (bbox ${fmt(box.width, 1)}×${fmt(box.height, 1)}), deformation is not transferred.`);
      atts.set(name, { a, geom: box, stub: true });
    }

    // Colour: on the group (animated), or baked into the images when attachments have their own.
    const attColored = [...atts.values()].some((v) => !isWhite(v.a.color));
    const groupTint = !attColored || colorTracks.has(s.name);
    if (attColored && colorTracks.has(s.name)) warnings.push(`slot ${s.name}: attachment colours are lost while the slot colour animates (the group's tint wins).`);

    const slotId = ids.take(`${s.name}-slot`);
    const keys = new Set([...atts.values()].map((v) => geomKey(v.geom)));
    const single = keys.size <= 1 && !(attColored && !groupTint && new Set([...atts.values()].map((v) => hex(v.a.color))).size > 1);
    const images: RigImage[] = [];
    const imageTint = (a: AttachmentData): string | undefined => {
      if (groupTint) return undefined;
      const c = mulRgb(s.color, a.color);
      return isWhite(c) ? undefined : hex(c);
    };
    if (single) {
      const first = (s.attachment && atts.get(s.attachment)) || [...atts.values()][0];
      if (first) images.push({ id: ids.take(`${s.name}-img`), att: first.a.name, region: first.a.path, geom: first.geom, stub: first.stub, tint: imageTint(first.a) });
    } else {
      for (const [name, v] of atts) images.push({ id: ids.take(`${s.name}-img-${name}`), att: name, region: v.a.path, geom: v.geom, stub: v.stub, tint: imageTint(v.a) });
    }
    for (const v of atts.values()) regions.add(v.a.path);
    const shown = s.attachment && atts.has(s.attachment) ? s.attachment : null;
    const names = used.get(s.name) ?? new Set();
    const hides = single && images.length > 0 && [...names].some((n) => n === null || !atts.has(n));
    const node: RigSlot = {
      kind: 'slot',
      id: slotId,
      slot: s.name,
      alpha: s.color.a,
      mode: single ? 'single' : 'multi',
      images,
      setup: shown,
      hides,
      tint: groupTint && !isWhite(s.color) ? hex(s.color) : undefined,
      groupTint,
      blend,
    };
    slots.set(s.name, node);

    // Open the bone chain (draw order).
    const chain = chainOf(s.bone);
    let k = 0;
    while (k < stack.length && k < chain.length && stack[k].bone === chain[k]) k++;
    stack = stack.slice(0, k);
    for (let j = k; j < chain.length; j++) {
      const g = newBone(chain[j]);
      (j === 0 ? children : stack[j - 1].children).push(g);
      stack.push(g);
    }
    (stack.length ? stack[stack.length - 1].children : children).push(node);
  }

  // Bones without slots — under their parent's first group, so they still exist (anchors).
  const first = new Map<string, RigBone>();
  const index = (list: (RigBone | RigSlot)[]): void => {
    for (const n of list)
      if (n.kind === 'bone') {
        if (!first.has(n.bone)) first.set(n.bone, n);
        index(n.children);
      }
  };
  index(children);
  for (const b of sk.bones) {
    if (boneIds.has(b.name)) continue;
    const g = newBone(b.name);
    const parent = b.parent ? first.get(b.parent) : undefined;
    (parent ? parent.children : children).push(g);
    first.set(b.name, g);
  }

  const clones = cloneCount({ boneIds } as Rig);
  if (clones) warnings.push(`the draw order disagrees with the bone hierarchy: ${clones} bone group clone(s) (ids "bone--N"), their tracks duplicated.`);

  return { rootId, children, boneIds, slots, regions, viewBox: viewBoxOf(sk, slots, setup.world), warnings, nonRegion: [...nonRegion] };
}

/** Bone groups opened again for the draw order. */
export const cloneCount = (rig: Pick<Rig, 'boneIds'>): number => [...rig.boneIds.values()].reduce((n, l) => n + l.length - 1, 0);

/** Bounds of the setup pose (visible images), y flipped, padded by 2 %. */
function viewBoxOf(sk: SkeletonData, slots: Map<string, RigSlot>, world: Map<string, World>): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const s of sk.slots) {
    const rs = slots.get(s.name);
    const w = world.get(s.bone);
    if (!rs || !w || !rs.setup) continue;
    const img = rs.images.find((i) => (rs.mode === 'single' ? true : i.att === rs.setup));
    if (!img) continue;
    const g = img.geom;
    const r = (g.rotation * Math.PI) / 180;
    for (const [cx, cy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const lx = (cx * g.width * g.scaleX) / 2;
      const ly = (cy * g.height * g.scaleY) / 2;
      const ax = g.x + lx * Math.cos(r) - ly * Math.sin(r);
      const ay = g.y + lx * Math.sin(r) + ly * Math.cos(r);
      const X = w.a * ax + w.b * ay + w.x;
      const Y = -(w.c * ax + w.d * ay + w.y);
      x0 = Math.min(x0, X);
      x1 = Math.max(x1, X);
      y0 = Math.min(y0, Y);
      y1 = Math.max(y1, Y);
    }
  }
  if (!Number.isFinite(x0)) return [-100, -100, 200, 200];
  const pad = Math.max(x1 - x0, y1 - y0) * 0.02;
  return [Math.floor(x0 - pad), Math.floor(y0 - pad), Math.ceil(x1 - x0 + 2 * pad), Math.ceil(y1 - y0 + 2 * pad)];
}

/** translate(x, −y) rotate(−r) scale(sx, sy), identity parts dropped. */
export function transformOf(x: number, y: number, rotation: number, scaleX: number, scaleY: number): string {
  const parts: string[] = [];
  if (fmt(x) !== '0' || fmt(-y) !== '0') parts.push(`translate(${fmt(x)} ${fmt(-y)})`);
  if (fmt(-rotation) !== '0') parts.push(`rotate(${fmt(-rotation)})`);
  if (fmt(scaleX) !== '1' || fmt(scaleY) !== '1') parts.push(`scale(${fmt(scaleX)} ${fmt(scaleY)})`);
  return parts.join(' ');
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export interface SvgOptions {
  /** Region name → href (default `art/<region>.png`). */
  href?: (region: string) => string;
}

export const defaultHref = (region: string): string => `art/${region}.png`;

/** scene.svg — the sterile Trempel base. */
export function sceneSvg(sk: SkeletonData, rig: Rig, opts: SvgOptions = {}): string {
  const href = opts.href ?? defaultHref;
  const bones = new Map(sk.bones.map((b) => [b.name, b]));
  const out: string[] = [];
  const [vx, vy, vw, vh] = rig.viewBox;
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vx} ${vy} ${vw} ${vh}" width="${vw}" height="${vh}">`);
  out.push(`  <g id="${esc(rig.rootId)}">`);
  const attr = (k: string, v: string | undefined): string => (v ? ` ${k}="${esc(v)}"` : '');
  const visit = (list: (RigBone | RigSlot)[], depth: number): void => {
    const pad = '  '.repeat(depth);
    for (const n of list) {
      if (n.kind === 'bone') {
        const b = bones.get(n.bone)!;
        const tr = transformOf(b.x, b.y, b.rotation, b.scaleX, b.scaleY);
        if (!n.children.length) {
          out.push(`${pad}<g id="${esc(n.id)}"${attr('transform', tr)}/>`);
          continue;
        }
        out.push(`${pad}<g id="${esc(n.id)}"${attr('transform', tr)}>`);
        visit(n.children, depth + 1);
        out.push(`${pad}</g>`);
        continue;
      }
      const op = fmt(n.alpha, 4) === '1' ? '' : fmt(n.alpha, 4);
      const head = `${pad}<g id="${esc(n.id)}"${attr('opacity', op)}${attr('data-tint', n.tint)}${attr('style', n.blend ? `mix-blend-mode: ${n.blend}` : undefined)}`;
      if (!n.images.length) {
        out.push(`${head}/>`);
        continue;
      }
      out.push(`${head}>`);
      for (const img of n.images) {
        const g = img.geom;
        const shown = n.mode === 'single' ? n.setup !== null : img.att === n.setup;
        const a = shown ? g.alpha : 0;
        const tr = transformOf(g.x, g.y, g.rotation, g.scaleX, g.scaleY);
        out.push(
          `${pad}  <image id="${esc(img.id)}" href="${esc(href(img.region))}" x="${fmt(-g.width / 2)}" y="${fmt(-g.height / 2)}" width="${fmt(g.width)}" height="${fmt(g.height)}"${attr('transform', tr)}${attr('opacity', fmt(a) === '1' ? '' : fmt(a))}${attr('data-tint', img.tint)}/>`,
        );
      }
      out.push(`${pad}</g>`);
    }
  };
  visit(rig.children, 2);
  out.push('  </g>');
  out.push('</svg>');
  return out.join('\n') + '\n';
}
