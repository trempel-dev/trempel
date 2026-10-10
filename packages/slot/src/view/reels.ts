// reels.ts — what the choreography's slot rows move (`reels:*`, `lines:*`, slot/actions.ts): the
// reels and the win lines. The real view is pixi-reels in the scene's `#reels` plus the lines drawn
// into the scene's empty `#lines`; the headless one keeps the grid and takes loop time like the real
// reels (tests, headless round runs). Over the reels (the component's overlay): expanded wilds (a panel
// on the whole reel with the multiplier) and the frames of teased reels — gone on the next spin.

import { Assets, Container, Graphics, Sprite, Text, type Texture } from 'pixi.js';
import type { GameLoop, Tweens } from '@trempel/kit';
import type { Pos } from '../feed/types.js';
import type { ReelGridInstance } from '../reels/component.js';
import type { SymbolLook } from '../reels/symbol.js';
import { TIMINGS, type SpeedMode, type SpinTimings } from '../round/timings.js';

/** A line to draw: its paying cells, its index (colour), its id (the full path in PixiReelsParts.paths). */
export interface LineDraw {
  cells: Pos[];
  index: number;
  lineId?: string;
  /** The line's multiplier (expanded wilds on it): above 1 — a `×N` badge at its end. */
  mult?: number;
}

/** A wild taking a whole reel. */
export interface ExpandDraw {
  reel: number;
  /** The wild's letter (its look). */
  symbol: string;
  /** Above 1 — a `×N` badge on the panel. */
  mult: number;
  /** Seconds the panel grows over the reel (0 — at once). */
  dur?: number;
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
  /** Reels landed since the last spin, left to right (all of them when none spins). */
  readonly landedReels: number;
  /** A wild takes the whole reel (a panel over it with the multiplier); removed by the next spin. */
  expand(e: ExpandDraw): void;
  /** Frame a reel that is teased (anticipation) until it lands. */
  tease(reel: number): void;
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
  /** Symbol looks (expanded wild panels) and the asset table of their textures. */
  looks?: Record<string, SymbolLook>;
  resolve?: (href: string) => string;
  /** The game's tweens (a panel grows over its reel); without them it shows at once. */
  tweens?: Tweens;
}

const badge = (text: string, size: number, color: number): Container => {
  const c = new Container();
  const t = new Text({ text, style: { fill: 0xffffff, fontSize: size, fontWeight: 'bold', fontFamily: 'sans-serif', stroke: { color: 0x000000, width: Math.max(2, size / 8) } } });
  t.anchor.set(0.5);
  const w = Math.max(t.width + size * 0.6, size * 1.6);
  const g = new Graphics().roundRect(-w / 2, -size * 0.7, w, size * 1.4, size * 0.7).fill(color).stroke({ color: 0xffffff, width: Math.max(2, size / 10) });
  c.addChild(g, t);
  c.label = 'mult';
  return c;
};

/** The reels of a mounted slot scene (pixi-reels) + its `#lines` group. */
export function pixiReels(p: PixiReelsParts): ReelsView {
  const rs = p.reels.reelSet;
  const timings = p.timings ?? TIMINGS;
  let mode: SpeedMode = 'normal';
  let spinning: Promise<unknown> | null = null;
  let slamPending = false;
  const overlay = p.reels.overlay;
  const landedSet = new Set<number>();
  const teased = new Map<number, Graphics>();
  rs.events.on('spin:reelLanded', (reel: number) => {
    landedSet.add(reel);
    teased.get(reel)?.destroy();
    teased.delete(reel);
  });
  /** A reel's box in the reels' (= overlay's) coordinates. */
  const reelBox = (reel: number) => {
    const a = rs.getCellBounds(reel, 0);
    const b = rs.getCellBounds(reel, p.reels.rows - 1);
    return { x: a.x, y: a.y, w: a.width, h: b.y + b.height - a.y };
  };
  const clearOverlay = () => {
    for (const ch of overlay.removeChildren()) ch.destroy({ children: true });
    teased.clear();
  };

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
      landedSet.clear();
      clearOverlay();
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
    get landedReels() {
      return view.landed ? p.reels.cols : landedSet.size;
    },
    expand(e) {
      const box = reelBox(e.reel);
      const look = p.looks?.[e.symbol] ?? {};
      const panel = new Container();
      panel.label = `expand-${e.reel}`;
      panel.position.set(box.x + box.w / 2, box.y + box.h / 2);
      const bg = new Graphics()
        .roundRect(-box.w / 2 + 3, -box.h / 2 + 3, box.w - 6, box.h - 6, Math.min(box.w, box.h) * 0.12)
        .fill({ color: look.color ?? 0x7e2553, alpha: look.texture ? 0.85 : 1 })
        .stroke({ color: 0xffec27, width: 6 });
      panel.addChild(bg);
      const tex = look.texture ? Assets.get<Texture>((p.resolve ?? ((x: string) => x))(look.texture)) : undefined;
      if (tex) {
        const sp = new Sprite(tex);
        sp.anchor.set(0.5);
        sp.scale.set(Math.min((box.w * 0.92) / tex.width, (box.h * 0.6) / tex.height));
        panel.addChild(sp);
      } else {
        const label = look.label ?? e.symbol;
        const t = new Text({ text: label, style: { fill: look.labelColor ?? 0xffffff, fontSize: Math.floor(Math.min(box.h * 0.3, (box.w * 0.85) / Math.max(1, label.length * 0.62))), fontWeight: 'bold', fontFamily: 'sans-serif' } });
        t.anchor.set(0.5);
        panel.addChild(t);
      }
      if (e.mult > 1) {
        const m = badge(`×${e.mult}`, Math.floor(Math.min(box.w * 0.3, 44)), 0xff004d);
        m.position.set(0, box.h / 2 - Math.min(box.w * 0.3, 44));
        panel.addChild(m);
      }
      overlay.addChild(panel);
      if (e.dur && p.tweens) {
        panel.scale.set(1, 0);
        void p.tweens.to(panel.scale, { y: 1 }, e.dur, 'outBack');
      }
    },
    tease(reel) {
      if (teased.has(reel) || landedSet.has(reel)) return;
      const box = reelBox(reel);
      const g = new Graphics().roundRect(box.x - 4, box.y - 4, box.w + 8, box.h + 8, 12).stroke({ color: 0xffec27, width: 8, alpha: 0.9 });
      g.label = `tease-${reel}`;
      overlay.addChild(g);
      teased.set(reel, g);
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
        const color = LINE_COLORS[l.index % LINE_COLORS.length];
        g.stroke({ width: 8, color, alpha: 0.9, cap: 'round', join: 'round' });
        p.lines.addChild(g);
        if ((l.mult ?? 1) > 1) {
          // on the last paying cell: where the line's win ends
          const last = l.cells.reduce((a, c) => (c.reel > a.reel ? c : a), l.cells[0]);
          const at = last ? cellCenter(last) : pts[pts.length - 1];
          const m = badge(`×${l.mult}`, Math.round(Math.min(p.reels.cellW, p.reels.cellH) * 0.28), color);
          m.position.set(at.x, at.y);
          p.lines.addChild(m);
        }
      }
      win(lines.flatMap((l) => l.cells));
    },
    highlight: win,
    clearLines() {
      for (const ch of p.lines.removeChildren()) ch.destroy({ children: true });
      for (const r of rs.reels) for (let i = 0; i < p.reels.rows; i++) r.getSymbolAt(i).stopAnimation();
    },
  };
  return view;
}

export interface HeadlessReels extends ReelsView {
  /** Calls in order (spin / stop / slam / set / lines / highlight / clear). */
  readonly log: string[];
}

/**
 * Reels without Pixi: reel k of a stop lands `0.2 + (k + 1) × stopDelay` s of loop time after it (a
 * teased reel later by the mode's anticipation), all of them at once after slam.
 */
export function headlessReels(loop: GameLoop, initial: string[][], timings: Record<SpeedMode, SpinTimings> = TIMINGS): HeadlessReels {
  let shown = initial.map((c) => [...c]);
  let mode: SpeedMode = 'normal';
  let spinning = false;
  let landAts: number[] = [];
  let target: string[][] | null = null;
  let slamPending = false;
  let landedCount = 0;
  const land = () => {
    if (target) shown = target.map((c) => [...c]);
    target = null;
    spinning = false;
    landAts = [];
    landedCount = shown.length;
  };
  loop.add(() => {
    if (!spinning || !landAts.length) return;
    while (landedCount < landAts.length && loop.gameTime >= landAts[landedCount]) landedCount++;
    if (landedCount >= landAts.length) land();
  });
  const view: HeadlessReels = {
    log: [],
    spin(m) {
      mode = m;
      spinning = true;
      slamPending = false;
      landAts = [];
      landedCount = 0;
      view.log.push(`spin ${m}`);
    },
    stop(grid, o = {}) {
      if (!spinning) view.spin(mode);
      const delay = o.stopDelay ?? timings[mode].stopDelay;
      target = grid;
      let at = loop.gameTime + 0.2;
      landAts = grid.map((_, k) => (at += delay + (o.anticipation?.includes(k) ? timings[mode].anticipation : 0)));
      view.log.push(`stop${o.anticipation?.length ? ` tease ${o.anticipation.join(',')}` : ''}`);
      if (slamPending) land();
    },
    get landed() {
      return !spinning;
    },
    get landedReels() {
      return spinning ? landedCount : shown.length;
    },
    expand(e) {
      view.log.push(`expand ${e.reel} ${e.symbol} x${e.mult}`);
    },
    tease(reel) {
      view.log.push(`tease ${reel}`);
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
      view.log.push(`lines ${lines.map((l) => ((l.mult ?? 1) > 1 ? `${l.index}x${l.mult}` : l.index)).join(',')}`);
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
