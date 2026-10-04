// game.spec.ts — the web build, driven by REAL mouse/touch/keyboard input at screen points the
// read-only probe reports (window.__trempel). Cheats only where a scenario needs a state.

import { expect, test, type Page } from '@playwright/test';
import { probe, waitGame } from '@trempel/kit/e2e';

async function click(page: Page, screen: string, id: string): Promise<void> {
  await page.waitForFunction(([s, i]) => (window as any).__trempel.node(s, i)?.visible, [screen, id]);
  const n = await probe<{ x: number; y: number }>(page, 'node', screen, id);
  await page.mouse.click(n.x, n.y);
}

const state = (page: Page) => probe<Record<string, unknown>>(page, 'state');
const settledPopup = (page: Page, name: string | null) => page.waitForFunction((n) => (window as any).__trempel.popup() === n, name);

test('menu → game → taps score → pause/resume → win → best survives reload', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('./?cheat=1');
  await waitGame(page);
  expect(await probe(page, 'screen')).toBe('menu');

  await click(page, 'menu', 'playBtn');
  await page.waitForFunction(() => (window as any).__trempel.screen() === 'game');
  await page.waitForTimeout(400);

  // Tap the target (mouse), then touch.
  await click(page, 'game', 'target');
  await page.waitForFunction(() => (window as any).__trempel.state().score === 1);
  expect(await probe(page, 'fx')).toBeGreaterThan(0);
  const t = await probe<{ x: number; y: number }>(page, 'node', 'game', 'target');
  await page.waitForTimeout(300);
  const t2 = await probe<{ x: number; y: number }>(page, 'node', 'game', 'target');
  await page.touchscreen.tap(t2.x, t2.y);
  await page.waitForFunction(() => (window as any).__trempel.state().score === 2);
  void t;

  // Keyboard pause: time stops, popup opens; resume button closes it.
  await page.keyboard.press('Escape');
  await settledPopup(page, 'pause');
  const time0 = (await state(page)).time as number;
  await page.waitForTimeout(600);
  expect((await state(page)).time).toBe(time0);
  await page.waitForTimeout(400);
  await click(page, 'pause', 'resumeBtn');
  await settledPopup(page, null);
  await page.waitForTimeout(500);
  expect((await state(page)).time).toBeLessThan(time0);

  // Win (cheat seeds 9 taps) → result popup, best saved.
  await page.evaluate(() => (window as any).__trempel.cheats.win());
  await settledPopup(page, 'result');
  expect(await state(page)).toMatchObject({ won: true, score: 10, best: 10 });
  expect(await probe(page, 'save')).toMatchObject({ best: 10 });

  await page.reload();
  await waitGame(page);
  expect((await state(page)).best).toBe(10);
  expect(errors).toEqual([]);
});

test('lose → play again restarts; settings toggle sound and persist', async ({ page }) => {
  await page.goto('./?cheat=1');
  await waitGame(page);
  await page.keyboard.press('Enter'); // action key starts from the menu
  await page.waitForFunction(() => (window as any).__trempel.screen() === 'game');
  await page.evaluate(() => (window as any).__trempel.cheats.lose());
  await settledPopup(page, 'result');
  expect((await state(page)).won).toBe(false);
  await page.waitForTimeout(400);
  await click(page, 'result', 'restartBtn');
  await settledPopup(page, null);
  expect((await state(page)).score).toBe(0);
  expect((await state(page)).time as number).toBeGreaterThan(14);

  await page.keyboard.press('Escape');
  await settledPopup(page, 'pause');
  await page.waitForTimeout(400);
  await click(page, 'pause', 'settingsBtn');
  await settledPopup(page, 'settings');
  await page.waitForTimeout(400);
  await click(page, 'settings', 'sfxToggle');
  await page.waitForFunction(() => (window as any).__trempel.kit().sfx === 0);
  await page.reload();
  await waitGame(page);
  expect((await probe<{ sfx: number }>(page, 'kit')).sfx).toBe(0);
});

test('v0.1 layout: resize after load (regression), playfield under the HUD, safe area, loading overlay', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('./?cheat=1');
  await waitGame(page);
  // The loading overlay covered the boot and is gone once the game is ready.
  await page.waitForFunction(() => (window as any).__trempel.overlay('loading') === false);
  await click(page, 'menu', 'playBtn');
  await page.waitForFunction(() => (window as any).__trempel.screen() === 'game');

  type L = { playfield: { x: number; y: number; w: number; h: number }; safe: { top: number }; width: number; height: number };
  const layout = () => probe<L>(page, 'layout');
  const node = (screen: string, id: string) => probe<{ x: number; y: number; w: number; h: number }>(page, 'node', screen, id);
  const check = async () => {
    const l = await layout();
    const pause = await node('game', 'pauseBtn');
    const field = await node('game', 'fieldBg');
    // The HUD is above the playfield; the world fills it (margin 20 design units).
    expect(pause.y + pause.h / 2).toBeLessThanOrEqual(l.playfield.y + 1);
    expect(field.y - field.h / 2).toBeGreaterThanOrEqual(l.playfield.y - 1);
    expect(field.y + field.h / 2).toBeLessThanOrEqual(l.playfield.y + l.playfield.h + 1);
    return l;
  };
  const before = await check();

  // Resize after load: the kit's handler must not throw (1682766), and the game's layout runs.
  await page.setViewportSize({ width: 900, height: 600 });
  await page.waitForFunction((w) => (window as any).__trempel.layout().width !== w, before.width);
  const land = await check();
  expect(land.playfield.w).toBeLessThan(900); // portrait column ≤ 3:4 on a landscape window
  await page.setViewportSize({ width: 414, height: 800 });
  await page.waitForFunction(() => (window as any).__trempel.layout().width === 414);

  // A notch: the HUD moves down inside the safe area, the playfield shrinks by it.
  const pause0 = await node('game', 'pauseBtn');
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--trempel-safe-top', '44px');
    (window as any).__trempel.relayout();
  });
  const notch = await check();
  expect(notch.safe.top).toBe(44);
  expect((await node('game', 'pauseBtn')).y).toBeCloseTo(pause0.y + 44, 0);
  expect(notch.playfield.y).toBeCloseTo(before.playfield.y + 44, 0);
  expect(errors).toEqual([]);
});
