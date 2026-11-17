// v0.7 through the real PixiBackend, headless: new shapes and their bounds, <defs> not drawn,
// clip-path masks (g and image; follow the node's transform; bound on/off), href on a rig part.

import { describe, it, expect, beforeAll } from 'vitest';
import { Assets, Container, Graphics, Sprite, Texture, TextureSource } from 'pixi.js';
import { PixiBackend } from '../src/render/pixi';
import { mount } from '../src/scene';
import { reactive } from '../src/reactive';
import { thrown } from './helpers/codes';

const metrics = (): { ascent: number; descent: number } => ({ ascent: 8, descent: 2 });
const backend = (): PixiBackend => new PixiBackend({ metrics });
const tex = (w: number, h: number): Texture => new Texture({ source: new TextureSource({ width: w, height: h }) });

const svg = (body: string): string => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600">${body}</svg>`;
const heir = (body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:tml="https://trempel.dev/ns/scene" tml:extends="scene.svg">${body}</svg>`;

beforeAll(() => {
  Assets.cache.set('v07/100x100.png', tex(100, 100));
  Assets.cache.set('v07/head-a.png', tex(10, 10));
  Assets.cache.set('v07/head-b.png', tex(10, 10));
});

const bounds = (b: PixiBackend, n: unknown) => {
  const r = b.getBounds(n as object);
  return [r.x, r.y, r.w, r.h].map((v) => Math.round(v * 100) / 100);
};

describe('PixiBackend v0.7 — shapes', () => {
  it('path → Graphics; its bounds; transform applies, x/y do not (geometry is absolute)', () => {
    const b = backend();
    const g = b.createNode('path', { d: 'M10 20 L110 20 L110 70 Z', fill: '#f00', transform: 'translate(5 5)' }) as Graphics;
    expect(g).toBeInstanceOf(Graphics);
    expect([g.x, g.y]).toEqual([5, 5]);
    expect(bounds(b, g)).toEqual([15, 25, 100, 50]);
  });

  it('every command of d draws (curves stay inside their hull)', () => {
    const b = backend();
    const g = b.createNode('path', { d: 'M0 0 H50 V50 C 50 60 40 70 30 70 S 10 60 10 50 Q 5 40 0 30 T 0 10 A 5 5 0 0 1 0 0 z', fill: '#0f0' });
    const [x, y, w, h] = bounds(b, g);
    expect(x).toBeGreaterThanOrEqual(-5.01);
    expect(y).toBeCloseTo(0, 0);
    expect(w).toBeLessThanOrEqual(56);
    expect(h).toBeCloseTo(70, 0);
  });

  it('circle / ellipse / line', () => {
    const b = backend();
    expect(bounds(b, b.createNode('circle', { cx: '50', cy: '40', r: '10' }))).toEqual([40, 30, 20, 20]);
    expect(bounds(b, b.createNode('ellipse', { cx: '50', cy: '40', rx: '20', ry: '5' }))).toEqual([30, 35, 40, 10]);
    const line = b.createNode('line', { x1: '0', y1: '10', x2: '100', y2: '10', stroke: '#fff', 'stroke-width': '4', 'stroke-linecap': 'butt' });
    // Pixi pads stroke bounds by half the width on every side (caps included).
    const [lx, ly, lw, lh] = bounds(b, line);
    expect(lx).toBeCloseTo(-2);
    expect(lw).toBeCloseTo(104);
    expect(ly).toBeCloseTo(8);
    expect(lh).toBeCloseTo(4);
  });

  it('fill="none" + stroke, opacity / display like any node', () => {
    const b = backend();
    const c = b.createNode('circle', { r: '10', fill: 'none', stroke: '#000', 'stroke-width': '2', opacity: '0.5', display: 'none' }) as Graphics;
    expect(c.alpha).toBe(0.5);
    expect(c.visible).toBe(false);
  });

  it('unreadable d is an error with the node id', () => {
    const e = thrown(() => backend().createNode('path', { id: 'wing', d: 'M0 0 X5' }));
    expect(e).toMatchObject({ code: 'E_PATH_DATA' });
    expect(e.message).toContain('#wing');
    expect(e.message).toContain('"X"');
  });
});

describe('scene v0.7 — defs are not drawn', () => {
  it('nothing inside <defs> becomes a display object; ids there are not in byId', () => {
    const b = backend();
    const scene = mount({
      base: svg('<defs id="defs"><path id="fly1" d="M0 0 L100 0"/><rect id="r" width="5" height="5"/></defs><circle id="c" r="3"/>'),
      backend: b,
      context: {},
    });
    const root = scene.root as Container;
    expect(root.children).toHaveLength(1);
    expect(scene.byId.has('fly1')).toBe(false);
    expect(scene.byId.has('c')).toBe(true);
    expect(scene.path('fly1').length).toBeCloseTo(100);
  });
});

describe('scene v0.7 — clip-path masks', () => {
  const defs = '<defs><clipPath id="m"><rect x="10" y="20" width="50" height="40"/></clipPath></defs>';

  it('on <g>: the mask is a child Graphics; bounds = the visible part', () => {
    const b = backend();
    const scene = mount({ base: svg(defs + '<g id="w" clip-path="url(#m)"><rect width="300" height="300"/></g>'), backend: b, context: {} });
    const w = scene.byId.get('w') as Container;
    expect(w.mask).toBeInstanceOf(Graphics);
    expect(w.children).toContain(w.mask);
    expect(bounds(b, w)).toEqual([10, 20, 50, 40]);
  });

  it("the mask follows the node's transform (geometry in the node's own coordinates)", () => {
    const b = backend();
    const scene = mount({
      base: svg(defs + '<g id="w" transform="translate(100 0) scale(2)" clip-path="url(#m)"><rect width="300" height="300"/></g>'),
      backend: b,
      context: {},
    });
    expect(bounds(b, scene.byId.get('w'))).toEqual([120, 40, 100, 80]);
    (scene.byId.get('w') as Container).x = 0; // the host / a clip moves the node — the window moves with it
    expect(bounds(b, scene.byId.get('w'))).toEqual([20, 40, 100, 80]);
  });

  it("clipPath's own and its children's transforms compose", () => {
    const b = backend();
    const scene = mount({
      base: svg('<defs><clipPath id="m" transform="translate(5 0)"><g transform="translate(0 5)"><circle cx="10" cy="10" r="10"/></g></clipPath></defs><g id="w" clip-path="url(#m)"><rect width="300" height="300"/></g>'),
      backend: b,
      context: {},
    });
    expect(bounds(b, scene.byId.get('w'))).toEqual([5, 5, 20, 20]);
  });

  it('on <image>: wrapped in a group (id, transform) that holds the sprite and the mask', () => {
    const b = backend();
    const scene = mount({
      base: svg(defs + '<image id="pic" href="v07/100x100.png" x="0" y="0" width="200" height="200" transform="translate(30 0)" clip-path="url(#m)"/>'),
      backend: b,
      context: {},
    });
    const pic = scene.byId.get('pic') as Container;
    expect(pic).not.toBeInstanceOf(Sprite);
    expect(pic.x).toBe(30);
    expect(pic.children[0]).toBeInstanceOf(Sprite);
    expect((pic.children[0] as Sprite).width).toBe(200);
    expect(bounds(b, pic)).toEqual([40, 20, 50, 40]);
    // tml:bind / href on the wrapper reaches the sprite.
    b.setProp(pic, 'href', 'v07/head-a.png');
    expect((pic.children[0] as Sprite).texture).toBe(Assets.cache.get('v07/head-a.png'));
  });

  it('one clipPath on several nodes — a Graphics each', () => {
    const b = backend();
    const scene = mount({
      base: svg(defs + '<g id="a" clip-path="url(#m)"><rect width="9" height="9"/></g><g id="b" clip-path="url(#m)"><rect width="9" height="9"/></g>'),
      backend: b,
      context: {},
    });
    const a = scene.byId.get('a') as Container;
    const c = scene.byId.get('b') as Container;
    expect(a.mask).toBeInstanceOf(Graphics);
    expect(a.mask).not.toBe(c.mask);
  });

  it('tml:bind-clip-path switches the mask on and off', () => {
    const b = backend();
    const state = reactive({ open: false });
    const scene = mount({
      base: svg(defs + '<g id="w"><rect width="300" height="300"/></g>'),
      heir: heir(`<tml:ref id="w" tml:bind-clip-path="state.open ? 'url(#m)' : 'none'"/>`),
      backend: b,
      context: { state },
    });
    const w = scene.byId.get('w') as Container;
    expect(w.mask).toBeFalsy();
    expect(bounds(b, w)).toEqual([0, 0, 300, 300]);
    state.open = true;
    expect(w.mask).toBeInstanceOf(Graphics);
    expect(bounds(b, w)).toEqual([10, 20, 50, 40]);
    state.open = false;
    expect(w.mask).toBeFalsy();
    expect(w.children).toHaveLength(1); // the old mask Graphics is gone
    expect(bounds(b, w)).toEqual([0, 0, 300, 300]);
  });

  it('a bound url to a missing clipPath is an error', () => {
    const state = reactive({ open: true });
    const e = thrown(() =>
      mount({
        base: svg(defs + '<g id="w"/>'),
        heir: heir(`<tml:ref id="w" tml:bind-clip-path="state.open ? 'url(#nope)' : 'none'"/>`),
        backend: backend(),
        context: { state },
      }),
    );
    expect(e).toMatchObject({ code: 'E_CLIP_PATH' });
    expect(e.message).toContain('<clipPath id="nope">');
  });

  it('a static reference error stops mount with the list', () => {
    const e = thrown(() => mount({ base: svg('<g id="w" clip-path="url(#m)"/>'), backend: backend(), context: {} }));
    expect(e).toMatchObject({ code: 'E_CLIP_PATH' });
    expect(e.errors).toHaveLength(1);
    expect(e.errors![0]).toContain('#w: clip-path="url(#m)"');
  });
});

describe('PixiBackend v0.7 — getProp, href on a group', () => {
  it('getProp reads what setProp writes', () => {
    const b = backend();
    const g = b.createNode('g', { transform: 'translate(3 4) rotate(90) scale(2)' });
    expect(b.getProp(g, 'x')).toBe(3);
    expect(b.getProp(g, 'rotation') as number).toBeCloseTo(Math.PI / 2);
    expect(b.getProp(g, 'scale.y') as number).toBeCloseTo(2);
  });

  it('href on a rig part swaps its one image; several images — an error', () => {
    const b = backend();
    const part = b.createNode('g', {});
    const img = b.createNode('image', { href: 'v07/head-a.png', width: '10', height: '10' }) as Sprite;
    b.addChild(part, img);
    b.setProp(part, 'href', 'v07/head-b.png');
    expect(img.texture).toBe(Assets.cache.get('v07/head-b.png'));
    b.addChild(part, b.createNode('image', { href: 'v07/head-a.png' }));
    const e = thrown(() => b.setProp(part, 'href', 'v07/head-a.png'));
    expect(e).toMatchObject({ code: 'E_BACKEND' });
    expect(e.message).toContain('2 <image>');
  });
});
