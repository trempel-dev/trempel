// yaml.ts — the subset of YAML Unity writes for its assets (.prefab, .unity, .mat, .meta): a stream
// of documents `--- !u!<classId> &<fileID> [stripped]`, each one mapping `<Type>: { … }`; block
// mappings and sequences (Unity puts `- ` at the parent key's indent), flow mappings / sequences
// (`{fileID: 0, guid: …, type: 3}`, `[]`), plain and quoted scalars that may run over several lines.
//
// Every scalar stays a STRING: fileIDs are 64-bit (beyond a double's 53 bits) and the converter
// decides what is a number (num()). No anchors / aliases / tags inside a document — Unity writes none.

export type YamlValue = string | YamlValue[] | { [key: string]: YamlValue };
export type YamlMap = { [key: string]: YamlValue };

export interface UnityDoc {
  /** The class id of `!u!<n>` (1 GameObject, 4 Transform, 114 MonoBehaviour, 198 ParticleSystem…). */
  classId: number;
  /** `&<fileID>` — the object's id inside its file (a decimal string, 64-bit). */
  fileID: string;
  /** `stripped`: a placeholder of an object of a prefab instance. */
  stripped: boolean;
  /** The type name (the document's only key): 'GameObject', 'ParticleSystem'… */
  type: string;
  body: YamlMap;
}

interface Line {
  indent: number;
  text: string;
  no: number;
}

const HEADER = /^--- !u!(\d+) &(-?\d+)( stripped)?/;

/** Lists made of a repeated key (see BlockParser.map). */
const DUPS = new WeakSet<YamlValue[]>();
/** A list made of a repeated key `k: a` `k: b` (old Unity serialization). */
export const isRepeated = (v: YamlValue | undefined): boolean => Array.isArray(v) && DUPS.has(v);

/** Parse a whole Unity YAML file into its documents. */
export function parseUnityYaml(src: string): UnityDoc[] {
  const docs: UnityDoc[] = [];
  const lines = src.split(/\r?\n/);
  let cur: { classId: number; fileID: string; stripped: boolean; start: number } | null = null;
  const flush = (end: number) => {
    if (!cur) return;
    const body = parseBlockLines(lines.slice(cur.start, end), cur.start + 1);
    const type = Object.keys(body)[0] ?? '';
    const inner = body[type];
    docs.push({ classId: cur.classId, fileID: cur.fileID, stripped: cur.stripped, type, body: inner && typeof inner === 'object' && !Array.isArray(inner) ? inner : {} });
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.startsWith('---')) continue;
    flush(i);
    const m = HEADER.exec(l);
    cur = m ? { classId: Number(m[1]), fileID: m[2], stripped: !!m[3], start: i + 1 } : null;
  }
  flush(lines.length);
  return docs;
}

/** Parse plain YAML (one document, no `---`): a .meta file, a fragment in tests. */
export function parseYaml(src: string): YamlMap {
  return parseBlockLines(src.split(/\r?\n/), 1);
}

function parseBlockLines(raw: string[], firstNo: number): YamlMap {
  const lines: Line[] = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i];
    if (!t.trim() || t.trimStart().startsWith('#') || t.startsWith('%')) continue;
    const indent = t.length - t.trimStart().length;
    lines.push({ indent, text: t.slice(indent), no: firstNo + i });
  }
  const p = new BlockParser(lines);
  const v = p.block(0);
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

/** `key: rest` — a key of a block mapping (keys are plain: no `: ` inside them, not starting with a quote / `{` / `[`). */
function splitKey(text: string): { key: string; rest: string } | null {
  if (text.startsWith('- ') || text === '-' || /^["'{[]/.test(text)) return null;
  const i = text.search(/:(\s|$)/);
  if (i <= 0) return null;
  return { key: text.slice(0, i), rest: text.slice(i + 1).trim() };
}

class BlockParser {
  private i = 0;
  constructor(private readonly lines: Line[]) {}

  /** The block (mapping or sequence) whose first line is at the current position with indent ≥ `min`. */
  block(min: number): YamlValue {
    const l = this.lines[this.i];
    if (!l || l.indent < min) return '';
    return l.text.startsWith('- ') || l.text === '-' ? this.seq(l.indent) : this.map(l.indent);
  }

  private map(indent: number): YamlMap {
    const out: YamlMap = {};
    while (this.i < this.lines.length) {
      const l = this.lines[this.i];
      if (l.indent !== indent) break;
      const kv = splitKey(l.text);
      if (!kv) break;
      this.i++;
      const v = this.value(kv.rest, indent, true);
      // Old Unity files repeat a key (materials: `data:` per property) — the values become a list.
      if (kv.key in out) {
        const prev = out[kv.key];
        out[kv.key] = DUPS.has(prev as YamlValue[]) ? [...(prev as YamlValue[]), v] : [prev, v];
        DUPS.add(out[kv.key] as YamlValue[]);
      } else out[kv.key] = v;
    }
    return out;
  }

  private seq(indent: number): YamlValue[] {
    const out: YamlValue[] = [];
    while (this.i < this.lines.length) {
      const l = this.lines[this.i];
      if (l.indent !== indent || !(l.text.startsWith('- ') || l.text === '-')) break;
      const rest = l.text === '-' ? '' : l.text.slice(2);
      const itemIndent = indent + 2;
      const kv = splitKey(rest);
      if (kv) {
        // `- key: v` + more keys of the same item at indent + 2.
        this.lines[this.i] = { indent: itemIndent, text: rest, no: l.no };
        out.push(this.map(itemIndent));
      } else {
        this.i++;
        out.push(this.value(rest, indent, false));
      }
    }
    return out;
  }

  /** The value after `key:` (or `- `): inline, or the nested block below. */
  private value(rest: string, indent: number, isKey: boolean): YamlValue {
    if (rest === '') {
      const n = this.lines[this.i];
      // Unity's sequences sit at the key's own indent: `key:\n- a`.
      if (n && (n.indent > indent || (isKey && n.indent === indent && (n.text.startsWith('- ') || n.text === '-')))) return this.block(n.indent === indent ? indent : indent + 1);
      return '';
    }
    let text = rest;
    if (text.startsWith('{') || text.startsWith('[')) {
      // A flow collection may wrap over lines.
      while (!balanced(text) && this.i < this.lines.length && this.lines[this.i].indent > indent) text += ' ' + this.lines[this.i++].text;
      return new FlowParser(text).value();
    }
    if (text.startsWith("'") || text.startsWith('"')) {
      const q = text[0];
      while (!closedQuote(text, q) && this.i < this.lines.length) text += '\n' + this.lines[this.i++].text;
      return unquote(text, q);
    }
    // A plain scalar continues on more-indented lines that are not keys.
    while (this.i < this.lines.length && this.lines[this.i].indent > indent && !splitKey(this.lines[this.i].text) && !this.lines[this.i].text.startsWith('- ')) text += ' ' + this.lines[this.i++].text;
    return text;
  }
}

function balanced(s: string): boolean {
  let d = 0;
  let q: string | null = null;
  for (const ch of s) {
    if (q) {
      if (ch === q) q = null;
    } else if (ch === "'" || ch === '"') q = ch;
    else if (ch === '{' || ch === '[') d++;
    else if (ch === '}' || ch === ']') d--;
  }
  return d <= 0;
}

function closedQuote(s: string, q: string): boolean {
  if (q === "'") {
    // '' is an escaped quote.
    let i = 1;
    while (i < s.length) {
      if (s[i] === "'") {
        if (s[i + 1] === "'") i += 2;
        else return true;
      } else i++;
    }
    return false;
  }
  for (let i = 1; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '"') return true;
  }
  return false;
}

function unquote(s: string, q: string): string {
  const end = q === "'" ? findSingleEnd(s) : findDoubleEnd(s);
  const body = s.slice(1, end);
  // Line folding: a line break inside quotes is a space (an empty line — a newline).
  const folded = body.replace(/\n[ \t]*\n/g, '\u0000').replace(/[ \t]*\n[ \t]*/g, ' ').replace(/\u0000/g, '\n');
  if (q === "'") return folded.replace(/''/g, "'");
  return folded.replace(/\\(["\\/nrt0]|x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4})/g, (_, e: string) => {
    switch (e[0]) {
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      case '0':
        return '\0';
      case 'x':
      case 'u':
        return String.fromCharCode(parseInt(e.slice(1), 16));
      default:
        return e;
    }
  });
}

function findSingleEnd(s: string): number {
  let i = 1;
  while (i < s.length) {
    if (s[i] === "'") {
      if (s[i + 1] === "'") i += 2;
      else return i;
    } else i++;
  }
  return s.length;
}

function findDoubleEnd(s: string): number {
  for (let i = 1; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '"') return i;
  }
  return s.length;
}

/** `{a: 1, b: {c: x}}`, `[1, 2]` — flow collections (Unity: references, vectors, colours). */
class FlowParser {
  private i = 0;
  constructor(private readonly s: string) {}

  value(): YamlValue {
    this.ws();
    const ch = this.s[this.i];
    if (ch === '{') return this.map();
    if (ch === '[') return this.seq();
    return this.scalar();
  }

  private ws(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
  }

  private map(): YamlMap {
    const out: YamlMap = {};
    this.i++; // {
    for (;;) {
      this.ws();
      if (this.s[this.i] === '}' || this.i >= this.s.length) {
        this.i++;
        return out;
      }
      const key = this.scalar(':');
      this.ws();
      if (this.s[this.i] === ':') this.i++;
      out[key] = this.value();
      this.ws();
      if (this.s[this.i] === ',') this.i++;
    }
  }

  private seq(): YamlValue[] {
    const out: YamlValue[] = [];
    this.i++; // [
    for (;;) {
      this.ws();
      if (this.s[this.i] === ']' || this.i >= this.s.length) {
        this.i++;
        return out;
      }
      out.push(this.value());
      this.ws();
      if (this.s[this.i] === ',') this.i++;
    }
  }

  private scalar(stopAt = ''): string {
    this.ws();
    const q = this.s[this.i];
    if (q === "'" || q === '"') {
      const rest = this.s.slice(this.i);
      const end = q === "'" ? findSingleEnd(rest) : findDoubleEnd(rest);
      this.i += end + 1;
      return unquote(rest.slice(0, end + 1), q);
    }
    const start = this.i;
    while (this.i < this.s.length) {
      const ch = this.s[this.i];
      if (ch === ',' || ch === '}' || ch === ']') break;
      if (stopAt && ch === ':' && /[\s]/.test(this.s[this.i + 1] ?? ' ')) break;
      this.i++;
    }
    return this.s.slice(start, this.i).trim();
  }
}

// ── reading values ─────────────────────────────────────────────────────────────────────────────────

/** A number from a scalar ('' / missing → `def`). */
export function num(v: YamlValue | undefined, def = 0): number {
  if (typeof v !== 'string' || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/** A mapping (or an empty one). */
export function map(v: YamlValue | undefined): YamlMap {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

/** A sequence (or an empty one). */
export function list(v: YamlValue | undefined): YamlValue[] {
  return Array.isArray(v) ? v : [];
}

/** A reference `{fileID, guid?, type?}`: fileID '0' — none. */
export interface Ref {
  fileID: string;
  guid?: string;
  type?: string;
}

export function ref(v: YamlValue | undefined): Ref | null {
  const m = map(v);
  const fileID = typeof m.fileID === 'string' ? m.fileID : '0';
  if (fileID === '0' && !m.guid) return null;
  return { fileID, guid: typeof m.guid === 'string' ? m.guid : undefined, type: typeof m.type === 'string' ? m.type : undefined };
}
