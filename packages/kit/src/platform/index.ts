// index.ts — the build-time platform choice. The kit's vite plugin defines __TREMPEL_TARGET__
// ('web' | 'youtube'); the minifier folds the condition and the unused adapter is tree-shaken, so
// the youtube bundle has no localStorage / visibilitychange (the build gate checks it). Outside
// vite (tests, node) the target is 'web'.

import type { Platform } from './types.js';
import { createWebPlatform, type WebPlatformOptions } from './web.js';
import { createYoutubePlatform } from './youtube.js';

declare const __TREMPEL_TARGET__: string | undefined;

/** Build target this bundle was made for: 'web' | 'youtube'. */
export function buildTarget(): string {
  return typeof __TREMPEL_TARGET__ !== 'undefined' ? __TREMPEL_TARGET__ : 'web';
}

/** The platform adapter of the current build target (web options: the save's localStorage key). */
export function createPlatform(web: WebPlatformOptions = {}): Platform {
  // Written so the bundler folds it after `define` (no variable in between).
  if (typeof __TREMPEL_TARGET__ !== 'undefined' && __TREMPEL_TARGET__ === 'youtube') return createYoutubePlatform();
  return createWebPlatform(web);
}

export type { Platform, RewardedResult } from './types.js';
export { createWebPlatform, type WebPlatformOptions } from './web.js';
export { createYoutubePlatform } from './youtube.js';
export { createMockPlatform, type MockPlatform, type MockHost } from './mock.js';
