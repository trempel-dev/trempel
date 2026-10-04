// kit-backend.ts — the kit's Trempel backend: PixiBackend + the non-SVG attributes games keep on the
// sterile base as plain data-* (a PixiBackend subclass — createGame takes a backend):
//
//   - 9-slice images: `data-slice="L T R B"`, the `slices(url)` lookup of the game, or the skin's
//     measured borders → NineSliceSprite (Trempel v0.6.1 extension point createImage: transform,
//     size, texture cache and readiness stay the base's);
//   - `data-tint` (an image's colour multiplied in);
//   - text: `data-wrap` (word-wrap width), `data-line` (line spacing), `data-fit` (shrink the font
//     until the text fits that width — TMP auto-size);
//   - the skin: art contain-fit into the role's box or 9-slice with the measured borders,
//     procedural fills (`skin:fill:<token>`), hidden roles (`skin:none`), `data-color` /
//     `data-font="heading|text"` token texts, `data-fill="<token>"` rects (backgrounds, dimmers),
//     the pressed state of `data-fx="press"` groups.
// Subclass it (createGame({ backend: (o) => new MyBackend(o) })) for a game's own attributes.

import { NineSliceSprite, Sprite, Text, Texture, type Container, type FederatedPointerEvent } from 'pixi.js';
import { PixiBackend, parseColor, type ImageNode, type NodeHandle, type PixiBackendOptions } from '@trempel/scene';
import { FILL_PREFIX, NONE_HREF, type Skin } from './skin/skin.js';

export type SliceLookup = (url: string) => [number, number, number, number] | null;

export interface KitBackendOptions extends PixiBackendOptions {
  /** The skin (tokens, roles, art meta). */
  skin?: Skin | null;
  /** 9-slice borders of a game's own (non-skin) art by resolved URL. */
  slices?: SliceLookup;
}

const num = (v: string | undefined, d = 0): number => (v != null && v !== '' ? parseFloat(v) : d);

interface TextMeta {
  base: number;
  fit?: number;
}
const textMeta = new WeakMap<Text, TextMeta>();

/** Contain-fit of an art of size aw×ah into the box (x, y, w, h), centred. */
export function containBox(aw: number, ah: number, x: number, y: number, w: number, h: number): { x: number; y: number; w: number; h: number } {
  const k = Math.min(w / aw, h / ah);
  const nw = aw * k;
  const nh = ah * k;
  return { x: x + (w - nw) / 2, y: y + (h - nh) / 2, w: nw, h: nh };
}

/** TMP auto-size: shrink the font until the text fits its box width (`data-fit`). */
export function fitText(t: Text): void {
  const meta = textMeta.get(t);
  if (!meta?.fit) return;
  t.style.fontSize = meta.base;
  const w = t.width / Math.abs(t.scale.x || 1);
  if (w > meta.fit) t.style.fontSize = Math.max(8, Math.floor((meta.base * meta.fit) / w));
}

/** Auto-size a text created in code to `width` (same rule as `data-fit`). */
export function setTextFit(t: Text, width: number): void {
  textMeta.set(t, { base: Number(t.style.fontSize) || 26, fit: width });
  fitText(t);
}

export class KitBackend extends PixiBackend {
  readonly skin: Skin | null;
  private readonly slices: SliceLookup | undefined;

  constructor(opts: KitBackendOptions = {}) {
    super(opts);
    this.skin = opts.skin ?? null;
    this.slices = opts.slices;
  }

  protected override createImage(a: Record<string, string>): ImageNode {
    const s = a['data-skin-slice'] ? (a['data-skin-slice'].split(' ').map(Number) as [number, number, number, number]) : this.sliceOf(a);
    if (!s) return super.createImage(a);
    const [leftWidth, topHeight, rightWidth, bottomHeight] = s;
    return new NineSliceSprite({ texture: Texture.EMPTY, leftWidth, topHeight, rightWidth, bottomHeight });
  }

  private sliceOf(a: Record<string, string>): [number, number, number, number] | null {
    if (a['data-slice']) return a['data-slice'].split(/[\s,]+/).map(Number) as [number, number, number, number];
    return a.href && this.slices ? this.slices(a.href) : null;
  }

  override createNode(tag: string, attrs: Record<string, string>): NodeHandle {
    let a = attrs;
    let after: ((n: Container) => void) | null = null;
    if (tag === 'image' && this.skin) [a, after] = this.skinImage(attrs);
    if (tag === 'rect' && this.skin && a['data-fill']) a = { ...a, fill: `#${this.skin.color(a['data-fill']).toString(16).padStart(6, '0')}` };
    if (tag === 'text' && this.skin && (a['data-color'] || a['data-font'])) {
      a = { ...a };
      if (a['data-color']) a.fill = `#${this.skin.color(a['data-color']).toString(16).padStart(6, '0')}`;
      if (a['data-font']) {
        const role = a['data-font'] as 'heading' | 'text';
        a['font-family'] = this.skin.font(role);
        const w = this.skin.fontWeight(role);
        if (w && !a['font-weight']) a['font-weight'] = w;
      }
    }
    const node = super.createNode(tag, a) as Container;
    after?.(node);
    if (tag === 'image' && a['data-tint']) (node as Sprite).tint = parseColor(a['data-tint'])?.color ?? 0xffffff;
    if (tag === 'g' && a['data-fx'] === 'press' && this.skin) this.pressedState(node);
    if (tag === 'text') {
      const t = node as Text;
      if (a['data-wrap']) {
        t.style.wordWrap = true;
        t.style.wordWrapWidth = num(a['data-wrap']);
        t.style.align = a['text-anchor'] === 'middle' ? 'center' : a['text-anchor'] === 'end' ? 'right' : 'left';
        t.style.lineHeight = num(a['font-size'], 26) * num(a['data-line'], 1.0);
      }
      if (a['data-fit']) {
        textMeta.set(t, { base: num(a['font-size'], 26), fit: num(a['data-fit']) });
        fitText(t);
      }
    }
    return node;
  }

  override setProp(node: NodeHandle, path: string, value: unknown): void {
    super.setProp(node, path, value);
    if (path === 'text' && node instanceof Text) fitText(node);
  }

  /**
   * An <image> through the skin: attributes for the base backend (the box adjusted for contain-fit,
   * 9-slice borders × their scale) and what to do with the built node. Hrefs are resolved already.
   */
  private skinImage(attrs: Record<string, string>): [Record<string, string>, ((n: Container) => void) | null] {
    const skin = this.skin!;
    const href = attrs.href ?? '';
    const meta = skin.artMeta(href);
    // A data-tint coloured the scene's own sprite; skin art and fills are drawn as they are.
    if (href === NONE_HREF || href.startsWith(FILL_PREFIX) || meta) {
      const { 'data-tint': _tint, ...clean } = attrs;
      void _tint;
      attrs = clean;
    }
    if (href === NONE_HREF) {
      const { href: _drop, ...rest } = attrs;
      void _drop;
      return [rest, (n) => (n.visible = false)];
    }
    if (href.startsWith(FILL_PREFIX)) {
      const { href: _drop, ...rest } = attrs;
      void _drop;
      const tint = skin.color(href.slice(FILL_PREFIX.length));
      return [
        rest,
        (n) => {
          const sp = n as Sprite;
          // 1×1, like the base's empty texture its box fit was made for: the base's later resizes
          // (Trempel v1.0 stretch, setSize) swap that fit by ratio and stay right.
          sp.texture = Texture.WHITE;
          sp.tint = tint;
          sp.setSize(num(attrs.width, 1), num(attrs.height, 1));
        },
      ];
    }
    if (!meta || attrs.width == null || attrs.height == null) return [attrs, null];
    const [aw, ah] = meta.size;
    const x = num(attrs.x);
    const y = num(attrs.y);
    const w = num(attrs.width);
    const h = num(attrs.height);
    if (meta.slice && attrs['data-stretch'] == null) {
      // 9-slice: borders in art px × k design units; the node is scaled by k, sized box / k.
      const k = skin.sliceScale(meta.file, ah, h);
      return [
        { ...attrs, width: String(w / k), height: String(h / k), 'data-skin-slice': meta.slice.join(' ') },
        (n) => n.scale.set(n.scale.x * k, n.scale.y * k),
      ];
    }
    if (attrs['data-stretch'] != null || attrs['data-fit-art'] === 'stretch') return [attrs, null];
    const b = containBox(aw, ah, x, y, w, h);
    return [{ ...attrs, x: String(b.x), y: String(b.y), width: String(b.w), height: String(b.h) }, null];
  }

  /** Pressed state (skin token): the node darkens while held; the 0.8 scale is the kit's ButtonFX. */
  private pressedState(node: Container): void {
    const tint = this.skin!.pressedTint();
    node.eventMode = 'static';
    node.on('pointerdown', (e: FederatedPointerEvent) => {
      if (e.button <= 0) node.tint = tint;
    });
    const up = () => (node.tint = 0xffffff);
    node.on('pointerup', up);
    node.on('pointerupoutside', up);
    node.on('pointerleave', up);
  }
}
