// atlas.ts — the Spine / libGDX texture atlas text → pages and regions.
//
// Two dialects:
//   old (Spine ≤ 3.8, also 4.x exports with legacy settings): region props `rotate: true|false`,
//     `xy`, `size`, `orig`, `offset`, `index`, indented under the region name;
//   new (4.0+): `bounds: x, y, w, h`, `offsets: x, y, origW, origH`, `rotate: 90|true`.
// A page starts after a blank line (or at the top) with the image file name, followed by its
// `key: value` lines; then regions: a bare name line and its `key: value` lines.
//
// Region geometry: (x, y) — top-left on the page; (w, h) — the packed size BEFORE rotation (on the
// page a 90° region occupies h × w); (offX, offY) — position of the packed image inside the
// original (trimmed whitespace), measured from the bottom-left; (origW, origH) — original size.
// `degrees` — how the packer rotated the image counter-clockwise; restoring it is a clockwise turn.

export interface AtlasPage {
  file: string;
  width: number;
  height: number;
  pma: boolean;
}

export interface AtlasRegion {
  name: string;
  page: AtlasPage;
  x: number;
  y: number;
  w: number;
  h: number;
  offX: number;
  offY: number;
  origW: number;
  origH: number;
  degrees: number;
  index: number;
}

export interface Atlas {
  pages: AtlasPage[];
  regions: AtlasRegion[];
}

const nums = (v: string): number[] => v.split(',').map((s) => Number(s.trim()));

/** Parse atlas text. @throws E_SPINE_IMPORT_ATLAS on a region outside any page or a malformed number. */
export function parseAtlas(text: string, label = 'atlas'): Atlas {
  const lines = text.split(/\r?\n/);
  const pages: AtlasPage[] = [];
  const regions: AtlasRegion[] = [];
  let page: AtlasPage | null = null;
  let region: AtlasRegion | null = null;
  let expectPage = true;

  const finish = (): void => {
    if (!region) return;
    if (region.origW === 0 && region.origH === 0) {
      region.origW = region.w;
      region.origH = region.h;
    }
    regions.push(region);
    region = null;
  };

  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) {
      finish();
      expectPage = true;
      return;
    }
    const colon = line.indexOf(':');
    if (colon < 0) {
      finish();
      if (expectPage) {
        page = { file: line, width: 0, height: 0, pma: false };
        pages.push(page);
        expectPage = false;
        return;
      }
      if (!page) throw new Error(`E_SPINE_IMPORT_ATLAS: ${label}:${i + 1}: region "${line}" outside a page`);
      region = { name: line, page, x: 0, y: 0, w: 0, h: 0, offX: 0, offY: 0, origW: 0, origH: 0, degrees: 0, index: -1 };
      return;
    }
    expectPage = false;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    const n = (): number[] => {
      const v = nums(value);
      if (!v.every(Number.isFinite)) throw new Error(`E_SPINE_IMPORT_ATLAS: ${label}:${i + 1}: ${key}: "${value}" — not numbers`);
      return v;
    };
    if (!region) {
      if (!page) throw new Error(`E_SPINE_IMPORT_ATLAS: ${label}:${i + 1}: ${key} before a page name`);
      if (key === 'size') [page.width, page.height] = n();
      else if (key === 'pma') page.pma = value === 'true';
      return;
    }
    const r: AtlasRegion = region;
    switch (key) {
      case 'rotate':
        r.degrees = value === 'true' ? 90 : value === 'false' ? 0 : n()[0];
        break;
      case 'xy':
        [r.x, r.y] = n();
        break;
      case 'size':
        [r.w, r.h] = n();
        break;
      case 'bounds':
        [r.x, r.y, r.w, r.h] = n();
        break;
      case 'orig':
        [r.origW, r.origH] = n();
        break;
      case 'offset':
        [r.offX, r.offY] = n();
        break;
      case 'offsets':
        [r.offX, r.offY, r.origW, r.origH] = n();
        break;
      case 'index':
        r.index = n()[0];
        break;
      default:
        break; // split, pad, custom values — not needed to cut images
    }
  });
  finish();
  return { pages, regions };
}

/** Region lookup by name; regions with an index are also found as `name + index` (frame sequences). */
export function regionIndex(atlas: Atlas): Map<string, AtlasRegion> {
  const m = new Map<string, AtlasRegion>();
  for (const r of atlas.regions) {
    if (r.index >= 0) m.set(`${r.name}${r.index}`, r);
    if (!m.has(r.name)) m.set(r.name, r);
  }
  return m;
}
