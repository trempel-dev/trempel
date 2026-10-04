// core.ts — the renderer-agnostic Trempel core: parse, merge, contract, expressions, reactivity,
// scene assembly over a RendererBackend, animation player, components. No PixiJS import.

export { parse, parseHeir, ALLOWED_TAGS } from './parser.js';
export type { SceneNode, HeirDoc, HeirRef, HeirInsert, PrefabInstance, InstanceScope } from './parser.js';

export { merge, mergeScene } from './merge.js';
export type { MergeOutcome, MergeOptions } from './merge.js';

// v0.9 prefabs: <use href> instances, multi-level tml:extends, loaders.
export { composeScene, expandInstances, preloadScenes, fetchSceneLoader, paramName, rebase } from './prefab.js';
export type { SceneSource, SceneLoader, AsyncSceneLoader, ComposeInput, Composed, ComposeErrors } from './prefab.js';

// One-release compatibility with the previous names of the format (prefix, heir, module, folder).
export { NS, HEIR_EXT, VIEW_MODULE, VIEW_MODULES, PROJECT_DIR, PROJECT_DIRS, LEGACY, upgradeDocument, onDeprecated, heirFile, isHeirFile, heirSuffix, readHeir, readHeirAsync, legacyName, sceneStem } from './compat.js';

export { parseContract, checkContract } from './contract.js';
export { baseTmlErrors, baseDuplicateIdErrors, walkOwn } from './tree.js';
export type { Contract, ContractNode, ContractPattern, ViewBoxRule, CheckContractOptions } from './contract.js';

export { TrempelError, ExpressionRuntimeError } from './errors.js';
export type { ExpressionErrorInfo } from './errors.js';

export { reactive, effect, evalExpression } from './reactive.js';
export { compile, run, applyPipes, ExpressionError } from './expr.js';
export type { CompiledExpr, PipeCall } from './expr.js';

export {
  applyBindings,
  evalBinding,
  parseBind,
  bindingErrors,
  isExprKey,
  defaultBindProp,
  PIPES,
  type PipeFn,
  type ExpressionErrorOptions,
  type BindingOptions,
} from './binding.js';

export { Registry, componentParam } from './registry.js';
export type { ComponentContext, ComponentInit, ComponentInstance, ComponentFactory } from './registry.js';

export { mountScene, mount, mountAsync, mountTree } from './scene.js';
export { sceneNames, exprNames } from './names.js';
// v1.1: a scene → one vanilla SVG (the Node CLI: @trempel/scene/node flattenFile, trempel-flatten).
export { flattenScene, flattenLeftovers } from './flatten.js';
export type { FlattenInput, FlattenResult } from './flatten.js';
export type { MountOptions, MountArgs, MountArgsLoose, MountedScene } from './scene.js';

export type { RendererBackend, NodeHandle, Bounds, ClipShape, PointerKind } from './render/backend.js';

// v0.7 geometry: paths, shapes, defs / clipPath rules.
export { parsePathData, toPathData, shapeCommands, PathDataError, GEOMETRY_TAGS } from './geom/pathdata.js';
export type { PathCmd } from './geom/pathdata.js';
export { pathFromNode } from './geom/path.js';
export type { ScenePath, PathPoint } from './geom/path.js';
export { geometryErrors, parseClipRef, clipPaths } from './geom/check.js';
// v0.9.1: outlines (dashes, hit areas) and the geometry hit test.
export { flatten, dashes, outlineLength, insideOutline } from './geom/outline.js';
export type { Polyline, DashPiece } from './geom/outline.js';
export { pointInNode, nodeMatrix, hitTestTree } from './geom/hit.js';

// v0.8 presentation attributes: mix-blend-mode, data-tint, data-z, data-views, data-pivot.
export { BLEND_MODES, parseBlend, parseTint, parseZ, parseViews, parsePivot, singleImage, propErrors } from './props.js';
// v0.9.1 strokes: stroke-dasharray / -dashoffset / -linecap / -linejoin, pathLength on geometry.
export { STROKE_HOSTS, LINE_CAPS, LINE_JOINS, parseDashArray, parsePathLength, parseLineStyle, strokeErrors } from './props.js';

// v1.0 layout: 9-slice, anchors, stretch, boxes (resizable prefabs).
export { parseSlices, parseAnchor, parseAxes, parseSize, viewBoxSize, refBox, stretchOf, resizableAxes, layoutErrors, resizableErrors, setBoxProp } from './layout.js';
export type { Axes, Size, Box as LayoutBox, Placed, SceneLayout } from './layout.js';
export { slotContractErrors } from './contract.js';

export { parseTransform, multiply, localMatrix, apply, IDENTITY } from './transform.js';
export type { Matrix } from './transform.js';
export { resolveHref, expandCollection, collectionOf, unknownCollection, COLLECTION_NAME } from './href.js';
// v1.1 collections: `.trempel/project.mdz`, unknown-collection checks.
export { parseProject, parseNpmRef, collectionErrors, usedCollections, PROJECT_FILE } from './project.js';
export type { ProjectFile, CollectionSpec } from './project.js';

export { Animator } from './anim/player.js';
export type { Clock, SpeedSource, PlayOptions, Handle, ClipSpec, AnimatorOptions } from './anim/player.js';
export { compileClips, compileClipsResult } from './anim/compile.js';
export type { CompileClipsOptions, CompileClipsResult } from './anim/compile.js';
export { resolveEase, cubicBezier, NAMED } from './anim/easing.js';
export type { EaseFn } from './anim/easing.js';
export type { AnimClip, Track, Keyframe, Marker, Ease, EaseName } from './anim/types.js';

import { Registry } from './registry.js';

/** The registry a scene gets by default: no built-in components since 1.2 — register your own. */
export function createDefaultRegistry(): Registry {
  return new Registry();
}
