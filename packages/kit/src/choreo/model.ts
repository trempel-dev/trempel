// model.ts — a choreography as data: md documents (scene format md: `# $seq <id>` blocks with `$title`
// / `$skip` attributes and a table of rows in the body; `# $consts` — the speed-mode constants) →
// sequences of rows + the constants table. Cells are formulas (expr.ts). Loading is strict: unknown
// columns, sync values, duplicate ids, bad formulas — thrown at load, with the place
// (`E_CHOREO_LOAD: <file>:<seq>:<row>: …`).
//
//   # $seq cards.deal
//   $title: The cards fly out one by one
//   $skip: on
//
//   | id  | each        | t        | dur  | target    | action      | value          | ease    | sync  | skip |
//   |-----|-------------|----------|------|-----------|-------------|----------------|---------|-------|------|
//   | fly | k=0..count-1| step * k | 300  | card{k}   | tween:x     | x: 0 → 120 * k | outQuad | await | now  |
//   | pop | k=0..count-1| @fly.end |      | card{k}   | fx:sparkle  |                |         | parallel |   |
//
//   # $consts
//   | name | normal | quick | turbo |
//   |------|--------|-------|-------|
//   | step | 120    | 60    | 0     |
//
// Columns: id, ref (a step of a reference timeline — verify.ts), each (`k=a..b`, `p in list`; `;`
// joins several), when, t (ms from the sequence start; `poll: <cond>` — checked every frame), dur
// (ms, `loop`, empty — instant), target (`{formula}` interpolated), action (`<kind>:<arg>` — clip,
// tween, fx, sound, call, run, wait, or the game's own), value (`p: a → b`, `p → b`, `p += d`,
// `p -= d`, `name = v`; `;` joins), ease, sound, sync (await / parallel / resolve), skip (cut / now / +N).

import { parse as parseMd } from '@trempel/scene/internal/md/index';
import { ease } from '../anim/tweens.js';
import { compile, type Value } from './expr.js';

export type SpeedMode = 'normal' | 'quick' | 'turbo';
export const MODES: SpeedMode[] = ['normal', 'quick', 'turbo'];

export type Sync = 'await' | 'parallel' | 'resolve';

/** One `name op expr` item of a `value` cell: `y += 530`, `alpha: 0 → 1`, `alpha → 0`, `k = k`. */
export interface ValueItem {
  name: string;
  set?: string;
  by?: string;
  from?: string;
  to?: string;
}

export interface EachSpec {
  name: string;
  /** `k=0..5` — inclusive range of formulas. */
  from?: string;
  to?: string;
  /** `p in cells` — a list from the scope. */
  list?: string;
}

/** Row skip rule: '' unaffected; cut / now / +N. */
export type SkipRule = { kind: 'none' } | { kind: 'cut' } | { kind: 'now' } | { kind: 'plus'; ms: number };

export interface Row {
  id: string;
  /** Reference timeline step(s) this row reproduces: `intro#3`, `deal.a#5`, `live:<probe>` (verify.ts). */
  ref: string;
  each: EachSpec[];
  when: string;
  t: string;
  /** Formula, `loop`, or '' (instant). */
  dur: string;
  target: string;
  action: string;
  value: ValueItem[];
  ease: string;
  sound: string;
  sync: Sync;
  skip: SkipRule;
  /** Where (file:seq:row) — for errors. */
  at: string;
}

export interface Sequence {
  id: string;
  title: string;
  /** `off` — skip does not touch this sequence; `on` — row skip rules apply. */
  skip: 'off' | 'on';
  rows: Row[];
  file: string;
}

export interface Choreo {
  sequences: Record<string, Sequence>;
  /** name → per-mode formula source. */
  consts: Record<string, Record<SpeedMode, string>>;
  constRefs: Record<string, string>;
}

export interface LoadOptions {
  /** Ease names a row may use ('' — none); default: the kit's tween eases. */
  eases?: readonly string[];
}

export const COLUMNS = ['id', 'ref', 'each', 'when', 't', 'dur', 'target', 'action', 'value', 'ease', 'sound', 'sync', 'skip'] as const;
const SYNCS: Sync[] = ['await', 'parallel', 'resolve'];

/** The kit's tween eases (anim/tweens.ts) — the default of LoadOptions.eases. */
export const KIT_EASES: readonly string[] = Object.keys(ease);

const fail = (where: string, msg: string): never => {
  throw new Error(`E_CHOREO_LOAD: ${where}: ${msg}`);
};

/** Cells of a GFM table row: `| a | b \| c |` → ['a', 'b | c']. */
function cells(line: string): string[] {
  const s = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (s[i] === '|') {
      out.push(cur.trim());
      cur = '';
    } else cur += s[i];
  }
  out.push(cur.trim());
  return out;
}

const SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/** The first table of a body (prose around it is documentation) → records by header. */
export function tableOf(body: string, where: string): Record<string, string>[] {
  const lines = body.split('\n');
  const start = lines.findIndex((l) => l.trim().startsWith('|'));
  if (start < 0) return [];
  const rows: string[] = [];
  for (let i = start; i < lines.length && lines[i].trim().startsWith('|'); i++) rows.push(lines[i]);
  const names = cells(rows[0]);
  return rows
    .slice(1)
    .filter((l) => !SEPARATOR.test(l))
    .map((l, i) => {
      const cs = cells(l);
      if (cs.length !== names.length) fail(where, `row ${i + 1} has ${cs.length} cells, the header has ${names.length}`);
      const rec: Record<string, string> = {};
      names.forEach((n, j) => (rec[n] = cs[j] ?? ''));
      return rec;
    });
}

const NAME = '([\\w.[\\]{}]+)';
const ARROW = '(?:→|->)';

export function parseValue(src: string, where: string): ValueItem[] {
  if (!src) return [];
  return src.split(';').map((part) => {
    const s = part.trim();
    let m = new RegExp(`^${NAME}\\s*:\\s*(.+?)\\s*${ARROW}\\s*(.+)$`).exec(s);
    if (m) return { name: m[1], from: m[2], to: m[3] };
    m = new RegExp(`^${NAME}\\s*${ARROW}\\s*(.+)$`).exec(s);
    if (m) return { name: m[1], to: m[2] };
    m = new RegExp(`^${NAME}\\s*\\+=\\s*(.+)$`).exec(s);
    if (m) return { name: m[1], by: m[2] };
    m = new RegExp(`^${NAME}\\s*-=\\s*(.+)$`).exec(s);
    if (m) return { name: m[1], by: `-(${m[2]})` };
    m = new RegExp(`^${NAME}\\s*=\\s*(.+)$`).exec(s);
    if (m) return { name: m[1], set: m[2] };
    return fail(where, `value item "${s}" is not "p: a → b", "p → b", "p += d" or "p = v"`);
  });
}

function parseEach(src: string, where: string): EachSpec[] {
  if (!src) return [];
  return src.split(';').map((part) => {
    const s = part.trim();
    let m = /^(\w+)\s*=\s*(.+?)\s*\.\.\s*(.+)$/.exec(s);
    if (m) return { name: m[1], from: m[2], to: m[3] };
    m = /^(\w+)\s+in\s+(.+)$/.exec(s);
    if (m) return { name: m[1], list: m[2] };
    return fail(where, `each "${s}" is not "k=a..b" or "p in list"`);
  });
}

function parseSkip(src: string, where: string): SkipRule {
  if (!src) return { kind: 'none' };
  if (src === 'cut') return { kind: 'cut' };
  if (src === 'now') return { kind: 'now' };
  const m = /^\+\s*([\d.]+)$/.exec(src);
  if (m) return { kind: 'plus', ms: Number(m[1]) };
  return fail(where, `skip "${src}" is not cut, now or +N`);
}

/** Formulas inside `{…}` of target/action/value names (rendered per instance). */
export function interpolations(s: string): string[] {
  const out: string[] = [];
  const re = /\{([^}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1]);
  return out;
}

function checkFormula(src: string, where: string, what: string): void {
  if (!src) return;
  try {
    compile(src);
  } catch (e) {
    fail(where, `${what} "${src}": ${(e as Error).message}`);
  }
}

/** Load choreography documents (file name → md text). @throws E_CHOREO_LOAD */
export function loadChoreo(files: Record<string, string>, opts: LoadOptions = {}): Choreo {
  const eases = new Set(['', ...(opts.eases ?? KIT_EASES)]);
  const sequences: Record<string, Sequence> = {};
  const consts: Choreo['consts'] = {};
  const constRefs: Record<string, string> = {};
  for (const [file, text] of Object.entries(files)) {
    let doc;
    try {
      doc = parseMd(text);
    } catch (e) {
      return fail(file, (e as Error).message);
    }
    const blocks = doc.root.children.flatMap(function all(b): typeof doc.root.children {
      return [b, ...b.children.flatMap(all)];
    });
    for (const b of blocks) {
      const body = typeof b.body === 'string' ? b.body : (b.body?.raw ?? '');
      const where = `${file}:${b.name}${b.id ? ` ${b.id}` : ''}`;
      const attr = (k: string): Value => b.attrs.find((a) => a.key.join('.') === k)?.value as Value;
      if (b.name === 'consts') {
        for (const r of tableOf(body, where)) {
          if (!r.name) fail(where, 'a const without a name');
          if (r.name in consts) fail(where, `const "${r.name}" defined twice`);
          const normal = r.normal;
          if (normal === undefined || normal === '') fail(where, `const "${r.name}" has no normal value`);
          consts[r.name] = { normal, quick: r.quick || normal, turbo: r.turbo || normal };
          for (const m of MODES) checkFormula(consts[r.name][m], where, `const ${r.name}.${m}`);
          constRefs[r.name] = r.ref ?? '';
        }
        continue;
      }
      if (b.name !== 'seq') continue; // other blocks are documentation
      const id = b.id;
      if (!id) fail(where, '$seq without an id');
      if (sequences[id!]) fail(where, `sequence ${id} defined twice (also in ${sequences[id!].file})`);
      const skip = String(attr('skip') ?? 'off');
      if (skip !== 'off' && skip !== 'on') fail(where, '$skip must be on or off');
      const recs = tableOf(body, where);
      const ids = new Set<string>();
      const rows: Row[] = recs.map((r, i) => {
        const at = `${file}:${id}:${r.id || `#${i + 1}`}`;
        for (const k of Object.keys(r)) if (!(COLUMNS as readonly string[]).includes(k)) fail(at, `unknown column "${k}" (known: ${COLUMNS.join(', ')})`);
        for (const k of ['id', 't', 'action', 'sync']) if (!r[k]) fail(at, `column "${k}" is empty`);
        if (ids.has(r.id)) fail(at, `row id "${r.id}" repeats`);
        ids.add(r.id);
        if (!SYNCS.includes(r.sync as Sync)) fail(at, `sync "${r.sync}" (known: ${SYNCS.join(', ')})`);
        if (!eases.has(r.ease ?? '')) fail(at, `ease "${r.ease}" (known: ${[...eases].filter(Boolean).join(', ')})`);
        const row: Row = {
          id: r.id,
          ref: r.ref ?? '',
          each: parseEach(r.each ?? '', at),
          when: r.when ?? '',
          t: r.t,
          dur: r.dur ?? '',
          target: r.target ?? '',
          action: r.action,
          value: parseValue(r.value ?? '', at),
          ease: r.ease ?? '',
          sound: r.sound ?? '',
          sync: r.sync as Sync,
          skip: parseSkip(r.skip ?? '', at),
          at,
        };
        checkFormula(row.t.startsWith('poll:') ? row.t.slice(5) : row.t, at, 't');
        checkFormula(row.when, at, 'when');
        if (row.dur && row.dur !== 'loop') checkFormula(row.dur, at, 'dur');
        for (const e of row.each) for (const f of [e.from, e.to, e.list]) if (f) checkFormula(f, at, 'each');
        for (const v of row.value) for (const f of [v.set, v.by, v.from, v.to]) if (f) checkFormula(f, at, `value ${v.name}`);
        for (const s of [row.target, row.action, row.sound, ...row.value.map((v) => v.name)]) for (const f of interpolations(s)) checkFormula(f, at, 'interpolation');
        return row;
      });
      sequences[id!] = { id: id!, title: String(attr('title') ?? ''), skip: skip as 'on' | 'off', rows, file };
    }
  }
  // run:<seq> targets exist
  for (const s of Object.values(sequences))
    for (const r of s.rows) {
      const m = /^run:(.+)$/.exec(r.action);
      if (m && !sequences[m[1]]) fail(r.at, `run of an unknown sequence "${m[1]}"`);
    }
  return { sequences, consts, constRefs };
}
