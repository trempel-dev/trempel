import { describe, it, expect } from 'vitest';
import { parse } from '../src/parser';
import { parseContract, checkContract } from '../src/contract';

const svg = (body: string, viewBox: string | null = '0 0 816 1456'): string =>
  `<svg xmlns="http://www.w3.org/2000/svg"${viewBox == null ? '' : ` viewBox="${viewBox}"`}>${body}</svg>`;
const check = (base: string, contract: string): string[] => checkContract(parse(base), parseContract(contract));

describe('contract v0.6 — viewBox rules', () => {
  it('fixed (v0.5) still works; commas are whitespace', () => {
    expect(check(svg('', '0,0,816,1456'), '<contract viewBox="0 0 816 1456"/>')).toEqual([]);
  });

  it('any: present and well-formed, value free', () => {
    expect(check(svg('', '0 0 1 2'), '<contract viewBox="any"/>')).toEqual([]);
    expect(check(svg('', null), '<contract viewBox="any"/>')).toEqual([
      'У базы нет корректного viewBox ("(нет)"), а контракт его требует.',
    ]);
  });

  it('a list of allowed values', () => {
    const c = '<contract viewBox="0 0 816 1456 | 0 0 960 1664 | 0 0 541 937"/>';
    expect(check(svg('', '0 0 960 1664'), c)).toEqual([]);
    expect(check(svg('', '0 0 1024 2048'), c)).toEqual([
      'viewBox базы "0 0 1024 2048" не из разрешённых: "0 0 816 1456", "0 0 960 1664", "0 0 541 937".',
    ]);
  });

  it('aspect only, with a tolerance (game canvases)', () => {
    const c = '<contract aspect="9:16" tolerance="3%"/>';
    for (const vb of ['0 0 816 1456', '0 0 960 1664', '0 0 864 1536', '0 0 541 937']) {
      expect(check(svg('', vb), c)).toEqual([]);
    }
    const [err] = check(svg('', '0 0 1280 800'), c);
    expect(err).toBe(
      'viewBox базы "0 0 1280 800" — пропорция 1280:800 ≈ 1.6000, а контракт ждёт 9:16 ≈ 0.5625 (допуск 3%).',
    );
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
    ['<contract viewBox="0 0 10"/>', /ожидается "minX minY ширина высота"/],
    ['<contract aspect="wide"/>', /aspect="wide" — ожидается "W:H"/],
    ['<contract aspect="9:16" tolerance="lots"/>', /tolerance="lots"/],
    ['<contract viewBox="any" aspect="9:16"/>', /либо viewBox, либо aspect/],
  ])('rejects a malformed rule: %s', (xml, re) => {
    expect(() => parseContract(xml)).toThrow(re);
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
      '<image id="o1"/><image id="o2"/><image id="d1"/><image id="o4 копия"/>',
      '<image id="_o1"/>',
    );
    expect(check(base, LEVEL)).toEqual([]);
  });

  it('flags the count, tag, place and missing partner — all at once', () => {
    const base = level('<image id="d1"/><g id="d2"/>', '<image id="_o3"/><image id="o9"/>');
    expect(check(base, LEVEL)).toEqual([
      '#o9: узлы по шаблону o(\\d+) должны лежать внутри #scene, а этот — снаружи.',
      'Узлов по шаблону o(\\d+) в #scene — 0, а контракт ждёт от 1 до 60.',
      '#_o3: к нему нужен парный узел #o3 (requires="o$1") — в базе его нет.',
      '#d2: по шаблону d\\d+ ожидается <image>, а в базе <g>.',
    ]);
  });

  it('count forms: exact, open-ended, upper bound', () => {
    const base = svg('<image id="a1"/><image id="a2"/>');
    expect(check(base, '<contract><image match="a\\d" count="2"/></contract>')).toEqual([]);
    expect(check(base, '<contract><image match="a\\d" count="3"/></contract>')).toEqual([
      'Узлов по шаблону a\\d — 2, а контракт ждёт ровно 3.',
    ]);
    expect(check(base, '<contract><image match="a\\d" count="3.."/></contract>')[0]).toMatch(/не меньше 3/);
    expect(check(base, '<contract><image match="a\\d" count="..1"/></contract>')[0]).toMatch(/не больше 1/);
    // default count is "at least one"
    expect(check(svg(''), '<contract><image match="a\\d"/></contract>')[0]).toMatch(/— 0, а контракт ждёт не меньше 1/);
  });

  it('the regex matches the whole id', () => {
    const base = svg('<image id="xo1"/><image id="o1x"/>');
    expect(check(base, '<contract><image match="o\\d+" count="0"/></contract>')).toEqual([]);
  });

  it('empty="true" on a pattern', () => {
    const base = svg('<g id="slot1"/><g id="slot2"><rect/><rect/></g>');
    expect(check(base, '<contract><g match="slot\\d" empty="true"/></contract>')).toEqual([
      '#slot2 должен быть пустым — в нём 2 дочерних узла.',
    ]);
  });

  it('a missing "in" container is one clear error', () => {
    expect(check(svg('<image id="o1"/>'), '<contract><image match="o\\d" in="scene"/></contract>')).toEqual([
      'Шаблон o\\d: контейнер #scene, в котором должны лежать узлы, в базе не найден.',
    ]);
  });

  it.each([
    ['<contract><image match="(" /></contract>', /не регулярное выражение/],
    ['<contract><image match="a" count="5..2"/></contract>', /минимум больше максимума/],
    ['<contract><image match="a" count="lots"/></contract>', /count="lots"/],
    ['<contract><image id="a" match="a"/></contract>', /id и match вместе не бывают/],
  ])('rejects a malformed pattern: %s', (xml, re) => {
    expect(() => parseContract(xml)).toThrow(re);
  });
});
