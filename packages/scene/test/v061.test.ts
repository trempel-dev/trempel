// v0.6.1: an extensible PixiBackend (createImage / track), image sizing relative to the node's
// current transform, and loud runtime expression errors (onError / throw / lenient).

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { Assets, Container, NineSliceSprite, Sprite, Texture, TextureSource } from 'pixi.js';
import { PixiBackend, type ImageNode } from '../src/render/pixi';
import { mountScene } from '../src/scene';
import { reactive } from '../src/reactive';
import { TrempelError, ExpressionRuntimeError, type ExpressionErrorInfo } from '../src/errors';
import { ExpressionError } from '../src/expr';
import { localMatrix, multiply } from '../src/transform';
import { createMockBackend, isMockNode } from './helpers/mockBackend';

const metrics = (): { ascent: number; descent: number } => ({ ascent: 8, descent: 2 });
const tex = (w: number, h: number): Texture => new Texture({ source: new TextureSource({ width: w, height: h }) });

beforeAll(() => {
  Assets.cache.set('v061/200x100.png', tex(200, 100));
  Assets.cache.set('v061/panel.png', tex(30, 30));
});

/** Assets.load replaced by hand-settled promises, keyed by href. */
function deferredLoads(): { settle: (href: string, t: Texture | Error) => Promise<void> } {
  const pending = new Map<string, { res: (t: Texture) => void; rej: (e: unknown) => void }>();
  vi.spyOn(Assets, 'load').mockImplementation(((href: string) =>
    new Promise<Texture>((res, rej) => pending.set(href, { res, rej }))) as typeof Assets.load);
  return {
    async settle(href, t) {
      const p = pending.get(href);
      if (!p) throw new Error(`no load for ${href}`);
      if (t instanceof Error) p.rej(t);
      else p.res(t);
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---- 1. extensible PixiBackend --------------------------------------------------

/** What a game's own backend shrinks to: only the view choice, nothing about loading. */
class SlicedBackend extends PixiBackend {
  extra: Promise<unknown> | null = null;

  protected createImage(attrs: Record<string, string>): ImageNode {
    const slice = attrs['data-slice'];
    if (!slice) return super.createImage(attrs);
    const [leftWidth, topHeight, rightWidth, bottomHeight] = slice.split(/\s+/).map(Number);
    return new NineSliceSprite({ texture: Texture.EMPTY, leftWidth, topHeight, rightWidth, bottomHeight });
  }

  /** A load of the subclass's own (e.g. slices.json) counts towards readiness. */
  loadExtra(load: Promise<unknown>, label: string): void {
    this.track(load, label);
  }
}

const sliced = (): SlicedBackend => new SlicedBackend({ metrics });

describe('PixiBackend extension: createImage + track (v0.6.1)', () => {
  it('a factory NineSliceSprite gets the cached texture, its width/height as size, x/y as position', () => {
    const n = sliced().createNode('image', { href: 'v061/panel.png', 'data-slice': '10 10 10 10', x: '5', y: '6', width: '300', height: '80' });
    expect(n).toBeInstanceOf(NineSliceSprite);
    const s = n as NineSliceSprite;
    expect(s.texture.orig.width).toBe(30);
    expect([s.width, s.height]).toEqual([300, 80]);
    expect([s.x, s.y, s.scale.x, s.scale.y]).toEqual([5, 6, 1, 1]);
  });

  it('plain images still go through the base Sprite', () => {
    expect(sliced().createNode('image', { href: 'v061/200x100.png' })).toBeInstanceOf(Sprite);
  });

  it('the base guards a factory node against a stale href and counts its loads in whenReady', async () => {
    const loads = deferredLoads();
    const b = sliced();
    const s = b.createNode('image', { href: 'late/old.png', 'data-slice': '4 4 4 4', width: '120', height: '40' }) as NineSliceSprite;
    b.setProp(s, 'href', 'late/new.png');
    let ready = false;
    const whenReady = b.whenReady().then(() => (ready = true));

    await loads.settle('late/new.png', tex(16, 16));
    expect(s.texture.orig.width).toBe(16);
    expect(ready).toBe(false); // the old load is still in flight
    await loads.settle('late/old.png', tex(64, 64)); // older and slower — must not win
    await whenReady;
    expect(s.texture.orig.width).toBe(16);
    expect([s.width, s.height]).toEqual([120, 40]);
  });

  it('a failed factory-node load and a failed subclass load are listed by whenReady', async () => {
    const loads = deferredLoads();
    const b = sliced();
    b.createNode('image', { href: 'late/broken.png', 'data-slice': '4 4 4 4' });
    b.loadExtra(Promise.reject(new Error('404')), 'scenes/ui/slices.json');
    await loads.settle('late/broken.png', new Error('404'));
    const err = await b.whenReady().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TrempelError);
    expect((err as TrempelError).errors).toEqual([
      'Текстура не загрузилась: "late/broken.png".',
      'Текстура не загрузилась: "scenes/ui/slices.json".',
    ]);
  });

  it('whenReady waits for a subclass load that settles later', async () => {
    const b = sliced();
    let release!: () => void;
    b.loadExtra(new Promise<void>((r) => (release = r)), 'font');
    let ready = false;
    const p = b.whenReady().then(() => (ready = true));
    await new Promise((r) => setTimeout(r, 0));
    expect(ready).toBe(false);
    release();
    await p;
    expect(ready).toBe(true);
  });
});

// ---- 2. a texture does not move the host's sprite -----------------------------------

describe('image sizing is relative to the current transform (v0.6.1)', () => {
  it('a late texture keeps the position/scale the host set after build', async () => {
    const loads = deferredLoads();
    const b = new PixiBackend({ metrics });
    const s = b.createNode('image', { href: 'late/a.png', x: '10', y: '20', width: '100', height: '50' }) as Sprite;
    s.position.set(300, 400); // host layout (anchors)
    s.scale.x *= 3; // host zoom
    await loads.settle('late/a.png', tex(200, 100));
    expect([s.x, s.y]).toEqual([300, 400]);
    expect(s.scale.x).toBeCloseTo(1.5); // 3 × 100/200
    expect(s.scale.y).toBeCloseTo(0.5);
  });

  it('a new href from a binding keeps the host offset too', async () => {
    const loads = deferredLoads();
    const state = reactive({ pic: 'v061/200x100.png' });
    const scene = mountScene(
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:tml="https://trempel.dev/ns/scene">
        <image id="pic" x="10" y="20" width="100" height="100" tml:bind="state.pic"/>
      </svg>`,
      { backend: new PixiBackend({ metrics }), context: { state } },
    );
    const s = scene.byId.get('pic') as Sprite;
    expect([s.x, s.y, s.scale.x, s.scale.y]).toEqual([10, 20, 0.5, 1]); // cached: sized at once

    s.position.set(-50, 75);
    state.pic = 'late/b.png';
    await loads.settle('late/b.png', tex(50, 25));
    expect([s.x, s.y]).toEqual([-50, 75]);
    expect([s.width, s.height].map(Math.round)).toEqual([100, 100]);
    expect(s.scale.x).toBeCloseTo(2);
    expect(s.scale.y).toBeCloseTo(4);
  });

  it('a host-set size survives a texture swap (display size kept)', () => {
    const b = new PixiBackend({ metrics });
    Assets.cache.set('v061/50x50.png', tex(50, 50));
    const s = b.createNode('image', { href: 'v061/200x100.png', width: '100', height: '100' }) as Sprite;
    b.setProp(s, 'width', 240);
    b.setProp(s, 'href', 'v061/50x50.png');
    expect(Math.round(s.width)).toBe(240);
    expect(Math.round(s.height)).toBe(100);
  });

  it('without host changes the result equals transform × size (v0.6 placement)', () => {
    const attrs = { href: 'v061/200x100.png', x: '7', y: '9', width: '100', height: '25', transform: 'translate(40 30) rotate(30) skewX(10)' };
    const s = new PixiBackend({ metrics }).createNode('image', attrs) as Container;
    s.updateLocalTransform();
    const m = s.localTransform;
    const want = multiply(localMatrix(attrs, true), [0.5, 0, 0, 0.25, 0, 0]);
    [m.a, m.b, m.c, m.d, m.tx, m.ty].forEach((v, i) => expect(v).toBeCloseTo(want[i], 9));
  });
});

// ---- 3. runtime expression errors are loud -------------------------------------------

const SCENE = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:tml="https://trempel.dev/ns/scene">
  <text id="lbl" tml:bind="state.box.n"/>
  <g id="win" tml:visible="state.box.n > 0"/>
  <g id="btn" tml:on-click="play()"/>
</svg>`;

describe('runtime expression errors (v0.6.1)', () => {
  const ok = (): { box: { n: number } | null } => ({ box: { n: 1 } });

  it('bind: without onError the mount throws with the place', () => {
    const run = (): unknown => mountScene(SCENE, { backend: createMockBackend(), context: { state: { box: null }, play() {} } });
    expect(run).toThrow(ExpressionRuntimeError);
    expect(run).toThrow('#lbl tml:bind="state.box.n": чтение поля «n» у null');
  });

  it('bind / visible: a later state change that breaks the expression throws from the write', () => {
    const state = reactive(ok());
    mountScene(SCENE, { backend: createMockBackend(), context: { state, play() {} } });
    let err: unknown;
    try {
      state.box = null;
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ExpressionRuntimeError);
    const e = err as ExpressionRuntimeError;
    expect([e.node, e.attr, e.expr]).toEqual(['#lbl', 'tml:bind', 'state.box.n']);
    expect(e.error).toBeInstanceOf(ExpressionError);
    expect(e.cause).toBe(e.error);
  });

  it('bind + visible: onError gets every failure with its place, the nodes keep their last value', () => {
    const state = reactive(ok());
    const seen: ExpressionErrorInfo[] = [];
    const scene = mountScene(SCENE, { backend: createMockBackend(), context: { state, play() {} }, onError: (i) => seen.push(i) });
    state.box = null;
    expect(seen.map((i) => [i.node, i.attr, i.expr])).toEqual([
      ['#lbl', 'tml:bind', 'state.box.n'],
      ['#win', 'tml:visible', 'state.box.n > 0'],
    ]);
    expect(seen[0].error).toBeInstanceOf(ExpressionError);
    expect(isMockNode(scene.byId.get('lbl')!).props.text).toBe(1);
    expect(isMockNode(scene.byId.get('win')!).props.visible).toBe(true);
  });

  it('on-click: a throwing context function is thrown with the place, or reported to onError', () => {
    const boom = new Error('no money');
    const context = { state: ok(), play: () => { throw boom; } };

    const loud = mountScene(SCENE, { backend: createMockBackend(), context });
    let err: unknown;
    try {
      isMockNode(loud.byId.get('btn')!).clicks[0]();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ExpressionRuntimeError);
    expect((err as Error).message).toBe('#btn tml:on-click="play()": no money');
    expect((err as ExpressionRuntimeError).error).toBe(boom);

    const seen: ExpressionErrorInfo[] = [];
    const reported = mountScene(SCENE, { backend: createMockBackend(), context, onError: (i) => seen.push(i) });
    expect(() => isMockNode(reported.byId.get('btn')!).clicks[0]()).not.toThrow();
    expect(seen).toEqual([{ node: '#btn', attr: 'tml:on-click', expr: 'play()', error: boom }]);
  });

  it('on-click: calling something that is not in the context is an error too', () => {
    const scene = mountScene(SCENE, { backend: createMockBackend(), context: { state: ok() } });
    expect(() => isMockNode(scene.byId.get('btn')!).clicks[0]()).toThrow(/#btn tml:on-click="play\(\)": имя «play» не определено/);
  });

  it('lenient: v0.5 silence — undefined is written, a failed click is swallowed; onError is still told', () => {
    const state = reactive(ok());
    const scene = mountScene(SCENE, {
      backend: createMockBackend(),
      context: { state, play: () => { throw new Error('x'); } },
      lenient: true,
    });
    state.box = null;
    expect(isMockNode(scene.byId.get('lbl')!).props.text).toBeUndefined();
    expect(isMockNode(scene.byId.get('win')!).props.visible).toBe(false);
    expect(() => isMockNode(scene.byId.get('btn')!).clicks[0]()).not.toThrow();

    const seen: string[] = [];
    const told = mountScene(SCENE, {
      backend: createMockBackend(),
      context: { state: { box: null }, play() {} },
      lenient: true,
      onError: (i) => seen.push(i.attr),
    });
    expect(isMockNode(told.byId.get('lbl')!).props.text).toBeUndefined();
    expect(seen).toEqual(['tml:bind', 'tml:visible']);
  });

  it('a node without id is named by its tag', () => {
    expect(() =>
      mountScene(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:tml="https://trempel.dev/ns/scene"><text tml:bind="nope"/></svg>`, {
        backend: createMockBackend(),
        context: {},
      }),
    ).toThrow('<text> tml:bind="nope": имя «nope» не определено в контексте');
  });
});
