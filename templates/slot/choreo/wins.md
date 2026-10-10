# Wins

The wins of a spin, in the order the feed tells them. Vars: `reel` / `symbol` / `mult` / `cells` (a wild
taking a reel — `frameExpandedWild`, multipliers from `slot.json` `wilds`), `lines` / `count` / `cells`
(won lines: each `{ cells, index, lineId, symbol, value, mult }` — `mult` is the product of the expanded
wilds it crosses, a line through two ×2 shows ×4), `hits` / `cells` / `trigger` (scatters: a pay, or a
free-spin trigger), `from` / `to` / `amount` (the win in currency).

# $seq wild.expand
$title: A wild takes its whole reel: the panel grows over it with the multiplier, the character cheers
$skip: on

| id    | when                     | t           | dur        | target | action                  | value                                     | sync     | skip |
|-------|--------------------------|-------------|------------|--------|-------------------------|-------------------------------------------|----------|------|
| sfx   |                          | 0           |            |        | sound:expand            |                                           | parallel | cut  |
| grow  |                          | 0           | expandGrow | reels  | reels:expand            | reel = reel; symbol = symbol; mult = mult | await    | now  |
| cheer | has(nodes, 'character')  | 0           |            |        | run:character.react.wild |                                          | parallel | cut  |
| hold  |                          | @grow.end   | expandHold |        | wait                    |                                           | await    | now  |

# $seq lines.show
$title: The won lines one by one (each with its × when wilds multiply it), then all of them stay a moment
$skip: on

| id    | each         | when                    | t                            | target | action                  | value           | sync     | skip |
|-------|--------------|-------------------------|------------------------------|--------|-------------------------|-----------------|----------|------|
| clear |              |                         | 0                            | lines  | lines:clear             |                 | parallel |      |
| one   | k=0..count-1 |                         | lineStep * k                 | lines  | lines:show              | line = lines[k] | parallel | now  |
| ding  | k=0..count-1 |                         | lineStep * k                 |        | sound:line              |                 | parallel | cut  |
| cheer |              | has(nodes, 'character') | 0                            |        | run:character.react.win |                 | parallel | cut  |
| hold  |              |                         | lineStep * count + linesHold |        | wait                    |                 | await    | now  |

# $seq lines.cycle
$title: In idle: the won lines again, one at a time (a pass; the idle repeats it until the next spin)
$skip: on

| id    | each         | t             | dur               | target | action      | value           | sync     | skip |
|-------|--------------|---------------|-------------------|--------|-------------|-----------------|----------|------|
| clear | k=0..count-1 | cycleStep * k |                   | lines  | lines:clear |                 | parallel | cut  |
| one   | k=0..count-1 | cycleStep * k |                   | lines  | lines:show  | line = lines[k] | parallel | cut  |
| end   |              | 0             | cycleStep * count |        | wait        |                 | await    | now  |

# $seq win.count
$title: The win counts up
$skip: on

| id    | t | dur     | target | action     | value          | ease    | sync     | skip |
|-------|---|---------|--------|------------|----------------|---------|----------|------|
| tick  | 0 |         |        | sound:coin |                |         | parallel | cut  |
| count | 0 | countUp | state  | tween:win  | win: from → to | outQuad | await    | now  |

# $seq scatter.hit
$title: The scatters light up together (a pay or a free-spin trigger); a trigger throws confetti
$skip: on

| id    | when                    | t | dur         | target | action                     | value         | sync     | skip |
|-------|-------------------------|---|-------------|--------|----------------------------|---------------|----------|------|
| glow  |                         | 0 |             | lines  | lines:highlight            | cells = cells | parallel |      |
| ring  |                         | 0 |             |        | sound:scatter              |               | parallel | cut  |
| fx    | trigger                 | 0 |             | winFx  | fx:confetti                |               | parallel | cut  |
| cheer | has(nodes, 'character') | 0 |             |        | run:character.react.scatter |              | parallel | cut  |
| hold  |                         | 0 | scatterHold |        | wait                       |               | await    | now  |

# $seq skip
$title: A skip press during the wins: a click (every running sequence applies its own skip rules)

| id  | t | action      | sync     |
|-----|---|-------------|----------|
| tap | 0 | sound:click | parallel |
