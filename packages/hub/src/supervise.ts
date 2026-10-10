// supervise.ts — the process that leads a run (started detached: its own process group, stdout and
// stderr into the run's log). Runs the action's commands in order (or its js module through
// js-runner), notes when a service answers on its port, writes how the run ended. Stopping a run
// signals this group — the supervisor writes `exit.json` once its children are gone.
//
//   node dist/supervise.js <run folder>

import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson } from './home.js';
import { portOpen } from './procs.js';
import type { ExitInfo } from './runs.js';

export interface RunSpec {
  shell?: string[];
  js?: string;
  cwd: string;
  env: Record<string, string>;
  ready?: { port: number; url: string; timeoutMs: number };
}

const dir = process.argv[2];
if (!dir) {
  console.error('E_CLI: usage: supervise.js <run folder>');
  process.exit(2);
}
const spec = readJson<RunSpec>(join(dir, 'spec.json'));
if (!spec) {
  console.error(`E_HUB_RUN: ${dir}: no spec.json`);
  process.exit(2);
}

let child: ChildProcess | null = null;
let stopping: NodeJS.Signals | null = null;
let ended = false;

function finish(code: number | null, signal: string | null): never {
  if (!ended) {
    ended = true;
    writeJson(join(dir, 'exit.json'), { code, signal, at: new Date().toISOString() } satisfies ExitInfo);
  }
  process.exit(code ?? 1);
}

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    stopping = sig;
    if (!child) finish(null, sig);
    // the group got the signal too; give the children time to go, then leave anyway
    setTimeout(() => finish(null, sig), 15_000).unref();
  });
}
process.on('SIGHUP', () => {});

function runOne(cmd: string | null): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((res) => {
    const env = { ...process.env, ...spec!.env };
    child = cmd === null
      ? spawn(process.execPath, [fileURLToPath(new URL('./js-runner.js', import.meta.url)), dir], { cwd: spec!.cwd, env, stdio: 'inherit' })
      : spawn(cmd, { cwd: spec!.cwd, env, stdio: 'inherit', shell: true });
    child.once('error', (e) => {
      console.error(`E_HUB_RUN: ${e.message}`);
      res({ code: 127, signal: null });
    });
    child.once('exit', (code, signal) => res({ code, signal }));
  });
}

async function watchReady(r: NonNullable<RunSpec['ready']>): Promise<void> {
  const deadline = Date.now() + r.timeoutMs;
  while (!ended && Date.now() < deadline) {
    if (await portOpen(r.port)) {
      writeJson(join(dir, 'ready.json'), { at: new Date().toISOString(), url: r.url });
      console.log(`[hub] ready: ${r.url}`);
      return;
    }
    await new Promise((s) => setTimeout(s, 250));
  }
  if (!ended) console.log(`[hub] W_HUB_NOT_READY: nothing answers on port ${r.port} after ${Math.round(r.timeoutMs / 1000)} s.`);
}

const steps: (string | null)[] = spec.js ? [null] : spec.shell ?? [];
if (spec.ready) void watchReady(spec.ready);
let last: { code: number | null; signal: NodeJS.Signals | null } = { code: 0, signal: null };
for (const cmd of steps) {
  if (stopping) break;
  if (cmd !== null && steps.length > 1) console.log(`$ ${cmd}`);
  last = await runOne(cmd);
  child = null;
  if (last.code !== 0) break;
}
if (stopping) finish(null, stopping);
finish(last.code ?? (last.signal ? 128 : 1), last.signal);
