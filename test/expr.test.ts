import { describe, it, expect } from 'vitest';
import { compile, run, ExpressionError, evalExpression } from '../src/expr';
import { evalBinding, bindingErrors } from '../src/binding';
import { parse } from '../src/parser';
import { reactive, effect } from '../src/reactive';

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
    spin: () => 'spun',
  };

  it('reads fields and indices', () => {
    expect(ev('state.win', ctx)).toBe(3);
    expect(ev('state.items[1]', ctx)).toBe(20);
    expect(ev("state['nested'].k", ctx)).toBe('v');
    expect(ev('state.items.length', ctx)).toBe(2);
    expect(ev("'abc'.length")).toBe(3);
  });

  it('calls context functions and methods with the right this', () => {
    expect(ev('spin()', ctx)).toBe('spun');
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
    expect(() => ev('nope', ctx)).toThrow(/имя «nope» не определено/);
    expect(() => ev('state.missing.x', ctx)).toThrow(/чтение поля «x» у undefined/);
    expect(() => ev('state.win()', ctx)).toThrow(/вызов не-функции/);
  });

  it('has no globals and no path back to code', () => {
    expect(() => ev('Math.max(1, 2)')).toThrow(/не определено/);
    expect(() => ev('globalThis')).toThrow(/не определено/);
    expect(() => compile('spin.constructor')).toThrow(/доступ к «constructor» запрещён/);
    expect(() => compile('a.__proto__')).toThrow(/запрещён/);
    expect(() => ev("spin['constru' + 'ctor']", ctx)).toThrow(/доступ к «constructor» запрещён/);
    expect(() => ev("t['__proto__']", ctx)).toThrow(/запрещён/);
    // inherited Object.prototype members are not context names
    expect(() => ev('toString', ctx)).toThrow(/не определено/);
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
    ['state.', 'после «.» ожидается имя поля', 6],
    ['a +', 'выражение оборвалось', 3],
    ['(a', 'ожидается «)»', 2],
    ['a b', 'лишнее «b»', 2],
    ['a = 1', 'присваивание не поддерживается', 2],
    ["'open", 'незакрытая строка', 0],
    ['a # b', 'неожиданный символ «#»', 2],
    ['a ? b', 'ожидается «:»', 5],
    ['a | ', 'после «|» ожидается имя пайпа', 4],
    ['1x', 'число сразу переходит в имя', 1],
    ['', 'пустое выражение', 0],
    ['{a 1}', 'ожидается «:»', 3],
  ])('%j → %s @%i', (src, reason, pos) => {
    const e = syntaxError(src);
    expect(e.reason).toContain(reason);
    expect(e.pos).toBe(pos);
    expect(e.message).toContain(`позиция ${pos + 1}`);
  });

  it('bindingErrors reports every broken expression of a tree, with a caret', () => {
    const tree = parse(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:tml="https://trempel.dev/ns/scene">
      <text id="a" tml:bind="state.x +"/>
      <g id="b" tml:on-click="go("/>
      <text id="c" tml:bind="state.x | nosuch"/>
      <g id="ok" tml:visible="state.x > 0" tml:cols="3"/>
    </svg>`);
    const errors = bindingErrors(tree);
    expect(errors).toHaveLength(3);
    expect(errors[0]).toMatch(/^#a tml:bind: выражение оборвалось.*позиция 10:\n {6}state\.x \+\n {15}\^$/);
    expect(errors[1]).toMatch(/^#b tml:on-click: выражение оборвалось/);
    expect(errors[2]).toMatch(/^#c tml:bind: неизвестный пайп «nosuch»/);
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
