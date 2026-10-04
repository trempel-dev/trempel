// v1.1 flatten: a scene → one vanilla SVG — prefabs expanded with prefixed ids, slots filled, 9-slice
// pieces (borders 1:1, scaled down like Pixi when the box is small), tiles, anchors / stretches of a
// resizable instance laid out, tint as a filter, data-z order, clips, expressions at a state (or the
// base's values), components left as their base with a warning; no tml:, data-*, @ in the output.

import { describe, it, expect } from 'vitest';
import { DOMParser } from '@xmldom/xmldom';
import { flattenLeftovers, flattenScene, type SceneSource } from '../src/core';
import { imageSizeOf } from '../src/node/imagesize';

const NS = 'xmlns="http://www.w3.org/2000/svg" xmlns:tml="https://trempel.dev/ns/scene"';
const svg = (body: string, root = ' viewBox="0 0 400 300"'): string => `<svg ${NS}${root}>${body}</svg>`;

const PANEL: SceneSource = {
  base: svg(
    `<image id="bg" href="art/panel.png" width="100" height="60" data-slices="10 8 10 8"/>` +
      `<text id="title" x="50" y="20" data-anchor="0.5 0">Title</text>` +
      `<g id="content"/>`,
    ' viewBox="0 0 100 60" data-resizable="xy" data-title="Title"',
  ),
  heir: `<svg ${NS} tml:extends="panel.svg"><tml:ref id="title" tml:bind="self.title"/><tml:ref id="content" tml:slot="content default"/></svg>`,
};
const docs: Record<string, SceneSource> = { '/p/ui/panel.svg': PANEL, '/skin/panel.svg': PANEL };
const sizes: Record<string, { w: number; h: number }> = { '/p/ui/art/panel.png': { w: 40, h: 30 }, '/skin/art/panel.png': { w: 40, h: 30 }, '/p/art/tile.png': { w: 16, h: 16 } };

function flat(base: string, extra: Partial<Parameters<typeof flattenScene>[0]> = {}) {
  return flattenScene({
    base,
    path: '/p/scene.svg',
    baseUrl: '/p/scene.svg',
    loadScene: (url) => docs[url] ?? null,
    imageSize: (h) => sizes[h] ?? null,
    mapHref: (h) => h.replace(/^\/p\//, ''),
    ...extra,
  });
}

const parse = (s: string): Document => {
  const errors: string[] = [];
  const doc = new DOMParser({ onError: (level, msg) => level !== 'warning' && errors.push(msg) }).parseFromString(s, 'image/svg+xml') as unknown as Document;
  expect(errors).toEqual([]);
  return doc;
};

describe('flatten', () => {
  it('a resizable instance: 9 slice pieces at its size, the anchored title moved, slot content in, ids prefixed', () => {
    const r = flat(svg(`<use id="pop" href="ui/panel.svg" x="20" y="10" width="200" height="100" data-title="Pause"><rect id="ok" slot="content" x="5" y="5" width="10" height="10" fill="red"/></use>`));
    expect(r.errors).toEqual([]);
    const doc = parse(r.svg!);
    expect(flattenLeftovers(r.svg!)).toEqual([]);
    const g = doc.getElementById('pop')!;
    expect(g.getAttribute('transform')).toBe('translate(20 10)');
    const pieces = [...(doc.getElementById('pop/bg')!.getElementsByTagName('svg') as unknown as Element[])];
    expect(pieces).toHaveLength(9);
    expect(pieces.map((p) => [p.getAttribute('x'), p.getAttribute('width'), p.getAttribute('viewBox')]).slice(0, 3)).toEqual([
      ['0', '10', '0 0 10 8'],
      ['10', '180', '10 0 20 8'],
      ['190', '10', '30 0 10 8'],
    ]);
    expect(pieces[8].getAttribute('y')).toBe('92');
    const title = doc.getElementById('pop/title')!;
    expect(title.textContent).toBe('Pause');
    expect(title.getAttribute('transform')).toBe('translate(50 0)'); // anchor 0.5 × (200 − 100)
    expect(doc.getElementById('ok')!.parentNode!.nodeName).toBe('g'); // the slot group
    expect(r.svg).not.toContain('data-');
  });

  it('borders scale down (Pixi rule) when the box is smaller than them', () => {
    const r = flat(svg(`<image id="b" href="ui/art/panel.png" x="0" y="0" width="10" height="100" data-slices="10 8 10 8"/>`));
    const pieces = [...(parse(r.svg!).getElementsByTagName('svg') as unknown as Element[])].slice(1);
    expect(pieces[0].getAttribute('width')).toBe('5'); // k = 10 / 20
  });

  it('a collection prefab: hrefs resolved and mapped; tile → pattern; tint → filter; data-z order', () => {
    const r = flat(
      svg(
        `<use id="c" href="@skin/panel.svg"/>` +
          `<image id="t" href="art/tile.png" width="64" height="32" data-tile="x"/>` +
          `<g id="z"><rect id="r1" width="1" height="1" data-z="2"/><rect id="r2" width="1" height="1"/></g>` +
          `<image id="tinted" href="art/tile.png" width="16" height="16" data-tint="#ff0000"/>`,
      ),
      { collections: { skin: '/skin' } },
    );
    expect(r.errors).toEqual([]);
    expect(r.collections).toEqual(['skin']);
    expect(r.svg).toContain('href="/skin/art/panel.png"');
    const doc = parse(r.svg!);
    const pattern = doc.getElementsByTagName('pattern')[0];
    expect(pattern.getAttribute('width')).toBe('16');
    expect(pattern.getAttribute('height')).toBe('32');
    const z = doc.getElementById('z')!;
    expect([...(z.childNodes as unknown as Element[])].map((n) => n.getAttribute('id'))).toEqual(['r2', 'r1']);
    expect(doc.getElementById('tinted')!.getAttribute('filter')).toMatch(/^url\(#flat-tint-\d+\)$/);
    expect(r.svg).toContain('values="1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0"');
  });

  it('expressions: at the state; without it (or a host function) the base value stays', () => {
    const heir = `<svg ${NS}><tml:ref id="a" tml:bind="state.score"/><tml:ref id="b" tml:bind="t('x')"/></svg>`;
    const base = svg(`<text id="a">0</text><text id="b">copy</text>`);
    const at = flattenScene({ base, heir, state: { score: 42 } });
    expect(at.svg).toContain('<text id="a">42</text>');
    expect(at.svg).toContain('<text id="b">copy</text>');
    const none = flattenScene({ base, heir });
    expect(none.svg).toContain('<text id="a">0</text>');
  });

  it('components with code stay as their base, listed; clips of a node become a <clipPath>', () => {
    const base = svg(`<defs><clipPath id="m"><rect width="5" height="5"/></clipPath></defs><g id="reels" data-cols="3"><rect width="9" height="9"/></g><g id="masked" clip-path="url(#m)"><rect width="9" height="9"/></g>`);
    const heir = `<svg ${NS}><tml:ref id="reels" tml:type="reel-grid"/></svg>`;
    const r = flattenScene({ base, heir });
    expect(r.warnings.join('\n')).toMatch(/компоненты с кодом нарисованы своей базой.*#reels \(reel-grid\)/);
    const doc = parse(r.svg!);
    expect(doc.getElementById('masked')!.getAttribute('clip-path')).toMatch(/^url\(#flat-clip-\d+\)$/);
    expect(doc.getElementsByTagName('clipPath')).toHaveLength(1);
  });

  it('an unknown collection: an error, nothing written', () => {
    const r = flattenScene({ base: svg(`<image id="a" href="@nope/a.png" width="1" height="1"/>`) });
    expect(r.svg).toBeNull();
    expect(r.errors.join('\n')).toMatch(/коллекции @nope нет/);
  });
});

describe('imageSizeOf', () => {
  it('PNG / GIF / SVG headers', () => {
    const png = Buffer.alloc(24);
    png.writeUInt32BE(0x89504e47, 0);
    png.write('IHDR', 12, 'ascii');
    png.writeUInt32BE(320, 16);
    png.writeUInt32BE(200, 20);
    expect(imageSizeOf(png)).toEqual({ w: 320, h: 200 });
    const gif = Buffer.from('GIF89a\x10\x00\x20\x00', 'latin1');
    expect(imageSizeOf(gif)).toEqual({ w: 16, h: 32 });
    expect(imageSizeOf(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 12"/>'))).toEqual({ w: 24, h: 12 });
  });
});
