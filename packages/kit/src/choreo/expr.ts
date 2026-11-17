// expr.ts — the formula language of choreography cells. No eval (CSP of Playables): a small parser
// to a closure tree, cached per source. Numbers, names (vars → constants), `a.b` members, `a[i]` index,
// `[1, 2]` lists, 'strings', + - * / %, comparisons, `and` `or` `not` (not `&&`/`||`: a `|` would
// split a markdown table cell), `c ? a : b`, functions max min floor ceil round abs len sum.
// Unknown names throw with the list of known ones — a typo in a table must not become 0.

export type Value = number | string | boolean | Value[] | { [k: string]: Value } | undefined;
export type Scope = (name: string) => Value;
type Node = (s: Scope) => Value;

const FUNCS: Record<string, (...a: Value[]) => Value> = {
  max: (...a) => Math.max(...nums(a)),
  min: (...a) => Math.min(...nums(a)),
  floor: (a) => Math.floor(num(a)),
  ceil: (a) => Math.ceil(num(a)),
  round: (a) => Math.round(num(a)),
  abs: (a) => Math.abs(num(a)),
  len: (a) => (Array.isArray(a) ? a.length : typeof a === 'string' ? a.length : 0),
  sum: (a) => (Array.isArray(a) ? nums(a).reduce((x, y) => x + y, 0) : num(a)),
  /** pick(obj, keys) → [obj[k] for k in keys] — e.g. the start times of the chosen items. */
  pick: (o, keys) => {
    if (!o || typeof o !== 'object' || Array.isArray(o) || !Array.isArray(keys)) throw new Error('E_CHOREO_EXPR: pick(object, list)');
    return keys.map((k) => {
      const v = (o as Record<string, Value>)[String(k)];
      if (v === undefined) throw new Error(`E_CHOREO_EXPR: pick: no key "${String(k)}" (known: ${Object.keys(o).join(', ')})`);
      return v;
    });
  },
  /** field(list, 'name') → [item.name for item in list]. */
  field: (l, name) => {
    if (!Array.isArray(l)) throw new Error('E_CHOREO_EXPR: field(list, name)');
    return l.map((it) => {
      if (!it || typeof it !== 'object' || Array.isArray(it) || !(String(name) in it)) throw new Error(`E_CHOREO_EXPR: field: no "${String(name)}" in ${JSON.stringify(it)}`);
      return (it as Record<string, Value>)[String(name)];
    });
  },
  /** has(list, v) — membership. */
  has: (l, v) => Array.isArray(l) && l.includes(v),
};

function num(v: Value): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  throw new Error(`E_CHOREO_EXPR: ${JSON.stringify(v)} is not a number`);
}
function nums(a: Value[]): number[] {
  return a.flatMap((v) => (Array.isArray(v) ? nums(v) : [num(v)]));
}
const truthy = (v: Value): boolean => !!v && !(Array.isArray(v) && v.length === 0);

type Tok = { k: 'num'; v: number } | { k: 'str'; v: string } | { k: 'id'; v: string } | { k: 'op'; v: string };

const OPS = ['<=', '>=', '==', '!=', '+', '-', '*', '/', '%', '(', ')', '[', ']', '{', '}', ',', '?', ':', '<', '>', '.'];
const WORDS = new Set(['and', 'or', 'not', 'true', 'false']);

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t') {
      i++;
      continue;
    }
    if ((c >= '0' && c <= '9') || (c === '.' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
      let j = i;
      while (j < src.length && ((src[j] >= '0' && src[j] <= '9') || src[j] === '.')) j++;
      if (src[j] === 'e' && (src[j + 1] === '-' || src[j + 1] === '+' || (src[j + 1] >= '0' && src[j + 1] <= '9'))) {
        j += 2;
        while (j < src.length && src[j] >= '0' && src[j] <= '9') j++;
      }
      out.push({ k: 'num', v: Number(src.slice(i, j)) });
      i = j;
      continue;
    }
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      if (j < 0) throw new Error(`E_CHOREO_EXPR: unterminated string in "${src}"`);
      out.push({ k: 'str', v: src.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_$@]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_$\u0400-\u04FF]/.test(src[j])) j++;
      out.push({ k: WORDS.has(src.slice(i, j)) ? 'op' : 'id', v: src.slice(i, j) });
      i = j;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new Error(`E_CHOREO_EXPR: unexpected "${c}" in "${src}"`);
    out.push({ k: 'op', v: op });
    i += op.length;
  }
  return out;
}

function parse(src: string): Node {
  const toks = lex(src);
  let p = 0;
  const peek = (v?: string) => (p < toks.length && (v === undefined || (toks[p].k === 'op' && toks[p].v === v)) ? toks[p] : null);
  const eat = (v: string) => {
    if (!peek(v)) throw new Error(`E_CHOREO_EXPR: expected "${v}" at token ${p} in "${src}"`);
    p++;
  };

  const ternary = (): Node => {
    const c = or();
    if (!peek('?')) return c;
    p++;
    const a = ternary();
    eat(':');
    const b = ternary();
    return (s) => (truthy(c(s)) ? a(s) : b(s));
  };
  const or = (): Node => {
    let l = and();
    while (peek('or')) {
      p++;
      const a = l;
      const b = and();
      l = (s) => truthy(a(s)) || truthy(b(s));
    }
    return l;
  };
  const and = (): Node => {
    let l = cmp();
    while (peek('and')) {
      p++;
      const a = l;
      const b = cmp();
      l = (s) => truthy(a(s)) && truthy(b(s));
    }
    return l;
  };
  const cmp = (): Node => {
    const l = add();
    for (const op of ['<=', '>=', '==', '!=', '<', '>']) {
      if (!peek(op)) continue;
      p++;
      const r = add();
      switch (op) {
        case '<=':
          return (s) => num(l(s)) <= num(r(s));
        case '>=':
          return (s) => num(l(s)) >= num(r(s));
        case '<':
          return (s) => num(l(s)) < num(r(s));
        case '>':
          return (s) => num(l(s)) > num(r(s));
        case '==':
          return (s) => l(s) === r(s);
        default:
          return (s) => l(s) !== r(s);
      }
    }
    return l;
  };
  const add = (): Node => {
    let l = mul();
    for (;;) {
      if (peek('+')) {
        p++;
        const a = l;
        const b = mul();
        l = (s) => num(a(s)) + num(b(s));
      } else if (peek('-')) {
        p++;
        const a = l;
        const b = mul();
        l = (s) => num(a(s)) - num(b(s));
      } else return l;
    }
  };
  const mul = (): Node => {
    let l = unary();
    for (;;) {
      const op = peek('*') ? '*' : peek('/') ? '/' : peek('%') ? '%' : null;
      if (!op) return l;
      p++;
      const a = l;
      const b = unary();
      l = op === '*' ? (s) => num(a(s)) * num(b(s)) : op === '/' ? (s) => num(a(s)) / num(b(s)) : (s) => num(a(s)) % num(b(s));
    }
  };
  const unary = (): Node => {
    if (peek('-')) {
      p++;
      const a = unary();
      return (s) => -num(a(s));
    }
    if (peek('not')) {
      p++;
      const a = unary();
      return (s) => !truthy(a(s));
    }
    return postfix();
  };
  const postfix = (): Node => {
    let n = primary();
    for (;;) {
      if (peek('[')) {
        p++;
        const ix = ternary();
        eat(']');
        const o = n;
        n = (s) => {
          const a = o(s);
          const i = ix(s);
          if (Array.isArray(a)) {
            const v = a[num(i)];
            if (v === undefined) throw new Error(`E_CHOREO_EXPR: index ${String(i)} out of range in "${src}"`);
            return v;
          }
          if (a && typeof a === 'object') return member(a, String(i));
          throw new Error(`E_CHOREO_EXPR: cannot index ${JSON.stringify(a)} in "${src}"`);
        };
      } else if (peek('.')) {
        p++;
        const t = toks[p++];
        if (!t || (t.k !== 'id' && t.k !== 'num')) throw new Error(`E_CHOREO_EXPR: member name expected in "${src}"`);
        const o = n;
        const key = String(t.v);
        n = (s) => member(o(s), key);
      } else return n;
    }
  };
  const member = (o: Value, key: string): Value => {
    if (o && typeof o === 'object' && !Array.isArray(o) && key in o) return (o as Record<string, Value>)[key];
    throw new Error(`E_CHOREO_EXPR: no member "${key}" in ${JSON.stringify(o)} ("${src}")`);
  };
  const primary = (): Node => {
    const t = toks[p++];
    if (!t) throw new Error(`E_CHOREO_EXPR: unexpected end of "${src}"`);
    if (t.k === 'num') return () => t.v;
    if (t.k === 'str') return () => t.v;
    if (t.k === 'op' && t.v === 'true') return () => true;
    if (t.k === 'op' && t.v === 'false') return () => false;
    if (t.k === 'op' && t.v === '(') {
      const e = ternary();
      eat(')');
      return e;
    }
    if (t.k === 'op' && t.v === '{') {
      const entries: [string, Node][] = [];
      while (!peek('}')) {
        const k = toks[p++];
        if (!k || (k.k !== 'id' && k.k !== 'str' && k.k !== 'num')) throw new Error(`E_CHOREO_EXPR: object key expected in "${src}"`);
        eat(':');
        entries.push([String(k.v), ternary()]);
        if (!peek('}')) eat(',');
      }
      p++;
      return (s) => Object.fromEntries(entries.map(([k, n]) => [k, n(s)]));
    }
    if (t.k === 'op' && t.v === '[') {
      const items: Node[] = [];
      while (!peek(']')) {
        items.push(ternary());
        if (!peek(']')) eat(',');
      }
      p++;
      return (s) => items.map((i) => i(s));
    }
    if (t.k === 'id') {
      if (peek('(')) {
        const f = FUNCS[t.v];
        if (!f) throw new Error(`E_CHOREO_EXPR: unknown function "${t.v}" (known: ${Object.keys(FUNCS).join(', ')})`);
        p++;
        const args: Node[] = [];
        while (!peek(')')) {
          args.push(ternary());
          if (!peek(')')) eat(',');
        }
        p++;
        return (s) => f(...args.map((a) => a(s)));
      }
      let name = t.v;
      // Row references: `@id` — start of row `id`, `@id.end` — its end (director scope).
      if (name.startsWith('@') && peek('.') && toks[p + 1]?.k === 'id' && (toks[p + 1].v === 'end' || toks[p + 1].v === 'start')) {
        name = `${name}.${toks[p + 1].v}`;
        p += 2;
      }
      return (s) => s(name);
    }
    throw new Error(`E_CHOREO_EXPR: unexpected "${t.v}" in "${src}"`);
  };

  const root = ternary();
  if (p !== toks.length) throw new Error(`E_CHOREO_EXPR: trailing tokens in "${src}"`);
  return root;
}

const cache = new Map<string, Node>();

export function compile(src: string): Node {
  let n = cache.get(src);
  if (!n) {
    n = parse(src);
    cache.set(src, n);
  }
  return n;
}

export function evaluate(src: string, scope: Scope): Value {
  return compile(src)(scope);
}

export function evalNum(src: string, scope: Scope): number {
  return num(evaluate(src, scope));
}

/** Scope over plain objects, first hit wins; unknown names throw with what is known. */
export function scopeOf(...layers: Record<string, Value>[]): Scope {
  return (name) => {
    for (const l of layers) if (name in l) return l[name];
    const known = [...new Set(layers.flatMap((l) => Object.keys(l)))].sort();
    throw new Error(`E_CHOREO_EXPR: unknown name "${name}" (known: ${known.join(', ')})`);
  };
}
