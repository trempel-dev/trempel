// fixtures.mjs — the template's synthetic rounds, written by hand as data below and turned into round
// feeds (docs/feed.md of @trempel/slot) in fixtures/*.json (the 3×3 slot.json) and fixtures/5x3/*.json
// (slot.5x3.json). Nothing here is math: every grid, every expanded wild, every paying line and its value
// is chosen by hand; the script only spells the feed out (step markers, the free-spin counter, the
// expansions, the totals) and checks the hand data is coherent: a paying line's cells hold one letter
// (an expanded reel stands for any), every wild on a frame expands, scatters are where the hits say.
//
//   node scripts/fixtures.mjs        (npm run fixtures)

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODE = 'freeSpins';
const SCATTER = 'S';

// Grids are grid[reel][row], rows top-down. Letters: A–E pay on lines, W / V — wilds (×1 / ×2, every one
// expands on its reel), S — the scatter.
const g = (...reels) => reels.map((r) => r.split(''));

/**
 * A spin: its grid; `expand` — reels the wild takes; `lines` — lineId → credits (the line pays from the
 * first reel over all of them) or [credits, reels] (over the first `reels`); `pays` — scatter credits;
 * `award` — scatters award that many free spins.
 */
const SETS = [
  {
    config: 'slot.json',
    dir: 'fixtures',
    rounds: [
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
          { grid: g('SAC', 'DSE', 'ACS'), award: 2 },
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
      { name: '07-wild', note: 'a wild takes the middle reel: the middle line of A and the diagonal of B', spins: [{ grid: g('BAC', 'CWD', 'EAB'), expand: [1], lines: { 0: 100, 3: 100 } }] },
      { name: '08-wild-x4', note: 'two ×2 wilds take two reels: every line ×4 (5 bets)', spins: [{ grid: g('DAB', 'CVE', 'VBC'), expand: [1, 2], lines: { 0: 100, 1: 100, 2: 100, 3: 100, 4: 100 } }] },
      { name: '09-mega', note: 'a ×2 wild among E: every line ×2, mega (45 bets)', spins: [{ grid: g('EEE', 'EVE', 'EEE'), expand: [1], lines: { 0: 900, 1: 900, 2: 900, 3: 900, 4: 900 } }] },
      { name: '10-epic', note: 'two ×2 wilds among E: every line ×4, epic (120 bets)', spins: [{ grid: g('EEE', 'VEE', 'EEV'), expand: [1, 2], lines: { 0: 2400, 1: 2400, 2: 2400, 3: 2400, 4: 2400 } }] },
      { name: '11-tease', note: 'two scatters on the first reels tease the last one; it misses', spins: [{ grid: g('SAB', 'CSD', 'ABC') }] },
    ],
  },
  {
    config: 'slot.5x3.json',
    dir: 'fixtures/5x3',
    rounds: [
      { name: '01-lose', note: 'no win', spins: [{ grid: g('ABC', 'DEA', 'BCD', 'EAB', 'CDE') }] },
      { name: '02-wild', note: 'a wild takes reel 3: the V-line of A over three reels', spins: [{ grid: g('ABC', 'BAD', 'CWE', 'ADB', 'EBC'), expand: [2], lines: { 3: [100, 3] } }] },
      { name: '03-wild-x2', note: 'a ×2 wild takes reel 3: the top line of D over four reels, ×2', spins: [{ grid: g('DAB', 'DCE', 'AVC', 'DBE', 'CAB'), expand: [2], lines: { 1: [400, 4] } }] },
      { name: '04-wild-x4', note: 'two ×2 wilds take reels 2 and 3: every line ×4, the top one over four reels', spins: [{ grid: g('BAC', 'EVD', 'VCA', 'BDE', 'ACB'), expand: [1, 2], lines: { 0: [100, 3], 1: [200, 4], 2: [100, 3], 3: [100, 3], 4: [100, 3] } }] },
      { name: '05-scatter', note: 'three scatters pay 3 bets; two of them tease the reels after', spins: [{ grid: g('SAB', 'CSD', 'ABS', 'DCA', 'BAC'), pays: 300 }] },
      { name: '06-big', note: 'a ×2 wild on reel 3, the top line of E over five reels: a big win (20 bets)', spins: [{ grid: g('EEA', 'EBC', 'DVE', 'EAB', 'ECD'), expand: [2], lines: { 1: 2000 } }] },
    ],
  },
];

const fail = (round, msg) => {
  throw new Error(`fixtures: ${round}: ${msg}`);
};

function feed(r, config) {
  const LINES = config.lines;
  const wilds = config.wilds ?? {};
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
    const expanded = new Set(s.expand ?? []);
    s.grid.forEach((col, reel) => {
      const w = col.filter((sym) => sym in wilds);
      if (w.length && !expanded.has(reel)) fail(r.name, `spin ${n}: a wild on reel ${reel} does not expand`);
      if (expanded.has(reel)) {
        if (w.length !== 1) fail(r.name, `spin ${n}: reel ${reel} expands with ${w.length} wilds`);
        out.push(ctx({ type: 'frameExpandedWild', value: { positions: col.map((_, row) => ({ reel, row })), symbol: w[0] } }, free));
      }
    });
    const lines = Object.entries(s.lines ?? {}).map(([lineId, v]) => {
      const rows = LINES[lineId];
      if (!rows) fail(r.name, `spin ${n}: no line "${lineId}" in ${config.file}`);
      const [value, len] = Array.isArray(v) ? v : [v, rows.length];
      const syms = rows.slice(0, len).map((row, reel) => (expanded.has(reel) ? null : s.grid[reel][row])).filter((x) => x !== null);
      if (!syms.length || new Set(syms).size !== 1) fail(r.name, `spin ${n}: line ${lineId} holds ${syms.join('') || 'only wilds'}`);
      if (len < rows.length && !expanded.has(len) && s.grid[len][rows[len]] === syms[0]) fail(r.name, `spin ${n}: line ${lineId} goes on past reel ${len}`);
      return { lineId, line: rows.map((row, reel) => (reel < len ? row : null)), value };
    });
    if (lines.length) out.push(ctx({ type: 'paylines', value: lines }, free));
    const scatters = [];
    s.grid.forEach((col, reel) => col.forEach((sym, row) => sym === SCATTER && scatters.push({ reel, row })));
    if (s.award || s.pays) {
      if (scatters.length < 3) fail(r.name, `spin ${n}: ${scatters.length} scatters ${s.award ? 'award free spins' : 'pay'}`);
      out.push(ctx({ type: 'frameHits', value: [{ positions: scatters, symbol: SCATTER, multiplier: 0, value: s.pays ?? 0 }] }, free));
    }
    const win = lines.reduce((a, l) => a + l.value, 0) + (s.pays ?? 0);
    if (win) out.push(ctx({ type: 'win', value: win }, free));
    total += win;
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

for (const set of SETS) {
  const config = { ...JSON.parse(readFileSync(join(root, set.config), 'utf8')), file: set.config };
  const dir = join(root, set.dir);
  for (const f of set.rounds) rmSync(join(dir, `${f.name}.json`), { force: true });
  mkdirSync(dir, { recursive: true });
  for (const r of set.rounds) {
    const f = feed(r, config);
    // one transform per line: the feed reads top-down like the round
    const { transforms, ...head } = f;
    const body = transforms.map((t) => `    ${JSON.stringify(t)}`).join(',\n');
    writeFileSync(join(dir, `${r.name}.json`), `${JSON.stringify(head, null, 2).slice(0, -2)},\n  "transforms": [\n${body}\n  ]\n}\n`);
    console.log(`${set.dir}/${r.name}.json — ${f.transforms.length} transforms, total ${f.transforms.at(-1).value} credits`);
  }
}
