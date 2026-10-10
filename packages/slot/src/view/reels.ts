// reels.ts — what the choreography's slot rows move (`reels:*`, `lines:*`, slot/actions.ts): the
// reels and the win lines. The real view is pixi-reels in the scene's `#reels` plus the lines drawn
// into the scene's empty `#lines`; the headless one keeps the grid and takes loop time like the real
// reels (tests, headless round runs).

import { Container, Graphics } from 'pixi.js';
import type { GameLoop } from '@trempel/kit';
import type { Pos } from '../feed/types.js';
import type { ReelGridInstance } from '../reels/component.js';
import { TIMINGS, type SpeedMode, type SpinTimings } from '../round/timings.js';

/** A line to draw: its paying cells, its index (colour), its id (the full path in PixiReelsParts.paths). */
export interface LineDraw {
  cells: Pos[];
  index: number;
  lineId?: string;
}

export interface StopOptions {
  /** Reels to tease before they stop. */
  anticipation?: number[];
  /** Seconds between reel stops (default: the mode's timing). */
  stopDelay?: number;
}

export interface ReelsView {
  /** Start every reel spinning in this speed mode (the result comes with stop()). */
  spin(mode: SpeedMode): void;
  /** Land on grid[reel][row]; `landed` turns true when the last reel has stopped. */
  stop(grid: string[][], opts?: StopOptions): void;
  /** No reel is spinning. */
  readonly landed: boolean;
  /** Land everything now (stop press / skip). */
  slam(): void;
  /** Show this grid at once (no spin): a respin result, a cascade's field. */
  set(grid: string[][]): void;
  /** The grid shown, grid[reel][row]. */
  grid(): string[][];
  /** Draw win lines (through the given cells) and play the win of their symbols. */
  showLines(lines: LineDraw[]): void;
  /** Play the win of these symbols (pay-anywhere hits, scatters). */
  highlight(cells: Pos[]): void;
  /** Remove the lines, stop the symbols' wins. */
  clearLines(): void;
}

const LINE_COLORS = [0xffec27, 0xff004d, 0x29adff, 0x00e436, 0xffa300, 0xff77a8, 0x83769c, 0xffccaa, 0x00ffcc, 0xc2c3c7];

export interface PixiReelsParts {
  reels: ReelGridInstance;
  /** Empty scene group the win lines are drawn into. */
  lines: Container;
  timings?: Record<SpeedMode, SpinTimings>;
  /** Paylines by id (row per reel): a won line is drawn across the whole field, not only its paying cells. */
  paths?: Record<string, number[]>;
}

/** The reels of a mounted slot scene (pixi-reels) + its `#lines` group. */
export function pixiReels(p: PixiReelsParts): ReelsView {
  const rs = p.reels.reelSet;
  const timings = p.timings ?? TIMINGS;
  let mode: SpeedMode = 'normal';
  let spinning: Promise<unknown> | null = null;
  let slamPending = false;

  const cellCenter = (c: Pos): { x: number; y: number } => {
    const b = rs.getCellBounds(c.reel, c.row);
    return p.lines.toLocal(rs.toGlobal({ x: b.x + b.width / 2, y: b.y + b.height / 2 }));
  };
  const win = (cells: Pos[]) => {
    const seen = new Set<string>();
    for (const c of cells) {
      const k = `${c.reel}:${c.row}`;
      if (seen.has(k)) continue;
      seen.add(k);
      void rs.getReel(c.reel).getSymbolAt(c.row).playWin();
    }
  };
  const view: ReelsView = {
    spin(m) {
      mode = m;
      slamPending = false;
      rs.setSpeed(timings[m].reelSpeed);
      const run = rs.spin();
      spinning = run;
      run.catch(() => {}).finally(() => {
        if (spinning === run) spinning = null;
      });
    },
    stop(grid, o = {}) {
      if (!spinning) view.spin(mode);
      const delay = o.stopDelay ?? timings[mode].stopDelay;
      rs.setStopDelays(grid.map((_, i) => Math.round(i * delay * 1000)));
      if (o.anticipation?.length) rs.setAnticipation(o.anticipation);
      rs.setResult(grid.map((visible) => ({ visible })));
      if (slamPending) rs.requestSkip();
    },
    get landed() {
      return !spinning && !rs.isSpinning;
    },
    slam() {
      slamPending = true;
      if (rs.isSpinning) rs.requestSkip();
    },
    set(grid) {
      grid.forEach((col, reel) => col.forEach((id, row) => rs.setSymbolAt(reel, row, id)));
    },
    grid: () => rs.getVisibleGrid().map((col) => [...col]),
    showLines(lines) {
      for (const l of lines) {
        const path = l.lineId !== undefined ? p.paths?.[l.lineId] : undefined;
        const through = path ? path.map((row, reel) => ({ reel, row })) : l.cells;
        if (through.length < 2) continue;
        const g = new Graphics();
        const pts = through.map(cellCenter);
        g.moveTo(pts[0].x, pts[0].y);
        for (const q of pts.slice(1)) g.lineTo(q.x, q.y);
        g.stroke({ width: 8, color: LINE_COLORS[l.index % LINE_COLORS.length], alpha: 0.9, cap: 'round', join: 'round' });
        p.lines.addChild(g);
      }
      win(lines.flatMap((l) => l.cells));
    },
    highlight: win,
    clearLines() {
      for (const ch of p.lines.removeChildren()) ch.destroy();
      for (const r of rs.reels) for (let i = 0; i < p.reels.rows; i++) r.getSymbolAt(i).stopAnimation();
    },
  };
  return view;
}

export interface HeadlessReels extends ReelsView {
  /** Calls in order (spin / stop / slam / set / lines / highlight / clear). */
  readonly log: string[];
}

/** Reels without Pixi: a stop lands after `reels × stopDelay + 0.2` s of loop time (at once after slam). */
export function headlessReels(loop: GameLoop, initial: string[][], timings: Record<SpeedMode, SpinTimings> = TIMINGS): HeadlessReels {
  let shown = initial.map((c) => [...c]);
  let mode: SpeedMode = 'normal';
  let spinning = false;
  let landAt = Infinity;
  let target: string[][] | null = null;
  let slamPending = false;
  const land = () => {
    if (target) shown = target.map((c) => [...c]);
    target = null;
    spinning = false;
    landAt = Infinity;
  };
  loop.add(() => {
    if (spinning && loop.gameTime >= landAt) land();
  });
  const view: HeadlessReels = {
    log: [],
    spin(m) {
      mode = m;
      spinning = true;
      slamPending = false;
      landAt = Infinity;
      view.log.push(`spin ${m}`);
    },
    stop(grid, o = {}) {
      if (!spinning) view.spin(mode);
      const delay = o.stopDelay ?? timings[mode].stopDelay;
      target = grid;
      landAt = loop.gameTime + grid.length * delay + (o.anticipation?.length ?? 0) * timings[mode].anticipation + 0.2;
      view.log.push(`stop${o.anticipation?.length ? ` tease ${o.anticipation.join(',')}` : ''}`);
      if (slamPending) land();
    },
    get landed() {
      return !spinning;
    },
    slam() {
      view.log.push('slam');
      if (spinning && target) land();
      else if (spinning) slamPending = true;
    },
    set(grid) {
      shown = grid.map((c) => [...c]);
      view.log.push('set');
    },
    grid: () => shown.map((c) => [...c]),
    showLines(lines) {
      view.log.push(`lines ${lines.map((l) => l.index).join(',')}`);
    },
    highlight(cells) {
      view.log.push(`highlight ${cells.length}`);
    },
    clearLines() {
      view.log.push('clear');
    },
  };
  return view;
}
