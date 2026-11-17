// hittest.ts — what a click on the stage selects (pure).
//
// The stage hit is the topmost drawn leaf whose bounds hold the point: document order is z-order
// (later siblings and children draw over earlier ones), so the last match in pre-order wins.
// Groups are never hit by their own bounds — only through what they draw. Selection then climbs
// to the child of the current scope (the group the user double-clicked into, as in Figma); a hit
// outside the scope leaves it for the root.

import { isWithin, parentPath, type Box, type Pt } from './geometry';

export interface HitNode {
  /** Index path from the root ("" — the root). */
  path: string;
  tag: string;
  /** Scene-space bounds (from the runtime); absent — not drawn / not measured. */
  bounds?: Box | null;
  children: HitNode[];
}

export interface HitOptions {
  /** Current scope: the group whose children a click selects ("" — the root). */
  scope?: string;
  /** Paths not to hit (hidden / locked in the tree, their subtrees too). */
  skip?: (path: string) => boolean;
}

const SERVICE = new Set(['defs', 'clipPath']);
const CONTAINERS = new Set(['svg', 'g']);

export const contains = (b: Box, p: Pt): boolean => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;

/** Topmost drawn leaf under the point (path), or null. */
export function topmostLeaf(root: HitNode, p: Pt, skip?: (path: string) => boolean): string | null {
  let hit: string | null = null;
  const visit = (n: HitNode): void => {
    if (SERVICE.has(n.tag)) return;
    if (n.path !== '' && skip?.(n.path)) return;
    if (!CONTAINERS.has(n.tag) && n.bounds && n.bounds.w >= 0 && n.bounds.h >= 0 && contains(n.bounds, p)) hit = n.path;
    n.children.forEach(visit);
  };
  visit(root);
  return hit;
}

/** The ancestor of `path` (or itself) that is a direct child of `scope`. */
export function childOfScope(path: string, scope: string): string {
  let p = path;
  while (parentPath(p) !== scope && p !== '') p = parentPath(p);
  return p;
}

/**
 * Click → { path to select, scope it is selected in }; null — empty space (the scope stays).
 * A leaf outside the scope resets the scope to the root.
 */
export function hitTest(root: HitNode, p: Pt, opts: HitOptions = {}): { path: string; scope: string } | null {
  const leaf = topmostLeaf(root, p, opts.skip);
  if (leaf == null) return null;
  let scope = opts.scope ?? '';
  if (scope !== '' && (!isWithin(leaf, scope) || leaf === scope)) scope = '';
  return { path: childOfScope(leaf, scope), scope };
}
