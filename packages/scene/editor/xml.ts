// xml.ts — source-preserving XML: text → xmldom DOM (+ the raw text of every node), DOM → text.
//
// The editor's document is an xmldom DOM, but xmldom's own serializer re-quotes attributes, drops
// the original spacing inside tags and re-escapes text — a save through it would turn every
// untouched line into git noise. So the DOM is built here from our own tokenizer, and every node
// remembers how it was written: an element its start tag (each attribute with its leading
// whitespace, `=`, quote) and end tag, a text node its raw text (entities as written), a comment
// its raw form. Serialization emits the remembered text for whatever was not changed and rebuilds
// only what was: a changed attribute keeps its slot, spacing and quote; a new one goes to the end.
//
// Well-formedness is checked by the caller (Trempel's own parse runs first); the tokenizer still
// throws on what it cannot read.

import { DOMImplementation, type CDATASection, type Comment, type Document, type Element, type Node, type Text } from '@xmldom/xmldom';

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const CDATA_SECTION_NODE = 4;
const COMMENT_NODE = 8;

/** One attribute as written: ` name = "value"` → ws=" ", eq=" = ", quote='"', value decoded. */
interface AttrSrc {
  name: string;
  value: string;
  ws: string;
  eq: string;
  quote: string;
  raw: string;
}

interface ElementSrc {
  /** The whole start tag as written. */
  start: string;
  attrs: AttrSrc[];
  /** Whitespace between the last attribute and `>` / `/>`. */
  tail: string;
  selfClosing: boolean;
  /** The end tag as written (null when self-closing). */
  end: string | null;
}

interface TextSrc {
  raw: string;
  data: string;
}

const elementSrc = new WeakMap<object, ElementSrc>();
const textSrc = new WeakMap<object, TextSrc>();

export interface SourceDoc {
  doc: Document;
  root: Element;
  /** Everything before the root start tag (`<?xml …?>`, comments, doctype, whitespace). */
  prolog: string;
  /** Everything after the root end tag. */
  epilog: string;
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** Decode XML character/entity references. Unknown named entities stay as written. */
export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[A-Za-z][\w.-]*);/g, (m, ref: string) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[ref] ?? m;
  });
}

export const escapeText = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const escapeAttr = (s: string, quote = '"'): string => {
  const out = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '&#10;').replace(/\t/g, '&#9;');
  return quote === '"' ? out.replace(/"/g, '&quot;') : out.replace(/'/g, '&apos;');
};

const NAME = /[A-Za-z_:][\w.:-]*/y;
const WS = /\s*/y;

class Tokenizer {
  i = 0;
  constructor(readonly s: string) {}

  fail(msg: string): never {
    const before = this.s.slice(0, this.i);
    const line = before.split('\n').length;
    throw new Error(`XML: ${msg} (строка ${line})`);
  }

  ws(): string {
    WS.lastIndex = this.i;
    WS.exec(this.s);
    const out = this.s.slice(this.i, WS.lastIndex);
    this.i = WS.lastIndex;
    return out;
  }

  name(): string {
    NAME.lastIndex = this.i;
    const m = NAME.exec(this.s);
    if (!m) this.fail(`ожидается имя, а тут «${this.s.slice(this.i, this.i + 10)}»`);
    this.i = NAME.lastIndex;
    return m[0];
  }

  /** Raw text up to and including `end`. */
  until(end: string): string {
    const j = this.s.indexOf(end, this.i);
    if (j < 0) this.fail(`нет закрывающего «${end}»`);
    const out = this.s.slice(this.i, j + end.length);
    this.i = j + end.length;
    return out;
  }
}

/** Parse a document; the DOM has no namespaces (names are kept as written, `tml:bind` included). */
export function parseSource(text: string): SourceDoc {
  const doc = new DOMImplementation().createDocument(null, null as unknown as string, null);
  const t = new Tokenizer(text);

  // Prolog: anything up to the first start tag.
  let root: Element | null = null;
  let prologEnd = 0;
  while (t.i < text.length) {
    const lt = text.indexOf('<', t.i);
    if (lt < 0) break;
    t.i = lt;
    if (text.startsWith('<?', lt)) t.until('?>');
    else if (text.startsWith('<!--', lt)) t.until('-->');
    else if (text.startsWith('<!DOCTYPE', lt) || text.startsWith('<!doctype', lt)) skipDoctype(t);
    else {
      prologEnd = lt;
      root = readElement(t, doc);
      break;
    }
  }
  if (!root) throw new Error('XML: в документе нет корневого элемента');
  doc.appendChild(root);
  return { doc, root, prolog: text.slice(0, prologEnd), epilog: text.slice(t.i) };
}

/** Parse a fragment of sibling nodes (elements, text, comments) owned by `doc`. */
export function parseFragment(text: string, doc: Document): Node[] {
  const t = new Tokenizer(text);
  const out: Node[] = [];
  readContent(t, doc, out, null);
  return out;
}

function skipDoctype(t: Tokenizer): void {
  let depth = 0;
  for (; t.i < t.s.length; t.i++) {
    const c = t.s[t.i];
    if (c === '[') depth++;
    else if (c === ']') depth--;
    else if (c === '>' && depth <= 0) {
      t.i++;
      return;
    }
  }
  t.fail('незакрытый DOCTYPE');
}

function readElement(t: Tokenizer, doc: Document): Element {
  const startAt = t.i;
  t.i++; // <
  const tag = t.name();
  const el = doc.createElement(tag);
  const attrs: AttrSrc[] = [];
  let tail = '';
  let selfClosing = false;
  for (;;) {
    const ws = t.ws();
    const c = t.s[t.i];
    if (c === '>') {
      tail = ws;
      t.i++;
      break;
    }
    if (c === '/' && t.s[t.i + 1] === '>') {
      tail = ws;
      selfClosing = true;
      t.i += 2;
      break;
    }
    if (c === undefined) t.fail(`незакрытый тег <${tag}>`);
    if (!ws) t.fail(`<${tag}>: между атрибутами нужен пробел`);
    const at = t.i - ws.length;
    const name = t.name();
    const eqAt = t.i;
    t.ws();
    if (t.s[t.i] !== '=') t.fail(`<${tag}> ${name}: ожидается =`);
    t.i++;
    t.ws();
    const eq = t.s.slice(eqAt, t.i);
    const quote = t.s[t.i];
    if (quote !== '"' && quote !== "'") t.fail(`<${tag}> ${name}: значение без кавычек`);
    t.i++;
    const vEnd = t.s.indexOf(quote, t.i);
    if (vEnd < 0) t.fail(`<${tag}> ${name}: незакрытые кавычки`);
    // XML attribute-value normalization: literal tab/newline become spaces.
    const value = decodeEntities(t.s.slice(t.i, vEnd).replace(/[\t\n\r]/g, ' '));
    t.i = vEnd + 1;
    attrs.push({ name, value, ws, eq, quote, raw: t.s.slice(at, t.i) });
    el.setAttribute(name, value);
  }
  const start = t.s.slice(startAt, t.i);
  let end: string | null = null;
  if (!selfClosing) {
    const kids: Node[] = [];
    readContent(t, doc, kids, tag);
    for (const k of kids) el.appendChild(k);
    const endAt = t.i;
    t.i += 2; // </
    const closing = t.name();
    if (closing !== tag) t.fail(`ожидается </${tag}>, а тут </${closing}>`);
    t.ws();
    if (t.s[t.i] !== '>') t.fail(`</${tag}: ожидается >`);
    t.i++;
    end = t.s.slice(endAt, t.i);
  }
  elementSrc.set(el, { start, attrs, tail, selfClosing, end });
  return el;
}

/** Children until `</parent` (or the end of input for a fragment). */
function readContent(t: Tokenizer, doc: Document, out: Node[], parent: string | null): void {
  while (t.i < t.s.length) {
    const s = t.s;
    if (s[t.i] !== '<') {
      const j = s.indexOf('<', t.i);
      const raw = s.slice(t.i, j < 0 ? s.length : j);
      t.i += raw.length;
      const node = doc.createTextNode(decodeEntities(raw));
      textSrc.set(node, { raw, data: node.data });
      out.push(node);
      continue;
    }
    if (s.startsWith('</', t.i)) {
      if (parent == null) t.fail('лишний закрывающий тег');
      return;
    }
    if (s.startsWith('<!--', t.i)) {
      const raw = t.until('-->');
      const node = doc.createComment(raw.slice(4, -3));
      textSrc.set(node, { raw, data: node.data });
      out.push(node);
    } else if (s.startsWith('<![CDATA[', t.i)) {
      const raw = t.until(']]>');
      const node = doc.createCDATASection(raw.slice(9, -3));
      textSrc.set(node, { raw, data: node.data });
      out.push(node);
    } else if (s.startsWith('<?', t.i)) {
      const raw = t.until('?>');
      const node = doc.createTextNode(raw); // a stray PI inside the tree: kept verbatim
      textSrc.set(node, { raw, data: raw });
      out.push(node);
    } else {
      out.push(readElement(t, doc));
    }
  }
  if (parent != null) t.fail(`нет </${parent}>`);
}

/** The document back to text: remembered source where nothing changed. */
export function serializeSource(src: SourceDoc): string {
  return src.prolog + serializeNode(src.root) + src.epilog;
}

export function serializeNode(node: Node): string {
  switch (node.nodeType) {
    case ELEMENT_NODE:
      return serializeElement(node as Element);
    case TEXT_NODE: {
      const s = textSrc.get(node);
      const data = (node as Text).data;
      return s && s.data === data ? s.raw : escapeText(data);
    }
    case CDATA_SECTION_NODE: {
      const s = textSrc.get(node);
      const data = (node as CDATASection).data;
      return s && s.data === data ? s.raw : `<![CDATA[${data}]]>`;
    }
    case COMMENT_NODE: {
      const s = textSrc.get(node);
      const data = (node as Comment).data;
      return s && s.data === data ? s.raw : `<!--${data}-->`;
    }
    default:
      return '';
  }
}

function serializeElement(el: Element): string {
  const s = elementSrc.get(el);
  const tag = el.nodeName;
  const cur: { name: string; value: string }[] = [];
  for (let i = 0; i < el.attributes.length; i++) {
    const a = el.attributes[i];
    cur.push({ name: a.name, value: a.value });
  }
  const kids = el.childNodes;
  let inner = '';
  for (let i = 0; i < kids.length; i++) inner += serializeNode(kids[i]);
  const empty = kids.length === 0;

  const sameAttrs =
    !!s && s.attrs.length === cur.length && s.attrs.every((a, i) => a.name === cur[i].name && a.value === cur[i].value);
  // Start tag as written when nothing in it changed and the open/self-closing form still fits.
  if (s && sameAttrs && (s.selfClosing ? empty : true)) {
    return s.selfClosing ? s.start : s.start + inner + s.end;
  }

  let open = `<${tag}`;
  for (const a of cur) {
    const was = s?.attrs.find((x) => x.name === a.name);
    if (was && was.value === a.value) open += was.raw;
    else if (was) open += `${was.ws}${a.name}${was.eq}${was.quote}${escapeAttr(a.value, was.quote)}${was.quote}`;
    else open += ` ${a.name}="${escapeAttr(a.value)}"`;
  }
  open += s?.tail ?? '';
  if (empty && (!s || s.selfClosing)) return `${open}/>`;
  return `${open}>${inner}${s?.end ?? `</${tag}>`}`;
}

/**
 * Deep copy of a node that keeps the source records of the original (so an untouched copy is
 * written exactly like the original).
 */
export function cloneWithSource(node: Node, doc: Document): Node {
  let copy: Node;
  if (node.nodeType === ELEMENT_NODE) {
    const el = node as Element;
    const c = doc.createElement(el.nodeName);
    for (let i = 0; i < el.attributes.length; i++) c.setAttribute(el.attributes[i].name, el.attributes[i].value);
    for (let i = 0; i < el.childNodes.length; i++) c.appendChild(cloneWithSource(el.childNodes[i], doc));
    const s = elementSrc.get(el);
    if (s) elementSrc.set(c, s);
    copy = c;
  } else if (node.nodeType === COMMENT_NODE) {
    copy = doc.createComment((node as Comment).data);
  } else if (node.nodeType === CDATA_SECTION_NODE) {
    copy = doc.createCDATASection((node as CDATASection).data);
  } else {
    copy = doc.createTextNode((node as Text).data);
  }
  const ts = textSrc.get(node);
  if (ts) textSrc.set(copy, ts);
  return copy;
}

export const isElement = (n: Node | null | undefined): n is Element => !!n && n.nodeType === ELEMENT_NODE;
export const isText = (n: Node | null | undefined): n is Text => !!n && n.nodeType === TEXT_NODE;

/** Element children of a node, in order. */
export function elementChildren(el: Node): Element[] {
  const out: Element[] = [];
  for (let i = 0; i < el.childNodes.length; i++) {
    const c = el.childNodes[i];
    if (isElement(c)) out.push(c);
  }
  return out;
}
