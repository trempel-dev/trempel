// tml.ts — `window.tml`: the editor as one object for scripts, macros and an agent. Instead of a
// tool per command — one `eval`: `tml.run(code)` runs a script as ONE undo step (core
// begin/end; an exception rolls the whole script back). The console panel, the ⌘K macro palette
// and (later) the artifact's single agent tool all go through run().
//
// The `Tml` interface below is what `npm run editor:commands` copies into edit/API.md for the
// agent's context — keep its comments short and user-facing.

import { clipCommands, commands, type ClipsDocument, type CommandResult, type EditorDocument, type TreeNode } from '../../editor/index.js';
import { coded, type AnimClip, type MountedScene } from '../../src/core.js';
import { legacyName, PROJECT_DIR, PROJECT_DIRS } from '../../src/compat.js';
import { invert, nodeWorld, parentPath, type Call } from '../geometry';
import { applyOp } from '../ops';
import type { SceneIO } from '../io';
import type { Clips } from './clips';
import type { Editor } from './editor';
import type { Reference } from './reference';

// BEGIN tml-api
/** Bounds in scene units (the root <svg>'s viewBox space). */
export interface TmlBounds { x: number; y: number; width: number; height: number }

/** A macro: `<scenes>/.trempel/macros/<file>.js`, first line `// name: <title>`. */
export interface TmlMacro { name: string; title: string; file: string }

/** RGBA pixels row by row (like ImageData). */
export interface TmlPixels { width: number; height: number; data: Uint8ClampedArray }
/** A compiled clip of the scene (anim/*.md, *.anim.md — the md clip itself; `$tex` maps tex cells). */
export interface TmlClip { name: string; file: string; duration: number; clip: AnimClip }
/** Clips on the stage, own clock (exact pause/seek). Posed — the stage is read-only; stop() — the
 *  rest pose. speed 0.25–2; onion(on, delta = 1/12 s): frames t∓delta over the scene when paused.
 *  rec (2.3): posed + rec — edits of nodes become keys at the playhead; params — $name values for the preview. */
export interface TmlAnim {
  readonly clip: string | null; readonly time: number; readonly playing: boolean; loop: boolean; speed: number; rec: boolean;
  params: Record<string, number>;
  play(name?: string): void; pause(): void; seek(t: number): void; stop(): Promise<void>; onion(on: boolean, delta?: number): void;
}
/** Reference picture under/over the scene, fitted to the viewBox, opacity 0–100; not saved to the
 *  file. pixels(box) — the picture at the viewBox's 1:1 size, cropped to a box in scene units. */
export interface TmlReference {
  readonly file: string | null; readonly opacity: number; readonly over: boolean;
  set(file: string | null, opts?: { opacity?: number; over?: boolean }): Promise<void>;
  pixels(box?: TmlBounds): Promise<TmlPixels | null>;
}

export interface Tml {
  /** Core document of the open scene: exec(name, args), batch(label, calls), undo(), redo(),
   *  tree() ([{ id?, tag, path, children }]), scene (SceneNode: tag, attrs, children, text),
   *  errors, serialize(), dirty, history. null — no scene open. */
  readonly doc: EditorDocument | null;
  /** Command registry: { [name]: { schema, describe } } — see the table below. */
  readonly commands: typeof commands;
  /** Runtime of the last render: byId, getBounds, path(id) — read-only, redrawn after commands. */
  readonly scene: MountedScene | null;
  /** Open scene id ("game", "popups/map"). */
  readonly sceneId: string | null;
  /** Every element of the base, flat, depth-first (doc.tree() is nested: [root]). */
  nodes(): TreeNode[];
  /** Selected nodes: id when unique, else index path ("0/3/1"). */
  readonly selection: string[];
  /** Select nodes by id or index path ([] — clear); returns the new selection. */
  select(nodes: string | string[]): string[];
  /** Node's bounds in scene units from the last render (await tml.idle() after commands). */
  bounds(node: string): TmlBounds | null;
  /** node.move by (dx, dy) in SCENE units (converted to the node's parent space). */
  moveBy(node: string, dx: number, dy: number): CommandResult | null;
  /** G/R/S as the keys, one undo step: op('G', { axis: 'x', value: 120 }) — along the node's local X (several: global;
   *  space, exclude), op('R', { value: -45 }), op('S', { axis: 'y', value: 1.5 }) about the pivot (data-pivot / bounds
   *  centre); op('.', { x, y }) / op('ctrl+.') — set the pivot. nodes — default the selection; null — no change. */
  op(name: 'G' | 'R' | 'S' | '.' | 'ctrl+.', opts?: { axis?: 'x' | 'y' | null; value?: number; space?: 'local' | 'global'; exclude?: boolean; x?: number; y?: number; nodes?: string[] }): CommandResult | null;
  /** Resolves when the newest state is drawn and measured. */
  idle(): Promise<void>;
  /** Save the base (X.svg) to disk. */
  save(): Promise<boolean>;
  /** Open another scene of the folder (asks about unsaved changes). */
  open(sceneId: string): Promise<boolean>;
  /** Scene ids of the folder. */
  scenes(): string[];
  /** Run a script (body of an async function with `tml` and `console` in scope; a single
   *  expression is returned) as one undo step `label`; an exception rolls it all back. */
  run(code: string, label?: string): Promise<unknown>;
  /** 2.3: an md clip file as commands (clip.*, track.*, key.*, event.* — the table below), in this scene's
   *  undo: tml.clipsDoc().exec('key.move', { clip, keys, dt }); .clips() — clips as written (tracks,
   *  keys by column, events). file — default the timeline's clip's file (else the scene's first). */
  clipsDoc(file?: string): ClipsDocument | null;
  readonly clipCommands: typeof clipCommands;
  /** 2.3: inspectors of the folder's trempel.view.ts by tml:type, e.g. tml.inspect.fx — effects (kit). */
  readonly inspect: Record<string, any>;
  /** Clips of the scene and their compile errors; playback — anim; the reference layer. */
  readonly clips: TmlClip[];
  readonly clipErrors: string[];
  readonly anim: TmlAnim;
  readonly reference: TmlReference;
  /** The scene's viewBox (scene units). */
  viewBox(): TmlBounds;
  /** The scene as drawn now (no reference/onion/handles) at the viewBox's 1:1, cropped to a box
   *  in scene units; background — the stage's, else #18181c. */
  pixels(box?: TmlBounds): Promise<TmlPixels>;
  /** "Video snapshot": the rest pose (a clip is stopped) at 1:1 on `background` (null —
   *  transparent; omitted — the panel's) → renders/<scene>-<time>.png; returns its path. */
  snapshot(opts?: { background?: string | null }): Promise<string>;
  /** Prefabs (v0.9): list() — scenes to place ("ui/button.svg"; v1.1 — a collection's too, "@skin/button.svg"); place(prefab, at?) — a <use> at a scene
   *  point (default: view centre), selected; open(node) — its prefab; extract(node, href) — <g> → prefab. */
  readonly prefabs: { list(): string[]; place(prefab: string, at?: { x: number; y: number }): Promise<CommandResult | null>; open(node: string): Promise<boolean>; extract(node: string, href: string): Promise<CommandResult | null> };
  /** Macros of the folder: list, run by name (file name or title), re-read. */
  readonly macros: {
    list(): Promise<TmlMacro[]>;
    run(name: string): Promise<unknown>;
    reload(): Promise<TmlMacro[]>;
  };
}
// END tml-api

declare global {
  interface Window {
    /** The editor's scripting object (the console, macros, an agent's eval). */
    tml?: Tml;
  }
}

/** Where a script's console output goes (the console panel). */
export interface TmlSink {
  print(level: 'log' | 'warn' | 'error' | 'result', parts: unknown[]): void;
}

export const MACRO_DIR = `${PROJECT_DIR}/macros`;
const PATH_RE = /^\d+(\/\d+)*$/;

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...a: unknown[]) => Promise<unknown>;

/** Compile a script: a lone expression is returned (`1 + 1` → 2), anything else runs as a body. */
export function compileScript(code: string, params: string[]): (...a: unknown[]) => Promise<unknown> {
  try {
    return new AsyncFunction(...params, `return (${code}\n);`);
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw cspHint(e);
  }
  try {
    return new AsyncFunction(...params, code);
  } catch (e) {
    throw cspHint(e);
  }
}

function cspHint(e: unknown): unknown {
  if (e instanceof EvalError || (e instanceof Error && /unsafe-eval|Content Security Policy/i.test(e.message))) {
    return new Error(coded('E_EDIT_SCRIPT', `scripts are forbidden by the page CSP ('unsafe-eval' is needed): ${e.message}`));
  }
  return e;
}

/** Macro title from its first line `// name: …` (else the file name). */
export function macroTitle(file: string, text: string): string {
  const m = /^\s*\/\/\s*name:\s*(.+?)\s*$/m.exec(text.split('\n', 1)[0] ?? '');
  return m ? m[1] : file.replace(/^.*\//, '').replace(/\.js$/, '');
}

/** Batch 2 parts of the editor tml exposes (absent in a stand-in host — those members then throw). */
export interface TmlExtras {
  clips: Pick<Clips, 'list' | 'errors' | 'selected' | 'time' | 'playing' | 'loop' | 'speed' | 'play' | 'pause' | 'seek' | 'stop' | 'setLoop' | 'setSpeed' | 'setOnion' | 'onion' | 'rec' | 'setRec' | 'params' | 'setParam' | 'current'>;
  /** 2.3: the inspectors' agent APIs. */
  inspect?: Record<string, Record<string, unknown>>;
  reference: Pick<Reference, 'state' | 'set' | 'pixels'>;
  viewBox(): TmlBounds;
  pixels(box?: TmlBounds): Promise<TmlPixels>;
  /** `background` undefined — the panel's setting. */
  snapshot(background: string | null | undefined): Promise<string>;
}

/** What tml needs of the editor (the Editor; a stand-in in tests). */
export type TmlHost = Pick<Editor, 'doc' | 'session' | 'entry' | 'scenes' | 'selection' | 'bounds' | 'node' | 'ref' | 'pathOfId' | 'select' | 'idle' | 'save' | 'openScene'> &
  Partial<Pick<Editor, 'prefabCandidates' | 'instantiate' | 'openPrefab' | 'extract'>>;

export function createTml(ed: TmlHost, io: Pick<SceneIO, 'list' | 'read'>, sink: TmlSink, extras?: TmlExtras): Tml {
  const x = (): TmlExtras => {
    if (!extras) throw new Error(coded('E_EDIT_HOST', 'clips, the reference and snapshots are available only on the editor page'));
    return extras;
  };
  const anim: TmlAnim = {
    get clip() {
      return extras?.clips.selected ?? null;
    },
    get time() {
      return extras?.clips.time ?? 0;
    },
    get playing() {
      return extras?.clips.playing ?? false;
    },
    get loop() {
      return extras?.clips.loop ?? true;
    },
    set loop(v) {
      x().clips.setLoop(v);
    },
    get speed() {
      return extras?.clips.speed ?? 1;
    },
    set speed(v) {
      x().clips.setSpeed(v);
    },
    get rec() {
      return extras?.clips.rec ?? false;
    },
    set rec(v) {
      x().clips.setRec(v);
    },
    get params() {
      return { ...(extras?.clips.params ?? {}) };
    },
    set params(v) {
      for (const [k, n] of Object.entries(v)) x().clips.setParam(k, n);
    },
    play: (name) => x().clips.play(name),
    pause: () => x().clips.pause(),
    seek: (t) => x().clips.seek(t),
    stop: () => x().clips.stop(),
    onion: (on, delta) => x().clips.setOnion(on, delta),
  };
  const reference: TmlReference = {
    get file() {
      return extras?.reference.state.file ?? null;
    },
    get opacity() {
      return extras?.reference.state.opacity ?? 50;
    },
    get over() {
      return extras?.reference.state.over ?? false;
    },
    set: (file, opts = {}) => x().reference.set({ file, ...opts }),
    pixels: (box) => x().reference.pixels(box),
  };
  /** Group open for a running script; open() inside the script carries it to the next document. */
  let active: { label: string; doc: EditorDocument } | null = null;
  let macroCache: (TmlMacro & { code: string })[] | null = null;

  const pathOf = (node: string): string | null => {
    if (PATH_RE.test(node) || node === '') return ed.node(node) ? node : null;
    return ed.pathOfId(node.replace(/^#/, ''));
  };

  const scriptConsole = {
    log: (...a: unknown[]) => sink.print('log', a),
    info: (...a: unknown[]) => sink.print('log', a),
    warn: (...a: unknown[]) => sink.print('warn', a),
    error: (...a: unknown[]) => sink.print('error', a),
  };

  const loadMacros = async (): Promise<(TmlMacro & { code: string })[]> => {
    let files: string[] = [];
    try {
      for (const dir of PROJECT_DIRS.map((d) => `${d}/macros`)) {
        files = (await io.list(dir)).files.filter((f) => f.startsWith(`${dir}/`) && f.endsWith('.js')).sort();
        if (files.length) {
          legacyName(dir);
          break;
        }
      }
    } catch {
      files = [];
    }
    const out: (TmlMacro & { code: string })[] = [];
    for (const file of files) {
      try {
        const code = await io.read(file);
        out.push({ name: file.slice(file.indexOf('/macros/') + 8).replace(/\.js$/, ''), title: macroTitle(file, code), file, code });
      } catch (e) {
        sink.print('warn', [coded('W_EDIT_MACRO', `macro ${file} could not be read: ${e instanceof Error ? e.message : String(e)}`)]);
      }
    }
    macroCache = out;
    return out;
  };
  const strip = (m: TmlMacro & { code: string }): TmlMacro => ({ name: m.name, title: m.title, file: m.file });

  const tml: Tml = {
    get doc() {
      return ed.doc;
    },
    commands,
    get scene() {
      return ed.session?.scene ?? null;
    },
    get sceneId() {
      return ed.entry?.id ?? null;
    },
    nodes() {
      const out: TreeNode[] = [];
      const walk = (n: TreeNode): void => {
        out.push(n);
        n.children.forEach(walk);
      };
      ed.doc?.tree().forEach(walk);
      return out;
    },
    get selection() {
      return ed.selection.map((p) => ed.ref(p));
    },
    select(nodes) {
      const list = typeof nodes === 'string' ? [nodes] : nodes;
      const paths: string[] = [];
      for (const n of list) {
        const p = pathOf(n);
        if (p == null || p === '') throw new Error(coded('E_EDIT_NODE', `tml.select: no node "${n}"`));
        paths.push(p);
      }
      ed.select(paths);
      return tml.selection;
    },
    bounds(node) {
      const p = pathOf(node);
      const b = p == null ? undefined : ed.bounds.get(p);
      return b ? { x: b.x, y: b.y, width: b.w, height: b.h } : null;
    },
    moveBy(node, dx, dy) {
      const doc = ed.doc;
      const p = pathOf(node);
      if (!doc || p == null || p === '') throw new Error(coded('E_EDIT_NODE', `tml.moveBy: no node "${node}"`));
      const v = invert(nodeWorld(doc.scene, parentPath(p)));
      const r = (x: number): number => Math.round(x * 10000) / 10000;
      const call: Call = { name: 'node.move', args: { node: ed.ref(p), dx: r(v[0] * dx + v[2] * dy), dy: r(v[1] * dx + v[3] * dy) } };
      return doc.exec(call.name, call.args);
    },
    op(name, opts = {}) {
      const doc = ed.doc;
      return applyOp(
        {
          doc,
          bounds: ed.bounds,
          selection: ed.selection,
          ref: (p) => ed.ref(p),
          pathOfId: (id) => ed.pathOfId(id),
          batch: (label, calls) => (doc ? doc.batch(label, calls) : null),
          instance: (r) => doc?.instance(r) ?? null,
        },
        name,
        opts,
      ) as CommandResult | null;
    },
    idle: () => ed.idle(),
    save: () => ed.save(),
    async open(sceneId) {
      const entry = ed.scenes.find((s) => s.id === sceneId);
      if (!entry) throw new Error(coded('E_EDIT_SCENE', `tml.open: no scene "${sceneId}" (scenes: ${ed.scenes.map((s) => s.id).join(', ')})`));
      if (active && active.doc === ed.doc && entry.id !== ed.entry?.id) active.doc.end(); // what the script did there — one step
      const ok = await ed.openScene(entry);
      if (active && ed.doc && ed.doc !== active.doc) {
        ed.doc.begin(active.label);
        active.doc = ed.doc;
      } else if (active && !ok) active.doc.begin(active.label); // stayed: keep grouping here
      return ok;
    },
    scenes: () => ed.scenes.map((s) => s.id),
    clipsDoc(file) {
      const doc = ed.doc;
      if (!doc) return null;
      const f = file ?? extras?.clips.current?.file ?? doc.clipFiles()[0];
      return f ? doc.clipsDoc(f) : null;
    },
    clipCommands,
    get inspect() {
      return extras?.inspect ?? {};
    },
    get clips() {
      return (extras?.clips.list ?? []).map((c) => ({ name: c.name, file: c.file, duration: c.duration, clip: c.clip }));
    },
    get clipErrors() {
      return [...(extras?.clips.errors ?? [])];
    },
    anim,
    reference,
    viewBox: () => x().viewBox(),
    pixels: (box) => x().pixels(box),
    snapshot: (opts = {}) => x().snapshot(opts.background),
    async run(code, label = 'script') {
      if (active) {
        // a nested run (a macro calling tml.run): joins the running step
        return compileScript(code, ['tml', 'console'])(tml, scriptConsole);
      }
      const fn = compileScript(code, ['tml', 'console']);
      const doc = ed.doc;
      if (!doc) return fn(tml, scriptConsole);
      active = { label, doc };
      doc.begin(label);
      try {
        const value = await fn(tml, scriptConsole);
        if (active.doc.grouping) active.doc.end();
        await ed.idle();
        return value;
      } catch (e) {
        if (active.doc.grouping) active.doc.abort();
        await ed.idle();
        throw e;
      } finally {
        active = null;
      }
    },
    prefabs: {
      list: () => ed.prefabCandidates?.() ?? [],
      place: async (prefab, at) => {
        if (!ed.instantiate) throw new Error(coded('E_EDIT_HOST', 'prefabs are available only on the editor page'));
        return ed.instantiate(prefab, at);
      },
      open: async (node) => {
        const path = PATH_RE.test(node) ? node : ed.pathOfId(node);
        return path != null && ed.openPrefab ? ed.openPrefab(path) : false;
      },
      extract: async (node, href) => {
        const path = PATH_RE.test(node) ? node : ed.pathOfId(node);
        if (path == null || !ed.extract) return null;
        return ed.extract(path, href);
      },
    },
    macros: {
      async list() {
        return (macroCache ?? (await loadMacros())).map(strip);
      },
      async reload() {
        return (await loadMacros()).map(strip);
      },
      async run(name) {
        const all = macroCache ?? (await loadMacros());
        const m = all.find((x) => x.name === name || x.title === name || x.file === name);
        if (!m) throw new Error(coded('E_EDIT_MACRO', `no macro "${name}" (macros: ${all.map((x) => x.name).join(', ') || '—'}; folder ${MACRO_DIR}/)`));
        return tml.run(m.code, m.title);
      },
    },
  };
  return tml;
}

/** A value as the console shows it. */
export function formatValue(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === undefined) return 'undefined';
  if (typeof v === 'function') return `ƒ ${v.name || '(anonymous)'}`;
  if (v instanceof Error) return v.stack?.split('\n').slice(0, 3).join('\n') ?? v.message;
  try {
    const json = (indent?: number): string | undefined => {
      const seen = new WeakSet();
      return JSON.stringify(
        v,
        (_k, x: unknown) => {
          if (x && typeof x === 'object') {
            if (seen.has(x)) return '[cycle]';
            seen.add(x);
            if (x instanceof Map) return Object.fromEntries([...x].slice(0, 50).map(([k, y]) => [String(k), typeof y === 'object' ? '{…}' : y]));
          }
          return x;
        },
        indent,
      );
    };
    const flat = json();
    if (flat === undefined) return String(v);
    if (flat.length <= 100) return flat;
    const s = json(2)!;
    return s.length > 4000 ? `${s.slice(0, 4000)}…` : s;
  } catch {
    return String(v);
  }
}
