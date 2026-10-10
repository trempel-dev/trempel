// @trempel/slot — a slot on @trempel/kit: the reels (pixi-reels as a scene component), the round player
// that plays a round feed through choreography bound by data, the standard HUD heir and popups.
// The round feed itself (types, plan, sources) — `@trempel/slot/feed`, re-exported here.

export { createSlot, bindSlotPopups, symbolLooks, planOptions } from './create.js';
export type { Slot, SlotConfig, SlotOptions, SlotIds, SymbolLookData } from './create.js';

export { RoundPlayer, eventKey } from './player.js';
export type { Bindings, Hook, HookApi, RoundPlayerOptions } from './player.js';
export { slotActions } from './actions.js';

export { initialSlotState } from './state.js';
export type { SlotState, SlotPhase } from './state.js';
export { TIMINGS } from './round/timings.js';
export type { SpinTimings, SpeedMode } from './round/timings.js';

export { reelGrid, QUICK } from './reels/component.js';
export type { ReelGridInstance, ReelGridOptions } from './reels/component.js';
export { GameSymbol } from './reels/symbol.js';
export type { SymbolLook, GameSymbolOptions } from './reels/symbol.js';
export { pixiReels, headlessReels } from './view/reels.js';
export type { ReelsView, HeadlessReels, LineDraw, StopOptions, PixiReelsParts } from './view/reels.js';

export {
  SLOT_HEIR,
  SLOT_CONTRACT,
  SLOT_POPUPS,
  SLOT_POPUP_NAMES,
  SLOT_FS_INTRO_HEIR,
  SLOT_FS_INTRO_CONTRACT,
  SLOT_FS_OUTRO_HEIR,
  SLOT_FS_OUTRO_CONTRACT,
  SLOT_BIGWIN_HEIR,
  SLOT_BIGWIN_CONTRACT,
  slotPopupOf,
} from './hud/scenes.js';
export type { SlotPopupName } from './hud/scenes.js';

export * from './feed/index.js';
