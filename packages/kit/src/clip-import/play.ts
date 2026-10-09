// play.ts — a clip played on a scene without a renderer: the base mounted by Trempel's own
// mountScene on the headless backend, the clip played by its Animator on a manual clock. Used by
// the importers' verification (their own sampler of the source format against Trempel itself) and
// to freeze a clip at a time.

import { Animator, mountScene, type AnimClip, type MountedScene } from '@trempel/scene';
import { createHeadlessBackend, type HNode } from './headless.js';

export interface HeadlessPlay {
  scene: MountedScene;
  node(id: string): HNode | undefined;
  /** Move the clip to `t` seconds (call with non-decreasing times). */
  at(t: number): void;
}

export function playHeadless(svg: string, clip: AnimClip | null, params?: Record<string, number>): HeadlessPlay {
  const backend = createHeadlessBackend();
  const scene = mountScene(svg, { backend, context: {} });
  const clock = { ms: 0, now(): number { return this.ms; } };
  const animator = new Animator(backend, clock, (id) => scene.byId.get(id), { path: (id) => scene.path(id) });
  if (clip) animator.play(clip, params ? { params } : {});
  return {
    scene,
    node: (id) => scene.byId.get(id) as HNode | undefined,
    at(t) {
      clock.ms = t * 1000;
      animator.tick();
    },
  };
}
