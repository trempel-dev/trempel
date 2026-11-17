import { describe, expect, it } from 'vitest'
import { maskBBox, planCrop, planRegion, roundTo } from '../src/geometry.js'
import { createMask } from '../src/raster.js'

const IMG = { width: 3000, height: 2000 }

function check(plan: ReturnType<typeof planCrop>, size: { width: number; height: number }, multiple: number): void {
  expect(plan.x).toBeGreaterThanOrEqual(0)
  expect(plan.y).toBeGreaterThanOrEqual(0)
  expect(plan.x + plan.w).toBeLessThanOrEqual(size.width)
  expect(plan.y + plan.h).toBeLessThanOrEqual(size.height)
  expect(Number.isInteger(plan.x) && Number.isInteger(plan.y) && Number.isInteger(plan.w) && Number.isInteger(plan.h)).toBe(true)
  expect(plan.workW % multiple).toBe(0)
  expect(plan.workH % multiple).toBe(0)
}

describe('planCrop', () => {
  it('scales a small region up to the target, multiples of 8, uniform scale', () => {
    const plan = planCrop({ x: 1400, y: 900, w: 200, h: 150 }, 32, IMG, 1024, 8)
    check(plan, IMG, 8)
    expect(Math.max(plan.workW, plan.workH)).toBe(1024)
    // region (with padding) is inside the crop
    expect(plan.x).toBeLessThanOrEqual(1400 - 32)
    expect(plan.y).toBeLessThanOrEqual(900 - 32)
    expect(plan.x + plan.w).toBeGreaterThanOrEqual(1600 + 32)
    expect(plan.y + plan.h).toBeGreaterThanOrEqual(1050 + 32)
    // aspect of the crop matches the working size (uniform scale, ±1 px rounding)
    expect(Math.abs(plan.w / plan.h - plan.workW / plan.workH)).toBeLessThan(0.01)
    expect(plan.scale).toBeGreaterThan(3)
  })

  it('stays inside the image at the edge (corner mask)', () => {
    const plan = planCrop({ x: 0, y: 0, w: 40, h: 30 }, 32, IMG, 1024, 8)
    check(plan, IMG, 8)
    expect(plan.x).toBe(0)
    expect(plan.y).toBe(0)
    const far = planCrop({ x: 2980, y: 1990, w: 20, h: 10 }, 64, IMG, 1024, 64)
    check(far, IMG, 64)
    expect(far.x + far.w).toBe(3000)
    expect(far.y + far.h).toBe(2000)
  })

  it('keeps the multiple (64) and the target long side', () => {
    for (const box of [
      { x: 10, y: 10, w: 333, h: 77 },
      { x: 500, y: 700, w: 1500, h: 1100 },
      { x: 2000, y: 100, w: 7, h: 900 },
    ]) {
      const plan = planCrop(box, 16, IMG, 1024, 64)
      check(plan, IMG, 64)
      expect(Math.max(plan.workW, plan.workH)).toBeLessThanOrEqual(1024 + 32)
    }
  })

  it('scales a sprite up (128×128 → 1024)', () => {
    const plan = planCrop({ x: 40, y: 30, w: 50, h: 20 }, 8, { width: 128, height: 128 }, 1024, 8)
    check(plan, { width: 128, height: 128 }, 8)
    expect(plan.scale).toBeGreaterThan(5)
  })

  it('a region larger than the image is clamped to the image', () => {
    const plan = planRegion({ x: 0, y: 0, w: 3000, h: 2000 }, IMG, 1024, 8)
    check(plan, IMG, 8)
    expect(plan).toMatchObject({ x: 0, y: 0, w: 3000, h: 2000, workW: 1024, workH: 680 })
  })
})

describe('maskBBox / roundTo', () => {
  it('finds bounds and returns null for an empty mask', () => {
    const m = createMask(10, 10)
    expect(maskBBox(m)).toBeNull()
    m.data[3 * 10 + 2] = 1
    m.data[7 * 10 + 8] = 255
    expect(maskBBox(m)).toEqual({ x: 2, y: 3, w: 7, h: 5 })
    expect(maskBBox(m, { x: 5, y: 5, w: 5, h: 5 })).toEqual({ x: 8, y: 7, w: 1, h: 1 })
  })
  it('roundTo never goes below one multiple', () => {
    expect(roundTo(3, 8)).toBe(8)
    expect(roundTo(1021, 8)).toBe(1024)
    expect(roundTo(1000, 64)).toBe(1024)
  })
})
