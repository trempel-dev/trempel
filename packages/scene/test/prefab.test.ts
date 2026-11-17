// v0.9 prefabs: <use href> expansion (prefixes, nesting, cycles, illegal shapes), parameters and
// `self` (defaults, overrides, `=` expressions reactive, kebab→camel, self.call, self.state), the
// scene heir onto `a/b`, multi-level tml:extends (tml:href, inherited contract, params), the
// contract's <use href>, pointer events and tml:bind-view, the async loader.

import { describe, it, expect } from 'vitest';
import { composeScene, mount, mountAsync, parseContract, reactive, TrempelError, type SceneSource } from '../src/core';
import { checkContract } from '../src/contract';
import { createMockBackend, isMockNode, type MockNode } from './helpers/mockBackend';
import type { PointerKind } from '../src/render/backend';
import type { SceneNode } from '../src/parser';
import { codesOf, thrown, withCode } from './helpers/codes';

const NS = 'xmlns="http://www.w3.org/2000/svg" xmlns:tml="https://trempel.dev/ns/scene"';
const svg = (body: string, root = ''): string => `<svg ${NS} viewBox="0 0 800 600"${root}>${body}</svg>`;
const heirOf = (ext: string, body: string, root = ''): string => `<svg ${NS} tml:extends="${ext}"${root}>${body}</svg>`;

const BUTTON: SceneSource = {
  base: svg(
    `<image id="bg" href="art/btn.png" width="200" height="60" data-views="idle:art/btn.png, hover:art/btn-hover.png, pressed:art/btn-down.png"/>` +
      `<rect id="hit" width="200" height="60" fill="#000" opacity="0"/>` +
      `<text id="label" x="100" y="38">Button</text>`,
    ' data-label="Button" data-action=""',
  ),
  heir: heirOf(
    'button.svg',
    `<tml:ref id="label" tml:bind="self.label"/>` +
      `<tml:ref id="bg" tml:bind-view="self.state.pressed ? 'pressed' : self.state.hover ? 'hover' : 'idle'"/>` +
      `<tml:ref id="hit" tml:on-click="self.call(self.action)" tml:on-over="self.set('hover', true)" tml:on-out="self.set('hover', false)" tml:on-down="self.set('pressed', true)" tml:on-up="self.set('pressed', false)"/>`,
  ),
  contract: `<contract params="data-label data-action"><text id="label"/><rect id="hit"/></contract>`,
};

const GREEN: SceneSource = {
  heir: heirOf('button.svg', `<tml:ref id="bg" tml:href="art/green.png"/>`, ' data-action="go"'),
};

const files = (extra: Record<string, SceneSource> = {}): Record<string, SceneSource> => ({
  'ui/button.svg': BUTTON,
  'ui/button-green.svg': GREEN,
  ...extra,
});

const loader = (fs: Record<string, SceneSource>) => (url: string): SceneSource | null => fs[url] ?? null;

/** A mock backend that also records pointer handlers. */
function backend() {
  const b = createMockBackend();
  const pointers = new Map<MockNode, Partial<Record<PointerKind, () => void>>>();
  b.onPointer = (node, kind, fn) => {
    const m = pointers.get(node as MockNode) ?? {};
    m[kind] = fn;
    pointers.set(node as MockNode, m);
  };
  return { b, pointers };
}

const errorsOf = (fn: () => unknown): string[] => {
  try {
    fn();
    return [];
  } catch (e) {
    if (e instanceof TrempelError) return e.errors;
    throw e;
  }
};

const ids = (n: SceneNode | null): string[] => {
  const out: string[] = [];
  const walk = (x: SceneNode): void => {
    if (x.attrs.id) out.push(x.attrs.id);
    x.children.forEach(walk);
  };
  if (n) walk(n);
  return out;
};

describe('expand', () => {
  it('<use> → <g> with the placement, prefab content with prefixed ids, hrefs rebased', () => {
    const c = composeScene({
      base: svg(`<use id="ok" href="ui/button.svg" x="10" y="20" transform="scale(2)" opacity="0.5" data-label="OK" data-action="close"/>`),
      loadScene: loader(files()),
    });
    expect(c.errors).toEqual({ parse: [], prefab: [], contract: [], merge: [] });
    const g = c.tree!.children[0];
    expect(g.tag).toBe('g');
    expect(g.attrs).toEqual({ id: 'ok', transform: 'scale(2) translate(10 20)', opacity: '0.5' });
    expect(g.instance?.href).toBe('ui/button.svg');
    expect(g.instance?.params).toEqual({ 'data-label': 'OK', 'data-action': 'close' });
    expect(ids(g)).toEqual(['ok', 'ok/bg', 'ok/hit', 'ok/label']);
    const bg = g.children[0];
    expect(bg.attrs.href).toBe('ui/art/btn.png');
    expect(bg.attrs['data-views']).toBe('idle:ui/art/btn.png, hover:ui/art/btn-hover.png, pressed:ui/art/btn-down.png');
    // the prefab heir's tml travels with the nodes
    expect(g.children[2].tml.bind).toBe('self.label');
  });

  it('nesting: prefixes add up, inner hrefs are relative to the inner file', () => {
    const fs = files({
      'ui/panel.svg': { base: svg(`<image id="frame" href="frame.png"/><use id="close" href="button.svg" data-label="x" data-action="hide"/>`) },
    });
    const c = composeScene({ base: svg(`<use id="p" href="ui/panel.svg"/>`), loadScene: loader(fs) });
    expect(c.errors.prefab).toEqual([]);
    expect(ids(c.tree)).toEqual(['p', 'p/frame', 'p/close', 'p/close/bg', 'p/close/hit', 'p/close/label']);
    expect(c.tree!.children[0].children[0].attrs.href).toBe('ui/frame.png');
    const close = c.tree!.children[0].children[1];
    expect(close.instance?.rel).toBe('ui/button.svg');
    expect(close.instance?.scope.parent).toBe(c.tree!.children[0].instance?.scope);
  });

  it('a cycle is an error with the chain', () => {
    const fs = {
      'a.svg': { base: svg(`<use id="b" href="b.svg"/>`) },
      'b.svg': { base: svg(`<use id="a" href="a.svg"/>`) },
    };
    const c = composeScene({ base: svg(`<use id="x" href="a.svg"/>`), loadScene: loader(fs) });
    expect(withCode(c.errors.prefab, 'E_PREFAB_CYCLE')[0]).toContain('a.svg → b.svg → a.svg');
  });

  it('instance without id, width/height, foreign attributes, children — errors', () => {
    const c = composeScene({
      base: svg(
        `<use href="ui/button.svg"/>` +
          `<use id="w" href="ui/button.svg" width="10" data-label="a" data-action="b"/>` +
          `<use id="f" href="ui/button.svg" fill="red" data-label="a" data-action="b"/>` +
          `<use id="k" href="ui/button.svg" data-label="a" data-action="b"><rect/></use>`,
      ),
      loadScene: loader(files()),
    });
    const e = c.errors.prefab;
    expect(withCode(e, 'E_USE_NO_ID')[0]).toContain('<use href="ui/button.svg">');
    const resize = withCode(e, 'E_PREFAB_RESIZE')[0];
    expect(resize).toContain('#w: width');
    expect(resize).toContain('ui/button.svg');
    expect(withCode(e, 'E_USE_ATTR')[0]).toContain('#f: the attribute fill');
    const slots = withCode(e, 'E_SLOT_UNKNOWN')[0];
    expect(slots).toContain('#k');
    expect(slots).toContain('ui/button.svg');
  });

  it('no loader / missing prefab — errors', () => {
    expect(codesOf(composeScene({ base: svg(`<use id="a" href="x.svg"/>`) }).errors.prefab)).toEqual(['E_PREFAB_LOADER']);
    const missing = composeScene({ base: svg(`<use id="a" href="x.svg"/>`), loadScene: () => null }).errors.prefab;
    expect(codesOf(missing)).toEqual(['E_PREFAB_MISSING']);
    expect(missing[0]).toMatch(/#a: prefab x\.svg: .*x\.svg/);
    expect(codesOf(errorsOf(() => mount({ base: svg(`<use id="a" href="x.svg"/>`), backend: createMockBackend(), context: {} })))).toEqual(['E_PREFAB_LOADER']);
  });

  it('a prefab problem carries the instance prefix', () => {
    const fs = { 'bad.svg': { base: svg(`<rect id="r"/>`), heir: heirOf('bad.svg', `<tml:ref id="nope" tml:bind="1"/>`) } };
    const c = composeScene({ base: svg(`<use id="a" href="bad.svg"/>`), loadScene: loader(fs) });
    expect(codesOf(c.errors.prefab)).toEqual(['E_REF_MISSING']);
    expect(c.errors.prefab[0]).toMatch(/^E_REF_MISSING: #a \(bad\.svg\): <tml:ref id="nope">/);
  });
});

describe('parameters and self', () => {
  const MENU = svg(
    `<use id="a" href="ui/button.svg" data-label="Play" data-action="play"/>` +
      `<use id="b" href="ui/button.svg" data-label="=t('settings')" data-action="openSettings"/>`,
  );

  it('defaults, overrides, =expression reactive, self.call, self.id', () => {
    const { b } = backend();
    const state = reactive({ lang: 'en' });
    const calls: string[] = [];
    const ctx = {
      state,
      t: (k: string) => (state.lang === 'en' ? `[${k}]` : `<${k}>`),
      play: () => calls.push('play'),
      openSettings: () => calls.push('settings'),
    };
    const s = mount({ base: MENU, backend: b, context: ctx, loadScene: loader(files()) });
    const text = (id: string) => isMockNode(s.byId.get(id)!).props.text;
    expect(text('a/label')).toBe('Play');
    expect(text('b/label')).toBe('[settings]');
    state.lang = 'de';
    expect(text('b/label')).toBe('<settings>');
    isMockNode(s.byId.get('a/hit')!).clicks[0]();
    isMockNode(s.byId.get('b/hit')!).clicks[0]();
    expect(calls).toEqual(['play', 'settings']);
  });

  it('kebab → camel; self.id is the composite id; reserved names are refused', () => {
    const fs = { 'p.svg': { base: svg(`<text id="t">x</text>`, ' data-hit-size="4"'), heir: heirOf('p.svg', `<tml:ref id="t" tml:bind="self.hitSize + ':' + self.id"/>`) } };
    const s = mount({ base: svg(`<use id="q" href="p.svg"/>`), backend: createMockBackend(), context: {}, loadScene: loader(fs) });
    expect(isMockNode(s.byId.get('q/t')!).props.text).toBe('4:q');
    expect(composeScene({ base: svg(`<use id="q" href="p.svg" data-call="x"/>`), loadScene: loader(fs) }).errors.prefab[0]).toMatch(/^E_PARAM_RESERVED: #q: .*data-call.*self\.call/);
  });

  it('required params (contract params) are checked per instance', () => {
    const c = composeScene({ base: svg(`<use id="settingsBtn" href="ui/button.svg" data-label="S"/>`), loadScene: loader(files()) });
    expect(codesOf(c.errors.prefab)).toEqual(['E_PARAM_MISSING']);
    expect(c.errors.prefab[0]).toMatch(/^E_PARAM_MISSING: #settingsBtn: .*data-action.*ui\/button\.svg/);
  });

  it('a syntax error in an =parameter is reported with the instance', () => {
    const c = composeScene({ base: svg(`<use id="x" href="ui/button.svg" data-label="=a +" data-action="b"/>`), loadScene: loader(files()) });
    expect(c.errors.prefab[0]).toMatch(/^E_EXPR_SYNTAX: #x data-label: /);
  });

  it('pointer events drive self.state → tml:bind-view swaps the data-views variant', () => {
    const { b, pointers } = backend();
    const s = mount({ base: MENU, backend: b, context: { t: (k: string) => k, play() {}, openSettings() {} }, loadScene: loader(files()) });
    const bg = isMockNode(s.byId.get('a/bg')!);
    const hit = pointers.get(isMockNode(s.byId.get('a/hit')!))!;
    expect(bg.props.href).toBe('ui/art/btn.png');
    hit.over!();
    expect(bg.props.href).toBe('ui/art/btn-hover.png');
    hit.down!();
    expect(bg.props.href).toBe('ui/art/btn-down.png');
    hit.up!();
    hit.out!();
    expect(bg.props.href).toBe('ui/art/btn.png');
    // the other instance keeps its own state
    expect(isMockNode(s.byId.get('b/bg')!).props.href).toBe('ui/art/btn.png');
  });

  it('a backend without onPointer is told so', () => {
    expect(() => mount({ base: MENU, backend: createMockBackend(), context: { t: (k: string) => k }, loadScene: loader(files()) })).toThrow(
      expect.objectContaining({ code: 'E_BACKEND', message: expect.stringContaining('onPointer') }),
    );
  });

  it('self.call of a missing function is a runtime error with its place', () => {
    const { b } = backend();
    const seen: string[] = [];
    const s = mount({ base: MENU, backend: b, context: { t: (k: string) => k }, loadScene: loader(files()), onError: (i) => seen.push(`${i.node} ${i.attr}`) });
    isMockNode(s.byId.get('a/hit')!).clicks[0]();
    expect(seen).toEqual(['#a/hit tml:on-click']);
  });
});

describe('scene heir onto instances', () => {
  it('tml:ref id="a/b" overrides the prefab binding in the scene context; insert into a/b works', () => {
    const { b } = backend();
    const fs = files({ 'box.svg': { base: svg(`<g id="content"/><text id="cap">c</text>`) } });
    const s = mount({
      base: svg(`<use id="ok" href="ui/button.svg" data-label="OK" data-action="close"/><use id="box" href="box.svg"/>`),
      heir: heirOf('menu.svg', `<tml:ref id="ok/label" tml:bind="state.title"/><text id="extra" tml:insert="into box/content">e</text>`),
      backend: b,
      context: { state: { title: 'Over' }, close() {} },
      loadScene: loader(fs),
    });
    expect(isMockNode(s.byId.get('ok/label')!).props.text).toBe('Over');
    expect(isMockNode(s.byId.get('box/content')!).children.map((c) => c.attrs.id)).toEqual(['extra']);
  });

  it('a ref to a missing composite id is a merge error', () => {
    const e = errorsOf(() =>
      mount({ base: svg(`<use id="ok" href="ui/button.svg" data-label="a" data-action="b"/>`), heir: heirOf('m.svg', `<tml:ref id="ok/nope" tml:bind="1"/>`), backend: backend().b, context: {}, loadScene: loader(files()) }),
    );
    expect(codesOf(e)).toEqual(['E_REF_MISSING']);
    expect(e[0]).toContain('<tml:ref id="ok/nope">');
  });

  it('the scene base stays sterile: tml on a prefab node is not the scene\'s', () => {
    const c = composeScene({ base: svg(`<use id="ok" href="ui/button.svg" data-label="a" data-action="b"/>`), contract: '<contract/>', loadScene: loader(files()) });
    expect(c.errors.contract).toEqual([]);
  });
});

describe('multi-level tml:extends', () => {
  it('button-green: base of another scene, tml:href on an image, new param defaults, inherited contract', () => {
    const { b } = backend();
    const s = mount({ base: svg(`<use id="g" href="ui/button-green.svg" data-label="Go"/>`), backend: b, context: { go() {} }, loadScene: loader(files()) });
    const bg = isMockNode(s.byId.get('g/bg')!);
    expect(bg.attrs.href).toBe('ui/art/green.png');
    expect(isMockNode(s.byId.get('g/label')!).props.text).toBe('Go');
    // data-action got a default from the heir → not required at the instance; data-label still is
    const c = composeScene({ base: svg(`<use id="g" href="ui/button-green.svg"/>`), loadScene: loader(files()) });
    expect(codesOf(c.errors.prefab)).toEqual(['E_PARAM_MISSING']);
    expect(c.errors.prefab[0]).toMatch(/^E_PARAM_MISSING: #g: .*data-label.*ui\/button-green\.svg/);
  });

  it('three levels; the top scene itself may be an heir without base', () => {
    const fs = files({
      'ui/button-big.svg': { heir: heirOf('button-green.svg', `<tml:ref id="label" tml:bind="'BIG ' + self.label"/>`) },
    });
    const s = mount({ heir: heirOf('ui/button-big.svg', ''), backend: backend().b, context: { go() {} }, loadScene: loader(fs) });
    expect(isMockNode(s.byId.get('label')!).props.text).toBe('BIG Button');
    expect(isMockNode(s.byId.get('bg')!).attrs.href).toBe('ui/art/green.png');
    const c = composeScene({ base: svg(`<use id="x" href="ui/button-big.svg" data-label="L"/>`), loadScene: loader(fs) });
    expect(c.errors.prefab).toEqual([]);
    expect(c.tree!.children[0].children[2].tml.bind).toBe(`'BIG ' + self.label`);
  });

  it('a cycle of tml:extends is an error', () => {
    const fs = { 'a.svg': { heir: heirOf('b.svg', '') }, 'b.svg': { heir: heirOf('a.svg', '') } };
    const c = composeScene({ heir: heirOf('a.svg', ''), path: 'top.svg', loadScene: loader(fs) });
    expect(withCode(c.errors.prefab, 'E_EXTENDS_CYCLE')[0]).toContain('top.svg → a.svg → b.svg → a.svg');
    expect(c.tree).toBeNull();
  });

  it('tml:href onto a non-image is refused', () => {
    const fs = { 'p.svg': { base: svg(`<rect id="r"/>`) }, 'q.svg': { heir: heirOf('p.svg', `<tml:ref id="r" tml:href="x.png"/>`) } };
    const e = composeScene({ heir: heirOf('q.svg', ''), loadScene: loader(fs) }).errors.prefab;
    expect(withCode(e, 'E_REF_HREF')[0]).toContain('<tml:ref id="r"');
  });

  it('an heir without a base and without tml:extends of another scene is an error', () => {
    expect(codesOf(composeScene({ heir: `<svg ${NS}/>` }).errors.parse)).toEqual(['E_EMPTY_SCENE']);
  });
});

describe('contract', () => {
  it('<use id href>: the right prefab passes, another is "expected an instance of …", params on the root', () => {
    const contract = `<contract><use id="settingsBtn" href="ui/button.svg"/><text id="settingsBtn/label"/></contract>`;
    const ok = composeScene({ base: svg(`<use id="settingsBtn" href="ui/button.svg" data-label="a" data-action="b"/>`), contract, loadScene: loader(files()) });
    expect(ok.errors.contract).toEqual([]);
    const bad = composeScene({ base: svg(`<use id="settingsBtn" href="ui/button-green.svg" data-label="a"/>`), contract, loadScene: loader(files()) });
    expect(codesOf(bad.errors.contract)).toEqual(['E_CONTRACT_TAG']);
    expect(bad.errors.contract[0]).toMatch(/^E_CONTRACT_TAG: #settingsBtn: .*ui\/button\.svg.*ui\/button-green\.svg/);
    const notUse = composeScene({ base: svg(`<g id="settingsBtn"><text id="settingsBtn/label">x</text></g>`), contract });
    expect(notUse.errors.contract[0]).toMatch(/^E_CONTRACT_TAG: #settingsBtn: .*<use href="ui\/button\.svg">.*<g>/);
  });

  it('params need defaults on the prefab root when it is checked as a scene', () => {
    const c = parseContract('<contract params="data-label data-icon"/>');
    expect(c.params).toEqual(['data-label', 'data-icon']);
    const e = checkContract({ tag: 'svg', attrs: { 'data-label': 'x' }, tml: {}, children: [] }, c);
    expect(codesOf(e)).toEqual(['E_CONTRACT_ATTR']);
    expect(e[0]).toContain('data-icon');
    const bad = thrown(() => parseContract('<contract params="icon"/>'));
    expect(bad).toMatchObject({ code: 'E_CONTRACT_SYNTAX' });
    expect(bad.message).toContain('"icon"');
  });

  it('the prefab checked alone: own contract against its base', () => {
    const c = composeScene({ ...BUTTON, path: 'ui/button.svg' });
    expect(c.errors).toEqual({ parse: [], prefab: [], contract: [], merge: [] });
    // button-green inherits button's contract and its base carries tml — not a sterility error
    const g = composeScene({ ...GREEN, path: 'ui/button-green.svg', loadScene: (u) => files()[`ui/${u}`] ?? null });
    expect(g.errors).toEqual({ parse: [], prefab: [], contract: [], merge: [] });
    expect(g.contract?.params).toEqual(['data-label', 'data-action']);
  });
});

describe('async loader', () => {
  it('mountAsync preloads instances and the extends chain', async () => {
    const fs = files();
    const asked: string[] = [];
    const s = await mountAsync({
      base: svg(`<use id="g" href="ui/button-green.svg" data-label="Go"/>`),
      backend: backend().b,
      context: { go() {} },
      baseUrl: 'https://cdn.example/scenes/menu.svg',
      loadScene: async (url) => {
        asked.push(url);
        return fs[url.replace('https://cdn.example/scenes/', '')] ?? null;
      },
    });
    expect(asked.sort()).toEqual(['https://cdn.example/scenes/ui/button-green.svg', 'https://cdn.example/scenes/ui/button.svg']);
    expect(isMockNode(s.byId.get('g/label')!).props.text).toBe('Go');
  });

  it('a sync mount with an async loader says to use mountAsync', () => {
    const e = errorsOf(() => mount({ base: svg(`<use id="a" href="x.svg"/>`), backend: createMockBackend(), context: {}, loadScene: async () => null }));
    expect(codesOf(e)).toEqual(['E_PREFAB_LOADER']);
    expect(e[0]).toContain('mountAsync');
  });
});
