// Synthetic round feeds on a 3×3 field (letters A–E, S — a scatter of the test game), the headless
// loop stepping and a small choreography for the player.
import { GameLoop } from '@trempel/kit/testing';
import type { RoundFeed, Transform } from '../src/feed/types.js';

export const step = (kind: string, n: number, context?: string, flags: Record<string, unknown> = {}): Transform => ({ type: 'step', value: { kind, n, ...flags }, ...(context ? { context } : {}) });
const t = (type: string, value: unknown, context?: string): Transform => ({ type, value, ...(context ? { context } : {}) }) as Transform;
export { t };

export const LOSE_GRID = [['A', 'B', 'C'], ['D', 'E', 'A'], ['B', 'C', 'D']];
export const LINE_GRID = [['A', 'B', 'C'], ['A', 'E', 'D'], ['A', 'C', 'D']];
export const FS_GRID = [['S', 'B', 'C'], ['D', 'S', 'A'], ['B', 'C', 'S']];

export const feed = (name: string, transforms: Transform[], buy: string | null = null): RoundFeed => ({ name, buy, transforms });

export const LOSE = feed('lose', [step('spin', 0), t('frameInit', LOSE_GRID)]);

/** Line 0 (top row) of A pays 2 bets. */
export const LINES = feed('lines', [step('spin', 0), t('frameInit', LINE_GRID), t('paylines', [{ lineId: '0', line: [0, 0, 0], value: 200 }]), t('win', 200)]);

/** 3 scatters → 2 free spins, the first retriggers +1, three free spins played; a line win in each. */
export const FREE = feed('free', [
  step('spin', 0),
  t('frameInit', FS_GRID),
  t('frameHits', [{ positions: [{ reel: 0, row: 0 }, { reel: 1, row: 1 }, { reel: 2, row: 2 }], symbol: 'S', multiplier: 0, value: 0 }]),
  t('switchToMode', 'freeSpins'),
  step('freeSpin', 1, 'freeSpins'),
  t('spinsLeft', 2, 'freeSpins'),
  t('frameInit', FS_GRID, 'freeSpins'),
  t('frameHits', [{ positions: [{ reel: 0, row: 0 }, { reel: 1, row: 1 }, { reel: 2, row: 2 }], symbol: 'S', multiplier: 0, value: 0 }], 'freeSpins'),
  step('freeSpin', 2, 'freeSpins'),
  t('spinsLeft', 2, 'freeSpins'),
  t('frameInit', LINE_GRID, 'freeSpins'),
  t('paylines', [{ lineId: '0', line: [0, 0, 0], value: 300 }], 'freeSpins'),
  t('win', 300, 'freeSpins'),
  step('freeSpin', 3, 'freeSpins'),
  t('spinsLeft', 1, 'freeSpins'),
  t('frameInit', LINE_GRID, 'freeSpins'),
  t('paylines', [{ lineId: '0', line: [0, 0, 0], value: 1500 }], 'freeSpins'),
  t('win', 1500, 'freeSpins'),
  t('roundFinished', 1800),
]);

/** Step the loop at 60 fps until the promise settles; returns seconds of loop time. */
export async function run<T>(loop: GameLoop, p: Promise<T>, max = 120): Promise<number> {
  const t0 = loop.time;
  let done = false;
  let err: unknown;
  p.then(() => (done = true), (e) => ((done = true), (err = e)));
  while (!done) {
    if (loop.time - t0 > max) throw new Error('did not settle');
    loop.step(1 / 60);
    await new Promise((r) => setTimeout(r, 0));
  }
  if (err) throw err;
  return loop.time - t0;
}

/** A neutral choreography for the player tests: spin, land, lines, count-up, banners. */
export const CHOREO = `# $seq spin
$skip: on
| id   | t   | dur     | target | action     | sync  | skip |
|------|-----|---------|--------|------------|-------|------|
| go   | 0   |         | reels  | reels:spin | parallel |      |
| hold | 0   | minSpin |        | wait       | await | now  |

# $seq land
$skip: on
| id   | t            | target | action     | value       | sync  | skip |
|------|--------------|--------|------------|-------------|-------|------|
| stop | 0            | reels  | reels:stop | grid = grid | parallel | now  |
| done | poll: landed |        | wait       |             | await |      |

# $seq lines
$skip: on
| id   | each        | t           | dur     | target | action      | value         | sync  | skip |
|------|-------------|-------------|---------|--------|-------------|---------------|-------|------|
| one  | k=0..count-1| lineStep * k|         | lines  | lines:show  | line = lines[k] | parallel |      |
| hold |             | 0           | showAll |        | wait        |               | await | now  |

# $seq count
$skip: on
| id  | t | dur     | target | action    | value          | ease   | sync  | skip |
|-----|---|---------|--------|-----------|----------------|--------|-------|------|
| win | 0 | countUp | state  | tween:win | win: from → to | linear | await | now  |

# $seq banner
$skip: on
| id   | t | dur    | action | sync  | skip |
|------|---|--------|--------|-------|------|
| hold | 0 | banner | wait   | await | now  |

# $seq big
$skip: on
| id  | t | dur    | target | action       | value             | sync  | skip |
|-----|---|--------|--------|--------------|-------------------|-------|------|
| up  | 0 | bigUp  | state  | tween:bigWin | bigWin: from → to | await | now  |

# $consts
| name     | normal | quick | turbo |
|----------|--------|-------|-------|
| minSpin  | 600    | 300   | 100   |
| lineStep | 300    | 150   | 50    |
| showAll  | 1000   | 500   | 200   |
| countUp  | 800    | 400   | 100   |
| banner   | 1500   | 800   | 300   |
| bigUp    | 2000   | 1000  | 300   |
`;

export const BINDINGS = { 'step:spin': 'spin', 'step:freeSpin': 'spin', frame: 'land', lines: 'lines', stepWin: 'count', spinWin: 'count', fsStart: 'banner', fsEnd: 'banner', bigWin: 'big' };
