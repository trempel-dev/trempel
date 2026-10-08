// types.ts — what createGame takes and what it returns (the kit's stable API, 2.0).

import type { Application } from 'pixi.js';
import type { ComponentFactory, PixiBackend } from '@trempel/scene';
import type { Clips } from '../anim/clips.js';
import type { Tweens } from '../anim/tweens.js';
import type { AssetSpec, BundleMap, Loader } from '../assets/loader.js';
import type { Sound, SoundSource } from '../audio/sound.js';
import type { Ads } from '../data/ads.js';
import type { I18n, Strings } from '../data/i18n.js';
import type { Save, SaveOptions } from '../data/save.js';
import type { EventBus } from '../flow/bus.js';
import type { Fx, FxTables } from '../fx/fx.js';
import type { Input } from '../input/input.js';
import type { Platform } from '../platform/types.js';
import type { AnyContract, Impl } from '../services/contract.js';
import type { Services } from '../services/services.js';
import type { GameLoop } from '../time/loop.js';
import type { Backdrop, BackdropOptions } from '../ui/backdrop.js';
import type { KitBackendOptions, SliceLookup } from '../ui/kit-backend.js';
import type { CanvasMode, Insets, Rect } from '../ui/layout.js';
import type { Overlays, OverlayHide } from '../ui/overlays.js';
import type { PopupAnim, PopupLayer, Popups } from '../ui/popups.js';
import type { Screen, SceneSource } from '../ui/screen.js';
import type { Screens, ShowOptions } from '../ui/screens.js';
import type { Transitions } from '../ui/transitions.js';
import type { Skin } from '../ui/skin/skin.js';

/** A screen's code: built when its scene mounts; inject() / listen() in its fields resolve there. */
export type Controller = () => unknown;

export interface ScreenSpec extends SceneSource {
  /** Scale mode of the canvas (default 'expand'). */
  mode?: CanvasMode;
  /** Controller (`() => new MenuScreen()`), constructed at mount — game.controller(name). */
  controller?: Controller;
  /** Asset bundle loaded before the first show. */
  bundle?: string;
  /** Mount on first show instead of at boot (its art leaves the initial bundle). */
  lazy?: boolean;
  onShow?: () => void;
  onHide?: () => void;
}

export interface OverlaySpec extends SceneSource {
  mode?: CanvasMode;
  controller?: Controller;
  /** Shown from the first frame (a loading / title screen over the boot); hide it with game.overlays.hide(). */
  boot?: boolean;
  onShow?: () => void;
  onHidden?: () => void;
}

export interface PopupSpec extends SceneSource {
  mode?: CanvasMode;
  controller?: Controller;
  anim?: PopupAnim;
  layer?: PopupLayer;
  onShow?: () => void;
  onHidden?: () => void;
}

/** Kit-owned reactive state, available to scenes as `kit`. */
export interface KitState {
  /** Loading progress 0..100. */
  progress: number;
  /** Settings 0..1 (saved). */
  sfx: number;
  music: number;
  /** Game paused (pause menu). */
  paused: boolean;
  screen: string;
  popup: string;
  lang: string;
  /** Ads can be shown (rewarded buttons show only then — Playables). */
  ads: boolean;
}

export type Actions = Record<string, (...args: never[]) => unknown>;

export interface GameConfig<S extends object, D extends object> {
  /** Initial game state (made reactive; scenes bind to `state.*`). */
  state: S;
  /** Full screens (Trempel scenes). */
  screens: Record<string, ScreenSpec>;
  /** Screen shown after loading. */
  start: string;
  /** Popups (Trempel scenes with #content and optional #dim). */
  popups?: Record<string, PopupSpec>;
  /**
   * Scene-callable functions; a function form gets the game. 2.0: called before the scenes mount
   * (they are in the context from the first binding, prefabs included) — use the game lazily in
   * them, the screens are not mounted yet.
   */
  actions?: Actions | ((game: Game<S, D>) => Actions);
  /** Typed save of the game's own data (game.save). 2.0: the kit's settings and the services' store are kept apart. */
  save?: SaveOptions<D>;
  /**
   * One-shot sounds: URL(s), SynthSpec or { synth: preset }; presets work without declaring. 2.1: or
   * { src, volume, pitch } — the level and the tone in the table (play() options multiply them).
   */
  sounds?: Record<string, SoundSource>;
  music?: Record<string, string | readonly string[]>;
  /** 2.1: the popups' sounds (names of `sounds` or presets): on show, on an animated close (not closeNow). */
  popupSounds?: { show?: string; hide?: string };
  /**
   * 2.1: a button's click sound (`data-sound`, game.sound.click) is silent when that click opened or
   * closed a popup — its sound plays instead. Default true.
   */
  quietClicks?: boolean;
  /**
   * 2.1: the game's particle effects and their textures: `game.fx.play('name', …)`; a texture of the
   * table loads at the first play of an effect using it (trempel-fx-import writes `effects.json`).
   */
  fx?: FxTables;
  /** String tables per language. */
  i18n?: Record<string, Strings>;
  /**
   * Trempel collections (v1.1): name → URL of the folder as the build serves it (`'./skins/default/ui'`,
   * a CDN). A scene's `@name/path` becomes `<URL>/path` before `assets.resolve` — the bundler's
   * table sees ordinary paths; asset bundles may list `@name/…` too. An unknown name is a mount error.
   */
  collections?: Record<string, string>;
  assets?: {
    /** Scene href → bundle URL (see assetTable()); collection hrefs arrive expanded. */
    resolve?: (href: string) => string;
    /** Loaded before the first screen (counted in the initial bundle). */
    initial?: AssetSpec[];
    /** Lazy bundles by name (ScreenSpec.bundle, game.loader.load()). */
    bundles?: BundleMap;
    /** Web fonts bundled with the game: { family, src }. */
    fonts?: { family: string; src: string }[];
  };
  layout?: {
    /** Widest column aspect (w/h); default 0.75 for portrait references, none for landscape. */
    maxAspect?: number;
    /** Clear colour around and under the scenes. */
    background?: number | string;
    /** Design resolution (default: the start screen's viewBox) — the frame of `hud` and the playfield. */
    design?: { width: number; height: number };
    /** Fit policy of screens, popups and overlays without their own `mode` (default fitMin = v0 'expand'). */
    policy?: CanvasMode;
    /** Safe area: true — the device's (CSS env), default; false — none; insets (px) — fixed. */
    safeArea?: boolean | Partial<Insets>;
    /**
     * HUD zones, design units from the canvas edges: the playfield is the rest (game.playfield).
     * `screen` — the screen whose canvas the zones are measured on (its fit; default: the design
     * resolution under `policy`).
     */
    hud?: HudZones;
    /** A blurred copy of a texture / container behind the column (game.backdrop.set(...)). */
    backdrop?: boolean | BackdropOptions;
  };
  /**
   * The UI skin (createSkin): tokens and art of the kit's components and of `skin:` hrefs. Default —
   * the kit's procedural skin; null — none (the scenes' own art only).
   */
  skin?: Skin | null;
  /** 9-slice borders of the game's own (non-skin) art by resolved URL. */
  slices?: SliceLookup;
  /**
   * The Trempel backend: a factory (or a subclass of KitBackend / PixiBackend) for the game's own
   * non-SVG attributes. Gets the kit's backend options (font, skin, slices).
   */
  backend?: PixiBackend | ((opts: KitBackendOptions) => PixiBackend) | (new (opts: KitBackendOptions) => PixiBackend);
  /** Overlay screens over everything (game.overlays.show / hide). */
  overlays?: Record<string, OverlaySpec>;
  /**
   * Finish loading before platform.gameReady(): runs after the start screen is shown (the game
   * loads its current level, draws it…). `update` starts after it.
   */
  ready?: (game: Game<S, D>) => void | Promise<void>;
  /** localStorage key of the web build's save (default 'trempel.save'); ignored with `platform`. */
  saveKey?: string;
  /** Default font family of scene texts. */
  fontFamily?: string;
  /**
   * Extra Trempel components (tml:type) by name. The function form gets the kit's services
   * (loop, tweens, fx, renderer, resolve) — Trempel's ComponentContext has none of them.
   */
  components?: Record<string, ComponentFactory> | ((kit: KitServices) => Record<string, ComponentFactory>);
  /** Platform adapter (default: the one of the build target): implements lifecycle, save, audio, language, ads. */
  platform?: Platform;
  /** The game's contracts (the kit's own are always registered): inject() of any other fails at mount. */
  services?: AnyContract[];
  /** Implementations over the mocks: [Contract, impl, name?] (after the platform's). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  provide?: (readonly [AnyContract, Impl<any, any, any>] | readonly [AnyContract, Impl<any, any, any>, string])[];
  /** Element (or selector) to put the canvas in (default: #app, else body). */
  parent?: HTMLElement | string;
  /** Per-frame game update (stops on pause). */
  update?: (dt: number) => void;
  /** Dev cheats (web build, ?cheat=1 → window.__trempel.cheats). */
  cheats?: Record<string, (...a: unknown[]) => unknown>;
  /** The game's own read-only e2e probes, merged into window.__trempel (web build only); also game.probe(). */
  probe?: Record<string, unknown>;
}

export type HudZones = Partial<Insets> & { screen?: string };

/** The playfield: the screen minus the HUD zones and the safe area — where the game's world goes. */
export interface Playfield {
  /** Window px. */
  readonly px: Rect;
  /** The device's safe-area insets, px. */
  readonly safe: Insets;
  /** The playfield in a screen's reference units (its canvas): a screen name or a Screen. */
  in(screen: string | Screen): Rect;
}

export interface LayoutEvent {
  width: number;
  height: number;
  playfield: Playfield;
}

/** Services a component factory may need (time, tweens, effects, renderer, href resolution). */
export interface KitServices {
  loop: GameLoop;
  tweens: Tweens;
  fx: Fx;
  sound: Sound;
  app: Application;
  resolve: (href: string) => string;
  services: Services;
}

/** Host events on the bus. */
export interface KitEvents {
  'screen:show': { name: string };
  'popup:show': { name: string };
  'popup:hide': { name: string };
  'game:pause': undefined;
  'game:resume': undefined;
  'platform:pause': undefined;
  'platform:resume': undefined;
  /** After every layout (resize, rotation, setHud): re-fit the world into game.playfield. */
  layout: LayoutEvent;
  'overlay:show': { name: string };
  'overlay:hide': { name: string };
  // The kit's contracts (services): `<contract>:<event>`; listen(Wallet.events.changed, …) is the typed way.
  'lifecycle:pause': undefined;
  'lifecycle:resume': undefined;
  'audio:changed': boolean;
  'language:changed': string;
  'ads:changed': boolean;
  'wallet:changed': number;
  'wallet:spent': { amount: number; reason?: string };
  'iap:purchased': { id: string };
  [intent: `intent:${string}`]: unknown;
}

export interface Game<S extends object, D extends object> {
  readonly state: S;
  readonly kit: KitState;
  readonly platform: Platform;
  readonly app: Application;
  readonly loop: GameLoop;
  readonly tweens: Tweens;
  readonly clips: Clips;
  readonly fx: Fx;
  readonly sound: Sound;
  /** The game's own save (2.0: the kit's sfx / music / svc are not in it and cannot be overwritten through it). */
  readonly save: Save<D>;
  readonly i18n: I18n;
  readonly t: I18n['t'];
  readonly ads: Ads;
  readonly input: Input;
  readonly bus: EventBus<KitEvents>;
  /** The game's contracts: get / provide / state / mock (also the module-level `services`). */
  readonly services: Services;
  readonly loader: Loader;
  readonly screens: Screens;
  readonly popups: Popups;
  readonly overlays: Overlays;
  /** 2.1: transitions by snapshots — the page leaf, page turns inside a screen, page drag. */
  readonly transitions: Transitions;
  readonly backend: PixiBackend;
  /** The skin (null with skin: null). */
  readonly skin: Skin | null;
  /** Screen minus HUD minus safe area (updated on every layout; `bus.on('layout')`). */
  readonly playfield: Playfield;
  /** Blurred copy behind the column (layout.backdrop). */
  readonly backdrop: Backdrop;
  /** Scene context (state, kit, t, built-ins, actions) — the same object every scene got. */
  readonly context: Record<string, unknown>;
  /**
   * Switch screen (loads its bundle first). 2.1: `{ transition }` — 'fade' (default), 'none',
   * { fade: s }, { leaf: { dir, look: 'hard' | 'soft', duration } } or a function over the snapshots.
   */
  show(name: string, opts?: ShowOptions): Promise<void>;
  /** Open / close a popup. */
  popup(name: string): void;
  close(name?: string): Promise<void>;
  /** Close a popup at once, without its animation. */
  closeNow(name: string): void;
  /** Hide an overlay (its animation; input passes through at once). */
  hideOverlay(name: string, opts?: OverlayHide): Promise<void>;
  /** Screen by name (`game.screen('game').byId('board')`). */
  screen(name: string): Screen;
  /** The controller of a screen / popup / overlay (its spec's `controller`); popups: 'popup:<name>'. */
  controller<T = unknown>(name: string): T;
  /** Pause / resume the game channel (+ the 'pause' popup when declared). */
  pause(): void;
  resume(): void;
  setVolume(kind: 'sfx' | 'music', v: number): void;
  /** Re-run layout (after changing what anchors depend on). */
  layout(): void;
  /** Change the HUD zones (design units) — the playfield follows, `layout` fires. */
  setHud(hud: HudZones): void;
  /** Add read-only e2e probes to window.__trempel (web build; no-op in the youtube build). */
  probe(extra: Record<string, unknown>): void;
  /**
   * 2.0: take the game down — screens, popups, overlays and their controllers (their inject /
   * listen), the ticker, input, sound, the bus and the services' subscriptions, the canvas, the
   * probe. Another createGame in the same page works after it.
   */
  destroy(): void;
}

