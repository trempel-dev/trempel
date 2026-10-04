// lock.ts — vitest globalSetup of the e2e project: one e2e run of the repo at a time on a machine.
// The lock is a file `<os tmpdir>/trempel-e2e.lock` holding the owner's pid; a second run waits for it
// (prints once), a stale one (its process is gone) is taken over. Released on teardown.

import { mkdirSync, openSync, readFileSync, rmSync, writeSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const LOCK = process.env.TML_E2E_LOCK ?? join(tmpdir(), 'trempel-e2e.lock');

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** Take the lock (waits while another live run holds it; up to `maxWaitMs`). */
export async function acquire(maxWaitMs = 30 * 60_000): Promise<void> {
  mkdirSync(join(LOCK, '..'), { recursive: true });
  const t0 = Date.now();
  let told = false;
  for (;;) {
    try {
      const fd = openSync(LOCK, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    let owner = NaN;
    try {
      owner = Number(readFileSync(LOCK, 'utf8').trim());
    } catch {
      continue; // released between open and read
    }
    if (!Number.isFinite(owner) || owner <= 0 || !alive(owner)) {
      rmSync(LOCK, { force: true }); // stale: its run is gone
      continue;
    }
    if (!told) {
      console.log(`e2e: ждём другой прогон (pid ${owner}, ${LOCK})…`);
      told = true;
    }
    if (Date.now() - t0 > maxWaitMs) throw new Error(`e2e: ${LOCK} занят pid ${owner} дольше ${Math.round(maxWaitMs / 60000)} мин`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export function release(): void {
  try {
    if (Number(readFileSync(LOCK, 'utf8').trim()) === process.pid) rmSync(LOCK, { force: true });
  } catch {
    // already gone
  }
}

export default async function setup(): Promise<() => void> {
  await acquire();
  const off = (): void => release();
  process.once('exit', off);
  return off;
}
