// slot.spec.ts — the web build: real clicks on the HUD (points from the read-only probe), rounds picked
// from the fixtures through cheats (?cheat=1): a lost spin, lines, free spins, a big win, a buy; the
// choreography of a slot with lines by its log — wilds and multipliers, reels landing one by one, the
// anticipation, idle cycling, quickstop / skip, the big win levels; the 5×3 variant.

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
  expect(log.filter((e) => e.action === 'lines:show' && e.seq === 'lines.show')).toHaveLength(2);
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

type Ev = { t: number; seq: string; row: string; action: string };
const log = (page: Page) => page.evaluate(() => (window as any).__trempel.cheats.log() as Ev[]);

test('wilds: each takes its reel with its multiplier, the line through two ×2 shows ×4; the character reacts', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('./?cheat=1');
  await waitGame(page);
  await fixture(page, '08-wild-x4');
  await page.keyboard.press('Space');
  await page.waitForFunction(() => (window as any).__trempel.state().phase === 'win');
  await idle(page);
  expect(await state(page)).toMatchObject({ win: 5, balance: 1000 - 1 + 5 });
  const l = await log(page);
  const seqs = (s: string) => l.filter((e) => e.seq === s && e.row === '^').length;
  expect(l.filter((e) => e.action === 'reels:expand')).toHaveLength(2);
  expect(seqs('wild.expand')).toBe(2);
  expect(seqs('character.react.wild')).toBe(2);
  expect(seqs('character.react.win')).toBe(1);
  expect(l.filter((e) => e.action === 'lines:show' && e.seq === 'lines.show')).toHaveLength(5);
  expect(errors).toEqual([]);
});

test('5×3: the reels land one by one, the scatters tease the reels after them, the wild ×2 on reel 3; idle cycles the lines until the next spin', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('./?cheat=1&grid=5x3');
  await waitGame(page);
  await fixture(page, '05-scatter');
  await page.keyboard.press('Space');
  await idle(page);
  let l = await log(page);
  const lands = l.filter((e) => e.seq === 'reel.stop' && e.row === '^').map((e) => e.t);
  expect(lands).toHaveLength(5);
  expect(new Set(lands).size).toBe(5);
  expect(l.filter((e) => e.seq === 'anticipation' && e.row === '^')).toHaveLength(3);
  expect(l.some((e) => e.seq === 'scatter.hit')).toBe(true);
  expect((await state(page)).win).toBe(3);

  await fixture(page, '03-wild-x2');
  await page.keyboard.press('Space');
  await idle(page);
  expect((await state(page)).win).toBe(4);
  // idle: the won line cycles until the next spin
  await page.waitForFunction(() => ((window as any).__trempel.cheats.log() as Ev[]).filter((e) => e.seq === 'lines.cycle' && e.row === '^').length >= 2, undefined, { timeout: 15000 });
  await fixture(page, '01-lose');
  await page.keyboard.press('Space');
  await page.waitForFunction(() => (window as any).__trempel.state().phase === 'spin');
  l = await log(page);
  const start = l.filter((e) => e.seq === 'spin.start' && e.row === '^').at(-1)!;
  expect(l.filter((e) => e.seq === 'lines.cycle' && e.row === 'one' && e.t > start.t)).toEqual([]);
  await idle(page);
  expect(errors).toEqual([]);
});

test('a stop press while the reels spin plays the quickstop; a press in the wins — the skip; the big win levels have their own sequences', async ({ page }) => {
  test.setTimeout(180_000); // two big win levels play in full — a slow CI runner needs more than the default minute
  await page.goto('./?cheat=1');
  await waitGame(page);
  await fixture(page, '09-mega');
  await page.keyboard.press('Space');
  await page.waitForFunction(() => (window as any).__trempel.state().phase === 'spin');
  await page.keyboard.press('Space');
  await page.waitForFunction(() => (window as any).__trempel.state().phase === 'win', undefined, { timeout: 20000 });
  await page.keyboard.press('Space'); // the lines (the big win popup, once open, takes the input itself)
  await idle(page);
  const l = await log(page);
  expect(l.some((e) => e.seq === 'quickstop')).toBe(true);
  expect(l.some((e) => e.seq === 'skip')).toBe(true);
  expect(l.some((e) => e.seq === 'bigwin.mega')).toBe(true);
  expect((await state(page)).win).toBe(45);
  await fixture(page, '10-epic');
  await click(page, 'turboBtn');
  await page.keyboard.press('Space');
  await page.waitForFunction(() => (window as any).__trempel.state().round === '10-epic');
  await idle(page);
  expect((await log(page)).some((e) => e.seq === 'bigwin.epic')).toBe(true);
  expect((await state(page)).win).toBe(120);
});
