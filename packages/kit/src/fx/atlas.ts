// atlas.ts — 2.5: particle frames from a sprite atlas (TexturePacker "JSON hash": frames{ name → frame /
// rotated / trimmed / spriteSourceSize / sourceSize }). The atlas is loaded by Pixi's own `Spritesheet`
// (it knows trim and rotation); here — the renderer-free part: which frames of an atlas an emitter
// takes (a name prefix, natural order), the prefixes an atlas has (the inspector's hint) and a check of
// the atlas data.

/** One frame of a TexturePacker hash atlas, as its JSON has it. */
export interface AtlasFrameData {
  frame: { x: number; y: number; w: number; h: number };
  rotated?: boolean;
  trimmed?: boolean;
  spriteSourceSize?: { x: number; y: number; w: number; h: number };
  sourceSize?: { w: number; h: number };
}

/** A TexturePacker "JSON hash" atlas. */
export interface AtlasData {
  frames: Record<string, AtlasFrameData>;
  meta?: { image?: string; size?: { w: number; h: number }; scale?: string | number; [k: string]: unknown };
}

/** A frame of an atlas, normalized: where it is in the image, and the box of the original picture. */
export interface AtlasFrame {
  name: string;
  /** The picture's rect as the atlas names it (w × h — the picture upright; a rotated one occupies h × w of the image). */
  frame: { x: number; y: number; w: number; h: number };
  rotated: boolean;
  trimmed: boolean;
  /** Where the trimmed picture sits in the original one. */
  trim: { x: number; y: number; w: number; h: number };
  /** The original picture's size (a trimmed frame keeps it — the particle does not "dance"). */
  source: { w: number; h: number };
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Natural order of frame names: `coin_2` before `coin_10`. */
export function naturalCompare(a: string, b: string): number {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

/** Frame names starting with `prefix` (all without one), in natural order. */
export function atlasFrameNames(names: Iterable<string>, prefix = ''): string[] {
  return [...names].filter((n) => n.startsWith(prefix)).sort(naturalCompare);
}

/**
 * The prefixes of an atlas's frames — a name without its frame number and extension
 * (`coin_0007.png` → `coin_`), with the number of frames each one takes, most frames first.
 */
export function atlasPrefixes(names: Iterable<string>): { prefix: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const n of names) {
    const p = /^(.*?)\d+(?:\.[A-Za-z0-9]+)?$/.exec(n)?.[1];
    if (p === undefined) continue;
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  return [...counts].map(([prefix, count]) => ({ prefix, count })).sort((a, b) => b.count - a.count || naturalCompare(a.prefix, b.prefix));
}

/** The atlas data is a TexturePacker hash atlas (frames as an object with `frame` rects). */
export function isAtlasData(data: unknown): data is AtlasData {
  if (!data || typeof data !== 'object') return false;
  const f = (data as { frames?: unknown }).frames;
  if (!f || typeof f !== 'object' || Array.isArray(f)) return false;
  return Object.values(f).every((v) => !!v && typeof v === 'object' && typeof (v as AtlasFrameData).frame?.w === 'number');
}

/**
 * The frames of an atlas taken by `prefix`, in natural order, normalized (trim box, original size).
 * @throws E_FX_ATLAS when the data is not a hash atlas.
 */
export function parseAtlas(data: unknown, prefix = ''): AtlasFrame[] {
  if (!isAtlasData(data)) throw new Error('E_FX_ATLAS: not a TexturePacker "JSON hash" atlas (frames: { name → { frame, … } })');
  return atlasFrameNames(Object.keys(data.frames), prefix).map((name) => {
    const d = data.frames[name];
    const rotated = !!d.rotated;
    // TexturePacker: frame w × h is the picture upright (a rotated one is stored turned, h × w of the image)
    const { w, h } = d.frame;
    const trim = d.spriteSourceSize ?? { x: 0, y: 0, w, h };
    const source = d.sourceSize ?? { w, h };
    return { name, frame: { ...d.frame }, rotated, trimmed: !!d.trimmed, trim: { ...trim }, source: { ...source } };
  });
}

/**
 * The frame of a particle `age` seconds old (`animate`): `fps` frames a second from its start frame,
 * cycling 0…n−1 (or, `pingpong`, 0…n−1…1). `start` — the position in that sequence it starts at.
 */
export function atlasFrameAt(age: number, n: number, fps: number, start: number, pingpong: boolean): number {
  if (n <= 1) return 0;
  const period = pingpong ? 2 * n - 2 : n;
  const k = (((Math.floor(age * fps + 1e-6) + start) % period) + period) % period;
  return k < n ? k : period - k;
}

/** The length of an atlas animation's sequence (the range of a random start). */
export function atlasPeriod(n: number, pingpong: boolean): number {
  return n <= 1 ? 1 : pingpong ? 2 * n - 2 : n;
}
