import { describe, it, expect } from 'vitest';
import { applyBindings, evalBinding, parseBind } from '../src/binding';
import { reactive } from '../src/reactive';
import { createMockBackend, isMockNode } from './helpers/mockBackend';

describe('binding — pipes', () => {
  it('parses expression and pipes', () => {
    const p = parseBind('state.balance | fixed:2');
    expect(p.expr).toBe('state.balance');
    expect(p.pipes).toEqual([{ name: 'fixed', arg: '2' }]);
  });

  it('applies fixed:N', () => {
    expect(evalBinding('state.balance | fixed:2', { state: { balance: 3 } })).toBe('3.00');
    expect(evalBinding('state.balance | fixed:0', { state: { balance: 3.7 } })).toBe('4');
  });

  it('applies int', () => {
    expect(evalBinding('state.x | int', { state: { x: 4.9 } })).toBe(4);
  });

  it('keeps logical || intact (does not split it as a pipe)', () => {
    expect(evalBinding('state.a || state.b', { state: { a: 0, b: 7 } })).toBe(7);
  });

  it('throws on an unknown pipe', () => {
    expect(() => evalBinding('state.x | bogus', { state: { x: 1 } })).toThrowError(/unknown pipe/);
  });
});

describe('binding — applyBindings', () => {
  it('writes the default property for a text node and reacts to mutations', () => {
    const backend = createMockBackend();
    const state = reactive({ balance: 1000 });
    const node = backend.createNode('text', {});
    applyBindings(node, 'text', { bind: 'state.balance | fixed:2' }, backend, { state });

    expect(isMockNode(node).props.text).toBe('1000.00');
    state.balance = 12.5;
    expect(isMockNode(node).props.text).toBe('12.50');
  });

  it('toggles visibility from a boolean expression', () => {
    const backend = createMockBackend();
    const state = reactive({ win: 0 });
    const node = backend.createNode('text', {});
    applyBindings(node, 'text', { visible: 'state.win > 0' }, backend, { state });

    expect(isMockNode(node).props.visible).toBe(false);
    state.win = 50;
    expect(isMockNode(node).props.visible).toBe(true);
  });

  it('supports tml:bind-<attr> on nodes without a default property', () => {
    const backend = createMockBackend();
    const state = reactive({ y: 10 });
    const node = backend.createNode('g', {});
    applyBindings(node, 'g', { 'bind-y': 'state.y' }, backend, { state });

    expect(isMockNode(node).props.y).toBe(10);
    state.y = 42;
    expect(isMockNode(node).props.y).toBe(42);
  });

  it('throws when tml:bind is used on a node without a default property', () => {
    const backend = createMockBackend();
    const node = backend.createNode('g', {});
    expect(() =>
      applyBindings(node, 'g', { bind: 'state.x' }, backend, { state: { x: 1 } }),
    ).toThrowError(/no default bind property/);
  });
});
