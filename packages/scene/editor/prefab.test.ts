// v0.9 prefab commands of the editor core: instantiate / setParam / detach / extract — each with
// undo / redo; extract creates the files (roundtrip through the loader); detach renders the same.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOf, mount, type SceneSource } from '@trempel/scene/core';
import { openDocument, type EditorDocument } from './index.js';
import { createMockBackend, type MockNode } from '../test/helpers/mockBackend';

const dir = fileURLToPath(new URL('../examples/prefabs/', import.meta.url));
const read = (p: string): string | undefined => (existsSync(join(dir, p)) ? readFileSync(join(dir, p), 'utf8') : undefined);
const loadScene = (rel: string): SceneSource | null => {
  const stem = rel.replace(/\.svg$/, '');
  const src = { base: read(`${stem}.svg`), heir: read(`${stem}.tml.svg`), contract: read(`${stem}.contract.xml`) };
  return src.base != null || src.heir != null ? src : null;
};
const MENU = read('menu.svg')!;
/** The example's own data: the button's default label, the shop button's label. */
const BUTTON_LABEL = /data-label="([^"]*)"/.exec(read('ui/button.svg')!)![1];
const SHOP_LABEL = /id="shopBtn"[^>]*data-label="([^"]*)"/.exec(MENU)![1];
const open = (svg = MENU): EditorDocument => openDocument(svg, { heir: read('menu.tml.svg'), contract: read('menu.contract.xml'), path: 'menu.svg', loadScene });

function roundtrip(doc: EditorDocument, name: string, args: unknown): string {
  const before = doc.serialize();
  const res = doc.exec(name, args);
  expect(res.errors).toBeUndefined();
  const after = doc.serialize();
  expect(after).not.toBe(before);
  expect(doc.undo()).toBe(true);
  expect(doc.serialize()).toBe(before);
  expect(doc.redo()).toBe(true);
  expect(doc.serialize()).toBe(after);
  return after;
}

/** What a mock render shows: tags, ids, transforms, effective text and href. */
function picture(n: MockNode): unknown {
  return {
    tag: n.tag,
    id: n.attrs.id,
    transform: n.attrs.transform,
    text: n.props.text,
    href: n.props.href ?? n.attrs.href,
    children: n.children.map(picture),
  };
}
const ctx = { t: (k: string) => k, state: { coins: 0 } };
const backend = () => ({ ...createMockBackend(), onPointer() {} });

describe('prefab commands', () => {
  it('the example opens clean: instances expanded in doc.merged, the tree shows <use> with href', () => {
    const doc = open();
    expect(doc.errors).toEqual([]);
    const top = doc.tree()[0].children.find((c) => c.id === 'shopBtn')!;
    expect(top).toMatchObject({ tag: 'use', href: 'ui/button-green.svg', children: [] });
    expect(doc.instance('shopBtn')).toMatchObject({ href: 'ui/button-green.svg', expanded: true, missing: [] });
    expect(doc.instance('settingsBtn')!.params).toEqual([
      { name: 'data-label', value: "=t('settings')", own: true, required: true, default: BUTTON_LABEL },
      { name: 'data-action', value: 'openSettings', own: true, required: true, default: '' },
    ]);
  });

  it('prefab.instantiate — <use id href x y data-*>, unknown prefab / taken id refused; undo/redo', () => {
    const doc = open();
    const after = roundtrip(doc, 'prefab.instantiate', { href: 'ui/button.svg', id: 'helpBtn', x: 10, y: 540, params: { label: 'Help', 'data-action': 'help' } });
    expect(after).toContain('<use id="helpBtn" href="ui/button.svg" x="10" y="540" data-label="Help" data-action="help"/>');
    expect(doc.errors).toEqual([]);
    expect(doc.exec('prefab.instantiate', { href: 'ui/nope.svg', id: 'x' }).errors![0]).toMatch(/^E_PREFAB_MISSING: .*ui\/nope\.svg/);
    expect(doc.exec('prefab.instantiate', { href: 'ui/button.svg', id: 'playBtn' }).errors![0]).toMatch(/^E_EDITOR_ID_TAKEN: /);
  });

  it('a new instance without required params — doc.errors says which', () => {
    const doc = open();
    doc.exec('prefab.instantiate', { href: 'ui/button.svg', id: 'b5' });
    expect(doc.errors.map(codeOf)).toEqual(['E_PARAM_MISSING', 'E_PARAM_MISSING']);
    expect(doc.errors[0]).toContain('data-label');
    expect(doc.errors[1]).toContain('data-action');
    expect(doc.instance('b5')!.missing).toEqual(['data-label', 'data-action']);
  });

  it('prefab.setParam — sets / removes data-*; presentation data-* refused; only on <use>', () => {
    const doc = open();
    const after = roundtrip(doc, 'prefab.setParam', { node: 'exitBtn', name: 'label', value: 'Bye' });
    expect(after).toContain('data-label="Bye"');
    roundtrip(doc, 'prefab.setParam', { node: 'exitBtn', name: 'data-label', value: null });
    expect(doc.errors.map(codeOf)).toEqual(['E_PARAM_MISSING']);
    expect(doc.errors[0]).toContain('#exitBtn');
    expect(doc.exec('prefab.setParam', { node: 'exitBtn', name: 'z', value: '1' }).errors![0]).toMatch(/^E_EDITOR_PARAM: /);
    expect(doc.exec('prefab.setParam', { node: 'title', name: 'label', value: '1' }).errors![0]).toMatch(/^E_EDITOR_NOT_INSTANCE: /);
  });

  it('node.move moves an instance by x/y', () => {
    const doc = open();
    expect(roundtrip(doc, 'node.move', { node: 'exitBtn', dx: 5, dy: -10 })).toContain('<use id="exitBtn" href="ui/button.svg" x="285" y="440"');
  });

  it('prefab.detach — a <g> with the prefab content (composite ids), same picture; undo/redo', () => {
    const doc = open();
    const before = mount({ base: doc.serialize(), backend: backend(), context: ctx, loadScene });
    const res = doc.exec('prefab.detach', { node: 'shopBtn' });
    expect(res.ok).toBe(true);
    expect(res.warnings?.[0]).toMatch(/^W_EDITOR_DETACH: /);
    const after = doc.serialize();
    // v1.0: the button is resizable with anchors inside — the copy is a box of its size
    expect(after).toContain('<g id="shopBtn" transform="translate(280 360)" data-size="240 72">');
    // static bindings baked: the label parameter, the green backdrop of button-green (tml:href)
    expect(after).toContain(`<text id="shopBtn/label" x="120" y="46" text-anchor="middle" font-size="28" font-weight="bold" fill="#ffffff" data-anchor="0.5 0">${SHOP_LABEL}</text>`);
    expect(after).toContain('<image id="shopBtn/bg" href="ui/art/green.png"');
    const detached = mount({ base: after, backend: backend(), context: ctx, loadScene });
    const pic = (s: ReturnType<typeof mount>, id: string) => picture(s.byId.get(id) as MockNode);
    for (const id of ['shopBtn', 'exitBtn', 'playBtn']) expect(pic(detached, id)).toEqual(pic(before, id));
    // the contract still wants an instance there
    expect(doc.errors.map(codeOf)).toEqual(['E_CONTRACT_TAG']);
    expect(doc.errors[0]).toContain('#shopBtn');
    doc.undo();
    expect(doc.serialize()).toBe(MENU);
    doc.redo();
    expect(doc.serialize()).toBe(after);
  });

  it('prefab.extract — a group → new prefab files + <use>; roundtrip: the instance draws the same', () => {
    const SCENE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">
  <g id="badge" transform="translate(40 30)" opacity="0.9">
    <image id="badge/icon" href="ui/art/btn.png" width="60" height="20"/>
    <text id="badge/caption" x="5" y="15">Hi</text>
  </g>
</svg>
`;
    const doc = openDocument(SCENE, { path: 'scene.svg', loadScene });
    const before = mount({ base: SCENE, backend: backend(), context: {} });
    const res = doc.exec('prefab.extract', { node: 'badge', href: 'ui/badge.svg', params: [{ node: 'badge/caption', attr: 'text', name: 'caption' }, { node: 'badge/icon', attr: 'href', name: 'icon' }] });
    expect(res.errors).toBeUndefined();
    expect(res.files!.map((f) => f.path)).toEqual(['ui/badge.svg', 'ui/badge.tml.svg']);
    const [base, heir] = res.files!.map((f) => f.text);
    expect(base).toContain('<svg xmlns="http://www.w3.org/2000/svg" data-caption="Hi" data-icon="art/btn.png">');
    expect(base).toContain('<image id="icon" href="art/btn.png" width="60" height="20"/>');
    expect(heir).toContain('tml:extends="badge.svg"');
    expect(heir).toContain('<tml:ref id="caption" tml:bind="self.caption"/>');
    const after = doc.serialize();
    expect(after).toContain('<use id="badge" href="ui/badge.svg" transform="translate(40 30)" opacity="0.9" data-caption="Hi" data-icon="ui/art/btn.png"/>');
    expect(doc.errors).toEqual([]);
    // the new files through a loader: the instance renders like the group did
    const files: Record<string, string> = Object.fromEntries(res.files!.map((f) => [f.path, f.text]));
    const load = (rel: string): SceneSource | null => (rel === 'ui/badge.svg' ? { base: files['ui/badge.svg'], heir: files['ui/badge.tml.svg'] } : null);
    const inst = mount({ base: after, backend: backend(), context: {}, loadScene: load });
    expect(picture(inst.byId.get('badge') as MockNode)).toEqual(picture(before.byId.get('badge') as MockNode));
    // undo / redo of the document (the files stay — the host wrote them)
    doc.undo();
    expect(doc.serialize()).toBe(SCENE);
    doc.redo();
    expect(doc.serialize()).toBe(after);
    // an existing prefab name is refused
    expect(openDocument(SCENE, { loadScene }).exec('prefab.extract', { node: 'badge', href: 'ui/button.svg' }).errors![0]).toMatch(/^E_EDITOR_FILE_EXISTS: /);
  });
});
