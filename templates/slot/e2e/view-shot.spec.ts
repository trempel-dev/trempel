// view-shot.spec.ts — the reskin gate, static half: every skin's scene and popups through the scene
// package's `view:shot` (headless, deterministic) — no errors; the shots go to test-results/view/.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const SKINS = readdirSync(new URL('../skins', import.meta.url));
const FILES = ['slot.svg', 'popups/fs-intro.svg', 'popups/fs-outro.svg', 'popups/bigwin.svg'];

for (const skin of SKINS) {
  test(`view:shot of the ${skin} skin: scene and popups without errors`, async () => {
    test.setTimeout(120_000);
    mkdirSync('test-results/view', { recursive: true });
    for (const f of FILES) {
      const out = `test-results/view/${skin}-${f.replace(/\//g, '-').replace(/\.svg$/, '.png')}`;
      const json = execFileSync('npx', ['trempel-view', 'view:shot', `skins/${skin}/${f}`, '--out', out], { encoding: 'utf8' });
      const r = JSON.parse(json.slice(json.indexOf('{')));
      expect(r.errors, `${skin}/${f}`).toEqual([]);
    }
  });
}
