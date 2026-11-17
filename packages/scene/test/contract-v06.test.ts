import { describe, it, expect } from 'vitest';
import { parse } from '../src/parser';
import { parseContract, checkContract } from '../src/contract';
import { codesOf, thrown } from './helpers/codes';

const svg = (body: string, viewBox: string | null = '0 0 816 1456'): string =>
  `<svg xmlns="http://www.w3.org/2000/svg"${viewBox == null ? '' : ` viewBox="${viewBox}"`}>${body}</svg>`;
const check = (base: string, contract: string): string[] => checkContract(parse(base), parseContract(contract));

describe('contract v0.6 — viewBox rules', () => {
  it('fixed (v0.5) still works; commas are whitespace', () => {
    expect(check(svg('', '0,0,816,1456'), '<contract viewBox="0 0 816 1456"/>')).toEqual([]);
  });

  it('any: present and well-formed, value free', () => {
    expect(check(svg('', '0 0 1 2'), '<contract viewBox="any"/>')).toEqual([]);
    expect(codesOf(check(svg('', null), '<contract viewBox="any"/>'))).toEqual(['E_CONTRACT_VIEWBOX']);
  });

  it('a list of allowed values', () => {
    const c = '<contract viewBox="0 0 816 1456 | 0 0 960 1664 | 0 0 541 937"/>';
    expect(check(svg('', '0 0 960 1664'), c)).toEqual([]);
    const errs = check(svg('', '0 0 1024 2048'), c);
    expect(codesOf(errs)).toEqual(['E_CONTRACT_VIEWBOX']);
    expect(errs[0]).toContain('"0 0 1024 2048"');
    expect(errs[0]).toContain('"0 0 816 1456", "0 0 960 1664", "0 0 541 937"');
  });

  it('aspect only, with a tolerance (game canvases)', () => {
    const c = '<contract aspect="9:16" tolerance="3%"/>';
    for (const vb of ['0 0 816 1456', '0 0 960 1664', '0 0 864 1536', '0 0 541 937']) {
      expect(check(svg('', vb), c)).toEqual([]);
    }
    const errs = check(svg('', '0 0 1280 800'), c);
    expect(codesOf(errs)).toEqual(['E_CONTRACT_VIEWBOX']);
    for (const part of ['"0 0 1280 800"', '1280:800 ≈ 1.6000', '9:16 ≈ 0.5625', '3%']) expect(errs[0]).toContain(part);
    expect(check(svg('', '0 0 900 1600'), '<contract aspect="9:16"/>')).toEqual([]); // exact, no tolerance
  });

  it('parses the rule', () => {
    expect(parseContract('<contract/>').viewBoxRule).toEqual({ kind: 'none' });
    expect(parseContract('<contract viewBox="*"/>').viewBoxRule).toEqual({ kind: 'any' });
    expect(parseContract('<contract aspect="16/9" tolerance="0.01"/>').viewBoxRule).toMatchObject({
      kind: 'aspect',
      tolerance: 0.01,
    });
  });

  it.each([
    ['<contract viewBox="0 0 10"/>', 'viewBox="0 0 10"'],
    ['<contract aspect="wide"/>', 'aspect="wide"'],
    ['<contract aspect="9:16" tolerance="lots"/>', 'tolerance="lots"'],
    ['<contract viewBox="any" aspect="9:16"/>', '<contract>'],
  ])('rejects a malformed rule: %s', (xml, names) => {
    const e = thrown(() => parseContract(xml));
    expect(e).toMatchObject({ code: 'E_CONTRACT_SYNTAX' });
    expect(e.message).toContain(names);
  });
});

// A find-the-cats level: cats oN in #scene, panel icons _oN in #icons, decor dK.
const LEVEL = `<contract aspect="9:16" tolerance="3%">
  <image id="back"/>
  <g id="scene"/>
  <g id="icons"/>
  <image match="o(\\d+)" count="1..60" in="scene"/>
  <image match="_o(\\d+)" count="..60" in="icons" requires="o$1"/>
  <image match="d\\d+" count="0.." in="scene"/>
</contract>`;

const level = (scene: string, icons: string): string =>
  svg(`<image id="back"/><g id="scene">${scene}</g><g id="icons">${icons}</g>`);

describe('contract v0.6 — pattern nodes', () => {
  it('parses patterns next to plain nodes', () => {
    const c = parseContract(LEVEL);
    expect(c.nodes.map((n) => n.id)).toEqual(['back', 'scene', 'icons']);
    expect(c.patterns).toEqual([
      { tag: 'image', match: 'o(\\d+)', min: 1, max: 60, in: 'scene', empty: false },
      { tag: 'image', match: '_o(\\d+)', min: 0, max: 60, in: 'icons', requires: 'o$1', empty: false },
      { tag: 'image', match: 'd\\d+', min: 0, max: Infinity, in: 'scene', empty: false },
    ]);
  });

  it('passes a good level (an oN without _oN is fine — the link is one-way)', () => {
    const base = level(
      '<image id="o1"/><image id="o2"/><image id="d1"/><image id="o4 copy"/>',
      '<image id="_o1"/>',
    );
    expect(check(base, LEVEL)).toEqual([]);
  });

  it('flags the count, tag, place and missing partner — all at once', () => {
    const base = level('<image id="d1"/><g id="d2"/>', '<image id="_o3"/><image id="o9"/>');
    const errs = check(base, LEVEL);
    expect(codesOf(errs)).toEqual(['E_CONTRACT_PLACE', 'E_CONTRACT_COUNT', 'E_CONTRACT_PARTNER', 'E_CONTRACT_TAG']);
    expect(errs[0]).toContain('#o9');
    expect(errs[0]).toContain('#scene');
    expect(errs[1]).toMatch(/o\(\\d\+\).*#scene.*\b0\b.*\b1\b.*\b60\b/);
    expect(errs[2]).toContain('#_o3');
    expect(errs[2]).toContain('#o3');
    expect(errs[3]).toContain('#d2');
    expect(errs[3]).toContain('<image>');
    expect(errs[3]).toContain('<g>');
  });

  it('count forms: exact, open-ended, upper bound', () => {
    const base = svg('<image id="a1"/><image id="a2"/>');
    expect(check(base, '<contract><image match="a\\d" count="2"/></contract>')).toEqual([]);
    // one E_CONTRACT_COUNT naming how many matched and the bound broken
    const count = (b: string, c: string): string => {
      const errs = check(b, c);
      expect(codesOf(errs)).toEqual(['E_CONTRACT_COUNT']);
      return errs[0];
    };
    expect(count(base, '<contract><image match="a\\d" count="3"/></contract>')).toMatch(/\b2\b.*\b3\b/);
    expect(count(base, '<contract><image match="a\\d" count="3.."/></contract>')).toMatch(/\b2\b.*\b3\b/);
    expect(count(base, '<contract><image match="a\\d" count="..1"/></contract>')).toMatch(/\b2\b.*\b1\b/);
    // default count is "at least one"
    expect(count(svg(''), '<contract><image match="a\\d"/></contract>')).toMatch(/\b0\b.*\b1\b/);
  });

  it('the regex matches the whole id', () => {
    const base = svg('<image id="xo1"/><image id="o1x"/>');
    expect(check(base, '<contract><image match="o\\d+" count="0"/></contract>')).toEqual([]);
  });

  it('empty="true" on a pattern', () => {
    const base = svg('<g id="slot1"/><g id="slot2"><rect/><rect/></g>');
    const errs = check(base, '<contract><g match="slot\\d" empty="true"/></contract>');
    expect(codesOf(errs)).toEqual(['E_CONTRACT_EMPTY']);
    expect(errs[0]).toContain('#slot2');
  });

  it('a missing "in" container is one clear error', () => {
    const errs = check(svg('<image id="o1"/>'), '<contract><image match="o\\d" in="scene"/></contract>');
    expect(codesOf(errs)).toEqual(['E_CONTRACT_MISSING']);
    expect(errs[0]).toContain('#scene');
  });

  it.each([
    ['<contract><image match="(" /></contract>', 'match="("'],
    ['<contract><image match="a" count="5..2"/></contract>', 'count="5..2"'],
    ['<contract><image match="a" count="lots"/></contract>', 'count="lots"'],
    ['<contract><image id="a" match="a"/></contract>', '<image id="a">'],
  ])('rejects a malformed pattern: %s', (xml, names) => {
    const e = thrown(() => parseContract(xml));
    expect(e).toMatchObject({ code: 'E_CONTRACT_SYNTAX' });
    expect(e.message).toContain(names);
  });
});
