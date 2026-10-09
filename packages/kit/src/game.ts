// game.ts — createGame(): the one entry point of the kit for the typical case. Boots platform →
// Pixi → loading → initial bundle → save → screens/popups (Trempel scenes) → first screen →
// gameReady, and wires everything an agent should not write by hand: the loop and pause, layout
// and resize, sound unlock and settings, input, save, i18n, ads, QA probe.
//
// Contract with scenes: every scene mounts with the context
//   { state, kit, services, t, show, popup, close, pause, resume, toggleSfx, toggleMusic, ...actions }
// so `tml:on-click="popup('settings')"`, `tml:bind="t('score', {n: state.score})"` and
// `tml:bind-text="services.wallet.balance"` work — inside prefabs too (2.0).
//
// 2.0: createGame is an assembly of modules (./game/): types, save (the kit's and the game's spaces
// of one save file), layout (column, safe area, HUD, playfield), scenes (context, registry, screens,
// popups, overlays, controllers; prefabs from the kit's Vite plugin). Here: the boot order, the
// platform (pause, audio, ads), the game object and game.destroy().
//
// Services (1.3): every external thing is a contract with a mandatory mock (./services). The
// platform adapter of the build target implements lifecycle / save / audio / language / ads;
// game.platform, game.save and game.ads are facades over those contracts.

// Pixi's eval-free shader/uniform/particle sync (its default generates code with new Function,
// which a CSP without unsafe-eval — YouTube Playables — blocks). Trempel needs no eval either.
import 'pixi.js/unsafe-eval';
import { Application, Container, Graphics, Text, type Renderer } from 'pixi.js';
import { PixiBackend, reactive } from '@trempel/scene';
import { Clips } from './anim/clips.js';
import { Tweens } from './anim/tweens.js';
import { Loader, withCollections } from './assets/loader.js';
import { Sound } from './audio/sound.js';
import { Ads } from './data/ads.js';
import { I18n } from './data/i18n.js';
import { withKitStrings } from './data/kit-strings.js';
import { EventBus } from './flow/bus.js';
import { Fx } from './fx/fx.js';
import { playFxMarker } from './fx/node.js';
import { Input } from './input/input.js';
import { createPlatform } from './platform/index.js';
import { GameLoop } from './time/loop.js';
import { Backdrop } from './ui/backdrop.js';
import { KitBackend, type KitBackendOptions } from './ui/kit-backend.js';
import { Transitions } from './ui/transitions.js';
import { platformFacade, platformProviders } from './services/platform.js';
import { adoptServices, parseModeQuery, releaseServices } from './services/services.js';
import { AdsService, KIT_CONTRACTS } from './services/standard.js';
import { DEFAULT_SKIN } from './ui/skin/default.js';
import { Skin } from './ui/skin/skin.js';
import { createLayout } from './game/layout.js';
import { loadSaves } from './game/save.js';
import { createScenes, type SceneHost } from './game/scenes.js';
import type { Game, GameConfig, KitEvents, KitState } from './game/types.js';

export type {
  Controller, ScreenSpec, OverlaySpec, PopupSpec, KitState, Actions, GameConfig, HudZones, Playfield, LayoutEvent, KitServices, KitEvents, Game,
} from './game/types.js';

declare const __TREMPEL_TARGET__: string | undefined;

const webBuild = (): boolean => typeof __TREMPEL_TARGET__ === 'undefined' || __TREMPEL_TARGET__ !== 'youtube';

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

/** The loading bar of the first frames (before the start screen). */
function loadingBar(app: Application, fontFamily: string | undefined): { draw(p: number): void; destroy(): void } {
  const view = new Container();
  const bar = new Graphics();
  const label = new Text({ text: '', style: { fill: 0xffffff, fontSize: 18, fontFamily: fontFamily ?? 'sans-serif' } });
  label.anchor.set(0.5);
  view.addChild(bar, label);
  app.stage.addChild(view);
  return {
    draw(p) {
      if (view.destroyed) return;
      const W = app.screen.width;
      const H = app.screen.height;
      const w = Math.min(320, W * 0.6);
      bar.clear().roundRect((W - w) / 2, H / 2 - 6, w, 12, 6).fill({ color: 0xffffff, alpha: 0.15 }).roundRect((W - w) / 2, H / 2 - 6, (w * p) / 100, 12, 6).fill(0xffffff);
      label.text = `${Math.round(p)}%`;
      label.position.set(W / 2, H / 2 + 30);
    },
    destroy: () => {
      if (!view.destroyed) view.destroy({ children: true });
    },
  };
}

export async function createGame<S extends object, D extends object = Record<string, never>>(cfg: GameConfig<S, D>): Promise<Game<S, D>> {
  const disposers: (() => void)[] = [];
  let destroyed = false;

  // ---- services and the platform -------------------------------------------------------------
  // The kit's contracts + the game's; the build target's platform adapter implements the platform
  // ones (unless provided before createGame), then the game's overrides.
  const bus = new EventBus<KitEvents>();
  const services = adoptServices();
  services.bus = bus as never;
  services.register(...KIT_CONTRACTS, ...(cfg.services ?? []));
  const source = cfg.platform ?? createPlatform({ saveKey: cfg.saveKey });
  for (const [c, impl] of platformProviders(source)) if (services.implName(c) === 'mock') services.provide(c, impl);
  for (const [c, impl, label] of cfg.provide ?? []) services.provide(c, impl, label);
  if (webBuild()) {
    for (const [name, modes] of Object.entries(parseModeQuery(location.search))) {
      try {
        services.mock(name, modes);
      } catch (e) {
        console.warn(`kit: ?svc.${name}: ${(e as Error).message}`);
      }
    }
  }
  const platform = platformFacade(services, source);
  disposers.push(() => source.dispose?.(), () => bus.clear(), () => releaseServices(services));
  await platform.init();

  // ---- Pixi and the first frame ----------------------------------------------------------------
  const parent = parentOf(cfg.parent);
  const app = new Application();
  if (!cfg.screens[cfg.start]) throw new Error(`createGame: start screen "${cfg.start}" is not in screens (${Object.keys(cfg.screens).join(', ')})`);
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
  disposers.push(loop.attach(app.ticker));

  const loading = loadingBar(app, cfg.fontFamily);
  loading.draw(0);
  app.render();
  platform.firstFrameReady();

  const kit = reactive<KitState>({ progress: 0, sfx: 1, music: 1, paused: false, screen: '', popup: '', lang: 'en', ads: false });
  const setProgress = (p: number) => {
    kit.progress = p;
    loading.draw(p);
  };

  // ---- assets: the skin, the resolver, the initial bundle --------------------------------------
  // The skin: the game's, else the kit's procedural one (in the game's font).
  const skin: Skin | null =
    cfg.skin !== undefined
      ? cfg.skin
      : new Skin({ json: cfg.fontFamily ? { ...DEFAULT_SKIN, fonts: { heading: { ...DEFAULT_SKIN.fonts.heading, family: cfg.fontFamily }, text: { family: cfg.fontFamily } } } : DEFAULT_SKIN });
  const gameResolve = withCollections(cfg.assets?.resolve ?? ((h: string) => h), cfg.collections);
  const resolve = skin ? (h: string) => skin.resolve(h) ?? gameResolve(h) : gameResolve;
  const loader = new Loader(cfg.assets?.bundles ?? {}, resolve);
  const fonts = (cfg.assets?.fonts ?? []).map((f) => ({ src: resolve(f.src), data: { family: f.family } }));
  await loader.loadList([...fonts, ...(skin?.urls() ?? []), ...(cfg.assets?.initial ?? [])], (p) => setProgress(p * 60));

  // ---- language, sound, save (the kit's space and the game's) -----------------------------------
  const i18n = new I18n(withKitStrings(cfg.i18n), platform.language());
  kit.lang = i18n.lang;
  const sound = new Sound({ sounds: cfg.sounds, music: cfg.music, resolve, quietClicks: cfg.quietClicks });
  disposers.push(() => sound.destroy());
  const saves = await loadSaves<D>(platform, cfg.save);
  services.store = saves.store;
  // Awake of the services: every implementation is built (the wallet reads its balance) before the scenes bind.
  services.start();
  kit.sfx = saves.kit.data.sfx;
  kit.music = saves.kit.data.music;
  sound.setVolumes(kit.sfx, kit.music);
  setProgress(70);

  // ---- the runtime pieces ------------------------------------------------------------------------
  const state = reactive(cfg.state);
  const fx = new Fx(app.renderer as Renderer, resolve);
  if (cfg.fx) fx.tables(cfg.fx);
  loop.add((dt) => fx.update(dt), 'ui');
  disposers.push(() => fx.clear());
  const backend = makeBackend(cfg.backend, { fontFamily: cfg.fontFamily, skin, slices: cfg.slices });
  const clips = new Clips(backend, loop);
  // 2.2: a clip's `fx:<name>@<node>` marker plays the effect at that node of the clip's scene
  clips.onMarker = (name, scene) => void playFxMarker(fx, name, scene);
  const input = new Input();
  disposers.push(() => input.detach());
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
  disposers.push(services.listen(AdsService.events.changed, (on) => (kit.ads = on)));
  const backdrop = new Backdrop(app.renderer as Renderer, typeof cfg.layout?.backdrop === 'object' ? cfg.layout.backdrop : {});

  // ---- the scenes (the game object exists from here: actions get it lazily) -----------------------
  let game!: Game<S, D>;
  const probeExtras: Record<string, unknown> = { ...(cfg.probe ?? {}) };
  let probeMerge: ((x: Record<string, unknown>) => void) | null = null;
  let host: SceneHost | null = null;
  // The actions are made before the scenes mount (2.0) — they get the game as a lazy reference.
  const lazyGame = new Proxy({} as Game<S, D>, {
    get: (_t, key) => {
      if (!game) throw new Error(`createGame: game.${String(key)} while the actions are being made — use the game inside the actions, it is ready when they run`);
      const v = Reflect.get(game, key) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(game) : v;
    },
    set: (_t, key, v) => Reflect.set(game, key, v),
    has: (_t, key) => !!game && Reflect.has(game, key),
  });
  const layout = createLayout(cfg as unknown as GameConfig<object, object>, app, () => host?.screens ?? null, backdrop, bus);
  host = createScenes({
    cfg: cfg as unknown as GameConfig<object, object>,
    app,
    backend,
    services,
    kit,
    state,
    t: i18n.t,
    tweens,
    sound,
    input,
    skin,
    resolve,
    loadBundle: (b) => loader.load(b),
    layout,
    kitServices: () => ({ loop, tweens, fx, sound, app, resolve, services }),
    builtins: {
      show: (name: string) => void game.show(name),
      popup: (name: string) => game.popup(name),
      close: (name?: string) => void game.close(name),
      pause: () => game.pause(),
      resume: () => game.resume(),
      toggleSfx: () => game.setVolume('sfx', kit.sfx > 0 ? 0 : 1),
      toggleMusic: () => game.setVolume('music', kit.music > 0 ? 0 : 1),
      setSfx: (v: number) => game.setVolume('sfx', v),
      setMusic: (v: number) => game.setVolume('music', v),
    },
    actions: () => (typeof cfg.actions === 'function' ? cfg.actions(lazyGame) : (cfg.actions ?? {})),
  });
  const { screens, popups, overlays, context } = host;
  disposers.push(() => host!.destroy());

  overlays.onChange = (name, open) => bus.emit(open ? 'overlay:show' : 'overlay:hide', { name });
  popups.onChange = () => {
    kit.popup = popups.top() ?? '';
    sound.popupMark();
    host!.gate();
  };
  screens.onChange = (name) => {
    kit.screen = name;
    bus.emit('screen:show', { name });
  };
  // 2.1: transitions by snapshots — a layer over the screens, under the popups.
  const transitions = new Transitions({
    renderer: app.renderer as Renderer,
    onFrame: (fn) => loop.add(fn, 'ui'),
    live: screens.layer,
    busy: (on) => host!.setBusy(on),
    canvas: app.canvas,
  });
  if (webBuild() && new URLSearchParams(location.search).get('transition') === 'fade') transitions.fallback = true;
  screens.transitions = transitions;
  disposers.push(() => transitions.destroy());
  app.stage.addChildAt(screens.layer, 0);
  app.stage.addChildAt(transitions.layer, 1);
  app.stage.addChildAt(popups.layers.over, 2);
  app.stage.addChildAt(popups.layers.default, 3);
  app.stage.addChildAt(backdrop.view, 0);
  app.stage.addChild(overlays.layer);
  app.renderer.on('resize', () => {
    if (destroyed) return;
    layout.run();
    loading.draw(kit.progress);
  });
  for (const [name, spec] of Object.entries(cfg.overlays ?? {})) if (spec.boot) overlays.show(name);

  // ---- the platform: audio, pause, input ---------------------------------------------------------
  sound.setPlatformAudio(platform.audioEnabled());
  platform.onAudioChange((on) => sound.setPlatformAudio(on));
  platform.onPause(() => {
    if (destroyed) return;
    loop.suspend();
    sound.suspend();
    bus.emit('platform:pause');
  });
  platform.onResume(() => {
    if (destroyed) return;
    loop.unsuspend();
    sound.resume();
    bus.emit('platform:resume');
  });
  input.attach(app.canvas, () => sound.unlock());
  const unlock = () => sound.unlock();
  app.canvas.addEventListener('pointerdown', unlock);
  disposers.push(() => app.canvas.removeEventListener('pointerdown', unlock));

  // ---- the game ----------------------------------------------------------------------------------
  /** A pause asked for again while the pause popup was closing (TRM-8b): it stays paused. */
  const pauseAgain = () => popups.isOpen('pause') || popups.queued('pause');
  game = {
    state, kit, platform, app, loop, tweens, clips, fx, sound, save: saves.game, i18n, t: i18n.t, ads, input, bus, services, loader, screens, popups, overlays, transitions, backend, context, skin, playfield: layout.playfield, backdrop,
    async show(name, opts) {
      host!.mountLazy(name);
      await screens.show(name, opts ?? {});
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
      if (n === 'pause' && kit.paused && !pauseAgain()) game.resume();
    },
    closeNow(name) {
      if (!popups.isOpen(name)) return;
      popups.closeNow(name);
      bus.emit('popup:hide', { name });
      if (name === 'pause' && kit.paused && !pauseAgain()) game.resume();
    },
    hideOverlay: (name, opts) => overlays.hide(name, opts),
    screen: (name) => screens.get(name),
    controller: (name) => host!.controller(name),
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
      void saves.kit.set({ [kind]: val });
    },
    layout: () => layout.run(),
    setHud: (h) => layout.setHud(h),
    probe(extra) {
      Object.assign(probeExtras, extra);
      probeMerge?.(extra);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const d of disposers.splice(0).reverse()) {
        try {
          d();
        } catch (e) {
          console.warn(`kit: game.destroy(): ${(e as Error).message}`);
        }
      }
      app.canvas.parentNode?.removeChild(app.canvas);
      app.destroy(true, { children: true });
    },
  };

  // ---- boot: the start screen, ready, gameReady ------------------------------------------------
  await host.ready();
  setProgress(100);
  await game.show(cfg.start);
  layout.booted();
  layout.run();
  loading.destroy();
  if (cfg.ready) await cfg.ready(game);
  platform.gameReady();
  // 2.1: the browser's audio start (~150 ms the first time) now, under the start screen — not in the first tap.
  setTimeout(() => !destroyed && sound.warm(), 0);

  if (webBuild()) {
    const { installProbe } = await import('./qa/probe.js');
    probeMerge = installProbe(game as unknown as Game<object, object>, cfg.cheats ?? {}, probeExtras);
    disposers.push(() => {
      const w = window as unknown as Record<string, unknown>;
      delete w.__trempel;
    });
    if (new URLSearchParams(location.search).get('services') === '1') {
      const { installServicesPanel } = await import('./services/panel.js');
      disposers.push(installServicesPanel(services));
    }
  }
  // The game's update starts last: by its first call `const game = await createGame(…)` is assigned.
  if (cfg.update) disposers.push(loop.add(cfg.update, 'game'));
  return game;
}

function makeBackend(b: GameConfig<object, object>['backend'], opts: KitBackendOptions): PixiBackend {
  if (!b) return new KitBackend(opts);
  if (b instanceof PixiBackend) return b;
  const made = (b as { prototype?: unknown }).prototype instanceof PixiBackend ? new (b as new (o: KitBackendOptions) => PixiBackend)(opts) : (b as (o: KitBackendOptions) => PixiBackend)(opts);
  if (!(made instanceof PixiBackend)) throw new Error('createGame: backend must be a PixiBackend (subclass KitBackend for the skin and the kit attributes)');
  return made;
}
