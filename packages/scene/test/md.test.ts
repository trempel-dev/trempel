// md/ — the block tree of md clips: headers, `$key: value` attributes, bodies, value forms.

import { describe, it, expect } from 'vitest';
import { parse, MdParseError } from '../src/md/index';

describe('md clips — block tree', () => {
  it('headers nest by level; `## $` closes back to the top; bodies keep their tables', () => {
    const doc = parse('$tex: art/{}.png\n# $clip play\n$duration: 0.5\n## $track $symbol\n| t | x |\n|---|---|\n| 0 | 1 |\n## $\n$after: 1\n# $clip "two "\n');
    expect(doc.root.attrs).toEqual([{ key: ['tex'], value: 'art/{}.png' }, { key: ['after'], value: 1 }]);
    const [play, two] = doc.root.children;
    expect(play).toMatchObject({ name: 'clip', id: 'play', level: 1, attrs: [{ key: ['duration'], value: 0.5 }] });
    expect(play.children[0]).toMatchObject({ name: 'track', id: '$symbol', level: 2, body: '| t | x |\n|---|---|\n| 0 | 1 |' });
    expect(two.id).toBe('two ');
  });

  it('value forms: scalars, quoted strings, lists, JSON5 objects, raw interpolations, escapes', () => {
    const v = (line: string): unknown => parse(line).root.attrs[0].value;
    expect([v('$a: 007'), v('$a: +1'), v('$a: .5'), v('$a: -2'), v('$a: true'), v('$a: null'), v('$a:')]).toEqual(['007', '+1', 0.5, -2, true, null, '']);
    expect(v('$a: "x \\"y\\""')).toBe('x "y"');
    expect(v('$a: $[1, "b,c", d\\,e]')).toEqual([1, 'b,c', 'd,e']);
    expect(v("$a: {b: [1, 2], 'c': 0x10, d: .5,}")).toEqual({ b: [1, 2], c: 16, d: 0.5 });
    expect(v('$a: x ${y} z')).toEqual({ raw: 'x ${y} z', placeholders: [{ raw: 'y', start: 2, end: 6 }] });
    expect(v('$a: \\{x}')).toBe('{x}');
    expect(parse('# $clip a\n\\$b').root.children[0].body).toBe('$b');
  });

  it('a malformed object or a nested list fails the document', () => {
    expect(() => parse('$a: {b: }')).toThrow(MdParseError);
    expect(() => parse('$a: $[[1, 2], 3]')).toThrow(MdParseError);
  });
});
