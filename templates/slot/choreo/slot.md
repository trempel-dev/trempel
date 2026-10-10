# Slot choreography

The template's presentation as data: which rows play for each event of the round feed (the bindings in
`slot.json` name the sequences), when (ms from the sequence start, formulas of the constants below) and
what they move — the reels and the lines (`reels:*`, `lines:*` of @trempel/slot), the state's numbers
(`tween:win` on `state`), effects (`fx:<effect>@<node>`), sounds (`sound:<cue>`). A skip press applies
each row's `skip` rule: `now` — jump to the end, `cut` — never play.

Vars of the events: `grid` (frame), `lines` / `count` / `cells` (lines), `cells` / `trigger` (hits), `from` /
`to` / `amount` (wins, currency), `count` (free spins won), `index` / `total` (the free-spin counter),
`level` / `from` / `to` (big win), `fs` — the spin is a free one.

# $seq spin
$title: The reels start; they spin at least minSpin
$skip: on

| id    | t | dur     | target | action      | sync     | skip |
|-------|---|---------|--------|-------------|----------|------|
| clear | 0 |         | lines  | lines:clear | parallel |      |
| go    | 0 |         | reels  | reels:spin  | parallel |      |
| sfx   | 0 |         |        | sound:rise  | parallel | cut  |
| hold  | 0 | minSpin |        | wait        | await    | now  |

# $seq land
$title: The reels stop on the frame of the feed, left to right
$skip: on

| id   | t            | target | action     | value                             | sync     | skip |
|------|--------------|--------|------------|-----------------------------------|----------|------|
| stop | 0            | reels  | reels:stop | grid = grid; stopDelay = stopStep | parallel | now  |
| done | poll: landed |        | wait       |                                   | await    |      |

# $seq lines
$title: The won lines one by one, then all of them stay a moment
$skip: on

| id   | each         | t                        | target | action     | value           | sync     | skip |
|------|--------------|--------------------------|--------|------------|-----------------|----------|------|
| one  | k=0..count-1 | lineStep * k             | lines  | lines:show | line = lines[k] | parallel | now  |
| coin | k=0..count-1 | lineStep * k             |        | sound:coin |                 | parallel | cut  |
| hold |              | lineStep * count + linesHold |    | wait       |                 | await    | now  |

# $seq win
$title: The win counts up
$skip: on

| id    | t | dur     | target | action    | value          | ease    | sync  | skip |
|-------|---|---------|--------|-----------|----------------|---------|-------|------|
| count | 0 | countUp | state  | tween:win | win: from → to | outQuad | await | now  |

# $seq scatter
$title: The scatters light up (a trigger or a retrigger)
$skip: on

| id   | t | dur      | target | action          | value         | sync     | skip |
|------|---|----------|--------|-----------------|---------------|----------|------|
| glow | 0 |          | lines  | lines:highlight | cells = cells | parallel |      |
| sfx  | 0 |          |        | sound:win       |               | parallel | cut  |
| hold | 0 | hitsHold |        | wait            |               | await    | now  |

# $seq fs.intro
$title: Free spins won — the banner
$skip: on

| id   | t | dur    | target | action        | sync     | skip |
|------|---|--------|--------|---------------|----------|------|
| fx   | 0 |        | winFx  | fx:confetti   | parallel | cut  |
| hold | 0 | banner |        | wait          | await    | now  |

# $seq fs.next
$title: A breath between free spins
$skip: on

| id   | t | dur          | action | sync  | skip |
|------|---|--------------|--------|-------|------|
| hold | 0 | betweenSpins | wait   | await | now  |

# $seq fs.outro
$title: Free spins over — the total
$skip: on

| id   | t | dur    | target | action   | sync     | skip |
|------|---|--------|--------|----------|----------|------|
| fx   | 0 |        | winFx  | fx:coins | parallel | cut  |
| hold | 0 | banner |        | wait     | await    | now  |

# $seq bigwin
$title: The big win counts up over coins, then stays a moment
$skip: on

| id   | t       | dur     | target | action       | value             | ease    | sync     | skip |
|------|---------|---------|--------|--------------|-------------------|---------|----------|------|
| sfx  | 0       |         |        | sound:win    |                   |         | parallel | cut  |
| fx   | 0       |         | winFx  | fx:coins     |                   |         | parallel | cut  |
| up   | 0       | bigUp   | state  | tween:bigWin | bigWin: from → to | outQuad | await    | now  |
| hold | @up.end | bigHold |        | wait         |                   |         | await    | now  |

# $consts

| name         | normal | quick | turbo |
|--------------|--------|-------|-------|
| minSpin      | 600    | 350   | 150   |
| stopStep     | 150    | 80    | 0     |
| lineStep     | 400    | 250   | 100   |
| linesHold    | 600    | 350   | 150   |
| countUp      | 800    | 500   | 250   |
| hitsHold     | 900    | 600   | 300   |
| banner       | 1600   | 1100  | 700   |
| betweenSpins | 300    | 200   | 100   |
| bigUp        | 2100   | 1400  | 840   |
| bigHold      | 900    | 600   | 360   |
