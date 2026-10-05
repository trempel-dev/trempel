// game.ts — createGame(): the one entry point of the kit for the typical case. Boots platform →
// Pixi → loading → initial bundle → save → screens/popups (Trempel scenes) → first screen →
// gameReady, and wires everything an agent should not write by hand: the loop and pause, layout
// and resize, sound unlock and settings, input, save, i18n, ads, QA probe.
//
// Contract with scenes: every scene mounts with the context
//   { state, kit, services, t, show, popup, close, pause, resume, toggleSfx, toggleMusic, ...actions }
// so `tml:on-click="popup('settings')"`, `tml:bind="t('score', {n: state.score})"` and
// `tml:bind-text="services.wallet.balance"` work.
//
// Services (1.3): every external thing is a contract with a mandatory mock (./services). The
// platform adapter of the build target implements lifecycle / save / audio / language / ads;
// game.platform, game.save and game.ads are facades over those contracts.
//
// The skin (tokens, art roles) and the kit's UI components (ui-button, ui-slot…) with every
// scene; fit policies, the safe area and the PLAYFIELD (screen minus the HUD the game declares);
// a blurred backdrop; overlays over everything; a game backend subclass; `ready` before gameReady;
// the game's own probes.

// Pixi's eval-free shader/uniform/particle sync (its default generates code with new Function,
// which a CSP without unsafe-eval — YouTube Playables — blocks). Trempel needs no eval either.
import 'pixi.js/unsafe-eval';
import { Application, Container, Graphics, Text, type Renderer } from 'pixi.js';
import { PixiBackend, Registry, reactive, type ComponentFactory } from '@trempel/scene';
import { Clips } from './anim/clips.js';
import { Tweens } from './anim/tweens.js';
import { Loader, withCollections, type AssetSpec, type BundleMap } from './assets/loader.js';
import { Sound, type SoundSource } from './audio/sound.js';
import { Ads } from './data/ads.js';
import { I18n, type Strings } from './data/i18n.js';
import { withKitStrings } from './data/kit-strings.js';
import { Save, type SaveOptions } from './data/save.js';
import { EventBus } from './flow/bus.js';
import { Fx } from './fx/fx.js';
import { Input } from './input/input.js';
import { createPlatform } from './platform/index.js';
import type { Platform } from './platform/types.js';
import { GameLoop } from './time/loop.js';
import { Backdrop, type BackdropOptions } from './ui/backdrop.js';
import { buttonFx } from './ui/buttons.js';
import { uiComponents } from './ui/components/index.js';
import { KitBackend, type KitBackendOptions, type SliceLookup } from './ui/kit-backend.js';
import { NO_INSETS, canvas, canvasRect, column, playfield as playfieldRect, safeRect, viewBoxOf, type CanvasMode, type Insets, type Rect } from './ui/layout.js';
import { Overlays, type OverlayHide } from './ui/overlays.js';
import { Popups, type PopupAnim, type PopupLayer } from './ui/popups.js';
import { readSafeArea } from './ui/safe-area.js';
import { Screen, type SceneSource, type ScreenHooks } from './ui/screen.js';
import { Screens } from './ui/screens.js';
import type { AnyContract, Impl } from './services/contract.js';
import { platformFacade, platformProviders } from './services/platform.js';
import { adoptServices, parseModeQuery, type Services } from './services/services.js';
import { AdsService, KIT_CONTRACTS } from './services/standard.js';
import { DEFAULT_SKIN } from './ui/skin/default.js';
import { Skin } from './ui/skin/skin.js';

declare const __TREMPEL_TARGET__: string | undefined;

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
  /** Scene-callable functions; a function form gets the game (called once, after boot). */
  actions?: Actions | ((game: Game<S, D>) => Actions);
  /** Typed save (kit adds `sfx`/`music` settings next to your fields). */
  save?: SaveOptions<D>;
  /** One-shot sounds: URL(s), SynthSpec or { synth: preset }; presets work without declaring. */
  sounds?: Record<string, SoundSource>;
  music?: Record<string, string | readonly string[]>;
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
  readonly save: Save<D & { sfx: number; music: number }>;
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
  readonly backend: PixiBackend;
  /** The skin (null with skin: null). */
  readonly skin: Skin | null;
  /** Screen minus HUD minus safe area (updated on every layout; `bus.on('layout')`). */
  readonly playfield: Playfield;
  /** Blurred copy behind the column (layout.backdrop). */
  readonly backdrop: Backdrop;
  /** Scene context (state, kit, t, built-ins, actions) — the same object every scene got. */
  readonly context: Record<string, unknown>;
  /** Switch screen (loads its bundle first). */
  show(name: string): Promise<void>;
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
}

function parentOf(p: HTMLElement | string | undefined): HTMLElement {
  if (typeof p === 'string') {
    const el = document.querySelector<HTMLElement>(p);
    if (!el) throw new Error(`createGame: parent "${p}" not found`);
    return el;
  }
  if (p) return p;
  const app = document.getElementById('app');
  if (app) return app;
  // No #app: the canvas goes into body — a full-window element already there would sit over it and
  // eat the input.
  for (const el of Array.from(document.body.children) as HTMLElement[]) {
    if (el.tagName === 'SCRIPT' || el.tagName === 'CANVAS') continue;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if ((cs.position === 'fixed' || cs.position === 'absolute') && r.width >= innerWidth * 0.9 && r.height >= innerHeight * 0.9 && cs.pointerEvents !== 'none') {
      console.warn(`kit: no #app — the canvas goes into <body>, but <${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}> covers the window and will take the input. Put <div id="app"></div> in index.html (or createGame({ parent })).`);
    }
  }
  return document.body;
}

export async function createGame<S extends object, D extends object = Record<string, never>>(cfg: GameConfig<S, D>): Promise<Game<S, D>> {
  // Services: the kit's contracts + the game's; the build target's platform adapter implements the
  // platform ones (unless provided before createGame), then the game's overrides.
  const bus = new EventBus<KitEvents>();
  const services = adoptServices();
  services.bus = bus as never;
  services.register(...KIT_CONTRACTS, ...(cfg.services ?? []));
  const source = cfg.platform ?? createPlatform({ saveKey: cfg.saveKey });
  for (const [c, impl] of platformProviders(source)) if (services.implName(c) === 'mock') services.provide(c, impl);
  for (const [c, impl, label] of cfg.provide ?? []) services.provide(c, impl, label);
  if (typeof __TREMPEL_TARGET__ === 'undefined' || __TREMPEL_TARGET__ !== 'youtube') {
    for (const [name, modes] of Object.entries(parseModeQuery(location.search))) {
      try {
        services.mock(name, modes);
      } catch (e) {
        console.warn(`kit: ?svc.${name}: ${(e as Error).message}`);
      }
    }
  }
  const platform = platformFacade(services, source);
  await platform.init();

  const parent = parentOf(cfg.parent);
  const app = new Application();
  const firstSpec = cfg.screens[cfg.start];
  if (!firstSpec) throw new Error(`createGame: start screen "${cfg.start}" is not in screens (${Object.keys(cfg.screens).join(', ')})`);
  await app.init({
    // WebGL2 is the kit's minimum.
    preference: 'webgl',
    resizeTo: parent === document.body ? window : parent,
    background: cfg.layout?.background ?? 0x101018,
    antialias: true,
    autoDensity: true,
    resolution: Math.min(2, window.devicePixelRatio || 1),
  });
  parent.appendChild(app.canvas);
  app.canvas.style.display = 'block';
  app.canvas.style.touchAction = 'none';

  const loop = new GameLoop();
  const tweens = new Tweens();
  loop.add((dt) => tweens.update(dt), 'ui');
  loop.attach(app.ticker);

  // Loading UI (built-in bar) — first frame.
  const loadingView = new Container();
  const bar = new Graphics();
  const label = new Text({ text: '', style: { fill: 0xffffff, fontSize: 18, fontFamily: cfg.fontFamily ?? 'sans-serif' } });
  label.anchor.set(0.5);
  loadingView.addChild(bar, label);
  const drawLoading = (p: number) => {
    if (loadingView.destroyed) return;
    const W = app.screen.width;
    const H = app.screen.height;
    const w = Math.min(320, W * 0.6);
    bar.clear().roundRect((W - w) / 2, H / 2 - 6, w, 12, 6).fill({ color: 0xffffff, alpha: 0.15 }).roundRect((W - w) / 2, H / 2 - 6, (w * p) / 100, 12, 6).fill(0xffffff);
    label.text = `${Math.round(p)}%`;
    label.position.set(W / 2, H / 2 + 30);
  };
  app.stage.addChild(loadingView);
  drawLoading(0);
  app.render();
  platform.firstFrameReady();

  const kit = reactive<KitState>({ progress: 0, sfx: 1, music: 1, paused: false, screen: '', popup: '', lang: 'en', ads: false });
  const setProgress = (p: number) => {
    kit.progress = p;
    drawLoading(p);
  };

  // The skin: the game's, else the kit's procedural one (in the game's font).
  const skin: Skin | null =
    cfg.skin !== undefined
      ? cfg.skin
      : new Skin({ json: cfg.fontFamily ? { ...DEFAULT_SKIN, fonts: { heading: { ...DEFAULT_SKIN.fonts.heading, family: cfg.fontFamily }, text: { family: cfg.fontFamily } } } : DEFAULT_SKIN });
  const collections = cfg.collections;
  const gameResolve = withCollections(cfg.assets?.resolve ?? ((h: string) => h), collections);
  const resolve = skin ? (h: string) => skin.resolve(h) ?? gameResolve(h) : gameResolve;
  const loader = new Loader(cfg.assets?.bundles ?? {}, resolve);
  const fonts = (cfg.assets?.fonts ?? []).map((f) => ({ src: resolve(f.src), data: { family: f.family } }));
  await loader.loadList([...fonts, ...(skin?.urls() ?? []), ...(cfg.assets?.initial ?? [])], (p) => setProgress(p * 60));

  const i18n = new I18n(withKitStrings(cfg.i18n), platform.language());
  kit.lang = i18n.lang;
  const sound = new Sound({ sounds: cfg.sounds, music: cfg.music, resolve });
  const saveOpts = {
    version: cfg.save?.version ?? 1,
    // `svc` — what contracts persist (ctx.store): the wallet's balance, owned purchases…
    defaults: { ...(cfg.save?.defaults ?? ({} as D)), sfx: 1, music: 1, svc: {} },
    migrate: cfg.save?.migrate,
  };
  const save = new Save<D & { sfx: number; music: number }>(platform, saveOpts);
  await save.load();
  type WithSvc = { svc?: Record<string, unknown> };
  services.store = {
    get: (name) => (save.data as WithSvc).svc?.[name],
    set: (name, v) => void save.update((d) => ({ ...d, svc: { ...((d as WithSvc).svc ?? {}), [name]: JSON.parse(JSON.stringify(v ?? null)) } })),
  };
  // Awake of the services: every implementation is built (the wallet reads its balance) before the scenes bind.
  services.start();
  kit.sfx = save.data.sfx;
  kit.music = save.data.music;
  sound.setVolumes(kit.sfx, kit.music);
  setProgress(70);

  const state = reactive(cfg.state);
  const fx = new Fx(app.renderer as Renderer, resolve);
  loop.add((dt) => fx.update(dt), 'ui');
  const backendOpts: KitBackendOptions = { fontFamily: cfg.fontFamily, skin, slices: cfg.slices };
  const backend = makeBackend(cfg.backend, backendOpts);
  const clips = new Clips(backend, loop);
  const input = new Input();
  const ads = new Ads(platform, {
    now: () => loop.time,
    onAd: (on) => {
      if (on) {
        loop.suspend();
        sound.suspend();
      } else {
        loop.unsuspend();
        sound.resume();
      }
    },
  });
  const context: Record<string, unknown> = { state, kit, services: services.scene, t: i18n.t };
  services.listen(AdsService.events.changed, (on) => (kit.ads = on));
  const registry = new Registry();
  if (skin) for (const [name, f] of Object.entries(uiComponents({ skin, tweens, context }))) registry.register(name, f);
  const comps = typeof cfg.components === 'function' ? cfg.components({ loop, tweens, fx, sound, app, resolve, services }) : (cfg.components ?? {});
  // The game's components are owners: inject() / listen() in them resolve at mount (awake).
  for (const [name, f] of Object.entries(comps)) registry.register(name, (ctx) => services.mount(`component ${name}${ctx.attrs.id ? '#' + ctx.attrs.id : ''}`, () => f(ctx)).value);

  const popups = new Popups(tweens);
  const screens = new Screens(tweens, (b) => loader.load(b));
  const overlays = new Overlays(tweens);
  const backdrop = new Backdrop(app.renderer as Renderer, typeof cfg.layout?.backdrop === 'object' ? cfg.layout.backdrop : {});

  let game!: Game<S, D>;
  const probeExtras: Record<string, unknown> = { ...(cfg.probe ?? {}) };
  let probeMerge: ((x: Record<string, unknown>) => void) | null = null;
  const builtins = {
    show: (name: string) => void game.show(name),
    popup: (name: string) => game.popup(name),
    close: (name?: string) => void game.close(name),
    pause: () => game.pause(),
    resume: () => game.resume(),
    toggleSfx: () => game.setVolume('sfx', kit.sfx > 0 ? 0 : 1),
    toggleMusic: () => game.setVolume('music', kit.music > 0 ? 0 : 1),
    setSfx: (v: number) => game.setVolume('sfx', v),
    setMusic: (v: number) => game.setVolume('music', v),
  };
  Object.assign(context, builtins);

  const hooks: ScreenHooks = {
    press: (node) => buttonFx(node, tweens),
    sound: (node, name) => {
      node.eventMode = 'static';
      node.on('pointertap', () => sound.play(name));
    },
  };
  const deps = { backend, context, registry, resolveHref: resolve, collections, hooks };

  const [, , designW, designH] = cfg.layout?.design ? [0, 0, cfg.layout.design.width, cfg.layout.design.height] : viewBoxOf(firstSpec.base);
  const portrait = designW < designH;
  const maxAspect = cfg.layout?.maxAspect ?? (portrait ? 0.75 : undefined);
  const policy: CanvasMode = cfg.layout?.policy ?? 'expand';
  let hud: HudZones = { ...(cfg.layout?.hud ?? {}) };
  const safeCfg = cfg.layout?.safeArea ?? true;
  const readSafe = (): Insets => (safeCfg === true ? readSafeArea() : safeCfg === false ? { ...NO_INSETS } : { ...NO_INSETS, ...safeCfg });
  let pfPx: Rect = { x: 0, y: 0, w: 0, h: 0 };
  let pfSafe: Insets = { ...NO_INSETS };
  const playfield: Playfield = {
    get px() {
      return pfPx;
    },
    get safe() {
      return pfSafe;
    },
    in: (screen) => (typeof screen === 'string' ? screens.get(screen) : screen).toRef(pfPx),
  };
  const all: Screen[] = [];
  let booted = false;
  const doLayout = () => {
    const W = app.screen.width;
    const H = app.screen.height;
    const col = column(W, H, maxAspect);
    pfSafe = readSafe();
    const safe = safeRect(W, H, pfSafe);
    for (const s of all) s.layout(col, safe);
    const on = hud.screen && screens.names().includes(hud.screen) ? screens.get(hud.screen) : null;
    if (on) pfPx = playfieldRect(on.rect, safe, hud, on.scale);
    else {
      const fit = canvas(policy, col.w, col.h, designW, designH);
      pfPx = playfieldRect(canvasRect(col, fit), safe, hud, fit.scale);
    }
    backdrop.layout(W, H);
    if (booted) bus.emit('layout', { width: W, height: H, playfield });
  };

  const controllers = new Map<string, unknown>();
  const mountScreen = (name: string, spec: ScreenSpec | PopupSpec | OverlaySpec) => {
    const s = new Screen(name, spec, spec.mode ?? policy, deps);
    all.push(s);
    doLayout();
    if (spec.controller) controllers.set(name, services.mount(`screen "${name}"`, spec.controller).value);
    return s;
  };
  const pendingLazy = new Map<string, ScreenSpec>();
  for (const [name, spec] of Object.entries(cfg.screens)) {
    if (spec.lazy && name !== cfg.start) pendingLazy.set(name, spec);
    else screens.add(name, { screen: mountScreen(name, spec), bundle: spec.bundle, onShow: spec.onShow, onHide: spec.onHide });
  }
  for (const [name, spec] of Object.entries(cfg.popups ?? {})) {
    const s = mountScreen(`popup:${name}`, spec);
    popups.register({ name, screen: s, layer: spec.layer ?? 'default', anim: spec.anim ?? 'scale', onShow: spec.onShow, onHidden: spec.onHidden });
  }
  for (const [name, spec] of Object.entries(cfg.overlays ?? {})) {
    overlays.add(name, mountScreen(`overlay:${name}`, spec), { onShow: spec.onShow, onHidden: spec.onHidden });
  }
  overlays.onChange = (name, open) => bus.emit(open ? 'overlay:show' : 'overlay:hide', { name });
  popups.onShowSound = () => {};
  popups.onChange = () => {
    kit.popup = popups.top() ?? '';
    input.enabled = !popups.blocking;
  };
  screens.onChange = (name) => {
    kit.screen = name;
    bus.emit('screen:show', { name });
  };
  app.stage.addChildAt(screens.layer, 0);
  app.stage.addChildAt(popups.layers.over, 1);
  app.stage.addChildAt(popups.layers.default, 2);
  app.stage.addChildAt(backdrop.view, 0);
  app.stage.addChild(overlays.layer);
  app.renderer.on('resize', () => {
    doLayout();
    drawLoading(kit.progress);
  });
  for (const [name, spec] of Object.entries(cfg.overlays ?? {})) if (spec.boot) overlays.show(name);

  // Platform wiring.
  sound.setPlatformAudio(platform.audioEnabled());
  platform.onAudioChange((on) => sound.setPlatformAudio(on));
  platform.onPause(() => {
    loop.suspend();
    sound.suspend();
    bus.emit('platform:pause');
  });
  platform.onResume(() => {
    loop.unsuspend();
    sound.resume();
    bus.emit('platform:resume');
  });
  input.attach(app.canvas, () => sound.unlock());
  app.canvas.addEventListener('pointerdown', () => sound.unlock());

  game = {
    state, kit, platform, app, loop, tweens, clips, fx, sound, save, i18n, t: i18n.t, ads, input, bus, services, loader, screens, popups, overlays, backend, context, skin, playfield, backdrop,
    async show(name) {
      const lazy = pendingLazy.get(name);
      if (lazy) {
        pendingLazy.delete(name);
        screens.add(name, { screen: mountScreen(name, lazy), bundle: lazy.bundle, onShow: lazy.onShow, onHide: lazy.onHide });
      }
      await screens.show(name);
    },
    popup(name) {
      popups.show(name);
      bus.emit('popup:show', { name });
    },
    async close(name) {
      const n = name ?? popups.top();
      if (!n) return;
      await popups.hide(n);
      bus.emit('popup:hide', { name: n });
      if (n === 'pause' && kit.paused) game.resume();
    },
    closeNow(name) {
      if (!popups.isOpen(name)) return;
      popups.closeNow(name);
      bus.emit('popup:hide', { name });
      if (name === 'pause' && kit.paused) game.resume();
    },
    hideOverlay: (name, opts) => overlays.hide(name, opts),
    screen: (name) => screens.get(name),
    controller<T>(name: string): T {
      if (!controllers.has(name)) throw new Error(`game.controller: "${name}" has no controller (known: ${[...controllers.keys()].join(', ') || 'none'})`);
      return controllers.get(name) as T;
    },
    pause() {
      if (kit.paused) return;
      kit.paused = true;
      loop.pause();
      bus.emit('game:pause');
      if (cfg.popups?.pause && !popups.isOpen('pause')) game.popup('pause');
    },
    resume() {
      if (!kit.paused) return;
      kit.paused = false;
      loop.resume();
      bus.emit('game:resume');
      if (popups.isOpen('pause')) void game.close('pause');
    },
    setVolume(kind, v) {
      const val = Math.max(0, Math.min(1, v));
      kit[kind] = val;
      sound.setVolumes(kit.sfx, kit.music);
      void save.set({ [kind]: val } as Partial<D & { sfx: number; music: number }>);
    },
    layout: doLayout,
    setHud(h) {
      hud = { ...h };
      doLayout();
    },
    probe(extra) {
      Object.assign(probeExtras, extra);
      probeMerge?.(extra);
    },
  };

  const actions = typeof cfg.actions === 'function' ? cfg.actions(game) : (cfg.actions ?? {});
  for (const k of Object.keys(actions)) if (k in context) throw new Error(`createGame: action "${k}" clashes with a built-in of the scene context`);
  Object.assign(context, actions);

  await Promise.all(all.map((s) => s.scene.ready));
  setProgress(100);
  await game.show(cfg.start);
  booted = true;
  doLayout();
  loadingView.destroy({ children: true });
  if (cfg.ready) await cfg.ready(game);
  platform.gameReady();

  if (typeof __TREMPEL_TARGET__ === 'undefined' || __TREMPEL_TARGET__ !== 'youtube') {
    const { installProbe } = await import('./qa/probe.js');
    probeMerge = installProbe(game as unknown as Game<object, object>, cfg.cheats ?? {}, probeExtras);
    if (new URLSearchParams(location.search).get('services') === '1') {
      const { installServicesPanel } = await import('./services/panel.js');
      installServicesPanel(services);
    }
  }
  // The game's update starts last: by its first call `const game = await createGame(…)` is assigned.
  if (cfg.update) loop.add(cfg.update, 'game');
  return game;
}

function makeBackend(b: GameConfig<object, object>['backend'], opts: KitBackendOptions): PixiBackend {
  if (!b) return new KitBackend(opts);
  if (b instanceof PixiBackend) return b;
  const made = (b as { prototype?: unknown }).prototype instanceof PixiBackend ? new (b as new (o: KitBackendOptions) => PixiBackend)(opts) : (b as (o: KitBackendOptions) => PixiBackend)(opts);
  if (!(made instanceof PixiBackend)) throw new Error('createGame: backend must be a PixiBackend (subclass KitBackend for the skin and the kit attributes)');
  return made;
}
