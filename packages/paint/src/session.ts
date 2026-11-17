/**
 * Edit session without DOM: the image, its mask with history, the region,
 * layers and the generation pipeline (crop → generator → paste back →
 * candidates). The editor UI drives it; consumers can drive it directly.
 */

import { maskBBox, planCrop, planRegion } from './geometry.js'
import { MaskHistory, fillRect } from './mask.js'
import { blobToRaster, rasterToBlob } from './png.js'
import { applyPatch, cloneRaster, createMask, cropScaled, extractPatch, hasAlpha, maskScaled, pasteBack, patchBounds } from './raster.js'
import type { AlphaMode, CropPlan, EditRecord, ExportedLayers, Generator, Layer, LayerManifest, MaskData, Matter, Raster, Rect } from './types.js'

export interface EditSettings {
  prompt: string
  negative: string
  /** 0…1, for generators with `caps.denoise`. */
  denoise: number
  /** `null` — random per run. */
  seed: number | null
  /** Candidates per run. */
  n: number
  /** Context around the mask, source pixels. */
  padding: number
  /** Working long side. */
  workSide: number
  /** Inward feather, source pixels. */
  feather: number
  colorMatch: boolean
  /** `auto` — `keep` for images with transparency, else `result`. */
  alpha: AlphaMode | 'auto'
  /** Backdrop under transparency in the crop sent to the generator. */
  background: string
  /** Adapter fields (`Generator.params`). */
  params: Record<string, unknown>
}

export const DEFAULT_SETTINGS: EditSettings = {
  prompt: '',
  negative: '',
  denoise: 0.5,
  seed: null,
  n: 1,
  padding: 32,
  workSide: 1024,
  feather: 8,
  colorMatch: false,
  alpha: 'auto',
  background: '#808080',
  params: {},
}

export interface Candidate {
  /** The whole image with this result pasted in. */
  image: Raster
  bbox: Rect
  record: EditRecord
  /** Raw generator output (before paste). */
  output: Blob
}

export interface RunIO {
  signal: AbortSignal
  progress(p: { value?: number; preview?: Blob; text?: string }): void
}

let seq = 0
const newId = (): string => `l${Date.now().toString(36)}${(seq += 1).toString(36)}`

const randomSeed = (): number => Math.floor(Math.random() * 2 ** 31)

/** File-safe slug for layer names. */
export function slug(name: string): string {
  const s = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  return s.slice(0, 48) || 'layer'
}

/** `name: prompt` lines of a series; a bare line is both. */
export function parseSeries(text: string): Array<{ name: string; prompt: string }> {
  const out: Array<{ name: string; prompt: string }> = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    const m = /^([^:]{1,40}):\s*(.+)$/.exec(t)
    if (m) out.push({ name: m[1]!.trim(), prompt: m[2]!.trim() })
    else out.push({ name: t.slice(0, 40), prompt: t })
  }
  return out
}

export class EditSession {
  base: Raster
  mask: MaskData
  readonly history: MaskHistory
  layers: Layer[] = []
  /** Layer shown over the base (`null` — the base). */
  active: string | null = null
  /** Region placed by hand; `null` — follows the mask. */
  region: Rect | null = null
  /** Edits applied into the base, oldest first. */
  applied: EditRecord[] = []
  readonly transparent: boolean

  constructor(base: Raster) {
    this.base = base
    this.mask = createMask(base.width, base.height)
    this.history = new MaskHistory(this.mask)
    this.transparent = hasAlpha(base)
  }

  static async fromBlob(blob: Blob): Promise<EditSession> {
    return new EditSession(await blobToRaster(blob))
  }

  get size(): { width: number; height: number } {
    return { width: this.base.width, height: this.base.height }
  }

  alphaMode(s: EditSettings): AlphaMode {
    return s.alpha === 'auto' ? (this.transparent ? 'keep' : 'result') : s.alpha
  }

  /** Region of interest before planning: hand-placed, else mask bbox + padding. */
  regionOf(s: EditSettings): Rect | null {
    if (this.region) return this.region
    const box = maskBBox(this.mask)
    if (!box) return null
    const p = Math.max(0, Math.round(s.padding))
    const x = Math.max(0, box.x - p)
    const y = Math.max(0, box.y - p)
    return { x, y, w: Math.min(this.base.width, box.x + box.w + p) - x, h: Math.min(this.base.height, box.y + box.h + p) - y }
  }

  /** Crop plan for a generator; `null` — nothing to edit (mask generator, empty mask). */
  plan(gen: Generator, s: EditSettings): CropPlan | null {
    const side = Math.min(s.workSide, gen.caps.maxSide ?? Infinity)
    const multiple = gen.caps.multiple ?? 8
    if (this.region) return planRegion(this.region, this.size, side, multiple)
    const box = maskBBox(this.mask)
    if (box) return planCrop(box, s.padding, this.size, side, multiple)
    // Instruction edit without a mask: the whole image.
    if (!gen.caps.mask) return planRegion({ x: 0, y: 0, w: this.base.width, h: this.base.height }, this.size, side, multiple)
    return null
  }

  /** The image as shown: base with the active layer (or the base for `before`). */
  view(before = false): Raster {
    const layer = before ? null : this.layers.find((l) => l.id === this.active)
    return layer ? applyPatch(this.base, layer.rgba, layer.bbox) : this.base
  }

  /**
   * One run: crop, generate, paste each output back. The mask used is the
   * current mask; without one (instruction edit) — the whole plan.
   */
  async generate(gen: Generator, s: EditSettings, io: RunIO, matter?: Matter): Promise<Candidate[]> {
    const plan = this.plan(gen, s)
    if (!plan) throw new Error('paint: draw a mask first')
    let mask = this.mask
    if (!maskBBox(this.mask, plan)) {
      if (gen.caps.mask) throw new Error('paint: the mask is outside the region')
      mask = createMask(this.base.width, this.base.height)
      fillRect(mask, plan, 'add')
    }
    const seed = s.seed ?? randomSeed()
    const alpha = this.alphaMode(s)
    const image = await rasterToBlob(cropScaled(this.base, plan, { background: s.background }))
    const maskBlob = gen.caps.mask ? await rasterToBlob(maskScaled(mask, plan)) : undefined
    const n = Math.max(1, Math.min(s.n, gen.caps.variants ?? 4))
    const record: EditRecord = {
      generator: gen.id,
      prompt: s.prompt,
      ...(gen.caps.negative && s.negative ? { negative: s.negative } : {}),
      ...(gen.caps.denoise ? { denoise: s.denoise } : {}),
      seed,
      params: { ...s.params },
      plan,
      feather: s.feather,
      alpha,
    }
    const outputs = await gen.run(
      {
        image,
        ...(maskBlob ? { mask: maskBlob } : {}),
        prompt: s.prompt,
        ...(record.negative ? { negative: record.negative } : {}),
        ...(record.denoise !== undefined ? { denoise: record.denoise } : {}),
        seed,
        n,
        params: { ...s.params },
      },
      io,
    )
    const bbox = patchBounds(mask, plan) ?? { x: plan.x, y: plan.y, w: plan.w, h: plan.h }
    const out: Candidate[] = []
    for (const [i, output] of outputs.entries()) {
      if (io.signal.aborted) break
      const result = await blobToRaster(output)
      let matte: Raster | undefined
      if (alpha === 'matte' && matter) matte = await blobToRaster(await matter.matte(output, { signal: io.signal }))
      const edited = pasteBack(this.base, result, mask, plan, { feather: s.feather, colorMatch: s.colorMatch, alpha, ...(matte ? { matte } : {}) })
      out.push({ image: edited, bbox, record: { ...record, seed: seed + i }, output })
    }
    return out
  }

  addLayer(c: Candidate, name: string): Layer {
    const layer: Layer = { id: newId(), name: name.trim() || `Layer ${this.layers.length + 1}`, bbox: c.bbox, rgba: extractPatch(c.image, c.bbox), record: c.record }
    this.layers.push(layer)
    this.active = layer.id
    return layer
  }

  removeLayer(id: string): void {
    this.layers = this.layers.filter((l) => l.id !== id)
    if (this.active === id) this.active = this.layers.at(-1)?.id ?? null
  }

  renameLayer(id: string, name: string): void {
    const l = this.layers.find((x) => x.id === id)
    if (l && name.trim()) l.name = name.trim()
  }

  /** Bake a layer into the base and keep editing; its record joins the chain. */
  applyLayer(id: string): void {
    const l = this.layers.find((x) => x.id === id)
    if (!l) return
    this.base = applyPatch(this.base, l.rgba, l.bbox)
    if (l.record) this.applied.push(l.record)
    this.layers = this.layers.filter((x) => x.id !== id)
    this.active = null
  }

  /** Applied edits plus the active layer's, oldest first. */
  chain(): EditRecord[] {
    const cur = this.layers.find((l) => l.id === this.active)?.record
    return cur ? [...this.applied, cur] : [...this.applied]
  }

  async exportFlat(): Promise<Blob> {
    return rasterToBlob(this.view())
  }

  async exportLayers(): Promise<ExportedLayers> {
    const used = new Set<string>()
    const layers: ExportedLayers['layers'] = []
    for (const l of this.layers) {
      let file = `layers/${slug(l.name)}.png`
      for (let i = 2; used.has(file); i += 1) file = `layers/${slug(l.name)}-${i}.png`
      used.add(file)
      layers.push({ name: l.name, file, x: l.bbox.x, y: l.bbox.y, w: l.bbox.w, h: l.bbox.h, png: await rasterToBlob(l.rgba) })
    }
    const manifest: LayerManifest = {
      format: 'trempel-paint-layers',
      version: 1,
      width: this.base.width,
      height: this.base.height,
      base: 'base.png',
      layers: layers.map(({ png: _png, ...rest }) => ({ ...rest, mode: 'replace' as const })),
    }
    return { base: await rasterToBlob(this.base), layers, manifest }
  }

  /** Snapshot of the base (for consumers that keep their own copy). */
  baseCopy(): Raster {
    return cloneRaster(this.base)
  }
}
