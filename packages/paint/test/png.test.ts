import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { encodePng, pngSize } from '../src/png.js'
import { createRaster } from '../src/raster.js'

describe('encodePng', () => {
  it('writes exact RGBA (semi-transparent colour survives)', async () => {
    const r = createRaster(3, 2)
    r.data.set([1, 2, 3, 4, 250, 128, 7, 1, 0, 0, 0, 0, 9, 8, 7, 255, 33, 44, 55, 66, 77, 88, 99, 128])
    const png = await encodePng(r)
    expect(pngSize(png)).toEqual({ width: 3, height: 2 })
    // IDAT → raw scanlines
    const view = new DataView(png.buffer, png.byteOffset)
    let at = 8
    let idat: Uint8Array | null = null
    while (at < png.length) {
      const len = view.getUint32(at)
      const type = String.fromCharCode(...png.subarray(at + 4, at + 8))
      if (type === 'IDAT') idat = png.subarray(at + 8, at + 8 + len)
      at += 12 + len
    }
    const raw = inflateSync(idat!)
    const rows = [...raw.subarray(1, 13), ...raw.subarray(14, 26)]
    expect(rows).toEqual([...r.data])
  })
})
