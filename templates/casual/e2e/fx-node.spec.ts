// fx-node.spec.ts — kit 2.2: an effect as a scene node is drawn the same every run. view:shot (the
// scene package's bin) shoots the kit's effects showcase (@trempel/kit/ui/scenes/effects, its view
// module) settled and posed by a clip whose markers fire effects: three runs, bit for bit.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test } from '@playwright/test';

const require = createRequire(import.meta.url);
const kit = dirname(require.resolve('@trempel/kit/package.json'));
const scene = dirname(require.resolve('@trempel/scene/package.json'));

function shot(out: string, ...args: string[]): { errors: unknown[] } {
  const json = execFileSync(process.execPath, [join(scene, 'view/bin.mjs'), 'view:shot', join(kit, 'ui/scenes/effects'), '--out', out, ...args], { encoding: 'utf8', timeout: 180_000 });
  return JSON.parse(json);
}
const sha = (f: string) => createHash('sha1').update(readFileSync(f)).digest('hex');

test('view:shot draws effect nodes and clip-fired effects the same every run', async () => {
  test.setTimeout(600_000);
  const dir = mkdtempSync(join(tmpdir(), 'fx-node-'));
  try {
    const settled: string[] = [];
    const posed: string[] = [];
    for (let i = 0; i < 3; i++) {
      expect(shot(join(dir, `s${i}.png`), '--settle', '1.3').errors).toEqual([]);
      settled.push(sha(join(dir, `s${i}.png`)));
      expect(shot(join(dir, `c${i}.png`), '--clip', 'celebrate', '--t', '0.8').errors).toEqual([]);
      posed.push(sha(join(dir, `c${i}.png`)));
    }
    expect(new Set(settled).size).toBe(1);
    expect(new Set(posed).size).toBe(1);
    expect(settled[0]).not.toBe(posed[0]); // the clip's confetti is in the picture
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
