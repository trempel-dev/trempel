# Changelog — @trempel/kit

## 2.3.0

Additions only (needs `@trempel/scene` ^2.3: the consumer module's `inspectors`); 2.2.1 included.

- **The particle editor in the scene editor**: `kitView()` brings the inspector of `tml:type="fx"`
  nodes (`inspectors.fx`, `src/fx/inspector.ts`): the node's effect (presets, the project's
  `fx/<name>.json`, the game's table) — changed by `heir.setAttr`; the config of each system in groups
  (emission and bursts, shape and the Cocos radial mode, lifetime / speed / size / rotation as a
  constant, a range or curves, gravity, accelerations, limitVelocity, colour and the colour-over-life
  gradient, size over life, sheet, render, tint, texture); the live preview on the node (⟲, a burst, the
  node's seed or a random one); save — `fx/<name>.json` whole, a converter's `systems.json` — only the
  effect's systems, the rest of the file byte for byte (`src/fx/json-edit.ts`); an effect from code or a
  preset — read-only, «move to a file» writes `fx/<name>.json` (hooking it up is the game's); a palette
  of effects to drag onto the stage; `tml.inspect.fx` for scripts and agents (`list`, `origin`, `get`,
  `update`, `save`, `extract`, `unsaved`).
- **`kitView({ effectSources })`**: effect files the game imports, by path relative to the scene folder
  → the imported JSON — the inspector finds an effect's file by the identity of its configs.

## 2.2.1

- Choreography: the Director log is bounded (`logLimit`, default 10000; `Infinity` for verify) — an idling slot no longer grows it forever.

## 2.2.0

The animation pipeline (TRM-12): Spine skeletons and Unity clips become scenes and md clips, Cocos
particles become the kit's effects, a choreography of named steps plays as data, and an effect is a
node of a scene that the viewer, the editor and `view:shot` draw deterministically. Additions only: the
2.1 API and configs are unchanged (new bins, entries, members, optional fields). Needs
`@trempel/scene` ^2.2 (the module's `onClipTime`). A 2.1 particle config simulates bit for bit as
before (the new fields draw their random values after the 2.1 ones and only when set; a test holds
digests of the 2.1 simulation).

### Spine skeletons: trempel-spine-import

- **`trempel-spine-import <skeleton.json | folder>… [--out] [--atlas] [--fps 30] [--skin] [--points 60]
  [--art false] [--verify false] [--frames 0,0.5 [--clip]]`** (bin): Spine JSON 3.5–4.2 + its atlas →
  `scene.svg` (a sterile base: bone → nested `<g id>` with the setup pose, y flipped; slot →
  `<g id="<slot>-slot">` with its `<image>`s in the draw order), `<name>.anim.md` (md clips: bones →
  relative x y rotation scaleX scaleY, bezier → `[x1,y1,x2,y2]`, stepped → `step`, a segment without a
  normal form baked adaptively; attachments → `tex` or alpha 0/1; events → `$events`) + the compiled
  `.anim.json`, `art/<region>.png` cut from the atlas (rotated / trimmed / premultiplied pages; our own
  PNG reader, no metadata, no native dependency), `report.md` (a folder: `summary.md`). The Spine
  runtime is not used: the JSON is read by our own code, from the format documentation.
- **Format 1.3 where the original had none**: slot colour → `data-tint` and the `tint` column (one
  ease per row when the channels agree, else baked; attachment colours on the images while the slot
  colour does not animate; the dark colour of a two-colour tint — reported); blend modes →
  `mix-blend-mode` (additive → plus-lighter, multiply, screen); draw order timelines → the `z` column of
  the siblings they reorder. `data-z` orders siblings only, so the setup draw order still needs bone
  group clones where two sibling subtrees interleave (the greedy walk is minimal; the report counts
  them); a draw order key that moves a slot across groups — reported, the setup order kept there.
- **Verification**: our own Spine pose sampler (from the documentation) against Trempel itself — the
  base mounted on a headless backend with Pixi's transform semantics, the md compiled and played by
  the Animator — at `--points` per animation: position ±0.5 px, rotation ±0.5°, scale ±0.5 %, alpha
  ±0.01, colour ±0.01, attachment and draw order exact. Codes `E_SPINE_IMPORT_USAGE / _INPUT / _ATLAS /
  _ART`. Tests on skeletons built in code; a real corpus — a local run (`TREMPEL_SPINE_CORPUS`).
- **`clip-import`** (`@trempel/kit/internal/clip-import`): what the clip importers share — the headless
  backend, Bézier segments → eases, md clip tables, `playHeadless`.

### An effect as a scene node

- **`tml:type="fx"`** (registered by `createGame`, `fxComponents()`): a particle effect placed in a
  scene — `data-effect` (a name of the effects table or a preset), `data-autostart` (default on),
  `data-loop`, `data-scale`, `data-seed`; the base keeps a placeholder (a dot) and stays sterile;
  `data-tint` tints it as any node. The effects of a node step on fixed frames of 1/60 s from a seeded
  random source (the node id + seed): an effect `t` seconds old is the same picture at any frame rate,
  `seek(t)` replays it. In a game the loop ticks them (pause / speed apply). The component's API:
  `play()`, `stop()`, `seek(t)`, `fire(effect)`, `node` (`FxNode`, its `FxHost`).
- **Clip markers `fx:<name>@<node>`**: `game.clips.play()` plays the effect at that node of the clip's
  scene (an effect node fires it, another node gets a one-shot in its place; `Clips.onMarker` — the
  kit's handler before the play's own).
- **`@trempel/kit/view`** — `kitView(options)` for a game's `trempel.view.ts`: the kit's UI components
  in a skin (or `skin: false`), effect nodes from the game's effects table (its textures loaded in
  `setup`, before the first scene), the game's own components, and `onClipTime`: the effects fired by
  markers replayed to the clip time shown — `view:shot --clip x --t 0.8` draws them, the editor's clip
  panel scrubs them. The page's time is counted in ticks of its clock, not in frames drawn, so
  `view:shot` gives the same picture every run (10 / 10 with a clip, 20 / 20 settled — the kit's
  showcase `ui/scenes/effects`).
- `Fx`: `make()` (an effect the caller steps), `rng` in the play options, built-in shapes drawn on a
  canvas when there is no renderer (the viewer).

### Choreography as data

- **`loadChoreo(files, { eases })`**: md documents (`# $seq <id>` with `$title` / `$skip` and a table of
  rows; `# $consts` — numbers per speed mode normal / quick / turbo) → sequences of named steps over
  different objects: formula times (`step * k`, `@fly.end`, `max(@a.end, @b.end)`), instances (`k=0..n`,
  `p in list`), `when`, durations or `loop`, `poll:` conditions, nested sequences (`run:`), sync
  (await / parallel / resolve), skip rules (cut / now / +N). Strict: every problem is
  `E_CHOREO_LOAD: <file>:<seq>:<row>: …`. The formula language has no eval (`E_CHOREO_EXPR`).
- **`Director`** on the loop's logical time: every row fires in the first frame at or after its time,
  the log keeps the exact `t` (`at` — the frame); a sequence started at the previous one's logical end
  keeps a round free of frame drift. Rows go to **actions** by the prefix of their `action` —
  `kitActions({ scene, tweens, clips, clipOf, fx, sound, calls })`: `clip:` (a clip with params from
  `value`), `tween:` (from → to / += / = over `dur` with the kit's eases; a row fired late starts that
  far in; skip jumps to the end), `fx:` (at the target node), `sound:`, `call:` — and the game's own;
  a `sink` sees every row (sounds by the `sound` column, a view that draws everything itself).
  `E_CHOREO_RUN`, `E_CHOREO_ACTION`.
- **`verifyLog`** — the log against a reference timeline (`timeline.json` of the original): ±1 frame
  for frame-timed actions, exact for timers and events, durations, order-only steps with the reason,
  coverage; `variant` for a game's per-variant values. **`verifyLive`** — probes of a live recording
  through the original's 60 Hz tick model. In the stable entry (types `ChoreoEvent`, `Choreo`, …).

### Particles from Cocos

- **`trempel-fx-import --cocos <X.plist | X.json | folder>… --out <dir> [--scale 1]`**: Cocos particles
  (Particle Designer / Particle2dx — an XML `.plist`, or the `.json` variant with the same keys; a
  folder — every particle file under it) → the kit's effects, the same output as the Unity mode:
  `effects.json` (`{ name: [ParticleConfig] }`, `createGame({ fx: { effects } })` as is),
  `textures/*.png` without metadata, `report.md` / `report.json` (every emitter `auto` / `manual` /
  `hard` and why). One file = one effect named after it. Both emitter modes: gravity (gravity x / y,
  speed, angle, radial and tangential acceleration, source position variance → a box) and radius
  (start / end radius, rotation per second); start / end size, colour (per channel) and rotation with
  variance, lifetime, `duration` (−1 — loops), `maxParticles`, emission rate (`totalParticles /
  particleLifespan` unless `emissionRate`); blend pairs (ONE/ONE, SRC_ALPHA/ONE → add;
  SRC_ALPHA/ONE_MINUS_SRC_ALPHA, ONE/ONE_MINUS_SRC_ALPHA → normal; others — the nearest, `manual`);
  `positionType` free / relative — `manual` (particles move with the effect). Y up, counter-clockwise
  degrees → y down, radians; points → px (`unit: [scale, scale]`). Texture: `textureFileName` next to
  the file, else `textureImageData` (base64 → gzip / zlib / raw PNG; a TIFF payload — the built-in
  circle, `manual`). Its own XML plist reader, no new dependencies. Errors: `E_FX_IMPORT_INPUT`,
  `E_FX_IMPORT_COCOS` (a malformed plist / JSON, not a particle file), `E_FX_IMPORT_USAGE`
  (`--ppu` with `--cocos`, `--scale` without it).
- **The check**: every emitter is simulated by the kit and by a reference model of Cocos' particle
  rules (written from the format's semantics) fed the same random values — the min, middle and max of
  every variance — and compared at every frame: position, size, colour, rotation of a particle, the
  particle count of a whole run. Tolerances (report and tests): 0.01 px, 0.01 px, 1e-4, 1e-4 rad, the
  count within two frames of emission; the synthetic emitters of the tests match within ~3e-7 px. Out of
  tolerance — `hard`.

### Particles: the Cocos model in the runtime

New optional `ParticleConfig` fields (typed, with doc comments; `OrbitConfig`, `ParticleShape` types):
`gravityX`; `radialAccel`, `tangentialAccel` (about the emitter's origin, per particle); `angle` (the
direction of the start velocity, replaces the shape's); `orbit` (`{ radius, endRadius?, speed }` — the
radius mode: particles circle their start point); `endSize`, `endColor`, `endRotation` (linear from the
start values over each particle's life); `colorPerChannel` (random colours drawn channel by channel,
clamped); `whenFull: 'wait'` (Cocos: the emission clock stops while the emitter is full); the shape
`type: 'box'` with `box: [halfW, halfH]`. `ParticleSim.spawned` counts spawned particles.

### Unity clips: trempel-anim-import

- **`trempel-anim-import`** (bin): Unity AnimationClips → md clips (scene format §9), straight from a
  Unity project — a folder, a prefab, a controller (`.controller`, `.overrideController`) or an
  `.anim` (Force Text YAML). A prefab with an Animator: its controller's states (every layer,
  sub-state machines; an override controller — its base with the clips swapped) → clips named after
  the states, the Animator's GameObject is the root of the curve paths and the prefab gives the rest
  pose; a legacy Animation — its clips. One md per prefab / controller / loose clip
  (`<out>/<name>.anim.md`) and the compiled `.anim.json` next to it.
- **Curves**: Unity's Hermite keys → cubic Bézier eases `[x1, y1, x2, y2]` (control points at dt/3
  along the slopes — exact), weighted tangents as their Bézier (exact for weights in 0..1: reported
  verified), infinite tangents → `step`, a segment with no Trempel ease (a flat value with a moving
  curve) baked into linear keys (adaptive). Position (Transform × `--ppu`, RectTransform anchored /
  local × `--ui-scale`, y down), Euler Z (clockwise), quaternion Z (baked), scale (a multiplier of
  the rest), CanvasGroup / colour alpha (multiplied), colour r g b → `tint` (one ease per row: exact
  when the channels share it, else baked), `m_IsActive` / a renderer's `m_Enabled` → alpha 0 / 1 with
  steps, sprites (`m_Sprite`, a sheet's sprite name from the `.meta`) → `tex` with a `$tex` template
  (`--tex`), `m_SizeDelta` → width / height on a 9-slice scene node, events → `$events` (parameters in
  the report), `m_StopTime` / `m_LoopTime` → `$duration` / `$loop`. A rotation about X / Y (a card flip)
  → its orthographic projection (rotation + scaleX / scaleY, `manual`).
- **Rest pose**: x / y / rotation are offsets of it, scale a multiplier — from the prefab's Transform /
  RectTransform, else the scene node, else the clip's first key (reported `manual`).
- **Ids**: `--scene X.svg` matches a path's last segment to the node ids (ambiguous / missing →
  unmatched, left out); `anim-map.md` lists every path with its id — edit it and pass `--map`
  (it wins). Without a scene: the idified last segments.
- **Report** (`report.md` / `report.json`): every clip `auto` / `manual` / `hard` per property with the
  reasons (weighted tangents, 3D rotations, guessed rest poses, `m_IsActive` as alpha; material
  properties, Animator / humanoid / root motion curves, unknown components, BlendTrees, clips of model
  files), the transitions (never executed — the game's logic). **Verification**: the md compiled and
  played by Trempel (headless) against the importer's own evaluation of the Unity curves at
  `--points` times: position ±0.5 px, rotation ±0.5°, scale ±0.5 %, alpha ±0.01, tint ±1/255, tex
  exact, events — a clip that does not converge is a finding, not a failure (exit 0). Codes:
  `E_ANIM_IMPORT_USAGE`, `E_ANIM_IMPORT_INPUT`, `E_ANIM_IMPORT_SCENE`, `E_ANIM_IMPORT_CLIP`,
  `E_ANIM_IMPORT_CONTROLLER` (exit 2); `W_ANIM_IMPORT_UNMATCHED`, `W_ANIM_IMPORT_COMPILE`,
  `W_ANIM_IMPORT_VERIFY`, `W_ANIM_IMPORT`.

## 2.1.0

What A World of Differences (DIF-2) and FindCat did around the kit, moved into it. Additions only:
the 2.0 API is unchanged (new options, members and exports). Needs `@trempel/scene` ^2.0.

### Transitions: a page leaf, by snapshots

- **`PageLeaf`** (stable entry; `LEAF_HARD`, `LEAF_SOFT`; the model — `@trempel/kit/internal/fx/page-leaf`):
  a genre-agnostic page leaf — one `Mesh` with its GLSL (WebGL2), rolled around a cylinder from the
  spine, with perspective, light on the front and the back, a shadow; `bend 0` — a hard leaf (a cover,
  a card). Front / back by the sign of the final matrix's determinant (the screen and a RenderTexture
  project Y differently; a mirrored parent too). Portrait: the turn ends when the leaf is wholly left
  of the spine (early finish), the column is cut in the shader.
- **`game.show(name, { transition })`** (`screens.show(name, { transition })`; a number — the fade
  seconds — still works): `'fade'` (default, as before), `'none'`, `{ fade: s }`,
  `{ leaf: { dir: 1 | -1, look: 'hard' | 'soft' | { bend, twist }, duration, back } }`, or a function
  `(ctx) => Promise` over the snapshots `ctx.before` / `ctx.after` with a layer and frames — the
  extension point for other transitions. The kit renders both screens into textures with the root's
  world matrix and the column's corner (DIF-2 rake №1: on a desktop the column is narrower than the
  window), hides the live screens while the transition plays, blocks the input (a blocker over the
  screens and `game.input`), frees the textures after. Without WebGL2 (or a shader that does not build,
  or `?transition=fade` in the web build) a leaf is a cross-fade of the same snapshots.
- **`game.transitions`** (`Transitions`): `turn(page, change, leaf)` — a page of one screen (an album's
  next world: snapshots around `change`), `drag({ page, allowed, can, change, … })` — pages turned with
  a finger: the leaf follows after 12 px horizontally (a vertical gesture is not a turn), a flick only
  while the finger moves, else by half the travel; a cancel switches the page back; `warm(pages)` —
  the shader and the textures on the GPU before the first turn; `info` (active, phase, mode, textures
  alive) for probes; `speed` (slow motion for e2e); `fallback`.

### Particles

- **Trails** in the kit's runtime (`ParticleConfig.trails`, typed `TrailConfig`: ratio, lifetime,
  minVertexDistance, width, color, blend, tint — all with defaults): a stroke along each particle's
  recent path, thinner and fainter towards the tail, one `Graphics` under the emitter's particles
  (FindCat's trail layer). The "not supported" warning is gone.
- **The effects table**: `createGame({ fx: { effects, textures } })` — `game.fx.play('name', …)` by name
  (`effects`: a config or a group, parent first — trempel-fx-import's `effects.json` as is); `textures`:
  a texture name → URL (or a function). A texture of the table that is not loaded yet loads at the
  first play of an effect using it: the `Effect` is returned at once and starts when its textures are
  in (`effect.ready`, `effect.pending`; its `time` runs from then). `fx.tables()`, `fx.names()`,
  `fx.configs()`, `fx.preload()`.
- **`trempel-fx-import`** (bin): Unity particle systems → the kit's effects, straight from a Unity
  project — a folder, a prefab or a scene (Force Text YAML). Nested prefabs are expanded with their
  overrides (ids `(instance ^ source) & 2^63−1`, property paths with arrays, removed components),
  materials (new and old serialization) and textures by GUID through the `.meta` files, built-in
  particle shaders → blends (Additive, Additive Soft → screen, Alpha Blended), legacy `_TintColor × 2`;
  units: world — pixels per unit × the scale chain, uGUI (`UIParticleSystem`) — the chain, Coffee
  `UIParticle` — its `m_Scale3D`; y-up → y-down. Writes `effects.json`, `textures/*.png` (no metadata;
  TGA decoded), `report.md` / `report.json`: every system `auto` / `manual` / `hard` with what is exact,
  approximated, not played; `--compare <configs.json>` — `compare.md` against a game's current configs.
  The normalization is FindCat's converter (`findcat/tools/lib/particles.ts`), now on the raw YAML.

### Sound

- **Volume and pitch in the table**: `sounds: { name: { src, volume?, pitch? } }` (`play()` options
  multiply them; `game.sound.level(name)`).
- **Popup sounds**: `createGame({ popupSounds: { show, hide } })`; `Popups.onHideSound` — on a close with
  the animation (not `closeNow()` / `closeAll()`).
- **A click silent when it opened / closed a popup** (`quietClicks`, default on): `data-sound` buttons
  and `game.sound.click(name)` play after the event, unless a popup opened or closed since the press
  (its own sound plays instead).
- **No lag on the first tap**: the AudioContext is made after boot (`sound.warm()`, suspended — the
  browser's audio start, ~150 ms the first time, is under the start screen); the first gesture only
  resumes it; synthesizing the presets and starting the loads run after that frame, one preset per
  task; a synth sound played before its turn is synthesized right then; a sound plays as soon as it is
  in (2.0: only after every sound loaded). Gate (the casual template's e2e): the first tap ≤ 20 ms of
  main-thread work at CPU ×4 (was 117–133 ms in DIF-2).

### Input

- A tap right after a popup closes reaches the game (the popup is still animating out) — the 2.0 rule,
  now under a test; a snapshot transition / a page drag blocks `game.input` while it runs.

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
