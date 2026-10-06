// pixi.ts — PixiBackend: SceneTree nodes → PixiJS v8 display tree, faithful to SVG where the
// base uses it (a base must look the same as a static mock in a browser and in the runtime):
//
//   - transform: translate / scale / rotate / matrix / skewX / skewY and chains (transform.ts);
//     an element's x/y sits inside its transform, as in SVG;
//   - opacity on any node, display="none" / visibility="hidden";
//   - text: font-family, font-weight, font-style, font-size, fill, stroke + stroke-width,
//     letter-spacing, text-anchor; y is the BASELINE (dominant-baseline middle/central/hanging
//     move it to the centre/top);
//   - rect: fill (incl. "none"), fill-opacity, rx/ry, stroke + stroke-width, stroke-opacity;
//   - (v0.7) path (d: M L H V C S Q T A Z, both cases), circle, ellipse, line: fill / fill-opacity /
//     fill-rule, stroke / stroke-width / stroke-opacity / stroke-linecap / stroke-linejoin. `d` goes
//     through the core's strict parser (geom/pathdata.ts) — what it cannot read is an error with
//     the node's id, never a dropped command;
//   - (v0.7) setClip: the <clipPath> shapes become one Graphics (fill only) — a child of the masked
//     node and its `mask`, so it follows the node's transform (SVG userSpaceOnUse);
//   - (v0.7) getProp — reads what setProp writes (rest pose for relative animation tracks);
//     setProp('href') on a group with exactly one <image> inside swaps that image (clip `tex`).
//   - image: sized after its texture is known; textures already in the Assets cache apply
//     synchronously, a stale load never overwrites a newer href. The size is applied relative
//     to the node's CURRENT transform (v0.6.1): a host that moved/scaled the node keeps that.
//
//   - (v0.8) setProp('mix-blend-mode', css) → blendMode (plus-lighter → add; Pixi children inherit);
//     'tint' on a sprite tints it, on a group — every image of its subtree; 'z' → zIndex, the parent
//     turns sortableChildren on (siblings keep their index as zIndex); data-pivot="x y" → Pixi pivot
//     with the same SVG matrix (position is where the pivot lands), kept through texture refits.
//   - (v0.9.1) stroke-dasharray / stroke-dashoffset / pathLength on path, circle, ellipse, line, rect —
//     Pixi has no dashes, so the outline is flattened (geom/outline.ts, once per shape) and the
//     visible dashes are stroked as open pieces; stroke-linecap / -linejoin on rect too. setProp /
//     getProp 'stroke-dashoffset', 'stroke-width', 'stroke-opacity' redraw the shape (clip columns
//     dash / strokeWidth / strokeAlpha); 'display' ('none' — hidden) shows / hides any node.
//
//   - (v1.0) <image data-slices="l t r b"> → NineSliceSprite (width/height — the panel's size, borders
//     1:1), <image data-tile="x|y|xy"> → TilingSprite — the default createImage. Slices that do not fit
//     the texture (no centre left) are a load error (whenReady). setProp('width' | 'height') on an
//     image resizes its SVG box (9-slice / tiling: the view itself, a sprite: its fit), on a rect —
//     redraws it (layout: data-stretch, MountedScene.setSize, clip columns width / height).
//   - (2.0) preserveAspectRatio on a plain <image> with width and height: `<align> slice` covers the
//     box (the texture is cut to the box's aspect — no mask), `<align> meet` contains it (letterboxed,
//     aligned); `none` or no attribute — the picture fills the box, as before.
//
// Extension (v0.6.1): a subclass makes its own <image> view with `createImage(attrs)` (e.g. a
// NineSliceSprite) and keeps cache / stale-href guard / sizing / readiness from the base;
// `track(load, label)` adds the subclass's own loads to whenReady().
//
// whenReady() resolves once every texture load started so far has settled (rejects with the
// list of hrefs that failed), so mount() can hand the host a "scene is fully drawn" promise.
//
// @internal — `@trempel/scene/internal/render/pixi`, for the kit and the editor: no stability promise.
// Stable (re-exported by @trempel/scene): PixiBackend, PixiBackendOptions, FontMetricsFn, ImageNode.

import {
  Assets,
  CanvasTextMetrics,
  Color,
  Container,
  Graphics,
  GraphicsPath,
  Matrix as PixiMatrix,
  NineSliceSprite,
  Rectangle,
  Sprite,
  Text,
  Texture,
  TilingSprite,
  type ContainerChild,
  type LineCap,
  type LineJoin,
  type TextStyleFontWeight,
} from 'pixi.js';
import { TrempelError, trempelError } from '../errors.js';
import { coded, within } from '../codes.js';
import { dashes, flatten, outlineLength, type Polyline } from '../geom/outline.js';
import { shapeCommands, type PathCmd } from '../geom/pathdata.js';
import { parseAxes, parseSlices } from '../layout.js';
import { parseAspect, parseDashArray, parseLineStyle, parseNumberAttr, parsePathLength, parsePivot, type AspectFit } from '../props.js';
import { localMatrix, multiply, parseTransform, type Matrix } from '../transform.js';
import type { Bounds, ClipShape, NodeHandle, PointerKind, RendererBackend } from './backend.js';

// Props with dedicated handling; everything else is treated as a nested path.
const NUMERIC_ATTRS = new Set(['x', 'y', 'width', 'height', 'alpha', 'rotation']);

const num = (v: string | undefined, d = 0): number => {
  if (v == null || v === '') return d;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : d;
};

/** A CSS/SVG colour → { color, alpha }, or null for "none"/unparseable. */
export function parseColor(value: string | undefined): { color: number; alpha: number } | null {
  if (!value || value === 'none' || value === 'transparent') return null;
  try {
    const c = new Color(value);
    return { color: c.toNumber(), alpha: c.alpha };
  } catch {
    return null;
  }
}

/** Font ascent/descent for a CSS font string — injectable so the backend is testable headless. */
export type FontMetricsFn = (font: string) => { ascent: number; descent: number };

export interface PixiBackendOptions {
  /** Font family for <text> without font-family (Pixi's default otherwise). */
  fontFamily?: string;
  /** Font metrics source; defaults to Pixi's CanvasTextMetrics (needs a canvas). */
  metrics?: FontMetricsFn;
  /** Baseline as a fraction of line height, used when metrics are unavailable. Default 0.8. */
  baselineRatio?: number;
}

/** mix-blend-mode (CSS, the format's names) → Pixi blendMode. */
const BLEND: Record<string, string> = { normal: 'normal', 'plus-lighter': 'add', multiply: 'multiply', screen: 'screen' };

/** data-pivot="x y" → point, or null when absent (mount reports a malformed one). */
const pivotOf = (attrs: Record<string, string>): { x: number; y: number } | null =>
  attrs['data-pivot'] == null ? null : parsePivot(attrs['data-pivot']);

const defaultMetrics: FontMetricsFn = (font) => CanvasTextMetrics.measureFont(font);

/**
 * What an <image> becomes: a Sprite by default, or any textured view a subclass returns from
 * createImage (NineSliceSprite, TilingSprite, a Sprite subclass…).
 */
export type ImageNode = Container & { texture: Texture };

interface ImageState {
  /** width/height attributes (SVG size of the image); undefined → the texture's own size. */
  w?: number;
  h?: number;
  /** Texture fit currently multiplied into a Sprite's scale (1 before any texture). */
  fx: number;
  fy: number;
  /** The href this node should show now (a slower, older load must not win). */
  href?: string;
  /** data-pivot relative to x/y (SVG units, before the texture fit) — kept through refits. */
  pivot?: { x: number; y: number };
  /** v1.0: data-slices [l, t, r, b] — checked against each texture. */
  slices?: [number, number, number, number];
  /** v1.0: the node's name for errors (#id). */
  where?: string;
  /** v1.0: data-tile axes — along the others the texture is stretched to the box. */
  tile?: 'x' | 'y' | 'xy';
  /** 2.0: preserveAspectRatio (meet / slice and the alignment); absent — the picture fills the box. */
  aspect?: AspectFit;
  /** 2.0: the texture as loaded (a slice shows a cut of it — `cut`, destroyed on the next fit). */
  src?: Texture;
  cut?: Texture;
  /** 2.0: where the fitted picture's top-left sits in the box (meet), SVG units. */
  ox?: number;
  oy?: number;
}

/** A drawn geometry node (path / circle / ellipse / line / rect): what a redraw needs. */
interface ShapeState {
  tag: string;
  /** Raw attributes; a rect's x/y are zeroed (its Pixi frame starts at x/y). */
  attrs: Record<string, string>;
  cmds: PathCmd[];
  stroke: { color: number; alpha: number } | null;
  /** stroke-opacity, stroke-width, stroke-dashoffset — what clips animate. */
  opacity: number;
  width: number;
  offset: number;
  dash: number[] | null;
  pathLength?: number;
  cap: LineCap;
  join: LineJoin;
  /** Flattened outline (dashes), built on the first dashed draw. */
  outline?: Polyline[];
}

/** Stroke props a shape redraws for (setProp path → ShapeState field). */
const STROKE_PROPS: Record<string, 'opacity' | 'width' | 'offset'> = {
  'stroke-opacity': 'opacity',
  'stroke-width': 'width',
  'stroke-dashoffset': 'offset',
};

/**
 * 2.0: the part of `tex` a slice shows — `w × h` texture pixels at the alignment; null when the
 * texture cannot be cut by frame (a trimmed or rotated atlas frame — then the picture is stretched).
 */
function cutTexture(tex: Texture, a: AspectFit, w: number, h: number): Texture | null {
  if (tex.trim || tex.rotate) return null;
  const tw = tex.orig.width;
  const th = tex.orig.height;
  const x = (tw - w) * a.ax;
  const y = (th - h) * a.ay;
  return new Texture({ source: tex.source, frame: new Rectangle(tex.frame.x + x, tex.frame.y + y, w, h) });
}

/** Views whose width/height resize the view itself instead of scaling it. */
const ownSize = (n: ImageNode): n is NineSliceSprite | TilingSprite =>
  n instanceof NineSliceSprite || n instanceof TilingSprite;

export class PixiBackend implements RendererBackend {
  private readonly images = new WeakMap<ImageNode, ImageState>();
  private readonly shapes = new WeakMap<Graphics, ShapeState>();
  /** The mask Graphics setClip installed on a node (replaced/removed by the next call). */
  private readonly clips = new WeakMap<Container, Graphics>();
  private readonly inflight = new Set<Promise<void>>();
  private failed = new Set<string>();
  /** v1.0: load-time problems that are not a failed load (slices that do not fit the texture). */
  private problems: string[] = [];
  private readonly opts: PixiBackendOptions;

  constructor(opts: PixiBackendOptions = {}) {
    this.opts = opts;
  }

  createNode(tag: string, attrs: Record<string, string>): NodeHandle {
    let node: Container;
    // data-pivot is in the element's user space; the Pixi frame of image/text/rect starts at x/y.
    const pivot = pivotOf(attrs);
    const local = (withXY: boolean): { x: number; y: number } | null =>
      pivot && (withXY ? { x: pivot.x - num(attrs.x), y: pivot.y - num(attrs.y) } : pivot);
    switch (tag) {
      case 'svg':
      case 'g':
        node = new Container();
        this.place(node, localMatrix(attrs, false), local(false));
        break;
      case 'image':
        node = this.image(attrs, local(true));
        break;
      case 'text':
        node = this.text(attrs);
        this.place(node, localMatrix(attrs, true), local(true));
        break;
      case 'rect':
        node = this.shape(tag, attrs);
        this.place(node, localMatrix(attrs, true), local(true));
        break;
      case 'path':
      case 'circle':
      case 'ellipse':
      case 'line':
        node = this.shape(tag, attrs);
        this.place(node, localMatrix(attrs, false), local(false));
        break;
      default:
        throw trempelError('E_BACKEND', `PixiBackend: cannot create a node for the tag <${tag}>`);
    }

    if (attrs.opacity != null) node.alpha = num(attrs.opacity, 1);
    if (attrs.display === 'none' || attrs.visibility === 'hidden') node.visible = false;
    return node;
  }

  setProp(node: NodeHandle, path: string, value: unknown): void {
    const obj = node as Container;
    switch (path) {
      case 'text':
        (obj as Text).text = value == null ? '' : String(value);
        return;
      case 'href':
        this.setTexture(this.imageOf(obj), String(value));
        return;
      case 'visible':
        obj.visible = Boolean(value);
        return;
      case 'display':
        obj.visible = value !== 'none' && value !== false && value != null;
        return;
      case 'tint':
        this.setTint(obj, Number(value));
        return;
      case 'mix-blend-mode': {
        const mode = BLEND[String(value)];
        if (!mode) throw trempelError('E_BLEND', `PixiBackend: mix-blend-mode="${String(value)}" — expected ${Object.keys(BLEND).join(', ')}.`);
        obj.blendMode = mode as Container['blendMode'];
        return;
      }
      case 'z':
        this.setZ(obj, Number(value));
        return;
      case 'width':
      case 'height':
        if (this.resize(obj, path, Number(value))) return;
        break;
    }
    const field = STROKE_PROPS[path];
    if (field) {
      const st = this.shapes.get(obj as Graphics);
      if (!st) throw trempelError('E_BACKEND', `PixiBackend: ${path} — only on geometry (path, circle, ellipse, line, rect).`);
      const v = Number(value);
      if (!Number.isFinite(v)) throw trempelError('E_BACKEND', `PixiBackend: ${path}=${String(value)} — not a number.`);
      st[field] = v;
      this.drawShape(obj as Graphics, st);
      return;
    }
    if (NUMERIC_ATTRS.has(path)) {
      (obj as unknown as Record<string, number>)[path] = Number(value);
      return;
    }
    // Nested path like 'scale.y'.
    const parts = path.split('.');
    let target = obj as unknown as Record<string, unknown>;
    for (let i = 0; i < parts.length - 1; i++) {
      target = target[parts[i]] as Record<string, unknown>;
      if (target == null) return;
    }
    target[parts[parts.length - 1]] = value;
  }

  onClick(node: NodeHandle, handler: () => void): void {
    const obj = node as Container;
    obj.eventMode = 'static';
    obj.cursor = 'pointer';
    obj.on('pointertap', handler);
  }

  onPointer(node: NodeHandle, kind: PointerKind, handler: () => void): void {
    const obj = node as Container;
    obj.eventMode = 'static';
    const events = { over: ['pointerover'], out: ['pointerout'], down: ['pointerdown'], up: ['pointerup', 'pointerupoutside'] }[kind];
    for (const e of events) obj.on(e, handler);
  }

  addChild(parent: NodeHandle, child: NodeHandle): void {
    (parent as Container).addChild(child as ContainerChild);
  }

  mount(root: NodeHandle, container: unknown): void {
    (container as Container).addChild(root as ContainerChild);
  }

  /** Read a property by setProp's paths ('x', 'rotation', 'scale.y', 'alpha', 'z', 'tint'…). */
  getProp(node: NodeHandle, path: string): unknown {
    if (path === 'z') return (node as Container).zIndex;
    if (path === 'width' || path === 'height') {
      const img = this.images.get(node as ImageNode);
      const st = this.shapes.get(node as Graphics);
      if (img) return (path === 'width' ? img.w : img.h) ?? (node as Container)[path];
      if (st?.tag === 'rect') return num(st.attrs[path]);
    }
    if (path === 'display') return (node as Container).visible ? 'inline' : 'none';
    const field = STROKE_PROPS[path];
    const st = field && this.shapes.get(node as Graphics);
    if (st) return st[field];
    if (path === 'tint') {
      const img = this.imagesIn(node as Container)[0];
      return img ? img.tint : 0xffffff;
    }
    let target: unknown = node;
    for (const part of path.split('.')) {
      if (target == null) return undefined;
      target = (target as Record<string, unknown>)[part];
    }
    return target;
  }

  /**
   * Mask a node by a <clipPath> (v0.7), or remove the mask (null). The shapes are drawn into a new
   * Graphics (white fill; transforms of the clipPath, its groups and shapes applied) that becomes
   * the node's child and mask — so the clip lives in the node's coordinate system.
   */
  setClip(node: NodeHandle, clip: ClipShape | null): void {
    const host = node as Container;
    const old = this.clips.get(host);
    if (old) {
      if (host.mask === old) host.mask = null;
      old.destroy();
      this.clips.delete(host);
    }
    if (!clip) return;
    if (!host.allowChildren) {
      throw trempelError('E_CLIP_PATH', 'PixiBackend: clip-path on a node without children (a sprite, a text) — wrap it in a <g>.');
    }
    const g = new Graphics();
    this.drawClip(g, clip.children, parseTransform(clip.attrs.transform));
    host.addChild(g);
    host.mask = g;
    this.clips.set(host, g);
  }

  getBounds(node: NodeHandle): Bounds {
    const b = (node as Container).getBounds();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  }

  /**
   * Resolves when every texture load started so far (including ones started while waiting)
   * has settled. Rejects with a TrempelError listing the hrefs that failed since the last call.
   */
  async whenReady(): Promise<void> {
    while (this.inflight.size) await Promise.all([...this.inflight]);
    if (this.failed.size || this.problems.length) {
      const failed = [...this.failed].sort();
      const problems = [...new Set(this.problems)];
      this.failed = new Set();
      this.problems = [];
      throw new TrempelError([...failed.map((h) => coded('E_TEXTURE', `the texture did not load: "${h}".`)), ...problems]);
    }
  }

  // ---- extension points (v0.6.1) ---------------------------------------------

  /**
   * The display object for an <image> (before transform, size and texture are applied — the base
   * does those). Override to return e.g. a NineSliceSprite for some attributes; call super otherwise.
   */
  protected createImage(attrs: Record<string, string>): ImageNode {
    // v1.0: data-slices / data-tile (malformed values are mount's errors — a plain sprite here).
    if (attrs['data-slices'] != null) {
      try {
        const [leftWidth, topHeight, rightWidth, bottomHeight] = parseSlices(attrs['data-slices']);
        return new NineSliceSprite({ texture: Texture.EMPTY, leftWidth, topHeight, rightWidth, bottomHeight });
      } catch {
        /* reported by mount */
      }
    }
    if (attrs['data-tile'] != null) {
      try {
        parseAxes('data-tile', attrs['data-tile']);
        return new TilingSprite({ texture: Texture.EMPTY });
      } catch {
        /* reported by mount */
      }
    }
    return new Sprite();
  }

  /**
   * Count a load the subclass starts itself (a texture, a font, a sheet) towards whenReady();
   * if it rejects, `label` (e.g. the href) is listed in whenReady's error.
   */
  protected track(load: Promise<unknown>, label: string): void {
    const settled = load.then(
      () => {},
      () => {
        this.failed.add(label);
      },
    );
    const tracked = settled.finally(() => this.inflight.delete(tracked));
    this.inflight.add(tracked);
  }

  // ---- nodes -----------------------------------------------------------------

  /** Set the node's matrix; with a pivot (its own frame) Pixi's position becomes where it lands. */
  private place(node: Container, m: Matrix, pivot: { x: number; y: number } | null = null): void {
    const [a, b, c, d, e, f] = m;
    if (pivot) node.pivot.set(pivot.x, pivot.y);
    if (!pivot && a === 1 && b === 0 && c === 0 && d === 1) node.position.set(e, f);
    else node.setFromMatrix(new PixiMatrix(a, b, c, d, e, f));
  }

  /** Every image of a subtree (the node itself when it is one). */
  private imagesIn(obj: Container): ImageNode[] {
    if (this.images.has(obj as ImageNode)) return [obj as ImageNode];
    const found: ImageNode[] = [];
    const visit = (c: Container): void => {
      for (const ch of c.children) {
        if (this.images.has(ch as ImageNode)) found.push(ch as ImageNode);
        else visit(ch);
      }
    };
    visit(obj);
    return found;
  }

  /** Tint a sprite, or every image of a group (v0.8 — a group's tint is its images'). */
  private setTint(obj: Container, color: number): void {
    if ('tint' in obj && this.images.has(obj as ImageNode)) {
      (obj as Sprite).tint = color;
      return;
    }
    const imgs = this.imagesIn(obj);
    if (!imgs.length && 'tint' in obj) (obj as Sprite).tint = color; // a foreign sprite / text
    for (const img of imgs) img.tint = color;
  }

  /** Order among siblings: the first z under a parent sorts it, siblings keep their index. */
  private setZ(obj: Container, z: number): void {
    const parent = obj.parent;
    if (parent && !parent.sortableChildren) {
      parent.children.forEach((c, i) => {
        if (c !== obj) c.zIndex = i;
      });
      parent.sortableChildren = true;
    }
    obj.zIndex = z;
  }

  private image(attrs: Record<string, string>, pivot: { x: number; y: number } | null = null): ImageNode {
    const node = this.createImage(attrs);
    const state: ImageState = {
      w: attrs.width ? num(attrs.width) : undefined,
      h: attrs.height ? num(attrs.height) : undefined,
      fx: 1,
      fy: 1,
      pivot: pivot ?? undefined,
      where: attrs.id ? `#${attrs.id}` : `<image href="${attrs.href ?? ''}">`,
    };
    if (node instanceof TilingSprite && attrs['data-tile'] != null) {
      try {
        state.tile = parseAxes('data-tile', attrs['data-tile']);
      } catch {
        /* reported by mount */
      }
    }
    if (node instanceof NineSliceSprite && attrs['data-slices'] != null) {
      try {
        state.slices = parseSlices(attrs['data-slices']);
      } catch {
        /* reported by mount */
      }
    }
    if (attrs.preserveAspectRatio != null && !ownSize(node)) {
      try {
        state.aspect = parseAspect(attrs.preserveAspectRatio) ?? undefined;
      } catch {
        /* reported by mount */
      }
    }
    this.images.set(node, state);
    this.place(node, localMatrix(attrs, true), pivot);
    if (ownSize(node) && state.w !== undefined && state.h !== undefined) node.setSize(state.w, state.h);
    // Fit the empty 1×1 texture to width/height right away: the element keeps its SVG box (bounds,
    // hit, editor handles) while the texture loads and if it never arrives.
    else if (!ownSize(node)) this.applyTexture(node, state, Texture.EMPTY);
    if (attrs.href) this.setTexture(node, attrs.href);
    return node;
  }

  /**
   * The image an href write is for: the node itself, or — for a group (a rig part, a clipped image's
   * wrapper) — its one <image> descendant. Zero or several images there is an error.
   */
  private imageOf(obj: Container): ImageNode {
    if (this.images.has(obj as ImageNode) || 'texture' in obj) return obj as ImageNode;
    const found: ImageNode[] = [];
    const visit = (c: Container): void => {
      for (const ch of c.children) {
        if (this.images.has(ch as ImageNode)) found.push(ch as ImageNode);
        else visit(ch);
      }
    };
    visit(obj);
    if (found.length !== 1) {
      throw trempelError('E_BACKEND', `PixiBackend: href on a group — it holds ${found.length} <image>; a picture can be swapped only when there is one.`);
    }
    return found[0];
  }

  /** Swap an image's texture; cached → now, otherwise after load (if still the current href). */
  private setTexture(node: ImageNode, href: string): void {
    let state = this.images.get(node);
    if (!state) {
      state = { fx: 1, fy: 1 };
      this.images.set(node, state);
    }
    state.href = href;
    if (Assets.cache.has(href)) {
      this.applyTexture(node, state, Assets.cache.get<Texture>(href));
      return;
    }
    const st = state;
    this.track(
      Assets.load<Texture>(href).then((tex) => {
        if (!node.destroyed && st.href === href) this.applyTexture(node, st, tex);
      }),
      href,
    );
  }

  /**
   * Set the texture, then size the node to the element's width/height (SVG semantics) — relative
   * to its current transform: only the previous texture fit is swapped for the new one, so a
   * position/scale/rotation the host set after build survives. Own-size views (9-slice, tiling)
   * get width/height directly.
   */
  private applyTexture(node: ImageNode, state: ImageState, tex: Texture): void {
    const before = { x: node.scale.x, y: node.scale.y };
    node.texture = tex;
    const tw = tex.orig.width || 1;
    const th = tex.orig.height || 1;
    if (state.slices && tex !== Texture.EMPTY) {
      const [l, t, r, b] = state.slices;
      if (tw - l - r < 1 || th - t - b < 1) {
        this.problems.push(
          coded('E_SLICES_FIT', `${state.where ?? '<image>'}: data-slices="${state.slices.join(' ')}" do not fit the texture ${tw}×${th}${state.href ? ` (${state.href})` : ''} — the centre needs at least 1 px.`),
        );
      }
    }
    if (ownSize(node)) {
      const w = state.w ?? (state.h !== undefined ? (state.h * tw) / th : tw);
      node.setSize(w, state.h ?? (state.w !== undefined ? (state.w * th) / tw : th));
      this.fitTile(node, state);
      return;
    }
    state.src = tex;
    this.fit(node, state, before);
  }

  /**
   * The texture fit of a plain image for its box (state.w / h) and its current texture (state.src):
   * stretched, or (2.0) meet / slice by preserveAspectRatio. `before` — the scale before a texture
   * swap (an axis Pixi itself re-derived is left alone); null — a resize, the fit is always swapped.
   */
  private fit(node: ImageNode, state: ImageState, before: { x: number; y: number } | null): void {
    if (state.w === undefined && state.h === undefined) return;
    const src = state.src ?? node.texture;
    const tw = src.orig.width || 1;
    const th = src.orig.height || 1;
    let fx = state.w !== undefined ? state.w / tw : (state.h as number) / th;
    let fy = state.h !== undefined ? state.h / th : fx;
    let ox = 0;
    let oy = 0;
    let shown = src;
    const a = state.aspect;
    if (a && state.w !== undefined && state.h !== undefined && src !== Texture.EMPTY && fx > 0 && fy > 0) {
      const sc = a.slice ? Math.max(fx, fy) : Math.min(fx, fy);
      if (a.slice) shown = cutTexture(src, a, state.w / sc, state.h / sc) ?? src;
      if (shown !== src || !a.slice) {
        ox = a.slice ? 0 : (state.w - tw * sc) * a.ax;
        oy = a.slice ? 0 : (state.h - th * sc) * a.ay;
        fx = fy = sc;
      }
    }
    if (node.texture !== shown) {
      const b = { x: node.scale.x, y: node.scale.y };
      node.texture = shown;
      // Swapping the shown texture must not let Pixi re-derive the scale of a fitted sprite.
      node.scale.set(b.x, b.y);
    }
    if (state.cut && state.cut !== shown) state.cut.destroy(false);
    state.cut = shown !== src ? shown : undefined;
    // Pixi's local matrix is T·R·Skew·diag(scale): the fit is the rightmost factor, so swapping it
    // is a per-axis ratio on scale. An axis whose scale Pixi itself just re-derived (the host set
    // sprite.width/height — Sprite keeps that size across textures) is left as Pixi made it.
    // A zero fit (width="0") stays zero for any texture.
    if (state.fx !== 0 && (!before || node.scale.x === before.x)) node.scale.x *= fx / state.fx;
    else if (!before) node.scale.x = fx;
    if (state.fy !== 0 && (!before || node.scale.y === before.y)) node.scale.y *= fy / state.fy;
    else if (!before) node.scale.y = fy;
    state.fx = fx;
    state.fy = fy;
    // The pivot lives in texture pixels: the same SVG point under the new fit (position unchanged);
    // a contained picture moves by its alignment offset inside the box.
    const moved = ox !== 0 || oy !== 0 || (state.ox ?? 0) !== 0 || (state.oy ?? 0) !== 0;
    state.ox = ox;
    state.oy = oy;
    if (state.pivot || moved) {
      const px = (state.pivot?.x ?? 0) - ox;
      const py = (state.pivot?.y ?? 0) - oy;
      node.pivot.set(fx ? px / fx : 0, fy ? py / fy : 0);
    }
  }

  /** data-tile="x" / "y": the texture repeats along that axis and is stretched to the box along the other. */
  private fitTile(node: ImageNode, state: ImageState): void {
    if (!(node instanceof TilingSprite) || !state.tile || state.tile === 'xy') return;
    const tw = node.texture.orig.width || 1;
    const th = node.texture.orig.height || 1;
    if (state.tile === 'x') node.tileScale.set(1, node.height / th);
    else node.tileScale.set(node.width / tw, 1);
  }

  /** v1.0: width / height of an image (its SVG box) or a rect (redrawn); false — not one of those. */
  private resize(obj: Container, path: 'width' | 'height', v: number): boolean {
    if (!Number.isFinite(v)) throw trempelError('E_BACKEND', `PixiBackend: ${path}=${String(v)} — not a number.`);
    const img = this.images.get(obj as ImageNode);
    if (img) {
      const node = obj as ImageNode;
      if (path === 'width') img.w = v;
      else img.h = v;
      if (ownSize(node)) {
        if (path === 'width') node.width = v;
        else node.height = v;
        this.fitTile(node, img);
      } else {
        // The fit for the current texture with the new box; the rest of the transform stays.
        this.fit(node, img, null);
      }
      return true;
    }
    const st = this.shapes.get(obj as Graphics);
    if (st?.tag === 'rect') {
      st.attrs = { ...st.attrs, [path]: String(v) };
      st.cmds = shapeCommands('rect', st.attrs);
      st.outline = undefined;
      this.drawShape(obj as Graphics, st);
      return true;
    }
    return false;
  }

  private text(attrs: Record<string, string>): Text {
    const fill = parseColor(attrs.fill ?? '#000');
    const stroke = parseColor(attrs.stroke);
    const strokeWidth = stroke ? num(attrs['stroke-width'], 1) : 0;
    const text = new Text({
      text: '',
      style: {
        fontFamily: attrs['font-family'] ?? this.opts.fontFamily ?? 'Arial',
        fontSize: num(attrs['font-size'], 26),
        fontWeight: (attrs['font-weight'] ?? 'normal') as TextStyleFontWeight,
        fontStyle: (attrs['font-style'] === 'italic' ? 'italic' : 'normal'),
        fill: fill
          ? { color: fill.color, alpha: fill.alpha * num(attrs['fill-opacity'], 1) }
          : { color: 0, alpha: 0 },
        stroke: stroke
          ? { color: stroke.color, alpha: stroke.alpha * num(attrs['stroke-opacity'], 1), width: strokeWidth, join: 'round' }
          : undefined,
        letterSpacing: num(attrs['letter-spacing'], 0),
        align: 'left',
      },
    });
    const anchorX = attrs['text-anchor'] === 'middle' ? 0.5 : attrs['text-anchor'] === 'end' ? 1 : 0;
    text.anchor.set(anchorX, this.baselineAnchor(text, attrs['dominant-baseline'], strokeWidth));
    return text;
  }

  /**
   * Anchor.y that puts the SVG `y` on the right line of a single-line Pixi Text. Pixi draws the
   * baseline at strokeWidth/2 + ascent inside a box of height ascent + descent + strokeWidth.
   */
  private baselineAnchor(text: Text, dominant: string | undefined, strokeWidth: number): number {
    if (dominant === 'middle' || dominant === 'central') return 0.5;
    if (dominant === 'hanging' || dominant === 'text-before-edge') return 0;
    try {
      const font = text.style._fontString ?? '';
      const { ascent, descent } = (this.opts.metrics ?? defaultMetrics)(font);
      const total = ascent + descent + strokeWidth;
      if (ascent > 0 && total > 0) return (ascent + strokeWidth / 2) / total;
    } catch {
      /* no canvas (headless) — fall back to the ratio */
    }
    return this.opts.baselineRatio ?? 0.8;
  }

  /** path / circle / ellipse / line (v0.7), rect — geometry in the node's own user space. */
  private shape(tag: string, attrs: Record<string, string>): Graphics {
    const g = new Graphics();
    const where = attrs.id ? `#${attrs.id}` : `<${tag}>`;
    // A rect is drawn in its own frame: Pixi's node sits at x/y.
    const own = tag === 'rect' ? { ...attrs, x: '0', y: '0' } : attrs;
    let st: ShapeState;
    try {
      const stroke = parseColor(attrs.stroke);
      st = {
        tag,
        attrs: own,
        cmds: shapeCommands(tag, own),
        stroke,
        opacity: num(attrs['stroke-opacity'], 1),
        width: num(attrs['stroke-width'], 1),
        offset: attrs['stroke-dashoffset'] != null ? parseNumberAttr('stroke-dashoffset', attrs['stroke-dashoffset']) : 0,
        dash: attrs['stroke-dasharray'] != null ? parseDashArray(attrs['stroke-dasharray']) : null,
        pathLength: attrs.pathLength != null ? parsePathLength(attrs.pathLength) : undefined,
        cap: (attrs['stroke-linecap'] != null ? parseLineStyle('stroke-linecap', attrs['stroke-linecap']) : 'butt') as LineCap,
        join: (attrs['stroke-linejoin'] != null ? parseLineStyle('stroke-linejoin', attrs['stroke-linejoin']) : 'miter') as LineJoin,
      };
    } catch (e) {
      throw new TrempelError([within(`PixiBackend: ${where}`, (e as Error).message)]);
    }
    this.shapes.set(g, st);
    this.drawShape(g, st);
    return g;
  }

  /** (Re)draw a shape: fill, then its stroke — solid, or the visible dashes as open pieces. */
  private drawShape(g: Graphics, st: ShapeState): void {
    g.clear();
    const { tag, attrs, cmds } = st;
    if (!cmds.length) return;
    const n = (v: string | undefined): number => num(v);
    if (tag === 'circle') g.circle(n(attrs.cx), n(attrs.cy), n(attrs.r));
    else if (tag === 'ellipse') g.ellipse(n(attrs.cx), n(attrs.cy), n(attrs.rx), n(attrs.ry));
    else if (tag === 'rect') {
      const w = n(attrs.width);
      const h = n(attrs.height);
      const r = Math.min(n(attrs.rx ?? attrs.ry), w / 2, h / 2);
      if (r > 0) g.roundRect(0, 0, w, h, r);
      else g.rect(0, 0, w, h);
    } else g.path(toGraphicsPath(cmds));
    // A line has no area: SVG never fills it. The SVG default fill is black; "none" leaves it unfilled.
    const fill = tag === 'line' ? null : parseColor(attrs.fill ?? '#000');
    if (fill) g.fill({ color: fill.color, alpha: fill.alpha * num(attrs['fill-opacity'], 1) });
    if (!st.stroke || !(st.width > 0)) return;
    const style = { color: st.stroke.color, alpha: st.stroke.alpha * st.opacity, width: st.width, cap: st.cap, join: st.join };
    if (!st.dash) {
      g.stroke(style);
      return;
    }
    st.outline ??= flatten(cmds);
    const scale = st.pathLength ? outlineLength(st.outline) / st.pathLength : 1;
    const pieces = dashes(st.outline, st.dash, st.offset, scale);
    if (!pieces.length) return;
    g.beginPath();
    for (const p of pieces) {
      g.moveTo(p.pts[0], p.pts[1]);
      for (let i = 2; i < p.pts.length; i += 2) g.lineTo(p.pts[i], p.pts[i + 1]);
      if (p.closed) g.closePath();
    }
    g.stroke(style);
  }

  /** Fill every clip shape (recursing into groups) into `g` under the accumulated matrix. */
  private drawClip(g: Graphics, shapes: ClipShape[], m: Matrix): void {
    for (const s of shapes) {
      const own = multiply(m, parseTransform(s.attrs.transform)); // rect x/y are in its outline
      if (s.tag === 'g') {
        this.drawClip(g, s.children, own);
        continue;
      }
      const cmds = shapeCommands(s.tag, s.attrs);
      if (!cmds.length) continue;
      const [a, b, c, d, e, f] = own;
      g.setTransform(a, b, c, d, e, f);
      g.path(toGraphicsPath(cmds)).fill({ color: 0xffffff });
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
  }
}

/** Normalized path commands → a Pixi GraphicsPath (holes found by contour winding). */
function toGraphicsPath(cmds: PathCmd[]): GraphicsPath {
  const p = new GraphicsPath(undefined, true);
  for (const c of cmds) {
    switch (c[0]) {
      case 'M':
        p.moveTo(c[1], c[2]);
        break;
      case 'L':
        p.lineTo(c[1], c[2]);
        break;
      case 'C':
        p.bezierCurveTo(c[1], c[2], c[3], c[4], c[5], c[6]);
        break;
      case 'Q':
        p.quadraticCurveTo(c[1], c[2], c[3], c[4]);
        break;
      case 'A':
        p.arcToSvg(c[1], c[2], c[3], c[4], c[5], c[6], c[7]);
        break;
      case 'Z':
        p.closePath();
        break;
    }
  }
  return p;
}
