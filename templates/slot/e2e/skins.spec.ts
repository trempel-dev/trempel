// skins.spec.ts — the reskin gate: the same fixtures through every skin (?skin=…): each round plays to
// its money without a page error, with a shot of the round's win moment and of its end
// (test-results/shots/<skin>-<round>-*.png). The 5×3 variant (?grid=5x3) — through the skins laid out for
// any grid (the default one; Fruity Spin is drawn cell by cell for 3×3).

import { readFileSync, readdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { probe, waitGame } from '@trempel/kit/e2e';

const SKINS = readdirSync(new URL('../skins', import.meta.url));
const COSTS: Record<string, number> = { fs: 50 };

/** The rounds of a fixtures folder with their cost and win at a bet of 1 (the feed's own totals). */
function rounds(dir: string): { name: string; buy: string | null; cost: number; win: number }[] {
  const at = new URL(`../${dir}/`, import.meta.url);
  return readdirSync(at)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const r = JSON.parse(readFileSync(new URL(f, at), 'utf8')) as { name: string; buy?: string; transforms: { type: string; value: unknown }[] };
      const total = r.transforms.find((t) => t.type === 'roundFinished')!.value as number;
      return { name: r.name, buy: r.buy ?? null, cost: r.buy ? COSTS[r.buy] : 1, win: total / 100 };
    });
}

const GATES = [
  ...SKINS.map((skin) => ({ skin, grid: '', dir: 'fixtures' })),
  { skin: 'default', grid: '5x3', dir: 'fixtures/5x3' },
];

for (const { skin, grid, dir } of GATES) {
  test(`skin ${skin}${grid ? ` ${grid}` : ''}: every fixture plays to its money`, async ({ page }) => {
    test.setTimeout(400_000);
    await page.setViewportSize(skin === 'fruity-spin' ? { width: 960, height: 540 } : { width: 414, height: 800 });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`./?cheat=1&skin=${skin}${grid ? `&grid=${grid}` : ''}`);
    await waitGame(page);
    await page.evaluate(() => (window as any).__trempel.cheats.balance(1000));
    let balance = 1000;
    for (const t of rounds(dir)) {
      const tag = `${skin}${grid ? `-${grid}` : ''}-${t.name}`;
      await page.evaluate((n) => (window as any).__trempel.cheats.fixture(n), t.name);
      if (t.buy) await page.evaluate(() => (window as any).__trempel.cheats.buy());
      else await page.keyboard.press('Space');
      await page.waitForFunction((n) => (window as any).__trempel.state().round === n && (window as any).__trempel.state().busy, t.name);
      if (t.win > 0) {
        await page.waitForFunction(() => ['win', 'bigwin', 'fsIntro'].includes((window as any).__trempel.state().phase), undefined, { timeout: 20000 });
        await page.screenshot({ path: `test-results/shots/${tag}-win.png` });
      }
      await page.waitForFunction(() => !(window as any).__trempel.state().busy, undefined, { timeout: 60000 });
      await page.screenshot({ path: `test-results/shots/${tag}-end.png` });
      balance = Math.round((balance - t.cost + t.win) * 100) / 100;
      const s = await probe<{ balance: number; win: number }>(page, 'state');
      expect(s, tag).toMatchObject({ balance, win: t.win });
    }
    // the character hooks: played where the skin has the figure, silently skipped where it has not
    const log = await page.evaluate(() => (window as any).__trempel.cheats.log() as { seq: string; row: string }[]);
    const character = log.some((e) => e.seq.startsWith('character.'));
    expect(character, `${skin}: character hooks`).toBe(skin === 'default');
    expect(errors).toEqual([]);
  });
}

test('a skin laid out for 3×3 refuses the 5×3 grid loudly', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('./?skin=fruity-spin&grid=5x3');
  await expect.poll(() => errors.join('\n')).toMatch(/E_SLOT_SKIN: the scene lays the reels out for 3×3, the game is 5×3/);
});
