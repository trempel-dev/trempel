// editor-core: document, commands (do / undo / redo), batch, validation, export with a minimal diff.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { multiply, parseTransform, pathFromNode, IDENTITY, type Matrix, type SceneNode } from '@trempel/scene/core';
import { commands, openDocument, type EditorDocument } from './index.js';
import { parseSource, serializeSource } from './xml.js';
import { insertPoint, type EditCmd } from './path.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string): string => readFileSync(join(root, p), 'utf8');

const MOTION = read('examples/motion/scene.svg');
const MOTION_HEIR = read('examples/motion/scene.tml.svg');
const MOTION_CONTRACT = read('examples/motion/scene.contract.xml');
const MOTION_CLIPS = { 'anim/motion.md': read('examples/motion/anim/motion.md') };

const SMALL = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <!-- a comment -->
  <g id="a" transform="translate(10,20)">
    <rect id="r" x="1" y='2' width="10"   height="10" fill="#fff"/>
    <text id="t" x="0" y="0">A &amp; B</text>
  </g>

  <g id="b"/>
  <path id="p" d="M 0 0 L 10 0 L 10 10"/>
</svg>
`;

/** Lines that differ between two texts (same line count expected for in-place edits). */
function changedLines(a: string, b: string): number {
  const x = a.split('\n');
  const y = b.split('\n');
  let n = Math.abs(x.length - y.length);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) n++;
  return n;
}

const find = (n: SceneNode, id: string): SceneNode | undefined => {
  if (n.attrs.id === id) return n;
  for (const c of n.children) {
    const hit = find(c, id);
    if (hit) return hit;
  }
  return undefined;
};

/** World matrix of a node of the SceneTree (product of transforms from the root down). */
function world(rootNode: SceneNode, id: string): Matrix {
  const chain: SceneNode[] = [];
  const visit = (n: SceneNode, path: SceneNode[]): boolean => {
    if (n.attrs.id === id) {
      chain.push(...path, n);
      return true;
    }
    return n.children.some((c) => visit(c, [...path, n]));
  };
  visit(rootNode, []);
  return chain.reduce<Matrix>((m, n) => multiply(m, parseTransform(n.attrs.transform)), IDENTITY);
}

/** Points at n+1 equal fractions of the arc length of an M L C Z path (dense flattening — exact to ~1e-5). */
function sampleByLength(d: string, n: number): { x: number; y: number }[] {
  const nums = (str: string): number[] => str.trim().split(/[\s,]+/).filter(Boolean).map(Number);
  const pts: { x: number; y: number }[] = [];
  let cur = { x: 0, y: 0 };
  let start = cur;
  for (const m of d.matchAll(/([MLCZ])([^MLCZ]*)/g)) {
    const v = nums(m[2]);
    if (m[1] === 'M') {
      cur = start = { x: v[0], y: v[1] };
      pts.push(cur);
    } else if (m[1] === 'L' || m[1] === 'Z') {
      const to = m[1] === 'L' ? { x: v[0], y: v[1] } : start;
      for (let k = 1; k <= 200; k++) pts.push({ x: cur.x + ((to.x - cur.x) * k) / 200, y: cur.y + ((to.y - cur.y) * k) / 200 });
      cur = to;
    } else {
      const [x1, y1, x2, y2, x, y] = v;
      const N = 20000;
      for (let k = 1; k <= N; k++) {
        const t = k / N;
        const u = 1 - t;
        pts.push({
          x: u * u * u * cur.x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x,
          y: u * u * u * cur.y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y,
        });
      }
      cur = { x, y };
    }
  }
  const acc = [0];
  for (let i = 1; i < pts.length; i++) acc.push(acc[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const total = acc[acc.length - 1];
  const out: { x: number; y: number }[] = [];
  let j = 1;
  for (let i = 0; i <= n; i++) {
    const s = (total * i) / n;
    while (j < acc.length - 1 && acc[j] < s) j++;
    const seg = acc[j] - acc[j - 1] || 1;
    const f = Math.min(1, Math.max(0, (s - acc[j - 1]) / seg));
    out.push({ x: pts[j - 1].x + (pts[j].x - pts[j - 1].x) * f, y: pts[j - 1].y + (pts[j].y - pts[j - 1].y) * f });
  }
  return out;
}

/** do → check → undo (back to the original bytes) → redo (the same result). */
function roundtripCommand(doc: EditorDocument, name: string, args: unknown, check?: (after: string) => void): string {
  const before = doc.serialize();
  const res = doc.exec(name, args);
  expect(res.errors).toBeUndefined();
  expect(res.ok).toBe(true);
  const after = doc.serialize();
  expect(after).not.toBe(before);
  check?.(after);
  expect(doc.undo()).toBe(true);
  expect(doc.serialize()).toBe(before);
  expect(doc.redo()).toBe(true);
  expect(doc.serialize()).toBe(after);
  return after;
}

// ---- roundtrip ---------------------------------------------------------------------------------

describe('roundtrip without commands — byte for byte', () => {
  it('examples/motion scene.svg (with heir and contract); scene.tml.svg is not touched', () => {
    const base = read('examples/motion/scene.svg');
    const heirPath = join(root, 'examples/motion/scene.tml.svg');
    const hash = (): string => createHash('sha256').update(readFileSync(heirPath)).digest('hex');
    const mtime = statSync(heirPath).mtimeMs;
    const h0 = hash();
    const doc = openDocument(base, {
      heir: readFileSync(heirPath, 'utf8'),
      contract: read('examples/motion/scene.contract.xml'),
      path: 'scene.svg',
    });
    expect(doc.serialize()).toBe(base);
    expect(doc.errors).toEqual([]);
    expect(doc.dirty).toBe(false);
    expect(hash()).toBe(h0);
    expect(statSync(heirPath).mtimeMs).toBe(mtime);
  });

  it('examples/motion and examples/prefabs bases', () => {
    for (const f of ['examples/motion/scene.svg', 'examples/prefabs/menu.svg', 'examples/prefabs/ui/button.svg']) {
      const text = read(f);
      expect(openDocument(text).serialize(), f).toBe(text);
    }
  });

  it('the XML layer reproduces every .svg of the examples (heirs and art too)', () => {
    const svgs: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.svg')) svgs.push(p);
      }
    };
    walk('examples');
    expect(svgs.length).toBeGreaterThan(4);
    for (const f of svgs) {
      const text = read(f);
      expect(serializeSource(parseSource(text)), f).toBe(text);
    }
  });

  it('prolog, comments, entities, quote styles and spacing inside tags survive', () => {
    expect(openDocument(SMALL).serialize()).toBe(SMALL);
  });

  it('an opened document with a heir shows the merged tree', () => {
    const doc = openDocument(MOTION, { heir: MOTION_HEIR, contract: MOTION_CONTRACT, clips: MOTION_CLIPS });
    expect(doc.errors).toEqual([]);
    const bird = find(doc.merged, 'bird');
    expect(bird).toBeDefined();
    expect(Object.keys(find(doc.scene, 'bird')!.tml)).toEqual([]);
  });
});

// ---- commands: do / undo / redo ------------------------------------------------------------------

describe('commands — direct action, undo, redo', () => {
  it('node.setAttr: change keeps the slot and quote, null removes, tml:* refused', () => {
    const doc = openDocument(SMALL);
    roundtripCommand(doc, 'node.setAttr', { node: 'r', name: 'y', value: 5.256 }, (after) => {
      expect(after).toContain(`<rect id="r" x="1" y='5.26' width="10"   height="10" fill="#fff"/>`);
    });
    roundtripCommand(doc, 'node.setAttr', { node: 'r', name: 'fill', value: null }, (after) => {
      expect(after).toContain(`<rect id="r" x="1" y='5.26' width="10"   height="10"/>`);
    });
    roundtripCommand(doc, 'node.setAttr', { node: 'r', name: 'opacity', value: '0.5' }, (after) => {
      expect(after).toContain(`height="10" opacity="0.5"/>`);
    });
    const before = doc.serialize();
    const bad = doc.exec('node.setAttr', { node: 'r', name: 'tml:bind', value: 'x' });
    expect(bad.ok).toBe(false);
    expect(bad.errors![0]).toMatch(/стерильна/);
    expect(doc.serialize()).toBe(before);
  });

  it('node.setText: replaces the layout text (escaped), undo restores the source byte for byte; only <text>', () => {
    const doc = openDocument(SMALL);
    roundtripCommand(doc, 'node.setText', { node: 't', text: 'x < y & z' }, (after) => {
      expect(after).toContain('<text id="t" x="0" y="0">x &lt; y &amp; z</text>');
      expect(changedLines(SMALL, after)).toBe(1);
      expect(doc.scene.children[0].children[1].text).toBe('x < y & z');
    });
    roundtripCommand(doc, 'node.setText', { node: 't', text: '' }, (after) => expect(after).toContain('<text id="t" x="0" y="0"></text>'));
    expect(doc.exec('node.setText', { node: 't', text: '' }).changed).toEqual([]);
    const bad = doc.exec('node.setText', { node: 'r', text: 'x' });
    expect(bad.ok).toBe(false);
    expect(bad.errors![0]).toMatch(/только у <text>/);
  });

  it('node.setId renames and updates clip-path references; warns about clips', () => {
    const doc = openDocument(MOTION, { clips: MOTION_CLIPS });
    roundtripCommand(doc, 'node.setId', { node: 'win', id: 'frame' }, (after) => {
      expect(after).toContain('<clipPath id="frame">');
      expect(after).toContain('clip-path="url(#frame)"');
      expect(after).not.toContain('url(#win)');
    });
    const res = doc.exec('node.setId', { node: 'bird', id: 'crow' });
    expect(res.ok).toBe(true);
    expect(res.warnings).toEqual(['клип anim/motion.md ссылается на старый id "bird"']);
    expect(doc.errors.some((e) => e.startsWith('anim/motion.md:') && e.includes('bird'))).toBe(true);
    expect(doc.exec('node.setId', { node: 'crow', id: 'sun' }).errors![0]).toMatch(/уже есть/);
  });

  it('node.move: g translate (separator kept), x/y, cx/cy, line ends, path points, through a rotation', () => {
    const doc = openDocument(SMALL);
    roundtripCommand(doc, 'node.move', { node: 'a', dx: 5, dy: -2.5 }, (after) => {
      expect(after).toContain('<g id="a" transform="translate(15,17.5)">');
    });
    roundtripCommand(doc, 'node.move', { node: 'b', dx: 1, dy: 2 }, (after) => {
      expect(after).toContain('<g id="b" transform="translate(1,2)"/>');
    });
    roundtripCommand(doc, 'node.move', { node: 'r', dx: 1, dy: 1 }, (after) => {
      expect(after).toContain(`<rect id="r" x="2" y='3'`);
    });
    roundtripCommand(doc, 'node.move', { node: 'p', dx: 1, dy: 1 }, (after) => {
      expect(after).toContain('d="M1 1L11 1L11 11"');
    });
    const m = openDocument(MOTION);
    roundtripCommand(m, 'node.move', { node: 'sun', dx: 10, dy: 0 }, (after) => expect(after).toContain('cx="620" cy="130" r="36"'));
    roundtripCommand(m, 'node.move', { node: 'horizon', dx: 0, dy: 5 }, (after) =>
      expect(after).toContain('x1="0" y1="435" x2="800" y2="435"'),
    );
    roundtripCommand(m, 'node.move', { node: 'window', dx: 1, dy: 1 }, (after) =>
      expect(after).toContain('transform="translate(41 31)"'),
    );
    // A rotated rect: the move is in the parent's space, so x/y change by the inverse rotation.
    const r = openDocument(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect id="q" x="0" y="0" width="1" height="1" transform="rotate(90)"/></svg>`);
    roundtripCommand(r, 'node.move', { node: 'q', dx: 3, dy: 0 }, (after) => expect(after).toContain('x="0" y="-3"'));
  });

  it('node.move changes only the moved nodes\' lines', () => {
    const base = MOTION;
    const ids = ['bird', 'sun', 'horizon'];
    const doc = openDocument(base);
    const res = doc.batch('move three', ids.map((node) => ({ name: 'node.move', args: { node, dx: 3, dy: 4 } })));
    expect(res.ok).toBe(true);
    expect(res.changed.sort()).toEqual([...ids].sort());
    expect(changedLines(base, doc.serialize())).toBeLessThanOrEqual(ids.length);
    expect(doc.serialize().length - base.length).toBeLessThan(40);
  });

  it('node.setTransform: v0.6 order with a pivot; empty — removes', () => {
    const doc = openDocument(SMALL);
    roundtripCommand(doc, 'node.setTransform', { node: 'b', translate: [10, 0], rotate: 45, scale: 2, pivot: [5, 5] }, (after) => {
      expect(after).toContain('<g id="b" transform="translate(15,5) rotate(45) scale(2) translate(-5,-5)"/>');
    });
    roundtripCommand(doc, 'node.setTransform', { node: 'a' }, (after) => expect(after).toContain('<g id="a">'));
  });

  it('node.setTransform: pivot defaults to data-pivot (v0.8)', () => {
    const doc = openDocument(SMALL.replace('<g id="b"/>', '<g id="b" data-pivot="5 5"/>'));
    roundtripCommand(doc, 'node.setTransform', { node: 'b', translate: [10, 0], rotate: 45 }, (after) => {
      expect(after).toContain('transform="translate(15,5) rotate(45) translate(-5,-5)"');
    });
  });

  it('node.setPivot: keepWorld — the matrix and world bounds stay; false — the parts turn around the new pivot', () => {
    const src = SMALL.replace('<g id="b"/>', '<g id="b" transform="translate(10,0) rotate(90)"><rect width="4" height="2"/></g>');
    const doc = openDocument(src);
    const before = world(doc.scene, 'b');
    roundtripCommand(doc, 'node.setPivot', { node: 'b', x: 2, y: 1 }, (after) => {
      expect(after).toContain('<g id="b" transform="translate(10,0) rotate(90)" data-pivot="2 1">');
    });
    expect(world(doc.scene, 'b')).toEqual(before);
    doc.undo();
    // keepWorld:false — translate(10,0) and rotate(90) now about (2, 1): (2, 1) lands at (12, 1).
    roundtripCommand(doc, 'node.setPivot', { node: 'b', x: 2, y: 1, keepWorld: false }, () => {
      const m = world(doc.scene, 'b');
      expect(m[0] * 2 + m[2] * 1 + m[4]).toBeCloseTo(12);
      expect(m[1] * 2 + m[3] * 1 + m[5]).toBeCloseTo(1);
    });
    expect(doc.exec('node.setPivot', { node: '', x: 0, y: 0 }).ok).toBe(false);
  });

  it('v0.8 attributes are checked after a command (mix-blend-mode, data-z)', () => {
    const doc = openDocument(SMALL);
    doc.exec('node.setAttr', { node: 'a', name: 'style', value: 'mix-blend-mode: overlay' });
    doc.exec('node.setAttr', { node: 'r', name: 'data-z', value: 'x' });
    expect(doc.errors).toEqual([
      '#a: mix-blend-mode: overlay — бывает normal, plus-lighter, multiply, screen.',
      '#r: data-z="x" — ожидается целое число.',
    ]);
  });

  it('node.reorder changes z-order among siblings', () => {
    const doc = openDocument(SMALL);
    roundtripCommand(doc, 'node.reorder', { node: 'p', index: 0 }, () => {
      expect(doc.tree()[0].children.map((c) => c.id)).toEqual(['p', 'a', 'b']);
    });
    expect(doc.exec('node.reorder', { node: 'p', index: 9 }).ok).toBe(false);
  });

  it('node.reparent keeps the world position', () => {
    const doc = openDocument(MOTION);
    const before = world(doc.scene, 'mascotHead');
    roundtripCommand(doc, 'node.reparent', { node: 'mascotHead', parent: 'window' });
    const after = world(doc.scene, 'mascotHead');
    after.forEach((v, i) => expect(v).toBeCloseTo(before[i], 2));
    expect(find(doc.scene, 'window')!.children.at(-1)!.attrs.id).toBe('mascotHead');

    // Through a rotation and a scale: the new transform is a similarity written as parts.
    const rot = openDocument(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">\n  <g id="from" transform="translate(5 5) rotate(30)">\n    <rect id="x" x="1" y="2" width="1" height="1" transform="translate(3 0)"/>\n  </g>\n  <g id="to" transform="scale(2) translate(1 1)"/>\n</svg>\n`,
    );
    const w0 = world(rot.scene, 'x');
    roundtripCommand(rot, 'node.reparent', { node: 'x', parent: 'to' });
    const w1 = world(rot.scene, 'x');
    w1.forEach((v, i) => expect(v).toBeCloseTo(w0[i], 2));
    expect(rot.exec('node.reparent', { node: 'from', parent: 'x' }).ok).toBe(false);
  });

  it('node.insert: one element, allowed tags, unique ids, indented under the parent', () => {
    const doc = openDocument(SMALL);
    roundtripCommand(doc, 'node.insert', { parent: 'a', index: 1, xml: '<circle id="c" r="3"/>' }, (after) => {
      expect(after).toContain(`fill="#fff"/>\n    <circle id="c" r="3"/>\n    <text id="t"`);
    });
    roundtripCommand(doc, 'node.insert', { parent: 'b', xml: '<g id="inner">\n  <rect width="1" height="1"/>\n</g>' }, (after) => {
      expect(after).toContain(`<g id="b">\n    <g id="inner">\n      <rect width="1" height="1"/>\n    </g>\n  </g>`);
    });
    expect(doc.exec('node.insert', { parent: 'a', xml: '<polygon points="0 0"/>' }).errors![0]).toMatch(/вне формата/);
    expect(doc.exec('node.insert', { parent: 'a', xml: '<rect id="r"/>' }).errors![0]).toMatch(/уже есть/);
    expect(doc.exec('node.insert', { parent: 'a', xml: '<rect/><rect/>' }).errors![0]).toMatch(/ровно один/);
    expect(doc.exec('node.insert', { parent: 'a', xml: '<rect tml:bind="x"/>' }).errors![0]).toMatch(/стерильна/);
  });

  it('node.remove takes the subtree and its line', () => {
    const doc = openDocument(SMALL);
    roundtripCommand(doc, 'node.remove', { node: 'a' }, (after) => {
      expect(after).not.toContain('id="r"');
      expect(after).toContain('<!-- a comment -->\n\n  <g id="b"/>');
    });
    const m = openDocument(MOTION, { clips: MOTION_CLIPS });
    expect(m.exec('node.remove', { node: 'mascotHead' }).warnings).toEqual(['клип anim/motion.md ссылается на удалённый id "mascotHead"']);
  });

  it('node.duplicate: next to the original, fresh ids', () => {
    const doc = openDocument(SMALL);
    roundtripCommand(doc, 'node.duplicate', { node: 'a' }, (after) => {
      expect(after).toContain('<g id="a-2" transform="translate(10,20)">');
      expect(after).toContain(`<rect id="r-2" x="1" y='2' width="10"   height="10" fill="#fff"/>`);
      expect(doc.tree()[0].children.map((c) => c.id)).toEqual(['a', 'a-2', 'b', 'p']);
    });
    roundtripCommand(doc, 'node.duplicate', { node: 'b', idSuffix: '_copy' }, (after) => expect(after).toContain('<g id="b_copy"/>'));
    expect(doc.errors).toEqual([]);
  });

  it('defs.ensure, clip.create, clip.assign, layer.create', () => {
    const doc = openDocument(SMALL);
    roundtripCommand(doc, 'defs.ensure', {}, (after) => {
      // first element child; the header comment stays on top
      expect(after).toContain('<!-- a comment -->\n  <defs id="defs"/>\n  <g id="a"');
    });
    roundtripCommand(doc, 'clip.create', { id: 'm', shape: 'rect', attrs: { x: 0, y: 0, width: 50, height: 50.555 } }, (after) => {
      expect(after).toContain('<defs id="defs">\n    <clipPath id="m">\n      <rect x="0" y="0" width="50" height="50.56"/>\n    </clipPath>\n  </defs>');
    });
    doc.exec('clip.create', { id: 'm', shape: 'rect', attrs: { width: 50, height: 50 } });
    roundtripCommand(doc, 'clip.assign', { node: 'a', clip: 'm' }, (after) => expect(after).toContain('<g id="a" transform="translate(10,20)" clip-path="url(#m)">'));
    expect(doc.errors).toEqual([]);
    expect(doc.exec('clip.assign', { node: 'r', clip: 'm' }).ok).toBe(false);
    expect(doc.exec('clip.assign', { node: 'a', clip: 'b' }).errors![0]).toMatch(/не <clipPath>|а не <clipPath>/);
    doc.exec('clip.assign', { node: 'a', clip: 'm' });
    roundtripCommand(doc, 'clip.assign', { node: 'a', clip: null }, (after) => expect(after).not.toContain('clip-path'));
    roundtripCommand(doc, 'layer.create', { id: 'fx', index: 2 }, () => {
      expect(doc.tree()[0].children.map((c) => c.id)).toEqual(['defs', 'a', 'fx', 'b', 'p']);
    });
    // defs already there → nothing to do, no history entry
    const n = doc.history.length;
    expect(doc.exec('defs.ensure', {})).toEqual({ ok: true, changed: [] });
    expect(doc.history.length).toBe(n);
  });
});

// ---- path tool ---------------------------------------------------------------------------------

describe('path commands', () => {
  const CURVE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">
  <path id="c" d="M0 0C64 128 192 128 256 0L256 64"/>
</svg>
`;
  const d = (doc: EditorDocument, id = 'c'): string => find(doc.scene, id)!.attrs.d;

  it('path.setData', () => {
    const doc = openDocument(CURVE);
    roundtripCommand(doc, 'path.setData', { node: 'c', d: 'M0 0L1 1' }, () => expect(d(doc)).toBe('M0 0L1 1'));
    expect(doc.exec('path.setData', { node: 'c', d: 'M0 0 X' }).errors![0]).toMatch(/^d:/);
  });

  it('path.setPoint moves the anchor with its handles', () => {
    const doc = openDocument(CURVE);
    roundtripCommand(doc, 'path.setPoint', { node: 'c', index: 1, x: 266, y: 10 }, () => expect(d(doc)).toBe('M0 0C64 128 202 138 266 10L256 64'));
  });

  it('path.setHandle: plain, linked (mirrors the opposite; a line becomes a curve)', () => {
    const doc = openDocument(CURVE);
    roundtripCommand(doc, 'path.setHandle', { node: 'c', index: 1, which: 'in', x: 200, y: 100 }, () =>
      expect(d(doc)).toBe('M0 0C64 128 200 100 256 0L256 64'),
    );
    roundtripCommand(doc, 'path.setHandle', { node: 'c', index: 1, which: 'in', x: 200, y: 100, linked: true }, () =>
      expect(d(doc)).toBe('M0 0C64 128 200 100 256 0C312 -100 256 64 256 64'),
    );
    expect(doc.exec('path.setHandle', { node: 'c', index: 0, which: 'in', x: 1, y: 1 }).errors![0]).toMatch(/нет входящего/);
  });

  it('path.insertPoint keeps the shape (20 equal steps of length, 1e-3)', () => {
    const doc = openDocument(CURVE);
    const before = d(doc);
    const beforePath = pathFromNode(find(doc.scene, 'c')!);
    roundtripCommand(doc, 'path.insertPoint', { node: 'c', segment: 0, t: 0.25 });
    expect(d(doc)).toBe('M0 0C16 32 36 56 58 72C124 120 208 96 256 0L256 64');
    // Exact arc length (dense flattening): the same points at 20 equal fractions within 1e-3.
    const a = sampleByLength(before, 20);
    const b = sampleByLength(d(doc), 20);
    a.forEach((p, i) => expect(Math.hypot(p.x - b[i].x, p.y - b[i].y)).toBeLessThan(1e-3));
    // pathFromNode (svg-path-properties) agrees within its own length→t tolerance (0.1 % of a segment).
    const afterPath = pathFromNode(find(doc.scene, 'c')!);
    expect(Math.abs(afterPath.length - beforePath.length) / beforePath.length).toBeLessThan(1e-3);
    for (let i = 0; i <= 20; i++) {
      const s = (beforePath.length * i) / 20;
      const p = beforePath.pointAt(s);
      const q = afterPath.pointAt(s);
      expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeLessThan(0.5);
    }
    roundtripCommand(doc, 'path.insertPoint', { node: 'c', segment: 2, t: 0.5 }, () => expect(d(doc)).toMatch(/L256 32L256 64$/));
  });

  it('the split itself (no rounding): any t keeps the shape within 1e-3', () => {
    const src: EditCmd[] = [['M', 3.7, 11.2], ['C', 40.1, 190.3, 210.9, -80.4, 300.5, 77.7], ['L', 320, 10]];
    const raw = (cmds: EditCmd[]): string => cmds.map((c) => c.join(' ')).join(' ');
    for (const t of [0.1, 0.37, 0.5, 0.93]) {
      const a = sampleByLength(raw(src), 20);
      const b = sampleByLength(raw(insertPoint(src, 0, t)), 20);
      a.forEach((p, i) => expect(Math.hypot(p.x - b[i].x, p.y - b[i].y)).toBeLessThan(1e-3));
    }
  });

  it('path.removePoint joins the neighbours', () => {
    const doc = openDocument(CURVE);
    roundtripCommand(doc, 'path.removePoint', { node: 'c', index: 1 }, () => expect(d(doc)).toBe('M0 0C64 128 256 64 256 64'));
    const first = openDocument(CURVE);
    roundtripCommand(first, 'path.removePoint', { node: 'c', index: 0 }, () => expect(d(first)).toBe('M256 0L256 64'));
    const one = openDocument(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path id="c" d="M0 0"/></svg>`);
    expect(one.exec('path.removePoint', { node: 'c', index: 0 }).errors![0]).toMatch(/последняя точка/);
  });

  it('path.close / path.open', () => {
    const doc = openDocument(CURVE);
    roundtripCommand(doc, 'path.close', { node: 'c' }, () => expect(d(doc)).toMatch(/Z$/));
    doc.exec('path.close', { node: 'c' });
    roundtripCommand(doc, 'path.open', { node: 'c' }, () => expect(d(doc)).not.toMatch(/Z/));
  });

  it('path.setNodeType smooth aligns the handles on one line, keeping their lengths', () => {
    const doc = openDocument(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path id="c" d="M0 0C0 50 50 50 50 0C50 50 100 50 100 0"/></svg>`);
    roundtripCommand(doc, 'path.setNodeType', { node: 'c', index: 1, type: 'smooth' }, () => {
      const [, , , , x2, y2, ax, ay, x1, y1] = d(doc).match(/-?[\d.]+/g)!.map(Number);
      // collinear: (anchor - in) ∥ (out - anchor)
      expect((ax - x2) * (y1 - ay) - (ay - y2) * (x1 - ax)).toBeCloseTo(0, 1);
      expect(Math.hypot(ax - x2, ay - y2)).toBeCloseTo(50, 1);
      expect(Math.hypot(x1 - ax, y1 - ay)).toBeCloseTo(50, 1);
    });
    expect(doc.exec('path.setNodeType', { node: 'c', index: 1, type: 'corner' })).toEqual({ ok: true, changed: [] });
  });

  it('relative commands, H V S T Q and arcs are normalized to absolute M L C Z on the first path command', () => {
    const doc = openDocument(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path id="c" d="m10 10 h20 v20 q10 10 20 0 t20 0 s10 10 20 0 a10 10 0 0 1 20 0 z"/></svg>`,
    );
    const before = pathFromNode(find(doc.scene, 'c')!);
    const res = doc.exec('path.setPoint', { node: 'c', index: 0, x: 10, y: 10 });
    expect(res.ok).toBe(true);
    expect(res.warnings).toEqual(['#c: d переписан в абсолютные M L C Z (дуги A — аппроксимация кубиками)']);
    expect(d(doc)).toMatch(/^M10 10L30 10L30 30C/);
    expect(d(doc)).toMatch(/^[MLCZ\d\s.-]+$/);
    const after = pathFromNode(find(doc.scene, 'c')!);
    expect(Math.abs(after.length - before.length) / before.length).toBeLessThan(2e-3);
    for (let i = 0; i <= 20; i++) {
      const s = (before.length * i) / 20;
      expect(Math.hypot(before.pointAt(s).x - after.pointAt(s).x, before.pointAt(s).y - after.pointAt(s).y)).toBeLessThan(0.1);
    }
  });

  it('a closed circle-like path: the start and the last point are one node', () => {
    const doc = openDocument(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path id="c" d="M10 0L20 10L10 20L0 10L10 0Z"/></svg>`);
    roundtripCommand(doc, 'path.setPoint', { node: 'c', index: 0, x: 10, y: -5 }, () => expect(d(doc)).toBe('M10 -5L20 10L10 20L0 10L10 -5Z'));
    roundtripCommand(doc, 'path.removePoint', { node: 'c', index: 0 }, () => expect(d(doc)).toBe('M20 10L10 20L0 10L20 10Z'));
  });

  it('a handle on the closing line of Z makes it an explicit curve back to the start', () => {
    const doc = openDocument(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path id="c" d="M0 0L10 0L10 10Z"/></svg>`);
    roundtripCommand(doc, 'path.setHandle', { node: 'c', index: 2, which: 'out', x: 5, y: 15 }, () => expect(d(doc)).toBe('M0 0L10 0L10 10C5 15 0 0 0 0Z'));
  });

  it('path commands refuse a non-path node', () => {
    const doc = openDocument(MOTION);
    expect(doc.exec('path.setPoint', { node: 'sun', index: 0, x: 0, y: 0 }).errors![0]).toMatch(/<path>/);
  });
});

// ---- batch, history, validation, registry ------------------------------------------------------------

describe('document', () => {
  it('begin…end: commands between (any number, nested) are one undo entry; abort rolls them back', () => {
    const doc = openDocument(SMALL);
    const orig = doc.serialize();
    const events: string[] = [];
    doc.on('change', (e) => events.push(e.type));
    doc.begin('скрипт');
    expect(doc.grouping).toBe(true);
    doc.exec('node.move', { node: 'a', dx: 1, dy: 0 });
    doc.begin('inner');
    doc.batch('b', [{ name: 'node.setAttr', args: { node: 'r', name: 'fill', value: '#000' } }]);
    doc.end();
    expect(doc.dirty).toBe(true);
    expect(doc.undo()).toBe(false); // off while open
    expect(doc.history).toEqual([]);
    doc.end();
    expect(doc.grouping).toBe(false);
    expect(doc.history.map((h) => h.label)).toEqual(['скрипт']);
    const changed = doc.serialize();
    doc.undo();
    expect(doc.serialize()).toBe(orig);
    doc.redo();
    expect(doc.serialize()).toBe(changed);

    doc.begin('сломанный');
    doc.exec('node.move', { node: 'b', dx: 5, dy: 5 });
    doc.abort();
    expect(doc.serialize()).toBe(changed);
    expect(doc.history.map((h) => h.label)).toEqual(['скрипт']);
    expect(events).toEqual(['exec', 'batch', 'batch', 'undo', 'redo', 'exec', 'rollback']);

    doc.begin('пусто');
    doc.end();
    expect(doc.history.length).toBe(1);
    expect(() => doc.end()).toThrow();
  });

  it('batch is one undo entry; a failing batch changes nothing', () => {
    const doc = openDocument(SMALL);
    const orig = doc.serialize();
    const res = doc.batch('layout', [
      { name: 'node.move', args: { node: 'a', dx: 1, dy: 1 } },
      { name: 'layer.create', args: { id: 'fx' } },
      { name: 'node.setAttr', args: { node: 'r', name: 'fill', value: '#000' } },
    ]);
    expect(res.ok).toBe(true);
    expect(res.changed).toEqual(['a', 'fx', 'r']);
    expect(doc.history.map((h) => h.label)).toEqual(['layout']);
    expect(doc.dirty).toBe(true);
    const changed = doc.serialize();
    doc.undo();
    expect(doc.serialize()).toBe(orig);
    expect(doc.dirty).toBe(false);
    doc.redo();
    expect(doc.serialize()).toBe(changed);

    const bad = doc.batch('broken', [
      { name: 'node.move', args: { node: 'a', dx: 1, dy: 1 } },
      { name: 'node.remove', args: { node: 'nope' } },
    ]);
    expect(bad.ok).toBe(false);
    expect(bad.errors![0]).toMatch(/^\[1\] node\.remove: /);
    expect(doc.serialize()).toBe(changed);
    expect(doc.history.length).toBe(1);
  });

  it('arguments are checked by the schema; the document is untouched', () => {
    const doc = openDocument(SMALL);
    const cases: [string, unknown, RegExp][] = [
      ['node.move', { node: 'a', dx: '1', dy: 0 }, /dx: ожидается число/],
      ['node.move', { node: 'a', dx: 1 }, /dy: обязательный/],
      ['node.move', { node: 'a', dx: 1, dy: 1, extra: 1 }, /extra: неизвестный/],
      ['path.setHandle', { node: 'p', index: 0, which: 'up', x: 0, y: 0 }, /which: одно из/],
      ['node.setId', { node: 'a', id: '1bad' }, /id: «1bad» не подходит/],
      ['no.such', {}, /команды «no\.such» нет/],
      ['node.move', { node: 'ghost', dx: 1, dy: 1 }, /узла "ghost" нет/],
    ];
    for (const [name, args, re] of cases) {
      const res = doc.exec(name, args);
      expect(res.ok, name).toBe(false);
      expect(res.errors!.join('\n')).toMatch(re);
    }
    expect(doc.serialize()).toBe(SMALL);
    expect(doc.history).toEqual([]);
  });

  it('nodes are addressed by id or by index path', () => {
    const doc = openDocument(SMALL);
    expect(doc.exec('node.setAttr', { node: '0/1', name: 'x', value: 7 }).changed).toEqual(['t']);
    expect(doc.tree()[0].children[0].children[1]).toMatchObject({ id: 't', tag: 'text', path: '0/1' });
  });

  it('validation runs after every command and does not block it', () => {
    const doc = openDocument(MOTION, { contract: MOTION_CONTRACT, heir: MOTION_HEIR, clips: MOTION_CLIPS });
    expect(doc.errors).toEqual([]);
    const events: string[] = [];
    doc.on('change', (e) => events.push(`${e.type}:${e.label}`));
    const res = doc.exec('node.remove', { node: 'window' });
    expect(res.ok).toBe(true);
    expect(doc.serialize()).not.toContain('id="window"');
    expect(doc.errors.some((e) => e.includes('#window') && e.includes('контракт'))).toBe(true);
    expect(doc.errors.some((e) => e.startsWith('наследник: ') && e.includes('window'))).toBe(true);
    doc.exec('node.setAttr', { node: 'fly1', name: 'd', value: 'M 0 0 X' });
    expect(doc.errors.some((e) => e.startsWith('#fly1: d:'))).toBe(true);
    doc.exec('node.insert', { parent: '', xml: '<g id="sun"/>' }); // refused (duplicate) — no event
    doc.undo();
    doc.undo();
    expect(doc.errors).toEqual([]);
    expect(events).toEqual(['exec:node.remove', 'exec:node.setAttr', 'undo:node.setAttr', 'undo:node.remove']);
  });

  it('a duplicate id made by setAttr-free means (insert into the base by hand) is reported', () => {
    const doc = openDocument(SMALL.replace('<g id="b"/>', '<g id="b"/>\n  <g id="b2"/>'));
    doc.exec('node.setId', { node: 'b2', id: 'b3' });
    expect(doc.errors).toEqual([]);
    const dup = openDocument(SMALL.replace('<g id="b"/>', '<g id="b"/><g id="b"/>'));
    expect(dup.errors.some((e) => e.includes('Дублирующийся id "b"'))).toBe(true);
  });

  it('editor/README.md lists every command of the registry (npm run editor:commands)', () => {
    const readme = read('editor/README.md');
    const block = readme.slice(readme.indexOf('<!-- BEGIN commands'), readme.indexOf('<!-- END commands -->'));
    const listed = [...block.matchAll(/^\| `([\w.]+)` \|/gm)].map((m) => m[1]);
    expect(listed).toEqual(Object.keys(commands));
  });

  it('the registry exports a JSON Schema and a description for every command', () => {
    const names = Object.keys(commands);
    expect(names).toEqual(
      expect.arrayContaining([
        'node.setAttr', 'node.setId', 'node.setText', 'node.move', 'node.setTransform', 'node.setPivot', 'node.reorder', 'node.reparent', 'node.insert',
        'node.remove', 'node.duplicate', 'path.setData', 'path.setPoint', 'path.setHandle', 'path.insertPoint',
        'path.removePoint', 'path.close', 'path.open', 'path.setNodeType', 'defs.ensure', 'clip.create', 'clip.assign',
        'layer.create',
      ]),
    );
    for (const [name, c] of Object.entries(commands)) {
      expect(c.schema.type, name).toBe('object');
      expect(c.describe.length, name).toBeGreaterThan(10);
      expect(JSON.parse(JSON.stringify(c.schema)), name).toEqual(c.schema);
      expect('run' in c, name).toBe(false);
    }
  });
});
