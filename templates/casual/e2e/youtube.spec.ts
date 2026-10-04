// youtube.spec.ts — the YOUTUBE build (dist-yt) with the ytgame SDK stubbed at its real URL and
// Playables' CSP (no unsafe-eval). No probe in this bundle: points come from the kit's layout math.

import { expect, test } from '@playwright/test';
import { SDK_URL, enforceCsp, refToScreen, stubYoutube, waitYt, watchLocalStorage } from '@trempel/kit/e2e';
import { YT_PORT } from '../playwright.config';

test.use({ baseURL: `http://localhost:${YT_PORT}/` });

test('boots under CSP without unsafe-eval, SDK lifecycle, saves via saveData, no localStorage/outbound', async ({ page }) => {
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
  const calls = await page.evaluate(() => (window as any).__yt.calls as string[]);
  expect(calls.indexOf('firstFrameReady')).toBeLessThan(calls.indexOf('gameReady'));
  expect(calls).toContain('loadData');
  expect(Object.keys(await page.evaluate(() => (window as any).__yt.cbs)).sort()).toEqual(['audio', 'pause', 'resume']);
  expect(await page.evaluate(() => typeof (window as any).__trempel)).toBe('undefined');

  // Menu → settings (icon top-right, anchored "1 0") → sound toggle (settings popup: content at the
  // centre, toggle at +210,−230) → saved through ytgame.saveData. Reference 720×1280, fitMin,
  // portrait column ≤ 0.75.
  const vp = page.viewportSize()!;
  const ref = { w: 720, h: 1280, maxAspect: 0.75 };
  await page.waitForTimeout(500);
  const settings = refToScreen(vp, ref, 640, 80, [1, 0]);
  await page.mouse.click(settings.x, settings.y);
  await page.waitForTimeout(600);
  const sfx = refToScreen(vp, ref, 360 + 210, 640 - 230, [0.5, 0.5]);
  await page.mouse.click(sfx.x, sfx.y);
  await page.waitForFunction(() => (window as any).__yt.saved !== '');
  expect(JSON.parse(await page.evaluate(() => (window as any).__yt.saved))).toMatchObject({ v: 1, sfx: 0, best: 0 });

  // Platform pause/resume/audio callbacks don't throw.
  await page.evaluate(() => {
    const y = (window as any).__yt.cbs;
    y.pause();
    y.audio(false);
    y.resume();
  });
  await page.waitForTimeout(200);

  expect(await page.evaluate(() => (window as any).__ls)).toBe(0);
  expect(await page.evaluate(() => (window as any).__csp)).toEqual([]);
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
  // …and the CSP is really in force: a string timer is blocked.
  await page.evaluate(() => setTimeout('window.__evalRan = true' as never, 0));
  await page.waitForFunction(() => (window as any).__csp.length > 0);
  expect(await page.evaluate(() => (window as any).__evalRan)).toBeUndefined();
});
