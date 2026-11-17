// screens.ts — navigation between full screens (structure of pixijs/open-games `navigation`,
// without the global app): one current screen; show() loads the screen's asset bundle, waits for
// its scene to be ready, hides the old one and fades the new one in. Input is blocked during the
// switch. A screen = Trempel scene + bundle.
//
// 2.1: show(name, { transition }) — 'fade' (default), 'none', { fade: s }, { leaf: { dir, look,
// duration } } or a function over the snapshots of both screens (ui/transitions.ts). Without the
// transitions host (headless) a snapshot transition is the default fade.

import { Container } from 'pixi.js';
import type { Tweens } from '../anim/tweens.js';
import type { Screen } from './screen.js';
import type { ScreenTransition, Transitions } from './transitions.js';

/** 2.1: options of a switch. */
export interface ShowOptions {
  transition?: ScreenTransition;
}

/** The default fade, s. */
const FADE = 0.2;

export interface ScreenEntry {
  screen: Screen;
  /** Asset bundle loaded before the first show (Loader bundle name). */
  bundle?: string;
  onShow?: () => void;
  onHide?: () => void;
}

export class Screens {
  readonly layer = new Container();
  private readonly entries = new Map<string, ScreenEntry>();
  private currentName: string | null = null;
  private switching = false;
  private isBlocked = false;
  /** Called after a switch (state.screen, probes). */
  onChange: (name: string) => void = () => {};
  /** 2.1: snapshot transitions (createGame sets it; null — headless: a fade instead). */
  transitions: Transitions | null = null;

  /** 2.0: the screens take no input (an open popup over them); a switch blocks it too. */
  get blocked(): boolean {
    return this.isBlocked;
  }

  set blocked(v: boolean) {
    this.isBlocked = v;
    this.layer.interactiveChildren = !v && !this.switching;
  }

  constructor(
    private readonly tweens: Tweens,
    private readonly loadBundle: (name: string) => Promise<void>,
  ) {}

  add(name: string, entry: ScreenEntry): void {
    if (this.entries.has(name)) throw new Error(`screen "${name}" added twice`);
    this.entries.set(name, entry);
    entry.screen.root.visible = false;
  }

  get(name: string): Screen {
    const e = this.entries.get(name);
    if (!e) throw new Error(`screen "${name}" not found (known: ${[...this.entries.keys()].join(', ')})`);
    return e.screen;
  }

  names(): string[] {
    return [...this.entries.keys()];
  }

  get current(): string | null {
    return this.currentName;
  }

  /** A switch runs (its bundle loads, its transition plays). */
  get switchingNow(): boolean {
    return this.switching;
  }

  /**
   * Switch to a screen: `fade` seconds of cross-fade (0 = instant) — or (2.1) { transition }.
   */
  async show(name: string, opts: number | ShowOptions = FADE): Promise<void> {
    const next = this.entries.get(name);
    if (!next) throw new Error(`screen "${name}" not found (known: ${[...this.entries.keys()].join(', ')})`);
    if (this.currentName === name) return;
    const tr = typeof opts === 'number' ? opts : (opts.transition ?? 'fade');
    this.switching = true;
    this.layer.interactiveChildren = false;
    try {
      if (next.bundle) await this.loadBundle(next.bundle);
      await next.screen.scene.ready;
      const prev = this.currentName ? this.entries.get(this.currentName)! : null;
      const fade = typeof tr === 'number' ? tr : tr === 'none' ? 0 : tr === 'fade' ? FADE : 'fade' in tr ? tr.fade : null;
      const shots = fade === null && prev && this.transitions ? this.transitions : null;
      const rect = next.screen.rect;
      const before = shots ? shots.snapshot(prev!.screen.root, rect) : null;
      this.currentName = name;
      const root = next.screen.root;
      this.layer.addChild(root);
      root.visible = true;
      next.onShow?.();
      this.onChange(name);
      if (prev) {
        const old = prev.screen.root;
        const hideOld = () => {
          old.visible = false;
          old.alpha = 1;
          old.parent?.removeChild(old);
          prev.onHide?.();
        };
        if (shots && before) {
          // Both as they are on the window: the leaving one before the switch, the arriving one now.
          hideOld();
          const after = shots.snapshot(root, rect);
          await shots.play(tr as Exclude<ScreenTransition, 'fade' | 'none' | { fade: number } | number>, before, after, rect);
        } else {
          const f = fade ?? FADE;
          if (f > 0) {
            root.alpha = 0;
            await this.tweens.to(root, { alpha: 1 }, f, 'outQuad');
          }
          hideOld();
        }
      }
      root.alpha = 1;
    } finally {
      this.switching = false;
      this.layer.interactiveChildren = !this.isBlocked;
    }
  }
}
