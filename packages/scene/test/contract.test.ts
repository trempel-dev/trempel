import { describe, it, expect } from 'vitest';
import { parse } from '../src/parser';
import { parseContract, checkContract } from '../src/contract';

// xmlns:tml is declared so the "tml in base" fixture can carry a tml:* attribute and still parse.
const base = (body: string, viewBox = '0 0 1280 800'): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:tml="https://trempel.dev/ns/scene" viewBox="${viewBox}">${body}</svg>`;

const check = (b: string, contract: string): string[] =>
  checkContract(parse(b), parseContract(contract));

const CONTRACT = `<contract viewBox="0 0 1280 800">
  <g id="board" empty="true"/>
  <text id="balance"/>
  <image id="bg"/>
</contract>`;

const GOOD_BASE = base(`
  <image id="bg" href="a.png"/>
  <g id="board"/>
  <text id="balance">$0</text>`);

describe('contract — happy path', () => {
  it('passes a base that satisfies every clause', () => {
    expect(check(GOOD_BASE, CONTRACT)).toEqual([]);
  });
});

describe('contract — check 1 (node exists once, tag matches)', () => {
  it('flags a missing node', () => {
    const errors = check(base(`<g id="board"/><image id="bg"/>`), CONTRACT);
    expect(errors.some((e) => /#balance:.*такого узла в базе нет/.test(e))).toBe(true);
  });

  it('flags a tag mismatch', () => {
    const errors = check(
      base(`<image id="bg"/><g id="board"/><g id="balance"/>`),
      CONTRACT,
    );
    expect(errors.some((e) => /#balance: контракт ждёт <text>, а в базе <g>/.test(e))).toBe(true);
  });
});

describe('contract — check 2 (empty="true")', () => {
  it('passes an empty container', () => {
    expect(check(GOOD_BASE, CONTRACT)).toEqual([]);
  });

  it('flags a container that has children', () => {
    const errors = check(
      base(`<image id="bg"/><g id="board"><rect/></g><text id="balance"/>`),
      CONTRACT,
    );
    expect(errors.some((e) => /#board должен быть пустым — в нём 1/.test(e))).toBe(true);
  });
});

describe('contract — check 3 (viewBox)', () => {
  it('passes when viewBox matches (whitespace-insensitive)', () => {
    const b = base(`<image id="bg"/><g id="board"/><text id="balance"/>`, '0  0 1280 800');
    expect(check(b, CONTRACT)).toEqual([]);
  });

  it('flags a viewBox mismatch', () => {
    const b = base(`<image id="bg"/><g id="board"/><text id="balance"/>`, '0 0 1024 768');
    const errors = check(b, CONTRACT);
    expect(errors.some((e) => /viewBox базы.*не совпадает/.test(e))).toBe(true);
  });
});

describe('contract — check 4 (base ids unique)', () => {
  it('flags duplicate base ids', () => {
    const errors = check(
      base(`<image id="bg"/><g id="board"/><text id="balance"/><text id="balance"/>`),
      CONTRACT,
    );
    // duplicate surfaces both as the per-node "встречается N раз" and the global uniqueness check
    expect(errors.some((e) => /balance.*id должен быть уникален/.test(e))).toBe(true);
  });
});

describe('contract — check 5 (base sterile)', () => {
  it('passes a sterile base', () => {
    expect(check(GOOD_BASE, CONTRACT)).toEqual([]);
  });

  it('flags a tml:* attribute in the base', () => {
    const errors = check(
      base(`<image id="bg"/><g id="board" tml:type="tile-grid"/><text id="balance"/>`),
      CONTRACT,
    );
    expect(errors.some((e) => /не стерильна.*tml:type/.test(e))).toBe(true);
  });
});

describe('contract — parsing', () => {
  it('reads viewBox, tags, ids and empty flags', () => {
    const c = parseContract(CONTRACT);
    expect(c.viewBox).toBe('0 0 1280 800');
    expect(c.nodes).toEqual([
      { tag: 'g', id: 'board', empty: true },
      { tag: 'text', id: 'balance', empty: false },
      { tag: 'image', id: 'bg', empty: false },
    ]);
  });

  it('throws on a non-<contract> root', () => {
    expect(() => parseContract(`<foo/>`)).toThrow(/root element must be <contract>/);
  });
});
