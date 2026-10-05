// props.ts — v0.8 presentation attributes of the base (vanilla SVG / data-*), renderer-agnostic:
//
//   - style="mix-blend-mode: normal | plus-lighter | multiply | screen" on g / image / geometry —
//     the only property the format reads from `style`; anything else there is an error
//     («стили — атрибутами»). A group's mode is inherited by its subtree (a child's own mode wins);
//   - data-tint="#rrggbb" on image and g (a group tints every <image> of its subtree; white = none);
//   - data-z="<int>" on any drawn node: order among its siblings (siblings without it keep their
//     document index);
//   - data-views="name:href, name:href" on image: named sprite variants (the clip column `view`,
//     MountedScene.setView); the href attribute itself is the default;
//   - data-pivot="x y" on any drawn node: the point (in the node's own user space, before its
//     transform; for image/rect/text — where x/y/width/height live) rotation and scale turn around —
//     a property of the node (Unity/Cocos), not of the tree. The node's SVG matrix does not change.
//   - (v0.9.1) stroke-dasharray, stroke-dashoffset, stroke-linecap, stroke-linejoin, pathLength on
//     geometry (path, circle, ellipse, line, rect) — vanilla SVG, a strict subset: plain numbers (no
//     units, no percentages), caps butt | round | square, joins miter | round | bevel.
//
// tml:bind-style is not supported (switching blend modes is not a thing). Used by mount(), the CLI
// checker and the editor core; wording names the node (#id or <tag>).
//
// @internal — `@trempel/scene/internal/props`, for the kit and the editor: no stability promise.

import type { SceneNode } from './parser.js';
import { coded, within } from './codes.js';
import { trempelError } from './errors.js';
import { layoutErrors } from './layout.js';
import { walk } from './tree.js';

/** mix-blend-mode values of the format (CSS names) — the backend maps them (Pixi: normal/add/multiply/screen). */
export const BLEND_MODES: readonly string[] = ['normal', 'plus-lighter', 'multiply', 'screen'];

/** Tags whose style may carry mix-blend-mode (everything drawn except text). */
const BLEND_HOSTS = new Set(['g', 'image', 'rect', 'path', 'circle', 'ellipse', 'line']);
/** Tags that take data-tint. */
export const TINT_HOSTS = new Set(['g', 'image']);
/** Tags never drawn — data-z there means nothing. */
const UNDRAWN = new Set(['svg', 'defs', 'clipPath']);

/** Tags a dashed / capped / joined stroke lives on (v0.9.1). */
export const STROKE_HOSTS = new Set(['path', 'circle', 'ellipse', 'line', 'rect']);
export const LINE_CAPS: readonly string[] = ['butt', 'round', 'square'];
export const LINE_JOINS: readonly string[] = ['miter', 'round', 'bevel'];

const where = (n: SceneNode): string => (n.attrs.id ? `#${n.attrs.id}` : `<${n.tag}>`);

/** Declarations of a style attribute, in order ("a: b; c: d" → [[a, b], [c, d]]). */
function declarations(style: string): [string, string][] {
  return style
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      const i = d.indexOf(':');
      return i < 0 ? [d.toLowerCase(), ''] : [d.slice(0, i).trim().toLowerCase(), d.slice(i + 1).trim()];
    });
}

/**
 * The node's own mix-blend-mode (CSS name), or undefined. @throws Error for another property in
 * `style` or an unknown mode — the message lists what is allowed.
 */
export function parseBlend(style: string | undefined): string | undefined {
  if (style == null || style.trim() === '') return undefined;
  let mode: string | undefined;
  for (const [k, v] of declarations(style)) {
    if (k !== 'mix-blend-mode') {
      throw trempelError('E_STYLE', `style: "${k}" is not supported — styles are attributes (fill, opacity…); style holds only mix-blend-mode.`);
    }
    if (!BLEND_MODES.includes(v)) throw trempelError('E_BLEND', `mix-blend-mode: ${v || '(empty)'} — expected ${BLEND_MODES.join(', ')}.`);
    mode = v;
  }
  return mode;
}

/** "#rrggbb" (or "#rgb") → 0xRRGGBB. @throws Error for anything else. */
export function parseTint(value: string): number {
  const v = value.trim();
  let m = /^#([0-9a-f]{6})$/i.exec(v);
  if (m) return parseInt(m[1], 16);
  m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(v);
  if (m) return parseInt(m[1] + m[1] + m[2] + m[2] + m[3] + m[3], 16);
  throw trempelError('E_TINT', `data-tint="${value}" — expected a colour #rrggbb.`);
}

/** data-z → integer. @throws Error unless an integer. */
export function parseZ(value: string): number {
  const v = value.trim();
  if (!/^[-+]?\d+$/.test(v)) throw trempelError('E_Z', `data-z="${value}" — expected an integer.`);
  return Number(v);
}

/** data-pivot="x y" → point. @throws Error unless two numbers. */
export function parsePivot(value: string): { x: number; y: number } {
  const p = value.trim().split(/[\s,]+/).filter(Boolean).map(Number);
  if (p.length !== 2 || !p.every(Number.isFinite)) throw trempelError('E_PIVOT', `data-pivot="${value}" — expected "x y" (two numbers).`);
  return { x: p[0], y: p[1] };
}

const PLAIN_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/**
 * stroke-dasharray → lengths (user units), or null for `none` / a list that sums to zero (a solid
 * stroke, as in SVG). @throws Error for anything but non-negative plain numbers.
 */
export function parseDashArray(value: string): number[] | null {
  const v = value.trim();
  if (v === 'none') return null;
  const parts = v.split(/[\s,]+/).filter(Boolean);
  if (!parts.length || !parts.every((p) => PLAIN_NUMBER.test(p)) || parts.some((p) => Number(p) < 0)) {
    throw trempelError('E_STROKE', `stroke-dasharray="${value}" — expected non-negative numbers separated by spaces or commas (or none).`);
  }
  const dash = parts.map(Number);
  return dash.some((d) => d > 0) ? dash : null;
}

/** stroke-dashoffset / a number attribute → number. @throws Error unless a plain number. */
export function parseNumberAttr(name: string, value: string): number {
  if (!PLAIN_NUMBER.test(value.trim())) throw trempelError(name.startsWith('stroke') ? 'E_STROKE' : 'E_NUMBER', `${name}="${value}" — expected a number.`);
  return Number(value.trim());
}

/** pathLength → a positive number. @throws Error otherwise. */
export function parsePathLength(value: string): number {
  const v = PLAIN_NUMBER.test(value.trim()) ? Number(value.trim()) : NaN;
  if (!(v > 0)) throw trempelError('E_STROKE', `pathLength="${value}" — expected a positive number.`);
  return v;
}

/** stroke-linecap / stroke-linejoin → the value. @throws Error with the list for anything else. */
export function parseLineStyle(name: 'stroke-linecap' | 'stroke-linejoin', value: string): string {
  const allowed = name === 'stroke-linecap' ? LINE_CAPS : LINE_JOINS;
  const v = value.trim();
  if (!allowed.includes(v)) throw trempelError('E_STROKE', `${name}="${value}" — expected ${allowed.join(', ')}.`);
  return v;
}

/** v0.9.1 stroke attribute problems of one node (wording without the node's name). */
export function strokeErrors(tag: string, attrs: Record<string, string>): string[] {
  const errors: string[] = [];
  const keys = ['stroke-dasharray', 'stroke-dashoffset', 'stroke-linecap', 'stroke-linejoin', 'pathLength'] as const;
  for (const k of keys) {
    const v = attrs[k];
    if (v == null) continue;
    if (!STROKE_HOSTS.has(tag)) {
      errors.push(coded('E_STROKE', `${k} on <${tag}> is not supported — only on ${[...STROKE_HOSTS].join(', ')}.`));
      continue;
    }
    try {
      if (k === 'stroke-dasharray') parseDashArray(v);
      else if (k === 'stroke-dashoffset') parseNumberAttr(k, v);
      else if (k === 'pathLength') parsePathLength(v);
      else parseLineStyle(k, v);
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  return errors;
}

/** data-views → ordered name → href. @throws Error on a malformed entry or a repeated name. */
export function parseViews(value: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of value.split(',')) {
    const part = raw.trim();
    if (!part) continue;
    const i = part.indexOf(':');
    const name = i < 0 ? '' : part.slice(0, i).trim();
    const href = i < 0 ? '' : part.slice(i + 1).trim();
    if (!name || !href) throw trempelError('E_VIEWS', `data-views: "${part}" — expected name:href (e.g. front:art/head-f.png).`);
    if (!/^[\w.-]+$/.test(name)) throw trempelError('E_VIEWS', `data-views: the name "${name}" — letters, digits, _ . -`);
    if (out.has(name)) throw trempelError('E_VIEWS', `data-views: the name "${name}" twice.`);
    out.set(name, href);
  }
  if (!out.size) throw trempelError('E_VIEWS', 'data-views is empty — expected "name:href, name:href".');
  return out;
}

/**
 * The image a view / tex / tint write lands on: the node itself if it is an <image>, else its only
 * <image> descendant; null when there are none or several.
 */
export function singleImage(n: SceneNode): SceneNode | null {
  if (n.tag === 'image') return n;
  const found: SceneNode[] = [];
  walk(n, (x) => {
    if (x.tag === 'image') found.push(x);
  });
  return found.length === 1 ? found[0] : null;
}

/** All v0.8 attribute problems of a (merged) tree, phrased for a human (v1.0: + layout — layout.ts). */
export function propErrors(tree: SceneNode): string[] {
  const errors: string[] = layoutErrors(tree);
  walk(tree, (n) => {
    const w = where(n);
    const style = n.attrs.style;
    if (style != null) {
      try {
        const mode = parseBlend(style);
        if (mode !== undefined && !BLEND_HOSTS.has(n.tag)) {
          errors.push(coded('E_BLEND', `${w}: mix-blend-mode on <${n.tag}> is not supported — only on ${[...BLEND_HOSTS].join(', ')}.`));
        }
      } catch (e) {
        errors.push(within(w, (e as Error).message));
      }
    }
    if (n.tml['bind-style'] !== undefined) {
      errors.push(coded('E_BIND_STYLE', `${w}: tml:bind-style is not supported — the blend mode is set in the base and does not switch.`));
    }
    const tint = n.attrs['data-tint'];
    if (tint != null) {
      if (!TINT_HOSTS.has(n.tag)) errors.push(coded('E_TINT', `${w}: data-tint on <${n.tag}> is not supported — only on <image> and <g>.`));
      else {
        try {
          parseTint(tint);
        } catch (e) {
          errors.push(within(w, (e as Error).message));
        }
      }
    }
    const z = n.attrs['data-z'];
    if (z != null) {
      if (UNDRAWN.has(n.tag)) errors.push(coded('E_Z', `${w}: data-z on <${n.tag}> means nothing — the node is not drawn.`));
      else {
        try {
          parseZ(z);
        } catch (e) {
          errors.push(within(w, (e as Error).message));
        }
      }
    }
    const pivot = n.attrs['data-pivot'];
    if (pivot != null) {
      if (UNDRAWN.has(n.tag)) errors.push(coded('E_PIVOT', `${w}: data-pivot on <${n.tag}> means nothing — the node is not drawn.`));
      else {
        try {
          parsePivot(pivot);
        } catch (e) {
          errors.push(within(w, (e as Error).message));
        }
      }
    }
    for (const e of strokeErrors(n.tag, n.attrs)) errors.push(within(w, e));
    const views = n.attrs['data-views'];
    if (views != null) {
      if (n.tag !== 'image') errors.push(coded('E_VIEWS', `${w}: data-views on <${n.tag}> is not supported — only on <image>.`));
      else {
        try {
          parseViews(views);
        } catch (e) {
          errors.push(within(w, (e as Error).message));
        }
      }
    }
  });
  return errors;
}
