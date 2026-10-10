# Slot template

A 3×3 slot with five lines, free spins, a buy and big win on `@trempel/slot`. Everything that makes the
slot is data; `src/main.ts` only wires it.

| file | what |
|---|---|
| `slot.json` | the config: grid, lines, bets, costs, big win levels, the source, the skin, **bindings** — events of the round feed → choreography sequences |
| `choreo/slot.md` | the presentation: sequences of rows (reels, lines, the win count-up, banners, effects, sounds) and their constants per speed mode |
| `fixtures/*.json` | the rounds: synthetic round feeds, written by hand in `scripts/fixtures.mjs` (`npm run fixtures`) |
| `skins/<name>/` | the look: `slot.svg` (the base of the standard slot heir), `popups/*.svg`, the art, `symbols.json` (feed letters → art) |

Skins: `default` (procedural, no art) and `fruity-spin` (generated art, uses the kit's default skin
prefabs through the `@skin` collection of `.trempel/project.mdz`).

```
npm run dev                 # http://localhost:5173/?skin=fruity-spin&fixture=05-free&cheat=1
npm test                    # the data holds together; every fixture plays headless through the choreography
npm run test:e2e            # web + YouTube builds; every fixture through every skin; view:shot of every skin
npm run build:yt            # YouTube Playables build + gates → build-report.md
```

- **Reskin**: a new folder in `skins/` with the same ids as `skins/default/slot.svg` (the slot contract)
  and a `symbols.json` for the letters of the feeds; pick it with `?skin=` or `slot.json` `"skin"`.
- **Rounds from a server**: `slot.json` `"source": { "type": "http", "url": "…" }` — the server answers a
  POST `{ bet, buy }` with a round feed (`@trempel/slot` docs/feed.md). Web builds only.
- **Another presentation**: edit `choreo/slot.md`, or bind events to other sequences in `slot.json`.
