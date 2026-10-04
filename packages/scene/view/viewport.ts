// viewport.ts — viewport presets and fitting a scene's viewBox into the stage (pure).
//
// The stage is what the snapshot captures. `scene` = the viewBox itself; an aspect preset grows
// the viewBox to that aspect (contain: the scene is fully visible, centred, at scale 1); a custom
// W×H stage fits the scene inside it.

export interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Viewport = { kind: 'scene' } | { kind: 'aspect'; w: number; h: number } | { kind: 'size'; w: number; h: number };

export const PRESETS = ['scene', '9:16', '9:19.5', '3:4', '16:9'] as const;

/** `scene` | `9:16` (aspect) | `1080x1920` (stage size in px). @throws on anything else. */
export function parseViewport(s: string): Viewport {
  const v = s.trim().toLowerCase();
  if (v === '' || v === 'scene') return { kind: 'scene' };
  const m = /^(\d+(?:\.\d+)?)\s*([:x×])\s*(\d+(?:\.\d+)?)$/.exec(v);
  if (m) {
    const w = Number(m[1]);
    const h = Number(m[3]);
    if (w > 0 && h > 0) return m[2] === ':' ? { kind: 'aspect', w, h } : { kind: 'size', w: Math.round(w), h: Math.round(h) };
  }
  throw new Error(`вьюпорт «${s}» не понят: ожидается scene, W:H (9:16) или WxH (1080x1920)`);
}

export function viewportLabel(v: Viewport): string {
  return v.kind === 'scene' ? 'scene' : v.kind === 'aspect' ? `${v.w}:${v.h}` : `${v.w}x${v.h}`;
}

/** viewBox="x y w h" of an SVG root; null when absent or broken. */
export function parseViewBox(attr: string | undefined): ViewBox | null {
  if (!attr) return null;
  const n = attr.trim().split(/[\s,]+/).map(Number);
  if (n.length !== 4 || n.some((x) => !Number.isFinite(x)) || n[2] <= 0 || n[3] <= 0) return null;
  return { x: n[0], y: n[1], w: n[2], h: n[3] };
}

export interface StageFit {
  /** Stage (canvas) size in px. */
  width: number;
  height: number;
  /** Scene root placement inside the stage. */
  scale: number;
  x: number;
  y: number;
}

/** Stage size and scene placement for a viewBox under a viewport. */
export function fitStage(vb: ViewBox, v: Viewport): StageFit {
  let width: number;
  let height: number;
  if (v.kind === 'scene') {
    width = vb.w;
    height = vb.h;
  } else if (v.kind === 'aspect') {
    const a = v.w / v.h;
    width = Math.max(vb.w, vb.h * a);
    height = width / a;
  } else {
    width = v.w;
    height = v.h;
  }
  width = Math.round(width);
  height = Math.round(height);
  const scale = Math.min(width / vb.w, height / vb.h);
  return {
    width,
    height,
    scale,
    x: (width - vb.w * scale) / 2 - vb.x * scale,
    y: (height - vb.h * scale) / 2 - vb.y * scale,
  };
}
