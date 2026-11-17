// presets.ts — ready-made effects on built-in shapes (no art needed): burst, confetti, sparkle,
// smoke, coins, trail. Each is a ParticleConfig; tweak by spreading: { ...PARTICLES.burst, max: 40 }.
// 2.5: coinFountain, coinBurst — spinning coins from an atlas named `coin` in the effects' textures
// (frames in natural order, out of phase); without it they play plain circles (the colour is white — it tints the art).

import { particleConfig, type ParticleConfig } from './types.js';

const DEG20 = (20 * Math.PI) / 180;
const ring = (radius = 0) => ({ type: 'circle' as const, radius, thickness: 1, arc: Math.PI * 2, scale: [1, 1] as [number, number] });

export const PARTICLES = {
  /** One-shot radial burst (pickup, eat, hit). */
  burst: particleConfig({
    duration: 0.1, lifetime: [0.35, 0.6], speed: [120, 260], size: [10, 18], max: 40,
    bursts: [{ time: 0, count: 24, cycles: 1, interval: 0, prob: 1 }], shape: ring(4),
    sizeOverLifetime: [[0, 1], [1, 0]], colorOverLifetime: { color: [[0, 1, 1, 1], [1, 1, 1, 1]], alpha: [[0, 1], [0.7, 1], [1, 0]] },
    color: [[1, 0.85, 0.3, 1], [1, 0.45, 0.2, 1]], texture: 'circle', blend: 'add',
  }),
  /** Celebration confetti falling with gravity (win screens). */
  confetti: particleConfig({
    duration: 0.2, lifetime: [1.2, 2], speed: [250, 520], size: [10, 16], max: 120, gravity: 700,
    bursts: [{ time: 0, count: 90, cycles: 1, interval: 0, prob: 1 }],
    shape: { type: 'circle', radius: 10, thickness: 1, arc: Math.PI, scale: [1, 1] },
    rotation: [0, 6.28], spin: [-8, 8], color: [[1, 0.3, 0.4, 1], [0.3, 0.7, 1, 1]], texture: 'square',
    colorOverLifetime: { color: [[0, 1, 1, 1], [1, 1, 1, 1]], alpha: [[0, 1], [0.8, 1], [1, 0]] },
  }),
  /** Looping sparkle around a point (highlights, buttons). Stop it to fade out. */
  sparkle: particleConfig({
    duration: 1, loop: true, lifetime: [0.5, 0.9], speed: [10, 40], size: [6, 14], max: 40, rate: 18,
    shape: ring(40), sizeOverLifetime: [[0, 0], [0.3, 1], [1, 0]], spin: [-3, 3], texture: 'star', blend: 'add',
    color: [1, 0.95, 0.6, 1],
  }),
  /** Soft rising smoke puff. */
  smoke: particleConfig({
    duration: 0.15, lifetime: [0.6, 1.1], speed: [20, 60], size: [24, 40], max: 30, gravity: -60,
    bursts: [{ time: 0, count: 14, cycles: 1, interval: 0, prob: 1 }], shape: ring(12),
    sizeOverLifetime: [[0, 0.6], [1, 1.4]], colorOverLifetime: { color: [[0, 1, 1, 1], [1, 1, 1, 1]], alpha: [[0, 0.5], [1, 0]] },
    color: [0.8, 0.8, 0.85, 1], texture: 'circle',
  }),
  /** Coin fountain (rewards). */
  coins: particleConfig({
    duration: 1.2, lifetime: [1, 1.6], speed: [380, 620], size: [18, 26], max: 160, gravity: 900, rate: 70,
    shape: { type: 'circle', radius: 6, thickness: 1, arc: Math.PI, scale: [0.5, 1] },
    rotation: [0, 6.28], spin: [-6, 6], color: [1, 0.82, 0.2, 1], texture: 'circle',
    colorOverLifetime: { color: [[0, 1, 1, 1], [1, 1, 1, 1]], alpha: [[0, 1], [0.85, 1], [1, 0]] },
  }),
  /**
   * 2.5: the big win coin fountain: up in a ±20° fan from an 80 px strip, falling back under gravity,
   * spinning, growing 0.5 → 1 over ~3 s; the frames of the `coin` atlas animate (24 fps, random start).
   * Without the atlas — white circles.
   */
  coinFountain: particleConfig({
    duration: 1.5, lifetime: [2.6, 3.2], speed: [700, 1150], size: 64, max: 500, gravity: 1400, rate: 45,
    shape: { type: 'box', radius: 0, thickness: 1, arc: Math.PI * 2, scale: [1, 1], box: [40, 0] },
    angle: [-Math.PI / 2 - DEG20, -Math.PI / 2 + DEG20], spin: [Math.PI * 100 / 180, Math.PI * 450 / 180], flipRotation: 0.5,
    sizeOverLifetime: [[0, 0.5], [1, 1]], color: [1, 1, 1, 1], texture: 'circle',
    atlas: { texture: 'coin', mode: 'animate', fps: 24 },
  }),
  /** 2.5: a short dense volley of the same coins (0.2 s at ~125/s) — the finale of a big win. */
  coinBurst: particleConfig({
    duration: 0.2, lifetime: [2.2, 2.8], speed: [800, 1300], size: 64, max: 100, gravity: 1400, rate: 125,
    shape: { type: 'box', radius: 0, thickness: 1, arc: Math.PI * 2, scale: [1, 1], box: [40, 0] },
    angle: [-Math.PI / 2 - DEG20 * 1.5, -Math.PI / 2 + DEG20 * 1.5], spin: [Math.PI * 100 / 180, Math.PI * 450 / 180], flipRotation: 0.5,
    sizeOverLifetime: [[0, 0.5], [1, 1]], color: [1, 1, 1, 1], texture: 'circle',
    atlas: { texture: 'coin', mode: 'animate', fps: 24 },
  }),
  /** Short glowing trail; attach to a moving node and keep playing. */
  trail: particleConfig({
    duration: 1, loop: true, lifetime: [0.25, 0.4], speed: 0, size: [8, 12], max: 60, rate: 50,
    sizeOverLifetime: [[0, 1], [1, 0]], color: [0.6, 0.9, 1, 1], texture: 'circle', blend: 'add',
  }),
} satisfies Record<string, ParticleConfig>;

export type ParticlePreset = keyof typeof PARTICLES;
