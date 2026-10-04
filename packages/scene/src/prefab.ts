// prefab.ts — v0.9 prefabs: any scene is a component. Renderer-agnostic, no I/O of its own.
//
//   - A prefab is an ordinary scene X.svg (+ X.tml.svg, + X.contract.xml). Its parameters are the
//     data-* of the base root (defaults); the contract's `params="data-a data-b"` are required.
//   - An instance is a vanilla `<use id href="ui/button.svg" x y transform data-*/>`. After the
//     scene's base is parsed it is expanded (before the contract and the heir) into a `<g>` with the
//     same placement and, inside, the prefab's result (its base merged with its own heir); ids get
//     the instance prefix (`btn/label`) so the scene's heir and contract address them. Uses inside a
//     prefab expand recursively (prefixes add up); a cycle is an error with the chain.
//   - tml:extends is multi-level: an heir without its own base takes another scene's result as the
//     base (`button-green.tml.svg` → `button.svg`), recursively; the contract is inherited.
//   - v1.0: a prefab with data-resizable on its root takes `<use width height>` along those axes (its
//     viewBox is the minimum; the instance's box — layout.ts); `data-anchor` / `data-stretch` on a
//     `<use>` place the instance in its parent's box. Children of a `<use>` go into the prefab's
//     slots (`tml:slot="name"` / `"name default"` on a group in the prefab's heir) by their `slot`
//     attribute — they stay the scene's nodes: ids without the instance prefix, the scene's context.
//   - Expressions of a prefab see `self` (parameters, `self.id`, `self.call(name)`, a local reactive
//     `self.state` + `self.set(k, v)`) next to the scene's context — scene.ts builds that from the
//     scopes recorded here (SceneNode.scope / keyScope / instance).
//
// Paths. Every document is addressed by its path relative to the top scene's folder (`rel`); the
// top scene itself is a file in that folder. Hrefs inside a prefab (images, data-views, nested
// uses, tml:href) are rewritten into that space when it is loaded, so after expansion the whole
// tree resolves against the top scene's document like any of its own hrefs. Parameters are
// strings: a value that looks like an image path (…png/jpg/webp/gif/avif/svg) is rebased too.
// The loader receives `url(rel)` — mount gives it the scene's baseUrl / resolveHref.
//
// v1.1 collections: `@name/…` is a space of its own — a prefab at `@skin/button.svg` rebases its
// relative hrefs to `@skin/art/…`, `url(rel)` (mount: collections → folder URLs) maps them to files.

import { readHeirAsync } from './compat.js';
import { checkContract, parseContract, slotContractErrors, type Contract } from './contract.js';
import { compile, ExpressionError } from './expr.js';
import { resolveHref } from './href.js';
import { mergeScene } from './merge.js';
import { parse, parseHeir, type HeirDoc, type InstanceScope, type SceneNode } from './parser.js';
import { parseAxes, resizableErrors, viewBoxSize, type Axes } from './layout.js';
import { walk, walkOwn } from './tree.js';

/** The documents of one scene, as text: base (absent for an heir extending another scene), heir, contract. */
export interface SceneSource {
  base?: string;
  heir?: string;
  contract?: string;
}

/** Synchronous scene loader: `url` of a base (`ui/button.svg`) → its documents, null — no such scene. */
export type SceneLoader = (url: string) => SceneSource | null | undefined;
/** A loader that may be asynchronous (fetch) — mountAsync / preloadScenes. */
export type AsyncSceneLoader = (url: string) => SceneSource | null | undefined | Promise<SceneSource | null | undefined>;

/** The placeholder name of the top scene when its own path is unknown (hrefs stay as written). */
const TOP = '_';

/** Attributes a `<use>` passes to its `<g>` (placement and presentation). */
const PLACEMENT = new Set(['id', 'transform', 'opacity', 'display', 'visibility', 'clip-path', 'style', 'x', 'y']);
/** data-* of a `<use>` that are presentation of the instance, not parameters. */
const PRESENTATION_DATA = new Set(['data-z', 'data-pivot', 'data-tint', 'data-anchor', 'data-stretch']);
/** v1.0: data-* of a prefab root that describe its box, not parameters. */
const BOX_ROOT_DATA = new Set(['data-resizable']);
/** `self` members a parameter may not shadow. */
export const SELF_RESERVED = new Set(['id', 'call', 'state', 'set']);

const IMAGE_PATH = /\.(png|jpe?g|webp|gif|avif|svg)(\?.*)?$/i;

/** data-hit-size → hitSize. */
export const paramName = (attr: string): string =>
  attr.replace(/^data-/, '').replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** `href` written in the document at `rel`, as a path in the top scene's space. */
export const rebase = (href: string, rel: string): string => resolveHref(href, rel || TOP);

/** File name of a path (the top scene is a file in its own folder). */
const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1) || TOP;

/** Rewrite the hrefs of a freshly parsed subtree written in the document at `rel`. */
function rebaseTree(tree: SceneNode, rel: string): void {
  if (!rel.includes('/')) return; // same folder as the top scene — paths are already right
  for (const [k, v] of Object.entries(tree.attrs)) if (k.startsWith('data-')) tree.attrs[k] = rebaseParam(v, rel);
  walk(tree, (n) => {
    if ((n.tag === 'image' || n.tag === 'use') && n.attrs.href != null) n.attrs.href = rebase(n.attrs.href, rel);
    const views = n.attrs['data-views'];
    if (views != null) {
      n.attrs['data-views'] = views
        .split(',')
        .map((raw) => {
          const part = raw.trim();
          const i = part.indexOf(':');
          return i < 0 ? part : `${part.slice(0, i + 1)}${rebase(part.slice(i + 1).trim(), rel)}`;
        })
        .join(', ');
    }
  });
}

const rebaseParam = (v: string, rel: string): string =>
  v.startsWith('=') || !IMAGE_PATH.test(v) || !rel.includes('/') ? v : rebase(v, rel);

/** What resolving one document gave. */
interface DocResult {
  tree: SceneNode;
  contract: Contract | null;
  /** The base is another scene's result (tml:extends chain). */
  inherited: boolean;
  /** Root data-* some heir of the chain set (they count as given for `params`). */
  overridden: Set<string>;
}

/** Where problems of one composition go. */
export interface ComposeErrors {
  /** The top documents: XML, unsupported tags. */
  parse: string[];
  /** Instances and the tml:extends chain (prefab problems carry the instance prefix). */
  prefab: string[];
  contract: string[];
  /** The top heir's merge. */
  merge: string[];
}

class Resolver {
  constructor(
    private readonly load: SceneLoader | undefined,
    private readonly url: (rel: string) => string,
  ) {}

  /** The documents at `rel`; null + an error when missing / unloadable. */
  source(rel: string, what: string, errs: string[]): SceneSource | null {
    if (!this.load) {
      errs.push(`${what}: нет загрузчика сцен (MountOptions.loadScene) — ${rel} не загрузить.`);
      return null;
    }
    let src: ReturnType<SceneLoader>;
    try {
      src = this.load(this.url(rel));
    } catch (e) {
      errs.push(`${what}: ${rel} не загрузился — ${(e as Error).message ?? String(e)}`);
      return null;
    }
    if (src && typeof (src as unknown as PromiseLike<unknown>).then === 'function') {
      errs.push(`${what}: загрузчик асинхронный — используйте mountAsync() (или preloadScenes).`);
      return null;
    }
    if (!src || (src.base == null && src.heir == null)) {
      errs.push(`${what}: сцены ${rel} нет.`);
      return null;
    }
    return src;
  }

  /**
   * A document's result: its base (or the scene it extends), instances expanded, its heir merged.
   * `beforeHeir` sees the expanded tree before the heir (the top scene checks its contract there).
   */
  doc(
    src: SceneSource,
    rel: string,
    stack: string[],
    errs: { prefab: string[]; merge: string[]; parse: string[]; contract?: string[] },
    beforeHeir?: (r: DocResult) => void,
  ): DocResult | null {
    let contract: Contract | null = null;
    if (src.contract != null) {
      try {
        contract = parseContract(src.contract);
      } catch (e) {
        errs.parse.push(`контракт: ${(e as Error).message}`);
      }
    }
    let heir: HeirDoc | null = null;
    if (src.heir != null) {
      try {
        heir = parseHeir(src.heir);
      } catch (e) {
        errs.parse.push(`наследник: ${(e as Error).message}`);
      }
    }
    const ext = heir?.extends ? rebase(heir.extends, rel) : null;

    let tree: SceneNode;
    let inherited = false;
    const overridden = new Set<string>();
    if (src.base != null) {
      try {
        tree = parse(src.base);
      } catch (e) {
        errs.parse.push(`база: ${(e as Error).message}`);
        return null;
      }
      if (ext && stack.length > 1 && ext !== rel) {
        errs.prefab.push(`у ${rel} своя база, а наследник расширяет ${ext} — база одна: уберите файл базы или tml:extends.`);
      }
      rebaseTree(tree, rel);
    } else if (ext) {
      if (ext === rel) {
        errs.parse.push(`нет базы: наследник расширяет ${ext}, а такого файла нет.`);
        return null;
      }
      if (stack.includes(ext)) {
        errs.prefab.push(`цикл tml:extends: ${[...stack, ext].join(' → ')}.`);
        return null;
      }
      const parent = this.source(ext, `tml:extends="${heir!.extends}"`, errs.prefab);
      if (!parent) return null;
      const sub = { prefab: [] as string[], merge: [] as string[], parse: [] as string[] };
      const r = this.doc(parent, ext, [...stack, ext], sub);
      const tag = (e: string): string => `${ext}: ${e}`;
      errs.prefab.push(...sub.parse.map(tag), ...sub.merge.map(tag), ...sub.prefab.map(tag));
      if (!r) return null;
      tree = r.tree;
      inherited = true;
      contract ??= r.contract;
      r.overridden.forEach((k) => overridden.add(k));
    } else {
      errs.parse.push(
        src.heir != null
          ? 'нет базы: наследник без своей X.svg должен расширять другую сцену (tml:extends="other.svg").'
          : 'нет базы — рисовать нечего.',
      );
      return null;
    }

    this.expand(tree, rel, stack, errs.prefab);
    const result: DocResult = { tree, contract, inherited, overridden };
    beforeHeir?.(result);

    if (heir) {
      for (const ins of heir.inserts) rebaseTree(ins.node, rel);
      for (const [k, v] of Object.entries(heir.rootData)) {
        heir.rootData[k] = rebaseParam(v, rel);
        overridden.add(k);
      }
      const out = mergeScene(tree, heir, { inherited, href: (h) => rebase(h, rel) });
      errs.merge.push(...out.errors);
      this.expand(tree, rel, stack, errs.prefab); // uses the heir inserted
    }
    if (contract) (errs.contract ?? errs.prefab).push(...slotContractErrors(tree, contract));
    (errs.contract ?? errs.prefab).push(...resizableErrors(tree));
    return result;
  }

  /** Replace every `<use>` below `tree` (not inside already expanded instances) by its `<g>`. */
  expand(tree: SceneNode, rel: string, stack: string[], errs: string[]): void {
    const visit = (n: SceneNode): void => {
      if (n.instance) return;
      for (let i = 0; i < n.children.length; i++) {
        const c = n.children[i];
        if (c.tag === 'use') n.children[i] = this.instance(c, rel, stack, errs);
        else visit(c);
      }
    };
    visit(tree);
  }

  /** One `<use>` → its `<g>` (an empty one with the placement when the instance is broken). */
  private instance(use: SceneNode, rel: string, stack: string[], errs: string[]): SceneNode {
    const id = use.attrs.id;
    const href = use.attrs.href;
    const where = id ? `#${id}` : `<use href="${href ?? ''}">`;
    const g: SceneNode = { tag: 'g', attrs: {}, tml: { ...use.tml }, children: [] };
    if (use.scope) g.scope = use.scope;
    if (use.keyScope) g.keyScope = use.keyScope;
    const own: Record<string, string> = {};
    const size: { width?: number; height?: number } = {};
    const problems: string[] = [];
    for (const [k, v] of Object.entries(use.attrs)) {
      if (k === 'href' || k === 'slot') continue; // slot — where a slot child of an outer <use> goes (v1.0)
      if (k.startsWith('data-tml-')) g.attrs[k] = v; // a tool's own marks (the editor's index paths) — not parameters
      else if (k.startsWith('data-') && !PRESENTATION_DATA.has(k)) own[k] = rebaseParam(v, rel);
      else if (PLACEMENT.has(k) || PRESENTATION_DATA.has(k)) {
        if (k !== 'x' && k !== 'y') g.attrs[k] = v;
      } else if (k === 'width' || k === 'height') {
        const n = /^\s*[+]?(\d+\.?\d*|\.\d+)\s*$/.test(v) ? Number(v) : NaN;
        if (!(n > 0)) problems.push(`${where}: ${k}="${v}" — размер инстанса положительным числом.`);
        else size[k] = n;
      } else {
        problems.push(`${where}: атрибут ${k} — инстанс настраивается параметрами (data-*) и трансформом.`);
      }
    }
    const x = use.attrs.x ?? '0';
    const y = use.attrs.y ?? '0';
    if (Number(x) || Number(y)) {
      g.attrs.transform = [use.attrs.transform?.trim(), `translate(${x} ${y})`].filter(Boolean).join(' ');
    }
    if (!id) problems.push(`${where}: инстанс без id — по id его адресуют наследник и контракт.`);
    if (!href) problems.push(`${where}: нет href — какой префаб ставить.`);
    if (use.text) problems.push(`${where}: текст внутри <use> не бывает — дети инстанса это узлы для слотов префаба.`);
    for (const k of Object.keys(own)) {
      const name = paramName(k);
      if (SELF_RESERVED.has(name)) problems.push(`${where}: параметр ${k} — имя self.${name} занято.`);
      if (own[k].startsWith('=')) {
        try {
          compile(own[k].slice(1));
        } catch (e) {
          if (!(e instanceof ExpressionError)) throw e;
          problems.push(`${where} ${k}: ${e.reason}, позиция ${e.pos + 2}.`);
        }
      }
    }
    if (problems.length || !href) {
      errs.push(...problems);
      return g;
    }

    const prel = rebase(href, TOP); // already in the top scene's space (rebaseTree)
    if (stack.includes(prel)) {
      errs.push(`${where}: цикл префабов: ${[...stack, prel].join(' → ')}.`);
      return g;
    }
    const sub = { prefab: [] as string[], merge: [] as string[], parse: [] as string[] };
    const src = this.source(prel, `${where}: префаб ${href}`, errs);
    if (!src) return g;
    const r = this.doc(src, prel, [...stack, prel], sub);
    const tag = (e: string): string => `${where} (${href}): ${e}`;
    errs.push(...sub.parse.map(tag), ...sub.merge.map(tag), ...sub.prefab.map(tag));
    if (!r) return g;

    // v1.0: the box — the prefab's viewBox is its minimum; width/height only along data-resizable.
    const min = viewBoxSize(r.tree.attrs.viewBox);
    let resizable: Axes | undefined;
    if (r.tree.attrs['data-resizable'] != null) {
      try {
        resizable = parseAxes('data-resizable', r.tree.attrs['data-resizable']);
      } catch {
        // the prefab's own error (layoutErrors)
      }
    }
    for (const k of ['width', 'height'] as const) {
      const v = size[k];
      if (v === undefined) continue;
      const axis = k === 'width' ? 'x' : 'y';
      if (!resizable) {
        problems.push(`${where}: ${k} на <use> — ${href} не растягивается (нет data-resizable у корня); масштаб инстанса задаётся transform.`);
      } else if (!resizable.includes(axis)) {
        problems.push(`${where}: ${k} — ${href} растягивается только по ${resizable} (data-resizable="${resizable}").`);
      } else if (min && v < (k === 'width' ? min.w : min.h) - 1e-9) {
        problems.push(`${where}: ${k}="${v}" меньше минимального ${k === 'width' ? min.w : min.h} (viewBox ${href}).`);
      }
    }

    const defaults: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.tree.attrs)) if (k.startsWith('data-') && !BOX_ROOT_DATA.has(k)) defaults[k] = v;
    const params: Record<string, string> = { ...defaults, ...own };
    for (const p of r.contract?.params ?? []) {
      if (own[p] === undefined && !r.overridden.has(p)) errs.push(`${where}: не задан параметр ${p}, его требует ${href}.`);
    }

    const scope: InstanceScope = { node: g, params };
    const placement: Record<string, string> = {};
    for (const [k, v] of Object.entries(use.attrs)) if (k !== 'href' && !(k in own)) placement[k] = v;
    g.instance = { href, rel: prel, params, defaults, own, use: placement, required: r.contract?.params ?? [], scope };
    g.instance.min = min;
    g.instance.size = min ? { w: size.width ?? min.w, h: size.height ?? min.h } : null;
    if (resizable) g.instance.resizable = resizable;
    g.children = r.tree.children;

    // Prefix ids (and the clip-path references to them) and adopt the prefab's scopes.
    const ids = new Set<string>();
    for (const c of g.children) walk(c, (n) => n.attrs.id && ids.add(n.attrs.id));
    const adopt = (s: InstanceScope | null | undefined): InstanceScope => {
      if (!s) return scope;
      if (!s.parent && s !== scope) s.parent = scope;
      return s;
    };
    for (const c of g.children) {
      walk(c, (n) => {
        if (n.attrs.id) n.attrs.id = `${id}/${n.attrs.id}`;
        const cp = /^url\(\s*['"]?#([^'")\s]+)['"]?\s*\)$/.exec(n.attrs['clip-path']?.trim() ?? '');
        if (cp && ids.has(cp[1])) n.attrs['clip-path'] = `url(#${id}/${cp[1]})`;
        n.scope = adopt(n.scope);
        if (n.keyScope) for (const k of Object.keys(n.keyScope)) n.keyScope[k] = adopt(n.keyScope[k]);
        if (n.instance) adopt(n.instance.scope);
      });
    }

    // v1.0 slots: the `<use>`'s children go into the prefab's tml:slot groups — as the scene's nodes
    // (ids as written, the scene's expression context).
    if (use.children.length) this.fill(g, use.children, where, href, rel, stack, problems);
    errs.push(...problems);
    return g;
  }

  /** Move the children of a `<use>` into the slots of its expanded `<g>` (v1.0). */
  private fill(g: SceneNode, children: SceneNode[], where: string, href: string, rel: string, stack: string[], errs: string[]): void {
    const slots = new Map<string, SceneNode>();
    let fallback: SceneNode | undefined;
    for (const c of g.children) {
      walkOwn(c, (n) => {
        const raw = n.tml.slot;
        if (raw === undefined) return;
        const words = raw.trim().split(/\s+/).filter(Boolean);
        const name = words[0];
        if (!name || words.length > 2 || (words.length === 2 && words[1] !== 'default')) {
          errs.push(`${where} (${href}): tml:slot="${raw}" — ожидается «имя» или «имя default».`);
          return;
        }
        if (n.tag !== 'g') errs.push(`${where} (${href}): tml:slot на <${n.tag}> — слот это группа <g>.`);
        if (slots.has(name)) errs.push(`${where} (${href}): слот «${name}» помечен дважды.`);
        slots.set(name, n);
        if (words[1] === 'default' || name === 'default') {
          if (fallback && fallback !== n) errs.push(`${where} (${href}): слотов по умолчанию два — default у одного.`);
          fallback = n;
        }
      });
    }
    // Instances among the children are the scene's (expanded in its document, before they move).
    const holder: SceneNode = { tag: 'g', attrs: {}, tml: {}, children };
    this.expand(holder, rel, stack, errs);
    const slotted: SceneNode[] = [];
    for (const c of holder.children) {
      const name = c.attrs.slot;
      const target = name != null ? slots.get(name) : fallback;
      const cw = c.attrs.id ? `#${c.attrs.id}` : `<${c.tag}>`;
      if (!slots.size) {
        errs.push(`${where}: дети у <use> — у ${href} нет слотов (tml:slot в наследнике префаба); настройка — параметрами data-*.`);
        return;
      }
      if (!target) {
        errs.push(
          name != null
            ? `${where}: ${cw} slot="${name}" — у ${href} такого слота нет (есть: ${[...slots.keys()].join(', ')}).`
            : `${where}: ${cw} без slot — у ${href} нет слота по умолчанию (есть: ${[...slots.keys()].join(', ')}).`,
        );
        continue;
      }
      target.children.push(c);
      slotted.push(c);
    }
    if (slotted.length) g.instance!.slotted = slotted;
  }
}

export interface ComposeInput {
  /** Base source; omitted — the heir must extend another scene (tml:extends). */
  base?: string;
  heir?: string;
  contract?: string;
  /** Loads prefab documents (and the tml:extends chain). Without it a `<use>` is an error. */
  loadScene?: SceneLoader;
  /** rel path (relative to the top scene's folder) → what the loader gets. Default: as is. */
  url?: (rel: string) => string;
  /** The top scene's own path (only its file name matters — cycles, tml:extends of itself). */
  path?: string;
  /** Skip the heir (a viewer showing the base alone after a merge failure). */
  noHeir?: boolean;
}

export interface Composed {
  /** The final tree: base (or extended scene) + instances + heir. null when nothing to build. */
  tree: SceneNode | null;
  /** Effective contract (own, or inherited through tml:extends). */
  contract: Contract | null;
  errors: ComposeErrors;
}

/**
 * Compose a scene: parse the base (or resolve the tml:extends chain), expand instances, check the
 * contract against that (pre-heir) tree, merge the heir, expand what it inserted. Never throws for
 * scene problems — every one is in `errors`, by stage.
 */
export function composeScene(input: ComposeInput): Composed {
  const errors: ComposeErrors = { parse: [], prefab: [], contract: [], merge: [] };
  const r = new Resolver(input.loadScene, input.url ?? ((rel) => rel));
  const rel = input.path ? basename(input.path) : TOP;
  const src: SceneSource = { base: input.base, heir: input.noHeir ? undefined : input.heir, contract: input.contract };
  if (input.noHeir && input.base == null) src.heir = input.heir; // an extends-only scene has no base without it
  let contract: Contract | null = null;
  const url = input.url;
  const res = r.doc(src, rel, [rel], errors, (d) => {
    contract = d.contract;
    if (d.contract) errors.contract.push(...checkContract(d.tree, d.contract, { sterile: !d.inherited, resolveHref: url }));
  });
  return { tree: res?.tree ?? null, contract, errors };
}

/** Expand the `<use>` instances of an already parsed tree (single-document mount). Returns the problems. */
export function expandInstances(tree: SceneNode, opts: { loadScene?: SceneLoader; url?: (rel: string) => string; path?: string } = {}): string[] {
  const errs: string[] = [];
  const rel = opts.path ? basename(opts.path) : TOP;
  new Resolver(opts.loadScene, opts.url ?? ((r) => r)).expand(tree, rel, [rel], errs);
  return errs;
}

/** Does the tree (or an heir source) need the loader at all? */
export function hasInstances(tree: SceneNode): boolean {
  let found = false;
  walk(tree, (n) => {
    if (n.tag === 'use') found = true;
  });
  return found;
}

/**
 * Fetch every document a composition needs with an asynchronous loader; returns a synchronous
 * loader over what arrived (for mount / composeScene). Loader failures are kept and reported where
 * the document is used.
 */
export async function preloadScenes(input: Omit<ComposeInput, 'loadScene'>, load: AsyncSceneLoader): Promise<SceneLoader> {
  const cache = new Map<string, SceneSource | null | Error>();
  const pending = new Set<string>();
  const sync: SceneLoader = (url) => {
    const v = cache.get(url);
    if (v instanceof Error) throw v;
    if (v !== undefined) return v;
    pending.add(url);
    return null;
  };
  for (let round = 0; round < 64; round++) {
    pending.clear();
    try {
      composeScene({ ...input, loadScene: sync });
    } catch {
      // top-level parse problems surface in the real composition
    }
    if (!pending.size) break;
    await Promise.all(
      [...pending].map(async (url) => {
        try {
          cache.set(url, (await load(url)) ?? null);
        } catch (e) {
          cache.set(url, e instanceof Error ? e : new Error(String(e)));
        }
      }),
    );
  }
  return sync;
}

/**
 * The browser default: fetch `X.svg`, `X.tml.svg`, `X.contract.xml` by the stem of the url (404 —
 * absent). `fetchFn` defaults to the global fetch.
 */
export function fetchSceneLoader(fetchFn: typeof fetch = globalThis.fetch): AsyncSceneLoader {
  if (!fetchFn) throw new Error('Trempel: fetch недоступен — передайте loadScene.');
  const get = async (url: string): Promise<string | undefined> => {
    const r = await fetchFn(url);
    if (r.status === 404) return undefined;
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return r.text();
  };
  return async (url) => {
    const m = /^(.*?)(\.svg)?([?#].*)?$/.exec(url)!;
    const stem = m[1];
    const tail = m[3] ?? '';
    const [base, heir, contract] = await Promise.all([get(`${stem}.svg${tail}`), readHeirAsync((f) => get(`${f}${tail}`), stem), get(`${stem}.contract.xml${tail}`)]);
    if (base == null && heir == null) return null;
    return { base, heir, contract };
  };
}
