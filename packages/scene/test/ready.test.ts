import { describe, it, expect } from 'vitest';
import { mount, mountScene } from '../src/scene';
import { reactive } from '../src/reactive';
import { resolveHref } from '../src/href';
import { TrempelError } from '../src/errors';
import { Registry } from '../src/registry';
import type { RendererBackend } from '../src/render/backend';
import { createMockBackend, isMockNode } from './helpers/mockBackend';
import { rejected } from './helpers/codes';

const BASE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <image id="bg" href="bg.png"/>
  <image id="abs" href="https://cdn.example/x.png"/>
  <g id="hud"/>
</svg>`;

/** Mock backend whose whenReady() is a promise the test settles by hand. */
function deferredBackend(): { backend: RendererBackend; resolve: () => void; reject: (e: unknown) => void } {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const p = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { backend: { ...createMockBackend(), whenReady: () => p }, resolve, reject };
}

describe('scene readiness', () => {
  it('ready resolves when the backend reports every texture loaded', async () => {
    const { backend, resolve } = deferredBackend();
    const scene = mount({ base: BASE, backend, context: {} });
    let done = false;
    void scene.ready.then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    resolve();
    await scene.ready;
    expect(done).toBe(true);
  });

  it('ready rejects with the backend error; an ignored rejection is not unhandled', async () => {
    const { backend, reject } = deferredBackend();
    const scene = mount({ base: BASE, backend, context: {} });
    reject(new TrempelError(['E_TEXTURE: the texture did not load: "bg.png".']));
    const e = await rejected(scene.ready);
    expect(e).toMatchObject({ code: 'E_TEXTURE' });
    expect(e.message).toContain('bg.png');
    // a second scene nobody awaits must not raise an unhandled rejection
    const other = deferredBackend();
    mount({ base: BASE, backend: other.backend, context: {} });
    other.reject(new Error('x'));
    await new Promise((r) => setTimeout(r, 0));
  });

  it('a backend without whenReady is ready immediately (v0.5 backends keep working)', async () => {
    const scene = mountScene(BASE, { backend: createMockBackend(), context: {} });
    await expect(scene.ready).resolves.toBeUndefined();
  });
});

describe('scene baseUrl — hrefs relative to the scene document', () => {
  it('resolves base image hrefs, bound hrefs and component hrefs', () => {
    const backend = createMockBackend();
    const state = reactive({ face: 'a.png' });
    const seen: string[] = [];
    const registry = new Registry().register('probe', (ctx) => {
      const root = ctx.backend.createNode('g', {});
      const img = ctx.backend.createNode('image', { href: 'sym/1.png' });
      ctx.backend.addChild(root, img);
      seen.push(ctx.resolveHref!('own.json'));
      return { root };
    });
    const heir = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:tml="https://trempel.dev/ns/scene" tml:extends="scene.svg">
      <tml:ref id="hud" tml:type="probe"/>
      <image id="face" tml:insert="after hud" tml:bind="'faces/' + state.face"/>
    </svg>`;
    const scene = mount({ base: BASE, heir, backend, registry, context: { state }, baseUrl: 'scenes/ui/game.svg' });

    expect(isMockNode(scene.byId.get('bg')!).attrs.href).toBe('scenes/ui/bg.png');
    expect(isMockNode(scene.byId.get('abs')!).attrs.href).toBe('https://cdn.example/x.png');
    expect(isMockNode(scene.byId.get('face')!).props.href).toBe('scenes/ui/faces/a.png');
    state.face = 'b.png';
    expect(isMockNode(scene.byId.get('face')!).props.href).toBe('scenes/ui/faces/b.png');
    const hud = isMockNode(scene.byId.get('hud')!);
    expect(hud.children[0].attrs.href).toBe('scenes/ui/sym/1.png');
    expect(seen).toEqual(['scenes/ui/own.json']);
  });

  it('without baseUrl hrefs pass through verbatim (v0.5)', () => {
    const scene = mount({ base: BASE, backend: createMockBackend(), context: {} });
    expect(isMockNode(scene.byId.get('bg')!).attrs.href).toBe('bg.png');
  });
});

describe('resolveHref', () => {
  it.each([
    ['bg.png', 'scenes/ui/game.svg', 'scenes/ui/bg.png'],
    ['../shared/x.png', 'scenes/ui/game.svg', 'scenes/shared/x.png'],
    ['./a/./b.png', 'scenes/', 'scenes/a/b.png'],
    ['../../x.png', 'a/b.svg', '../x.png'],
    ['x.png', 'game.svg', 'x.png'],
    ['x.png', '/levels/a1/level.svg', '/levels/a1/x.png'],
    ['../../../x.png', '/levels/a1/level.svg', '/x.png'],
    ['x.png', 'https://cdn.example/g/scene.svg', 'https://cdn.example/g/x.png'],
    ['../x.png', 'https://cdn.example/g/scene.svg', 'https://cdn.example/x.png'],
    ['data:image/png;base64,AAA', 'scenes/game.svg', 'data:image/png;base64,AAA'],
    ['/abs.png', 'scenes/game.svg', '/abs.png'],
    ['bg.png', undefined, 'bg.png'],
  ])('%s against %s → %s', (href, base, want) => {
    expect(resolveHref(href, base)).toBe(want);
  });
});

describe('mount — expression errors join the merge/contract list', () => {
  it('reports syntax errors of the heir together with merge errors', () => {
    const heir = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:tml="https://trempel.dev/ns/scene" tml:extends="scene.svg">
      <tml:ref id="bg" tml:bind="state.x +"/>
      <tml:ref id="nope" tml:visible="true"/>
    </svg>`;
    let err: TrempelError | undefined;
    try {
      mount({ base: BASE, heir, backend: createMockBackend(), context: {} });
    } catch (e) {
      err = e as TrempelError;
    }
    expect(err).toBeInstanceOf(TrempelError);
    expect(err!.codes).toEqual(['E_REF_MISSING', 'E_EXPR_SYNTAX']);
    expect(err!.errors[0]).toContain('<tml:ref id="nope">');
    expect(err!.errors[1]).toContain('#bg tml:bind:');
  });
});

describe('scene resolveHref — a mapping applied after baseUrl', () => {
  it('maps resolved hrefs (e.g. a bundler table); unknown ones pass through', () => {
    const table: Record<string, string> = { 'scenes/ui/bg.png': '/assets/bg-3f2a.png' };
    const scene = mount({
      base: BASE,
      backend: createMockBackend(),
      context: {},
      baseUrl: 'scenes/ui/game.svg',
      resolveHref: (h) => table[h] ?? h,
    });
    expect(isMockNode(scene.byId.get('bg')!).attrs.href).toBe('/assets/bg-3f2a.png');
    expect(isMockNode(scene.byId.get('abs')!).attrs.href).toBe('https://cdn.example/x.png');
  });
});
