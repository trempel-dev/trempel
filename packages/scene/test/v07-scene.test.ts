// v0.7 scene API: MountedScene.path, ComponentContext.param (tml > data-*) and .path, a component configured from data-*
// configured from the sterile base, the contract's attrs="…", defs never reaching the backend.

import { describe, it, expect } from 'vitest';
import { mount } from '../src/scene';
import { Registry, type ComponentContext } from '../src/registry';
import { checkContract, parseContract } from '../src/contract';
import { parse } from '../src/parser';
import { createTileGrid, type TileGridInstance } from './helpers/tileGrid';
import { createMockBackend } from './helpers/mockBackend';

const svg = (body: string): string => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600">${body}</svg>`;
const heir = (body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:tml="https://trempel.dev/ns/scene" tml:extends="scene.svg">${body}</svg>`;

describe('defs never reach the backend', () => {
  it('no createNode for <defs>, <clipPath> or anything inside them', () => {
    const backend = createMockBackend();
    const tags: string[] = [];
    const create = backend.createNode;
    backend.createNode = (tag, attrs) => {
      tags.push(attrs.id ?? tag);
      return create(tag, attrs);
    };
    mount({
      base: svg('<defs id="d"><path id="fly" d="M0 0 L1 1"/><clipPath id="m"><rect width="1" height="1"/></clipPath></defs><g id="a" clip-path="url(#m)"/>'),
      backend,
      context: {},
    });
    expect(tags).toEqual(['svg', 'a']);
  });
});

describe('MountedScene.path', () => {
  const scene = mount({
    base: svg('<defs><line id="l" x1="0" y1="0" x2="30" y2="40"/></defs><g id="g"/>'),
    backend: createMockBackend(),
    context: {},
  });

  it('length / closed / pointAt / tangentAt in scene units', () => {
    const p = scene.path('l');
    expect(p.length).toBeCloseTo(50);
    expect(p.closed).toBe(false);
    expect(p.pointAt(25)).toEqual({ x: expect.closeTo(15, 5), y: expect.closeTo(20, 5) });
    expect(p.tangentAt(10).x).toBeCloseTo(0.6);
    expect(scene.path('l')).toBe(p); // built once
  });

  it('an unknown id or a non-geometry node is an error', () => {
    expect(() => scene.path('nope')).toThrow(/path\("nope"\) — узла с таким id в сцене нет/);
    expect(() => scene.path('g')).toThrow(/#g — <g>, не геометрия/);
  });
});

describe('ComponentContext.param / path', () => {
  const seen: { cols?: string; rows?: string; none?: string; len?: number } = {};
  const registry = new Registry().register('probe', (ctx: ComponentContext) => {
    seen.cols = ctx.param('cols');
    seen.rows = ctx.param('rows');
    seen.none = ctx.param('none');
    seen.len = ctx.path('track').length;
    return { root: ctx.backend.createNode('g', {}) };
  });
  const base = svg('<defs><line id="track" x2="7"/></defs><g id="c" data-cols="3" data-rows="2"/>');

  it('tml:<name> from the heir wins over data-<name> of the base; ctx.path measures scene geometry', () => {
    mount({ base, heir: heir('<tml:ref id="c" tml:type="probe" tml:cols="5"/>'), backend: createMockBackend(), registry, context: {} });
    expect(seen).toEqual({ cols: '5', rows: '2', none: undefined, len: 7 });
  });

  it('Registry.create without a scene still gives param (from the node) — old callers keep working', () => {
    let got: string | undefined;
    new Registry()
      .register('p', (ctx) => {
        got = ctx.param('cols');
        return { root: {} };
      })
      .create('p', { tag: 'g', attrs: { 'data-cols': '4' }, tml: {}, backend: createMockBackend(), children: [] });
    expect(got).toBe('4');
  });
});

describe('a component configured from the base (data-*)', () => {
  it('data-cols/rows/cellw/cellh of the base; tml:* of the heir overrides', () => {
    const backend = createMockBackend();
    const scene = mount({
      base: svg('<g id="board" data-cols="4" data-rows="2" data-cellw="100" data-cellh="80" data-gapx="0" data-gapy="0"/>'),
      heir: heir('<tml:ref id="board" tml:type="tile-grid" tml:rows="3"/>'),
      backend,
      registry: new Registry().register('tile-grid', createTileGrid),
      context: {},
    });
    const grid = scene.components.get('board') as TileGridInstance;
    expect(grid.cells(3)).toHaveLength(3); // 4 columns from data-cols, 3 rows from tml:rows
    expect(grid.cells(4) ?? []).toHaveLength(0);
    const cell = grid.cell(1, 1) as { props: Record<string, unknown> };
    expect(cell.props.x).toBe(100 + 50); // pitch = data-cellw, pivot at the centre
    expect(cell.props.y).toBe(80 + 40);
  });
});

describe('contract attrs="…"', () => {
  const contract = parseContract(`<contract viewBox="0 0 800 600">
    <g id="board" attrs="data-cols data-rows data-cellw data-cellh"/>
    <image match="o(\\d+)" count="1.." attrs="data-kind"/>
  </contract>`);

  it('every listed attribute must be in the base; values are not checked', () => {
    const ok = parse(svg('<g id="board" data-cols="x" data-rows="" data-cellw="1" data-cellh="1"/><image id="o1" data-kind="cat"/>'));
    expect(checkContract(ok, contract)).toEqual([]);
  });

  it('a missing one is named with the node', () => {
    const bad = parse(svg('<g id="board" data-cols="3" data-rows="3" data-cellh="1"/><image id="o1"/>'));
    expect(checkContract(bad, contract)).toEqual(['#board: нет data-cellw — его ждёт контракт.', '#o1: нет data-kind — его ждёт контракт.']);
  });
});
