# Round feed

The round a slot client plays is a **flat list of typed facts** — the round feed. The client shows it
and knows nothing of the game's rules: everything on the screen comes from the feed. `@trempel/slot/feed`
reads it (`planRound`), the round player plays it (`RoundPlayer`), sources deliver it (`fixtureSource`,
`httpSource`, `fnSource`). The kit computes no wins, reels or return: whatever makes the feed (a server,
a recorded fixture, a function) owns the game.

## On the wire

```json
{ "type": "<name>", "value": <payload>, "context": "<mode>" }
```

- `context` is **absent** in the base game (no key, not `null`); inside a mode it is the mode's name from
  `switchToMode` (`freeSpins`…). The absence of context is what marks the base game.
- A position is `{ "reel": r, "row": w }`, rows top-down, from 0. A frame is `value[reel][row]`.
- A symbol is **one letter** of the game's table (the game maps letters to art).
- **Money is in credits, integers.** One bet = `betCredits` credits (a parameter of the game, 100 by
  default). The price of a buy is not in the values: the numbers are the same in every mode.
- A round is `{ name, buy, transforms }` (`RoundFeed`): `buy` — the bought feature (a key of the game's
  `costs`), `null` — a normal spin.

## Steps

Every step opens with the **step marker**:

```json
{ "type": "step", "value": { "kind": "spin", "n": 0 } }
```

- The first transform of a round is always `step`; steps are cut **only** by it — the client never cuts
  by heuristics.
- `n` — the step number in the round from 0, consecutive. `kind` — from the game's closed list; the kit
  knows the roles (`PlanOptions.kinds`, defaults in brackets): a paid spin (`spin`), the spin of a bought
  feature (`buy`, only the first step), a spin of a mode (`freeSpin`), a step that continues the spin
  before it — a cascade or a respin (`cascade`, `respin`).
- `context` — the same as the step's transforms.
- **Flags of the step** — other keys of `value` (`{ "kind": "spin", "n": 0, "slow": true }`): decisions
  of the server the player sees but that are not facts of the field. They are the game's: the plan passes
  them through (`StepInfo.flags`) to the game's hooks.

## Core transforms

| type | value | when |
|---|---|---|
| `step` | `{ kind, n, …flags }` | opens every step |
| `spinsLeft` | `int` | spins of the mode left, **this one included**; on every spin of a mode, right after `step`. A retrigger shows as growth |
| `frameInit` | `char[][]` | the frame after the reels stop; once per step (a spin, or a respin) |
| `frameInitDiff` | `{ diff: [{ old?, new? }], snapshot: char[][] }` | a cascade: the frame changed atom by atom; `old` / `new` = `{ position, symbol }` |
| `frameHits` | `[{ positions, symbol, multiplier, value }]` | scatters, pay-anywhere, clusters; `value` 0 for every hit — a highlight (a trigger / retrigger) |
| `paylines` | `[{ lineId, line, value }]` | line wins: `line[reel]` — the row of the paying cell on that reel, `null` where the line does not pay; the symbol is read from the frame |
| `win` | `int` | a step's win (`> 0`; 0 is not sent); after `multipliersInit` — the spin's multiplied total |
| `multipliersInit` | `[int]` | the multiplier of the spin's total (announced before its final `win`) |
| `maxWin` | `int` | the cap is reached: comes **instead** of the `win` that hit it, `value` = the cap; nothing follows it |
| `switchToMode` | `string` | entering a mode (free spins, a bought episode): the last transform of the trigger step |
| `roundFinished` | `int` | the round's total — a debug feed only (fixtures, tests): checked against the computed total |

### Order within a step

```
step
spinsLeft                 spins of a mode only
frameInit | frameInitDiff
… the game's own transforms of the field (cell multipliers, tags) …
frameHits / paylines      the step's wins; a trigger without a win — frameHits with value 0
win                       the step's win, if > 0
── the last step of a spin only:
multipliersInit           the spin's multiplier, if any
win | maxWin              the spin's multiplied total, or the cap
switchToMode              a trigger
```

### Cascades

`frameInitDiff` atoms go **reel by reel, left to right**; within a reel: removals (`old`, no `new`), then
falls (`old` and `new` at different positions; bottom-up — applied one by one, never overwriting), then
new symbols on top (`new`, no `old`). An atom with `old` and `new` at one position — a symbol changing in
place. `snapshot` — the whole frame after the cascade: the client replays the atoms and compares.

## Money

- A spin's total = the `win` after `multipliersInit` if the spin has one, otherwise the sum of its step
  `win`s.
- The round's total = the sum of the spin totals, or exactly the cap when `maxWin` came.
- A free-spin episode's total (the outro) = the sum of the spin totals of the mode.
- The cost of a round in bets: 1 for a spin, the game's `costs[buy]` for a buy.
- Big win levels are presentation, not math: thresholds ×bet of the round total, data of the game
  (`{ "big": 15, "mega": 40, "epic": 100 }` by default); a capped round is level `max`.

## The game's own transforms

Anything not in the core table above is the game's (cell multipliers, tags, collectors, expanding
symbols…). The kit does not read it and does not reject it:

- the plan calls the game's handler for its type, if any (`PlanOptions.extend`): it may check the
  transform and put data on the field's cells (`BoardCell.data` — it moves with its symbol through
  cascades, is dropped when a symbol changes in place);
- the book gets an `extra` event with the transform for the round player's hooks / bindings (key: the
  type).

New fields inside core types are not added: a game's fact is a transform of its own, or a flag of the
step.

## What the plan checks

Loud errors (`E_FEED: <round>: …`), before any money moves: a transform before the first marker, `n` out
of order, an unknown `kind`, a step without a frame, a frame of another size, a cascade that does not
replay to its snapshot or does not follow gravity, a line off the field, a win ≤ 0, a free spin without
`switchToMode`, `switchToMode` without a following `spinsLeft`, `spinsLeft` going down by more than one, a
transform after `maxWin`, `roundFinished` ≠ the computed total, a context that differs from its step's.

## The book

`planRound(feed, options)` → `RoundPlan` with the **book** the player plays in order (money in credits):
`step`, `spinsLeft` (left, index, total, added), `frame` (grid of reel symbol ids), `cascade` (reel ops +
snapshot), `hits` (trigger?), `lines` (paying cells, symbol), `stepWin`, `multTotal`, `spinWin`, `maxWin`,
`fsStart` (mode, count), `fsEnd` (mode, total), `bigWin` (level, amount), `roundEnd` (total), `extra`.

## Sources

```ts
interface RoundSource { next(req: { bet: number; buy: string | null }): Promise<RoundFeed> }
```

- `fixtureSource(files, { pin?, walk? })` — recorded rounds `{ name, note?, buy?, transforms }`, by name
  round-robin; a normal spin takes the next round without a buy, a buy — the next of that buy (`walk:
  'all'` — every round in turn, a viewer); `select(name, pin?)`.
- `httpSource(url, { fetch?, headers?, body? })` — POSTs the request as JSON; the response is a feed
  (`{ name?, buy?, transforms }`) or a bare list of transforms.
- `fnSource(fn)` — `(req) => feed` in the same process.

A slot and a viewer of rounds differ only in the source their config names.
