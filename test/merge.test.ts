import { describe, it, expect } from 'vitest';
import { parse, parseHeir } from '../src/parser';
import { mergeScene, merge } from '../src/merge';
import { TrempelError } from '../src/errors';
import { findById } from '../src/tree';

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
      base(`<g id="reels"/><text id="balance">$0</text>`),
      heir(`<tml:ref id="reels" tml:type="reel-grid" tml:cols="3"/>
             <tml:ref id="balance" tml:bind="state.balance"/>`),
    );
    expect(errors).toEqual([]);
    expect(findById(tree, 'reels')[0].tml).toEqual({ type: 'reel-grid', cols: '3' });
    expect(findById(tree, 'balance')[0].tml.bind).toBe('state.balance');
  });

  it('errors when a ref targets an id that is not in the base', () => {
    const { errors } = run(base(`<g id="reels"/>`), heir(`<tml:ref id="ghost" tml:type="x"/>`));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/id="ghost".*нет в базе/);
  });

  it('errors when a ref carries a non-tml attribute (geometry stays in the base)', () => {
    const { errors } = run(
      base(`<g id="reels"/>`),
      heir(`<tml:ref id="reels" tml:type="x" transform="translate(1,2)" width="9"/>`),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/не-tml атрибут.*transform.*width/);
  });

  it('errors on a duplicate ref to the same id', () => {
    const { errors } = run(
      base(`<g id="reels"/>`),
      heir(`<tml:ref id="reels" tml:type="a"/><tml:ref id="reels" tml:type="b"/>`),
    );
    expect(errors.some((e) => /встречается более одного раза/.test(e))).toBe(true);
  });
});

describe('merge — inserts', () => {
  it('splices "after <id>" as a following sibling and "into <id>" as a last child', () => {
    const { tree, errors } = run(
      base(`<g id="reels"/><g id="hud"/>`),
      heir(`<text id="bigwin" tml:insert="after reels">win</text>
             <rect id="badge" tml:insert="into hud"/>`),
    );
    expect(errors).toEqual([]);
    const rootKids = tree.children.map((c) => c.attrs.id);
    expect(rootKids).toEqual(['reels', 'bigwin', 'hud']);
    expect(findById(tree, 'hud')[0].children[0].attrs.id).toBe('badge');
  });

  it('errors when an insert targets a missing id', () => {
    const { errors } = run(base(`<g id="reels"/>`), heir(`<g tml:insert="after ghost"/>`));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/узла "ghost" нет в базе/);
  });

  it('errors on malformed insert syntax', () => {
    const { errors } = run(base(`<g id="reels"/>`), heir(`<g tml:insert="sideways reels"/>`));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/ожидается 'after <id>' или 'into <id>'/);
  });
});

describe('merge — global invariants', () => {
  it('errors on a duplicate id within the base', () => {
    const { errors } = run(base(`<g id="dup"/><g id="dup"/>`), heir(``));
    expect(errors.some((e) => /Дублирующийся id "dup"/.test(e))).toBe(true);
  });

  it('errors on an id that collides between base and an heir insert', () => {
    const { errors } = run(
      base(`<g id="reels"/>`),
      heir(`<g id="reels" tml:insert="after reels"/>`),
    );
    expect(errors.some((e) => /Дублирующийся id "reels"/.test(e))).toBe(true);
  });

  it('errors when the base is not sterile (carries tml:*)', () => {
    const { errors } = run(base(`<g id="reels" tml:type="x"/>`), heir(``));
    expect(errors.some((e) => /не стерильна.*tml:type/.test(e))).toBe(true);
  });

  it('errors on an heir child that is neither a ref nor an insert subtree', () => {
    const { errors } = run(base(`<g id="reels"/>`), heir(`<g id="loose"/>`));
    expect(errors.some((e) => /не <tml:ref> и без tml:insert/.test(e))).toBe(true);
  });
});

describe('merge — error aggregation', () => {
  it('collects EVERY problem at once, not just the first', () => {
    const { errors } = run(
      base(`<g id="reels" tml:type="x"/><g id="dup"/><g id="dup"/>`),
      heir(`<tml:ref id="ghost" tml:type="a"/>
             <tml:ref id="reels" width="5"/>
             <g tml:insert="into nowhere"/>`),
    );
    // sterility + duplicate id + missing ref + foreign attr + missing insert target ⇒ ≥5
    expect(errors.length).toBeGreaterThanOrEqual(5);
    expect(errors.some((e) => /не стерильна/.test(e))).toBe(true);
    expect(errors.some((e) => /Дублирующийся id "dup"/.test(e))).toBe(true);
    expect(errors.some((e) => /id="ghost".*нет в базе/.test(e))).toBe(true);
    expect(errors.some((e) => /не-tml атрибут/.test(e))).toBe(true);
    expect(errors.some((e) => /"nowhere" нет в базе/.test(e))).toBe(true);
  });

  it('merge() throws a TrempelError carrying the whole list', () => {
    try {
      merge(parse(base(`<g id="reels"/>`)), parseHeir(heir(`<tml:ref id="ghost"/>`)));
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(TrempelError);
      expect((e as TrempelError).errors.length).toBeGreaterThan(0);
    }
  });
});
