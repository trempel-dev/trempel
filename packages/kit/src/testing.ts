// testing.ts — headless helpers: a mock platform and a manual loop (no Pixi, no DOM).
export { createMockPlatform, type MockPlatform, type MockHost } from './platform/mock.js';
export { GameLoop } from './time/loop.js';
export { seededRandom } from './qa/random.js';
