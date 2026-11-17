// vars.ts — `${…}` in an action's shell, url, cwd, env and `when`, and the `when` conditions.
//
//   ${input.<name>}            a value from the run's inputs
//   ${port} ${url}             a service's port and URL
//   ${project.root|name|kit|scene}
//   ${pkg:<package>}           the folder of a package as the project resolves it (node_modules up the tree)
//   ${services.<id>.port|url}  a service of this project that is running now
//   ${env.<NAME>}              the hub's environment
//   ${here}                    the folder of the file declaring the action
//
// Any other `${…}` (`${HOME}`, `${1:-x}`) is left to the shell. In a shell command a value is quoted
// for the shell (an input can't add a command).

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Action } from './actions.js';
import { declared, findPackageDir, readPackageJson, type GitState, type ProjectInfo } from './project.js';

export interface VarContext {
  project: Pick<ProjectInfo, 'root' | 'name' | 'kit' | 'scene'>;
  input: Record<string, string | number | boolean>;
  port?: number;
  url?: string;
  /** Running services of the project: action id → port / URL. */
  services: Record<string, { port?: number; url?: string }>;
  here: string;
}

export class VarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VarError';
  }
}

const KNOWN = /^(?:input\.|services\.|env\.|project\.|pkg:|port$|url$|here$)/;

/** Quote for the platform's shell unless plainly safe. */
export function shellQuote(v: string): string {
  if (v !== '' && /^[A-Za-z0-9_./:@%+=,-]+$/.test(v)) return v;
  if (process.platform === 'win32') return `"${v.replace(/"/g, '""')}"`;
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

function lookup(key: string, ctx: VarContext): string {
  if (key.startsWith('input.')) {
    const name = key.slice(6);
    if (!(name in ctx.input)) throw new VarError(`E_HUB_VAR: \${${key}} — no input "${name}".`);
    return String(ctx.input[name]);
  }
  if (key === 'port') {
    if (ctx.port === undefined) throw new VarError('E_HUB_VAR: ${port} — only a service with $port has a port.');
    return String(ctx.port);
  }
  if (key === 'url') {
    if (ctx.url === undefined) throw new VarError('E_HUB_VAR: ${url} — only a service has a URL.');
    return ctx.url;
  }
  if (key === 'here') return ctx.here;
  if (key.startsWith('project.')) {
    const f = key.slice(8) as 'root' | 'name' | 'kit' | 'scene';
    if (!['root', 'name', 'kit', 'scene'].includes(f)) throw new VarError(`E_HUB_VAR: \${${key}} — project.root, project.name, project.kit, project.scene.`);
    return String(ctx.project[f] ?? '');
  }
  if (key.startsWith('pkg:')) {
    const dir = findPackageDir(ctx.project.root, key.slice(4));
    if (!dir) throw new VarError(`E_HUB_VAR: \${${key}} — the package is not installed for ${ctx.project.root}.`);
    return dir;
  }
  if (key.startsWith('services.')) {
    const m = /^services\.(.+)\.(port|url)$/.exec(key);
    if (!m) throw new VarError(`E_HUB_VAR: \${${key}} — services.<id>.port or services.<id>.url.`);
    const s = ctx.services[m[1]];
    const v = s?.[m[2] as 'port' | 'url'];
    if (v === undefined) throw new VarError(`E_HUB_VAR: \${${key}} — the service "${m[1]}" is not running for this project.`);
    return String(v);
  }
  if (key.startsWith('env.')) return process.env[key.slice(4)] ?? '';
  throw new VarError(`E_HUB_VAR: \${${key}} — unknown.`);
}

/** Substitute `${…}`; `quote` — for a shell command. @throws VarError */
export function interpolate(s: string, ctx: VarContext, quote = false): string {
  return s.replace(/\$\{([^{}]+)\}/g, (m, key: string) => {
    const k = key.trim();
    if (!KNOWN.test(k)) return m;
    const v = lookup(k, ctx);
    return quote ? shellQuote(v) : v;
  });
}

export interface WhenContext {
  root: string;
  git: GitState | null;
  running: Set<string>;
  vars: VarContext;
}

/** Does every condition of the action hold? A condition that can't be evaluated is false. */
export function whenHolds(action: Pick<Action, 'when'>, ctx: WhenContext): boolean {
  return action.when.every((c) => {
    const neg = c.startsWith('!');
    const cond = neg ? c.slice(1).trim() : c.trim();
    let v: boolean;
    try {
      v = evalCondition(cond, ctx);
    } catch {
      v = false;
      return false;
    }
    return neg ? !v : v;
  });
}

function evalCondition(c: string, ctx: WhenContext): boolean {
  if (c === 'git') return ctx.git !== null;
  if (c === 'git.dirty') return !!ctx.git?.dirty;
  if (c === 'git.ahead') return (ctx.git?.ahead ?? 0) > 0;
  if (c === 'git.behind') return (ctx.git?.behind ?? 0) > 0;
  if (c === 'git.upstream') return !!ctx.git?.upstream;
  const i = c.indexOf(':');
  const kind = i < 0 ? c : c.slice(0, i);
  const arg = i < 0 ? '' : c.slice(i + 1).trim();
  if (kind === 'file') return existsSync(resolve(ctx.root, interpolate(arg, ctx.vars)));
  if (kind === 'dep') {
    const pj = readPackageJson(ctx.root);
    return declared(pj, arg) !== null;
  }
  if (kind === 'script') return !!readPackageJson(ctx.root)?.scripts?.[arg];
  if (kind === 'running') return ctx.running.has(arg);
  if (kind === 'platform') return process.platform === arg;
  throw new VarError(`E_HUB_WHEN: unknown condition "${c}".`);
}
