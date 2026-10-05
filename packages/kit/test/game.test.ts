// createGame end to end, headless: Pixi's Application is a fake (no WebGL — a stage, a manual
// ticker, a renderer that resizes), the platform is the mock one, scenes mount through the real
// PixiBackend. These tests hold game.ts while it is split (TRM-8b): boot order, pause, screens /
// popups / overlays and their controllers, save + services, ads, layout.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---- a fake Pixi Application -------------------------------------------------------------------
const size = { w: 720, h: 1280 };
const apps: FakeApp[] = [];

class FakeCanvas {
  style: Record<string, string> = {};
  private readonly handlers = new Map<string, ((e: unknown) => void)[]>();
  addEventListener(type: string, fn: (e: unknown) => void): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]);
  }
  removeEventListener(): void {}
  dispatch(type: string, e: unknown = {}): void {
    for (const fn of this.handlers.get(type) ?? []) fn(e);
  }
}

class FakeApp {
  stage!: import('pixi.js').Container;
  readonly canvas = new FakeCanvas();
  readonly screen = { x: 0, y: 0, width: 0, height: 0 };
  renders = 0;
  readonly initOptions: Record<string, unknown>[] = [];
  private readonly tickers: ((t: { deltaMS: number }) => void)[] = [];
  readonly ticker = { add: (fn: (t: { deltaMS: number }) => void) => void this.tickers.push(fn) };
  private readonly resizers: (() => void)[] = [];
  readonly renderer = {
    on: (ev: string, fn: () => void) => void (ev === 'resize' && this.resizers.push(fn)),
    resize: (w: number, h: number) => {
      this.screen.width = w;
      this.screen.height = h;
      this.resizers.forEach((f) => f());
    },
    generateTexture: () => null,
  };
  async init(opts: Record<string, unknown>): Promise<void> {
    const { Container } = await vi.importActual<typeof import('pixi.js')>('pixi.js');
    this.stage = new Container();
    this.initOptions.push(opts);
    this.screen.width = size.w;
    this.screen.height = size.h;
    apps.push(this);
  }
  render(): void {
    this.renders++;
  }
  /** One frame of `ms`. */
  tick(ms = 1000 / 60): void {
    for (const f of this.tickers) f({ deltaMS: ms });
  }
}

vi.mock('pixi.js', async (orig) => ({ ...(await orig<typeof import('pixi.js')>()), Application: FakeApp }));

// ---- a minimal DOM: createGame reads document / window / location ------------------------------
const body = { children: [] as unknown[], appendChild: (c: unknown) => void body.children.push(c) };
const parent = { appendChild: (c: unknown) => void parent.children.push(c), children: [] as unknown[] };
beforeEach(() => {
  apps.length = 0;
  size.w = 720;
  size.h = 1280;
  // Pixi probes a canvas for the shader precision (the backdrop's blur): none here.
  vi.stubGlobal('document', { body, getElementById: () => null, querySelector: () => null, createElement: () => ({ style: {}, getContext: () => null }) });
  vi.stubGlobal('window', { addEventListener: () => {}, devicePixelRatio: 1 });
  vi.stubGlobal('location', { search: '' });
  vi.stubGlobal('devicePixelRatio', 1);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const { createGame } = await import('../src/game.js');
const { createMockPlatform } = await import('../src/platform/mock.js');
const { contract, sticky } = await import('../src/services/contract.js');
const { inject, listen } = await import('../src/services/services.js');
const { AdsService, Wallet } = await import('../src/services/standard.js');

// ---- scenes (no text: Pixi Text needs a DOM canvas) ---------------------------------------------
const SCREEN = (id: string, w = 720, h = 1280) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"><rect id="bg" x="0" y="0" width="${w}" height="${h}" data-stretch="xy"/><rect id="${id}" x="10" y="10" width="100" height="100"/></svg>`;
const POPUP = (id: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 1280"><rect id="dim" x="0" y="0" width="720" height="1280" opacity="0.5" data-stretch="xy"/><g id="content" transform="translate(360,640)" data-anchor="0.5 0.5"><rect id="${id}" x="-100" y="-100" width="200" height="200"/></g></svg>`;

/** A game contract with state, a sticky event and a store. */
const Score = contract('test-score', {
  state: { best: 0 },
  events: { changed: sticky<number>('best') },
  mock: (ctx) => {
    const saved = ctx.store.get<{ best: number }>();
    if (saved) ctx.state.best = saved.best;
    return {
      submit(n: number): number {
        if (n > ctx.state.best) {
          ctx.state.best = n;
          ctx.store.set({ best: n });
          ctx.emit('changed', n);
        }
        return ctx.state.best;
      },
    };
  },
})<{ submit(n: number): number }>();

const log: string[] = [];

class MenuController {
  readonly wallet = inject(Wallet);
  readonly score = inject(Score);
  readonly seen: number[] = [];
  readonly off = listen(Wallet.events.changed, (b) => this.seen.push(b));
  constructor() {
    log.push('controller:menu');
  }
}

type Cfg = Parameters<typeof createGame<{ n: number }, { level: number }>>[0];
const flush = () => new Promise((r) => setTimeout(r, 0));
/** Run frames until `p` settles (screen transitions and popup animations run on the loop). */
async function drive<T>(app: FakeApp, p: Promise<T>): Promise<T> {
  let done = false;
  void p.then(
    () => (done = true),
    () => (done = true),
  );
  for (let i = 0; i < 600 && !done; i++) {
    app.tick();
    await flush();
  }
  return p;
}

async function boot(over: Partial<Cfg> = {}, platform = createMockPlatform()) {
  log.length = 0;
  const game = await createGame<{ n: number }, { level: number }>({
    state: { n: 0 },
    parent: parent as never,
    platform,
    services: [Score],
    save: { version: 1, defaults: { level: 1 } },
    screens: {
      menu: { base: SCREEN('menuBox'), controller: () => new MenuController(), onShow: () => log.push('show:menu') },
      play: { base: SCREEN('playBox'), lazy: true, controller: () => (log.push('controller:play'), { name: 'play' }) },
    },
    popups: { pause: { base: POPUP('pauseBox') }, info: { base: POPUP('infoBox'), anim: 'none', controller: () => ({ name: 'info' }) } },
    overlays: { loading: { base: SCREEN('loadingBox'), boot: true } },
    start: 'menu',
    layout: { safeArea: false },
    ready: (g) => {
      log.push(`ready:${g.kit.screen}:${platform.host.calls.includes('gameReady')}`);
    },
    update: () => log.push('update'),
    ...over,
  });
  return { game, platform, app: apps[apps.length - 1] };
}

describe('createGame: boot', () => {
  it('order: init → first frame → loading → save → services → screens → first screen → ready → gameReady → update', async () => {
    const platform = createMockPlatform();
    const init = vi.spyOn(platform, 'init');
    const { game, app } = await boot({}, platform);
    expect(init).toHaveBeenCalledOnce();
    expect(platform.host.calls.slice(0, 2)).toEqual(['firstFrameReady', 'gameReady']);
    expect(app.renders).toBeGreaterThan(0); // the loading frame before firstFrameReady
    expect(app.initOptions[0]).toMatchObject({ preference: 'webgl', resizeTo: parent });
    expect(parent.children).toContain(app.canvas);
    // ready() runs after the start screen is shown and before gameReady; update only after it.
    expect(log).toEqual(['controller:menu', 'show:menu', 'ready:menu:false']);
    expect(game.kit.screen).toBe('menu');
    expect(game.kit.progress).toBe(100);
    app.tick();
    expect(log.at(-1)).toBe('update');
    // The loading UI is gone from the stage; the boot overlay is up.
    expect(game.overlays.isOpen('loading')).toBe(true);
    expect(game.screen('menu').byId('menuBox')).toBeTruthy();
    // Scenes get the context: state, kit, services, built-ins.
    expect(Object.keys(game.context)).toEqual(expect.arrayContaining(['state', 'kit', 'services', 't', 'show', 'popup', 'close', 'pause', 'resume', 'toggleSfx', 'toggleMusic']));
    expect(game.services.names()).toEqual(expect.arrayContaining(['lifecycle', 'save', 'audio', 'language', 'ads', 'wallet', 'iap', 'leaderboard', 'test-score']));
  });

  it('errors: an unknown start screen; an action clashing with a built-in', async () => {
    await expect(boot({ start: 'nope' })).rejects.toThrow(/start screen "nope"/);
    await expect(boot({ actions: { pause: () => 1 } })).rejects.toThrow(/clashes with a built-in/);
  });

  it('actions (function form) get the game; the web build installs the probe', async () => {
    const { game, app } = await boot({ actions: (g) => ({ go: () => g.show('play') }), probe: { mine: 1 } });
    expect(typeof game.context.go).toBe('function');
    await drive(app, (game.context.go as () => Promise<void>)());
    expect(game.kit.screen).toBe('play');
    const probe = (window as unknown as { __trempel: Record<string, unknown> }).__trempel;
    expect(probe).toBeTruthy();
    expect(probe.mine).toBe(1);
    game.probe({ more: 2 });
    expect(probe.more).toBe(2);
  });
});

describe('createGame: pause', () => {
  it('platform pause: everything stops (loop, sound), the bus says so; resume', async () => {
    const { game, platform, app } = await boot();
    const suspend = vi.spyOn(game.sound, 'suspend');
    const resume = vi.spyOn(game.sound, 'resume');
    const events: string[] = [];
    game.bus.on('platform:pause', () => events.push('pause'));
    game.bus.on('platform:resume', () => events.push('resume'));
    log.length = 0;
    platform.host.pause();
    expect(game.loop.suspended).toBe(true);
    expect(suspend).toHaveBeenCalledOnce();
    const t = game.loop.time;
    app.tick();
    app.tick();
    expect(log).toEqual([]); // update does not tick
    expect(game.loop.time).toBe(t);
    platform.host.resume();
    expect(game.loop.suspended).toBe(false);
    expect(resume).toHaveBeenCalledOnce();
    app.tick();
    expect(log).toEqual(['update']);
    expect(events).toEqual(['pause', 'resume']);
  });

  it('game pause: the game channel stops, the pause popup opens; resume closes it', async () => {
    const { game, app } = await boot();
    log.length = 0;
    game.pause();
    expect(game.kit.paused).toBe(true);
    expect(game.loop.paused).toBe(true);
    expect(game.popups.isOpen('pause')).toBe(true);
    expect(game.kit.popup).toBe('pause');
    app.tick();
    expect(log).toEqual([]);
    game.resume();
    expect(game.kit.paused).toBe(false);
    app.tick();
    expect(log).toEqual(['update']);
    for (let i = 0; i < 60; i++) app.tick();
    expect(game.popups.isOpen('pause')).toBe(false);
  });

  it('platform audio switch and volumes reach the sound; volumes are saved', async () => {
    const { game, platform } = await boot();
    const audio = vi.spyOn(game.sound, 'setPlatformAudio');
    platform.host.setAudio(false);
    expect(audio).toHaveBeenCalledWith(false);
    game.setVolume('sfx', 0.25);
    (game.context.toggleMusic as () => void)();
    expect(game.sound.volumes).toEqual({ sfx: 0.25, music: 0 });
    await flush();
    expect(JSON.parse(platform.host.saved!)).toMatchObject({ sfx: 0.25, music: 0 });
  });
});

describe('createGame: screens, popups, overlays, controllers', () => {
  it('show: a lazy screen mounts (and its controller is built) on first show only', async () => {
    const { game, app } = await boot();
    const shown: string[] = [];
    game.bus.on('screen:show', ({ name }) => shown.push(name));
    expect(log).not.toContain('controller:play');
    await drive(app, game.show('play'));
    await drive(app, game.show('menu'));
    await drive(app, game.show('play'));
    expect(log.filter((l) => l === 'controller:play')).toHaveLength(1);
    expect(shown).toEqual(['play', 'menu', 'play']);
    expect(game.controller<{ name: string }>('play').name).toBe('play');
    expect(() => game.controller('nope')).toThrow(/has no controller/);
  });

  it('popups: show / close / closeNow on the bus, kit.popup follows; a popup controller is "popup:<name>"', async () => {
    const { game } = await boot();
    const events: string[] = [];
    game.bus.on('popup:show', ({ name }) => events.push(`show:${name}`));
    game.bus.on('popup:hide', ({ name }) => events.push(`hide:${name}`));
    (game.context.popup as (n: string) => void)('info');
    expect(game.kit.popup).toBe('info');
    await game.close();
    expect(game.kit.popup).toBe('');
    game.popup('info');
    game.closeNow('info');
    game.closeNow('info'); // not open: nothing
    expect(events).toEqual(['show:info', 'hide:info', 'show:info', 'hide:info']);
    expect(game.controller<{ name: string }>('popup:info').name).toBe('info');
    await game.close(); // nothing open
  });

  it('overlays: the boot overlay is up from the first frame; hideOverlay; bus events', async () => {
    const { game } = await boot();
    const events: string[] = [];
    game.bus.on('overlay:hide', ({ name }) => events.push(name));
    expect(game.overlays.isOpen('loading')).toBe(true);
    await game.hideOverlay('loading', { anim: 'none' });
    expect(game.overlays.isOpen('loading')).toBe(false);
    expect(events).toEqual(['loading']);
  });

  it('a controller is an owner: inject resolves in the game registry, listen gets the sticky value and the changes', async () => {
    const { game } = await boot();
    const c = game.controller<MenuController>('menu');
    expect(c.seen).toEqual([0]);
    await c.wallet.add(5);
    expect(c.seen).toEqual([0, 5]);
    expect(c.score.submit(7)).toBe(7);
    // Its subscription is its own: dropping it unsubscribes (the kit unmounts owners this way).
    const before = game.services.listeners(Wallet.events.changed);
    c.off();
    expect(game.services.listeners(Wallet.events.changed)).toBe(before - 1);
    await c.wallet.add(1);
    expect(c.seen).toEqual([0, 5]);
  });

  it('a controller injecting an unregistered contract fails the boot naming both', async () => {
    const Other = contract('test-other', { mock: () => ({ x: () => 1 }) })<{ x(): number }>();
    await expect(boot({ screens: { menu: { base: SCREEN('m'), controller: () => ({ o: inject(Other) }) } } })).rejects.toThrow(/screen "menu"" injects "test-other"/);
  });
});

describe('createGame: save and services', () => {
  it('the game save and the services\' svc survive re-creating the game on the same storage', async () => {
    const first = await boot();
    await first.game.save.set({ level: 4 });
    await first.game.services.get(Wallet).add(30);
    first.game.services.get(Score).submit(12);
    await flush();
    const stored = first.platform.host.saved!;
    expect(JSON.parse(stored).svc).toEqual({ wallet: { balance: 30 }, 'test-score': { best: 12 } });

    const again = await boot({}, createMockPlatform({ saved: stored }));
    expect(again.game.services).not.toBe(first.game.services);
    expect(again.game.save.data.level).toBe(4);
    expect(again.game.services.state(Wallet).balance).toBe(30);
    expect(again.game.services.state(Score).best).toBe(12);
    // Scenes bind services.<name>.* — the same reactive object.
    expect((again.game.context.services as Record<string, { balance: number }>).wallet.balance).toBe(30);
    expect(again.game.controller<MenuController>('menu').seen).toEqual([30]);
  });

  it('provide: [[Contract, impl, name]] over the mock; ?svc.<name>=… mock modes on the web build', async () => {
    vi.stubGlobal('location', { search: '?svc.wallet=no-funds&svc.nope=fail' });
    const { game } = await boot({ provide: [[Score, { submit: () => 99 }, 'remote']] });
    expect(game.services.implName(Score)).toBe('remote');
    expect(game.services.get(Score).submit(1)).toBe(99);
    expect(game.services.modes(Wallet)).toEqual({ 'no-funds': true });
    await game.services.get(Wallet).add(10);
    expect((await game.services.get(Wallet).spend(5)).ok).toBe(false);
  });
});

describe('createGame: ads', () => {
  it.each(['rewarded', 'closed', 'failed'] as const)('rewarded through the platform: %s; the loop and the sound are suspended while it shows', async (result) => {
    const platform = createMockPlatform();
    platform.host.rewarded = result;
    const { game } = await boot({}, platform);
    const during: boolean[] = [];
    const show = platform.showRewarded.bind(platform);
    platform.showRewarded = async () => {
      during.push(game.loop.suspended);
      return show();
    };
    const suspend = vi.spyOn(game.sound, 'suspend');
    expect(await game.ads.rewarded()).toBe(result);
    expect(during).toEqual([true]);
    expect(suspend).toHaveBeenCalledOnce();
    expect(game.loop.suspended).toBe(false);
  });

  it('rewarded through the ads contract mock and its modes (closed, no-ads, fail)', async () => {
    const { game } = await boot();
    game.services.unprovide(AdsService);
    expect(await game.ads.rewarded()).toBe('rewarded');
    game.services.mock('ads', { closed: true });
    expect(await game.ads.rewarded()).toBe('closed');
    game.services.mock('ads', null);
    game.services.mock('ads', { fail: 'always' });
    await expect(game.services.get(AdsService).rewarded()).rejects.toThrow(/mock failure/);
    game.services.mock('ads', null);
    game.services.mock('ads', { 'no-ads': true });
    expect(await game.services.get(AdsService).rewarded()).toBe('failed');
    expect(game.kit.ads).toBe(false); // kit.ads follows the contract's sticky event
  });

  it('interstitial: shown once, then the cooldown; no ads → skipped', async () => {
    const { game, platform } = await boot();
    expect(await game.ads.interstitial()).toBe(true);
    expect(await game.ads.interstitial()).toBe(false);
    expect(platform.host.calls.filter((c) => c === 'interstitial')).toHaveLength(1);
    game.loop.advance(61);
    expect(await game.ads.interstitial()).toBe(true);
    // A platform without ads (known at init): skipped, the scenes' kit.ads is false.
    const none = createMockPlatform();
    none.host.ads = false;
    const off = await boot({}, none);
    expect(off.game.kit.ads).toBe(false);
    expect(await off.game.ads.interstitial()).toBe(false);
    expect(await off.game.ads.rewarded()).toBe('failed');
    expect(none.host.calls).not.toContain('interstitial');
  });
});

describe('createGame: layout and the playfield', () => {
  it('a window resize: `layout` on the bus with the new size, the playfield is recomputed', async () => {
    const { game, app } = await boot({ layout: { safeArea: { top: 40 }, hud: { top: 160 } } });
    const p0 = { ...game.playfield.px };
    expect(p0).toEqual({ x: 0, y: 200, w: 720, h: 1080 }); // safe 40 + HUD 160 at scale 1
    expect(game.playfield.safe.top).toBe(40);
    const seen: { width: number; height: number; y: number; h: number }[] = [];
    game.bus.on('layout', (e) => seen.push({ width: e.width, height: e.height, y: e.playfield.px.y, h: e.playfield.px.h }));
    app.renderer.resize(360, 640);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ width: 360, height: 640 });
    expect(game.playfield.px).toEqual({ x: 0, y: 120, w: 360, h: 520 }); // safe 40 px + HUD 160 × 0.5
    // The playfield in a screen's own units.
    expect(game.playfield.in('menu')).toMatchObject({ y: 240, h: 1040 });
    game.setHud({ top: 0 });
    expect(seen).toHaveLength(2);
    expect(game.playfield.px.y).toBe(40);
    game.layout();
    expect(seen).toHaveLength(3);
  });

  it('a landscape window on a portrait game: the column is capped at maxAspect 0.75', async () => {
    size.w = 1920;
    size.h = 1080;
    const { game } = await boot();
    expect(game.playfield.px.w).toBeCloseTo(1080 * 0.75);
    expect(game.playfield.px.x).toBeCloseTo((1920 - 810) / 2);
  });
});
