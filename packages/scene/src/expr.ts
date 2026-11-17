// expr.ts — the Trempel expression language: a tokenizer, a Pratt parser and a tree-walking
// interpreter. No code generation of any kind, so scenes run under a strict CSP (no unsafe-eval).
//
// Grammar (v0.6), lowest precedence first:
//   pipeline   := cond ( '|' NAME ( ':' ARG )? )*          ARG: number | string | name
//   cond       := nullish ( '?' cond ':' cond )?
//   nullish    := or ( '??' or )*
//   or         := and ( '||' and )*
//   and        := equality ( '&&' equality )*
//   equality   := relation ( ( '==' | '!=' | '===' | '!==' ) relation )*
//   relation   := additive ( ( '<' | '<=' | '>' | '>=' ) additive )*
//   additive   := multiplicative ( ( '+' | '-' ) multiplicative )*
//   multiplicative := unary ( ( '*' | '/' | '%' ) unary )*
//   unary      := ( '!' | '-' | '+' ) unary | postfix
//   postfix    := primary ( '.' NAME | '[' cond ']' | '(' args ')' )*
//   primary    := number | string | true | false | null | undefined | NAME
//               | '(' cond ')' | '[' items ']' | '{' key ':' cond, ... '}'
//
// Names resolve against the context's own keys only (no globals). Member access to
// constructor / prototype / __proto__ is refused — the sandbox has no path back to code.
// Syntax errors throw ExpressionError with a position; evaluation errors (member of undefined,
// calling a non-function, unknown name) are thrown as ExpressionError too and turned into
// `undefined` by the lenient entry points, exactly as v0.5 behaved.
//
// @internal — `@trempel/scene/internal/expr`, for the kit and the editor: no stability promise.
// Stable (re-exported by @trempel/scene): ExpressionError.

import { PIPES, type PipeFn } from './pipes.js';
import { coded, type Code } from './codes.js';
import { trempelError } from './errors.js';

// ---- errors ----------------------------------------------------------------

/**
 * A syntax or evaluation error in an expression. `pos` is a 0-based offset into `src`; `code` —
 * `E_EXPR_SYNTAX` for syntax, `E_EXPR_UNDEF` / `E_EXPR_FIELD` / `E_EXPR_FORBIDDEN` /
 * `E_EXPR_CALL` for evaluation.
 */
export class ExpressionError extends Error {
  constructor(
    readonly reason: string,
    readonly src: string,
    readonly pos: number,
    readonly code: Code = 'E_EXPR_SYNTAX',
  ) {
    super(coded(code, `${reason} (col ${pos + 1}) in "${src}"`));
    this.name = 'ExpressionError';
  }
}

// ---- tokens ----------------------------------------------------------------

type TokKind = 'num' | 'str' | 'name' | 'op' | 'end';
interface Tok {
  kind: TokKind;
  value: string;
  /** Parsed value for num/str. */
  lit?: unknown;
  pos: number;
}

// Longest first so '===' wins over '==' over '='.
const OPS = [
  '===', '!==', '==', '!=', '<=', '>=', '&&', '||', '??',
  '<', '>', '+', '-', '*', '/', '%', '!', '?', ':', '.', ',', '(', ')', '[', ']', '{', '}', '|',
];

const isNameStart = (c: string): boolean => /[A-Za-z_$]/.test(c);
const isNameChar = (c: string): boolean => /[A-Za-z0-9_$]/.test(c);
const isDigit = (c: string): boolean => c >= '0' && c <= '9';

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const start = i;

    if (isDigit(c) || (c === '.' && isDigit(src[i + 1] ?? ''))) {
      const m = /^(\d*\.?\d+|\d+\.)([eE][+-]?\d+)?/.exec(src.slice(i))!;
      i += m[0].length;
      if (isNameChar(src[i] ?? '')) {
        throw new ExpressionError(`a number runs into a name "${src[i]}"`, src, i);
      }
      toks.push({ kind: 'num', value: m[0], lit: Number(m[0]), pos: start });
      continue;
    }

    if (isNameStart(c)) {
      while (i < src.length && isNameChar(src[i])) i++;
      toks.push({ kind: 'name', value: src.slice(start, i), pos: start });
      continue;
    }

    if (c === "'" || c === '"') {
      i++;
      let out = '';
      for (;;) {
        if (i >= src.length) throw new ExpressionError('unterminated string', src, start);
        const ch = src[i];
        if (ch === c) {
          i++;
          break;
        }
        if (ch === '\\') {
          const e = src[i + 1];
          if (e === undefined) throw new ExpressionError('unterminated string', src, start);
          if (e === 'u') {
            const hex = src.slice(i + 2, i + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
              throw new ExpressionError('expected \\uXXXX', src, i);
            }
            out += String.fromCharCode(parseInt(hex, 16));
            i += 6;
          } else {
            out += ESCAPES[e] ?? e;
            i += 2;
          }
          continue;
        }
        out += ch;
        i++;
      }
      toks.push({ kind: 'str', value: src.slice(start, i), lit: out, pos: start });
      continue;
    }

    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) {
      if (c === '=') throw new ExpressionError('assignment is not supported (to compare, use "===")', src, i);
      throw new ExpressionError(`unexpected character "${c}"`, src, i);
    }
    i += op.length;
    toks.push({ kind: 'op', value: op, pos: start });
  }
  toks.push({ kind: 'end', value: '', pos: src.length });
  return toks;
}

// ---- AST -------------------------------------------------------------------

export type Node =
  | { k: 'lit'; v: unknown }
  | { k: 'name'; name: string; pos: number }
  | { k: 'member'; obj: Node; prop: Node | string; pos: number }
  | { k: 'call'; callee: Node; args: Node[]; pos: number }
  | { k: 'unary'; op: string; arg: Node }
  | { k: 'binary'; op: string; l: Node; r: Node }
  | { k: 'logical'; op: string; l: Node; r: Node }
  | { k: 'cond'; test: Node; a: Node; b: Node }
  | { k: 'array'; items: Node[] }
  | { k: 'object'; props: [string, Node][] };

export interface PipeCall {
  name: string;
  arg?: string;
}

/** A parsed expression: the AST, its pipes, and the source split at the first pipe. */
export interface CompiledExpr {
  src: string;
  /** Source of the expression part (before the first pipe), trimmed. */
  expr: string;
  ast: Node;
  pipes: PipeCall[];
}

const FORBIDDEN = new Set([
  'constructor', 'prototype', '__proto__',
  '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__',
]);

const KEYWORDS = new Map<string, unknown>([
  ['true', true],
  ['false', false],
  ['null', null],
  ['undefined', undefined],
]);

const BINARY_PREC: Record<string, number> = {
  '??': 1,
  '||': 2,
  '&&': 3,
  '==': 4, '!=': 4, '===': 4, '!==': 4,
  '<': 5, '<=': 5, '>': 5, '>=': 5,
  '+': 6, '-': 6,
  '*': 7, '/': 7, '%': 7,
};
const LOGICAL = new Set(['&&', '||', '??']);

class Parser {
  private toks: Tok[];
  private i = 0;

  constructor(private readonly src: string) {
    this.toks = tokenize(src);
  }

  private peek(): Tok {
    return this.toks[this.i];
  }
  private next(): Tok {
    return this.toks[this.i++];
  }
  private isOp(v: string): boolean {
    const t = this.peek();
    return t.kind === 'op' && t.value === v;
  }
  private fail(reason: string, t: Tok = this.peek()): never {
    throw new ExpressionError(reason, this.src, t.pos);
  }
  private describe(t: Tok): string {
    return t.kind === 'end' ? 'the end of the expression' : `"${t.value}"`;
  }
  private expect(v: string): Tok {
    if (!this.isOp(v)) this.fail(`expected "${v}", found ${this.describe(this.peek())}`);
    return this.next();
  }

  compile(): CompiledExpr {
    if (this.peek().kind === 'end') this.fail('empty expression');
    const ast = this.cond();
    const pipeStart = this.peek().pos;
    const pipes: PipeCall[] = [];
    while (this.isOp('|')) {
      this.next();
      const name = this.next();
      if (name.kind !== 'name') this.fail(`expected a pipe name after "|", found ${this.describe(name)}`, name);
      const pipe: PipeCall = { name: name.value };
      if (this.isOp(':')) {
        this.next();
        let arg = this.next();
        let sign = '';
        if (arg.kind === 'op' && arg.value === '-') {
          sign = '-';
          arg = this.next();
        }
        if (arg.kind === 'num') pipe.arg = sign + arg.value;
        else if (!sign && arg.kind === 'str') pipe.arg = String(arg.lit);
        else if (!sign && arg.kind === 'name') pipe.arg = arg.value;
        else this.fail(`the argument of the pipe "${name.value}" is a number, a string or a name, found ${this.describe(arg)}`, arg);
      }
      pipes.push(pipe);
    }
    const end = this.peek();
    if (end.kind !== 'end') this.fail(`unexpected ${this.describe(end)} — the expression has ended`, end);
    const expr = (pipes.length ? this.src.slice(0, pipeStart) : this.src).trim();
    return { src: this.src, expr, ast, pipes };
  }

  private cond(): Node {
    const test = this.binary(1);
    if (!this.isOp('?')) return test;
    this.next();
    const a = this.cond();
    this.expect(':');
    const b = this.cond();
    return { k: 'cond', test, a, b };
  }

  private binary(minPrec: number): Node {
    let left = this.unary();
    for (;;) {
      const t = this.peek();
      const prec = t.kind === 'op' ? BINARY_PREC[t.value] : undefined;
      if (prec === undefined || prec < minPrec) return left;
      this.next();
      const right = this.binary(prec + 1);
      left = LOGICAL.has(t.value)
        ? { k: 'logical', op: t.value, l: left, r: right }
        : { k: 'binary', op: t.value, l: left, r: right };
    }
  }

  private unary(): Node {
    const t = this.peek();
    if (t.kind === 'op' && (t.value === '!' || t.value === '-' || t.value === '+')) {
      this.next();
      return { k: 'unary', op: t.value, arg: this.unary() };
    }
    return this.postfix(this.primary());
  }

  private postfix(node: Node): Node {
    for (;;) {
      const t = this.peek();
      if (t.kind !== 'op') return node;
      if (t.value === '.') {
        this.next();
        const name = this.next();
        if (name.kind !== 'name') this.fail(`expected a field name after ".", found ${this.describe(name)}`, name);
        if (FORBIDDEN.has(name.value)) throw new ExpressionError(`access to "${name.value}" is forbidden`, this.src, name.pos, 'E_EXPR_FORBIDDEN');
        node = { k: 'member', obj: node, prop: name.value, pos: name.pos };
      } else if (t.value === '[') {
        this.next();
        const prop = this.cond();
        this.expect(']');
        node = { k: 'member', obj: node, prop, pos: t.pos };
      } else if (t.value === '(') {
        this.next();
        node = { k: 'call', callee: node, args: this.list(')'), pos: t.pos };
      } else {
        return node;
      }
    }
  }

  /** Comma-separated expressions up to `close` (consumed); trailing comma allowed. */
  private list(close: string): Node[] {
    const items: Node[] = [];
    while (!this.isOp(close)) {
      items.push(this.cond());
      if (!this.isOp(close)) this.expect(',');
    }
    this.next();
    return items;
  }

  private primary(): Node {
    const t = this.next();
    switch (t.kind) {
      case 'num':
      case 'str':
        return { k: 'lit', v: t.lit };
      case 'name':
        if (KEYWORDS.has(t.value)) return { k: 'lit', v: KEYWORDS.get(t.value) };
        return { k: 'name', name: t.value, pos: t.pos };
      case 'op':
        if (t.value === '(') {
          const inner = this.cond();
          this.expect(')');
          return inner;
        }
        if (t.value === '[') return { k: 'array', items: this.list(']') };
        if (t.value === '{') return this.object();
        break;
      case 'end':
        this.fail('the expression ends where a value is expected', t);
    }
    return this.fail(`unexpected ${this.describe(t)} — expected a value`, t);
  }

  private object(): Node {
    const props: [string, Node][] = [];
    while (!this.isOp('}')) {
      const key = this.next();
      let name: string;
      if (key.kind === 'name') name = key.value;
      else if (key.kind === 'str' || key.kind === 'num') name = String(key.lit);
      else this.fail(`expected an object key, found ${this.describe(key)}`, key);
      if (FORBIDDEN.has(name)) throw new ExpressionError(`the key "${name}" is forbidden`, this.src, key.pos, 'E_EXPR_FORBIDDEN');
      this.expect(':');
      props.push([name, this.cond()]);
      if (!this.isOp('}')) this.expect(',');
    }
    this.next();
    return { k: 'object', props };
  }
}

// ---- compile cache -----------------------------------------------------------

const cache = new Map<string, CompiledExpr>();

/** Parse an expression (with optional pipes). Cached by source. @throws ExpressionError */
export function compile(src: string): CompiledExpr {
  let c = cache.get(src);
  if (!c) {
    c = new Parser(src).compile();
    cache.set(src, c);
  }
  return c;
}

// ---- interpreter -------------------------------------------------------------

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/**
 * A name of the context: its own, or inherited through the context's prototype chain (a prefab
 * instance's context inherits the scene's — 2.0), never one of Object.prototype's.
 */
export function inContext(ctx: object, k: string): boolean {
  for (let o: object | null = ctx; o && o !== Object.prototype; o = Object.getPrototypeOf(o) as object | null) if (hasOwn(o, k)) return true;
  return false;
}

function member(obj: unknown, prop: unknown, src: string, pos: number): unknown {
  if (obj === null || obj === undefined) {
    throw new ExpressionError(`reading the field "${String(prop)}" of ${String(obj)}`, src, pos, 'E_EXPR_FIELD');
  }
  const key = typeof prop === 'symbol' ? prop : String(prop);
  if (typeof key === 'string' && FORBIDDEN.has(key)) {
    throw new ExpressionError(`access to "${key}" is forbidden`, src, pos, 'E_EXPR_FORBIDDEN');
  }
  return (obj as Record<string | symbol, unknown>)[key];
}

function binaryOp(op: string, l: unknown, r: unknown): unknown {
  const a = l as number;
  const b = r as number;
  switch (op) {
    case '+': return (l as string) + (r as string);
    case '-': return a - b;
    case '*': return a * b;
    case '/': return a / b;
    case '%': return a % b;
    case '<': return a < b;
    case '<=': return a <= b;
    case '>': return a > b;
    case '>=': return a >= b;
    case '==': return l == r;
    case '!=': return l != r;
    case '===': return l === r;
    case '!==': return l !== r;
  }
  throw new Error(`unknown operator ${op}`);
}

function evalNode(n: Node, ctx: Record<string, unknown>, src: string): unknown {
  switch (n.k) {
    case 'lit':
      return n.v;
    case 'name':
      if (!inContext(ctx, n.name)) throw new ExpressionError(`the name "${n.name}" is not defined in the context`, src, n.pos, 'E_EXPR_UNDEF');
      return ctx[n.name];
    case 'member':
      return member(
        evalNode(n.obj, ctx, src),
        typeof n.prop === 'string' ? n.prop : evalNode(n.prop, ctx, src),
        src,
        n.pos,
      );
    case 'call': {
      let self: unknown;
      let fn: unknown;
      if (n.callee.k === 'member') {
        self = evalNode(n.callee.obj, ctx, src);
        const prop = typeof n.callee.prop === 'string' ? n.callee.prop : evalNode(n.callee.prop, ctx, src);
        fn = member(self, prop, src, n.callee.pos);
      } else {
        fn = evalNode(n.callee, ctx, src);
      }
      if (typeof fn !== 'function') throw new ExpressionError('calling something that is not a function', src, n.pos, 'E_EXPR_CALL');
      const args = n.args.map((a) => evalNode(a, ctx, src));
      return Reflect.apply(fn as (...a: unknown[]) => unknown, self, args);
    }
    case 'unary': {
      const v = evalNode(n.arg, ctx, src);
      return n.op === '!' ? !v : n.op === '-' ? -(v as number) : +(v as number);
    }
    case 'binary':
      return binaryOp(n.op, evalNode(n.l, ctx, src), evalNode(n.r, ctx, src));
    case 'logical': {
      const l = evalNode(n.l, ctx, src);
      if (n.op === '&&') return l ? evalNode(n.r, ctx, src) : l;
      if (n.op === '||') return l ? l : evalNode(n.r, ctx, src);
      return l ?? evalNode(n.r, ctx, src);
    }
    case 'cond':
      return evalNode(n.test, ctx, src) ? evalNode(n.a, ctx, src) : evalNode(n.b, ctx, src);
    case 'array':
      return n.items.map((x) => evalNode(x, ctx, src));
    case 'object': {
      const o: Record<string, unknown> = {};
      for (const [k, v] of n.props) o[k] = evalNode(v, ctx, src);
      return o;
    }
  }
}

/** Run a compiled expression's AST (pipes NOT applied). @throws ExpressionError */
export function run(c: CompiledExpr, ctx: Record<string, unknown>): unknown {
  return evalNode(c.ast, ctx, c.src);
}

/** Apply a compiled expression's pipes to a value. @throws on an unknown pipe. */
export function applyPipes(value: unknown, pipes: PipeCall[], registry: Record<string, PipeFn> = PIPES): unknown {
  return pipes.reduce((acc, p) => {
    const fn = hasOwn(registry, p.name) ? registry[p.name] : undefined;
    if (!fn) throw trempelError('E_PIPE_UNKNOWN', `unknown pipe "${p.name}"`);
    return fn(acc, p.arg);
  }, value);
}

/** Names of pipes a compiled expression uses that the registry does not know. */
export function unknownPipes(c: CompiledExpr, registry: Record<string, PipeFn> = PIPES): string[] {
  return c.pipes.filter((p) => !hasOwn(registry, p.name)).map((p) => p.name);
}

/**
 * Evaluate an expression (pipes included) against a context, leniently: a syntax or evaluation
 * error yields `undefined` (the v0.5 contract of evalExpression). Unknown pipes still throw.
 */
export function evalExpression(src: string, context: Record<string, unknown>): unknown {
  let c: CompiledExpr;
  let value: unknown;
  try {
    c = compile(src);
    value = run(c, context);
  } catch {
    return undefined;
  }
  return c.pipes.length ? applyPipes(value, c.pipes) : value;
}
