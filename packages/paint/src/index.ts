/**
 * @trempel/paint — zero-dependency image editor for generative edits.
 *
 * DOM + Canvas 2D only. Geometry and compositing are pure functions; the
 * editor UI and the HTTP adapter sit on top.
 */

export type {
  AlphaMode,
  CropPlan,
  EditRecord,
  ExportedLayers,
  GenerateIO,
  GenerateProgress,
  GenerateRequest,
  Generator,
  GeneratorCaps,
  Layer,
  LayerManifest,
  MaskData,
  Matter,
  ParamField,
  Raster,
  Rect,
  Size,
} from './types.js'
export { intersect, maskBBox, planCrop, planRegion, roundTo } from './geometry.js'
export {
  applyPatch,
  cloneRaster,
  createMask,
  createRaster,
  cropMask,
  cropRaster,
  cropScaled,
  extractPatch,
  featherMask,
  hasAlpha,
  maskScaled,
  parseColor,
  pasteBack,
  patchBounds,
  resizeMask,
  resizeRaster,
} from './raster.js'
export type { CropOptions, PasteOptions, ResizeMode } from './raster.js'
export { MaskHistory, clearMask, fillPolygon, fillRect, invertMask, stamp, stroke, union } from './mask.js'
export type { MaskOp } from './mask.js'
export { blobToRaster, encodePng, pngSize, rasterToBlob } from './png.js'
export { createHttpGenerator, describeHttpGenerator } from './http.js'
export type { HttpGeneratorOptions } from './http.js'
export { DEFAULT_SETTINGS, EditSession, parseSeries, slug } from './session.js'
export type { Candidate, EditSettings, RunIO } from './session.js'
export { createImageEditor } from './editor/editor.js'
export type { EditorAction, EditorHandle, ImageEditorOptions, Preset } from './editor/editor.js'
export { LABELS } from './editor/labels.js'
export type { Labels } from './editor/labels.js'
export { CSS } from './editor/styles.js'
