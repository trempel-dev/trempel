# Changelog — @trempel/scene

The scene format has its own changelog at the end of [docs/format/scene-format.md](docs/format/scene-format.md).

## 2.1.0

Additions only; the format stays 1.3.

- **`trempel-view` — the viewer's tools as a bin of the package** (`view/bin.mjs`; also the package's
  default bin, so `npx @trempel/scene view:shot …` works): `trempel-view view:shot <scene> [--out]
  [--settle] [--clip --t]` is the same deterministic headless snapshot + JSON of errors as
  `npm run view:shot` in the repository, `trempel-view view <folder>` — the viewer. For agents with
  Node (Codex and others) without cloning the repository. Vite and Playwright are optional peers: when
  one is missing — `E_CLI` with the command that installs it. The package now ships `view/` and
  `src/` (the viewer's dev server serves the sources).

## 2.0.0

The major version is for the API: the stable entry is narrow now. The format is **1.3**: additions
only — scenes, heirs, contracts, prefabs and md clips of 1.2 work as they are (one behaviour change
below: a prefab instance's context inherits the scene's instead of copying it).

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

- **Format 1.3** — what a real game needed (TRM-8b):
  - a prefab instance's expression context **inherits** the scene's (a prototype, not a copy taken
    at mount): a function the host adds after the mount — a game's actions — is callable inside
    prefabs (`tml:on-click="tap(self.action)"`, bindings); `self.call` finds it too. Names are
    looked up through the chain, never in `Object.prototype`;
  - **clip parameters**: a number cell `$name` in an md clip, given at play time —
    `play(clip, { params: { toX, toY } })` (`PlayOptions.params`, `Keyframe.param`), in the
    column's units; missing / not a number — `E_ANIM_PARAM` before anything moves; the clip is not
    copied or changed;
  - **`preserveAspectRatio`** of an `<image>` with a box: `<align> slice` covers it (the texture is
    cut — no mask), `<align> meet` contains it (aligned), `none` / absent — stretched as before;
    with a stretched box (`data-stretch`, `setSize`) it refits; `flatten` writes it; malformed or
    with `data-slices` / `data-tile` — `E_ASPECT`;
  - **project heirs** of collection documents: any heir of the project whose `tml:extends` names a
    collection document (`@ui/ui/card.svg`) is that document's heir in the project — every
    instance of it, in the project's scenes and inside the collection's own documents, is built as
    the collection's base + heir + the project's heir. `MountOptions.heirs` / `ComposeInput.heirs`
    (document → the heir's href from the scene), `projectHeirs`, `heirsFor`, `relativePath`
    (`@trempel/scene/internal/project`), Node: `Project.heirs`, `heirsOf(project, file)`; the
    viewer, `view:shot`, `check`, `flatten` and the editor find them in the project themselves;
    two heirs of one document, or a "project heir" that is not an heir of it — `E_PROJECT_HEIR`.
    An heir in the project extending a collection document (`tml:extends="@ui/level.svg"`) is a
    spec example and a test.
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
