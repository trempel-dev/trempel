// document.ts — EditorDocument: the base scene as a source-preserving XML DOM, commands with
// undo/redo/batch, validation after every change, export.
//
// The DOM is the truth; SceneNode (doc.scene) is derived from it after each change by
// parse(serialize()) — scenes are small, this is cheap and guarantees the runtime sees exactly
// what will be saved. Validation never blocks: a command that breaks the contract is applied and
// the problem lands in doc.errors (an artist may break things on the way).

import { sharedClipHint } from '@trempel/scene/internal/anim/clip-files';
import { coded, compileClipsResult, composeScene, parse, parseContract, parseHeir, within, type SceneLoader, type SceneNode, type SceneSource } from '@trempel/scene/core';
import { baseDuplicateIdErrors, baseTmlErrors } from '@trempel/scene/internal/tree';
import { geometryErrors } from '@trempel/scene/internal/geom/check';
import { propErrors } from '@trempel/scene/internal/props';
import { rebase } from '@trempel/scene/internal/prefab';
import type { Element } from '@xmldom/xmldom';
import { attachClips, renameInClips, type ClipsDocument } from './clips.js';
import { registry, type CommandName } from './commands.js';
import { CommandError, Ctx, indexPath, type Op } from './ctx.js';
import { HEIR_COMMANDS } from './heir.js';
import { checkSchema } from './schema.js';
import { elementChildren, parseSource, serializeSource, type SourceDoc } from './xml.js';

export interface OpenOptions {
  /** scene.contract.xml text — checked after every command. */
  contract?: string;
  /** scene.tml.svg text — shown merged (doc.merged); commands always target the base. */
  heir?: string;
  /** Where the base lives (informational, e.g. "scenes/game.svg"). */
  path?: string;
  /**
   * md clip files by name: compiled against the scene, errors prefixed with the file name. 2.3: each
   * is a ClipsDocument (doc.clipsDoc(file)) sharing the scene's history.
   */
  clips?: Record<string, string>;
  /**
   * 2.3: the scene is an heir extending another scene (no base of its own): `svg` is that scene's
   * base, shown read-only — base commands fail with E_EDITOR_READONLY; the heir's effect commands
   * (heir.*) and the clips are edited.
   */
  heirOnly?: boolean;
  /**
   * v0.9: prefab documents by path relative to the scene's folder (`ui/button.svg` → { base, heir?,
   * contract? }, null — none). Synchronous: the host preloads (or reads from its cache).
   */
  loadScene?: SceneLoader;
}

export interface CommandResult {
  ok: boolean;
  /** Argument / command errors (ok: false; the document is untouched). */
  errors?: string[];
  /** Ids (or index paths) of the nodes the command changed. */
  changed: string[];
  /** Applied, but worth knowing: d rewritten, a clip refers to a renamed/removed id… */
  warnings?: string[];
  /** v0.9: files the command created (prefab.extract), paths relative to the scene's folder — the host writes them. */
  files?: { path: string; text: string }[];
}

export interface CommandCall {
  name: CommandName | string;
  args?: unknown;
}

export interface HistoryEntry {
  label: string;
  /** ms timestamp of when it was applied. */
  at: number;
}

export interface TreeNode {
  id?: string;
  tag: string;
  /** Index path from the root ("" — the root itself). */
  path: string;
  children: TreeNode[];
  /** Filled by the UI from the runtime (the core does not measure). */
  bounds?: { x: number; y: number; width: number; height: number };
  /** v0.9: a prefab instance (`<use>`): the prefab's base path. */
  href?: string;
}

/** v0.9: a prefab instance as the inspector sees it. */
export interface InstanceInfo {
  id: string;
  href: string;
  /** Every parameter: the prefab's (root data-* defaults, contract params) and the instance's own. */
  params: { name: string; value: string; own: boolean; required: boolean; default?: string }[];
  /** Required parameters without a value on the instance. */
  missing: string[];
  /** Expanded? (false — the prefab is missing / broken; see errors). */
  expanded: boolean;
  /** v1.0: the instance's size (width/height of a resizable prefab, else its viewBox); absent — unknown. */
  size?: { w: number; h: number };
  /** v1.0: the prefab's minimum (its viewBox). */
  min?: { w: number; h: number };
  /** v1.0: the axes the prefab resizes along (data-resizable); absent — not resizable. */
  resizable?: 'x' | 'y' | 'xy';
}

export interface ChangeEvent {
  /** rollback — an open group (begin…abort) was undone. */
  type: 'exec' | 'batch' | 'undo' | 'redo' | 'rollback';
  label: string;
}

interface Entry extends HistoryEntry {
  ops: Op[];
}

const dedupe = (xs: string[]): string[] => [...new Set(xs)];

export class EditorDocument {
  readonly path?: string;
  private readonly src: SourceDoc;
  private readonly contractSrc?: string;
  /** 2.3: the heir as a source-preserving DOM (heir.* commands write it). */
  private readonly heirDoc: SourceDoc | null;
  private heirSaved: string | undefined;
  readonly heirOnly: boolean;
  private readonly loadScene?: SceneLoader;
  /** Prefab files created by commands (extract) — seen before the host's loader. */
  private readonly created = new Map<string, SceneSource>();
  private readonly clipDocs = new Map<string, ClipsDocument>();
  private readonly sep: string;
  private readonly undoStack: Entry[] = [];
  private readonly redoStack: Entry[] = [];
  private savedTop: Entry | null = null;
  /** Open group (begin…end): commands collect here instead of the undo stack. */
  private group: { label: string; ops: Op[]; depth: number } | null = null;
  private readonly listeners = new Set<(e: ChangeEvent) => void>();
  private _scene!: SceneNode;
  private _merged!: SceneNode;
  private _errors: string[] = [];

  constructor(svg: string, opts: OpenOptions = {}) {
    this._scene = parse(svg); // the format's own check first: malformed XML, unknown tags
    this.src = parseSource(svg);
    this.path = opts.path;
    if (opts.contract != null) parseContract(opts.contract); // a bad contract / heir fails the open, as before
    if (opts.heir != null) parseHeir(opts.heir);
    this.contractSrc = opts.contract;
    this.heirDoc = opts.heir != null ? parseSource(opts.heir) : null;
    this.heirSaved = opts.heir;
    this.heirOnly = !!opts.heirOnly;
    this.loadScene = opts.loadScene;
    const host = { scene: () => this._merged, record: (label: string, ops: Op[], type: ChangeEvent['type']) => this.record(label, ops, type) };
    for (const [file, md] of Object.entries(opts.clips ?? {})) this.clipDocs.set(file, attachClips(md, file, host));
    const comma = /translate\(\s*[-+\d.eE]+\s*,/.test(svg);
    const space = /translate\(\s*[-+\d.eE]+\s+[-+\d.]/.test(svg);
    this.sep = space && !comma ? ' ' : ',';
    this.validate();
  }

  /** SceneNode of the base (recomputed after every change). */
  get scene(): SceneNode {
    return this._scene;
  }

  /** Base merged with the heir, when one was given; otherwise the base. */
  get merged(): SceneNode {
    return this._merged;
  }

  /** Problems of the current state: contract, tml in the base, ids, geometry, heir merge, clips. */
  get errors(): string[] {
    return this._errors;
  }

  /** Changed since opened (or since markClean()). */
  get dirty(): boolean {
    if (this.group?.ops.length) return true;
    return (this.undoStack[this.undoStack.length - 1] ?? null) !== this.savedTop;
  }

  /** The current state is what is on disk now (after the host saved serialize(), 2.3: the heir and the clips too). */
  markClean(): void {
    this.savedTop = this.undoStack[this.undoStack.length - 1] ?? null;
    this.heirSaved = this.serializeHeir();
    for (const d of this.clipDocs.values()) d.markClean();
  }

  /** Undo entries, oldest first. */
  get history(): HistoryEntry[] {
    return this.undoStack.map(({ label, at }) => ({ label, at }));
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  on(event: 'change', fn: (e: ChangeEvent) => void): () => void {
    if (event !== 'change') throw new Error(coded('E_EDITOR_API', `EditorDocument.on: no event "${event}" (events: change)`));
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Validate again with fresh prefab documents (a prefab changed on disk; the host's loader now
   * returns the new text). Emits nothing; doc.errors / doc.merged are updated.
   */
  refresh(): void {
    this.validate();
  }

  /** v0.9: a prefab instance (`<use>`) by id or index path — parameters with the prefab's defaults and contract. */
  instance(ref: string): InstanceInfo | null {
    let el: Element;
    try {
      el = this.ctx().node(ref);
    } catch {
      return null;
    }
    if (el.nodeName !== 'use') return null;
    const id = el.getAttribute('id') ?? '';
    const href = el.getAttribute('href') ?? '';
    let found: SceneNode | null = null;
    const walk = (n: SceneNode): void => {
      if (found) return;
      if (n.attrs.id === id && n.instance) found = n;
      else n.children.forEach(walk);
    };
    if (id) walk(this._merged);
    const inst = (found as SceneNode | null)?.instance;
    const own: Record<string, string> = {};
    for (let i = 0; i < el.attributes.length; i++) {
      const a = el.attributes[i];
      if (a.name.startsWith('data-') && !['data-z', 'data-pivot', 'data-tint', 'data-anchor', 'data-stretch'].includes(a.name)) own[a.name] = a.value;
    }
    const required = inst?.required ?? [];
    const defaults: Record<string, string> = inst?.defaults ?? {};
    const names = [...new Set([...required, ...Object.keys(defaults), ...Object.keys(own)])];
    const params = names.map((name) => {
      const p: InstanceInfo['params'][number] = { name, value: own[name] ?? defaults[name] ?? '', own: name in own, required: required.includes(name) };
      if (name in defaults) p.default = defaults[name];
      return p;
    });
    const info: InstanceInfo = { id, href, params, missing: required.filter((r) => !(r in own)), expanded: !!inst };
    if (inst?.size) info.size = { ...inst.size };
    if (inst?.min) info.min = { ...inst.min };
    if (inst?.resizable) info.resizable = inst.resizable;
    return info;
  }

  /** Run one command: one undo entry (when it changed anything). */
  exec(name: CommandName | string, args: unknown = {}): CommandResult {
    const ctx = this.ctx();
    const err = this.run(ctx, name, args);
    if (err) return { ok: false, errors: err, changed: [] };
    return this.commit(ctx, name, 'exec');
  }

  /** Run several commands as one undo entry; any failure rolls all of them back. */
  batch(label: string, calls: CommandCall[]): CommandResult {
    const ctx = this.ctx();
    for (let i = 0; i < calls.length; i++) {
      let err: string[] | null;
      try {
        err = this.run(ctx, calls[i].name, calls[i].args ?? {});
      } catch (e) {
        ctx.rollback(); // a bug in a command: leave no half-applied batch behind
        throw e;
      }
      if (err) {
        ctx.rollback();
        return { ok: false, errors: err.map((e) => within(`[${i}] ${calls[i].name}`, e)), changed: [] };
      }
    }
    return this.commit(ctx, label, 'batch');
  }

  /**
   * Open a group: every command until the matching end() — one undo entry (`label`), however many
   * calls and awaits in between (a script). Nested begin/end pairs join the outer group. Each
   * command still applies and emits `change` at once; undo/redo are off while a group is open.
   */
  begin(label: string): void {
    if (this.group) this.group.depth++;
    else this.group = { label, ops: [], depth: 1 };
  }

  /** Close the group opened by begin(): its commands become one undo entry (none — nothing). */
  end(): void {
    const g = this.group;
    if (!g) throw new Error(coded('E_EDITOR_API', 'EditorDocument.end: no group is open (begin)'));
    if (--g.depth > 0) return;
    this.group = null;
    if (!g.ops.length) return;
    this.undoStack.push({ label: g.label, at: Date.now(), ops: g.ops });
    this.redoStack.length = 0;
    this.changed({ type: 'batch', label: g.label });
  }

  /** Close the group undoing all its commands (the whole group, also from a nested level). */
  abort(): void {
    const g = this.group;
    if (!g) throw new Error(coded('E_EDITOR_API', 'EditorDocument.abort: no group is open (begin)'));
    this.group = null;
    if (!g.ops.length) return;
    for (let i = g.ops.length - 1; i >= 0; i--) g.ops[i].undo();
    this.changed({ type: 'rollback', label: g.label });
  }

  /** A group is open (begin without end/abort). */
  get grouping(): boolean {
    return this.group != null;
  }

  undo(): boolean {
    if (this.group) return false;
    const e = this.undoStack.pop();
    if (!e) return false;
    for (let i = e.ops.length - 1; i >= 0; i--) e.ops[i].undo();
    this.redoStack.push(e);
    this.changed({ type: 'undo', label: e.label });
    return true;
  }

  redo(): boolean {
    if (this.group) return false;
    const e = this.redoStack.pop();
    if (!e) return false;
    for (const op of e.ops) op.redo();
    this.undoStack.push(e);
    this.changed({ type: 'redo', label: e.label });
    return true;
  }

  /** The base as SVG text: untouched parts byte for byte as opened. */
  serialize(): string {
    return serializeSource(this.src);
  }

  /** 2.3: the heir as text (heir.* edits; untouched parts byte for byte); undefined — no heir. */
  serializeHeir(): string | undefined {
    return this.heirDoc ? serializeSource(this.heirDoc) : undefined;
  }

  /** 2.3: the heir changed since opened / saved. */
  get heirDirty(): boolean {
    return this.heirDoc != null && this.serializeHeir() !== this.heirSaved;
  }

  /** 2.3: clip files of the scene (their ClipsDocuments: clipsDoc(file)). */
  clipFiles(): string[] {
    return [...this.clipDocs.keys()];
  }

  /** 2.3: a clip file as a document of commands (clip.*, track.*, key.*, event.*) — in this scene's history. */
  clipsDoc(file: string): ClipsDocument | null {
    return this.clipDocs.get(file) ?? null;
  }

  /** 2.3: a new clip file of the scene (empty, or `text`); it is written on save. */
  createClips(file: string, text = ''): ClipsDocument {
    if (this.clipDocs.has(file)) throw new Error(coded('E_EDITOR_FILE_EXISTS', `${file}: the scene already has this clip file`));
    const host = { scene: () => this._merged, record: (label: string, ops: Op[], type: ChangeEvent['type']) => this.record(label, ops, type) };
    const d = attachClips(text, file, host);
    this.clipDocs.set(file, d);
    return d;
  }

  /** The element tree (ids, tags, index paths) — for a layers panel or an agent's view. */
  tree(): TreeNode[] {
    const build = (el: Element): TreeNode => {
      const id = el.getAttribute('id');
      const node: TreeNode = { tag: el.nodeName, path: indexPath(this.src.root, el), children: elementChildren(el).map(build) };
      if (id) node.id = id;
      if (el.nodeName === 'use') node.href = el.getAttribute('href') ?? '';
      return node;
    };
    return [build(this.src.root)];
  }

  // ---- internals -------------------------------------------------------------------------

  private ctx(): Ctx {
    let heir: Ctx | null | undefined;
    const ctx: Ctx = new Ctx(this.src.doc, this.src.root, this.sep, this.clipRefs(), {
      merged: () => this._merged,
      loadScene: this.loadScene || this.created.size ? (rel) => this.load(rel) : undefined,
      files: [],
      heir: () => {
        if (heir === undefined) heir = this.heirDoc ? new Ctx(this.heirDoc.doc, this.heirDoc.root, ' ', new Map(), ctx.env, ctx) : null;
        return heir;
      },
      renameInClips: (from, to) => [...this.clipDocs.values()].map((d) => d.textOp(renameInClips(d.toString(), from, to))).filter((op): op is Op => op != null),
    });
    return ctx;
  }

  /** id → clip files that refer to it (track targets and motion paths). */
  private clipRefs(): Map<string, string[]> {
    const refs = new Map<string, string[]>();
    for (const [file, d] of this.clipDocs) {
      for (const clip of Object.values(compileClipsResult(d.toString()).clips)) {
        for (const t of clip.tracks) {
          for (const id of [t.target, t.path]) {
            if (!id || id.startsWith('$')) continue;
            const files = refs.get(id) ?? [];
            if (!files.includes(file)) files.push(file);
            refs.set(id, files);
          }
        }
      }
    }
    return refs;
  }

  /** 2.3: ops applied elsewhere (a clip file) recorded as one undo entry, or into the open group. */
  private record(label: string, ops: Op[], type: ChangeEvent['type']): void {
    if (!ops.length) return;
    if (this.group) this.group.ops.push(...ops);
    else {
      this.undoStack.push({ label, at: Date.now(), ops: [...ops] });
      this.redoStack.length = 0;
    }
    this.changed({ type, label });
  }

  /** Prefab documents: created by commands first, then the host's loader. */
  private load(rel: string): SceneSource | null {
    const key = rebase(rel, '_');
    return this.created.get(key) ?? this.loadScene?.(key) ?? null;
  }

  /** Run a command inside ctx; on failure undo its own ops and return the errors. */
  private run(ctx: Ctx, name: string, args: unknown): string[] | null {
    const def = registry[name];
    if (!def) return [coded('E_EDITOR_COMMAND', `no command "${name}" (commands: ${Object.keys(registry).join(', ')})`)];
    if (this.heirOnly && !HEIR_COMMANDS.has(name)) {
      return [coded('E_EDITOR_READONLY', `${name}: the scene extends another scene — its base is read-only here (edit it where it lives); the heir's effects and the clips are edited`)];
    }
    const argErrors = checkSchema(def.schema, args);
    if (argErrors.length) return argErrors;
    const mark = ctx.ops.length;
    try {
      def.run(ctx, args as never);
      return null;
    } catch (e) {
      for (let i = ctx.ops.length - 1; i >= mark; i--) ctx.ops[i].undo();
      ctx.ops.length = mark;
      if (e instanceof CommandError) return [e.message];
      throw e;
    }
  }

  private commit(ctx: Ctx, label: string, type: ChangeEvent['type']): CommandResult {
    const result: CommandResult = { ok: true, changed: ctx.changed };
    if (ctx.warnings.length) result.warnings = [...ctx.warnings];
    if (ctx.env.files.length) {
      result.files = [...ctx.env.files];
      for (const f of ctx.env.files) {
        const stem = f.path.replace(/(\.tml)?\.svg$|\.contract\.xml$/, '');
        const src = this.created.get(`${stem}.svg`) ?? {};
        if (f.path.endsWith('.tml.svg')) src.heir = f.text;
        else if (f.path.endsWith('.contract.xml')) src.contract = f.text;
        else src.base = f.text;
        this.created.set(`${stem}.svg`, src);
      }
    }
    if (ctx.ops.length && this.group) {
      this.group.ops.push(...ctx.ops);
      this.changed({ type, label });
    } else if (ctx.ops.length) {
      this.undoStack.push({ label, at: Date.now(), ops: [...ctx.ops] });
      this.redoStack.length = 0;
      this.changed({ type, label });
    }
    return result;
  }

  private changed(e: ChangeEvent): void {
    this.validate();
    for (const d of this.clipDocs.values()) d.notify(e);
    for (const fn of this.listeners) fn(e);
  }

  private validate(): void {
    const text = this.serialize();
    let scene: SceneNode;
    try {
      scene = parse(text);
    } catch (e) {
      this._errors = [(e as Error).message];
      return;
    }
    const errors: string[] = [];
    if (!this.heirOnly) errors.push(...baseTmlErrors(scene), ...baseDuplicateIdErrors(scene));
    // Contract, instances (v0.9), heir — the runtime's composition over the expanded tree.
    const c = composeScene({
      base: this.heirOnly ? undefined : text,
      heir: this.serializeHeir(),
      contract: this.contractSrc,
      path: this.path,
      loadScene: this.loadScene || this.created.size ? (rel) => this.load(rel) : undefined,
    });
    errors.push(...c.errors.contract, ...c.errors.prefab, ...c.errors.merge.map((e) => within('heir', e)));
    const merged = c.tree ?? scene;
    errors.push(...geometryErrors(merged), ...propErrors(merged));
    for (const [file, d] of this.clipDocs) {
      const id = this.path?.replace(/\\/g, '/').replace(/(\.tml)?\.svg$/, '');
      errors.push(...compileClipsResult(d.toString(), merged).errors.map((e) => (id ? sharedClipHint(file, id, within(file, e)) : within(file, e))));
    }
    this._scene = scene;
    this._merged = merged;
    this._errors = dedupe(errors);
  }
}

/** Open a base scene for editing. @throws on malformed XML / unsupported tags / a bad contract or heir. */
export function openDocument(svg: string, opts: OpenOptions = {}): EditorDocument {
  return new EditorDocument(svg, opts);
}
