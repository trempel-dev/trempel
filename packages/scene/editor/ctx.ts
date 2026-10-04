// ctx.ts — what a command sees: the DOM, node lookup, and the recorded mutation primitives.
//
// Commands never touch the DOM directly: every change goes through setAttr / insert / remove /
// move, which log an inverse. Undo replays the inverses, redo the forward ops — the very node
// objects come back, so their remembered source text (xml.ts) does too and an undone change
// serializes byte for byte as before.

import type { SceneLoader, SceneNode } from '@trempel/scene/core';
import type { Document, Element, Node, Text } from '@xmldom/xmldom';
import { elementChildren, isElement, isText, parseFragment } from './xml.js';

/** A command's own failure (bad node, impossible edit): `ok: false`, the document untouched. */
export class CommandError extends Error {}

/** What commands know about the scene beyond its DOM (v0.9 prefabs). */
export interface CtxEnv {
  /** The composed scene (instances expanded, heir merged) as of the last validation. */
  merged(): SceneNode;
  /** Prefab documents by path relative to the scene's folder (null — none). */
  loadScene?: SceneLoader;
  /** Files a command created (prefab.extract) — the host writes them. */
  files: { path: string; text: string }[];
}

export interface Op {
  redo(): void;
  undo(): void;
}

/** Attribute list snapshot (order matters: undo restores the slot an attribute had). */
type Attrs = [string, string][];

const snapshot = (el: Element): Attrs => {
  const out: Attrs = [];
  for (let i = 0; i < el.attributes.length; i++) out.push([el.attributes[i].name, el.attributes[i].value]);
  return out;
};

const restore = (el: Element, attrs: Attrs): void => {
  while (el.attributes.length) el.removeAttribute(el.attributes[0].name);
  for (const [k, v] of attrs) el.setAttribute(k, v);
};

/** Index path "0/3/1" of an element below the root (root itself → ""). */
export function indexPath(root: Element, el: Element): string {
  const parts: number[] = [];
  for (let n: Element = el; n !== root; ) {
    const p = n.parentNode as Element | null;
    if (!p) return '';
    parts.unshift(elementChildren(p).indexOf(n));
    n = p;
  }
  return parts.join('/');
}

/** Leading whitespace of the line an element's start tag is on ("" at column 0 / unknown). */
function indentOf(el: Element): string {
  const prev = el.previousSibling;
  if (isText(prev)) {
    const m = /\n([ \t]*)$/.exec(prev.data);
    if (m) return m[1];
  }
  return '';
}

export class Ctx {
  readonly ops: Op[] = [];
  readonly warnings: string[] = [];
  private readonly touched: string[] = [];

  constructor(
    readonly doc: Document,
    readonly root: Element,
    /** `,` or ` ` — how the document writes transform arguments (new ones follow it). */
    readonly sep: string,
    /** id → clip files that refer to it (from the last validation). */
    readonly clipRefs: Map<string, string[]>,
    readonly env: CtxEnv = { merged: () => ({ tag: 'svg', attrs: {}, tml: {}, children: [] }), files: [] },
  ) {}

  get changed(): string[] {
    return [...new Set(this.touched)];
  }

  private record(op: Op): void {
    op.redo();
    this.ops.push(op);
  }

  /** Undo whatever this context did (a failed command or batch). */
  rollback(): void {
    for (let i = this.ops.length - 1; i >= 0; i--) this.ops[i].undo();
    this.ops.length = 0;
  }

  // ---- lookup ----------------------------------------------------------------------------

  /** All elements with this id, document order. */
  byId(id: string): Element[] {
    const out: Element[] = [];
    const visit = (el: Element): void => {
      if (el.getAttribute('id') === id) out.push(el);
      for (const c of elementChildren(el)) visit(c);
    };
    visit(this.root);
    return out;
  }

  allElements(from: Element = this.root): Element[] {
    const out: Element[] = [];
    const visit = (el: Element): void => {
      out.push(el);
      for (const c of elementChildren(el)) visit(c);
    };
    visit(from);
    return out;
  }

  /** A node by id, or by index path ("0/3/1"; "" or "/" — the root). @throws CommandError. */
  node(ref: string, arg = 'node'): Element {
    const byId = this.byId(ref);
    if (byId.length === 1) return byId[0];
    if (byId.length > 1) throw new CommandError(`${arg}: id "${ref}" встречается ${byId.length} раз — адресуйте путём индексов`);
    if (ref === '' || ref === '/') return this.root;
    if (/^\d+(\/\d+)*$/.test(ref)) {
      let el = this.root;
      for (const part of ref.split('/')) {
        const kids = elementChildren(el);
        const k = Number(part);
        if (k >= kids.length) throw new CommandError(`${arg}: пути "${ref}" нет — у <${el.nodeName}> ${kids.length} дочерних`);
        el = kids[k];
      }
      return el;
    }
    throw new CommandError(`${arg}: узла "${ref}" нет (ни id, ни путь индексов вида "0/3/1")`);
  }

  /** How results name a node: its id, else its index path. */
  label(el: Element): string {
    return el.getAttribute('id') || indexPath(this.root, el);
  }

  touch(el: Element): void {
    this.touched.push(this.label(el));
  }

  warn(msg: string): void {
    this.warnings.push(msg);
  }

  // ---- mutations ---------------------------------------------------------------------------

  setAttr(el: Element, name: string, value: string | null): void {
    const before = snapshot(el);
    const had = el.getAttribute(name);
    if (value === null ? !el.hasAttribute(name) : had === value && el.hasAttribute(name)) return;
    this.record({
      redo: () => (value === null ? el.removeAttribute(name) : el.setAttribute(name, value)),
      undo: () => restore(el, before),
    });
    this.touch(el);
  }

  /** Replace an element's text content (it must have no element children) by one text node. */
  setText(el: Element, text: string): void {
    const kids: Node[] = [];
    for (let c = el.firstChild; c; c = c.nextSibling) kids.push(c);
    if (kids.some(isElement)) throw new CommandError(`<${el.nodeName}>: внутри элементы — текст целиком не заменяется`);
    if ((el.textContent ?? '') === text && kids.length <= 1) return;
    const node = this.doc.createTextNode(text);
    this.record({
      redo: () => {
        for (const k of kids) el.removeChild(k);
        if (text !== '') el.appendChild(node);
      },
      undo: () => {
        if (node.parentNode) el.removeChild(node);
        for (const k of kids) el.appendChild(k);
      },
    });
    this.touch(el);
  }

  /** Detach a node (raw — no whitespace handling). */
  private detach(node: Node): void {
    const parent = node.parentNode;
    if (!parent) return;
    const next = node.nextSibling;
    this.record({
      redo: () => parent.removeChild(node),
      undo: () => parent.insertBefore(node, next),
    });
  }

  /** Attach a node before `ref` (raw). */
  private attach(parent: Node, node: Node, ref: Node | null): void {
    this.record({
      redo: () => parent.insertBefore(node, ref),
      undo: () => parent.removeChild(node),
    });
  }

  private ws(text: string): Text {
    return this.doc.createTextNode(text);
  }

  /**
   * Put an element among `parent`'s element children at `index` (default: last), on its own line,
   * indented like its siblings (or the parent + 2 spaces). `lead` — reuse this whitespace node
   * (a moved node keeps its blank lines).
   */
  insert(parent: Element, el: Element, index?: number, lead?: Text): void {
    const kids = elementChildren(parent);
    const k = index == null ? kids.length : index;
    if (!Number.isInteger(k) || k < 0 || k > kids.length) {
      throw new CommandError(`index ${index}: у <${parent.nodeName}> ${kids.length} дочерних — допустимо 0…${kids.length}`);
    }
    const childIndent = kids.length ? indentOf(kids[Math.min(k, kids.length - 1)]) : `${indentOf(parent)}  `;
    const sepText = lead ?? this.ws(`\n${childIndent}`);
    if (k < kids.length) {
      // … ws_k el_k  →  … ws_k el sep el_k
      const before = kids[k];
      this.attach(parent, el, before);
      this.attach(parent, sepText, before);
    } else if (kids.length) {
      // after the last element: … el_last [trailing ws]  →  … el_last sep el [trailing ws]
      const after = kids[kids.length - 1].nextSibling;
      this.attach(parent, sepText, after);
      this.attach(parent, el, after);
    } else {
      // empty parent: open it up onto lines of its own
      const tail = parent.lastChild;
      if (isText(tail) && /^\s*$/.test(tail.data)) {
        this.attach(parent, sepText, tail);
        this.attach(parent, el, tail);
      } else {
        this.attach(parent, sepText, null);
        this.attach(parent, el, null);
        this.attach(parent, this.ws(`\n${indentOf(parent)}`), null);
      }
    }
    this.touch(el);
  }

  /** Remove an element with the whitespace that put it on its line. Returns that whitespace. */
  remove(el: Element): Text | undefined {
    const parent = el.parentNode as Element | null;
    if (!parent) throw new CommandError('корень удалить нельзя');
    this.touch(el);
    const prev = el.previousSibling;
    const lead = isText(prev) && /^\s*$/.test(prev.data) ? prev : undefined;
    if (lead) this.detach(lead);
    this.detach(el);
    // Nothing left but whitespace: collapse to an empty element.
    if (!elementChildren(parent).length) {
      for (let c = parent.firstChild; c; ) {
        const next = c.nextSibling;
        if (isText(c) && /^\s*$/.test(c.data)) this.detach(c);
        c = next;
      }
    }
    return lead;
  }

  /** Re-place an element (z-order / reparent) keeping its leading whitespace. */
  move(el: Element, parent: Element, index: number): void {
    const lead = this.remove(el);
    this.insert(parent, el, index, lead && /\n/.test(lead.data) ? lead : undefined);
  }

  /** Parse one element from XML text (fragment whitespace re-indented under `parent`). */
  fragment(xml: string, parent: Element): Element {
    let nodes: Node[];
    try {
      nodes = parseFragment(xml.trim(), this.doc);
    } catch (e) {
      throw new CommandError(`xml: ${(e as Error).message}`);
    }
    const els = nodes.filter(isElement);
    const junk = nodes.filter((n) => !isElement(n) && !(isText(n) && /^\s*$/.test(n.data)));
    if (els.length !== 1 || junk.length) throw new CommandError('xml: ожидается ровно один элемент');
    const el = els[0];
    const kids = elementChildren(parent);
    const indent = kids.length ? indentOf(kids[kids.length - 1]) : `${indentOf(parent)}  `;
    const reindent = (n: Node): void => {
      for (let c = n.firstChild; c; c = c.nextSibling) {
        if (isText(c) && /^\s*$/.test(c.data) && c.data.includes('\n')) c.data = c.data.replace(/\n/g, `\n${indent}`);
        else if (isElement(c)) reindent(c);
      }
    };
    reindent(el);
    return el;
  }
}
