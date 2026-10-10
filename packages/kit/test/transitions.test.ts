// Kit 2.1 (TRM-10): transitions by snapshots — the leaf (with a "WebGL2" renderer) and its
// cross-fade fallback, a function transition, a page turn inside a screen, a page drag; the screens
// switch with { transition }. Headless: the renderer only counts the snapshots it renders.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Container, Texture } from 'pixi.js';
import { dragOutcome, phaseRun, Transitions, type TransitionHost } from '../src/ui/transitions.js';
import { Screens } from '../src/ui/screens.js';
import { Tweens } from '../src/anim/tweens.js';
import { FakeCanvas } from './helpers/fake-pixi.js';

class FakeGl {}
const RECT = { x: 40, y: 0, w: 400, h: 800 };

function host(webgl: boolean) {
  const frames: ((dt: number) => void)[] = [];
  const live = new Container();
  const canvas = new FakeCanvas();
  const busy: boolean[] = [];
  const renders: { container: Container; transform?: unknown }[] = [];
  const h: TransitionHost = {
    renderer: { resolution: 1, gl: webgl ? new FakeGl() : undefined, render: (o: { container: Container; transform?: unknown }) => void renders.push(o) } as never,
    onFrame: (fn) => {
      frames.push(fn);
      return () => frames.splice(frames.indexOf(fn), 1);
    },
    live,
    busy: (on) => void busy.push(on),
    canvas: canvas as never,
  };
  const tick = (n = 1, dt = 1 / 60) => {
    for (let i = 0; i < n; i++) for (const f of [...frames]) f(dt);
  };
  return { h, live, canvas, busy, renders, tick, frames };
}

/** Run frames until `p` settles. */
async function settle<T>(tick: (n?: number) => void, p: Promise<T>): Promise<T> {
  let done = false;
  void p.then(
    () => (done = true),
    () => (done = true),
  );
  for (let i = 0; i < 2000 && !done; i++) {
    tick();
    await Promise.resolve();
    await Promise.resolve();
  }
  return p;
}

beforeEach(() => {
  vi.stubGlobal('document', { createElement: () => ({ getContext: () => null }) });
  vi.stubGlobal('WebGL2RenderingContext', FakeGl);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('transitions: pure parts', () => {
  it('a phase run is clamped to the early finish and takes its share of the duration', () => {
    expect(phaseRun(0, 1, 1, 0.5)).toEqual({ a: 0, b: 0.5, seconds: 0.5 });
    expect(phaseRun(1, 0, 0.8, 0.7)).toMatchObject({ a: 0.7, b: 0 });
    expect(phaseRun(0, 1, 1, 0.05).seconds).toBeCloseTo(0.15, 6); // the floor: 15% of a full turn
    expect(phaseRun(0, 1, 1, 1, 3).seconds).toBe(3); // slow motion
  });

  it('release of a drag: a flick only while the finger moves; else by half the travel', () => {
    expect(dragOutcome({ dir: 1, t: 0.1, gone: 0.7, v: -8, sinceMove: 20 })).toEqual({ forward: true, committed: true });
    expect(dragOutcome({ dir: 1, t: 0.1, gone: 0.7, v: -8, sinceMove: 200 })).toEqual({ forward: false, committed: false }); // stopped
    expect(dragOutcome({ dir: 1, t: 0.5, gone: 0.7, v: 0, sinceMove: 200 })).toEqual({ forward: true, committed: true });
    // Back: the leaf comes from `gone` to 0 — committed when it goes back (not forward).
    expect(dragOutcome({ dir: -1, t: 0.2, gone: 0.7, v: 0, sinceMove: 200 })).toEqual({ forward: false, committed: true });
    expect(dragOutcome({ dir: -1, t: 0.6, gone: 0.7, v: -5, sinceMove: 10 })).toEqual({ forward: true, committed: false });
  });
});

describe('transitions: the leaf and its fallback', () => {
  it('a snapshot renders the root with its world matrix shifted by the column (rake №1)', () => {
    const { h, renders } = host(false);
    const tr = new Transitions(h);
    const layer = new Container();
    layer.position.set(5, 7);
    layer.updateLocalTransform();
    // The parent's world transform (as the last render left it).
    layer.worldTransform.copyFrom(layer.localTransform);
    const root = new Container();
    root.position.set(40, 0);
    root.scale.set(0.5);
    root.visible = false;
    layer.addChild(root);
    const rt = tr.snapshot(root, RECT);
    expect(rt.width).toBe(400);
    const m = renders[0].transform as { a: number; tx: number; ty: number };
    expect(m.a).toBe(0.5);
    expect(m.tx).toBe(5 + 40 - RECT.x);
    expect(m.ty).toBe(7);
    expect(root.visible).toBe(false); // restored
    expect(tr.info.textures).toBe(1);
  });

  it('WebGL2: forward — the leaf turns 0 → its early finish, the live screens hidden, input blocked, textures freed after', async () => {
    const { h, live, busy, tick } = host(true);
    const tr = new Transitions(h);
    const before = Texture.WHITE;
    const p = tr.play({ leaf: { look: 'hard', duration: 1 } }, before, before, RECT);
    expect(tr.active).toBe(true);
    expect(tr.info.mode).toBe('leaf');
    expect(live.visible).toBe(false);
    expect(tr.layer.visible).toBe(true);
    expect(tr.layer.position.x).toBe(RECT.x);
    expect(busy).toEqual([true]);
    tick(15);
    const mid = tr.info.t;
    expect(mid).toBeGreaterThan(0);
    const gone = tr.leaf()!.gone();
    await settle(tick, p);
    expect(tr.leaf()!.t).toBeCloseTo(gone, 6);
    expect(gone).toBeLessThan(0.6); // a hard leaf is off the column at ~0.5
    expect(tr.active).toBe(false);
    expect(live.visible).toBe(true);
    expect(tr.layer.visible).toBe(false);
    expect(busy).toEqual([true, false]);
  });

  it('WebGL2: back — the phase goes from the early finish down to 0', async () => {
    const { h, tick } = host(true);
    const tr = new Transitions(h);
    const p = tr.play({ leaf: { dir: -1, look: 'soft' } }, Texture.WHITE, Texture.WHITE, RECT);
    tick(1);
    const t0 = tr.info.t;
    tick(10);
    expect(tr.info.t).toBeLessThan(t0);
    await settle(tick, p);
    expect(tr.leaf()!.t).toBe(0);
  });

  it('no WebGL2 (or fallback): a cross-fade of the snapshots', async () => {
    for (const [webgl, fallback] of [
      [false, false],
      [true, true],
    ] as const) {
      const { h, tick } = host(webgl);
      const tr = new Transitions(h);
      tr.fallback = fallback;
      const p = tr.play({ leaf: {} }, Texture.WHITE, Texture.WHITE, RECT);
      expect(tr.info.mode).toBe('fade');
      expect(tr.info.t).toBe(1); // the front fully over
      tick(20);
      expect(tr.info.t).toBeLessThan(1);
      await settle(tick, p);
      expect(tr.active).toBe(false);
    }
  });

  it('a function transition gets both snapshots, a layer and frames; what it adds is destroyed after', async () => {
    const { h, tick } = host(true);
    const tr = new Transitions(h);
    const seen: string[] = [];
    let added: Container | null = null;
    const p = tr.play(
      async (ctx) => {
        seen.push(`${ctx.width}x${ctx.height}`);
        const a = ctx.sprite(ctx.before);
        const b = ctx.sprite(ctx.after);
        ctx.layer.addChild(b, a);
        added = a;
        let k = 0;
        await ctx.frame((dt) => {
          k += dt;
          a.alpha = 1 - k / 0.2;
          return k >= 0.2;
        });
        seen.push('done');
      },
      Texture.WHITE,
      Texture.WHITE,
      RECT,
    );
    await settle(tick, p);
    expect(seen).toEqual(['400x800', 'done']);
    expect(added!.destroyed).toBe(true);
  });

  it('turn(): snapshots around the change of the page; the page changed under the leaf', async () => {
    const { h, renders, tick } = host(true);
    const tr = new Transitions(h);
    const root = new Container();
    let page = 1;
    const p = tr.turn({ root, rect: RECT }, () => void (page = 2), { dir: 1 });
    expect(page).toBe(2);
    await Promise.resolve();
    expect(renders).toHaveLength(2);
    expect(tr.info.textures).toBe(2);
    await settle(tick, p);
    expect(tr.info.textures).toBe(0);
    // A throwing change frees the first snapshot.
    await expect(tr.turn({ root, rect: RECT }, () => Promise.reject(new Error('no page')))).rejects.toThrow('no page');
    expect(tr.info.textures).toBe(0);
  });

  it('warm(): compiles the leaf with the textures of the pages, frees them', () => {
    const { h, renders } = host(true);
    const tr = new Transitions(h);
    tr.warm([{ root: new Container(), rect: RECT }]);
    expect(renders).toHaveLength(2); // the snapshot + the leaf over it
    expect(tr.info.textures).toBe(0);
    tr.destroy();
    expect(tr.layer.destroyed).toBe(true);
  });
});

describe('transitions: page drag', () => {
  const ev = (x: number, y = 300, id = 1) => ({ clientX: x, clientY: y, pointerId: id });

  function setup(can = (_d: 1 | -1) => true) {
    const t = host(true);
    const tr = new Transitions(t.h);
    const log: string[] = [];
    let world = 0;
    const off = tr.drag({
      page: () => ({ root: new Container(), rect: RECT }),
      allowed: () => true,
      can,
      change: (d) => void (world += d),
      onStart: (d) => void log.push(`start ${d}`),
      onRelease: (d, c) => void log.push(`release ${d} ${c}`),
      onEnd: (d, c) => void log.push(`end ${d} ${c}`),
    });
    return { ...t, tr, log, world: () => world, off };
  }

  it('a short pull with the finger stopped falls back; the page goes back too', async () => {
    const s = setup();
    s.canvas.dispatch('pointerdown', ev(380));
    s.canvas.dispatch('pointermove', ev(375)); // under the threshold
    expect(s.tr.active).toBe(false);
    s.canvas.dispatch('pointermove', ev(340));
    expect(s.tr.active).toBe(true);
    expect(s.world()).toBe(1); // the next page is live under the leaf
    expect(s.tr.info.t).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 120)); // the finger stops: no flick
    s.canvas.dispatch('pointerup', ev(340));
    await settle(s.tick, new Promise<void>((r) => (s.log.includes('end 1 false') ? r() : setTimeout(r, 50))));
    for (let i = 0; i < 200 && !s.log.includes('end 1 false'); i++) {
      s.tick();
      await Promise.resolve();
    }
    expect(s.log).toEqual(['start 1', 'release 1 false', 'end 1 false']);
    expect(s.world()).toBe(0);
    expect(s.tr.active).toBe(false);
    expect(s.tr.info.textures).toBe(0);
  });

  it('a long pull turns the page; a quick flick right goes back', async () => {
    const s = setup();
    s.canvas.dispatch('pointerdown', ev(390));
    for (let k = 1; k <= 8; k++) s.canvas.dispatch('pointermove', ev(390 - 40 * k));
    await new Promise((r) => setTimeout(r, 120));
    s.canvas.dispatch('pointerup', ev(70));
    for (let i = 0; i < 300 && s.tr.active; i++) {
      s.tick();
      await Promise.resolve();
    }
    expect(s.world()).toBe(1);
    expect(s.log.slice(-1)).toEqual(['end 1 true']);
    // Back by a flick (the finger still moving on release).
    s.canvas.dispatch('pointerdown', ev(60));
    for (let k = 1; k <= 4; k++) s.canvas.dispatch('pointermove', ev(60 + 30 * k));
    s.canvas.dispatch('pointerup', ev(180));
    for (let i = 0; i < 300 && s.tr.active; i++) {
      s.tick();
      await Promise.resolve();
    }
    expect(s.log.slice(-2)).toEqual(['release -1 true', 'end -1 true']);
    expect(s.world()).toBe(0);
    s.off();
    s.canvas.dispatch('pointerdown', ev(300));
    s.canvas.dispatch('pointermove', ev(200));
    expect(s.tr.active).toBe(false); // detached
  });

  it('a vertical gesture, no page that way, another pointer — not a page turn', () => {
    const s = setup((d) => d > 0);
    s.canvas.dispatch('pointerdown', ev(300, 300));
    s.canvas.dispatch('pointermove', ev(296, 360));
    s.canvas.dispatch('pointermove', ev(200, 360));
    expect(s.tr.active).toBe(false);
    s.canvas.dispatch('pointerup', ev(200, 360));
    s.canvas.dispatch('pointerdown', ev(100));
    s.canvas.dispatch('pointermove', ev(200)); // dir −1: no page there
    expect(s.tr.active).toBe(false);
    s.canvas.dispatch('pointerup', ev(200));
    s.canvas.dispatch('pointerdown', ev(300, 300, 1));
    s.canvas.dispatch('pointermove', ev(200, 300, 2));
    expect(s.tr.active).toBe(false);
  });

  it('drag() needs the canvas', () => {
    const { h } = host(true);
    expect(() => new Transitions({ ...h, canvas: undefined }).drag({ page: { root: new Container(), rect: RECT }, allowed: () => true, can: () => true, change: () => {} })).toThrow(/canvas/);
  });
});

describe('screens.show({ transition })', () => {
  function screens() {
    const tweens = new Tweens();
    const sc = new Screens(tweens, async () => {});
    const mk = (name: string) => ({ name, root: new Container(), rect: RECT, scene: { ready: Promise.resolve() } });
    const a = mk('a');
    const b = mk('b');
    sc.add('a', { screen: a as never });
    sc.add('b', { screen: b as never });
    return { sc, a, b, tweens };
  }

  it('a leaf over the snapshots of both screens; the old one is gone from the layer at once', async () => {
    const { sc, a, b } = screens();
    const t = host(true);
    const tr = new Transitions({ ...t.h, live: sc.layer });
    sc.transitions = tr;
    await sc.show('a', 0);
    const p = sc.show('b', { transition: { leaf: { look: 'hard' } } });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(sc.switchingNow).toBe(true);
    expect(t.renders.map((r) => r.container)).toEqual([a.root, b.root]);
    expect(a.root.parent).toBe(null);
    expect(sc.layer.visible).toBe(false);
    await settle(t.tick, p);
    expect(sc.current).toBe('b');
    expect(sc.layer.visible).toBe(true);
    expect(tr.info.textures).toBe(0);
  });

  it("'none' / { fade } / 'fade' and no transitions host: the live switch", async () => {
    const { sc, tweens } = screens();
    await sc.show('a', { transition: 'none' });
    const p = sc.show('b', { transition: { fade: 0.1 } });
    for (let i = 0; i < 30; i++) {
      tweens.update(1 / 60);
      await Promise.resolve();
    }
    await p;
    expect(sc.current).toBe('b');
    // A leaf without the host: a fade.
    const q = sc.show('a', { transition: { leaf: {} } });
    for (let i = 0; i < 30; i++) {
      tweens.update(1 / 60);
      await Promise.resolve();
    }
    await q;
    expect(sc.current).toBe('a');
  });
});
