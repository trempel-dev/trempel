// flatten.ts — v1.1: a Trempel scene → one vanilla SVG that any browser (and Figma) draws.
// Renderer-agnostic and without I/O: the CLI (node/flatten-cli.ts) reads the files, measures the
// pictures and maps hrefs to the output's place.
//
// The scene is built by the runtime itself (composeScene + mountTree) over a recording backend, so
// the output is what mount() would draw at the scene's own size:
//   - the heir merged, prefab instances expanded into `<g>` (ids with the instance prefix), slots filled;
//   - anchors / stretches laid out for the viewBox (resizable instances at their width/height) and
//     written as coordinates; data-* and tml:* dropped;
//   - expressions evaluated at a state (--state / X.state.json) and instance parameters (`self`); an
//     expression that reads a name nobody provides (no state, a host function like `t`) keeps the
//     base's value (its layout copy);
//   - <image data-slices> → 9 nested `<svg viewBox>` pieces of the one picture (the raster is not cut,
//     borders scale down like Pixi's NineSliceSprite when the box is too small); data-tile → <pattern>;
//     an image's box is stretched like the runtime does it (preserveAspectRatio="none");
//   - data-tint → an feColorMatrix filter (multiply, as Pixi's tint); data-z → sibling order;
//     clip-path → a <clipPath> per use;
//   - what vanilla SVG cannot do (components with code, clips, bound transforms) stays as in the
//     base, listed in `warnings`.
//
// @internal — `@trempel/scene/internal/flatten`, for the kit and the editor: no stability promise.
// Stable (re-exported by @trempel/scene): flattenScene, FlattenInput, FlattenResult.

import { bindingErrors, isExprKey } from './binding.js';
import { coded } from './codes.js';
import { TrempelError } from './errors.js';
import { expandCollection, resolveHref } from './href.js';
import { exprNames, sceneNames } from './names.js';
import { parseAxes, parseSlices } from './layout.js';
import { composeScene, type SceneLoader } from './prefab.js';
import { collectionErrors, usedCollections } from './project.js';
import { reactive } from './reactive.js';
import type { ClipShape, NodeHandle, RendererBackend } from './render/backend.js';
import { mountTree } from './scene.js';
import { geometryErrors } from './geom/check.js';
import { propErrors } from './props.js';
import { localMatrix } from './transform.js';
import { walk } from './tree.js';

export interface FlattenInput {
  base?: string;
  heir?: string;
  contract?: string;
  /** The scene's path (its file name: cycles of tml:extends). */
  path?: string;
  /** Prefab documents (synchronous): url → { base, heir?, contract? }. */
  loadScene?: SceneLoader;
  /**
   * URL (or absolute path) of the scene document: image hrefs resolve against it (and prefab hrefs,
   * unless `sceneUrl`). Collections expand first.
   */
  baseUrl?: string;
  /** Collections: name → folder URL / absolute path. */
  collections?: Record<string, string>;
  /**
   * The stand-in state (X.state.json / --state). Undefined — no state: only expressions of instance
   * parameters run, everything else keeps the base's values.
   */
  state?: Record<string, unknown>;
  /** Extra context next to `state` (texts, functions); other names are stubs returning undefined. */
  context?: Record<string, unknown>;
  /** Pixel size of a picture by its resolved href (9-slice, tiling, an image without width/height). */
  imageSize?: (href: string) => { w: number; h: number } | null;
  /** The href written into the output for a resolved one (relative to the output, a data: URI). Default: as is. */
  mapHref?: (href: string) => string;
  /** font-family on the root (the runtime's default font; PixiBackend draws Arial without one). */
  fontFamily?: string;
}

export interface FlattenResult {
  /** The vanilla SVG (null — nothing to draw: the scene does not compose). */
  svg: string | null;
  /** Scene problems (what mount() would refuse); the output is still written when it can be. */
  errors: string[];
  /** What vanilla SVG cannot carry, one line each. */
  warnings: string[];
  /** Collections the scene uses (sorted names). */
  collections: string[];
}

// ---- the recording backend ---------------------------------------------------------------------

interface Rec {
  tag: string;
  attrs: Record<string, string>;
  children: Rec[];
  text?: string;
  /** The node's own translation at build (Pixi position: transform + x/y) and the layout's shift of it. */
  e0: number;
  f0: number;
  dx: number;
  dy: number;
  hidden?: boolean;
  tint?: number;
  z?: number;
  clip?: ClipShape | null;
}

/** SVG presentation attributes a `tml:bind-<attr>` may write straight through. */
const PASS_ATTRS = new Set([
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray', 'stroke-dashoffset',
  'stroke-linecap', 'stroke-linejoin', 'opacity', 'font-size', 'font-family', 'font-weight', 'font-style', 'letter-spacing',
  'text-anchor', 'dominant-baseline', 'rx', 'ry', 'r', 'cx', 'cy', 'x1', 'y1', 'x2', 'y2', 'd', 'points', 'style',
]);

class RecordingBackend implements RendererBackend {
  readonly unsupported = new Set<string>();

  createNode(tag: string, attrs: Record<string, string>): NodeHandle {
    const m = localMatrix(attrs, tag === 'image' || tag === 'text' || tag === 'rect');
    const rec: Rec = { tag, attrs: { ...attrs }, children: [], e0: m[4], f0: m[5], dx: 0, dy: 0 };
    if (attrs.display === 'none' || attrs.visibility === 'hidden') rec.hidden = true;
    return rec;
  }

  setProp(node: NodeHandle, path: string, value: unknown): void {
    const rec = node as Rec;
    switch (path) {
      case 'text':
        rec.text = value == null ? '' : String(value);
        return;
      case 'href': {
        const img = imageOf(rec);
        if (img) img.attrs.href = String(value);
        return;
      }
      case 'visible':
        rec.hidden = !value;
        return;
      case 'display':
        rec.hidden = value === 'none' || value === false || value == null;
        return;
      case 'tint':
        rec.tint = Number(value);
        return;
      case 'mix-blend-mode':
        return; // the authored style="mix-blend-mode: …" is kept as written
      case 'z':
        rec.z = Number(value);
        return;
      case 'x':
        rec.dx = Number(value) - rec.e0;
        return;
      case 'y':
        rec.dy = Number(value) - rec.f0;
        return;
      case 'alpha':
        rec.attrs.opacity = String(value);
        return;
      case 'width':
      case 'height':
        rec.attrs[path] = fmt(Number(value));
        return;
    }
    if (PASS_ATTRS.has(path)) {
      rec.attrs[path] = String(value);
      return;
    }
    this.unsupported.add(`${rec.attrs.id ? `#${rec.attrs.id}` : `<${rec.tag}>`}: ${path}`);
  }

  getProp(node: NodeHandle, path: string): unknown {
    const rec = node as Rec;
    if (path === 'x') return rec.e0 + rec.dx;
    if (path === 'y') return rec.f0 + rec.dy;
    if (path === 'width' || path === 'height') return rec.attrs[path] != null ? Number(rec.attrs[path]) : undefined;
    return rec.attrs[path];
  }

  onClick(): void {}
  onPointer(): void {}
  addChild(parent: NodeHandle, child: NodeHandle): void {
    (parent as Rec).children.push(child as Rec);
  }
  mount(): void {}
  getBounds(): { x: number; y: number; w: number; h: number } {
    return { x: 0, y: 0, w: 0, h: 0 };
  }
  setClip(node: NodeHandle, clip: ClipShape | null): void {
    (node as Rec).clip = clip;
  }
}

/** The image an href write is for: the node itself, or a group's one image. */
function imageOf(rec: Rec): Rec | null {
  if (rec.tag === 'image') return rec;
  const found: Rec[] = [];
  const visit = (r: Rec): void => r.children.forEach((c) => (c.tag === 'image' ? found.push(c) : visit(c)));
  visit(rec);
  return found.length === 1 ? found[0] : null;
}

// ---- serialization -----------------------------------------------------------------------------

const fmt = (n: number): string => String(Math.round(n * 1e4) / 1e4);
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Attributes that never reach the output (format attributes, tool marks). */
const dropAttr = (k: string): boolean => k.startsWith('data-') || k === 'slot' || k.startsWith('tml:') || k.startsWith('xmlns');

/** `attrs` without `keys`. */
const omit = (attrs: Record<string, string>, keys: string[]): Record<string, string> =>
  Object.fromEntries(Object.entries(attrs).filter(([k]) => !keys.includes(k)));

const attrText = (attrs: Record<string, string | undefined>): string =>
  Object.entries(attrs)
    .filter(([k, v]) => v != null && !dropAttr(k))
    .map(([k, v]) => ` ${k}="${esc(v!)}"`)
    .join('');

class Writer {
  private readonly defs: string[] = [];
  private readonly tints = new Map<number, string>();
  private ids = 0;
  readonly warnings = new Set<string>();

  constructor(private readonly input: FlattenInput) {}

  private id(kind: string): string {
    return `flat-${kind}-${++this.ids}`;
  }

  private tintFilter(color: number): string {
    let id = this.tints.get(color);
    if (!id) {
      id = this.id('tint');
      this.tints.set(color, id);
      const r = ((color >> 16) & 255) / 255;
      const g = ((color >> 8) & 255) / 255;
      const b = (color & 255) / 255;
      this.defs.push(
        `<filter id="${id}" x="0" y="0" width="1" height="1" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="${fmt(r)} 0 0 0 0 0 ${fmt(g)} 0 0 0 0 0 ${fmt(b)} 0 0 0 0 0 1 0"/></filter>`,
      );
    }
    return `url(#${id})`;
  }

  private clipPath(clip: ClipShape): string {
    const id = this.id('clip');
    const shape = (c: ClipShape): string => {
      const attrs = omit(c.attrs, ['id']);
      return c.children.length ? `<${c.tag}${attrText(attrs)}>${c.children.map(shape).join('')}</${c.tag}>` : `<${c.tag}${attrText(attrs)}/>`;
    };
    this.defs.push(`<clipPath id="${id}"${attrText({ transform: clip.attrs.transform })}>${clip.children.map(shape).join('')}</clipPath>`);
    return `url(#${id})`;
  }

  private href(raw: string | undefined): string | undefined {
    if (raw == null) return undefined;
    return this.input.mapHref ? this.input.mapHref(raw) : raw;
  }

  private size(href: string | undefined): { w: number; h: number } | null {
    return href != null && this.input.imageSize ? this.input.imageSize(href) : null;
  }

  /** The transform of a node with the layout's shift in front (a shift is in the parent's space). */
  private transform(rec: Rec): string | undefined {
    const own = rec.attrs.transform?.trim();
    if (!rec.dx && !rec.dy) return own || undefined;
    return [`translate(${fmt(rec.dx)} ${fmt(rec.dy)})`, own].filter(Boolean).join(' ');
  }

  /** What every element carries: id, transform, opacity, visibility, clip, tint (images). */
  private common(rec: Rec, tint: number | undefined): Record<string, string | undefined> {
    return {
      transform: this.transform(rec),
      display: rec.hidden ? 'none' : undefined,
      'clip-path': rec.clip ? this.clipPath(rec.clip) : undefined,
      filter: tint !== undefined && tint !== 0xffffff ? this.tintFilter(tint) : undefined,
    };
  }

  node(rec: Rec, inheritedTint?: number): string {
    const tint = rec.tint ?? inheritedTint;
    if (rec.tag === 'image') return this.image(rec, tint);
    const attrs = { ...omit(rec.attrs, ['transform', 'display', 'visibility', 'clip-path']), ...this.common(rec, undefined) };
    if (rec.tag === 'text') return `<text${attrText(attrs)}>${esc(rec.text ?? '')}</text>`;
    const kids = this.children(rec, tint);
    return kids ? `<${rec.tag}${attrText(attrs)}>${kids}</${rec.tag}>` : `<${rec.tag}${attrText(attrs)}/>`;
  }

  /** Children in drawing order: data-z sorts siblings (the others keep their index), stable. */
  children(rec: Rec, tint?: number): string {
    const order = rec.children.map((c, i) => ({ c, z: c.z ?? i, i }));
    if (rec.children.some((c) => c.z !== undefined)) order.sort((a, b) => a.z - b.z || a.i - b.i);
    return order.map(({ c }) => this.node(c, tint)).join('');
  }

  private image(rec: Rec, tint: number | undefined): string {
    const a = rec.attrs;
    const raw = a.href;
    const href = this.href(raw);
    const tex = a['data-slices'] != null || a['data-tile'] != null || a.width == null || a.height == null ? this.size(raw) : null;
    let w = a.width != null ? Number(a.width) : undefined;
    let h = a.height != null ? Number(a.height) : undefined;
    if (tex && w === undefined) w = h !== undefined ? (h * tex.w) / tex.h : tex.w;
    if (tex && h === undefined) h = w !== undefined ? (w * tex.h) / tex.w : tex.h;
    const x = Number(a.x ?? 0);
    const y = Number(a.y ?? 0);
    const outer = { id: a.id, opacity: a.opacity, style: a.style, ...this.common(rec, tint) };

    if (a['data-slices'] != null && w !== undefined && h !== undefined) {
      if (!tex) {
        this.warnings.add(coded('W_FLATTEN', `${where(rec)}: data-slices — the size of the picture ${raw} is unknown, it is drawn stretched whole.`));
      } else {
        const [l, t, r, b] = parseSlices(a['data-slices']);
        const k = Math.min(w > l + r ? 1 : w / (l + r), h > t + b ? 1 : h / (t + b));
        const xs = [0, l * k, w - r * k, w];
        const ys = [0, t * k, h - b * k, h];
        const us = [0, l, tex.w - r, tex.w];
        const vs = [0, t, tex.h - b, tex.h];
        const pieces: string[] = [];
        for (let j = 0; j < 3; j++) {
          for (let i = 0; i < 3; i++) {
            const dw = xs[i + 1] - xs[i];
            const dh = ys[j + 1] - ys[j];
            const sw = us[i + 1] - us[i];
            const sh = vs[j + 1] - vs[j];
            if (dw <= 0 || dh <= 0 || sw <= 0 || sh <= 0) continue;
            pieces.push(
              `<svg x="${fmt(x + xs[i])}" y="${fmt(y + ys[j])}" width="${fmt(dw)}" height="${fmt(dh)}" viewBox="${fmt(us[i])} ${fmt(vs[j])} ${fmt(sw)} ${fmt(sh)}" preserveAspectRatio="none"><image${attrText({ href })} width="${fmt(tex.w)}" height="${fmt(tex.h)}"/></svg>`,
            );
          }
        }
        return `<g${attrText(outer)}>${pieces.join('')}</g>`;
      }
    }
    if (a['data-tile'] != null && w !== undefined && h !== undefined) {
      if (!tex) {
        this.warnings.add(coded('W_FLATTEN', `${where(rec)}: data-tile — the size of the picture ${raw} is unknown, it is drawn stretched whole.`));
      } else {
        const axes = parseAxes('data-tile', a['data-tile']);
        const pw = axes.includes('x') ? tex.w : w;
        const ph = axes.includes('y') ? tex.h : h;
        const id = this.id('tile');
        this.defs.push(
          `<pattern id="${id}" patternUnits="userSpaceOnUse" x="${fmt(x)}" y="${fmt(y)}" width="${fmt(pw)}" height="${fmt(ph)}"><image${attrText({ href })} width="${fmt(pw)}" height="${fmt(ph)}" preserveAspectRatio="none"/></pattern>`,
        );
        return `<g${attrText(outer)}><rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" fill="url(#${id})"/></g>`;
      }
    }
    if (w === undefined || h === undefined) {
      if (raw) this.warnings.add(coded('W_FLATTEN', `${where(rec)}: the size of the picture ${raw} is unknown — without width/height a browser takes its own.`));
    }
    const attrs: Record<string, string | undefined> = {
      id: a.id,
      x: a.x,
      y: a.y,
      width: w !== undefined ? fmt(w) : undefined,
      height: h !== undefined ? fmt(h) : undefined,
      href,
      preserveAspectRatio: w !== undefined && h !== undefined ? 'none' : undefined,
      opacity: a.opacity,
      style: a.style,
      ...this.common(rec, tint),
    };
    return `<image${attrText(attrs)}/>`;
  }

  document(root: Rec): string {
    const rest = omit(root.attrs, ['transform']);
    const body = this.children(root, root.tint);
    const font = this.input.fontFamily && rest['font-family'] == null ? { 'font-family': this.input.fontFamily } : {};
    const head = `<svg xmlns="http://www.w3.org/2000/svg"${attrText({ ...rest, ...font, ...this.common(root, undefined) })}>`;
    const defs = this.defs.length ? `<defs>${this.defs.join('')}</defs>` : '';
    return `<?xml version="1.0" encoding="UTF-8"?>\n${head}${defs}${body}</svg>\n`;
  }
}

const where = (rec: Rec): string => (rec.attrs.id ? `#${rec.attrs.id}` : `<${rec.tag}>`);

// ---- the pipeline ------------------------------------------------------------------------------

/** Flatten a scene into a vanilla SVG. Never throws for scene problems — they are in `errors`. */
export function flattenScene(input: FlattenInput): FlattenResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const url = (rel: string): string => {
    const own = expandCollection(rel, input.collections);
    return input.baseUrl ? resolveHref(own, input.baseUrl) : own;
  };
  const c = composeScene({ base: input.base, heir: input.heir, contract: input.contract, path: input.path, loadScene: input.loadScene, url });
  errors.push(...c.errors.parse, ...c.errors.prefab, ...c.errors.contract, ...c.errors.merge);
  const tree = c.tree;
  if (!tree) return { svg: null, errors: errors.length ? errors : [coded('E_EMPTY_SCENE', 'the scene is empty')], warnings, collections: [] };
  const collections = usedCollections(tree);
  // What mount() refuses to build: nothing is written.
  const hard = [...geometryErrors(tree), ...propErrors(tree), ...bindingErrors(tree), ...collectionErrors(tree, input.collections)];
  if (hard.length) return { svg: null, errors: [...new Set([...errors, ...hard])], warnings, collections };

  // Components with code: drawn as their base nodes.
  const components: string[] = [];
  // An expression runs when everything it reads is there: `self` (instance parameters), `state` (when
  // given), the host's context. One that reads a name nobody provides keeps the base's value.
  const provided = new Set(['self', ...Object.keys(input.context ?? {})]);
  if (input.state !== undefined) provided.add('state');
  const reads = (src: string): string[] => {
    try {
      return exprNames(src);
    } catch {
      return ['?'];
    }
  };
  walk(tree, (n) => {
    // An instance parameter `=expr` that reads a missing name: the prefab's default instead.
    const inst = n.instance;
    if (inst) {
      for (const [k, v] of Object.entries(inst.params)) {
        if (!v.startsWith('=') || reads(v.slice(1)).every((x) => provided.has(x))) continue;
        const d = inst.defaults[k];
        if (d !== undefined && !d.startsWith('=')) inst.params[k] = d;
        else delete inst.params[k];
      }
    }
    if (n.tml.type) {
      components.push(`${n.attrs.id ? `#${n.attrs.id}` : `<${n.tag}>`} (${n.tml.type})`);
      delete n.tml.type;
    }
    for (const [k, v] of Object.entries(n.tml)) {
      if (isExprKey(k) && !reads(v).every((x) => provided.has(x))) delete n.tml[k];
    }
  });
  if (components.length) warnings.push(coded('W_FLATTEN', `components with code are drawn as their base (vanilla SVG has none): ${components.join(', ')}`));

  const context: Record<string, unknown> = { state: reactive({ ...(input.state ?? {}) }), ...input.context };
  for (const name of sceneNames(tree).names) if (!(name in context)) context[name] = () => undefined;

  const backend = new RecordingBackend();
  let root: Rec;
  try {
    const scene = mountTree(tree, {
      backend,
      context,
      baseUrl: input.baseUrl,
      collections: input.collections,
      lenient: true,
      onError: (info) => warnings.push(coded('W_FLATTEN', `${info.node} ${info.attr}: the expression did not evaluate — ${info.error instanceof Error ? info.error.message : String(info.error)}`)),
    });
    root = scene.root as Rec;
  } catch (e) {
    return { svg: null, errors: [...errors, ...(e instanceof TrempelError ? e.errors : [e instanceof Error ? e.message : String(e)])], warnings, collections };
  }
  for (const u of backend.unsupported) warnings.push(coded('W_FLATTEN', `${u} — the binding does not carry into vanilla SVG (the base's value is kept)`));
  const w = new Writer(input);
  const svg = w.document(root);
  warnings.push(...w.warnings);
  return { svg, errors: [...new Set(errors)], warnings: [...new Set(warnings)], collections };
}

/** What must not be left in a flattened SVG (tml:, data-*, @-links) — the CLI and the tests check it. */
export function flattenLeftovers(svg: string): string[] {
  const out: string[] = [];
  if (/\btml:/.test(svg)) out.push('tml:');
  if (/\sdata-[\w-]+=/.test(svg)) out.push('data-*');
  if (/\s(?:href|xlink:href)="@/.test(svg)) out.push('@-hrefs');
  return out;
}

