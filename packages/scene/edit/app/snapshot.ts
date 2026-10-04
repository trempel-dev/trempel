// snapshot.ts — the scene layer as pixels at the viewBox's 1:1 size (batch 2): what the similarity
// macro compares with the reference, and the «снимок для видео» PNG (I2V: the rig in its rest pose
// on a plain background). Only the runtime's drawing — no reference, onion, handles or service
// outlines (those are DOM / other layers). The stage view (zoom, fit) is put back afterwards.

import { Graphics, Rectangle } from 'pixi.js';
import type { Editor } from './editor';

/** A box in scene units. */
export interface SceneBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** RGBA pixels, row by row (ImageData-like). */
export interface Pixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** The scene's viewBox (scene units); without one — the drawn area as the stage fit sees it. */
export function viewBoxOf(ed: Editor): SceneBox {
  const vb = ed.session?.viewBox;
  if (vb) return { x: vb.x, y: vb.y, width: vb.w, height: vb.h };
  const s = ed.world.scale.x || 1;
  return { x: -ed.world.position.x / s, y: -ed.world.position.y / s, width: ed.fit.width / s, height: ed.fit.height / s };
}

/** Run `fn` with the scene layer alone at 1:1, its viewBox at (0, 0); `background` — a colour or null. */
function atOneToOne<T>(ed: Editor, background: string | null, fn: (frame: Rectangle) => T): T {
  const vb = viewBoxOf(ed);
  const w = ed.world;
  const scale = { x: w.scale.x, y: w.scale.y };
  const pos = { x: w.position.x, y: w.position.y };
  const others = ed.holder.children.filter((c) => c !== w && c.visible);
  const bg = background ? new Graphics().rect(0, 0, Math.round(vb.width), Math.round(vb.height)).fill(background) : null;
  try {
    for (const c of others) c.visible = false;
    w.scale.set(1);
    w.position.set(-vb.x, -vb.y);
    if (bg) ed.holder.addChildAt(bg, 0);
    return fn(new Rectangle(0, 0, Math.round(vb.width), Math.round(vb.height)));
  } finally {
    bg?.destroy();
    w.scale.set(scale.x, scale.y);
    w.position.set(pos.x, pos.y);
    for (const c of others) c.visible = true;
  }
}

/** The scene layer's pixels at the viewBox's 1:1 size, cropped to `box` (scene units). */
export function scenePixels(ed: Editor, opts: { box?: SceneBox; background?: string | null } = {}): Pixels {
  const vb = viewBoxOf(ed);
  const all = atOneToOne(ed, opts.background ?? null, (frame) => ed.app.renderer.extract.pixels({ target: ed.holder, frame, resolution: 1 }));
  const full: Pixels = { width: all.width, height: all.height, data: all.pixels };
  if (!opts.box) return full;
  return crop(full, opts.box.x - vb.x, opts.box.y - vb.y, opts.box.width, opts.box.height);
}

/** A sub-rectangle of pixels (clamped to them; fractional edges widen outwards). */
export function crop(p: Pixels, x0: number, y0: number, w0: number, h0: number): Pixels {
  const x = Math.max(0, Math.floor(x0));
  const y = Math.max(0, Math.floor(y0));
  const w = Math.max(0, Math.min(p.width, Math.ceil(x0 + w0)) - x);
  const h = Math.max(0, Math.min(p.height, Math.ceil(y0 + h0)) - y);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let r = 0; r < h; r++) out.set(p.data.subarray(((y + r) * p.width + x) * 4, ((y + r) * p.width + x + w) * 4), r * w * 4);
  return { width: w, height: h, data: out };
}

/** PNG bytes of the scene layer at 1:1 on `background` (null — transparent). */
export async function scenePng(ed: Editor, background: string | null): Promise<Uint8Array> {
  const url = await atOneToOne(ed, background, (frame) => ed.app.renderer.extract.base64({ target: ed.holder, frame, resolution: 1, format: 'png' }));
  const bin = atob(url.replace(/^data:image\/png;base64,/, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** «2026-10-04 15.07.31» → a file-name stamp `20261004-150731`. */
export function stamp(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
