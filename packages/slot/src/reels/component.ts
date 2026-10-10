// component.ts — the reels as a Trempel component: `<tml:ref id="reels" tml:type="reel-grid"/>`
// on an empty `<g id="reels"/>` of the base (contract: empty="true"), on pixi-reels 3.x (pinned by major).
// Geometry: tml:cols/rows/cellw/cellh/gapx/gapy on the heir, or — so that a reskin changes only
// the BASE — plain data attributes on the base node: data-cols, data-rows, data-cellw, data-cellh,
// data-gapx, data-gapy (the base stays sterile: no tml:*). Heir wins over base.
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
  cols: number;
  rows: number;
  cellW: number;
  cellH: number;
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
    for (const k of ['cols', 'rows', 'cellw', 'cellh', 'gapx', 'gapy']) g[k] = ctx.tml[k] ?? a[`data-${k}`];
    const cols = num(g.cols, 5);
    const rows = num(g.rows, 3);
    const cellW = num(g.cellw, 160);
    const cellH = num(g.cellh, 160);
    const ids = Object.keys(opts.symbols);
    if (!ids.length) throw new Error('reel-grid: no symbols');
    driveOnLoop(kit.loop);
    const sp = opts.speeds ?? {};
    const builder = new ReelSetBuilder()
      .reels(cols)
      .visibleCells(rows)
      .symbolSize(cellW, cellH)
      .symbolGap(num(g.gapx, 0), num(g.gapy, 0))
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
    root.addChild(reelSet);
    const inst: ReelGridInstance = { root, reelSet, cols, rows, cellW, cellH };
    return inst;
  };
}
