// @trempel/kit — public API. Typical game: createGame({...}); everything else is optional.

export { createGame } from './game.js';
export type { Game, GameConfig, ScreenSpec, PopupSpec, OverlaySpec, Controller, KitState, KitEvents, KitServices, Actions, Playfield, LayoutEvent, HudZones } from './game.js';

// Services: contracts with a mandatory mock; the kit's standard contracts.
export {
  contract, extend, adapt, sticky, once, Services, ServiceError, services, inject, listen, provide, currentServices, setCurrentServices, parseModeQuery,
  Lifecycle, SaveService, AudioService, Language, AdsService, Wallet, Iap, Leaderboard, KIT_CONTRACTS, platformProviders, platformFacade,
} from './services/index.js';
export type {
  Contract, AnyContract, ContractSpec, ServiceContext, EventRef, EventDecl, EventKind, MockModes, Impl, Named, Factory, Api, StateOf, EventsOf, PayloadArgs,
  Mounted, ServiceLogEntry, ServiceStore, ServiceInfo, SpendResult, Product, PurchaseResult, LeaderEntry, Provision,
} from './services/index.js';

export { createPlatform, buildTarget, createWebPlatform, createYoutubePlatform, createMockPlatform } from './platform/index.js';
export type { Platform, RewardedResult, MockPlatform, MockHost, WebPlatformOptions } from './platform/index.js';

export { GameLoop, TickerAdapter, abortError, isAbort } from './time/loop.js';
export type { Clock, UpdateFn, LoopOptions } from './time/loop.js';

export { Tweens, ease, easeOf } from './anim/tweens.js';
export type { Ease, EaseName, TweenOptions } from './anim/tweens.js';
export { Clips } from './anim/clips.js';
export type { ClipPlayOptions, AnimClip, Handle } from './anim/clips.js';

export { EventPlayer } from './flow/player.js';
export type { BookEvent, PlayContext, EventHandler, HandlerMap, EventPlayerOptions } from './flow/player.js';
export { StateMachine, abortable, checkAborted } from './flow/fsm.js';
export type { StateHandler } from './flow/fsm.js';
export { EventBus } from './flow/bus.js';
export type { BusHandler } from './flow/bus.js';

export { Screen } from './ui/screen.js';
export type { SceneSource, ScreenDeps, ScreenHooks } from './ui/screen.js';
export { Screens } from './ui/screens.js';
export { Popups, POPUP } from './ui/popups.js';
export type { PopupDef, PopupAnim, PopupLayer } from './ui/popups.js';
export { column, canvas, canvasRect, coverScale, containScale, viewBoxOf, policyOf, playfield, safeRect, insetsOf, inset, safeShift, NO_INSETS } from './ui/layout.js';
export type { Rect, CanvasMode, CanvasFit, FitPolicy, Insets } from './ui/layout.js';
export { buttonFx, centerPivot } from './ui/buttons.js';
export { readSafeArea } from './ui/safe-area.js';
export { Backdrop } from './ui/backdrop.js';
export type { BackdropOptions } from './ui/backdrop.js';
export { Overlays, OVERLAY } from './ui/overlays.js';
export type { OverlayAnim, OverlayHide } from './ui/overlays.js';
export { KitBackend, containBox, fitText, setTextFit } from './ui/kit-backend.js';
export type { KitBackendOptions, SliceLookup } from './ui/kit-backend.js';
export { whiteTexture } from './ui/textures.js';

// UI kit: skins and components.
export { Skin, createSkin, defaultSkin, artTable, parseHex, NONE_HREF, FILL_PREFIX, ROLE_PREFIX } from './ui/skin/skin.js';
export type { SkinSource, Look } from './ui/skin/skin.js';
export { DEFAULT_SKIN } from './ui/skin/default.js';
export { validateSkin, ROLES, SLOT_ICON_MODES } from './ui/skin/format.js';
export type { SkinJson, SkinMap, SkinFile, SkinFont, SkinStates, RoleValue, Slice, SlotIconMode } from './ui/skin/format.js';
export {
  uiComponents, UI_COMPONENTS, UIButton, UIIconButton, UIToggle, UIPlate, UIPanel, UIPopupFrame, UIBadge, UIProgress, UISlider, UIStars, UISlot,
  iconView, placeFrame, slotLook, silhouetteFilter, FULL_FRAME, SLOT, ICONS, drawIcon, starPoints, shade, plateGraphics,
} from './ui/components/index.js';
export type { UIServices, SlotFrame, SlotState, IconName } from './ui/components/index.js';
export { UI_SCENES } from './ui/scenes.js';

export { Loader, assetTable } from './assets/loader.js';
export type { AssetSpec, BundleMap } from './assets/loader.js';

export { Sound } from './audio/sound.js';
export type { SoundSource, SoundOptions } from './audio/sound.js';
export { SYNTH_PRESETS, renderSynth } from './audio/synth.js';
export type { SynthSpec, SynthPreset } from './audio/synth.js';

export { Fx, Effect } from './fx/fx.js';
export type { EffectSpec, FxPlayOptions } from './fx/fx.js';
export { ParticleEmitter } from './fx/emitter.js';
export { ParticleSim, sampleCurve, sampleMinMax, spawnPoint } from './fx/sim.js';
export { PARTICLES } from './fx/presets.js';
export type { ParticlePreset } from './fx/presets.js';
export { particleConfig } from './fx/types.js';
export type { ParticleConfig, Curve, MinMax, RGBA, Burst, Blend } from './fx/types.js';

export { Save, parseSave } from './data/save.js';
export type { SaveOptions } from './data/save.js';
export { I18n } from './data/i18n.js';
export { KIT_STRINGS, withKitStrings } from './data/kit-strings.js';
export type { Strings } from './data/i18n.js';
export { Ads } from './data/ads.js';

export { Input, swipeDirection, keyAction } from './input/input.js';
export type { Dir, InputAction, TapEvent } from './input/input.js';

export { seededRandom } from './qa/random.js';
