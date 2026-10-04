// web.ts — plain-web adapter: localStorage saves, Page Visibility pause, fake ads.
// Never bundled into the youtube build (the build target picks the adapter, ./index.ts).

import type { Platform, RewardedResult } from './types.js';

export const FAKE_AD_MS = 1000;

function adOverlay(): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute('data-testid', 'fake-ad');
  el.textContent = 'AD';
  Object.assign(el.style, {
    position: 'fixed',
    inset: '0',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(0,0,0,0.85)',
    color: '#fff',
    font: 'bold 72px sans-serif',
    zIndex: '1000',
  } satisfies Partial<CSSStyleDeclaration>);
  return el;
}

function fakeAd(): Promise<void> {
  const el = adOverlay();
  document.body.appendChild(el);
  return new Promise((done) =>
    setTimeout(() => {
      el.remove();
      done();
    }, FAKE_AD_MS),
  );
}

export interface WebPlatformOptions {
  /** localStorage key of the save. */
  saveKey?: string;
}

export function createWebPlatform(opts: WebPlatformOptions = {}): Platform {
  const key = opts.saveKey ?? 'trempel.save';
  const pause: (() => void)[] = [];
  const resume: (() => void)[] = [];

  return {
    name: 'web',
    async init() {
      document.addEventListener('visibilitychange', () => {
        for (const cb of document.hidden ? pause : resume) cb();
      });
    },
    firstFrameReady() {},
    gameReady() {},
    async load() {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    async save(data) {
      try {
        localStorage.setItem(key, data);
      } catch {
        /* storage full / disabled — progress is best-effort on the web */
      }
    },
    onPause(cb) {
      pause.push(cb);
    },
    onResume(cb) {
      resume.push(cb);
    },
    audioEnabled: () => true,
    onAudioChange() {},
    language: () => navigator.language || 'en',
    adsAvailable: () => true,
    showInterstitial: fakeAd,
    async showRewarded(): Promise<RewardedResult> {
      await fakeAd();
      return 'rewarded';
    },
  };
}
