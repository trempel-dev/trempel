// ads.ts — ads through the platform only (Playables: interstitial in natural pauses, rewarded by
// the player's choice; the code MUST check availability first). While an ad shows, the game loop
// is suspended and the sound muted; an interstitial cooldown keeps them rare.

import type { Platform, RewardedResult } from '../platform/types.js';

export interface AdsHooks {
  /** Called around an ad: true = an ad starts (pause everything), false = it ended. */
  onAd?: (showing: boolean) => void;
  /** Seconds of game time between interstitials. */
  cooldown?: number;
  /** Game time source, seconds. */
  now?: () => number;
}

export class Ads {
  private lastInterstitial = -Infinity;
  private showing = false;

  constructor(
    private readonly platform: Platform,
    private readonly hooks: AdsHooks = {},
  ) {}

  get available(): boolean {
    return this.platform.adsAvailable();
  }

  /** Interstitial at a natural pause; skipped (false) on cooldown / no ads. */
  async interstitial(): Promise<boolean> {
    const now = this.hooks.now?.() ?? 0;
    if (this.showing || !this.available || now - this.lastInterstitial < (this.hooks.cooldown ?? 60)) return false;
    await this.run(() => this.platform.showInterstitial());
    this.lastInterstitial = this.hooks.now?.() ?? 0;
    return true;
  }

  /** Rewarded ad: 'rewarded' — give the reward. */
  async rewarded(): Promise<RewardedResult> {
    if (this.showing || !this.available) return 'failed';
    return this.run(() => this.platform.showRewarded());
  }

  private async run<T>(fn: () => Promise<T>): Promise<T> {
    this.showing = true;
    this.hooks.onAd?.(true);
    try {
      return await fn();
    } finally {
      this.showing = false;
      this.hooks.onAd?.(false);
    }
  }
}
