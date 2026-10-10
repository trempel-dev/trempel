// component.ts — the reels as a Trempel component: `<tml:ref id="reels" tml:type="reel-grid"/>`
// on an empty `<g id="reels"/>` of the base (contract: empty="true"), on pixi-reels 3.x (pinned by major).
// Geometry: tml:cols/rows/cellw/cellh/gapx/gapy on the heir, or — so that a reskin changes only
// the BASE — plain data attributes on the base node: data-cols, data-rows, data-cellw, data-cellh,
// data-gapx, data-gapy (the base stays sterile: no tml:*). Heir wins over base.
// The grid as data: with `grid` (the slot config's) the field has that many reels and rows; a base that
// gives the box of the field (data-width / data-height) fits the cells into it, so one skin serves any
// grid; a base laid out cell by cell (cols / rows) must match the grid — otherwise E_SLOT_SKIN.
// Time: the kit's ticker adapter (game loop). pixi-reels animates its reels with GSAP (its peer
// dependency); this package does not import GSAP — it moves the instance pixi-reels resolved onto the
// game loop (driveGsapWithTicker), so a platform pause freezes the reels with the rest of the game.

import { Container, type Ticker } from 'pixi.js';
import { ReelSetBuilder, SpeedPresets, driveGsapWithTicker, type ReelSet, type SpeedProfile } from 'pixi-reels';
import type { ComponentFactory } from '@trempel/scene';
import type { GameLoop, KitServices } from '@trempel/kit';
import { GameSymbol, type SymbolLook } from './symbol.js';

export interface ReelGridInstance {
  root: Container;
  reelSet: ReelSet;
  /** Over the reels (expanded wilds, teased reels' frames — slot/view/reels.ts). */
  overlay: Container;
  cols: number;
  rows: number;
  cellW: number;
  cellH: number;
  gapX: number;
  gapY: number;
}

export interface ReelGridOptions {
  /** Symbol ids and their looks. */
  symbols: Record<string, SymbolLook>;
  /** Weights of the random strip shown while spinning (default: equal). */
  weights?: Record<string, number>;
  /** Initial grid [col][row] (default: random). */
  initial?: string[][];
  /** RNG of the spinning strip (only the look of the spin; outcomes come from the round feed). */
  rng?: () => number;
  /** Speed profiles by mode over pixi-reels' presets (normal / quick / turbo). */
  speeds?: Partial<Record<'normal' | 'quick' | 'turbo', Partial<SpeedProfile>>>;
  /** The field size of the game (default: the scene's cols / rows). */
  grid?: { reels: number; rows: number };
}

/** A pixi-reels speed profile between normal and turbo. */
export const QUICK: SpeedProfile = { ...SpeedPresets.NORMAL, name: 'quick', spinDelay: 60, spinSpeed: 40, stopDelay: 70, bounceDuration: 350, minimumSpinTime: 250 } as SpeedProfile;

const num = (v: string | undefined, d: number): number => (v != null && v !== '' ? Number(v) : d);

const driven = new WeakSet<GameLoop>();

/** Drive pixi-reels' GSAP from this loop (once per loop). */
function driveOnLoop(loop: GameLoop): void {
  if (driven.has(loop)) return;
  driven.add(loop);
  driveGsapWithTicker(loop.ticker as unknown as Ticker);
}

export function reelGrid(kit: KitServices, opts: ReelGridOptions): ComponentFactory {
  return (ctx) => {
    const a = ctx.attrs;
    const g: Record<string, string | undefined> = {};
    for (const k of ['cols', 'rows', 'cellw', 'cellh', 'gapx', 'gapy', 'width', 'height']) g[k] = ctx.tml[k] ?? a[`data-${k}`];
    const want = opts.grid;
    const cols = want?.reels ?? num(g.cols, 5);
    const rows = want?.rows ?? num(g.rows, 3);
    if (want && ((g.cols && num(g.cols, 0) !== cols && !g.width) || (g.rows && num(g.rows, 0) !== rows && !g.height))) {
      throw new Error(`E_SLOT_SKIN: the scene lays the reels out for ${g.cols}×${g.rows}, the game is ${cols}×${rows} (give the field's box: data-width / data-height)`);
    }
    const gapX = num(g.gapx, 0);
    const gapY = num(g.gapy, 0);
    const cellW = g.width ? (num(g.width, 0) - gapX * (cols - 1)) / cols : num(g.cellw, 160);
    const cellH = g.height ? (num(g.height, 0) - gapY * (rows - 1)) / rows : num(g.cellh, 160);
    const ids = Object.keys(opts.symbols);
    if (!ids.length) throw new Error('reel-grid: no symbols');
    driveOnLoop(kit.loop);
    const sp = opts.speeds ?? {};
    const builder = new ReelSetBuilder()
      .reels(cols)
      .visibleCells(rows)
      .symbolSize(cellW, cellH)
      .symbolGap(gapX, gapY)
      .symbols((r) => {
        for (const id of ids) r.register(id, GameSymbol, { looks: opts.symbols, resolve: kit.resolve, tweens: kit.tweens });
      })
      .weights(opts.weights ?? Object.fromEntries(ids.map((id) => [id, 10])))
      .speed('normal', { ...SpeedPresets.NORMAL, ...sp.normal } as SpeedProfile)
      .speed('quick', { ...QUICK, ...sp.quick } as SpeedProfile)
      .speed('turbo', { ...SpeedPresets.TURBO, ...sp.turbo } as SpeedProfile)
      .ticker(kit.loop.ticker as unknown as Ticker);
    if (opts.rng) builder.rng(opts.rng);
    if (opts.initial) builder.initialFrame(opts.initial.map((visible) => ({ visible })));
    const reelSet = builder.build();
    const root = new Container();
    root.label = 'reel-grid';
    const overlay = new Container();
    overlay.label = 'reel-overlay';
    root.addChild(reelSet, overlay);
    const inst: ReelGridInstance = { root, reelSet, overlay, cols, rows, cellW, cellH, gapX, gapY };
    return inst;
  };
}
