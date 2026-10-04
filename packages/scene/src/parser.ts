// parser.ts — SVG string → SceneTree (renderer-agnostic).
// DOMParser approach:
//   - root is <svg> (not <scene>), tags are standard SVG,
//   - tml:* attributes are pulled out into a separate `tml` map,
//   - unknown tags are a hard parse error.
// Uses @xmldom/xmldom so the core parses identically in Node (tests) and the browser.
//
// v0.5 adds the *heir* document (scene.tml.svg): a <svg tml:extends="..."> whose children are
// either <tml:ref id="..."> overrides of base nodes or ordinary SVG subtrees carrying
// tml:insert. Structural validation of those directives lives in merge.ts — parseHeir only
// extracts them (so every problem can be reported together, not one exception at a time).

import { DOMParser } from '@xmldom/xmldom';
import { upgradeDocument } from './compat.js';

/** A node of the parsed scene tree. */
export interface SceneNode {
  /** Element tag name: svg | g | image | text | rect | path | circle | ellipse | line | defs | clipPath. */
  tag: string;
  /** Plain (non-tml, non-xmlns) attributes, verbatim. */
  attrs: Record<string, string>;
  /** tml:* attributes with the `tml:` prefix stripped (e.g. `bind`, `type`, `on-click`, `cols`). */
  tml: Record<string, string>;
  /** Trimmed direct text content, if any. */
  text?: string;
  children: SceneNode[];
  /** v0.9: set on the `<g>` an instance `<use href>` expanded into (prefab.ts). */
  instance?: PrefabInstance;
  /** v0.9: the instance whose `self` this node's expressions see (undefined — the document's own level). */
  scope?: InstanceScope;
  /**
   * v0.9: per-key override of `scope` — a tml key mixed in by an outer heir (`tml:ref id="btn/label"`)
   * evaluates in that heir's document (`null` — the current document's level).
   */
  keyScope?: Record<string, InstanceScope | null>;
}

/** v0.9: what a `<use href>` instance was (kept on the expanded `<g>`). */
export interface PrefabInstance {
  /** href as written on the `<use>`. */
  href: string;
  /** The prefab document's path relative to the top scene's folder (how it was loaded). */
  rel: string;
  /** Effective parameters: prefab root data-* overridden by the instance's (keys with `data-`). */
  params: Record<string, string>;
  /** The prefab's own defaults (its root data-*, after the tml:extends chain). */
  defaults: Record<string, string>;
  /** The parameters the `<use>` itself set (as written, href-like values rebased). */
  own: Record<string, string>;
  /** Placement attributes of the `<use>` as written (x, y, transform…) — tools write it back. */
  use: Record<string, string>;
  /** Required parameters of the prefab (its contract's `params`, inherited through tml:extends). */
  required: string[];
  /** The scope the prefab's expressions run in. */
  scope: InstanceScope;
  /** v1.0: the prefab's viewBox size — its minimum (null: no viewBox). */
  min?: { w: number; h: number } | null;
  /** v1.0: the instance's size — `<use width height>` of a resizable prefab, else the minimum. */
  size?: { w: number; h: number } | null;
  /** v1.0: the prefab's data-resizable axes (absent — not resizable). */
  resizable?: 'x' | 'y' | 'xy';
  /** v1.0: the `<use>`'s children moved into the prefab's slots — nodes of the scene, not the prefab. */
  slotted?: SceneNode[];
}

/** v0.9: an instance as the prefab's expressions see it — `self`. */
export interface InstanceScope {
  /** The expanded `<g>` (its id — composite after nesting — is `self.id`). */
  node: SceneNode;
  /** Effective parameters (with `data-`); a value starting with `=` is an expression of the parent level. */
  params: Record<string, string>;
  /** The enclosing instance (undefined — the top scene). `=` params and `self.call` run there. */
  parent?: InstanceScope;
}

// SVG elements understood by the format (v0.7: + geometry, <defs>, <clipPath>; v0.9: <use href> — a prefab instance). Anything else is a
// parse error. Exported for tools that build nodes (the editor checks inserted fragments with it).
export const ALLOWED_TAGS: ReadonlySet<string> = new Set(['svg', 'g', 'image', 'text', 'rect', 'path', 'circle', 'ellipse', 'line', 'defs', 'clipPath', 'use']);

/** Tags people reach for that the format deliberately lacks — the error says what to use instead. */
const HINTS: Record<string, string> = {
  mask: 'мягкие маски (<mask>, альфа, градиент) — вне формата; только геометрическая <clipPath> + clip-path="url(#id)"',
  polygon: 'используйте <path d="M … Z">',
  polyline: 'используйте <path d="M … L …">',
};

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

/**
 * Parse an SVG scene string (a base document) into a SceneTree.
 * @throws on malformed XML or an unsupported element tag.
 */
export function parse(svg: string): SceneNode {
  const root = parseXmlRoot(svg);
  if (root.nodeName !== 'svg') {
    throw new Error(`Trempel parse error: root element must be <svg>, got <${root.nodeName}>`);
  }
  return parseElement(root);
}

// ---- heir document ---------------------------------------------------------

/** A `<tml:ref id="...">` directive: which base node to enrich and with what tml:* attrs. */
export interface HeirRef {
  /** The referenced base id (null if the ref omitted `id` — reported by merge). */
  id: string | null;
  /** tml:* attributes (prefix stripped) to mix into the base node. */
  tml: Record<string, string>;
  /** Names of any non-tml, non-id attributes present (illegal — reported by merge). */
  foreign: string[];
}

/** A `tml:insert="after <id> | into <id>"` subtree that lives only in the heir. */
export interface HeirInsert {
  /** Raw tml:insert value, e.g. "after board" (parsed & validated by merge). */
  raw: string;
  /** The parsed subtree (its own tml:insert removed from the tml map). */
  node: SceneNode;
}

/** The parsed heir document — directives extracted, not yet validated. */
export interface HeirDoc {
  /** Value of tml:extends on the root (informational; mount is fed the base directly). */
  extends: string | null;
  refs: HeirRef[];
  inserts: HeirInsert[];
  /** Heir children that are neither a <tml:ref> nor carry tml:insert (illegal). */
  strays: { tag: string }[];
  /** v0.9: data-* of the heir root — new defaults for the base root's parameters. */
  rootData: Record<string, string>;
}

/**
 * Parse an heir document (scene.tml.svg) into its directives.
 * @throws on malformed XML, a non-<svg> root, or an unsupported element inside an insert subtree.
 */
export function parseHeir(svg: string): HeirDoc {
  const root = parseXmlRoot(svg);
  if (root.nodeName !== 'svg') {
    throw new Error(`Trempel parse error: heir root must be <svg>, got <${root.nodeName}>`);
  }

  const extendsAttr = readAttrs(root).find((a) => a.name === 'tml:extends');
  const doc: HeirDoc = {
    extends: extendsAttr ? extendsAttr.value : null,
    refs: [],
    inserts: [],
    strays: [],
    rootData: {},
  };
  for (const { name, value } of readAttrs(root)) if (name.startsWith('data-')) doc.rootData[name] = value;

  const childNodes = root.childNodes;
  for (let i = 0; i < childNodes.length; i++) {
    const el = childNodes[i];
    if (el.nodeType !== ELEMENT_NODE) continue;
    const node = el as XmlElement;

    if (node.nodeName === 'tml:ref') {
      doc.refs.push(parseRef(node));
      continue;
    }

    const parsed = parseElement(node);
    if (parsed.tml.insert !== undefined) {
      const raw = parsed.tml.insert;
      delete parsed.tml.insert; // the insert directive itself is not part of the subtree's tml
      doc.inserts.push({ raw, node: parsed });
    } else {
      doc.strays.push({ tag: parsed.tag });
    }
  }

  return doc;
}

function parseRef(el: XmlElement): HeirRef {
  const ref: HeirRef = { id: null, tml: {}, foreign: [] };
  for (const { name, value } of readAttrs(el)) {
    if (name === 'xmlns' || name.startsWith('xmlns:')) continue;
    if (name === 'id') ref.id = value;
    else if (name.startsWith('tml:')) ref.tml[name.slice(4)] = value;
    else ref.foreign.push(name);
  }
  return ref;
}

// ---- shared XML machinery --------------------------------------------------

// Minimal structural subset of the DOM we rely on (works for both xmldom and native).
interface XmlAttr {
  name?: string;
  nodeName?: string;
  value: string;
}
interface XmlNode {
  nodeType: number;
  nodeName: string;
  textContent?: string | null;
}
interface XmlElement extends XmlNode {
  attributes: ArrayLike<XmlAttr>;
  childNodes: ArrayLike<XmlNode>;
}

/** Parse a string and return its validated root element. @throws on any XML failure. */
function parseXmlRoot(src: string): XmlElement {
  const errors: string[] = [];
  const parser = new DOMParser({
    onError: (level, message) => {
      if (level === 'error' || level === 'fatalError') errors.push(message);
    },
  });

  const doc = parser.parseFromString(upgradeDocument(src), 'text/xml');
  if (errors.length) {
    throw new Error(`Trempel parse error: malformed XML — ${errors.join('; ')}`);
  }

  const root = doc.documentElement as unknown as XmlElement | null;
  if (!root) {
    throw new Error('Trempel parse error: document has no root element');
  }
  // Native DOMParser reports failures as a <parsererror> element; guard for that too.
  if (root.nodeName === 'parsererror') {
    throw new Error(`Trempel parse error: ${(root.textContent ?? '').trim()}`);
  }
  return root;
}

function readAttrs(el: XmlElement): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  const attributes = el.attributes;
  for (let i = 0; i < attributes.length; i++) {
    const attr = attributes[i];
    const name = attr.name ?? attr.nodeName ?? '';
    if (name) out.push({ name, value: attr.value });
  }
  return out;
}

function parseElement(el: XmlElement): SceneNode {
  const tag = el.nodeName;
  if (!ALLOWED_TAGS.has(tag)) {
    throw new Error(
      `Trempel parse error: unsupported element <${tag}>. ` +
        (HINTS[tag] ? `${HINTS[tag]}. ` : '') +
        `Supported: ${[...ALLOWED_TAGS].join(', ')}.`,
    );
  }

  const attrs: Record<string, string> = {};
  const tml: Record<string, string> = {};
  for (const { name, value } of readAttrs(el)) {
    if (name === 'xmlns' || name.startsWith('xmlns:')) continue;
    if (name.startsWith('tml:')) tml[name.slice(4)] = value;
    else attrs[name] = value;
  }

  const children: SceneNode[] = [];
  let text: string | undefined;
  const childNodes = el.childNodes;
  for (let i = 0; i < childNodes.length; i++) {
    const node = childNodes[i];
    if (node.nodeType === ELEMENT_NODE) {
      children.push(parseElement(node as XmlElement));
    } else if (node.nodeType === TEXT_NODE) {
      const t = (node.textContent ?? '').trim();
      if (t) text = text ? `${text}${t}` : t;
    }
  }

  return { tag, attrs, tml, text, children };
}
