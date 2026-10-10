# Spin

The reels from the press to the last stop. Vars of a frame: `grid` (the frame, `grid[reel][row]`), `reels`
(how many), `marks` (cells of the letters that land with a show — `slot.json` `marks`: `{ reel, row, symbol }`),
`tease` (the reels to tease — `slot.json` `tease`), `fs` (a free spin). Globals: `landedReels` (reels landed
so far, left to right), `landed` (all of them), `nodes` (ids of the scene).

# $seq spin.start
$title: The press: the lines go, every reel starts; the reels spin at least minSpin
$skip: on

| id    | t | dur     | target | action      | sync     | skip |
|-------|---|---------|--------|-------------|----------|------|
| clear | 0 |         | lines  | lines:clear | parallel |      |
| go    | 0 |         | reels  | reels:spin  | parallel |      |
| sfx   | 0 |         |        | sound:spin  | parallel | cut  |
| hold  | 0 | minSpin |        | wait        | await    | now  |

# $seq spin.stop
$title: The reels stop on the frame left to right; each landing and each teased reel has its own sequence
$skip: on

| id     | each         | t                      | dur        | target | action           | value                                                   | sync     | skip |
|--------|--------------|------------------------|------------|--------|------------------|---------------------------------------------------------|----------|------|
| stop   |              | 0                      |            | reels  | reels:stop       | grid = grid; stopDelay = stopStep; anticipation = tease | parallel | now  |
| tease  | r in tease   | poll: landedReels >= r |            |        | run:anticipation | reel = r                                                | parallel | cut  |
| land   | k=0..reels-1 | poll: landedReels > k  |            |        | run:reel.stop    | reel = k                                                | parallel | cut  |
| done   |              | poll: landed           |            |        | wait             |                                                         | await    |      |
| settle |              | @done.start            | landSettle |        | wait             |                                                         | await    | now  |

# $seq reel.stop
$title: One reel lands: a thud; the marked symbols on it (scatters, wilds) pop with a ring

| id   | each         | when                                         | t | target | action          | value       | sync     |
|------|--------------|----------------------------------------------|---|--------|-----------------|-------------|----------|
| thud |              |                                              | 0 |        | sound:land      |             | parallel |
| ring |              | has(field(marks, 'reel'), reel)              | 0 |        | sound:mark      |             | parallel |
| pop  | c in marks   | c.reel == reel                               | 0 | lines  | lines:highlight | cells = [c] | parallel |

# $seq anticipation
$title: A teased reel: framed and humming until it lands (pixi-reels slows it down)

| id    | t | target | action      | value      | sync     |
|-------|---|--------|-------------|------------|----------|
| frame | 0 | reels  | reels:tease | reel = reel | parallel |
| hum   | 0 |        | sound:tease |            | parallel |

# $seq quickstop
$title: A stop press while the reels spin: they slam down at once, one thud for all

| id   | t | target | action     | sync     |
|------|---|--------|------------|----------|
| slam | 0 | reels  | reels:slam | parallel |
| thud | 0 |        | sound:land | parallel |
