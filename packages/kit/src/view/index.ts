// view/ — 2.2: `@trempel/kit/view`, the kit's half of a game's `trempel.view.ts`: the viewer, the
// editor and view:shot draw the scenes with the kit's components — the UI components with a skin
// and the effect nodes (`tml:type="fx"`), and effects fired by clip markers (`fx:<name>@<node>`)
// at the clip time shown.
//
//   // scenes/trempel.view.ts
//   import { kitView } from '@trempel/kit/view';
//   import effects from '../fx/effects.json';
//   export default kitView({ effects, textures: (n) => `../fx/textures/${n}.png` });
//
// Time: effect nodes step on the page's frames (fixed 1/60 s steps, seeded particles — in view:shot
// the frames are virtual, so the picture after `--settle` is the same every run); with a clip posed
// (`--clip --t`, the editor's clip panel) the effects its markers fired are replayed to that time.

import { Registry } from '@trempel/scene';
import type { ComponentFactory } from '@trempel/scene';
import type { ViewConfig } from '@trempel/scene/view';
import { Tweens } from '../anim/tweens.js';
import { Fx, type FxTables } from '../fx/fx.js';
import { fxInspector } from '../fx/inspector.js';
import { FxClipTime, fxComponents } from '../fx/node.js';
import { adopt } from '../ui/components/base.js';
import { uiComponents } from '../ui/components/index.js';
import { KitBackend } from '../ui/kit-backend.js';
import { defaultSkin, type Skin } from '../ui/skin/skin.js';

export interface KitViewOptions extends Omit<ViewConfig, 'registry' | 'onClipTime'> {
  /** Effects by name (trempel-fx-import's effects.json fits as is) — besides the kit's presets. */
  effects?: FxTables['effects'];
  /** Texture name → URL (or a function) of the effects. */
  textures?: FxTables['textures'];
  /** The skin of the UI components (default — the kit's procedural one); false — no UI components. */
  skin?: Skin | false;
  /** The game's own components (over the kit's). */
  components?: Record<string, ComponentFactory>;
  /** The scene context the UI components call (slider actions). */
  componentContext?: Record<string, unknown>;
  /** A backend with the skin's attributes (default: the kit's when a skin is on). */
  backend?: ViewConfig['backend'];
  /**
   * 2.3: where the effects live, for the editor's particle inspector: a file path relative to the
   * scene folder → the JSON the game imports from it (a converter's systems.json — `import systems
   * from './fx/particles/systems.json'`). An effect whose configs are elements of such an array is
   * saved back into it; the project's own `fx/<name>.json` are found by the inspector.
   */
  effectSources?: Record<string, unknown>;
  /** 2.3: the editor's inspectors (over the kit's `fx` particle editor). */
  inspectors?: ViewConfig['inspectors'];
}

type Tick = (dt: number) => void;

/**
 * The page's time for every subscriber, in whole ticks of 1/60 s of the page clock (performance.now):
 * a subscriber's dt is the ticks passed since its last frame. The page's frames only decide WHEN it
 * is told — so the picture at a moment does not depend on how many frames the page drew (view:shot's
 * virtual clock starts a millisecond or two apart and its frames fall on a 16 ms grid).
 */
function frames(): (fn: Tick) => () => void {
  const TICK = 1000 / 60;
  const tickOf = (ms: number): number => Math.floor(ms / TICK + 1e-6);
  const subs = new Map<Tick, number>();
  let running = false;
  const loop = (now: number): void => {
    const tick = tickOf(now);
    for (const [f, last] of [...subs]) {
      if (!subs.has(f)) continue;
      subs.set(f, tick);
      if (tick > last) f(Math.min(6, tick - last) / 60);
    }
    if (subs.size) requestAnimationFrame(loop);
    else running = false;
  };
  return (fn) => {
    subs.set(fn, tickOf(typeof performance !== 'undefined' ? performance.now() : 0));
    if (!running && typeof requestAnimationFrame === 'function') {
      running = true;
      requestAnimationFrame(loop);
    }
    return () => void subs.delete(fn);
  };
}

/** The kit's view config: UI components and effect nodes in the viewer, the editor, view:shot. */
export function kitView(o: KitViewOptions = {}): ViewConfig {
  const { effects, textures, skin: skinOpt, components, componentContext, backend, onMount, setup, effectSources, inspectors, ...rest } = o;
  const skin = skinOpt === false ? null : (skinOpt ?? defaultSkin());
  const tick = frames();
  const tweens = new Tweens();
  tick((dt) => tweens.update(dt));
  const fx = new Fx(null, (h) => h);
  fx.tables({ effects, textures });
  const clipTime = new FxClipTime(fx);
  return {
    ...rest,
    // the effects' textures are in before the first scene: a lazy load would land mid-settle
    setup: async () => {
      await setup?.();
      await fx.preload();
    },
    backend: backend ?? (skin ? () => new KitBackend({ skin }) : undefined),
    registry: () => {
      const reg = new Registry();
      if (skin) for (const [n, f] of Object.entries(uiComponents({ skin, tweens, context: componentContext ?? {} }))) reg.register(n, f);
      for (const [n, f] of Object.entries(fxComponents({ fx, tick, place: adopt }))) reg.register(n, f);
      for (const [n, f] of Object.entries(components ?? {})) reg.register(n, f);
      return reg;
    },
    onMount: (args) => {
      clipTime.clear();
      onMount?.(args);
    },
    onClipTime: ({ scene, t, markers }) => clipTime.apply(scene, t, markers),
    // 2.3: the particle editor of the scene editor (fx nodes), over the same effects table
    inspectors: { fx: fxInspector({ fx, sources: effectSources }), ...inspectors },
  };
}

export { FxClipTime, FxHost, FxNode, fxComponents, parseFxMarker, playFxMarker, FX_STEP } from '../fx/node.js';
