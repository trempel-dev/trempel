// Kit 2.0 (TRM-8b): the holes a real game found (a game built on the kit, its first two rounds), each with the
// case from the game. createGame headless as in game.test.ts (a fake Pixi Application, the mock
// platform, scenes through the real PixiBackend).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Assets, Sprite, Texture, TextureSource, type Container } from 'pixi.js';
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
  setSceneTable(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const { createGame } = await import('../src/game.js');
const { createMockPlatform } = await import('../src/platform/mock.js');
const { listen } = await import('../src/services/services.js');
const { Wallet } = await import('../src/services/standard.js');
const { setSceneTable } = await import('../src/ui/scene-table.js');
const { compileClips } = await import('@trempel/scene');

const NS = 'xmlns="http://www.w3.org/2000/svg" xmlns:tml="https://trempel.dev/ns/scene"';
const SCREEN = (body: string, w = 720, h = 1280) => `<svg ${NS} viewBox="0 0 ${w} ${h}"><rect id="bg" x="0" y="0" width="${w}" height="${h}" data-stretch="xy"/>${body}</svg>`;
const POPUP = (id: string) =>
  `<svg ${NS} viewBox="0 0 720 1280"><rect id="dim" x="0" y="0" width="720" height="1280" opacity="0.5" data-stretch="xy"/><g id="content" transform="translate(360,640)" data-anchor="0.5 0.5"><rect id="${id}" x="-100" y="-100" width="200" height="200"/></g></svg>`;
const heirOf = (ext: string, body: string) => `<svg ${NS} tml:extends="${ext}">${body}</svg>`;

type Cfg = Parameters<typeof createGame>[0];
async function boot(over: Partial<Cfg> = {}, platform = createMockPlatform()) {
  const game = await createGame({
    state: { n: 0 },
    parent: dom.parent as never,
    platform,
    screens: { menu: { base: SCREEN('<rect id="menuBox" x="10" y="10" width="100" height="100"/>') } },
    popups: { pause: { base: POPUP('pauseBox') }, info: { base: POPUP('infoBox'), anim: 'none' } },
    start: 'menu',
    layout: { safeArea: false },
    ...over,
  } as Cfg);
  return { game, platform, app: apps[apps.length - 1] as FakeApp };
}
const tap = (n: unknown) => (n as Container).emit('pointertap', {} as never);

// ---- §1.1, §1.2, §1.11: prefabs from the plugin's table, actions inside them, a collection base ----
// The UI kit as a collection @ui (as the plugin collects it); the game's heirs in scenes/.
const BUTTON = `<svg ${NS} viewBox="0 0 200 80" data-action="" data-fade="1"><rect id="hit" width="200" height="80"/><g id="content"/></svg>`;
const DOCS: Record<string, string> = {
  '@ui/level.svg': SCREEN('<use id="okBtn" href="ui/button.svg" x="100" y="900" data-action="go"/><use id="backBtn" href="ui/button.svg" x="400" y="900" data-action="back" data-fade="0.5"/>'),
  '@ui/level.contract.xml': '<contract><rect id="bg"/></contract>',
  '@ui/ui/button.svg': BUTTON,
  // The collection's own heir: declares the slot — stays under the game's heir.
  '@ui/ui/button.tml.svg': heirOf('button.svg', '<tml:ref id="content" tml:slot="content default"/>'),
  // The game: the screen extends the collection's level; the button's project heir clicks through
  // the game's tap() and binds a game function (the kit adds the actions — 2.0 — before the mount).
  'scenes/level.tml.svg': heirOf('@ui/level.svg', '<use id="extraBtn" tml:insert="after backBtn" href="@ui/ui/button.svg" x="100" y="1100" data-action="extra"/>'),
  'scenes/ui/button.tml.svg': heirOf('@ui/ui/button.svg', '<tml:ref id="hit" tml:on-click="tap(self.action, self.id)" tml:bind-alpha="fade(self.fade)"/>'),
};
/** The table as the plugin makes it: by stem, [base, heir, contract]. */
const byStem = (docs: Record<string, string>) => {
  const out: Record<string, [string | undefined, string | undefined, string | undefined]> = {};
  for (const [k, v] of Object.entries(docs)) {
    const m = /^(.*?)(\.tml\.svg|\.contract\.xml|\.svg)$/.exec(k)!;
    const row = (out[m[1]] ??= [undefined, undefined, undefined]);
    row[m[2] === '.svg' ? 0 : m[2] === '.tml.svg' ? 1 : 2] = v;
  }
  return out;
};
const TABLE = {
  scenes: byStem(DOCS),
  heirs: { '@ui/level.svg': 'scenes/level.svg', '@ui/ui/button.svg': 'scenes/ui/button.svg' },
  collections: ['ui'],
};

describe('kit 2.0 — prefabs, actions inside prefabs, a base from a collection (§1.1, §1.2, §1.11)', () => {
  it('a screen whose heir extends @ui/level.svg mounts its <use> instances; the game heir of the button clicks through tap()', async () => {
    setSceneTable(TABLE);
    const taps: unknown[][] = [];
    const { game } = await boot({
      screens: { level: { heir: DOCS['scenes/level.tml.svg'] } },
      start: 'level',
      // The function form: the game is a lazy reference — the actions exist before the scenes mount.
      actions: (g) => ({ tap: (action: string, id: string) => taps.push([action, id, g.kit.screen]), fade: (v: string) => Number(v) }),
    });
    const scr = game.screen('level');
    expect(scr.refW).toBe(720); // the reference size of the collection's base
    for (const id of ['okBtn', 'backBtn', 'extraBtn']) tap(scr.byId(`${id}/hit`));
    expect(taps).toEqual([
      ['go', 'okBtn', 'level'],
      ['back', 'backBtn', 'level'],
      ['extra', 'extraBtn', 'level'],
    ]);
    // A binding calls a game function inside a prefab.
    expect(scr.byId('backBtn/hit').alpha).toBe(0.5);
    expect(scr.byId('okBtn/hit').alpha).toBe(1);
    // The collection heir's slot is there under the game's heir.
    expect(scr.scene.tree).toBeTruthy();
  });

  it('without the table (no plugin) a source mounts as before; an instance without a loader fails loud', async () => {
    await expect(boot({ screens: { level: { base: SCREEN('<use id="b" href="ui/button.svg"/>') } }, start: 'level' })).rejects.toThrow(/E_PREFAB_LOADER/);
  });
});

// ---- §1.3: a popup takes the input while it is open, not while it closes ------------------------
describe('kit 2.0 — a popup blocks the input under it (§1.3)', () => {
  it('open: the screens and game.input wait; closing: the dim takes nothing, the screen and input are back at once', async () => {
    const { game, app } = await boot();
    const layer = game.screens.layer;
    expect(layer.interactiveChildren).toBe(true);
    game.popup('pause');
    expect(layer.interactiveChildren).toBe(false);
    expect(game.input.enabled).toBe(false);
    const root = game.popups.def('pause').screen.root;
    expect(root.interactiveChildren).toBe(true);
    // A popup over a popup: the lower one takes nothing.
    game.popup('info');
    expect(root.interactiveChildren).toBe(false);
    expect(game.popups.def('info').screen.root.interactiveChildren).toBe(true);
    game.closeNow('info');
    expect(root.interactiveChildren).toBe(true);
    // Close with the animation: while it runs the popup is not open any more.
    const closing = game.close('pause');
    expect(game.popups.isOpen('pause')).toBe(false);
    expect(root.eventMode).toBe('none');
    expect(root.interactiveChildren).toBe(false);
    expect(layer.interactiveChildren).toBe(true);
    expect(game.input.enabled).toBe(true);
    await drive(app, closing);
    expect(layer.interactiveChildren).toBe(true);
  });

  it('the click that closes a popup is not a tap of the game (its pointerup gives the input back)', async () => {
    const { game, app } = await boot();
    const taps: unknown[] = [];
    game.input.onTap((t) => taps.push(t));
    const pointer = (type: string) => app.canvas.dispatch(type, { clientX: 100, clientY: 100, pointerId: 1 });
    game.popup('pause');
    pointer('pointerdown');
    void game.close('pause'); // the popup's button, on that pointerup
    pointer('pointerup');
    expect(taps).toEqual([]);
    // A gesture that starts with the input back is a tap.
    pointer('pointerdown');
    pointer('pointerup');
    expect(taps).toHaveLength(1);
  });
});

// ---- §1.4: the pause race ----------------------------------------------------------------------------
describe('kit 2.0 — the pause race (§1.4)', () => {
  it('Esc right after Resume (the pause popup still closing): the game stays paused with the pause popup', async () => {
    const { game, app } = await boot();
    game.pause();
    await frames(app, 30);
    game.resume(); // closes the pause popup with its 0.3 s animation
    expect(game.kit.paused).toBe(false);
    game.pause(); // asked again while it closes — queued
    await frames(app, 60);
    expect(game.kit.paused).toBe(true);
    expect(game.loop.paused).toBe(true);
    expect(game.popups.isOpen('pause')).toBe(true);
    // A plain close (X) still resumes.
    await drive(app, game.close('pause'));
    expect(game.kit.paused).toBe(false);
  });
});

// ---- §1.5: the kit's and the game's save apart -------------------------------------------------------
/** The save of a game's v0 (kit 1.4: one flat object). */
const DIFF_V1 = JSON.stringify({
  done: ['istanbul-01'],
  found: { 'istanbul-02': [1, 3] },
  hints: {},
  world: 'istanbul',
  winsSinceAd: 1,
  flipped: [],
  sfx: 0,
  music: 1,
  svc: { wallet: { balance: 7 } },
  v: 1,
});
const DIFF_DEFAULTS = { done: [] as string[], found: {} as Record<string, number[]>, hints: {} as Record<string, number>, world: '', winsSinceAd: 0, flipped: [] as string[] };

describe('kit 2.0 — save: the kit and the game apart (§1.5)', () => {
  it('a 1.x save of differences loads into both spaces; the game writing its whole object cannot overwrite sfx / svc', async () => {
    const first = await boot({ save: { version: 1, defaults: DIFF_DEFAULTS } }, createMockPlatform({ saved: DIFF_V1 }));
    const g = first.game;
    expect(g.save.data).toEqual({ done: ['istanbul-01'], found: { 'istanbul-02': [1, 3] }, hints: {}, world: 'istanbul', winsSinceAd: 1, flipped: [] });
    expect('sfx' in g.save.data).toBe(false);
    expect(g.kit.sfx).toBe(0);
    expect(g.services.state(Wallet).balance).toBe(7);
    // The game's whole data object written back (differences did this) — even with a stray `sfx`.
    await g.save.set({ ...g.save.data, world: 'japan' });
    await g.save.update((d) => ({ ...d, sfx: 1, svc: {} }) as typeof d);
    await new Promise((r) => setTimeout(r, 0));
    const stored = JSON.parse(first.platform.host.saved!);
    expect(stored).toMatchObject({ trempel: 2, sfx: 0, music: 1, svc: { wallet: { balance: 7 } } });
    expect(stored.game).toMatchObject({ world: 'japan', v: 1 });
    first.game.destroy();
    // A kit-only write (a setting) still stores the whole file: the game's data with its version.
    const fresh = await boot({ save: { version: 1, defaults: DIFF_DEFAULTS } });
    fresh.game.setVolume('music', 0);
    await new Promise((r) => setTimeout(r, 0));
    expect(JSON.parse(fresh.platform.host.saved!)).toMatchObject({ trempel: 2, music: 0, sfx: 1, svc: {}, game: { ...DIFF_DEFAULTS, v: 1 } });
    fresh.game.destroy();
    // Reload: the sound is still off, the wallet kept.
    const again = await boot({ save: { version: 1, defaults: DIFF_DEFAULTS } }, createMockPlatform({ saved: first.platform.host.saved }));
    expect(again.game.kit.sfx).toBe(0);
    expect((again.game.save.data as typeof DIFF_DEFAULTS).world).toBe('japan');
    expect(again.game.services.state(Wallet).balance).toBe(7);
  });

  it('the game migrate sees the 1.x version of its data', async () => {
    const migrate = vi.fn((raw: Record<string, unknown>) => ({ ...raw, world: 'migrated' }));
    const { game } = await boot({ save: { version: 2, defaults: DIFF_DEFAULTS, migrate } }, createMockPlatform({ saved: DIFF_V1 }));
    // The game's view of the 1.x object (its sfx too — a game may have kept it as its own), without svc.
    expect(migrate).toHaveBeenCalledWith(expect.objectContaining({ v: 1, world: 'istanbul', sfx: 0 }), 1);
    expect(migrate.mock.calls[0][0]).not.toHaveProperty('svc');
    expect((game.save.data as typeof DIFF_DEFAULTS).world).toBe('migrated');
  });
});

// ---- §1.6: clip parameters ----------------------------------------------------------------------------
describe('kit 2.0 — clip parameters at play (§1.6)', () => {
  it('collect flies into a different card per play, the clip is not copied', async () => {
    const { game, app } = await boot({
      popups: {
        victory: { base: `<svg ${NS} viewBox="0 0 720 1280"><g id="content"><rect id="flyingPostcard" x="0" y="0" width="100" height="60"/></g></svg>`, anim: 'none' },
      },
    });
    const { collect } = compileClips(['# $clip collect', '$duration: 1', '## $track flyingPostcard', '| t | x | y | ease |', '|---|---|---|---|', '| 0 | 0 | 0 | inOut |', '| 1 | $toX | $toY | |'].join('\n'));
    const frozen = JSON.stringify(collect);
    const scene = game.popups.def('victory').screen.scene;
    const card = game.popups.def('victory').screen.byId('flyingPostcard');
    for (const [toX, toY] of [[-45, 344], [300, 120]]) {
      await drive(app, game.clips.play(collect, { scene, params: { toX, toY } }).done);
      expect([card.x, card.y]).toEqual([toX, toY]);
    }
    expect(JSON.stringify(collect)).toBe(frozen);
  });
});

// ---- §1.8: a stretched background without distortion ----------------------------------------------------
describe('kit 2.0 — preserveAspectRatio of a stretched image (§1.8)', () => {
  it('xMidYMid slice: a 3:4 desktop column and a 9:19.5 phone — the background covers the canvas with a uniform scale', async () => {
    Assets.cache.set('bg.png', new Texture({ source: new TextureSource({ width: 1080, height: 1920 }) }));
    for (const [w, h] of [
      [960, 1280],
      [600, 1300],
    ]) {
      size.w = w;
      size.h = h;
      const { game } = await boot({
        screens: { menu: { base: `<svg ${NS} viewBox="0 0 720 1280"><image id="bg" href="bg.png" width="720" height="1280" data-stretch="xy" preserveAspectRatio="xMidYMid slice"/></svg>` } },
      });
      const scr = game.screen('menu');
      const bg = scr.byId<Sprite>('bg');
      expect(bg.scale.x).toBeCloseTo(bg.scale.y);
      expect(bg.width).toBeCloseTo(scr.w);
      expect(bg.height).toBeCloseTo(scr.h);
      game.destroy();
    }
  });
});

// ---- §1.9: game.destroy() ----------------------------------------------------------------------------
describe('kit 2.0 — game.destroy() (§1.9)', () => {
  it('controllers unmount (listen unsubscribes), the ticker, input and canvas go; a second createGame works', async () => {
    class Menu {
      readonly seen: number[] = [];
      readonly off = listen(Wallet.events.changed, (b) => this.seen.push(b));
    }
    const first = await boot({ screens: { menu: { base: SCREEN(''), controller: () => new Menu() } }, update: () => {} });
    const menu = first.game.controller<Menu>('menu');
    const services = first.game.services;
    expect(services.listeners(Wallet.events.changed)).toBeGreaterThan(0);
    expect(dom.windowListeners.get('keydown')?.length).toBe(1);
    first.game.destroy();
    expect(services.listeners(Wallet.events.changed)).toBe(0);
    expect(first.app.tickers).toHaveLength(0);
    expect(first.app.destroyed).toBe(true);
    expect(dom.parent.children).not.toContain(first.app.canvas);
    expect(dom.windowListeners.get('keydown')).toHaveLength(0);
    expect((window as unknown as Record<string, unknown>).__trempel).toBeUndefined();
    first.game.destroy(); // twice — nothing
    await services.get(Wallet).add(3);
    expect(menu.seen).toEqual([0]);

    const second = await boot({ screens: { menu: { base: SCREEN(''), controller: () => new Menu() } } });
    expect(second.game.services).not.toBe(services);
    await second.game.services.get(Wallet).add(2);
    expect(second.game.controller<Menu>('menu').seen).toEqual([0, 2]);
    expect(dom.windowListeners.get('keydown')).toHaveLength(1);
  });
});

// ---- §1.10: ads availability on the fly ------------------------------------------------------------------
describe('kit 2.0 — ads availability changes on the fly (§1.10)', () => {
  it('the host turns ads off mid-game: ads.available and kit.ads at once, no interstitial after; back on', async () => {
    const { game, platform } = await boot();
    expect(game.ads.available).toBe(true);
    expect(game.kit.ads).toBe(true);
    platform.host.setAds(false);
    expect(game.ads.available).toBe(false);
    expect(game.kit.ads).toBe(false);
    expect(await game.ads.interstitial()).toBe(false);
    expect(await game.ads.rewarded()).toBe('failed');
    expect(platform.host.calls).not.toContain('interstitial');
    platform.host.setAds(true);
    expect(game.kit.ads).toBe(true);
    expect(await game.ads.interstitial()).toBe(true);
  });

  it('a host that turns ads off without telling: the interstitial is not shown', async () => {
    const { game, platform } = await boot();
    platform.host.ads = false;
    expect(await game.ads.interstitial()).toBe(false);
    expect(platform.host.calls).not.toContain('interstitial');
    expect(game.kit.ads).toBe(false);
  });
});
