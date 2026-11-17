// 2.0 additions found by a real game (TRM-8b): a prefab instance's context inherits the scene's
// (names added after the mount are seen inside prefabs), clip parameters at play, preserveAspectRatio
// of a boxed image, tml:extends from a collection and project heirs of collection documents.

import { describe, it, expect, beforeAll } from 'vitest';
import { Assets, Sprite, Texture, TextureSource } from 'pixi.js';
import { PixiBackend } from '../src/render/pixi';
import { Animator, checkScene, compileClips, compileClipsResult, expandCollection, flattenScene, mount, reactive, TrempelError, type SceneSource } from '../src/core';
import { createMockBackend, createMockClock, type MockNode } from './helpers/mockBackend';
import { codesOf, thrown } from './helpers/codes';
import { heirsFor, projectHeirs, relativePath } from '../src/project';
import { heirsOf, loadProject } from '../src/node/project';
import { projectInfo } from '../view/plugin';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const NS = 'xmlns="http://www.w3.org/2000/svg" xmlns:tml="https://trempel.dev/ns/scene"';
const svg = (body: string, root = '', vb = '0 0 400 300'): string => `<svg ${NS} viewBox="${vb}"${root}>${body}</svg>`;
const heirOf = (ext: string, body: string, root = ''): string => `<svg ${NS} tml:extends="${ext}"${root}>${body}</svg>`;
const loader = (fs: Record<string, SceneSource>) => (url: string): SceneSource | null => fs[url] ?? null;

const BUTTON: SceneSource = {
  base: svg(`<rect id="hit" width="100" height="40"/><text id="label" x="10" y="25">B</text>`, ' data-action="" data-label="B"', '0 0 100 40'),
  heir: heirOf('button.svg', `<tml:ref id="hit" tml:on-click="tap(self.action, self.id)"/><tml:ref id="label" tml:bind="caption(self.label)"/>`),
};

describe('2.0 — a prefab instance context inherits the scene context', () => {
  it('functions the host adds AFTER the mount are callable inside a prefab (tml:on-click, bindings)', () => {
    const backend = createMockBackend();
    const state = reactive({ n: 1 });
    const context: Record<string, unknown> = { state, caption: (s: string) => `${s}!` };
    const scene = mount({
      base: svg(`<use id="play" href="ui/button.svg" data-action="start" data-label="Play"/>`),
      backend,
      context,
      loadScene: loader({ 'ui/button.svg': BUTTON }),
    });
    const hit = scene.byId.get('play/hit') as MockNode;
    const label = scene.byId.get('play/label') as MockNode;
    expect(hit.tag).toBe('rect');
    expect(label.props.text).toBe('Play!');
    // The game's actions arrive after the scenes mounted (the kit's lazy game).
    const calls: unknown[][] = [];
    context.tap = (...a: unknown[]) => calls.push(a);
    hit.clicks.forEach((c) => c());
    expect(calls).toEqual([['start', 'play']]);
    // A changed name is seen too.
    context.tap = (...a: unknown[]) => calls.push(['again', ...a]);
    hit.clicks.forEach((c) => c());
    expect(calls[1]).toEqual(['again', 'start', 'play']);
  });

  it('self.call finds a function the scene got after the mount; Object.prototype names stay undefined', () => {
    const backend = createMockBackend();
    const context: Record<string, unknown> = {};
    const btn: SceneSource = { ...BUTTON, heir: heirOf('button.svg', `<tml:ref id="hit" tml:on-click="self.call(self.action)"/>`) };
    const scene = mount({
      base: svg(`<use id="a" href="ui/button.svg" data-action="start"/><use id="b" href="ui/button.svg" data-action="toString"/>`),
      backend,
      context,
      lenient: true,
      loadScene: loader({ 'ui/button.svg': btn }),
    });
    let started = 0;
    context.start = () => started++;
    (scene.byId.get('a/hit') as MockNode).clicks.forEach((c) => c());
    expect(started).toBe(1);
    const errors: string[] = [];
    const s2 = mount({
      base: svg(`<use id="b" href="ui/button.svg" data-action="toString"/>`),
      backend: createMockBackend(),
      context: {},
      onError: (e) => errors.push((e.error as Error).message),
      loadScene: loader({ 'ui/button.svg': btn }),
    });
    (s2.byId.get('b/hit') as MockNode).clicks.forEach((c) => c());
    expect(errors.join()).toMatch(/E_SELF_CALL/);
  });
});

describe('2.0 — clip parameters ($name cells, play options params)', () => {
  const MD = [
    '# $clip collect',
    '$duration: 1',
    '## $track card',
    '| t | x | y | rotation | alpha | ease |',
    '|---|---|---|---|---|---|',
    '| 0 | 0 | 0 | 0 | 1 | inOut |',
    '| 1 | $toX | $toY | $turn | $fade | |',
  ].join('\n');

  it('compiles a $name cell to a parameter key (the column unit kept: degrees → radians)', () => {
    const { collect } = compileClips(MD);
    const x = collect.tracks.find((t) => t.property === 'x')!;
    expect(x.keys[1]).toEqual({ t: 1, v: 1, param: 'toX', ease: 'inOut' });
    const rot = collect.tracks.find((t) => t.property === 'rotation')!;
    expect(rot.keys[1].param).toBe('turn');
    expect(rot.keys[1].v).toBeCloseTo(Math.PI / 180);
  });

  it('one clip flies to different places: params per play, the clip is not changed', () => {
    const { collect } = compileClips(MD);
    const frozen = JSON.stringify(collect);
    const backend = createMockBackend();
    const scene = mount({ base: svg('<rect id="card" width="5" height="5"/>'), backend, context: {} });
    const clock = createMockClock();
    const anim = new Animator(backend, clock, (id) => scene.byId.get(id));
    const node = scene.byId.get('card') as MockNode;
    Object.assign(node.props, { x: 10, y: 20, rotation: 0, alpha: 1 }); // the rest pose
    for (const [toX, toY] of [[100, 50], [-30, 7]]) {
      anim.play(collect, { params: { toX, toY, turn: 90, fade: 0.5 } });
      clock.t += 1000;
      anim.tick();
      expect(node.props.x).toBeCloseTo(10 + toX);
      expect(node.props.y).toBeCloseTo(20 + toY);
      expect(node.props.rotation).toBeCloseTo(Math.PI / 2);
      expect(node.props.alpha).toBeCloseTo(0.5);
    }
    expect(JSON.stringify(collect)).toBe(frozen);
  });

  it('a parameter not given (or not a number) — E_ANIM_PARAM before anything moves; a bad name — E_ANIM_VALUE', () => {
    const { collect } = compileClips(MD);
    const backend = createMockBackend();
    const scene = mount({ base: svg('<rect id="card" width="5" height="5"/>'), backend, context: {} });
    const anim = new Animator(backend, createMockClock(), (id) => scene.byId.get(id));
    const node = scene.byId.get('card') as MockNode;
    Object.assign(node.props, { x: 3, y: 0, rotation: 0, alpha: 1 });
    expect(thrown(() => anim.play(collect, { params: { toX: 1 } }))).toMatchObject({ code: 'E_ANIM_PARAM' });
    expect(node.props.x).toBe(3);
    expect(thrown(() => anim.play(collect, { params: { toX: 1, toY: Number.NaN, turn: 0, fade: 1 } }))).toMatchObject({ code: 'E_ANIM_PARAM' });
    const bad = compileClipsResult(MD.replace('$toX', '$to-x'));
    expect(codesOf(bad.errors)).toEqual(['E_ANIM_VALUE']);
  });
});

describe('2.0 — preserveAspectRatio of a boxed <image> (PixiBackend)', () => {
  const metrics = (): { ascent: number; descent: number } => ({ ascent: 8, descent: 2 });
  beforeAll(() => {
    // 100×50: a landscape picture in square and tall boxes.
    Assets.cache.set('v20/photo.png', new Texture({ source: new TextureSource({ width: 100, height: 50 }) }));
  });
  const one = (attrs: string, root = '') =>
    mount({ base: svg(`<image id="p" href="v20/photo.png" width="200" height="200"${attrs}/>`, root), backend: new PixiBackend({ metrics }), context: {} });

  it('slice covers the box: the texture is cut to the box aspect (aligned), uniform scale, no distortion', () => {
    const mid = one(' preserveAspectRatio="xMidYMid slice"').byId.get('p') as Sprite;
    expect([mid.width, mid.height]).toEqual([200, 200]);
    expect(mid.scale.x).toBeCloseTo(mid.scale.y);
    expect([mid.texture.frame.x, mid.texture.frame.width, mid.texture.frame.height]).toEqual([25, 50, 50]);
    const left = one(' preserveAspectRatio="xMinYMid slice"').byId.get('p') as Sprite;
    expect(left.texture.frame.x).toBe(0);
    const right = one(' preserveAspectRatio="xMaxYMax slice"').byId.get('p') as Sprite;
    expect(right.texture.frame.x).toBe(50);
  });

  it('meet contains it: the whole picture, uniform scale, placed by the alignment', () => {
    const s = one(' preserveAspectRatio="xMidYMid meet"');
    const p = s.byId.get('p') as Sprite;
    expect([p.width, p.height]).toEqual([200, 100]);
    const b = p.getBounds();
    expect([b.x, b.y, b.width, b.height]).toEqual([0, 50, 200, 100]);
    const top = one(' preserveAspectRatio="xMidYMin meet"').byId.get('p') as Sprite;
    expect(top.getBounds().y).toBe(0);
    const bottom = one(' preserveAspectRatio="xMidYMax"').byId.get('p') as Sprite; // meet is the default
    expect(bottom.getBounds().y).toBe(100);
  });

  it('none and no attribute stretch it as before; a stretched box (setSize / data-stretch) refits', () => {
    expect((one(' preserveAspectRatio="none"').byId.get('p') as Sprite).height).toBe(200);
    expect((one('').byId.get('p') as Sprite).height).toBe(200);
    const s = one(' preserveAspectRatio="xMidYMid slice"');
    s.setSize('p', 400, 100);
    const p = s.byId.get('p') as Sprite;
    expect([p.width, p.height]).toEqual([400, 100]);
    expect([p.texture.frame.y, p.texture.frame.height]).toEqual([12.5, 25]);
  });

  it('errors: a malformed value, with data-slices — E_ASPECT; the root <svg> may carry its own', () => {
    const bad = (attrs: string, root = ''): string[] => {
      try {
        one(attrs, root);
        return [];
      } catch (e) {
        return (e as TrempelError).errors;
      }
    };
    expect(codesOf(bad(' preserveAspectRatio="center cover"'))).toEqual(['E_ASPECT']);
    expect(codesOf(bad(' preserveAspectRatio="xMidYMid slice" data-slices="4"'))).toEqual(['E_ASPECT']);
    expect(bad('', ' preserveAspectRatio="xMidYMid meet"')).toEqual([]);
  });

  it('flatten keeps the image\'s own meet / slice (none without it)', () => {
    const out = (a: string) => flattenScene({ base: svg(`<image id="p" href="x.png" width="20" height="20"${a}/>`) }).svg ?? '';
    expect(out(' preserveAspectRatio="xMidYMid slice"')).toContain('preserveAspectRatio="xMidYMid slice"');
    expect(out('')).toContain('preserveAspectRatio="none"');
  });
});

describe('2.0 — tml:extends from a collection; project heirs of collection documents', () => {
  // A UI kit as a collection (@ui → /ui-kit), the game's heirs in its own folder (scenes/).
  const KIT: Record<string, SceneSource> = {
    '/ui-kit/level.svg': {
      base: svg(`<image id="bg" href="art/bg.png" width="400" height="300"/><use id="ok" href="ui/button.svg" data-action="go" data-label="OK"/><text id="title" x="10" y="20">Level</text>`),
      contract: `<contract><text id="title"/></contract>`,
    },
    '/ui-kit/ui/button.svg': {
      base: svg(`<rect id="hit" width="100" height="40"/><text id="label" x="10" y="25">B</text><g id="content"/>`, ' data-action="" data-label="B"', '0 0 100 40'),
      // The collection's own heir: declares the slot and binds the label — kept under the game's heir.
      heir: heirOf('button.svg', `<tml:ref id="content" tml:slot="content default"/><tml:ref id="label" tml:bind="self.label"/>`),
    },
  };
  const GAME: Record<string, string> = {
    'scenes/level.tml.svg': heirOf('@ui/level.svg', `<tml:ref id="title" tml:bind="state.title"/><use id="extra" tml:insert="after ok" href="@ui/ui/button.svg" data-action="more" data-label="More"/>`),
    'scenes/ui/button.tml.svg': heirOf('@ui/ui/button.svg', `<tml:ref id="hit" tml:on-click="tap(self.action, self.id)"/>`),
  };
  const fs = (): Record<string, SceneSource> => {
    const out: Record<string, SceneSource> = { ...KIT };
    // The loader gets hrefs from the top scene's folder (scenes/): the game's own heir-only scenes.
    for (const [path, heir] of Object.entries(GAME)) out[path.replace(/^scenes\//, '').replace(/\.tml\.svg$/, '.svg')] = { heir };
    return out;
  };
  const collections = { ui: '/ui-kit' };

  it('an heir in the game extends a base of the collection (images and prefabs resolve inside it; the contract is inherited)', () => {
    const backend = createMockBackend();
    const state = reactive({ title: 'Istanbul' });
    const scene = mount({ heir: GAME['scenes/level.tml.svg'], path: 'level.svg', backend, context: { state, tap: () => {} }, collections, loadScene: loader(fs()) });
    expect((scene.byId.get('bg') as MockNode).attrs.href).toBe('/ui-kit/art/bg.png');
    expect((scene.byId.get('title') as MockNode).props.text).toBe('Istanbul');
    expect((scene.byId.get('ok/label') as MockNode).props.text).toBe('OK');
    expect(scene.byId.get('extra/hit')).toBeTruthy();
  });

  it('a project heir is laid over the collection heir for every instance — in the collection base and in the game', () => {
    const { heirs, errors } = projectHeirs(GAME);
    expect(errors).toEqual([]);
    expect(heirs).toEqual({ '@ui/level.svg': 'scenes/level.svg', '@ui/ui/button.svg': 'scenes/ui/button.svg' });
    const calls: unknown[][] = [];
    const scene = mount({
      heir: GAME['scenes/level.tml.svg'],
      path: 'level.svg',
      backend: createMockBackend(),
      context: { state: reactive({ title: '' }), tap: (...a: unknown[]) => calls.push(a) },
      collections,
      heirs: heirsFor(heirs, 'scenes/level.svg'),
      loadScene: loader(fs()),
    });
    for (const id of ['ok', 'extra']) (scene.byId.get(`${id}/hit`) as MockNode).clicks.forEach((c) => c());
    expect(calls).toEqual([['go', 'ok'], ['more', 'extra']]);
    // The collection heir's layer stays: the label binding and the slot.
    expect((scene.byId.get('ok/label') as MockNode).props.text).toBe('OK');
    // The top scene that extends a document with a project heir (itself) is merged once.
    expect(scene.byId.get('extra')).toBeTruthy();
  });

  it('without the project heirs the instances are the collection\'s own (no click)', () => {
    const scene = mount({ heir: GAME['scenes/level.tml.svg'], path: 'level.svg', backend: createMockBackend(), context: { state: reactive({ title: '' }) }, collections, loadScene: loader(fs()) });
    expect((scene.byId.get('ok/hit') as MockNode).clicks).toEqual([]);
  });

  it('errors: two heirs of one document; a "project heir" with its own base or extending something else — E_PROJECT_HEIR', () => {
    const two = projectHeirs({ ...GAME, 'scenes/other/button.tml.svg': heirOf('@ui/ui/button.svg', '') });
    expect(codesOf(two.errors)).toEqual(['E_PROJECT_HEIR']);
    expect(two.errors[0]).toContain('scenes/other/button.tml.svg');
    const files = fs();
    files['ui/button.svg'] = { base: svg('<rect id="hit" width="1" height="1"/>') };
    const err = thrown(() =>
      mount({ heir: GAME['scenes/level.tml.svg'], path: 'level.svg', backend: createMockBackend(), context: { state: reactive({ title: '' }) }, collections, heirs: { '@ui/ui/button.svg': 'ui/button.svg' }, loadScene: loader(files) }),
    ) as TrempelError;
    expect(codesOf(err.errors)).toContain('E_PROJECT_HEIR');
  });

  it('heirsFor: hrefs from the scene\'s folder', () => {
    expect(relativePath('scenes/level.svg', 'scenes/ui/card.svg')).toBe('ui/card.svg');
    expect(relativePath('scenes/popups/pause.svg', 'scenes/ui/card.svg')).toBe('../ui/card.svg');
    expect(relativePath('top.svg', 'scenes/ui/card.svg')).toBe('scenes/ui/card.svg');
  });
});

describe('2.0 — project heirs on disk (Node tools: check, flatten, the viewer)', () => {
  let dir = '';
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'trempel-heirs-'));
    const put = (rel: string, text: string): void => {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), text);
    };
    put('game/.trempel/project.mdz', '## collections\n$ui: ../kit\n');
    put('kit/ui/button.svg', svg('<rect id="hit" width="10" height="10"/>', ' data-action=""', '0 0 10 10'));
    put('kit/level.svg', svg('<use id="ok" href="ui/button.svg" data-action="go"/>'));
    put('game/scenes/level.tml.svg', heirOf('@ui/level.svg', ''));
    put('game/scenes/ui/button.tml.svg', heirOf('@ui/ui/button.svg', '<tml:ref id="hit" tml:on-click="tap(self.action)"/>'));
    put('game/node_modules/x/y.tml.svg', heirOf('@ui/ui/button.svg', ''));
    put('game/dist-web/z.tml.svg', heirOf('@ui/ui/button.svg', ''));
  });

  it('loadProject finds them (not in node_modules / builds); heirsOf — hrefs from a scene; projectInfo — URLs', () => {
    const p = loadProject(join(dir, 'game/scenes'));
    expect(p.errors).toEqual([]);
    expect(p.heirs).toEqual({ '@ui/level.svg': join(dir, 'game/scenes/level.svg'), '@ui/ui/button.svg': join(dir, 'game/scenes/ui/button.svg') });
    expect(heirsOf(p, join(dir, 'game/scenes/level.svg'))).toEqual({ '@ui/level.svg': 'level.svg', '@ui/ui/button.svg': 'ui/button.svg' });
    expect(projectInfo(join(dir, 'game/scenes')).heirs).toEqual({ '@ui/level.svg': '/__tml/root/scenes/level.svg', '@ui/ui/button.svg': '/__tml/root/scenes/ui/button.svg' });
  });

  it('the composition on disk (what check runs): the collection base instance gets the game\'s click', () => {
    const p = loadProject(join(dir, 'game/scenes'));
    const read = (f: string): string | undefined => (existsSync(f) ? readFileSync(f, 'utf8') : undefined);
    const load = (url: string): SceneSource | null => {
      const stem = url.replace(/\.svg$/, '');
      const src = { base: read(`${stem}.svg`), heir: read(`${stem}.tml.svg`), contract: read(`${stem}.contract.xml`) };
      return src.base != null || src.heir != null ? src : null;
    };
    const scene = join(dir, 'game/scenes/level.svg');
    const r = checkScene({
      heir: read(join(dir, 'game/scenes/level.tml.svg')),
      path: scene,
      loadScene: load,
      url: (rel) => resolve(dirname(scene), expandCollection(rel, p.collections)),
      collections: p.collections,
      heirs: heirsOf(p, scene),
    });
    expect(r.errors).toEqual([]);
    const hit = r.tree!.children[0].children.find((c) => c.attrs.id === 'ok/hit');
    expect(hit?.tml['on-click']).toBe('tap(self.action)');
  });
});

describe('2.0 — the contract of a collection document, inherited by a project heir', () => {
  it('its <use href> lines are read from its own document (ui/card.svg in @ui/album.contract.xml is @ui/ui/card.svg)', () => {
    const NS2 = 'xmlns="http://www.w3.org/2000/svg" xmlns:tml="https://trempel.dev/ns/scene"';
    const files: Record<string, SceneSource> = {
      '@ui/album.svg': { base: `<svg ${NS2} viewBox="0 0 10 10"><use id="card1" href="ui/card.svg"/></svg>`, contract: '<contract><use id="card1" href="ui/card.svg"/></contract>' },
      '@ui/ui/card.svg': { base: `<svg ${NS2} viewBox="0 0 4 4"><rect id="hit" width="4" height="4"/></svg>` },
      'ui/card.svg': { heir: `<svg ${NS2} tml:extends="@ui/ui/card.svg"/>` },
    };
    const r = checkScene({ heir: `<svg ${NS2} tml:extends="@ui/album.svg"/>`, path: 'album.svg', loadScene: (u) => files[u] ?? null, collections: { ui: '@ui' }, heirs: { '@ui/ui/card.svg': 'ui/card.svg' } });
    expect(r.errors).toEqual([]);
    const bad = checkScene({ heir: `<svg ${NS2} tml:extends="@ui/album.svg"/>`, path: 'album.svg', loadScene: (u) => (u === '@ui/album.svg' ? { ...files[u], contract: '<contract><use id="card1" href="ui/other.svg"/></contract>' } : files[u] ?? null), collections: { ui: '@ui' } });
    expect(codesOf(bad.errors)).toEqual(['E_CONTRACT_TAG']);
  });
});
