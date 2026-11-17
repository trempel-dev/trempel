// popups.ts — popup manager: a queue of popups with animated show/hide.
//
// Layers: 'over' (below) and 'default' (above). One popup of a name open at a time; a second
// request waits in the queue and opens after a close. `blocking` is true while any popup is open
// (the game pauses its timers on it if it wants).
//
// 2.0 input: a popup takes the input while it is OPEN — `isOpen()` (not while it closes): the top
// open popup alone is interactive, the popups under it are not (createGame also blocks the screens
// under them); a closing popup takes nothing — its fading dim does not eat the next click.
//
// Animations (DOTween-style timings): `scale` — dim alpha 0 → its own alpha in 0.2 s
// OutQuad, content 0.01 → 1 in 0.3 s OutBack; hide: content → 0.01 in 0.2 s, dim → 0 in 0.2 s,
// gone after 0.301 s. `top` — content slides in from above (canvas height + 20) in 0.3 s OutQuad,
// out in 0.2 s. `none` — instant.
//
// A popup is a Screen whose base has `#dim` (optional) and `#content` (authored with its origin
// at the frame centre: `transform="translate(cx,cy)" data-anchor="0.5 0.5"`).

import { Container } from 'pixi.js';
import type { Tweens } from '../anim/tweens.js';
import type { Screen } from './screen.js';

export const POPUP = { dimIn: 0.2, showScale: 0.3, hide: 0.2, destroyAfter: 0.301, slideIn: 0.3, slideOut: 0.2, slideExtra: 20, from: 0.01 };

export type PopupLayer = 'over' | 'default';
export type PopupAnim = 'scale' | 'top' | 'none';

export interface PopupDef {
  name: string;
  screen: Screen;
  layer: PopupLayer;
  anim: PopupAnim;
  /** Called before the show animation. */
  onShow?: () => void;
  /** Called when fully hidden. */
  onHidden?: () => void;
}

interface Open {
  def: PopupDef;
  closing: boolean;
}

export class Popups {
  readonly layers: Record<PopupLayer, Container> = { over: new Container(), default: new Container() };
  private readonly defs = new Map<string, PopupDef>();
  private readonly open: Open[] = [];
  private readonly queue: string[] = [];
  private readonly dimAlpha = new Map<string, number>();
  /** Called whenever the open set changes. */
  onChange: () => void = () => {};
  /** Called on every show (popup sound). */
  onShowSound: () => void = () => {};
  /** 2.1: called when a popup starts closing with its animation (popup sound) — not by closeNow() / closeAll(). */
  onHideSound: () => void = () => {};

  constructor(private readonly tweens: Tweens) {}

  register(def: PopupDef): void {
    if (this.defs.has(def.name)) throw new Error(`popup "${def.name}" registered twice`);
    this.defs.set(def.name, def);
    const dim = def.screen.scene.byId.get('dim') as Container | undefined;
    if (dim) this.dimAlpha.set(def.name, dim.alpha);
    def.screen.root.visible = false;
  }

  def(name: string): PopupDef {
    const d = this.defs.get(name);
    if (!d) throw new Error(`popup "${name}" not registered (known: ${[...this.defs.keys()].join(', ')})`);
    return d;
  }

  names(): string[] {
    return [...this.defs.keys()];
  }

  isOpen(name?: string): boolean {
    return this.open.some((o) => !o.closing && (!name || o.def.name === name));
  }

  /** A show of `name` waits in the queue (asked while it was open or closing). */
  queued(name: string): boolean {
    return this.queue.includes(name);
  }

  /** Any popup open. */
  get blocking(): boolean {
    return this.open.length > 0;
  }

  /** Topmost open popup name. */
  top(): string | null {
    const o = [...this.open].reverse().find((x) => !x.closing);
    return o?.def.name ?? null;
  }

  show(name: string): void {
    const def = this.def(name);
    if (this.open.some((o) => o.def.name === name)) {
      if (!this.queue.includes(name)) this.queue.push(name);
      return;
    }
    const { screen } = def;
    const root = screen.root;
    this.tweens.kill(root);
    this.layers[def.layer].addChild(root);
    root.visible = true;
    def.onShow?.();
    this.open.push({ def, closing: false });
    this.gate();
    this.onShowSound();
    const dim = screen.scene.byId.get('dim') as Container | undefined;
    const content = screen.scene.byId.get('content') as Container | undefined;
    const alive = () => !root.destroyed;
    if (dim && def.anim !== 'none') {
      dim.alpha = 0;
      void this.tweens.to(dim, { alpha: this.dimAlpha.get(name) ?? 1 }, POPUP.dimIn, { ease: 'outQuad', alive, target: root });
    }
    if (content) {
      if (def.anim === 'scale') {
        content.scale.set(POPUP.from);
        void this.tweens.to(content.scale, { x: 1, y: 1 }, POPUP.showScale, { ease: 'outBack', alive, target: root });
      } else if (def.anim === 'top') {
        const y = content.y;
        content.y = y - (screen.h + POPUP.slideExtra);
        void this.tweens.to(content, { y }, POPUP.slideIn, { ease: 'outQuad', alive, target: root });
      }
    }
    this.onChange();
  }

  /** Close with the hide animation (`instant`: none). Resolves when the popup is gone. */
  async hide(name: string, instant = false): Promise<void> {
    const o = this.open.find((x) => x.def.name === name && !x.closing);
    if (!o) return;
    o.closing = true;
    if (!instant) this.onHideSound();
    this.gate();
    this.onChange();
    const { def } = o;
    const { screen } = def;
    const root = screen.root;
    const dim = screen.scene.byId.get('dim') as Container | undefined;
    const content = screen.scene.byId.get('content') as Container | undefined;
    const alive = () => !root.destroyed;
    this.tweens.kill(root);
    let restoreY: number | null = null;
    if (def.anim !== 'none' && !instant) {
      if (dim) void this.tweens.to(dim, { alpha: 0 }, POPUP.hide, { ease: 'outQuad', alive, target: root });
      if (content && def.anim === 'scale') void this.tweens.to(content.scale, { x: POPUP.from, y: POPUP.from }, POPUP.hide, { ease: 'outBack', alive, target: root });
      else if (content && def.anim === 'top') {
        restoreY = content.y;
        void this.tweens.to(content, { y: content.y - (screen.h + POPUP.slideExtra) }, POPUP.slideOut, { ease: 'outQuad', alive, target: root });
      }
      await this.tweens.wait(POPUP.destroyAfter);
    }
    this.tweens.kill(root);
    root.visible = false;
    root.parent?.removeChild(root);
    if (content) {
      content.scale.set(1);
      if (restoreY !== null) content.y = restoreY;
    }
    if (dim) dim.alpha = this.dimAlpha.get(name) ?? 1;
    this.open.splice(this.open.indexOf(o), 1);
    this.gate();
    def.onHidden?.();
    this.onChange();
    const next = this.queue.findIndex((q) => !this.open.some((x) => x.def.name === q));
    if (next >= 0) this.show(this.queue.splice(next, 1)[0]);
  }

  /**
   * Close one popup NOW, without its animation (a popup replaced by another at once, the map over
   * itself) — the same bookkeeping as hide(): onHidden, the queue, onChange. Synchronous.
   */
  closeNow(name: string): void {
    void this.hide(name, true);
  }

  /** Close everything immediately. */
  closeAll(): void {
    for (const o of [...this.open]) {
      this.tweens.kill(o.def.screen.root);
      o.def.screen.root.visible = false;
      o.def.screen.root.parent?.removeChild(o.def.screen.root);
      const content = o.def.screen.scene.byId.get('content') as Container | undefined;
      content?.scale.set(1);
      o.def.onHidden?.();
    }
    this.open.length = 0;
    this.queue.length = 0;
    this.gate();
    this.onChange();
  }

  /** Who takes the input: the top open popup only; closing ones and the ones under it — nothing. */
  private gate(): void {
    const top = [...this.open].reverse().find((o) => !o.closing) ?? null;
    for (const o of this.open) {
      const on = o === top;
      o.def.screen.root.interactiveChildren = on;
      o.def.screen.root.eventMode = on ? 'passive' : 'none';
    }
    for (const d of this.defs.values()) {
      if (!this.open.some((o) => o.def === d)) {
        d.screen.root.interactiveChildren = true;
        d.screen.root.eventMode = 'passive';
      }
    }
  }
}
