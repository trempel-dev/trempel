#!/usr/bin/env node
// cli.ts — `trempel`: the hub page and the same actions without it.
//
//   trempel hub [--port 5170] [--host 127.0.0.1] [--no-open] [--root <dir>]…   the hub page
//   trempel run <action> [--project <dir>] [--input k=v]… [--detach] [--yes] [--force]
//   trempel run --list [--project <dir>] [--json]       actions by layer (what wins, what is off)
//   trempel ps [--json]                                  running services of every project
//   trempel stop <run id | action> [--project <dir>]     stop a run's process tree
//   trempel log <run id> [--follow]
//   trempel projects [--json]                            projects under the roots + added ones
//   trempel add <dir> | trempel remove <dir>             a project by hand
//   trempel roots [<dir>…]                               show / set the roots to scan
//   trempel new <template> <dir> [--name n] [--install]  a project from a template (git init + commit)
//   trempel templates
//
// `--project` defaults to the nearest project from the current folder up. Exit code of `run` — the
// action's; 2 — a usage problem; 3 — already running.

import { createInterface } from 'node:readline/promises';
import { dirname, resolve } from 'node:path';
import type { Action } from './actions.js';
import { LAYERS } from './actions.js';
import { HubError, projectActions, startAction } from './engine.js';
import { loadConfig, saveConfig } from './home.js';
import { describeProject, gitState, isProject, scanProjects } from './project.js';
import { activeServices, followLog, isActive, listRuns, logFile, readLog, readRun, stopRun, waitRun } from './runs.js';
import { createProject, listTemplates } from './templates.js';

interface Args {
  _: string[];
  flags: Record<string, string | true>;
  inputs: Record<string, string>;
  roots: string[];
}

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {}, inputs: {}, roots: [] };
  const BOOL = new Set(['list', 'json', 'detach', 'yes', 'force', 'follow', 'no-open', 'install', 'help']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') out.flags.help = true;
    else if (a === '-y') out.flags.yes = true;
    else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
      const val = eq > 0 ? a.slice(eq + 1) : BOOL.has(key) ? true : argv[++i];
      if (val === undefined) throw new HubError(`E_CLI: --${key} needs a value.`, 2);
      if (key === 'input' || key === 'i') {
        const s = String(val);
        const k = s.indexOf('=');
        if (k < 1) throw new HubError(`E_CLI: --input k=v, not "${s}".`, 2);
        out.inputs[s.slice(0, k)] = s.slice(k + 1);
      } else if (key === 'root') out.roots.push(String(val));
      else out.flags[key] = val;
    } else out._.push(a);
  }
  return out;
}

const USAGE = `usage:
  trempel hub [--port 5170] [--no-open] [--root <dir>]…
  trempel run <action> [--project <dir>] [--input k=v]… [--detach] [--yes] [--force]
  trempel run --list [--project <dir>] [--json]
  trempel ps | stop <run|action> | log <run> [--follow]
  trempel projects | add <dir> | remove <dir> | roots [<dir>…]
  trempel new <template> <dir> [--name n] [--install] | templates`;

function projectRoot(flag: string | true | undefined): string {
  if (typeof flag === 'string') {
    const d = resolve(flag);
    if (!isProject(d)) throw new HubError(`E_HUB_PROJECT: ${d} is not a Trempel project (no @trempel/kit or @trempel/scene dependency, no .trempel/project.mdz).`, 2);
    return d;
  }
  for (let d = process.cwd(); ; d = dirname(d)) {
    if (isProject(d)) return d;
    if (dirname(d) === d) throw new HubError('E_HUB_PROJECT: no project here (from the current folder up) — --project <dir>.', 2);
  }
}

const pad = (s: string, n: number): string => (s.length >= n ? s + ' ' : s + ' '.repeat(n - s.length));

async function list(args: Args): Promise<number> {
  const pa = await projectActions(projectRoot(args.flags.project));
  if (args.flags.json) {
    console.log(
      JSON.stringify(
        {
          project: pa.project,
          layers: pa.sources,
          actions: pa.all.map((a) => ({ ...a, wins: pa.actions.get(a.id) === a, shown: pa.actions.get(a.id) === a && pa.visible.has(a.id) })),
          errors: pa.errors,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  console.log(`${pa.project.name}  ${pa.project.root}`);
  console.log(`kit ${pa.project.kit ?? '—'}  scene ${pa.project.scene ?? '—'}`);
  for (const layer of LAYERS) {
    const own = pa.all.filter((a) => a.layer === layer);
    const src = pa.sources.filter((s) => s.layer === layer);
    if (!src.length) continue;
    console.log(`\n${layer}  ${src.map((s) => s.file + (s.legacy ? ' (the kit has no hub/actions.mdz — npm scripts)' : '')).join(', ')}`);
    if (!own.length) console.log('  (none)');
    for (const a of own) {
      const winner = pa.actions.get(a.id)!;
      const notes: string[] = [];
      if (a.kind === 'service') notes.push('service');
      if (winner !== a) notes.push(`overridden by ${winner.layer}`);
      else if (!pa.visible.has(a.id)) notes.push(`off: ${a.when.join(', ')}`);
      if (pa.running.has(a.id) && winner === a) notes.push(`running ${pa.running.get(a.id)!.url ?? ''}`.trim());
      console.log(`  ${pad(a.id, 18)}${pad(a.title, 34)}${pad(a.group, 10)}${notes.length ? `[${notes.join('; ')}]` : ''}`);
    }
  }
  for (const e of pa.errors) console.log(`\n${e}`);
  return 0;
}

async function ask(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(q);
  } finally {
    rl.close();
  }
}

async function run(args: Args): Promise<number> {
  if (args.flags.list) return list(args);
  const id = args._[1];
  if (!id) throw new HubError(`E_CLI: trempel run <action> — or --list.\n${USAGE}`, 2);
  const root = projectRoot(args.flags.project);
  const pa = await projectActions(root);
  const action: Action | undefined = pa.actions.get(id);
  if (!action) throw new HubError(`E_HUB_NO_ACTION: ${pa.project.name} has no action "${id}" (${[...pa.actions.keys()].join(', ')}).`, 2);
  const input: Record<string, string> = { ...args.inputs };
  const tty = process.stdin.isTTY && process.stdout.isTTY;
  for (const inp of action.inputs) {
    if (input[inp.name] !== undefined || inp.default !== undefined || !inp.required) continue;
    if (!tty) continue; // checkInputs names it
    input[inp.name] = await ask(`${inp.label ?? inp.name}${inp.options ? ` (${inp.options.join('/')})` : ''}: `);
  }
  if (action.confirm && !args.flags.yes) {
    if (!tty) throw new HubError(`E_HUB_CONFIRM: "${id}" asks to confirm: ${action.confirm} — run with --yes.`, 2);
    const a = (await ask(`${action.confirm} — run "${action.title}"? [y/N] `)).trim().toLowerCase();
    if (a !== 'y' && a !== 'yes') return 1;
  }
  const started = await startAction(pa.project, id, { input, force: !!args.flags.force });
  if (args.flags.detach) {
    if (started.kind === 'service' && started.port !== undefined) {
      const r = await waitRun(started.id, { ready: true, timeoutMs: 120_000 });
      if (r.status !== 'ready') {
        process.stdout.write(readLog(started.id, 4000));
        console.error(`E_HUB_RUN: ${id} ${r.status}${r.code !== null ? ` (exit ${r.code})` : ''}`);
        return r.code || 1;
      }
      console.log(r.url);
    } else console.log(started.id);
    console.error(`run ${started.id} — trempel stop ${started.id}`);
    return 0;
  }
  const tail = followLog(logFile(started.id), (t) => process.stdout.write(t));
  let stopping = false;
  const onSig = (): void => {
    if (stopping) return;
    stopping = true;
    void stopRun(started.id);
  };
  process.on('SIGINT', onSig);
  process.on('SIGTERM', onSig);
  const r = await waitRun(started.id);
  tail.stop();
  if (r.status === 'stopped') return 130;
  if (r.status === 'lost') return 1;
  return r.code ?? 1;
}

async function ps(args: Args): Promise<number> {
  const runs = activeServices();
  if (args.flags.json) {
    console.log(JSON.stringify(runs, null, 2));
    return 0;
  }
  if (!runs.length) console.log('no services running');
  for (const r of runs) console.log(`${pad(r.id, 30)}${pad(r.projectName, 24)}${pad(r.action, 14)}${pad(r.status, 8)}${pad(`${r.seconds}s`, 8)}${r.url ?? ''}`);
  return 0;
}

async function stop(args: Args): Promise<number> {
  const what = args._[1];
  if (!what) throw new HubError('E_CLI: trempel stop <run id | action>', 2);
  let ids: string[];
  if (readRun(what)) ids = [what];
  else {
    const root = projectRoot(args.flags.project);
    const pid = describeProject(root).id;
    ids = listRuns({ projectId: pid })
      .filter((r) => r.action === what && isActive(r))
      .map((r) => r.id);
    if (!ids.length) throw new HubError(`E_HUB_NOT_RUNNING: nothing of "${what}" runs for ${root}.`, 1);
  }
  for (const id of ids) {
    const r = await stopRun(id);
    console.log(`${id}: ${r?.status}`);
  }
  return 0;
}

async function log(args: Args): Promise<number> {
  const id = args._[1];
  if (!id || !readRun(id)) throw new HubError('E_CLI: trempel log <run id>', 2);
  if (!args.flags.follow) {
    process.stdout.write(readLog(id));
    return 0;
  }
  const tail = followLog(logFile(id), (t) => process.stdout.write(t));
  await waitRun(id);
  tail.stop();
  return 0;
}

async function projects(args: Args): Promise<number> {
  const cfg = loadConfig();
  const all = scanProjects(cfg.roots, cfg.projects, cfg.depth);
  const rows = await Promise.all(all.map(async (p) => ({ ...p, git: await gitState(p.root) })));
  if (args.flags.json) {
    console.log(JSON.stringify({ roots: cfg.roots, projects: rows }, null, 2));
    return 0;
  }
  console.log(`roots: ${cfg.roots.join(', ') || '—'}`);
  for (const p of rows) {
    const g = p.git ? `${p.git.branch ?? 'detached'}${p.git.dirty ? '*' : ''}${p.git.ahead ? ` ↑${p.git.ahead}` : ''}${p.git.behind ? ` ↓${p.git.behind}` : ''}` : 'no git';
    console.log(`${pad(p.name, 28)}${pad(`kit ${p.kit ?? '—'}`, 14)}${pad(`scene ${p.scene ?? '—'}`, 16)}${pad(g, 20)}${p.root}`);
  }
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const cmd = args._[0];
  if (!cmd || args.flags.help) {
    console.log(USAGE);
    return cmd ? 0 : 2;
  }
  switch (cmd) {
    case 'run':
      return run(args);
    case 'ps':
      return ps(args);
    case 'stop':
      return stop(args);
    case 'log':
      return log(args);
    case 'projects':
      return projects(args);
    case 'add':
    case 'remove': {
      const d = args._[1] && resolve(args._[1]);
      if (!d) throw new HubError(`E_CLI: trempel ${cmd} <dir>`, 2);
      if (cmd === 'add' && !isProject(d)) throw new HubError(`E_HUB_PROJECT: ${d} is not a Trempel project.`, 2);
      const cfg = loadConfig();
      const next = cmd === 'add' ? [...new Set([...cfg.projects, d])] : cfg.projects.filter((p) => p !== d);
      saveConfig({ projects: next });
      console.log(`${cmd === 'add' ? 'added' : 'removed'} ${d}`);
      return 0;
    }
    case 'roots': {
      if (args._.length > 1) saveConfig({ roots: args._.slice(1).map((r) => resolve(r)) });
      console.log(loadConfig().roots.join('\n'));
      return 0;
    }
    case 'templates':
      for (const t of listTemplates()) console.log(`${pad(t.name, 10)}${t.description}`);
      return 0;
    case 'new': {
      const [, template, dest] = args._;
      if (!template || !dest) throw new HubError('E_CLI: trempel new <template> <dir> [--name n] [--install]', 2);
      const dir = createProject({ template, dest, name: typeof args.flags.name === 'string' ? args.flags.name : undefined, install: !!args.flags.install, log: (l) => console.log(l) });
      console.log(dir);
      return 0;
    }
    case 'hub': {
      const { startHub } = await import('./server.js');
      if (args.roots.length) process.env.TREMPEL_HUB_ROOTS = args.roots.map((r) => resolve(r)).join(process.platform === 'win32' ? ';' : ':');
      const hub = await startHub({ port: typeof args.flags.port === 'string' ? Number(args.flags.port) : undefined, host: typeof args.flags.host === 'string' ? args.flags.host : undefined });
      console.log(`Trempel hub: ${hub.url}`);
      if (!args.flags['no-open']) {
        const { spawn } = await import('node:child_process');
        const opener = process.env.TREMPEL_HUB_OPEN ?? (process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open');
        spawn(opener, [hub.url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
      }
      await new Promise(() => {});
      return 0;
    }
    default:
      throw new HubError(`E_CLI: unknown command "${cmd}".\n${USAGE}`, 2);
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    if (e instanceof HubError) {
      console.error(e.message);
      process.exit(e.code);
    }
    console.error(e instanceof Error ? e.stack : String(e));
    process.exit(1);
  },
);

