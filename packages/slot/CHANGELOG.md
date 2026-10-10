# Changelog — @trempel/slot

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
