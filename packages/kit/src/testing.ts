// testing.ts — headless helpers: a mock platform, a manual loop, services (no Pixi, no DOM).
export { createMockPlatform, type MockPlatform, type MockHost } from './platform/mock.js';
export { GameLoop } from './time/loop.js';
export { seededRandom } from './qa/random.js';
// Services without a game: a registry, the kit's contracts and their mocks.
export { Services, contract, extend, adapt, sticky, once, inject, listen, provide, setCurrentServices, platformProviders, platformFacade, Lifecycle, SaveService, AudioService, Language, AdsService, Wallet, Iap, Leaderboard, KIT_CONTRACTS } from './services/index.js';
// 2.0: the scene table the kit's Vite plugin injects (prefabs, collections, project heirs) — for game tests.
export { setSceneTable, sceneTable, type SceneTable } from './ui/scene-table.js';
