// href.ts — resolve an asset href against the scene document's URL, browser-style.
//
// `base` is the document's URL or path ("scenes/ui/game.svg", "https://cdn/x/scene.svg"); a
// trailing "/" marks a directory. Absolute hrefs (scheme:, //host, /path, #frag) are left alone.
// Relative bases are resolved as paths (no origin needed), absolute ones with the URL API.
//
// v1.1 collections: `@name/path` is a file of the collection `name` (`.trempel/project.mdz` → a
// folder). Such an href is a root of its own: it stays `@name/…` (normalized) against any base, and
// relative hrefs written in a collection document (base `@skin/button.svg`) stay inside it
// (`art/x.png` → `@skin/art/x.png`; `..` never climbs above `@skin`). `expandCollection` turns it
// into `<URL of the collection folder>/path` — before baseUrl / the host's resolveHref.
//
// @internal — `@trempel/scene/internal/href`, for the kit and the editor: no stability promise.
// Stable (re-exported by @trempel/scene): expandCollection.

import { trempelError } from './errors.js';

const ABSOLUTE = /^(?:[a-zA-Z][a-zA-Z\d+.-]*:|\/|#)/;
const HAS_SCHEME = /^[a-zA-Z][a-zA-Z\d+.-]*:/;
/** `@name/…` — a collection href; name `[a-z][a-z0-9-]*`. */
const COLLECTION = /^@([a-z][a-z0-9-]*)(?:\/|$)/;

/** A collection name is `[a-z][a-z0-9-]*`. */
export const COLLECTION_NAME = /^[a-z][a-z0-9-]*$/;

/** The collection an href points into (`@skin/panel.svg` → `skin`), or null. */
export function collectionOf(href: string): string | null {
  return COLLECTION.exec(href)?.[1] ?? null;
}

/** Normalize `dir + href` path segments under `root` ('' | '/' | '@name/'); `..` never leaves the root. */
function joinPath(root: string, dir: string, href: string): string {
  const out: string[] = [];
  for (const seg of `${dir}${href}`.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..' && out.length && out[out.length - 1] !== '..') out.pop();
    else if (seg === '..' && root) continue;
    else out.push(seg);
  }
  const path = out.join('/');
  const trailing = href.endsWith('/') && path ? '/' : '';
  return `${root}${path}${trailing}`;
}

export function resolveHref(href: string, base: string | undefined): string {
  if (href === '') return href;
  const own = COLLECTION.exec(href);
  if (own) return joinPath(`@${own[1]}/`, '', href.slice(own[0].length));
  if (!base || ABSOLUTE.test(href)) return href;
  if (HAS_SCHEME.test(base)) return new URL(href, base).href;

  const coll = COLLECTION.exec(base);
  const root = coll ? `@${coll[1]}/` : base.startsWith('/') ? '/' : '';
  const rest = base.slice(coll ? coll[0].length : 0);
  const dir = rest.slice(0, rest.lastIndexOf('/') + 1); // "" when base has no directory part
  return joinPath(root, dir, href);
}

/**
 * The message of an unknown collection, without its code (`E_COLLECTION_UNKNOWN` — one wording for
 * the runtime, the checker and the tools).
 */
export function unknownCollection(name: string, collections: Record<string, string> | undefined): string {
  const known = Object.keys(collections ?? {}).sort();
  return `the project has no collection @${name} (collections: ${known.length ? known.map((k) => `@${k}`).join(', ') : '—'}) — collections are declared in .trempel/project.mdz (## collections).`;
}

/**
 * `@name/path` → `<collections[name]>/path` (the folder URL as given: absolute, or relative to the
 * scene document — baseUrl resolves it next); any other href as is. @throws for an unknown name.
 */
export function expandCollection(href: string, collections: Record<string, string> | undefined): string {
  const m = COLLECTION.exec(href);
  if (!m) return href;
  const url = collections && Object.prototype.hasOwnProperty.call(collections, m[1]) ? collections[m[1]] : undefined;
  if (url == null) throw trempelError('E_COLLECTION_UNKNOWN', unknownCollection(m[1], collections));
  const path = resolveHref(href, undefined).slice(m[1].length + 2);
  return url.endsWith('/') ? `${url}${path}` : `${url}/${path}`;
}
