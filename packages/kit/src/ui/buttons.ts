// buttons.ts — ButtonFX: pointer down → scale to 0.8 × base in
// 0.3 s OutCubic; up / exit → base in 0.3 s OutBack. Scaling is around the node's centre.

import type { Container, FederatedPointerEvent } from 'pixi.js';
import type { Tweens } from '../anim/tweens.js';

export const BUTTON = { pressScale: 0.8, pressTime: 0.3, releaseTime: 0.3 };

/** Move the pivot to the local bounds centre without moving the node on screen. */
export function centerPivot(node: Container): void {
  const b = node.getLocalBounds();
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const dx = (cx - node.pivot.x) * node.scale.x;
  const dy = (cy - node.pivot.y) * node.scale.y;
  node.pivot.set(cx, cy);
  node.position.set(node.x + dx, node.y + dy);
}

/** Press feedback on a node (scene buttons get it from `data-fx="press"`). */
export function buttonFx(node: Container, tweens: Tweens): void {
  let base: number | null = null;
  const to = (k: number, dur: number, e: 'outCubic' | 'outBack') => {
    if (base === null) {
      centerPivot(node);
      base = node.scale.x;
    }
    tweens.kill(node.scale);
    void tweens.to(node.scale, { x: base * k, y: base * k }, dur, { ease: e, alive: () => !node.destroyed });
  };
  node.eventMode = 'static';
  node.cursor = 'pointer';
  node.on('pointerdown', (e: FederatedPointerEvent) => {
    if (e.button > 0) return;
    to(BUTTON.pressScale, BUTTON.pressTime, 'outCubic');
  });
  const up = () => {
    if (base !== null) to(1, BUTTON.releaseTime, 'outBack');
  };
  node.on('pointerup', up);
  node.on('pointerupoutside', up);
  node.on('pointerleave', up);
}
