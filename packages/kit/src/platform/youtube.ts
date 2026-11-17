// youtube.ts — YouTube Playables adapter over the `ytgame` SDK.
// Method names from the official reference (developers.google.com/youtube/gaming/playables/
// reference/sdk, checked 2026-10-01): game.firstFrameReady/gameReady/loadData/saveData,
// system.onPause/onResume/isAudioEnabled/onAudioEnabledChange/getLanguage,
// ads.requestInterstitialAd/requestRewardedAd(rewardId).
//
// Rules of the platform: saves ONLY via saveData/loadData (no localStorage), pause ONLY via
// onPause/onResume (no Page Visibility API), no outbound network. The SDK script tag is injected
// into index.html before the game code by the kit's vite plugin.
//
// Outside the Playables host (local preview of the youtube build) `ytgame` may be missing:
// everything degrades to in-memory no-ops so the bundle still runs.

import type { Platform, RewardedResult } from './types.js';

interface YtGame {
  IN_PLAYABLES_ENV?: boolean;
  game: {
    firstFrameReady(): void;
    gameReady(): void;
    loadData(): Promise<string>;
    saveData(data: string): Promise<void>;
  };
  system: {
    getLanguage(): Promise<string>;
    isAudioEnabled(): boolean;
    onAudioEnabledChange(cb: (on: boolean) => void): () => void;
    onPause(cb: () => void): () => void;
    onResume(cb: () => void): () => void;
  };
  ads?: {
    requestInterstitialAd(): Promise<void>;
    requestRewardedAd(rewardId: string): Promise<boolean>;
  };
  health?: { logError(): void; logWarning(): void };
}

function sdk(): YtGame | null {
  return (globalThis as unknown as { ytgame?: YtGame }).ytgame ?? null;
}

/** SdkError with errorType API_UNAVAILABLE means ads are not available here (region, account). */
function unavailable(e: unknown): boolean {
  return !!e && typeof e === 'object' && String((e as { errorType?: unknown }).errorType) === 'API_UNAVAILABLE';
}

export interface YoutubePlatformOptions {
  /** Reward id passed to requestRewardedAd. */
  rewardId?: string;
}

export function createYoutubePlatform(opts: YoutubePlatformOptions = {}): Platform {
  const yt = sdk();
  const rewardId = opts.rewardId ?? 'reward';
  let lang = 'en';
  let memorySave: string | null = null;
  // Ads stay "available" until the SDK tells us otherwise (it has no availability event: an
  // API_UNAVAILABLE error is the signal — the kit hears it at once through onAdsChange).
  let adsOk = typeof yt?.ads?.requestRewardedAd === 'function';
  const adsChange: ((on: boolean) => void)[] = [];
  const noAds = () => {
    if (!adsOk) return;
    adsOk = false;
    adsChange.forEach((cb) => cb(false));
  };

  return {
    name: 'youtube',
    async init() {
      if (!yt) return;
      try {
        lang = (await yt.system.getLanguage()) || 'en';
      } catch {
        lang = 'en';
      }
    },
    firstFrameReady() {
      yt?.game.firstFrameReady();
    },
    gameReady() {
      yt?.game.gameReady();
    },
    async load() {
      if (!yt) return memorySave;
      try {
        const s = await yt.game.loadData();
        return s ? s : null;
      } catch {
        return null;
      }
    },
    async save(data) {
      if (!yt) {
        memorySave = data;
        return;
      }
      try {
        await yt.game.saveData(data);
      } catch {
        yt.health?.logWarning();
      }
    },
    onPause(cb) {
      yt?.system.onPause(cb);
    },
    onResume(cb) {
      yt?.system.onResume(cb);
    },
    audioEnabled: () => (yt ? yt.system.isAudioEnabled() : true),
    onAudioChange(cb) {
      yt?.system.onAudioEnabledChange(cb);
    },
    language: () => lang,
    adsAvailable: () => adsOk,
    onAdsChange: (cb) => void adsChange.push(cb),
    async showInterstitial() {
      if (!adsOk || !yt?.ads) return;
      try {
        await yt.ads.requestInterstitialAd();
      } catch (e) {
        if (unavailable(e)) noAds();
      }
    },
    async showRewarded(): Promise<RewardedResult> {
      if (!adsOk || !yt?.ads) return 'failed';
      try {
        return (await yt.ads.requestRewardedAd(rewardId)) ? 'rewarded' : 'closed';
      } catch (e) {
        if (unavailable(e)) noAds();
        return 'failed';
      }
    },
  };
}
