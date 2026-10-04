// href.ts — resolve an asset href against the scene document's URL, browser-style.
//
// `base` is the document's URL or path ("scenes/ui/game.svg", "https://cdn/x/scene.svg"); a
// trailing "/" marks a directory. Absolute hrefs (scheme:, //host, /path, #frag) are left alone.
// Relative bases are resolved as paths (no origin needed), absolute ones with the URL API.

const ABSOLUTE = /^(?:[a-zA-Z][a-zA-Z\d+.-]*:|\/|#)/;
const HAS_SCHEME = /^[a-zA-Z][a-zA-Z\d+.-]*:/;

export function resolveHref(href: string, base: string | undefined): string {
  if (!base || href === '' || ABSOLUTE.test(href)) return href;
  if (HAS_SCHEME.test(base)) return new URL(href, base).href;

  const dir = base.slice(0, base.lastIndexOf('/') + 1); // "" when base has no directory part
  const rooted = dir.startsWith('/');
  const out: string[] = [];
  for (const seg of `${dir}${href}`.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..' && out.length && out[out.length - 1] !== '..') out.pop();
    else if (seg === '..' && rooted) continue;
    else out.push(seg);
  }
  const path = out.join('/');
  const trailing = href.endsWith('/') && path ? '/' : '';
  return `${rooted ? '/' : ''}${path}${trailing}`;
}
