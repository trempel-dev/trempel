// timings.ts — the reels' feel per speed mode as DATA: the reels read the active profile when a
// choreography row does not say otherwise (`reels:stop` with `stopDelay = …`). Seconds everywhere.
// Presentation times (win show, count-up, banners) are the choreography's constants (`# $consts`).

export type SpeedMode = 'normal' | 'quick' | 'turbo';

export interface SpinTimings {
  /** Delay between reel stops. */
  stopDelay: number;
  /** Extra time a teased (anticipation) reel spins. */
  anticipation: number;
  /** pixi-reels speed profile of this mode. */
  reelSpeed: SpeedMode;
}

export const TIMINGS: Record<SpeedMode, SpinTimings> = {
  normal: { stopDelay: 0.15, anticipation: 1.2, reelSpeed: 'normal' },
  quick: { stopDelay: 0.08, anticipation: 0.8, reelSpeed: 'quick' },
  turbo: { stopDelay: 0, anticipation: 0.4, reelSpeed: 'turbo' },
};
