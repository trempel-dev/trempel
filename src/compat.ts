// compat.ts — the previous names of the format, accepted for one release with a deprecation warning.
// Format only (files and documents), not the API. Everything old lives here; `node
// scripts/migrate-tml.mjs <folder>` renames a consumer's files and namespace for good.
//
//   prefix `gml:` and its namespace URI         → `tml:`, https://trempel.dev/ns/scene
//   heir `X.gml.svg`                             → `X.tml.svg`
//   consumer module `gameml.view.ts`             → `trempel.view.ts`
//   editor project folder `.gml/` (macros)       → `.trempel/`

export const NS = 'https://trempel.dev/ns/scene';
export const HEIR_EXT = '.tml.svg';
export const VIEW_MODULE = 'trempel.view.ts';
export const PROJECT_DIR = '.trempel';

/** The old names, for tools that look for them (the migration script, listings). */
export const LEGACY = {
  prefix: 'gml',
  ns: 'http://gameml.dev/ns',
  heirExt: '.gml.svg',
  viewModule: 'gameml.view.ts',
  projectDir: '.gml',
} as const;

const told = new Set<string>();
let sink: (message: string) => void = (m) => console.warn(m);

/** Where deprecation warnings go (default console.warn); each distinct message is reported once. */
export function onDeprecated(fn: (message: string) => void): void {
  sink = fn;
  told.clear();
}

function deprecated(message: string): void {
  if (told.has(message)) return;
  told.add(message);
  sink(`Trempel: устарело — ${message} (переименование: node scripts/migrate-tml.mjs <папка>)`);
}

const LEGACY_TAG = /(<\/?)gml:/g;
const LEGACY_ATTR = /(\s)gml:([A-Za-z_][\w.-]*\s*=)/g;
const LEGACY_XMLNS = /(\s)xmlns:gml(\s*=\s*)(["'])[^"']*\3/g;
const LEGACY_NS = /(\s)xmlns:tml(\s*=\s*)(["'])http:\/\/gameml\.dev\/ns\3/g;

/** A scene document with the old prefix / namespace rewritten to `tml:` (warns); others as is. */
export function upgradeDocument(src: string): string {
  if (!src.includes('gml:') && !src.includes('gameml.dev/ns')) return src;
  const out = src
    .replace(LEGACY_XMLNS, `$1xmlns:tml$2$3${NS}$3`)
    .replace(LEGACY_NS, `$1xmlns:tml$2$3${NS}$3`)
    .replace(LEGACY_TAG, '$1tml:')
    .replace(LEGACY_ATTR, '$1tml:$2');
  if (out !== src) deprecated(`префикс gml: и xmlns ${LEGACY.ns} — пишите tml: и xmlns:tml="${NS}"`);
  return out;
}

/** Heir file name of a stem: `X.tml.svg`. */
export const heirFile = (stem: string): string => `${stem}${HEIR_EXT}`;

/** Is `file` an heir (current or old name)? */
export const isHeirFile = (file: string): boolean => file.endsWith(HEIR_EXT) || file.endsWith(LEGACY.heirExt);

/** The heir suffix `file` ends with (current or old), or null. */
export const heirSuffix = (file: string): string | null =>
  file.endsWith(HEIR_EXT) ? HEIR_EXT : file.endsWith(LEGACY.heirExt) ? LEGACY.heirExt : null;

/** Read the heir of a stem: `X.tml.svg`, else the old `X.gml.svg` (warns). `get` — undefined/null when absent. */
export function readHeir<T extends string | null | undefined>(get: (path: string) => T, stem: string): T {
  const own = get(heirFile(stem));
  if (own != null) return own;
  const old = get(`${stem}${LEGACY.heirExt}`);
  if (old != null) deprecated(`${stem}${LEGACY.heirExt} — переименуйте в ${heirFile(stem)}`);
  return old;
}

/** readHeir for an async `get`. */
export async function readHeirAsync<T extends string | null | undefined>(get: (path: string) => Promise<T>, stem: string): Promise<T> {
  const own = await get(heirFile(stem));
  if (own != null) return own;
  const old = await get(`${stem}${LEGACY.heirExt}`);
  if (old != null) deprecated(`${stem}${LEGACY.heirExt} — переименуйте в ${heirFile(stem)}`);
  return old;
}

/** Consumer module names in the order they are looked for: `trempel.view.ts`, then the old one. */
export const VIEW_MODULES = [VIEW_MODULE, LEGACY.viewModule] as const;

/** Warn that a found module / folder has the old name. */
export function legacyName(found: string): void {
  if (found.endsWith(LEGACY.viewModule)) deprecated(`${LEGACY.viewModule} — переименуйте в ${VIEW_MODULE}`);
  else if (found.split('/').includes(LEGACY.projectDir)) deprecated(`папка ${LEGACY.projectDir}/ — переименуйте в ${PROJECT_DIR}/`);
}

/** Editor project folders (macros live in `<dir>/macros`): `.trempel`, then the old `.gml`. */
export const PROJECT_DIRS = [PROJECT_DIR, LEGACY.projectDir] as const;

/** Stem of a scene file: `X.svg`, `X.tml.svg` (or the old heir name) → `X`. */
export const sceneStem = (file: string): string => file.replace(/(\.tml|\.gml)?\.svg$/, '');
