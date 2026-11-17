// spine.ts — Spine skeleton JSON (3.5–4.2) → one normalized model the rest of the importer reads.
//
// Written from the format documentation (the Spine JSON format reference), not from the Spine
// runtimes. Differences between versions are absorbed here:
//   - 4.x curves are absolute control points (time, value) per value of the timeline, 3.x curves
//     are normalized 0..1 and shared by all values — both end up absolute (Curve 'bezier');
//   - 4.x rotate key `value`, 3.x `angle`; 4.x split timelines translatex/scaley/…;
//   - 4.x slot rgba/rgb/alpha/rgba2/rgb2, 3.x color/twoColor;
//   - 4.2 bone `inherit`, 4.0–4.1 `transform`, 3.5 inheritRotation/inheritScale.
// Coordinates stay Spine's: y up, rotation in degrees counter-clockwise.

export type Curve =
  | { kind: 'linear' }
  | { kind: 'stepped' }
  /** Control points in absolute (time, value) of the segment from this key to the next. */
  | { kind: 'bezier'; cx1: number; cy1: number; cx2: number; cy2: number };

/** One key of a numeric timeline; `curve` shapes the segment to the next key. */
export interface Key {
  t: number;
  v: number;
  curve: Curve;
}

export interface BoneData {
  name: string;
  parent: string | null;
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  shearX: number;
  shearY: number;
  /** normal | onlyTranslation | noRotationOrReflection | noScale | noScaleOrReflection */
  inherit: string;
}

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface SlotData {
  name: string;
  bone: string;
  attachment: string | null;
  color: Rgba;
  /** A dark colour (two-colour tint) is set in the setup pose. */
  dark: boolean;
  blend: string;
}

export interface AttachmentData {
  /** Name in the skin (the key the slot / timeline uses). */
  name: string;
  type: string;
  /** Atlas region name (path ?? name; a sequence — the setup frame). */
  path: string;
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  width: number;
  height: number;
  color: Rgba;
  sequence: boolean;
  /** Mesh: vertices as written (weighted or not), uv count; linked mesh: parent name. */
  vertices?: number[];
  uvCount?: number;
  parent?: string;
}

export type BoneProp = 'rotate' | 'x' | 'y' | 'scaleX' | 'scaleY' | 'shearX' | 'shearY';

export interface BoneTimeline {
  bone: string;
  prop: BoneProp;
  keys: Key[];
}

export interface AttachmentKey {
  t: number;
  name: string | null;
}

export interface EventKey {
  t: number;
  name: string;
  /** int / float / string / audio payload present (only the name is transferred). */
  payload: boolean;
}

/** A slot colour timeline, channel by channel (absolute 0..1). */
export interface ColorTimeline {
  slot: string;
  r: Key[];
  g: Key[];
  b: Key[];
}

/** A draw order key: the slots' order from `t` on (null offsets — back to the setup order). */
export interface DrawOrderKey {
  t: number;
  offsets: { slot: string; offset: number }[] | null;
}

export interface AnimationData {
  name: string;
  /** Seconds — the last key of any timeline, supported or not (as Spine counts it). */
  duration: number;
  bones: BoneTimeline[];
  /** Slot alpha (absolute, 0..1). */
  alpha: { slot: string; keys: Key[] }[];
  /** Slot colour (rgb, absolute) — the `tint` column. */
  color: ColorTimeline[];
  attachments: { slot: string; keys: AttachmentKey[] }[];
  events: EventKey[];
  /** Slots whose colour (rgb) changes. */
  tinted: string[];
  /** Slots with a dark colour timeline (two-colour tint — not transferred). */
  dark: string[];
  drawOrder: DrawOrderKey[];
  /** Timelines that are not transferred, human-readable (`ik: arm`, `deform: body/mesh`). */
  unsupported: string[];
}

export interface SkeletonData {
  name: string;
  version: string;
  bones: BoneData[];
  slots: SlotData[];
  /** Skin name → slot → attachment name → data. */
  skins: Map<string, Map<string, Map<string, AttachmentData>>>;
  events: string[];
  ik: { name: string; bones: string[]; target: string }[];
  transform: { name: string; bones: string[]; target: string }[];
  path: { name: string; bones: string[]; target: string }[];
  physics: string[];
  animations: AnimationData[];
}

type J = Record<string, any>;

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export function parseColor(hex: unknown, d: Rgba = { r: 1, g: 1, b: 1, a: 1 }): Rgba {
  if (typeof hex !== 'string' || !/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(hex)) return { ...d };
  const c = (i: number): number => parseInt(hex.slice(i, i + 2), 16) / 255;
  return { r: c(0), g: c(2), b: c(4), a: hex.length === 8 ? c(6) : 1 };
}

export const isWhite = (c: Rgba): boolean => c.r === 1 && c.g === 1 && c.b === 1;

/** Major version of the `skeleton.spine` string ('4.1.17' → 4); unknown → 4. */
function major(version: string): number {
  const m = /^(\d+)/.exec(version);
  return m ? Number(m[1]) : 4;
}

/**
 * Curves of key `i` for `count` values. 4.x: `curve` is 'stepped' or an array with four absolute
 * numbers per value. 3.x: 'stepped', a normalized [cx1, cy1, cx2, cy2] (3.5–3.7), or a number cx1
 * with c2/c3/c4 (3.8) — shared by every value, made absolute against this key and the next.
 */
function readCurves(keys: J[], i: number, values: (k: J) => number[], v3: boolean): Curve[] {
  const k = keys[i];
  const n = values(k).length;
  const same = (c: Curve): Curve[] => Array.from({ length: n }, () => c);
  const c = k.curve;
  if (c === undefined || c === 'linear' || i === keys.length - 1) return same({ kind: 'linear' });
  if (c === 'stepped') return same({ kind: 'stepped' });
  if (!v3) {
    if (!Array.isArray(c)) return same({ kind: 'linear' });
    return Array.from({ length: n }, (_, j) => ({
      kind: 'bezier' as const,
      cx1: num(c[j * 4], 0),
      cy1: num(c[j * 4 + 1], 0),
      cx2: num(c[j * 4 + 2], 1),
      cy2: num(c[j * 4 + 3], 1),
    }));
  }
  let norm: number[];
  if (Array.isArray(c)) norm = [num(c[0], 0), num(c[1], 0), num(c[2], 1), num(c[3], 1)];
  else if (typeof c === 'number') norm = [c, num(k.c2, 0), num(k.c3, 1), num(k.c4, 1)];
  else return same({ kind: 'linear' });
  const next = keys[i + 1];
  const t0 = num(k.time, 0);
  const t1 = num(next.time, 0);
  const v0 = values(k);
  const v1 = values(next);
  return v0.map((a, j) => ({
    kind: 'bezier' as const,
    cx1: t0 + norm[0] * (t1 - t0),
    cy1: a + norm[1] * (v1[j] - a),
    cx2: t0 + norm[2] * (t1 - t0),
    cy2: a + norm[3] * (v1[j] - a),
  }));
}

/** A timeline of several values → one key list per value. */
function readMulti(keys: J[], values: (k: J) => number[], v3: boolean): Key[][] {
  if (!Array.isArray(keys) || !keys.length) return [];
  const n = values(keys[0]).length;
  const out: Key[][] = Array.from({ length: n }, () => []);
  keys.forEach((k, i) => {
    const vs = values(k);
    const curves = readCurves(keys, i, values, v3);
    vs.forEach((v, j) => out[j].push({ t: num(k.time, 0), v, curve: curves[j] }));
  });
  return out;
}

function inheritOf(b: J): string {
  if (typeof b.inherit === 'string') return b.inherit;
  if (typeof b.transform === 'string') return b.transform;
  if (b.inheritRotation === false && b.inheritScale === false) return 'onlyTranslation';
  if (b.inheritRotation === false) return 'noRotationOrReflection';
  if (b.inheritScale === false) return 'noScale';
  return 'normal';
}

function readAttachment(name: string, a: J): AttachmentData {
  const type = typeof a.type === 'string' ? a.type : 'region';
  let path = typeof a.path === 'string' ? a.path : typeof a.name === 'string' ? a.name : name;
  const seq = a.sequence && typeof a.sequence === 'object' ? (a.sequence as J) : null;
  if (seq) {
    const frame = num(seq.start, 1) + num(seq.setup, 0);
    const digits = num(seq.digits, 0);
    path += String(frame).padStart(digits, '0');
  }
  const out: AttachmentData = {
    name,
    type,
    path,
    x: num(a.x, 0),
    y: num(a.y, 0),
    rotation: num(a.rotation, 0),
    scaleX: num(a.scaleX, 1),
    scaleY: num(a.scaleY, 1),
    width: num(a.width, 32),
    height: num(a.height, 32),
    color: parseColor(a.color),
    sequence: !!seq,
  };
  if (type === 'mesh') {
    out.vertices = Array.isArray(a.vertices) ? a.vertices : [];
    out.uvCount = Array.isArray(a.uvs) ? a.uvs.length : 0;
  }
  if (type === 'linkedmesh') out.parent = typeof a.parent === 'string' ? a.parent : undefined;
  return out;
}

function readSkins(raw: unknown): SkeletonData['skins'] {
  const skins: SkeletonData['skins'] = new Map();
  // 4.x: [{ name, attachments }]; 3.x: { skinName: { slot: { att: data } } }
  const list: [string, J][] = Array.isArray(raw)
    ? (raw as J[]).map((s) => [String(s.name), (s.attachments ?? {}) as J])
    : raw && typeof raw === 'object'
      ? Object.entries(raw as J)
      : [];
  for (const [skin, slots] of list) {
    const m = new Map<string, Map<string, AttachmentData>>();
    for (const [slot, atts] of Object.entries(slots)) {
      const am = new Map<string, AttachmentData>();
      for (const [an, a] of Object.entries(atts as J)) am.set(an, readAttachment(an, a as J));
      m.set(slot, am);
    }
    skins.set(skin, m);
  }
  return skins;
}

const constraintBones = (list: unknown): { name: string; bones: string[]; target: string }[] =>
  Array.isArray(list)
    ? (list as J[]).map((c) => ({
        name: String(c.name),
        bones: Array.isArray(c.bones) ? c.bones.map(String) : typeof c.bone === 'string' ? [c.bone] : [],
        target: typeof c.target === 'string' ? c.target : '',
      }))
    : [];

function maxTime(v: unknown): number {
  let m = 0;
  const visit = (x: unknown): void => {
    if (Array.isArray(x)) {
      for (const k of x) {
        if (k && typeof k === 'object' && !Array.isArray(k)) m = Math.max(m, num((k as J).time, 0));
        visit(k);
      }
    } else if (x && typeof x === 'object') for (const y of Object.values(x)) visit(y);
  };
  visit(v);
  return m;
}

function readAnimation(name: string, a: J, v3: boolean): AnimationData {
  const anim: AnimationData = {
    name,
    duration: maxTime(a),
    bones: [],
    alpha: [],
    color: [],
    attachments: [],
    events: [],
    tinted: [],
    dark: [],
    drawOrder: [],
    unsupported: [],
  };
  const pair = (dx: number, kx: string, ky: string) => (k: J) => [num(k[kx], dx), num(k[ky], dx)];
  const single = (d: number, key = 'value') => (k: J) => [num(k[key] ?? (key === 'value' ? k.angle : undefined), d)];

  for (const [bone, tls] of Object.entries((a.bones ?? {}) as J)) {
    for (const [type, keys] of Object.entries(tls as J)) {
      const push = (prop: BoneProp, ks: Key[] | undefined): void => {
        if (ks && ks.length) anim.bones.push({ bone, prop, keys: ks });
      };
      switch (type) {
        case 'rotate': {
          const [r] = readMulti(keys, single(0), v3);
          push('rotate', r);
          break;
        }
        case 'translate':
        case 'scale':
        case 'shear': {
          const d = type === 'scale' ? 1 : 0;
          const [x, y] = readMulti(keys, pair(d, 'x', 'y'), v3);
          const px: BoneProp = type === 'translate' ? 'x' : type === 'scale' ? 'scaleX' : 'shearX';
          const py: BoneProp = type === 'translate' ? 'y' : type === 'scale' ? 'scaleY' : 'shearY';
          push(px, x);
          push(py, y);
          break;
        }
        case 'translatex':
        case 'translatey':
        case 'scalex':
        case 'scaley':
        case 'shearx':
        case 'sheary': {
          const d = type.startsWith('scale') ? 1 : 0;
          const [v] = readMulti(keys, single(d), v3);
          const prop = ({ translatex: 'x', translatey: 'y', scalex: 'scaleX', scaley: 'scaleY', shearx: 'shearX', sheary: 'shearY' } as const)[type];
          push(prop, v);
          break;
        }
        default:
          anim.unsupported.push(`bone ${type}: ${bone}`);
      }
    }
  }

  const tinted = (slot: string, ch: Key[][]): void => {
    if (ch.slice(0, 3).some((ks) => ks.some((k) => k.v !== 1))) anim.tinted.push(slot);
    anim.color.push({ slot, r: ch[0], g: ch[1], b: ch[2] });
  };
  for (const [slot, tls] of Object.entries((a.slots ?? {}) as J)) {
    for (const [type, keys] of Object.entries(tls as J)) {
      if (!Array.isArray(keys) || !keys.length) continue;
      switch (type) {
        case 'attachment':
          anim.attachments.push({
            slot,
            keys: (keys as J[]).map((k) => ({ t: num(k.time, 0), name: typeof k.name === 'string' ? k.name : null })),
          });
          break;
        case 'rgba':
        case 'color':
        case 'rgba2':
        case 'twoColor': {
          // rgba2 / twoColor: light rgba + dark rgb; the light part is the colour, the dark is lost.
          const field = type === 'rgba' || type === 'color' ? 'color' : 'light';
          const rgba = (k: J): number[] => {
            const c = parseColor(k[field]);
            return [c.r, c.g, c.b, c.a];
          };
          const channels = readMulti(keys, rgba, v3);
          anim.alpha.push({ slot, keys: channels[3] });
          tinted(slot, channels);
          if (type === 'rgba2' || type === 'twoColor') anim.dark.push(slot);
          break;
        }
        case 'alpha': {
          const [v] = readMulti(keys, single(0), v3);
          anim.alpha.push({ slot, keys: v });
          break;
        }
        case 'rgb':
        case 'rgb2': {
          const field = type === 'rgb' ? 'color' : 'light';
          const rgb = (k: J): number[] => {
            const c = parseColor(typeof k[field] === 'string' && k[field].length === 6 ? `${k[field]}ff` : k[field]);
            return [c.r, c.g, c.b];
          };
          tinted(slot, readMulti(keys, rgb, v3));
          if (type === 'rgb2') anim.dark.push(slot);
          break;
        }
        default:
          anim.unsupported.push(`slot ${type}: ${slot}`);
      }
    }
  }

  for (const k of (Array.isArray(a.events) ? a.events : []) as J[]) {
    anim.events.push({
      t: num(k.time, 0),
      name: String(k.name),
      payload: k.int !== undefined || k.float !== undefined || k.string !== undefined || k.volume !== undefined || k.balance !== undefined,
    });
  }

  const order = a.drawOrder ?? a.draworder;
  if (Array.isArray(order)) {
    for (const k of order as J[]) {
      const offsets = Array.isArray(k.offsets) ? (k.offsets as J[]).map((o) => ({ slot: String(o.slot), offset: num(o.offset, 0) })) : null;
      anim.drawOrder.push({ t: num(k.time, 0), offsets });
    }
  }

  for (const kind of ['ik', 'transform', 'path', 'physics'] as const) {
    const tl = a[kind];
    if (tl && typeof tl === 'object') for (const id of Object.keys(tl)) anim.unsupported.push(`${kind}: ${id || '(all)'}`);
  }
  // 4.x: attachments → skin → slot → attachment → { deform, sequence }; 3.x: deform → skin → slot → attachment.
  const nested = (root: unknown, label: (inner: string) => string): void => {
    if (!root || typeof root !== 'object') return;
    for (const [skin, sl] of Object.entries(root as J))
      for (const [slot, at] of Object.entries(sl as J))
        for (const [att, tls] of Object.entries(at as J)) {
          const kinds = v3 ? ['deform'] : Object.keys(tls as J);
          for (const k of kinds) anim.unsupported.push(`${label(k)}: ${slot}/${att}${skin === 'default' ? '' : ` (skin ${skin})`}`);
        }
  };
  nested(a.attachments, (k) => k);
  nested(a.deform ?? a.ffd, () => 'deform');
  return anim;
}

/** Parse Spine skeleton JSON. @throws E_SPINE_IMPORT_INPUT when the document is not a Spine skeleton. */
export function readSkeleton(json: unknown, name: string): SkeletonData {
  const j = json as J;
  if (!j || typeof j !== 'object' || !Array.isArray(j.bones)) {
    throw new Error(`E_SPINE_IMPORT_INPUT: ${name}: not a Spine skeleton (no bones array)`);
  }
  const version = String(j.skeleton?.spine ?? '');
  const v3 = major(version) < 4;
  const bones: BoneData[] = (j.bones as J[]).map((b) => ({
    name: String(b.name),
    parent: typeof b.parent === 'string' ? b.parent : null,
    x: num(b.x, 0),
    y: num(b.y, 0),
    rotation: num(b.rotation, 0),
    scaleX: num(b.scaleX, 1),
    scaleY: num(b.scaleY, 1),
    shearX: num(b.shearX, 0),
    shearY: num(b.shearY, 0),
    inherit: inheritOf(b),
  }));
  const slots: SlotData[] = ((j.slots ?? []) as J[]).map((s) => ({
    name: String(s.name),
    bone: String(s.bone),
    attachment: typeof s.attachment === 'string' ? s.attachment : null,
    color: parseColor(s.color),
    dark: typeof s.dark === 'string',
    blend: typeof s.blend === 'string' ? s.blend : 'normal',
  }));
  const animations = Object.entries((j.animations ?? {}) as J).map(([n, a]) => readAnimation(n, a as J, v3));
  return {
    name,
    version,
    bones,
    slots,
    skins: readSkins(j.skins),
    events: Object.keys(j.events ?? {}),
    ik: constraintBones(j.ik),
    transform: constraintBones(j.transform),
    path: constraintBones(j.path),
    physics: Array.isArray(j.physics) ? (j.physics as J[]).map((p) => String(p.name)) : [],
    animations,
  };
}

/** Is this parsed JSON a Spine skeleton (bones + skeleton)? */
export const isSkeleton = (j: unknown): boolean => !!j && typeof j === 'object' && Array.isArray((j as J).bones) && !!(j as J).skeleton;

/** The slot's attachment by name: the chosen skin first, then `default`. */
export function findAttachment(sk: SkeletonData, skin: string, slot: string, name: string): AttachmentData | undefined {
  return sk.skins.get(skin)?.get(slot)?.get(name) ?? sk.skins.get('default')?.get(slot)?.get(name);
}

/**
 * The draw order (slot indices, back to front) a draw order key gives: the slots named in `offsets`
 * move by their offset from their setup position, the others keep their relative setup order and
 * fill the free places (the Spine draw order timeline semantics).
 */
export function drawOrderOf(sk: SkeletonData, offsets: DrawOrderKey['offsets']): number[] {
  const n = sk.slots.length;
  if (!offsets) return sk.slots.map((_, i) => i);
  const index = new Map(sk.slots.map((s, i) => [s.name, i]));
  const order = new Array<number>(n).fill(-1);
  const unchanged: number[] = [];
  let original = 0;
  const moved = offsets
    .map((o) => ({ i: index.get(o.slot), offset: o.offset }))
    .filter((o): o is { i: number; offset: number } => o.i !== undefined)
    .sort((a, b) => a.i - b.i);
  for (const o of moved) {
    while (original !== o.i) unchanged.push(original++);
    const at = original + o.offset;
    if (at >= 0 && at < n) order[at] = original;
    original++;
  }
  while (original < n) unchanged.push(original++);
  let u = unchanged.length;
  for (let i = n - 1; i >= 0; i--) if (order[i] === -1) order[i] = unchanged[--u];
  return order;
}
