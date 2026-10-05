// probe.ts — web-build-only QA hooks. Loaded by createGame through a
// dynamic import that the youtube build folds away (the build gate checks `__trempel` is absent).
//
//   window.__trempel       — read-only probe for e2e: state, kit, save, services, current screen/popup,
//                            node centre in screen px, fire(input), step/advance time.
//   window.__trempel.cheats — only with ?cheat=1: the game's cheats (createGame({ cheats })).
//   game.probe({ name: fn }) — the game's own read-only probes (genre: level → screen, zoom…),
//                            merged in; a name the kit already has fails loud.

import type { Container } from 'pixi.js';
import type { Game } from '../game.js';

export type ProbeExtras = Record<string, unknown>;

export function installProbe(game: Game<object, object>, cheats: Record<string, (...a: unknown[]) => unknown>, extras: ProbeExtras): (more: ProbeExtras) => void {
  const w = window as unknown as Record<string, unknown>;
  const probe: Record<string, unknown> = {
    ready: true,
    state: () => JSON.parse(JSON.stringify(game.state)),
    kit: () => JSON.parse(JSON.stringify(game.kit)),
    save: () => JSON.parse(JSON.stringify(game.save.data)),
    screen: () => game.screens.current,
    popup: () => game.popups.top(),
    sounds: () => [...game.sound.log],
    /** Centre of a node of a screen or popup (screen px) + visibility. */
    node: (screenOrPopup: string, id: string) => {
      const scr = game.screens.names().includes(screenOrPopup) ? game.screens.get(screenOrPopup) : game.popups.def(screenOrPopup).screen;
      const n = scr.scene.byId.get(id) as Container | undefined;
      if (!n) return null;
      const b = n.getBounds();
      let visible = true;
      for (let c: Container | null = n; c; c = c.parent) if (!c.visible) visible = false;
      return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height, visible };
    },
    fire: (a: string) => game.input.fire(a as never),
    fx: () => game.fx.size,
    time: () => game.loop.time,
    paused: () => game.loop.paused,
    overlay: (name: string) => game.overlays.isOpen(name),
    /** Playfield (screen px), the safe-area insets (px) and the window. */
    layout: () => ({ playfield: { ...game.playfield.px }, safe: { ...game.playfield.safe }, width: game.app.screen.width, height: game.app.screen.height }),
    /** Re-run the layout now (after changing --trempel-safe-* in a test). */
    relayout: () => game.layout(),
    /** Contracts: implementation, state, mock modes (services). */
    services: () => game.services.info(),
  };
  const kitNames = new Set(Object.keys(probe));
  const merge = (more: ProbeExtras): void => {
    for (const [k, v] of Object.entries(more)) {
      if (kitNames.has(k) || k === 'cheats') throw new Error(`kit probe: "${k}" is the kit's own (kit: ${[...kitNames].join(', ')})`);
      probe[k] = v;
    }
  };
  merge(extras);
  if (new URLSearchParams(location.search).get('cheat') === '1') {
    probe.cheats = cheats;
    console.info(`[kit] cheats: ${Object.keys(cheats).join(', ') || 'none'}`);
  }
  w.__trempel = probe;
  return merge;
}
