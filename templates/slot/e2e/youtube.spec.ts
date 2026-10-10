// youtube.spec.ts — the YOUTUBE build under Playables' CSP, ytgame SDK stubbed. No probe: the spin
// button point comes from the kit's layout math (the default skin: 720×1280, the button at 360, 1050).

import { readFileSync, readdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { SDK_URL, enforceCsp, refToScreen, stubYoutube, waitYt, watchLocalStorage } from '@trempel/kit/e2e';
import { YT_PORT } from '../playwright.config';

test.use({ baseURL: `http://localhost:${YT_PORT}/` });

test('boots under CSP without unsafe-eval; a spin saves the balance via saveData; no localStorage/outbound', async ({ page }) => {
  const errors: string[] = [];
  const external: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    if (new URL(r.url()).hostname !== 'localhost' && r.url() !== SDK_URL) external.push(r.url());
  });
  await stubYoutube(page);
  await enforceCsp(page);
  await watchLocalStorage(page);
  await page.goto('./');
  await waitYt(page, 'gameReady');
  await page.waitForTimeout(300);
  const spin = refToScreen(page.viewportSize()!, { w: 720, h: 1280, maxAspect: 0.75 }, 360, 1050, [0.5, 1]);
  await page.mouse.click(spin.x, spin.y);
  await page.waitForFunction(() => (window as any).__yt.saved !== '', undefined, { timeout: 20000 });
  // The game's data is the save file's `game` space (the kit's settings are apart).
  const saved = JSON.parse(await page.evaluate(() => (window as any).__yt.saved)).game;
  expect(saved.v).toBe(1);
  expect(saved.balance).toBe(999); // the first normal-spin fixture (01-lose) at a bet of 1
  await page.evaluate(() => {
    const y = (window as any).__yt.cbs;
    y.pause();
    y.resume();
  });
  expect(await page.evaluate(() => (window as any).__ls)).toBe(0);
  expect(await page.evaluate(() => (window as any).__csp)).toEqual([]);
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});

test('every normal round of the fixtures plays in the YouTube build (turbo): the choreography to the saved balance', async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await stubYoutube(page);
  await enforceCsp(page);
  await page.goto('./');
  await waitYt(page, 'gameReady');
  await page.waitForTimeout(300);
  const size = page.viewportSize()!;
  const ref = { w: 720, h: 1280, maxAspect: 0.75 };
  const turbo = refToScreen(size, ref, 130, 1145, [0.5, 1]);
  const spin = refToScreen(size, ref, 360, 1050, [0.5, 1]);
  await page.mouse.click(turbo.x, turbo.y);
  // the source plays the normal-spin fixtures in order (a buy is not a press of SPIN)
  const dir = new URL('../fixtures/', import.meta.url);
  const rounds = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(new URL(f, dir), 'utf8')) as { name: string; buy?: string; transforms: { type: string; value: number }[] })
    .filter((r) => !r.buy);
  let balance = 1000;
  for (const r of rounds) {
    balance = Math.round((balance - 1 + r.transforms.find((t) => t.type === 'roundFinished')!.value / 100) * 100) / 100;
    await page.mouse.click(spin.x, spin.y);
    await page.waitForFunction((b) => {
      const s = (window as any).__yt.saved;
      return s !== '' && JSON.parse(s).game.balance === b;
    }, balance, { timeout: 60000 });
    await page.waitForTimeout(300); // the round closes after its save: the next press must not be its skip
  }
  expect(balance).toBe(1000 - rounds.length + 0.5 + 2.5 + 20 + 6.5 + 2 + 5 + 45 + 120);
  expect(await page.evaluate(() => (window as any).__csp)).toEqual([]);
  expect(errors).toEqual([]);
});
