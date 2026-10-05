# Changelog — @trempel/scene

The scene format has its own changelog at the end of [docs/format/scene-format.md](docs/format/scene-format.md).

## 2.0.0

**The format does not change** (scenes, heirs, contracts, prefabs and md clips of 1.2 work as they
are). The major version is for the API: the stable entry is narrow now.

### Breaking

- **A narrow stable entry.** `@trempel/scene` and `@trempel/scene/core` export only what a host
  needs: parse and compose a scene, mount it, the contract, md clips, the renderer backend,
  collections, flatten, check, errors and codes (the list — scene-format.md §15). Everything else
  moved to deep imports `@trempel/scene/internal/<module>` — for the kit and the editor, with **no
  stability promise**. The exports that left the root, and where they are now:

| Now | Exports |
|---|---|
| `@trempel/scene/internal/anim/easing` | `resolveEase`, `cubicBezier`, `NAMED`, `type EaseFn` |
| `@trempel/scene/internal/binding` | `applyBindings`, `evalBinding`, `parseBind`, `bindingErrors`, `isExprKey`, `defaultBindProp`, `type ExpressionErrorOptions`, `type BindingOptions` |
| `@trempel/scene/internal/compat` | `VIEW_MODULE`, `VIEW_MODULES`, `PROJECT_DIR`, `PROJECT_DIRS`, `LEGACY`, `upgradeDocument`, `onDeprecated`, `heirSuffix`, `readHeir`, `readHeirAsync`, `legacyName` |
| `@trempel/scene/internal/contract` | `slotContractErrors` |
| `@trempel/scene/internal/expr` | `compile`, `run`, `applyPipes`, `type CompiledExpr`, `type PipeCall` |
| `@trempel/scene/internal/flatten` | `flattenLeftovers` |
| `@trempel/scene/internal/geom/check` | `geometryErrors`, `parseClipRef`, `clipPaths` |
| `@trempel/scene/internal/geom/hit` | `pointInNode`, `nodeMatrix`, `hitTestTree` |
| `@trempel/scene/internal/geom/outline` | `flatten`, `dashes`, `outlineLength`, `insideOutline`, `type Polyline`, `type DashPiece` |
| `@trempel/scene/internal/geom/path` | `pathFromNode` |
| `@trempel/scene/internal/geom/pathdata` | `parsePathData`, `toPathData`, `shapeCommands`, `GEOMETRY_TAGS`, `type PathCmd` |
| `@trempel/scene/internal/href` | `resolveHref`, `collectionOf`, `unknownCollection`, `COLLECTION_NAME` |
| `@trempel/scene/internal/layout` | `parseSlices`, `parseAnchor`, `parseAxes`, `parseSize`, `viewBoxSize`, `refBox`, `stretchOf`, `resizableAxes`, `layoutErrors`, `resizableErrors`, `setBoxProp`, `type Axes`, `type Size`, `type Box` (was `LayoutBox`), `type Placed`, `type SceneLayout` |
| `@trempel/scene/internal/names` | `sceneNames`, `exprNames` |
| `@trempel/scene/internal/parser` | `ALLOWED_TAGS` |
| `@trempel/scene/internal/prefab` | `expandInstances`, `paramName`, `rebase` |
| `@trempel/scene/internal/project` | `parseNpmRef`, `collectionErrors`, `usedCollections` |
| `@trempel/scene/internal/props` | `BLEND_MODES`, `parseBlend`, `parseTint`, `parseZ`, `parseViews`, `parsePivot`, `singleImage`, `propErrors`, `STROKE_HOSTS`, `LINE_CAPS`, `LINE_JOINS`, `parseDashArray`, `parsePathLength`, `parseLineStyle`, `strokeErrors` |
| `@trempel/scene/internal/reactive` | `evalExpression` |
| `@trempel/scene/internal/registry` | `componentParam` |
| `@trempel/scene/internal/render/pixi` | `parseColor` |
| `@trempel/scene/internal/transform` | `parseTransform`, `multiply`, `localMatrix`, `apply`, `IDENTITY`, `type Matrix` |
| `@trempel/scene/internal/tree` | `baseTmlErrors`, `baseDuplicateIdErrors`, `walkOwn` |

- **Messages are English and start with a code**: `E_CODE: message` (errors), `W_CODE: message`
  (warnings) — mount, check, contract, expressions, clips, flatten, the CLIs, the viewer and the
  editor. `TrempelError` has `.codes` and `.code` (the first); `ExpressionError`,
  `ExpressionRuntimeError`, `PathDataError` have `.code`. Match codes, not wording: the catalog is
  `CODES` (`src/codes.ts`), documented in scene-format.md §16. Errors that used to be plain
  `Error`s with a "Trempel … error:" prefix are `TrempelError`s now.
- **`<!DOCTYPE>` and `<!ENTITY>` are refused** in every document (`E_DOCTYPE`) — before the XML
  parser sees them: no entity expansion, no external entities.
- The `pixi.js` peer is `^8.19.0` (was `^8.5.0`).

### Added

- `checkScene(input)` — the mount pipeline without a backend: `{ tree, errors, collections }`
  (`npm run check` uses it).
- `@trempel/scene/view` — `defineView` and `ViewConfig` for a consumer's `trempel.view.ts` as a
  package entry (the viewer resolved it on its own before).
- `CODES`, `coded`, `codeOf`, `within`, `trempelError`.
- `view:shot` is deterministic: the page runs on Playwright's virtual clock, time moves only in
  frame steps of 1/60 s; `--settle <sec>` (default 2) plays that much virtual time before the
  picture (`--settle 0` — the frame right after the mount). The same scene and flags give the same
  PNG bit for bit.
- The examples of scene-format.md are tests (`test/spec.test.ts`).

### Tooling

- The monorepo has one set of dev tools at its root (Vite 6, Vitest 3, TypeScript 5, Playwright,
  `@types/node` 22); `overrides` pin one `pixi.js` (8.22.0) and one `sharp` (^0.34.5).
- CI: GitHub Actions (build, typecheck, unit and e2e tests of every package, a visual gate of
  `view:shot` against the goldens in `test/golden/`).
