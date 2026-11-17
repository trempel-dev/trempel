// index.ts — the stable API (`@trempel/scene`): the renderer-agnostic core (core.ts) plus the
// PixiJS backend. Pixi-free consumers (CLI checkers, level tools) import '@trempel/scene/core'.

export * from './core.js';
export { PixiBackend } from './render/pixi.js';
export type { PixiBackendOptions, FontMetricsFn, ImageNode } from './render/pixi.js';

import { mountAsync as coreMountAsync, type MountArgsLoose, type MountedScene } from './scene.js';
import { fetchSceneLoader } from './prefab.js';

/** mountAsync with the browser default loader (v0.9): prefabs are fetched by stem next to the scene. */
export function mountAsync(args: MountArgsLoose): Promise<MountedScene> {
  return coreMountAsync({ ...args, loadScene: args.loadScene ?? (typeof globalThis.fetch === "function" ? fetchSceneLoader() : undefined) });
}
