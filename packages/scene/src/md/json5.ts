// json5.ts — a JSON5 object as an attribute value (`$key: {a: 1, b: 'x'}`). Strict: a value shaped
// `{…}` must parse, or the document does not. Recursive descent over the JSON5 grammar: comments,
// trailing commas, single quotes, bare keys, hex / Infinity / NaN / leading-dot numbers, line
// continuations in strings.

import type { Json5Object, Json5Value } from './types.js';

export class Json5Error extends SyntaxError {
  constructor(message: string, readonly line: number, readonly column: number) {
    super(`${message} at ${line}:${column}`);
    this.name = 'Json5Error';
  }
}

const ID_START = /[$_\p{ID_Start}]/u;
const ID_CONT = /[$_\u200C\u200D\p{ID_Continue}]/u;
const SPACE = /[\t\n\v\f\r \u00A0\u2028\u2029\uFEFF\p{Zs}]/u;
const ESC: Record<string, string> = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '0': '\0' };

/** Parse JSON5 text (any value). @throws Json5Error */
export function parseJson5(text: string): Json5Value {
  let i = 0;
  const fail = (msg: string): never => {
    const before = text.slice(0, i).split('\n');
    throw new Json5Error(msg, before.length, before[before.length - 1].length + 1);
  };
  const skip = (): void => {
    for (;;) {
      const c = text[i];
      if (c !== undefined && SPACE.test(c)) i++;
      else if (c === '/' && text[i + 1] === '/') {
        while (i < text.length && text[i] !== '\n' && text[i] !== '\r' && text[i] !== '\u2028' && text[i] !== '\u2029') i++;
      } else if (c === '/' && text[i + 1] === '*') {
        const end = text.indexOf('*/', i + 2);
        if (end < 0) fail('unterminated comment');
        i = end + 2;
      } else return;
    }
  };
  const unexpected = (): never => fail(i >= text.length ? 'unexpected end of input' : `unexpected «${text[i]}»`);

  const string = (): string => {
    const q = text[i++];
    let out = '';
    for (;;) {
      const c = text[i++];
      if (c === undefined) return fail('unterminated string');
      if (c === q) return out;
      if (c === '\n' || c === '\r') return fail('line break in a string');
      if (c !== '\\') {
        out += c;
        continue;
      }
      const e = text[i++];
      if (e === undefined) return fail('unterminated string');
      if (e in ESC && !(e === '0' && /[0-9]/.test(text[i] ?? ''))) out += ESC[e];
      else if (e === 'x' || e === 'u') {
        const n = e === 'x' ? 2 : 4;
        const hex = text.slice(i, i + n);
        if (!new RegExp(`^[0-9a-fA-F]{${n}}$`).test(hex)) fail('bad escape');
        out += String.fromCharCode(parseInt(hex, 16));
        i += n;
      } else if (e === '\r') {
        if (text[i] === '\n') i++;
      } else if (e === '\n' || e === '\u2028' || e === '\u2029') {
        // line continuation
      } else if (/[1-9]/.test(e)) fail('bad escape');
      else out += e;
    }
  };

  const identifier = (): string => {
    let out = '';
    const char = (first: boolean): string | null => {
      let c = text[i];
      if (c === '\\') {
        if (text[i + 1] !== 'u' || !/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) fail('bad escape in a key');
        c = String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16));
        if (!(first ? ID_START : ID_CONT).test(c)) fail('bad key');
        i += 6;
        return c;
      }
      if (c === undefined || !(first ? ID_START : ID_CONT).test(c)) return null;
      i++;
      return c;
    };
    const f = char(true);
    if (f === null) unexpected();
    out += f;
    for (let c = char(false); c !== null; c = char(false)) out += c;
    return out;
  };

  const number = (): number => {
    const m = /^[+-]?(?:Infinity|NaN|0[xX][0-9a-fA-F]+|(?:(?:0|[1-9][0-9]*)(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(i));
    if (!m) return unexpected();
    i += m[0].length;
    const s = m[0];
    const sign = s[0] === '-' ? -1 : 1;
    const body = s.replace(/^[+-]/, '');
    if (body === 'Infinity') return sign * Infinity;
    if (body === 'NaN') return NaN;
    if (/^0[xX]/.test(body)) return sign * parseInt(body.slice(2), 16);
    return sign * Number(body);
  };

  const value = (): Json5Value => {
    skip();
    const c = text[i];
    if (c === '{') {
      i++;
      const obj: Json5Object = {};
      for (;;) {
        skip();
        if (text[i] === '}') {
          i++;
          return obj;
        }
        const key = text[i] === '"' || text[i] === "'" ? string() : identifier();
        skip();
        if (text[i] !== ':') unexpected();
        i++;
        obj[key] = value();
        skip();
        if (text[i] === ',') i++;
        else if (text[i] !== '}') unexpected();
      }
    }
    if (c === '[') {
      i++;
      const arr: Json5Value[] = [];
      for (;;) {
        skip();
        if (text[i] === ']') {
          i++;
          return arr;
        }
        arr.push(value());
        skip();
        if (text[i] === ',') i++;
        else if (text[i] !== ']') unexpected();
      }
    }
    if (c === '"' || c === "'") return string();
    for (const [word, v] of [['null', null], ['true', true], ['false', false]] as const) {
      if (text.startsWith(word, i) && !ID_CONT.test(text[i + word.length] ?? '')) {
        i += word.length;
        return v;
      }
    }
    return number();
  };

  const out = value();
  skip();
  if (i < text.length) unexpected();
  return out;
}
