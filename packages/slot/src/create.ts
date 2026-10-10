// create.ts — createSlot(): everything a slot game wires into createGame in one object, from DATA — the
// slot config (grid, lines, bets, bindings, speeds), the symbol looks (feed letters → art), a round
// source and a choreography. attach() builds the reels view, the Director and the round player on the
// mounted scene and opens the slot popups from the state.
//
//   const slot = createSlot({ config, symbols, source: fixtureSource(files), choreo: loadChoreo(md) });
//   const game = await createGame({ state: slot.state, components: slot.components, actions: slot.actions,
//     screens: { slot: { base, heir: SLOT_HEIR, contract: SLOT_CONTRACT } },
//     popups: { fsIntro: { base: fsIntroBase, ...SLOT_POPUPS.fsIntro }, fsOutro: …, bigwin: … }, start: 'slot' });
//   slot.attach(game);

import type { ComponentFactory } from '@trempel/scene';
import { Director, kitActions, type Choreo, type Game, type KitServices } from '@trempel/kit';
import type { Container } from 'pixi.js';
import type { BigWinLevels, Extension, PlanOptions, StepKinds } from './feed/plan.js';
import type { RoundSource } from './feed/source.js';
import { RoundPlayer, type Bindings, type Hook } from './player.js';
import { slotActions } from './actions.js';
import { reelGrid, type ReelGridInstance, type ReelGridOptions } from './reels/component.js';
import type { SymbolLook } from './reels/symbol.js';
import { TIMINGS, type SpeedMode, type SpinTimings } from './round/timings.js';
import { initialSlotState, type SlotState } from './state.js';
import { pixiReels, type ReelsView } from './view/reels.js';
import { SLOT_POPUP_NAMES, slotPopupOf, type SlotPopupName } from './hud/scenes.js';

/** A symbol's look as data (JSON): colours as numbers or '#rrggbb'. */
export interface SymbolLookData {
  texture?: string;
  color?: number | string;
  label?: string;
  labelColor?: number | string;
}

/** The slot config — data of the game (a JSON file), not code. */
export interface SlotConfig {
  /** Field size; every frame of every feed must have it. */
  grid: { reels: number; rows: number };
  /** Paylines: lineId → the row on every reel (a won line is drawn across the whole field). */
  lines?: Record<string, number[]>;
  /** Weights of the spinning strip by letter (the look of the spin only). */
  weights?: Record<string, number>;
  /** The first grid on the reels, grid[reel][row] (default: random letters). */
  initial?: string[][];
  balance?: number;
  bets?: number[];
  bet?: number;
  /** Credits of one bet in the feeds (default 100). */
  betCredits?: number;
  /** Cost in bets of every buy the feeds may name (`spin` — 1). */
  costs?: Record<string, number>;
  /** Big win levels ×bet of the round total (default big 15, mega 40, epic 100). */
  bigWin?: BigWinLevels;
  /** Modes `switchToMode` may name (default: any). */
  modes?: string[];
  /** The game's step kinds by role (default: spin / buy / freeSpin / cascade, respin). */
  kinds?: Partial<StepKinds>;
  /** Book events → choreography sequences (see player.ts). */
  bindings: Bindings;
  /** Reels' feel per speed mode (stop delay, anticipation, pixi-reels profile). */
  timings?: Partial<Record<SpeedMode, Partial<SpinTimings>>>;
  /** pixi-reels speed profiles over its presets. */
  speeds?: ReelGridOptions['speeds'];
  /** Autoplay rounds of the AUTO button (default 10). */
  autoSpins?: number;
  /** A sound cue played when a reel lands ('' — none, the choreography plays it; default 'stop', a kit synth preset). */
  reelStopSound?: string;
  /** Expanding wilds: letter → multiplier (`frameExpandedWild` → the `expand` event, line multipliers). */
  wilds?: Record<string, number>;
  /** Letters a frame lists in its `marks` var (what lands with a show: scatters, wilds). */
  marks?: string[];
  /** Anticipation: reels after `count` of `symbols` have landed are teased (a frame's `tease` var). */
  tease?: { symbols: string[]; count: number };
}

export interface SlotOptions {
  config: SlotConfig;
  /** Feed letter → look (the skin's symbols file). */
  symbols: Record<string, SymbolLookData>;
  source: RoundSource;
  choreo: Choreo;
  /** The game's own events (see player.ts). */
  hooks?: Record<string, Hook>;
  /** Handlers of the game's own transforms (PlanOptions.extend). */
  extend?: Record<string, Extension>;
  /** Initial state over the config's balance / bets. */
  state?: Partial<SlotState>;
  creditWins?: boolean;
  onRoundEnd?: RoundPlayerHook;
}

type RoundPlayerHook = ConstructorParameters<typeof RoundPlayer>[0]['onRoundEnd'];

export interface SlotIds {
  screen?: string;
  reels?: string;
  lines?: string;
}

export interface Slot {
  readonly state: SlotState;
  readonly components: (kit: KitServices) => Record<string, ComponentFactory>;
  readonly actions: Record<string, () => void>;
  /** Build the reels view, the director and the round player on the mounted scene; once, after createGame. */
  attach(game: Game<SlotState, object>, ids?: SlotIds): RoundPlayer;
  readonly player: RoundPlayer;
  readonly reels: ReelsView;
}

const colour = (v: number | string | undefined): number | undefined => (typeof v === 'string' ? parseInt(v.replace(/^#/, ''), 16) : v);

/** Symbol looks of the data file → the reels' looks. */
export function symbolLooks(data: Record<string, SymbolLookData>): Record<string, SymbolLook> {
  const out: Record<string, SymbolLook> = {};
  for (const [id, d] of Object.entries(data)) out[id] = { texture: d.texture, color: colour(d.color), label: d.label, labelColor: colour(d.labelColor) };
  return out;
}

/** The plan options of a config (+ the game's transform handlers). */
export function planOptions(config: SlotConfig, extend?: Record<string, Extension>): PlanOptions {
  return { betCredits: config.betCredits, costs: config.costs, bigWin: config.bigWin, grid: config.grid, modes: config.modes, kinds: config.kinds, wilds: config.wilds, extend };
}

export function createSlot(o: SlotOptions): Slot {
  const cfg = o.config;
  const bets = o.state?.bets ?? cfg.bets;
  const state = initialSlotState({ ...(cfg.balance !== undefined ? { balance: cfg.balance } : {}), ...(bets ? { bets } : {}), ...(cfg.bet !== undefined ? { bet: cfg.bet } : {}), ...o.state });
  const timings = Object.fromEntries((Object.keys(TIMINGS) as SpeedMode[]).map((m) => [m, { ...TIMINGS[m], ...cfg.timings?.[m] }])) as Record<SpeedMode, SpinTimings>;
  const looks = symbolLooks(o.symbols);
  for (const row of cfg.initial ?? []) for (const id of row) if (!looks[id]) throw new Error(`E_SLOT_CONFIG: initial grid letter "${id}" has no look`);
  if (cfg.initial && (cfg.initial.length !== cfg.grid.reels || cfg.initial.some((c) => c.length !== cfg.grid.rows))) throw new Error(`E_SLOT_CONFIG: the initial grid is not ${cfg.grid.reels}×${cfg.grid.rows}`);
  for (const id of [...Object.keys(cfg.wilds ?? {}), ...(cfg.marks ?? []), ...(cfg.tease?.symbols ?? [])]) if (!looks[id]) throw new Error(`E_SLOT_CONFIG: letter "${id}" (wilds / marks / tease) has no look`);
  let resolve: ((href: string) => string) | undefined;
  let player: RoundPlayer | null = null;
  let reels: ReelsView | null = null;
  const ctl = () => {
    if (!player) throw new Error('E_SLOT_ATTACH: call slot.attach(game) after createGame');
    return player;
  };
  return {
    state,
    components: (kit) => {
      resolve = kit.resolve;
      return { 'reel-grid': reelGrid(kit, { symbols: looks, weights: cfg.weights, initial: cfg.initial, speeds: cfg.speeds, grid: cfg.grid }) };
    },
    actions: {
      spinOrStop: () => void ctl().spinOrStop(),
      skip: () => ctl().skip(),
      betUp: () => ctl().betUp(),
      betDown: () => ctl().betDown(),
      toggleTurbo: () => ctl().toggleTurbo(),
      toggleAuto: () => ctl().autoplay(ctl().state.auto > 0 ? 0 : (cfg.autoSpins ?? 10)),
    },
    attach(game, ids = {}) {
      if (player) return player;
      const screen = game.screen(ids.screen ?? 'slot');
      const grid = screen.component<ReelGridInstance>(ids.reels ?? 'reels');
      const view = pixiReels({ reels: grid, lines: screen.byId<Container>(ids.lines ?? 'lines'), timings, paths: cfg.lines, looks, resolve, tweens: game.tweens });
      const nodes = [...screen.scene.byId.keys()];
      reels = view;
      const stopSound = cfg.reelStopSound ?? 'stop';
      if (stopSound) grid.reelSet.events.on('spin:reelLanded', () => game.sound.play(stopSound));
      const director = new Director({
        choreo: o.choreo,
        loop: game.loop,
        actions: {
          ...kitActions({
            scene: screen.scene,
            target: (name) => (name === 'state' ? game.state : (screen.scene.byId.get(name) as object | undefined)),
            tweens: game.tweens,
            clips: game.clips,
            fx: game.fx,
            sound: game.sound,
          }),
          ...slotActions(() => view),
        },
        globals: {
          get landed() {
            return view.landed;
          },
          get landedReels() {
            return view.landedReels;
          },
          nodes,
        },
      });
      player = new RoundPlayer({
        state: game.state,
        loop: game.loop,
        source: o.source,
        director,
        bindings: cfg.bindings,
        hooks: o.hooks,
        plan: planOptions(cfg, o.extend),
        creditWins: o.creditWins,
        onRoundEnd: o.onRoundEnd,
        onSkip: () => view.slam(),
        marks: cfg.marks,
        tease: cfg.tease,
      });
      bindSlotPopups(game);
      player.idle();
      return player;
    },
    get player() {
      return ctl();
    },
    get reels() {
      if (!reels) throw new Error('E_SLOT_ATTACH: call slot.attach(game) after createGame');
      return reels;
    },
  };
}

/**
 * Open/close the slot popups (fsIntro, fsOutro, bigwin) from the state, every UI frame: the popup the
 * state wants (slotPopupOf) is open, the other slot popups are closed. Only popups declared in
 * createGame take part (a game may declare a subset). Returns a function that stops it.
 */
export function bindSlotPopups(game: Game<SlotState, object>): () => void {
  const declared = new Set(game.popups.names());
  const names = SLOT_POPUP_NAMES.filter((n) => declared.has(n));
  if (!names.length) return () => {};
  let shown: SlotPopupName | null = null;
  const tick = () => {
    const want = slotPopupOf(game.state);
    const next = want && declared.has(want) ? want : null;
    if (next === shown) return;
    if (shown) void game.close(shown);
    shown = next;
    if (next) game.popup(next);
  };
  return game.loop.add(tick, 'ui');
}
