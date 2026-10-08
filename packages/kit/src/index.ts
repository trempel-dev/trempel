// @trempel/kit — the stable API (2.0). A typical game: createGame({...}) and, when it has external
// services, contracts; everything else is reached through the game object (game.loop, game.tweens,
// game.sound…). The classes behind those members are exported here as TYPES only.
//
// Other entries: `@trempel/kit/vite` (the Vite plugin, build gates), `@trempel/kit/testing`
// (headless helpers, the mock platform), `@trempel/kit/e2e` (Playwright helpers), `@trempel/kit/skin-cli`.
// Everything else — the classes themselves (Tweens, GameLoop, Fx, Popups, Screen…), layout math,
// particle internals, the save parser… — is `@trempel/kit/internal/<module>` (e.g.
// `@trempel/kit/internal/anim/tweens`), with no stability promise. CHANGELOG.md (2.0.0) lists
// where every export of 1.x went.

// ---- createGame ----------------------------------------------------------------------------------
export { createGame } from './game.js';
export type {
  Game, GameConfig, ScreenSpec, PopupSpec, OverlaySpec, Controller, KitState, KitEvents, KitServices, Actions, Playfield, LayoutEvent, HudZones,
} from './game.js';
export type { SceneSource } from './ui/screen.js';
export type { Platform, RewardedResult } from './platform/types.js';

// The types of the game's members (game.loop, game.tweens, game.save…) — types only.
export type { GameLoop, Clock, UpdateFn } from './time/loop.js';
export type { Tweens, Ease, EaseName, TweenOptions } from './anim/tweens.js';
export type { Clips, ClipPlayOptions, AnimClip, Handle } from './anim/clips.js';
export type { Fx, Effect, EffectSpec, FxPlayOptions, FxTables } from './fx/fx.js';
export type { ParticleConfig, TrailConfig } from './fx/types.js';
export type { Sound, SoundSource, SoundEntry } from './audio/sound.js';
export type { SynthSpec, SynthPreset } from './audio/synth.js';
export type { Save, SaveOptions } from './data/save.js';
export type { I18n, Strings } from './data/i18n.js';
export type { Ads } from './data/ads.js';
export type { Input, InputAction, Dir, TapEvent } from './input/input.js';
export type { EventBus, BusHandler } from './flow/bus.js';
export type { Loader, AssetSpec, BundleMap } from './assets/loader.js';
export type { Screen } from './ui/screen.js';
export type { Screens, ShowOptions } from './ui/screens.js';
export type { Transitions, ScreenTransition, LeafOptions, TransitionFn, TransitionContext, PageDragOptions, PageTarget } from './ui/transitions.js';
export type { Popups, PopupAnim, PopupLayer } from './ui/popups.js';
export type { Overlays, OverlayHide, OverlayAnim } from './ui/overlays.js';
export type { Backdrop, BackdropOptions } from './ui/backdrop.js';
export type { CanvasMode, Rect, Insets } from './ui/layout.js';

// ---- 2.1: the page leaf (fx) — genre-agnostic: a page, a cover, a card turned over --------------------
export { PageLeaf, LEAF_HARD, LEAF_SOFT } from './fx/page-leaf.js';
export type { LeafLook, LeafLookName } from './fx/page-leaf.js';

// ---- services: contracts with a mandatory mock ---------------------------------------------------
export { contract, extend, adapt, sticky, once, Services, ServiceError, services, inject, listen, provide, currentServices } from './services/index.js';
export { Lifecycle, SaveService, AudioService, Language, AdsService, Wallet, Iap, Leaderboard, KIT_CONTRACTS } from './services/index.js';
export type {
  Contract, AnyContract, ContractSpec, ServiceContext, EventRef, EventDecl, EventKind, MockModes, Impl, Named, Factory, Api, StateOf, EventsOf, PayloadArgs,
  Mounted, ServiceLogEntry, ServiceStore, ServiceInfo, SpendResult, Product, PurchaseResult, LeaderEntry,
} from './services/index.js';

// ---- components: the kit's UI components, the skin, the backend a game's components draw with ----
export { uiComponents, UI_COMPONENTS } from './ui/components/index.js';
export type { UIServices } from './ui/components/index.js';
export { Skin, createSkin, defaultSkin } from './ui/skin/skin.js';
export type { SkinSource, Look } from './ui/skin/skin.js';
export { DEFAULT_SKIN } from './ui/skin/default.js';
export type { SkinJson, SkinMap, SkinFile, SkinFont, SkinStates, RoleValue, Slice, SlotIconMode } from './ui/skin/format.js';
export { KitBackend } from './ui/kit-backend.js';
export type { KitBackendOptions, SliceLookup } from './ui/kit-backend.js';
export { UI_SCENES } from './ui/scenes.js';
export { assetTable } from './assets/loader.js';
