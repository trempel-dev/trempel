// Batch 3-A: the transform operators without UI (tml.op), the modal state (Esc leaves no trace),
// the keymap's two schemes, the gizmo's projection, the pivot, the command form.

import { describe, it, expect } from 'vitest';
import { openDocument } from '../editor/index.js';
import { apply, decompose, multiply, nodeAt, nodeWorld, type Box, type Matrix, type Pt } from './geometry';
import { applyOp, opTargets, opPivot, stepped, typeKey, type OpHost } from './ops';
import { collisions, actionOf, chordOf, SCHEMES, type KeymapScheme } from './app/keymap';
import { gizmoLayout } from './app/gizmo';
import { fieldKind, parseField } from './app/commandpalette';
import { Operators, pixiLocal, pixiProps } from './app/ops';
import type { Editor } from './app/editor';

const close = (a: Pt, b: Pt, eps = 1e-4): void => {
  expect(Math.abs(a.x - b.x), `x ${a.x} vs ${b.x}`).toBeLessThan(eps);
  expect(Math.abs(a.y - b.y), `y ${a.y} vs ${b.y}`).toBeLessThan(eps);
};
const deg = (d: number): number => (d * Math.PI) / 180;

const SCENE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">
  <rect id="bg" width="400" height="300" fill="#000"/>
  <g id="arm" transform="translate(200 150) rotate(30)">
    <rect id="a" x="0" y="0" width="40" height="20"/>
    <rect id="b" x="10" y="40" width="20" height="20" transform="rotate(30)"/>
    <ellipse id="e" cx="0" cy="0" rx="10" ry="5" data-pivot="0 0"/>
  </g>
  <rect id="top" x="300" y="200" width="50" height="50"/>
</svg>`;

/** A host over a real core document; bounds — exact geometry boxes in the scene. */
function host(svg = SCENE): OpHost & { doc: ReturnType<typeof openDocument>; measure(): void } {
  const doc = openDocument(svg);
  const pathOf = (id: string): string | null => {
    const walk = (n: ReturnType<typeof doc.tree>[number]): string | null => (n.id === id ? n.path : n.children.map(walk).find((x) => x != null) ?? null);
    return walk(doc.tree()[0]);
  };
  const h = {
    doc,
    bounds: new Map<string, Box>(),
    selection: [] as string[],
    ref: (p: string) => nodeAt(doc.scene, p)?.attrs.id ?? p,
    pathOfId: pathOf,
    batch: (label: string, calls: { name: string; args: Record<string, unknown> }[]) => doc.batch(label, calls),
    measure() {
      this.bounds.clear();
      const visit = (n: typeof doc.scene, path: string): void => {
        const a = n.attrs;
        const num = (k: string): number => Number(a[k] ?? 0);
        let local: Box | null = null;
        if (n.tag === 'rect') local = { x: num('x'), y: num('y'), w: num('width'), h: num('height') };
        if (n.tag === 'ellipse') local = { x: num('cx') - num('rx'), y: num('cy') - num('ry'), w: 2 * num('rx'), h: 2 * num('ry') };
        if (local && path !== '') {
          const W = nodeWorld(doc.scene, path);
          const ps = [apply(W, { x: local.x, y: local.y }), apply(W, { x: local.x + local.w, y: local.y }), apply(W, { x: local.x, y: local.y + local.h }), apply(W, { x: local.x + local.w, y: local.y + local.h })];
          const x = Math.min(...ps.map((p) => p.x));
          const y = Math.min(...ps.map((p) => p.y));
          this.bounds.set(path, { x, y, w: Math.max(...ps.map((p) => p.x)) - x, h: Math.max(...ps.map((p) => p.y)) - y });
        }
        n.children.forEach((c, i) => visit(c, path === '' ? String(i) : `${path}/${i}`));
      };
      visit(doc.scene, '');
    },
  };
  h.measure();
  return h;
}

const world = (h: ReturnType<typeof host>, id: string): Matrix => nodeWorld(h.doc.scene, h.pathOfId(id)!);
/** Where a rect's corner (x, y) lands in the scene. */
const corner = (h: ReturnType<typeof host>, id: string): Pt => {
  const n = nodeAt(h.doc.scene, h.pathOfId(id)!)!;
  return apply(world(h, id), { x: Number(n.attrs.x ?? 0), y: Number(n.attrs.y ?? 0) });
};

describe('operators without UI — tml.op (G / R / S, axes, values)', () => {
  it('G X 120 under a rotated parent: exactly 120 along the local X, one node.move in parent space, one undo', () => {
    const h = host();
    const p0 = corner(h, 'a');
    const r = applyOp(h, 'G', { axis: 'x', value: 120, nodes: ['a'] });
    expect(r?.ok).toBe(true);
    const n = nodeAt(h.doc.scene, h.pathOfId('a')!)!;
    expect(Number(n.attrs.x)).toBeCloseTo(120, 6); // local X of #a = the parent's X: x += 120
    expect(Number(n.attrs.y)).toBeCloseTo(0, 6);
    const p1 = corner(h, 'a');
    close({ x: p1.x - p0.x, y: p1.y - p0.y }, { x: 120 * Math.cos(deg(30)), y: 120 * Math.sin(deg(30)) });
    expect(h.doc.history.length).toBe(1);
  });

  it('G X twice-pressed = global: 120 scene units along the screen X; Shift+X (exclude) — the Y', () => {
    const h = host();
    const p0 = corner(h, 'a');
    applyOp(h, 'G', { axis: 'x', value: 120, space: 'global', nodes: ['a'] });
    const p1 = corner(h, 'a');
    close({ x: p1.x - p0.x, y: p1.y - p0.y }, { x: 120, y: 0 }, 0.01); // the core writes x/y to 2 decimals
    applyOp(h, 'G', { axis: 'x', exclude: true, value: 50, space: 'global', nodes: ['a'] });
    const p2 = corner(h, 'a');
    close({ x: p2.x - p1.x, y: p2.y - p1.y }, { x: 0, y: 50 }, 0.01);
  });

  it('R -45 about data-pivot: the pivot stays, setTransform rotate parts; R 45 on #top → rotate 45 about its centre', () => {
    const h = host();
    const piv0 = apply(world(h, 'e'), { x: 0, y: 0 });
    expect(applyOp(h, 'R', { value: -45, nodes: ['e'] })?.ok).toBe(true);
    close(apply(world(h, 'e'), { x: 0, y: 0 }), piv0);
    const e = nodeAt(h.doc.scene, h.pathOfId('e')!)!;
    expect(e.attrs.transform).toBe('rotate(-45)');

    applyOp(h, 'R', { value: 45, nodes: ['top'] });
    const top = nodeAt(h.doc.scene, h.pathOfId('top')!)!;
    const parts = decompose(world(h, 'top'), { x: 325, y: 225 })!;
    expect(parts.rotate).toBeCloseTo(45, 6);
    close(apply(world(h, 'top'), { x: 325, y: 225 }), { x: 325, y: 225 }); // about the centre
    expect(top.attrs.transform).toMatch(/rotate\(45\)/);
  });

  it('S X 2 on a node rotated 30° inside a 30° parent — local axes, no skew; global S on it — a skew (matrix)', () => {
    const h = host();
    expect(applyOp(h, 'S', { axis: 'x', value: 2, nodes: ['b'] })?.ok).toBe(true);
    const b = nodeAt(h.doc.scene, h.pathOfId('b')!)!;
    const W = world(h, 'b');
    expect(Math.abs(W[0] * W[2] + W[1] * W[3])).toBeLessThan(1e-6); // columns orthogonal: no skew
    expect(Math.hypot(W[0], W[1])).toBeCloseTo(2, 6);
    expect(Math.hypot(W[2], W[3])).toBeCloseTo(1, 6);
    expect(b.attrs.transform).toMatch(/rotate\(30\).*scale\(2,? ?1\)/);

    const g = host();
    applyOp(g, 'S', { axis: 'x', value: 2, space: 'global', nodes: ['b'] });
    expect(nodeAt(g.doc.scene, g.pathOfId('b')!)!.attrs.transform).toMatch(/^matrix\(/);
  });

  it('S 1.5 on an axis-aligned <rect> resizes it by attributes about its centre; several nodes — about their common centre', () => {
    const h = host();
    applyOp(h, 'S', { value: 1.5, nodes: ['top'] });
    const t = nodeAt(h.doc.scene, h.pathOfId('top')!)!;
    expect([t.attrs.x, t.attrs.y, t.attrs.width, t.attrs.height].map(Number)).toEqual([287.5, 187.5, 75, 75]);
    expect(t.attrs.transform).toBeUndefined();

    const m = host();
    const targets = opTargets(m.doc.scene, [m.pathOfId('bg')!, m.pathOfId('top')!], m.bounds, m.ref);
    expect(opPivot(targets)).toEqual({ x: 200, y: 150 }); // union of 0..400 × 0..300 and 300..350
  });

  it('a selected parent carries its children (a child under it is not transformed twice); errors are human', () => {
    const h = host();
    const targets = opTargets(h.doc.scene, [h.pathOfId('arm')!, h.pathOfId('a')!], h.bounds, h.ref);
    expect(targets.map((t) => t.ref)).toEqual(['arm']);
    expect(() => applyOp(h, 'G', { nodes: ['a'] })).toThrow(/value/);
    expect(() => applyOp(h, 'G', { value: 1 })).toThrow(/^E_EDIT_SELECTION: /);
    expect(() => applyOp(h, 'G', { value: 1, nodes: ['nope'] })).toThrow(/nope/);
    expect(applyOp(h, 'G', { value: 0, nodes: ['a'] })).toBeNull(); // nothing changes — no undo entry
    expect(h.doc.history).toEqual([]);
  });

  it("pivot: '.' at a point and 'ctrl+.' = node.setPivot keepWorld — the matrix (and so the bounds) stays", () => {
    const h = host();
    const before = world(h, 'b');
    const box = h.bounds.get(h.pathOfId('b')!)!;
    applyOp(h, '.', { x: 210, y: 170, nodes: ['b'] });
    const b = nodeAt(h.doc.scene, h.pathOfId('b')!)!;
    const [px, py] = b.attrs['data-pivot'].split(' ').map(Number);
    close(apply(world(h, 'b'), { x: px, y: py }), { x: 210, y: 170 }, 1e-3); // data-pivot is written to 4 decimals
    expect(world(h, 'b')).toEqual(before);
    h.measure();
    expect(h.bounds.get(h.pathOfId('b')!)).toEqual(box);
    applyOp(h, 'ctrl+.', { nodes: ['b'] });
    expect(nodeAt(h.doc.scene, h.pathOfId('b')!)!.attrs['data-pivot']).toBe('20 50'); // the rect's centre in its own space
    expect(h.doc.history.length).toBe(2);
  });
});

describe('the modal operator — keys, live feedback, Esc leaves no trace', () => {
  /** An Editor stand-in for Operators: a mock backend that keeps props, no DOM but a window. */
  function stage() {
    const h = host();
    const props = new Map<string, Record<string, number>>();
    const handle = { id: 'a' };
    props.set('a', { x: 200, y: 150, rotation: deg(30), 'scale.x': 1, 'scale.y': 1, 'skew.x': 0, 'skew.y': 0, 'pivot.x': 0, 'pivot.y': 0 });
    const events: string[] = [];
    const ed = {
      doc: h.doc,
      readOnly: null,
      selection: [h.pathOfId('a')!],
      bounds: h.bounds,
      scope: '',
      fit: { width: 400, height: 300, scale: 1, x: 0, y: 0 },
      operating: false,
      handles: new Map([[h.pathOfId('a')!, handle]]),
      backend: {
        getProp: (_: unknown, k: string) => props.get('a')![k],
        setProp: (_: unknown, k: string, v: number) => {
          props.get('a')![k] = v;
        },
      },
      skipped: () => false,
      isService: () => false,
      ref: h.ref,
      node: (p: string) => nodeAt(h.doc.scene, p),
      view: (): Matrix => [1, 0, 0, 1, 0, 0],
      emit: (e: string) => events.push(e),
      batch: (label: string, calls: { name: string; args: Record<string, unknown> }[]) => h.doc.batch(label, calls),
      render: async () => {},
    } as unknown as Editor;
    const status = { hidden: true, textContent: '' } as HTMLElement;
    const ops = new Operators(ed, status, (e) => ({ x: e.clientX, y: e.clientY }));
    return { h, ops, props, status, ed };
  }
  const key = (k: string, code = '', extra: Partial<KeyboardEvent> = {}) => ({ key: k, code, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...extra }) as KeyboardEvent;
  const g = globalThis as unknown as { window?: EventTarget };

  it('G → X → 120 → Enter: one undo entry, 120 along the local X; the status reads like Blender', () => {
    g.window ??= new EventTarget();
    const { h, ops, status } = stage();
    expect(ops.start('G', { at: { x: 0, y: 0 } })).toBe(true);
    ops.key(key('x', 'KeyX'));
    for (const c of '120') ops.key(key(c, `Digit${c}`));
    expect(status.textContent).toMatch(/^Move X \(local\): 120 px/);
    expect(status.textContent).toContain('Shift fine · Ctrl snap');
    ops.key(key('Enter'));
    expect(ops.active).toBe(false);
    expect(h.doc.history.length).toBe(1);
    expect(Number(nodeAt(h.doc.scene, h.pathOfId('a')!)!.attrs.x)).toBeCloseTo(120, 6);
  });

  it('typed value drives the runtime props live; Esc — props back, the document and undo untouched', () => {
    g.window ??= new EventTarget();
    const { h, ops, props } = stage();
    const orig = h.doc.serialize();
    const p0 = { ...props.get('a')! };
    ops.start('R', { at: { x: 0, y: 0 } });
    ops.key(key('9', 'Digit9'));
    ops.key(key('0', 'Digit0'));
    expect(props.get('a')!.rotation).toBeCloseTo(deg(120), 6); // 30° + 90° live
    ops.key(key('-', 'Minus'));
    expect(props.get('a')!.rotation).toBeCloseTo(deg(-60), 6);
    ops.key(key('Escape'));
    for (const [k, v] of Object.entries(p0)) expect(props.get('a')![k], k).toBeCloseTo(v, 9);
    expect(h.doc.serialize()).toBe(orig);
    expect(h.doc.history).toEqual([]);
  });

  it('X cycles local → global → free; Backspace erases; Ctrl steps 15°; pixi props ↔ matrix round trip', () => {
    g.window ??= new EventTarget();
    const { ops, status } = stage();
    ops.start('G', { at: { x: 0, y: 0 } });
    ops.key(key('x', 'KeyX'));
    expect(status.textContent).toMatch(/X \(local\)/);
    ops.key(key('x', 'KeyX'));
    expect(status.textContent).toMatch(/X \(global\)/);
    ops.key(key('x', 'KeyX'));
    expect(status.textContent).toMatch(/^Move: /);
    ops.key(key('5', 'Digit5'));
    ops.key(key('0', 'Digit0'));
    ops.key(key('Backspace', 'Backspace'));
    expect(status.textContent).toMatch(/^Move X: 5 px · typed/);
    ops.cancel();
    const m: Matrix = [Math.cos(0.3) * 2, Math.sin(0.3) * 2, -Math.sin(0.3), Math.cos(0.3), 5, 7];
    const back = pixiLocal(pixiProps(m, { x: 3, y: 4 }), { x: 3, y: 4 });
    back.forEach((v, i) => expect(v).toBeCloseTo(m[i], 9));
  });
});

describe('operator modifiers and typing', () => {
  it('Ctrl steps: G 10 units (along the axis), R 15°, S 0.1; numeric keys: «-» flips, «.» once, Backspace', () => {
    const axes: [Pt, Pt] = [{ x: Math.cos(deg(30)), y: Math.sin(deg(30)) }, { x: -Math.sin(deg(30)), y: Math.cos(deg(30)) }];
    const g = stepped({ kind: 'G', delta: { x: axes[0].x * 23, y: axes[0].y * 23 }, space: 'local', pivot: { x: 0, y: 0 } }, 'x', axes);
    close(g.delta!, { x: axes[0].x * 20, y: axes[0].y * 20 });
    close(stepped({ kind: 'G', delta: { x: 14, y: -26 }, space: 'global', pivot: { x: 0, y: 0 } }, null, axes).delta!, { x: 10, y: -30 });
    expect(stepped({ kind: 'R', angle: 52, space: 'local', pivot: { x: 0, y: 0 } }, null, axes).angle).toBe(45);
    expect(stepped({ kind: 'S', factor: [1.26, 0.94], space: 'local', pivot: { x: 0, y: 0 } }, null, axes).factor!.map((v) => Math.round(v * 100) / 100)).toEqual([1.3, 0.9]);
    let t: string | null = null;
    for (const k of ['1', '.', '5', '.', '-']) t = typeKey(t, k) ?? t;
    expect(t).toBe('-1.5');
    expect(typeKey('-1.5', 'Backspace')).toBe('-1.');
    expect(typeKey('7', 'Backspace')).toBeNull(); // empty — back to the pointer
    expect(typeKey('7', 'q')).toBeUndefined();
  });
});

describe('keymap — two schemes', () => {
  it('no chord collisions in either scheme (Mac and not); the scheme decides G vs V', () => {
    for (const s of Object.keys(SCHEMES) as KeymapScheme[]) for (const mac of [true, false]) expect(collisions(s, mac), `${s} mac=${mac}`).toEqual([]);
    const ev = (key: string, code: string, m: Partial<KeyboardEvent> = {}) => ({ key, code, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...m });
    expect(actionOf(ev('g', 'KeyG'), 'blender', true)).toBe('op.move');
    expect(actionOf(ev('\u043f', 'KeyG'), 'blender', true)).toBe('op.move'); // a Russian layout: the physical key
    expect(actionOf(ev('g', 'KeyG'), 'figma', true)).toBeNull();
    expect(actionOf(ev('v', 'KeyV'), 'figma', true)).toBe('tool.select');
    expect(actionOf(ev('D', 'KeyD', { shiftKey: true }), 'blender', true)).toBe('node.duplicate');
    expect(actionOf(ev('d', 'KeyD', { metaKey: true }), 'figma', true)).toBe('node.duplicate');
    expect(actionOf(ev('F3', 'F3'), 'blender', true)).toBe('palette.commands');
    expect(actionOf(ev('P', 'KeyP', { metaKey: true, shiftKey: true }), 'figma', true)).toBe('palette.commands');
    expect(actionOf(ev('p', 'KeyP', { metaKey: true }), 'blender', true)).toBe('palette.prefabs'); // common ⌘P
    expect(actionOf(ev('.', 'Period', { ctrlKey: true }), 'blender', true)).toBe('pivot.centre');
    expect(actionOf(ev('.', 'Period'), 'blender', true)).toBe('pivot.pick');
    expect(actionOf(ev('h', 'KeyH', { altKey: true }), 'blender', false)).toBe('node.unhideAll');
    expect(chordOf(ev('+', 'Equal', { shiftKey: true }), true)).toBe('+');
  });
});

describe('gizmo — local axes through the view', () => {
  it('under a 30° parent the X arrow points along the rotated axis; a 2× zoom view keeps directions, not lengths', () => {
    const h = host();
    const W = world(h, 'a');
    const V: Matrix = [2, 0, 0, 2, 10, 20];
    const L = gizmoLayout(V, W, { x: 200, y: 150 }, 1);
    close(L.o, { x: 410, y: 320 });
    close(L.ax, { x: Math.cos(deg(30)), y: Math.sin(deg(30)) });
    close(L.ay, { x: -Math.sin(deg(30)), y: Math.cos(deg(30)) });
    close(L.at['move-x']!, { x: 410 + L.ax.x * (L.len - 8), y: 320 + L.ax.y * (L.len - 8) });
    expect(L.compact).toBe(false);
    // below 50 %: the XY square and the ring only
    const C = gizmoLayout(V, W, { x: 200, y: 150 }, 0.4);
    expect(Object.keys(C.at).sort()).toEqual(['move-xy', 'rotate']);
    // several nodes: global axes
    close(gizmoLayout(V, null, { x: 0, y: 0 }, 1).ax, { x: 1, y: 0 });
    void multiply;
  });
});

describe('command palette form — JSON Schema fields', () => {
  it('string / number / pair / enum / boolean / mixed values', () => {
    expect(fieldKind({ type: 'string' })).toBe('string');
    expect(fieldKind({ type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 })).toBe('pair');
    expect(parseField({ type: 'number' }, '1,5', 'dx')).toBe(1.5);
    expect(() => parseField({ type: 'integer' }, '1.5', 'index')).toThrow(/^E_EDIT_ARGS: index: expected an integer/);
    expect(parseField({ type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 }, '10 -4', 'translate')).toEqual([10, -4]);
    expect(parseField({ enum: ['in', 'out'] }, 'out', 'which')).toBe('out');
    expect(parseField({ type: 'boolean' }, 'false', 'keepWorld')).toBe(false);
    expect(parseField({ type: 'boolean' }, '', 'keepWorld')).toBeUndefined();
    expect(parseField({ anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }] }, '12', 'value')).toBe(12);
    expect(parseField({ anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }] }, '#fff', 'value')).toBe('#fff');
    expect(parseField({ type: 'string' }, '', 'id')).toBeUndefined();
  });
});
