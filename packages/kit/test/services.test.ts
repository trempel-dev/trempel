// Services: contracts with a mandatory mock — declaration, sticky / once, inject at mount, lazy
// references, listen without leaks, mock modes, extend, adapt, the scene binding of
// services.<name>.*, the Platform facade over the contracts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type NodeHandle, type RendererBackend } from '@trempel/scene/core';
import { adapt, contract, extend, once, sticky } from '../src/services/contract.js';
import { Services, inject, listen, parseModeQuery, provide, setCurrentServices } from '../src/services/services.js';
import { AdsService, AudioService, Iap, KIT_CONTRACTS, Language, Leaderboard, Lifecycle, SaveService, Wallet } from '../src/services/standard.js';
import { platformFacade, platformProviders } from '../src/services/platform.js';
import { createMockPlatform } from '../src/platform/mock.js';
import { Save } from '../src/data/save.js';
import { Ads } from '../src/data/ads.js';
import { scanSterility } from '../src/vite/gates.js';

// "provided after its first call" warnings are expected here (asserted where they matter).
beforeEach(() => void vi.spyOn(console, 'warn').mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

let n = 0;
const uniq = (s: string) => `${s}-${++n}`;

const Counter = contract(uniq('counter'), {
  state: { value: 0 },
  events: { changed: sticky<number>('value'), hit: once<{ by: number }>() },
  modes: ['frozen'],
  mock: (ctx) => ({
    async inc(by = 1): Promise<number> {
      if (ctx.mode.frozen) return ctx.state.value;
      ctx.state.value += by;
      ctx.emit('changed', ctx.state.value);
      ctx.emit('hit', { by });
      return ctx.state.value;
    },
    peek: () => ctx.state.value,
  }),
})<{ inc(by?: number): Promise<number>; peek(): number }>();

describe('contract()', () => {
  it('a mock is mandatory (types and runtime); names are unique and well-formed', () => {
    // @ts-expect-error — no mock
    expect(() => contract(uniq('nomock'), { state: { a: 1 } })).toThrow(/mock is mandatory/);
    const name = uniq('dup');
    contract(name, { mock: () => ({}) });
    expect(() => contract(name, { mock: () => ({}) })).toThrow(/declared twice/);
    expect(() => contract('Bad Name', { mock: () => ({}) })).toThrow(/must match/);
  });

  it('the mock must satisfy the method type (types)', () => {
    const ok = contract(uniq('typed'), { mock: () => ({ async a() { return 1; } }) })<{ a(): Promise<number> }>();
    expect(ok.name).toMatch(/^typed-/);
    // @ts-expect-error — the mock has no b()
    contract(uniq('typed'), { mock: () => ({ async a() { return 1; } }) })<{ a(): Promise<number>; b(): void }>();
  });
});

describe('registry: get / provide / state', () => {
  it('runs on the mock by default; provide before or after get is the same', async () => {
    const s = new Services({ contracts: [Counter] });
    const api = s.get(Counter);
    expect(await api.inc(2)).toBe(2);
    expect(s.state(Counter).value).toBe(2);
    expect(s.implName(Counter)).toBe('mock');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    s.provide(Counter, (ctx) => ({ inc: async () => (ctx.state.value = 100), peek: () => -1 }), 'server');
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/provided after its first call/));
    warn.mockRestore();
    expect(await api.inc()).toBe(100);
    expect(api.peek()).toBe(-1);
    expect(s.implName(Counter)).toBe('server');
    s.unprovide(Counter);
    expect(api.peek()).toBe(100);
  });

  it('an unregistered contract is an error naming it', () => {
    expect(() => new Services().get(Counter)).toThrow(new RegExp(`"${Counter.name}" is not registered`));
  });

  it('the kit registers its standard contracts with working mocks', async () => {
    const s = new Services({ contracts: [...KIT_CONTRACTS] });
    expect(s.names()).toEqual(['lifecycle', 'save', 'audio', 'language', 'ads', 'wallet', 'iap', 'leaderboard']);
    const w = s.get(Wallet);
    expect(await w.add(30)).toBe(30);
    expect(await w.spend(50)).toEqual({ ok: false, balance: 30 });
    expect(await w.spend(10)).toEqual({ ok: true, balance: 20 });
    s.state(Iap).products = [{ id: 'gold', title: 'Gold', price: '$1', permanent: true }];
    expect(await s.get(Iap).purchase('gold')).toEqual({ ok: true, id: 'gold' });
    expect(await s.get(Iap).purchase('gold')).toMatchObject({ ok: false, reason: 'owned' });
    expect(await s.get(Iap).purchase('nope')).toMatchObject({ ok: false, reason: 'unknown-product' });
    expect(await s.get(Iap).restore()).toEqual(['gold']);
    await s.get(Leaderboard).submit(5);
    await s.get(Leaderboard).submit(9);
    expect((await s.get(Leaderboard).top(5)).map((e) => e.score)).toEqual([9, 5]);
    expect(await s.get(AdsService).rewarded()).toBe('rewarded');
    await s.get(SaveService).save('{"a":1}');
    expect(await s.get(SaveService).load()).toBe('{"a":1}');
  });

  it('the wallet persists through the store (the game save in createGame)', async () => {
    const data = new Map<string, unknown>();
    const store = { get: (c: string) => data.get(c), set: (c: string, v: unknown) => void data.set(c, v) };
    await new Services({ contracts: [Wallet], store }).get(Wallet).add(7);
    expect(data.get('wallet')).toEqual({ balance: 7 });
    const again = new Services({ contracts: [Wallet], store });
    again.start();
    expect(again.state(Wallet).balance).toBe(7);
  });
});

describe('events: sticky / once through the bus', () => {
  it('sticky delivers the current value at once (from state, then the last emit); once does not', async () => {
    const s = new Services({ contracts: [Counter] });
    const got: number[] = [];
    s.listen(Counter.events.changed, (v) => got.push(v));
    expect(got).toEqual([0]);
    const hits: number[] = [];
    s.listen(Counter.events.hit, (p) => hits.push(p.by));
    expect(hits).toEqual([]);
    await s.get(Counter).inc(3);
    expect(got).toEqual([0, 3]);
    expect(hits).toEqual([3]);
    const late: number[] = [];
    const lateHits: number[] = [];
    s.listen(Counter.events.changed, (v) => late.push(v));
    s.listen(Counter.events.hit, (p) => lateHits.push(p.by));
    expect(late).toEqual([3]);
    expect(lateHits).toEqual([]);
  });

  it('events are on the bus as <contract>:<event>; an undeclared event is an error', async () => {
    const s = new Services({ contracts: [Counter] });
    const seen: unknown[] = [];
    s.bus.on(`${Counter.name}:hit`, (p) => seen.push(p));
    await s.get(Counter).inc(2);
    expect(seen).toEqual([{ by: 2 }]);
    s.provide(Counter, (ctx) => ({ inc: async () => (ctx.emit('nope' as never), 0), peek: () => 0 }));
    await expect(s.get(Counter).inc()).rejects.toThrow(/no event "nope"/);
  });
});

describe('inject / listen — owners', () => {
  class Shop {
    counter = inject(Counter);
    seen: number[] = [];
    off = listen(Counter.events.changed, (v) => this.seen.push(v));
  }

  it('inject in a component of a contract the game does not register fails at mount, with both names', () => {
    const s = new Services();
    expect(() => s.mount('component shop#panel', () => new Shop())).toThrow(new RegExp(`"component shop#panel" injects "${Counter.name}", not registered`));
  });

  it('resolves at mount (awake), the sticky init arrives after construction', async () => {
    const s = new Services({ contracts: [Counter] });
    let during: number[] | null = null;
    const m = s.mount('shop', () => {
      const shop = new Shop();
      during = [...shop.seen];
      return shop;
    });
    expect(during).toEqual([]);
    expect(m.value.seen).toEqual([0]);
    await m.value.counter.inc(4);
    expect(m.value.seen).toEqual([0, 4]);
  });

  it('listen has no leaks: mount → unmount ×1000 leaves zero subscribers', () => {
    const s = new Services({ contracts: [Counter] });
    for (let i = 0; i < 1000; i++) s.mount('shop', () => new Shop()).unmount();
    expect(s.listeners(Counter.events.changed)).toBe(0);
    const kept = s.mount('shop', () => new Shop());
    expect(s.listeners(Counter.events.changed)).toBe(1);
    kept.unmount();
    kept.unmount();
    expect(s.listeners(Counter.events.changed)).toBe(0);
  });

  it('outside an owner inject is a lazy reference: a later provide is picked up; listen returns dispose', async () => {
    const s = setCurrentServices(new Services({ contracts: [Counter] }));
    const ref = inject(Counter);
    expect(ref.peek()).toBe(0);
    provide(Counter, { inc: async () => 42, peek: () => 42 }, 'test');
    expect(ref.peek()).toBe(42);
    expect(await ref.inc()).toBe(42);
    const got: number[] = [];
    const off = listen(Counter.events.changed, (v) => got.push(v));
    expect(s.listeners(Counter.events.changed)).toBe(1);
    off();
    expect(s.listeners(Counter.events.changed)).toBe(0);
    setCurrentServices(new Services());
  });
});

describe('mock modes', () => {
  it('latency delays, fail rejects (always / rate), never and clearing restore', async () => {
    vi.useFakeTimers();
    try {
      const s = new Services({ contracts: [Counter] });
      s.mock(Counter, { latency: 500 });
      let done = false;
      const p = s.get(Counter).inc().then((v) => ((done = true), v));
      await vi.advanceTimersByTimeAsync(499);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await p).toBe(1);
      s.mock(Counter, { latency: 0, fail: 'always' });
      await expect(s.get(Counter).inc()).rejects.toThrow(/mock failure/);
      expect(s.state(Counter).value).toBe(1);
      s.random = () => 0.3;
      s.mock(Counter, { fail: 0.5 });
      await expect(s.get(Counter).inc()).rejects.toThrow();
      s.random = () => 0.7;
      expect(await s.get(Counter).inc()).toBe(2);
      s.mock(Counter, null);
      expect(s.modes(Counter)).toEqual({});
      expect(s.log.some((e) => e.kind === 'fail')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("custom modes are the contract's own; unknown ones are an error; modes touch only the mock", async () => {
    const s = new Services({ contracts: [Counter, Wallet] });
    s.mock(Counter, { frozen: true });
    expect(await s.get(Counter).inc(5)).toBe(0);
    expect(() => s.mock(Counter, { nope: true })).toThrow(/no mode "nope"/);
    await s.get(Wallet).add(100);
    s.mock('wallet', { 'no-funds': true });
    expect(await s.get(Wallet).spend(1)).toEqual({ ok: false, balance: 100 });
    s.mock(Counter, { fail: 'always' });
    s.provide(Counter, { inc: async () => 9, peek: () => 9 }, 'real');
    expect(await s.get(Counter).inc()).toBe(9);
  });

  it('modes from the query string, set before registration', () => {
    expect(parseModeQuery('?svc.wallet=fail&svc.iap=latency:300,cancel&x=1&svc.ads=fail:0.25,no-ads')).toEqual({
      wallet: { fail: 'always' },
      iap: { latency: 300, cancel: true },
      ads: { fail: 0.25, 'no-ads': true },
    });
    const s = new Services();
    s.mock('wallet', { 'no-funds': true });
    s.register(Wallet);
    expect(s.modes(Wallet)).toEqual({ 'no-funds': true });
  });
});

describe('extend / adapt', () => {
  it('extend requires a mock; the extension replaces its base under the same name', async () => {
    // @ts-expect-error — no mock
    expect(() => extend(Counter, { events: {} })).toThrow(/mock is mandatory/);
    const Counter2 = extend(Counter, {
      state: { resets: 0 },
      events: { reset: once() },
      mock: (ctx, base) => ({
        async reset(): Promise<void> {
          ctx.state.value = 0;
          ctx.state.resets++;
          ctx.emit('reset');
          void base;
        },
      }),
    })<{ reset(): Promise<void> }>();
    expect(Counter2.name).toBe(Counter.name);
    const s = new Services({ contracts: [Counter, Counter2] });
    const api = s.get(Counter2);
    expect(await api.inc(3)).toBe(3);
    await api.reset();
    expect(s.state(Counter2)).toMatchObject({ value: 0, resets: 1 });
    // The base reference reaches the extended service.
    expect(await s.get(Counter).inc()).toBe(1);
  });

  it('adapt: another model under the contract — named, checked for completeness', async () => {
    const vendor = { add: (n: number) => n * 10 };
    const s = new Services({ contracts: [Counter] });
    s.provide(
      Counter,
      adapt(Counter, (ctx) => ({
        async inc(by = 1) {
          ctx.state.value = vendor.add(by);
          ctx.emit('changed', ctx.state.value);
          return ctx.state.value;
        },
        peek: () => ctx.state.value,
      }), 'vendor'),
    );
    expect(s.implName(Counter)).toBe('vendor');
    expect(await s.get(Counter).inc(2)).toBe(20);
    s.provide(Counter, adapt(Counter, () => ({ peek: () => 1 }) as never, 'broken'));
    expect(() => s.get(Counter).peek()).toThrow(/broken implementation .* lacks inc/);
  });
});

/** A minimal in-memory backend (texts recorded). */
function memBackend(): RendererBackend & { texts: Map<string, unknown> } {
  const texts = new Map<string, unknown>();
  type N = { attrs: Record<string, string>; children: N[] };
  return {
    texts,
    createNode: (_tag, attrs) => ({ attrs, children: [] }) as N,
    setProp: (node, path, value) => {
      const id = (node as N).attrs.id;
      if (path === 'text' && id) texts.set(id, value);
    },
    onClick: () => {},
    addChild: (p, c) => void (p as N).children.push(c as N),
    mount: () => {},
    getBounds: () => ({ x: 0, y: 0, w: 0, h: 0 }),
    getProp: () => undefined,
  } as RendererBackend & { texts: Map<string, unknown> };
}

describe('scenes bind services.<name>.*', () => {
  it('services.wallet.balance in a scene updates without code', async () => {
    const s = new Services({ contracts: [Wallet] });
    const backend = memBackend();
    mount({
      base: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text id="coins">0</text></svg>',
      heir: '<svg xmlns="http://www.w3.org/2000/svg" xmlns:tml="https://trempel.dev/ns/scene" tml:extends="x.svg"><tml:ref id="coins" tml:bind-text="services.wallet.balance"/></svg>',
      backend,
      context: { services: s.scene },
      container: {} as NodeHandle,
    });
    expect(backend.texts.get('coins')).toBe(0);
    await s.get(Wallet).add(25);
    expect(backend.texts.get('coins')).toBe(25);
  });
});

describe('the Platform as contracts, and back', () => {
  const kit = () => {
    const s = new Services({ contracts: [...KIT_CONTRACTS] });
    const host = createMockPlatform({ language: 'ru' });
    for (const [c, impl] of platformProviders(host)) s.provide(c, impl);
    return { s, host, platform: platformFacade(s, host) };
  };

  it('the adapter implements lifecycle / save / audio / language / ads; the facade is a Platform', async () => {
    const { s, host, platform } = kit();
    await platform.init();
    expect(platform.name).toBe('mock');
    expect(s.implName(SaveService)).toBe('mock');
    expect(s.state(Language).lang).toBe('ru');
    expect(platform.language()).toBe('ru');
    platform.firstFrameReady();
    platform.gameReady();
    expect(host.host.calls).toEqual(['firstFrameReady', 'gameReady']);

    const paused: string[] = [];
    platform.onPause(() => paused.push('pause'));
    s.listen(Lifecycle.events.resume, () => paused.push('resume'));
    host.host.pause();
    host.host.resume();
    expect(paused).toEqual(['pause', 'resume']);

    const audio: boolean[] = [];
    platform.onAudioChange((on) => audio.push(on));
    s.listen(AudioService.events.changed, (on) => audio.push(on));
    host.host.setAudio(false);
    expect(audio).toEqual([true, false, false]);
    expect(platform.audioEnabled()).toBe(false);
    // The facade keeps the adapter's own members.
    expect((platform as typeof host).host).toBe(host.host);
  });

  it('game.save / game.ads stay facades: Save and Ads over the contracts', async () => {
    const { s, host, platform } = kit();
    const save = new Save(platform, { version: 1, defaults: { best: 0 } });
    await save.load();
    await save.set({ best: 3 });
    expect(JSON.parse(host.host.saved!)).toEqual({ best: 3, v: 1 });
    const ads = new Ads(platform);
    const avail: boolean[] = [];
    s.listen(AdsService.events.changed, (v) => avail.push(v));
    expect(avail).toEqual([true]);
    expect(await ads.rewarded()).toBe('rewarded');
    host.host.ads = false;
    expect(await ads.rewarded()).toBe('failed');
    // Re-checked after the call: the contract's state follows the adapter.
    expect(avail).toEqual([true, false]);
    expect(platform.adsAvailable()).toBe(false);
  });

  it('a mocked ads contract in fail mode is "no ad" through the facade', async () => {
    const s = new Services({ contracts: [...KIT_CONTRACTS] });
    s.mock('ads', { fail: 'always' });
    const ads = new Ads(platformFacade(s));
    expect(await ads.rewarded()).toBe('failed');
    expect(await ads.interstitial()).toBe(true);
  });
});

describe('build gate', () => {
  it('the services dev panel is web-only: its marker fails the youtube sterility scan', () => {
    const { hits } = scanSterility([{ path: 'a.js', text: 'x.id="trempel-services"' }]);
    expect(hits).toEqual([{ file: 'a.js', what: 'web-only trempel-services' }]);
  });
});
