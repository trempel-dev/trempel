// Kit 2.2 (TRM-12 §4): a particle effect as a scene node (`tml:type="fx"`), clip markers
// `fx:<name>@<node>`, the clip time of the viewer — deterministic particles.
import { Container } from 'pixi.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Registry, mount, PixiBackend } from '@trempel/scene';
import { Fx } from '../src/fx/fx.js';
import { FX_STEP, FxClipTime, FxHost, FxNode, fxComponents, fxNodeOf, parseFxMarker, playFxMarker, seedOf } from '../src/fx/node.js';
import { particleConfig } from '../src/fx/types.js';
import { Clips } from '../src/anim/clips.js';
import { kitView } from '../src/view/index.js';
import type { Effect } from '../src/fx/fx.js';

afterEach(() => vi.restoreAllMocks());

/** Particle positions of an effect, rounded — the picture's fingerprint. */
const picture = (e: Effect | null | undefined): string =>
  JSON.stringify((e?.emitters ?? []).map((em) => em.sim.particles.map((p) => [p.x, p.y, p.outSize, ...p.outColor].map((v) => Math.round(v * 1e6) / 1e6))));

const SPARK = particleConfig({ duration: 1, loop: true, rate: 40, lifetime: [0.3, 0.8], speed: [40, 90], size: [4, 9], max: 100, shape: { type: 'circle', radius: 6, thickness: 1, arc: Math.PI * 2, scale: [1, 1] } });
const POP = particleConfig({ duration: 0.1, lifetime: 0.3, speed: 50, bursts: [{ time: 0, count: 6, cycles: 1, interval: 0, prob: 1 }], shape: { type: 'circle', radius: 0, thickness: 1, arc: Math.PI * 2, scale: [1, 1] } });

function fxOf(): Fx {
  const fx = new Fx(null);
  fx.tables({ effects: { spark: SPARK, pop: POP } });
  return fx;
}

describe('fx node: deterministic time', () => {
  it('the same id and seed → the same particles; seek(t) is what stepping to t gives, at any frame rate', () => {
    const fx = fxOf();
    const a = new FxNode(fx, 'star', 'spark');
    const b = new FxNode(fx, 'star', 'spark');
    for (let i = 0; i < 50; i++) a.update(1 / 60);
    for (let i = 0; i < 25; i++) b.update(1 / 30); // 30 fps: the same fixed frames
    expect(picture(a.host.run(FxNode.MAIN)!.effect)).toBe(picture(b.host.run(FxNode.MAIN)!.effect));
    const c = new FxNode(fx, 'star', 'spark');
    c.seek(50 / 60);
    expect(picture(c.host.run(FxNode.MAIN)!.effect)).toBe(picture(a.host.run(FxNode.MAIN)!.effect));
    // back in time — replayed from the start
    c.seek(0.25);
    const d = new FxNode(fx, 'star', 'spark');
    d.seek(0.25);
    expect(picture(c.host.run(FxNode.MAIN)!.effect)).toBe(picture(d.host.run(FxNode.MAIN)!.effect));
    // another id or seed — other particles
    const e = new FxNode(fx, 'moon', 'spark');
    e.seek(50 / 60);
    expect(picture(e.host.run(FxNode.MAIN)!.effect)).not.toBe(picture(a.host.run(FxNode.MAIN)!.effect));
    const f = new FxNode(fx, 'star', 'spark', { seed: 7 });
    f.seek(50 / 60);
    expect(picture(f.host.run(FxNode.MAIN)!.effect)).not.toBe(picture(a.host.run(FxNode.MAIN)!.effect));
    expect(seedOf('a')).not.toBe(seedOf('b'));
  });

  it('autostart off, loop restarts a finished effect, one-shots fired without a key end with their particles', () => {
    const fx = fxOf();
    const n = new FxNode(fx, 'p', 'pop', { autostart: false, loop: true });
    expect(n.host.size).toBe(0);
    n.play();
    n.update(1); // pop lives 0.3 s — restarted by the loop
    expect(n.host.run(FxNode.MAIN)!.effect!.alive).toBe(true);
    n.fire('pop');
    expect(n.host.size).toBe(2);
    n.update(0.5);
    expect(n.host.size).toBe(1);
    n.stop();
    n.clear();
    expect(n.host.size).toBe(0);
    n.seek(0.1); // seek starts the node's effect
    expect(n.host.size).toBe(1);
    n.destroy();
    expect(n.root.destroyed).toBe(true);
  });

  it('manual runs move only by seek; dropped keys; frames below a step accumulate', () => {
    const fx = fxOf();
    const h = new FxHost(fx, new Container(), 3);
    h.fire('spark', { manual: true }, 'm');
    h.fire('spark', {}, 'r');
    h.update(FX_STEP / 2);
    expect(h.run('r')!.age).toBe(0);
    h.update(FX_STEP / 2);
    expect(h.run('r')!.age).toBeCloseTo(FX_STEP, 9);
    expect(h.run('m')!.age).toBe(0);
    h.seek('m', 0.5);
    expect(h.run('m')!.age).toBeCloseTo(0.5, 6);
    h.seek('nope', 1);
    expect(h.keys()).toEqual(['m', 'r']);
    h.stop('m');
    h.drop('m');
    expect(h.keys()).toEqual(['r']);
  });
});

describe('fx node: markers and clip time', () => {
  it('fx:<name>@<node> parsed; others are not effects', () => {
    expect(parseFxMarker('fx:spark@star')).toEqual({ effect: 'spark', node: 'star' });
    expect(parseFxMarker('fx:spark')).toEqual({ effect: 'spark', node: undefined });
    expect(parseFxMarker('done')).toBeNull();
  });

  it('a game marker: an effect node fires it, another node gets a one-shot, a missing node warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fx = fxOf();
    const node = new FxNode(fx, 'star', 'spark', { autostart: false });
    const box = new Container();
    const scene = { byId: new Map<string, object>([['box', box]]), components: new Map<string, unknown>([['star', { node }]]) };
    expect(playFxMarker(fx, 'fx:pop@star', scene)).toBe(true);
    expect(node.host.size).toBe(1);
    expect(playFxMarker(fx, 'fx:pop@box', scene)).toBe(true);
    expect(fx.size).toBe(1);
    expect(box.children.length).toBe(1);
    playFxMarker(fx, 'fx:pop@nope', scene);
    playFxMarker(fx, 'fx:pop', scene);
    expect(warn.mock.calls.map((c) => String(c[0]).slice(0, 12))).toEqual(['W_FX_MARKER:', 'W_FX_MARKER:']);
    expect(playFxMarker(fx, 'step', scene)).toBe(false);
    expect(playFxMarker(fx, 'fx:pop@star', null)).toBe(true);
    expect(fxNodeOf(scene as never, 'star')).toBe(node);
    expect(fxNodeOf(scene as never, 'box')).toBeUndefined();
  });

  it('clip time: runs at t − marker time, replayed the same, dropped when the marker is no longer crossed', () => {
    const fx = fxOf();
    const node = new FxNode(fx, 'star', 'spark', { autostart: false });
    const box = new Container();
    const scene = { byId: new Map<string, never>([['box', box as never]]), components: new Map<string, unknown>([['star', { node }]]) };
    const markers = [
      { t: 0.2, name: 'fx:spark@star' },
      { t: 0.5, name: 'fx:spark@box' },
      { t: 0.6, name: 'step' },
      { t: 0.9, name: 'fx:spark@ghost' },
    ];
    const ct = new FxClipTime(fx);
    ct.apply(scene as never, 1, markers);
    expect(node.host.run('0.2|fx:spark@star')!.age).toBeCloseTo(0.8, 6);
    const first = picture(node.host.run('0.2|fx:spark@star')!.effect);
    // the same time again on a fresh player → the same picture
    const node2 = new FxNode(fx, 'star', 'spark', { autostart: false });
    new FxClipTime(fx).apply({ byId: new Map(), components: new Map([['star', { node: node2 }]]) } as never, 1, markers);
    expect(picture(node2.host.run('0.2|fx:spark@star')!.effect)).toBe(first);
    expect(box.children.length).toBe(1);
    // forward a frame — stepped on; back before 0.5 — the box run is dropped
    ct.apply(scene as never, 1 + FX_STEP, markers);
    ct.apply(scene as never, 0.3, markers.slice(0, 1));
    expect(box.children.length).toBe(0);
    expect(node.host.run('0.2|fx:spark@star')!.age).toBeCloseTo(0.1, 6);
    // real time does not move clip-fired runs
    node.update(1);
    expect(node.host.run('0.2|fx:spark@star')!.age).toBeCloseTo(0.1, 6);
    ct.clear();
    expect(node.host.size).toBe(0);
  });

  it('kit Clips: markers go to onMarker first, then to the play\'s own', () => {
    const seen: string[] = [];
    const ticks: (() => void)[] = [];
    const backend = { setProp() {}, getProp: () => 0, createNode: () => ({}), onClick() {}, addChild() {}, mount() {}, getBounds: () => ({ x: 0, y: 0, w: 0, h: 0 }) };
    const loop = { clock: { now: () => t }, add: (fn: () => void) => (ticks.push(fn), () => {}) };
    let t = 0;
    const clips = new Clips(backend as never, loop as never);
    clips.onMarker = (name, scene) => seen.push(`kit ${name} ${scene ? 'scene' : '-'}`);
    clips.play({ tracks: [], markers: [{ t: 0.1, name: 'fx:pop@a' }], duration: 0.2 }, { onMarker: (n) => seen.push(`own ${n}`), scene: { byId: new Map() } });
    t = 150;
    ticks.forEach((f) => f());
    expect(seen).toEqual(['kit fx:pop@a scene', 'own fx:pop@a']);
  });
});

describe('fx node: the component and the view module', () => {
  it('tml:type="fx" mounts at its node, ticks, unsubscribes when destroyed; no effect → E_FX_NODE', () => {
    const fx = fxOf();
    const subs = new Set<(dt: number) => void>();
    const reg = new Registry();
    for (const [n, f] of Object.entries(fxComponents({ fx, tick: (fn) => (subs.add(fn), () => void subs.delete(fn)), place: (root) => root.position.set(10, 20) }))) reg.register(n, f);
    const base = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><g id="star" data-effect="spark" data-scale="2" data-tint="#ff8000"><circle r="4"/></g><g id="off" data-effect="pop" data-autostart="false" data-loop="true" data-seed="3"/></svg>';
    const heir = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:tml="https://trempel.dev/ns/scene" tml:extends="x.svg"><tml:ref id="star" tml:type="fx"/><tml:ref id="off" tml:type="fx"/></svg>';
    const scene = mount({ base, heir, backend: new PixiBackend(), registry: reg, context: {} });
    const star = fxNodeOf(scene, 'star')!;
    expect(star.root.position.x).toBe(10);
    expect(star.opts).toMatchObject({ scale: 2, autostart: true });
    expect(star.root.tint).toBe(0xff8000); // data-tint: the scene tints the component's root
    expect(fxNodeOf(scene, 'off')!.host.size).toBe(0);
    for (const f of subs) f(0.5);
    expect(star.host.run(FxNode.MAIN)!.age).toBeCloseTo(0.5, 6);
    expect(subs.size).toBe(2);
    star.root.destroy();
    for (const f of [...subs]) f(0.1);
    expect(subs.size).toBe(1);
    const bad = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g id="x"/></svg>';
    const badHeir = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:tml="https://trempel.dev/ns/scene" tml:extends="x.svg"><tml:ref id="x" tml:type="fx"/></svg>';
    expect(() => mount({ base: bad, heir: badHeir, backend: new PixiBackend(), registry: reg, context: {} })).toThrow(/E_FX_NODE/);
  });

  it('kitView: the registry has the UI components and fx; onClipTime replays marker effects', () => {
    const view = kitView({ effects: { spark: SPARK }, background: '#000' });
    expect(view.background).toBe('#000');
    const reg = view.registry!();
    expect(reg.has('fx')).toBe(true);
    expect(reg.has('ui-button')).toBe(true);
    expect(kitView({ skin: false }).registry!().has('ui-button')).toBe(false);
    const box = new Container();
    const scene = { byId: new Map([['box', box]]), components: new Map() };
    view.onClipTime!({ id: 's', scene: scene as never, clip: 'c', t: 0.5, markers: [{ t: 0.1, name: 'fx:spark@box' }] });
    expect(box.children.length).toBe(1);
    view.onMount!({ id: 's', scene: scene as never, state: {} });
    expect(box.children.length).toBe(0);
  });
});
