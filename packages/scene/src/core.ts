// core.ts — the stable, renderer-agnostic API of Trempel (`@trempel/scene/core`; `@trempel/scene`
// adds the PixiJS backend): parse and compose a scene, mount it over a RendererBackend, the
// contract, md clips (compile, play), collections, flatten, check, errors and their codes.
// No PixiJS import.
//
// Everything else (geometry, hit testing, dashes, layout and attribute parsers, expressions,
// bindings…) is internal: reachable as `@trempel/scene/internal/<module>` for the kit and the
// editor, with no stability promise.

// ---- parse and compose ---------------------------------------------------------------------------
export { parse, parseHeir } from './parser.js';
export type { SceneNode, HeirDoc, HeirRef, HeirInsert, PrefabInstance, InstanceScope } from './parser.js';
export { merge, mergeScene } from './merge.js';
export type { MergeOutcome, MergeOptions } from './merge.js';
export { composeScene, preloadScenes, fetchSceneLoader } from './prefab.js';
export type { SceneSource, SceneLoader, AsyncSceneLoader, ComposeInput, Composed, ComposeErrors } from './prefab.js';
// The format's names: the namespace, the heir file (X.tml.svg), a scene's stem.
export { NS, HEIR_EXT, heirFile, isHeirFile, sceneStem } from './compat.js';

// ---- mount -----------------------------------------------------------------------------------------
export { mountScene, mount, mountAsync, mountTree } from './scene.js';
export type { MountOptions, MountArgs, MountArgsLoose, MountedScene } from './scene.js';
export type { ScenePath, PathPoint } from './geom/path.js';
export { reactive, effect } from './reactive.js';
export { PIPES } from './pipes.js';
export type { PipeFn } from './pipes.js';
export { Registry } from './registry.js';
export type { ComponentContext, ComponentInit, ComponentInstance, ComponentFactory } from './registry.js';

// ---- the renderer backend --------------------------------------------------------------------------
export type { RendererBackend, NodeHandle, Bounds, ClipShape, PointerKind } from './render/backend.js';

// ---- the contract ----------------------------------------------------------------------------------
export { parseContract, checkContract } from './contract.js';
export type { Contract, ContractNode, ContractPattern, ViewBoxRule, CheckContractOptions } from './contract.js';

// ---- md clips --------------------------------------------------------------------------------------
export { Animator } from './anim/player.js';
export type { Clock, SpeedSource, PlayOptions, Handle, ClipSpec, AnimatorOptions } from './anim/player.js';
export { compileClips, compileClipsResult } from './anim/compile.js';
export type { CompileClipsOptions, CompileClipsResult } from './anim/compile.js';
export type { AnimClip, Track, Keyframe, Marker, Ease, EaseName } from './anim/types.js';

// ---- collections -----------------------------------------------------------------------------------
export { expandCollection } from './href.js';
export { parseProject, PROJECT_FILE } from './project.js';
export type { ProjectFile, CollectionSpec } from './project.js';

// ---- flatten and check -----------------------------------------------------------------------------
export { flattenScene } from './flatten.js';
export type { FlattenInput, FlattenResult } from './flatten.js';
export { checkScene } from './check.js';
export type { CheckInput, CheckResult } from './check.js';

// ---- errors and codes ------------------------------------------------------------------------------
export { TrempelError, ExpressionRuntimeError, trempelError } from './errors.js';
export type { ExpressionErrorInfo } from './errors.js';
export { ExpressionError } from './expr.js';
export { PathDataError } from './geom/pathdata.js';
export { CODES, coded, codeOf, within } from './codes.js';
export type { Code } from './codes.js';

import { Registry } from './registry.js';

/** The registry a scene gets by default: no built-in components since 1.2 — register your own. */
export function createDefaultRegistry(): Registry {
  return new Registry();
}
