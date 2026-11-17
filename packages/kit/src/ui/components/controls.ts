// controls.ts — buttons, plates, panels, the popup frame, the badge, the toggle (kit components;
// looks from the skin, see base.ts). Each is a Container subclass: the heir binds its setters
// (tml:bind-text, tml:bind-disabled, tml:bind-on…) and its clicks (tml:on-click).

import { ColorMatrixFilter, Container, Graphics, Rectangle, Text } from 'pixi.js';
import type { ComponentContext, ComponentInstance } from '@trempel/scene';
import { setTextFit } from '../kit-backend.js';
import type { Skin } from '../skin/skin.js';
import { adopt, artView, childText, label, num, plate, pressStates, setDisabled, type UIServices } from './base.js';
import { drawIcon } from './icons.js';

const fg = (skin: Skin, variant: string): number => skin.colorOr([`on${variant[0].toUpperCase()}${variant.slice(1)}`, 'onPrimary'], 0xffffff);
const bg = (skin: Skin, variant: string): number => skin.colorOr([variant, 'primary'], 0x3d7bfd);

/** Wide button with a label. Centred; params w, h, variant (primary | secondary | danger | neutral | token), size (font). */
export class UIButton extends Container {
  private readonly labelNode: Text;
  private readonly back = new Container();
  private dis = { f: null as ColorMatrixFilter | null };
  private disabledNow = false;
  private variantNow: string;

  constructor(
    private readonly skin: Skin,
    readonly w: number,
    readonly h: number,
    variant: string,
    text: string,
    size: number,
  ) {
    super();
    this.variantNow = variant;
    this.addChild(this.back);
    this.labelNode = label(skin, text, size, fg(skin, variant), w * 0.84);
    this.labelNode.y = -h * 0.04;
    this.addChild(this.labelNode);
    this.drawBack();
    this.hitArea = new Rectangle(-w / 2, -h / 2, w, h);
    pressStates(this, skin);
  }

  private drawBack(): void {
    this.back.removeChildren().forEach((c) => c.destroy());
    const v = this.variantNow;
    const s = this.skin;
    this.back.addChild(plate(s, [`button.${v}`, 'button'], this.w, this.h, () => ({ color: bg(s, v), radius: s.radius('button', this.h), lip: this.h * 0.08, outline: { color: s.colorOr(['outline'], 0), width: s.outline } })));
    this.labelNode.style.fill = fg(s, v);
  }

  get text(): string {
    return this.labelNode.text;
  }
  set text(v: string) {
    this.labelNode.text = v == null ? '' : String(v);
    setTextFit(this.labelNode, this.w * 0.84);
  }
  get variant(): string {
    return this.variantNow;
  }
  set variant(v: string) {
    if (!v || v === this.variantNow) return;
    this.variantNow = v;
    this.drawBack();
  }
  get disabled(): boolean {
    return this.disabledNow;
  }
  set disabled(v: boolean) {
    this.disabledNow = !!v;
    setDisabled(this, this.skin, this.disabledNow, this.dis);
  }
}

/** The glyph of an icon: skin art (role icon.<name>) or the procedural one, in a box `s`, centred. */
export function iconView(skin: Skin, name: string, s: number, color: number): Container {
  const look = skin.look(`icon.${name}`);
  if (look?.kind === 'art') return artView(skin, look, s, s);
  if (look?.kind === 'none') return new Container();
  const g = new Graphics();
  drawIcon(g, name, s, color);
  return g;
}

/** Round icon button. Centred; params size, icon, variant (plate colour token; default neutral), plate ("none" = icon only). */
export class UIIconButton extends Container {
  protected readonly glyph = new Container();
  private dis = { f: null as ColorMatrixFilter | null };
  private disabledNow = false;
  protected iconNow: string;

  constructor(
    protected readonly skin: Skin,
    readonly size: number,
    icon: string,
    protected readonly variant: string,
    protected readonly withPlate: boolean,
  ) {
    super();
    this.iconNow = icon;
    if (withPlate) {
      this.addChild(plate(skin, [`iconButton.${variant}`, 'iconButton'], size, size, () => ({ color: bg(skin, variant), radius: size / 2, lip: size * 0.06, outline: { color: skin.colorOr(['outline'], 0), width: skin.outline } })));
    }
    this.addChild(this.glyph);
    this.drawIcon();
    this.hitArea = new Rectangle(-size / 2, -size / 2, size, size);
    pressStates(this, skin);
  }

  protected drawIcon(): void {
    this.glyph.removeChildren().forEach((c) => c.destroy());
    if (!this.iconNow) return;
    // On a plate the glyph takes 0.56 of it; without one (plate="none") the icon IS the button —
    // e.g. a skin's round icon art — and fills the size.
    const v = iconView(this.skin, this.iconNow, this.withPlate ? this.size * 0.56 : this.size, this.withPlate ? fg(this.skin, this.variant) : this.skin.colorOr(['onBg'], 0xffffff));
    if (this.withPlate) v.y = -this.size * 0.03;
    this.glyph.addChild(v);
  }

  get icon(): string {
    return this.iconNow;
  }
  set icon(v: string) {
    if (v === this.iconNow) return;
    this.iconNow = v;
    this.drawIcon();
  }
  get disabled(): boolean {
    return this.disabledNow;
  }
  set disabled(v: boolean) {
    this.disabledNow = !!v;
    setDisabled(this, this.skin, this.disabledNow, this.dis);
  }
}

/** A pair of icons for a two-state setting (sound on/off). Params like the icon button + on, off (icon names). Prop `checked`. */
export class UIToggle extends UIIconButton {
  private state = true;
  constructor(
    skin: Skin,
    size: number,
    private readonly onIcon: string,
    private readonly offIcon: string,
    variant: string,
    withPlate: boolean,
  ) {
    super(skin, size, onIcon, variant, withPlate);
  }
  get checked(): boolean {
    return this.state;
  }
  set checked(v: boolean) {
    this.state = !!v;
    this.icon = this.state ? this.onIcon : this.offIcon;
  }
}

/** Title plate / pill with a text. Centred; params w, h, size, color (text token). Prop `text`. */
export class UIPlate extends Container {
  private readonly labelNode: Text;
  constructor(
    skin: Skin,
    readonly w: number,
    readonly h: number,
    text: string,
    size: number,
    role = 'plate',
    color?: string,
  ) {
    super();
    this.addChild(plate(skin, [role, 'plate'], w, h, () => ({ color: skin.colorOr(['surface'], 0xffffff), radius: skin.radius('plate', h), outline: { color: skin.colorOr(['outline'], 0), width: Math.max(2, skin.outline) } })));
    this.labelNode = label(skin, text, size, color ? skin.color(color) : skin.colorOr(['onSurface'], 0), w * 0.8);
    this.addChild(this.labelNode);
  }
  get text(): string {
    return this.labelNode.text;
  }
  set text(v: string) {
    this.labelNode.text = v == null ? '' : String(v);
    setTextFit(this.labelNode, this.w * 0.8);
  }
}

/** A panel (light, or variant="dark"). Centred; params w, h, variant. */
export class UIPanel extends Container {
  constructor(skin: Skin, w: number, h: number, variant: string) {
    super();
    const role = variant ? `panel.${variant}` : 'panel';
    const token = variant ? `surface.${variant}` : 'surface';
    this.addChild(plate(skin, [role, 'panel'], w, h, () => ({ color: skin.colorOr([token, 'surface'], 0xffffff), radius: skin.radius('panel', h), outline: { color: skin.colorOr(['outline'], 0), width: skin.outline } })));
  }
}

/** Popup frame: a panel with a title plate straddling its top edge. Centred; params w, h, title-w, title-h, size. Prop `title`. */
export class UIPopupFrame extends Container {
  private readonly titlePlate: UIPlate | null;
  constructor(skin: Skin, w: number, h: number, title: string, titleW: number, titleH: number, size: number) {
    super();
    this.addChild(plate(skin, ['popup', 'panel'], w, h, () => ({ color: skin.colorOr(['surface'], 0xffffff), radius: skin.radius('popup', h), lip: 10, outline: { color: skin.colorOr(['outline'], 0), width: skin.outline } })));
    this.titlePlate = titleH > 0 ? new UIPlate(skin, titleW, titleH, title, size, 'popup.title') : null;
    if (this.titlePlate) {
      this.titlePlate.y = -h / 2;
      this.addChild(this.titlePlate);
    }
  }
  get title(): string {
    return this.titlePlate?.text ?? '';
  }
  set title(v: string) {
    if (this.titlePlate) this.titlePlate.text = v;
  }
}

/** Counter badge. Centred; params size, variant (token; default accent). Props `text` / `count`. */
export class UIBadge extends Container {
  private readonly labelNode: Text;
  constructor(
    skin: Skin,
    readonly size: number,
    variant: string,
    text: string,
  ) {
    super();
    this.addChild(plate(skin, ['badge'], size, size, () => ({ color: skin.colorOr([variant, 'accent'], 0xffb020), radius: size / 2, outline: { color: skin.colorOr(['surface'], 0xffffff), width: Math.max(2, size * 0.06) } })));
    this.labelNode = label(skin, text, size * 0.56, fg(skin, variant), size * 0.78);
    this.addChild(this.labelNode);
    this.eventMode = 'none';
  }
  get text(): string {
    return this.labelNode.text;
  }
  set text(v: string) {
    this.labelNode.text = v == null ? '' : String(v);
    setTextFit(this.labelNode, this.size * 0.78);
  }
  set count(v: number) {
    this.text = String(v);
  }
}

export type ControlName = 'ui-button' | 'ui-icon-button' | 'ui-toggle' | 'ui-plate' | 'ui-panel' | 'ui-popup-frame' | 'ui-badge';

/** Factories of the controls (ComponentFactory per tml:type). */
export function controls(svc: UIServices): Record<ControlName, (ctx: ComponentContext) => ComponentInstance> {
  const { skin } = svc;
  const p = (ctx: ComponentContext, k: string) => ctx.param(k);
  const wrap = <T extends Container>(root: T, ctx: ComponentContext) => ({ root: adopt(root, ctx) });
  return {
    'ui-button': (ctx) => {
      const h = num(p(ctx, 'h'), 96);
      return wrap(new UIButton(skin, num(p(ctx, 'w'), 320), h, p(ctx, 'variant') ?? 'primary', p(ctx, 'text') ?? childText(ctx), num(p(ctx, 'size'), h * 0.42)), ctx);
    },
    'ui-icon-button': (ctx) => wrap(new UIIconButton(skin, num(p(ctx, 'size'), 96), p(ctx, 'icon') ?? '', p(ctx, 'variant') ?? 'neutral', p(ctx, 'plate') !== 'none'), ctx),
    'ui-toggle': (ctx) => wrap(new UIToggle(skin, num(p(ctx, 'size'), 96), p(ctx, 'on') ?? 'sound-on', p(ctx, 'off') ?? 'sound-off', p(ctx, 'variant') ?? 'neutral', p(ctx, 'plate') !== 'none'), ctx),
    'ui-plate': (ctx) => {
      const h = num(p(ctx, 'h'), 88);
      return wrap(new UIPlate(skin, num(p(ctx, 'w'), 360), h, p(ctx, 'text') ?? childText(ctx), num(p(ctx, 'size'), h * 0.46), p(ctx, 'role') ?? 'plate', p(ctx, 'color')), ctx);
    },
    'ui-panel': (ctx) => wrap(new UIPanel(skin, num(p(ctx, 'w'), 560), num(p(ctx, 'h'), 400), p(ctx, 'variant') ?? ''), ctx),
    'ui-popup-frame': (ctx) => {
      const w = num(p(ctx, 'w'), 600);
      const th = num(p(ctx, 'title-h'), 96);
      return wrap(new UIPopupFrame(skin, w, num(p(ctx, 'h'), 640), p(ctx, 'title') ?? childText(ctx), num(p(ctx, 'title-w'), w * 0.7), th, num(p(ctx, 'size'), th * 0.46)), ctx);
    },
    'ui-badge': (ctx) => wrap(new UIBadge(skin, num(p(ctx, 'size'), 56), p(ctx, 'variant') ?? 'accent', p(ctx, 'text') ?? childText(ctx)), ctx),
  };
}

