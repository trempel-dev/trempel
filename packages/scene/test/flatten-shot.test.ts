// v1.1 flatten in a real browser: the vanilla SVG of a scene, shown by Chromium as `<img src=out.svg>`
// (--embed: one self-contained file) and opened directly (pictures as relative links), differs from
// the runtime's own picture (view:shot of the same scene) by ≤ 2/255 on average; the output is XML
// without tml:, data-*, @-links.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DOMParser } from '@xmldom/xmldom';
import type { Browser } from 'playwright';
import { flattenLeftovers } from '../src/flatten';
import { flattenFile } from '../src/node/flatten';

const root = fileURLToPath(new URL('..', import.meta.url));
const T = 180_000;
let tmp = '';
let browser: Browser;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'tml-flat-'));
  const { chromium } = await import('playwright');
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
});
afterAll(async () => {
  await browser?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

/** view:shot of a scene → PNG path, size. */
function shot(scene: string, out: string): { width: number; height: number } {
  const r = spawnSync(process.execPath, [join(root, 'view/shot.mjs'), scene, '--out', out], { cwd: root, encoding: 'utf8', timeout: 120_000, env: { ...process.env, INIT_CWD: root } });
  const json = JSON.parse(r.stdout) as { width: number; height: number; errors: unknown[] };
  expect(json.errors).toEqual([]);
  return json;
}

/** Chromium's picture of `page` (an html file) at w×h, transparent where nothing is drawn. */
async function render(file: string, w: number, h: number, png: string): Promise<void> {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await page.goto(`file://${file}`);
  await page.waitForFunction(() => [...document.images].every((i) => i.complete) && document.readyState === 'complete');
  await page.screenshot({ path: png, omitBackground: true });
  await page.close();
}

/** Mean |a − b| over RGB composited on black and on white (alpha counted), 0..255. */
async function meanDiff(a: string, b: string): Promise<number> {
  const sharp = (await import('sharp')).default;
  const A = await sharp(a).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const B = await sharp(b).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  expect([B.info.width, B.info.height]).toEqual([A.info.width, A.info.height]);
  let sum = 0;
  let n = 0;
  for (let i = 0; i < A.data.length; i += 4) {
    for (const bg of [0, 255]) {
      for (let c = 0; c < 3; c++) {
        const x = (A.data[i + c] * A.data[i + 3] + bg * (255 - A.data[i + 3])) / 255;
        const y = (B.data[i + c] * B.data[i + 3] + bg * (255 - B.data[i + 3])) / 255;
        sum += Math.abs(x - y);
        n++;
      }
    }
  }
  return sum / n;
}

const xmlErrors = (s: string): string[] => {
  const errors: string[] = [];
  new DOMParser({ onError: (level, msg) => level !== 'warning' && errors.push(msg) }).parseFromString(s, 'image/svg+xml');
  return errors;
};

const SCENES: { name: string; scene: string; background?: string }[] = [
  // the viewer paints the module's background (trempel.view.ts) under the scene — the page does too
  { name: 'prefabs-menu', scene: 'examples/prefabs/menu.svg', background: '#141a2e' },
  { name: 'prefabs-popup', scene: 'examples/prefabs/popup-pause.svg', background: '#141a2e' },
  { name: 'motion', scene: 'examples/motion/scene.svg' },
  { name: 'collections', scene: 'examples/collections/game/scene.svg' },
];

describe('flatten — vanilla SVG in Chromium vs view:shot', () => {
  for (const s of SCENES) {
    it(
      `${s.name}: <img src=out.svg> (--embed) and the file itself ≤ 2/255 from view:shot; XML; no tml:/data-/@`,
      async () => {
        const ref = join(tmp, `${s.name}-shot.png`);
        const { width, height } = shot(s.scene, ref);

        const embedded = flattenFile({ scene: resolve(root, s.scene), out: join(tmp, `${s.name}-embed.svg`), embed: true });
        expect(embedded.errors).toEqual([]);
        const text = readFileSync(embedded.out!, 'utf8');
        expect(xmlErrors(text)).toEqual([]);
        expect(flattenLeftovers(text)).toEqual([]);
        expect(text.match(/\shref="(?!data:)[^"]*"/g) ?? []).toEqual([]); // one self-contained file
        const bg = s.background ?? 'transparent';
        const html = join(tmp, `${s.name}.html`);
        writeFileSync(html, `<!doctype html><body style="margin:0;background:${bg}"><img src="${s.name}-embed.svg" width="${width}" height="${height}" style="display:block"></body>`);
        const img = join(tmp, `${s.name}-img.png`);
        await render(html, width, height, img);
        expect(await meanDiff(ref, img)).toBeLessThanOrEqual(2);

        const linked = flattenFile({ scene: resolve(root, s.scene), out: join(tmp, 'out', `${s.name}.svg`) });
        expect(linked.errors).toEqual([]);
        const ltext = readFileSync(linked.out!, 'utf8');
        expect(flattenLeftovers(ltext)).toEqual([]);
        const html2 = join(tmp, 'out', `${s.name}.html`);
        writeFileSync(html2, `<!doctype html><body style="margin:0;background:${bg}">${ltext.replace(/^<\?xml[^>]*>/, '').replace('<svg ', `<svg width="${width}" height="${height}" style="display:block" `)}</body>`);
        const direct = join(tmp, `${s.name}-direct.png`);
        await render(html2, width, height, direct);
        expect(await meanDiff(ref, direct)).toBeLessThanOrEqual(2);
      },
      T,
    );
  }
});
