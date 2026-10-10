# Big win

The round's total over the big win levels of `slot.json` (`bigWin`: ×bet thresholds) — one sequence per
level (`bigWin:<level>` bindings), a level the bindings do not name falls back to `bigWin` (the capped
`max` too). The popup (`popups/bigwin.svg`) opens from the state while the level shows. Vars: `level`,
`amount`, `from` / `to` (the counter, currency).

# $seq bigwin.big
$title: Big: the counter runs over two bursts of coins

| id   | t | action          | value                      | sync  |
|------|---|-----------------|----------------------------|-------|
| show | 0 | run:bigwin.show | up = bigUp; bursts = 2     | await |

# $seq bigwin.mega
$title: Mega: longer, more coins

| id   | t | action          | value                      | sync  |
|------|---|-----------------|----------------------------|-------|
| show | 0 | run:bigwin.show | up = megaUp; bursts = 4    | await |

# $seq bigwin.epic
$title: Epic: the longest run, coins all the way and confetti on top
$skip: on

| id    | t                      | target | action          | value                   | sync     | skip |
|-------|------------------------|--------|-----------------|-------------------------|----------|------|
| show  | 0                      |        | run:bigwin.show | up = epicUp; bursts = 8 | await    |      |
| party | epicUp / 2             | winFx  | fx:confetti     |                         | parallel | cut  |

# $seq bigwin.show
$title: The common show of a level: a fanfare, the character jumps, `bursts` of coins while the counter runs `up` ms, a hold
$skip: on

| id      | each           | when                    | t             | dur     | target | action                     | value             | ease     | sync     | skip |
|---------|----------------|-------------------------|---------------|---------|--------|----------------------------|-------------------|----------|----------|------|
| fanfare |                |                         | 0             |         |        | sound:fanfare              |                   |          | parallel | cut  |
| cheer   |                | has(nodes, 'character') | 0             |         |        | run:character.react.bigwin |                   |          | parallel | cut  |
| burst   | b=0..bursts-1  |                         | burstStep * b |         | winFx  | fx:coins                   |                   |          | parallel | cut  |
| up      |                |                         | 0             | up      | state  | tween:bigWin               | bigWin: from → to | outCubic | await    | now  |
| hold    |                |                         | @up.end       | bigHold |        | wait                       |                   |          | await    | now  |
