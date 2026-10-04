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

import { parse as parseMd } from './md/parse.js';
import { COLLECTION_NAME, collectionOf, unknownCollection } from './href.js';
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
    out.errors.push(`${PROJECT_FILE}: ${(e as Error).message}`);
    return out;
  }
  const seen = new Set<string>();
  for (const a of attrs) {
    const name = a.key.join('.');
    const where = `${PROJECT_FILE}: $${name}`;
    if (!COLLECTION_NAME.test(name)) {
      out.errors.push(`${where} — имя коллекции [a-z][a-z0-9-]* (строчные латинские буквы, цифры, дефис).`);
      continue;
    }
    if (seen.has(name)) {
      out.errors.push(`${where} — коллекция объявлена дважды.`);
      continue;
    }
    seen.add(name);
    const value = typeof a.value === 'string' ? a.value.trim() : '';
    if (!value) {
      out.errors.push(`${where} — нужна папка: путь от корня проекта или npm:<пакет>/<папка>.`);
      continue;
    }
    if (value.startsWith('npm:')) {
      const npm = parseNpmRef(value);
      if (!npm) out.errors.push(`${where}: «${value}» — ожидается npm:<пакет>/<папка>.`);
      else out.collections.push({ name, value, npm });
      continue;
    }
    if (/^(?:[a-zA-Z][a-zA-Z\d+.-]*:|\/)/.test(value)) {
      out.errors.push(`${where}: «${value}» — путь от корня проекта (относительный) или npm:<пакет>/<папка>.`);
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
      errors.push(`${where}: ${href} — ${unknownCollection(name, collections)}`);
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
