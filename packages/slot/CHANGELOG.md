# Changelog — @trempel/slot

## 2.3.0

The additions of TRM-17 (were listed under the unreleased 2.2.0 by mistake — 2.2.0 had shipped): expanding wilds (`frameExpandedWild` → expand, `LineWin.mult`), reels landing one by one, anticipation from data, idle / quickstop / skip bindings, `bigWin:<level>`, the grid as data.

## 2.2.0

The first release of the slot package, versioned with `@trempel/scene` and `@trempel/kit` 2.2. A slot is
a viewer of rounds: the client plays a round feed that something else makes and computes no wins.

- **The round feed** — `@trempel/slot/feed`: the format (docs/feed.md: `{ type, value, context? }`, the
  `step` marker, frames `[reel][row]`, money in credits of a bet), `planRound` (the book, the money, the
  field replayed against snapshots, loud `E_FEED` errors), the game's own transforms passed through
  (`extend`, `extra` events), cell data riding cascades (`BoardCell.data`).
- **Sources**: `fixtureSource`, `httpSource`, `fnSource` (`RoundSource`).
- **The round player** `RoundPlayer`: book events → choreography sequences by the game's bindings (data),
  hooks for the game's own events, the slot state around the sequences, skip, autoplay, turbo.
- **Choreography actions** `reels:*`, `lines:*` (`slotActions`), the `landed` global for `poll:` rows.
- **`createSlot`** from data: the slot config (grid, lines, bets, costs, big win levels, bindings,
  timings), symbol looks (letters → art), a source, a choreography.
- **The reels** (pixi-reels 3): the win animation on the kit's tweens; pixi-reels' GSAP driven by the game
  loop without importing GSAP here; speed profiles from the config.
- **HUD and popups**: `SLOT_HEIR`, `SLOT_CONTRACT`, `SLOT_POPUPS`, `bindSlotPopups` (the big win title knows
  `max`).
- Headless: `headlessReels` for tests and round runs without Pixi.
- **A slot with lines** (TRM-17, for the template's base choreography): expanding wilds — the plan reads
  `frameExpandedWild` when the game declares `wilds` (letter → multiplier): an `expand` event, the
  multiplier on the reel's cells, `LineWin.mult` (the product a line crosses; display only); `reels:expand`
  (the wild's panel over its reel with `×N`), `lines:show` draws `×N` on a multiplied line; reels landing
  one by one (`landedReels` global, `ReelsView.landedReels`, the headless reels land reel by reel);
  anticipation — `tease` of the config → a frame's `tease` reels (`reels:stop anticipation`, `reels:tease`),
  `marks` → the cells that land with a show; `bigWin:<level>` bindings (fallback `bigWin`); `idle` — passes
  while no round runs, a spin skips the pass (its rows must end on a skip — `E_SLOT_BINDING`); `quickstop` /
  `skip` — a press's reaction sequences; the `nodes` global (rows for an optional node:
  `when: has(nodes, 'character')`); the grid as data — `reel-grid` takes the config's grid, a base giving
  the field's box (`data-width` / `data-height`) fits it, a base laid out for another grid fails
  `E_SLOT_SKIN`; `SlotConfig` checks the initial grid's size and the letters of `wilds` / `marks` / `tease`.
