// state.ts — the slot's reactive state: the standard heir (SLOT_HEIR) and the popups bind to it, the
// round player writes it. Money in currency (the feed's credits × bet / betCredits).

export type SlotPhase = 'idle' | 'spin' | 'stop' | 'win' | 'cascade' | 'bigwin' | 'fsIntro' | 'fsOutro';

export interface SlotState {
  phase: SlotPhase;
  balance: number;
  bet: number;
  bets: number[];
  /** Win of the current round so far (currency). */
  win: number;
  /** Amount shown by the big-win popup (counts up). */
  bigWin: number;
  /** Big win level being shown ('' — none): a name of the game's levels, or 'max'. */
  bigWinTier: string;
  /** Free spins: index of the current one and the total awarded (0 = not in free spins). */
  fsIndex: number;
  fsTotal: number;
  fsWin: number;
  /** Mode of the spin being played ('' — the base game). */
  mode: string;
  turbo: boolean;
  /** Autoplay spins left (0 = off). */
  auto: number;
  /** A round is in flight (the spin button shows STOP). */
  busy: boolean;
  /** Name of the feed being played (fixture name, round id). */
  round: string;
}

export function initialSlotState(o: Partial<SlotState> = {}): SlotState {
  const bets = o.bets ?? [0.2, 0.5, 1, 2, 5, 10];
  return { phase: 'idle', balance: 1000, bet: bets[2] ?? bets[0], bets, win: 0, bigWin: 0, bigWinTier: '', fsIndex: 0, fsTotal: 0, fsWin: 0, mode: '', turbo: false, auto: 0, busy: false, round: '', ...o };
}
