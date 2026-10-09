// transition-sound.spec.ts — kit 2.1 on the web build: the menu turns away as a page leaf over the game
// screen (snapshots of both, input blocked, textures freed), the way back turns it back; the gate of
// the first tap — at most 20 ms of main-thread work at CPU ×4 (the audio start is not in it).

import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { probe, waitGame } from '@trempel/kit/e2e';
import sharp from 'sharp';

type Info = { active: boolean; t: number; mode: 'leaf' | 'fade'; textures: number };
const SHOTS = 'test-results/transition';
mkdirSync(SHOTS, { recursive: true });

const info = (page: Page) => probe<Info>(page, 'transition');
const settled = (page: Page) => page.waitForFunction(() => !(window as any).__trempel.transition().active, undefined, { timeout: 20000 });

async function click(page: Page, screen: string, id: string): Promise<void> {
  await page.waitForFunction(([s, i]) => (window as any).__trempel.node(s, i)?.visible, [screen, id]);
  const n = await probe<{ x: number; y: number }>(page, 'node', screen, id);
  await page.mouse.click(n.x, n.y);
}

/** Pixel spread of a screenshot (0 — one flat colour). */
async function spread(png: Buffer): Promise<number> {
  const st = await sharp(png).stats();
  return Math.max(...st.channels.slice(0, 3).map((c) => c.stdev));
}

/** Mean absolute difference of two screenshots, 0..255. */
async function diff(a: Buffer, b: Buffer): Promise<number> {
  const [x, y] = await Promise.all([a, b].map((p) => sharp(p).removeAlpha().raw().toBuffer()));
  let s = 0;
  for (let i = 0; i < x.length; i++) s += Math.abs(x[i] - y[i]);
  return s / x.length;
}

test('menu → game turns as a page leaf: the middle is a real frame, input waits, snapshots are freed; back turns it back', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('./?cheat=1');
  await waitGame(page);
  await page.waitForTimeout(300);
  const menu = await page.screenshot();
  await page.evaluate(() => (window as any).__trempel.cheats.slowTransitions(8));
  await click(page, 'menu', 'playBtn');
  await page.waitForFunction(() => (window as any).__trempel.transition().t > 0.4);
  const mid = await info(page);
  expect(mid).toMatchObject({ active: true, mode: 'leaf', textures: 2 });
  // A tap under the turning leaf reaches nothing (the game screen's target, the menu's settings).
  // Tapped first, while the leaf surely turns (a slow CI runner may finish the turn during the shot).
  const kit0 = await probe<{ popup: string }>(page, 'kit');
  const settings = await probe<{ x: number; y: number }>(page, 'node', 'menu', 'settingsBtn');
  await page.mouse.click(settings.x, settings.y);
  const tapped = await info(page);
  expect((await probe<{ popup: string }>(page, 'kit')).popup).toBe(kit0.popup);
  const shot = await page.screenshot({ path: `${SHOTS}/leaf-mid.png` });
  expect(await spread(shot)).toBeGreaterThan(10);
  expect(await diff(shot, menu)).toBeGreaterThan(2); // the leaf moved: not the menu any more (both are dark)
  await settled(page);
  if (!tapped.active) throw new Error('the turn ended before the tap — the input-block check proved nothing');
  expect(await probe(page, 'screen')).toBe('game');
  expect(await info(page)).toMatchObject({ active: false, textures: 0 });
  const after = await page.screenshot();
  expect(await diff(after, shot)).toBeGreaterThan(2);

  // Back to the menu: the leaf comes back — the phase goes down.
  await page.evaluate(() => (window as any).__trempel.cheats.lose());
  await page.waitForFunction(() => (window as any).__trempel.popup() === 'result');
  await page.waitForTimeout(400);
  await click(page, 'result', 'menuBtn');
  await page.waitForFunction(() => (window as any).__trempel.transition().active);
  const t0 = (await info(page)).t;
  await page.waitForTimeout(500);
  expect((await info(page)).t).toBeLessThan(t0);
  await settled(page);
  expect(await probe(page, 'screen')).toBe('menu');
  expect(await info(page)).toMatchObject({ active: false, textures: 0 });
  expect(errors).toEqual([]);
});

test('?transition=fade: the same switch as a cross-fade of the snapshots', async ({ page }) => {
  await page.goto('./?cheat=1&transition=fade');
  await waitGame(page);
  await page.evaluate(() => (window as any).__trempel.cheats.slowTransitions(6));
  await click(page, 'menu', 'playBtn');
  await page.waitForFunction(() => (window as any).__trempel.transition().active);
  expect((await info(page)).mode).toBe('fade');
  await settled(page);
  expect(await probe(page, 'screen')).toBe('game');
  expect((await info(page)).textures).toBe(0);
});

test('gate: the first tap is ≤ 20 ms of main-thread work at CPU ×4 (no audio start, no synthesis in it)', async ({ page }) => {
  await page.goto('./');
  await waitGame(page);
  await page.waitForTimeout(800); // the kit warms the audio context after boot — not under the tap
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  // Every listener of a pointer event runs between a window capture listener (first) and a window
  // bubble listener (last); long tasks after it — the deferred work — are recorded too.
  await page.evaluate(() => {
    const w = window as any;
    w.__tap = { spans: [] as { type: string; ms: number }[], long: [] as number[] };
    for (const type of ['pointerdown', 'pointerup', 'click']) {
      let t0 = 0;
      window.addEventListener(type, () => (t0 = performance.now()), { capture: true });
      window.addEventListener(type, () => w.__tap.spans.push({ type, ms: performance.now() - t0 }));
    }
    new PerformanceObserver((l) => l.getEntries().forEach((e) => w.__tap.long.push(e.duration))).observe({ type: 'longtask', buffered: false });
  });
  // An empty spot of the menu: the tap does nothing but the kit's own first-gesture work.
  const vp = page.viewportSize()!;
  await page.mouse.click(vp.width * 0.15, vp.height * 0.92);
  await page.waitForTimeout(1500);
  const r = await page.evaluate(() => (window as any).__tap as { spans: { type: string; ms: number }[]; long: number[] });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  const worst = Math.max(...r.spans.map((s) => s.ms));
  console.log(`first tap at CPU ×4: ${r.spans.map((s) => `${s.type} ${s.ms.toFixed(1)} ms`).join(', ')}; long tasks after: ${r.long.map((d) => d.toFixed(0)).join(', ') || 'none'}`);
  expect(r.spans.map((s) => s.type)).toEqual(expect.arrayContaining(['pointerdown', 'pointerup']));
  expect(worst).toBeLessThanOrEqual(20);
  // The deferred synthesis goes one preset per task: no long task (≥ 50 ms) after the tap.
  expect(r.long.filter((d) => d >= 50)).toEqual([]);
  // The audio is live after it (unlocked, the presets synthesized).
  await page.waitForFunction(() => (window as any).__trempel.kit().sfx === 1);
});
