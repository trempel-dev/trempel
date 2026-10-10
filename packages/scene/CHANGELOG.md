# Changelog — @trempel/scene

The scene format has its own changelog at the end of [docs/format/scene-format.md](docs/format/scene-format.md).

## 2.3.0

Additions only; the format stays 1.3. The editor: an animator and the consumer's inspectors.

- **Clip commands in the editor core** (`@trempel/scene/editor`): md clips are documents of commands —
  `openClips(md, file)` standalone, `doc.clipsDoc(file)` / `doc.createClips(file)` in the scene's
  history (one undo stack for the base, the heir and every clip file; `begin`/`end` group across
  them). `clip.create` / `rename` / `remove` / `duplicate` / `setAttr`, `track.add` / `remove` /
  `retarget` / `setAttr`, `key.set` / `remove` / `move` / `setEase` / `setParam`, `event.add` / `move`
  / `remove` / `set` (`clipCommands`: JSON Schema + description). A minimal diff of the md: untouched
  lines byte for byte, a touched table re-aligned when it was aligned, else only its changed rows; the
  md is compiled against the scene after every command — a command adding compile errors is rolled
  back. `node.setId` rewrites the clips' references (`## $track`, `$path`, `fx:…@id`) — no more
  `W_EDITOR_CLIP_REF` for a rename.
- **The heir's effect edits**: `heir.setAttr` (an attribute of an element of the heir — an inserted fx
  node's `data-*`/`transform`, a ref's `tml:*`) and `heir.insertFx` (a new `tml:type="fx"` node by
  `tml:insert`), with the heir's minimal diff (`doc.serializeHeir()`, `doc.heirDirty`). A scene
  extending another one (`heirOnly`: a project heir of a collection document) opens with its base
  read-only (`E_EDITOR_READONLY`) — its clips and effects are edited.
- **The timeline** (the editor page's «Timeline» tab, instead of «Clips» — which it keeps): an events
  lane (`fx:` markers with the effect icon), a track per `## $track` unfolded by column, keys
  (diamond; `step` — a square; a parameter — with its `$name`), the playhead (scrub, ←/→ a frame,
  ⇧ 0.1 s), click / ⇧ / box selection, drag = `key.move` / `event.move`, Delete, double-click — a key /
  an event, the side panel: a key's value and parameter, its ease (named, Bézier with two handles,
  the curve), an event's name, a track's target and attributes; the clip: new, rename, duplicate,
  remove, `$duration` (the field or its end on the ruler), `$loop`; preview values of the clip's
  parameters. **● Rec**: with a clip on the stage, the gizmo / G R S / the inspector write keys at the
  playhead, not the base. ⌘S saves the base, the heir and the clips.
- **Inspectors of the consumer module** (`trempel.view.ts` `inspectors`, §11; `@trempel/scene/view`:
  `InspectorFactory`, `InspectorHost`, `InspectorPanel`, `InspectorUi`, `FX_DRAG_MIME`): a panel for the
  nodes of a `tml:type`, a palette (an effect dropped on the stage → `heir.insertFx`), an agent API
  (`tml.inspect[type]`); the page's widgets — a curve and a gradient editor. The dev server writes md
  clips, the heir and effect data (`fx/*.json`, `systems.json`), and a file the editor wrote does not
  reload the page.
- **The agent's bridge**: the editor's dev server takes `POST /__tml/agent` (localhost) and runs it in
  the open page — `{ op: eval | save | state }` → `{ ok, value, errors, dirty }`; bin `trempel-edit`
  (`eval [--port N] '<code>'` / `--file`, `save`, `state`, `mcp` — an MCP server over stdio with
  `editor.eval`, `editor.save`, `editor.state`). An agent's script is one undo step, marked «agent»
  in the log. `tml.clipsDoc(file?)`, `tml.clipCommands`, `tml.inspect`, `tml.anim.rec` /
  `tml.anim.params`; edit/API.md — the clip commands and the effects.

## 2.2.0

Additions only; the format stays 1.3.

- **`onClipTime` of the consumer module** (`trempel.view.ts`, §11; type `ViewClipArgs` of
  `@trempel/scene/view`): after every pose of the scene by a clip — `view:shot --clip --t`, a seek or a
  played frame of the editor's clip panel — the module hears `{ id, scene, clip, t, markers }`: the time
  shown and the clip's `$events` crossed in this cycle. What lives in time next to the clip catches up
  to the frame: the kit's view module (`@trempel/kit/view`) replays the particle effects fired by
  `fx:<name>@<node>` markers, so `view:shot` and the editor draw them at that moment. The viewer's
  `ClipPlayer` takes `{ onTime }` for it.
- **`view:shot` settles to fixed moments of the virtual clock** (`CLOCK_START + i` frames) instead of
  steps from "now": loading leaks a millisecond or two of fake time, and with the page's frames on a
  16 ms grid the steps from a leaked start sometimes ended a frame later — a picture that lives in time
  (particles) differed between runs. Still images and the golden snapshots are unchanged (0/255); a
  scene with effects is now the same bit for bit (20 runs of 20 in the kit's effects showcase).

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
