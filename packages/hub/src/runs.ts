// runs.ts — a run on disk: `~/.trempel/hub/runs/<id>/` holds `meta.json` (what was started, by
// whom it is supervised, the port), `spec.json` (what the supervisor executes), `log.txt` (stdout
// and stderr), `ready.json` (a service answered on its port), `exit.json` (how it ended),
// `stop.json` (someone asked it to stop). Files, not memory: services outlive the hub, and the hub
// (or the CLI) reads their state back.

import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Layer } from './actions.js';
import { readJson, runsDir, writeJson } from './home.js';
import { isAlive, killTree } from './procs.js';

export type RunStatus = 'starting' | 'running' | 'ready' | 'exited' | 'failed' | 'stopped' | 'lost';

export interface RunMeta {
  id: string;
  projectId: string;
  projectRoot: string;
  projectName: string;
  action: string;
  title: string;
  layer: Layer;
  kind: 'once' | 'service';
  group: string;
  input: Record<string, string | number | boolean>;
  /** What runs, for people (the commands after substitution, or the module). */
  command: string;
  cwd: string;
  /** The supervisor: leads the run's process group (`ownGroup`), else shares its parent run's group. */
  pid?: number;
  ownGroup?: boolean;
  procStart?: string | null;
  port?: number;
  url?: string;
  /** The run that started this one (`ctx.run`). */
  parent?: string;
  startedAt: string;
}

export interface RunState extends RunMeta {
  status: RunStatus;
  code: number | null;
  signal: string | null;
  readyAt?: string;
  endedAt?: string;
  /** Seconds since the start (running) or the run's duration (ended). */
  seconds: number;
}

export interface ExitInfo {
  code: number | null;
  signal: string | null;
  at: string;
}

export const runDir = (id: string): string => join(runsDir(), id);
export const logFile = (id: string): string => join(runDir(id), 'log.txt');

let seq = 0;
/** A sortable, unique run id: `20261010-153822-123-ab12`. */
export function newRunId(): string {
  const d = new Date();
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
  const rnd = ((process.pid * 31 + ++seq) % 0xffff).toString(16).padStart(4, '0');
  return `${stamp}-${rnd}${Math.random().toString(16).slice(2, 4)}`;
}

export function writeMeta(meta: RunMeta): void {
  mkdirSync(runDir(meta.id), { recursive: true });
  writeJson(join(runDir(meta.id), 'meta.json'), meta);
}

/** The run's state from its files (and whether its supervisor is still alive). */
export function readRun(id: string): RunState | null {
  const dir = runDir(id);
  const meta = readJson<RunMeta>(join(dir, 'meta.json'));
  if (!meta) return null;
  const exit = readJson<ExitInfo>(join(dir, 'exit.json'));
  const ready = readJson<{ at: string }>(join(dir, 'ready.json'));
  const stop = readJson<{ at: string }>(join(dir, 'stop.json'));
  const started = Date.parse(meta.startedAt);
  let status: RunStatus;
  let endedAt: string | undefined;
  if (exit) {
    endedAt = exit.at;
    status = stop ? 'stopped' : exit.code === 0 ? 'exited' : 'failed';
  } else if (meta.pid === undefined) status = 'starting';
  else if (isAlive(meta.pid, meta.procStart)) status = ready ? 'ready' : 'running';
  else {
    status = stop ? 'stopped' : 'lost';
    endedAt = stop?.at;
  }
  const end = endedAt ? Date.parse(endedAt) : Date.now();
  return {
    ...meta,
    status,
    code: exit?.code ?? null,
    signal: exit?.signal ?? null,
    readyAt: ready?.at,
    endedAt,
    seconds: Math.max(0, Math.round((end - started) / 1000)),
  };
}

export const isActive = (s: RunState): boolean => s.status === 'starting' || s.status === 'running' || s.status === 'ready';

/** All runs, newest first (optionally of one project). */
export function listRuns(filter: { projectId?: string; limit?: number } = {}): RunState[] {
  if (!existsSync(runsDir())) return [];
  const ids = readdirSync(runsDir()).sort().reverse();
  const out: RunState[] = [];
  for (const id of ids) {
    const r = readRun(id);
    if (!r) continue;
    if (filter.projectId && r.projectId !== filter.projectId) continue;
    out.push(r);
    if (filter.limit && out.length >= filter.limit) break;
  }
  return out;
}

/** Services that are up (any project). */
export function activeServices(projectId?: string): RunState[] {
  return listRuns({ projectId }).filter((r) => r.kind === 'service' && isActive(r));
}

/** Keep the newest `keep` finished runs; active ones always stay. */
export function pruneRuns(keep = 300): void {
  if (!existsSync(runsDir())) return;
  const ids = readdirSync(runsDir()).sort().reverse();
  let finished = 0;
  for (const id of ids) {
    const r = readRun(id);
    if (r && isActive(r)) continue;
    if (++finished > keep) rmSync(runDir(id), { recursive: true, force: true });
  }
}

/** Stop a run's process tree. Resolves once it is gone; a run already ended is left as is. */
export async function stopRun(id: string): Promise<RunState | null> {
  const r = readRun(id);
  if (!r) return null;
  if (!isActive(r) || r.pid === undefined) return r;
  writeJson(join(runDir(id), 'stop.json'), { at: new Date().toISOString() });
  await killTree(r.pid, { group: r.ownGroup !== false });
  // the supervisor writes exit.json on SIGTERM; after a SIGKILL nobody does
  if (!existsSync(join(runDir(id), 'exit.json'))) writeJson(join(runDir(id), 'exit.json'), { code: null, signal: 'SIGKILL', at: new Date().toISOString() } satisfies ExitInfo);
  return readRun(id);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Wait until the run ends (or, with `ready`, until a service answers). */
export async function waitRun(id: string, opts: { ready?: boolean; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<RunState> {
  const deadline = opts.timeoutMs ? Date.now() + opts.timeoutMs : Infinity;
  for (;;) {
    const r = readRun(id);
    if (r && (!isActive(r) || (opts.ready && r.status === 'ready'))) return r;
    if (Date.now() > deadline) throw new Error(`E_HUB_TIMEOUT: the run ${id} did not ${opts.ready ? 'answer' : 'end'} in ${Math.round((opts.timeoutMs ?? 0) / 1000)} s.`);
    if (opts.signal?.aborted) throw new Error('E_HUB_ABORTED: aborted.');
    await sleep(100);
  }
}

/**
 * Follow a log: call `onChunk` with what is appended to it. `stop()` reads the rest once and stops.
 */
export function followLog(file: string, onChunk: (text: string) => void, opts: { from?: number; intervalMs?: number } = {}): { stop: () => void; flush: () => void } {
  let pos = opts.from ?? 0;
  const read = (): void => {
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      return;
    }
    if (size <= pos) return;
    const buf = Buffer.alloc(size - pos);
    const fd = openSync(file, 'r');
    try {
      readSync(fd, buf, 0, buf.length, pos);
    } finally {
      closeSync(fd);
    }
    pos = size;
    onChunk(buf.toString('utf8'));
  };
  const t = setInterval(read, opts.intervalMs ?? 100);
  return {
    stop: () => {
      clearInterval(t);
      read();
    },
    flush: read,
  };
}

/** The log's text (the last `maxBytes`). */
export function readLog(id: string, maxBytes = 1 << 20): string {
  try {
    const buf = readFileSync(logFile(id));
    return buf.subarray(Math.max(0, buf.length - maxBytes)).toString('utf8');
  } catch {
    return '';
  }
}
