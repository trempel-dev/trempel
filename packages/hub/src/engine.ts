// engine.ts — run an action of a project: check its conditions and inputs, give a service its
// port, substitute `${…}`, start the supervisor detached (own process group, log to a file).
// The CLI, the hub page and `ctx.run` of a js action all come here.

import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { Action, ActionInput } from './actions.js';
import { writeJson } from './home.js';
import { distEntry, resolveActions, type ResolvedActions } from './layers.js';
import { describeProject, gitState, type GitState, type ProjectInfo } from './project.js';
import { freePort, procStart } from './procs.js';
import { activeServices, logFile, newRunId, pruneRuns, readRun, runDir, writeMeta, type RunMeta, type RunState } from './runs.js';
import type { RunSpec } from './supervise.js';
import { interpolate, whenHolds, type VarContext } from './vars.js';

export type InputValues = Record<string, string | number | boolean>;

export class HubError extends Error {
  constructor(message: string, readonly code = 1) {
    super(message);
    this.name = 'HubError';
  }
}

export interface ProjectActions extends ResolvedActions {
  project: ProjectInfo;
  git: GitState | null;
  /** id → shown (its `when` holds). */
  visible: Set<string>;
  /** Services of this project that are up: action id → the run. */
  running: Map<string, RunState>;
}

function servicesOf(running: Map<string, RunState>): VarContext['services'] {
  const out: VarContext['services'] = {};
  for (const [id, r] of running) out[id] = { port: r.port, url: r.url };
  return out;
}

/** A project's actions with their conditions evaluated now. */
export async function projectActions(root: string | ProjectInfo): Promise<ProjectActions> {
  const project = typeof root === 'string' ? describeProject(root) : root;
  const resolved = resolveActions(project);
  const git = await gitState(project.root);
  const running = new Map<string, RunState>();
  for (const r of activeServices(project.id)) if (!running.has(r.action)) running.set(r.action, r);
  const visible = new Set<string>();
  for (const a of resolved.actions.values()) {
    const vars: VarContext = { project, input: {}, services: servicesOf(running), here: a.base };
    if (whenHolds(a, { root: project.root, git, running: new Set(running.keys()), vars })) visible.add(a.id);
  }
  return { ...resolved, project, git, visible, running };
}

/** Inputs as given (strings from a CLI or a form) → typed values with defaults; @throws HubError */
export function checkInputs(action: Action, given: Record<string, unknown>): InputValues {
  const out: InputValues = {};
  const known = new Set(action.inputs.map((i) => i.name));
  for (const k of Object.keys(given)) if (!known.has(k)) throw new HubError(`E_HUB_INPUT: "${action.id}" has no input "${k}" (${[...known].join(', ') || 'none'}).`, 2);
  for (const inp of action.inputs) {
    const raw = given[inp.name];
    if (raw === undefined || raw === '') {
      if (inp.default !== undefined) out[inp.name] = inp.default;
      else if (inp.type === 'bool') out[inp.name] = false;
      else if (inp.required) throw new HubError(`E_HUB_INPUT: "${action.id}" needs the input "${inp.name}" (--input ${inp.name}=…).`, 2);
      else out[inp.name] = '';
      continue;
    }
    out[inp.name] = coerceInput(action, inp, raw);
  }
  return out;
}

function coerceInput(action: Action, inp: ActionInput, raw: unknown): string | number | boolean {
  if (inp.type === 'bool') {
    if (typeof raw === 'boolean') return raw;
    const s = String(raw).toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(s)) return true;
    if (['false', '0', 'no', 'off'].includes(s)) return false;
    throw new HubError(`E_HUB_INPUT: "${action.id}": ${inp.name} is true or false, not "${String(raw)}".`, 2);
  }
  if (inp.type === 'select') {
    const hit = inp.options!.find((o) => String(o) === String(raw));
    if (hit === undefined) throw new HubError(`E_HUB_INPUT: "${action.id}": ${inp.name} is one of ${inp.options!.join(', ')}, not "${String(raw)}".`, 2);
    return hit;
  }
  return typeof raw === 'number' ? raw : String(raw);
}

export interface StartOptions {
  input?: Record<string, unknown>;
  /** Run even if `when` does not hold. */
  force?: boolean;
  /** The run that asks (`ctx.run`): a `once` child joins its process group. */
  parent?: string;
  /** Seconds a service may take to answer on its port (default 120). */
  readyTimeout?: number;
}

/** Start an action; resolves once its supervisor is up (not when it ends — `waitRun`). */
export async function startAction(root: string | ProjectInfo, actionId: string, opts: StartOptions = {}): Promise<RunState> {
  const pa = await projectActions(root);
  const { project } = pa;
  const action = pa.actions.get(actionId);
  if (!action) {
    const ids = [...pa.actions.keys()].join(', ');
    throw new HubError(`E_HUB_NO_ACTION: ${project.name} has no action "${actionId}" (${ids}).`, 2);
  }
  if (!opts.force && !pa.visible.has(actionId)) throw new HubError(`E_HUB_WHEN: "${actionId}" is off for ${project.name}: ${action.when.join(', ')} does not hold.`, 2);
  if (action.kind === 'service' && pa.running.has(actionId)) {
    const r = pa.running.get(actionId)!;
    throw new HubError(`E_HUB_RUNNING: "${actionId}" is already running for ${project.name} (run ${r.id}${r.url ? `, ${r.url}` : ''}).`, 3);
  }
  const input = checkInputs(action, opts.input ?? {});
  let port: number | undefined;
  if (action.kind === 'service' && action.port !== undefined) port = action.port === 'auto' ? await freePort() : action.port;
  const vars: VarContext = { project, input, port, services: servicesOf(pa.running), here: action.base };
  if (port !== undefined) vars.url = interpolate(action.url ?? 'http://localhost:${port}/', vars);
  const cwd = action.cwd ? resolve(project.root, interpolate(action.cwd, vars)) : project.root;
  // 2.4.1: INIT_CWD is where a command was started (npm's); a hub started by `npm run …` must not
  // hand its own to the project's tools (the scene's editor and view:shot resolve folders from it)
  const env: Record<string, string> = { INIT_CWD: cwd };
  for (const [k, v] of Object.entries(action.env)) env[k] = interpolate(v, vars);
  if (port !== undefined) env.PORT = String(port);
  const id = newRunId();
  env.TREMPEL_RUN = id;
  env.TREMPEL_PROJECT = project.root;
  const spec: RunSpec = { cwd, env };
  let command: string;
  if (action.shell) {
    spec.shell = action.shell.map((c) => interpolate(c, vars, true));
    command = spec.shell.join(' && ');
  } else {
    const mod = interpolate(action.js!, vars);
    spec.js = isAbsolute(mod) ? mod : resolve(action.base, mod);
    command = `js ${spec.js}`;
  }
  if (port !== undefined) spec.ready = { port, url: vars.url!, timeoutMs: (opts.readyTimeout ?? 120) * 1000 };
  pruneRuns();
  const meta: RunMeta = {
    id,
    projectId: project.id,
    projectRoot: project.root,
    projectName: project.name,
    action: action.id,
    title: action.title,
    layer: action.layer,
    kind: action.kind,
    group: action.group,
    input,
    command,
    cwd,
    port,
    url: vars.url,
    parent: opts.parent,
    startedAt: new Date().toISOString(),
  };
  writeMeta(meta);
  writeJson(join(runDir(id), 'spec.json'), spec);
  writeJson(join(runDir(id), 'ctx.json'), { project, input, port, url: vars.url, services: vars.services, action: action.id, run: id } satisfies JsContextData);
  const fd = openSync(logFile(id), 'a');
  // a `once` child of a running js action stays in its parent's process group (stopping the parent stops it)
  const detached = !(opts.parent && action.kind === 'once');
  const child = spawn(process.execPath, [distEntry('supervise.js'), runDir(id)], {
    cwd,
    detached,
    stdio: ['ignore', fd, fd],
    env: process.env,
    windowsHide: true,
  });
  closeSync(fd);
  await new Promise<void>((res, rej) => {
    child.once('spawn', () => res());
    child.once('error', rej);
  });
  child.unref();
  meta.pid = child.pid;
  meta.ownGroup = detached;
  meta.procStart = child.pid ? procStart(child.pid) : null;
  writeMeta(meta);
  return readRun(id)!;
}

/** What a js action's ctx is built from (`ctx.json` of the run). */
export interface JsContextData {
  project: ProjectInfo;
  input: InputValues;
  port?: number;
  url?: string;
  services: VarContext['services'];
  action: string;
  run: string;
}
