// home.ts — where the hub keeps its things: `~/.trempel` (TREMPEL_HOME moves it). The user's
// actions — `actions.mdz` there; the hub's own state — `hub/`: `config.json` (roots to scan,
// projects added by hand), `runs/<id>/` (a run: meta, log), so services outlive the hub.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export function trempelHome(): string {
  return resolve(process.env.TREMPEL_HOME ?? join(homedir(), '.trempel'));
}

export const userActionsFile = (): string => join(trempelHome(), 'actions.mdz');
export const hubDir = (): string => join(trempelHome(), 'hub');
export const runsDir = (): string => join(hubDir(), 'runs');

/** The default root to scan: the `Studio/Projects` folder of the home folder. */
export const DEFAULT_ROOTS = (): string[] => [join(homedir(), 'Studio', 'Projects')];

export interface HubConfig {
  /** Folders scanned for projects. */
  roots: string[];
  /** Projects added by hand (absolute). */
  projects: string[];
  /** How deep below a root projects are looked for (default 2: `root/x`, `root/group/x`). */
  depth: number;
}

const configFile = (): string => join(hubDir(), 'config.json');

/** `~` at the start → the home folder. */
export function expandHome(p: string): string {
  return p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

/**
 * The config: the file, then TREMPEL_HUB_ROOTS (path-list separated, replaces the roots), then the
 * defaults. Missing file → defaults.
 */
export function loadConfig(): HubConfig {
  let file: Partial<HubConfig> = {};
  try {
    file = JSON.parse(readFileSync(configFile(), 'utf8')) as Partial<HubConfig>;
  } catch {
    /* no config yet */
  }
  const envRoots = process.env.TREMPEL_HUB_ROOTS;
  const roots = envRoots !== undefined ? envRoots.split(process.platform === 'win32' ? ';' : ':').filter(Boolean) : file.roots ?? DEFAULT_ROOTS();
  return {
    roots: roots.map((r) => resolve(expandHome(r))),
    projects: (file.projects ?? []).map((p) => resolve(expandHome(p))),
    depth: typeof file.depth === 'number' ? file.depth : 2,
  };
}

export function saveConfig(cfg: Partial<HubConfig>): HubConfig {
  let file: Partial<HubConfig> = {};
  try {
    file = JSON.parse(readFileSync(configFile(), 'utf8')) as Partial<HubConfig>;
  } catch {
    /* new */
  }
  const next = { ...file, ...cfg };
  writeJson(configFile(), next);
  return loadConfig();
}

/** Write JSON atomically (a temp file, then rename). */
export function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  renameSync(tmp, file);
}

export function readJson<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}
