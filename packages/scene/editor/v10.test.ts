// v1.0 in the editor core: a scene with a resizable prefab and slots opens clean and serializes byte
// for byte; node.resize (instance along its axes, image, rect, data-size group) and node.setAttr
// data-slices — each with undo / redo; the operator S over a resizable instance / a 9-slice image
// writes width / height, not a transform.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOf, mount, type SceneSource } from '@trempel/scene/core';
import { createMockBackend, type MockNode } from '../test/helpers/mockBackend';
import { openDocument, type EditorDocument } from './index.js';
import { applyOp, type OpHost } from '../edit/ops';
import { nodeAt, type Box } from '../edit/geometry';

const dir = fileURLToPath(new URL('../examples/prefabs/', import.meta.url));
const read = (p: string): string | undefined => (existsSync(join(dir, p)) ? readFileSync(join(dir, p), 'utf8') : undefined);
const loadScene = (rel: string): SceneSource | null => {
  const stem = rel.replace(/\.svg$/, '');
  const src = { base: read(`${stem}.svg`), heir: read(`${stem}.tml.svg`), contract: read(`${stem}.contract.xml`) };
  return src.base != null || src.heir != null ? src : null;
};
const PAUSE = read('popup-pause.svg')!;
const open = (svg = PAUSE): EditorDocument =>
  openDocument(svg, { heir: read('popup-pause.tml.svg'), contract: read('popup-pause.contract.xml'), clips: { 'anim/popup-pause.md': read('anim/popup-pause.md')! }, path: 'popup-pause.svg', loadScene });

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

describe('v1.0 — editor core', () => {
  it('popup-pause opens clean, serializes byte for byte, shows slot children under the <use>', () => {
    const doc = open();
    expect(doc.errors).toEqual([]);
    expect(doc.serialize()).toBe(PAUSE);
    const pause = doc.tree()[0].children.find((c) => c.id === 'pause')!;
    expect(pause.href).toBe('ui/panel.svg');
    expect(pause.children.map((c) => c.id)).toEqual(['resumeBtn', 'settingsBtn', 'exitBtn', 'hint']);
    expect(doc.instance('pause')).toMatchObject({ size: { w: 600, h: 800 }, min: { w: 320, h: 240 }, resizable: 'xy' });
    expect(doc.instance('resumeBtn')).toMatchObject({ size: { w: 440, h: 72 }, resizable: 'x' });
    // presentation, not parameters
    expect(doc.instance('pause')!.params.map((p) => p.name)).toEqual(['data-title', 'data-close']);
  });

  it('node.resize on an instance writes width/height along its axes; a wrong axis is an error', () => {
    const doc = open();
    const after = roundtrip(doc, 'node.resize', { node: 'pause', width: 500 });
    expect(after).toContain('width="500" height="800"');
    expect(doc.instance('pause')!.size).toEqual({ w: 500, h: 800 });
    expect(doc.exec('node.resize', { node: 'resumeBtn', height: 90 }).errors?.[0]).toMatch(/^E_PREFAB_RESIZE: #resumeBtn: ui\/button.svg /);
    roundtrip(doc, 'node.resize', { node: 'pause', width: null, height: null });
    expect(doc.instance('pause')!.size).toEqual({ w: 320, h: 240 });
    // below the minimum — applied, but reported
    doc.exec('node.resize', { node: 'pause', width: 100 });
    expect(doc.errors.some((e) => codeOf(e) === 'E_PREFAB_MIN_SIZE' && e.includes('#pause'))).toBe(true);
  });

  it('node.resize on image / rect / g[data-size]; node.setAttr data-slices — undo/redo', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">
  <image id="p" href="ui/art/panel.png" width="320" height="240"/>
  <rect id="r" width="10" height="10"/>
  <g id="zone" data-size="100 50"><rect id="k" width="5" height="5" data-anchor="1 0"/></g>
  <text id="t">x</text>
</svg>`;
    const doc = openDocument(svg);
    expect(roundtrip(doc, 'node.setAttr', { node: 'p', name: 'data-slices', value: '40 96 40 40' })).toContain('data-slices="40 96 40 40"');
    expect(roundtrip(doc, 'node.resize', { node: 'p', width: 400, height: 260 })).toContain('width="400" height="260" data-slices');
    expect(roundtrip(doc, 'node.resize', { node: 'r', height: 30 })).toContain('<rect id="r" width="10" height="30"/>');
    expect(roundtrip(doc, 'node.resize', { node: 'zone', width: 140 })).toContain('data-size="140 50"');
    expect(doc.exec('node.resize', { node: 't', width: 3 }).errors?.[0]).toMatch(/^E_EDITOR_TAG: /);
    doc.exec('node.setAttr', { node: 'p', name: 'data-slices', value: '1 2 3' });
    expect(doc.errors.some((e) => codeOf(e) === 'E_SLICES' && e.includes('#p'))).toBe(true);
  });
});

describe('v1.0 — detach bakes the size', () => {
  it('a resized panel → <g data-size> with anchored nodes moved and the background grown; draws the same', () => {
    const doc = open();
    const before = mount({ base: PAUSE, heir: read('popup-pause.tml.svg'), backend: { ...createMockBackend(), onPointer() {} }, context: { t: (k: string) => k }, loadScene, onError: () => {} });
    expect(doc.exec('prefab.detach', { node: 'pause' }).ok).toBe(true);
    const after = doc.serialize();
    expect(after).toContain('<g id="pause" data-anchor="0.5 0.5" transform="translate(60 100)" data-size="600 800">');
    expect(after).toMatch(/<image id="pause\/bg" href="ui\/art\/panel.png" width="600" height="800" data-slices/);
    expect(after).toMatch(/<text id="pause\/title" x="300" y="46"/);
    expect(after).toMatch(/<use id="pause\/close" x="542" y="8" data-anchor="1 0" href="ui\/icon-button.svg"/);
    expect(after).toMatch(/<g id="pause\/content" transform="translate\(40 96\)">\s*<use id="resumeBtn"/);
    const detached = mount({ base: after, heir: read('popup-pause.tml.svg'), backend: { ...createMockBackend(), onPointer() {} }, context: { t: (k: string) => k }, loadScene, onError: () => {} });
    const at = (s: ReturnType<typeof mount>, id: string) => {
      const n = s.byId.get(id) as MockNode;
      return { x: n.props.x ?? n.attrs.x, y: n.props.y ?? n.attrs.y, w: n.props.width ?? n.attrs.width, h: n.props.height ?? n.attrs.height };
    };
    for (const id of ['pause/bg', 'pause/close', 'resumeBtn/bg']) {
      expect(Number(at(detached, id).w ?? 0)).toBe(Number(at(before, id).w ?? 0));
    }
  });
});

describe('v1.0 — operator S writes sizes', () => {
  /** An op host over a document; bounds given by hand (the runtime measures them in the editor). */
  function host(doc: EditorDocument, bounds: Record<string, Box>): OpHost {
    const pathOf = (id: string): string | null => {
      const walk = (n: ReturnType<typeof doc.tree>[number]): string | null => (n.id === id ? n.path : n.children.map(walk).find((x) => x != null) ?? null);
      return walk(doc.tree()[0]);
    };
    const b = new Map<string, Box>();
    for (const [id, box] of Object.entries(bounds)) b.set(pathOf(id)!, box);
    return {
      doc,
      bounds: b,
      selection: [],
      ref: (p) => nodeAt(doc.scene, p)?.attrs.id ?? p,
      pathOfId: pathOf,
      batch: (label, calls) => doc.batch(label, calls),
      instance: (r) => doc.instance(r),
    };
  }

  it('S along x on a resizable instance → node.resize + node.move (its centre stays), not a transform', () => {
    const doc = open();
    const h = host(doc, { pause: { x: 60, y: 100, w: 600, h: 800 } });
    const r = applyOp(h, 'S', { nodes: ['pause'], axis: 'x', value: 0.6 })!;
    expect(r.ok).toBe(true);
    const s = doc.serialize();
    expect(s).toMatch(/<use id="pause" href="ui\/panel.svg" x="180" y="100" width="360" height="800"/);
    expect(s).not.toMatch(/id="pause"[^>]*transform/);
  });

  it('S never goes below the prefab minimum; a non-resizable axis stays', () => {
    const doc = open();
    const h = host(doc, { resumeBtn: { x: 140, y: 256, w: 440, h: 72 } });
    applyOp(h, 'S', { nodes: ['resumeBtn'], value: 0.1 });
    expect(doc.serialize()).toMatch(/<use id="resumeBtn" slot="content" href="ui\/button.svg" x="[\d.]+" y="60" width="240"/);
  });

  it('S on a rotated 9-slice image resizes its box in its own axes', () => {
    const doc = openDocument(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">
  <image id="p" href="a.png" x="0" y="0" width="100" height="50" data-slices="10" data-pivot="0 0" transform="translate(200 100) rotate(30)"/>
</svg>`);
    const h = host(doc, { p: { x: 175, y: 100, w: 112, h: 93 } });
    applyOp(h, 'S', { nodes: ['p'], axis: 'x', value: 2 });
    const s = doc.serialize();
    expect(s).toContain('width="200"');
    expect(s).toContain('transform="translate(200 100) rotate(30)"');
  });
});
