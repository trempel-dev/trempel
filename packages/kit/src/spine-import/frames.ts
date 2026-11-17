// frames.ts — a clip frozen at time t as a static Trempel scene: scene.svg mounted on the headless
// backend, the clip played by Trempel's Animator up to t, every node written back with the pose the
// player gave it (groups — transform matrix, opacity, tint, z; images — href, opacity). The result is
// an ordinary base scene any viewer draws (view:shot of the scene with --clip --t does the same live).

import { compileClips, parse, type AnimClip } from '@trempel/scene';
import { localOf } from '../clip-import/headless.js';
import { playHeadless } from '../clip-import/play.js';
import { fmt, hexColor } from '../clip-import/tables.js';
import { defaultHref } from './rig.js';

interface Node {
  tag: string;
  attrs: Record<string, string>;
  children: Node[];
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function serialize(n: Node, depth: number, out: string[]): void {
  const pad = '  '.repeat(depth);
  const attrs = Object.entries(n.attrs)
    .map(([k, v]) => ` ${k}="${esc(v)}"`)
    .join('');
  if (!n.children.length) {
    out.push(`${pad}<${n.tag}${attrs}/>`);
    return;
  }
  out.push(`${pad}<${n.tag}${attrs}>`);
  for (const c of n.children) serialize(c, depth + 1, out);
  out.push(`${pad}</${n.tag}>`);
}

/** All clips of the md, compiled against the scene (tex → art/<region>.png). */
export function clipsOf(svg: string, md: string): Record<string, AnimClip> {
  return compileClips(md, parse(svg), { tex: defaultHref });
}

/**
 * The scene posed at `t` seconds of `clip`. `href` maps the clip's hrefs (art/x.png) for a frame
 * file that lives elsewhere (e.g. `../art/x.png`).
 */
export function posedSvg(svg: string, clip: AnimClip, t: number, href: (h: string) => string = (h) => h): string {
  const play = playHeadless(svg, clip);
  play.at(t);
  const tree = parse(svg) as unknown as Node;
  const visit = (n: Node): void => {
    const id = n.attrs.id;
    const h = id ? play.node(id) : undefined;
    if (h && n.tag === 'g') {
      const [a, b, c, d, e, f] = localOf(h);
      const identity = fmt(a) === '1' && fmt(b) === '0' && fmt(c) === '0' && fmt(d) === '1' && fmt(e) === '0' && fmt(f) === '0';
      if (identity) delete n.attrs.transform;
      else n.attrs.transform = `matrix(${[a, b, c, d, e, f].map((v) => fmt(v, 5)).join(' ')})`;
      if (h.z !== undefined) n.attrs['data-z'] = String(h.z);
    }
    if (h) {
      if (fmt(h.alpha) === '1') delete n.attrs.opacity;
      else n.attrs.opacity = fmt(h.alpha);
      if (n.tag === 'image' && h.tint !== 0xffffff) n.attrs['data-tint'] = hexColor(((h.tint >> 16) & 255) / 255, ((h.tint >> 8) & 255) / 255, (h.tint & 255) / 255);
      if (n.tag === 'g') delete n.attrs['data-tint'];
    }
    if (n.tag === 'image' && n.attrs.href) n.attrs.href = href(h?.href ?? n.attrs.href);
    n.children.forEach(visit);
  };
  visit(tree);
  tree.attrs = { xmlns: 'http://www.w3.org/2000/svg', ...tree.attrs };
  const out: string[] = [];
  serialize(tree, 0, out);
  return out.join('\n') + '\n';
}
