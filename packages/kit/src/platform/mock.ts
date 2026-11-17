// mock.ts — in-memory platform for tests and headless runs (QA). Everything the host could do is
// a method on `host`: pause/resume, flip the audio switch, decide what an ad returns.

import type { Platform, RewardedResult } from './types.js';

export interface MockHost {
  /** Calls in order: 'firstFrameReady', 'gameReady', 'save', 'interstitial', 'rewarded'… */
  readonly calls: string[];
  saved: string | null;
  rewarded: RewardedResult;
  /** Ads available now (set it directly before boot; setAds() during the game tells the kit). */
  ads: boolean;
  /** 2.0: the host turns ads on / off during the game (onAdsChange fires). */
  setAds(on: boolean): void;
  pause(): void;
  resume(): void;
  setAudio(on: boolean): void;
}

export interface MockPlatform extends Platform {
  readonly host: MockHost;
}

export function createMockPlatform(opts: { saved?: string | null; language?: string } = {}): MockPlatform {
  const pause: (() => void)[] = [];
  const resume: (() => void)[] = [];
  const audio: ((on: boolean) => void)[] = [];
  const adsChange: ((on: boolean) => void)[] = [];
  let audioOn = true;
  const host: MockHost = {
    calls: [],
    saved: opts.saved ?? null,
    rewarded: 'rewarded',
    ads: true,
    pause: () => pause.forEach((cb) => cb()),
    resume: () => resume.forEach((cb) => cb()),
    setAudio(on) {
      audioOn = on;
      audio.forEach((cb) => cb(on));
    },
    setAds(on) {
      host.ads = on;
      adsChange.forEach((cb) => cb(on));
    },
  };
  return {
    name: 'mock',
    host,
    async init() {},
    firstFrameReady: () => void host.calls.push('firstFrameReady'),
    gameReady: () => void host.calls.push('gameReady'),
    async load() {
      return host.saved;
    },
    async save(data) {
      host.calls.push('save');
      host.saved = data;
    },
    onPause: (cb) => void pause.push(cb),
    onResume: (cb) => void resume.push(cb),
    audioEnabled: () => audioOn,
    onAudioChange: (cb) => void audio.push(cb),
    language: () => opts.language ?? 'en',
    adsAvailable: () => host.ads,
    onAdsChange: (cb) => void adsChange.push(cb),
    async showInterstitial() {
      if (!host.ads) return;
      host.calls.push('interstitial');
    },
    async showRewarded() {
      host.calls.push('rewarded');
      return host.ads ? host.rewarded : 'failed';
    },
  };
}
