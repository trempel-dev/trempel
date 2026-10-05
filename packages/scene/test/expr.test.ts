import { describe, it, expect } from 'vitest';
import { compile, run, ExpressionError, evalExpression } from '../src/expr';
import { evalBinding, bindingErrors } from '../src/binding';
import { parse } from '../src/parser';
import { reactive, effect } from '../src/reactive';
import { codesOf, thrown } from './helpers/codes';

const ev = (src: string, ctx: Record<string, unknown> = {}): unknown => run(compile(src), ctx);

/** The ExpressionError a source raises (fails the test if it parses). */
function syntaxError(src: string): ExpressionError {
  try {
    compile(src);
  } catch (e) {
    if (e instanceof ExpressionError) return e;
    throw e;
  }
  throw new Error(`"${src}" parsed, expected a syntax error`);
}

describe('expr — literals and operators', () => {
  it('evaluates literals', () => {
    expect(ev('42')).toBe(42);
    expect(ev('.5')).toBe(0.5);
    expect(ev('1e3')).toBe(1000);
    expect(ev("'a\\'b'")).toBe("a'b");
    expect(ev('"x\\ny"')).toBe('x\ny');
    expect(ev("'\\u00d7'")).toBe('×');
    expect(ev('true')).toBe(true);
    expect(ev('null')).toBe(null);
    expect(ev('undefined')).toBe(undefined);
    expect(ev('[1, 2, 3,]')).toEqual([1, 2, 3]);
    expect(ev("{ a: 1, 'b c': 2, 3: 4 }")).toEqual({ a: 1, 'b c': 2, 3: 4 });
  });

  it('respects arithmetic precedence and grouping', () => {
    expect(ev('1 + 2 * 3')).toBe(7);
    expect(ev('(1 + 2) * 3')).toBe(9);
    expect(ev('10 - 4 - 3')).toBe(3); // left-associative
    expect(ev('7 % 4 / 2')).toBe(1.5);
    expect(ev('-2 * -3')).toBe(6);
    expect(ev('+"5" + 1')).toBe(6);
    expect(ev("'$' + 3")).toBe('$3');
  });

  it('compares like JS', () => {
    expect(ev('1 < 2 && 2 <= 2 && 3 > 2 && 3 >= 4')).toBe(false);
    expect(ev("1 == '1'")).toBe(true);
    expect(ev("1 === '1'")).toBe(false);
    expect(ev("1 != '1'")).toBe(false);
    expect(ev("1 !== '1'")).toBe(true);
  });

  it('short-circuits && || ?? and !', () => {
    let calls = 0;
    const hit = (): number => ++calls;
    expect(ev('0 && hit()', { hit })).toBe(0);
    expect(ev('1 || hit()', { hit })).toBe(1);
    expect(ev('0 ?? hit()', { hit })).toBe(0);
    expect(calls).toBe(0);
    expect(ev('null ?? 7')).toBe(7);
    expect(ev('!0')).toBe(true);
    expect(ev('!!"x"')).toBe(true);
  });

  it('evaluates (nested) ternaries', () => {
    expect(ev("a ? 'y' : 'n'", { a: 1 })).toBe('y');
    expect(ev("a > 1 ? 'big' : a > 0 ? 'small' : 'none'", { a: 1 })).toBe('small');
  });
});

describe('expr — context access and calls', () => {
  const ctx = {
    state: { win: 3, items: [10, 20], nested: { k: 'v' }, phase: 'idle' },
    t: { title: 'Hello' },
    add: (a: number, b: number) => a + b,
    play: () => 'spun',
  };

  it('reads fields and indices', () => {
    expect(ev('state.win', ctx)).toBe(3);
    expect(ev('state.items[1]', ctx)).toBe(20);
    expect(ev("state['nested'].k", ctx)).toBe('v');
    expect(ev('state.items.length', ctx)).toBe(2);
    expect(ev("'abc'.length")).toBe(3);
  });

  it('calls context functions and methods with the right this', () => {
    expect(ev('play()', ctx)).toBe('spun');
    expect(ev('add(state.win, 1)', ctx)).toBe(4);
    expect(ev('state.items.includes(20)', ctx)).toBe(true);
    expect(ev("t.title.toUpperCase()", ctx)).toBe('HELLO');
  });

  it("runs a money expression (method call with an object literal argument)", () => {
    const src =
      "'$' + state.balance.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})";
    expect(ev(src, { state: { balance: 1234.5 } })).toBe('$1,234.50');
  });

  it('throws an evaluation error for unknown names, member of undefined and non-functions', () => {
    const undef = thrown(() => ev('nope', ctx));
    expect(undef).toMatchObject({ code: 'E_EXPR_UNDEF' });
    expect(undef.message).toContain('nope');
    const field = thrown(() => ev('state.missing.x', ctx));
    expect(field).toMatchObject({ code: 'E_EXPR_FIELD' });
    expect(field.message).toContain('"x"');
    expect(thrown(() => ev('state.win()', ctx))).toMatchObject({ code: 'E_EXPR_CALL' });
  });

  it('has no globals and no path back to code', () => {
    expect(thrown(() => ev('Math.max(1, 2)'))).toMatchObject({ code: 'E_EXPR_UNDEF' });
    expect(thrown(() => ev('globalThis'))).toMatchObject({ code: 'E_EXPR_UNDEF' });
    const ctor = thrown(() => compile('play.constructor'));
    expect(ctor).toMatchObject({ code: 'E_EXPR_FORBIDDEN' });
    expect(ctor.message).toContain('constructor');
    expect(thrown(() => compile('a.__proto__'))).toMatchObject({ code: 'E_EXPR_FORBIDDEN' });
    const computed = thrown(() => ev("play['constru' + 'ctor']", ctx));
    expect(computed).toMatchObject({ code: 'E_EXPR_FORBIDDEN' });
    expect(computed.message).toContain('constructor');
    expect(thrown(() => ev("t['__proto__']", ctx))).toMatchObject({ code: 'E_EXPR_FORBIDDEN' });
    // inherited Object.prototype members are not context names
    expect(thrown(() => ev('toString', ctx))).toMatchObject({ code: 'E_EXPR_UNDEF' });
  });
});

describe('expr — pipes', () => {
  it('splits pipes from the expression (|| stays logical, | inside strings is text)', () => {
    const c = compile("state.a || 'x|y' | fixed:2 | int");
    expect(c.expr).toBe("state.a || 'x|y'");
    expect(c.pipes).toEqual([{ name: 'fixed', arg: '2' }, { name: 'int' }]);
  });

  it('accepts string, name and negative-number pipe arguments', () => {
    expect(compile("v | money:'€'").pipes).toEqual([{ name: 'money', arg: '€' }]);
    expect(compile('v | money:EUR').pipes).toEqual([{ name: 'money', arg: 'EUR' }]);
    expect(compile('v | fixed:-1').pipes).toEqual([{ name: 'fixed', arg: '-1' }]);
  });

  it('applies built-in pipes, money included', () => {
    expect(evalBinding('v | fixed:2', { v: 3 })).toBe('3.00');
    expect(evalBinding('v | money', { v: 1234.5 })).toBe('$1,234.50');
    expect(evalBinding("v | money:'€'", { v: 2 })).toBe('€2.00');
  });
});

describe('expr — syntax errors carry a position', () => {
  it.each([
    ['state.', 'a field name expected after "."', 6],
    ['a +', 'the expression breaks off', 3],
    ['(a', '")" expected', 2],
    ['a b', 'an extra "b"', 2],
    ['a = 1', 'assignment is not supported', 2],
    ["'open", 'an unclosed string', 0],
    ['a # b', 'an unexpected "#"', 2],
    ['a ? b', '":" expected', 5],
    ['a | ', 'a pipe name expected after "|"', 4],
    ['1x', 'a number runs into a name', 1],
    ['', 'an empty expression', 0],
    ['{a 1}', '":" expected', 3],
  ])('%j → %s @%i', (src, _what, pos) => {
    const e = syntaxError(src);
    expect(e).toMatchObject({ code: 'E_EXPR_SYNTAX', pos });
    expect(e.reason).not.toBe('');
    expect(e.message).toContain(`(col ${pos + 1})`);
  });

  it('bindingErrors reports every broken expression of a tree, with a caret', () => {
    const tree = parse(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:tml="https://trempel.dev/ns/scene">
      <text id="a" tml:bind="state.x +"/>
      <g id="b" tml:on-click="go("/>
      <text id="c" tml:bind="state.x | nosuch"/>
      <g id="ok" tml:visible="state.x > 0" tml:cols="3"/>
    </svg>`);
    const errors = bindingErrors(tree);
    expect(codesOf(errors)).toEqual(['E_EXPR_SYNTAX', 'E_EXPR_SYNTAX', 'E_PIPE_UNKNOWN']);
    expect(errors[0]).toMatch(/^E_EXPR_SYNTAX: #a tml:bind: .*\(col 10\):\n {6}state\.x \+\n {15}\^$/);
    expect(errors[1]).toContain('#b tml:on-click:');
    expect(errors[2]).toContain('#c tml:bind:');
    expect(errors[2]).toContain('nosuch');
  });
});

describe('expr — reactivity and v0.5 leniency', () => {
  it('tracks reads through the interpreter', () => {
    const state = reactive({ a: 1, b: 2, flag: false });
    const seen: unknown[] = [];
    effect(() => seen.push(evalExpression('state.flag ? state.a : state.b', { state })));
    state.b = 5;
    state.flag = true;
    state.a = 9;
    expect(seen).toEqual([2, 5, 1, 9]);
  });

  it('evalExpression yields undefined on syntax and evaluation errors', () => {
    expect(evalExpression('state.', { state: {} })).toBeUndefined();
    expect(evalExpression('state.x.y', { state: {} })).toBeUndefined();
  });

  it('caches compiled expressions by source', () => {
    expect(compile('a + 1')).toBe(compile('a + 1'));
  });
});
