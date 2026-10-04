// layout.ts — screen geometry as pure math; the reference size is the scene's viewBox.
//
// Every screen is a Trempel scene authored in its reference frame (viewBox = design resolution) and
// scaled like a Unity CanvasScaler / Cocos design resolution. A portrait game keeps a portrait
// COLUMN on a landscape window (centred, at most `maxAspect` wide); the rest of the window is the
// backdrop. Orientation is never locked (Playables MUST NOT lock it); a resize re-lays everything
// out and keeps the state.
//
// Fit policies by name (Cocos/Unity), the safe area (notches: CSS env(safe-area-inset-*)) and
// the PLAYFIELD — the screen minus the HUD zones the game declares and the safe area; the game fits
// its world into it.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Distances from the four edges (px or reference units, by context). */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const NO_INSETS: Readonly<Insets> = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 });

/** Column inside a window W×H (px), at most `maxAspect` (w/h) wide; no limit when undefined. */
export function column(W: number, H: number, maxAspect?: number): Rect {
  const w = maxAspect ? Math.min(W, H * maxAspect) : W;
  return { x: (W - w) / 2, y: 0, w, h: H };
}

/**
 * Fit policies (design resolution → column):
 *  - fitWidth  — scale by width; the canvas height follows the window (Cocos FIXED_WIDTH);
 *  - fitHeight — scale by height (FIXED_HEIGHT);
 *  - fitMin    — the whole design fits; the canvas grows along the free axis and anchored nodes
 *                move outwards (Unity Expand) — the default;
 *  - fitMax    — cover: the design covers the column, the canvas is cropped (Unity Shrink, Cocos
 *                NO_BORDER);
 *  - showAll   — letterbox: the design fits and the canvas IS the design (nothing is anchored
 *                outwards, the bars are the backdrop) (Cocos SHOW_ALL).
 * v0 names stay valid: expand = fitMin, shrink = fitMax, width = fitWidth, height = fitHeight.
 */
export type FitPolicy = 'fitWidth' | 'fitHeight' | 'fitMin' | 'fitMax' | 'showAll';
export type CanvasMode = FitPolicy | 'expand' | 'shrink' | 'width' | 'height';

const ALIAS: Record<CanvasMode, FitPolicy> = {
  fitWidth: 'fitWidth',
  fitHeight: 'fitHeight',
  fitMin: 'fitMin',
  fitMax: 'fitMax',
  showAll: 'showAll',
  expand: 'fitMin',
  shrink: 'fitMax',
  width: 'fitWidth',
  height: 'fitHeight',
};

/** The policy of a mode name (short aliases → policy names); fails loud on an unknown one. */
export function policyOf(mode: CanvasMode): FitPolicy {
  const p = ALIAS[mode];
  if (!p) throw new Error(`kit: unknown fit policy "${mode}" (known: ${Object.keys(ALIAS).join(', ')})`);
  return p;
}

export interface CanvasFit {
  /** Screen px per reference unit. */
  scale: number;
  /** Canvas size in reference units (one side is the reference side). */
  w: number;
  h: number;
  /** Offset of the canvas inside the column, px (showAll centres the design; 0 otherwise). */
  ox: number;
  oy: number;
}

export function canvas(mode: CanvasMode, colW: number, colH: number, refW: number, refH: number): CanvasFit {
  const policy = policyOf(mode);
  const sw = colW / refW;
  const sh = colH / refH;
  const scale = policy === 'fitWidth' ? sw : policy === 'fitHeight' ? sh : policy === 'fitMax' ? Math.max(sw, sh) : Math.min(sw, sh);
  if (policy === 'showAll') return { scale, w: refW, h: refH, ox: (colW - refW * scale) / 2, oy: (colH - refH * scale) / 2 };
  return { scale, w: colW / scale, h: colH / scale, ox: 0, oy: 0 };
}

/** The canvas of a fit as a window rect (px). */
export function canvasRect(col: Rect, fit: CanvasFit): Rect {
  return { x: col.x + fit.ox, y: col.y + fit.oy, w: fit.w * fit.scale, h: fit.h * fit.scale };
}

/** Insets of `inner` inside `outer` (how far each edge of inner is from outer's), never negative. */
export function insetsOf(outer: Rect, inner: Rect): Insets {
  return {
    top: Math.max(0, inner.y - outer.y),
    left: Math.max(0, inner.x - outer.x),
    bottom: Math.max(0, outer.y + outer.h - (inner.y + inner.h)),
    right: Math.max(0, outer.x + outer.w - (inner.x + inner.w)),
  };
}

/** A rect shrunk by insets (never negative size). */
export function inset(r: Rect, i: Insets): Rect {
  return { x: r.x + i.left, y: r.y + i.top, w: Math.max(0, r.w - i.left - i.right), h: Math.max(0, r.h - i.top - i.bottom) };
}

/** Safe rect of a window W×H (px) with the device's safe-area insets (px). */
export function safeRect(W: number, H: number, safe: Insets = NO_INSETS): Rect {
  return inset({ x: 0, y: 0, w: W, h: H }, safe);
}

/**
 * The playfield (px): the canvas of the design fit minus the safe area and the HUD zones (design
 * units, measured from the canvas edges the HUD is anchored to). The game fits its world into it.
 */
export function playfield(canvasPx: Rect, safe: Rect, hud: Partial<Insets>, scale: number): Rect {
  const s = insetsOf(canvasPx, safe);
  return inset(canvasPx, {
    top: s.top + (hud.top ?? 0) * scale,
    right: s.right + (hud.right ?? 0) * scale,
    bottom: s.bottom + (hud.bottom ?? 0) * scale,
    left: s.left + (hud.left ?? 0) * scale,
  });
}

/**
 * Offset of an anchored node so it stays inside the safe area: ax = 0 moves it by the left inset,
 * ax = 1 by minus the right one, 0.5 by half the difference (same for y). Reference units.
 */
export function safeShift(ax: number, ay: number, s: Insets): [number, number] {
  return [s.left * (1 - ax) - s.right * ax, s.top * (1 - ay) - s.bottom * ay];
}

/** Cover-fit scale of an image into a box. */
export function coverScale(boxW: number, boxH: number, imgW: number, imgH: number): number {
  return Math.max(boxW / imgW, boxH / imgH);
}

/** Contain-fit scale of an image into a box. */
export function containScale(boxW: number, boxH: number, imgW: number, imgH: number): number {
  return Math.min(boxW / imgW, boxH / imgH);
}

/** viewBox of an SVG document's root as [x, y, w, h]; throws when it has none. */
export function viewBoxOf(svg: string): [number, number, number, number] {
  const m = svg.match(/<svg\b[^>]*\bviewBox\s*=\s*["']([^"']+)["']/);
  if (!m) throw new Error('kit: scene base has no viewBox on <svg> — the reference size comes from it');
  const v = m[1].trim().split(/[\s,]+/).map(Number);
  if (v.length !== 4 || v.some((n) => !Number.isFinite(n)) || v[2] <= 0 || v[3] <= 0) throw new Error(`kit: bad viewBox "${m[1]}"`);
  return v as [number, number, number, number];
}
