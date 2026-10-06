// scenes.ts — the game's scenes: the context every scene gets, the component registry, screens,
// popups and overlays mounted as Trempel scenes (prefabs through the plugin's scene table), their
// controllers as owners of the services (inject / listen — unmounted on destroy), lazy screens.
//
// The context: { state, kit, services, t, show, popup, close, pause, resume, toggleSfx,
// toggleMusic, setSfx, setMusic, ...actions }. 2.0: the actions are in it BEFORE the scenes mount
// (the function form gets the game lazily), and a prefab instance's context inherits it — a
// prefab's `tml:on-click="tap(self.action)"` calls the game's `tap`.
//
// Input (2.0): while a popup is open (not while it closes) the screens under it take no input and
// neither does game.input; the popups under the top one take none either (ui/popups.ts).

import type { Application, Container } from 'pixi.js';
import { Registry, type PixiBackend } from '@trempel/scene';
import type { Tweens } from '../anim/tweens.js';
import type { Sound } from '../audio/sound.js';
import type { I18n } from '../data/i18n.js';
import type { Input } from '../input/input.js';
import type { Mounted, Services } from '../services/services.js';
import { buttonFx } from '../ui/buttons.js';
import { uiComponents } from '../ui/components/index.js';
import { Overlays } from '../ui/overlays.js';
import { Popups } from '../ui/popups.js';
import { sceneTable } from '../ui/scene-table.js';
import { Screen, type ScreenHooks } from '../ui/screen.js';
import { Screens } from '../ui/screens.js';
import type { Skin } from '../ui/skin/skin.js';
import type { GameLayout } from './layout.js';
import type { Actions, GameConfig, KitServices, KitState, OverlaySpec, PopupSpec, ScreenSpec } from './types.js';

export interface SceneHost {
  readonly context: Record<string, unknown>;
  readonly screens: Screens;
  readonly popups: Popups;
  readonly overlays: Overlays;
  /** The controller of a screen / popup ('popup:<name>') / overlay ('overlay:<name>'). */
  controller<T>(name: string): T;
  /** Mount a lazy screen on its first show. */
  mountLazy(name: string): void;
  /** Every scene's first textures. */
  ready(): Promise<void>;
  /** Re-apply who takes the input after the popups changed (the screens and game.input wait under an open popup). */
  gate(): void;
  /** Unmount every controller and component (their subscriptions), destroy every scene. */
  destroy(): void;
}

export interface SceneDeps {
  cfg: GameConfig<object, object>;
  app: Application;
  backend: PixiBackend;
  services: Services;
  kit: KitState;
  state: object;
  t: I18n['t'];
  tweens: Tweens;
  sound: Sound;
  input: Input;
  skin: Skin | null;
  resolve: (href: string) => string;
  loadBundle: (name: string) => Promise<void>;
  layout: GameLayout;
  kitServices: () => KitServices;
  /** The scene built-ins (show, popup, close…) — they call the game. */
  builtins: Record<string, (...a: never[]) => unknown>;
  /** The game's actions (cfg.actions resolved against the game). */
  actions: () => Actions;
}

export function createScenes(d: SceneDeps): SceneHost {
  const { cfg, services, tweens, sound, layout } = d;
  const owned: Mounted<unknown>[] = [];
  const own = <T>(name: string, make: () => T): T => {
    const m = services.mount(name, make);
    owned.push(m);
    return m.value;
  };

  const context: Record<string, unknown> = { state: d.state, kit: d.kit, services: services.scene, t: d.t };
  Object.assign(context, d.builtins);
  // 2.0: the actions are there before the first binding runs.
  const actions = d.actions();
  for (const k of Object.keys(actions)) if (k in context) throw new Error(`createGame: action "${k}" clashes with a built-in of the scene context`);
  Object.assign(context, actions);

  const registry = new Registry();
  if (d.skin) for (const [name, f] of Object.entries(uiComponents({ skin: d.skin, tweens, context }))) registry.register(name, f);
  const comps = typeof cfg.components === 'function' ? cfg.components(d.kitServices()) : (cfg.components ?? {});
  // The game's components are owners: inject() / listen() in them resolve at mount (awake).
  for (const [name, f] of Object.entries(comps)) registry.register(name, (ctx) => own(`component ${name}${ctx.attrs.id ? '#' + ctx.attrs.id : ''}`, () => f(ctx)));

  const popups = new Popups(tweens);
  const screens = new Screens(tweens, d.loadBundle);
  const overlays = new Overlays(tweens);
  const hooks: ScreenHooks = {
    press: (node) => buttonFx(node, tweens),
    sound: (node, name) => {
      node.eventMode = 'static';
      node.on('pointertap', () => sound.play(name));
    },
  };
  const deps = { backend: d.backend, context, registry, resolveHref: d.resolve, collections: cfg.collections, hooks, table: sceneTable() };

  const all: Screen[] = [];
  const controllers = new Map<string, unknown>();
  const mountScreen = (name: string, spec: ScreenSpec | PopupSpec | OverlaySpec): Screen => {
    const s = new Screen(name, spec, spec.mode ?? layout.policy, deps);
    all.push(s);
    if (name === cfg.start) layout.design(s.refW, s.refH);
    layout.add(s);
    if (spec.controller) controllers.set(name, own(`screen "${name}"`, spec.controller));
    return s;
  };

  const startSpec = cfg.screens[cfg.start];
  if (!startSpec) throw new Error(`createGame: start screen "${cfg.start}" is not in screens (${Object.keys(cfg.screens).join(', ')})`);
  const pendingLazy = new Map<string, ScreenSpec>();
  // The start screen first: its reference size is the design resolution of the layout.
  const order = [cfg.start, ...Object.keys(cfg.screens).filter((n) => n !== cfg.start)];
  for (const name of order) {
    const spec = cfg.screens[name];
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

  popups.onShowSound = () => {};

  return {
    context,
    screens,
    popups,
    overlays,
    controller<T>(name: string): T {
      if (!controllers.has(name)) throw new Error(`game.controller: "${name}" has no controller (known: ${[...controllers.keys()].join(', ') || 'none'})`);
      return controllers.get(name) as T;
    },
    mountLazy(name) {
      const lazy = pendingLazy.get(name);
      if (!lazy) return;
      pendingLazy.delete(name);
      screens.add(name, { screen: mountScreen(name, lazy), bundle: lazy.bundle, onShow: lazy.onShow, onHide: lazy.onHide });
    },
    ready: () => Promise.all(all.map((s) => s.scene.ready)).then(() => undefined),
    gate() {
      // A popup takes the input while it is open (not while it closes): the screens and game.input wait.
      const open = popups.isOpen();
      screens.blocked = open;
      d.input.enabled = !open;
    },
    destroy() {
      for (const m of owned.splice(0)) m.unmount();
      controllers.clear();
      for (const s of all.splice(0)) if (!s.root.destroyed) (s.root as Container).destroy({ children: true });
    },
  };
}
