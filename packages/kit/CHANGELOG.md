# Changelog — @trempel/kit

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
