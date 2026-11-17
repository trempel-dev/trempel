import { describe, expect, it } from 'vitest'
import { planCrop } from '../src/geometry.js'
import { fillRect } from '../src/mask.js'
import { applyPatch, createMask, createRaster, cropScaled, extractPatch, featherMask, maskScaled, pasteBack, patchBounds, resizeRaster } from '../src/raster.js'
import type { MaskData, Raster } from '../src/types.js'

/** Every pixel different (including alpha), deterministic. */
function noise(w: number, h: number, opaque = false): Raster {
  const r = createRaster(w, h)
  let s = 12345
  const next = (): number => ((s = (s * 1103515245 + 12345) >>> 0) >>> 16) & 255
  for (let i = 0; i < r.data.length; i += 4) {
    r.data[i] = next()
    r.data[i + 1] = next()
    r.data[i + 2] = next()
    r.data[i + 3] = opaque ? 255 : next()
  }
  return r
}

function solid(w: number, h: number, rgba: [number, number, number, number]): Raster {
  const r = createRaster(w, h)
  for (let i = 0; i < r.data.length; i += 4) r.data.set(rgba, i)
  return r
}

function outsideEqual(a: Raster, b: Raster, mask: MaskData): void {
  for (let i = 0; i < mask.data.length; i += 1) {
    if (mask.data[i] !== 0) continue
    for (let c = 0; c < 4; c += 1) if (a.data[i * 4 + c] !== b.data[i * 4 + c]) throw new Error(`pixel ${i % mask.width},${Math.floor(i / mask.width)} changed outside the mask`)
  }
}

describe('pasteBack', () => {
  const base = noise(300, 200)
  const mask = createMask(300, 200)
  fillRect(mask, { x: 120, y: 60, w: 50, h: 40 }, 'add')
  const plan = planCrop({ x: 120, y: 60, w: 50, h: 40 }, 16, { width: 300, height: 200 }, 512, 8)
  const result = solid(plan.workW, plan.workH, [255, 0, 255, 255])

  it('outside the mask — byte for byte, with feather and colour match', () => {
    for (const opts of [{}, { feather: 8 }, { feather: 8, colorMatch: true }, { alpha: 'result' as const }]) {
      const out = pasteBack(base, result, mask, plan, opts)
      outsideEqual(out, base, mask)
      expect(out.data.length).toBe(base.data.length)
    }
  })

  it("alpha 'keep' — the source alpha exactly, everywhere", () => {
    const out = pasteBack(base, result, mask, plan, { alpha: 'keep', feather: 4 })
    for (let i = 3; i < base.data.length; i += 4) expect(out.data[i]).toBe(base.data[i])
    // and the masked area did change colour
    const inside = (80 * 300 + 145) * 4
    if (base.data[inside + 3] !== 0) expect([out.data[inside], out.data[inside + 1], out.data[inside + 2]]).not.toEqual([base.data[inside], base.data[inside + 1], base.data[inside + 2]])
  })

  it("alpha 'keep' leaves fully transparent source pixels untouched", () => {
    const sprite = solid(64, 64, [10, 20, 30, 0])
    for (let y = 16; y < 48; y += 1) for (let x = 16; x < 48; x += 1) sprite.data.set([200, 150, 100, 255], (y * 64 + x) * 4)
    const m = createMask(64, 64)
    fillRect(m, { x: 0, y: 0, w: 64, h: 64 }, 'add')
    const p = planCrop({ x: 0, y: 0, w: 64, h: 64 }, 0, { width: 64, height: 64 }, 512, 8)
    const out = pasteBack(sprite, solid(p.workW, p.workH, [0, 255, 0, 255]), m, p, { alpha: 'keep' })
    expect([...out.data.subarray(0, 4)]).toEqual([10, 20, 30, 0])
    expect([...out.data.subarray((32 * 64 + 32) * 4, (32 * 64 + 32) * 4 + 4)]).toEqual([0, 255, 0, 255])
  })

  it('default alpha: keep for transparent sources, result for opaque', () => {
    const opaque = noise(300, 200, true)
    const transparentResult = solid(plan.workW, plan.workH, [0, 0, 0, 0])
    const out = pasteBack(opaque, transparentResult, mask, plan)
    expect(out.data[(80 * 300 + 145) * 4 + 3]).toBe(0)
    const kept = pasteBack(base, transparentResult, mask, plan)
    expect(kept.data[(80 * 300 + 145) * 4 + 3]).toBe(base.data[(80 * 300 + 145) * 4 + 3])
  })

  it('feather stays inside the mask and softens its edge', () => {
    const f = featherMask(mask, 8)
    for (let i = 0; i < mask.data.length; i += 1) expect(f.data[i]! <= mask.data[i]!).toBe(true)
    expect(f.data[80 * 300 + 120]).toBeLessThan(128) // edge pixel
    expect(f.data[80 * 300 + 145]).toBe(255) // centre
  })
})

describe('crop in / patch out', () => {
  it('cropScaled flattens transparency onto the backdrop, maskScaled is white on black', () => {
    const img = solid(64, 64, [255, 0, 0, 0])
    const m = createMask(64, 64)
    fillRect(m, { x: 16, y: 16, w: 32, h: 32 }, 'add')
    const p = planCrop({ x: 16, y: 16, w: 32, h: 32 }, 0, { width: 64, height: 64 }, 256, 8)
    const c = cropScaled(img, p, { background: '#102030' })
    expect(c.width).toBe(p.workW)
    expect([...c.data.subarray(0, 4)]).toEqual([16, 32, 48, 255])
    const ms = maskScaled(m, p)
    expect(ms.width).toBe(p.workW)
    expect([...ms.data.subarray(0, 4)]).toEqual([255, 255, 255, 255])
  })

  it('resize keeps size and averages when shrinking', () => {
    const r = resizeRaster(solid(100, 50, [10, 200, 30, 255]), 37, 11)
    expect(r.width).toBe(37)
    expect(r.height).toBe(11)
    expect([...r.data.subarray(0, 4)]).toEqual([10, 200, 30, 255])
  })

  it('patch round trip: extract → apply restores the edited image', () => {
    const base = noise(80, 60)
    const edited = noise(80, 60, true)
    const m = createMask(80, 60)
    fillRect(m, { x: 10, y: 12, w: 20, h: 9 }, 'add')
    const plan = planCrop({ x: 10, y: 12, w: 20, h: 9 }, 4, { width: 80, height: 60 }, 128, 8)
    const box = patchBounds(m, plan)!
    expect(box).toEqual({ x: 10, y: 12, w: 20, h: 9 })
    const back = applyPatch(base, extractPatch(edited, box), box)
    for (let y = 0; y < 60; y += 1)
      for (let x = 0; x < 80; x += 1) {
        const i = (y * 80 + x) * 4
        const src = x >= 10 && x < 30 && y >= 12 && y < 21 ? edited : base
        expect(back.data[i]).toBe(src.data[i])
      }
  })
})
