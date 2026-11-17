// art.ts — cut atlas regions into one PNG per region at its original size: un-rotate (the packer
// turned rotated regions 90° counter-clockwise; restoring is a clockwise turn), put the trimmed
// image back at its offset (measured from the bottom-left), un-premultiply pages marked `pma: true`
// (Trempel draws a PNG with straight alpha). Pages are decoded by our own PNG reader and the regions
// written as plain RGBA PNGs — nothing but pixels, no metadata, no native dependency.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { encodePng } from '../fx-import/image.js';
import { regionIndex, type Atlas } from './atlas.js';

export interface Rgba8 {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, top row first. */
  data: Uint8Array;
}

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Decode a PNG (any colour type and bit depth, interlaced or not) to RGBA8. @throws E_SPINE_IMPORT_ART */
export function decodePng(bytes: Uint8Array, label = 'png'): Rgba8 {
  const fail = (m: string): never => {
    throw new Error(`E_SPINE_IMPORT_ART: ${label}: ${m}`);
  };
  if (bytes.length < 8 || SIG.some((b, i) => bytes[i] !== b)) fail('not a PNG');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let type = 0;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (at + 8 <= bytes.length) {
    const len = dv.getUint32(at);
    const name = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const data = bytes.subarray(at + 8, at + 8 + len);
    if (name === 'IHDR') {
      width = dv.getUint32(at + 8);
      height = dv.getUint32(at + 12);
      depth = data[8];
      type = data[9];
      interlace = data[12];
    } else if (name === 'PLTE') palette = data;
    else if (name === 'tRNS') trns = data;
    else if (name === 'IDAT') idat.push(data);
    else if (name === 'IEND') break;
    at += 12 + len;
  }
  if (!width || !height) fail('no IHDR');
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[type];
  if (!channels) fail(`colour type ${type}`);
  if (type === 3 && !palette) fail('palette image without PLTE');
  const all = new Uint8Array(idat.reduce((s, d) => s + d.length, 0));
  let o = 0;
  for (const d of idat) {
    all.set(d, o);
    o += d.length;
  }
  const raw = new Uint8Array(inflateSync(all));
  const bpp = Math.max(1, (channels * depth) >> 3);
  const out = new Uint8Array(width * height * 4);
  const max = (1 << depth) - 1;

  let pos = 0;
  /** Unfilter one pass (w × h pixels) and write its pixels at (x0 + i·dx, y0 + j·dy). */
  const pass = (w: number, h: number, x0: number, y0: number, dx: number, dy: number): void => {
    if (!w || !h) return;
    const stride = Math.ceil((w * channels * depth) / 8);
    let prev = new Uint8Array(stride);
    for (let j = 0; j < h; j++) {
      const filter = raw[pos++];
      const line = raw.slice(pos, pos + stride);
      pos += stride;
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? line[i - bpp] : 0;
        const b = prev[i];
        const c = i >= bpp ? prev[i - bpp] : 0;
        let v = line[i];
        if (filter === 1) v += a;
        else if (filter === 2) v += b;
        else if (filter === 3) v += (a + b) >> 1;
        else if (filter === 4) {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        } else if (filter !== 0) fail(`filter ${filter}`);
        line[i] = v & 255;
      }
      prev = line;
      const sample = (i: number, ch: number): number => {
        if (depth === 8) return line[i * channels + ch];
        if (depth === 16) return line[(i * channels + ch) * 2];
        const bit = (i * channels + ch) * depth;
        return (line[bit >> 3] >> (8 - depth - (bit & 7))) & max;
      };
      const scale = (v: number): number => (depth >= 8 ? v : Math.round((v * 255) / max));
      for (let i = 0; i < w; i++) {
        const q = ((y0 + j * dy) * width + (x0 + i * dx)) * 4;
        if (type === 3) {
          const k = sample(i, 0);
          out[q] = palette![k * 3];
          out[q + 1] = palette![k * 3 + 1];
          out[q + 2] = palette![k * 3 + 2];
          out[q + 3] = trns && k < trns.length ? trns[k] : 255;
        } else if (type === 0 || type === 4) {
          const g = scale(sample(i, 0));
          out[q] = out[q + 1] = out[q + 2] = g;
          out[q + 3] = type === 4 ? scale(sample(i, 1)) : 255;
          // tRNS of a grey image: the one transparent grey level (16-bit — compared by its high byte)
          if (type === 0 && trns && trns.length >= 2 && sample(i, 0) === (depth === 16 ? trns[0] : (trns[0] << 8) | trns[1])) out[q + 3] = 0;
        } else {
          out[q] = sample(i, 0);
          out[q + 1] = sample(i, 1);
          out[q + 2] = sample(i, 2);
          out[q + 3] = type === 6 ? sample(i, 3) : 255;
        }
      }
    }
  };
  if (interlace) {
    const ADAM = [
      [0, 0, 8, 8],
      [4, 0, 8, 8],
      [0, 4, 4, 8],
      [2, 0, 4, 4],
      [0, 2, 2, 4],
      [1, 0, 2, 2],
      [0, 1, 1, 2],
    ];
    for (const [x0, y0, dx, dy] of ADAM) pass(Math.ceil((width - x0) / dx), Math.ceil((height - y0) / dy), x0, y0, dx, dy);
  } else pass(width, height, 0, 0, 1, 1);
  return { width, height, data: out };
}

/** A w × h window of an image at (x, y). */
export function crop(img: Rgba8, x: number, y: number, w: number, h: number): Rgba8 {
  const data = new Uint8Array(w * h * 4);
  for (let j = 0; j < h; j++) {
    const sy = y + j;
    if (sy < 0 || sy >= img.height) continue;
    for (let i = 0; i < w; i++) {
      const sx = x + i;
      if (sx < 0 || sx >= img.width) continue;
      data.set(img.data.subarray((sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4), (j * w + i) * 4);
    }
  }
  return { width: w, height: h, data };
}

/** Turn clockwise by 90 / 180 / 270 degrees. */
export function rotateCw(img: Rgba8, degrees: number): Rgba8 {
  const turns = (((Math.round(degrees / 90) % 4) + 4) % 4);
  let cur = img;
  for (let k = 0; k < turns; k++) {
    const { width: w, height: h, data } = cur;
    const out = new Uint8Array(w * h * 4);
    // (x, y) → (h − 1 − y, x) in a h × w image
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) out.set(data.subarray((y * w + x) * 4, (y * w + x) * 4 + 4), (x * h + (h - 1 - y)) * 4);
    cur = { width: h, height: w, data: out };
  }
  return cur;
}

/** Transparent margins around an image. */
export function extend(img: Rgba8, top: number, right: number, bottom: number, left: number): Rgba8 {
  const w = img.width + left + right;
  const h = img.height + top + bottom;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < img.height; y++) data.set(img.data.subarray(y * img.width * 4, (y + 1) * img.width * 4), ((y + top) * w + left) * 4);
  return { width: w, height: h, data };
}

/** Straight alpha from premultiplied. */
export function unpremultiply(img: Rgba8): Rgba8 {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    if (a === 0 || a === 255) continue;
    for (let c = 0; c < 3; c++) d[i + c] = Math.min(255, Math.round((d[i + c] * 255) / a));
  }
  return img;
}

export interface CutResult {
  written: string[];
  missing: string[];
}

/** Write `<outDir>/<region>.png` for every needed region; regions absent from the atlas are listed. */
export function cutRegions(atlas: Atlas, atlasDir: string, needed: Iterable<string>, outDir: string): CutResult {
  const index = regionIndex(atlas);
  const pages = new Map<string, Rgba8>();
  const res: CutResult = { written: [], missing: [] };
  for (const name of [...new Set(needed)].sort()) {
    const r = index.get(name);
    if (!r) {
      res.missing.push(name);
      continue;
    }
    let page = pages.get(r.page.file);
    if (!page) {
      const file = join(atlasDir, r.page.file);
      if (!existsSync(file)) throw new Error(`E_SPINE_IMPORT_ART: atlas page ${file} not found`);
      page = decodePng(new Uint8Array(readFileSync(file)), r.page.file);
      pages.set(r.page.file, page);
    }
    const turned = r.degrees === 90 || r.degrees === 270;
    let img = crop(page, r.x, r.y, turned ? r.h : r.w, turned ? r.w : r.h);
    if (r.degrees) img = rotateCw(img, r.degrees);
    const top = Math.max(0, r.origH - r.h - r.offY);
    const right = Math.max(0, r.origW - r.w - r.offX);
    if (top || right || r.offX || r.offY) img = extend(img, top, right, Math.max(0, r.offY), Math.max(0, r.offX));
    if (r.page.pma) img = unpremultiply(img);
    const out = join(outDir, `${name}.png`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, encodePng(img.width, img.height, img.data));
    res.written.push(out);
  }
  return res;
}
