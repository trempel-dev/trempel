import { describe, it, expect } from 'vitest';
import { mountScene } from '../src/scene';
import { reactive } from '../src/reactive';
import { Registry } from '../src/registry';
import { createTileGrid, type TileGridInstance } from './helpers/tileGrid';
import { createMockBackend, isMockNode } from './helpers/mockBackend';
import { thrown } from './helpers/codes';

const SCENE = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:tml="https://trempel.dev/ns/scene" viewBox="0 0 1280 800">
  <g id="board" tml:type="tile-grid" tml:cols="3" tml:rows="3" tml:cellw="200" tml:cellh="200"/>
  <text id="balance" tml:bind="state.balance | fixed:2"/>
  <text id="bonus" tml:visible="state.bonus > 0" tml:bind="state.bonus | fixed:2"/>
  <g id="playBtn" tml:on-click="play()"/>
</svg>`;

describe('scene', () => {
  it('builds nodes, wires bindings, and instantiates custom components', () => {
    const backend = createMockBackend();
    const state = reactive({ balance: 1000, bonus: 0 });
    let plays = 0;
    const scene = mountScene(SCENE, {
      backend,
      registry: new Registry().register('tile-grid', createTileGrid),
      context: { state, play: () => plays++ },
    });

    // bindings applied
    expect(isMockNode(scene.byId.get('balance')!).props.text).toBe('1000.00');
    expect(isMockNode(scene.byId.get('bonus')!).props.visible).toBe(false);

    // reactive updates propagate
    state.balance = 950;
    expect(isMockNode(scene.byId.get('balance')!).props.text).toBe('950.00');
    state.bonus = 25;
    expect(isMockNode(scene.byId.get('bonus')!).props.visible).toBe(true);
    expect(isMockNode(scene.byId.get('bonus')!).props.text).toBe('25.00');

    // custom component registered and available
    const grid = scene.components.get('board') as TileGridInstance;
    expect(grid).toBeTruthy();
    grid.setField([[1, 2, 3], [4, 5, 6], [7, 0, 1]]);
    const cell = isMockNode(grid.cell(0, 0));
    // cell container holds a rect + a text label; label text reflects the field
    const label = cell.children.find((c) => c.tag === 'text')!;
    expect(label.props.text).toBe('1');

    // click handler evaluates against context
    const btn = isMockNode(scene.byId.get('playBtn')!);
    btn.clicks[0]();
    expect(plays).toBe(1);
  });

  it('throws on tml:type without a registry', () => {
    const backend = createMockBackend();
    const e = thrown(() =>
      mountScene(SCENE, { backend, context: { state: reactive({ balance: 0, bonus: 0 }) } }),
    );
    expect(e).toMatchObject({ code: 'E_NO_REGISTRY' });
  });
});
