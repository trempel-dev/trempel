// fixtures.mjs — the template's synthetic rounds, written by hand as data below and turned into round
// feeds (docs/feed.md of @trempel/slot) in fixtures/*.json. Nothing here is math: every grid, every
// paying line and its value is chosen by hand; the script only spells the feed out (step markers, the
// free-spin counter, the totals) and checks the hand data is coherent (a paying line's cells hold one
// letter, scatters are where the hits say).
//
//   node scripts/fixtures.mjs        (npm run fixtures)

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(join(root, 'slot.json'), 'utf8'));
const LINES = config.lines;
const MODE = 'freeSpins';

// Grids are grid[reel][row], rows top-down. Letters: A–E pay on lines, S — the scatter.
const g = (...reels) => reels.map((r) => r.split(''));

/** A spin: its grid, the paying lines (lineId → credits), scatters that award free spins. */
const ROUNDS = [
  { name: '01-lose', note: 'no win', spins: [{ grid: g('ABC', 'DEA', 'BCD') }] },
  { name: '02-line', note: 'the middle line of A pays half a bet', spins: [{ grid: g('BAC', 'DAE', 'CAD'), lines: { 0: 50 } }] },
  { name: '03-lines', note: 'the top line of B and the bottom line of C', spins: [{ grid: g('BAC', 'BEC', 'BDC'), lines: { 1: 150, 2: 100 } }] },
  { name: '04-big', note: 'every line of E: a big win (20 bets)', spins: [{ grid: g('EEE', 'EEE', 'EEE'), lines: { 0: 400, 1: 400, 2: 400, 3: 400, 4: 400 } }] },
  {
    name: '05-free',
    note: 'three scatters → 3 free spins, the second retriggers +2; five free spins',
    spins: [
      { grid: g('SBC', 'DSA', 'BCS'), award: 3 },
      { grid: g('ABC', 'DEA', 'BCD') },
      { grid: g('SAC', 'DSE', 'ACS'), award: 2, lines: {} },
      { grid: g('BAC', 'DAE', 'CAD'), lines: { 0: 150 } },
      { grid: g('ABC', 'DEA', 'BCD') },
      { grid: g('DCA', 'DCB', 'DCE'), lines: { 1: 300, 0: 200 } },
    ],
  },
  {
    name: '06-buy',
    note: 'bought free spins (50 bets): the buy spin lands three scatters, 3 free spins',
    buy: 'fs',
    spins: [
      { grid: g('SAB', 'CSD', 'EAS'), award: 3 },
      { grid: g('EAD', 'EBD', 'ECD'), lines: { 1: 400, 2: 250 } },
      { grid: g('ABC', 'DEA', 'BCD') },
      { grid: g('BAC', 'DAE', 'CAD'), lines: { 0: 150 } },
    ],
  },
];

const fail = (round, msg) => {
  throw new Error(`fixtures: ${round}: ${msg}`);
};

function feed(r) {
  const out = [];
  const ctx = (o, free) => (free ? { ...o, context: MODE } : o);
  let left = 0; // free spins left after the current one
  let inFs = false;
  let total = 0;
  r.spins.forEach((s, n) => {
    const free = inFs;
    const kind = n === 0 ? (r.buy ? 'buy' : 'spin') : free ? 'freeSpin' : 'spin';
    if (n > 0 && !free) fail(r.name, `spin ${n} after the round ended`);
    out.push(ctx({ type: 'step', value: { kind, n } }, free));
    if (free) out.push(ctx({ type: 'spinsLeft', value: left }, true));
    if (s.grid.length !== config.grid.reels || s.grid.some((c) => c.length !== config.grid.rows)) fail(r.name, `spin ${n}: not ${config.grid.reels}×${config.grid.rows}`);
    out.push(ctx({ type: 'frameInit', value: s.grid }, free));
    if (s.award) {
      const positions = [];
      s.grid.forEach((col, reel) => col.forEach((sym, row) => sym === 'S' && positions.push({ reel, row })));
      if (positions.length < 3) fail(r.name, `spin ${n} awards free spins with ${positions.length} scatters`);
      out.push(ctx({ type: 'frameHits', value: [{ positions, symbol: 'S', multiplier: 0, value: 0 }] }, free));
    }
    const lines = Object.entries(s.lines ?? {}).map(([lineId, value]) => {
      const rows = LINES[lineId];
      if (!rows) fail(r.name, `spin ${n}: no line "${lineId}" in slot.json`);
      const syms = rows.map((row, reel) => s.grid[reel][row]);
      if (new Set(syms).size !== 1) fail(r.name, `spin ${n}: line ${lineId} holds ${syms.join('')}`);
      return { lineId, line: rows, value };
    });
    if (lines.length) {
      const win = lines.reduce((a, l) => a + l.value, 0);
      out.push(ctx({ type: 'paylines', value: lines }, free));
      out.push(ctx({ type: 'win', value: win }, free));
      total += win;
    }
    if (s.award && !free) {
      out.push({ type: 'switchToMode', value: MODE });
      inFs = true;
      left = s.award;
    } else if (free) {
      left = left - 1 + (s.award ?? 0);
      if (left === 0) inFs = false;
    }
  });
  if (inFs) fail(r.name, `${left} free spins left at the end`);
  out.push({ type: 'roundFinished', value: total });
  return { name: r.name, note: r.note, ...(r.buy ? { buy: r.buy } : {}), transforms: out };
}

const dir = join(root, 'fixtures');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
for (const r of ROUNDS) {
  const f = feed(r);
  // one transform per line: the feed reads top-down like the round
  const { transforms, ...head } = f;
  const body = transforms.map((t) => `    ${JSON.stringify(t)}`).join(',\n');
  writeFileSync(join(dir, `${r.name}.json`), `${JSON.stringify(head, null, 2).slice(0, -2)},\n  "transforms": [\n${body}\n  ]\n}\n`);
  console.log(`fixtures/${r.name}.json — ${f.transforms.length} transforms, total ${f.transforms.at(-1).value} credits`);
}
