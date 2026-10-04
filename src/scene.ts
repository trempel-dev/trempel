// scene.ts — assemble a scene onto a backend.
//
// Two entry points:
//   - mountScene(svg, opts)     single-document path (base with inline tml) — unchanged.
//   - mount({ base, heir, ... }) v0.5 two-document path: parse base + heir, run the contract,
//                               merge, then build. merge + contract + expression errors are
//                               thrown as one deduplicated TrempelError list.
//
// v0.6: both return `ready` (resolves when every texture of the scene has loaded — the backend's
// whenReady) and accept `baseUrl` / `resolveHref`: image hrefs (attributes and bound values,
// including those a component sets through ctx.backend) are resolved relative to the scene
// document, then optionally mapped (bundler URL tables).
//
// v0.6.1: an expression that fails while running (tml:bind / tml:bind-* / tml:visible /
// tml:on-click) is loud — `onError({ node, attr, expr, error })`, or ExpressionRuntimeError
// thrown with its place; `lenient: true` restores the v0.5 silence.
//
// v0.7: <defs> is not built (service geometry; masks are built per use), clip-path="url(#id)" and
// tml:bind-clip-path go to backend.setClip (an <image> with a clip gets a wrapping group — a Pixi
// sprite cannot hold its mask), `MountedScene.path(id)` / `ComponentContext.path(id)` measure
// geometry, `ComponentContext.param(name)` reads tml:<name> → data-<name>.
//
// v0.8 (props.ts): style="mix-blend-mode: …" goes to the backend as setProp('mix-blend-mode') on
// every built node of the subtree (a node without its own mode takes its parent's); data-tint —
// setProp('tint', 0xRRGGBB) on the images of the subtree; data-z — setProp('z') once the node sits
// in its parent (order among siblings); `MountedScene.setView(id, name)` swaps to a data-views variant.
//
// v0.9 (prefab.ts): `<use href>` instances are expanded (loadScene) before the contract and the heir;
// a node from a prefab evaluates its expressions in `{ ...scene context, self }` of its instance;
// tml:bind-view="expr" picks a data-views variant by name; tml:on-over / on-out / on-down / on-up —
// pointer handlers (backend.onPointer). mountAsync() loads the prefabs with an asynchronous loader.
//
// v0.9.1 (geom/hit.ts): `MountedScene.hitTest(id, x, y)` / `hitTestAll(x, y)` and
// `ComponentContext.hitTest` — by the geometry of the document (scene coordinates, the transform
// chain), hidden nodes included (display="none" is not drawn, but is hit and measured).

import { applyBindings, bindingErrors, evalAt, failed, type ExpressionErrorOptions } from './binding.js';
import { parseContract } from './contract.js';
import { ExpressionRuntimeError, TrempelError, type ExpressionErrorInfo } from './errors.js';
import { compile } from './expr.js';
import { clipPaths, geometryErrors, parseClipRef } from './geom/check.js';
import { hitTestTree, nodeMatrix, pointInNode } from './geom/hit.js';
import { pathFromNode, type ScenePath } from './geom/path.js';
import { applyPipes, run } from './expr.js';
import { composeScene, expandInstances, hasInstances, paramName, preloadScenes, type AsyncSceneLoader, type SceneLoader } from './prefab.js';
import { parse, parseHeir, type InstanceScope, type SceneNode } from './parser.js';
import { reactive } from './reactive.js';
import { parseBlend, parseTint, parseViews, parseZ, propErrors, singleImage } from './props.js';
import { effect } from './reactive.js';
import { resolveHref } from './href.js';
import { componentParam, Registry } from './registry.js';
import type { ComponentInstance } from './registry.js';
import type { NodeHandle, PointerKind, RendererBackend } from './render/backend.js';
import { walk } from './tree.js';
import { layoutScene, type SceneLayout } from './layout.js';

export interface MountOptions extends ExpressionErrorOptions {
  backend: RendererBackend;
  /** Evaluation context for tml:bind / tml:visible / tml:on-click (e.g. { state, spin, buy }). */
  context: Record<string, unknown>;
  /** Registry of custom components; required if the scene uses tml:type. */
  registry?: Registry;
  /** Host container to mount the root into (e.g. a Pixi Application stage). */
  container?: unknown;
  /**
   * URL (or path) of the scene document; relative image hrefs resolve against it like in a
   * browser. Omitted ⇒ hrefs reach the backend verbatim (v0.5 behaviour).
   */
  baseUrl?: string;
  /**
   * Final href mapping, applied after `baseUrl` (e.g. a bundler's hashed-URL table). Same reach
   * as baseUrl: base/heir image hrefs, bound hrefs, component hrefs via ctx.backend.
   */
  resolveHref?: (href: string) => string;
  /**
   * v0.9: loads prefab documents (`<use href>`, multi-level tml:extends): url → { base, heir?,
   * contract? }. mount() needs a synchronous one; mountAsync() takes a Promise-returning one too
   * (in the browser entry `trempel` it defaults to fetch). The url is the href resolved like an
   * image's (baseUrl / resolveHref), or against `sceneUrl` when given.
   */
  loadScene?: SceneLoader | AsyncSceneLoader;
  /** v0.9: URL of the scene document for prefab hrefs (default: baseUrl / resolveHref as for images). */
  sceneUrl?: string;
}

/** What the prefab loader gets for a path relative to the scene's folder. */
function sceneUrlOf(opts: MountOptions): (rel: string) => string {
  if (opts.sceneUrl) return (rel) => resolveHref(rel, opts.sceneUrl);
  return hrefResolver(opts) ?? ((rel) => rel);
}

/** The scene's href resolver, or null when hrefs pass through verbatim. */
function hrefResolver(opts: MountOptions): ((href: string) => string) | null {
  const { baseUrl, resolveHref: map } = opts;
  if (!baseUrl && !map) return null;
  return (href) => {
    const abs = baseUrl ? resolveHref(href, baseUrl) : href;
    return map ? map(abs) : abs;
  };
}

/** v0.5 two-document mount input. */
export interface MountArgs extends MountOptions {
  /** Sterile base SVG source (scene.svg). */
  base: string;
  /** Heir source (scene.tml.svg); omit for a base-only scene. */
  heir?: string;
  /** Contract source (scene.contract.xml); when present, validated on mount. */
  contract?: string;
  /** v0.9: path of the scene document (only its file name matters: cycles of tml:extends). */
  path?: string;
}

/** v0.9 two-document mount input; `base` may be omitted when the heir extends another scene. */
export type MountArgsLoose = Omit<MountArgs, 'base'> & { base?: string };

export interface MountedScene {
  root: NodeHandle;
  /** All nodes that carried an `id`. */
  byId: Map<string, NodeHandle>;
  /** Custom-component instances, keyed by node id. */
  components: Map<string, ComponentInstance>;
  /**
   * Resolves when every texture the scene started loading has arrived (backend.whenReady);
   * rejects with a TrempelError listing failed hrefs. Already-handled: ignoring it is safe.
   */
  ready: Promise<void>;
  /**
   * A geometry node (path, line, circle, ellipse, rect — usually in <defs>) as a measurable path
   * (v0.7): `{ length, closed, pointAt(s), tangentAt(s) }`, s — distance in scene units, points in
   * the node's parent space. @throws if the id is missing or not geometry.
   */
  path(id: string): ScenePath;
  /**
   * Show a named sprite variant (v0.8): `data-views="name:href, …"` of the <image> `id` (or of the
   * one image inside the group `id`) → its href. @throws for an unknown id or name.
   */
  setView(id: string, name: string): void;
  /**
   * Is the scene point (x, y) — viewBox units — inside the geometry of node `id` (v0.9.1)? Shapes by
   * their outline, image by its box, a group by its children; the document's transforms apply,
   * display="none" does not matter. @throws for an unknown id.
   */
  hitTest(id: string, x: number, y: number): boolean;
  /** Ids of the shapes / images under the scene point, topmost first (v0.9.1); hidden ones included. */
  hitTestAll(x: number, y: number): string[];
  /**
   * v1.0: the host's new size of the scene (viewBox units, e.g. the canvas in reference units): the
   * root's data-anchor / data-stretch children follow it. @throws without a viewBox.
   */
  resize(w: number, h: number): void;
  /**
   * v1.0: resize node `id` — an instance of a resizable prefab (its box: anchored content follows),
   * a `<g data-size>`, an `<image>` (9-slice: the panel's size) or a `<rect>`. Omitted (undefined)
   * axis stays. @throws for an unknown id or an axis the prefab does not resize along.
   */
  setSize(id: string, w?: number, h?: number): void;
  /** v1.0: current size of a box (root, instance, data-size group) or a laid-out node; undefined — none. */
  sizeOf(id: string): { w: number; h: number } | undefined;
}

/** What a built node inherits from its ancestors (v0.8): blend mode (CSS name) and tint. */
interface Inherited {
  blend?: string;
  tint?: number;
}

/** What buildScene knows about the whole tree (before any node is built). */
interface SceneIndex {
  nodes: Map<string, SceneNode>;
  /** v1.0: the built node of each scene node (layout). */
  handles: Map<SceneNode, NodeHandle>;
  /** v1.0: the live layout, once built (hit tests follow it). */
  layout?: SceneLayout;
  clips: Map<string, SceneNode>;
  path(id: string): ScenePath;
  /** href of a data-views variant of node `id`. @throws for an unknown id / name. */
  view(id: string, name: string): string;
  /** v0.9: the expression context of an instance scope (undefined / null — the scene's own). */
  contextOf(scope: InstanceScope | null | undefined): Record<string, unknown>;
  /** v0.9.1: geometry hit test of node `id`. @throws for an unknown id. */
  hitTest(id: string, x: number, y: number): boolean;
}

/** `self` of an instance (v0.9): parameters (camelCase; `=expr` evaluated in `parent`), id, call, state, set. */
function makeSelf(scope: InstanceScope, parent: Record<string, unknown>): Record<string, unknown> {
  const self: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(scope.params)) {
    const name = paramName(k);
    if (v.startsWith('=')) {
      const c = compile(v.slice(1));
      Object.defineProperty(self, name, {
        enumerable: true,
        get: () => {
          const x = run(c, parent);
          return c.pipes.length ? applyPipes(x, c.pipes) : x;
        },
      });
    } else self[name] = v;
  }
  const local = reactive({} as Record<string, unknown>);
  Object.defineProperty(self, 'id', { enumerable: true, get: () => scope.node.attrs.id });
  self.state = local;
  self.set = (key: string, value: unknown): void => {
    local[key] = value;
  };
  self.call = (name: unknown, ...args: unknown[]): unknown => {
    const fn =
      typeof name === 'function'
        ? name
        : typeof name === 'string' && Object.prototype.hasOwnProperty.call(parent, name)
          ? parent[name]
          : undefined;
    if (typeof fn !== 'function') throw new Error(`self.call(${JSON.stringify(name ?? null)}): такой функции в контексте сцены нет`);
    return (fn as (...a: unknown[]) => unknown)(...args);
  };
  return self;
}

/** `self` objects mount() put on a host context (a prefab opened as a scene) — replaced on remount. */
const ROOT_SELVES = new WeakSet<object>();

/**
 * A prefab opened as a scene (viewer, editor, a test) has no instance: its expressions' `self` is
 * the root's own parameters (data-* defaults). Defined (non-enumerable) on the context only when
 * the scene's own expressions name `self` and the host gave none.
 */
function rootSelf(tree: SceneNode, context: Record<string, unknown>): void {
  const own = Object.getOwnPropertyDescriptor(context, 'self');
  if (own && !(own.value && ROOT_SELVES.has(own.value as object))) return;
  let uses = false;
  walk(tree, (n) => {
    if (n.scope) return;
    for (const v of Object.values(n.tml)) if (/\bself\b/.test(v)) uses = true;
  });
  if (!uses) return;
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(tree.attrs)) if (k.startsWith('data-')) params[k] = v;
  const self = makeSelf({ node: tree, params }, context);
  ROOT_SELVES.add(self);
  Object.defineProperty(context, 'self', { value: self, configurable: true, enumerable: false, writable: true });
}

/** Contexts of instance scopes over the scene's context, made once per scope. */
function scopeContexts(root: Record<string, unknown>): SceneIndex['contextOf'] {
  const memo = new Map<InstanceScope, Record<string, unknown>>();
  const of = (s: InstanceScope | null | undefined): Record<string, unknown> => {
    if (!s) return root;
    let c = memo.get(s);
    if (!c) {
      const parent = of(s.parent);
      c = { ...parent, self: makeSelf(s, parent) };
      memo.set(s, c);
    }
    return c;
  };
  return of;
}

/** A node's tml split by the scope each key evaluates in (v0.9: refs of an outer heir keep theirs). */
function tmlByScope(node: SceneNode): Map<InstanceScope | undefined, Record<string, string>> {
  const out = new Map<InstanceScope | undefined, Record<string, string>>();
  for (const [k, v] of Object.entries(node.tml)) {
    const s = node.keyScope && k in node.keyScope ? (node.keyScope[k] ?? undefined) : node.scope;
    let g = out.get(s);
    if (!g) out.set(s, (g = {}));
    g[k] = v;
  }
  return out;
}

const POINTER_KEYS: [string, PointerKind][] = [
  ['on-over', 'over'],
  ['on-out', 'out'],
  ['on-down', 'down'],
  ['on-up', 'up'],
];

/** Report a runtime failure that is not an expression's own (an unknown view name) by the policy. */
function reportAt(info: ExpressionErrorInfo, opts: ExpressionErrorOptions): void {
  opts.onError?.(info);
  if (opts.lenient || opts.onError) return;
  throw new ExpressionRuntimeError(info);
}

function indexScene(tree: SceneNode, context: Record<string, unknown>): SceneIndex {
  const nodes = new Map<string, SceneNode>();
  const parents = new Map<SceneNode, SceneNode | null>();
  walk(tree, (n, p) => {
    parents.set(n, p);
    if (n.attrs.id && !nodes.has(n.attrs.id)) nodes.set(n.attrs.id, n);
  });
  const index: SceneIndex = {
    hitTest(id, x, y) {
      const n = nodes.get(id);
      if (!n) throw new Error(`Trempel hitTest error: hitTest("${id}") — узла с таким id в сцене нет.`);
      const chain: SceneNode[] = [];
      for (let c: SceneNode | null | undefined = n; c; c = parents.get(c)) chain.unshift(c);
      const adjust = index.layout?.placed;
      return pointInNode(n, nodeMatrix(chain, adjust), x, y, adjust);
    },
    nodes,
    handles: new Map(),
    contextOf: scopeContexts(context),
    clips: clipPaths(tree),
    path(id) {
      const n = nodes.get(id);
      if (!n) throw new Error(`Trempel path error: path("${id}") — узла с таким id в сцене нет.`);
      try {
        return pathFromNode(n);
      } catch (e) {
        throw new Error(`Trempel path error: ${(e as Error).message}`);
      }
    },
    view(id, name) {
      const n = nodes.get(id);
      if (!n) throw new Error(`Trempel view error: setView("${id}") — узла с таким id в сцене нет.`);
      const img = singleImage(n);
      const raw = img?.attrs['data-views'];
      if (!img || raw == null) throw new Error(`Trempel view error: #${id} — нет <image> с data-views.`);
      const href = parseViews(raw).get(name);
      if (href === undefined) {
        throw new Error(`Trempel view error: #${id} — варианта «${name}» нет (есть: ${[...parseViews(raw).keys()].join(', ')}).`);
      }
      return href;
    },
  };
  return index;
}

/**
 * The backend as the scene sees it: hrefs resolved (baseUrl / resolveHref) before the real backend
 * gets them, `setProp('clip-path', 'url(#m)' | 'none')` turned into setClip with the <clipPath>
 * node. Optional methods are forwarded as they are.
 */
function sceneBackend(
  backend: RendererBackend,
  res: ((href: string) => string) | null,
  clips: Map<string, SceneNode>,
): RendererBackend {
  const setClip = (node: NodeHandle, value: unknown): void => {
    const id = parseClipRef(value);
    const clip = id == null ? null : clips.get(id);
    if (clip === undefined) throw new Error(`Trempel clip error: clip-path="${String(value)}" — <clipPath id="${id}"> в сцене нет.`);
    if (!backend.setClip) throw new Error('Trempel clip error: бэкенд не умеет clip-path (нет setClip).');
    backend.setClip(node, clip);
  };
  return {
    createNode: (tag, attrs) =>
      backend.createNode(tag, res && attrs.href != null ? { ...attrs, href: res(attrs.href) } : attrs),
    setProp: (node, path, value) => {
      if (path === 'clip-path') return setClip(node, value);
      backend.setProp(node, path, res && path === 'href' && value != null ? res(String(value)) : value);
    },
    onClick: (node, handler) => backend.onClick(node, handler),
    onPointer: backend.onPointer ? (node, kind, handler) => backend.onPointer!(node, kind, handler) : undefined,
    addChild: (parent, child) => backend.addChild(parent, child),
    mount: (root, container) => backend.mount(root, container),
    getBounds: (node) => backend.getBounds(node),
    whenReady: backend.whenReady ? () => backend.whenReady!() : undefined,
    setClip: backend.setClip ? (node, clip) => backend.setClip!(node, clip) : undefined,
    getProp: backend.getProp ? (node, path) => backend.getProp!(node, path) : undefined,
  };
}

/** Attributes an <image> hands to its wrapping group when it is clipped (the group is "the node"). */
const WRAPPER_ATTRS = ['id', 'transform', 'opacity', 'display', 'visibility'];

/** A clipped <image>: group (id, transform, opacity…) → sprite (x, y, size, href) + the mask. */
function buildClippedImage(node: SceneNode, backend: RendererBackend): NodeHandle {
  const outer: Record<string, string> = {};
  const inner: Record<string, string> = {};
  for (const [k, v] of Object.entries(node.attrs)) {
    if (k === 'clip-path') continue;
    (WRAPPER_ATTRS.includes(k) ? outer : inner)[k] = v;
  }
  const group = backend.createNode('g', outer);
  backend.addChild(group, backend.createNode('image', inner));
  return group;
}

function buildNode(
  node: SceneNode,
  opts: MountOptions,
  index: SceneIndex,
  byId: Map<string, NodeHandle>,
  components: Map<string, ComponentInstance>,
  inherited: Inherited = {},
): NodeHandle | null {
  const { backend, registry } = opts;
  let handle: NodeHandle;

  // Service geometry: not drawn; clip paths are built per use by setClip.
  if (node.tag === 'defs' || node.tag === 'clipPath') return null;

  const clipped = node.attrs['clip-path'] != null || node.tml['bind-clip-path'] !== undefined;
  const blend = parseBlend(node.attrs.style) ?? inherited.blend;
  const tint = node.attrs['data-tint'] != null ? parseTint(node.attrs['data-tint']) : inherited.tint;
  const down: Inherited = { blend, tint };
  const type = node.tml.type;
  if (type) {
    if (!registry) {
      throw new Error(`Trempel scene error: tml:type="${type}" used but no registry provided`);
    }
    const instance = registry.create(type, {
      tag: node.tag,
      attrs: node.attrs,
      tml: node.tml,
      backend,
      children: node.children,
      resolveHref: hrefResolver(opts) ?? ((href) => href),
      param: (name) => componentParam(node.tml, node.attrs, name),
      path: (id) => index.path(id),
      setView: (id, name) => backend.setProp(viewTarget(byId, id), 'href', index.view(id, name)),
      hitTest: (id, x, y) => index.hitTest(id, x, y),
    });
    handle = instance.root;
    if (node.attrs.id) components.set(node.attrs.id, instance);
    // Component owns its subtree; we do not descend into node.children here.
  } else if (node.tag === 'image' && clipped) {
    handle = buildClippedImage(node, backend);
  } else {
    handle = backend.createNode(node.tag, node.attrs);
    // Sterile-base text is layout copy (spec: "макетные тексты вместо биндингов"). Seed it so it
    // renders as authored; a tml:bind, if present, overrides it reactively below.
    if (node.tag === 'text' && node.text != null && node.tml.bind === undefined) {
      backend.setProp(handle, 'text', node.text);
    }
    const placed: [SceneNode, NodeHandle][] = [];
    for (const child of node.children) {
      const childHandle = buildNode(child, opts, index, byId, components, down);
      if (childHandle) {
        backend.addChild(handle, childHandle);
        placed.push([child, childHandle]);
      }
    }
    // Order among siblings (v0.8): set once the children sit in their parent.
    for (const [child, h] of placed) {
      if (child.attrs['data-z'] != null) backend.setProp(h, 'z', parseZ(child.attrs['data-z']));
    }
  }

  if (blend !== undefined) backend.setProp(handle, 'mix-blend-mode', blend);
  // A group passes its tint down to its images (a component / clipped image gets it on its handle).
  if (tint !== undefined && (node.tag === 'image' || type)) backend.setProp(handle, 'tint', tint);

  if (node.attrs['clip-path'] != null) backend.setProp(handle, 'clip-path', node.attrs['clip-path']);

  const policy: ExpressionErrorOptions = { onError: opts.onError, lenient: opts.lenient };
  const whereNode = node.attrs.id ? `#${node.attrs.id}` : `<${node.tag}>`;
  for (const [scope, tml] of tmlByScope(node)) {
    const context = index.contextOf(scope);
    const { 'bind-view': bindView, ...rest } = tml;
    applyBindings(handle, node.tag, rest, backend, context, { ...policy, id: node.attrs.id });

    if (bindView !== undefined) {
      const img = singleImage(node);
      const raw = img?.attrs['data-views'];
      if (!img || raw == null) throw new Error(`Trempel view error: ${whereNode} tml:bind-view — нет <image> с data-views.`);
      const views = parseViews(raw);
      const c = compile(bindView);
      const where = { node: whereNode, attr: 'tml:bind-view' };
      effect(() => {
        const v = evalAt(c, context, where, policy);
        if (failed(v)) return;
        const href = v == null || v === '' ? img.attrs.href : views.get(String(v));
        if (href === undefined) {
          const error = new Error(`варианта «${String(v)}» нет (есть: ${[...views.keys()].join(', ')})`);
          reportAt({ ...where, expr: bindView, error }, policy);
          return;
        }
        backend.setProp(handle, 'href', href);
      });
    }

    const onClick = tml['on-click'];
    if (onClick) {
      const c = compile(onClick);
      const where = { node: whereNode, attr: 'tml:on-click' };
      backend.onClick(handle, () => {
        evalAt(c, context, where, policy);
      });
    }
    for (const [key, kind] of POINTER_KEYS) {
      const src = tml[key];
      if (!src) continue;
      if (!backend.onPointer) throw new Error(`Trempel scene error: ${whereNode} tml:${key} — бэкенд не умеет события указателя (нет onPointer).`);
      const c = compile(src);
      const where = { node: whereNode, attr: `tml:${key}` };
      backend.onPointer(handle, kind, () => {
        evalAt(c, context, where, policy);
      });
    }
  }

  if (node.attrs.id) byId.set(node.attrs.id, handle);
  index.handles.set(node, handle);
  return handle;
}

/** Build an already-parsed (and merged) tree onto the backend and optionally mount it. */
function buildScene(tree: SceneNode, options: MountOptions): MountedScene {
  rootSelf(tree, options.context);
  const index = indexScene(tree, options.context);
  const opts = { ...options, backend: sceneBackend(options.backend, hrefResolver(options), index.clips) };
  const byId = new Map<string, NodeHandle>();
  const components = new Map<string, ComponentInstance>();
  const root = buildNode(tree, opts, index, byId, components)!;
  const layout = (index.layout = layoutScene(tree, index.handles, opts.backend));
  if (opts.container !== undefined) {
    opts.backend.mount(root, opts.container);
  }
  const ready = opts.backend.whenReady ? opts.backend.whenReady() : Promise.resolve();
  ready.catch(() => {}); // the host may not await it; awaiting still sees the rejection
  return {
    root,
    byId,
    components,
    ready,
    path: (id) => index.path(id),
    setView: (id, name) => opts.backend.setProp(viewTarget(byId, id), 'href', index.view(id, name)),
    hitTest: (id, x, y) => index.hitTest(id, x, y),
    hitTestAll: (x, y) => hitTestTree(tree, x, y, layout.placed),
    resize(w, h) {
      const box = layout.box(tree);
      if (!box) throw new Error('Trempel resize error: у корня нет viewBox — размер сцены не задан.');
      box.size.w = w;
      box.size.h = h;
    },
    setSize(id, w, h) {
      const n = index.nodes.get(id);
      const handle = byId.get(id);
      if (!n || !handle) throw new Error(`Trempel size error: setSize("${id}") — узла с таким id в сцене нет.`);
      const box = layout.box(n);
      if (box) {
        if (n.instance) {
          const axes = n.instance.resizable ?? '';
          if ((w !== undefined && !axes.includes('x')) || (h !== undefined && !axes.includes('y'))) {
            throw new Error(`Trempel size error: #${id} — ${n.instance.href} растягивается ${axes ? `только по ${axes}` : 'никак (нет data-resizable)'}.`);
          }
        }
        if (w !== undefined) box.size.w = w;
        if (h !== undefined) box.size.h = h;
        return;
      }
      if (n.tag !== 'image' && n.tag !== 'rect') throw new Error(`Trempel size error: #${id} — размер задаётся у инстанса растягиваемого префаба, <g data-size>, <image> и <rect>.`);
      if (w !== undefined) opts.backend.setProp(handle, 'width', w);
      if (h !== undefined) opts.backend.setProp(handle, 'height', h);
    },
    sizeOf(id) {
      const n = index.nodes.get(id);
      if (!n) return undefined;
      const box = layout.box(n);
      if (box) return { w: box.size.w, h: box.size.h };
      const p = layout.placed(n);
      return p?.w !== undefined || p?.h !== undefined ? { w: p.w ?? Number(n.attrs.width), h: p.h ?? Number(n.attrs.height) } : undefined;
    },
  };
}

/**
 * Build a tree the caller composed itself (composeScene — a viewer that reports problems instead of
 * throwing) onto the backend. No checks: they are the caller's.
 */
export function mountTree(tree: SceneNode, opts: MountOptions): MountedScene {
  return buildScene(tree, opts);
}

/** The built node setView writes href to (a group with one image passes it down — backend rule). */
function viewTarget(byId: Map<string, NodeHandle>, id: string): NodeHandle {
  const h = byId.get(id);
  if (!h) throw new Error(`Trempel view error: setView("${id}") — узел ещё не построен или вне сцены.`);
  return h;
}

/** Single-document mount: parse an SVG (with inline tml) and build it. */
export function mountScene(svg: string, opts: MountOptions): MountedScene {
  const tree = parse(svg);
  const errors: string[] = [];
  if (hasInstances(tree)) errors.push(...expandInstances(tree, { loadScene: opts.loadScene as SceneLoader | undefined, url: sceneUrlOf(opts) }));
  errors.push(...geometryErrors(tree), ...propErrors(tree), ...bindingErrors(tree));
  if (errors.length) throw new TrempelError(errors);
  return buildScene(tree, opts);
}

/**
 * Two-document mount (v0.5): parse the base, expand prefab instances (v0.9), validate against the
 * contract, merge the heir, and build the result. All merge + contract + prefab problems are thrown
 * together as one TrempelError. Without `base` the heir must extend another scene (loadScene).
 */
export function mount(args: MountArgsLoose): MountedScene {
  const { base, heir, contract, path, ...opts } = args;
  // Top-level documents that do not parse fail as before — a plain Error with the parser's words.
  if (base != null) parse(base);
  if (heir != null) parseHeir(heir);
  if (contract != null) parseContract(contract);

  const c = composeScene({ base, heir, contract, path, loadScene: opts.loadScene as SceneLoader | undefined, url: sceneUrlOf(opts) });
  const errors: string[] = [...c.errors.contract, ...c.errors.merge, ...c.errors.prefab, ...c.errors.parse];
  if (c.tree) {
    errors.push(...geometryErrors(c.tree));
    errors.push(...propErrors(c.tree));
    errors.push(...bindingErrors(c.tree));
  }
  const deduped = [...new Set(errors)];
  if (deduped.length || !c.tree) throw new TrempelError(deduped.length ? deduped : ['сцена пуста']);

  return buildScene(c.tree, opts);
}

/**
 * mount() with an asynchronous prefab loader (v0.9): every document the scene needs (instances, the
 * tml:extends chain) is loaded first, then the scene mounts synchronously.
 */
export async function mountAsync(args: MountArgsLoose): Promise<MountedScene> {
  const { loadScene } = args;
  if (!loadScene) return mount(args);
  const sync = await preloadScenes({ base: args.base, heir: args.heir, contract: args.contract, path: args.path, url: sceneUrlOf(args) }, loadScene);
  return mount({ ...args, loadScene: sync });
}
