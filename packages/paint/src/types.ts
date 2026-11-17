/**
 * Public types: pixels, geometry, generation adapters, layers.
 *
 * Everything here is plain data — no DOM, no classes — so the geometry and
 * compositing functions run (and are tested) anywhere.
 */

/** RGBA pixels, 8 bits per channel, straight (not premultiplied) alpha; same shape as `ImageData`. */
export interface Raster {
  width: number
  height: number
  data: Uint8ClampedArray
}

/** One channel per pixel, 0 = untouched, 255 = edit. */
export interface MaskData {
  width: number
  height: number
  data: Uint8Array
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Size {
  width: number
  height: number
}

/**
 * Inpaint-only-masked plan: the crop region of the source image and the
 * working resolution the generator sees.
 */
export interface CropPlan {
  /** Crop region in source pixels (integers, inside the image). */
  x: number
  y: number
  w: number
  h: number
  /** Working size sent to the generator (multiples of `multiple`). */
  workW: number
  workH: number
  /** `workW / w` — above 1 the crop is scaled up (small details, sprites). */
  scale: number
}

// ────────────────────────────────────────────────────────────────────────────
// Generation adapters
// ────────────────────────────────────────────────────────────────────────────

export interface GeneratorCaps {
  /** Takes a mask (inpaint). Without it the edit is instruction-only and the mask stays local (`pasteBack`). */
  mask: boolean
  denoise: boolean
  negative: boolean
  /** Extra reference images it accepts. */
  refs?: number
  /** Longest side it accepts; the working resolution is capped by it. */
  maxSide?: number
  /** Working size must be a multiple of this (default 8). */
  multiple?: number
  /** Candidates per run it can return (default 1; the panel offers 1…variants). */
  variants?: number
}

/** A field of the adapter's own simple form (model, template, steps…). */
export interface ParamField {
  key: string
  label: string
  type: 'text' | 'number' | 'select' | 'checkbox'
  default?: string | number | boolean
  options?: Array<{ value: string; label?: string }>
  min?: number
  max?: number
  step?: number
  hint?: string
}

export interface GenerateRequest {
  /** The crop at working resolution (PNG). Transparency is flattened onto the backdrop colour. */
  image: Blob
  /** Mask at the same size (PNG, white = edit); only for `caps.mask`. */
  mask?: Blob
  refs?: Blob[]
  prompt: string
  negative?: string
  denoise?: number
  seed?: number
  /** Candidates wanted. */
  n?: number
  params?: Record<string, unknown>
}

export interface GenerateProgress {
  /** 0…1 when known. */
  value?: number
  preview?: Blob
  text?: string
}

export interface GenerateIO {
  signal: AbortSignal
  progress(p: GenerateProgress): void
}

/** A generation backend. The editor knows nothing about providers — only this. */
export interface Generator {
  id: string
  label: string
  caps: GeneratorCaps
  params?: ParamField[]
  run(req: GenerateRequest, io: GenerateIO): Promise<Blob[]>
}

/** Background removal: returns an image whose alpha is the matte. */
export interface Matter {
  matte(image: Blob, io: { signal: AbortSignal }): Promise<Blob>
}

// ────────────────────────────────────────────────────────────────────────────
// Layers
// ────────────────────────────────────────────────────────────────────────────

/** What produced a layer: enough to reproduce the edit. */
export interface EditRecord {
  generator: string
  prompt: string
  negative?: string
  denoise?: number
  seed?: number
  params: Record<string, unknown>
  plan: CropPlan
  /** Paste options used. */
  feather: number
  alpha: AlphaMode
}

export type AlphaMode = 'keep' | 'result' | 'matte'

/** A patch over the base: its pixels replace the base inside `bbox`. */
export interface Layer {
  id: string
  name: string
  bbox: Rect
  rgba: Raster
  record?: EditRecord
}

export interface LayerManifest {
  format: 'trempel-paint-layers'
  version: 1
  width: number
  height: number
  base: string
  layers: Array<{ name: string; file: string; x: number; y: number; w: number; h: number; mode: 'replace' }>
}

export interface ExportedLayers {
  base: Blob
  layers: Array<{ name: string; file: string; x: number; y: number; w: number; h: number; png: Blob }>
  manifest: LayerManifest
}
