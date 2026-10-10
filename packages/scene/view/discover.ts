// discover.ts — find Trempel scenes in a folder listing (pure: takes relative paths, no fs).
//
// A scene is named by its stem X (path relative to the folder, without extension):
//   X.svg           — sterile base (required to render)
//   X.tml.svg       — heir (optional; a base alone is a scene too)
//   X.contract.xml  — contract (optional)
//   X.state.json    — stand-in state for the viewer (optional)
// A heir without its base is still listed (the viewer reports the missing base), a lone contract
// or state file is not a scene.

import { HEIR_EXT, LEGACY } from '../src/compat.js';

export interface SceneEntry {
  /** Stem relative to the folder, '/'-separated, e.g. `popups/map`. */
  id: string;
  base?: string;
  heir?: string;
  contract?: string;
  state?: string;
}

const KINDS: [suffix: string, key: keyof Omit<SceneEntry, 'id'>][] = [
  [HEIR_EXT, 'heir'],
  [LEGACY.heirExt, 'heir'],
  ['.contract.xml', 'contract'],
  ['.state.json', 'state'],
  ['.svg', 'base'],
];

/** Group relative file paths into scenes, sorted by id. */
export function discoverScenes(files: string[]): SceneEntry[] {
  const byId = new Map<string, SceneEntry>();
  for (const raw of files) {
    const file = raw.replace(/\\/g, '/');
    const kind = KINDS.find(([suffix]) => file.endsWith(suffix));
    if (!kind) continue;
    const id = file.slice(0, -kind[0].length);
    if (!id || id.endsWith('/')) continue;
    const entry = byId.get(id) ?? { id };
    entry[kind[1]] = file;
    byId.set(id, entry);
  }
  return [...byId.values()]
    .filter((s) => s.base || s.heir)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Folders the scan never enters. */
export const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);

/**
 * 2.3.1: a service folder — one of SKIP_DIRS, any build output `dist-*` (a game's `dist-web/`,
 * `dist-yt/` inside its scene folder) or a dot-folder (`.trempel`, `.git`, `.cache`…).
 */
export const isServiceDir = (name: string): boolean => SKIP_DIRS.has(name) || name.startsWith('dist-') || name.startsWith('.');

/**
 * Clip files (md clips) of a scene, by convention: `anim/*.md` next to the scene (v0.7) and
 * `*.anim.md` in the scene's folder (v0.8 — what an animation importer writes: `el_nine.anim.md`).
 */
export function clipFiles(files: string[], sceneId: string): string[] {
  const dir = sceneId.includes('/') ? sceneId.slice(0, sceneId.lastIndexOf('/') + 1) : '';
  return files.filter((raw) => {
    const f = raw.replace(/\\/g, '/');
    if (!f.startsWith(dir) || !f.endsWith('.md')) return false;
    const rest = f.slice(dir.length);
    return (rest.startsWith('anim/') && !rest.slice(5).includes('/')) || (rest.endsWith('.anim.md') && !rest.includes('/'));
  });
}
