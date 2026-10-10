// project.ts — a project as the hub sees it: its root, name, the versions of the kit and the scene
// it runs on (installed in node_modules, else as declared), git state; finding projects under roots.

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export const PROJECT_FILE = '.trempel/project.mdz';
export const ENGINE_PACKAGES = ['@trempel/kit', '@trempel/scene'] as const;

export interface PackageJson {
  name?: string;
  version?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

export interface GitState {
  branch: string | null;
  dirty: boolean;
  /** Changed files (porcelain lines). */
  changes: number;
  ahead: number;
  behind: number;
  upstream: string | null;
}

export interface ProjectInfo {
  id: string;
  root: string;
  name: string;
  /** Installed version (node_modules), else the declared range; null — not a dependency. */
  kit: string | null;
  scene: string | null;
  /** Where the project's `@trempel/kit` lives (for its layer of actions), null — not installed. */
  kitDir: string | null;
  hasProjectFile: boolean;
  manual: boolean;
  /**
   * 2.4.1: the name to show — `name`, or `name · folder` when another listed project has the same name
   * (a game and its live copy both named after one package.json); the id and the logic use `id`/`root`.
   */
  label: string;
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

export function readPackageJson(dir: string): PackageJson | null {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PackageJson;
  } catch {
    return null;
  }
}

/** A project's stable id: a hash of its real path. */
export function projectId(root: string): string {
  let real = resolve(root);
  try {
    real = realpathSync(real);
  } catch {
    /* gone */
  }
  return createHash('sha1').update(real).digest('hex').slice(0, 10);
}

/** `node_modules/<pkg>` found like Node does: from `root` up the tree (and through symlinks). */
export function findPackageDir(root: string, pkg: string): string | null {
  for (let d = resolve(root); ; d = dirname(d)) {
    const p = join(d, 'node_modules', ...pkg.split('/'));
    if (isDir(p)) return p;
    if (dirname(d) === d) return null;
  }
}

export function declared(pj: PackageJson | null, pkg: string): string | null {
  if (!pj) return null;
  return pj.dependencies?.[pkg] ?? pj.devDependencies?.[pkg] ?? pj.peerDependencies?.[pkg] ?? null;
}

/** Is `dir` a project: depends on the kit or the scene, or has `.trempel/project.mdz`. */
export function isProject(dir: string): boolean {
  if (existsSync(join(dir, PROJECT_FILE))) return true;
  const pj = readPackageJson(dir);
  return ENGINE_PACKAGES.some((p) => declared(pj, p) !== null);
}

function installedVersion(root: string, pkg: string): { version: string | null; dir: string | null } {
  const dir = findPackageDir(root, pkg);
  if (!dir) return { version: null, dir: null };
  const pj = readPackageJson(dir);
  return { version: pj?.version ?? null, dir };
}

export function describeProject(root: string, manual = false): ProjectInfo {
  const abs = resolve(root);
  const pj = readPackageJson(abs);
  const kit = installedVersion(abs, '@trempel/kit');
  const scene = installedVersion(abs, '@trempel/scene');
  return {
    id: projectId(abs),
    root: abs,
    name: pj?.name ?? basename(abs),
    kit: declared(pj, '@trempel/kit') !== null || kit.version ? kit.version ?? declared(pj, '@trempel/kit') : null,
    scene: declared(pj, '@trempel/scene') !== null || scene.version ? scene.version ?? declared(pj, '@trempel/scene') : null,
    kitDir: declared(pj, '@trempel/kit') !== null ? kit.dir : null,
    hasProjectFile: existsSync(join(abs, PROJECT_FILE)),
    manual,
    label: pj?.name ?? basename(abs),
  };
}

/** 2.4.1: labels of a list — a name shared by several projects gets the folder (`name · folder`; the path if even that repeats). */
export function labelProjects<T extends ProjectInfo>(list: T[]): T[] {
  const count = (key: (p: T) => string): Map<string, number> => {
    const m = new Map<string, number>();
    for (const p of list) m.set(key(p), (m.get(key(p)) ?? 0) + 1);
    return m;
  };
  const names = count((p) => p.name);
  const withFolder = (p: T): string => (basename(p.root) === p.name ? p.name : `${p.name} · ${basename(p.root)}`);
  const folders = count(withFolder);
  for (const p of list) {
    if (names.get(p.name)! < 2) p.label = p.name;
    else if (folders.get(withFolder(p))! < 2) p.label = withFolder(p);
    else p.label = `${p.name} · ${p.root}`;
  }
  return list;
}

const SKIP = /^(?:node_modules|dist|dist-.*|build|coverage|test-results|playwright-report)$/;

/** Projects under the roots (a project's own subfolders are not searched further) and the manual ones. */
export function scanProjects(roots: string[], manual: string[], depth = 2): ProjectInfo[] {
  const found = new Map<string, ProjectInfo>();
  const add = (dir: string, isManual: boolean): void => {
    const info = describeProject(dir, isManual);
    if (!found.has(info.id)) found.set(info.id, info);
    else if (isManual) found.get(info.id)!.manual = true;
  };
  const walk = (dir: string, left: number): void => {
    let ents;
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (e.name.startsWith('.') || SKIP.test(e.name)) continue;
      const p = join(dir, e.name);
      if (!(e.isDirectory() || (e.isSymbolicLink() && isDir(p)))) continue;
      if (isProject(p)) add(p, false);
      else if (left > 1) walk(p, left - 1);
    }
  };
  for (const r of roots) {
    if (!isDir(r)) continue;
    if (isProject(r)) add(r, false);
    else walk(r, depth);
  }
  for (const m of manual) if (isDir(m)) add(m, true);
  return labelProjects([...found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.root.localeCompare(b.root)));
}

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((res) => {
    execFile('git', args, { cwd, timeout: 10_000, maxBuffer: 8 << 20 }, (err, stdout) => res(err ? null : stdout));
  });
}

/** Branch, dirty, ahead/behind of the repository holding `root`; null — not in a repository. */
export async function gitState(root: string): Promise<GitState | null> {
  const out = await git(root, ['status', '--porcelain=v2', '--branch', '--untracked-files=normal', '.']);
  if (out === null) return null;
  const st: GitState = { branch: null, dirty: false, changes: 0, ahead: 0, behind: 0, upstream: null };
  for (const line of out.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      const b = line.slice(14).trim();
      st.branch = b === '(detached)' ? null : b;
    } else if (line.startsWith('# branch.upstream ')) st.upstream = line.slice(18).trim();
    else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) {
        st.ahead = Number(m[1]);
        st.behind = Number(m[2]);
      }
    } else if (line && !line.startsWith('#')) st.changes++;
  }
  st.dirty = st.changes > 0;
  return st;
}
