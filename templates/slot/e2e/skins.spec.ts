// skins.spec.ts — the reskin gate: the same fixtures through every skin (?skin=…): each round plays to
// its money without a page error, with a shot of the round's win moment and of its end
// (test-results/shots/<skin>-<round>-*.png).

import { readdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { probe, waitGame } from '@trempel/kit/e2e';

const SKINS = readdirSync(new URL('../skins', import.meta.url));
const ROUNDS = readdirSync(new URL('../fixtures', import.meta.url)).map((f) => f.replace(/\.json$/, ''));
const TOTALS: Record<string, { cost: number; win: number }> = {
  '01-lose': { cost: 1, win: 0 },
  '02-line': { cost: 1, win: 0.5 },
  '03-lines': { cost: 1, win: 2.5 },
  '04-big': { cost: 1, win: 20 },
  '05-free': { cost: 1, win: 6.5 },
  '06-buy': { cost: 50, win: 8 },
};

for (const skin of SKINS) {
  test(`skin ${skin}: every fixture plays to its money`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize(skin === 'fruity-spin' ? { width: 960, height: 540 } : { width: 414, height: 800 });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`./?cheat=1&skin=${skin}`);
    await waitGame(page);
    await page.evaluate(() => (window as any).__trempel.cheats.balance(1000));
    let balance = 1000;
    for (const round of ROUNDS) {
      await page.evaluate((n) => (window as any).__trempel.cheats.fixture(n), round);
      if (round === '06-buy') await page.evaluate(() => (window as any).__trempel.cheats.buy());
      else await page.keyboard.press('Space');
      await page.waitForFunction((n) => (window as any).__trempel.state().round === n && (window as any).__trempel.state().busy, round);
      const t = TOTALS[round];
      if (t.win > 0) {
        await page.waitForFunction(() => ['win', 'bigwin', 'fsIntro'].includes((window as any).__trempel.state().phase), undefined, { timeout: 20000 });
        await page.screenshot({ path: `test-results/shots/${skin}-${round}-win.png` });
      }
      await page.waitForFunction(() => !(window as any).__trempel.state().busy, undefined, { timeout: 60000 });
      await page.screenshot({ path: `test-results/shots/${skin}-${round}-end.png` });
      balance = Math.round((balance - t.cost + t.win) * 100) / 100;
      const s = await probe<{ balance: number; win: number }>(page, 'state');
      expect(s, `${skin} ${round}`).toMatchObject({ balance, win: t.win });
    }
    expect(errors).toEqual([]);
  });
}
