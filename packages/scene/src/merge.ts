// merge.ts — combine a sterile base tree with an heir document into one SceneTree.
//
// Every rule violation is collected into a single list (never thrown one-at-a-time), so a
// designer or CI run sees all problems at once. mergeScene returns { tree, errors }; merge()
// is the throwing wrapper for callers that want a hard failure.
//
// Errors covered (spec §Семантика merge, step 3):
//   - base is not sterile (carries tml:*),
//   - duplicate ids (within the base, within the heir's inserts, or across the two),
//   - a <tml:ref> targets an id that does not exist in the base,
//   - a <tml:ref> carries a non-tml attribute (geometry/style belong in the base),
//   - a tml:insert targets an id that does not exist in the base (or is malformed),
//   - an heir child that is neither a <tml:ref> nor an insert subtree,
//   - (v0.7) a <tml:ref> onto a node inside <defs> — service geometry is not bound,
//   - (v0.7) `into defs` while the base's <defs> has no id.
// v0.9: the heir root's data-* override the base root's (new parameter defaults); `tml:href` in a
// ref swaps an <image>'s href (the one appearance an heir may change — a prefab extending another);
// a ref onto a node inside a prefab instance (`btn/label`) evaluates in the heir's own document;
// an inherited base (multi-level tml:extends) already carries tml — sterility is not asked of it.

import type { HeirDoc, SceneNode } from './parser.js';
import { TrempelError } from './errors.js';
import { coded } from './codes.js';
import { baseTmlErrors, collectIds, duplicateIdErrors, parentMap } from './tree.js';

export interface MergeOutcome {
  /** The base tree, mutated in place: refs mixed in, inserts spliced. */
  tree: SceneNode;
  /** All problems found (empty ⇒ the tree is valid). */
  errors: string[];
}

const INSERT_RE = /^(after|into)\s+(\S+)$/;

export interface MergeOptions {
  /** The base is another scene's result (tml:extends chain) — its tml is legitimate. */
  inherited?: boolean;
  /** Map a `tml:href` value (relative to the heir) to the tree's href space. Default: as written. */
  href?: (href: string) => string;
}

/** Merge base + heir, collecting every problem into a list. Does not throw. */
export function mergeScene(base: SceneNode, heir: HeirDoc, opts: MergeOptions = {}): MergeOutcome {
  const errors: string[] = [];

  // 1. The base must be sterile (checked before refs mix any tml in).
  if (!opts.inherited) errors.push(...baseTmlErrors(base));

  // v0.9: new defaults of the root's parameters.
  for (const [k, v] of Object.entries(heir.rootData ?? {})) base.attrs[k] = v;

  // 2. Duplicate ids: base nodes plus everything the heir's inserts introduce.
  const baseIds = collectIds(base);
  const insertIds = heir.inserts.flatMap((ins) => collectIds(ins.node));
  errors.push(...duplicateIdErrors([...baseIds, ...insertIds].map((e) => e.id), 'the base and the heir'));

  // First-wins lookup for ref/insert targeting (duplicates already reported above).
  const byId = new Map<string, SceneNode>();
  for (const { id, node } of baseIds) if (!byId.has(id)) byId.set(id, node);
  const parents = parentMap(base);
  const inDefs = (n: SceneNode): boolean => {
    for (let p = parents.get(n); p; p = parents.get(p)) if (p.tag === 'defs') return true;
    return n.tag === 'defs';
  };

  // 3. Refs: enrich a base node with tml:* attributes.
  const seenRefs = new Set<string>();
  for (const ref of heir.refs) {
    if (ref.id == null) {
      errors.push(coded('E_REF_NO_ID', '<tml:ref> without an id — a ref names the id of a base node.'));
      continue;
    }
    if (ref.foreign.length) {
      errors.push(coded('E_REF_FOREIGN', `<tml:ref id="${ref.id}">: non-tml attribute(s) ${ref.foreign.join(', ')} are not allowed — geometry and style are edited in the base.`));
    }
    if (seenRefs.has(ref.id)) {
      errors.push(coded('E_REF_TWICE', `<tml:ref id="${ref.id}"> occurs more than once.`));
    }
    seenRefs.add(ref.id);

    const target = byId.get(ref.id);
    if (!target) {
      errors.push(coded('E_REF_MISSING', `<tml:ref id="${ref.id}">: no such id in the base.`));
      continue;
    }
    if (inDefs(target)) {
      errors.push(coded('E_REF_DEFS', `<tml:ref id="${ref.id}">: the node is in <defs> — service geometry is not bound.`));
      continue;
    }
    for (const [k, v] of Object.entries(ref.tml)) {
      if (k === 'href') {
        if (target.tag !== 'image') {
          errors.push(coded('E_REF_HREF', `<tml:ref id="${ref.id}" tml:href>: only an <image> can swap its href, this is <${target.tag}>.`));
        } else {
          target.attrs.href = opts.href ? opts.href(v) : v;
        }
        continue;
      }
      target.tml[k] = v;
      if (target.scope) (target.keyScope ??= {})[k] = null;
    }
  }

  // 4. Inserts: splice an heir-only subtree next to / into a base node.
  for (const ins of heir.inserts) {
    const m = INSERT_RE.exec(ins.raw.trim());
    if (!m) {
      errors.push(coded('E_INSERT_SYNTAX', `tml:insert="${ins.raw}": expected 'after <id>' or 'into <id>'.`));
      continue;
    }
    const mode = m[1] as 'after' | 'into';
    const targetId = m[2];
    const target = byId.get(targetId);
    if (!target) {
      const idlessDefs = targetId === 'defs' && base.children.some((c) => c.tag === 'defs' && !c.attrs.id);
      errors.push(
        idlessDefs
          ? coded('E_INSERT_TARGET', `tml:insert="${ins.raw}": an insert into an id-less <defs> — give the base's <defs> an id (e.g. id="defs").`)
          : coded('E_INSERT_TARGET', `tml:insert="${ins.raw}": the base has no node "${targetId}".`),
      );
      continue;
    }
    if (mode === 'into') {
      target.children.push(ins.node);
    } else {
      const parent = parents.get(target);
      if (!parent) {
        errors.push(coded('E_INSERT_ROOT', `tml:insert="${ins.raw}": the root has no parent to insert after it.`));
        continue;
      }
      const idx = parent.children.indexOf(target);
      parent.children.splice(idx + 1, 0, ins.node);
    }
  }

  // 5. Heir children that fit neither shape.
  for (const stray of heir.strays) {
    errors.push(coded('E_HEIR_STRAY', `heir element <${stray.tag}> is neither a <tml:ref> nor carries tml:insert; children of the heir are refs or insert subtrees.`));
  }

  return { tree: base, errors };
}

/** Merge base + heir, throwing a {@link TrempelError} with the full list on any problem. */
export function merge(base: SceneNode, heir: HeirDoc, opts: MergeOptions = {}): SceneNode {
  const { tree, errors } = mergeScene(base, heir, opts);
  if (errors.length) throw new TrempelError(errors);
  return tree;
}
