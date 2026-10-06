// layout.ts — the column, the safe area, the HUD zones and the playfield: every screen, popup and
// overlay is laid out on the window's column; the playfield is the screen minus the HUD the game
// declares and the safe area. `layout` goes on the bus after every layout once the game is booted.

import type { Application } from 'pixi.js';
import type { EventBus } from '../flow/bus.js';
import type { Backdrop } from '../ui/backdrop.js';
import { NO_INSETS, canvas, canvasRect, column, playfield as playfieldRect, safeRect, type CanvasMode, type Insets, type Rect } from '../ui/layout.js';
import { readSafeArea } from '../ui/safe-area.js';
import type { Screen } from '../ui/screen.js';
import type { Screens } from '../ui/screens.js';
import type { GameConfig, HudZones, KitEvents, Playfield } from './types.js';

export interface GameLayout {
  readonly playfield: Playfield;
  /** The fit policy of scenes without their own `mode`. */
  readonly policy: CanvasMode;
  /** A mounted screen / popup / overlay to lay out with the others. */
  add(s: Screen): void;
  /** The design resolution (default: the start screen's reference size) — known once it is mounted. */
  design(w: number, h: number): void;
  run(): void;
  setHud(h: HudZones): void;
  /** From now on every layout goes on the bus (after the boot). */
  booted(): void;
}

export function createLayout(cfg: GameConfig<object, object>, app: Application, screensOf: () => Screens | null, backdrop: Backdrop, bus: EventBus<KitEvents>): GameLayout {
  const all: Screen[] = [];
  let designW = cfg.layout?.design?.width ?? 0;
  let designH = cfg.layout?.design?.height ?? 0;
  let maxAspect: number | undefined;
  const fixDesign = (w: number, h: number) => {
    designW = w;
    designH = h;
    maxAspect = cfg.layout?.maxAspect ?? (designW < designH ? 0.75 : undefined);
  };
  if (cfg.layout?.design) fixDesign(cfg.layout.design.width, cfg.layout.design.height);
  const policy: CanvasMode = cfg.layout?.policy ?? 'expand';
  let hud: HudZones = { ...(cfg.layout?.hud ?? {}) };
  const safeCfg = cfg.layout?.safeArea ?? true;
  const readSafe = (): Insets => (safeCfg === true ? readSafeArea() : safeCfg === false ? { ...NO_INSETS } : { ...NO_INSETS, ...safeCfg });
  let pfPx: Rect = { x: 0, y: 0, w: 0, h: 0 };
  let pfSafe: Insets = { ...NO_INSETS };
  let isBooted = false;
  const playfield: Playfield = {
    get px() {
      return pfPx;
    },
    get safe() {
      return pfSafe;
    },
    in: (screen) => (typeof screen === 'string' ? screensOf()!.get(screen) : screen).toRef(pfPx),
  };
  const run = () => {
    const W = app.screen.width;
    const H = app.screen.height;
    const col = column(W, H, maxAspect);
    pfSafe = readSafe();
    const safe = safeRect(W, H, pfSafe);
    for (const s of all) s.layout(col, safe);
    const screens = screensOf();
    const on = screens && hud.screen && screens.names().includes(hud.screen) ? screens.get(hud.screen) : null;
    if (on) pfPx = playfieldRect(on.rect, safe, hud, on.scale);
    else if (designW > 0 && designH > 0) {
      const fit = canvas(policy, col.w, col.h, designW, designH);
      pfPx = playfieldRect(canvasRect(col, fit), safe, hud, fit.scale);
    }
    backdrop.layout(W, H);
    if (isBooted) bus.emit('layout', { width: W, height: H, playfield });
  };
  return {
    playfield,
    policy,
    add(s) {
      all.push(s);
      run();
    },
    design(w, h) {
      if (!cfg.layout?.design) fixDesign(w, h);
    },
    run,
    setHud(h) {
      hud = { ...h };
      run();
    },
    booted() {
      isBooted = true;
    },
  };
}
