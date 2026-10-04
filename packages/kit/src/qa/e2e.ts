/* eslint-disable @typescript-eslint/no-explicit-any */
// e2e.ts — Playwright helpers for games on the kit (made
// reusable). No Playwright import: `page` is typed structurally, so this module costs nothing to
// the game bundle and works with any @playwright/test version.
//
//   await stubYoutube(page)          — serve a fake `ytgame` SDK at its real URL (records calls,
//                                      keeps saves in window.__yt.saved, exposes pause/resume/audio
//                                      callbacks in window.__yt.cbs)
//   await enforceCsp(page)           — serve the page with Playables' CSP (no unsafe-eval) and
//                                      collect violations in window.__csp
//   await waitYt(page, 'gameReady')  — wait for an SDK call
//   probe(page, 'state')             — call window.__trempel.<fn> (web build only)

export const SDK_URL = 'https://www.youtube.com/game_api/v1';

export const YT_STUB = `
  window.__yt = { calls: [], saved: window.__ytSaved || '', cbs: {} };
  const rec = (n) => (...a) => { window.__yt.calls.push(n); };
  window.ytgame = {
    IN_PLAYABLES_ENV: true, SDK_VERSION: 'stub',
    game: {
      firstFrameReady: rec('firstFrameReady'),
      gameReady: rec('gameReady'),
      loadData: async () => { window.__yt.calls.push('loadData'); return window.__yt.saved; },
      saveData: async (s) => { window.__yt.calls.push('saveData'); window.__yt.saved = s; },
    },
    system: {
      getLanguage: async () => 'en',
      isAudioEnabled: () => true,
      onAudioEnabledChange: (cb) => { window.__yt.cbs.audio = cb; return () => {}; },
      onPause: (cb) => { window.__yt.cbs.pause = cb; return () => {}; },
      onResume: (cb) => { window.__yt.cbs.resume = cb; return () => {}; },
    },
    ads: {
      requestInterstitialAd: async () => { window.__yt.calls.push('interstitial'); },
      requestRewardedAd: async (id) => { window.__yt.calls.push('rewarded:' + id); return true; },
    },
  };`;

/** Playables-like CSP: no 'unsafe-eval', no inline scripts, no external hosts but the SDK. */
export const PLAYABLES_CSP = [
  "default-src 'self'",
  "script-src 'self' https://www.youtube.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "connect-src 'self' data: blob:",
  "worker-src 'self' blob:",
].join('; ');

interface Route {
  fetch(): Promise<{ headers(): Record<string, string> }>;
  fulfill(o: Record<string, unknown>): Promise<void>;
}
interface PageLike {
  route(url: string | RegExp, handler: (route: Route) => unknown): Promise<unknown>;
  addInitScript(script: string | ((arg: unknown) => unknown), arg?: unknown): Promise<unknown>;
  waitForFunction(fn: (arg: any) => unknown, arg?: any, opts?: { timeout?: number }): Promise<unknown>;
  evaluate<T>(fn: (arg: any) => T, arg?: any): Promise<T>;
}

export async function stubYoutube(page: PageLike): Promise<void> {
  await page.route(SDK_URL, (route) => route.fulfill({ contentType: 'text/javascript', body: YT_STUB }));
}

export async function enforceCsp(page: PageLike, csp = PLAYABLES_CSP): Promise<void> {
  await page.route(/\/(index\.html)?(\?.*)?$/, async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, headers: { ...res.headers(), 'content-security-policy': csp } });
  });
  await page.addInitScript(`window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.effectiveDirective + ' ' + e.blockedURI));`);
}

/** Count localStorage accesses in window.__ls (must stay 0 in the youtube build). */
export async function watchLocalStorage(page: PageLike): Promise<void> {
  await page.addInitScript(`window.__ls = 0; const real = window.localStorage; Object.defineProperty(window, 'localStorage', { get() { window.__ls++; return real; } });`);
}

export async function waitYt(page: PageLike, call: string, timeout = 20000): Promise<void> {
  // Function predicates, not strings: a string predicate is eval'd and the CSP blocks it.
  await page.waitForFunction((c) => !!(window as any).__yt && (window as any).__yt.calls.includes(c), call, { timeout });
}

/** window.__trempel.<fn>(...args) of the web build. */
export function probe<T>(page: PageLike, fn: string, ...args: unknown[]): Promise<T> {
  return page.evaluate((a) => {
    const [f, rest] = a as [string, unknown[]];
    return (window as any).__trempel[f](...rest);
  }, [fn, args]) as Promise<T>;
}

/** Wait until the web build's probe is installed (game booted, first screen shown). */
export async function waitGame(page: PageLike, timeout = 20000): Promise<void> {
  await page.waitForFunction(() => !!(window as any).__trempel?.ready, undefined, { timeout });
}

/**
 * Screen px of a reference point (x, y) of a screen, from the kit's layout math — for builds
 * without the probe (youtube). Mirrors ui/layout.ts: column (maxAspect) + canvas mode + anchors.
 */
export function refToScreen(
  viewport: { width: number; height: number },
  ref: { w: number; h: number; mode?: 'expand' | 'shrink' | 'width' | 'height'; maxAspect?: number },
  x: number,
  y: number,
  anchor: [number, number] = [0, 0],
): { x: number; y: number } {
  const W = viewport.width;
  const H = viewport.height;
  const colW = ref.maxAspect ? Math.min(W, H * ref.maxAspect) : W;
  const colX = (W - colW) / 2;
  const sw = colW / ref.w;
  const sh = H / ref.h;
  const mode = ref.mode ?? 'expand';
  const s = mode === 'width' ? sw : mode === 'height' ? sh : mode === 'expand' ? Math.min(sw, sh) : Math.max(sw, sh);
  const cw = colW / s;
  const ch = H / s;
  return { x: colX + (x + (cw - ref.w) * anchor[0]) * s, y: (y + (ch - ref.h) * anchor[1]) * s };
}
