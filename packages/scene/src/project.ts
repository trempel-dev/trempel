// project.ts — v1.1: the project file `.trempel/project.mdz` and the checks of collection hrefs.
// Pure (no fs): the Node tools find and read the file themselves (node/project.ts).
//
//   # Trempel project
//
//   ## collections
//   $skin: skins/default/ui           ← a folder from the project root
//   $kit: npm:@trempel/kit/ui         ← a folder of an npm package (node resolution from the root)
//
// The file is md (src/md/): plain `##` headings open sections, `$name: value` lines in the
// `collections` section declare collections. Other sections are free text (notes for people).
//
// @internal — `@trempel/scene/internal/project`, for the kit and the editor: no stability promise.
// Stable (re-exported by @trempel/scene): parseProject, PROJECT_FILE, ProjectFile, CollectionSpec.

import { parse as parseMd } from './md/parse.js';
import { COLLECTION_NAME, collectionOf, resolveHref, unknownCollection } from './href.js';
import { parseHeir } from './parser.js';
import { coded } from './codes.js';
import { parseViews } from './props.js';
import type { SceneNode } from './parser.js';
import { walk } from './tree.js';

/** Where a project's own files live and what it is called (`<root>/.trempel/project.mdz`). */
export const PROJECT_FILE = '.trempel/project.mdz';

/** One collection as written: a folder from the project root, or `npm:<package>/<subfolder>`. */
export interface CollectionSpec {
  name: string;
  /** The value as written (`skins/default/ui`, `npm:@trempel/kit/ui`). */
  value: string;
  /** `npm:` — the package and the folder inside it ('' — the package folder). */
  npm?: { pkg: string; sub: string };
}

export interface ProjectFile {
  collections: CollectionSpec[];
  /** Problems of the file, phrased for a human (a bad name, an empty value, a repeated name). */
  errors: string[];
}

/** `npm:@scope/pkg/sub/dir` → { pkg: '@scope/pkg', sub: 'sub/dir' }; null — not a package reference. */
export function parseNpmRef(value: string): { pkg: string; sub: string } | null {
  if (!value.startsWith('npm:')) return null;
  const parts = value.slice(4).split('/').filter(Boolean);
  const n = parts[0]?.startsWith('@') ? 2 : 1;
  if (parts.length < n) return null;
  return { pkg: parts.slice(0, n).join('/'), sub: parts.slice(n).join('/') };
}

/** Parse `.trempel/project.mdz`. Never throws: problems go to `errors`. */
export function parseProject(text: string): ProjectFile {
  const out: ProjectFile = { collections: [], errors: [] };
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let section: string | null = null;
  const own: string[] = [];
  lines.forEach((line) => {
    const h = /^#{1,6}\s+(.*?)\s*$/.exec(line);
    if (h) {
      section = h[1].toLowerCase();
      return;
    }
    if (section === 'collections') own.push(line);
  });
  if (!own.length) return out;
  let attrs;
  try {
    attrs = parseMd(own.join('\n')).root.attrs;
  } catch (e) {
    out.errors.push(coded('E_PROJECT', `${PROJECT_FILE}: ${(e as Error).message}`));
    return out;
  }
  const seen = new Set<string>();
  for (const a of attrs) {
    const name = a.key.join('.');
    const where = `${PROJECT_FILE}: $${name}`;
    if (!COLLECTION_NAME.test(name)) {
      out.errors.push(coded('E_PROJECT', `${where} — a collection name is [a-z][a-z0-9-]* (lowercase Latin letters, digits, hyphens).`));
      continue;
    }
    if (seen.has(name)) {
      out.errors.push(coded('E_PROJECT', `${where} — the collection is declared twice.`));
      continue;
    }
    seen.add(name);
    const value = typeof a.value === 'string' ? a.value.trim() : '';
    if (!value) {
      out.errors.push(coded('E_PROJECT', `${where} — needs a folder: a path from the project root or npm:<package>/<folder>.`));
      continue;
    }
    if (value.startsWith('npm:')) {
      const npm = parseNpmRef(value);
      if (!npm) out.errors.push(coded('E_PROJECT', `${where}: "${value}" — expected npm:<package>/<folder>.`));
      else out.collections.push({ name, value, npm });
      continue;
    }
    if (/^(?:[a-zA-Z][a-zA-Z\d+.-]*:|\/)/.test(value)) {
      out.errors.push(coded('E_PROJECT', `${where}: "${value}" — a (relative) path from the project root or npm:<package>/<folder>.`));
      continue;
    }
    out.collections.push({ name, value });
  }
  return out;
}

/** Hrefs a (composed) tree carries in attributes: image href, data-views variants, instance hrefs. */
function treeHrefs(tree: SceneNode, visit: (href: string, where: string) => void): void {
  walk(tree, (n) => {
    const where = n.attrs.id ? `#${n.attrs.id}` : `<${n.tag}>`;
    if (n.attrs.href != null) visit(n.attrs.href, where);
    if (n.instance) visit(n.instance.href, where);
    const views = n.attrs['data-views'];
    if (views != null) {
      try {
        for (const href of parseViews(views).values()) visit(href, where);
      } catch {
        // malformed data-views — propErrors
      }
    }
    for (const [k, v] of Object.entries(n.attrs)) {
      if (k.startsWith('data-') && k !== 'data-views' && collectionOf(v)) visit(v, `${where} ${k}`);
    }
  });
}

/** Every `@name/…` of a tree whose collection is not among `collections` (v1.1), one line per href. */
export function collectionErrors(tree: SceneNode, collections: Record<string, string> | undefined): string[] {
  const errors: string[] = [];
  treeHrefs(tree, (href, where) => {
    const name = collectionOf(href);
    if (name && !(collections && Object.prototype.hasOwnProperty.call(collections, name))) {
      errors.push(coded('E_COLLECTION_UNKNOWN', `${where}: ${href} — ${unknownCollection(name, collections)}`));
    }
  });
  return [...new Set(errors)];
}

/** Names of the collections a tree uses (sorted). */
export function usedCollections(tree: SceneNode): string[] {
  const names = new Set<string>();
  treeHrefs(tree, (href) => {
    const name = collectionOf(href);
    if (name) names.add(name);
  });
  return [...names].sort();
}

/** 2.0: the project heirs of collection documents (see projectHeirs). */
export interface ProjectHeirs {
  /** Collection document (`@ui/ui/card.svg`) → the heir's scene path from the project root (`scenes/ui/card.svg`). */
  heirs: Record<string, string>;
  errors: string[];
}

/**
 * 2.0: project heirs. Every heir of the project (outside its collections) whose tml:extends names a
 * collection document is that document's heir in the project: its instances anywhere — the project's
 * scenes and the collection's own documents — are built as the heir, layered over the collection's
 * heir (§12). Two heirs of one document — E_PROJECT_HEIR. `files`: heir path from the project root
 * (`scenes/ui/card.tml.svg`) → its text; unreadable heirs are skipped (reported where they are used).
 */
export function projectHeirs(files: Record<string, string>): ProjectHeirs {
  const heirs: Record<string, string> = {};
  const errors: string[] = [];
  for (const file of Object.keys(files).sort()) {
    let ext: string | undefined;
    try {
      ext = parseHeir(files[file]).extends ?? undefined;
    } catch {
      continue;
    }
    if (!ext) continue;
    const doc = resolveHref(ext, file);
    if (!collectionOf(doc)) continue;
    const scene = file.replace(/\.tml\.svg$/, '.svg');
    if (Object.prototype.hasOwnProperty.call(heirs, doc)) {
      errors.push(coded('E_PROJECT_HEIR', `${doc} has two project heirs: ${heirs[doc].replace(/\.svg$/, '.tml.svg')} and ${file} — a collection document has one heir in a project (a variant extends that heir).`));
      continue;
    }
    heirs[doc] = scene;
  }
  return { heirs, errors };
}

/** 2.0: project heirs as `MountOptions.heirs` of one scene: hrefs from that scene's folder (`scenePath` — from the project root). */
export function heirsFor(heirs: Record<string, string>, scenePath: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [doc, path] of Object.entries(heirs)) out[doc] = relativePath(scenePath, path);
  return out;
}

/** A path from the folder of `from` to `to` (both from one root, `/`-separated). */
export function relativePath(from: string, to: string): string {
  const a = from.split('/').slice(0, -1);
  const b = to.split('/');
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
}
