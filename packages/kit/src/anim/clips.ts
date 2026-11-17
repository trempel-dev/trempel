// clips.ts — Trempel clips (anim.json) on the kit's loop. The Trempel `Animator` reads an injectable
// Clock; the kit gives it the loop's clock and ticks it from the UI channel, so clips stop with a
// platform pause and speed up with `speed` (turbo on the fly). Clip targets are scene node ids
// (resolved in the scene the clip plays on) or `$param` handles.

import { Animator, type AnimClip, type Handle, type NodeHandle, type PlayOptions, type RendererBackend } from '@trempel/scene';
import type { GameLoop } from '../time/loop.js';

export interface ClipPlayOptions extends PlayOptions {
  /** Scene to resolve node-id targets in (`byId` of a mounted scene / Screen). */
  scene?: { byId: Map<string, NodeHandle>; components?: Map<string, unknown> };
}

/** 2.2: what the kit does with a clip's marker before the play's own onMarker (effects: `fx:<name>@<node>`). */
export type MarkerHandler = (name: string, scene: ClipPlayOptions['scene'] | null) => void;

export class Clips {
  private readonly animator: Animator;
  private scene: { byId: Map<string, NodeHandle> } | null = null;
  /** Global speed multiplier, read every frame (×speed of each play). */
  speed = 1;
  /** 2.2: markers of every play go here first (createGame: `fx:` markers play effects). */
  onMarker: MarkerHandler | null = null;

  constructor(backend: RendererBackend, loop: GameLoop) {
    this.animator = new Animator(backend, loop.clock, (id) => this.scene?.byId.get(id));
    loop.add(() => this.animator.tick(), 'ui');
  }

  /** Play a clip; `await handle.done`. Node ids resolve in `opts.scene`. */
  play(clip: AnimClip, opts: ClipPlayOptions = {}): Handle {
    const ownSpeed = opts.speed ?? 1;
    const speed = () => this.speed * (typeof ownSpeed === 'function' ? ownSpeed() : ownSpeed);
    this.scene = opts.scene ?? null;
    const scene = opts.scene ?? null;
    const own = opts.onMarker;
    const onMarker = (name: string): void => {
      this.onMarker?.(name, scene);
      own?.(name);
    };
    try {
      return this.animator.play(clip, { ...opts, speed, onMarker });
    } finally {
      this.scene = null;
    }
  }
}

export type { AnimClip, Handle };
