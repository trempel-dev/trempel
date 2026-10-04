// base.ts — what every kit component shares: the node's transform from the scene, parameters, and
// the look of a role (skin art — 9-slice or contain-fit — a procedural fill, or the procedural
// default drawn from the tokens).
//
// Kit components are CENTRED on their node: `<g id="play" transform="translate(360,800)"
// data-w="320" data-h="96"/>` is a 320×96 button whose centre is (360, 800). Parameters come from
// the base as data-* (appearance) or from the heir as tml:* (ComponentContext.param, Trempel v0.7);
// live values (text, value, state…) are bound in the heir: tml:bind-text, tml:bind-value….

import { Assets, ColorMatrixFilter, Container, Graphics, NineSliceSprite, Sprite, Text, Texture, type FederatedPointerEvent } from 'pixi.js';
import type { ComponentContext } from '@trempel/scene';
import type { Tweens } from '../../anim/tweens.js';
import { setTextFit } from '../kit-backend.js';
import type { Look, Skin } from '../skin/skin.js';
import { whiteTexture } from '../textures.js';

/** What the kit's component factories get (the scene context — for actions like a slider's). */
export interface UIServices {
  skin: Skin;
  tweens: Tweens;
  /** The scene context: kit components call its functions (`data-action`). */
  context: Record<string, unknown>;
}

export const num = (v: string | undefined, d: number): number => (v != null && v !== '' && Number.isFinite(parseFloat(v)) ? parseFloat(v) : d);

/** Text of the first <text> child of a component node in the scene (layout copy). */
export function childText(ctx: ComponentContext): string {
  const walk = (ns: ComponentContext['children']): string | null => {
    for (const n of ns) {
      if (n.tag === 'text' && n.text != null) return n.text;
      const t = walk(n.children);
      if (t != null) return t;
    }
    return null;
  };
  return walk(ctx.children) ?? '';
}

/** Copy the node's transform/opacity/visibility from the scene attributes onto `root`. */
export function adopt<T extends Container>(root: T, ctx: ComponentContext): T {
  const g = ctx.backend.createNode('g', ctx.attrs) as Container;
  root.position.copyFrom(g.position);
  root.scale.copyFrom(g.scale);
  root.skew.copyFrom(g.skew);
  root.pivot.copyFrom(g.pivot);
  root.rotation = g.rotation;
  root.alpha = g.alpha;
  root.visible = g.visible;
  if (ctx.attrs.id) root.label = ctx.attrs.id;
  g.destroy();
  return root;
}

/** A texture by bundle URL: from the cache now, else when it loads. */
export function texture(url: string, apply: (t: Texture) => void): void {
  const t = Assets.get<Texture>(url);
  if (t) apply(t);
  else void Assets.load<Texture>(url).then((tx) => apply(tx));
}

/** Skin art of a look in a w×h box centred at (0, 0): 9-slice when measured, else contain-fit. */
export function artView(skin: Skin, look: Extract<Look, { kind: 'art' }>, w: number, h: number): Container {
  const [aw, ah] = look.size;
  if (look.slice) {
    const [leftWidth, topHeight, rightWidth, bottomHeight] = look.slice;
    const k = skin.sliceScale(look.file, ah, h);
    const s = new NineSliceSprite({ texture: Texture.EMPTY, leftWidth, topHeight, rightWidth, bottomHeight, width: w / k, height: h / k });
    s.scale.set(k);
    s.position.set(-w / 2, -h / 2);
    texture(look.url, (t) => {
      if (s.destroyed) return;
      s.texture = t;
      s.width = w / k;
      s.height = h / k;
    });
    return s;
  }
  const s = new Sprite(Texture.EMPTY);
  s.anchor.set(0.5);
  texture(look.url, (t) => {
    if (s.destroyed) return;
    s.texture = t;
    s.scale.set(Math.min(w / aw, h / ah));
  });
  return s;
}

/** A flat rect of a fill look, w×h centred. */
export function fillView(color: number, w: number, h: number, r = 0): Container {
  if (r <= 0) {
    const s = new Sprite(whiteTexture());
    s.tint = color;
    s.setSize(w, h);
    s.position.set(-w / 2, -h / 2);
    return s;
  }
  return new Graphics().roundRect(-w / 2, -h / 2, w, h, r).fill(color);
}

export interface PlateStyle {
  /** Fill colour. */
  color: number;
  /** Corner radius. */
  radius: number;
  /** Outline colour/width (0 = none). */
  outline?: { color: number; width: number };
  /** A darker lip under the plate (buttons), design units. */
  lip?: number;
}

/** The procedural plate: a rounded rect, optional lip and outline, centred. */
export function plateGraphics(w: number, h: number, st: PlateStyle): Graphics {
  const g = new Graphics();
  const r = Math.min(st.radius, h / 2, w / 2);
  if (st.lip) g.roundRect(-w / 2, -h / 2 + st.lip, w, h, r).fill({ color: shade(st.color, 0.72) });
  g.roundRect(-w / 2, -h / 2, w, h - (st.lip ?? 0), r).fill(st.color);
  if (st.outline && st.outline.width > 0) g.roundRect(-w / 2, -h / 2, w, h - (st.lip ?? 0), r).stroke({ color: st.outline.color, width: st.outline.width, alignment: 1 });
  return g;
}

/**
 * The look of the first role of `roles` the skin maps (art / fill / hidden), else the procedural
 * plate. Returned centred, w×h.
 */
export function plate(skin: Skin, roles: string[], w: number, h: number, proc: () => PlateStyle): Container {
  const look = skin.lookAny(roles);
  if (look?.kind === 'art') return artView(skin, look, w, h);
  if (look?.kind === 'fill') return fillView(look.color, w, h);
  if (look?.kind === 'none') return new Container();
  return plateGraphics(w, h, proc());
}

/** Multiply an 0xRRGGBB colour by k (0..1 darker, >1 lighter, clamped). */
export function shade(color: number, k: number): number {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * k)));
  return (c((color >> 16) & 255) << 16) | (c((color >> 8) & 255) << 8) | c(color & 255);
}

/** A centred label in the skin's font, auto-fitted to `maxW`. */
export function label(skin: Skin, text: string, size: number, color: number, maxW: number, font: 'heading' | 'text' = 'heading'): Text {
  const t = new Text({
    text,
    style: { fontFamily: skin.font(font), fontSize: size, fill: color, fontWeight: (skin.fontWeight(font) ?? 'normal') as 'normal' },
  });
  t.anchor.set(0.5);
  t.eventMode = 'none';
  setTextFit(t, maxW);
  return t;
}

/** Pressed (darken while held) and hover (brighten) states of the skin on an interactive root. */
export function pressStates(root: Container, skin: Skin): void {
  root.eventMode = 'static';
  root.cursor = 'pointer';
  const pressed = skin.pressedTint();
  const hover = skin.states.hover?.brighten ?? 1;
  let hf: ColorMatrixFilter | null = null;
  root.on('pointerdown', (e: FederatedPointerEvent) => {
    if (e.button <= 0) root.tint = pressed;
  });
  const up = () => (root.tint = 0xffffff);
  root.on('pointerup', up);
  root.on('pointerupoutside', up);
  root.on('pointerleave', up);
  if (hover !== 1) {
    root.on('pointerover', (e: FederatedPointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      hf ??= (() => {
        const f = new ColorMatrixFilter();
        f.brightness(hover, false);
        return f;
      })();
      if (!root.filters || !(root.filters as ColorMatrixFilter[]).includes(hf)) root.filters = [...((root.filters as ColorMatrixFilter[] | null) ?? []), hf];
    });
    root.on('pointerout', () => {
      if (hf && root.filters) root.filters = (root.filters as ColorMatrixFilter[]).filter((f) => f !== hf);
    });
  }
}

/** Disabled look (skin filter + alpha) and no input; restores both. */
export function setDisabled(root: Container, skin: Skin, on: boolean, filter: { f: ColorMatrixFilter | null }): void {
  if (on) {
    filter.f ??= skin.disabledFilter();
    root.filters = [filter.f];
    root.alpha = skin.states.disabled.alpha ?? 1;
    root.eventMode = 'none';
  } else {
    root.filters = [];
    root.alpha = 1;
    root.eventMode = 'static';
  }
}
