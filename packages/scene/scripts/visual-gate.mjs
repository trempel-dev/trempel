#!/usr/bin/env node
// visual-gate.mjs — the visual gate of CI: `view:shot` of a few example scenes against the goldens
// in test/golden/*.png. A scene passes when the mean absolute difference of its RGBA bytes is at
// most 1/255 (and the sizes match). On a failure the shot and an amplified diff are written to
// .visual/ (CI uploads that folder as an artifact).
//
//   npm run visual-gate              (from packages/scene; builds nothing — view:shot runs the sources)
//   npm run visual-gate -- --update  (rewrite the goldens from fresh shots)
//
// Exit code: 0 — every scene within the threshold; 1 — a scene differs (or failed to shoot).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = fileURLToPath(new URL('..', import.meta.url));
const GOLDEN = join(root, 'test', 'golden');
const OUT = join(root, '.visual');
/** Mean |Δ| over RGBA bytes, as a fraction of 255. */
const THRESHOLD = 1 / 255;

export const SCENES = [
  { name: 'motion', args: ['examples/motion/scene.tml.svg'] },
  { name: 'motion-wave-0.5', args: ['examples/motion/scene.tml.svg', '--clip', 'wave', '--t', '0.5'] },
  { name: 'prefabs-menu', args: ['examples/prefabs/menu.tml.svg'] },
  { name: 'prefabs-popup-pause', args: ['examples/prefabs/popup-pause.tml.svg'] },
];

const update = process.argv.includes('--update');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
mkdirSync(GOLDEN, { recursive: true });

const raw = async (file) => {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
};

let failed = 0;
for (const s of SCENES) {
  const shot = join(OUT, `${s.name}.png`);
  const r = spawnSync(process.execPath, [join(root, 'view/shot.mjs'), ...s.args, '--out', shot], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, INIT_CWD: root },
    timeout: 180_000,
  });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    // reported below
  }
  if (r.status !== 0 || !json || !existsSync(shot)) {
    console.error(`✗ ${s.name}: view:shot failed (exit ${r.status})\n${r.stdout}\n${r.stderr}`);
    failed++;
    continue;
  }
  const golden = join(GOLDEN, `${s.name}.png`);
  if (update) {
    await sharp(shot).png({ compressionLevel: 9 }).toFile(golden);
    console.log(`↻ ${s.name}: golden written (${json.width}×${json.height})`);
    continue;
  }
  if (!existsSync(golden)) {
    console.error(`✗ ${s.name}: no golden test/golden/${s.name}.png (npm run visual-gate -- --update)`);
    failed++;
    continue;
  }
  const a = await raw(shot);
  const b = await raw(golden);
  if (a.width !== b.width || a.height !== b.height) {
    console.error(`✗ ${s.name}: ${a.width}×${a.height}, the golden is ${b.width}×${b.height}`);
    failed++;
    continue;
  }
  let sum = 0;
  let changed = 0;
  const diff = Buffer.alloc(a.width * a.height * 4);
  for (let p = 0; p < a.width * a.height; p++) {
    let px = 0;
    for (let c = 0; c < 4; c++) {
      const d = Math.abs(a.data[p * 4 + c] - b.data[p * 4 + c]);
      sum += d;
      px = Math.max(px, d);
    }
    if (px) changed++;
    const v = Math.min(255, px * 8);
    diff[p * 4] = v;
    diff[p * 4 + 1] = 0;
    diff[p * 4 + 2] = 0;
    diff[p * 4 + 3] = px ? 255 : 0;
  }
  const mean = sum / (a.width * a.height * 4) / 255;
  const line = `${s.name}: mean |Δ| ${(mean * 255).toFixed(3)}/255, ${changed} px differ (${((changed / (a.width * a.height)) * 100).toFixed(2)}%)`;
  if (mean <= THRESHOLD) {
    console.log(`✓ ${line}`);
    rmSync(shot);
  } else {
    await sharp(diff, { raw: { width: a.width, height: a.height, channels: 4 } }).png().toFile(join(OUT, `${s.name}.diff.png`));
    console.error(`✗ ${line} — over 1/255; shot and diff in .visual/`);
    failed++;
  }
}
process.exit(failed ? 1 : 0);
