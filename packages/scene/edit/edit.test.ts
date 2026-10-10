// edit/ — the editor page's pure parts: projection scene ↔ screen, gestures → core commands,
// hit-test by z, the dev server's write guard, the render bookkeeping (paths of drawn nodes,
// stand-ins for unknown components).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mount, parse, type SceneNode } from '@trempel/scene/core';
import { parseTransform, multiply } from '@trempel/scene/internal/transform';
import { openDocument } from '../editor/index.js';
import { fitStage, parseViewport } from '../view/viewport';
import { writeRenderFile, writeSceneFile } from '../view/plugin';
import { ClipPlayer, compileSceneClips } from '../view/clips';
import { PixiBackend } from '../src/render/pixi';
import {
  apply,
  compose,
  decompose,
  gestureCommands,
  invert,
  nodeWorld,
  parentWorld,
  resizeCommands,
  screenDeltaToParent,
  screenToSceneMap,
  transformArgs,
  viewMatrix,
  canvasToScene,
  stageView,
  centredOrigin,
  zoomAbout,
  nodeAt,
  type Matrix,
  type Pt,
} from './geometry';
import { hitTest, topmostLeaf, type HitNode } from './hittest';
import { annotate, PATH_ATTR, recordingBackend, StandInRegistry } from './render';
import { clipFiles, relativeTo } from './io';
import { createTml, type TmlHost } from './app/tml';
import { createMockBackend, isMockNode } from '../test/helpers/mockBackend';
import { Registry, type NodeHandle } from '../src/core';

const close = (a: Pt, b: Pt, eps = 1e-6): void => {
  expect(Math.abs(a.x - b.x)).toBeLessThan(eps);
  expect(Math.abs(a.y - b.y)).toBeLessThan(eps);
};
const closeM = (a: Matrix, b: Matrix, eps = 1e-6): void => a.forEach((v, i) => expect(Math.abs(v - b[i]), `[${i}] ${v} vs ${b[i]}`).toBeLessThan(eps));

const rot = (deg: number, cx = 0, cy = 0): Matrix => {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy];
};

/** A small scene: a rotated, pivoted group with children. */
const SCENE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">
  <defs id="defs">
    <path id="route" d="M 0 0 L 100 0"/>
  </defs>
  <rect id="bg" width="400" height="300" fill="#000"/>
  <g id="arm" transform="translate(200 150) rotate(90) scale(2) translate(-10 -5)">
    <rect id="a" x="0" y="0" width="20" height="10"/>
    <g id="inner" transform="translate(30 0)">
      <image id="pic" href="x.png" x="5" y="5" width="10" height="10"/>
    </g>
  </g>
  <rect id="top" x="300" y="200" width="50" height="50"/>
</svg>
`;

describe('projection scene ↔ screen', () => {
  const tree = parse(SCENE);

  it('viewport "scene", zoom 1: view is the fit (scale 1, no offset); canvas px = scene', () => {
    const fit = fitStage({ x: 0, y: 0, w: 400, h: 300 }, parseViewport('scene'));
    const V = viewMatrix(fit, 1);
    close(apply(V, { x: 10, y: 20 }), { x: 10, y: 20 });
    expect(canvasToScene(fit, { x: 10, y: 20, w: 5, h: 5 })).toEqual({ x: 10, y: 20, w: 5, h: 5 });
  });

  it('aspect 9:16 at zoom 0.5: the scene is centred in the taller stage; screen ↔ scene round trip', () => {
    const fit = fitStage({ x: 0, y: 0, w: 400, h: 300 }, parseViewport('9:16'));
    expect(fit.width).toBe(400);
    expect(fit.height).toBe(711);
    const V = viewMatrix(fit, 0.5);
    const s = apply(V, { x: 0, y: 0 });
    close(s, { x: 0, y: ((711 - 300) / 2) * 0.5 });
    close(apply(invert(V), apply(V, { x: 123, y: 45 })), { x: 123, y: 45 });
  });

  it('transform chain with rotate and pivot: a child point lands where the SVG chain puts it', () => {
    // arm: translate(200 150) rotate(90) scale(2) translate(-10 -5) — pivot (10, 5) rotated & doubled at (200,150)
    const W = nodeWorld(tree, '2/0'); // rect#a in arm
    close(apply(W, { x: 10, y: 5 }), { x: 200, y: 150 }); // the pivot stays at the translate
    close(apply(W, { x: 20, y: 5 }), { x: 200, y: 170 }); // +10 along x → rotated 90° and ×2 → +20 down
    const fit = fitStage({ x: 0, y: 0, w: 400, h: 300 }, parseViewport('scene'));
    const S = multiply(viewMatrix(fit, 2), W);
    close(apply(S, { x: 20, y: 5 }), { x: 400, y: 340 });
  });

  it('nested groups: world of the image = arm · inner (x/y stay geometry, not transform)', () => {
    const W = nodeWorld(tree, '2/1/0');
    const expected = multiply(multiply(parseTransform('translate(200 150) rotate(90) scale(2) translate(-10 -5)'), parseTransform('translate(30 0)')), [1, 0, 0, 1, 0, 0]);
    closeM(W, expected);
    closeM(parentWorld(tree, '2/1/0'), expected);
  });
});

describe('gestures → core commands', () => {
  it('drag under a rotated parent: screen delta → node.move in parent space; the world position follows the pointer', () => {
    const doc = openDocument(SCENE);
    const tree = doc.scene;
    const fit = fitStage({ x: 0, y: 0, w: 400, h: 300 }, parseViewport('scene'));
    const V = viewMatrix(fit, 1.5);
    const P = parentWorld(tree, '2/0');
    const d = screenDeltaToParent(30, 0, V, P);
    // parent: rotate 90 ×2 → screen +x (30px = 20 scene) is parent −y by 10
    close(d, { x: 0, y: -10 });
    const before = apply(nodeWorld(doc.scene, '2/0'), { x: 0, y: 0 });
    const calls = gestureCommands({ ref: 'a', node: tree.children[2].children[0], parent: P, box: { x: 0, y: 0, w: 1, h: 1 } }, screenToSceneMap([1, 0, 0, 1, 30, 0], V));
    expect(calls).toEqual([{ name: 'node.move', args: { node: 'a', dx: 0, dy: -10 } }]);
    for (const c of calls) expect(doc.exec(c.name, c.args).ok).toBe(true);
    const after = apply(nodeWorld(doc.scene, '2/0'), { x: Number(doc.scene.children[2].children[0].attrs.x), y: Number(doc.scene.children[2].children[0].attrs.y) });
    close(after, { x: before.x + 20, y: before.y });
  });

  it('rotate about the box centre → node.setTransform; the new world = D · old world', () => {
    const doc = openDocument(SCENE);
    const path = '2/1'; // g#inner
    const node = doc.scene.children[2].children[1];
    const P = parentWorld(doc.scene, path);
    const W0 = nodeWorld(doc.scene, path);
    const box = { x: 150, y: 180, w: 40, h: 20 };
    const D = rot(30, 170, 190);
    const calls = gestureCommands({ ref: 'inner', node, parent: P, box }, D);
    expect(calls[0].name).toBe('node.setTransform');
    expect(calls[0].args.pivot).toBeDefined();
    expect(doc.exec(calls[0].name, calls[0].args).ok).toBe(true);
    closeM(nodeWorld(doc.scene, path), multiply(D, W0), 0.02);
  });

  it('uniform scale of a node under a rotated parent; resize of an axis-aligned image by attributes', () => {
    const doc = openDocument(SCENE);
    const node = doc.scene.children[3];
    const P = parentWorld(doc.scene, '3');
    const D: Matrix = [2, 0, 0, 2, -325, -225]; // ×2 about (325, 225) = centre of #top
    const calls = gestureCommands({ ref: 'top', node, parent: P, box: { x: 300, y: 200, w: 50, h: 50 } }, D);
    expect(doc.exec(calls[0].name, calls[0].args).ok).toBe(true);
    const W = nodeWorld(doc.scene, '3');
    close(apply(W, { x: 300, y: 200 }), { x: 275, y: 175 }, 0.01);

    const doc2 = openDocument(SCENE);
    const r = resizeCommands({ ref: 'top', node: doc2.scene.children[3], parent: P, box: { x: 300, y: 200, w: 50, h: 50 } }, [1.5, 0, 0, 1, -150, 0]);
    expect(r).toEqual([
      { name: 'node.setAttr', args: { node: 'top', name: 'width', value: 75 } },
    ]);
    // under a parent turned by 30° a screen-axis stretch is not axis-aligned in user space → null (use scale)
    const tilted = parse('<svg xmlns="http://www.w3.org/2000/svg"><g transform="rotate(30)"><image id="p" width="10" height="10"/></g></svg>');
    expect(resizeCommands({ ref: 'p', node: tilted.children[0].children[0], parent: parentWorld(tilted, '0/0'), box: { x: 0, y: 0, w: 1, h: 1 } }, [1.5, 0, 0, 1, 0, 0])).toBeNull();
  });

  it('decompose ↔ compose ↔ the matrix the core writes for those parts (pivot, rotate, non-uniform scale)', () => {
    const M = multiply(multiply(rot(37, 12, 7), [1.5, 0, 0, 0.5, 0, 0]), [1, 0, 0, 1, 40, -3]);
    const parts = decompose(M, { x: 12, y: 7 })!;
    closeM(compose(parts), M);
    const doc = openDocument(SCENE);
    expect(doc.exec('node.setTransform', transformArgs('top', parts)).ok).toBe(true);
    closeM(parseTransform(doc.scene.children[3].attrs.transform), M, 0.01);
    expect(decompose([1, 0.5, 0, 1, 0, 0])).toBeNull(); // skew
  });

  it('a pivot at (0, 0) is passed explicitly — the core would otherwise take data-pivot (v0.8)', () => {
    const M = rot(30, 0, 0);
    const parts = decompose(M, { x: 0, y: 0 })!;
    expect(transformArgs('top', parts).pivot).toEqual([0, 0]);
    const doc = openDocument(SCENE.replace('id="top"', 'id="top" data-pivot="40 40"'));
    expect(doc.exec('node.setTransform', transformArgs('top', parts)).ok).toBe(true);
    closeM(parseTransform(doc.scene.children[3].attrs.transform), M, 0.01);
  });
});

describe('hit-test by z', () => {
  const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
  const root: HitNode = {
    path: '',
    tag: 'svg',
    children: [
      { path: '0', tag: 'defs', children: [{ path: '0/0', tag: 'path', bounds: box(0, 0, 100, 100), children: [] }] },
      { path: '1', tag: 'rect', bounds: box(0, 0, 100, 100), children: [] },
      {
        path: '2',
        tag: 'g',
        bounds: box(10, 10, 80, 80),
        children: [
          { path: '2/0', tag: 'image', bounds: box(10, 10, 40, 40), children: [] },
          { path: '2/1', tag: 'g', bounds: box(40, 40, 50, 50), children: [{ path: '2/1/0', tag: 'rect', bounds: box(40, 40, 50, 50), children: [] }] },
        ],
      },
      { path: '3', tag: 'text', bounds: box(45, 45, 10, 10), children: [] },
    ],
  };

  it('the last drawn leaf wins; groups by their content only; service geometry is not hit', () => {
    expect(topmostLeaf(root, { x: 50, y: 50 })).toBe('3');
    expect(topmostLeaf(root, { x: 20, y: 20 })).toBe('2/0');
    expect(topmostLeaf(root, { x: 95, y: 5 })).toBe('1');
    expect(topmostLeaf(root, { x: 200, y: 200 })).toBeNull();
  });

  it('selects the child of the scope; inside a group after double click; outside it — back to the root', () => {
    expect(hitTest(root, { x: 20, y: 20 })).toEqual({ path: '2', scope: '' });
    expect(hitTest(root, { x: 60, y: 60 })).toEqual({ path: '2', scope: '' });
    expect(hitTest(root, { x: 60, y: 60 }, { scope: '2' })).toEqual({ path: '2/1', scope: '2' });
    expect(hitTest(root, { x: 60, y: 60 }, { scope: '2/1' })).toEqual({ path: '2/1/0', scope: '2/1' });
    expect(hitTest(root, { x: 95, y: 5 }, { scope: '2' })).toEqual({ path: '1', scope: '' });
  });

  it('hidden / locked subtrees are skipped', () => {
    expect(hitTest(root, { x: 50, y: 50 }, { skip: (p) => p === '3' })).toEqual({ path: '2', scope: '' });
    expect(hitTest(root, { x: 60, y: 60 }, { skip: (p) => p === '3' || p.startsWith('2') })).toEqual({ path: '1', scope: '' });
  });
});

describe('SceneIO dev — writes only bases inside the folder', () => {
  let dir = '';
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'tml-edit-io-'));
    mkdirSync(join(dir, 'popups'));
    writeFileSync(join(dir, 'popups/map.svg'), '<svg/>');
  });
  afterAll(() => dir && rmSync(dir, { recursive: true, force: true }));

  it('a base below the folder: written, hash = sha1 of the text', () => {
    const r = writeSceneFile(dir, 'popups/map.svg', '<svg id="x"/>');
    expect(r.status).toBe(200);
    expect(readFileSync(join(dir, 'popups/map.svg'), 'utf8')).toBe('<svg id="x"/>');
    if (r.status === 200) expect(r.hash).toBe(createHash('sha1').update('<svg id="x"/>').digest('hex'));
  });

  it('v0.9: a new heir (prefab.extract) and a new subfolder are created; 2.3: an existing heir, md clips, effect data are written', () => {
    expect(writeSceneFile(dir, 'ui/badge.svg', '<svg/>').status).toBe(200);
    expect(writeSceneFile(dir, 'ui/badge.tml.svg', '<svg/>').status).toBe(200);
    expect(readFileSync(join(dir, 'ui/badge.tml.svg'), 'utf8')).toBe('<svg/>');
    expect(writeSceneFile(dir, 'ui/badge.tml.svg', '<svg id="h"/>').status).toBe(200);
    expect(readFileSync(join(dir, 'ui/badge.tml.svg'), 'utf8')).toBe('<svg id="h"/>');
    expect(writeSceneFile(dir, 'anim/win.md', '# $clip a\n').status).toBe(200);
    expect(writeSceneFile(dir, 'popups/map.anim.md', '# $clip a\n').status).toBe(200);
    expect(writeSceneFile(dir, 'fx/burst.json', '[]').status).toBe(200);
    expect(writeSceneFile(dir, 'src/fx/particles/systems.json', '[]').status).toBe(200);
    expect(writeSceneFile(dir, 'README.md', 'x').status).toBe(403);
    expect(writeSceneFile(dir, 'package.json', '{}').status).toBe(403);
  });

  it('../, absolute, contract, state, service folders — 403; bad body — 400', () => {
    writeFileSync(join(dir, 'game.tml.svg'), '<svg/>');
    expect(writeSceneFile(dir, '../evil.svg', 'x').status).toBe(403);
    expect(writeSceneFile(dir, 'popups/../../evil.svg', 'x').status).toBe(403);
    expect(writeSceneFile(dir, join(tmpdir(), 'evil.svg'), 'x').status).toBe(403);
    expect(writeSceneFile(dir, 'game.contract.xml', 'x').status).toBe(403);
    expect(writeSceneFile(dir, 'game.state.json', 'x').status).toBe(403);
    expect(writeSceneFile(dir, 'node_modules/x.svg', 'x').status).toBe(403);
    expect(writeSceneFile(dir, '.git/x.svg', 'x').status).toBe(403);
    expect(writeSceneFile(dir, 'a.svg', 42).status).toBe(400);
    expect(existsSync(join(dir, '..', 'evil.svg'))).toBe(false);
  });

  it('clip files of a scene: anim/*.md next to it, *.anim.md in its folder (v0.8); a compiled .json is not one', () => {
    expect(clipFiles(['anim/motion.md', 'anim/sub/x.md', 'popups/anim/p.md', 'scene.svg'], 'scene')).toEqual(['anim/motion.md']);
    expect(clipFiles(['anim/motion.md', 'popups/anim/p.md'], 'popups/map')).toEqual(['popups/anim/p.md']);
    const spine = ['scene.svg', 'el_nine.anim.md', 'el_nine.anim.json', 'notes.md', 'sub/x.anim.md'];
    expect(clipFiles(spine, 'scene')).toEqual(['el_nine.anim.md']);
  });

  it('render write (batch 2): only renders/*.png below the folder, bytes from base64, the folder is created', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
    const r = writeRenderFile(dir, 'renders/scene-1.png', png);
    expect(r.status).toBe(200);
    expect(readFileSync(join(dir, 'renders/scene-1.png')).subarray(1, 4).toString('latin1')).toBe('PNG');
    expect(writeRenderFile(dir, 'popups/renders/map-1.png', png).status).toBe(200);
    expect(writeRenderFile(dir, 'scene.png', png).status).toBe(403);
    expect(writeRenderFile(dir, 'renders/x.svg', png).status).toBe(403);
    expect(writeRenderFile(dir, '../renders/x.png', png).status).toBe(403);
    expect(writeRenderFile(dir, '.trempel/renders/x.png', png).status).toBe(403);
    expect(writeRenderFile(dir, 'renders/x.png', 42).status).toBe(400);
  });
});

describe('render bookkeeping', () => {
  it('annotate + recordingBackend: every drawn base node is known by its index path; the mark never reaches the backend', () => {
    const backend = createMockBackend();
    const byPath = new Map<string, NodeHandle>();
    const scene = mount({ base: annotate(SCENE), backend: recordingBackend(backend, byPath), context: {} });
    expect([...byPath.keys()].sort()).toEqual(['', '1', '2', '2/0', '2/1', '2/1/0', '3']);
    expect(byPath.get('3')).toBe(scene.byId.get('top'));
    for (const h of byPath.values()) expect(isMockNode(h).attrs[PATH_ATTR]).toBeUndefined();
  });

  it('StandInRegistry: an unregistered component draws its base subtree and is reported; registered ones run', () => {
    const heir = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:tml="https://trempel.dev/ns/scene" tml:extends="base.svg">
  <tml:ref id="arm" tml:type="spinner"/>
  <tml:ref id="top" tml:type="known"/>
</svg>`;
    const backend = createMockBackend();
    const byPath = new Map<string, NodeHandle>();
    let made = 0;
    const inner = new Registry().register('known', (ctx) => {
      made++;
      return { root: ctx.backend.createNode('g', {}) };
    });
    const reg = new StandInRegistry(inner);
    mount({ base: annotate(SCENE), heir, backend: recordingBackend(backend, byPath), registry: reg, context: {} });
    expect([...reg.missing]).toEqual(['spinner']);
    expect(made).toBe(1);
    expect(byPath.has('2/1/0')).toBe(true); // the stand-in built the component's children
    const tree: SceneNode = parse(SCENE);
    expect(tree.children[2].attrs.id).toBe('arm');
  });
});

describe('edit — in the package only as a library (@trempel/scene/edit)', () => {
  it('no moveable (own gizmo); the editor core builds from editor/ only; the page library has no dev server in it', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as Record<string, Record<string, unknown>>;
    expect(pkg.dependencies.moveable).toBeUndefined();
    expect(pkg.devDependencies.moveable).toBeUndefined();
    // 2.1: view/ and src/ ship for the trempel-view bin — the editor page's dev server (edit/) does not.
    expect(pkg.files).toEqual(['dist', 'view', '!view/**/*.test.*', '!view/tsconfig.json', 'src', 'LICENSE', 'README.md', 'CHANGELOG.md']);
    expect((pkg.files as unknown as string[]).some((f) => f.startsWith('edit'))).toBe(false);
    expect(JSON.parse(readFileSync(new URL('../editor/tsconfig.build.json', import.meta.url), 'utf8')).include.join()).not.toMatch(/edit\//);
    expect(pkg.exports['./edit']).toEqual({ types: './dist/edit/types/edit/lib.d.ts', import: './dist/edit/index.js' });
    const lib = readFileSync(new URL('./lib.ts', import.meta.url), 'utf8');
    expect(lib).not.toMatch(/io-dev|main|plugin|virtual:/);
  });
});

// ---- batch 1: the view (pan/zoom), tml.run --------------------------------------------------

describe('view: translate(origin) · scale(zoom) · fit', () => {
  const fit = { scale: 0.5, x: 10, y: 20 };

  it('scene ↔ screen: 3 cases (fit only, zoom, zoom + pan)', () => {
    const cases: { zoom: number; origin: Pt; scene: Pt; screen: Pt }[] = [
      { zoom: 1, origin: { x: 0, y: 0 }, scene: { x: 100, y: 40 }, screen: { x: 60, y: 40 } },
      { zoom: 2, origin: { x: 0, y: 0 }, scene: { x: 100, y: 40 }, screen: { x: 120, y: 80 } },
      { zoom: 3, origin: { x: -50, y: 30 }, scene: { x: 100, y: 40 }, screen: { x: -50 + 3 * 60, y: 30 + 3 * 40 } },
    ];
    for (const c of cases) {
      const V = stageView(fit, c.zoom, c.origin);
      close(apply(V, c.scene), c.screen);
      close(apply(invert(V), c.screen), c.scene);
    }
  });

  it('centredOrigin centres the canvas; the offset shifts it', () => {
    close(centredOrigin({ w: 800, h: 600 }, { width: 400, height: 200 }, 1), { x: 200, y: 200 });
    close(centredOrigin({ w: 800, h: 600 }, { width: 400, height: 200 }, 2, { x: 15, y: -5 }), { x: 15, y: 95 });
  });

  it('zoom to the cursor keeps the scene point under it', () => {
    const o0 = { x: 37, y: -12 };
    const at = { x: 412, y: 233 };
    for (const [z0, z1] of [[1, 1.7], [0.3, 0.05], [2, 8]]) {
      const before = apply(invert(stageView(fit, z0, o0)), at);
      const o1 = zoomAbout(o0, z0, z1, at);
      const after = apply(invert(stageView(fit, z1, o1)), at);
      close(after, before, 1e-9);
    }
  });
});

describe('tml.run — a script is one undo step', () => {
  const host = (svg: string) => {
    const doc = openDocument(svg);
    const ids = (id: string): string | null => {
      const t = doc.tree()[0];
      const walk = (n: (typeof t)): string | null => (n.id === id ? n.path : n.children.map(walk).find((x) => x != null) ?? null);
      return walk(t);
    };
    const ed = {
      doc,
      session: null,
      entry: { id: 'scene', base: 'scene.svg' },
      scenes: [{ id: 'scene', base: 'scene.svg' }],
      selection: [] as string[],
      bounds: new Map(),
      node: (p: string) => nodeAt(doc.scene, p),
      ref: (p: string) => nodeAt(doc.scene, p)?.attrs.id ?? p,
      pathOfId: ids,
      select(paths: string[]) {
        this.selection = paths;
      },
      idle: async () => {},
      save: async () => true,
      openScene: async () => true,
    };
    return ed as unknown as TmlHost & { doc: typeof doc };
  };
  const io = { list: async () => ({ name: '', files: [], module: null, writable: false }), read: async () => '' };
  const sink = { print: () => {} };

  it('two commands — one undo entry; an exception rolls the script back; a lone expression is returned', async () => {
    const ed = host(SCENE);
    const tml = createTml(ed, io, sink);
    const orig = ed.doc.serialize();
    const v = await tml.run(`
      tml.doc.exec('node.move', { node: 'bg', dx: 5, dy: 0 });
      tml.doc.exec('node.setAttr', { node: 'a', name: 'width', value: 30 });
      await Promise.resolve();
      return tml.doc.history.length;
    `, 'double');
    expect(v).toBe(0); // inside the script the step is still open
    expect(ed.doc.history.map((h) => h.label)).toEqual(['double']);
    expect(ed.doc.undo()).toBe(true);
    expect(ed.doc.serialize()).toBe(orig);

    await expect(tml.run(`tml.doc.exec('node.move', { node: 'bg', dx: 5, dy: 0 }); throw new Error('stop')`)).rejects.toThrow('stop');
    expect(ed.doc.serialize()).toBe(orig);
    expect(ed.doc.history).toEqual([]);
    expect(ed.doc.grouping).toBe(false);

    expect(await tml.run(`tml.doc.tree()[0].children.length`)).toBe(ed.doc.scene.children.length);
    expect(await tml.run(`tml.nodes().filter(n => n.tag === 'image').length`)).toBe(1);
    expect(ed.doc.history).toEqual([]); // nothing changed — no entry
  });

  it('select / selection speak ids; moveBy converts scene units to the parent space', async () => {
    const ed = host(SCENE);
    const tml = createTml(ed, io, sink);
    expect(tml.select(['a', 'bg'])).toEqual(['a', 'bg']);
    expect(() => tml.select('nope')).toThrow();
    // #a lives in #arm: rotate(90) scale(2) — scene +x is parent +y/2
    const r = tml.moveBy('a', 10, 0);
    expect(r?.ok).toBe(true);
    const n = nodeAt(ed.doc.scene, ed.pathOfId('a')!)!;
    expect(Number(n.attrs.y)).toBeCloseTo(-5, 6);
    expect(Number(n.attrs.x)).toBeCloseTo(0, 6);
  });

  it('macros: listed from .trempel/macros with their `// name:` titles, run by name as one step', async () => {
    const ed = host(SCENE);
    const files: Record<string, string> = {
      '.trempel/macros/b.js': "// name: Nudge the background\ntml.doc.exec('node.move', { node: 'bg', dx: 1, dy: 0 });\ntml.doc.exec('node.move', { node: 'bg', dx: 1, dy: 0 });",
      '.trempel/macros/a.js': 'return 42',
    };
    const mio = {
      list: async (dir?: string) => ({ name: dir ?? '', files: Object.keys(files), module: null, writable: false }),
      read: async (p: string) => files[p],
    };
    const tml = createTml(ed, mio, sink);
    expect(await tml.macros.list()).toEqual([
      { name: 'a', title: 'a', file: '.trempel/macros/a.js' },
      { name: 'b', title: 'Nudge the background', file: '.trempel/macros/b.js' },
    ]);
    expect(await tml.macros.run('a')).toBe(42);
    await tml.macros.run('Nudge the background');
    expect(ed.doc.history.map((h) => h.label)).toEqual(['Nudge the background']);
    await expect(tml.macros.run('nope')).rejects.toThrow(/^E_EDIT_MACRO: no macro "nope"/);
  });

  it('relativeTo: href from the scene folder', () => {
    expect(relativeTo('game.svg', 'art/x.png')).toBe('art/x.png');
    expect(relativeTo('popups/map.svg', 'art/x.png')).toBe('../art/x.png');
    expect(relativeTo('popups/map.svg', 'popups/art/x.png')).toBe('art/x.png');
  });
});

describe('edit/API.md (npm run editor:commands)', () => {
  it('has the Tml interface of edit/app/tml.ts and every command', async () => {
    const { commands, clipCommands } = await import('../editor/index.js');
    const api = readFileSync(new URL('./API.md', import.meta.url), 'utf8');
    const src = readFileSync(new URL('./app/tml.ts', import.meta.url), 'utf8');
    const block = src.slice(src.indexOf('// BEGIN tml-api'), src.indexOf('// END tml-api'));
    for (const line of block.split('\n').slice(1).map((l) => l.replace(/^export /, '')).filter((l) => l.trim())) expect(api, line).toContain(line);
    for (const name of [...Object.keys(commands), ...Object.keys(clipCommands)]) expect(api).toContain(`| \`${name}\` |`);
    expect(api.split('\n').length).toBeLessThan(200); // about two screens (batch 2: clips, reference, pixels; v1.0: node.resize; 2.3: clip commands, effects)
  });
});

describe('clips of a scene (view/clips.ts, batch 2)', () => {
  const SCENE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <g id="box" transform="translate(10 20)"><rect width="10" height="10"/></g></svg>`;
  const MD = `# $clip slide
$duration: 2
## $track box
| t | x  | ease   |
|---|----|--------|
| 0 | 0  | linear |
| 2 | 40 |        |

# $clip broken
## $track ghost
| t | x |
|---|---|
| 0 | 1 |
`;

  it('compileSceneClips: errors prefixed with the file; playback is the md clip (v0.9.1: no .json fallback)', () => {
    const tree = parse(SCENE);
    const r = compileSceneClips({ 'anim/a.md': MD }, tree);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/^E_ANIM_TARGET: anim\/a\.md: .*#ghost/);
    expect(r.clips.map((c) => [c.name, c.file, c.duration])).toEqual([
      ['slide', 'anim/a.md', 2],
      ['broken', 'anim/a.md', 0],
    ]);
  });

  it('ClipPlayer: seek is exact and repeatable, advance ×speed, no loop — holds the end and stops', () => {
    const backend = new PixiBackend({ metrics: () => ({ ascent: 8, descent: 2 }) });
    const scene = mount({ base: SCENE, backend, context: {} });
    const box = scene.byId.get('box') as unknown as { x: number };
    const clip = compileSceneClips({ 'anim/a.md': MD }, parse(SCENE)).clips[0];
    const p = new ClipPlayer(scene, backend);
    p.select(clip);
    expect(box.x).toBe(10);
    p.seek(1);
    expect(box.x).toBeCloseTo(30);
    p.seek(0.5);
    p.seek(1);
    expect(box.x).toBeCloseTo(30); // no drift: the rest pose is remembered once
    p.loop = false;
    p.speed = 2;
    p.play();
    p.advance(250); // ×2 → +0.5 s
    expect(p.time).toBeCloseTo(1.5);
    expect(box.x).toBeCloseTo(40);
    p.advance(1000);
    expect([p.playing, p.time]).toEqual([false, 2]);
    expect(box.x).toBeCloseTo(50);
    p.loop = true;
    p.seek(2.5);
    expect(p.time).toBeCloseTo(0); // clamped to the clip, wraps when looping
  });
});

describe('trempel-edit mcp (2.3): an MCP server (stdio) over the agent bridge', () => {
  it('initialize, tools/list, tools/call → POST /__tml/agent', async () => {
    const { createServer } = await import('node:http');
    const { spawn } = await import('node:child_process');
    const seen: unknown[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push(JSON.parse(body));
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, value: 42, errors: [], dirty: true }));
      });
    });
    await new Promise<void>((ok) => server.listen(0, 'localhost', ok));
    const port = (server.address() as { port: number }).port;
    const bin = new URL('../view/edit-bin.mjs', import.meta.url).pathname;
    const p = spawn(process.execPath, [bin, 'mcp', '--port', String(port)]);
    const lines: Record<string, unknown>[] = [];
    let buf = '';
    p.stdout.on('data', (c: Buffer) => {
      buf += c.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        lines.push(JSON.parse(buf.slice(0, i)));
        buf = buf.slice(i + 1);
      }
    });
    const send = (m: unknown): boolean => p.stdin.write(`${JSON.stringify(m)}\n`);
    const reply = async (id: number): Promise<Record<string, unknown>> => {
      for (let k = 0; k < 200; k++) {
        const hit = lines.find((l) => l.id === id);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`no reply ${id}`);
    };
    try {
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
      expect(((await reply(1)).result as { serverInfo: { name: string } }).serverInfo.name).toBe('trempel-edit');
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      expect(((await reply(2)).result as { tools: { name: string }[] }).tools.map((t) => t.name)).toEqual(['editor.eval', 'editor.save', 'editor.state']);
      send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'editor.eval', arguments: { code: '1 + 1' } } });
      const r = (await reply(3)).result as { content: { text: string }[]; isError: boolean };
      expect(r.isError).toBe(false);
      expect(JSON.parse(r.content[0].text)).toMatchObject({ ok: true, value: 42 });
      expect(seen).toEqual([{ op: 'eval', code: '1 + 1' }]);
    } finally {
      p.kill();
      server.close();
    }
  });
});
