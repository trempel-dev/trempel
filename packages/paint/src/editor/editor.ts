/**
 * `createImageEditor(container, options)` — the editor UI on DOM + Canvas 2D.
 *
 *   stage    one canvas: image (base or base + layer), mask overlay, region
 *            frame with the working resolution, brush cursor, lasso path,
 *            pixel grid; pan (space/middle drag), zoom (wheel, pinch), fit, 1:1,
 *            pixel mode (nearest neighbour + grid when zoomed in)
 *   toolbar  brush, eraser, lasso (free or polygon), rectangle, region,
 *            invert, clear, undo/redo, size/hardness, before/after
 *   panel    generator (built from its caps), presets, prompt…, region
 *            options, generate / series, candidates, layers
 *
 * The editor holds no provider knowledge: generation goes through the
 * `Generator` objects it is given.
 */

import { stroke, fillPolygon, fillRect, invertMask, clearMask, union } from '../mask.js'
import { rasterToBlob } from '../png.js'
import { EditSession, DEFAULT_SETTINGS, parseSeries, type Candidate, type EditSettings } from '../session.js'
import type { EditRecord, ExportedLayers, Generator, Layer, MaskData, Matter, ParamField, Raster, Rect } from '../types.js'
import { LABELS, type Labels } from './labels.js'
import { injectStyles } from './styles.js'

export interface Preset {
  id: string
  label: string
  values: Partial<Omit<EditSettings, 'params'>> & { params?: Record<string, unknown> }
}

export interface EditorAction {
  id: string
  label: string
  title?: string
  /** Hidden until there is something to act on. */
  when?: 'always' | 'layers'
  run(editor: EditorHandle): void | Promise<void>
}

export interface ImageEditorOptions {
  image: Blob | Raster
  generators: Generator[]
  matter?: Matter
  presets?: Preset[]
  defaults?: Partial<EditSettings>
  labels?: Partial<Labels>
  /** Buttons at the end of the toolbar (save, close…). */
  actions?: EditorAction[]
  /** Pixel mode: on, off, or `auto` (on for images up to 256 px). */
  pixel?: boolean | 'auto'
  onChange?(e: { type: 'mask' | 'layers' | 'generate' | 'apply' | 'settings' }): void
  onError?(err: Error): void
}

export interface EditorHandle {
  /** Resolves when the image is decoded and shown. */
  readonly ready: Promise<void>
  /** Flattened PNG of what is shown: base plus the active layer. */
  export(): Promise<Blob>
  exportLayers(): Promise<ExportedLayers>
  layers(): Layer[]
  /** Applied edits plus the active layer's record. */
  chain(): EditRecord[]
  settings(): EditSettings
  setSettings(patch: Partial<EditSettings>): void
  applyPreset(id: string): void
  generator(): Generator | null
  mask(): MaskData | null
  base(): Raster | null
  /** Run the current settings (same as the button). */
  generate(): Promise<void>
  destroy(): void
}

type Tool = 'brush' | 'eraser' | 'lasso' | 'rect' | 'frame'

interface View {
  scale: number
  ox: number
  oy: number
}

type El = HTMLElement

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | number | boolean | undefined> = {}, ...children: Array<Node | string | null>): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue
    if (k === 'class') el.className = String(v)
    else el.setAttribute(k, v === true ? '' : String(v))
  }
  for (const c of children) if (c !== null) el.append(c)
  return el
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

function inEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  return !!el && typeof el.tagName === 'string' && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')
}

export function createImageEditor(container: HTMLElement, options: ImageEditorOptions): EditorHandle {
  const L: Labels = { ...LABELS, ...options.labels }
  injectStyles(container)
  const generators = options.generators
  let gen: Generator | null = generators[0] ?? null
  let settings: EditSettings = { ...DEFAULT_SETTINGS, ...options.defaults, params: { ...options.defaults?.params } }
  let session: EditSession | null = null
  let tool: Tool = 'brush'
  let brush = 24
  let hardness = 0.7
  let pixel = false
  let before = false
  let view: View = { scale: 1, ox: 0, oy: 0 }
  let candidates: Candidate[] = []
  let picked = -1
  let running: AbortController | null = null
  let destroyed = false
  const urls: string[] = []

  // ── DOM ───────────────────────────────────────────────────────────────────
  const root = h('div', { class: 'tp-root', 'data-testid': 'paint-editor', 'data-state': 'loading', tabindex: 0 })
  const bar = h('div', { class: 'tp-bar' })
  const stage = h('div', { class: 'tp-stage' })
  const canvas = h('canvas', { 'data-testid': 'paint-canvas' })
  stage.append(canvas)
  const panel = h('aside', { class: 'tp-panel', 'data-testid': 'paint-panel' })
  root.append(bar, h('div', { class: 'tp-main' }, stage, panel))
  container.append(root)
  const g = canvas.getContext('2d')!

  const toolBtns = new Map<Tool, HTMLButtonElement>()
  const btn = (label: string, attrs: Record<string, string | number | boolean | undefined>, onClick: () => void): HTMLButtonElement => {
    const b = h('button', { type: 'button', class: 'tp-btn', title: label, ...attrs }, label)
    b.addEventListener('click', onClick)
    return b
  }
  const keyHint = (label: string, key: string): string => `${label} (${key})`
  for (const [t, label, key] of [
    ['brush', L.brush, 'B'],
    ['eraser', L.eraser, 'E'],
    ['lasso', L.lasso, 'L'],
    ['rect', L.rect, 'M'],
    ['frame', L.frame, 'F'],
  ] as Array<[Tool, string, string]>) {
    const b = btn(label, { 'data-testid': 'paint-tool', 'data-tool': t, title: keyHint(label, key), 'aria-pressed': t === tool }, () => setTool(t))
    toolBtns.set(t, b)
    bar.append(b)
  }
  bar.append(h('span', { class: 'tp-sep' }))
  bar.append(btn(L.invert, { 'data-testid': 'paint-invert' }, () => maskOp((m) => invertMask(m))))
  bar.append(btn(L.clear, { 'data-testid': 'paint-clear' }, () => maskOp((m) => clearMask(m))))
  const undoBtn = btn(L.undo, { 'data-testid': 'paint-undo', title: keyHint(L.undo, '⌘Z') }, () => undo())
  const redoBtn = btn(L.redo, { 'data-testid': 'paint-redo', title: keyHint(L.redo, '⇧⌘Z') }, () => redo())
  bar.append(undoBtn, redoBtn, h('span', { class: 'tp-sep' }))
  const sizeIn = h('input', { type: 'range', min: 1, max: 400, value: brush, 'data-testid': 'paint-size' })
  sizeIn.addEventListener('input', () => {
    brush = Number(sizeIn.value)
    draw()
  })
  const hardIn = h('input', { type: 'range', min: 0, max: 100, value: hardness * 100, 'data-testid': 'paint-hardness' })
  hardIn.addEventListener('input', () => (hardness = Number(hardIn.value) / 100))
  bar.append(h('label', { class: 'tp-range', title: `${L.size} ([ ])` }, L.size, sizeIn), h('label', { class: 'tp-range' }, L.hardness, hardIn))
  bar.append(h('span', { class: 'tp-sep' }))
  bar.append(btn(L.fit, { 'data-testid': 'paint-fit', title: keyHint(L.fit, '0') }, () => fit()))
  bar.append(btn(L.actual, { 'data-testid': 'paint-actual', title: keyHint(L.actual, '1') }, () => zoomTo(1)))
  const pixelBtn = btn(L.pixel, { 'data-testid': 'paint-pixel', title: keyHint(L.pixel, 'P'), 'aria-pressed': false }, () => setPixel(!pixel))
  const beforeBtn = btn(L.before, { 'data-testid': 'paint-before', title: keyHint(L.before, '\\'), 'aria-pressed': false }, () => setBefore(!before))
  bar.append(pixelBtn, beforeBtn)
  const actionBtns: Array<[EditorAction, HTMLButtonElement]> = []
  if (options.actions?.length) {
    bar.append(h('span', { style: 'flex:1' }))
    for (const a of options.actions) {
      const b = btn(a.label, { 'data-testid': 'paint-action', 'data-id': a.id, title: a.title ?? a.label }, () => void runAction(a))
      actionBtns.push([a, b])
      bar.append(b)
    }
  }

  // Panel sections
  const genSec = h('section', { class: 'tp-sec' })
  const promptSec = h('section', { class: 'tp-sec' })
  const regionSec = h('section', { class: 'tp-sec' })
  const runSec = h('section', { class: 'tp-sec' })
  const candSec = h('section', { class: 'tp-sec', 'data-testid': 'paint-candidates', hidden: true })
  const layerSec = h('section', { class: 'tp-sec', 'data-testid': 'paint-layers' })
  panel.append(genSec, promptSec, regionSec, runSec, candSec, layerSec)

  const status = h('div', { class: 'tp-note', 'data-testid': 'paint-status', role: 'status' })
  const prog = h('div', { class: 'tp-prog', hidden: true }, h('i'))
  const previewImg = h('img', { class: 'tp-preview', hidden: true, alt: '' })

  // ── state helpers ─────────────────────────────────────────────────────────
  const changed = (type: Parameters<NonNullable<ImageEditorOptions['onChange']>>[0]['type']): void => options.onChange?.({ type })
  const say = (text: string, error = false): void => {
    status.textContent = text
    status.classList.toggle('tp-err', error)
  }
  const fail = (err: unknown): void => {
    const e = err instanceof Error ? err : new Error(String(err))
    say(e.message, true)
    options.onError?.(e)
  }

  function setTool(t: Tool): void {
    tool = t
    lasso = null
    for (const [k, b] of toolBtns) b.setAttribute('aria-pressed', String(k === t))
    root.dataset.tool = t
    draw()
  }

  function setPixel(on: boolean): void {
    pixel = on
    pixelBtn.setAttribute('aria-pressed', String(on))
    draw()
  }

  function setBefore(on: boolean): void {
    before = on
    beforeBtn.setAttribute('aria-pressed', String(on))
    root.dataset.before = String(on)
    refreshImage()
  }

  // ── offscreen layers of the picture ───────────────────────────────────────
  let imageCanvas: HTMLCanvasElement | null = null
  let maskCanvas: HTMLCanvasElement | null = null
  let maskPixels: ImageData | null = null

  function rasterCanvas(r: Raster): HTMLCanvasElement {
    const c = document.createElement('canvas')
    c.width = r.width
    c.height = r.height
    c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(r.data), r.width, r.height), 0, 0)
    return c
  }

  function shownRaster(): Raster | null {
    if (!session) return null
    if (picked >= 0 && candidates[picked] && !before) return candidates[picked]!.image
    return session.view(before)
  }

  function refreshImage(): void {
    const r = shownRaster()
    imageCanvas = r ? rasterCanvas(r) : null
    draw()
  }

  function refreshMask(rect?: Rect | null): void {
    if (!session) return
    const m = session.mask
    if (!maskCanvas || maskCanvas.width !== m.width || maskCanvas.height !== m.height) {
      maskCanvas = document.createElement('canvas')
      maskCanvas.width = m.width
      maskCanvas.height = m.height
      maskPixels = new ImageData(m.width, m.height)
      rect = null
    }
    const px = maskPixels!
    const area = rect ?? { x: 0, y: 0, w: m.width, h: m.height }
    for (let y = area.y; y < area.y + area.h; y += 1) {
      for (let x = area.x; x < area.x + area.w; x += 1) {
        const i = y * m.width + x
        const v = m.data[i]!
        px.data[i * 4] = 255
        px.data[i * 4 + 1] = 48
        px.data[i * 4 + 2] = 64
        px.data[i * 4 + 3] = Math.round(v * 0.5)
      }
    }
    maskCanvas.getContext('2d')!.putImageData(px, 0, 0, area.x, area.y, area.w, area.h)
    root.dataset.masked = String(m.data.some((v) => v > 0))
    updatePlan()
    draw()
  }

  // ── view: pan / zoom ──────────────────────────────────────────────────────
  let cssW = 0
  let cssH = 0
  const dpr = (): number => globalThis.devicePixelRatio || 1

  function resize(): void {
    const r = stage.getBoundingClientRect()
    if (r.width === cssW && r.height === cssH) return
    const first = cssW === 0
    cssW = r.width
    cssH = r.height
    canvas.width = Math.max(1, Math.round(cssW * dpr()))
    canvas.height = Math.max(1, Math.round(cssH * dpr()))
    if (first && session) fit()
    else draw()
  }
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => resize()) : null
  ro?.observe(stage)

  function fit(): void {
    if (!session || cssW === 0) return
    const { width, height } = session.size
    const s = Math.min((cssW - 32) / width, (cssH - 32) / height)
    const scale = clamp(pixel ? Math.max(1, Math.floor(s)) : s, 0.02, 64)
    view = { scale, ox: (cssW - width * scale) / 2, oy: (cssH - height * scale) / 2 }
    draw()
  }

  function zoomAt(factor: number, cx: number, cy: number): void {
    const scale = clamp(view.scale * factor, 0.02, 64)
    const k = scale / view.scale
    view = { scale, ox: cx - (cx - view.ox) * k, oy: cy - (cy - view.oy) * k }
    draw()
  }

  function zoomTo(scale: number): void {
    zoomAt(scale / view.scale, cssW / 2, cssH / 2)
  }

  const toImage = (sx: number, sy: number): { x: number; y: number } => ({ x: (sx - view.ox) / view.scale, y: (sy - view.oy) / view.scale })
  const local = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const r = canvas.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  // ── drawing ───────────────────────────────────────────────────────────────
  let frame = 0
  let hover: { x: number; y: number } | null = null
  let lasso: { points: Array<{ x: number; y: number }>; free: boolean } | null = null
  let rectDrag: { x0: number; y0: number; x1: number; y1: number; subtract: boolean } | null = null

  function draw(): void {
    if (frame || destroyed) return
    frame = requestAnimationFrame(() => {
      frame = 0
      paint()
    })
  }

  function paint(): void {
    const k = dpr()
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.clearRect(0, 0, canvas.width, canvas.height)
    if (!session || !imageCanvas) return
    root.dataset.zoom = String(Math.round(view.scale * 100))
    // Screen ← image transform (CSS px of the canvas): for tests and embedding hosts.
    root.dataset.view = `${view.ox.toFixed(2)},${view.oy.toFixed(2)},${view.scale.toFixed(5)}`
    g.setTransform(k, 0, 0, k, 0, 0)
    const { width, height } = session.size
    // checkerboard under transparency
    if (session.transparent) {
      const x0 = Math.max(0, view.ox)
      const y0 = Math.max(0, view.oy)
      const x1 = Math.min(cssW, view.ox + width * view.scale)
      const y1 = Math.min(cssH, view.oy + height * view.scale)
      const cell = 8
      for (let y = Math.floor(y0 / cell) * cell; y < y1; y += cell) {
        for (let x = Math.floor(x0 / cell) * cell; x < x1; x += cell) {
          g.fillStyle = ((x + y) / cell) % 2 ? '#3a3a40' : '#2c2c31'
          g.fillRect(Math.max(x, x0), Math.max(y, y0), Math.min(cell, x1 - x), Math.min(cell, y1 - y))
        }
      }
    }
    g.save()
    g.translate(view.ox, view.oy)
    g.scale(view.scale, view.scale)
    g.imageSmoothingEnabled = !(pixel && view.scale >= 1)
    g.drawImage(imageCanvas, 0, 0)
    if (maskCanvas && !before) g.drawImage(maskCanvas, 0, 0)
    g.restore()

    // pixel grid
    if (pixel && view.scale >= 8) {
      g.strokeStyle = 'rgba(255,255,255,0.12)'
      g.lineWidth = 1
      g.beginPath()
      const xa = Math.max(0, Math.floor(-view.ox / view.scale))
      const xb = Math.min(width, Math.ceil((cssW - view.ox) / view.scale))
      const ya = Math.max(0, Math.floor(-view.oy / view.scale))
      const yb = Math.min(height, Math.ceil((cssH - view.oy) / view.scale))
      for (let x = xa; x <= xb; x += 1) {
        const sx = Math.round(view.ox + x * view.scale) + 0.5
        g.moveTo(sx, view.oy + ya * view.scale)
        g.lineTo(sx, view.oy + yb * view.scale)
      }
      for (let y = ya; y <= yb; y += 1) {
        const sy = Math.round(view.oy + y * view.scale) + 0.5
        g.moveTo(view.ox + xa * view.scale, sy)
        g.lineTo(view.ox + xb * view.scale, sy)
      }
      g.stroke()
    }

    // region frame + working size
    const plan = gen ? session.plan(gen, settings) : null
    if (plan && !before) {
      const sx = view.ox + plan.x * view.scale
      const sy = view.oy + plan.y * view.scale
      const sw = plan.w * view.scale
      const sh = plan.h * view.scale
      g.setLineDash([6, 4])
      g.strokeStyle = session.region ? '#ffd166' : '#6aa8ff'
      g.lineWidth = 1.5
      g.strokeRect(sx, sy, sw, sh)
      g.setLineDash([])
      const label = `${plan.workW}×${plan.workH}  ×${plan.scale.toFixed(2)}`
      g.font = '12px system-ui, sans-serif'
      const tw = g.measureText(label).width + 10
      g.fillStyle = 'rgba(0,0,0,0.65)'
      g.fillRect(sx, Math.max(0, sy - 20), tw, 18)
      g.fillStyle = '#fff'
      g.fillText(label, sx + 5, Math.max(0, sy - 20) + 13)
      if (tool === 'frame') {
        g.fillStyle = g.strokeStyle
        for (const [hx, hy] of [
          [sx, sy],
          [sx + sw, sy],
          [sx, sy + sh],
          [sx + sw, sy + sh],
        ] as Array<[number, number]>)
          g.fillRect(hx - 4, hy - 4, 8, 8)
      }
    }

    // rectangle in progress
    if (rectDrag) {
      const x = Math.min(rectDrag.x0, rectDrag.x1)
      const y = Math.min(rectDrag.y0, rectDrag.y1)
      g.strokeStyle = rectDrag.subtract ? '#ff6b6b' : '#ffffff'
      g.setLineDash([4, 3])
      g.strokeRect(view.ox + x * view.scale, view.oy + y * view.scale, Math.abs(rectDrag.x1 - rectDrag.x0) * view.scale, Math.abs(rectDrag.y1 - rectDrag.y0) * view.scale)
      g.setLineDash([])
    }
    // lasso in progress
    if (lasso && lasso.points.length > 0) {
      g.strokeStyle = '#ffffff'
      g.lineWidth = 1.5
      g.beginPath()
      lasso.points.forEach((p, i) => {
        const x = view.ox + p.x * view.scale
        const y = view.oy + p.y * view.scale
        if (i === 0) g.moveTo(x, y)
        else g.lineTo(x, y)
      })
      if (hover && !lasso.free) g.lineTo(view.ox + hover.x * view.scale, view.oy + hover.y * view.scale)
      g.stroke()
    }
    // brush cursor
    if (hover && (tool === 'brush' || tool === 'eraser')) {
      g.strokeStyle = tool === 'eraser' ? '#ff6b6b' : '#ffffff'
      g.lineWidth = 1
      g.beginPath()
      g.arc(view.ox + hover.x * view.scale, view.oy + hover.y * view.scale, Math.max(1, (brush / 2) * view.scale), 0, Math.PI * 2)
      g.stroke()
    }
  }

  // ── mask ops ──────────────────────────────────────────────────────────────
  function maskOp(fn: (m: MaskData) => Rect | null): void {
    if (!session) return
    session.history.begin()
    const rect = fn(session.mask)
    session.history.commit(rect)
    afterMask(rect)
  }

  function afterMask(rect: Rect | null): void {
    refreshMask(rect)
    updateUndo()
    changed('mask')
  }

  function undo(): void {
    const r = session?.history.undo()
    if (r) afterMask(r)
  }
  function redo(): void {
    const r = session?.history.redo()
    if (r) afterMask(r)
  }
  function updateUndo(): void {
    undoBtn.disabled = !session?.history.canUndo
    redoBtn.disabled = !session?.history.canRedo
  }

  function closeLasso(): void {
    if (!session || !lasso) return
    const pts = lasso.points
    lasso = null
    if (pts.length >= 3) maskOp((m) => fillPolygon(m, pts, 'add'))
    else draw()
  }

  // ── pointer input ─────────────────────────────────────────────────────────
  const pointers = new Map<number, { x: number; y: number }>()
  let gesture:
    | { kind: 'pan'; sx: number; sy: number; ox: number; oy: number }
    | { kind: 'paint'; last: { x: number; y: number }; box: Rect | null; erase: boolean }
    | { kind: 'rect' }
    | { kind: 'lasso'; start: { x: number; y: number }; moved: boolean }
    | { kind: 'frame'; mode: 'move' | 'new' | 'nw' | 'ne' | 'sw' | 'se'; start: { x: number; y: number }; orig: Rect }
    | { kind: 'pinch'; dist: number; mid: { x: number; y: number } }
    | null = null
  let spaceDown = false

  function frameHit(p: { x: number; y: number }, region: Rect): 'move' | 'nw' | 'ne' | 'sw' | 'se' | null {
    const tol = 8 / view.scale
    const corners: Array<['nw' | 'ne' | 'sw' | 'se', number, number]> = [
      ['nw', region.x, region.y],
      ['ne', region.x + region.w, region.y],
      ['sw', region.x, region.y + region.h],
      ['se', region.x + region.w, region.y + region.h],
    ]
    for (const [k, x, y] of corners) if (Math.abs(p.x - x) <= tol && Math.abs(p.y - y) <= tol) return k
    if (p.x >= region.x && p.x <= region.x + region.w && p.y >= region.y && p.y <= region.y + region.h) return 'move'
    return null
  }

  function onPointerDown(e: PointerEvent): void {
    if (!session) return
    root.focus({ preventScroll: true })
    canvas.setPointerCapture(e.pointerId)
    const s = local(e)
    pointers.set(e.pointerId, s)
    if (pointers.size === 2) {
      // second finger: pinch replaces whatever the first one started
      if (gesture?.kind === 'paint' || gesture?.kind === 'lasso') session.history.commit(gesture.kind === 'paint' ? gesture.box : null)
      const [a, b] = [...pointers.values()] as [{ x: number; y: number }, { x: number; y: number }]
      gesture = { kind: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } }
      rectDrag = null
      return
    }
    if (e.button === 1 || spaceDown || e.button === 2) {
      gesture = { kind: 'pan', sx: s.x, sy: s.y, ox: view.ox, oy: view.oy }
      e.preventDefault()
      return
    }
    if (e.button !== 0) return
    const p = toImage(s.x, s.y)
    if (tool === 'brush' || tool === 'eraser') {
      const erase = tool === 'eraser' || e.altKey
      session.history.begin()
      const box = stroke(session.mask, p.x, p.y, p.x, p.y, brush / 2, hardness, erase ? 'subtract' : 'add')
      gesture = { kind: 'paint', last: p, box, erase }
      refreshMask(box)
    } else if (tool === 'rect') {
      rectDrag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, subtract: e.altKey }
      gesture = { kind: 'rect' }
    } else if (tool === 'lasso') {
      if (lasso && !lasso.free) {
        const first = lasso.points[0]!
        if (Math.hypot((first.x - p.x) * view.scale, (first.y - p.y) * view.scale) < 10) {
          closeLasso()
          gesture = null
          return
        }
      }
      gesture = { kind: 'lasso', start: p, moved: false }
      if (!lasso) lasso = { points: [p], free: false }
    } else if (tool === 'frame') {
      const plan = gen ? session.plan(gen, settings) : null
      const region = session.region ?? (plan ? { x: plan.x, y: plan.y, w: plan.w, h: plan.h } : null)
      const hit = region ? frameHit(p, region) : null
      gesture = { kind: 'frame', mode: hit ?? 'new', start: p, orig: region ?? { x: p.x, y: p.y, w: 0, h: 0 } }
    }
    draw()
  }

  function onPointerMove(e: PointerEvent): void {
    const s = local(e)
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, s)
    hover = toImage(s.x, s.y)
    if (!session) return
    if (!gesture) {
      draw()
      return
    }
    const p = hover
    switch (gesture.kind) {
      case 'pinch': {
        if (pointers.size < 2) return
        const [a, b] = [...pointers.values()] as [{ x: number; y: number }, { x: number; y: number }]
        const dist = Math.hypot(a.x - b.x, a.y - b.y)
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
        view = { ...view, ox: view.ox + mid.x - gesture.mid.x, oy: view.oy + mid.y - gesture.mid.y }
        if (gesture.dist > 0) zoomAt(dist / gesture.dist, mid.x, mid.y)
        gesture = { kind: 'pinch', dist, mid }
        draw()
        return
      }
      case 'pan':
        view = { ...view, ox: gesture.ox + s.x - gesture.sx, oy: gesture.oy + s.y - gesture.sy }
        draw()
        return
      case 'paint': {
        const box = stroke(session.mask, gesture.last.x, gesture.last.y, p.x, p.y, brush / 2, hardness, gesture.erase ? 'subtract' : 'add')
        gesture.box = union(gesture.box, box)
        gesture.last = p
        refreshMask(box)
        return
      }
      case 'rect':
        if (rectDrag) {
          rectDrag.x1 = p.x
          rectDrag.y1 = p.y
        }
        draw()
        return
      case 'lasso': {
        const d = Math.hypot((p.x - gesture.start.x) * view.scale, (p.y - gesture.start.y) * view.scale)
        if (!gesture.moved && d > 4 && lasso && lasso.points.length === 1) {
          gesture.moved = true
          lasso.free = true
        }
        if (lasso?.free) {
          const last = lasso.points[lasso.points.length - 1]!
          if (Math.hypot((p.x - last.x) * view.scale, (p.y - last.y) * view.scale) > 3) lasso.points.push(p)
        }
        draw()
        return
      }
      case 'frame': {
        const { width, height } = session.size
        const dx = p.x - gesture.start.x
        const dy = p.y - gesture.start.y
        const o = gesture.orig
        let r: Rect
        if (gesture.mode === 'move') r = { x: clamp(o.x + dx, 0, width - o.w), y: clamp(o.y + dy, 0, height - o.h), w: o.w, h: o.h }
        else if (gesture.mode === 'new') r = { x: Math.min(gesture.start.x, p.x), y: Math.min(gesture.start.y, p.y), w: Math.abs(dx), h: Math.abs(dy) }
        else {
          let x0 = o.x
          let y0 = o.y
          let x1 = o.x + o.w
          let y1 = o.y + o.h
          if (gesture.mode.includes('w')) x0 += dx
          if (gesture.mode.includes('e')) x1 += dx
          if (gesture.mode.includes('n')) y0 += dy
          if (gesture.mode.includes('s')) y1 += dy
          r = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) }
        }
        const x = clamp(Math.round(r.x), 0, width - 1)
        const y = clamp(Math.round(r.y), 0, height - 1)
        if (r.w >= 2 && r.h >= 2) session.region = { x, y, w: clamp(Math.round(r.w), 1, width - x), h: clamp(Math.round(r.h), 1, height - y) }
        updatePlan()
        draw()
        return
      }
    }
  }

  function onPointerUp(e: PointerEvent): void {
    pointers.delete(e.pointerId)
    if (!session || !gesture) return
    const g0 = gesture
    if (g0.kind === 'pinch') {
      if (pointers.size < 2) gesture = null
      return
    }
    gesture = null
    if (g0.kind === 'paint') {
      session.history.commit(g0.box)
      updateUndo()
      changed('mask')
    } else if (g0.kind === 'rect' && rectDrag) {
      const r = rectDrag
      rectDrag = null
      const rect = { x: Math.min(r.x0, r.x1), y: Math.min(r.y0, r.y1), w: Math.abs(r.x1 - r.x0), h: Math.abs(r.y1 - r.y0) }
      if (rect.w >= 1 && rect.h >= 1) maskOp((m) => fillRect(m, rect, r.subtract || tool === 'eraser' ? 'subtract' : 'add'))
      else draw()
    } else if (g0.kind === 'lasso' && lasso) {
      if (lasso.free) closeLasso()
      else {
        const p = toImage(local(e).x, local(e).y)
        if (lasso.points.length > 1 || Math.hypot(p.x - lasso.points[0]!.x, p.y - lasso.points[0]!.y) > 0) {
          const last = lasso.points[lasso.points.length - 1]!
          if (last.x !== p.x || last.y !== p.y) lasso.points.push(p)
        }
        draw()
      }
    } else if (g0.kind === 'frame') {
      changed('settings')
    }
  }

  function onWheel(e: WheelEvent): void {
    if (!session) return
    e.preventDefault()
    const s = local(e)
    // trackpad pinch arrives as ctrl+wheel
    const k = e.ctrlKey ? 0.01 : 0.0015
    zoomAt(Math.exp(-e.deltaY * k), s.x, s.y)
  }

  canvas.addEventListener('pointerdown', onPointerDown)
  canvas.addEventListener('pointermove', onPointerMove)
  canvas.addEventListener('pointerup', onPointerUp)
  canvas.addEventListener('pointercancel', onPointerUp)
  canvas.addEventListener('pointerleave', () => {
    hover = null
    draw()
  })
  canvas.addEventListener('dblclick', () => {
    if (lasso && !lasso.free) closeLasso()
  })
  canvas.addEventListener('wheel', onWheel, { passive: false })
  canvas.addEventListener('contextmenu', (e) => e.preventDefault())

  // ── keys ──────────────────────────────────────────────────────────────────
  const active = (): boolean => root.contains(document.activeElement) || root.matches(':hover')
  function onKeyDown(e: KeyboardEvent): void {
    if (destroyed || !session || !active() || inEditable(e.target)) return
    const mod = e.metaKey || e.ctrlKey
    const key = e.key.toLowerCase()
    let handled = true
    if (mod && key === 'z') e.shiftKey ? redo() : undo()
    else if (mod && key === 'y') redo()
    else if (mod) handled = false
    else if (e.code === 'Space') spaceDown = true
    else if (key === 'b') setTool('brush')
    else if (key === 'e') setTool('eraser')
    else if (key === 'l') setTool('lasso')
    else if (key === 'm') setTool('rect')
    else if (key === 'f') setTool('frame')
    else if (key === '[') sizeBy(-1)
    else if (key === ']') sizeBy(1)
    else if (key === '0') fit()
    else if (key === '1') zoomTo(1)
    else if (key === 'p') setPixel(!pixel)
    else if (key === '\\') setBefore(true)
    else if (key === 'arrowleft') stepLayer(-1)
    else if (key === 'arrowright') stepLayer(1)
    else if (key === 'enter' && lasso) closeLasso()
    else if (key === 'escape' && lasso) {
      lasso = null
      draw()
    } else handled = false
    if (handled) {
      e.preventDefault()
      e.stopPropagation()
    }
  }
  function onKeyUp(e: KeyboardEvent): void {
    if (e.code === 'Space') spaceDown = false
    if (e.key === '\\' && before) setBefore(false)
  }
  globalThis.addEventListener('keydown', onKeyDown, true)
  globalThis.addEventListener('keyup', onKeyUp, true)

  function sizeBy(dir: number): void {
    brush = clamp(Math.round(brush * (dir > 0 ? 1.25 : 0.8)), 1, 400)
    sizeIn.value = String(brush)
    draw()
  }

  // ── panel: generator, prompt, region ──────────────────────────────────────
  const field = (label: string, input: El, extra?: El): HTMLDivElement => h('div', { class: 'tp-row' }, h('label', {}, label), input, extra ?? null)

  function paramInput(f: ParamField): El {
    const cur = settings.params[f.key] ?? f.default
    if (f.type === 'select') {
      const sel = h('select', { class: 'tp-in', 'data-testid': 'paint-param', 'data-key': f.key })
      for (const o of f.options ?? []) sel.append(h('option', { value: o.value, selected: String(cur) === o.value }, o.label ?? o.value))
      sel.addEventListener('change', () => setParam(f.key, sel.value))
      return sel
    }
    if (f.type === 'checkbox') {
      const cb = h('input', { type: 'checkbox', 'data-testid': 'paint-param', 'data-key': f.key, checked: cur === true })
      cb.addEventListener('change', () => setParam(f.key, cb.checked))
      return cb
    }
    const inp = h('input', {
      class: 'tp-in',
      type: f.type === 'number' ? 'number' : 'text',
      'data-testid': 'paint-param',
      'data-key': f.key,
      value: cur === undefined ? '' : String(cur),
      min: f.min,
      max: f.max,
      step: f.step,
      placeholder: f.hint,
    })
    inp.addEventListener('change', () => setParam(f.key, f.type === 'number' ? (inp.value === '' ? undefined : Number(inp.value)) : inp.value))
    return inp
  }

  function setParam(key: string, value: unknown): void {
    const params = { ...settings.params }
    if (value === undefined || value === '') delete params[key]
    else params[key] = value
    settings = { ...settings, params }
    changed('settings')
  }

  function defaultsOf(g: Generator): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const f of g.params ?? []) if (f.default !== undefined) out[f.key] = f.default
    return out
  }

  function renderGen(): void {
    genSec.replaceChildren()
    if (generators.length === 0) {
      genSec.append(h('div', { class: 'tp-note' }, L.noGenerators))
      return
    }
    if (generators.length > 1) {
      const sel = h('select', { class: 'tp-in', 'data-testid': 'paint-generator' })
      for (const x of generators) sel.append(h('option', { value: x.id, selected: x === gen }, x.label))
      sel.addEventListener('change', () => {
        gen = generators.find((x) => x.id === sel.value) ?? gen
        settings = { ...settings, params: { ...defaultsOf(gen!), ...options.defaults?.params } }
        renderAll()
        changed('settings')
      })
      genSec.append(field(L.generator, sel))
    } else genSec.append(h('h4', {}, gen!.label))
    genSec.append(h('div', { class: 'tp-note', 'data-testid': 'paint-mode', 'data-mode': gen!.caps.mask ? 'inpaint' : 'instruction' }, gen!.caps.mask ? L.inpaint : L.instruction))
    for (const f of gen!.params ?? []) genSec.append(field(f.label, paramInput(f)))
    if (options.presets?.length) {
      const row = h('div', { class: 'tp-row' }, h('label', {}, L.presets))
      for (const p of options.presets) row.append(btn(p.label, { 'data-testid': 'paint-preset', 'data-id': p.id }, () => applyPreset(p.id)))
      genSec.append(row)
    }
  }

  function numberInput(key: 'denoise' | 'padding' | 'workSide' | 'feather', attrs: Record<string, number>): HTMLInputElement {
    const inp = h('input', { class: 'tp-in', type: 'number', 'data-testid': `paint-${key}`, value: settings[key], ...attrs })
    inp.addEventListener('change', () => {
      const v = Number(inp.value)
      if (!Number.isFinite(v)) return
      settings = { ...settings, [key]: v }
      updatePlan()
      draw()
      changed('settings')
    })
    return inp
  }

  function renderPrompt(): void {
    promptSec.replaceChildren()
    if (!gen) return
    const prompt = h('textarea', { class: 'tp-in', 'data-testid': 'paint-prompt', rows: 3, placeholder: gen.caps.mask ? L.promptHint : L.instructionHint })
    prompt.value = settings.prompt
    prompt.addEventListener('input', () => (settings = { ...settings, prompt: prompt.value }))
    promptSec.append(h('h4', {}, L.prompt), prompt)
    if (gen.caps.negative) {
      const neg = h('textarea', { class: 'tp-in', 'data-testid': 'paint-negative', rows: 2 })
      neg.value = settings.negative
      neg.addEventListener('input', () => (settings = { ...settings, negative: neg.value }))
      promptSec.append(field(L.negative, neg))
    }
    if (gen.caps.denoise) promptSec.append(field(L.denoise, numberInput('denoise', { min: 0, max: 1, step: 0.05 })))
    const seed = h('input', { class: 'tp-in', type: 'number', 'data-testid': 'paint-seed', placeholder: L.seedRandom, value: settings.seed ?? '' })
    seed.addEventListener('change', () => (settings = { ...settings, seed: seed.value === '' ? null : Math.round(Number(seed.value)) }))
    promptSec.append(field(L.seed, seed))
    const max = Math.max(1, gen.caps.variants ?? 4)
    if (max > 1) {
      const n = h('select', { class: 'tp-in', 'data-testid': 'paint-variants' })
      for (let i = 1; i <= max; i += 1) n.append(h('option', { value: i, selected: settings.n === i }, String(i)))
      n.addEventListener('change', () => (settings = { ...settings, n: Number(n.value) }))
      promptSec.append(field(L.variants, n))
    }
  }

  const planNote = h('div', { class: 'tp-note', 'data-testid': 'paint-plan' })
  function updatePlan(): void {
    if (!session || !gen) {
      planNote.textContent = ''
      return
    }
    const plan = session.plan(gen, settings)
    if (!plan) {
      planNote.textContent = L.noRegion
      delete planNote.dataset.work
      return
    }
    planNote.dataset.work = `${plan.workW}x${plan.workH}`
    planNote.dataset.crop = `${plan.x},${plan.y},${plan.w},${plan.h}`
    planNote.textContent = `${plan.w}×${plan.h} → ${plan.workW}×${plan.workH} (×${plan.scale.toFixed(2)})${session.region ? '' : ` · ${L.regionAuto}`}`
  }

  function renderRegion(): void {
    regionSec.replaceChildren()
    if (!gen) return
    const alpha = h('select', { class: 'tp-in', 'data-testid': 'paint-alpha' })
    for (const [v, label] of [
      ['auto', L.alphaAuto],
      ['keep', L.alphaKeep],
      ['result', L.alphaResult],
      ...(options.matter ? [['matte', L.alphaMatte]] : []),
    ] as Array<[string, string]>)
      alpha.append(h('option', { value: v, selected: settings.alpha === v }, label))
    alpha.addEventListener('change', () => (settings = { ...settings, alpha: alpha.value as EditSettings['alpha'] }))
    const cm = h('input', { type: 'checkbox', 'data-testid': 'paint-colormatch', checked: settings.colorMatch })
    cm.addEventListener('change', () => (settings = { ...settings, colorMatch: cm.checked }))
    const reset = btn(L.regionReset, { 'data-testid': 'paint-region-reset' }, () => {
      if (session) session.region = null
      updatePlan()
      draw()
    })
    regionSec.append(
      h('h4', {}, L.region),
      planNote,
      field(L.padding, numberInput('padding', { min: 0, step: 8 })),
      field(L.workSide, numberInput('workSide', { min: 64, step: 64 })),
      field(L.feather, numberInput('feather', { min: 0, step: 1 })),
      field(L.alpha, alpha),
      field(L.colorMatch, cm),
      h('div', { class: 'tp-row' }, reset),
    )
    updatePlan()
  }

  const genBtn = btn(L.generate, { 'data-testid': 'paint-generate', class: 'tp-btn tp-primary' }, () => void generate())
  const stopBtn = btn(L.stop, { 'data-testid': 'paint-stop', hidden: true }, () => running?.abort())
  const series = h('textarea', { class: 'tp-in', 'data-testid': 'paint-series', rows: 3, placeholder: L.seriesHint })
  const seriesBtn = btn(L.seriesRun, { 'data-testid': 'paint-series-run' }, () => void runSeries())
  function renderRun(): void {
    runSec.replaceChildren(h('div', { class: 'tp-row' }, genBtn, stopBtn), prog, previewImg, status, h('h4', {}, L.series), series, h('div', { class: 'tp-row' }, seriesBtn))
    genBtn.disabled = !gen
    seriesBtn.disabled = !gen
  }

  function renderCandidates(): void {
    candSec.replaceChildren()
    candSec.hidden = candidates.length === 0
    if (candidates.length === 0) return
    const grid = h('div', { class: 'tp-cands' })
    candidates.forEach((c, i) => {
      const url = URL.createObjectURL(c.output)
      urls.push(url)
      const b = h('button', { type: 'button', class: 'tp-cand', 'data-testid': 'paint-candidate', 'data-index': i, 'aria-pressed': i === picked }, h('img', { src: url, alt: '' }))
      b.addEventListener('click', () => {
        picked = i
        renderCandidates()
        refreshImage()
      })
      grid.append(b)
    })
    const name = h('input', { class: 'tp-in', 'data-testid': 'paint-layer-name', value: settings.prompt.slice(0, 40) })
    const use = btn(L.use, { 'data-testid': 'paint-use', class: 'tp-btn tp-primary', disabled: picked < 0 }, () => {
      if (!session || picked < 0 || !candidates[picked]) return
      session.addLayer(candidates[picked]!, name.value || settings.prompt.slice(0, 40))
      candidates = []
      picked = -1
      renderCandidates()
      renderLayers()
      refreshImage()
      changed('layers')
    })
    candSec.append(h('h4', {}, L.candidates), grid, h('div', { class: 'tp-row' }, name, use))
  }

  function stepLayer(dir: number): void {
    if (!session) return
    const ids: Array<string | null> = [null, ...session.layers.map((l) => l.id)]
    const i = ids.indexOf(session.active)
    session.active = ids[(i + dir + ids.length) % ids.length] ?? null
    picked = -1
    renderLayers()
    refreshImage()
  }

  function renderLayers(): void {
    layerSec.replaceChildren(h('h4', {}, L.layers))
    if (!session) return
    root.dataset.layers = String(session.layers.length)
    const list = h('div', { class: 'tp-layers', role: 'listbox' })
    const row = (id: string | null, label: string): HTMLDivElement => {
      const r = h('div', { class: 'tp-layer', role: 'option', 'data-testid': id ? 'paint-layer' : 'paint-layer-base', 'data-id': id ?? '', 'data-name': label, 'aria-selected': session!.active === id }, h('span', {}, label))
      r.addEventListener('click', () => {
        session!.active = id
        picked = -1
        renderLayers()
        refreshImage()
      })
      return r
    }
    list.append(row(null, L.base))
    for (const l of session.layers) {
      const r = row(l.id, l.name)
      const rename = h('button', { type: 'button', class: 'tp-x', title: L.rename, 'data-testid': 'paint-layer-rename' }, '✎')
      rename.addEventListener('click', (e) => {
        e.stopPropagation()
        const inp = h('input', { class: 'tp-in', value: l.name })
        r.firstChild!.replaceWith(inp)
        inp.focus()
        const done = (): void => {
          session!.renameLayer(l.id, inp.value)
          renderLayers()
          changed('layers')
        }
        inp.addEventListener('blur', done)
        inp.addEventListener('keydown', (k) => {
          if (k.key === 'Enter') inp.blur()
          k.stopPropagation()
        })
      })
      const del = h('button', { type: 'button', class: 'tp-x', title: L.remove, 'data-testid': 'paint-layer-delete' }, '×')
      del.addEventListener('click', (e) => {
        e.stopPropagation()
        session!.removeLayer(l.id)
        renderLayers()
        refreshImage()
        changed('layers')
      })
      r.append(rename, del)
      list.append(r)
    }
    layerSec.append(list)
    const apply = btn(L.apply, { 'data-testid': 'paint-apply', disabled: !session.active }, () => {
      if (!session?.active) return
      session.applyLayer(session.active)
      renderLayers()
      refreshImage()
      changed('apply')
    })
    layerSec.append(h('div', { class: 'tp-row' }, apply))
    for (const [a, b] of actionBtns) b.hidden = a.when === 'layers' && session.layers.length === 0
  }

  function renderAll(): void {
    renderGen()
    renderPrompt()
    renderRegion()
    renderRun()
    renderCandidates()
    renderLayers()
  }

  function applyPreset(id: string): void {
    const p = options.presets?.find((x) => x.id === id)
    if (!p) return
    const { params, ...rest } = p.values
    settings = { ...settings, ...rest, params: { ...settings.params, ...params } }
    renderAll()
    draw()
    changed('settings')
  }

  // ── generation ────────────────────────────────────────────────────────────
  function setRunning(ctrl: AbortController | null): void {
    running = ctrl
    root.dataset.state = ctrl ? 'running' : 'idle'
    genBtn.disabled = !!ctrl || !gen
    seriesBtn.disabled = !!ctrl || !gen
    stopBtn.hidden = !ctrl
    prog.hidden = !ctrl
    if (!ctrl) {
      previewImg.hidden = true
      ;(prog.firstChild as HTMLElement).style.width = '0'
    }
  }

  const io = (ctrl: AbortController) => ({
    signal: ctrl.signal,
    progress: (p: { value?: number; preview?: Blob; text?: string }) => {
      if (p.value !== undefined) (prog.firstChild as HTMLElement).style.width = `${Math.round(clamp(p.value, 0, 1) * 100)}%`
      if (p.text) say(p.text)
      if (p.preview) {
        const url = URL.createObjectURL(p.preview)
        urls.push(url)
        previewImg.src = url
        previewImg.hidden = false
      }
    },
  })

  async function generate(): Promise<void> {
    if (!session || !gen || running) return
    const ctrl = new AbortController()
    setRunning(ctrl)
    say(L.running)
    try {
      const out = await session.generate(gen, settings, io(ctrl), options.matter)
      if (ctrl.signal.aborted) return say(L.stopped)
      candidates = out
      picked = out.length > 0 ? 0 : -1
      say('')
      renderCandidates()
      refreshImage()
      changed('generate')
    } catch (err) {
      if (ctrl.signal.aborted) say(L.stopped)
      else fail(err)
    } finally {
      setRunning(null)
    }
  }

  /** One mask, several prompts, one fixed seed, low denoise → a layer per state. */
  async function runSeries(): Promise<void> {
    if (!session || !gen || running) return
    const items = parseSeries(series.value)
    if (items.length === 0) return
    const ctrl = new AbortController()
    setRunning(ctrl)
    const seed = settings.seed ?? Math.floor(Math.random() * 2 ** 31)
    try {
      for (const [i, item] of items.entries()) {
        if (ctrl.signal.aborted) break
        say(`${L.running} ${i + 1}/${items.length} · ${item.name}`)
        const [c] = await session.generate(gen, { ...settings, prompt: item.prompt, seed, n: 1 }, io(ctrl), options.matter)
        if (c) session.addLayer(c, item.name)
        renderLayers()
        refreshImage()
        changed('layers')
      }
      say(ctrl.signal.aborted ? L.stopped : '')
    } catch (err) {
      if (ctrl.signal.aborted) say(L.stopped)
      else fail(err)
    } finally {
      setRunning(null)
    }
  }

  async function runAction(a: EditorAction): Promise<void> {
    try {
      await a.run(handle)
    } catch (err) {
      fail(err)
    }
  }

  // ── start ─────────────────────────────────────────────────────────────────
  renderAll()
  setTool('brush')
  updateUndo()

  const ready = (async () => {
    try {
      session = options.image instanceof Blob ? await EditSession.fromBlob(options.image) : new EditSession(options.image)
      if (destroyed) return
      const small = Math.max(session.size.width, session.size.height) <= 256
      setPixel(options.pixel === 'auto' || options.pixel === undefined ? small : options.pixel)
      if (gen) settings = { ...settings, params: { ...defaultsOf(gen), ...settings.params } }
      if (small && options.defaults?.padding === undefined) settings = { ...settings, padding: Math.max(4, Math.round(settings.padding / 4)) }
      brush = clamp(Math.round(Math.max(session.size.width, session.size.height) / 40), 2, 200)
      sizeIn.value = String(brush)
      renderAll()
      refreshImage()
      refreshMask()
      root.dataset.state = 'idle'
      root.dataset.size = `${session.size.width}x${session.size.height}`
      cssW = 0
      resize()
    } catch (err) {
      root.dataset.state = 'error'
      fail(err)
      throw err
    }
  })()
  ready.catch(() => undefined)

  const handle: EditorHandle = {
    ready,
    async export() {
      await ready
      return rasterToBlob(shownRaster()!)
    },
    async exportLayers() {
      await ready
      return session!.exportLayers()
    },
    layers: () => session?.layers.slice() ?? [],
    chain: () => session?.chain() ?? [],
    settings: () => ({ ...settings, params: { ...settings.params } }),
    setSettings(patch) {
      settings = { ...settings, ...patch, params: { ...settings.params, ...patch.params } }
      renderAll()
      draw()
    },
    applyPreset,
    generator: () => gen,
    mask: () => session?.mask ?? null,
    base: () => session?.base ?? null,
    generate,
    destroy() {
      if (destroyed) return
      destroyed = true
      running?.abort()
      if (frame) cancelAnimationFrame(frame)
      ro?.disconnect()
      globalThis.removeEventListener('keydown', onKeyDown, true)
      globalThis.removeEventListener('keyup', onKeyUp, true)
      for (const u of urls) URL.revokeObjectURL(u)
      root.remove()
    },
  }
  return handle
}
