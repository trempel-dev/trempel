// check.ts — structural rules of v0.7 geometry over a (merged) tree, collected as a list:
//
//   - <defs> only as a direct child of the root <svg>; its children: path, circle, ellipse, line,
//     rect, g, clipPath (g inside defs — the same set);
//   - <clipPath> only inside <defs>, with an id, userSpaceOnUse units; its children: path, rect,
//     circle, ellipse, g of those;
//   - clip-path="url(#id)" | "none" only on <g> and <image>, pointing at an existing <clipPath>;
//     tml:bind-clip-path only on <g> and <image>;
//   - geometry data readable (`d`, numbers) — the same parser the backend draws with;
//   - nothing inside <defs> is bound (service geometry is not a view).
//
// Used by mount() and the CLI checker; wording names the node (#id or <tag>).
//
// @internal — `@trempel/scene/internal/geom/check`, for the kit and the editor: no stability promise.

import type { SceneNode } from '../parser.js';
import { coded, within } from '../codes.js';
import { trempelError } from '../errors.js';
import { walk } from '../tree.js';
import { GEOMETRY_TAGS, PathDataError, shapeCommands } from './pathdata.js';

const DEFS_CHILDREN = new Set(['path', 'circle', 'ellipse', 'line', 'rect', 'g', 'clipPath']);
const CLIP_CHILDREN = new Set(['path', 'rect', 'circle', 'ellipse', 'g']);
/** Elements that may carry clip-path / tml:bind-clip-path. */
export const CLIP_HOSTS = new Set(['g', 'image']);

const where = (n: SceneNode): string => (n.attrs.id ? `#${n.attrs.id}` : `<${n.tag}>`);

/**
 * `url(#m)` → "m", `none` (or empty) → null. @throws Error for anything else (a clip-path value
 * the format does not read: url to another document, objectBoundingBox tricks, basic shapes…).
 */
export function parseClipRef(value: unknown): string | null {
  if (value == null || value === false) return null;
  const v = String(value).trim();
  if (v === '' || v === 'none') return null;
  const m = /^url\(\s*['"]?#([^'")\s]+)['"]?\s*\)$/.exec(v);
  if (!m) throw trempelError('E_CLIP_PATH', `clip-path="${v}" — expected url(#id) or none.`);
  return m[1];
}

/** Every <clipPath> of the tree by id. */
export function clipPaths(tree: SceneNode): Map<string, SceneNode> {
  const out = new Map<string, SceneNode>();
  walk(tree, (n) => {
    if (n.tag === 'clipPath' && n.attrs.id && !out.has(n.attrs.id)) out.set(n.attrs.id, n);
  });
  return out;
}

/** All v0.7 geometry/defs/clip problems of a tree, phrased for a human. */
export function geometryErrors(tree: SceneNode): string[] {
  const errors: string[] = [];
  const ids = new Map<string, SceneNode>();
  walk(tree, (n) => {
    if (n.attrs.id && !ids.has(n.attrs.id)) ids.set(n.attrs.id, n);
  });

  const visit = (n: SceneNode, parent: SceneNode | null, inDefs: boolean, inClip: boolean): void => {
    const w = where(n);

    if (n.tag === 'defs') {
      if (parent !== tree) errors.push(coded('E_DEFS_PLACE', `${w}: <defs> is only a direct child of the root <svg>.`));
    }
    if (n.tag === 'clipPath') {
      if (!parent || parent.tag !== 'defs') errors.push(coded('E_DEFS_PLACE', `${w}: <clipPath> lives only inside <defs>.`));
      if (!n.attrs.id) errors.push(coded('E_CLIP_NO_ID', '<clipPath> without an id — clip-path cannot reference it.'));
      const units = n.attrs.clipPathUnits;
      if (units != null && units !== 'userSpaceOnUse') {
        errors.push(coded('E_CLIP_UNITS', `${w}: clipPathUnits="${units}" is not supported — only userSpaceOnUse (the masked node's units).`));
      }
    }
    if (parent?.tag === 'defs' && !DEFS_CHILDREN.has(n.tag)) {
      errors.push(coded('E_DEFS_PLACE', `${w}: <defs> cannot hold <${n.tag}> (it holds: ${[...DEFS_CHILDREN].join(', ')}).`));
    } else if (inDefs && parent?.tag === 'g' && !inClip && !DEFS_CHILDREN.has(n.tag)) {
      errors.push(coded('E_DEFS_PLACE', `${w}: <defs> cannot hold <${n.tag}> (it holds: ${[...DEFS_CHILDREN].join(', ')}).`));
    }
    if (inClip && n.tag !== 'clipPath' && !CLIP_CHILDREN.has(n.tag)) {
      errors.push(coded('E_DEFS_PLACE', `${w}: <clipPath> cannot hold <${n.tag}> (it holds: ${[...CLIP_CHILDREN].join(', ')}).`));
    }

    if (GEOMETRY_TAGS.has(n.tag)) {
      try {
        shapeCommands(n.tag, n.attrs);
      } catch (e) {
        const msg = e instanceof PathDataError && n.tag === 'path' && e.src ? within('d', e.message) : (e as Error).message;
        errors.push(`${within(w, msg)}.`);
      }
    }

    if (inDefs) {
      const keys = Object.keys(n.tml);
      if (keys.length) {
        errors.push(coded('E_REF_DEFS', `${w}: service geometry (<defs>) is not bound — ${keys.map((k) => `tml:${k}`).join(', ')} has no effect here.`));
      }
    }

    const cp = n.attrs['clip-path'];
    if (cp != null) {
      if (!CLIP_HOSTS.has(n.tag)) {
        errors.push(coded('E_CLIP_PATH', `${w}: clip-path on <${n.tag}> is not supported — only on <g> and <image>.`));
      } else if (inDefs) {
        errors.push(coded('E_CLIP_PATH', `${w}: clip-path inside <defs> masks nothing.`));
      } else {
        try {
          const id = parseClipRef(cp);
          if (id != null) {
            const target = ids.get(id);
            if (!target) errors.push(coded('E_CLIP_PATH', `${w}: clip-path="${cp}" — no node #${id}.`));
            else if (target.tag !== 'clipPath') errors.push(coded('E_CLIP_PATH', `${w}: clip-path="${cp}" — #${id} is <${target.tag}>, not a <clipPath>.`));
          }
        } catch (e) {
          errors.push(within(w, (e as Error).message));
        }
      }
    }
    if (n.tml['bind-clip-path'] !== undefined && !CLIP_HOSTS.has(n.tag)) {
      errors.push(coded('E_CLIP_PATH', `${w}: tml:bind-clip-path on <${n.tag}> is not supported — only on <g> and <image>.`));
    }

    for (const child of n.children) visit(child, n, inDefs || n.tag === 'defs', inClip || n.tag === 'clipPath');
  };
  visit(tree, null, false, false);
  return errors;
}
