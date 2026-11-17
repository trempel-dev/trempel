/**
 * Mask editing: brush stamps, polygons, rectangles, invert, clear — and an
 * undo history that stores only the changed rectangle of each step.
 */

import { intersect } from './geometry.js'
import { cropMask } from './raster.js'
import type { MaskData, Rect } from './types.js'

export type MaskOp = 'add' | 'subtract'

const full = (m: MaskData): Rect => ({ x: 0, y: 0, w: m.width, h: m.height })

function put(m: MaskData, i: number, v: number, op: MaskOp): void {
  if (v <= 0) return
  const cur = m.data[i]!
  if (op === 'add') {
    if (v > cur) m.data[i] = v
  } else {
    m.data[i] = Math.round((cur * (255 - v)) / 255)
  }
}

/**
 * Round brush stamp. `hardness` 1 — hard edge, 0 — soft all the way from the
 * centre. Returns the touched rectangle (or `null`).
 */
export function stamp(m: MaskData, cx: number, cy: number, radius: number, hardness: number, op: MaskOp): Rect | null {
  const r = Math.max(0.5, radius)
  const area = intersect({ x: Math.floor(cx - r), y: Math.floor(cy - r), w: Math.ceil(r * 2) + 2, h: Math.ceil(r * 2) + 2 }, full(m))
  if (!area) return null
  const inner = r * Math.max(0, Math.min(1, hardness))
  for (let y = area.y; y < area.y + area.h; y += 1) {
    for (let x = area.x; x < area.x + area.w; x += 1) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy)
      if (d > r) continue
      const v = d <= inner ? 255 : Math.round(255 * (1 - (d - inner) / Math.max(1e-6, r - inner)))
      put(m, y * m.width + x, v, op)
    }
  }
  return area
}

/** Stamps along a segment, spaced by a quarter of the radius. */
export function stroke(m: MaskData, x0: number, y0: number, x1: number, y1: number, radius: number, hardness: number, op: MaskOp): Rect | null {
  const len = Math.hypot(x1 - x0, y1 - y0)
  const step = Math.max(0.5, radius / 4)
  const n = Math.max(1, Math.ceil(len / step))
  let box: Rect | null = null
  for (let i = 0; i <= n; i += 1) {
    const t = i / n
    box = union(box, stamp(m, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, radius, hardness, op))
  }
  return box
}

export function union(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b
  if (!b) return a
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }
}

/** Fill a rectangle. */
export function fillRect(m: MaskData, rect: Rect, op: MaskOp): Rect | null {
  const r = intersect({ x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h) }, full(m))
  if (!r) return null
  for (let y = r.y; y < r.y + r.h; y += 1) for (let x = r.x; x < r.x + r.w; x += 1) put(m, y * m.width + x, 255, op)
  return r
}

/** Fill a polygon (even-odd, pixel centres). */
export function fillPolygon(m: MaskData, points: Array<{ x: number; y: number }>, op: MaskOp): Rect | null {
  if (points.length < 3) return null
  let minY = Infinity
  let maxY = -Infinity
  let minX = Infinity
  let maxX = -Infinity
  for (const p of points) {
    minY = Math.min(minY, p.y)
    maxY = Math.max(maxY, p.y)
    minX = Math.min(minX, p.x)
    maxX = Math.max(maxX, p.x)
  }
  const box = intersect({ x: Math.floor(minX), y: Math.floor(minY), w: Math.ceil(maxX) - Math.floor(minX) + 1, h: Math.ceil(maxY) - Math.floor(minY) + 1 }, full(m))
  if (!box) return null
  const xs: number[] = []
  for (let y = box.y; y < box.y + box.h; y += 1) {
    const cy = y + 0.5
    xs.length = 0
    for (let i = 0; i < points.length; i += 1) {
      const a = points[i]!
      const b = points[(i + 1) % points.length]!
      if ((a.y <= cy && b.y > cy) || (b.y <= cy && a.y > cy)) xs.push(a.x + ((cy - a.y) / (b.y - a.y)) * (b.x - a.x))
    }
    xs.sort((p, q) => p - q)
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.max(box.x, Math.ceil(xs[k]! - 0.5))
      const to = Math.min(box.x + box.w - 1, Math.floor(xs[k + 1]! - 0.5))
      for (let x = from; x <= to; x += 1) put(m, y * m.width + x, 255, op)
    }
  }
  return box
}

export function invertMask(m: MaskData): Rect {
  for (let i = 0; i < m.data.length; i += 1) m.data[i] = 255 - m.data[i]!
  return full(m)
}

export function clearMask(m: MaskData): Rect {
  m.data.fill(0)
  return full(m)
}

interface Step {
  rect: Rect
  before: Uint8Array
  after: Uint8Array
}

/**
 * Undo/redo for one mask. `begin()` before a change, `commit(rect)` after it
 * with the touched rectangle: only that rectangle is kept, before and after.
 */
export class MaskHistory {
  private undoStack: Step[] = []
  private redoStack: Step[] = []
  private snapshot: Uint8Array | null = null

  constructor(
    private readonly mask: MaskData,
    private readonly limit = 100,
  ) {}

  begin(): void {
    this.snapshot = new Uint8Array(this.mask.data)
  }

  commit(rect: Rect | null): void {
    const snap = this.snapshot
    this.snapshot = null
    if (!snap || !rect) return
    const before = cropMask({ width: this.mask.width, height: this.mask.height, data: snap }, rect).data
    const after = cropMask(this.mask, rect).data
    if (before.every((v, i) => v === after[i])) return
    this.undoStack.push({ rect, before, after })
    if (this.undoStack.length > this.limit) this.undoStack.shift()
    this.redoStack = []
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0
  }

  undo(): Rect | null {
    const s = this.undoStack.pop()
    if (!s) return null
    this.write(s.rect, s.before)
    this.redoStack.push(s)
    return s.rect
  }

  redo(): Rect | null {
    const s = this.redoStack.pop()
    if (!s) return null
    this.write(s.rect, s.after)
    this.undoStack.push(s)
    return s.rect
  }

  private write(rect: Rect, data: Uint8Array): void {
    for (let y = 0; y < rect.h; y += 1) this.mask.data.set(data.subarray(y * rect.w, (y + 1) * rect.w), (rect.y + y) * this.mask.width + rect.x)
  }
}
