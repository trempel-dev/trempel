import { describe, it, expect } from 'vitest';
import { parse, parseHeir } from '../src/parser';
import { mergeScene, merge } from '../src/merge';
import { TrempelError } from '../src/errors';
import { findById } from '../src/tree';
import { codesOf, withCode } from './helpers/codes';

// xmlns:tml is declared so "dirty base" fixtures can carry a tml:* attribute and still parse;
// a namespace *declaration* is not a tml:* attribute (the parser drops all xmlns:*), so the
// base stays sterile unless a fixture adds an actual tml:… attribute.
const base = (body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:tml="https://trempel.dev/ns/scene" viewBox="0 0 100 100">${body}</svg>`;
const heir = (body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:tml="https://trempel.dev/ns/scene" tml:extends="scene.svg">${body}</svg>`;

const run = (b: string, h: string): { tree: ReturnType<typeof parse>; errors: string[] } =>
  mergeScene(parse(b), parseHeir(h));

describe('merge — refs', () => {
  it('mixes a ref\'s tml:* attributes into the matching base node (no errors)', () => {
    const { tree, errors } = run(
      base(`<g id="board"/><text id="balance">$0</text>`),
      heir(`<tml:ref id="board" tml:type="tile-grid" tml:cols="3"/>
             <tml:ref id="balance" tml:bind="state.balance"/>`),
    );
    expect(errors).toEqual([]);
    expect(findById(tree, 'board')[0].tml).toEqual({ type: 'tile-grid', cols: '3' });
    expect(findById(tree, 'balance')[0].tml.bind).toBe('state.balance');
  });

  it('errors when a ref targets an id that is not in the base', () => {
    const { errors } = run(base(`<g id="board"/>`), heir(`<tml:ref id="ghost" tml:type="x"/>`));
    expect(codesOf(errors)).toEqual(['E_REF_MISSING']);
    expect(errors[0]).toContain('id="ghost"');
  });

  it('errors when a ref carries a non-tml attribute (geometry stays in the base)', () => {
    const { errors } = run(
      base(`<g id="board"/>`),
      heir(`<tml:ref id="board" tml:type="x" transform="translate(1,2)" width="9"/>`),
    );
    expect(codesOf(errors)).toEqual(['E_REF_FOREIGN']);
    expect(errors[0]).toMatch(/transform.*width/);
  });

  it('errors on a duplicate ref to the same id', () => {
    const { errors } = run(
      base(`<g id="board"/>`),
      heir(`<tml:ref id="board" tml:type="a"/><tml:ref id="board" tml:type="b"/>`),
    );
    expect(withCode(errors, 'E_REF_TWICE')[0]).toContain('id="board"');
  });
});

describe('merge — inserts', () => {
  it('splices "after <id>" as a following sibling and "into <id>" as a last child', () => {
    const { tree, errors } = run(
      base(`<g id="board"/><g id="hud"/>`),
      heir(`<text id="levelup" tml:insert="after board">win</text>
             <rect id="badge" tml:insert="into hud"/>`),
    );
    expect(errors).toEqual([]);
    const rootKids = tree.children.map((c) => c.attrs.id);
    expect(rootKids).toEqual(['board', 'levelup', 'hud']);
    expect(findById(tree, 'hud')[0].children[0].attrs.id).toBe('badge');
  });

  it('errors when an insert targets a missing id', () => {
    const { errors } = run(base(`<g id="board"/>`), heir(`<g tml:insert="after ghost"/>`));
    expect(codesOf(errors)).toEqual(['E_INSERT_TARGET']);
    expect(errors[0]).toContain('"ghost"');
  });

  it('errors on malformed insert syntax', () => {
    const { errors } = run(base(`<g id="board"/>`), heir(`<g tml:insert="sideways board"/>`));
    expect(codesOf(errors)).toEqual(['E_INSERT_SYNTAX']);
    expect(errors[0]).toContain('sideways board');
  });
});

describe('merge — global invariants', () => {
  it('errors on a duplicate id within the base', () => {
    const { errors } = run(base(`<g id="dup"/><g id="dup"/>`), heir(``));
    expect(withCode(errors, 'E_DUP_ID')[0]).toContain('"dup"');
  });

  it('errors on an id that collides between base and an heir insert', () => {
    const { errors } = run(
      base(`<g id="board"/>`),
      heir(`<g id="board" tml:insert="after board"/>`),
    );
    expect(withCode(errors, 'E_DUP_ID')[0]).toContain('"board"');
  });

  it('errors when the base is not sterile (carries tml:*)', () => {
    const { errors } = run(base(`<g id="board" tml:type="x"/>`), heir(``));
    expect(withCode(errors, 'E_STERILE')[0]).toContain('tml:type');
  });

  it('errors on an heir child that is neither a ref nor an insert subtree', () => {
    const { errors } = run(base(`<g id="board"/>`), heir(`<g id="loose"/>`));
    withCode(errors, 'E_HEIR_STRAY');
  });
});

describe('merge — error aggregation', () => {
  it('collects EVERY problem at once, not just the first', () => {
    const { errors } = run(
      base(`<g id="board" tml:type="x"/><g id="dup"/><g id="dup"/>`),
      heir(`<tml:ref id="ghost" tml:type="a"/>
             <tml:ref id="board" width="5"/>
             <g tml:insert="into nowhere"/>`),
    );
    // sterility + duplicate id + missing ref + foreign attr + missing insert target ⇒ ≥5
    expect(errors.length).toBeGreaterThanOrEqual(5);
    withCode(errors, 'E_STERILE');
    expect(withCode(errors, 'E_DUP_ID')[0]).toContain('"dup"');
    expect(withCode(errors, 'E_REF_MISSING')[0]).toContain('id="ghost"');
    withCode(errors, 'E_REF_FOREIGN');
    expect(withCode(errors, 'E_INSERT_TARGET')[0]).toContain('"nowhere"');
  });

  it('merge() throws a TrempelError carrying the whole list', () => {
    try {
      merge(parse(base(`<g id="board"/>`)), parseHeir(heir(`<tml:ref id="ghost"/>`)));
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(TrempelError);
      expect((e as TrempelError).errors.length).toBeGreaterThan(0);
    }
  });
});
