# Changelog — @trempel/kit

## 2.0.0

The holes a real game found (A World of Differences — `differences.dev` DIF-1 / DIF-2, the 1.4
tests), a narrow stable entry, and `createGame` split into modules. Needs `@trempel/scene` 2.0
(format 1.3). Migration: imports (the table below), `game.save` holds only the game's data, the
md-clip and prefab workarounds go away.

### Breaking

- **A narrow stable entry.** `@trempel/kit` exports `createGame` with its options and types, the
  types of the game's members (`GameLoop`, `Tweens`, `Sound`, `Save`, `Popups`, `Screen`… — as
  types only), the services (`contract`, `extend`, `adapt`, `sticky`, `once`, `Services`,
  `ServiceError`, `services`, `inject`, `listen`, `provide`, `currentServices`, the standard
  contracts, `KIT_CONTRACTS`) and the components (`uiComponents`, `UI_COMPONENTS`, `Skin`,
  `createSkin`, `defaultSkin`, `DEFAULT_SKIN`, `KitBackend`, `UI_SCENES`, `assetTable`). Other
  entries: `@trempel/kit/vite`, `@trempel/kit/testing`, `@trempel/kit/e2e`, `@trempel/kit/skin-cli`.
  Everything else moved to **`@trempel/kit/internal/<module>`** — no stability promise:

| Now | Exports |
|---|---|
| `@trempel/kit/internal/time/loop` | the class `GameLoop`, `TickerAdapter`, `abortError`, `isAbort`, `type LoopOptions` |
| `@trempel/kit/internal/anim/tweens` | the class `Tweens`, `ease`, `easeOf` |
| `@trempel/kit/internal/anim/clips` | the class `Clips` |
| `@trempel/kit/internal/flow/player` | `EventPlayer`, `type BookEvent`, `type PlayContext`, `type EventHandler`, `type HandlerMap`, `type EventPlayerOptions` |
| `@trempel/kit/internal/flow/fsm` | `StateMachine`, `abortable`, `checkAborted`, `type StateHandler` |
| `@trempel/kit/internal/flow/bus` | the class `EventBus` |
| `@trempel/kit/internal/ui/screen` | the class `Screen`, `type ScreenDeps`, `type ScreenHooks` |
| `@trempel/kit/internal/ui/screens` | the class `Screens` |
| `@trempel/kit/internal/ui/popups` | the class `Popups`, `POPUP`, `type PopupDef` |
| `@trempel/kit/internal/ui/overlays` | the class `Overlays`, `OVERLAY` |
| `@trempel/kit/internal/ui/layout` | `column`, `canvas`, `canvasRect`, `coverScale`, `containScale`, `viewBoxOf`, `policyOf`, `playfield`, `safeRect`, `insetsOf`, `inset`, `safeShift`, `NO_INSETS`, `type CanvasFit`, `type FitPolicy` |
| `@trempel/kit/internal/ui/buttons` | `buttonFx`, `centerPivot` |
| `@trempel/kit/internal/ui/safe-area` | `readSafeArea` |
| `@trempel/kit/internal/ui/backdrop` | the class `Backdrop` |
| `@trempel/kit/internal/ui/kit-backend` | `containBox`, `fitText`, `setTextFit` |
| `@trempel/kit/internal/ui/textures` | `whiteTexture` |
| `@trempel/kit/internal/ui/skin/skin` | `artTable`, `parseHex`, `NONE_HREF`, `FILL_PREFIX`, `ROLE_PREFIX` |
| `@trempel/kit/internal/ui/skin/format` | `validateSkin`, `ROLES`, `SLOT_ICON_MODES` |
| `@trempel/kit/internal/ui/components/controls` | `UIButton`, `UIIconButton`, `UIToggle`, `UIPlate`, `UIPanel`, `UIPopupFrame`, `UIBadge`, `iconView` |
| `@trempel/kit/internal/ui/components/values` | `UIProgress`, `UISlider`, `UIStars` |
| `@trempel/kit/internal/ui/components/slot` | `UISlot`, `placeFrame`, `slotLook`, `silhouetteFilter`, `FULL_FRAME`, `SLOT`, `type SlotFrame`, `type SlotState` |
| `@trempel/kit/internal/ui/components/icons` | `ICONS`, `drawIcon`, `starPoints`, `type IconName` |
| `@trempel/kit/internal/ui/components/base` | `shade`, `plateGraphics` |
| `@trempel/kit/internal/assets/loader` | the class `Loader` |
| `@trempel/kit/internal/audio/sound` | the class `Sound`, `type SoundOptions` |
| `@trempel/kit/internal/audio/synth` | `SYNTH_PRESETS`, `renderSynth` |
| `@trempel/kit/internal/fx/fx` | the classes `Fx`, `Effect` |
| `@trempel/kit/internal/fx/emitter` | `ParticleEmitter` |
| `@trempel/kit/internal/fx/sim` | `ParticleSim`, `sampleCurve`, `sampleMinMax`, `spawnPoint` |
| `@trempel/kit/internal/fx/presets` | `PARTICLES`, `type ParticlePreset` |
| `@trempel/kit/internal/fx/types` | `particleConfig`, `type Curve`, `type MinMax`, `type RGBA`, `type Burst`, `type Blend` |
| `@trempel/kit/internal/data/save` | the class `Save`, `parseSave` |
| `@trempel/kit/internal/data/i18n` | the class `I18n` |
| `@trempel/kit/internal/data/kit-strings` | `KIT_STRINGS`, `withKitStrings` |
| `@trempel/kit/internal/data/ads` | the class `Ads` |
| `@trempel/kit/internal/input/input` | the class `Input`, `swipeDirection`, `keyAction` |
| `@trempel/kit/internal/platform/index` | `createPlatform`, `buildTarget` |
| `@trempel/kit/internal/platform/web` | `createWebPlatform`, `type WebPlatformOptions` |
| `@trempel/kit/internal/platform/youtube` | `createYoutubePlatform` |
| `@trempel/kit/internal/platform/mock` (also `@trempel/kit/testing`) | `createMockPlatform`, `type MockPlatform`, `type MockHost` |
| `@trempel/kit/internal/qa/random` (also `@trempel/kit/testing`) | `seededRandom` |
| `@trempel/kit/internal/services/services` (also `@trempel/kit/testing`) | `setCurrentServices`, `parseModeQuery` |
| `@trempel/kit/internal/services/platform` (also `@trempel/kit/testing`) | `platformProviders`, `platformFacade`, `type Provision` |

- **`game.save` is the game's data only** (`Save<D>`, was `Save<D & { sfx; music }>`). The save
  file has two spaces: `{ "trempel": 2, "sfx", "music", "svc", "game": { …, "v" } }` — the kit's
  settings and the services' store at the top, the game's data in `game`. `game.save.set` /
  `update` / `reset` cannot overwrite `sfx` / `music` / `svc`, even with a whole object. A 1.x save
  (one flat object) is split when it loads: the kit takes `sfx` / `music` / `svc`, the game's space
  is the 1.x object as the game saw it (with `sfx` / `music` — a game that kept them as its own
  settings keeps them — and `v` for its `migrate`), without `svc`.
- **The actions are made before the scenes mount**: `actions: (game) => ({…})` gets the game as a
  lazy reference — use it inside the actions (it is ready when they run), not while making them.
- **A popup takes the input while it is open, not while it closes**: the screens under an open
  popup and `game.input` take no input (they did); the popups under the top one take none; a
  closing popup takes none — its dim no longer eats the next click, and `game.input` is back at
  once (1.x: after the animation).
- `Popups.show` of a name already queued does not queue it twice.
- `SceneSource.base` is optional (an heir extending another scene); a screen reads its reference
  size and its `data-anchor` / `data-stretch` / `data-fx` / `data-sound` nodes from the composed
  scene (a prefab's insides are its own layout); a stretched image is resized through the backend.

### Added

- **Prefabs in the kit's screens** (`<use href>` in screens, popups, overlays), tml:extends chains,
  collections of `.trempel/project.mdz`, **project heirs** of collection documents (scene format
  1.3) — the kit's **Vite plugin** collects the scene documents of the game and of its collections
  (the closure of `<use>` / `tml:extends` from the game's scenes) and injects them as a table
  before the game's code; the game configures nothing. A screen whose source is in the table
  mounts with its path, the table's loader and the project heirs. The plugin also adds the
  collections' folders to the dev server's `fs.allow` and pre-bundles `pixi.js` /
  `pixi.js/unsafe-eval`. (`@trempel/kit/vite`: `collectScenes`, `tableModule`, `composeOnDisk`.)
- **md clips at build time**: `import clips from './anim/win.md?clips=<scene>'` — compiled
  (`compileClips`) and checked against the composed scene (a scene path from the md's folder, or
  above its `anim/` folder); a bad clip or scene fails the build with its codes. `?clips` alone —
  without a scene.
- **Clip parameters**: `game.clips.play(clip, { scene, params: { toX, toY } })` (the format's `$name`
  cells) — one clip flies to a different place per play.
- **`game.destroy()`**: screens, popups, overlays and their controllers (their `inject` / `listen`),
  the game's components, the ticker, input (window and canvas listeners), sound (the audio context),
  the bus, the services (the registry stops being current — the next `createGame` and `provide()`
  before it get a fresh one), the platform adapter's listeners (`Platform.dispose?`), the canvas,
  the probe and the services panel. Another `createGame` in the same page works.
- **Ads availability on the fly**: `Platform.onAdsChange?(cb)` — the mock (`host.setAds(on)`) and
  the YouTube adapter (the SDK's `API_UNAVAILABLE`) tell the kit; the `ads` contract's sticky
  `available`, `game.ads.available` and `kit.ads` follow at once; no interstitial after ads went
  away, even when the host did not say so (the provider checks before showing).
- **Pause race**: `close('pause')` / `closeNow('pause')` do not resume when a pause was asked again
  while the popup closed (Esc right after Resume): the game stays paused with the pause popup.
  `Popups.queued(name)`.
- `Screens.blocked`; `Input.detach()`; `Sound.destroy()`; `GameLoop.attach` returns the detach;
  `releaseServices(s)` (internal); `@trempel/kit/testing`: `setSceneTable`, `sceneTable`.

### Inside

`createGame` is an assembly of modules (`src/game/`): `types` (options and the game), `save` (the
save file's two spaces), `layout` (column, safe area, HUD, playfield), `scenes` (context, registry,
screens / popups / overlays, controllers, the input gate); `game.ts` keeps the boot order, the
platform wiring and the game object. The 1.4 integration tests pass unchanged.

## 1.4.0

Additive only: no export is removed or narrowed, games on 1.3 build and run unchanged.

### Builds ship images without metadata (a gate)

- **Every release build** (`vite build` with `trempelKit()`: web, youtube, any target) rewrites the
  rasters of the dist without metadata: PNG `tEXt` / `iTXt` / `zTXt` (where ComfyUI writes the
  workflow and the prompt), `eXIf`, `tIME`, C2PA `caBX`; JPEG EXIF / XMP / IPTC / C2PA JUMBF /
  comments; WebP `EXIF` / `XMP ` / C2PA. **Nothing is re-encoded**: the chunks / segments are
  dropped and the coded image is copied byte for byte, so the decoded pixels are bit-identical
  (colour chunks — `iCCP`, `sRGB`, `gAMA`, JPEG ICC — stay).
- **Gate `E_ASSET_METADATA`**: the build fails when the dist still has metadata in a raster (GIF /
  AVIF are checked, not rewritten; an EXIF orientation other than 1 is never dropped — rotate the
  source), or a generation sidecar: `*.png.json`, `*.jpg.json`, `*.webp.json`…, any `*.json` with a
  top-level `prompt` / `workflow`. The message lists every file. The dev server cleans nothing.
- The youtube `build-report.md` has a section "Метаданные ассетов" (what was cleaned).
- `@trempel/kit/vite` exports `cleanAssets`, `scanMetadata`, `stripPng`, `stripJpeg`, `stripWebp`,
  `stripImage`, `metadataError`, `METADATA_CODE` (and their types); `GateOptions.metadata`.

### Contracts and HMR

- On the dev server (the plugin defines `__TREMPEL_DEV__`) a contract declared again — its module
  re-run by Vite HMR — **replaces** the old one in the running game's registry: the mock in force
  is rebuilt from the new declaration, state and subscriptions stay when the state's shape (keys
  and value types) is the same, else the state is reset with `W_CONTRACT_STATE_RESET` in the
  console; a provided implementation stays. In a build (and without the plugin) a second
  declaration is an error, as before. New: `Services.replace(c)`.

### Tests

- Integration tests of `createGame` (headless: a fake Pixi Application, the mock platform, real
  scene mounting): boot order, platform and game pause, screens / popups / overlays and their
  controllers, save + services' `svc` across a re-created game, ads (rewarded / closed / failed,
  the ads contract's modes, interstitial cooldown), layout and the playfield on resize.
  `npm run coverage -w @trempel/kit` — coverage of `src`.

### Versions

- Peer and dev dependency on `@trempel/scene` — `^2.0.0` (since 1.3.0 in the monorepo).

## 1.3.0

### Services — contracts with a mandatory mock

- `contract(name, { state, events, mock })<Methods>()` — declaring one without a mock is a type and
  a runtime error. `services.get` / `provide` / `extend` / `adapt`; `inject(C)` resolves at mount
  (awake) of kit components and screen controllers, an unregistered contract fails there naming
  both; `sticky` / `once` events go through the kit bus as `<contract>:<event>`; `listen()` is owned
  and dropped at unmount. Contract state binds in scenes as `services.<name>.*`.
- Mock modes (latency, fail, the contract's own) via `services.mock`, `?svc.<name>=…`, and a dev
  panel (`?services=1`, web build only; the youtube gate rejects its marker).
- Standard contracts: `lifecycle`, `save`, `audio`, `language`, `ads` (implemented by the build
  target's platform adapter; `Platform`, `game.platform`, `game.save`, `game.ads` are facades —
  existing games unchanged), `wallet`, `iap`, `leaderboard` (mock + local; the wallet keeps its
  balance in the game save).
- Template casual: coins on the wallet (HUD binding, reward via `add`).
