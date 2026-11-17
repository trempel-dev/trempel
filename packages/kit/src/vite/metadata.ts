// metadata.ts — release builds ship images without metadata. Generators write their provenance
// into the files: ComfyUI puts the whole workflow and the prompt into PNG tEXt chunks, cameras and
// editors write EXIF / XMP, C2PA signs with manifests (PNG caBX, JPEG APP11 JUMBF, WebP C2PA).
// None of it is the players' business: the provenance stays in the game's private sources.
//
// cleanAssets(dist) rewrites every raster of a built dist in place WITHOUT re-encoding — the
// metadata containers are dropped, the coded image data is copied byte for byte, so the decoded
// pixels are bit-identical:
//   PNG  — every chunk except the image and colour ones (IHDR PLTE IDAT IEND tRNS, gAMA cHRM sRGB
//          iCCP sBIT cICP mDCv cLLi, bKGD pHYs, APNG acTL fcTL fdAT): tEXt iTXt zTXt eXIf tIME caBX…;
//   JPEG — APP1 (EXIF, XMP), APP2 except ICC_PROFILE, APP3–APP13, APP15 (IPTC, C2PA JUMBF…) and COM;
//          APP0 (JFIF) and APP14 (Adobe colour transform) stay;
//   WebP — EXIF, XMP and every unknown chunk (C2PA); the VP8X flags follow.
// An EXIF orientation other than 1 is NOT dropped (the image would turn): that is a gate failure —
// rotate the source pixels. Other rasters (GIF, AVIF) are not rewritten, only checked.
//
// scanMetadata(dist) is the gate: metadata left in any raster, or a generation sidecar
// (`*.png.json`…, any `*.json` with a top-level `prompt` / `workflow` key) — E_ASSET_METADATA.

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface Stripped {
  data: Uint8Array;
  /** What was dropped: chunk / segment names ('tEXt', 'APP1 Exif', 'XMP '…), in file order. */
  removed: string[];
  /** EXIF orientation found (1 = none / upright). */
  orientation: number;
}

export interface MetadataHit {
  file: string;
  what: string;
}

export interface CleanedFile {
  file: string;
  before: number;
  after: number;
  removed: string[];
}

export interface CleanResult {
  /** Files rewritten (something was dropped). */
  cleaned: CleanedFile[];
  /** Rasters looked at. */
  rasters: number;
  bytesBefore: number;
  bytesAfter: number;
}

export const METADATA_CODE = 'E_ASSET_METADATA';
const RASTER = /\.(png|apng|jpe?g|jfif|webp|gif|avif|heic|tiff?)$/i;
const STRIPPABLE = /\.(png|apng|jpe?g|jfif|webp)$/i;
const SIDECAR = /\.(png|apng|jpe?g|jfif|webp|gif|avif|heic|tiff?)\.json$/i;

const ascii = (b: Uint8Array, at: number, n: number): string => String.fromCharCode(...b.subarray(at, at + n));
const u32be = (b: Uint8Array, at: number): number => ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3];
const u32le = (b: Uint8Array, at: number): number => b[at] + (b[at + 1] << 8) + (b[at + 2] << 16) + ((b[at + 3] << 24) >>> 0);
const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** Orientation tag (0x0112) of a TIFF-structured EXIF block (starting at "II"/"MM"); 1 when absent. */
export function exifOrientation(tiff: Uint8Array): number {
  if (tiff.length < 8) return 1;
  const le = tiff[0] === 0x49 && tiff[1] === 0x49;
  if (!le && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) return 1;
  const u16 = (at: number) => (le ? tiff[at] + (tiff[at + 1] << 8) : (tiff[at] << 8) + tiff[at + 1]);
  const u32 = (at: number) => (le ? u32le(tiff, at) : u32be(tiff, at));
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return 1;
  const n = u16(ifd);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > tiff.length) break;
    if (u16(e) === 0x0112) return u16(e + 8) || 1;
  }
  return 1;
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'cICP', 'mDCv', 'cLLi', 'bKGD', 'pHYs', 'acTL', 'fcTL', 'fdAT']);

export const isPng = (b: Uint8Array): boolean => b.length >= 8 && PNG_SIG.every((v, i) => b[i] === v);

/** PNG without metadata chunks: the kept chunks are copied byte for byte (CRCs included). */
export function stripPng(b: Uint8Array): Stripped {
  if (!isPng(b)) throw new Error(`${METADATA_CODE}: not a PNG`);
  const parts: Uint8Array[] = [b.subarray(0, 8)];
  const removed: string[] = [];
  let orientation = 1;
  let at = 8;
  while (at + 12 <= b.length) {
    const len = u32be(b, at);
    const type = ascii(b, at + 4, 4);
    const end = at + 12 + len;
    if (end > b.length) throw new Error(`${METADATA_CODE}: truncated PNG chunk ${type}`);
    if (PNG_KEEP.has(type)) parts.push(b.subarray(at, end));
    else {
      removed.push(type);
      if (type === 'eXIf') orientation = exifOrientation(b.subarray(at + 8, at + 8 + len));
    }
    at = end;
    if (type === 'IEND') break;
  }
  if (at < b.length) removed.push('trailing data');
  return { data: removed.length ? concat(parts) : b, removed, orientation };
}

export const isJpeg = (b: Uint8Array): boolean => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

/** JPEG without metadata segments: the header segments that stay and the entropy-coded data are copied as is. */
export function stripJpeg(b: Uint8Array): Stripped {
  if (!isJpeg(b)) throw new Error(`${METADATA_CODE}: not a JPEG`);
  const parts: Uint8Array[] = [b.subarray(0, 2)];
  const removed: string[] = [];
  let orientation = 1;
  let at = 2;
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) throw new Error(`${METADATA_CODE}: bad JPEG marker at ${at}`);
    const marker = b[at + 1];
    if (marker === 0xff) {
      at++; // fill byte
      continue;
    }
    if (marker === 0xda) break; // SOS: the scan data and everything after it stay
    const len = (b[at + 2] << 8) + b[at + 3];
    const end = at + 2 + len;
    const body = b.subarray(at + 4, end);
    const app = marker >= 0xe0 && marker <= 0xef ? marker - 0xe0 : -1;
    let drop: string | null = null;
    if (marker === 0xfe) drop = 'COM';
    else if (app === 1) {
      const exif = ascii(body, 0, 6) === 'Exif\0\0';
      if (exif) orientation = exifOrientation(body.subarray(6));
      drop = exif ? 'APP1 Exif' : ascii(body, 0, 28).startsWith('http://ns.adobe.com/xap') ? 'APP1 XMP' : 'APP1';
    } else if (app === 2) drop = ascii(body, 0, 12) === 'ICC_PROFILE\0' ? null : 'APP2';
    else if (app >= 3 && app !== 14) drop = app === 11 ? 'APP11 JUMBF' : app === 13 ? 'APP13 IPTC' : `APP${app}`;
    if (drop) removed.push(drop);
    else parts.push(b.subarray(at, end));
    at = end;
  }
  parts.push(b.subarray(at));
  return { data: removed.length ? concat(parts) : b, removed, orientation };
}

export const isWebp = (b: Uint8Array): boolean => b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP';
const WEBP_KEEP = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF', 'ICCP']);

/** WebP without EXIF / XMP / unknown chunks (C2PA); the VP8X flags and the RIFF size follow. */
export function stripWebp(b: Uint8Array): Stripped {
  if (!isWebp(b)) throw new Error(`${METADATA_CODE}: not a WebP`);
  const parts: Uint8Array[] = [];
  const removed: string[] = [];
  let orientation = 1;
  let vp8x: Uint8Array | null = null;
  let at = 12;
  while (at + 8 <= b.length) {
    const type = ascii(b, at, 4);
    const len = u32le(b, at + 4);
    const end = Math.min(b.length, at + 8 + len + (len & 1));
    if (WEBP_KEEP.has(type)) {
      const chunk = b.slice(at, end);
      if (type === 'VP8X') vp8x = chunk;
      parts.push(chunk);
    } else {
      removed.push(type);
      if (type === 'EXIF') {
        const body = b.subarray(at + 8, at + 8 + len);
        orientation = exifOrientation(ascii(body, 0, 6) === 'Exif\0\0' ? body.subarray(6) : body);
      }
    }
    at = end;
  }
  if (!removed.length) return { data: b, removed, orientation };
  // VP8X flags: bit 3 EXIF, bit 2 XMP.
  if (vp8x) vp8x[8] &= ~(0x08 | 0x04);
  const body = concat(parts);
  const head = new Uint8Array(12);
  head.set(b.subarray(0, 12));
  const size = body.length + 4;
  head.set([size & 0xff, (size >> 8) & 0xff, (size >> 16) & 0xff, (size >>> 24) & 0xff], 4);
  return { data: concat([head, body]), removed, orientation };
}

/** Strip by content (not by extension); null for formats the kit does not rewrite. */
export function stripImage(b: Uint8Array): Stripped | null {
  if (isPng(b)) return stripPng(b);
  if (isJpeg(b)) return stripJpeg(b);
  if (isWebp(b)) return stripWebp(b);
  return null;
}

/** Byte markers of metadata in rasters the kit does not rewrite (GIF comments / XMP, AVIF Exif / XMP / C2PA). */
const MARKERS: { what: string; bytes: Uint8Array }[] = [
  ['Exif', 'Exif\0\0'],
  ['XMP', '<x:xmpmeta'],
  ['XMP', 'http://ns.adobe.com/xap/'],
  ['C2PA', 'c2pa'],
  ['JUMBF', 'jumb'],
  ['ComfyUI workflow', '"workflow"'],
  ['prompt', '"prompt"'],
].map(([what, s]) => ({ what, bytes: new TextEncoder().encode(s) }));

function indexOf(hay: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

function walk(dir: string, root = dir, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, root, out);
    else out.push(relative(root, p).split('\\').join('/'));
  }
  return out;
}

/** Rewrite every PNG / JPEG / WebP of `dist` without metadata (in place; nothing re-encoded). */
export function cleanAssets(dist: string): CleanResult {
  const res: CleanResult = { cleaned: [], rasters: 0, bytesBefore: 0, bytesAfter: 0 };
  for (const file of walk(dist)) {
    if (!RASTER.test(file)) continue;
    res.rasters++;
    const p = join(dist, file);
    const b = new Uint8Array(readFileSync(p));
    res.bytesBefore += b.length;
    let s: Stripped | null = null;
    try {
      s = STRIPPABLE.test(file) || isPng(b) || isJpeg(b) || isWebp(b) ? stripImage(b) : null;
    } catch {
      s = null; // malformed: left as is, the gate reports what it finds
    }
    // An orientation the browser would apply stays (dropping it would turn the image): the gate fails on it.
    if (s && s.removed.length && s.orientation === 1) {
      writeFileSync(p, s.data);
      res.cleaned.push({ file, before: b.length, after: s.data.length, removed: s.removed });
      res.bytesAfter += s.data.length;
    } else res.bytesAfter += b.length;
  }
  return res;
}

/** The gate: metadata left in rasters of `dist`, generation sidecars. */
export function scanMetadata(dist: string): MetadataHit[] {
  const hits: MetadataHit[] = [];
  for (const file of walk(dist)) {
    const p = join(dist, file);
    if (SIDECAR.test(file)) {
      hits.push({ file, what: 'generation sidecar' });
      continue;
    }
    if (/\.json$/i.test(file)) {
      let j: unknown;
      try {
        j = JSON.parse(readFileSync(p, 'utf8'));
      } catch {
        continue;
      }
      if (j && typeof j === 'object' && !Array.isArray(j)) {
        const keys = ['prompt', 'workflow'].filter((k) => k in (j as object));
        if (keys.length) hits.push({ file, what: `generation data (${keys.join(', ')})` });
      }
      continue;
    }
    if (!RASTER.test(file)) continue;
    const b = new Uint8Array(readFileSync(p));
    let s: Stripped | null = null;
    try {
      s = stripImage(b);
    } catch (e) {
      hits.push({ file, what: `unreadable (${(e as Error).message})` });
      continue;
    }
    if (s) {
      if (s.orientation !== 1) hits.push({ file, what: `EXIF orientation ${s.orientation} — rotate the source pixels, the bundle cannot drop it without turning the image` });
      else if (s.removed.length) hits.push({ file, what: s.removed.join(', ') });
      continue;
    }
    const found = [...new Set(MARKERS.filter((m) => indexOf(b, m.bytes) !== -1).map((m) => m.what))];
    if (found.length) hits.push({ file, what: found.join(', ') });
  }
  return hits;
}

/** The gate's error message: the code first, then every file. */
export function metadataError(hits: MetadataHit[]): string {
  return `${METADATA_CODE}: generation metadata in the bundle (${hits.length} file${hits.length === 1 ? '' : 's'}) — provenance stays in the private sources:\n${hits.map((h) => `  ✗ ${h.file}: ${h.what}`).join('\n')}`;
}
