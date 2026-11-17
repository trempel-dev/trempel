// clip-files.ts — which md clip files belong to which scene (2.3.1). Pure: relative paths in, no fs.
//
// Clip files live next to their scenes: `anim/*.md` in the scene's folder and `*.anim.md` beside it.
// A file named after a scene of that folder — `anim/<scene>.md` or `<scene>.anim.md` — is bound to
// that scene and compiled only against it. Any other clip file of the folder is shared: compiled
// against every scene of the folder (the rule before 2.3.1, kept for compatibility).

const norm = (p: string): string => p.replace(/\\/g, '/');

/** The folder part of a scene id or a file path, with the trailing '/' ('' at the top). */
const folderOf = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');

/**
 * A clip file relative to the folder the scenes are listed from: its scene folder and the scene name
 * its file name gives (`popups/anim/win.md` → `popups/` + `win`; `popups/win.anim.md` → the same).
 * null — not a clip file (not `anim/*.md`, not `*.anim.md`).
 */
export function clipFileName(file: string): { folder: string; name: string } | null {
  const f = norm(file);
  if (!f.endsWith('.md')) return null;
  const parts = f.split('/');
  const base = parts.at(-1)!;
  if (parts.length >= 2 && parts.at(-2) === 'anim') {
    return { folder: parts.slice(0, -2).map((p) => `${p}/`).join(''), name: base.slice(0, -'.md'.length) };
  }
  if (base.endsWith('.anim.md')) return { folder: folderOf(f), name: base.slice(0, -'.anim.md'.length) };
  return null;
}

/**
 * The scene a clip file is bound to, given the scene ids of the listing (`popups/win`): the scene of
 * the file's folder named like the file, else null — a shared file.
 */
export function clipFileScene(file: string, sceneIds: Iterable<string>): string | null {
  const c = clipFileName(file);
  if (!c) return null;
  const id = c.folder + c.name;
  for (const s of sceneIds) if (s === id) return id;
  return null;
}

/**
 * Clip files of a scene among `files` (relative paths of the listing): `anim/*.md` and `*.anim.md`
 * of the scene's folder, minus the files bound to another scene of that folder. `sceneIds` — every
 * scene of the listing (a file named after no scene stays shared).
 */
export function sceneClipFiles(files: string[], sceneId: string, sceneIds: Iterable<string>): string[] {
  const ids = new Set(sceneIds);
  const dir = folderOf(sceneId);
  return files.filter((raw) => {
    const c = clipFileName(raw);
    if (!c || c.folder !== dir) return false;
    const bound = ids.has(c.folder + c.name) ? c.folder + c.name : null;
    return bound === null || bound === sceneId;
  });
}

/** Whether a clip file of a scene is shared (not named after it): the scene id and the file, both relative to one folder. */
export function isSharedClipFile(file: string, sceneId: string): boolean {
  const c = clipFileName(file);
  return !c || c.folder + c.name !== norm(sceneId);
}

/**
 * The error panel's hint for a target error (E_ANIM_TARGET) from a shared clip file: the file is
 * compiled against every scene of the folder; naming it after its scene binds it.
 */
export function sharedClipHint(file: string, sceneId: string, error: string): string {
  if (!error.startsWith('E_ANIM_TARGET') || !isSharedClipFile(file, sceneId)) return error;
  return `${error} (${norm(file)} is a shared clip file — compiled against every scene of its folder; name it after the scene it animates, anim/<scene>.md or <scene>.anim.md, to compile it only there)`;
}
