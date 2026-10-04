import { describe, it, expect } from 'vitest';
import { mountScene } from '../src/scene';
import { reactive } from '../src/reactive';
import { createDefaultRegistry } from '../src/index';
import type { ReelGridInstance } from '../src/components/ReelGrid';
import { createMockBackend, isMockNode } from './helpers/mockBackend';

const SCENE = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:tml="https://trempel.dev/ns/scene" viewBox="0 0 1280 800">
  <g id="reels" tml:type="reel-grid" tml:cols="3" tml:rows="3" tml:cell="200" tml:gap="8"/>
  <text id="balance" tml:bind="state.balance | fixed:2"/>
  <text id="winlabel" tml:visible="state.win > 0" tml:bind="state.win | fixed:2"/>
  <g id="spinBtn" tml:on-click="spin()"/>
</svg>`;

describe('scene', () => {
  it('builds nodes, wires bindings, and instantiates custom components', () => {
    const backend = createMockBackend();
    const state = reactive({ balance: 1000, win: 0 });
    let spins = 0;
    const scene = mountScene(SCENE, {
      backend,
      registry: createDefaultRegistry(),
      context: { state, spin: () => spins++ },
    });

    // bindings applied
    expect(isMockNode(scene.byId.get('balance')!).props.text).toBe('1000.00');
    expect(isMockNode(scene.byId.get('winlabel')!).props.visible).toBe(false);

    // reactive updates propagate
    state.balance = 950;
    expect(isMockNode(scene.byId.get('balance')!).props.text).toBe('950.00');
    state.win = 25;
    expect(isMockNode(scene.byId.get('winlabel')!).props.visible).toBe(true);
    expect(isMockNode(scene.byId.get('winlabel')!).props.text).toBe('25.00');

    // custom component registered and available
    const grid = scene.components.get('reels') as ReelGridInstance;
    expect(grid).toBeTruthy();
    grid.setField([[1, 2, 3], [4, 5, 6], [7, 0, 1]]);
    const cell = isMockNode(grid.cell(0, 0));
    // cell container holds a rect + a text label; label text reflects the field
    const label = cell.children.find((c) => c.tag === 'text')!;
    expect(label.props.text).toBe('1');

    // click handler evaluates against context
    const btn = isMockNode(scene.byId.get('spinBtn')!);
    btn.clicks[0]();
    expect(spins).toBe(1);
  });

  it('throws on tml:type without a registry', () => {
    const backend = createMockBackend();
    expect(() =>
      mountScene(SCENE, { backend, context: { state: reactive({ balance: 0, win: 0 }) } }),
    ).toThrowError(/no registry provided|unknown component/);
  });
});
