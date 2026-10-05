// node/project.ts — v1.1: find a scene's project (`.trempel/project.mdz` in the nearest ancestor)
// and resolve its collections to folders on disk. For the Node tools (view, view:shot, edit, check,
// flatten, migrate-collections); the browser runtime gets collections from its host.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { PROJECT_FILE, parseProject } from '../project.js';
import { coded, within } from '../codes.js';

export interface Project {
  /** The project root (the folder holding `.trempel/project.mdz`); null — no project file found. */
  root: string | null;
  /** Collection name → absolute folder. */
  collections: Record<string, string>;
  /** Problems of the project file and of resolving it (a missing folder, a package not found). */
  errors: string[];
}

const isDir = (p: string): boolean => existsSync(p) && statSync(p).isDirectory();

/** The nearest folder from `start` (a file or a folder) up holding `.trempel/project.mdz`, or null. */
export function findProjectRoot(start: string): string | null {
  let d = resolve(start);
  if (!isDir(d)) d = dirname(d);
  for (;;) {
    if (existsSync(join(d, PROJECT_FILE))) return d;
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/** `node_modules/<pkg>` found like Node does: from `root` up the tree. */
export function findPackageDir(root: string, pkg: string): string | null {
  for (let d = resolve(root); ; d = dirname(d)) {
    const p = join(d, 'node_modules', ...pkg.split('/'));
    if (isDir(p)) return p;
    if (dirname(d) === d) return null;
  }
}

/** Read the project of a scene file / folder: its root and collections as absolute folders. */
export function loadProject(start: string): Project {
  const root = findProjectRoot(start);
  if (!root) return { root: null, collections: {}, errors: [] };
  const file = join(root, PROJECT_FILE);
  const parsed = parseProject(readFileSync(file, 'utf8'));
  const out: Project = { root, collections: {}, errors: parsed.errors.map((e) => within(file, e.replace(`${PROJECT_FILE}: `, ''))) };
  for (const c of parsed.collections) {
    let dir: string | null;
    if (c.npm) {
      const pkg = findPackageDir(root, c.npm.pkg);
      if (!pkg) {
        out.errors.push(coded('E_PROJECT', `${file}: $${c.name}: the package ${c.npm.pkg} is not found (node_modules from ${root} up).`));
        continue;
      }
      dir = join(pkg, c.npm.sub);
    } else dir = resolve(root, c.value);
    if (!isDir(dir)) {
      out.errors.push(coded('E_PROJECT', `${file}: $${c.name}: no folder ${c.value} (${dir}).`));
      continue;
    }
    out.collections[c.name] = dir;
  }
  return out;
}

/** Is `file` inside `dir` (or `dir` itself)? */
export function isInside(dir: string, file: string): boolean {
  const d = resolve(dir);
  const f = resolve(file);
  return f === d || f.startsWith(d.endsWith(sep) ? d : d + sep);
}

/**
 * An absolute file inside one of the collections → `@name/path` (the deepest collection wins), or
 * null. For tools that write hrefs (the migration, the editor's palette).
 */
export function collectionPath(file: string, collections: Record<string, string>): string | null {
  let best: { name: string; dir: string } | null = null;
  for (const [name, dir] of Object.entries(collections)) {
    if (isInside(dir, file) && (!best || dir.length > best.dir.length)) best = { name, dir };
  }
  if (!best) return null;
  const rel = relative(best.dir, resolve(file)).split(sep).join('/');
  return rel ? `@${best.name}/${rel}` : `@${best.name}/`;
}
