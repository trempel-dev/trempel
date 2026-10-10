# @trempel/slot

A slot on [`@trempel/kit`](../kit): making a slot is making a **viewer** — a reskin, a source of rounds and
a choreography as data; the game's code is wiring. The kit computes no wins, reels or return: the
client plays a **round feed** (a flat list of typed facts, [docs/feed.md](docs/feed.md)) that something
else makes — a server, recorded fixtures, a function.

- **The round feed** (`@trempel/slot/feed`, pure, no Pixi): the types; `planRound` — the feed → the book the
  client plays, steps cut only by the `step` marker, the field replayed atom by atom against the
  snapshots, the money summed as the format says, loud `E_FEED` errors before any money moves; the
  game's own transforms pass through to the game (`extend` handlers, `extra` events).
- **Sources**: `fixtureSource(files)` (in order / by name / pinned — the viewer), `httpSource(url)` (POST
  → feed), `fnSource(fn)`. A slot and a viewer differ only in the source.
- **The round player** (`RoundPlayer`): every book event → the choreography sequence the game's
  **bindings** name for it (`frame` → `land`, `lines` → `lines`, `bigWin` → `bigwin`…), played by the kit's
  `Director`; the state (`SlotState`: phase, win, free-spin counter, big win) changes around the
  sequences. The game's own events — **hooks** by the same keys, no fork of the player.
- **Choreography actions** for the reels and lines: `reels:spin`, `reels:stop` (`grid = grid`, wait with a
  `poll: landed` row), `reels:set`, `reels:slam`, `lines:show`, `lines:highlight`, `lines:clear` — next to the
  kit's `tween:`, `fx:`, `sound:`, `clip:`, `call:`.
- **The reels**: pixi-reels 3 as a scene component (`<tml:ref id="reels" tml:type="reel-grid"/>`, geometry
  as `data-*` of the base), procedural placeholder symbols until the art exists; the win animation on the
  kit's tweens; everything on the game loop (a platform pause freezes it).
- **The HUD and popups**: the standard heir `SLOT_HEIR` + `SLOT_CONTRACT` (a reskin replaces only the
  base), popups `SLOT_POPUPS` (free-spins intro / outro, big win) opened from the state.
- **Gates**: `LIBRARY_URLS` for the kit's Playables gates (see Dependencies).

## Use

```ts
import { createGame, loadChoreo } from '@trempel/kit';
import { SLOT_CONTRACT, SLOT_HEIR, SLOT_POPUPS, createSlot, fixtureSource } from '@trempel/slot';
import config from './slot.json';            // grid, lines, bets, bindings — data
import symbols from './skin/symbols.json';   // feed letters → art
import choreo from './choreo/slot.md?raw';   // the presentation

const slot = createSlot({ config, symbols, source: fixtureSource(FIXTURES), choreo: loadChoreo({ 'slot.md': choreo }) });
const game = await createGame({
  state: slot.state, components: slot.components, actions: slot.actions,
  screens: { slot: { base, heir: SLOT_HEIR, contract: SLOT_CONTRACT } },
  popups: { fsIntro: { base: fsIntroBase, ...SLOT_POPUPS.fsIntro }, fsOutro: { … }, bigwin: { … } },
  start: 'slot',
});
slot.attach(game);
```

The template `templates/slot` of the repository is a complete slot on synthetic fixtures with two skins.

## Dependencies

| package | license | why |
|---|---|---|
| `pixi-reels` ^3.1 | MIT | the reels |
| `gsap` (peer of pixi-reels) | GSAP Standard "no charge" license | pixi-reels animates its reels with it; this package does not import it — it drives pixi-reels' instance from the game loop |
| `@trempel/kit`, `@trempel/scene`, `pixi.js` (peers) | MIT | |

`gsap` ships in a game's bundle with pixi-reels (its license comment carries its URLs — `LIBRARY_URLS`
tells the kit's Playables gate they are text).

## License

MIT © Denys Vynohradskyi
