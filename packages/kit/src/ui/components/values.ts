// values.ts — components that show a value: progress bar, segmented slider, result stars.

import { Container, Graphics, Rectangle, Sprite, type FederatedPointerEvent } from 'pixi.js';
import type { ComponentContext, ComponentInstance } from '@trempel/scene';
import type { Tweens } from '../../anim/tweens.js';
import type { Skin } from '../skin/skin.js';
import { whiteTexture } from '../textures.js';
import { adopt, artView, num, plate, plateGraphics, type UIServices } from './base.js';
import { starPoints } from './icons.js';

const clamp01 = (v: number) => Math.max(0, Math.min(1, Number(v) || 0));

/** Progress bar. Centred; params w, h. Prop `value` 0..1. */
export class UIProgress extends Container {
  private readonly fill = new Container();
  private readonly clip = new Graphics();
  private v = 0;
  constructor(
    skin: Skin,
    readonly w: number,
    readonly h: number,
  ) {
    super();
    const r = skin.radius('progress', h);
    this.addChild(plate(skin, ['progress.track'], w, h, () => ({ color: skin.colorOr(['track'], 0xdddddd), radius: r })));
    const inner = h * 0.7;
    const look = skin.look('progress.fill');
    this.fill.addChild(look?.kind === 'art' ? artView(skin, look, w, h) : plateGraphics(w - (h - inner), inner, { color: skin.colorOr(['fill', 'primary'], 0x3d7bfd), radius: r }));
    this.fill.mask = this.clip;
    this.addChild(this.fill, this.clip);
    this.eventMode = 'none';
    this.draw();
  }
  private draw(): void {
    this.clip.clear().rect(-this.w / 2, -this.h / 2, this.w * this.v, this.h).fill(0xffffff);
  }
  get value(): number {
    return this.v;
  }
  set value(x: number) {
    this.v = clamp01(x);
    this.draw();
  }
}

/**
 * Segmented slider (settings volume). Centred; params w, h, segments (0 = a continuous track),
 * knob (size), knob-y (offset), action (scene-context function called with (value, dragging) —
 * e.g. setSfx / setMusic, the kit's built-ins). Prop `value` 0..1.
 */
export class UISlider extends Container {
  private readonly fillLayer = new Container();
  private readonly clip = new Graphics();
  private readonly knob: Container;
  private v = 1;
  dragging = false;
  /** Called on every change from the player. */
  onChange: (value: number, dragging: boolean) => void = () => {};

  constructor(
    skin: Skin,
    readonly w: number,
    readonly h: number,
    segments: number,
    knobSize: number,
    private readonly knobY: number,
  ) {
    super();
    const trackLook = skin.look('slider.track');
    const fillLook = skin.look('slider.fill');
    const back = trackLook?.kind === 'fill' ? trackLook.color : skin.colorOr(['track'], 0xdddddd);
    const front = fillLook?.kind === 'fill' ? fillLook.color : skin.colorOr(['fill', 'primary'], 0x3d7bfd);
    const backLayer = new Container();
    if (segments > 1) {
      // Segments evenly spaced edge to edge, each 0.4 of the step.
      const step = w / (segments - 1 + 0.4);
      const sw = step * 0.4;
      for (let i = 0; i < segments; i++) {
        const x = -w / 2 + i * step;
        for (const [layer, c] of [[backLayer, back], [this.fillLayer, front]] as const) {
          const s = new Sprite(whiteTexture());
          s.tint = c;
          s.setSize(sw, h);
          s.position.set(x, -h / 2);
          layer.addChild(s);
        }
      }
    } else {
      backLayer.addChild(plateGraphics(w, h, { color: back, radius: h / 2 }));
      this.fillLayer.addChild(plateGraphics(w, h, { color: front, radius: h / 2 }));
    }
    this.fillLayer.mask = this.clip;
    const knobLook = skin.look('slider.knob');
    this.knob = knobLook?.kind === 'art' ? artView(skin, knobLook, knobSize, knobSize) : plateGraphics(knobSize, knobSize, { color: skin.colorOr(['surface'], 0xffffff), radius: knobSize / 2, outline: { color: front, width: Math.max(3, knobSize * 0.08) } });
    this.addChild(backLayer, this.fillLayer, this.clip, this.knob);
    this.eventMode = 'static';
    this.cursor = 'pointer';
    this.hitArea = new Rectangle(-w / 2 - knobSize / 2, -Math.max(h, knobSize) / 2 - 10, w + knobSize, Math.max(h, knobSize) + 20);
    this.draw();

    const at = (e: FederatedPointerEvent): void => {
      const p = this.toLocal(e.global);
      this.v = clamp01((p.x + w / 2) / w);
      this.draw();
      this.onChange(this.v, this.dragging);
    };
    this.on('pointerdown', (e: FederatedPointerEvent) => {
      this.dragging = true;
      at(e);
    });
    this.on('globalpointermove', (e: FederatedPointerEvent) => {
      if (this.dragging) at(e);
    });
    const end = (): void => {
      if (!this.dragging) return;
      this.dragging = false;
      this.onChange(this.v, false);
    };
    this.on('pointerup', end);
    this.on('pointerupoutside', end);
  }

  private draw(): void {
    this.clip.clear().rect(-this.w / 2, -this.h / 2, this.w * this.v, this.h).fill(0xffffff);
    this.knob.position.set(-this.w / 2 + this.w * this.v, this.knobY);
  }
  get value(): number {
    return this.v;
  }
  set value(x: number) {
    if (this.dragging) return; // the player's finger wins over a binding echo
    this.v = clamp01(x);
    this.draw();
  }
}

/** Result stars. Centred row; params count (3), size, gap. Prop `value` (earned, 0..count); pops in when it grows. */
export class UIStars extends Container {
  private readonly stars: { full: Container; empty: Container }[] = [];
  private v = 0;
  constructor(
    skin: Skin,
    count: number,
    size: number,
    gap: number,
    public tweens: Tweens | null,
  ) {
    super();
    const one = (role: string, token: string) => {
      const look = skin.look(role);
      if (look?.kind === 'art') return artView(skin, look, size, size);
      return new Graphics().poly(starPoints(size / 2)).fill(skin.colorOr([token], 0xffc531));
    };
    const total = count * size + (count - 1) * gap;
    for (let i = 0; i < count; i++) {
      const x = -total / 2 + size / 2 + i * (size + gap);
      // The middle one a little higher, as result screens do.
      const y = count === 3 && i === 1 ? -size * 0.18 : 0;
      const empty = one('star.empty', 'star.empty');
      const full = one('star.full', 'star');
      for (const n of [empty, full]) n.position.set(x, y);
      full.visible = false;
      this.addChild(empty, full);
      this.stars.push({ full, empty });
    }
    this.eventMode = 'none';
  }
  get value(): number {
    return this.v;
  }
  set value(x: number) {
    const n = Math.max(0, Math.min(this.stars.length, Math.round(Number(x) || 0)));
    const prev = this.v;
    this.v = n;
    this.stars.forEach((s, i) => {
      const on = i < n;
      s.full.visible = on;
      if (on && i >= prev && this.tweens) {
        s.full.scale.set(0.01);
        void this.tweens.to(s.full.scale, { x: 1, y: 1 }, 0.35, { ease: 'outBack', delay: 0.12 * (i - prev), alive: () => !s.full.destroyed });
      }
    });
  }
}

export type ValueName = 'ui-progress' | 'ui-slider' | 'ui-stars';

export function values(svc: UIServices): Record<ValueName, (ctx: ComponentContext) => ComponentInstance> {
  const { skin, tweens, context } = svc;
  const p = (ctx: ComponentContext, k: string) => ctx.param(k);
  return {
    'ui-progress': (ctx) => {
      const b = adopt(new UIProgress(skin, num(p(ctx, 'w'), 420), num(p(ctx, 'h'), 36)), ctx);
      b.value = num(p(ctx, 'value'), 0);
      return { root: b };
    },
    'ui-slider': (ctx) => {
      const h = num(p(ctx, 'h'), 40);
      const s: UISlider = adopt(new UISlider(skin, num(p(ctx, 'w'), 420), h, num(p(ctx, 'segments'), 0), num(p(ctx, 'knob'), h * 1.6), num(p(ctx, 'knob-y'), 0)), ctx);
      s.value = num(p(ctx, 'value'), 1);
      const action = p(ctx, 'action');
      if (action) {
        s.onChange = (v, dragging) => {
          const fn = context[action];
          if (typeof fn !== 'function') throw new Error(`ui-slider #${ctx.attrs.id ?? '?'}: action "${action}" is not a function of the scene context`);
          (fn as (v: number, d: boolean) => void)(v, dragging);
        };
      }
      return { root: s };
    },
    'ui-stars': (ctx) => {
      const size = num(p(ctx, 'size'), 96);
      const st = adopt(new UIStars(skin, num(p(ctx, 'count'), 3), size, num(p(ctx, 'gap'), size * 0.2), null), ctx);
      st.value = num(p(ctx, 'value'), 0);
      st.tweens = tweens; // pop-in only for changes after mount
      return { root: st };
    },
  };
}
