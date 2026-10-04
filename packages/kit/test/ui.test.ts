// UI kit: screen templates (merge + contract + kit components + strings), components headless
// (the ones without text: Pixi Text needs a DOM), popups.closeNow, overlays.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Container } from 'pixi.js';
import { PixiBackend, TrempelError, checkContract, mergeScene, parse, parseContract, parseHeir, type SceneNode } from '@trempel/scene';
import { assetTable, withCollections } from '../src/assets/loader.js';
import { Tweens } from '../src/anim/tweens.js';
import { KIT_STRINGS, withKitStrings } from '../src/data/kit-strings.js';
import { UI_COMPONENTS } from '../src/ui/components/index.js';
import { UIProgress, UISlider, UIStars } from '../src/ui/components/values.js';
import { UISlot, placeFrame, slotLook } from '../src/ui/components/slot.js';
import { Overlays } from '../src/ui/overlays.js';
import { Popups } from '../src/ui/popups.js';
import { UI_SCENES } from '../src/ui/scenes.js';
import { Screen } from '../src/ui/screen.js';
import { defaultSkin } from '../src/ui/skin/skin.js';

const walk = (n: SceneNode, f: (n: SceneNode) => void): void => {
  f(n);
  n.children.forEach((c) => walk(c, f));
};

describe('screen templates (UI_SCENES)', () => {
  it('generated file is current (scripts/ui-scenes.mjs)', () => {
    expect(() => execFileSync('node', [fileURLToPath(new URL('../scripts/ui-scenes.mjs', import.meta.url)), '--check'], { stdio: 'pipe' })).not.toThrow();
  });
  it.each(Object.keys(UI_SCENES))('%s: base + heir merge, contract holds, only kit components, every ui.* string exists', (name) => {
    const s = UI_SCENES[name as keyof typeof UI_SCENES];
    const base = parse(s.base);
    expect(checkContract(base, parseContract(s.contract))).toEqual([]);
    const { tree, errors } = mergeScene(base, parseHeir(s.heir));
    expect(errors).toEqual([]);
    walk(tree, (n) => {
      if (n.tml.type) expect(UI_COMPONENTS).toContain(n.tml.type);
    });
    for (const m of s.heir.matchAll(/'(ui\.\w+)'/g)) {
      expect(KIT_STRINGS.en[m[1]], m[1]).toBeTruthy();
      expect(KIT_STRINGS.ru[m[1]], m[1]).toBeTruthy();
    }
  });
  it('kit strings go under the game\'s (the game wins; its languages)', () => {
    const t = withKitStrings({ en: { 'ui.play': 'GO', title: 'Snake' } });
    expect(Object.keys(t)).toEqual(['en']);
    expect(t.en['ui.play']).toBe('GO');
    expect(t.en['ui.settings']).toBe('SETTINGS');
    expect(Object.keys(withKitStrings(undefined)).sort()).toEqual(['en', 'ru']);
  });
});

describe('components (headless)', () => {
  const skin = defaultSkin();
  it('slot frame: the square {x, y, scale} of the source lands on the circle', () => {
    // A 200×100 texture, the square of side 0.5 w (=100 px) centred at (0.25, 0.5): onto d = 50.
    expect(placeFrame({ x: 0.25, y: 0.5, scale: 0.5 }, 200, 100, 50)).toEqual({ scale: 0.5, x: -25, y: -25 });
  });
  it('slot modes: colour / grayscale (alpha) / silhouette; found fades colour in for the last two', () => {
    expect(slotLook('color', 0.86)).toEqual({ filter: 'none', alpha: 1, revealColor: false });
    expect(slotLook('grayscale', 0.86)).toEqual({ filter: 'grayscale', alpha: 0.86, revealColor: true });
    expect(slotLook('silhouette', 0.86).revealColor).toBe(true);
  });
  it('slot states: hint → glow, found → mark; reveal animates on the tweens', async () => {
    const tweens = new Tweens();
    const s = new UISlot(skin, 120, 96, 'color', 0.86, tweens); // filters (grayscale) need a DOM
    s.state = 'hint';
    expect(s.state).toBe('hint');
    const p = s.reveal();
    for (let i = 0; i < 40; i++) tweens.update(0.02);
    await p;
    expect(s.state).toBe('found');
    expect(() => new UISlot(skin, 120, 96, 'sepia' as never, 1, null)).toThrow(/mode "sepia"/);
  });
  it('progress / slider clamp their value; stars count earned ones', () => {
    const b = new UIProgress(skin, 400, 30);
    b.value = 1.7;
    expect(b.value).toBe(1);
    const sl = new UISlider(skin, 400, 30, 0, 48, 0);
    sl.value = -2;
    expect(sl.value).toBe(0);
    sl.dragging = true;
    sl.value = 0.5; // a binding echo while the player drags is ignored
    expect(sl.value).toBe(0);
    const st = new UIStars(skin, 3, 80, 10, null);
    st.value = 5;
    expect(st.value).toBe(3);
  });
});

const POPUP = (id: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 1280"><rect id="dim" x="0" y="0" width="720" height="1280" opacity="0.5" data-stretch="xy"/><g id="content" transform="translate(360,640)" data-anchor="0.5 0.5"><rect id="${id}" x="-100" y="-100" width="200" height="200"/></g></svg>`;
const screen = (name: string) => new Screen(name, { base: POPUP(name + 'Box') }, 'expand', { backend: new PixiBackend(), context: {} });

describe('popups.closeNow, overlays', () => {
  it('closeNow: gone at once, onHidden, the queued one opens', () => {
    const tweens = new Tweens();
    const popups = new Popups(tweens);
    const hidden: string[] = [];
    popups.register({ name: 'a', screen: screen('a'), layer: 'default', anim: 'scale', onHidden: () => hidden.push('a') });
    popups.show('a');
    popups.show('a'); // queued
    popups.closeNow('a');
    expect(hidden).toEqual(['a']);
    expect(popups.isOpen('a')).toBe(true); // the queued one
    popups.closeNow('a');
    expect(popups.isOpen()).toBe(false);
    expect(popups.layers.default.children.length).toBe(0);
  });
  it('overlay: over everything, input passes at once on hide, gone after goneAfter', async () => {
    const tweens = new Tweens();
    const ov = new Overlays(tweens);
    const s = screen('loading');
    ov.add('loading', s);
    ov.show('loading');
    expect(ov.isOpen('loading')).toBe(true);
    expect(s.root.visible).toBe(true);
    const p = ov.hide('loading', { anim: 'scale', duration: 0.2, goneAfter: 0.1 });
    expect(s.root.eventMode).toBe('none');
    expect(ov.isOpen('loading')).toBe(false);
    for (let i = 0; i < 6; i++) tweens.update(0.02);
    await p;
    expect(s.root.visible).toBe(false);
    expect(() => ov.get('nope')).toThrow(/overlay "nope" not found/);
  });
  it('screen layout keeps anchored nodes inside the safe area; stretched ones fill the canvas', () => {
    const s = screen('p');
    s.layout({ x: 0, y: 0, w: 720, h: 1280 }, { x: 0, y: 40, w: 720, h: 1280 - 40 - 20 });
    const content = s.byId<Container>('content');
    expect(content.y).toBeCloseTo(640 + (40 - 20) / 2);
    expect(s.byId<Container>('dim').y).toBe(0);
    expect(s.safe).toEqual({ top: 40, right: 0, bottom: 20, left: 0 });
  });
});

describe('Trempel collections (v1.1): createGame({ collections })', () => {
  const SCENE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 1280"><image id="panel" href="@skin/art/panel.png" width="200" height="100"/><image id="own" href="art/own.png" width="10" height="10"/></svg>';
  // what game.ts wires: collections first, then the bundler's table (assets.resolve)
  const table = assetTable({ './skins/ui/art/panel.png': '/assets/panel-3f2a.png', './art/own.png': '/assets/own-91c0.png' });
  const collections = { skin: 'skins/ui' };

  it('a kit scene with an @-link mounts: the link expands, then the hashed-URL table maps it', () => {
    const seen: string[] = [];
    const resolve = withCollections((h) => {
      seen.push(h);
      return table(h);
    }, collections);
    const s = new Screen('coll', { base: SCENE }, 'expand', { backend: new PixiBackend(), context: {}, collections, resolveHref: resolve });
    expect(s.byId('panel')).toBeTruthy();
    expect(seen).toEqual(['skins/ui/art/panel.png', 'art/own.png']);
    expect(resolve('@skin/art/panel.png')).toBe('/assets/panel-3f2a.png'); // the Loader's bundles take @-links too
  });

  it('an unknown collection is a mount error, not a silent 404', () => {
    expect(() => new Screen('bad', { base: SCENE.replace('@skin/', '@ui/') }, 'expand', { backend: new PixiBackend(), context: {}, collections })).toThrow(TrempelError);
    expect(() => withCollections((h) => h, collections)('@ui/x.png')).toThrow(/коллекции @ui нет/);
  });
});
