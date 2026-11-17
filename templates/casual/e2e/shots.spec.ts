// shots.spec.ts — view:shot of the template's screens (the hub's `shots` action runs the same
// command): `game` and `menu` with the kit's components (scenes/trempel.view.ts — kitView with the
// game's texts and the wallet's starting state), no errors, the HUD drawn with its values; the
// same picture twice.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCENE_PKG = dirname(createRequire(import.meta.url).resolve('@trempel/scene/package.json'));

interface Shot {
  errors: { message: string }[];
  warnings: { message: string }[];
  width: number;
  height: number;
  stubs: string[];
}

function shot(scene: string, out: string): Shot {
  const json = execFileSync(process.execPath, [join(SCENE_PKG, 'view/bin.mjs'), 'view:shot', `scenes/${scene}.tml.svg`, '--out', out, '--settle', '1'], { cwd: ROOT, encoding: 'utf8', timeout: 180_000 });
  return JSON.parse(json) as Shot;
}

let dir = '';
test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'casual-shots-'));
});
test.afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

for (const scene of ['game', 'menu']) {
  test(`view:shot of ${scene}: no errors, the same picture twice`, async () => {
    test.setTimeout(240_000);
    const a = shot(scene, join(dir, `${scene}-a.png`));
    expect(a.errors).toEqual([]);
    expect([a.width, a.height]).toEqual([720, 1280]);
    // the game's context is there: only the handlers are stand-ins
    expect(a.stubs).not.toContain('services');
    expect(a.stubs).not.toContain('t');
    const b = shot(scene, join(dir, `${scene}-b.png`));
    expect(b.errors).toEqual([]);
    const hash = (f: string): string => createHash('sha1').update(readFileSync(join(dir, f))).digest('hex');
    expect(hash(`${scene}-b.png`)).toBe(hash(`${scene}-a.png`));
  });
}
