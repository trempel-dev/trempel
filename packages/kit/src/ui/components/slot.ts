// slot.ts — icon slot (a place for a picture in an icon panel): a round plate with a picture under a
// round mask — any texture, a square FRAME of it — and the states "found" (a mark fades in) and
// "hint" (a glow ring while a hint points at it). How a not-yet-found picture shows is the skin's
// `slotIcon` (or the `mode` param):
//   color       the picture as it is;
//   grayscale   grey at `back-alpha`, the colour fades in when found;
//   silhouette  a flat shape (token `silhouette`), the colour fades in when found.
// Frame `{ x, y, scale }` in fractions of the source: x, y — the square's centre, scale — its side
// as a fraction of the source width.

import { ColorMatrixFilter, Container, Graphics, Sprite, Texture } from 'pixi.js';
import type { ComponentContext, ComponentInstance } from '@trempel/scene';
import type { Tweens } from '../../anim/tweens.js';
import { SLOT_ICON_MODES, type SlotIconMode } from '../skin/format.js';
import type { Skin } from '../skin/skin.js';
import { adopt, artView, num, plate, texture, type UIServices } from './base.js';
import { drawIcon } from './icons.js';

export interface SlotFrame {
  /** Centre of the square, fraction of the source width / height. */
  x: number;
  y: number;
  /** Side of the square, fraction of the source width. */
  scale: number;
}

export type SlotState = 'idle' | 'found' | 'hint';

export const FULL_FRAME: SlotFrame = { x: 0.5, y: 0.5, scale: 1 };

/** Sprite scale + position that put the frame of a w×h texture onto a circle of diameter d at (0, 0). */
export function placeFrame(frame: SlotFrame, w: number, h: number, d: number): { scale: number; x: number; y: number } {
  const side = frame.scale * w;
  const scale = d / side;
  return { scale, x: -frame.x * w * scale, y: -frame.y * h * scale };
}

/** What the not-yet-found picture looks like in a mode: filter kind, alpha, whether colour fades in when found. */
export function slotLook(mode: SlotIconMode, backAlpha: number): { filter: 'none' | 'grayscale' | 'silhouette'; alpha: number; revealColor: boolean } {
  if (mode === 'grayscale') return { filter: 'grayscale', alpha: backAlpha, revealColor: true };
  if (mode === 'silhouette') return { filter: 'silhouette', alpha: 1, revealColor: true };
  return { filter: 'none', alpha: 1, revealColor: false };
}

/** A flat colour of the alpha (silhouette). */
export function silhouetteFilter(color: number): ColorMatrixFilter {
  const f = new ColorMatrixFilter();
  const r = ((color >> 16) & 255) / 255;
  const g = ((color >> 8) & 255) / 255;
  const b = (color & 255) / 255;
  f.matrix = [0, 0, 0, 0, r, 0, 0, 0, 0, g, 0, 0, 0, 0, b, 0, 0, 0, 1, 0];
  return f;
}

export const SLOT = { reveal: 0.5 };

export class UISlot extends Container {
  private readonly picture = new Sprite();
  private readonly color = new Sprite();
  private readonly mark: Container | null;
  private readonly glow: Container | null;
  private readonly look: ReturnType<typeof slotLook>;
  private stateNow: SlotState = 'idle';
  private frameNow: SlotFrame = FULL_FRAME;

  constructor(
    skin: Skin,
    readonly size: number,
    readonly icon: number,
    readonly mode: SlotIconMode,
    backAlpha: number,
    private readonly tweens: Tweens | null,
  ) {
    super();
    if (!SLOT_ICON_MODES.includes(mode)) throw new Error(`ui-slot: mode "${mode}" (known: ${SLOT_ICON_MODES.join(', ')})`);
    this.look = slotLook(mode, backAlpha);
    const glowLook = skin.look('slot.hint');
    this.glow = glowLook?.kind === 'art' ? artView(skin, glowLook, size * 1.22, size * 1.22) : glowLook?.kind === 'none' ? null : new Graphics().circle(0, 0, size * 0.56).stroke({ color: skin.colorOr(['hint', 'accent'], 0xffb020), width: size * 0.09 });
    if (this.glow) {
      this.glow.visible = false;
      this.addChild(this.glow);
    }
    if (size > 0) this.addChild(plate(skin, ['slot.plate'], size, size, () => ({ color: skin.colorOr(['surface'], 0xffffff), radius: size / 2, outline: { color: skin.colorOr(['outline'], 0), width: Math.max(2, size * 0.03) } })));
    const mask = new Graphics().circle(0, 0, icon / 2).fill(0xffffff);
    const face = new Container();
    if (this.look.filter === 'grayscale') {
      const f = new ColorMatrixFilter();
      f.desaturate();
      this.picture.filters = [f];
    } else if (this.look.filter === 'silhouette') this.picture.filters = [silhouetteFilter(skin.colorOr(['silhouette', 'onSurface'], 0x1d3557))];
    this.picture.alpha = this.look.alpha;
    this.color.visible = false;
    face.addChild(this.picture, this.color);
    face.mask = mask;
    this.addChild(face, mask);
    const markLook = skin.look('slot.found');
    const ms = (size || icon) * 0.42;
    this.mark =
      markLook?.kind === 'art'
        ? artView(skin, markLook, ms, ms)
        : markLook?.kind === 'none'
          ? null
          : (() => {
              const g = new Graphics().circle(0, 0, ms / 2).fill(skin.colorOr(['found', 'secondary'], 0x24a865));
              drawIcon(g, 'check', ms * 0.7, 0xffffff);
              return g;
            })();
    if (this.mark) {
      this.mark.position.set((size || icon) * 0.33, (size || icon) * 0.33);
      this.mark.visible = false;
      this.addChild(this.mark);
    }
    this.eventMode = 'none';
  }

  /** The picture: a texture or a bundle URL. */
  set source(src: Texture | string | null) {
    const apply = (t: Texture) => {
      if (this.destroyed) return;
      this.picture.texture = t;
      this.color.texture = t;
      this.place();
    };
    if (!src) apply(Texture.EMPTY);
    else if (typeof src === 'string') texture(src, apply);
    else apply(src);
  }
  get source(): Texture {
    return this.picture.texture;
  }

  set frame(f: SlotFrame | null) {
    this.frameNow = f ?? FULL_FRAME;
    this.place();
  }
  get frame(): SlotFrame {
    return this.frameNow;
  }

  private place(): void {
    const t = this.picture.texture;
    const w = t.width || 1;
    const h = t.height || 1;
    const p = placeFrame(this.frameNow, w, h, this.icon);
    for (const s of [this.picture, this.color]) {
      s.scale.set(p.scale);
      s.position.set(p.x, p.y);
    }
  }

  get state(): SlotState {
    return this.stateNow;
  }
  /** Set without animation (bindings, reset). */
  set state(s: SlotState) {
    this.stateNow = s;
    if (this.tweens) for (const n of [this.color, this.mark]) if (n) this.tweens.kill(n);
    if (this.glow) this.glow.visible = s === 'hint';
    const found = s === 'found';
    this.color.visible = found && this.look.revealColor;
    this.color.alpha = 1;
    if (this.mark) {
      this.mark.visible = found;
      this.mark.alpha = 1;
    }
  }

  /** Found, animated (the mark and the colour fade in, SLOT.reveal s). */
  reveal(): Promise<void> {
    this.stateNow = 'found';
    if (this.glow) this.glow.visible = false;
    const fades: Promise<void>[] = [];
    const fade = (n: Container) => {
      n.visible = true;
      n.alpha = 0;
      if (this.tweens) fades.push(this.tweens.to(n, { alpha: 1 }, SLOT.reveal, { ease: 'outQuad', alive: () => !n.destroyed }));
      else n.alpha = 1;
    };
    if (this.look.revealColor) fade(this.color);
    if (this.mark) fade(this.mark);
    return Promise.all(fades).then(() => {});
  }
}

export function slot(svc: UIServices): Record<'ui-slot', (ctx: ComponentContext) => ComponentInstance> {
  const { skin, tweens } = svc;
  return {
    'ui-slot': (ctx) => {
      const size = num(ctx.param('size'), 120);
      const s = new UISlot(skin, size, num(ctx.param('icon'), size * 0.8), (ctx.param('mode') as SlotIconMode | undefined) ?? skin.slotIcon, num(ctx.param('back-alpha'), 0.86), tweens);
      const src = ctx.param('src');
      if (src) s.source = ctx.resolveHref ? ctx.resolveHref(src) : src;
      return { root: adopt(s, ctx) };
    },
  };
}
