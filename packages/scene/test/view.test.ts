// The scene viewer (view/): scene discovery, viewport fitting, and the session — the real mount()
// over a mock backend with every problem collected for the panel, stand-in state, click log.

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { discoverScenes } from '../view/discover';
import { scanScenes } from '../view/plugin';
import { fitStage, parseViewport, parseViewBox } from '../view/viewport';
import { openScene, hasErrors, type ViewIssue } from '../view/session';
import { TrempelError, Registry, type RendererBackend } from '../src/core';
import { createMockBackend, type MockNode } from './helpers/mockBackend';

const BASE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">
  <rect id="back" x="0" y="0" width="400" height="300" fill="#000"/>
  <text id="label" x="10" y="20">layout</text>
  <g id="slot"/>
</svg>`;
const heir = (refs: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:tml="https://trempel.dev/ns/scene" tml:extends="s.svg">${refs}</svg>`;

/** Find a mock node by id under a root. */
function byId(root: MockNode, id: string): MockNode | undefined {
  if (root.attrs.id === id) return root;
  for (const c of root.children) {
    const f = byId(c, id);
    if (f) return f;
  }
  return undefined;
}
const kinds = (issues: ViewIssue[]): string[] => issues.map((i) => `${i.level}:${i.kind}`);

describe('view — discovery', () => {
  it('groups triples by stem; base alone is a scene; lone contract/state are not', () => {
    const scenes = discoverScenes([
      'scene.svg',
      'scene.tml.svg',
      'scene.contract.xml',
      'scene.state.json',
      'popups/map.svg',
      'popups/map.tml.svg',
      'skin/button.svg',
      'level.contract.xml',
      'orphan.state.json',
      'only.tml.svg',
      'art/bg.png',
      'trempel.view.ts',
    ]);
    expect(scenes).toEqual([
      { id: 'only', heir: 'only.tml.svg' },
      { id: 'popups/map', base: 'popups/map.svg', heir: 'popups/map.tml.svg' },
      { id: 'scene', base: 'scene.svg', heir: 'scene.tml.svg', contract: 'scene.contract.xml', state: 'scene.state.json' },
      { id: 'skin/button', base: 'skin/button.svg' },
    ]);
  });

  it('scans a folder recursively (Windows separators normalised)', () => {
    expect(discoverScenes(['a\\b.svg']).map((s) => s.id)).toEqual(['a/b']);
    const dir = fileURLToPath(new URL('./fixtures/view', import.meta.url));
    expect(scanScenes(dir)).toEqual([
      { id: 'broken', base: 'broken.svg', heir: 'broken.tml.svg', contract: 'broken.contract.xml', state: 'broken.state.json' },
      { id: 'nested/ok', base: 'nested/ok.svg', heir: 'nested/ok.tml.svg', state: 'nested/ok.state.json' },
    ]);
  });
});

describe('view — viewport', () => {
  const vb = parseViewBox('0 0 1280 800')!;

  it('parses presets, aspects and sizes; rejects garbage', () => {
    expect(parseViewport('scene')).toEqual({ kind: 'scene' });
    expect(parseViewport('9:19.5')).toEqual({ kind: 'aspect', w: 9, h: 19.5 });
    expect(parseViewport('1080x1920')).toEqual({ kind: 'size', w: 1080, h: 1920 });
    expect(() => parseViewport('wide')).toThrow(/вьюпорт/);
  });

  it('scene = the viewBox; an aspect contains it centred at scale 1; a size fits it', () => {
    expect(fitStage(vb, { kind: 'scene' })).toEqual({ width: 1280, height: 800, scale: 1, x: 0, y: 0 });
    const portrait = fitStage(vb, parseViewport('9:16'));
    expect(portrait).toMatchObject({ width: 1280, height: 2276, scale: 1, x: 0 });
    expect(portrait.y).toBeCloseTo((2276 - 800) / 2);
    const wide = fitStage(parseViewBox('0 0 1024 2048')!, parseViewport('16:9'));
    expect(wide).toMatchObject({ width: 3641, height: 2048, scale: 1, y: 0 });
    const small = fitStage(vb, parseViewport('640x640'));
    expect(small).toMatchObject({ width: 640, height: 640, scale: 0.5, x: 0, y: 120 });
  });
});

describe('view — session', () => {
  it('stand-in state reaches bindings; applying another state reopens with it', () => {
    const src = { base: BASE, heir: heir(`<tml:ref id="label" tml:bind="state.title"/>`) };
    const a = openScene({ sources: src, state: '{"title":"first"}', backend: createMockBackend() });
    expect(a.issues).toEqual([]);
    expect(byId(a.scene!.root as MockNode, 'label')!.props.text).toBe('first');
    expect(a.viewBox).toEqual({ x: 0, y: 0, w: 400, h: 300 });

    const b = openScene({ sources: src, state: { title: 'second' }, backend: createMockBackend() });
    expect(byId(b.scene!.root as MockNode, 'label')!.props.text).toBe('second');
    // The state is live (reactive): a write updates the bound node.
    b.state.title = 'third';
    expect(byId(b.scene!.root as MockNode, 'label')!.props.text).toBe('third');
  });

  it('bad state JSON is a panel error, the scene still opens', () => {
    const s = openScene({ sources: { base: BASE }, state: '{ title: ', backend: createMockBackend() });
    expect(kinds(s.issues)).toEqual(['error:state']);
    expect(s.issues[0].message).toMatch(/не JSON/);
    expect(s.scene).not.toBeNull();
    expect(kinds(openScene({ sources: { base: BASE }, state: '[1]', backend: createMockBackend() }).issues)).toEqual(['error:state']);
  });

  it('contract errors go to the panel and do not stop the render', () => {
    const s = openScene({
      sources: { base: BASE, contract: `<contract viewBox="0 0 400 300"><g id="missing"/><text id="label"/></contract>` },
      backend: createMockBackend(),
    });
    expect(kinds(s.issues)).toEqual(['error:contract']);
    expect(s.issues[0].message).toMatch(/missing/);
    expect(s.scene).not.toBeNull();
    expect(hasErrors(s.issues)).toBe(true);
  });

  it('merge and expression errors go to the panel; the base renders without the heir', () => {
    const merge = openScene({ sources: { base: BASE, heir: heir(`<tml:ref id="nope" tml:bind="1"/>`) }, backend: createMockBackend() });
    expect(kinds(merge.issues)).toEqual(['error:merge', 'warn:merge']);
    expect(merge.issues[0].message).toMatch(/nope/);
    expect(merge.scene).not.toBeNull();

    const expr = openScene({ sources: { base: BASE, heir: heir(`<tml:ref id="label" tml:bind="state.a >> 1"/>`) }, backend: createMockBackend() });
    expect(kinds(expr.issues)).toEqual(['error:expression', 'warn:merge']);
    expect(expr.issues[0].message).toMatch(/#label tml:bind: .*позиция/);
    expect(byId(expr.scene!.root as MockNode, 'label')!.props.text).toBe('layout');
  });

  it('runtime expression errors arrive through onError — no exception, at open and later', () => {
    const late: ViewIssue[] = [];
    const s = openScene({
      sources: { base: BASE, heir: heir(`<tml:ref id="label" tml:bind="state.box.n"/>`) },
      state: '{"box":null}',
      backend: createMockBackend(),
      onIssue: (i) => late.push(i),
    });
    expect(kinds(s.issues)).toEqual(['error:runtime']);
    expect(s.issues[0].message).toBe('#label tml:bind="state.box.n": чтение поля «n» у null');
    expect(late).toEqual([]); // found during open: in the list, not "late"

    s.state.box = { n: 1 };
    s.state.box = undefined;
    expect(late.map((i) => i.message)).toEqual(['#label tml:bind="state.box.n": чтение поля «n» у undefined']);
  });

  it('a component problem is a panel error', () => {
    const s = openScene({
      sources: { base: BASE, heir: heir(`<tml:ref id="slot" tml:type="nope"/>`) },
      backend: createMockBackend(),
      registry: new Registry(),
    });
    expect(kinds(s.issues)).toEqual(['error:component']);
    expect(s.scene).toBeNull();
  });

  it('no base / unparseable base are panel errors', () => {
    expect(kinds(openScene({ sources: { heir: heir('') }, backend: createMockBackend() }).issues)).toEqual(['error:base']);
    expect(kinds(openScene({ sources: { base: '<svg><polygon/></svg>' }, backend: createMockBackend() }).issues)).toEqual(['error:parse']);
  });

  it('unknown names become stubs; clicks go to the log with the calls they made', () => {
    const log: string[] = [];
    let real = 0;
    const s = openScene({
      sources: { base: BASE, heir: heir(`<tml:ref id="back" tml:on-click="play(state.stake, 'x') || count()"/><tml:ref id="label" tml:bind="t('hi')"/>`) },
      state: '{"stake":2}',
      backend: createMockBackend(),
      context: () => ({ count: () => ++real }),
      onLog: (e) => log.push(`${e.node} ${e.expr} → ${e.calls.join(', ')}`),
    });
    expect(s.stubs).toEqual(['play', 't']);
    expect(kinds(s.issues)).toEqual(['warn:context']);
    expect(hasErrors(s.issues)).toBe(false);
    byId(s.scene!.root as MockNode, 'back')!.clicks.forEach((c) => c());
    expect(real).toBe(1);
    expect(log).toEqual([`#back play(state.stake, 'x') || count() → play(2, "x")`]);
    expect(s.log).toHaveLength(1);
  });

  it('textures that fail to load become asset errors once ready settles', async () => {
    const backend: RendererBackend = {
      ...createMockBackend(),
      whenReady: () => Promise.reject(new TrempelError(['Текстура не загрузилась: "a.png".'])),
    };
    const late: ViewIssue[] = [];
    const s = openScene({ sources: { base: BASE }, backend, onIssue: (i) => late.push(i) });
    await s.ready;
    expect(kinds(s.issues)).toEqual(['error:asset']);
    expect(late).toHaveLength(1);
  });

  it('readiness that never settles times out as a warning', async () => {
    const backend: RendererBackend = { ...createMockBackend(), whenReady: () => new Promise(() => {}) };
    const s = openScene({ sources: { base: BASE }, backend, readyTimeoutMs: 10 });
    await s.ready;
    expect(kinds(s.issues)).toEqual(['warn:asset']);
  });
});

describe('view — stays out of the package', () => {
  it('dist builds from src only; Playwright is a dev dependency', async () => {
    const { readFileSync } = await import('node:fs');
    const read = (p: string): Record<string, any> => JSON.parse(readFileSync(new URL(p, new URL('..', import.meta.url)), 'utf8'));
    expect(read('tsconfig.build.json').include).toEqual(['src']);
    const pkg = read('package.json');
    expect(pkg.files).toEqual(['dist', 'LICENSE', 'README.md']); // публикация (d4f6e37): + лицензия и README
    expect(pkg.dependencies.playwright).toBeUndefined();
    expect(pkg.devDependencies.playwright).toBeDefined();
  });
});
