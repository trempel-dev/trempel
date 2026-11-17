import { describe, expect, it } from 'vitest'
import { MaskHistory, clearMask, fillPolygon, fillRect, invertMask, stroke } from '../src/mask.js'
import { maskBBox } from '../src/geometry.js'
import { createMask } from '../src/raster.js'

describe('mask tools', () => {
  it('brush stroke covers the segment, eraser removes', () => {
    const m = createMask(100, 100)
    stroke(m, 10, 50, 90, 50, 5, 1, 'add')
    expect(m.data[50 * 100 + 50]).toBe(255)
    expect(m.data[10 * 100 + 50]).toBe(0)
    stroke(m, 50, 40, 50, 60, 6, 1, 'subtract')
    expect(m.data[50 * 100 + 50]).toBe(0)
    expect(m.data[50 * 100 + 20]).toBe(255)
  })

  it('soft brush falls off', () => {
    const m = createMask(50, 50)
    stroke(m, 25, 25, 25, 25, 10, 0, 'add')
    expect(m.data[25 * 50 + 25]).toBeGreaterThan(200)
    expect(m.data[25 * 50 + 33]).toBeLessThan(100)
  })

  it('polygon, rect, invert, clear', () => {
    const m = createMask(40, 40)
    fillPolygon(m, [{ x: 5, y: 5 }, { x: 35, y: 5 }, { x: 5, y: 35 }], 'add')
    expect(m.data[8 * 40 + 8]).toBe(255)
    expect(m.data[33 * 40 + 33]).toBe(0)
    clearMask(m)
    fillRect(m, { x: 2, y: 3, w: 4, h: 5 }, 'add')
    expect(maskBBox(m)).toEqual({ x: 2, y: 3, w: 4, h: 5 })
    invertMask(m)
    expect(m.data[3 * 40 + 2]).toBe(0)
    expect(m.data[0]).toBe(255)
  })

  it('history stores only the changed rectangle and round-trips', () => {
    const m = createMask(64, 64)
    const h = new MaskHistory(m)
    h.begin()
    const r1 = fillRect(m, { x: 10, y: 10, w: 5, h: 5 }, 'add')
    h.commit(r1)
    h.begin()
    const r2 = stroke(m, 30, 30, 40, 40, 3, 1, 'add')
    h.commit(r2)
    const after = new Uint8Array(m.data)
    expect(h.undo()).toEqual(r2)
    expect(m.data[35 * 64 + 35]).toBe(0)
    expect(m.data[12 * 64 + 12]).toBe(255)
    h.undo()
    expect(m.data.every((v) => v === 0)).toBe(true)
    expect(h.canUndo).toBe(false)
    h.redo()
    h.redo()
    expect(m.data).toEqual(after)
    // a no-op change is not recorded
    h.begin()
    h.commit({ x: 0, y: 0, w: 4, h: 4 })
    h.undo()
    expect(m.data[35 * 64 + 35]).toBe(0)
  })
})
