// render.ts — what the editor adds around the real runtime to know which drawn node is which base
// element (pure apart from the backend/registry it wraps; no Pixi import).
//
//   - annotate(): the base text handed to mount() gets `data-tml-editor-path="0/3"` on every
//     element (the saved document never sees it). The backend wrapper reads it in createNode, so
//     every drawn node of the base — with an id or not — maps to its index path. Heir inserts
//     carry no mark: drawn, not selectable (spec: base only).
//   - standIns(): components the folder's module does not register are drawn as their base
//     (plain nodes), with a warning — instead of the whole scene failing to mount.

import { DOMParser, XMLSerializer, type Element } from '@xmldom/xmldom';
import { Registry, type ComponentInstance, type NodeHandle, type RendererBackend, type SceneNode } from '../src/core.js';

export const PATH_ATTR = 'data-tml-editor-path';

const elementKids = (el: Element): Element[] => {
  const out: Element[] = [];
  for (let c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) out.push(c as Element);
  return out;
};

/** The base with every element marked by its index path (root — ""). */
export function annotate(svg: string): string {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = doc.documentElement;
  if (!root) return svg;
  const visit = (el: Element, path: string): void => {
    el.setAttribute(PATH_ATTR, path);
    elementKids(el).forEach((c, i) => visit(c, path === '' ? String(i) : `${path}/${i}`));
  };
  visit(root, '');
  return new XMLSerializer().serializeToString(doc);
}

/** Backend wrapper: records index path → handle (the first node created for an element wins). */
export function recordingBackend(backend: RendererBackend, byPath: Map<string, NodeHandle>): RendererBackend {
  return {
    createNode: (tag, attrs) => {
      const path = attrs[PATH_ATTR];
      let clean = attrs;
      if (path != null) {
        clean = { ...attrs };
        delete clean[PATH_ATTR];
      }
      const h = backend.createNode(tag, clean);
      if (path != null && !byPath.has(path)) byPath.set(path, h);
      return h;
    },
    setProp: (node, path, value) => backend.setProp(node, path, value),
    onClick: (node, handler) => backend.onClick(node, handler),
    onPointer: backend.onPointer ? (node, kind, handler) => backend.onPointer!(node, kind, handler) : undefined,
    addChild: (parent, child) => backend.addChild(parent, child),
    mount: (root, container) => backend.mount(root, container),
    getBounds: (node) => backend.getBounds(node),
    whenReady: backend.whenReady ? () => backend.whenReady!() : undefined,
    setClip: backend.setClip ? (node, clip) => backend.setClip!(node, clip) : undefined,
    getProp: backend.getProp ? (node, path) => backend.getProp!(node, path) : undefined,
  };
}

const SERVICE = new Set(['defs', 'clipPath']);

/** Draw a base subtree as plain nodes (a component's stand-in). */
function buildPlain(node: SceneNode, backend: RendererBackend): NodeHandle | null {
  if (SERVICE.has(node.tag)) return null;
  const attrs = { ...node.attrs };
  delete attrs['clip-path'];
  const h = backend.createNode(node.tag, attrs);
  if (node.tag === 'text' && node.text != null) backend.setProp(h, 'text', node.text);
  for (const c of node.children) {
    const ch = buildPlain(c, backend);
    if (ch) backend.addChild(h, ch);
  }
  return h;
}

/** Registry that falls back to the base for component types the module does not register. */
export class StandInRegistry extends Registry {
  readonly missing = new Set<string>();

  constructor(private readonly inner: Registry) {
    super();
  }

  /** Every type has a factory here (the stand-in, at worst). */
  override has(): boolean {
    return true;
  }

  override create(name: string, init: Parameters<Registry['create']>[1]): ComponentInstance {
    if (this.inner.has(name)) return this.inner.create(name, init);
    this.missing.add(name);
    const root = buildPlain({ tag: init.tag, attrs: init.attrs, tml: {}, children: init.children } as SceneNode, init.backend)!;
    return { root };
  }
}
