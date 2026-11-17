// node/imagesize.ts — pixel size of a picture from its header (PNG, JPEG, GIF, WebP, SVG): what
// flatten needs for 9-slice pieces, tiles and images without width/height. No dependencies.

import { readFileSync } from 'node:fs';

export interface PixelSize {
  w: number;
  h: number;
}

/** Size of a picture's bytes, or null when the format is not known / the header is broken. */
export function imageSizeOf(buf: Buffer): PixelSize | null {
  // PNG: signature, IHDR width / height (big-endian).
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString('ascii', 12, 16) === 'IHDR') {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  // GIF: logical screen size (little-endian).
  if (buf.length >= 10 && buf.toString('ascii', 0, 3) === 'GIF') return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  // JPEG: the first SOFn segment.
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
      }
      i += 2 + len;
    }
    return null;
  }
  // WebP: VP8 / VP8L / VP8X.
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const kind = buf.toString('ascii', 12, 16);
    if (kind === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
    }
    if (kind === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
    return null;
  }
  // SVG: width / height of the root, else its viewBox.
  const head = buf.toString('utf8', 0, Math.min(buf.length, 4096));
  const root = /<svg\b[^>]*>/i.exec(head)?.[0];
  if (root) {
    const attr = (k: string): string | undefined => new RegExp(`\\s${k}\\s*=\\s*["']([^"']*)["']`).exec(root)?.[1];
    const num = (v: string | undefined): number | null => (v != null && /^\s*[\d.]+(px)?\s*$/.test(v) ? parseFloat(v) : null);
    const w = num(attr('width'));
    const h = num(attr('height'));
    if (w && h) return { w, h };
    const vb = attr('viewBox')?.trim().split(/[\s,]+/).map(Number);
    if (vb && vb.length === 4 && vb[2] > 0 && vb[3] > 0) return { w: vb[2], h: vb[3] };
  }
  return null;
}

/** Size of a picture file, or null (missing, unknown format). */
export function imageSize(file: string): PixelSize | null {
  try {
    return imageSizeOf(readFileSync(file));
  } catch {
    return null;
  }
}

/** MIME type by extension (for data: URIs). */
export function mimeOf(file: string): string {
  const ext = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(file)?.[1]?.toLowerCase() ?? '';
  return (
    { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml' }[ext] ??
    'application/octet-stream'
  );
}
