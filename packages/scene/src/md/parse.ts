// parse.ts — md clips as structured data. A Markdown document where `# $name id` headings open
// blocks (nested by level), `$key: value` lines are the block's attributes, and every other line
// is its body (tables live there; md/table is not parsed here). `# $` alone closes every open
// block. What the blocks mean is anim/compile.ts.
//
// Values: `"…"` — a string as written; `$[a, b]` — a list; `{…}` — a JSON5 object (strict);
// `null` / `true` / `false` / numbers (`007`, `+1` stay strings); text with `${…}` is kept raw
// (InterpolatedValue). Escapes `\$ \@ \[ \{ \\` (and `\,` in a list) unfold in values and bodies.

import { parseJson5 } from './json5.js';
import type { Attribute, AttributeValue, Block, BodyValue, Document, InterpolatedValue, Json5Object, ListItem, Scalar } from './types.js';

export class MdParseError extends Error {
  constructor(message: string, readonly line: number) {
    super(message);
    this.name = 'MdParseError';
  }
}

const NAME = '[A-Za-z_][A-Za-z0-9_.-]*';
const HEADER = new RegExp(`^(#{1,6}) \\$(${NAME})(?: (.*))?$`);
const CLOSE = /^#{1,6} \$@?$/;
const ATTR = new RegExp(`^\\$(${NAME}):( ?)(.*)$`);

/** Parse an md document into blocks. @throws MdParseError (a malformed JSON5 or list value) */
export function parse(text: string): Document {
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r\n?/g, '\n').split('\n');
  const root: Block = { name: '', level: 0, attrs: [], children: [] };
  const stack: Block[] = [root];
  const top = (): Block => stack[stack.length - 1];
  const raw = new Map<Block, string>();
  let body: string[] = [];

  const flush = (b: Block): void => {
    let s = 0;
    let e = body.length;
    while (s < e && body[s] === '') s++;
    while (e > s && body[e - 1] === '') e--;
    if (s < e) {
      const frag = body.slice(s, e).join('\n');
      const prev = raw.get(b);
      const full = prev === undefined ? frag : `${prev}\n\n${frag}`;
      raw.set(b, full);
      b.body = bodyValue(full);
    }
    body = [];
  };

  lines.forEach((line, li) => {
    if (CLOSE.test(line)) {
      // `## $` — back to the top level
      flush(top());
      stack.length = 1;
      return;
    }
    const h = HEADER.exec(line);
    if (h) {
      const level = h[1].length;
      flush(top());
      while (stack.length > 1 && top().level >= level) stack.pop();
      const block: Block = { name: h[2], level, attrs: [], children: [] };
      const tail = h[3]?.trim();
      if (tail) block.id = isQuoted(tail) ? unquote(tail.slice(1, -1)) : tail;
      top().children.push(block);
      stack.push(block);
      return;
    }
    const a = ATTR.exec(line);
    if (a) {
      const attr: Attribute = { key: [a[1]], value: attrValue(a[3], li + 1, a[1]) };
      top().attrs.push(attr);
      return;
    }
    body.push(line);
  });
  while (stack.length) flush(stack.pop()!);
  return { root };
}

// ---- values ----------------------------------------------------------------------------------

/** One `"…"` and nothing else (escapes honoured). */
function isQuoted(s: string): boolean {
  if (s.length < 2 || s[0] !== '"') return false;
  for (let i = 1; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) i++;
    else if (s[i] === '"') return i === s.length - 1;
  }
  return false;
}

/** Inside quotes: `\" \\ \n \t`; anything else stays as written. */
function unquote(s: string): string {
  return s.replace(/\\(.)/g, (m, c: string) => (c === '"' ? '"' : c === '\\' ? '\\' : c === 'n' ? '\n' : c === 't' ? '\t' : m));
}

/** Unfold `\$ \@ \[ \{ \\` (and `\,` in a list item, `\${` → `${`); other `\x` stay. */
function unescape(s: string, list = false): string {
  return s.replace(/\\(\$\{|.)/g, (m, c: string) => (c === '${' || '$@[{\\'.includes(c) || (list && c === ',') ? c : m));
}

function coerce(s: string): Scalar {
  if (s === '') return '';
  if (isQuoted(s)) return unquote(s.slice(1, -1));
  if (s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?(?:0|[1-9][0-9]*)$/.test(s) || /^-?(?:0|[1-9][0-9]*|)\.[0-9]*$|^-?(?:0|[1-9][0-9]*)\.$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n) && /[0-9]/.test(s)) return n;
  }
  return s;
}

/** Index of the `}` closing a `${` whose body starts at `from`, or -1. */
function closing(s: string, from: number): number {
  let depth = 1;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') i++;
    else if (c === '"') {
      for (i++; i < s.length && s[i] !== '"'; i++) if (s[i] === '\\') i++;
    } else if (c === '$' && s[i + 1] === '{') {
      depth++;
      i++;
    } else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

/** `${…}` spans of a text and whether it has the `\${` opt-out: such text is kept raw. */
function interpolated(s: string): InterpolatedValue | null {
  const placeholders: InterpolatedValue['placeholders'] = [];
  let optOut = false;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') {
      if (s[i + 1] === '$' && s[i + 2] === '{') optOut = true;
      i++;
    } else if (s[i] === '$' && s[i + 1] === '{') {
      const end = closing(s, i + 2);
      if (end < 0) continue;
      placeholders.push({ raw: s.slice(i + 2, end), start: i, end: end + 1 });
      i = end;
    }
  }
  return placeholders.length || optOut ? { raw: s, placeholders } : null;
}

/** Split a list body on top-level commas (quotes, escapes, `${…}` respected); a nested list is an error. */
function listItems(s: string, line: number, key: string): string[] {
  const out: string[] = [];
  let buf = '';
  let depth = 0;
  let openAt = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) {
      buf += c + s[++i];
    } else if (c === '"') {
      let j = i + 1;
      for (; j < s.length && s[j] !== '"'; j++) if (s[j] === '\\') j++;
      buf += s.slice(i, j + 1);
      i = j;
    } else if (c === '$' && s[i + 1] === '{' && closing(s, i + 2) >= 0) {
      const end = closing(s, i + 2);
      buf += s.slice(i, end + 1);
      i = end;
    } else if (c === '[' && s.indexOf(']', i) > i) {
      if (depth++ === 0) openAt = i;
      buf += c;
    } else if (c === ']' && depth > 0) {
      depth--;
      buf += c;
    } else if (c === ',') {
      if (depth > 0) throw new MdParseError(`$${key} (строка ${line}, позиция ${openAt + 3}): вложенный список в $[…] не поддерживается`, line);
      out.push(buf);
      buf = '';
    } else buf += c;
  }
  out.push(buf);
  return out;
}

function listItem(raw: string): ListItem {
  const t = raw.replace(/^[ \t]+|[ \t]+$/g, '');
  if (isQuoted(t)) return coerce(t);
  return interpolated(t) ?? coerce(unescape(t, true));
}

function attrValue(raw: string, line: number, key: string): AttributeValue {
  const v = raw.replace(/[ \t\r]+$/, '');
  if (v.startsWith('$[') && v.endsWith(']')) {
    const inner = v.slice(2, -1);
    return inner.trim() === '' ? [] : listItems(inner, line, key).map(listItem);
  }
  if (isQuoted(v)) return coerce(v);
  const ip = interpolated(v);
  if (ip) return ip;
  const t = v.trim();
  if (t.length >= 2 && t[0] === '{' && t[t.length - 1] === '}') {
    let obj: unknown;
    try {
      obj = parseJson5(t);
    } catch (e) {
      throw new MdParseError(`$${key} (строка ${line}): ${(e as Error).message}`, line);
    }
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) throw new MdParseError(`$${key} (строка ${line}): ожидается объект`, line);
    return obj as Json5Object;
  }
  return coerce(unescape(v));
}

function bodyValue(raw: string): BodyValue {
  return interpolated(raw) ?? unescape(raw);
}
