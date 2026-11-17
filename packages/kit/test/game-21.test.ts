// Kit 2.1 (TRM-10): createGame with what a game did by hand — screens switched
// by a snapshot transition, the popups' sounds, a click silent when it opened / closed a popup, a tap
// right after a popup closes, the effects table. Headless as in game-2.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Container } from 'pixi.js';
import { apps, drive, frames, size, stubDom, type FakeApp } from './helpers/fake-pixi.js';

vi.mock('pixi.js', async (orig) => ({ ...(await orig<typeof import('pixi.js')>()), Application: (await import('./helpers/fake-pixi.js')).FakeApp }));

let dom: ReturnType<typeof stubDom>;
beforeEach(() => {
  apps.length = 0;
  size.w = 720;
  size.h = 1280;
  dom = stubDom();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const { createGame } = await import('../src/game.js');
const { createMockPlatform } = await import('../src/platform/mock.js');
const { particleConfig } = await import('../src/fx/types.js');

const NS = 'xmlns="http://www.w3.org/2000/svg" xmlns:tml="https://trempel.dev/ns/scene"';
const SCREEN = (body: string, w = 720, h = 1280) => `<svg ${NS} viewBox="0 0 ${w} ${h}"><rect id="bg" x="0" y="0" width="${w}" height="${h}" data-stretch="xy"/>${body}</svg>`;
const POPUP = (id: string) =>
  `<svg ${NS} viewBox="0 0 720 1280"><rect id="dim" x="0" y="0" width="720" height="1280" opacity="0.5" data-stretch="xy"/><g id="content" transform="translate(360,640)" data-anchor="0.5 0.5"><rect id="${id}" x="-100" y="-100" width="200" height="200"/></g></svg>`;
const heirOf = (ext: string, body: string) => `<svg ${NS} tml:extends="${ext}">${body}</svg>`;

type Cfg = Parameters<typeof createGame>[0];
async function boot(over: Partial<Cfg> = {}) {
  const game = await createGame({
    state: { n: 0 },
    parent: dom.parent as never,
    platform: createMockPlatform(),
    screens: {
      menu: { base: SCREEN('<rect id="menuBox" x="10" y="10" width="100" height="100"/>') },
      album: { base: SCREEN('<rect id="albumBox" x="10" y="10" width="100" height="100"/>') },
    },
    popups: { pause: { base: POPUP('pauseBox') } },
    start: 'menu',
    layout: { safeArea: false },
    ...over,
  } as Cfg);
  return { game, app: apps[apps.length - 1] as FakeApp };
}
const tap = (n: unknown) => {
  (n as Container).emit('pointerdown', {} as never);
  (n as Container).emit('pointertap', {} as never);
};

describe('createGame 2.1: screens by a snapshot transition', () => {
  it('game.show(name, { transition: { leaf } }): snapshots of both screens over the hidden screens (no WebGL2 here: the cross-fade); input blocked, textures freed', async () => {
    const { game, app } = await boot();
    const stage = game.app.stage.children;
    // Over the screens, under the popups.
    expect(stage.indexOf(game.transitions.layer)).toBe(stage.indexOf(game.screens.layer) + 1);
    expect(stage.indexOf(game.transitions.layer)).toBeLessThan(stage.indexOf(game.popups.layers.over));
    const taps: unknown[] = [];
    game.input.onTap((t) => taps.push(t));
    const before = (app.renderer as unknown as { snapshots: number }).snapshots;
    const p = game.show('album', { transition: { leaf: { look: 'hard', duration: 0.3 } } });
    await frames(app, 2);
    expect(game.transitions.active).toBe(true);
    expect(game.transitions.info.mode).toBe('fade');
    expect(game.screens.layer.visible).toBe(false);
    expect(game.input.enabled).toBe(false);
    expect((app.renderer as unknown as { snapshots: number }).snapshots - before).toBe(2);
    await drive(app, p);
    expect(game.kit.screen).toBe('album');
    expect(game.transitions.info).toMatchObject({ active: false, textures: 0 });
    expect(game.screens.layer.visible).toBe(true);
    expect(game.input.enabled).toBe(true);
    // The default stays the live fade; 'none' is instant.
    await drive(app, game.show('menu', { transition: 'none' }));
    expect(game.kit.screen).toBe('menu');
    game.destroy();
  });

  it('?transition=fade (web build) forces the cross-fade', async () => {
    dom = stubDom('?transition=fade');
    const { game } = await boot();
    expect(game.transitions.fallback).toBe(true);
    game.destroy();
  });
});

describe('createGame 2.1: sounds', () => {
  it('popupSounds: on show and on an animated close; closeNow is silent; table entries with volume / pitch', async () => {
    const { game, app } = await boot({ popupSounds: { show: 'pop', hide: 'whoosh' }, sounds: { ding: { src: { synth: 'coin' }, volume: 0.6, pitch: 1.2 } } });
    game.popup('pause');
    await drive(app, game.close('pause'));
    game.popup('pause');
    game.closeNow('pause');
    expect(game.sound.log).toEqual(['pop', 'whoosh', 'pop']);
    expect(game.sound.level('ding')).toEqual({ volume: 0.6, pitch: 1.2 });
    game.destroy();
  });

  it('data-sound: a click plays after the tap — unless that tap opened / closed a popup', async () => {
    const { game } = await boot({
      screens: {
        menu: {
          base: SCREEN('<rect id="okBtn" x="10" y="10" width="100" height="100" data-sound="click"/><rect id="menuBtn" x="200" y="10" width="100" height="100" data-sound="click"/>'),
          heir: heirOf('menu.svg', '<tml:ref id="menuBtn" tml:on-click="popup(\'pause\')"/>'),
        },
      },
      popupSounds: { show: 'pop' },
    });
    const scr = game.screen('menu');
    tap(scr.byId('okBtn'));
    await Promise.resolve();
    expect(game.sound.log).toEqual(['click']);
    tap(scr.byId('menuBtn'));
    await Promise.resolve();
    expect(game.popups.isOpen('pause')).toBe(true);
    expect(game.sound.log).toEqual(['click', 'pop']); // no click on top of the popup's sound
    game.destroy();
  });

  it('quietClicks: false — the click plays anyway', async () => {
    const { game } = await boot({
      screens: { menu: { base: SCREEN('<rect id="menuBtn" x="200" y="10" width="100" height="100" data-sound="click"/>'), heir: heirOf('menu.svg', '<tml:ref id="menuBtn" tml:on-click="popup(\'pause\')"/>') } },
      quietClicks: false,
    });
    tap(game.screen('menu').byId('menuBtn'));
    await Promise.resolve();
    expect(game.sound.log).toContain('click');
    game.destroy();
  });
});

describe('createGame 2.1: input after a popup closes', () => {
  it('a tap right after the close (the popup still animating out) reaches the game', async () => {
    const { game, app } = await boot();
    const taps: unknown[] = [];
    game.input.onTap((t) => taps.push(t));
    game.popup('pause');
    expect(game.input.enabled).toBe(false);
    const closing = game.close('pause');
    // At once — the hide animation (0.3 s) has not run a single frame.
    const c = app.canvas;
    c.dispatch('pointerdown', { clientX: 50, clientY: 60, pointerId: 1 });
    c.dispatch('pointerup', { clientX: 50, clientY: 60, pointerId: 1 });
    expect(taps).toEqual([{ x: 50, y: 60 }]);
    await drive(app, closing);
    game.destroy();
  });
});

describe('createGame 2.1: the effects table', () => {
  it('createGame({ fx }) — effects by name on game.fx', async () => {
    const spark = particleConfig({ texture: 'circle', bursts: [{ time: 0, count: 3, cycles: 1, interval: 0, prob: 1 }] });
    const { game } = await boot({ fx: { effects: { spark: [spark] } } });
    expect(game.fx.names()).toEqual(['spark']);
    const e = game.fx.play('spark', game.screen('menu').root, 10, 10);
    expect(e.pending).toBe(false);
    expect(e.emitters).toHaveLength(1);
    game.destroy();
  });
});
