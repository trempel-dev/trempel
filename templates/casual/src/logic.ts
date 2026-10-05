// logic.ts — the game's RULES, pure (no Pixi, no kit): unit-tested in test/logic.test.ts.
// Replace with your game. Stub: tap the target before the timer runs out; GOAL taps wins.

export const GOAL = 10;
export const TIME = 15;
/** Coins for a won round (paid into the wallet service). */
export const REWARD = 10;

export interface Round {
  score: number;
  time: number;
  over: boolean;
  won: boolean;
}

export const newRound = (): Round => ({ score: 0, time: TIME, over: false, won: false });

/** A tap on the target. */
export function hit(r: Round): Round {
  if (r.over) return r;
  const score = r.score + 1;
  return { ...r, score, over: score >= GOAL, won: score >= GOAL };
}

/** Time passes. */
export function tick(r: Round, dt: number): Round {
  if (r.over) return r;
  const time = Math.max(0, r.time - dt);
  return { ...r, time, over: time === 0, won: false };
}

/** Coins earned by a finished round. */
export const reward = (r: Round): number => (r.won ? REWARD : 0);

/** Stars for the result screen: 0 on a loss, 1–3 by the time left on a win. */
export function stars(r: Round): number {
  if (!r.won) return 0;
  return r.time > TIME * 0.5 ? 3 : r.time > TIME * 0.2 ? 2 : 1;
}
