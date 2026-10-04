// PixiBackend against real PixiJS display objects, headless: nothing here renders or measures
// glyphs (font metrics are injected), so Node is enough.

import { describe, it, expect, beforeAll } from 'vitest';
import { Assets, Container, Graphics, Sprite, Text, Texture, TextureSource } from 'pixi.js';
import { PixiBackend } from '../src/render/pixi';
import { TrempelError } from '../src/errors';

// ascent 80 + descent 20 per 100px: the baseline sits at 80% of an unstroked line.
const metrics = (font: string): { ascent: number; descent: number } => {
  const px = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 0);
  return { ascent: px * 0.8, descent: px * 0.2 };
};
const backend = (): PixiBackend => new PixiBackend({ metrics, fontFamily: 'Alegreya SC' });

const tex = (w: number, h: number): Texture => new Texture({ source: new TextureSource({ width: w, height: h }) });

beforeAll(() => {
  Assets.cache.set('test/200x100.png', tex(200, 100));
  Assets.cache.set('test/50x50.png', tex(50, 50));
});

describe('PixiBackend — transform', () => {
  it('translate on a group', () => {
    const g = backend().createNode('g', { transform: 'translate(379,157)' }) as Container;
    expect([g.x, g.y]).toEqual([379, 157]);
  });

  it('rotate + scale chain decomposes onto the container', () => {
    const g = backend().createNode('g', { transform: 'translate(10 20) rotate(90) scale(2 3)' }) as Container;
    expect(g.x).toBeCloseTo(10);
    expect(g.y).toBeCloseTo(20);
    expect(g.rotation).toBeCloseTo(Math.PI / 2);
    expect(g.scale.x).toBeCloseTo(2);
    expect(g.scale.y).toBeCloseTo(3);
  });

  it('matrix (as editors write it), skew included', () => {
    const g = backend().createNode('g', { transform: 'matrix(1 0 1 1 5 6)' }) as Container; // skewX(45)
    const m = g.localTransform;
    g.updateLocalTransform();
    expect([m.a, m.b, m.c, m.d, m.tx, m.ty].map((v) => +v.toFixed(6))).toEqual([1, 0, 1, 1, 5, 6]);
  });

  it('x/y of a shape sit inside its transform (SVG semantics)', () => {
    const r = backend().createNode('rect', { x: '10', y: '0', width: '4', height: '4', transform: 'scale(2)' }) as Graphics;
    expect([r.x, r.y, r.scale.x]).toEqual([20, 0, 2]);
  });

  it('a bad transform is a hard error', () => {
    expect(() => backend().createNode('g', { transform: 'perspective(1)' })).toThrow(/не поддерживается/);
  });
});

describe('PixiBackend — opacity and visibility on any node', () => {
  it.each(['g', 'rect', 'text', 'image'])('<%s opacity>', (tag) => {
    const n = backend().createNode(tag, { opacity: '0.25' }) as Container;
    expect(n.alpha).toBe(0.25);
  });

  it('display="none" / visibility="hidden"', () => {
    expect((backend().createNode('g', { display: 'none' }) as Container).visible).toBe(false);
    expect((backend().createNode('rect', { visibility: 'hidden' }) as Container).visible).toBe(false);
  });
});

describe('PixiBackend — text', () => {
  const text = (attrs: Record<string, string>): Text => backend().createNode('text', attrs) as Text;

  it('font-family / font-weight / font-style / size / fill', () => {
    const t = text({ 'font-family': 'Georgia', 'font-weight': 'bold', 'font-style': 'italic', 'font-size': '34', fill: '#ffe08a' });
    expect(t.style.fontFamily).toBe('Georgia');
    expect(t.style.fontWeight).toBe('bold');
    expect(t.style.fontStyle).toBe('italic');
    expect(t.style.fontSize).toBe(34);
    expect(t.style.fill).toMatchObject({ color: 0xffe08a, alpha: 1 });
  });

  it('falls back to the backend font family; fill defaults to black like SVG', () => {
    const t = text({});
    expect(t.style.fontFamily).toBe('Alegreya SC');
    expect(t.style.fill).toMatchObject({ color: 0x000000, alpha: 1 });
  });

  it('short hex and named colours parse', () => {
    expect(text({ fill: "#fff" }).style.fill).toMatchObject({ color: 0xffffff });
    expect(text({ fill: "red" }).style.fill).toMatchObject({ color: 0xff0000 });
    expect(text({ fill: "#fff", "fill-opacity": "0.5" }).style.fill).toMatchObject({ alpha: 0.5 });
  });

  it('stroke + stroke-width', () => {
    const t = text({ stroke: '#000', 'stroke-width': '4' });
    expect(t.style.stroke).toMatchObject({ color: 0x000000, width: 4 });
  });

  it('text-anchor → anchor.x', () => {
    expect(text({}).anchor.x).toBe(0);
    expect(text({ 'text-anchor': 'middle' }).anchor.x).toBe(0.5);
    expect(text({ 'text-anchor': 'end' }).anchor.x).toBe(1);
  });

  it('y is the baseline: anchor.y = (ascent + stroke/2) / (ascent + descent + stroke)', () => {
    const t = text({ x: '640', y: '300', 'font-size': '100' });
    expect([t.x, t.y]).toEqual([640, 300]); // the node sits at y; the anchor lifts the glyphs
    expect(t.anchor.y).toBeCloseTo(0.8);
    expect(text({ 'font-size': '100', stroke: '#000', 'stroke-width': '10' }).anchor.y).toBeCloseTo(85 / 110);
  });

  it('dominant-baseline middle / hanging', () => {
    expect(text({ 'dominant-baseline': 'middle' }).anchor.y).toBe(0.5);
    expect(text({ 'dominant-baseline': 'central' }).anchor.y).toBe(0.5);
    expect(text({ 'dominant-baseline': 'hanging' }).anchor.y).toBe(0);
  });

  it('without metrics (no canvas) uses the configurable baseline ratio', () => {
    const t = new PixiBackend({ metrics: () => { throw new Error('no canvas'); }, baselineRatio: 0.75 })
      .createNode('text', {}) as Text;
    expect(t.anchor.y).toBe(0.75);
  });
});

describe('PixiBackend — rect', () => {
  const rect = (attrs: Record<string, string>): Graphics =>
    backend().createNode('rect', { width: '100', height: '40', ...attrs }) as Graphics;

  it('rx → rounded rect; fill-opacity and stroke reach the context', () => {
    const g = rect({ rx: '8', fill: '#3a1420', 'fill-opacity': '0.5', stroke: '#ffd77a', 'stroke-width': '3' });
    const ins = g.context.instructions;
    const fill = ins.find((i) => i.action === 'fill') as { data: { style: { color: number; alpha: number } } };
    const stroke = ins.find((i) => i.action === 'stroke') as { data: { style: { color: number; width: number } } };
    expect(fill.data.style.color).toBe(0x3a1420);
    expect(fill.data.style.alpha).toBe(0.5);
    expect(stroke.data.style.color).toBe(0xffd77a);
    expect(stroke.data.style.width).toBe(3);
    const path = (fill.data as unknown as { path: { shapePath: { shapePrimitives: { shape: { type: string; radius: number } }[] } } })
      .path.shapePath.shapePrimitives[0].shape;
    expect(path.type).toBe('roundedRectangle');
    expect(path.radius).toBe(8);
  });

  it('fill="none" draws no fill', () => {
    const g = rect({ fill: 'none', stroke: '#fff' });
    expect(g.context.instructions.map((i) => i.action)).toEqual(['stroke']);
  });

  it('bounds follow width/height', () => {
    const b = rect({ x: '5', y: '6' }).getBounds();
    expect([b.x, b.y, b.width, b.height]).toEqual([5, 6, 100, 40]);
  });
});

describe('PixiBackend — images and readiness', () => {
  it('a cached texture applies synchronously and is sized to width/height', () => {
    const s = backend().createNode('image', { href: 'test/200x100.png', x: '10', y: '20', width: '100', height: '100' }) as Sprite;
    expect(s.texture.orig.width).toBe(200);
    expect([s.x, s.y]).toEqual([10, 20]);
    expect(s.scale.x).toBeCloseTo(0.5);
    expect(s.scale.y).toBeCloseTo(1);
    expect([s.width, s.height].map(Math.round)).toEqual([100, 100]);
  });

  it('width/height combine with the transform instead of overriding it', () => {
    const s = backend().createNode('image', { href: 'test/50x50.png', width: '100', height: '100', transform: 'scale(2)' }) as Sprite;
    expect(s.scale.x).toBeCloseTo(4);
  });

  it('an image without width/height keeps its natural size (scale 1)', () => {
    const s = backend().createNode('image', { href: 'test/200x100.png' }) as Sprite;
    expect(s.scale.x).toBe(1);
  });

  it('setProp(href) swaps a cached texture immediately and re-applies the size', () => {
    const b = backend();
    const s = b.createNode('image', { href: 'test/200x100.png', width: '100', height: '100' }) as Sprite;
    b.setProp(s, 'href', 'test/50x50.png');
    expect(s.texture.orig.width).toBe(50);
    expect(s.scale.x).toBeCloseTo(2);
  });

  it('whenReady resolves with nothing in flight', async () => {
    await expect(backend().whenReady()).resolves.toBeUndefined();
  });

  it('whenReady waits for loads and rejects listing every failed href once', async () => {
    const b = backend();
    // Node has no document/fetch for Pixi's loader → these loads fail.
    b.createNode('image', { href: 'missing/a.png' });
    b.createNode('image', { href: 'missing/b.png' });
    const err = await b.whenReady().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TrempelError);
    expect((err as TrempelError).errors).toEqual([
      'Текстура не загрузилась: "missing/a.png".',
      'Текстура не загрузилась: "missing/b.png".',
    ]);
    await expect(b.whenReady()).resolves.toBeUndefined(); // failures are reported once
  });
});

describe('PixiBackend — image without a texture', () => {
  it('keeps the SVG width/height as its box before the texture arrives', () => {
    const img = backend().createNode('image', { href: 'test/not-cached.png', x: '-210', y: '-71', width: '420', height: '114' }) as Sprite;
    const b = img.getBounds();
    expect(Math.round(b.width)).toBe(420);
    expect(Math.round(b.height)).toBe(114);
    expect(Math.round(b.x)).toBe(-210);
  });
  it('swaps to the real fit when the texture is cached', () => {
    const img = backend().createNode('image', { href: 'test/200x100.png', width: '400' }) as Sprite;
    expect(Math.round(img.getBounds().width)).toBe(400);
    expect(Math.round(img.getBounds().height)).toBe(200);
  });
});
