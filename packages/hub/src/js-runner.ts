// js-runner.ts — a `$js` action: import the module, call its default export with `ctx`. Runs as
// the supervisor's child (so in the run's process group, its output in the run's log).
//
//   ctx.project   { root, name, kit, scene, id }
//   ctx.input     the run's inputs (typed, defaults applied)
//   ctx.port / ctx.url   a service's port and URL
//   ctx.exec(cmd, { cwd, env, check }) → { code, stdout, stderr }   (output also goes to the log;
//                 a non-zero exit throws unless check: false)
//   ctx.log(...)  a line to the log
//   ctx.open(url | path)   the system opener (TREMPEL_HUB_OPEN replaces it)
//   ctx.run(id, input) → the other action's run (a `once` one is waited for; a `service` — until it answers)
//   ctx.actions() → the project's actions shown now
//   ctx.signal    aborted when the run is stopped
//
// The default export may return a number — the exit code.

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { format } from 'node:util';
import { projectActions, startAction, type JsContextData } from './engine.js';
import { readJson } from './home.js';
import { followLog, logFile, readRun, stopRun, waitRun, type RunState } from './runs.js';
import type { ActionContext, ExecResult } from './js-runner-types.js';
import type { RunSpec } from './supervise.js';

const dir = process.argv[2];
const data = readJson<JsContextData>(join(dir, 'ctx.json'));
const spec = readJson<RunSpec>(join(dir, 'spec.json'));
if (!data || !spec?.js) {
  console.error(`E_HUB_RUN: ${dir}: no ctx.json / js module`);
  process.exit(2);
}

const abort = new AbortController();
const children = new Set<string>();
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    abort.abort();
    // services this run started are its own: they stop with it
    void Promise.all([...children].map((id) => stopRun(id))).finally(() => process.exit(130));
  });
}

function exec(cmd: string | string[], opts: { cwd?: string; env?: Record<string, string>; check?: boolean } = {}): Promise<ExecResult> {
  return new Promise((res, rej) => {
    const env = { ...process.env, ...opts.env };
    const cwd = opts.cwd ?? data!.project.root;
    const child = Array.isArray(cmd) ? spawn(cmd[0], cmd.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }) : spawn(cmd, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: true });
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (b: Buffer) => {
      stdout += b;
      process.stdout.write(b);
    });
    child.stderr!.on('data', (b: Buffer) => {
      stderr += b;
      process.stderr.write(b);
    });
    const onAbort = (): void => {
      child.kill('SIGTERM');
    };
    abort.signal.addEventListener('abort', onAbort, { once: true });
    child.once('error', (e) => rej(e));
    child.once('close', (code, signal) => {
      abort.signal.removeEventListener('abort', onAbort);
      const r = { code: code ?? (signal ? 128 : 1), stdout, stderr };
      if (r.code !== 0 && opts.check !== false) {
        const e = new Error(`E_HUB_EXEC: ${Array.isArray(cmd) ? cmd.join(' ') : cmd} — exit ${r.code}`) as Error & ExecResult;
        Object.assign(e, r);
        rej(e);
      } else res(r);
    });
  });
}

async function open(target: string): Promise<void> {
  const custom = process.env.TREMPEL_HUB_OPEN;
  console.log(`[hub] open ${target}`);
  const [cmd, args] = custom
    ? [custom, [target]]
    : process.platform === 'darwin'
      ? ['open', [target]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', target]]
        : ['xdg-open', [target]];
  await new Promise<void>((res) => {
    const c = spawn(cmd, args, { stdio: 'ignore', detached: !custom });
    c.once('error', (e) => {
      console.log(`[hub] W_HUB_OPEN: ${cmd}: ${e.message}`);
      res();
    });
    c.once('spawn', () => {
      if (!custom) c.unref();
      res();
    });
    if (custom) c.once('exit', () => res());
  });
}

async function run(actionId: string, input: Record<string, unknown> = {}): Promise<RunState> {
  const started = await startAction(data!.project.root, actionId, { input, parent: data!.run });
  const r0 = readRun(started.id)!;
  console.log(`[hub] run ${actionId} (${started.id})`);
  if (r0.kind === 'service') {
    children.add(started.id);
    const r = await waitRun(started.id, { ready: r0.port !== undefined, signal: abort.signal });
    console.log(`[hub] ${actionId}: ${r.status}${r.url ? ` ${r.url}` : ''}`);
    return r;
  }
  const tail = followLog(logFile(started.id), (t) => process.stdout.write(t.replace(/^(?=.)/gm, `[${actionId}] `)));
  try {
    const r = await waitRun(started.id, { signal: abort.signal });
    return r;
  } finally {
    tail.stop();
    const r = readRun(started.id);
    if (r) console.log(`[hub] ${actionId}: ${r.status}${r.code !== null ? ` (exit ${r.code})` : ''}`);
  }
}

const ctx: ActionContext = {
  project: data.project,
  input: data.input,
  port: data.port,
  url: data.url,
  services: data.services,
  runId: data.run,
  signal: abort.signal,
  exec,
  log: (...args) => console.log(format(...args)),
  open,
  run,
  actions: async () => {
    const pa = await projectActions(data.project.root);
    return [...pa.actions.values()].filter((a) => pa.visible.has(a.id));
  },
};

try {
  const mod = (await import(pathToFileURL(spec.js).href)) as { default?: unknown };
  if (typeof mod.default !== 'function') throw new Error(`E_HUB_JS: ${spec.js} has no default export function (export default async (ctx) => …).`);
  const res: unknown = await (mod.default as (c: ActionContext) => unknown)(ctx);
  await Promise.all([...children].map((id) => stopRun(id)));
  process.exit(typeof res === 'number' ? res : 0);
} catch (e) {
  console.error(e instanceof Error ? (e.message.startsWith('E_') ? e.message : e.stack ?? e.message) : String(e));
  await Promise.all([...children].map((id) => stopRun(id)));
  process.exit(1);
}
