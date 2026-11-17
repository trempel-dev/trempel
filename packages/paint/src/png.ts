/**
 * PNG in and out without a canvas round trip on the way out.
 *
 * Encoding is our own (RGBA, filter 0, zlib via `CompressionStream`): canvas
 * `toBlob` premultiplies and can shift the colour of semi-transparent pixels;
 * this writes the bytes exactly. Decoding uses the platform decoder
 * (`createImageBitmap` + a 2D canvas) — PNG, JPEG, WebP alike.
 */

import type { Raster } from './types.js'

let CRC_TABLE: Uint32Array | null = null

function crc32(bytes: Uint8Array): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256)
    for (let n = 0; n < 256; n += 1) {
      let c = n
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      CRC_TABLE[n] = c >>> 0
    }
  }
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

async function deflate(raw: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([raw as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** RGBA raster → PNG bytes (exact). */
export async function encodePng(r: Raster): Promise<Uint8Array> {
  const row = r.width * 4 + 1
  const raw = new Uint8Array(row * r.height)
  for (let y = 0; y < r.height; y += 1) raw.set(r.data.subarray(y * r.width * 4, (y + 1) * r.width * 4), y * row + 1)
  const ihdr = new Uint8Array(13)
  const v = new DataView(ihdr.buffer)
  v.setUint32(0, r.width)
  v.setUint32(4, r.height)
  ihdr[8] = 8
  ihdr[9] = 6
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', await deflate(raw)), chunk('IEND', new Uint8Array(0))]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

export async function rasterToBlob(r: Raster): Promise<Blob> {
  return new Blob([(await encodePng(r)) as BlobPart], { type: 'image/png' })
}

/** Width/height from a PNG header, without decoding; `null` if not a PNG. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: v.getUint32(16), height: v.getUint32(20) }
}

/** Decode any browser-supported image to straight-alpha RGBA. Browser only. */
export async function blobToRaster(blob: Blob): Promise<Raster> {
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
  try {
    const canvas = makeCanvas(bmp.width, bmp.height)
    const g = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
    if (!g) throw new Error('paint: no 2D canvas')
    g.drawImage(bmp, 0, 0)
    const img = g.getImageData(0, 0, bmp.width, bmp.height)
    return { width: img.width, height: img.height, data: img.data }
  } finally {
    bmp.close()
  }
}

export function makeCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas')
    c.width = width
    c.height = height
    return c
  }
  return new OffscreenCanvas(width, height)
}
