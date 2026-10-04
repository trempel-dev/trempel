// v1.0: 9-slice (data-slices / data-tile), anchors and stretch in the format (data-anchor /
// data-stretch / data-size), resizable prefabs (data-resizable, <use width height>), slots
// (tml:slot), the contract's anchor / slices / resizable / slot, clip columns width / height.

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { Assets, Container, Graphics, NineSliceSprite, Sprite, Texture, TextureSource, TilingSprite } from 'pixi.js';
import { PixiBackend } from '../src/render/pixi';
import { Animator, compileClips, composeScene, mount, parseContract, TrempelError, type SceneSource } from '../src/core';
import { checkContract } from '../src/contract';
import { layoutErrors, parseSlices } from '../src/layout';
import { createMockBackend, createMockClock, isMockNode, type MockNode } from './helpers/mockBackend';

const NS = 'xmlns="http://www.w3.org/2000/svg" xmlns:tml="https://trempel.dev/ns/scene"';
const svg = (body: string, root = '', vb = '0 0 800 600'): string => `<svg ${NS} viewBox="${vb}"${root}>${body}</svg>`;
const heirOf = (ext: string, body: string, root = ''): string => `<svg ${NS} tml:extends="${ext}"${root}>${body}</svg>`;
const metrics = (): { ascent: number; descent: number } => ({ ascent: 8, descent: 2 });
const tex = (w: number, h: number): Texture => new Texture({ source: new TextureSource({ width: w, height: h }) });

beforeAll(() => {
  Assets.cache.set('v10/panel.png', tex(60, 60));
  Assets.cache.set('v10/tile.png', tex(16, 8));
  Assets.cache.set('v10/photo.png', tex(100, 50));
});
afterEach(() => vi.restoreAllMocks());

const errorsOf = (fn: () => unknown): string[] => {
  try {
    fn();
    return [];
  } catch (e) {
    if (e instanceof TrempelError) return e.errors;
    throw e;
  }
};

/** A resizable panel: 9-slice background, centred title, a close button at the top right, a content slot. */
const PANEL: SceneSource = {
  base: svg(
    `<image id="bg" href="../v10/panel.png" width="200" height="120" data-slices="20"/>` +
      `<text id="title" x="100" y="30" text-anchor="middle" data-anchor="0.5 0">Title</text>` +
      `<rect id="close" x="160" y="10" width="30" height="30" data-anchor="1 0"/>` +
      `<g id="content" transform="translate(20 50)"/>`,
    ' data-resizable="xy" data-title="Title"',
    '0 0 200 120',
  ),
  heir: heirOf('panel.svg', `<tml:ref id="title" tml:bind="self.title"/><tml:ref id="content" tml:slot="content default"/>`),
  contract: `<contract resizable="xy" params="data-title"><image id="bg" slices="true"/><text id="title" anchor="0.5 0"/><g id="content" slot="true"/></contract>`,
};
const BUTTON: SceneSource = {
  base: svg(`<rect id="bg" width="100" height="40"/><text id="label" x="50" y="25">B</text>`, ' data-label="B"', '0 0 100 40'),
  heir: heirOf('button.svg', `<tml:ref id="label" tml:bind="self.label"/>`),
};
const files: Record<string, SceneSource> = { 'ui/panel.svg': PANEL, 'ui/button.svg': BUTTON };
const loader = (fs: Record<string, SceneSource> = files) => (url: string): SceneSource | null => fs[url] ?? null;

describe('v1.0 — data-slices / data-tile (PixiBackend)', () => {
  it('parses 1 / 2 / 4 values', () => {
    expect(parseSlices('12')).toEqual([12, 12, 12, 12]);
    expect(parseSlices('10 20')).toEqual([10, 20, 10, 20]);
    expect(parseSlices('1 2 3 4')).toEqual([1, 2, 3, 4]);
    expect(() => parseSlices('1 2 3')).toThrow(/l t r b/);
    expect(() => parseSlices('-1')).toThrow();
  });

  it('data-slices → NineSliceSprite sized by width/height, borders 1:1 (scale 1)', async () => {
    const backend = new PixiBackend({ metrics });
    const s = mount({ base: svg(`<image id="p" href="v10/panel.png" x="5" y="7" width="300" height="90" data-slices="10 12 14 16"/>`), backend, context: {} });
    await s.ready;
    const n = s.byId.get('p') as NineSliceSprite;
    expect(n).toBeInstanceOf(NineSliceSprite);
    expect([n.width, n.height]).toEqual([300, 90]);
    expect([n.scale.x, n.scale.y]).toEqual([1, 1]);
    expect([n.leftWidth, n.topHeight, n.rightWidth, n.bottomHeight]).toEqual([10, 12, 14, 16]);
    expect([n.x, n.y]).toEqual([5, 7]);
  });

  it('slices that leave no centre are a load error (ready rejects)', async () => {
    const backend = new PixiBackend({ metrics });
    const s = mount({ base: svg(`<image id="p" href="v10/panel.png" width="300" height="90" data-slices="30 10"/>`), backend, context: {} });
    await expect(s.ready).rejects.toThrow(/#p: data-slices="30 10 30 10" не помещаются в текстуру 60×60/);
  });

  it('data-slices on a non-image, malformed values, with data-tile — mount errors', () => {
    const errs = errorsOf(() =>
      mount({
        base: svg(`<rect id="r" width="10" height="10" data-slices="2"/><image id="i" href="v10/panel.png" data-slices="a"/><image id="t" href="v10/tile.png" data-slices="2" data-tile="x"/>`),
        backend: createMockBackend(),
        context: {},
      }),
    );
    expect(errs.join('\n')).toMatch(/#r: data-slices на <rect>/);
    expect(errs.join('\n')).toMatch(/#i: data-slices="a"/);
    expect(errs.join('\n')).toMatch(/#t: data-slices и data-tile вместе не бывают/);
  });

  it('data-tile → TilingSprite; "x" stretches the texture vertically', async () => {
    const backend = new PixiBackend({ metrics });
    const s = mount({ base: svg(`<image id="t" href="v10/tile.png" width="160" height="32" data-tile="x"/>`), backend, context: {} });
    await s.ready;
    const n = s.byId.get('t') as TilingSprite;
    expect(n).toBeInstanceOf(TilingSprite);
    expect([n.width, n.height]).toEqual([160, 32]);
    expect([n.tileScale.x, n.tileScale.y]).toEqual([1, 4]);
  });

  it('setProp width/height: 9-slice resizes itself, a sprite refits, a rect redraws', async () => {
    const backend = new PixiBackend({ metrics });
    const s = mount({
      base: svg(`<image id="p" href="v10/panel.png" width="100" height="100" data-slices="10"/><image id="s" href="v10/photo.png" width="100" height="50"/><rect id="r" width="10" height="10"/>`),
      backend,
      context: {},
    });
    await s.ready;
    s.setSize('p', 250, 80);
    s.setSize('s', 200);
    s.setSize('r', 40, 20);
    const p = s.byId.get('p') as NineSliceSprite;
    const sp = s.byId.get('s') as Sprite;
    expect([p.width, p.height, p.scale.x]).toEqual([250, 80, 1]);
    expect([sp.width, sp.height]).toEqual([200, 50]);
    const r = s.byId.get('r') as Graphics;
    expect([r.width, r.height]).toEqual([40, 20]);
    expect(backend.getProp(r, 'width')).toBe(40);
  });
});

describe('v1.0 — data-anchor / data-stretch / data-size', () => {
  const base = svg(
    `<rect id="dim" width="800" height="600" data-stretch="xy"/>` +
      `<g id="tr" transform="translate(760 20)" data-anchor="1 0"><rect width="10" height="10"/></g>` +
      `<text id="mid" x="400" y="300" data-anchor="0.5 0.5">M</text>` +
      `<g id="zone" data-size="200 100" data-stretch="x"><rect id="zr" x="180" width="20" height="20" data-anchor="1 0"/></g>`,
  );

  it('at the reference size nothing moves (vanilla SVG); resize(w, h) moves anchors, stretches', () => {
    const b = createMockBackend();
    const s = mount({ base, backend: b, context: {} });
    const p = (id: string): Record<string, unknown> => isMockNode(s.byId.get(id)!).props;
    expect(p('tr').x).toBe(760);
    expect(p('mid').x).toBe(400);
    s.resize(1000, 700);
    expect([p('tr').x, p('tr').y]).toEqual([960, 20]);
    expect([p('mid').x, p('mid').y]).toEqual([500, 350]);
    expect([p('dim').width, p('dim').height]).toEqual([1000, 700]);
    // a stretched data-size group is a box: its anchored child follows the grown width
    expect(p('zr').x).toBe(380);
    expect(s.sizeOf('zone')).toEqual({ w: 400, h: 100 });
    expect(s.sizeOf('')).toBeUndefined();
  });

  it('pixi: anchors keep the node transform, a stretched sprite keeps its offset', () => {
    const backend = new PixiBackend({ metrics });
    const s = mount({
      base: svg(`<g id="g" transform="translate(700 10) rotate(30)" data-anchor="1 1"/><image id="bg" href="v10/photo.png" x="10" y="10" width="780" height="580" data-stretch="xy"/>`),
      backend,
      context: {},
    });
    s.resize(900, 650);
    const g = s.byId.get('g') as Container;
    expect([g.x, g.y]).toEqual([800, 60]);
    expect(g.rotation).toBeCloseTo(Math.PI / 6);
    const bg = s.byId.get('bg') as Sprite;
    expect([bg.x, bg.y, Math.round(bg.width), bg.height]).toEqual([10, 10, 880, 630]);
  });

  it('anchor without the parent size, bad values, stretch on a text — errors', () => {
    const errs = layoutErrors(
      composeScene({
        base: svg(`<g id="plain"><rect id="a" data-anchor="1 0" width="1" height="1"/></g><text id="t" data-stretch="x">x</text><rect id="b" data-anchor="1" width="1" height="1"/><g id="s" data-size="5"><rect id="c" data-anchor="0 0" width="1" height="1"/></g>`),
      }).tree!,
    ).join('\n');
    expect(errs).toMatch(/#a: якорь без размера родителя — #plain: дайте группе data-size/);
    expect(errs).toMatch(/#t: data-stretch на <text>/);
    expect(errs).toMatch(/#b: data-anchor="1" — ожидается «ax ay»/);
    expect(errs).toMatch(/#s: data-size="5"/);
  });

  it('data-size with one number is a component parameter until something asks for the box', () => {
    expect(layoutErrors(composeScene({ base: svg(`<g id="btn" data-size="120" data-anchor="0 0"/>`) }).tree!)).toEqual([]);
  });

  it('hit tests follow the layout', () => {
    const s = mount({ base: svg(`<rect id="r" x="700" y="0" width="100" height="50" data-anchor="1 0"/>`), backend: createMockBackend(), context: {} });
    expect(s.hitTest('r', 750, 10)).toBe(true);
    s.resize(1000, 600);
    expect(s.hitTest('r', 750, 10)).toBe(false);
    expect(s.hitTestAll(950, 10)).toEqual(['r']);
  });

  it('the contract: anchor="ax ay" must be present and equal', () => {
    const c = parseContract(`<contract><g id="a" anchor="1 0"/><g id="b" anchor="0.5 0.5"/><g id="c" anchor="0 1"/></contract>`);
    const tree = composeScene({ base: svg(`<g id="a" data-anchor="1 0"/><g id="b" data-anchor="0.5 0"/><g id="c"/>`) }).tree!;
    const errs = checkContract(tree, c);
    expect(errs).toEqual([
      '#b: data-anchor="0.5 0", а контракт ждёт «0.5 0.5».',
      '#c: нет data-anchor — контракт ждёт якорь «0 1».',
    ]);
  });
});

describe('v1.0 — resizable prefabs', () => {
  const scene = (use: string): string => svg(use);

  it('<use width height> of a resizable prefab: bg 9-slice to the size, title centred, close at the right', async () => {
    const backend = new PixiBackend({ metrics });
    const s = mount({ base: scene(`<use id="p" href="ui/panel.svg" x="10" y="20" width="400" height="300" data-title="Пауза"/>`), backend, context: {}, loadScene: loader() });
    await s.ready;
    const bg = s.byId.get('p/bg') as NineSliceSprite;
    expect(bg).toBeInstanceOf(NineSliceSprite);
    expect([bg.width, bg.height, bg.scale.x]).toEqual([400, 300, 1]);
    const title = s.byId.get('p/title') as Container;
    expect(title.x).toBe(200);
    expect((s.byId.get('p/close') as Container).x).toBe(360);
    expect(s.sizeOf('p')).toEqual({ w: 400, h: 300 });
    // resize the instance: the content follows
    s.setSize('p', 300);
    expect(bg.width).toBe(300);
    expect(title.x).toBe(150);
    expect(() => s.setSize('nope', 1)).toThrow(/узла с таким id/);
  });

  it('without a size — the minimum (viewBox); below the minimum — an error', () => {
    const c = composeScene({ base: scene(`<use id="p" href="ui/panel.svg"/><use id="q" href="ui/panel.svg" width="100"/>`), loadScene: loader() });
    expect(c.tree!.children[0].instance!.size).toEqual({ w: 200, h: 120 });
    expect(c.errors.prefab).toContain('#q: width="100" меньше минимального 200 (viewBox ui/panel.svg).');
  });

  it('width on a non-resizable prefab — the old error; on a wrong axis — which axes', () => {
    const ONEAXIS: SceneSource = { base: svg(`<image id="bg" href="v10/panel.png" width="100" height="40" data-slices="10"/>`, ' data-resizable="x"', '0 0 100 40') };
    const c = composeScene({
      base: scene(`<use id="b" href="ui/button.svg" width="200"/><use id="o" href="ui/one.svg" width="300" height="80"/>`),
      loadScene: loader({ ...files, 'ui/one.svg': ONEAXIS }),
    });
    expect(c.errors.prefab).toEqual([
      '#b: width на <use> — ui/button.svg не растягивается (нет data-resizable у корня); масштаб инстанса задаётся transform.',
      '#o: height — ui/one.svg растягивается только по x (data-resizable="x").',
    ]);
  });

  it('data-resizable without a stretching background — an error (and the contract checks resizable)', () => {
    const NOBG: SceneSource = { base: svg(`<image id="bg" href="v10/panel.png" width="100" height="40"/>`, ' data-resizable="xy"', '0 0 100 40') };
    const errs = errorsOf(() => mount({ base: scene(`<use id="n" href="ui/nobg.svg" width="200"/>`), backend: createMockBackend(), context: {}, loadScene: loader({ 'ui/nobg.svg': NOBG }) }));
    expect(errs.join('\n')).toMatch(/data-resizable без растягиваемого фона/);
    const c = parseContract('<contract resizable="xy"/>');
    expect(checkContract(composeScene({ base: svg('', ' data-resizable="x"') }).tree!, c)).toContain('корень <svg>: data-resizable="x", а контракт ждёт «xy».');
  });

  it('data-resizable is not a parameter', () => {
    const c = composeScene({ base: scene(`<use id="p" href="ui/panel.svg"/>`), loadScene: loader() });
    expect(Object.keys(c.tree!.children[0].instance!.params)).toEqual(['data-title']);
  });

  it('a prefab opened as a scene resizes with resize()', () => {
    const b = createMockBackend();
    const s = mount({ base: PANEL.base!, heir: PANEL.heir, contract: PANEL.contract, path: 'panel.svg', backend: b, context: {} });
    s.resize(300, 200);
    expect(isMockNode(s.byId.get('bg')!).props.width).toBe(300);
    expect(isMockNode(s.byId.get('close')!).props.x).toBe(260);
  });

  it('clips: width / height on the instance resize its box; on an image[data-slices] — the panel; else an error', () => {
    const tree = composeScene({ base: scene(`<use id="p" href="ui/panel.svg" data-title="x"/><image id="i" href="v10/photo.png" width="10" height="10"/><image id="s" href="v10/panel.png" width="100" height="100" data-slices="10"/>`), loadScene: loader() }).tree!;
    const md = `# $clip open\n\n## $track p\n| t | height |\n|---|---|\n| 0 | 120 |\n| 1 | 400 |\n\n## $track s\n| t | width |\n|---|---|\n| 0 | 100 |\n| 1 | 300 |\n`;
    const clips = compileClips(md, tree);
    expect(clips.open.tracks.map((t) => t.property)).toEqual(['height', 'width']);
    expect(() => compileClips(`# $clip bad\n\n## $track i\n| t | width |\n|---|---|\n| 0 | 1 |\n`, tree)).toThrow(/width\/height анимируются только у data-slices/);

    const b = createMockBackend();
    const s = mount({ base: scene(`<use id="p" href="ui/panel.svg" data-title="x"/><image id="s" href="v10/panel.png" width="100" height="100" data-slices="10"/>`), backend: b, context: {}, loadScene: loader() });
    const clock = createMockClock();
    const anim = new Animator(b, clock, (id) => s.byId.get(id));
    anim.play(clips.open);
    clock.t = 1000;
    anim.tick();
    expect(s.sizeOf('p')).toEqual({ w: 200, h: 400 });
    expect(isMockNode(s.byId.get('p/bg')!).props.height).toBe(400);
    expect(isMockNode(s.byId.get('p')!).props.height).toBeUndefined(); // the container is not scaled
    expect(isMockNode(s.byId.get('s')!).props.width).toBe(300);
  });
});

describe('v1.0 — slots', () => {
  const pause = (children: string, extra = ''): string =>
    svg(`<use id="pp" href="ui/panel.svg" width="400" height="500" data-title="Пауза"${extra}>${children}</use>`);

  it('children go into the slot: ids without the prefix, the scene context, nested instances expand', () => {
    const b = createMockBackend();
    const s = mount({
      base: pause(`<use id="resume" slot="content" href="ui/button.svg" y="10" data-label="Дальше"/><text id="note" y="80">x</text>`),
      heir: heirOf('scene.svg', `<tml:ref id="note" tml:bind="hint"/>`),
      backend: b,
      context: { hint: 'из сцены' },
      loadScene: loader(),
    });
    expect(s.byId.has('resume')).toBe(true);
    expect(s.byId.has('resume/label')).toBe(true);
    expect(s.byId.has('pp/resume')).toBe(false);
    expect(isMockNode(s.byId.get('note')!).props.text).toBe('из сцены');
    expect(isMockNode(s.byId.get('resume/label')!).props.text).toBe('Дальше');
    const content = isMockNode(s.byId.get('pp/content')!);
    expect(content.children.map((c: MockNode) => c.attrs.id ?? c.tag)).toEqual(['resume', 'note']);
  });

  it('expressions in slot children see the scene, not self', () => {
    const s = mount({ base: pause(`<text id="t" slot="content">x</text>`), heir: heirOf('scene.svg', `<tml:ref id="t" tml:bind="self ? 'self' : 'scene'"/>`), backend: createMockBackend(), context: { self: null }, loadScene: loader() });
    expect(isMockNode(s.byId.get('t')!).props.text).toBe('scene');
  });

  it('no default slot / unknown slot / a prefab without slots — errors', () => {
    const NAMED: SceneSource = { base: PANEL.base, heir: heirOf('named.svg', `<tml:ref id="content" tml:slot="content"/>`) };
    const fs = { ...files, 'ui/named.svg': NAMED };
    const c = composeScene({
      base: svg(`<use id="a" href="ui/named.svg"><g id="x"/></use><use id="b" href="ui/named.svg"><g id="y" slot="footer"/></use><use id="c" href="ui/button.svg"><g id="z"/></use>`),
      loadScene: loader(fs),
    });
    expect(c.errors.prefab).toEqual([
      '#a: #x без slot — у ui/named.svg нет слота по умолчанию (есть: content).',
      '#b: #y slot="footer" — у ui/named.svg такого слота нет (есть: content).',
      '#c: дети у <use> — у ui/button.svg нет слотов (tml:slot в наследнике префаба); настройка — параметрами data-*.',
    ]);
  });

  it('slot children are the scene base: sterility, contract by their own id', () => {
    const c = composeScene({
      base: pause(`<g id="body" slot="content" tml:bind="x"/>`),
      contract: `<contract><use id="pp" href="ui/panel.svg"/><g id="body"/></contract>`,
      loadScene: loader(),
    });
    expect(c.errors.contract.join('\n')).toMatch(/База не стерильна: #body/);
  });

  it('the prefab contract: slot="true" needs tml:slot in the heir', () => {
    const NOSLOT: SceneSource = { base: PANEL.base, contract: PANEL.contract };
    const c = composeScene({ base: svg(`<use id="p" href="ui/noslot.svg" data-title="x"/>`), loadScene: loader({ 'ui/noslot.svg': NOSLOT }) });
    expect(c.errors.prefab.join('\n')).toMatch(/#p \(ui\/noslot.svg\): #content: контракт ждёт слот/);
  });
});
