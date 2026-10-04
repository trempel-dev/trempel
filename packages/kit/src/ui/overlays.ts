// overlays.ts — screens over EVERYTHING (above screens and popups): a loading / title screen that
// covers the game from the first frame and closes with its own animation while the game already
// runs under it (a main menu over the level). Not popups: they do not block input, do not queue and do
// not count in `kit.popup`; input passes to the game the moment hide() starts.

import { Container } from 'pixi.js';
import type { Tweens } from '../anim/tweens.js';
import type { Screen } from './screen.js';

export type OverlayAnim = 'scale' | 'fade' | 'none';

export interface OverlayHide {
  /** Hide animation (default fade): scale — #content (or the root) → 0.01, OutBack; fade — alpha → 0. */
  anim?: OverlayAnim;
  /** Animation time, s (default 0.2). */
  duration?: number;
  /** Gone (invisible) after this many seconds — may be shorter than the animation (default = duration). */
  goneAfter?: number;
}

export const OVERLAY = { duration: 0.2, from: 0.01 };

interface Entry {
  screen: Screen;
  open: boolean;
  onShow?: () => void;
  onHidden?: () => void;
}

export class Overlays {
  readonly layer = new Container();
  private readonly entries = new Map<string, Entry>();
  onChange: (name: string, open: boolean) => void = () => {};

  constructor(private readonly tweens: Tweens) {
    this.layer.label = 'kit:overlays';
  }

  add(name: string, screen: Screen, hooks: { onShow?: () => void; onHidden?: () => void } = {}): void {
    if (this.entries.has(name)) throw new Error(`overlay "${name}" added twice`);
    this.entries.set(name, { screen, open: false, ...hooks });
    screen.root.visible = false;
  }

  get(name: string): Screen {
    return this.entry(name).screen;
  }

  names(): string[] {
    return [...this.entries.keys()];
  }

  isOpen(name: string): boolean {
    return this.entry(name).open;
  }

  private entry(name: string): Entry {
    const e = this.entries.get(name);
    if (!e) throw new Error(`overlay "${name}" not found (known: ${[...this.entries.keys()].join(', ') || 'none'})`);
    return e;
  }

  show(name: string): void {
    const e = this.entry(name);
    const root = e.screen.root;
    this.tweens.kill(root);
    const content = e.screen.scene.byId.get('content') as Container | undefined;
    (content ?? root).scale.set(1);
    root.alpha = 1;
    root.eventMode = 'passive';
    root.interactiveChildren = true;
    this.layer.addChild(root);
    root.visible = true;
    e.open = true;
    e.onShow?.();
    this.onChange(name, true);
  }

  /** Hide with an animation; input passes through at once. Resolves when it is gone. */
  async hide(name: string, opts: OverlayHide = {}): Promise<void> {
    const e = this.entry(name);
    if (!e.open) return;
    e.open = false;
    const root = e.screen.root;
    root.eventMode = 'none';
    root.interactiveChildren = false;
    this.onChange(name, false);
    const anim = opts.anim ?? 'fade';
    const dur = opts.duration ?? OVERLAY.duration;
    const gone = opts.goneAfter ?? dur;
    const alive = () => !root.destroyed;
    if (anim === 'scale') {
      const target = (e.screen.scene.byId.get('content') as Container | undefined) ?? root;
      void this.tweens.to(target.scale, { x: OVERLAY.from, y: OVERLAY.from }, dur, { ease: 'outBack', alive, target: root });
    } else if (anim === 'fade') void this.tweens.to(root, { alpha: 0 }, dur, { ease: 'outQuad', alive, target: root });
    if (anim !== 'none' && gone > 0) await this.tweens.wait(gone);
    if (e.open) return; // shown again meanwhile
    this.tweens.kill(root);
    root.visible = false;
    root.parent?.removeChild(root);
    e.onHidden?.();
  }
}
