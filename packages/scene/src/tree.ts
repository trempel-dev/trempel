// tree.ts — renderer-agnostic helpers over a parsed SceneTree.
// Shared by merge.ts and contract.ts so the two produce identical wording for the
// checks they have in common (base id-uniqueness, base sterility) — mount() dedupes
// the combined list, so identical strings collapse to one.
//
// @internal — `@trempel/scene/internal/tree`, for the kit and the editor: no stability promise.

import type { SceneNode } from './parser.js';
import { coded } from './codes.js';

/** Preorder walk; the callback receives each node and its parent (null for the root). */
export function walk(
  node: SceneNode,
  fn: (n: SceneNode, parent: SceneNode | null) => void,
  parent: SceneNode | null = null,
): void {
  fn(node, parent);
  for (const child of node.children) walk(child, fn, node);
}

/** Every id-bearing node in the tree, in document order. */
export function collectIds(root: SceneNode): { id: string; node: SceneNode }[] {
  const out: { id: string; node: SceneNode }[] = [];
  walk(root, (n) => {
    if (n.attrs.id) out.push({ id: n.attrs.id, node: n });
  });
  return out;
}

/** All nodes carrying a given id (normally 0 or 1; more than 1 is a uniqueness violation). */
export function findById(root: SceneNode, id: string): SceneNode[] {
  const out: SceneNode[] = [];
  walk(root, (n) => {
    if (n.attrs.id === id) out.push(n);
  });
  return out;
}

/** node → parent map (root maps to null), used to place `tml:insert="after <id>"`. */
export function parentMap(root: SceneNode): Map<SceneNode, SceneNode | null> {
  const m = new Map<SceneNode, SceneNode | null>();
  walk(root, (n, p) => m.set(n, p));
  return m;
}

/** Preorder walk that does not enter expanded prefab instances (their content is another document). */
export function walkOwn(node: SceneNode, fn: (n: SceneNode) => void): void {
  fn(node);
  if (node.instance) {
    // v1.0: what the `<use>` put into the prefab's slots is the document's own.
    for (const child of node.instance.slotted ?? []) walkOwn(child, fn);
    return;
  }
  for (const child of node.children) walkOwn(child, fn);
}

/** Report every tml:* attribute found in a tree — the base must be sterile (prefab instances are not its own). */
export function baseTmlErrors(root: SceneNode): string[] {
  const errors: string[] = [];
  walkOwn(root, (n) => {
    const keys = Object.keys(n.tml);
    if (keys.length) {
      const where = n.attrs.id ? `#${n.attrs.id}` : `<${n.tag}>`;
      errors.push(coded('E_STERILE', `the base is not sterile: ${where} carries ${keys.map((k) => `tml:${k}`).join(', ')} — all logic lives in the heir (X.tml.svg).`));
    }
  });
  return errors;
}

/** Duplicate-id report for a list of ids, phrased with `where` (e.g. "the base"). */
export function duplicateIdErrors(ids: string[], where: string): string[] {
  const counts = new Map<string, number>();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  const errors: string[] = [];
  for (const [id, n] of counts) {
    if (n > 1) {
      errors.push(coded('E_DUP_ID', `duplicate id "${id}": ${n} times in ${where} — an id must be unique.`));
    }
  }
  return errors;
}

/** Duplicate ids inside a single base tree. */
export function baseDuplicateIdErrors(root: SceneNode): string[] {
  return duplicateIdErrors(
    collectIds(root).map((e) => e.id),
    'the base',
  );
}
