// types.ts — the platform adapter contract. The core knows the
// game logic, the platform is brought in: everything outside the game (saves, pause, the host's
// audio switch, language, ads, lifecycle signals) goes through this one object. One
// implementation per target, picked at BUILD time (see ../vite, `target`), so a target's bundle
// never contains another target's adapter.
//
// Save data is an opaque string — typed saves are the core's save module on top of it
// (../data/save.ts).

export type RewardedResult = 'rewarded' | 'closed' | 'failed';

export interface Platform {
  /** Target name, for logs: 'web' | 'youtube' | 'mock'. */
  readonly name: string;
  init(): Promise<void>;
  /** First frame is on screen (loading UI visible). */
  firstFrameReady(): void;
  /** The game is interactive. Everything loaded before this counts as the initial bundle. */
  gameReady(): void;
  /** The stored save string, or null when nothing is stored. */
  load(): Promise<string | null>;
  save(data: string): Promise<void>;
  onPause(cb: () => void): void;
  onResume(cb: () => void): void;
  /** Platform-level audio switch; the game's own sound settings are subordinate to it. */
  audioEnabled(): boolean;
  onAudioChange(cb: (on: boolean) => void): void;
  /** BCP-47 language, e.g. "en", "ru-RU". */
  language(): string;
  adsAvailable(): boolean;
  /**
   * 2.0: availability of ads changed on the host (mock `host.setAds`, the YouTube SDK saying ads are
   * unavailable here) — the kit's `ads` contract follows at once. Optional for custom adapters.
   */
  onAdsChange?(cb: (available: boolean) => void): void;
  /** 2.0: drop what the adapter hooked into the page (listeners) — game.destroy(). Optional. */
  dispose?(): void;
  showInterstitial(): Promise<void>;
  /**
   * 'rewarded' — watched, give the reward; 'closed' — shown but not earned; 'failed' — not shown
   * (no ad, region, error).
   */
  showRewarded(): Promise<RewardedResult>;
}
