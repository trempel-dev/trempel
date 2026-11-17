/**
 * Inpaint-only-masked geometry: where to crop and at what working size.
 *
 * The mask bbox plus padding is the region of interest. The generator works
 * best near its native resolution, so the crop is scaled (up for small
 * details and sprites, down for large areas) until its long side is the
 * target, rounded to the model's multiple. The crop is then widened to the
 * exact aspect of the working size so the scale is uniform; near the image
 * edge it slides inward instead of leaving the image.
 */

import type { CropPlan, MaskData, Rect, Size } from './types.js'

/** Bounds of non-zero mask pixels; `null` for an empty mask. */
export function maskBBox(mask: MaskData, within?: Rect): Rect | null {
  const x0 = within ? Math.max(0, within.x) : 0
  const y0 = within ? Math.max(0, within.y) : 0
  const x1 = within ? Math.min(mask.width, within.x + within.w) : mask.width
  const y1 = within ? Math.min(mask.height, within.y + within.h) : mask.height
  let minX = Infinity
  let minY = Infinity
  let maxX = -1
  let maxY = -1
  const { data, width } = mask
  for (let y = y0; y < y1; y += 1) {
    const row = y * width
    for (let x = x0; x < x1; x += 1) {
      if (data[row + x] === 0) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
}

/** Round to the nearest multiple, never below one multiple. */
export function roundTo(value: number, multiple: number): number {
  const m = Math.max(1, Math.round(multiple))
  return Math.max(m, Math.round(value / m) * m)
}

/** Slide an interval of length `len` around `center` into `[0, limit]`. */
function fit1d(center: number, len: number, limit: number): [number, number] {
  const l = Math.min(len, limit)
  let start = Math.round(center - l / 2)
  if (start < 0) start = 0
  if (start + l > limit) start = limit - l
  return [start, l]
}

/**
 * Crop plan for a mask bbox.
 *
 * @param maskBBox region to edit (source pixels), e.g. `maskBBox(mask)`
 * @param padding context around it, source pixels
 * @param imageSize source size
 * @param targetLongSide working long side (e.g. 1024)
 * @param multiple working size multiple (8 for SD-like latents, 64 for some models)
 */
export function planCrop(maskBBox: Rect, padding: number, imageSize: Size, targetLongSide: number, multiple = 8): CropPlan {
  const W = imageSize.width
  const H = imageSize.height
  if (W <= 0 || H <= 0) throw new Error('planCrop: empty image')
  const pad = Math.max(0, Math.round(padding))
  // Region of interest, clamped to the image.
  const rx0 = Math.max(0, Math.floor(maskBBox.x) - pad)
  const ry0 = Math.max(0, Math.floor(maskBBox.y) - pad)
  const rx1 = Math.min(W, Math.ceil(maskBBox.x + maskBBox.w) + pad)
  const ry1 = Math.min(H, Math.ceil(maskBBox.y + maskBBox.h) + pad)
  const rw = Math.max(1, rx1 - rx0)
  const rh = Math.max(1, ry1 - ry0)

  // Working size: long side → target, both rounded to the multiple.
  const s0 = targetLongSide / Math.max(rw, rh)
  let workW = roundTo(rw * s0, multiple)
  let workH = roundTo(rh * s0, multiple)

  // Crop with the exact working aspect: grow the short side (never shrink the region).
  let cw = rw
  let ch = rh
  if (workW / workH > rw / rh) cw = Math.round((rh * workW) / workH)
  else ch = Math.round((rw * workH) / workW)
  const [x, w] = fit1d(rx0 + rw / 2, cw, W)
  const [y, h] = fit1d(ry0 + rh / 2, ch, H)

  // Clamped by the image edge: keep the aspect from the crop we actually have.
  if (w !== cw || h !== ch) {
    const s = targetLongSide / Math.max(w, h)
    workW = roundTo(w * s, multiple)
    workH = roundTo(h * s, multiple)
  }
  return { x, y, w, h, workW, workH, scale: workW / w }
}

/** Plan for a region the user placed by hand (no padding, same rules). */
export function planRegion(region: Rect, imageSize: Size, targetLongSide: number, multiple = 8): CropPlan {
  return planCrop(region, 0, imageSize, targetLongSide, multiple)
}

export function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const r = Math.min(a.x + a.w, b.x + b.w)
  const btm = Math.min(a.y + a.h, b.y + b.h)
  return r > x && btm > y ? { x, y, w: r - x, h: btm - y } : null
}
