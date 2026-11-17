// check.ts — the mount pipeline without rendering: everything `mount()` would refuse, as one list
// (parse, prefabs, contract, merge, geometry, presentation and layout attributes, expressions,
// collections). The repository's `npm run check`, the spec test and tools run it.

import { bindingErrors } from './binding.js';
import { geometryErrors } from './geom/check.js';
import type { SceneNode } from './parser.js';
import { composeScene, type ComposeInput } from './prefab.js';
import { collectionErrors, usedCollections } from './project.js';
import { propErrors } from './props.js';

export interface CheckInput extends ComposeInput {
  /** Collection name → folder URL (as for mount); an `@name/…` href outside it is an error. */
  collections?: Record<string, string>;
}

export interface CheckResult {
  /** The composed scene (instances expanded, heir merged), null when there is nothing to compose. */
  tree: SceneNode | null;
  /** Every problem (`E_CODE: message`), deduplicated, in pipeline order. */
  errors: string[];
  /** Collections the scene uses (names without `@`). */
  collections: string[];
}

/** Check a scene as `mount()` would, without a backend. Never throws for scene problems. */
export function checkScene(input: CheckInput): CheckResult {
  const c = composeScene(input);
  const errors = [...c.errors.parse, ...c.errors.contract, ...c.errors.merge, ...c.errors.prefab];
  if (c.tree) errors.push(...geometryErrors(c.tree), ...propErrors(c.tree), ...bindingErrors(c.tree), ...collectionErrors(c.tree, input.collections));
  return { tree: c.tree, errors: [...new Set(errors)], collections: c.tree ? usedCollections(c.tree) : [] };
}
