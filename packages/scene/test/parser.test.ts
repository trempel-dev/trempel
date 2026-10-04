import { describe, it, expect } from 'vitest';
import { parse } from '../src/parser';

const SCENE = `<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:tml="https://trempel.dev/ns/scene"
     viewBox="0 0 1280 800">
  <image id="bg" href="assets/bg.png" width="1280" height="800"/>
  <g id="board" tml:type="tile-grid" transform="translate(320,160)"
     tml:cols="3" tml:rows="3" tml:cell="200" tml:gap="8"/>
  <text id="balance" x="200" y="760" fill="#ffd700" font-size="36"
        tml:bind="state.balance | fixed:2"/>
  <g id="playBtn" transform="translate(1080,700)" tml:on-click="play()">
    <image href="assets/buttons/play_normal.png"/>
  </g>
</svg>`;

describe('parser', () => {
  it('parses the example scene into a SceneTree', () => {
    const tree = parse(SCENE);
    expect(tree.tag).toBe('svg');
    expect(tree.attrs.viewBox).toBe('0 0 1280 800');
    expect(tree.children.map((c) => c.tag)).toEqual(['image', 'g', 'text', 'g']);
  });

  it('separates tml:* attributes from plain attributes', () => {
    const tree = parse(SCENE);
    const board = tree.children[1];
    expect(board.tml.type).toBe('tile-grid');
    expect(board.tml.cols).toBe('3');
    expect(board.tml.gap).toBe('8');
    expect(board.attrs.transform).toBe('translate(320,160)');
    // tml keys are prefix-stripped and never leak into attrs.
    expect(board.attrs['tml:cols']).toBeUndefined();
  });

  it('captures tml:bind and tml:on-click verbatim', () => {
    const tree = parse(SCENE);
    const balance = tree.children[2];
    expect(balance.tml.bind).toBe('state.balance | fixed:2');
    const btn = tree.children[3];
    expect(btn.tml['on-click']).toBe('play()');
    expect(btn.children[0].tag).toBe('image');
  });

  it('drops xmlns declarations from attrs', () => {
    const tree = parse(SCENE);
    expect(tree.attrs.xmlns).toBeUndefined();
    expect(tree.attrs['xmlns:tml']).toBeUndefined();
  });

  it('throws a clear error on an unsupported element', () => {
    const bad = `<svg xmlns="http://www.w3.org/2000/svg"><polygon points="0,0 5,5"/></svg>`;
    expect(() => parse(bad)).toThrowError(/unsupported element <polygon>.*<path/);
  });

  it('throws on malformed XML', () => {
    expect(() => parse('<svg><g></svg>')).toThrow();
  });
});
