// slot.spec.ts — the web build: real clicks on the HUD (points from the read-only probe), rounds picked
// from the fixtures through cheats (?cheat=1): a lost spin, lines, free spins, a big win, a buy.

import { expect, test, type Page } from '@playwright/test';
import { probe, waitGame } from '@trempel/kit/e2e';

type S = { phase: string; balance: number; win: number; busy: boolean; fsTotal: number; turbo: boolean; bet: number; auto: number; round: string; bigWinTier: string };
const state = (page: Page) => probe<S>(page, 'state');
const idle = (page: Page, timeout = 30000) => page.waitForFunction(() => !(window as any).__trempel.state().busy, undefined, { timeout });
const fixture = (page: Page, name: string) => page.evaluate((n) => (window as any).__trempel.cheats.fixture(n), name);

async function click(page: Page, id: string): Promise<void> {
  const n = await probe<{ x: number; y: number }>(page, 'node', 'slot', id);
  await page.mouse.click(n.x, n.y);
}

test('spin by click: the bet charged, the round ends idle; bet steppers; the balance survives a reload', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('./?cheat=1');
  await waitGame(page);
  await click(page, 'betUp');
  expect((await state(page)).bet).toBe(2);
  await fixture(page, '01-lose');
  await click(page, 'spinBtn');
  await page.waitForFunction(() => (window as any).__trempel.state().busy);
  await idle(page);
  const s = await state(page);
  expect(s).toMatchObject({ balance: 998, phase: 'idle', round: '01-lose' });
  expect(await page.evaluate(() => (window as any).__trempel.cheats.grid())).toEqual([['A', 'B', 'C'], ['D', 'E', 'A'], ['B', 'C', 'D']]);
  await page.waitForTimeout(100);
  await page.reload();
  await waitGame(page);
  expect((await state(page)).balance).toBe(998);
  expect(errors).toEqual([]);
});

test('lines: drawn by the choreography, the win counted and credited', async ({ page }) => {
  await page.goto('./?cheat=1');
  await waitGame(page);
  await fixture(page, '03-lines');
  await page.keyboard.press('Space');
  await page.waitForFunction(() => (window as any).__trempel.state().phase === 'win');
  await idle(page);
  const s = await state(page);
  expect(s).toMatchObject({ win: 2.5, balance: 1000 - 1 + 2.5 });
  const log = await page.evaluate(() => (window as any).__trempel.cheats.log() as { seq: string; row: string; action: string }[]);
  expect(log.filter((e) => e.action === 'lines:show')).toHaveLength(2);
});

test('free spins: intro, counter, outro, back to idle; a stop press finishes fast; credited', async ({ page }) => {
  await page.goto('./?cheat=1');
  await waitGame(page);
  await fixture(page, '05-free');
  await page.keyboard.press('Space');
  await page.waitForFunction(() => (window as any).__trempel.state().phase === 'fsIntro');
  await page.waitForFunction(() => (window as any).__trempel.popup() === 'fsIntro');
  await page.waitForFunction(() => (window as any).__trempel.state().fsTotal >= 3);
  await page.waitForFunction(() => (window as any).__trempel.state().phase === 'spin');
  expect((await probe<{ visible: boolean }>(page, 'node', 'slot', 'fsBanner')).visible).toBe(true);
  await click(page, 'spinBtn'); // STOP: the reels land, the sequence jumps to its end
  await idle(page, 30000);
  const s = await state(page);
  expect(s).toMatchObject({ fsTotal: 0, win: 6.5, balance: 1000 - 1 + 6.5 });
});

test('big win popup; turbo; the bought round', async ({ page }) => {
  await page.goto('./?cheat=1');
  await waitGame(page);
  await click(page, 'turboBtn');
  expect((await state(page)).turbo).toBe(true);
  await fixture(page, '04-big');
  await click(page, 'spinBtn');
  await page.waitForFunction(() => (window as any).__trempel.state().phase === 'bigwin', undefined, { timeout: 15000 });
  await page.waitForFunction(() => (window as any).__trempel.popup() === 'bigwin');
  expect((await probe<{ visible: boolean }>(page, 'node', 'bigwin', 'bigwinAmount')).visible).toBe(true);
  await idle(page);
  await page.waitForFunction(() => (window as any).__trempel.popup() === null);
  expect((await state(page)).win).toBe(20);
  await page.evaluate(() => (window as any).__trempel.cheats.buy());
  await page.waitForFunction(() => (window as any).__trempel.state().round === '06-buy');
  await idle(page);
  expect((await state(page)).balance).toBeCloseTo(1000 - 1 + 20 - 50 + 8, 2);
});
