// scenes.ts — the slot's standard Trempel HEIR (logic) and CONTRACT. A slot game provides only the
// sterile BASE (its look: background, frame, buttons, fonts, art) — a reskin replaces the base
// and the art, these two stay. Ids below are the contract; see the template's skins/default/slot.svg.
//
// HUD features: balance, bet with steppers, win, spin (STOP while a round runs), turbo, simple
// autoplay, free-spin counter.
//
// Overlays (free-spins intro/outro, big win) are separate POPUP scenes of the kit, not nodes of the
// main scene: `popups/fs-intro.svg`, `fs-outro.svg`, `bigwin.svg` of a skin, each with its own heir and
// contract (SLOT_POPUPS). A popup base has `#dim` (full-screen shade) and `#content` (the plaque,
// origin at its centre) — the kit's popup manager animates both. createSlot() opens and closes them
// from the state (bindSlotPopups); a game with its own round player opens them itself.
// The big win title knows the default levels (big / mega / epic) and the cap ('max'); a game with
// other level names writes its own heir.

export const SLOT_HEIR = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:tml="https://trempel.dev/ns/scene" tml:extends="slot.svg">
  <tml:ref id="reels" tml:type="reel-grid"/>
  <tml:ref id="balance" tml:bind="state.balance | money"/>
  <tml:ref id="bet" tml:bind="state.bet | money"/>
  <tml:ref id="win" tml:bind="state.win | money" tml:visible="state.win > 0"/>
  <tml:ref id="spinBtn" tml:on-click="spinOrStop()"/>
  <tml:ref id="spinLabel" tml:bind="state.busy ? 'STOP' : 'SPIN'"/>
  <tml:ref id="betUp" tml:on-click="betUp()"/>
  <tml:ref id="betDown" tml:on-click="betDown()"/>
  <tml:ref id="turboBtn" tml:on-click="toggleTurbo()"/>
  <tml:ref id="turboLabel" tml:bind="state.turbo ? 'TURBO ON' : 'TURBO'"/>
  <tml:ref id="autoBtn" tml:on-click="toggleAuto()"/>
  <tml:ref id="autoLabel" tml:bind="state.auto > 0 ? 'AUTO ' + state.auto : 'AUTO'"/>
  <tml:ref id="fsBanner" tml:visible="state.fsTotal > 0"/>
  <tml:ref id="fsCount" tml:bind="'FREE SPINS ' + state.fsIndex + ' / ' + state.fsTotal"/>
</svg>`;

export const SLOT_CONTRACT = `<contract>
  <g id="reels" empty="true"/>
  <g id="lines" empty="true"/>
  <g id="fx" empty="true"/>
  <text id="balance"/>
  <text id="bet"/>
  <text id="win"/>
  <g id="spinBtn"/>
  <text id="spinLabel"/>
  <g id="betUp"/>
  <g id="betDown"/>
  <g id="turboBtn"/>
  <text id="turboLabel"/>
  <g id="autoBtn"/>
  <text id="autoLabel"/>
  <g id="fsBanner"/>
  <text id="fsCount"/>
</contract>`;

// ── popup scenes ─────────────────────────────────────────────────────────────

/** Popup names (createGame `popups` keys) → when they are open, from the slot state. */
export const SLOT_POPUP_NAMES = ['fsIntro', 'fsOutro', 'bigwin'] as const;
export type SlotPopupName = (typeof SLOT_POPUP_NAMES)[number];

export const SLOT_FS_INTRO_HEIR = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:tml="https://trempel.dev/ns/scene" tml:extends="fs-intro.svg">
  <tml:ref id="dim" tml:on-click="skip()"/>
  <tml:ref id="content" tml:on-click="skip()"/>
  <tml:ref id="fsIntroText" tml:bind="state.fsTotal + ' FREE SPINS'"/>
</svg>`;

export const SLOT_FS_INTRO_CONTRACT = `<contract>
  <rect id="dim"/>
  <g id="content"/>
  <text id="fsIntroText"/>
</contract>`;

export const SLOT_FS_OUTRO_HEIR = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:tml="https://trempel.dev/ns/scene" tml:extends="fs-outro.svg">
  <tml:ref id="dim" tml:on-click="skip()"/>
  <tml:ref id="content" tml:on-click="skip()"/>
  <tml:ref id="fsOutroText" tml:bind="'TOTAL ' + (state.fsWin.toFixed(2))"/>
</svg>`;

export const SLOT_FS_OUTRO_CONTRACT = `<contract>
  <rect id="dim"/>
  <g id="content"/>
  <text id="fsOutroText"/>
</contract>`;

export const SLOT_BIGWIN_HEIR = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:tml="https://trempel.dev/ns/scene" tml:extends="bigwin.svg">
  <tml:ref id="dim" tml:on-click="skip()"/>
  <tml:ref id="content" tml:on-click="skip()"/>
  <tml:ref id="bigwinTitle" tml:bind="state.bigWinTier === 'max' ? 'MAX WIN' : state.bigWinTier === 'epic' ? 'EPIC WIN' : state.bigWinTier === 'mega' ? 'MEGA WIN' : 'BIG WIN'"/>
  <tml:ref id="bigwinAmount" tml:bind="state.bigWin | money"/>
</svg>`;

export const SLOT_BIGWIN_CONTRACT = `<contract>
  <rect id="dim"/>
  <g id="content"/>
  <text id="bigwinTitle"/>
  <text id="bigwinAmount"/>
</contract>`;

/** Heir + contract of each slot popup; spread a base in: `popups: { bigwin: { base, ...SLOT_POPUPS.bigwin } }`. */
export const SLOT_POPUPS: Record<SlotPopupName, { heir: string; contract: string }> = {
  fsIntro: { heir: SLOT_FS_INTRO_HEIR, contract: SLOT_FS_INTRO_CONTRACT },
  fsOutro: { heir: SLOT_FS_OUTRO_HEIR, contract: SLOT_FS_OUTRO_CONTRACT },
  bigwin: { heir: SLOT_BIGWIN_HEIR, contract: SLOT_BIGWIN_CONTRACT },
};

/** Which slot popup the state wants open (the old overlay visibility rules): big win over the FS ones. */
export function slotPopupOf(s: { phase: string; bigWinTier: string }): SlotPopupName | null {
  if (s.bigWinTier !== '') return 'bigwin';
  if (s.phase === 'fsIntro') return 'fsIntro';
  if (s.phase === 'fsOutro') return 'fsOutro';
  return null;
}
