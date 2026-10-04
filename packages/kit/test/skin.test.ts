// The skin format (validation), roles → looks, scene hrefs through the skin.
import { describe, expect, it } from 'vitest';
import { DEFAULT_SKIN } from '../src/ui/skin/default.js';
import { validateSkin, type SkinJson } from '../src/ui/skin/format.js';
import { FILL_PREFIX, NONE_HREF, Skin, artTable, createSkin } from '../src/ui/skin/skin.js';
import { KitBackend } from '../src/ui/kit-backend.js';
import type { Sprite } from 'pixi.js';

const art: SkinJson = {
  ...DEFAULT_SKIN,
  name: 'test',
  colors: { ...DEFAULT_SKIN.colors, navy: '#1d3557' },
  slice: { default: 'height', 'kit/panel.png': 1.6 },
  stretch: ['kit/btn.png', 'kit/panel.png'],
  files: {
    'kit/btn.png': { size: [300, 90], slice: [40, 30, 40, 30] },
    'kit/panel.png': { size: [500, 260], slice: [28, 60, 26, 24] },
    'kit/icon-back.png': { size: [120, 120] },
  },
};
const map = { roles: { 'button.primary': 'kit/btn.png', panel: 'kit/panel.png', ui_x: null, ui_back: { fill: 'navy' }, old_art: { keep: 'no pair' } } };
const table = { 'kit/btn.png': '/a/btn.webp', 'kit/panel.png': '/a/panel.webp', 'kit/icon-back.png': '/a/back.webp' };

describe('skin format', () => {
  it('the default skin is valid and procedural (no roles, no files)', () => {
    expect(validateSkin(DEFAULT_SKIN)).toEqual([]);
    expect(new Skin({ json: DEFAULT_SKIN }).urls()).toEqual([]);
  });
  it('reports every problem', () => {
    const bad = {
      ...art,
      colors: { ...art.colors, broken: 'red' },
      slotIcon: 'sepia',
      states: { pressed: { scale: 0.8 }, disabled: art.states.disabled },
      files: { ...art.files, 'kit/btn.png': { size: [60, 40], slice: [40, 30, 40, 30] } },
    } as unknown as SkinJson;
    const errors = validateSkin(bad, { roles: { a: 'kit/missing.png', b: { fill: 'nope' }, c: 3 as never } });
    expect(errors.join('\n')).toMatch(/colors.broken/);
    expect(errors.join('\n')).toMatch(/slotIcon: "sepia"/);
    expect(errors.join('\n')).toMatch(/states.pressed/);
    expect(errors.join('\n')).toMatch(/do not fit 60×40/);
    expect(errors.join('\n')).toMatch(/kit\/missing.png: not in skin.json files/);
    expect(errors.join('\n')).toMatch(/fill token "nope"/);
    expect(errors.join('\n')).toMatch(/roles.c: a file, null/);
  });
  it('createSkin fails loud on an invalid skin or a role without a URL', () => {
    expect(() => createSkin({ json: { ...art, slotIcon: 'x' as never } })).toThrow(/slotIcon/);
    expect(() => createSkin({ json: art, map, art: {} })).toThrow(/button.primary → "kit\/btn.png" has no bundle URL/);
  });
});

describe('Skin', () => {
  const skin = createSkin({ json: art, map, art: table, root: 'art/ui/', hrefRole: (h) => h.match(/^ui\/(\w+)\.webp$/)?.[1] });
  it('looks: art (with 9-slice), fill, none; unmapped → null (procedural)', () => {
    expect(skin.look('button.primary')).toMatchObject({ kind: 'art', url: '/a/btn.webp', size: [300, 90], slice: [40, 30, 40, 30] });
    expect(skin.look('ui_back')).toEqual({ kind: 'fill', role: 'ui_back', color: 0x1d3557, token: 'navy' });
    expect(skin.look('ui_x')).toEqual({ kind: 'none', role: 'ui_x' });
    expect(skin.look('badge')).toBeNull();
    expect(skin.look('old_art')).toBeNull();
    expect(skin.lookAny(['button.green', 'button.primary'])?.kind).toBe('art');
  });
  it('hrefs: skin:<role>, root files, the game role convention; others pass', () => {
    expect(skin.resolve('skin:panel')).toBe('/a/panel.webp');
    expect(skin.resolve('../art/ui/kit/icon-back.png')).toBe('/a/back.webp');
    expect(skin.resolve('ui/ui_x.webp')).toBe(NONE_HREF);
    expect(skin.resolve('ui/ui_back.webp')).toBe(FILL_PREFIX + 'navy');
    expect(skin.resolve('ui/old_art.webp')).toBeUndefined();
    expect(skin.resolve('levels/a1/back.webp')).toBeUndefined();
    expect(() => skin.resolve('skin:badge')).toThrow(/role "badge" is not in the skin map/);
    expect(() => skin.resolve('art/ui/kit/nope.png')).toThrow(/no art "kit\/nope.png"/);
  });
  it('tokens, radii, 9-slice scale, art meta', () => {
    expect(skin.color('navy')).toBe(0x1d3557);
    expect(() => skin.color('nope')).toThrow(/unknown colour token "nope"/);
    expect(skin.radius('button', 80)).toBe(40);
    expect(skin.radius('panel', 40)).toBe(20);
    expect(skin.sliceScale('kit/panel.png', 260, 400)).toBe(1.6);
    expect(skin.sliceScale('kit/btn.png', 90, 45)).toBe(0.5);
    expect(skin.artMeta('/a/btn.webp')).toMatchObject({ file: 'kit/btn.png', size: [300, 90] });
    expect(skin.artMeta('/other.webp')).toBeNull();
    expect(skin.urls().sort()).toEqual(['/a/btn.webp', '/a/panel.webp']);
    expect(skin.pressedTint()).toBe(0xd9d9d9);
  });
  it('a fill keeps its box through the base resizes (Trempel v1.0 stretch, setSize)', () => {
    const backend = new KitBackend({ skin });
    const dim = backend.createNode('image', { href: FILL_PREFIX + 'navy', x: '0', y: '0', width: '1024', height: '2048' }) as Sprite;
    expect([dim.width, dim.height]).toEqual([1024, 2048]);
    backend.setProp(dim, 'width', 1280);
    backend.setProp(dim, 'height', 2560);
    expect([dim.width, dim.height]).toEqual([1280, 2560]);
    expect(dim.tint).toBe(0x1d3557);
  });
  it('artTable maps glob keys to skin files', () => {
    expect(artTable({ '../scenes/skin/kit/btn.webp': '/x.webp', '../other/y.png': '/y' }, 'skin/', '.png')).toEqual({ 'kit/btn.png': '/x.webp' });
  });
});

describe('9-slice measurement (trempel-skin)', () => {
  it('a rounded plate with a rim: borders hold the corner and the rim, the middle stretches', async () => {
    const { measureSlice, premultiply } = await import('../src/ui/skin/measure.js');
    // 100×40: 3 px transparent margin, a 4 px dark rim, cream inside.
    const w = 100;
    const h = 40;
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const d = Math.min(x, y, w - 1 - x, h - 1 - y);
        const i = (y * w + x) * 4;
        if (d < 3) continue;
        const c = d < 7 ? [40, 30, 20] : [250, 240, 220];
        rgba.set([...c, 255], i);
      }
    const [l, t, r, b] = measureSlice(premultiply(rgba, w, h));
    expect([l, t, r, b]).toEqual([9, 9, 9, 9]); // 3 margin + 4 rim + 2 safety
  });
});
