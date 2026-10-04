// A minimal in-memory RendererBackend for browser-free unit tests.
// setProp writes are recorded flat by path string on node.props for easy assertions.

import type { Bounds, NodeHandle, RendererBackend } from '../../src/render/backend';

export interface MockNode {
  tag: string;
  attrs: Record<string, string>;
  props: Record<string, unknown>;
  children: MockNode[];
  clicks: (() => void)[];
  bounds: Bounds;
}

export function isMockNode(n: NodeHandle): MockNode {
  return n as MockNode;
}

export function createMockBackend(): RendererBackend {
  return {
    createNode(tag, attrs) {
      const node: MockNode = {
        tag,
        attrs,
        props: {},
        children: [],
        clicks: [],
        bounds: { x: 0, y: 0, w: 0, h: 0 },
      };
      return node;
    },
    setProp(node, path, value) {
      (node as MockNode).props[path] = value;
    },
    onClick(node, handler) {
      (node as MockNode).clicks.push(handler);
    },
    addChild(parent, child) {
      (parent as MockNode).children.push(child as MockNode);
    },
    mount() {
      /* no-op */
    },
    getBounds(node) {
      return (node as MockNode).bounds;
    },
    // v0.7: the clip is recorded as props.clip (the <clipPath> id, or null when removed).
    setClip(node, clip) {
      (node as MockNode).props.clip = clip ? clip.attrs.id ?? '(без id)' : null;
    },
    getProp(node, path) {
      return (node as MockNode).props[path];
    },
  };
}

/** A hand-steppable clock in milliseconds. */
export function createMockClock(): { t: number; now(): number } {
  return {
    t: 0,
    now() {
      return this.t;
    },
  };
}
