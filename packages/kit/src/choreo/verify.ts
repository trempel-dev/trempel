// verify.ts — acceptance: the choreography log against a reference timeline (timeline.json: the
// sequences of the original measured step by step).
//
// Every log event of a row with `ref` is matched to that timeline step; the expected time is the
// step's `t` (a number, a per-mode object, or a formula string evaluated in the scenario), measured
// from the start of the timeline's sequence — found in the event's chain of nested runs (innermost
// run whose id is the sequence or starts with it: `deal#…` → the `deal.card` run). Tolerance: ±1 frame
// for tweens / clips / effects (the original's frame loop), 1e-3 ms for timers and events (the
// timeline rounds to 4 decimals). Durations are checked the same way. Strings that do not evaluate
// are findings unless the caller lists them as order-only with a reason — nothing passes silently.
//
// Second reference — a live recording (probes: intervals between two events of the original,
// measured live, median of many). `verifyLive` takes the client's interval for each probe (measured
// from the log by the caller, split into the chain of awaited steps) and compares it with the live
// median through the original runtime's tick model (60 Hz): every awaited step ends on a tick (Σ ceil
// per step, not ceil of the sum), a duration closer than 2 ms to a tick boundary slips to the next
// tick, plus the probe's extra ticks (a step started from an animation event callback, a state
// change) and counter quanta. The client itself does not quantize (logical time) — the model lives
// here, not in the data. Live wins: a row that carries a `live:<probe>` ref is checked against the
// live probe, its timeline refs are only covered (superseded); the timeline stays the reference for
// everything the live recording has not measured.

import type { ChoreoEvent } from './director.js';
import { evaluate, type Scope, type Value } from './expr.js';
import type { SpeedMode } from './model.js';

export interface TimelineStep {
  t: unknown;
  dur: unknown;
  target?: string | null;
  action?: string;
  ease?: string | null;
  sync?: string;
  src?: string;
}

export interface TimelineSeq {
  title?: string;
  steps?: TimelineStep[];
  substeps?: Record<string, TimelineStep[]>;
  loops?: Record<string, unknown>[];
  [k: string]: unknown;
}

export interface TimelineDoc {
  meta: Record<string, unknown>;
  sequences: Record<string, TimelineSeq>;
}

export interface VerifyOptions {
  timeline: TimelineDoc;
  log: ChoreoEvent[];
  mode: SpeedMode;
  /** Scenario names for timeline formula strings (start times, counts, scales…) — fixed, or per event. */
  vars?: Record<string, Value> | ((ev: ChoreoEvent) => Record<string, Value>);
  /** Timeline string → formula of this module's language; may use `t_<ref>` / `d_<ref>` (expected t / dur of another step, same instance vars: `t_intro_7`, `d_deal_a_2`). */
  aliases?: Record<string, string>;
  /** Refs whose time is checked by order only — with the reason (strings like `{after: …}` are order-only by themselves). */
  orderOnly?: Record<string, string>;
  /** Absolute start (ms) of a timeline sequence when it is not in the event chain (a step started by a click is a run of its own). */
  bases?: Record<string, number>;
  /** Check only refs of these timeline sequences (top-level ids: intro, deal…). */
  sequences?: string[];
  /** Timeline steps of the checked sequences that this scenario does not play — with the reason. */
  notPlayed?: Record<string, string>;
  frame?: number;
  /**
   * A timeline value given per variant (an object of keys) other than the speed modes → the value
   * for this instance (`{ landscape: 1, portrait: 2 }` → by a scenario var); undefined — not a variant.
   */
  variant?: (value: Record<string, unknown>, vars: Record<string, Value>) => unknown;
  /** Action prefixes timed by frames (±1 frame); default FRAME_KINDS. */
  frameKinds?: string[];
}

/** Actions that run on the original's frames — checked within a frame (timers and events — exactly). */
export const FRAME_KINDS = ['tween', 'clip', 'fx', 'spine', 'emitter'];

export interface Finding {
  ref: string;
  row: string;
  seq: string;
  vars: Record<string, Value>;
  what: 'time' | 'dur' | 'unevaluable' | 'no-base' | 'unknown-ref' | 'frame-lag' | 'missing' | 'order';
  expected?: number;
  got?: number;
  note?: string;
}

export interface VerifyResult {
  ok: boolean;
  /** Time comparisons made. */
  checked: number;
  findings: Finding[];
  /** Refs matched by at least one event. */
  covered: string[];
  /** Order-only refs met (time not compared) — with the reason. */
  orderOnly: Record<string, string>;
  /** Durations not compared (strings outside the scenario) — ref → timeline text. */
  durUnchecked: Record<string, string>;
  /** Timeline refs not compared because their row follows the live recording — ref → live refs of the row. */
  superseded: Record<string, string>;
}

const MODES = ['normal', 'quick', 'turbo'];

interface Located {
  top: string;
  key: string;
  step: TimelineStep;
}

/** `intro#3`, `deal.a#5`, `outro#loops[0]`, `deal:order` → the timeline step (or null for non-step refs). */
export function locate(tl: TimelineDoc, ref: string): Located | null | undefined {
  const m = /^([^#:]+)#(\d+)$/.exec(ref);
  if (!m) return ref.includes(':') || /#loops\[\d+\]$/.test(ref) ? null : undefined;
  const [, key, idx] = m;
  const i = Number(idx);
  const top = tl.sequences[key];
  if (top?.steps) return top.steps[i] ? { top: key, key, step: top.steps[i] } : undefined;
  for (const [tk, s] of Object.entries(tl.sequences)) {
    if (!s.substeps) continue;
    const sk = Object.keys(s.substeps).find((k) => k === key || k.startsWith(`${key} `));
    if (sk) return s.substeps[sk][i] ? { top: tk, key, step: s.substeps[sk][i] } : undefined;
  }
  return undefined;
}

const refName = (ref: string) => ref.replace('#', '_').replace(/\./g, '_');

function pickMode(v: unknown, mode: SpeedMode, vars: Record<string, Value>, variant?: VerifyOptions['variant']): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if (MODES.some((m) => m in o)) return o[mode];
    const picked = variant?.(o, vars);
    if (picked !== undefined) return picked;
  }
  return v;
}

export function verifyLog(o: VerifyOptions): VerifyResult {
  const frame = o.frame ?? 1000 / 60;
  const findings: Finding[] = [];
  const covered = new Set<string>();
  const orderOnlyMet: Record<string, string> = {};
  const durUnchecked: Record<string, string> = {};
  const superseded: Record<string, string> = {};
  let checked = 0;
  const varsOf = (ev: ChoreoEvent): Record<string, Value> => (typeof o.vars === 'function' ? o.vars(ev) : (o.vars ?? {}));
  const aliases = o.aliases ?? {};

  /** Evaluate a timeline value (t or dur) for an instance. `null` = not computable. */
  const value = (raw: unknown, ev: ChoreoEvent, depth = 0): number | 'loop' | 'order' | null => {
    const vars = varsOf(ev);
    const v = pickMode(raw, ev.mode ?? o.mode, { ...vars, ...ev.vars }, o.variant);
    if (typeof v === 'number') return v;
    if (v === null || v === undefined) return 0;
    if (typeof v === 'object' && v && 'after' in (v as object)) return 'order';
    if (typeof v !== 'string') return null;
    if (v === 'loop' || v.startsWith('until:')) return 'loop';
    let src = aliases[v] ?? v;
    if (!(v in aliases)) {
      src = src.replace(/,\s*\w+\s*=\s*[\d.]+\s*\.\.\s*[\d.]+\s*$/, ''); // "50*(k+1), k=0..5"
      const eq = /^[^=<>!]*[^=<>!]=(?!=)(.*)$/.exec(src); // "d_i = [..][i]"
      if (eq) src = eq[1];
    }
    const scope: Scope = (name) => {
      if (name in ev.vars) return ev.vars[name];
      if (name in vars) return vars[name];
      const r = /^([td])_(.+)_(\d+)$/.exec(name);
      if (r && depth < 4) {
        const ref = `${r[2].replace(/_/g, '.')}#${r[3]}`;
        const loc = locate(o.timeline, ref);
        if (!loc) throw new Error(`no timeline step ${ref}`);
        const x = value(r[1] === 't' ? loc.step.t : loc.step.dur, ev, depth + 1);
        if (typeof x !== 'number') throw new Error(`${ref} is not a number`);
        return x;
      }
      throw new Error(`unknown name "${name}"`);
    };
    try {
      const x = evaluate(src, scope);
      return typeof x === 'number' ? x : null;
    } catch {
      return null;
    }
  };

  let lastT = -Infinity;
  for (const ev of o.log) {
    if (ev.t < lastT - 1e-6) findings.push({ ref: ev.ref, row: ev.row, seq: ev.seq, vars: ev.vars, what: 'order', expected: lastT, got: ev.t, note: 'log goes back in time' });
    lastT = Math.max(lastT, ev.t);
    if (ev.at - ev.t < -1e-6 || ev.at - ev.t > frame + 1e-6) findings.push({ ref: ev.ref, row: ev.row, seq: ev.seq, vars: ev.vars, what: 'frame-lag', expected: ev.t, got: ev.at });
    if (!ev.ref) continue;
    const refs = ev.ref.split(',').map((s) => s.trim());
    const live = refs.filter(isLiveRef);
    for (const ref of refs) {
      if (isLiveRef(ref)) continue;
      const loc = locate(o.timeline, ref);
      if (loc === undefined) {
        findings.push({ ref, row: ev.row, seq: ev.seq, vars: ev.vars, what: 'unknown-ref' });
        continue;
      }
      const top = ref.split(/[#:]/)[0].split('.')[0];
      if (o.sequences && !o.sequences.includes(top)) continue;
      // a row with several refs reproduces each only inside that sequence (a shared row: its ref of another sequence only in that one)
      const key0 = loc ? loc.key : top;
      const inChain = ev.chain.some((c) => c.seq === key0 || c.seq.startsWith(`${key0}.`) || c.seq === top || c.seq.startsWith(`${top}.`));
      if (!inChain && !(o.bases && (key0 in o.bases || top in o.bases))) continue;
      covered.add(ref);
      if (loc === null) continue; // orders / loops: bespoke checks
      if (live.length) {
        superseded[ref] = live.join(', ');
        continue;
      }
      const seqKey = loc.key;
      const s = loc.step;
      const framed = new RegExp(`^(${(o.frameKinds ?? FRAME_KINDS).join('|')})`);
      const tween = !!s.ease || framed.test(String(s.action ?? '')) || framed.test(ev.action);
      const tol = tween ? frame : 1e-3;
      const exp = value(s.t, ev);
      if (exp === 'order' || ref in (o.orderOnly ?? {})) orderOnlyMet[ref] = o.orderOnly?.[ref] ?? `timeline t ${JSON.stringify(s.t)}`;
      else if (exp === null || exp === 'loop') findings.push({ ref, row: ev.row, seq: ev.seq, vars: ev.vars, what: 'unevaluable', note: `t ${JSON.stringify(s.t)}` });
      else {
        const base = o.bases?.[seqKey] ?? o.bases?.[top] ?? [...ev.chain].reverse().find((c) => c.seq === seqKey || c.seq.startsWith(`${seqKey}.`))?.start;
        if (base === undefined) {
          findings.push({ ref, row: ev.row, seq: ev.seq, vars: ev.vars, what: 'no-base', note: `no run of ${seqKey} in ${ev.chain.map((c) => c.seq).join(' > ')}` });
          continue;
        }
        checked++;
        const got = ev.t - base;
        if (Math.abs(got - exp) > tol) findings.push({ ref, row: ev.row, seq: ev.seq, vars: ev.vars, what: 'time', expected: exp, got });
      }
      if (ev.dur === 0) continue; // instant marker rows share a step's moment, not its duration
      const d = value(s.dur, ev);
      if (d === 'loop') {
        if (ev.dur !== Infinity) findings.push({ ref, row: ev.row, seq: ev.seq, vars: ev.vars, what: 'dur', note: `timeline loops, got ${ev.dur}` });
      } else if (d === null || d === 'order') durUnchecked[ref] = JSON.stringify(s.dur);
      else if (d !== 0 && Math.abs(ev.dur - d) > tol) findings.push({ ref, row: ev.row, seq: ev.seq, vars: ev.vars, what: 'dur', expected: d, got: ev.dur });
    }
  }

  // coverage: every step of the checked sequences is played, or the scenario says why not
  if (o.sequences) {
    for (const top of o.sequences) {
      const s = o.timeline.sequences[top];
      if (!s) continue;
      const lists: [string, TimelineStep[]][] = s.steps ? [[top, s.steps]] : Object.entries(s.substeps ?? {}).map(([k, v]) => [k.split(' ')[0], v]);
      for (const [key, steps] of lists)
        steps.forEach((_, i) => {
          const ref = `${key}#${i}`;
          if (!covered.has(ref) && !(ref in (o.notPlayed ?? {}))) findings.push({ ref, row: '', seq: key, vars: {}, what: 'missing' });
        });
    }
  }
  return { ok: findings.length === 0, checked, findings, covered: [...covered].sort(), orderOnly: orderOnlyMet, durUnchecked, superseded };
}

// ── the live reference ───────────────────────────────────────────────────────

/** `live:<probe>` — a row ref to a probe of the live recording. */
export const isLiveRef = (ref: string): boolean => ref.startsWith('live:');

export interface LiveStats {
  median: number | null;
  min: number | null;
  max: number | null;
  n: number;
  nClean: number;
}

/** A probe of a live recording, as is. */
export interface LiveProbe {
  id: string;
  seq: string;
  /** Path in timeline.json (free text). */
  ref: string;
  what: string;
  mode?: string | null;
  /** The static number (of the timeline) — the fallback when the live recording has no samples. */
  expected: number | string | null;
  live: LiveStats;
  grid?: number | string | null;
  note?: string | null;
  [k: string]: unknown;
}

export interface LiveDoc {
  meta: Record<string, unknown>;
  probes: LiveProbe[];
  [k: string]: unknown;
}

/** One client interval: logical ms from the log, and the chain of awaited steps it is made of (sum = d). */
export interface LiveSample {
  d: number;
  parts?: number[];
}

/** The client's side of a probe: samples from the log + what the original runtime adds on top of the chain. */
export interface LiveMeasure {
  samples: LiveSample[];
  /** Extra ticks of the original runtime: a step started from an animation event callback (`cb`), a state change… */
  extraTicks?: number;
  /** Counter quantum (setFPS): 1000/15, 40… */
  quant?: number;
  /** The extra ticks come from an animation event callback (reported separately). */
  cb?: boolean;
  /** Where the samples come from (fixture, mode). */
  from?: string;
  note?: string;
  /** A discrepancy left on purpose — with the reason (not a finding). */
  accept?: string;
}

export type LiveMapping = Record<string, LiveMeasure | { na: string }>;

export interface LiveRow {
  id: string;
  seq: string;
  what: string;
  mode: string | null;
  /** Client: median interval of the samples (logical ms). */
  client: number | null;
  /** Chain of the median sample. */
  parts: number[];
  /** The original runtime's grid of the client's chain. */
  lo: number | null;
  hi: number | null;
  live: number | null;
  n: number;
  /** live − client. */
  delta: number | null;
  verdict: 'ok' | 'grid' | 'static' | 'na' | 'accepted' | 'off';
  note: string;
  measure?: LiveMeasure;
  probe: LiveProbe;
}

export interface LiveFinding {
  id: string;
  what: 'unmapped' | 'no-samples' | 'off-grid' | 'static' | 'unknown-probe';
  expected?: number;
  got?: number;
  note?: string;
}

/** Ticks of the original runtime for one awaited step: [earliest, latest] (the latest slips when closer than `margin` to a boundary). */
export function stepTicks(d: number, frame = 1000 / 60, margin = 2): [number, number] {
  if (d <= 1e-9) return [0, 0];
  return [Math.ceil(d / frame - 1e-6), Math.floor((d + margin) / frame) + 1];
}

/** The grid of a chain of awaited steps on the original runtime: [Σ earliest, Σ latest + extra ticks + quantum] ms. */
export function tickGrid(parts: number[], o: { extraTicks?: number; quant?: number; frame?: number; margin?: number } = {}): { lo: number; hi: number } {
  const frame = o.frame ?? 1000 / 60;
  let lo = 0;
  let hi = 0;
  for (const p of parts) {
    const [a, b] = stepTicks(p, frame, o.margin);
    lo += a;
    hi += b;
  }
  return { lo: lo * frame, hi: (hi + (o.extraTicks ?? 0)) * frame + (o.quant ?? 0) };
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Client ↔ live: every probe of the live recording must be measured on the client (or marked not
 * applicable with the reason). Verdict: |live − client| ≤ 1 frame → ok; else the live median within
 * the original's grid of the client's chain ±1 frame → ok on the grid; else a finding (unless accepted).
 * A probe without live samples falls back to its static number (±1 frame).
 */
export function verifyLive(o: { live: LiveDoc; extra?: LiveProbe[]; measures: LiveMapping; frame?: number }): { ok: boolean; rows: LiveRow[]; findings: LiveFinding[] } {
  const frame = o.frame ?? 1000 / 60;
  const probes = [...o.live.probes, ...(o.extra ?? [])];
  const known = new Set(probes.map((p) => p.id));
  const rows: LiveRow[] = [];
  const findings: LiveFinding[] = [];
  for (const id of Object.keys(o.measures)) if (!known.has(id)) findings.push({ id, what: 'unknown-probe' });
  for (const p of probes) {
    const m = o.measures[p.id];
    const base = { id: p.id, seq: p.seq, what: p.what, mode: p.mode ?? null, live: p.live?.median ?? null, n: p.live?.n ?? 0, probe: p };
    if (!m) {
      findings.push({ id: p.id, what: 'unmapped' });
      continue;
    }
    if ('na' in m) {
      rows.push({ ...base, client: null, parts: [], lo: null, hi: null, delta: null, verdict: 'na', note: m.na });
      continue;
    }
    if (!m.samples.length) {
      findings.push({ id: p.id, what: 'no-samples', note: m.from });
      continue;
    }
    const client = median(m.samples.map((s) => s.d));
    const at = m.samples.find((s) => Math.abs(s.d - client) < 1e-6) ?? m.samples[0];
    const parts = at.parts ?? [at.d];
    const { lo, hi } = tickGrid(parts, { extraTicks: m.extraTicks, quant: m.quant, frame });
    const row: LiveRow = { ...base, client, parts, lo, hi, delta: null, verdict: 'ok', note: m.note ?? '', measure: m };
    const live = base.live;
    if (live === null) {
      const exp = typeof p.expected === 'number' ? p.expected : null;
      row.verdict = 'static';
      if (exp === null || Math.abs(client - exp) > frame + 1e-6) {
        if (m.accept) row.verdict = 'accepted';
        else findings.push({ id: p.id, what: 'static', expected: exp ?? undefined, got: client, note: 'no live samples, static fallback' });
      }
    } else {
      row.delta = live - client;
      if (Math.abs(row.delta) <= frame + 1e-6) row.verdict = 'ok';
      else if (live >= lo - frame - 1e-6 && live <= hi + frame + 1e-6) row.verdict = 'grid';
      else if (m.accept) row.verdict = 'accepted';
      else {
        row.verdict = 'off';
        findings.push({ id: p.id, what: 'off-grid', expected: live, got: client, note: `grid ${lo.toFixed(1)}…${hi.toFixed(1)} (${m.from ?? ''})` });
      }
    }
    if (m.accept && row.verdict !== 'accepted') row.note = [row.note, `(accept not needed: ${m.accept})`].filter(Boolean).join(' ');
    rows.push(row);
  }
  return { ok: findings.length === 0, rows, findings };
}

/** Findings as text lines (test failure messages, reports). */
export function formatFindings(fs: Finding[]): string {
  return fs
    .map((f) => {
      const v = Object.entries(f.vars)
        .filter(([k]) => !k.endsWith('_index'))
        .map(([k, x]) => `${k}=${typeof x === 'object' ? JSON.stringify(x) : String(x)}`)
        .join(' ');
      return `${f.what} ${f.ref} ${f.seq}:${f.row} ${v}${f.expected !== undefined ? ` expected ${f.expected.toFixed(4)}` : ''}${f.got !== undefined ? ` got ${f.got.toFixed(4)}` : ''}${f.note ? ` — ${f.note}` : ''}`;
    })
    .join('\n');
}

export { refName };
