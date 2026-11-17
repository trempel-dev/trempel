// measure.ts — 9-slice borders measured on the art (pure): a border must hold
// everything that may not stretch — the transparent margin (shadow), the rounded corner and the rim.
// Per side, on the alpha-weighted colour profile: a column (row) belongs to the border while its
// profile across the image still differs from the middle column's (row's) — rounding shows in
// alpha, the rim in colour. +2 px margin, at most 45 % of the side.

export const SLICE_TOL = 0.035;
export const SLICE_MARGIN = 2;

export interface Pixels {
  w: number;
  h: number;
  /** Premultiplied RGBA 0..1. */
  px: Float32Array;
}

/** RGBA 0..255 (straight alpha) → premultiplied floats. */
export function premultiply(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number): Pixels {
  const px = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const a = rgba[i * 4 + 3] / 255;
    px[i * 4] = (rgba[i * 4] / 255) * a;
    px[i * 4 + 1] = (rgba[i * 4 + 1] / 255) * a;
    px[i * 4 + 2] = (rgba[i * 4 + 2] / 255) * a;
    px[i * 4 + 3] = a;
  }
  return { w, h, px };
}

function lineDiff(img: Pixels, axis: 'x' | 'y', i: number, ref: number): number {
  const { w, h, px } = img;
  const n = axis === 'x' ? h : w;
  let s = 0;
  for (let k = 0; k < n; k++) {
    const a = axis === 'x' ? (k * w + i) * 4 : (i * w + k) * 4;
    const b = axis === 'x' ? (k * w + ref) * 4 : (ref * w + k) * 4;
    for (let c = 0; c < 4; c++) s += Math.abs(px[a + c] - px[b + c]);
  }
  return s / (n * 4);
}

function border(img: Pixels, axis: 'x' | 'y', fromStart: boolean): number {
  const len = axis === 'x' ? img.w : img.h;
  const mid = Math.floor(len / 2);
  let last = 0;
  for (let d = 0; d < mid; d++) {
    const i = fromStart ? d : len - 1 - d;
    if (lineDiff(img, axis, i, mid) > SLICE_TOL) last = d + 1;
  }
  return Math.min(Math.floor(len * 0.45), last + SLICE_MARGIN);
}

/** 9-slice borders [left, top, right, bottom] of an image. */
export function measureSlice(img: Pixels): [number, number, number, number] {
  return [border(img, 'x', true), border(img, 'y', true), border(img, 'x', false), border(img, 'y', false)];
}
