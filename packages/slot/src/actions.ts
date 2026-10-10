// actions.ts — the slot's choreography actions (Director `actions`, next to the kit's tween / fx /
// sound / clip / call): rows move the reels and the win lines with the data of the row's `value`.
//
//   reels:spin                 every reel spins (the row's speed mode)
//   reels:stop    grid = grid  land on the grid; `anticipation = [3, 4]`, `stopDelay = 150` (ms) optional;
//                              wait for it with a `poll: landed` row; a skip of the row slams the reels
//   reels:set     grid = grid  show the grid at once (a cascade's field, a respin result)
//   reels:slam                 land everything now
//   reels:expand  reel = reel; symbol = symbol; mult = mult   a wild takes the whole reel (grows over
//                              the row's `dur`), the multiplier on it; gone on the next spin
//   reels:tease   reel = r     frame a teased reel until it lands
//   lines:show    lines = lines | line = lines[k]   draw the line(s) (`cells`, `index`) and play the symbols
//   lines:highlight cells = cells                  play the win of these cells' symbols
//   lines:clear                remove the lines, stop the symbols
//
// Globals of the slot's director: `landed` — no reel spins (`| t: poll: landed |`); `landedReels` — reels
// landed since the spin, left to right (`poll: landedReels > k` — the moment reel k lands); `nodes` — the
// ids of the slot scene (`when: has(nodes, 'character')` — a row for a node a skin may not have).

import type { Action, ChoreoEvent, ChoreoValue } from '@trempel/kit';
import type { Pos } from './feed/types.js';
import type { LineDraw, ReelsView } from './view/reels.js';

const fail = (e: ChoreoEvent, msg: string): never => {
  throw new Error(`E_SLOT_ACTION: ${e.seq}:${e.row}: ${e.action} — ${msg}`);
};

function arg(e: ChoreoEvent, name: string): ChoreoValue | undefined {
  return e.props.find((p) => p.name === name)?.set;
}

function need(e: ChoreoEvent, name: string): ChoreoValue {
  const v = arg(e, name);
  if (v === undefined) fail(e, `no \`${name} = …\` in the row's value`);
  return v;
}

function gridOf(e: ChoreoEvent): string[][] {
  const g = need(e, 'grid');
  if (!Array.isArray(g) || g.some((c) => !Array.isArray(c))) fail(e, '`grid` is not a list of reels');
  return (g as ChoreoValue[][]).map((c) => c.map(String));
}

function cellsOf(e: ChoreoEvent, v: ChoreoValue): Pos[] {
  if (!Array.isArray(v)) fail(e, '`cells` is not a list');
  return (v as ChoreoValue[]).map((c) => {
    const o = c as { reel?: unknown; row?: unknown };
    if (!o || typeof o.reel !== 'number' || typeof o.row !== 'number') fail(e, `not a cell: ${JSON.stringify(c)}`);
    return { reel: o.reel as number, row: o.row as number };
  });
}

function lineOf(e: ChoreoEvent, v: ChoreoValue, i: number): LineDraw {
  const o = v as { cells?: ChoreoValue; index?: unknown; lineId?: unknown };
  if (!o || typeof o !== 'object') fail(e, `not a line: ${JSON.stringify(v)}`);
  const mult = (v as { mult?: unknown }).mult;
  return { cells: cellsOf(e, o.cells), index: typeof o.index === 'number' ? o.index : i, lineId: o.lineId === undefined ? undefined : String(o.lineId), mult: typeof mult === 'number' ? mult : undefined };
}

/** The slot's actions over a reels view (`reels`, `lines` prefixes). */
export function slotActions(reels: () => ReelsView): Record<string, Action> {
  return {
    reels(e, ctl, op) {
      const r = reels();
      switch (op) {
        case 'spin':
          r.spin(e.mode);
          break;
        case 'stop': {
          const anticipation = arg(e, 'anticipation');
          const delay = arg(e, 'stopDelay');
          r.stop(gridOf(e), {
            anticipation: Array.isArray(anticipation) ? anticipation.map(Number) : undefined,
            stopDelay: typeof delay === 'number' ? delay / 1000 : undefined,
          });
          ctl.signal.addEventListener('abort', () => r.slam(), { once: true });
          break;
        }
        case 'set':
          r.set(gridOf(e));
          break;
        case 'slam':
          r.slam();
          break;
        case 'expand': {
          const reel = need(e, 'reel');
          const mult = arg(e, 'mult') ?? 1;
          if (typeof reel !== 'number' || typeof mult !== 'number') fail(e, '`reel` and `mult` are numbers');
          r.expand({ reel: reel as number, symbol: String(need(e, 'symbol')), mult: mult as number, dur: Number.isFinite(e.dur) ? e.dur / 1000 : 0 });
          break;
        }
        case 'tease': {
          const reel = need(e, 'reel');
          if (typeof reel !== 'number') fail(e, '`reel` is not a number');
          r.tease(reel as number);
          break;
        }
        default:
          fail(e, `unknown reels action "${op}" (known: spin, stop, set, slam, expand, tease)`);
      }
    },
    lines(e, _ctl, op) {
      const r = reels();
      switch (op) {
        case 'show': {
          const all = arg(e, 'lines');
          const one = arg(e, 'line');
          if (all === undefined && one === undefined) fail(e, 'no `lines = …` or `line = …` in the row\'s value');
          const list = all !== undefined ? (Array.isArray(all) ? all : fail(e, '`lines` is not a list')) : [one as ChoreoValue];
          r.showLines(list.map((v, i) => lineOf(e, v, i)));
          break;
        }
        case 'highlight':
          r.highlight(cellsOf(e, need(e, 'cells')));
          break;
        case 'clear':
          r.clearLines();
          break;
        default:
          fail(e, `unknown lines action "${op}" (known: show, highlight, clear)`);
      }
    },
  };
}
