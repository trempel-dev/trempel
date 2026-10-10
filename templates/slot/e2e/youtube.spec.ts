// youtube.spec.ts — the YOUTUBE build under Playables' CSP, ytgame SDK stubbed. No probe: the spin
// button point comes from the kit's layout math (the default skin: 720×1280, the button at 360, 1050).

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
