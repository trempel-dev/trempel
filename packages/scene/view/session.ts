// session.ts — open one scene for viewing: the real mount() over any RendererBackend, with every
// problem collected as a list for the panel instead of thrown or logged to the console.
//
// Order mirrors the runtime: parse → contract (against the pristine base) → merge → expression
// syntax → mount → texture readiness. Problems are classified so the panel (and the headless
// shot's JSON) says what failed. The viewer still shows what it can: contract errors do not stop
// the render; merge/expression errors render the base alone (the heir is unusable).
//
// Expression context: `state` (the stand-in state, reactive) + what the consumer's module gives;
// any other name the scene's expressions use becomes a stub, so handlers (on-click) never crash
// the viewer — clicks go to the log with the calls they made.

import { coded, codeOf, expandCollection, composeScene, ExpressionRuntimeError, TrempelError, mountTree, parseHeir, reactive, type SceneLoader, type MountedScene, type NodeHandle, type Registry, type RendererBackend, type SceneNode } from '../src/core.js';
import { bindingErrors } from '../src/binding.js';
import { collectionErrors } from '../src/project.js';
import { geometryErrors } from '../src/geom/check.js';
import { propErrors } from '../src/props.js';
import { resolveHref } from '../src/href.js';
import { sceneNames } from '../src/names.js';
import { parseViewBox, type ViewBox } from './viewport.js';

export type IssueKind =
  | 'base' // no base document
  | 'parse' // XML / unsupported SVG
  | 'contract'
  | 'merge'
  | 'prefab' // v0.9: an instance (<use href>) or the tml:extends chain
  | 'collection' // v1.1: an href into a collection the project does not declare
  | 'expression' // syntax, unknown pipe
  | 'runtime' // expression failed while running (onError)
  | 'component' // registry / component factory
  | 'asset' // textures that did not load
  | 'state' // X.state.json / the editor
  | 'context' // names without an implementation (stubs)
  | 'clips'; // clip compile errors / a clip that cannot play (view:shot --clip, the editor's Clips panel)

export interface ViewIssue {
  level: 'error' | 'warn';
  kind: IssueKind;
  message: string;
}

export interface LogEntry {
  seq: number;
  /** `#id` of the clicked node. */
  node: string;
  /** Its tml:on-click expression. */
  expr: string;
  /** Stub calls the handler made, e.g. `play()`, `buy(1, "x")`. */
  calls: string[];
}

export interface SceneSources {
  base?: string;
  heir?: string;
  contract?: string;
}

export interface OpenInput {
  sources: SceneSources;
  /** Stand-in state: JSON text (X.state.json / editor) or an object. */
  state?: string | Record<string, unknown>;
  backend: RendererBackend;
  registry?: Registry;
  container?: unknown;
  baseUrl?: string;
  resolveHref?: (href: string) => string;
  /** v0.9: prefab documents (synchronous — the runtime preloads them). */
  loadScene?: SceneLoader;
  /** v0.9: URL of the scene document prefab hrefs resolve against (default: baseUrl). */
  sceneUrl?: string;
  /** v0.9: the scene's path (`ui/button.svg`) — cycles of tml:extends. */
  path?: string;
  /** v1.1: collections — name → folder URL (`@name/x` → `<URL>/x`, before baseUrl / resolveHref). */
  collections?: Record<string, string>;
  /** Consumer context next to `state`. */
  context?: (state: Record<string, unknown>) => Record<string, unknown>;
  /** Readiness gives up after this long (a warning, not a hang). Default 15 s. */
  readyTimeoutMs?: number;
  /** Called on every issue found after open() returned (runtime, assets). */
  onIssue?: (issue: ViewIssue) => void;
  /** Called after each click handler ran. */
  onLog?: (entry: LogEntry) => void;
}

export interface ViewSession {
  scene: MountedScene | null;
  /** The tree that was mounted (base, or base + heir) — clips compile against it. */
  tree: SceneNode | null;
  /**
   * The backend as mount() got it, with hrefs resolved like the scene's (baseUrl / resolveHref) —
   * for an Animator over this scene: clip hrefs (tex / view) then load like the base's.
   */
  animBackend: RendererBackend | null;
  /** viewBox of the base root (null when absent / unparseable). */
  viewBox: ViewBox | null;
  issues: ViewIssue[];
  log: LogEntry[];
  state: Record<string, unknown>;
  /** Names that got stubs. */
  stubs: string[];
  /** Settles (never rejects) once textures arrived, failed or timed out; asset issues are in by then. */
  ready: Promise<void>;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Every context name a (merged) tree's expressions use (moved to the core, v1.1 — flatten stubs them too). */
export { sceneNames };

const fmtArg = (v: unknown): string => {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
};

/** A parse error of the heir document (`heir: …`, with or without a code in front). */
export function isHeirError(m: string): boolean {
  const code = codeOf(m);
  return /^heir\b/.test(code ? m.slice(code.length + 2) : m);
}

/** Parse the stand-in state: an object, or an issue. */
export function parseState(src: string | Record<string, unknown> | undefined): { state: Record<string, unknown>; issue?: ViewIssue } {
  if (src == null || src === '') return { state: {} };
  if (typeof src !== 'string') return { state: src };
  try {
    const v: unknown = JSON.parse(src);
    if (v && typeof v === 'object' && !Array.isArray(v)) return { state: v as Record<string, unknown> };
    return { state: {}, issue: { level: 'error', kind: 'state', message: coded('E_STATE', 'the state must be a JSON object ({ … }) — it is the value of `state` in expressions') } };
  } catch (e) {
    return { state: {}, issue: { level: 'error', kind: 'state', message: coded('E_STATE', `the state is not JSON: ${message(e)}`) } };
  }
}

/** Open a scene: check, mount over `backend`, collect issues. Never throws for scene problems. */
export function openScene(input: OpenInput): ViewSession {
  const issues: ViewIssue[] = [];
  const log: LogEntry[] = [];
  const seen = new Set<string>();
  const add = (issue: ViewIssue, late = false): void => {
    const key = `${issue.kind}\n${issue.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    issues.push(issue);
    if (late) input.onIssue?.(issue);
  };
  const err = (kind: IssueKind, msgs: string[]): void => msgs.forEach((m) => add({ level: 'error', kind, message: m }));

  const parsedState = parseState(input.state);
  if (parsedState.issue) add(parsedState.issue);
  const state = reactive(parsedState.state);

  const session: ViewSession = { scene: null, tree: null, animBackend: null, viewBox: null, issues, log, state, stubs: [], ready: Promise.resolve() };
  const { base, heir, contract } = input.sources;

  let extendsOther = false;
  if (base == null && heir != null) {
    try {
      extendsOther = parseHeir(heir).extends != null;
    } catch {
      // reported by the composition below
    }
  }
  if (base == null && (!extendsOther || !input.loadScene)) {
    err('base', [coded('E_EMPTY_SCENE', 'no base (X.svg next to the heir) — nothing to draw')]);
    return session;
  }

  // parse → instances → contract (pre-heir) → heir → instances it inserted: one composition (v0.9).
  const compose = (noHeir: boolean) =>
    composeScene({
      base,
      heir,
      contract,
      noHeir,
      path: input.path,
      loadScene: input.loadScene,
      url: (rel) => {
        const doc = input.sceneUrl ?? input.baseUrl;
        const own = expandCollection(rel, input.collections);
        return doc ? resolveHref(own, doc) : own;
      },
    });
  const full = compose(false);
  err('parse', full.errors.parse);
  err('prefab', full.errors.prefab);
  err('contract', full.errors.contract);
  let tree: SceneNode | null = full.tree;
  if (heir != null && base != null) {
    const exprErrors = full.errors.merge.length || !full.tree ? [] : bindingErrors(full.tree);
    err('merge', full.errors.merge);
    err('expression', exprErrors);
    if (full.errors.merge.length || exprErrors.length || full.errors.parse.some(isHeirError)) {
      add({ level: 'warn', kind: 'merge', message: coded('W_VIEW_HEIR', 'the heir is not applied — showing the base without it') });
      const bare = compose(true);
      err('prefab', bare.errors.prefab);
      tree = bare.tree;
    }
  } else {
    err('merge', full.errors.merge);
    if (tree) err('expression', bindingErrors(tree));
  }
  if (!tree) return session;
  session.viewBox = parseViewBox(tree.attrs.viewBox);
  const unknown = collectionErrors(tree, input.collections);
  if (unknown.length) {
    err('collection', unknown);
    return session;
  }
  // What mount() would refuse to build (geometry, v0.8 attributes): listed, nothing drawn.
  const hard = [...geometryErrors(tree), ...propErrors(tree)];
  if (hard.length) {
    err('merge', hard);
    return session;
  }

  // Context: state + consumer + stubs for everything else the expressions name.
  const { names, clicks } = sceneNames(tree);
  let consumer: Record<string, unknown> = {};
  try {
    consumer = input.context?.(state) ?? {};
  } catch (e) {
    err('context', [coded('E_VIEW_MODULE', `view module context(): ${message(e)}`)]);
  }
  let clicking: LogEntry | null = null;
  const context: Record<string, unknown> = { state, ...consumer };
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(context, name)) continue;
    session.stubs.push(name);
    context[name] = (...args: unknown[]): undefined => {
      clicking?.calls.push(`${name}(${args.map(fmtArg).join(', ')})`);
      return undefined;
    };
  }
  if (session.stubs.length) {
    add({ level: 'warn', kind: 'context', message: coded('W_CONTEXT_STUB', `not in the context — stubbed (click calls go to the log): ${session.stubs.join(', ')}`) });
  }

  // Clicks: the backend view logs each handler with its node and the stub calls it made.
  let byHandle: Map<NodeHandle, string> | null = null;
  let seq = 0;
  const { backend } = input;
  const view: RendererBackend = {
    createNode: (tag, attrs) => backend.createNode(tag, attrs),
    setProp: (node, path, value) => backend.setProp(node, path, value),
    addChild: (parent, child) => backend.addChild(parent, child),
    mount: (root, container) => backend.mount(root, container),
    getBounds: (node) => backend.getBounds(node),
    whenReady: backend.whenReady ? () => backend.whenReady!() : undefined,
    setClip: backend.setClip ? (node, clip) => backend.setClip!(node, clip) : undefined,
    getProp: backend.getProp ? (node, path) => backend.getProp!(node, path) : undefined,
    onPointer: backend.onPointer ? (node, kind, handler) => backend.onPointer!(node, kind, handler) : undefined,
    onClick: (node, handler) =>
      backend.onClick(node, () => {
        if (!byHandle) byHandle = new Map([...(session.scene?.byId ?? [])].map(([id, h]) => [h, id]));
        const id = byHandle.get(node);
        const entry: LogEntry = { seq: ++seq, node: id ? `#${id}` : '(node without id)', expr: (id && clicks.get(id)) || '', calls: [] };
        clicking = entry;
        try {
          handler();
        } finally {
          clicking = null;
        }
        log.push(entry);
        input.onLog?.(entry);
      }),
  };

  let opened = false;
  const res = (href: string): string => {
    const own = expandCollection(href, input.collections);
    const abs = input.baseUrl ? resolveHref(own, input.baseUrl) : own;
    return input.resolveHref ? input.resolveHref(abs) : abs;
  };
  try {
    session.tree = tree;
    session.animBackend = {
      ...view,
      setProp: (node, path, value) => view.setProp(node, path, path === 'href' && value != null ? res(String(value)) : value),
    };
    session.scene = mountTree(tree, {
      backend: view,
      registry: input.registry,
      context,
      container: input.container,
      baseUrl: input.baseUrl,
      resolveHref: input.resolveHref,
      collections: input.collections,
      onError: (info) => add({ level: 'error', kind: 'runtime', message: new ExpressionRuntimeError(info).message }, opened),
    });
  } catch (e) {
    const list = e instanceof TrempelError ? e.errors : [message(e)];
    for (const m of list) {
      const code = codeOf(m);
      const component = code ? code === 'E_COMPONENT' || code === 'E_NO_REGISTRY' : /registry|component/i.test(m);
      err(component ? 'component' : e instanceof TrempelError ? 'merge' : 'runtime', [m]);
    }
    return session;
  } finally {
    opened = true;
  }

  const timeout = input.readyTimeoutMs ?? 15_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  session.ready = Promise.race([
    session.scene.ready.then(
      () => undefined,
      (e: unknown) => {
        const list = e instanceof TrempelError ? e.errors : [message(e)];
        list.forEach((m) => add({ level: 'error', kind: 'asset', message: m }, true));
      },
    ),
    new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        add({ level: 'warn', kind: 'asset', message: coded('W_VIEW_TEXTURE_TIMEOUT', `textures did not load within ${timeout / 1000} s`) }, true);
        resolve();
      }, timeout);
    }),
  ]).finally(() => clearTimeout(timer));

  return session;
}

/** Errors (not warnings) — the headless shot's exit code. */
export const hasErrors = (issues: ViewIssue[]): boolean => issues.some((i) => i.level === 'error');
