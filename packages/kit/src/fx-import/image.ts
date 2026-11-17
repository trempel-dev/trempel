// image.ts — textures of the converted effects as PNG without metadata: a PNG is copied with its
// metadata chunks dropped (no re-encoding: the kit's stripPng, the same as the builds' gate); a TGA
// (uncompressed or RLE, 24 / 32 bit, Cartoon FX ships some) is decoded and encoded as a plain RGBA PNG.

import { deflateSync } from 'node:zlib';
import { isPng, stripPng } from '../vite/metadata.js';

/** PNG bytes of a texture file, or null with the reason (a format the converter does not read). */
export function texturePng(bytes: Uint8Array, name: string): { png: Uint8Array } | { error: string } {
  if (isPng(bytes)) {
    const s = stripPng(bytes);
    return { png: s.data };
  }
  if (/\.tga$/i.test(name)) {
    try {
      const img = decodeTga(bytes);
      return { png: encodePng(img.width, img.height, img.rgba) };
    } catch (e) {
      return { error: `TGA: ${(e as Error).message}` };
    }
  }
  return { error: `${name.split('.').pop()?.toUpperCase() ?? '?'} textures are not converted (PNG and TGA are)` };
}

/** A TGA (types 2 / 10 — truecolour, raw / RLE; 24 or 32 bit) → RGBA, top row first. */
export function decodeTga(b: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  const idLen = b[0];
  const cmapType = b[1];
  const type = b[2];
  if (cmapType !== 0 || (type !== 2 && type !== 10)) throw new Error(`type ${type} (only truecolour 2 / 10)`);
  const cmapLen = b[5] | (b[6] << 8);
  const cmapDepth = b[7];
  const width = b[12] | (b[13] << 8);
  const height = b[14] | (b[15] << 8);
  const depth = b[16];
  const desc = b[17];
  if (depth !== 24 && depth !== 32) throw new Error(`${depth}-bit pixels`);
  const px = depth / 8;
  let at = 18 + idLen + cmapLen * Math.ceil(cmapDepth / 8);
  const n = width * height;
  const raw = new Uint8Array(n * 4);
  const put = (i: number, o: number) => {
    raw[i * 4] = b[o + 2];
    raw[i * 4 + 1] = b[o + 1];
    raw[i * 4 + 2] = b[o];
    raw[i * 4 + 3] = px === 4 ? b[o + 3] : 255;
  };
  if (type === 2) {
    if (at + n * px > b.length) throw new Error('truncated');
    for (let i = 0; i < n; i++) put(i, at + i * px);
  } else {
    let i = 0;
    while (i < n) {
      if (at >= b.length) throw new Error('truncated');
      const h = b[at++];
      const count = (h & 0x7f) + 1;
      if (h & 0x80) {
        for (let k = 0; k < count && i < n; k++) put(i++, at);
        at += px;
      } else {
        for (let k = 0; k < count && i < n; k++, at += px) put(i++, at);
      }
    }
  }
  // Origin: bit 5 of the descriptor — top-left; else bottom-left (flip the rows).
  const topLeft = (desc & 0x20) !== 0;
  const rightLeft = (desc & 0x10) !== 0;
  if (topLeft && !rightLeft) return { width, height, rgba: raw };
  const out = new Uint8Array(n * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const sy = topLeft ? y : height - 1 - y;
      const sx = rightLeft ? width - 1 - x : x;
      out.set(raw.subarray((sy * width + sx) * 4, (sy * width + sx) * 4 + 4), (y * width + x) * 4);
    }
  return { width, height, rgba: out };
}

/** A plain RGBA PNG (IHDR, IDAT, IEND — nothing else). */
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const rows = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    rows[y * (width * 4 + 1)] = 0;
    rows.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', new Uint8Array(deflateSync(rows))), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

let table: Uint32Array | null = null;
function crc32(b: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = table[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
