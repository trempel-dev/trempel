// moments.spec.ts — the key moments of the choreography as pictures, deterministic: the page runs on
// Playwright's virtual clock (as the scene package's view:shot does — time stands still unless the test
// moves it, in frames of 1/60 s) with a seeded Math.random, a round is played from a fixture and the
// picture is taken at a logical moment of the choreography log: the reels landed, a ×2 wild on its reel,
// the lines with their ×, the big win counting. Every moment is shot twice in fresh pages — the PNGs
// must be equal bit for bit. Pictures: test-results/moments/<case>-<moment>.png.

import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const CLOCK_START = Date.UTC(2026, 0, 1);
const FRAME_MS = 1000 / 60;
/** Frames between the boot and the press. */
const PRESS_FRAMES = 120;

type Ev = { t: number; seq: string; row: string; action: string; dur: number };
/** A moment: the first log event matching, then `after` ms of choreography time. */
type Moment = { name: string; seq: string; row: string; nth?: number; after?: number | 'end' };
type Case = { name: string; query: string; fixture: string; viewport: { width: number; height: number }; moments: Moment[] };

const CASES: Case[] = [
  {
    name: '5x3',
    query: 'grid=5x3',
    fixture: '04-wild-x4',
    viewport: { width: 414, height: 800 },
    moments: [
      { name: 'stop', seq: 'spin.stop', row: 'done', after: 0 },
      { name: 'wild-x2', seq: 'wild.expand', row: 'grow', nth: 1, after: 'end' },
      { name: 'lines', seq: 'lines.show', row: 'hold', after: 0 },
    ],
  },
  {
    name: '5x3-big',
    query: 'grid=5x3',
    fixture: '06-big',
    viewport: { width: 414, height: 800 },
    moments: [{ name: 'bigwin', seq: 'bigwin.show', row: 'up', after: 1500 }],
  },
  {
    name: 'fruity-spin',
    query: 'skin=fruity-spin',
    fixture: '08-wild-x4',
    viewport: { width: 960, height: 540 },
    moments: [
      { name: 'stop', seq: 'spin.stop', row: 'done', after: 0 },
      { name: 'wild-x2', seq: 'wild.expand', row: 'grow', nth: 1, after: 'end' },
      { name: 'lines', seq: 'lines.show', row: 'hold', after: 0 },
    ],
  },
];

/** Math.random → a fixed sequence (mulberry32): the spinning strip and anything else random. */
const SEED = `(() => { let a = 20261010; Math.random = () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();`;

/** Frames land on fixed moments of the page clock (CLOCK_START + i frames, as view:shot settles), never by steps from "now". */
const frames = new WeakMap<Page, number>();
async function frame(page: Page): Promise<void> {
  const i = (frames.get(page) ?? 0) + 1;
  frames.set(page, i);
  const ahead = Math.round(CLOCK_START + i * FRAME_MS) - (await page.evaluate(() => Date.now()));
  if (ahead > 0) await page.clock.runFor(ahead);
}
const cheat = <T>(page: Page, fn: string, ...args: unknown[]) => page.evaluate(([f, a]) => (window as any).__trempel.cheats[f as string](...(a as unknown[])), [fn, args] as const) as Promise<T>;

/** Play the case in a fresh page and shoot its moments; returns the PNGs by moment. */
async function shoot(page: Page, c: Case): Promise<Record<string, Buffer>> {
  await page.setViewportSize(c.viewport);
  await page.addInitScript(SEED);
  await page.clock.install({ time: CLOCK_START - 10_000 });
  await page.clock.pauseAt(CLOCK_START);
  await page.goto(`./?cheat=1&${c.query}`);
  // boot: the loads are real — wait for them with the clock standing; a frame only when the boot waits for one
  // (so a slow load never adds frames) …
  const ready = () => page.evaluate(() => !!(window as any).__trempel?.cheats);
  for (let i = 0; i < 600 && !(await ready()); i++) {
    await page.waitForLoadState('networkidle');
    if (!(await ready())) await frame(page);
  }
  await page.waitForLoadState('networkidle'); // every texture in before the moments
  // … then a fixed number of frames to the press: it lands on the same frame of the scene's own animations
  for (let i = 0; i < PRESS_FRAMES; i++) await frame(page);
  await cheat(page, 'fixture', c.fixture);
  await page.keyboard.press('Space');
  const out: Record<string, Buffer> = {};
  for (const m of c.moments) {
    let at: number | null = null;
    for (let i = 0; i < 3000 && at === null; i++) {
      const log = await cheat<Ev[]>(page, 'log');
      const ev = log.filter((e) => e.seq === m.seq && e.row === m.row)[m.nth ?? 0];
      if (ev) at = ev.t + (m.after === 'end' ? ev.dur : (m.after ?? 0));
      else await frame(page);
    }
    expect(at, `${c.name}: ${m.seq}:${m.row}`).not.toBeNull();
    while ((await cheat<number>(page, 'now')) < at! - 1e-6) await frame(page);
    out[m.name] = await page.screenshot();
  }
  return out;
}

for (const c of CASES) {
  test(`moments of ${c.name} (${c.fixture}): the same pictures bit for bit, run after run`, async ({ browser }) => {
    test.setTimeout(240_000);
    mkdirSync('test-results/moments', { recursive: true });
    const runs: Record<string, Buffer>[] = [];
    for (let i = 0; i < 2; i++) {
      const ctx = await browser.newContext({ viewport: c.viewport, baseURL: test.info().project.use.baseURL });
      const page = await ctx.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      runs.push(await shoot(page, c));
      expect(errors).toEqual([]);
      await ctx.close();
    }
    for (const m of c.moments) {
      writeFileSync(`test-results/moments/${c.name}-${m.name}.png`, runs[0][m.name]);
      if (!runs[1][m.name].equals(runs[0][m.name])) writeFileSync(`test-results/moments/${c.name}-${m.name}.run2.png`, runs[1][m.name]);
      expect(runs[1][m.name].equals(runs[0][m.name]), `${c.name} ${m.name}: two runs differ`).toBe(true);
    }
  });
}
