// scene-table.ts — the game's scene documents for prefabs (`<use href>`) and tml:extends chains,
// as the kit's Vite plugin collects them: every scene of the project that a screen can reach (its
// own folders and the collections of `.trempel/project.mdz`), the project heirs of collection
// documents and the collection names. The plugin's module puts the table on `globalThis` before
// the game's code runs (an injected <script type="module">); the game configures nothing.
//
// Paths: from the project root (`scenes/ui/card.tml.svg`), collection files as `@name/path`.
// A screen whose source is in the table mounts with its path — prefab hrefs resolve from it like
// in the Node tools (view, check); a source that is not (tests, the kit's own scenes) mounts as
// before, without a loader.

import type { SceneLoader } from '@trempel/scene';

export interface SceneTable {
  /** Scenes by stem from the project root (`scenes/ui/card`, collections as `@ui/ui/card`): [base, heir, contract] texts. */
  scenes: Record<string, [string | undefined, string | undefined, string | undefined]>;
  /** Project heirs: collection document (`@ui/ui/card.svg`) → the heir's scene path (`scenes/ui/card.svg`). */
  heirs: Record<string, string>;
  /** The project's collection names. */
  collections: string[];
}

/** The global the plugin's module writes (`globalThis.TREMPEL_SCENE_TABLE`). */
export const SCENE_TABLE_KEY = 'TREMPEL_SCENE_TABLE';

/** The table of the running page (the kit's Vite plugin), or null. */
export function sceneTable(): SceneTable | null {
  return ((globalThis as Record<string, unknown>)[SCENE_TABLE_KEY] as SceneTable | undefined) ?? null;
}

/** Install a table (the plugin's module; tests). */
export function setSceneTable(t: SceneTable | null): void {
  (globalThis as Record<string, unknown>)[SCENE_TABLE_KEY] = t ?? undefined;
}

/** The scene path of a source in the table (its heir's or base's text), e.g. `scenes/album.svg`; null — not there. */
export function scenePathOf(table: SceneTable, src: { base?: string; heir?: string }): string | null {
  for (const [stem, [base, heir]] of Object.entries(table.scenes)) {
    if ((src.heir != null && heir === src.heir) || (src.base != null && base === src.base)) return `${stem}.svg`;
  }
  return null;
}

/**
 * A synchronous loader over the table: a scene path (`scenes/ui/card.svg`, `@ui/ui/card.svg`) → its
 * base, heir and contract. The screen mounts with the collections as names (`@ui` → `@ui`), so
 * collection hrefs reach the loader as written; images go through the kit's resolver, which expands
 * the game's collection URLs.
 */
export function tableLoader(table: SceneTable): SceneLoader {
  return (url) => {
    const s = table.scenes[url.replace(/^\.\//, '').replace(/\.svg$/, '')];
    if (!s || (s[0] == null && s[1] == null)) return null;
    return { base: s[0], heir: s[1], contract: s[2] };
  };
}

/** The collections as names (`{ ui: '@ui' }`): `@name/…` stays as written for the loader and the kit's resolver. */
export function tableCollections(table: SceneTable): Record<string, string> {
  return Object.fromEntries(table.collections.map((n) => [n, `@${n}`]));
}

/** The project heirs for one scene: hrefs from its folder (MountOptions.heirs). */
export function tableHeirs(table: SceneTable, scenePath: string): Record<string, string> {
  const from = scenePath.split('/').slice(0, -1);
  const out: Record<string, string> = {};
  for (const [doc, path] of Object.entries(table.heirs)) {
    const to = path.split('/');
    let i = 0;
    while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
    out[doc] = [...from.slice(i).map(() => '..'), ...to.slice(i)].join('/');
  }
  return out;
}
