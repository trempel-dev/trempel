// editor.ts — the editor's state and its one loop: document (@trempel/scene/editor) → render by the real
// runtime → measure → panels. Every change is a core command; the UI never edits attributes.
//
// Render: the base text (doc.serialize()) is annotated with index paths and mounted with the heir
// by the viewer's runtime (view/runtime.ts) — so what is drawn is what the game draws, and each
// drawn node of the base is known by its path. After a command the scene is reopened (selection,
// scope, zoom and pan stay); a gesture's live feedback writes the node handles (setProp) and
// the release commits one command (one undo entry).

import { Application, Container, Graphics } from 'pixi.js';
import { geometryErrors, preloadScenes, propErrors, mergeScene, parse, parseHeir, parsePathData, readHeir, readHeirAsync, resolveHref, sceneStem, type NodeHandle, type RendererBackend, type SceneLoader, type SceneNode, type SceneSource } from '../../src/core.js';
import { openDocument, type CommandResult, type EditorDocument } from '../../editor/index.js';
import { anchorPoints, toEditCmds } from '../../editor/path.js';
import { discoverScenes, type SceneEntry } from '../../view/discover';
import { folderSceneLoader, type StageRuntime } from '../../view/runtime';
import type { ViewIssue, ViewSession } from '../../view/session';
import { type StageFit, type Viewport } from '../../view/viewport';
import { apply, canvasToScene, centredOrigin, geometryBox, invert as invertM, isWithin, mapBox, nodeAt, nodeWorld, parentPath, stageView, zoomAbout, type Box, type Call, type Matrix, type Pt } from '../geometry';
import type { HitNode } from '../hittest';
import { clipFiles, relativeTo, sha1, type FileChange, type FolderListing, type SceneIO } from '../io';
import { annotate, PATH_ATTR, recordingBackend, StandInRegistry } from '../render';

export type Tool = 'select' | 'path';
export type EditorEvent = 'scenes' | 'render' | 'selection' | 'doc' | 'log' | 'issues' | 'tool' | 'layout' | 'readonly' | 'op';

export interface LogLine {
  level: 'info' | 'warn' | 'error';
  text: string;
  at: number;
}

/** A row of the layers tree: a base element (path) or a heir insert (foreign, not selectable). */
export interface Row {
  path: string | null;
  tag: string;
  id?: string;
  /** tml:type of the merged node (a component). */
  type?: string;
  /** v0.9: a prefab instance (<use>): its href; its rows below are the prefab's (read-only). */
  href?: string;
  /** v0.8: data-z, the own mix-blend-mode (raw style value), data-views names. */
  z?: string;
  blend?: string;
  views?: string;
  children: Row[];
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const SERVICE = new Set(['defs', 'clipPath']);
export const ZOOM_MIN = 0.05;
export const ZOOM_MAX = 8;

export class Editor {
  readonly app = new Application();
  /** What the canvas shows: background + the scene root placed by `fit`. */
  readonly holder = new Container();
  readonly world = new Container();
  /** Layers in scene units (placed like `world`): under the scene (the reference) and over it (onion, the reference on top). */
  readonly under = new Container();
  readonly over = new Container();
  /**
   * Why the stage is read-only now (a clip is posing the scene — handles and hit-test are off), or
   * null. Set through setReadOnly().
   */
  readOnly: string | null = null;
  /** Clip files of the scene (md clips), as last read (a compiled .json next to them is the game's — not read). */
  clipSources: { md: Record<string, string> } = { md: {} };

  listing: FolderListing = { name: '', files: [], module: null, writable: false };
  scenes: SceneEntry[] = [];
  entry: SceneEntry | null = null;
  doc: EditorDocument | null = null;
  heir: string | undefined;
  /** The scene's contract text as last read. */
  contractText: string | undefined;
  stateText: string | undefined;
  /** Base merged with the heir from the annotated text: paths on base nodes, none on inserts. */
  display: SceneNode | null = null;
  rows: Row[] = [];

  session: ViewSession | null = null;
  fit: StageFit = { width: 64, height: 64, scale: 1, x: 0, y: 0 };
  /** CSS px per canvas px; null — fit into the stage area. */
  zoom: number | null = null;
  /** Pan: the canvas's shift from centred, screen px (survives re-renders, like zoom). */
  offset: Pt = { x: 0, y: 0 };
  viewport: Viewport = { kind: 'scene' };
  /** Index path → drawn node (the node with that id when it has one). */
  handles = new Map<string, NodeHandle>();
  /** Index path → scene-space bounds (runtime for drawn nodes, geometry for service ones). */
  bounds = new Map<string, Box>();
  backend: RendererBackend | null = null;
  /** v0.9: prefab documents read for this scene (folder-relative path → text); dropped when the file changes. */
  prefabTexts = new Map<string, string>();
  /** Folder-relative stems (`ui/button`) of the prefabs the open scene uses (transitively). */
  prefabDeps = new Set<string>();

  selection: string[] = [];
  scope = '';
  hidden = new Set<string>();
  /** Instance rows already shown (collapsed on first sight only). */
  private seenInstances = new Set<string>();
  locked = new Set<string>();
  collapsed = new Set<string>();
  showService = true;
  /** A modal operator (G/R/S, pivot pick) is running: frames and the gizmo step aside. */
  operating = false;
  tool: Tool = 'select';

  renderIssues: ViewIssue[] = [];
  logs: LogLine[] = [];
  /** Hash of what we last wrote/read for the base: a watch event with it is our own. */
  lastHash: string | null = null;
  private warned = new Set<string>();
  private listeners = new Map<EditorEvent, Set<() => void>>();
  private renderWanted = false;
  private renderLoop: Promise<void> | null = null;
  private unwatch: (() => void) | null = null;

  constructor(
    readonly io: SceneIO,
    readonly runtime: StageRuntime,
    readonly ui: { confirm(text: string, buttons: string[]): Promise<number> },
  ) {}

  // ---- events --------------------------------------------------------------------------------

  on(e: EditorEvent, fn: () => void): () => void {
    let set = this.listeners.get(e);
    if (!set) this.listeners.set(e, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  emit(...events: EditorEvent[]): void {
    for (const e of events) for (const fn of this.listeners.get(e) ?? []) fn();
  }

  log(level: LogLine['level'], text: string): void {
    this.logs.push({ level, text, at: Date.now() });
    if (this.logs.length > 300) this.logs.splice(0, this.logs.length - 300);
    this.emit('log');
  }

  // ---- boot / folder ---------------------------------------------------------------------------

  async init(slot: HTMLElement): Promise<void> {
    await this.app.init({ width: 64, height: 64, backgroundAlpha: 0, antialias: true, preference: 'webgl', autoDensity: false });
    slot.appendChild(this.app.canvas);
    this.app.stage.addChild(this.holder);
    this.holder.addChild(this.world);
    this.unwatch = this.io.watch('', (c) => void this.onFileChange(c));
  }

  dispose(): void {
    this.unwatch?.();
  }

  /**
   * The open scene is a heir without its own base (`tml:extends` a prefab): what it extends and
   * that scene's id when it is in the folder (the page offers to open it), else null.
   */
  noBase: { extends: string; scene: string | null } | null = null;

  /** The folder could not be listed (fully or at all). */
  folderIssue: ViewIssue | null = null;

  async loadFolder(): Promise<void> {
    this.listing = await this.io.list('');
    this.folderIssue = this.listing.error ? { level: 'warn', kind: 'base', message: this.listing.error } : null;
    this.scenes = discoverScenes(this.listing.files);
    if (this.entry) this.entry = this.scenes.find((s) => s.id === this.entry!.id) ?? this.entry;
    this.emit('scenes');
  }

  // ---- scene / document --------------------------------------------------------------------------

  /** Open a scene for editing (asks about unsaved changes first). */
  async openScene(entry: SceneEntry, opts: { force?: boolean } = {}): Promise<boolean> {
    if (!opts.force && this.doc?.dirty && entry.id !== this.entry?.id) {
      const k = await this.ui.confirm(`В «${this.entry?.id}» несохранённые правки.`, ['Сохранить', 'Отбросить', 'Отмена']);
      if (k === 2) return false;
      if (k === 0 && !(await this.save())) return false;
    }
    const changed = entry.id !== this.entry?.id;
    this.entry = entry;
    if (changed) {
      this.selection = [];
      this.scope = '';
      this.hidden.clear();
      this.locked.clear();
      this.collapsed.clear();
      this.seenInstances.clear();
      this.prefabTexts.clear();
      this.warned.clear();
      this.setTool('select');
    }
    this.emit('scenes');
    await this.loadDocument();
    return true;
  }

  /** (Re)read the scene's files and open the document over them. */
  async loadDocument(): Promise<void> {
    const entry = this.entry;
    if (!entry) return;
    this.doc = null;
    this.noBase = null;
    this.display = null;
    this.rows = [];
    this.renderIssues = [];
    const read = async (p: string | undefined): Promise<string | undefined> => (p ? this.io.read(p) : undefined);
    let base: string | undefined;
    let contract: string | undefined;
    const clips: Record<string, string> = {};
    try {
      [base, this.heir, contract, this.stateText] = await Promise.all([read(entry.base), read(entry.heir), read(entry.contract), read(entry.state)]);
      for (const f of clipFiles(this.listing.files, entry.id)) clips[f] = await this.io.read(f);
      this.clipSources = { md: { ...clips } };
    } catch (e) {
      this.renderIssues = [{ level: 'error', kind: 'base', message: msg(e) }];
      this.emit('issues', 'doc', 'render');
      return;
    }
    if (base == null) {
      // a heir without its own base (a prefab variant): its base is edited where it lives
      const ext = this.heir ? /tml:extends\s*=\s*"([^"]+)"/.exec(this.heir)?.[1] : undefined;
      const from = ext && entry.heir ? resolveHref(ext, entry.heir) : null;
      const stem = from?.replace(/(\.tml)?\.svg$/, '') ?? null;
      this.noBase = ext ? { extends: ext, scene: this.scenes.some((s) => s.id === stem) ? stem : null } : null;
      this.renderIssues = this.noBase ? [] : [{ level: 'error', kind: 'base', message: `нет базы ${entry.id}.svg — редактор правит только базу` }];
      this.emit('issues', 'doc', 'render');
      return;
    }
    this.contractText = contract;
    await this.loadPrefabs(base, contract);
    try {
      this.doc = openDocument(base, { heir: this.heir, contract, clips, path: entry.base, loadScene: this.docLoader() });
    } catch (e) {
      this.renderIssues = [{ level: 'error', kind: 'parse', message: msg(e) }];
      this.emit('issues', 'doc', 'render');
      return;
    }
    if (entry.base) this.lastHash = await sha1Safe(base);
    this.doc.on('change', () => {
      this.emit('doc');
      void this.render();
    });
    this.collapsed.clear();
    this.doc.tree()[0].children.forEach((c) => c.tag === 'defs' && this.collapsed.add(c.path));
    this.emit('doc');
    await this.render();
  }

  // ---- prefabs (v0.9) ----------------------------------------------------------------------------

  /** A folder file's text through the cache (prefab documents). */
  private async readCached(rel: string): Promise<string> {
    const hit = this.prefabTexts.get(rel);
    if (hit != null) return hit;
    const text = await this.io.read(rel);
    this.prefabTexts.set(rel, text);
    return text;
  }

  /** Folder-relative path of an href written in the open scene (null — absolute / no scene). */
  folderPath(href: string): string | null {
    const base = this.entry?.base ?? (this.entry ? `${this.entry.id}.svg` : null);
    if (!base || /^(?:[a-zA-Z][a-zA-Z\d+.-]*:|\/)/.test(href)) return null;
    return resolveHref(href, base);
  }

  /** The documents of a scene of the folder by its base path, from the cache (sync). */
  private cachedScene(path: string): SceneSource | null {
    const stem = sceneStem(path);
    const get = (f: string): string | undefined => this.prefabTexts.get(f);
    const src = { base: get(`${stem}.svg`), heir: readHeir(get, stem), contract: get(`${stem}.contract.xml`) };
    return src.base != null || src.heir != null ? src : null;
  }

  /** The document's loader: hrefs relative to the scene → the cache. */
  docLoader(): SceneLoader {
    return (rel) => {
      const p = this.folderPath(rel);
      return p ? this.cachedScene(p) : null;
    };
  }

  /** Read every prefab document the scene needs (instances, the tml:extends chain) into the cache. */
  async loadPrefabs(base?: string, contract?: string): Promise<void> {
    const entry = this.entry;
    if (!entry) return;
    const listed = new Set(this.listing.files);
    const deps = new Set<string>();
    const load = async (path: string): Promise<SceneSource | null> => {
      const stem = sceneStem(path);
      deps.add(stem);
      const get = (f: string): Promise<string | undefined> => (listed.has(f) ? this.readCached(f).catch(() => undefined) : Promise.resolve(undefined));
      const [b, h, c] = await Promise.all([get(`${stem}.svg`), readHeirAsync(get, stem), get(`${stem}.contract.xml`)]);
      return b != null || h != null ? { base: b, heir: h, contract: c } : null;
    };
    const path = entry.base ?? `${entry.id}.svg`;
    await preloadScenes({ base: base ?? this.doc?.serialize(), heir: this.heir, contract: contract ?? this.contractText, path, url: (rel) => resolveHref(rel, path) }, load);
    this.prefabDeps = deps;
  }

  /** A scene of the folder by its base path, read through the cache (null — not in the folder). */
  private async ioScene(path: string): Promise<SceneSource | null> {
    const listed = new Set(this.listing.files);
    const stem = sceneStem(path);
    const get = (f: string): Promise<string | undefined> => (listed.has(f) ? this.readCached(f).catch(() => undefined) : Promise.resolve(undefined));
    const [b, h, c] = await Promise.all([get(`${stem}.svg`), readHeirAsync(get, stem), get(`${stem}.contract.xml`)]);
    return b != null || h != null ? { base: b, heir: h, contract: c } : null;
  }

  /** Read a scene of the folder (a prefab) and everything it needs into the cache. */
  async loadPrefabsFor(path: string): Promise<void> {
    const top = await this.ioScene(path);
    if (top) await preloadScenes({ ...top, path, url: (rel) => resolveHref(rel, path) }, (p) => this.ioScene(p));
  }

  /** A scene of the folder from the cache (after loadPrefabsFor). */
  sceneSources(path: string): SceneSource | null {
    return this.cachedScene(path);
  }

  /** The runtime's loader for a render of another scene of the folder (palette previews). */
  sceneLoaderForRender() {
    return this.renderLoader();
  }

  /** The runtime's loader (URLs under the folder's URL) over the cache. */
  private renderLoader() {
    return folderSceneLoader(this.io.folderUrl(), this.listing.files, (rel) => this.readCached(rel));
  }

  /** Scenes of the folder that can be placed as prefabs (not the open one), folder-relative base paths. */
  prefabCandidates(): string[] {
    const out: string[] = [];
    for (const s of this.scenes) {
      if (s.id === this.entry?.id) continue;
      out.push(s.base ?? `${s.id}.svg`);
    }
    return out;
  }

  /** Double click on an instance: open its prefab (a scene of the folder). */
  async openPrefab(path: string): Promise<boolean> {
    const n = this.node(path);
    if (n?.tag !== 'use' || !n.attrs.href) return false;
    const p = this.folderPath(n.attrs.href);
    const stem = p?.replace(/\.svg$/, '');
    const entry = this.scenes.find((s) => s.id === stem);
    if (!entry) {
      this.log('warn', `префаб ${n.attrs.href} — не в открытой папке`);
      return false;
    }
    return this.openScene(entry);
  }

  /**
   * Place an instance of a prefab (folder-relative base path) at a scene point (default: the
   * view's centre) in the current scope; selects it.
   */
  async instantiate(prefab: string, at?: Pt): Promise<CommandResult | null> {
    const doc = this.doc;
    const entry = this.entry;
    if (!doc || !entry) return null;
    await this.loadPrefabsFor(prefab);
    doc.refresh();
    let parent = this.scope;
    const scopeNode = this.node(parent);
    if (!scopeNode || (scopeNode.tag !== 'g' && scopeNode.tag !== 'svg')) parent = '';
    const p = at ?? this.viewCentre();
    let local = p;
    try {
      local = apply(invertM(nodeWorld(doc.scene, parent)), p);
    } catch {
      // degenerate transform: scene coordinates
    }
    const stem = prefab.replace(/^.*\//, '').replace(/(\.tml)?\.svg$/, '').replace(/[^\w.-]/g, '_').replace(/^([^A-Za-z_])/, '_$1');
    let id = stem;
    for (let k = 2; countId(doc.scene, id) > 0; k++) id = `${stem}${k}`;
    const href = relativeTo(entry.base ?? `${entry.id}.svg`, prefab);
    const r = this.exec('prefab.instantiate', { ...(parent ? { parent: this.ref(parent) } : {}), href, id, x: Math.round(local.x), y: Math.round(local.y) });
    if (r?.ok) {
      await this.loadPrefabs(); // the scene's prefab set (watch) now has this one
      await this.idle();
      const np = this.pathOfId(id);
      if (np) this.select([np]);
    }
    return r;
  }

  /** The scene point in the middle of the stage area. */
  viewCentre(): Pt {
    try {
      return apply(invertM(this.view()), { x: this.area.w / 2, y: this.area.h / 2 });
    } catch {
      return { x: 0, y: 0 };
    }
  }

  /** prefab.extract + writing the new files (paths relative to the scene → the folder). */
  async extract(path: string, href: string): Promise<CommandResult | null> {
    const r = this.exec('prefab.extract', { node: this.ref(path), href });
    if (!r?.ok) return r;
    for (const f of r.files ?? []) {
      const rel = this.folderPath(f.path);
      if (!rel) continue;
      try {
        await this.io.write(rel, f.text);
        this.prefabTexts.set(rel, f.text);
        this.log('info', `создан префаб: ${rel}`);
      } catch (e) {
        this.log('error', `${rel}: ${msg(e)}`);
      }
    }
    await this.loadFolder().catch(() => {});
    return r;
  }

  /** Save the base: serialize → IO write → markClean. */
  async save(): Promise<boolean> {
    if (!this.doc || !this.entry?.base) return false;
    const text = this.doc.serialize();
    try {
      const { hash } = await this.io.write(this.entry.base, text);
      this.lastHash = hash;
      this.doc.markClean();
      this.log('info', `сохранено: ${this.entry.base}`);
      this.emit('doc');
      return true;
    } catch (e) {
      this.log('error', msg(e));
      return false;
    }
  }

  private async onFileChange(c: FileChange): Promise<void> {
    if (c.file.endsWith('.svg') || c.file.endsWith('.xml') || c.file.endsWith('.json') || c.file.endsWith('.md')) {
      // new / removed scenes
      await this.loadFolder().catch(() => {});
    }
    const e = this.entry;
    if (!e) return;
    const clipFilesNow = clipFiles(this.listing.files, e.id);
    const mine = [e.base, e.heir, e.contract, e.state, ...clipFilesNow].includes(c.file);
    if (!mine) this.prefabTexts.delete(c.file); // any scene file may be a prefab (palette previews)
    const stem = c.file.replace(/(\.tml)?\.svg$|\.contract\.xml$/, '');
    if (!mine && this.prefabDeps.has(stem)) {
      // A prefab of this scene changed: its instances are redrawn (v0.9).
      for (const f of [`${stem}.svg`, `${stem}.tml.svg`, `${stem}.contract.xml`]) this.prefabTexts.delete(f);
      await this.loadPrefabs();
      this.doc?.refresh();
      this.log('info', `${c.file} изменён — инстансы перерисованы`);
      this.emit('doc');
      await this.render();
      return;
    }
    if (!mine) return;
    if (c.file === e.base) {
      if (c.hash && c.hash === this.lastHash) return;
      if (!c.hash) {
        const text = await this.io.read(c.file).catch(() => null);
        if (text != null && (await sha1Safe(text)) === this.lastHash) return;
      }
    }
    if (this.doc?.dirty) {
      const k = await this.ui.confirm(`${c.file} изменён на диске, а у вас несохранённые правки.`, ['Перезагрузить с диска', 'Оставить мои']);
      if (k !== 0) {
        this.log('warn', `${c.file} изменён на диске — оставлены правки редактора (сохранение перезапишет файл)`);
        return;
      }
    }
    this.log('info', `${c.file} изменён на диске — сцена перечитана`);
    await this.loadDocument();
  }

  // ---- render ---------------------------------------------------------------------------------

  /** Reopen the scene from the document; resolves when the newest state is drawn. */
  render(): Promise<void> {
    this.renderWanted = true;
    this.renderLoop ??= (async () => {
      while (this.renderWanted) {
        this.renderWanted = false;
        try {
          await this.renderNow();
        } catch (e) {
          this.log('error', `рендер: ${msg(e)}`);
        }
      }
      this.renderLoop = null;
    })();
    return this.renderLoop;
  }

  /** Settles when no render is queued or running. */
  async idle(): Promise<void> {
    while (this.renderLoop) await this.renderLoop;
  }

  private async renderNow(): Promise<void> {
    const doc = this.doc;
    const entry = this.entry;
    if (!doc || !entry) {
      this.session = null;
      this.handles.clear();
      this.bounds.clear();
      this.emit('render', 'issues');
      return;
    }
    const text = doc.serialize();
    const annotated = annotate(text);
    const byPath = new Map<string, NodeHandle>();
    let standIns = null as StandInRegistry | null;
    let backend = null as RendererBackend | null;
    const opened = await this.runtime.openInto(this.world, {
      id: entry.id,
      sources: { base: annotated, heir: this.heir },
      docUrl: this.io.url(entry.base ?? entry.id),
      state: this.stateText,
      viewport: this.viewport,
      wrapBackend: (b) => (backend = recordingBackend(b, byPath)),
      wrapRegistry: (r) => (standIns = new StandInRegistry(r)),
      hooks: { onIssue: () => this.emit('issues') },
      loadScene: this.renderLoader(),
    });
    this.session = opened.session;
    this.fit = opened.fit;
    this.backend = backend;
    const extra = [...opened.extra];
    const missing = [...(standIns?.missing ?? [])];
    if (missing.length) {
      extra.push({ level: 'warn', kind: 'component', message: `компоненты без реализации — нарисована их база: ${missing.join(', ')} (их даёт trempel.view.ts папки)` });
    }
    this.renderIssues = extra;

    // display tree (merged, paths on base nodes) for the layers panel
    let display: SceneNode;
    if (this.session.tree) display = this.session.tree; // v0.9: what the runtime composed (instances expanded)
    else {
      try {
        display = parse(annotated);
        if (this.heir) {
          const m = mergeScene(display, parseHeir(this.heir));
          if (!m.errors.length) display = m.tree;
        }
      } catch {
        display = doc.scene;
      }
    }
    this.display = display;
    this.rows = rowsOf(display);
    // instances start collapsed (their rows are the prefab's); a detached one opens up
    const now = new Set<string>();
    const seen = (rows: Row[]): void => {
      for (const r of rows) {
        if (r.href != null && r.path != null) {
          now.add(r.path);
          if (!this.seenInstances.has(r.path)) {
            this.seenInstances.add(r.path);
            this.collapsed.add(r.path);
          }
        }
        seen(r.children);
      }
    };
    seen(this.rows);
    for (const p of this.seenInstances) {
      if (now.has(p)) continue;
      this.seenInstances.delete(p);
      this.collapsed.delete(p);
    }

    // handles: by id (component roots, clipped images' groups) else the recorded node
    this.handles.clear();
    const scene = this.session.scene;
    const visit = (n: SceneNode, path: string): void => {
      const h = (n.attrs.id && scene?.byId.get(n.attrs.id)) || byPath.get(path);
      if (h) this.handles.set(path, h);
      n.children.forEach((c, i) => visit(c, path === '' ? String(i) : `${path}/${i}`));
    };
    visit(doc.scene, '');
    for (const p of this.hidden) {
      const h = this.handles.get(p);
      if (h) this.backend?.setProp(h, 'visible', false);
    }
    this.measure();
    // selection may point past the end after structural edits
    this.selection = this.selection.filter((p) => nodeAt(doc.scene, p));
    if (this.scope && !nodeAt(doc.scene, this.scope)) this.scope = '';
    this.layout();
    this.emit('render', 'issues', 'selection');
  }

  /** Scene-space bounds of every base element (runtime for drawn, geometry for service). */
  measure(): void {
    const doc = this.doc;
    this.bounds.clear();
    if (!doc) return;
    const points = (d: string): Pt[] => {
      try {
        return toEditCmds(parsePathData(d)).flatMap((c) =>
          c[0] === 'C' ? [{ x: c[1], y: c[2] }, { x: c[3], y: c[4] }, { x: c[5], y: c[6] }] : c[0] === 'Z' ? [] : [{ x: c[1], y: c[2] }],
        );
      } catch {
        return [];
      }
    };
    const visit = (n: SceneNode, path: string, service: boolean): void => {
      const svc = service || SERVICE.has(n.tag);
      if (svc) {
        const b = geometryBox(n, points);
        if (b) {
          try {
            this.bounds.set(path, mapBox(nodeWorld(doc.scene, path), b));
          } catch {
            // broken transform: not measurable
          }
        }
      } else {
        const h = this.handles.get(path);
        if (h && this.backend && path !== '') {
          const b = this.backend.getBounds(h);
          if (b.w > 0 || b.h > 0) this.bounds.set(path, canvasToScene(this.fit, b));
        }
      }
      n.children.forEach((c, i) => visit(c, path === '' ? String(i) : `${path}/${i}`, svc));
    };
    visit(doc.scene, '', false);
  }

  /** Canvas size, CSS zoom, background. */
  layout(): void {
    const f = this.fit;
    this.app.renderer.resize(f.width, f.height);
    for (const c of this.holder.removeChildren()) if (c !== this.world && c !== this.under && c !== this.over) c.destroy();
    const bg = this.runtime.config.background;
    if (bg) this.holder.addChild(new Graphics().rect(0, 0, f.width, f.height).fill(bg));
    for (const layer of [this.under, this.over]) {
      layer.scale.copyFrom(this.world.scale);
      layer.position.copyFrom(this.world.position);
    }
    this.holder.addChild(this.under, this.world, this.over);
    const z = this.zoomValue();
    this.app.canvas.style.width = `${Math.round(f.width * z)}px`;
    this.app.canvas.style.height = `${Math.round(f.height * z)}px`;
    this.emit('layout');
  }

  /** The stage area (set by the page): what the view is fitted into and the screen space of view(). */
  area = { w: 800, h: 600 };

  zoomValue(): number {
    if (this.zoom != null) return this.zoom;
    const f = this.fit;
    return Math.max(ZOOM_MIN, Math.min((this.area.w - 48) / f.width, (this.area.h - 48) / f.height, 2));
  }

  /** Where the canvas's top-left corner is in the stage area: centred, then panned by `offset`. */
  origin(): Pt {
    return centredOrigin(this.area, this.fit, this.zoomValue(), this.offset);
  }

  /**
   * Zoom (null — fit and recentre). With `at` (a point of the stage area) the scene point under it
   * stays put, otherwise the area's centre does.
   */
  setZoom(z: number | null, at?: Pt): void {
    if (z == null) {
      this.zoom = null;
      this.offset = { x: 0, y: 0 };
      this.layout();
      return;
    }
    const z0 = this.zoomValue();
    const z1 = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
    const o = zoomAbout(this.origin(), z0, z1, at ?? { x: this.area.w / 2, y: this.area.h / 2 });
    const c = centredOrigin(this.area, this.fit, z1);
    this.zoom = z1;
    this.offset = { x: o.x - c.x, y: o.y - c.y };
    this.layout();
  }

  /** Move the view by (dx, dy) screen px. */
  panBy(dx: number, dy: number): void {
    if (!dx && !dy) return;
    this.offset = { x: this.offset.x + dx, y: this.offset.y + dy };
    this.emit('layout');
  }

  /** scene → screen (CSS px in the stage area): translate(origin) · scale(zoom) · fit. */
  view(): Matrix {
    return stageView(this.fit, this.zoomValue(), this.origin());
  }

  // ---- selection --------------------------------------------------------------------------------

  /** Base element at a path. */
  node(path: string): SceneNode | null {
    return this.doc ? nodeAt(this.doc.scene, path) : null;
  }

  /** How commands address a node: its id when unique, else the index path. */
  ref(path: string): string {
    const n = this.node(path);
    const id = n?.attrs.id;
    if (id && this.doc && countId(this.doc.scene, id) === 1) return id;
    return path;
  }

  pathOfId(id: string): string | null {
    if (!this.doc) return null;
    let found: string | null = null;
    const visit = (n: SceneNode, path: string): void => {
      if (found == null && n.attrs.id === id) found = path;
      n.children.forEach((c, i) => visit(c, path === '' ? String(i) : `${path}/${i}`));
    };
    visit(this.doc.scene, '');
    return found;
  }

  isService(path: string): boolean {
    const doc = this.doc;
    if (!doc) return false;
    let n: SceneNode | null = doc.scene;
    if (path === '') return false;
    for (const part of path.split('/')) {
      n = n?.children[Number(part)] ?? null;
      if (!n) return false;
      if (SERVICE.has(n.tag)) return true;
    }
    return false;
  }

  select(paths: string[], opts: { add?: boolean; scope?: string } = {}): void {
    let next = opts.add ? [...this.selection] : [];
    for (const p of paths) {
      if (p === '' || !this.node(p)) continue;
      if (opts.add && next.includes(p)) next = next.filter((x) => x !== p);
      else if (!next.includes(p)) next.push(p);
    }
    this.selection = next;
    if (opts.scope != null) this.scope = opts.scope;
    else if (next.length) {
      const sc = parentPath(next[next.length - 1]);
      if (!isWithin(next[next.length - 1], this.scope) || next[next.length - 1] === this.scope) this.scope = sc;
    }
    if (this.tool === 'path' && (next.length !== 1 || !isPathLike(this.node(next[0])))) this.setTool('select');
    this.emit('selection');
  }

  /** Double click: into the selected group (its child under the point is selected next); an instance opens its prefab. */
  enterScope(path: string): void {
    const n = this.node(path);
    if (n?.tag === 'use') {
      void this.openPrefab(path);
      return;
    }
    if (!n || (n.tag !== 'g' && n.tag !== 'svg')) return;
    this.scope = path;
    this.emit('selection');
  }

  /** Esc: select the scope, the scope goes up. */
  exitScope(): void {
    if (this.scope === '') {
      this.select([]);
      return;
    }
    const s = this.scope;
    this.scope = parentPath(s);
    this.select([s], { scope: this.scope });
  }

  /** The hit-test tree: base elements with their scene bounds. */
  hitTree(): HitNode | null {
    const doc = this.doc;
    if (!doc) return null;
    const build = (n: SceneNode, path: string): HitNode => ({
      path,
      tag: n.tag,
      bounds: this.bounds.get(path) ?? null,
      children: n.children.map((c, i) => build(c, path === '' ? String(i) : `${path}/${i}`)),
    });
    return build(doc.scene, '');
  }

  /** Skipped by the stage hit-test: hidden or locked here or above. */
  skipped = (path: string): boolean => {
    for (let p = path; ; p = parentPath(p)) {
      if (this.hidden.has(p) || this.locked.has(p)) return true;
      if (p === '') return false;
    }
  };

  /** Make the stage read-only (a reason for the header) or editable again (null). */
  setReadOnly(reason: string | null): void {
    if (reason === this.readOnly) return;
    this.readOnly = reason;
    if (reason) {
      this.setTool('select');
      this.emit('readonly', 'selection');
    } else this.emit('readonly', 'selection');
  }

  setTool(t: Tool): void {
    if (t === 'path' && (this.selection.length !== 1 || !isPathLike(this.node(this.selection[0])))) {
      if (this.tool !== 'select') {
        this.tool = 'select';
        this.emit('tool');
      }
      if (t === 'path') this.log('warn', 'контур: выделите один <path> или <line>');
      return;
    }
    if (this.tool === t) return;
    this.tool = t;
    this.emit('tool');
  }

  toggleHidden(path: string): void {
    if (this.hidden.has(path)) this.hidden.delete(path);
    else this.hidden.add(path);
    const h = this.handles.get(path);
    if (h) {
      this.backend?.setProp(h, 'visible', !this.hidden.has(path) && this.node(path)?.attrs.display !== 'none');
      this.measure();
    }
    this.emit('render', 'selection');
  }

  toggleLocked(path: string): void {
    if (this.locked.has(path)) this.locked.delete(path);
    else this.locked.add(path);
    this.emit('render');
  }

  // ---- commands --------------------------------------------------------------------------------

  /** One command; failures and warnings go to the log. */
  exec(name: string, args: Record<string, unknown>): CommandResult | null {
    if (!this.doc) return null;
    const r = this.doc.exec(name, args);
    this.report(name, r);
    return r;
  }

  /** Several commands as one undo entry. */
  batch(label: string, calls: Call[]): CommandResult | null {
    if (!this.doc || !calls.length) return null;
    if (calls.length === 1) return this.exec(calls[0].name, calls[0].args);
    const r = this.doc.batch(label, calls);
    this.report(label, r);
    return r;
  }

  private report(what: string, r: CommandResult): void {
    if (!r.ok) {
      this.log('error', `${what}: ${(r.errors ?? []).join('; ')}`);
      return;
    }
    for (const w of r.warnings ?? []) {
      // the d-normalization note — once per node
      const key = /^(\S+): d переписан/.exec(w)?.[1];
      if (key) {
        if (this.warned.has(key)) continue;
        this.warned.add(key);
      }
      this.log('warn', w);
    }
  }

  undo(): void {
    if (this.doc?.undo()) this.log('info', 'отменено');
  }

  redo(): void {
    if (this.doc?.redo()) this.log('info', 'повторено');
  }

  /** Errors and warnings for the panel: the render's (runtime, assets, components) + the document's. */
  issues(): (ViewIssue & { id?: string })[] {
    const out: (ViewIssue & { id?: string })[] = [...(this.folderIssue ? [this.folderIssue] : []), ...this.renderIssues, ...(this.session?.issues ?? [])];
    const doc = this.doc;
    if (doc) {
      const geom = new Set([...geometryErrors(doc.scene), ...propErrors(doc.scene)]);
      const clipNames = Object.keys(clipsOf(this.listing.files, this.entry?.id));
      for (const m of doc.errors) {
        if (m.startsWith('наследник: ')) continue; // the render reports merge itself
        const kind = geom.has(m) ? 'geometry' : clipNames.some((f) => m.startsWith(`${f}: `)) ? 'clips' : 'contract';
        if (out.some((i) => i.message === m)) continue;
        out.push({ level: 'error', kind: kind as ViewIssue['kind'], message: m });
      }
    }
    for (const i of out) i.id = idIn(i.message, doc?.scene);
    return out;
  }
}

function clipsOf(files: string[], id: string | undefined): Record<string, true> {
  return Object.fromEntries((id ? clipFiles(files, id) : []).map((f) => [f, true]));
}

/** The first `#id` / `id "x"` in a message that names a node of the scene. */
function idIn(message: string, scene: SceneNode | undefined): string | undefined {
  if (!scene) return undefined;
  for (const m of message.matchAll(/#([A-Za-z_][\w.-]*)|id "([^"]+)"/g)) {
    const id = m[1] ?? m[2];
    if (countId(scene, id) > 0) return id;
  }
  return undefined;
}

function countId(n: SceneNode, id: string): number {
  return (n.attrs.id === id ? 1 : 0) + n.children.reduce((s, c) => s + countId(c, id), 0);
}

export function isPathLike(n: SceneNode | null): boolean {
  return !!n && (n.tag === 'path' || n.tag === 'line');
}

function rowsOf(n: SceneNode): Row[] {
  const build = (x: SceneNode): Row => {
    const path = x.attrs[PATH_ATTR];
    const row: Row = { path: path ?? null, tag: x.instance ? 'use' : x.tag, children: x.children.map(build) };
    if (x.attrs.id) row.id = x.attrs.id;
    if (x.instance) row.href = x.instance.href;
    if (x.tml?.type) row.type = x.tml.type;
    if (x.attrs['data-z'] != null) row.z = x.attrs['data-z'];
    const blend = /mix-blend-mode\s*:\s*([\w-]+)/.exec(x.attrs.style ?? '')?.[1];
    if (blend) row.blend = blend;
    if (x.attrs['data-views'] != null) row.views = x.attrs['data-views'];
    return row;
  };
  return [build(n)];
}

async function sha1Safe(text: string): Promise<string | null> {
  try {
    return await sha1(text);
  } catch {
    return null;
  }
}

/** Anchor points of a path node (local), for tests and the path tool. */
export function pathAnchors(n: SceneNode): Pt[] {
  return anchorPoints(toEditCmds(parsePathData(n.attrs.d ?? '')));
}
