// @trempel/slot/feed — the round feed: types, the field by the feed, the plan (the book a client plays)
// and the round sources. Pure, no Pixi (docs/feed.md).

export { CORE_TYPES, DEFAULT_BET_CREDITS, coreOf } from './types.js';
export type { Pos, Frame, StepMarker, DiffCell, DiffAtom, Hit, Payline, CoreTransform, CoreType, ExtraTransform, Transform, RoundFeed } from './types.js';
export { at, boardOf, lettersOf, viewOf, sameFrame, frameDiff, applyDiff, cascadeOps, letterId } from './board.js';
export type { Board, BoardCell, ReelCell, CascadeOps, ViewId } from './board.js';
export { planRound, bigWinLevel, DEFAULT_BIG_WIN, DEFAULT_KINDS, EXPAND_TRANSFORM } from './plan.js';
export type { PlanOptions, RoundPlan, BookEvent, BookEventType, StepInfo, LineWin, SpinSummary, StepKinds, BigWinLevels, Extension, ExtensionContext, Expansion } from './plan.js';
export { fixtureSource, httpSource, fnSource, feedOf } from './source.js';
export type { RoundSource, RoundRequest, FixtureFile, FixtureSource, FixtureSourceOptions, HttpSourceOptions } from './source.js';
