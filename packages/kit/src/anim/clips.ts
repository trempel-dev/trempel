// clips.ts — Trempel clips (anim.json) on the kit's loop. The Trempel `Animator` reads an injectable
// Clock; the kit gives it the loop's clock and ticks it from the UI channel, so clips stop with a
// platform pause and speed up with `speed` (turbo on the fly). Clip targets are scene node ids
// (resolved in the scene the clip plays on) or `$param` handles.

import { Animator, type AnimClip, type Handle, type NodeHandle, type PlayOptions, type RendererBackend } from '@trempel/scene';
import type { GameLoop } from '../time/loop.js';

export interface ClipPlayOptions extends PlayOptions {
  /** Scene to resolve node-id targets in (`byId` of a mounted scene / Screen). */
  scene?: { byId: Map<string, NodeHandle> };
}

export class Clips {
  private readonly animator: Animator;
  private scene: { byId: Map<string, NodeHandle> } | null = null;
  /** Global speed multiplier, read every frame (×speed of each play). */
  speed = 1;

  constructor(backend: RendererBackend, loop: GameLoop) {
    this.animator = new Animator(backend, loop.clock, (id) => this.scene?.byId.get(id));
    loop.add(() => this.animator.tick(), 'ui');
  }

  /** Play a clip; `await handle.done`. Node ids resolve in `opts.scene`. */
  play(clip: AnimClip, opts: ClipPlayOptions = {}): Handle {
    const own = opts.speed ?? 1;
    const speed = () => this.speed * (typeof own === 'function' ? own() : own);
    this.scene = opts.scene ?? null;
    try {
      return this.animator.play(clip, { ...opts, speed });
    } finally {
      this.scene = null;
    }
  }
}

export type { AnimClip, Handle };
