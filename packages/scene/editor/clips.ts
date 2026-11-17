// clips.ts — ClipsDocument (2.3): md clips (anim/*.md, X.anim.md) as text with commands — the
// timeline's and an agent's way to edit a clip, with a minimal diff of the md.
//
// The document is the md TEXT, not the compiled clip: a command reads the lines into blocks
// (`# $clip`, `## $track`, `## $events`), attributes (`$key: value`) and tables, changes only the
// lines it has to, and writes them back. Prose, comment headings, column order and every table it
// does not touch stay byte for byte; a touched table is re-aligned as a whole when it was aligned
// (all its lines of one width), else only its changed rows are rewritten in the table's compact
// style (`| a | b |`). After every command the md is compiled (against the scene when there is
// one): a command that adds compile errors is rolled back and returns them — like the base's
// commands, `{ ok: false, errors }`, the document untouched.
//
// History: a standalone document (openClips) keeps its own undo/redo; a document of an
// EditorDocument (doc.clipsDoc(file)) records into the scene's history — one undo stack for the
// base, its heir and its clips, so ⌘Z and a script's one undo step cover them all.
//
// Times are written with at most 4 decimals and snapped to frames of 1/60 s where the command
// says so; two times within 1 ms are the same key.

import { coded, compileClipsResult, within, type CompileClipsResult, type SceneNode } from '@trempel/scene/core';
import { CommandError, type Op } from './ctx.js';
import { checkSchema, type JSONSchema7 } from './schema.js';
import type { CommandCall, CommandResult, ChangeEvent, HistoryEntry } from './document.js';

// ---- the md as lines ---------------------------------------------------------------------------

const NAME = '[A-Za-z_][A-Za-z0-9_.-]*';
const HEADER = new RegExp(`^(#{1,6}) \\$(${NAME})(?: (.*))?$`);
const CLOSE = /^#{1,6} \$@?$/;
const ATTR = new RegExp(`^\\$(${NAME}):( ?)(.*)$`);

/** Value columns of a track table (t and ease are not values). */
export const CLIP_COLUMNS = [
  'x', 'y', 'rotation', 'scale', 'scaleX', 'scaleY', 'skewX', 'skewY', 'alpha', 'tint', 'z', 'tex', 'view', 'motion',
  'dash', 'strokeWidth', 'strokeAlpha', 'width', 'height',
] as const;
const STRING_COLUMNS = new Set(['tint', 'tex', 'view']);
const TRACK_ATTRS = ['path', 'orient', 'orient-offset', 'offset', 'tex'] as const;
const CLIP_ATTRS = ['duration', 'loop', 'tex'] as const;
const EASE_NAMES = ['linear', 'in', 'out', 'inOut', 'outBack', 'inBack', 'outBounce', 'step', 'quadIn', 'quadOut', 'quadInOut', 'cubicInOut', 'backOut', 'elasticOut'];
/** One frame of the timeline. */
export const FRAME = 1 / 60;
/** Two times closer than this are one key. */
const SAME_T = 1e-3;

interface Table {
  /** Line of the header row; `end` — past the last row. */
  line: number;
  end: number;
  columns: string[];
  rows: { line: number; cells: string[] }[];
  /** Every line of the table has one width: re-aligned when touched. */
  aligned: boolean;
  /** `| --- |` (true) or `|---|` (false) in the separator. */
  spacedSep: boolean;
  indent: string;
  /** Column widths of an aligned table as written (a re-alignment never narrows them). */
  widths: Record<string, number>;
}

interface Block {
  name: string;
  id?: string;
  level: number;
  /** The header line. */
  line: number;
  /** Past the block (the next header of the same or a higher level, a `# $` close, the end). */
  end: number;
  /** Past the block's own lines (before its first child header). */
  ownEnd: number;
  attrs: { key: string; line: number; value: string }[];
  table: Table | null;
  children: Block[];
}

function splitRow(l: string): string[] {
  const inner = l.trim().replace(/^\|/, '').replace(/\|$/, '');
  return inner.split('|').map((c) => c.trim());
}

function scanTable(lines: string[], from: number, to: number): Table | null {
  let i = from;
  while (i < to && !lines[i].trim().startsWith('|')) i++;
  if (i >= to) return null;
  let end = i;
  while (end < to && lines[end].trim().startsWith('|')) end++;
  const columns = splitRow(lines[i]);
  const sep = lines[i + 1];
  if (end - i < 2 || !splitRow(sep).every((c) => /^:?-+:?$/.test(c))) return { line: i, end, columns, rows: [], aligned: false, spacedSep: true, indent: '', widths: {} };
  const rows: Table['rows'] = [];
  for (let k = i + 2; k < end; k++) {
    const cells = splitRow(lines[k]);
    while (cells.length < columns.length) cells.push('');
    rows.push({ line: k, cells: cells.slice(0, columns.length) });
  }
  const widths = new Set<number>();
  for (let k = i; k < end; k++) widths.add(lines[k].trimEnd().length);
  const aligned = widths.size === 1 && end - i > 2;
  const colWidths: Record<string, number> = {};
  if (aligned) {
    const runs = sep.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
    columns.forEach((c, k) => (colWidths[c] = Math.max((runs[k]?.length ?? 2) - 2, c.length, ...rows.map((r) => r.cells[k].length))));
  }
  return { line: i, end, columns, rows, aligned, spacedSep: /\|\s+:?-/.test(sep), indent: /^\s*/.exec(lines[i])![0], widths: colWidths };
}

/** The block tree of md clips as line ranges (the same nesting rules as md/parse.ts). */
function scan(lines: string[]): Block {
  const root: Block = { name: '', level: 0, line: -1, end: lines.length, ownEnd: lines.length, attrs: [], table: null, children: [] };
  const stack: Block[] = [root];
  const all: Block[] = [];
  lines.forEach((line, i) => {
    if (CLOSE.test(line)) {
      while (stack.length > 1) stack.pop()!.end = i;
      return;
    }
    const h = HEADER.exec(line);
    if (!h) return;
    const level = h[1].length;
    while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop()!.end = i;
    const b: Block = { name: h[2], level, line: i, end: lines.length, ownEnd: lines.length, attrs: [], table: null, children: [] };
    const tail = h[3]?.trim();
    if (tail) b.id = tail;
    stack[stack.length - 1].children.push(b);
    stack.push(b);
    all.push(b);
  });
  for (const b of [root, ...all]) {
    let j = b.line + 1;
    while (j < b.end && !HEADER.test(lines[j]) && !CLOSE.test(lines[j])) j++;
    b.ownEnd = j;
    for (let k = b.line + 1; k < b.ownEnd; k++) {
      const a = ATTR.exec(lines[k]);
      if (a) b.attrs.push({ key: a[1], line: k, value: a[3].trim() });
    }
    if (b !== root) b.table = scanTable(lines, b.line + 1, b.ownEnd);
  }
  return root;
}

const timeOf = (cell: string): number => (cell.trim() === '' ? NaN : Number(cell));
const sameT = (a: number, b: number): boolean => Math.abs(a - b) < SAME_T;

/** A time as written: ≤ 4 decimals, no -0. */
export function fmtTime(t: number): string {
  const r = Math.round(t * 1e4) / 1e4;
  return String(Object.is(r, -0) ? 0 : r);
}

/** A cell value as written: numbers with ≤ 4 decimals; strings as given. */
function fmtCell(v: number | string): string {
  if (typeof v === 'number') return fmtTime(v);
  return v;
}

function fmtEase(e: string | number[] | null): string {
  if (e == null) return '';
  if (Array.isArray(e)) return `[${e.map((x) => fmtTime(x)).join(', ')}]`;
  return e;
}

/** Rows of a table as written lines (aligned: every line re-padded; compact: `| a | b |`). */
function tableLines(t: { columns: string[]; rows: string[][]; aligned: boolean; spacedSep: boolean; indent: string; widths?: Record<string, number> }): string[] {
  const n = t.columns.length;
  if (t.aligned) {
    const w = t.columns.map((c, i) => Math.max(t.widths?.[c] ?? 3, c.length, ...t.rows.map((r) => (r[i] ?? '').length)));
    const row = (cells: string[]): string => `${t.indent}| ${w.map((wi, i) => (cells[i] ?? '').padEnd(wi)).join(' | ')} |`;
    return [row(t.columns), `${t.indent}|${w.map((wi) => '-'.repeat(wi + 2)).join('|')}|`, ...t.rows.map(row)];
  }
  const row = (cells: string[]): string => `${t.indent}| ${Array.from({ length: n }, (_, i) => cells[i] ?? '').join(' | ')} |`;
  const sep = t.spacedSep ? `${t.indent}| ${Array(n).fill('---').join(' | ')} |` : `${t.indent}|${Array(n).fill('---').join('|')}|`;
  return [row(t.columns), sep, ...t.rows.map(row)];
}

// ---- the edit buffer a command works on ----------------------------------------------------------

/** What a command changes: a copy of the lines, re-scanned after every structural edit. */
class Buf {
  lines: string[];
  root!: Block;
  constructor(text: string) {
    this.lines = text.split('\n');
    this.rescan();
  }

  rescan(): void {
    this.root = scan(this.lines);
  }

  get text(): string {
    return this.lines.join('\n');
  }

  splice(at: number, remove: number, ...add: string[]): void {
    this.lines.splice(at, remove, ...add);
    this.rescan();
  }

  clips(): Block[] {
    return this.root.children.filter((b) => b.name === 'clip' && b.id);
  }

  clip(name: string): Block {
    const c = this.clips().find((b) => b.id === name);
    if (!c) throw new CommandError('E_EDITOR_CLIP_NONE', `clip: no clip "${name}" (clips: ${this.clips().map((b) => b.id).join(', ') || '—'})`);
    return c;
  }

  tracks(clip: Block, target?: string): Block[] {
    return clip.children.filter((b) => b.name === 'track' && (target == null || b.id === target));
  }

  events(clip: Block): Block | null {
    return clip.children.find((b) => b.name === 'events') ?? null;
  }

  /** Rewrite a table (its row set / columns changed): see tableLines; untouched compact rows keep their text. */
  writeTable(t: Table, columns: string[], rows: { cells: string[]; keep?: number }[]): void {
    const sameCols = columns.length === t.columns.length && columns.every((c, i) => c === t.columns[i]);
    let out: string[];
    if (t.aligned) {
      out = tableLines({ columns, rows: rows.map((r) => r.cells), aligned: true, spacedSep: t.spacedSep, indent: t.indent, widths: t.widths });
      // the widths held: the untouched lines stay as written (a hand-made `| 0.45| …` included)
      const grown = columns.some((c, i) => Math.max(c.length, ...rows.map((r) => (r.cells[i] ?? '').length)) > (t.widths[c] ?? -1));
      if (sameCols && !grown) {
        out[0] = this.lines[t.line];
        out[1] = this.lines[t.line + 1];
        rows.forEach((r, i) => {
          if (r.keep != null && this.unchanged(t, r)) out[i + 2] = this.lines[r.keep];
        });
      }
    } else {
      const fresh = tableLines({ columns, rows: rows.map((r) => r.cells), aligned: false, spacedSep: t.spacedSep, indent: t.indent });
      out = sameCols ? [this.lines[t.line], this.lines[t.line + 1] ?? fresh[1]] : fresh.slice(0, 2);
      rows.forEach((r, i) => out.push(sameCols && r.keep != null && this.unchanged(t, r) ? this.lines[r.keep] : fresh[i + 2]));
    }
    this.splice(t.line, t.end - t.line, ...out);
  }

  private unchanged(t: Table, r: { cells: string[]; keep?: number }): boolean {
    const was = t.rows.find((x) => x.line === r.keep);
    return !!was && was.cells.length === r.cells.length && was.cells.every((c, i) => c === r.cells[i]);
  }

  /** Insert a block's lines after line `at` with one blank line before it. */
  insertBlock(at: number, block: string[]): void {
    const lead = at > 0 && this.lines[at - 1].trim() !== '' ? [''] : [];
    const trail = at < this.lines.length && this.lines[at].trim() !== '' ? [''] : [];
    this.splice(at, 0, ...lead, ...block, ...trail);
  }

  /** Remove lines [from, to) (its trailing blank lines stay) and the blank line that would be left doubled. */
  removeLines(from: number, to: number): void {
    const blank = (i: number): boolean => this.lines[i].trim() === '';
    let b = to;
    while (b > from && blank(b - 1)) b--;
    this.lines.splice(from, b - from);
    if (from > 0 && blank(from - 1) && (from >= this.lines.length || blank(from))) this.lines.splice(from - 1, 1);
    else if (from === 0 && this.lines.length > 1 && blank(0)) this.lines.splice(0, 1);
    this.rescan();
  }

  /** Where a new block of a clip goes: after its last child (before trailing blank lines). */
  clipTail(clip: Block, before?: Block | null): number {
    let at = before ? before.line : clip.end;
    while (at > clip.line + 1 && this.lines[at - 1].trim() === '') at--;
    return at;
  }

  /** The table style of the file (for new tables): the first table's. */
  style(): { aligned: boolean; spacedSep: boolean } {
    const first = (b: Block): Table | null => b.table ?? b.children.map(first).find(Boolean) ?? null;
    const t = this.root.children.map(first).find(Boolean);
    return t ? { aligned: t.aligned, spacedSep: t.spacedSep } : { aligned: false, spacedSep: false };
  }

  setAttrLine(block: Block, key: string, value: string | null): void {
    const a = block.attrs.find((x) => x.key === key);
    if (a) {
      if (value == null) this.splice(a.line, 1);
      else if (this.lines[a.line] !== `$${key}: ${value}`) this.splice(a.line, 1, `$${key}: ${value}`);
      return;
    }
    if (value == null) return;
    const last = block.attrs.length ? block.attrs[block.attrs.length - 1].line : block.line;
    this.splice(last + 1, 0, `$${key}: ${value}`);
  }
}

// ---- schema pieces ----------------------------------------------------------------------------

const obj = (properties: Record<string, JSONSchema7>, required: string[] = []): JSONSchema7 => ({ type: 'object', properties, required, additionalProperties: false });
const CLIP: JSONSchema7 = { type: 'string', minLength: 1, description: 'clip name (# $clip <name>)' };
const CLIP_NAME: JSONSchema7 = { type: 'string', pattern: '^[^\\s|#$][^\\s|]*$', description: 'a new clip name (no spaces, no |)' };
const TARGET: JSONSchema7 = { type: 'string', pattern: '^\\$?[A-Za-z_][\\w./-]*$', description: 'track target: a node id (or $name — bound at play time)' };
const INDEX: JSONSchema7 = { type: 'integer', minimum: 0, description: 'which table of the target (0 — the first); default — all of them' };
const TIME: JSONSchema7 = { type: 'number', minimum: 0, description: 'seconds' };
const COLUMN: JSONSchema7 = { type: 'string', enum: [...CLIP_COLUMNS], description: 'a value column (§9.2)' };
const VALUE: JSONSchema7 = { anyOf: [{ type: 'number' }, { type: 'string', minLength: 1 }], description: 'a number, a colour #rrggbb (tint), a texture / view name, or $name (a clip parameter)' };
const EASE: JSONSchema7 = {
  anyOf: [{ type: 'string', enum: EASE_NAMES }, { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 }, { type: 'null' }],
  description: `ease from this key to the next: ${EASE_NAMES.join(', ')} or [x1, y1, x2, y2]; null — none (linear)`,
};
const KEY: JSONSchema7 = obj({ target: TARGET, column: COLUMN, t: TIME }, ['target', 'column', 't']);
const KEYS: JSONSchema7 = { type: 'array', items: KEY, minItems: 1 };
const EVENT_REF: JSONSchema7 = obj({ t: TIME, event: { type: 'string', minLength: 1 } }, ['t', 'event']);
const EVENT_NAME: JSONSchema7 = { type: 'string', pattern: '^[^|\\s][^|]*$', description: 'event name, e.g. sfx:stamp or fx:<effect>@<node>' };
const SNAP: JSONSchema7 = { type: 'boolean', description: 'snap the new times to frames of 1/60 s and to other keys within 2 frames (default true)' };

export interface KeyRef {
  target: string;
  column: string;
  t: number;
}

export interface EventRef {
  t: number;
  event: string;
}

// ---- helpers over the buffer ----------------------------------------------------------------------

function checkValue(column: string, v: number | string): void {
  if (typeof v === 'string' && /[|\n]/.test(v)) throw new CommandError('E_EDITOR_CLIP_VALUE', `value: "${v}" — a cell cannot hold | or a line break`);
  // a number column takes a number, a number as written ("1.0" stays "1.0") or $name
  if (typeof v === 'string' && !STRING_COLUMNS.has(column) && !/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(v) && !(v.trim() !== '' && Number.isFinite(Number(v)))) {
    throw new CommandError('E_EDITOR_CLIP_VALUE', `value: ${column} takes a number or a clip parameter $name, not "${v}"`);
  }
}

/** The table of `target` in `clip` that has `column` (null — none). */
function tableWith(buf: Buf, clip: Block, target: string, column: string): Block | null {
  return buf.tracks(clip, target).find((b) => b.table?.columns.includes(column)) ?? null;
}

function rowIndex(t: Table, at: number): number {
  const ti = t.columns.indexOf('t');
  return t.rows.findIndex((r) => sameT(timeOf(r.cells[ti]), at));
}

/** A track table's rows as editable cells (keep — the original line). */
function editRows(t: Table): { cells: string[]; keep?: number }[] {
  return t.rows.map((r) => ({ cells: [...r.cells], keep: r.line }));
}

/** Put a row for time `at` in order (or find it); returns its index. `ease` — of a new row. */
function rowAt(columns: string[], rows: { cells: string[]; keep?: number }[], at: number, ease?: string): number {
  const ti = columns.indexOf('t');
  const found = rows.findIndex((r) => sameT(timeOf(r.cells[ti]), at));
  if (found >= 0) return found;
  const cells = columns.map(() => '');
  cells[ti] = fmtTime(at);
  const ei = columns.indexOf('ease');
  if (ei >= 0 && ease) cells[ei] = ease;
  let k = rows.findIndex((r) => timeOf(r.cells[ti]) > at);
  if (k < 0) k = rows.length;
  rows.splice(k, 0, { cells });
  return k;
}

/** Drop rows left without any value (t and ease are not values). */
function pruneRows(columns: string[], rows: { cells: string[]; keep?: number }[]): { cells: string[]; keep?: number }[] {
  return rows.filter((r) => r.cells.some((c, i) => c !== '' && columns[i] !== 't' && columns[i] !== 'ease'));
}

/** Columns with a new one: before `ease` when ease is last, else at the end. */
function withColumn(columns: string[], col: string): string[] {
  if (columns.includes(col)) return columns;
  const e = columns.indexOf('ease');
  return e >= 0 && e === columns.length - 1 ? [...columns.slice(0, e), col, 'ease'] : [...columns, col];
}

function widen(rows: { cells: string[]; keep?: number }[], from: string[], to: string[]): { cells: string[]; keep?: number }[] {
  return rows.map((r) => ({ cells: to.map((c) => r.cells[from.indexOf(c)] ?? ''), keep: r.keep }));
}

/** A new track block: `## $track <target>` + a table with t, the columns and ease. */
function newTrack(buf: Buf, target: string, columns: string[]): string[] {
  const s = buf.style();
  const cols = ['t', ...columns.filter((c) => c !== 't' && c !== 'ease'), 'ease'];
  return [`## $track ${target}`, ...tableLines({ columns: cols, rows: [], aligned: false, spacedSep: s.spacedSep, indent: '' })];
}

/** Where a new track goes in a clip: after its last track (before $events / $tex), else at the clip's end. */
function trackSlot(buf: Buf, clip: Block): number {
  const tracks = buf.tracks(clip);
  if (tracks.length) return buf.clipTail(clip, clip.children[clip.children.indexOf(tracks[tracks.length - 1]) + 1] ?? null);
  return buf.clipTail(clip, clip.children[0] ?? null);
}

/** The table (creating the track / the column when missing) where `target.column` lives. */
function ensureColumn(buf: Buf, clipName: string, target: string, column: string): Block {
  let clip = buf.clip(clipName);
  const have = tableWith(buf, clip, target, column);
  if (have) return have;
  const tracks = buf.tracks(clip, target).filter((b) => b.table && b.table.columns.includes('t'));
  if (tracks.length) {
    const b = tracks[0];
    const t = b.table!;
    const cols = withColumn(t.columns, column);
    buf.writeTable(t, cols, widen(editRows(t), t.columns, cols));
  } else {
    buf.insertBlock(trackSlot(buf, clip), newTrack(buf, target, [column]));
  }
  clip = buf.clip(clipName);
  return tableWith(buf, clip, target, column)!;
}

/** Snap a new time: to another key within 2 frames, else to the frame. */
function snapTime(t: number, others: number[], snap: boolean): number {
  if (!snap) return Math.max(0, t);
  let best: number | null = null;
  for (const o of others) if (Math.abs(o - t) <= 2 * FRAME + 1e-9 && (best == null || Math.abs(o - t) < Math.abs(best - t))) best = o;
  return Math.max(0, best ?? Math.round(t / FRAME) * FRAME);
}

/** Every key time of a clip (all tracks, all value columns) except `skip`. */
function keyTimes(buf: Buf, clip: Block, skip: (target: string, column: string, t: number) => boolean): number[] {
  const out: number[] = [];
  for (const b of buf.tracks(clip)) {
    const t = b.table;
    if (!t) continue;
    const ti = t.columns.indexOf('t');
    for (const r of t.rows) {
      const at = timeOf(r.cells[ti]);
      if (!Number.isFinite(at)) continue;
      t.columns.forEach((c, i) => {
        if (c !== 't' && c !== 'ease' && r.cells[i] !== '' && !skip(b.id ?? '', c, at)) out.push(at);
      });
    }
  }
  return out;
}

function ensureEvents(buf: Buf, clipName: string): Block {
  const clip = buf.clip(clipName);
  const ev = buf.events(clip);
  if (ev?.table) return ev;
  if (ev) {
    const s = buf.style();
    buf.splice(ev.ownEnd, 0, ...tableLines({ columns: ['t', 'event'], rows: [], aligned: false, spacedSep: s.spacedSep, indent: '' }));
  } else {
    const s = buf.style();
    buf.insertBlock(buf.clipTail(clip), ['## $events', ...tableLines({ columns: ['t', 'event'], rows: [], aligned: false, spacedSep: s.spacedSep, indent: '' })]);
  }
  return buf.events(buf.clip(clipName))!;
}

function eventRows(ev: Block): { cells: string[]; keep?: number }[] {
  return editRows(ev.table!);
}

function findEvent(ev: Block, rows: { cells: string[] }[], ref: EventRef): number {
  const cols = ev.table!.columns;
  const ti = cols.indexOf('t');
  const ei = cols.indexOf('event');
  const k = rows.findIndex((r) => sameT(timeOf(r.cells[ti]), ref.t) && r.cells[ei] === ref.event);
  if (k < 0) throw new CommandError('E_EDITOR_CLIP_EVENT', `events: no event "${ref.event}" at ${fmtTime(ref.t)} s`);
  return k;
}

function insertEvent(ev: Block, rows: { cells: string[]; keep?: number }[], t: number, name: string): void {
  const cols = ev.table!.columns;
  const ti = cols.indexOf('t');
  const ei = cols.indexOf('event');
  const cells = cols.map(() => '');
  cells[ti] = fmtTime(t);
  cells[ei] = name;
  let k = rows.findIndex((r) => timeOf(r.cells[ti]) > t + SAME_T / 2);
  if (k < 0) k = rows.length;
  rows.splice(k, 0, { cells });
}

// ---- the commands ----------------------------------------------------------------------------------

export interface ClipCommandDef {
  schema: JSONSchema7;
  describe: string;
  run(buf: Buf, args: never): void;
}

const defs = {
  'clip.create': {
    describe: 'Create an empty clip (# $clip <name>) at the end of the file; duration — $duration (s), loop — $loop.',
    schema: obj({ name: CLIP_NAME, duration: { type: 'number', exclusiveMinimum: 0 }, loop: { type: 'boolean' } }, ['name']),
    run(buf: Buf, a: { name: string; duration?: number; loop?: boolean }) {
      if (buf.clips().some((c) => c.id === a.name)) throw new CommandError('E_EDITOR_CLIP_TAKEN', `name: the file already has a clip "${a.name}"`);
      let at = buf.lines.length;
      while (at > 0 && buf.lines[at - 1].trim() === '') at--;
      const lines = [`# $clip ${a.name}`];
      if (a.duration != null) lines.push(`$duration: ${fmtTime(a.duration)}`);
      if (a.loop != null) lines.push(`$loop: ${a.loop}`);
      if (at === 0) buf.splice(0, buf.lines.length, ...lines, '');
      else buf.splice(at, 0, '', ...lines);
    },
  },

  'clip.rename': {
    describe: 'Rename a clip.',
    schema: obj({ clip: CLIP, name: CLIP_NAME }, ['clip', 'name']),
    run(buf: Buf, a: { clip: string; name: string }) {
      const c = buf.clip(a.clip);
      if (a.name === a.clip) return;
      if (buf.clips().some((x) => x.id === a.name)) throw new CommandError('E_EDITOR_CLIP_TAKEN', `name: the file already has a clip "${a.name}"`);
      buf.splice(c.line, 1, buf.lines[c.line].replace(/(\$clip )(.*)$/, `$1${a.name}`));
    },
  },

  'clip.remove': {
    describe: 'Remove a clip with its tracks and events.',
    schema: obj({ clip: CLIP }, ['clip']),
    run(buf: Buf, a: { clip: string }) {
      const c = buf.clip(a.clip);
      buf.removeLines(c.line, c.end);
    },
  },

  'clip.duplicate': {
    describe: 'Copy a clip under a new name, right after it.',
    schema: obj({ clip: CLIP, name: CLIP_NAME }, ['clip', 'name']),
    run(buf: Buf, a: { clip: string; name: string }) {
      const c = buf.clip(a.clip);
      if (buf.clips().some((x) => x.id === a.name)) throw new CommandError('E_EDITOR_CLIP_TAKEN', `name: the file already has a clip "${a.name}"`);
      let end = c.end;
      while (end > c.line + 1 && buf.lines[end - 1].trim() === '') end--;
      const copy = buf.lines.slice(c.line, end);
      copy[0] = copy[0].replace(/(\$clip )(.*)$/, `$1${a.name}`);
      buf.insertBlock(end, copy);
    },
  },

  'clip.setAttr': {
    describe: 'A clip attribute: duration ($duration, seconds), loop ($loop), tex ($tex template); value null — remove it.',
    schema: obj(
      { clip: CLIP, name: { type: 'string', enum: [...CLIP_ATTRS] }, value: { anyOf: [{ type: 'number' }, { type: 'boolean' }, { type: 'string', minLength: 1 }, { type: 'null' }] } },
      ['clip', 'name', 'value'],
    ),
    run(buf: Buf, a: { clip: string; name: string; value: number | boolean | string | null }) {
      const c = buf.clip(a.clip);
      if (a.name === 'duration' && a.value != null && !(typeof a.value === 'number' && a.value > 0)) throw new CommandError('E_EDITOR_CLIP_VALUE', 'value: $duration is a positive number of seconds');
      if (a.name === 'loop' && a.value != null && typeof a.value !== 'boolean') throw new CommandError('E_EDITOR_CLIP_VALUE', 'value: $loop is true or false');
      buf.setAttrLine(c, a.name, a.value == null ? null : typeof a.value === 'number' ? fmtTime(a.value) : String(a.value));
    },
  },

  'track.add': {
    describe: 'A new track (## $track <target>) in a clip, with a table of these value columns (t and ease added) and no keys yet.',
    schema: obj({ clip: CLIP, target: TARGET, columns: { type: 'array', items: COLUMN } }, ['clip', 'target']),
    run(buf: Buf, a: { clip: string; target: string; columns?: string[] }) {
      const c = buf.clip(a.clip);
      for (const col of a.columns ?? []) {
        if (tableWith(buf, c, a.target, col)) throw new CommandError('E_EDITOR_CLIP_TRACK', `columns: ${col} of #${a.target} is already keyed in clip ${a.clip}`);
      }
      buf.insertBlock(trackSlot(buf, c), newTrack(buf, a.target, a.columns ?? []));
    },
  },

  'track.remove': {
    describe: 'Remove the tracks of a target from a clip (index — only that table of the target).',
    schema: obj({ clip: CLIP, target: TARGET, index: INDEX }, ['clip', 'target']),
    run(buf: Buf, a: { clip: string; target: string; index?: number }) {
      const blocks = buf.tracks(buf.clip(a.clip), a.target);
      if (!blocks.length || (a.index != null && a.index >= blocks.length)) {
        throw new CommandError('E_EDITOR_CLIP_TRACK', `target: clip ${a.clip} has ${blocks.length ? `${blocks.length} table(s)` : 'no track'} of #${a.target}`);
      }
      const chosen = a.index != null ? [blocks[a.index]] : blocks;
      for (const b of [...chosen].reverse()) buf.removeLines(b.line, b.end);
    },
  },

  'track.retarget': {
    describe: 'Point a target\'s tracks at another node (index — only that table of the target).',
    schema: obj({ clip: CLIP, target: TARGET, to: TARGET, index: INDEX }, ['clip', 'target', 'to']),
    run(buf: Buf, a: { clip: string; target: string; to: string; index?: number }) {
      const blocks = buf.tracks(buf.clip(a.clip), a.target);
      if (!blocks.length || (a.index != null && a.index >= blocks.length)) throw new CommandError('E_EDITOR_CLIP_TRACK', `target: clip ${a.clip} has no track of #${a.target}${a.index != null ? ` number ${a.index}` : ''}`);
      for (const b of a.index != null ? [blocks[a.index]] : blocks) buf.lines[b.line] = buf.lines[b.line].replace(/(\$track )(.*)$/, `$1${a.to}`);
      buf.rescan();
    },
  },

  'track.setAttr': {
    describe: 'A track attribute: path ($path, a geometry id for motion), orient (auto), orient-offset (degrees), offset ("dx, dy"), tex (template); value null — remove it.',
    schema: obj(
      { clip: CLIP, target: TARGET, index: INDEX, name: { type: 'string', enum: [...TRACK_ATTRS] }, value: { anyOf: [{ type: 'number' }, { type: 'string', minLength: 1 }, { type: 'null' }] } },
      ['clip', 'target', 'name', 'value'],
    ),
    run(buf: Buf, a: { clip: string; target: string; index?: number; name: string; value: number | string | null }) {
      const blocks = buf.tracks(buf.clip(a.clip), a.target);
      const b = blocks[a.index ?? 0];
      if (!b) throw new CommandError('E_EDITOR_CLIP_TRACK', `target: clip ${a.clip} has no track of #${a.target}${a.index != null ? ` number ${a.index}` : ''}`);
      buf.setAttrLine(b, a.name, a.value == null ? null : typeof a.value === 'number' ? fmtTime(a.value) : a.value);
    },
  },

  'key.set': {
    describe:
      'Set a key: the value of column at time t of the target in a clip — the track, the column and the row are created when missing (a new row takes the ease of the row before it). value: a number, #rrggbb (tint), a name (tex, view) or $name (a clip parameter).',
    schema: obj({ clip: CLIP, target: TARGET, column: COLUMN, t: TIME, value: VALUE, ease: EASE }, ['clip', 'target', 'column', 't', 'value']),
    run(buf: Buf, a: { clip: string; target: string; column: string; t: number; value: number | string; ease?: string | number[] | null }) {
      checkValue(a.column, a.value);
      const b = ensureColumn(buf, a.clip, a.target, a.column);
      const t = b.table!;
      let cols = t.columns;
      let rows = editRows(t);
      if (a.ease !== undefined && !cols.includes('ease')) {
        const next = [...cols, 'ease'];
        rows = widen(rows, cols, next);
        cols = next;
      }
      const ei = cols.indexOf('ease');
      const ti = cols.indexOf('t');
      const before = [...rows].reverse().find((r) => timeOf(r.cells[ti]) < a.t - SAME_T / 2);
      const k = rowAt(cols, rows, a.t, ei >= 0 ? before?.cells[ei] : undefined);
      rows[k].cells[cols.indexOf(a.column)] = fmtCell(a.value);
      if (a.ease !== undefined) rows[k].cells[ei] = fmtEase(a.ease);
      buf.writeTable(t, cols, rows);
    },
  },

  'key.remove': {
    describe: 'Remove keys (cells); a row left without values is removed, a track left without rows too.',
    schema: obj({ clip: CLIP, keys: KEYS }, ['clip', 'keys']),
    run(buf: Buf, a: { clip: string; keys: KeyRef[] }) {
      for (const ref of a.keys) {
        const b = tableWith(buf, buf.clip(a.clip), ref.target, ref.column);
        const t = b?.table;
        const k = t ? rowIndex(t, ref.t) : -1;
        const ci = t ? t.columns.indexOf(ref.column) : -1;
        if (!t || k < 0 || t.rows[k].cells[ci] === '') throw new CommandError('E_EDITOR_CLIP_KEY', `keys: no ${ref.column} key of #${ref.target} at ${fmtTime(ref.t)} s in clip ${a.clip}`);
        const rows = editRows(t);
        rows[k].cells[ci] = '';
        const left = pruneRows(t.columns, rows);
        if (!left.length) buf.removeLines(b!.line, b!.end);
        else buf.writeTable(t, t.columns, left);
      }
    },
  },

  'key.move': {
    describe:
      'Move keys by dt seconds (a selection — one step). snap (default true): the new times stick to other keys within 2 frames, else to frames of 1/60 s. A key landing on another key of its column is an error.',
    schema: obj({ clip: CLIP, keys: KEYS, dt: { type: 'number' }, snap: SNAP }, ['clip', 'keys', 'dt']),
    run(buf: Buf, a: { clip: string; keys: KeyRef[]; dt: number; snap?: boolean }) {
      if (a.dt === 0) return;
      const moving = (target: string, column: string, t: number): boolean => a.keys.some((k) => k.target === target && k.column === column && sameT(k.t, t));
      const others = keyTimes(buf, buf.clip(a.clip), moving);
      // Lift every key out (value + its row's ease), then put each back at its new time.
      const lifted: { ref: KeyRef; value: string; ease: string; to: number }[] = [];
      for (const ref of a.keys) {
        const b = tableWith(buf, buf.clip(a.clip), ref.target, ref.column);
        const t = b?.table;
        const k = t ? rowIndex(t, ref.t) : -1;
        const ci = t ? t.columns.indexOf(ref.column) : -1;
        if (!t || k < 0 || t.rows[k].cells[ci] === '') throw new CommandError('E_EDITOR_CLIP_KEY', `keys: no ${ref.column} key of #${ref.target} at ${fmtTime(ref.t)} s in clip ${a.clip}`);
        const ei = t.columns.indexOf('ease');
        lifted.push({ ref, value: t.rows[k].cells[ci], ease: ei >= 0 ? t.rows[k].cells[ei] : '', to: snapTime(ref.t + a.dt, others, a.snap !== false) });
        const rows = editRows(t);
        rows[k].cells[ci] = '';
        buf.writeTable(t, t.columns, pruneRows(t.columns, rows));
      }
      for (const l of lifted) {
        const b = tableWith(buf, buf.clip(a.clip), l.ref.target, l.ref.column);
        if (!b?.table) {
          // the whole table moved out: the track block is still there with its header
          throw new CommandError('E_EDITOR_CLIP_KEY', `keys: the table of #${l.ref.target} lost its ${l.ref.column} column`);
        }
        const t = b.table;
        const rows = editRows(t);
        const ci = t.columns.indexOf(l.ref.column);
        const ei = t.columns.indexOf('ease');
        const ti = t.columns.indexOf('t');
        const existing = rows.findIndex((r) => sameT(timeOf(r.cells[ti]), l.to));
        if (existing >= 0 && rows[existing].cells[ci] !== '') {
          throw new CommandError('E_EDITOR_CLIP_KEY', `keys: ${l.ref.column} of #${l.ref.target} already has a key at ${fmtTime(l.to)} s — move it too, or remove it first`);
        }
        const k = rowAt(t.columns, rows, l.to, ei >= 0 ? l.ease : undefined);
        rows[k].cells[ci] = l.value;
        if (ei >= 0 && existing < 0) rows[k].cells[ei] = l.ease;
        buf.writeTable(t, t.columns, rows);
      }
      // A track whose last key moved out is gone only if no row is left at all (rows were moved, not removed).
    },
  },

  'key.setEase': {
    describe: 'The ease of keys (from the key to the next key of its column). The format keeps one ease per table row: the other values of the row share it.',
    schema: obj({ clip: CLIP, keys: KEYS, ease: EASE }, ['clip', 'keys', 'ease']),
    run(buf: Buf, a: { clip: string; keys: KeyRef[]; ease: string | number[] | null }) {
      for (const ref of a.keys) {
        const b = tableWith(buf, buf.clip(a.clip), ref.target, ref.column);
        const t = b?.table;
        const k = t ? rowIndex(t, ref.t) : -1;
        if (!t || k < 0) throw new CommandError('E_EDITOR_CLIP_KEY', `keys: no ${ref.column} key of #${ref.target} at ${fmtTime(ref.t)} s in clip ${a.clip}`);
        let cols = t.columns;
        let rows = editRows(t);
        if (!cols.includes('ease')) {
          if (a.ease == null) continue;
          const next = [...cols, 'ease'];
          rows = widen(rows, cols, next);
          cols = next;
        }
        rows[k].cells[cols.indexOf('ease')] = fmtEase(a.ease);
        buf.writeTable(t, cols, rows);
      }
    },
  },

  'key.setParam': {
    describe: 'Make a key a clip parameter (param: the name, cell $name — given at play time) or a number again (param: null, value: the number).',
    schema: obj({ clip: CLIP, target: TARGET, column: COLUMN, t: TIME, param: { anyOf: [{ type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$' }, { type: 'null' }] }, value: { type: 'number' } }, ['clip', 'target', 'column', 't', 'param']),
    run(buf: Buf, a: { clip: string; target: string; column: string; t: number; param: string | null; value?: number }) {
      if (STRING_COLUMNS.has(a.column)) throw new CommandError('E_EDITOR_CLIP_VALUE', `column: ${a.column} is not a number column — no parameters`);
      if (a.param == null && a.value == null) throw new CommandError('E_EDITOR_CLIP_VALUE', 'value: a number is needed when the parameter is removed');
      const b = tableWith(buf, buf.clip(a.clip), a.target, a.column);
      const t = b?.table;
      const k = t ? rowIndex(t, a.t) : -1;
      if (!t || k < 0) throw new CommandError('E_EDITOR_CLIP_KEY', `no ${a.column} key of #${a.target} at ${fmtTime(a.t)} s in clip ${a.clip}`);
      const rows = editRows(t);
      rows[k].cells[t.columns.indexOf(a.column)] = a.param != null ? `$${a.param}` : fmtCell(a.value!);
      buf.writeTable(t, t.columns, rows);
    },
  },

  'event.add': {
    describe: 'Add an event ($events) at t: a name the game handles, e.g. sfx:stamp, or fx:<effect>@<node> — an effect at a node of the scene.',
    schema: obj({ clip: CLIP, t: TIME, event: EVENT_NAME }, ['clip', 't', 'event']),
    run(buf: Buf, a: { clip: string; t: number; event: string }) {
      const ev = ensureEvents(buf, a.clip);
      const rows = eventRows(ev);
      insertEvent(ev, rows, a.t, a.event.trim());
      buf.writeTable(ev.table!, ev.table!.columns, rows);
    },
  },

  'event.remove': {
    describe: 'Remove events (by time and name); the $events block goes when it is empty.',
    schema: obj({ clip: CLIP, events: { type: 'array', items: EVENT_REF, minItems: 1 } }, ['clip', 'events']),
    run(buf: Buf, a: { clip: string; events: EventRef[] }) {
      const ev = buf.events(buf.clip(a.clip));
      if (!ev?.table) throw new CommandError('E_EDITOR_CLIP_EVENT', `events: clip ${a.clip} has no $events`);
      const rows = eventRows(ev);
      for (const ref of a.events) rows.splice(findEvent(ev, rows, ref), 1);
      if (!rows.length) buf.removeLines(ev.line, ev.end);
      else buf.writeTable(ev.table, ev.table.columns, rows);
    },
  },

  'event.move': {
    describe: 'Move events by dt seconds (snap — to frames of 1/60 s and to keys within 2 frames, default true).',
    schema: obj({ clip: CLIP, events: { type: 'array', items: EVENT_REF, minItems: 1 }, dt: { type: 'number' }, snap: SNAP }, ['clip', 'events', 'dt']),
    run(buf: Buf, a: { clip: string; events: EventRef[]; dt: number; snap?: boolean }) {
      if (a.dt === 0) return;
      const clip = buf.clip(a.clip);
      const ev = buf.events(clip);
      if (!ev?.table) throw new CommandError('E_EDITOR_CLIP_EVENT', `events: clip ${a.clip} has no $events`);
      const others = keyTimes(buf, clip, () => false);
      const rows = eventRows(ev);
      const moved = a.events.map((ref) => ({ ref, row: rows[findEvent(ev, rows, ref)] }));
      for (const m of moved) rows.splice(rows.indexOf(m.row), 1);
      for (const m of moved) insertEvent(ev, rows, snapTime(m.ref.t + a.dt, others, a.snap !== false), m.ref.event);
      buf.writeTable(ev.table, ev.table.columns, rows);
    },
  },

  'event.set': {
    describe: 'Change one event: its name (name) and / or its time (t).',
    schema: obj({ clip: CLIP, event: EVENT_REF, name: EVENT_NAME, t: TIME }, ['clip', 'event']),
    run(buf: Buf, a: { clip: string; event: EventRef; name?: string; t?: number }) {
      const ev = buf.events(buf.clip(a.clip));
      if (!ev?.table) throw new CommandError('E_EDITOR_CLIP_EVENT', `events: clip ${a.clip} has no $events`);
      const rows = eventRows(ev);
      const k = findEvent(ev, rows, a.event);
      const name = a.name?.trim() ?? a.event.event;
      if (a.t == null || sameT(a.t, a.event.t)) {
        rows[k].cells[ev.table.columns.indexOf('event')] = name;
      } else {
        rows.splice(k, 1);
        insertEvent(ev, rows, a.t, name);
      }
      buf.writeTable(ev.table, ev.table.columns, rows);
    },
  },
} satisfies Record<string, { describe: string; schema: JSONSchema7; run(buf: Buf, a: never): void }>;

export type ClipCommandName = keyof typeof defs;

const registry: Record<string, ClipCommandDef> = defs as unknown as Record<string, ClipCommandDef>;

/** Clip commands: name → { schema, describe } — run on a ClipsDocument (tml.clipsDoc(file).exec). */
export const clipCommands: Record<ClipCommandName, { schema: JSONSchema7; describe: string }> = Object.fromEntries(
  Object.entries(defs).map(([k, v]) => [k, { schema: v.schema, describe: v.describe }]),
) as Record<ClipCommandName, { schema: JSONSchema7; describe: string }>;

// ---- reading -------------------------------------------------------------------------------------

/** A key of a track table as the timeline shows it. */
export interface ClipKey {
  t: number;
  /** The cell as written (`12`, `$toX`, `#ff8800`, `head-blink`). */
  value: string;
  /** The row's ease cell ('' — none). */
  ease: string;
  /** `$name` — a clip parameter. */
  param?: string;
}

export interface ClipTrackInfo {
  target: string;
  /** Which table of the target (0 — the first). */
  index: number;
  /** Track attributes ($path, $orient, …) as written. */
  attrs: Record<string, string>;
  /** Value columns in table order. */
  columns: string[];
  /** Keys by column. */
  keys: Record<string, ClipKey[]>;
  /** Line of `## $track` (0-based). */
  line: number;
}

export interface ClipInfo {
  name: string;
  /** $duration as written (null — none: the last key / event). */
  duration: number | null;
  loop: boolean;
  attrs: Record<string, string>;
  tracks: ClipTrackInfo[];
  events: { t: number; event: string }[];
  line: number;
}

function readClips(text: string): ClipInfo[] {
  const buf = new Buf(text);
  return buf.clips().map((c) => {
    const attrs = Object.fromEntries(c.attrs.map((x) => [x.key, x.value]));
    const counts = new Map<string, number>();
    const tracks: ClipTrackInfo[] = buf.tracks(c).map((b) => {
      const target = b.id ?? '';
      const index = counts.get(target) ?? 0;
      counts.set(target, index + 1);
      const t = b.table;
      const columns = t ? t.columns.filter((x) => x !== 't' && x !== 'ease') : [];
      const keys: Record<string, ClipKey[]> = {};
      if (t) {
        const ti = t.columns.indexOf('t');
        const ei = t.columns.indexOf('ease');
        for (const col of columns) {
          const ci = t.columns.indexOf(col);
          keys[col] = t.rows
            .filter((r) => r.cells[ci] !== '' && Number.isFinite(timeOf(r.cells[ti])))
            .map((r) => {
              const v = r.cells[ci];
              const k: ClipKey = { t: timeOf(r.cells[ti]), value: v, ease: ei >= 0 ? r.cells[ei] : '' };
              if (/^\$[A-Za-z_]\w*$/.test(v)) k.param = v.slice(1);
              return k;
            });
        }
      }
      return { target, index, attrs: Object.fromEntries(b.attrs.map((x) => [x.key, x.value])), columns, keys, line: b.line };
    });
    const ev = buf.events(c)?.table;
    const events = ev
      ? ev.rows
          .map((r) => ({ t: timeOf(r.cells[ev.columns.indexOf('t')]), event: r.cells[ev.columns.indexOf('event')] ?? '' }))
          .filter((e) => Number.isFinite(e.t) && e.event)
      : [];
    const dur = attrs.duration != null ? Number(attrs.duration) : NaN;
    return { name: c.id!, duration: Number.isFinite(dur) ? dur : null, loop: attrs.loop === 'true', attrs, tracks, events, line: c.line };
  });
}

/** Rewrite references to a renamed node id in md clips: `## $track`, `$path`, `fx:…@<id>` events. Returns the new text (same — nothing refers). */
export function renameInClips(text: string, from: string, to: string): string {
  const buf = new Buf(text);
  let changed = false;
  for (const c of buf.clips()) {
    for (const b of c.children) {
      if (b.name === 'track' && b.id === from) {
        buf.lines[b.line] = buf.lines[b.line].replace(/(\$track )(.*)$/, `$1${to}`);
        changed = true;
      }
      if (b.name === 'track') {
        for (const a of b.attrs) {
          if (a.key === 'path' && a.value === from) {
            buf.lines[a.line] = buf.lines[a.line].replace(/(:\s*)(.*)$/, `$1${to}`);
            changed = true;
          }
        }
      }
      if (b.name === 'events' && b.table) {
        const ei = b.table.columns.indexOf('event');
        for (const r of b.table.rows) {
          const name = r.cells[ei] ?? '';
          const m = /^(fx:[^@\s]+)@(\S+)$/.exec(name);
          if (m && m[2] === from) {
            // the one cell, the rest of the line as written
            const at = buf.lines[r.line].indexOf(name);
            buf.lines[r.line] = buf.lines[r.line].slice(0, at) + `${m[1]}@${to}` + buf.lines[r.line].slice(at + name.length);
            changed = true;
          }
        }
      }
    }
  }
  return changed ? buf.text : text;
}

// ---- the document --------------------------------------------------------------------------------

/** Where an attached document records its changes (the scene's history). */
export interface ClipsHost {
  /** The composed scene the clips are compiled against (undefined — compile without it). */
  scene(): SceneNode | undefined;
  /** Record applied ops as one undo entry (or into the open group). */
  record(label: string, ops: Op[], type: ChangeEvent['type']): void;
}

const normalize = (e: string): string => e.replace(/\b(row|line) \d+/g, '$1 #');

interface Entry extends HistoryEntry {
  ops: Op[];
}

export class ClipsDocument {
  private _text: string;
  private saved: string;
  private readonly bom: string;
  private readonly eol: string;
  private readonly undoStack: Entry[] = [];
  private readonly redoStack: Entry[] = [];
  private readonly listeners = new Set<(e: ChangeEvent) => void>();
  private cache: { text: string; scene: SceneNode | undefined; result: CompileClipsResult } | null = null;
  private readCache: { text: string; clips: ClipInfo[] } | null = null;

  constructor(
    md: string,
    readonly file: string,
    private readonly host?: ClipsHost,
    private readonly sceneOf?: () => SceneNode | undefined,
  ) {
    this.bom = md.charCodeAt(0) === 0xfeff ? '﻿' : '';
    const body = this.bom ? md.slice(1) : md;
    this.eol = body.includes('\r\n') ? '\r\n' : '\n';
    this._text = body.replace(/\r\n/g, '\n');
    this.saved = this._text;
  }

  /** The md as it will be saved: untouched lines byte for byte (BOM and CRLF kept). */
  toString(): string {
    return this.bom + (this.eol === '\n' ? this._text : this._text.replace(/\n/g, this.eol));
  }

  /** Same as toString(). */
  get text(): string {
    return this.toString();
  }

  /** Clips of the file as the timeline reads them (tracks, keys by column, events). */
  clips(): ClipInfo[] {
    if (this.readCache?.text !== this._text) this.readCache = { text: this._text, clips: readClips(this._text) };
    return this.readCache.clips;
  }

  /** One clip by name (null — none). */
  clip(name: string): ClipInfo | null {
    return this.clips().find((c) => c.name === name) ?? null;
  }

  /** Compiled against the scene (when there is one): { clips, errors }. */
  compile(): CompileClipsResult {
    const scene = this.host ? this.host.scene() : this.sceneOf?.();
    if (this.cache && this.cache.text === this._text && this.cache.scene === scene) return this.cache.result;
    const result = compileClipsResult(this._text, scene);
    this.cache = { text: this._text, scene, result };
    return result;
  }

  get errors(): string[] {
    return this.compile().errors;
  }

  /** Changed since opened or saved (markClean). */
  get dirty(): boolean {
    return this._text !== this.saved;
  }

  /** The text is on disk now. */
  markClean(): void {
    this.saved = this._text;
  }

  on(event: 'change', fn: (e: ChangeEvent) => void): () => void {
    if (event !== 'change') throw new Error(coded('E_EDITOR_API', `ClipsDocument.on: no event "${event}" (events: change)`));
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Run one clip command: one undo entry. */
  exec(name: ClipCommandName | string, args: unknown = {}): CommandResult {
    return this.apply(name, [{ name, args }], 'exec');
  }

  /** Several clip commands as one undo entry; any failure rolls all back. */
  batch(label: string, calls: CommandCall[]): CommandResult {
    return this.apply(label, calls, 'batch');
  }

  /** Standalone history (an attached document's history is the scene's). */
  undo(): boolean {
    if (this.host) return false;
    const e = this.undoStack.pop();
    if (!e) return false;
    for (let i = e.ops.length - 1; i >= 0; i--) e.ops[i].undo();
    this.redoStack.push(e);
    this.emit({ type: 'undo', label: e.label });
    return true;
  }

  redo(): boolean {
    if (this.host) return false;
    const e = this.redoStack.pop();
    if (!e) return false;
    for (const op of e.ops) op.redo();
    this.undoStack.push(e);
    this.emit({ type: 'redo', label: e.label });
    return true;
  }

  get history(): HistoryEntry[] {
    return this.undoStack.map(({ label, at }) => ({ label, at }));
  }

  /** An op replacing the whole text (for the scene's history: node.setId rewriting references). */
  textOp(next: string): Op | null {
    const before = this._text;
    const after = next.replace(/\r\n/g, '\n');
    if (before === after) return null;
    return {
      redo: () => this.set(after),
      undo: () => this.set(before),
    };
  }

  /** @internal: the host announces a change it applied (undo/redo of its history). */
  notify(e: ChangeEvent): void {
    this.emit(e);
  }

  private set(text: string): void {
    this._text = text;
  }

  private emit(e: ChangeEvent): void {
    for (const fn of this.listeners) fn(e);
  }

  private apply(label: string, calls: CommandCall[], type: ChangeEvent['type']): CommandResult {
    const before = this._text;
    const buf = new Buf(before);
    for (let i = 0; i < calls.length; i++) {
      const { name, args = {} } = calls[i];
      const at = (e: string): string => (calls.length > 1 ? within(`[${i}] ${name}`, e) : e);
      const def = registry[name];
      if (!def) return { ok: false, errors: [at(coded('E_EDITOR_COMMAND', `no clip command "${name}" (commands: ${Object.keys(registry).join(', ')})`))], changed: [] };
      const argErrors = checkSchema(def.schema, args);
      if (argErrors.length) return { ok: false, errors: argErrors.map(at), changed: [] };
      try {
        def.run(buf, args as never);
      } catch (e) {
        if (e instanceof CommandError) return { ok: false, errors: [at(e.message)], changed: [] };
        throw e;
      }
    }
    const after = buf.text;
    if (after === before) return { ok: true, changed: [] };
    // Compile: a command must not add errors (those already in the file do not block it).
    const was = new Set(this.compile().errors.map(normalize));
    this._text = after;
    const now = this.compile().errors;
    const added = now.filter((e) => !was.has(normalize(e)));
    if (added.length) {
      this._text = before;
      return { ok: false, errors: added.map((e) => within(this.file, e)), changed: [] };
    }
    const op: Op = { redo: () => this.set(after), undo: () => this.set(before) };
    const changed = [this.file];
    if (this.host) this.host.record(label, [op], type);
    else {
      this.undoStack.push({ label, at: Date.now(), ops: [op] });
      this.redoStack.length = 0;
    }
    this.emit({ type, label });
    return { ok: true, changed };
  }
}

/**
 * Open md clips for editing. `scene` — the composed scene they are compiled against after every
 * command (omitted — compiled without one: targets are not checked).
 */
export function openClips(md: string, file = 'clips.md', opts: { scene?: () => SceneNode | undefined } = {}): ClipsDocument {
  return new ClipsDocument(md, file, undefined, opts.scene);
}

/** @internal — an attached document (EditorDocument.clipsDoc). */
export function attachClips(md: string, file: string, host: ClipsHost): ClipsDocument {
  return new ClipsDocument(md, file, host);
}
