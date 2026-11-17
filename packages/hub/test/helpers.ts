// helpers.ts — temporary projects, kits and hub homes for the tests.

import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HUB = join(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO = join(HUB, '..', '..');
export const CLI = join(HUB, 'dist', 'cli.js');

export function tmp(prefix = 'hub-'): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** A fresh TREMPEL_HOME for this process (the engine reads it at call time). */
export function freshHome(): string {
  const h = tmp('hub-home-');
  process.env.TREMPEL_HOME = h;
  process.env.TREMPEL_HUB_ROOTS = '';
  return h;
}

export function write(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** A project folder: package.json (+ files). */
export function makeProject(root: string, pkg: Record<string, unknown>, files: Record<string, string> = {}): string {
  mkdirSync(root, { recursive: true });
  write(join(root, 'package.json'), JSON.stringify({ version: '1.0.0', type: 'module', ...pkg }, null, 2));
  for (const [f, t] of Object.entries(files)) write(join(root, f), t);
  return root;
}

/** A fake `@trempel/kit` of some version in the project's node_modules; `actions` — its hub/actions.mdz (null — none, an old kit). */
export function fakeKit(project: string, version: string, actions: string | null): string {
  const dir = join(project, 'node_modules', '@trempel', 'kit');
  write(join(dir, 'package.json'), JSON.stringify({ name: '@trempel/kit', version }));
  if (actions !== null) write(join(dir, 'hub', 'actions.mdz'), actions);
  return dir;
}

/** The monorepo's own kit (and scene) linked into a fixture project. */
export function linkRealKit(project: string): void {
  mkdirSync(join(project, 'node_modules', '@trempel'), { recursive: true });
  symlinkSync(join(REPO, 'packages', 'kit'), join(project, 'node_modules', '@trempel', 'kit'));
  symlinkSync(join(REPO, 'packages', 'scene'), join(project, 'node_modules', '@trempel', 'scene'));
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the built `trempel` CLI. */
export function cli(args: string[], opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {}): Promise<CliResult> {
  return new Promise((res) => {
    execFile(process.execPath, [CLI, ...args], { cwd: opts.cwd, env: { ...process.env, ...opts.env }, timeout: opts.timeoutMs ?? 60_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
      res({ code, stdout, stderr });
    });
  });
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function until<T>(fn: () => T | Promise<T>, timeoutMs = 20_000, what = 'condition'): Promise<NonNullable<T>> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await sleep(100);
  }
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    // a zombie is not alive
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2)[0] !== 'Z';
  } catch {
    return process.platform !== 'linux';
  }
}
