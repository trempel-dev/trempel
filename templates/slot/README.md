# Slot template

A slot with five lines on `@trempel/slot`: expanding wilds with multipliers (×1, ×2 — two ×2 on a line
show ×4), scatters, free spins, a buy, big win by levels — and the base choreography of a slot with lines to
start a game from. Two grids of the same data: 3×3 (`slot.json`) and 5×3 (`slot.5x3.json`). Everything that
makes the slot is data; `src/main.ts` only wires it.

| file | what |
|---|---|
| `slot.json`, `slot.5x3.json` | the config: grid, lines, wilds (letter → multiplier), marks / tease (what lands with a show, what teases the reels after it), bets, costs, big win levels, the source, the skin, **bindings** — events of the round feed → choreography sequences |
| `choreo/*.md` | the presentation (`choreo/README.md`): `spin.start`, `spin.stop`, `reel.stop`, `anticipation`, `wild.expand`, `lines.show`, `lines.cycle`, `win.count`, `bigwin.<level>`, `scatter.hit`, `idle`, `quickstop`, `skip`, the free spins, the character's hooks; `consts.md` — the speed modes (normal / quick / turbo) |
| `sounds.json` | the cues the choreography plays (synth placeholders until the game has its audio) |
| `fixtures/*.json`, `fixtures/5x3/*.json` | the rounds: synthetic round feeds, written by hand in `scripts/fixtures.mjs` (`npm run fixtures`) |
| `skins/<name>/` | the look: `slot.svg` (the base of the standard slot heir), `popups/*.svg`, the art, `symbols.json` (feed letters → art) |

Skins: `default` (procedural, no art; the field's box fits any grid; a stub character — `#character`, which
the character hooks move) and `fruity-spin` (generated art laid out cell by cell for 3×3, no character —
its hooks are skipped silently; uses the kit's default skin prefabs through the `@skin` collection of
`.trempel/project.mdz`).

```
npm run dev                 # http://localhost:5173/?skin=fruity-spin&fixture=08-wild-x4&cheat=1 · ?grid=5x3&fixture=04-wild-x4
npm test                    # the data holds together; every fixture plays headless through the choreography
npm run test:e2e            # web + YouTube builds; every fixture through every skin; key moments shot bit for bit; view:shot of every skin
npm run build:yt            # YouTube Playables build + gates → build-report.md
```

- **Reskin**: a new folder in `skins/` with the same ids as `skins/default/slot.svg` (the slot contract)
  and a `symbols.json` for the letters of the feeds; pick it with `?skin=` or `slot.json` `"skin"`. A
  `#character` node is optional.
- **Another grid**: the config's `grid` and `lines`, fixtures of that size; a skin whose `#reels` gives the
  field's box (`data-width` / `data-height`) fits it, one laid out cell by cell refuses it (`E_SLOT_SKIN`).
- **Rounds from a server**: `"source": { "type": "http", "url": "…" }` — the server answers a POST
  `{ bet, buy }` with a round feed (`@trempel/slot` docs/feed.md). Web builds only.
- **Another presentation**: edit `choreo/*.md`, or bind events to other sequences in the config; a real
  character replaces the `character.*` sequences and keeps the calls.
