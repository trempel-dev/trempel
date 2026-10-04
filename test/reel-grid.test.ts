// reel-grid.test.ts — the built-in `reel-grid` component on a small synthetic grid (no art, no game
// engine): parameters from the heir and the base, placeholder / image / text cells, the spin loop,
// stopping columns, and a tiny round driven the way a host controller drives it — `$symbol` clips
// on the cells through the Animator, on a mock clock.

import { describe, it, expect } from 'vitest';
import { mount } from '../src/scene';
import { reactive } from '../src/reactive';
import { createDefaultRegistry } from '../src/index';
import { Animator } from '../src/anim/player';
import type { AnimClip } from '../src/anim/types';
import type { ReelGridInstance } from '../src/components/ReelGrid';
import { createMockBackend, createMockClock, isMockNode, type MockNode } from './helpers/mockBackend';

const NS = 'xmlns="http://www.w3.org/2000/svg" xmlns:tml="https://trempel.dev/ns/scene"';

function grid(attrs: string, base = ''): { reel: ReelGridInstance; root: MockNode } {
  const backend = createMockBackend();
  const scene = mount({
    base: `<svg ${NS} viewBox="0 0 400 300"><g id="reels" ${base}/></svg>`,
    heir: `<svg ${NS}><tml:ref id="reels" tml:type="reel-grid" ${attrs}/></svg>`,
    backend,
    registry: createDefaultRegistry(),
    context: { state: reactive({}) },
  });
  const reel = scene.components.get('reels') as ReelGridInstance;
  return { reel, root: isMockNode(reel.root) };
}

const label = (n: unknown): MockNode => isMockNode(n as never).children.find((c) => c.tag === 'text')!;
const sprite = (n: unknown): MockNode => isMockNode(n as never).children.find((c) => c.tag === 'image')!;

describe('reel-grid', () => {
  it('lays out cols × rows cells, pivoted on their centres (square cell + gap)', () => {
    const { reel, root } = grid('tml:cols="2" tml:rows="3" tml:cell="40" tml:gap="4"');
    expect(root.children).toHaveLength(6);
    const c = isMockNode(reel.cell(1, 2));
    expect(c.props['pivot.x']).toBe(20);
    expect(c.props['pivot.y']).toBe(20);
    expect(c.props.x).toBe(1 * 44 + 20);
    expect(c.props.y).toBe(2 * 44 + 20);
    expect(reel.cells(1)).toHaveLength(3);
    expect(reel.cells(5)).toEqual([]);
    // placeholder cell: a background rect + a text label
    expect(c.children.map((n) => n.tag)).toEqual(['rect', 'text']);
    expect(c.children[0].attrs).toMatchObject({ width: '40', height: '40', fill: '#333' });
  });

  it('non-square cells and spacing; parameters from the base (data-*) lose to the heir', () => {
    const { reel } = grid('tml:cellw="30"', 'data-cols="1" data-rows="2" data-cellw="99" data-cellh="20" data-gapx="5" data-gapy="2"');
    expect(reel.cells(0)).toHaveLength(2);
    const c = isMockNode(reel.cell(0, 1));
    expect(c.props.x).toBe(15);
    expect(c.props.y).toBe(1 * 22 + 10);
  });

  it('setField shows the ids; a face that did not change is not rewritten', () => {
    const { reel } = grid('tml:cols="2" tml:rows="2" tml:cell="10"');
    reel.setField([[1, 2], [3, 4]]);
    expect(label(reel.cell(0, 1)).props.text).toBe('2');
    expect(label(reel.cell(1, 0)).props.text).toBe('3');
    const l = label(reel.cell(0, 0));
    l.props.text = 'touched';
    reel.setField([[1, 5]]);
    expect(l.props.text).toBe('touched');
    expect(label(reel.cell(0, 1)).props.text).toBe('5');
    expect(label(reel.cell(1, 1)).props.text).toBe('4'); // short field: other columns kept
  });

  it('text cells: prefix, size, fill, no background', () => {
    const { reel } = grid('tml:cols="1" tml:rows="1" tml:cell="50" tml:faces="2,5,10" tml:textprefix="×" tml:textsize="20" tml:textfill="#ff0" tml:cellbg="none"');
    const c = isMockNode(reel.cell(0, 0));
    expect(c.children.map((n) => n.tag)).toEqual(['text']);
    expect(c.children[0].attrs).toMatchObject({ 'font-size': '20', fill: '#ff0' });
    reel.setField([[10]]);
    expect(label(c).props.text).toBe('×10');
  });

  it('image cells: a centred sprite of <assets>/<id>.png, scaled to the cell', () => {
    const { reel } = grid('tml:cols="1" tml:rows="1" tml:cell="128" tml:symfit="1" tml:assets="sym"');
    const s = sprite(reel.cell(0, 0));
    expect(s.attrs.href).toBe('sym/1.png');
    expect(s.props['scale.x']).toBe(0.5);
    expect(s.props['anchor.x']).toBe(0.5);
    reel.setField([[7]]);
    expect(s.props.href).toBe('sym/7.png');
  });

  it('spins: faces cycle and bob while spinning; stopReel rests the column on the given symbols', () => {
    const { reel } = grid('tml:cols="2" tml:rows="2" tml:cell="100" tml:gap="0" tml:faces="1,2,3"');
    reel.setField([[1, 1], [1, 1]]);
    reel.startSpin();
    reel.spinFrame(0.1); // 20 symbols/s → offset 2
    expect(label(reel.cell(0, 0)).props.text).toBe('3');
    expect(label(reel.cell(0, 1)).props.text).toBe('1');
    reel.spinFrame(0.01); // offset 2.2 → bob (0.2 − 0.5)·50 = −15
    expect(label(reel.cell(1, 0)).props.y).toBeCloseTo(50 - 15);

    reel.stopReel(0, [2, 3]);
    expect(label(reel.cell(0, 0)).props.text).toBe('2');
    expect(label(reel.cell(0, 1)).props.text).toBe('3');
    expect(label(reel.cell(0, 0)).props.y).toBe(50);
    reel.spinFrame(0.05); // column 0 stays, column 1 keeps spinning
    expect(label(reel.cell(0, 0)).props.text).toBe('2');
    expect(label(reel.cell(1, 0)).props.y).not.toBe(50);
    reel.stopReel(1, [1, 2]);
    expect(label(reel.cell(1, 1)).props.text).toBe('2');
  });

  it('a round the way a controller drives it: spin, stop column by column, bounce the stopped cells', async () => {
    const backend = createMockBackend();
    const clock = createMockClock();
    const scene = mount({
      base: `<svg ${NS} viewBox="0 0 300 300"><g id="reels"/></svg>`,
      heir: `<svg ${NS}><tml:ref id="reels" tml:type="reel-grid" tml:cols="3" tml:rows="3" tml:cell="96" tml:gap="4"/></svg>`,
      backend,
      registry: createDefaultRegistry(),
      context: { state: reactive({}) },
    });
    const reel = scene.components.get('reels') as ReelGridInstance;
    const animator = new Animator(backend, clock);
    const bounce: AnimClip = {
      tracks: [
        { target: '$symbol', property: 'scale.y', keys: [{ t: 0, v: 1 }, { t: 0.05, v: 0.88, ease: 'backOut' }, { t: 0.2, v: 1 }] },
        { target: '$symbol', property: 'scale.x', keys: [{ t: 0, v: 1 }, { t: 0.05, v: 1.12 }, { t: 0.2, v: 1 }] },
      ],
    };
    const result = [[1, 2, 3], [4, 5, 6], [7, 1, 2]];
    const step = (ms: number): void => {
      clock.t += ms;
      reel.spinFrame(ms / 1000);
      animator.tick();
    };

    reel.startSpin();
    for (let i = 0; i < 10; i++) step(16);
    const bounces: Promise<void>[] = [];
    for (let col = 0; col < 3; col++) {
      reel.stopReel(col, result[col]);
      bounces.push(animator.play(bounce, { targets: { $symbol: reel.cells(col) } }).done);
      step(25);
      expect(isMockNode(reel.cell(col, 1)).props['scale.y']).toBeLessThan(1);
      for (let i = 0; i < 4; i++) step(16);
    }
    for (let i = 0; i < 20; i++) step(16);
    await Promise.all(bounces);

    for (let col = 0; col < 3; col++) {
      for (let row = 0; row < 3; row++) {
        expect(label(reel.cell(col, row)).props.text).toBe(String(result[col][row]));
        expect(isMockNode(reel.cell(col, row)).props['scale.x']).toBe(1);
      }
    }
  });
});
