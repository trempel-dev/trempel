/**
 * Pixel operations on plain buffers: crop, resample, flatten, feather, paste.
 *
 * Pure functions over `Raster` / `MaskData` (no canvas): deterministic,
 * byte-exact where it matters (outside the mask nothing changes), testable
 * without a browser.
 */

import { intersect, maskBBox } from './geometry.js'
import type { AlphaMode, CropPlan, MaskData, Raster, Rect } from './types.js'

export function createRaster(width: number, height: number): Raster {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) }
}

export function createMask(width: number, height: number): MaskData {
  return { width, height, data: new Uint8Array(width * height) }
}

export function cloneRaster(r: Raster): Raster {
  return { width: r.width, height: r.height, data: new Uint8ClampedArray(r.data) }
}

/** Any pixel not fully opaque. */
export function hasAlpha(r: Raster): boolean {
  const d = r.data
  for (let i = 3; i < d.length; i += 4) if (d[i] !== 255) return true
  return false
}

/** `#rgb` / `#rrggbb` → [r, g, b]; anything else → mid grey. */
export function parseColor(color: string | undefined): [number, number, number] {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color?.trim() ?? '')
  if (!m) return [128, 128, 128]
  const hex = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join('') : m[1]!
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)]
}

/** Copy a region (must lie inside the raster). */
export function cropRaster(src: Raster, rect: Rect): Raster {
  const out = createRaster(rect.w, rect.h)
  for (let y = 0; y < rect.h; y += 1) {
    const from = ((rect.y + y) * src.width + rect.x) * 4
    out.data.set(src.data.subarray(from, from + rect.w * 4), y * rect.w * 4)
  }
  return out
}

export function cropMask(src: MaskData, rect: Rect): MaskData {
  const out = createMask(rect.w, rect.h)
  for (let y = 0; y < rect.h; y += 1) {
    const from = (rect.y + y) * src.width + rect.x
    out.data.set(src.data.subarray(from, from + rect.w), y * rect.w)
  }
  return out
}

// ────────────────────────────────────────────────────────────────────────────
// Resampling
// ────────────────────────────────────────────────────────────────────────────

export type ResizeMode = 'smooth' | 'nearest'

interface Weights {
  start: Int32Array
  count: Int32Array
  w: Float32Array
  stride: number
}

/**
 * Triangle filter weights, widened by the scale when shrinking (antialiased
 * like Pillow's BILINEAR): upscaling is bilinear, downscaling averages areas.
 */
function weights(srcLen: number, dstLen: number): Weights {
  const scale = srcLen / dstLen
  const support = Math.max(1, scale)
  const stride = Math.ceil(support) * 2 + 1
  const start = new Int32Array(dstLen)
  const count = new Int32Array(dstLen)
  const w = new Float32Array(dstLen * stride)
  for (let i = 0; i < dstLen; i += 1) {
    const center = (i + 0.5) * scale
    const lo = Math.max(0, Math.floor(center - support))
    const hi = Math.min(srcLen, Math.ceil(center + support))
    let total = 0
    let n = 0
    for (let j = lo; j < hi && n < stride; j += 1) {
      const t = 1 - Math.abs((j + 0.5 - center) / support)
      const v = t > 0 ? t : 0
      w[i * stride + n] = v
      total += v
      n += 1
    }
    if (total <= 0) {
      // Degenerate: nearest.
      start[i] = Math.min(srcLen - 1, Math.floor(center))
      count[i] = 1
      w[i * stride] = 1
      continue
    }
    for (let k = 0; k < n; k += 1) w[i * stride + k]! /= total
    start[i] = lo
    count[i] = n
  }
  return { start, count, w, stride }
}

/** Separable resample of `channels`-interleaved floats. */
function resampleFloat(src: Float32Array, sw: number, sh: number, dw: number, dh: number, channels: number): Float32Array {
  const wx = weights(sw, dw)
  const tmp = new Float32Array(dw * sh * channels)
  for (let y = 0; y < sh; y += 1) {
    for (let x = 0; x < dw; x += 1) {
      const s = wx.start[x]!
      const n = wx.count[x]!
      for (let c = 0; c < channels; c += 1) {
        let acc = 0
        for (let k = 0; k < n; k += 1) acc += src[(y * sw + s + k) * channels + c]! * wx.w[x * wx.stride + k]!
        tmp[(y * dw + x) * channels + c] = acc
      }
    }
  }
  const wy = weights(sh, dh)
  const out = new Float32Array(dw * dh * channels)
  for (let y = 0; y < dh; y += 1) {
    const s = wy.start[y]!
    const n = wy.count[y]!
    for (let x = 0; x < dw; x += 1) {
      for (let c = 0; c < channels; c += 1) {
        let acc = 0
        for (let k = 0; k < n; k += 1) acc += tmp[((s + k) * dw + x) * channels + c]! * wy.w[y * wy.stride + k]!
        out[(y * dw + x) * channels + c] = acc
      }
    }
  }
  return out
}

function nearestIndex(srcLen: number, dstLen: number): Int32Array {
  const out = new Int32Array(dstLen)
  for (let i = 0; i < dstLen; i += 1) out[i] = Math.min(srcLen - 1, Math.floor(((i + 0.5) * srcLen) / dstLen))
  return out
}

/** Resize RGBA. `smooth` filters in premultiplied alpha (no dark fringes); `nearest` keeps pixels crisp. */
export function resizeRaster(src: Raster, width: number, height: number, mode: ResizeMode = 'smooth'): Raster {
  if (src.width === width && src.height === height) return cloneRaster(src)
  const out = createRaster(width, height)
  if (mode === 'nearest') {
    const xs = nearestIndex(src.width, width)
    const ys = nearestIndex(src.height, height)
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const from = (ys[y]! * src.width + xs[x]!) * 4
        out.data.set(src.data.subarray(from, from + 4), (y * width + x) * 4)
      }
    }
    return out
  }
  const n = src.width * src.height
  const pre = new Float32Array(n * 4)
  for (let i = 0; i < n; i += 1) {
    const a = src.data[i * 4 + 3]! / 255
    pre[i * 4] = src.data[i * 4]! * a
    pre[i * 4 + 1] = src.data[i * 4 + 1]! * a
    pre[i * 4 + 2] = src.data[i * 4 + 2]! * a
    pre[i * 4 + 3] = src.data[i * 4 + 3]!
  }
  const res = resampleFloat(pre, src.width, src.height, width, height, 4)
  for (let i = 0; i < width * height; i += 1) {
    const a = res[i * 4 + 3]!
    const k = a > 0 ? 255 / a : 0
    out.data[i * 4] = res[i * 4]! * k
    out.data[i * 4 + 1] = res[i * 4 + 1]! * k
    out.data[i * 4 + 2] = res[i * 4 + 2]! * k
    out.data[i * 4 + 3] = a
  }
  return out
}

export function resizeMask(src: MaskData, width: number, height: number, mode: ResizeMode = 'smooth'): MaskData {
  if (src.width === width && src.height === height) return { width, height, data: new Uint8Array(src.data) }
  const out = createMask(width, height)
  if (mode === 'nearest') {
    const xs = nearestIndex(src.width, width)
    const ys = nearestIndex(src.height, height)
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) out.data[y * width + x] = src.data[ys[y]! * src.width + xs[x]!]!
    return out
  }
  const res = resampleFloat(Float32Array.from(src.data), src.width, src.height, width, height, 1)
  for (let i = 0; i < res.length; i += 1) out.data[i] = Math.max(0, Math.min(255, Math.round(res[i]!)))
  return out
}

// ────────────────────────────────────────────────────────────────────────────
// Inpaint-only-masked: crop in, paste back
// ────────────────────────────────────────────────────────────────────────────

export interface CropOptions {
  /** Backdrop under transparent pixels (models do not keep alpha). Default `#808080`. */
  background?: string
  mode?: ResizeMode
}

/** The plan's crop at working size, flattened onto the backdrop (opaque). */
export function cropScaled(base: Raster, plan: CropPlan, opts: CropOptions = {}): Raster {
  const crop = resizeRaster(cropRaster(base, plan), plan.workW, plan.workH, opts.mode ?? 'smooth')
  const [br, bg, bb] = parseColor(opts.background)
  const d = crop.data
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3]! / 255
    if (a === 1) continue
    d[i] = d[i]! * a + br * (1 - a)
    d[i + 1] = d[i + 1]! * a + bg * (1 - a)
    d[i + 2] = d[i + 2]! * a + bb * (1 - a)
    d[i + 3] = 255
  }
  return crop
}

/** The plan's mask at working size as an opaque greyscale image (white = edit). */
export function maskScaled(mask: MaskData, plan: CropPlan): Raster {
  const m = resizeMask(cropMask(mask, plan), plan.workW, plan.workH)
  const out = createRaster(plan.workW, plan.workH)
  for (let i = 0; i < m.data.length; i += 1) {
    const v = m.data[i]!
    out.data[i * 4] = v
    out.data[i * 4 + 1] = v
    out.data[i * 4 + 2] = v
    out.data[i * 4 + 3] = 255
  }
  return out
}

/** Box blur of a mask region (separable, one pass per axis). */
function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h)
  const out = new Float32Array(w * h)
  const span = 2 * r + 1
  for (let y = 0; y < h; y += 1) {
    let acc = 0
    for (let x = -r; x <= r; x += 1) acc += src[y * w + Math.min(w - 1, Math.max(0, x))]!
    for (let x = 0; x < w; x += 1) {
      tmp[y * w + x] = acc / span
      acc += src[y * w + Math.min(w - 1, x + r + 1)]! - src[y * w + Math.max(0, x - r)]!
    }
  }
  for (let x = 0; x < w; x += 1) {
    let acc = 0
    for (let y = -r; y <= r; y += 1) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x]!
    for (let y = 0; y < h; y += 1) {
      out[y * w + x] = acc / span
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x]! - tmp[Math.max(0, y - r) * w + x]!
    }
  }
  return out
}

/**
 * Feather inward: the soft edge stays inside the mask, so everything outside
 * it remains untouched (`min(mask, blur(mask))`).
 */
export function featherMask(mask: MaskData, radius: number, within?: Rect): MaskData {
  const r = Math.round(radius)
  const out: MaskData = { width: mask.width, height: mask.height, data: new Uint8Array(mask.data) }
  if (r <= 0) return out
  const area = within ?? { x: 0, y: 0, w: mask.width, h: mask.height }
  // Work on the area plus a margin so the blur near its edge sees real pixels.
  const ext = intersect({ x: area.x - r * 2, y: area.y - r * 2, w: area.w + r * 4, h: area.h + r * 4 }, { x: 0, y: 0, w: mask.width, h: mask.height })
  if (!ext) return out
  const sub = cropMask(mask, ext)
  // Erode by ~r/2 (blur, keep the inner half), then soften by ~r/2 (two box
  // passes ≈ a tent): the ramp runs from ~0 at the mask edge to full at ~r inside.
  const half = Math.max(1, Math.round(r / 2))
  const soft = Math.max(1, Math.round(half / 2))
  const f1 = boxBlur(Float32Array.from(sub.data), ext.w, ext.h, half)
  for (let i = 0; i < f1.length; i += 1) f1[i] = Math.max(0, Math.min(255, f1[i]! * 2 - 255))
  const f = boxBlur(boxBlur(f1, ext.w, ext.h, soft), ext.w, ext.h, soft)
  for (let y = 0; y < ext.h; y += 1) {
    for (let x = 0; x < ext.w; x += 1) {
      const i = (ext.y + y) * mask.width + ext.x + x
      const m = mask.data[i]!
      if (m === 0) continue
      out.data[i] = Math.min(m, Math.round(f[y * ext.w + x]!))
    }
  }
  return out
}

export interface PasteOptions {
  /** Inward feather radius, source pixels. */
  feather?: number
  /** Shift the result's mean colour under the mask to the base's. */
  colorMatch?: boolean
  /**
   * `keep` — alpha of the source (default for images with transparency; fully
   * transparent source pixels stay byte-identical); `result` — alpha of the
   * result (models return opaque); `matte` — alpha of `matte`.
   */
  alpha?: AlphaMode
  /** For `alpha: 'matte'`: the matted result (its alpha is used), any size. */
  matte?: Raster
  /** Resample mode for the result (`nearest` for pixel art). */
  mode?: ResizeMode
}

/**
 * Paste a generated crop back into the source by the mask. Pixels where the
 * (feathered) mask is zero are copied unchanged — byte for byte.
 */
export function pasteBack(base: Raster, result: Raster, mask: MaskData, plan: CropPlan, opts: PasteOptions = {}): Raster {
  const out = cloneRaster(base)
  const alpha: AlphaMode = opts.alpha ?? (hasAlpha(base) ? 'keep' : 'result')
  const res = resizeRaster(result, plan.w, plan.h, opts.mode ?? 'smooth')
  const matte = alpha === 'matte' && opts.matte ? resizeRaster(opts.matte, plan.w, plan.h, opts.mode ?? 'smooth') : null
  const m = featherMask(mask, opts.feather ?? 0, plan)

  let dr = 0
  let dg = 0
  let db = 0
  if (opts.colorMatch) {
    let sw = 0
    const sb = [0, 0, 0]
    const sr = [0, 0, 0]
    for (let y = 0; y < plan.h; y += 1) {
      for (let x = 0; x < plan.w; x += 1) {
        const k = m.data[(plan.y + y) * base.width + plan.x + x]! / 255
        if (k === 0) continue
        const bi = ((plan.y + y) * base.width + plan.x + x) * 4
        const ri = (y * plan.w + x) * 4
        for (let c = 0; c < 3; c += 1) {
          sb[c]! += base.data[bi + c]! * k
          sr[c]! += res.data[ri + c]! * k
        }
        sw += k
      }
    }
    if (sw > 0) {
      dr = (sb[0]! - sr[0]!) / sw
      dg = (sb[1]! - sr[1]!) / sw
      db = (sb[2]! - sr[2]!) / sw
    }
  }

  for (let y = 0; y < plan.h; y += 1) {
    for (let x = 0; x < plan.w; x += 1) {
      const mi = (plan.y + y) * base.width + plan.x + x
      const mv = m.data[mi]!
      if (mv === 0) continue
      const bi = mi * 4
      const ba = base.data[bi + 3]!
      if (alpha === 'keep' && ba === 0) continue
      const k = mv / 255
      const ri = (y * plan.w + x) * 4
      out.data[bi] = base.data[bi]! * (1 - k) + (res.data[ri]! + dr) * k
      out.data[bi + 1] = base.data[bi + 1]! * (1 - k) + (res.data[ri + 1]! + dg) * k
      out.data[bi + 2] = base.data[bi + 2]! * (1 - k) + (res.data[ri + 2]! + db) * k
      if (alpha === 'result') out.data[bi + 3] = ba * (1 - k) + res.data[ri + 3]! * k
      else if (alpha === 'matte') out.data[bi + 3] = ba * (1 - k) + (matte ? matte.data[ri + 3]! : res.data[ri + 3]!) * k
      // keep: alpha untouched
    }
  }
  return out
}

/** Bounds of what `pasteBack` may have changed: the mask within the plan. */
export function patchBounds(mask: MaskData, plan: CropPlan): Rect | null {
  return maskBBox(mask, plan)
}

/** Layer pixels: the region of the edited image. */
export function extractPatch(edited: Raster, bbox: Rect): Raster {
  return cropRaster(edited, bbox)
}

/** Apply a patch (replace mode) onto a copy of the base. */
export function applyPatch(base: Raster, patch: Raster, at: { x: number; y: number }): Raster {
  const out = cloneRaster(base)
  for (let y = 0; y < patch.height; y += 1) {
    const ty = at.y + y
    if (ty < 0 || ty >= base.height) continue
    const x0 = Math.max(0, at.x)
    const x1 = Math.min(base.width, at.x + patch.width)
    if (x1 <= x0) continue
    const from = (y * patch.width + (x0 - at.x)) * 4
    out.data.set(patch.data.subarray(from, from + (x1 - x0) * 4), (ty * base.width + x0) * 4)
  }
  return out
}
