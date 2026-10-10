// procs.ts — processes by pid: alive or not (a reused pid is not "alive"), the tree under a pid,
// stopping a tree. Only the run's own process group and its descendants are signalled — never a
// process by name.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, connect } from 'node:net';

/** Start time of a process (Linux: clock ticks since boot, /proc/<pid>/stat field 22); null elsewhere. */
export function procStart(pid: number): string | null {
  if (process.platform !== 'linux') return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (fields[0] === 'Z') return null;
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

/** Is `pid` alive and (when `start` is known) the same process that was started then? */
export function isAlive(pid: number, start?: string | null): boolean {
  try {
    process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EPERM') return false;
  }
  if (process.platform === 'linux') {
    const now = procStart(pid);
    if (now === null) return false; // a zombie or gone
    if (start && now !== start) return false;
  }
  return true;
}

/** Every descendant of `pid` (children, their children…), from a process listing. */
export function descendants(pid: number): number[] {
  if (process.platform === 'win32') return [];
  let out: string;
  try {
    out = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', maxBuffer: 16 << 20 });
  } catch {
    return [];
  }
  const kids = new Map<number, number[]>();
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)/.exec(line);
    if (!m) continue;
    const p = Number(m[1]);
    const pp = Number(m[2]);
    if (!kids.has(pp)) kids.set(pp, []);
    kids.get(pp)!.push(p);
  }
  const res: number[] = [];
  const stack = [...(kids.get(pid) ?? [])];
  while (stack.length) {
    const p = stack.pop()!;
    if (res.includes(p)) continue;
    res.push(p);
    stack.push(...(kids.get(p) ?? []));
  }
  return res;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    /* gone */
  }
}

/**
 * Stop the tree of a run: its process group (`pid` leads it — runs start detached) and every
 * descendant that left the group; SIGTERM, then SIGKILL after `graceMs`. Resolves when all are gone.
 */
export async function killTree(pid: number, opts: { group?: boolean; graceMs?: number } = {}): Promise<void> {
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      /* gone */
    }
    return;
  }
  const group = opts.group ?? true;
  const tree = [pid, ...descendants(pid)];
  const groups = new Set<number>();
  if (group) groups.add(pid);
  const hit = (sig: NodeJS.Signals): void => {
    for (const g of groups) signal(-g, sig);
    for (const p of tree) signal(p, sig);
  };
  hit('SIGTERM');
  const deadline = Date.now() + (opts.graceMs ?? 5000);
  while (Date.now() < deadline) {
    // newcomers forked during shutdown join the tree
    for (const p of descendants(pid)) if (!tree.includes(p)) tree.push(p);
    if (!tree.some((p) => isAlive(p))) return;
    await sleep(100);
  }
  hit('SIGKILL');
  for (let i = 0; i < 20 && tree.some((p) => isAlive(p)); i++) await sleep(50);
}

/** A free TCP port (the OS picks one). */
export function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.unref();
    s.on('error', rej);
    s.listen(0, () => {
      const a = s.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      s.close(() => res(port));
    });
  });
}

/** Does something accept connections on the port (IPv4 or IPv6 loopback)? */
export function portOpen(port: number, timeoutMs = 500): Promise<boolean> {
  const one = (host: string): Promise<boolean> =>
    new Promise((res) => {
      const sock = connect({ port, host });
      const done = (ok: boolean): void => {
        sock.destroy();
        res(ok);
      };
      sock.setTimeout(timeoutMs, () => done(false));
      sock.once('connect', () => done(true));
      sock.once('error', () => done(false));
    });
  return Promise.all([one('127.0.0.1'), one('::1')]).then(([a, b]) => a || b);
}
