// plist.ts — a minimal XML property list reader (Cocos / Particle Designer particle files): dict,
// array, key, string, real, integer, true, false, data (base64 → bytes), date (kept as a string).
// No DTD processing: a <!DOCTYPE> is skipped, entities are the five XML ones and numeric references.
// A malformed file — E_FX_IMPORT_COCOS with the offset.

export type PlistValue = string | number | boolean | Uint8Array | PlistValue[] | PlistDict;
export interface PlistDict {
  [key: string]: PlistValue;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

/** Parse an XML plist; `where` — the file name for messages. */
export function parsePlist(xml: string, where = 'plist'): PlistValue {
  let at = 0;
  const fail = (msg: string): never => {
    throw new Error(`E_FX_IMPORT_COCOS: ${where}: ${msg} (at ${at})`);
  };
  // A tag: <name …>, </name>, <name/>; skips the prolog, comments, a doctype.
  const skip = () => {
    for (;;) {
      while (at < xml.length && /\s/.test(xml[at])) at++;
      if (xml.startsWith('<?', at)) {
        const e = xml.indexOf('?>', at);
        if (e < 0) fail('unterminated <?');
        at = e + 2;
      } else if (xml.startsWith('<!--', at)) {
        const e = xml.indexOf('-->', at);
        if (e < 0) fail('unterminated comment');
        at = e + 3;
      } else if (xml.startsWith('<!DOCTYPE', at)) {
        const e = xml.indexOf('>', at);
        if (e < 0) fail('unterminated <!DOCTYPE');
        at = e + 1;
      } else return;
    }
  };
  const tag = (): { name: string; close: boolean; empty: boolean } => {
    skip();
    if (xml[at] !== '<') fail(`expected a tag, got ${JSON.stringify(xml.slice(at, at + 12))}`);
    const e = xml.indexOf('>', at);
    if (e < 0) fail('unterminated tag');
    const body = xml.slice(at + 1, e).trim();
    at = e + 1;
    const close = body.startsWith('/');
    const empty = body.endsWith('/');
    const name = body.replace(/^\//, '').replace(/\/$/, '').trim().split(/\s+/)[0];
    if (!name) fail('an empty tag');
    return { name, close, empty };
  };
  const text = (name: string): string => {
    const e = xml.indexOf(`</${name}`, at);
    if (e < 0) fail(`no </${name}>`);
    const raw = xml.slice(at, e);
    if (raw.includes('<') && !raw.includes('<![CDATA[')) fail(`markup inside <${name}>`);
    at = e;
    const t = tag();
    if (t.name !== name) fail(`</${name}> expected`);
    return raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  };
  const value = (t: { name: string; close: boolean; empty: boolean }): PlistValue => {
    if (t.close) fail(`unexpected </${t.name}>`);
    switch (t.name) {
      case 'dict': {
        const d: PlistDict = {};
        if (t.empty) return d;
        for (;;) {
          const k = tag();
          if (k.close && k.name === 'dict') return d;
          if (k.name !== 'key' || k.close) fail(`<key> expected in <dict>, got <${k.close ? '/' : ''}${k.name}>`);
          const key = k.empty ? '' : unescapeXml(text('key'));
          const v = tag();
          if (v.close) fail(`a value expected for key "${key}"`);
          d[key] = value(v);
        }
      }
      case 'array': {
        const a: PlistValue[] = [];
        if (t.empty) return a;
        for (;;) {
          const v = tag();
          if (v.close && v.name === 'array') return a;
          a.push(value(v));
        }
      }
      case 'string':
      case 'date':
        return t.empty ? '' : unescapeXml(text(t.name));
      case 'real':
      case 'integer': {
        const s = t.empty ? '' : text(t.name).trim();
        const n = Number(s);
        if (!s || !Number.isFinite(n)) {
          if (/^[+-]?(inf|infinity)$/i.test(s)) return s[0] === '-' ? -Infinity : Infinity;
          if (/^nan$/i.test(s)) return NaN;
          fail(`<${t.name}> is not a number: ${JSON.stringify(s)}`);
        }
        return n;
      }
      case 'true':
      case 'false':
        if (!t.empty) {
          const c = tag();
          if (!c.close || c.name !== t.name) fail(`</${t.name}> expected`);
        }
        return t.name === 'true';
      case 'data': {
        const s = t.empty ? '' : text('data').replace(/\s+/g, '');
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) fail('<data> is not base64');
        return new Uint8Array(Buffer.from(s, 'base64'));
      }
      default:
        return fail(`unknown element <${t.name}>`);
    }
  };
  const root = tag();
  if (root.name === 'plist' && !root.close) {
    if (root.empty) fail('an empty <plist>');
    const v = value(tag());
    const end = tag();
    if (!end.close || end.name !== 'plist') fail('</plist> expected');
    skip();
    if (at < xml.length) fail('content after </plist>');
    return v;
  }
  const v = value(root);
  skip();
  if (at < xml.length) fail('content after the root value');
  return v;
}
