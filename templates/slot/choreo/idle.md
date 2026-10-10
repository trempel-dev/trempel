# Idle and the character

`idle` plays in passes while no round runs (the round player repeats it; a spin skips the pass and starts at
once — so every row here ends on a skip). Vars: the last round's won lines (`lines`, `count`, `cells`) and
its `total`; `mode` — the speed mode (turbo: no line cycling).

The character's hooks are sequences on the nodes `#character` (the figure, its origin at the feet) and
`#characterBody` of a skin — absolute values only (a reaction over the breathing never drifts the pose).
They are always played behind `when: has(nodes, 'character')`: a skin without the figure skips them.

# $seq idle
$title: A pass of idle: the character breathes, the won lines cycle one at a time
$skip: on

| id      | when                             | t | dur      | action              | sync     | skip |
|---------|----------------------------------|---|----------|---------------------|----------|------|
| breathe | has(nodes, 'character')          | 0 |          | run:character.idle  | parallel | cut  |
| cycle   | count > 0 and mode != 'turbo'    | 0 |          | run:lines.cycle     | await    | cut  |
| beat    |                                  | 0 | idleBeat | wait                | await    | now  |

# $seq character.idle
$title: Breathing: the body swells a little and settles, twice a pass
$skip: on

| id   | each    | t                 | dur    | target        | action        | value                | ease      | sync  | skip |
|------|---------|-------------------|--------|---------------|---------------|----------------------|-----------|-------|------|
| in   | n=0..1  | breath * 2 * n    | breath | characterBody | tween:scale.y | scale.y: 1 → 1.06    | inOutSine | await | cut  |
| out  | n=0..1  | @in.end           | breath | characterBody | tween:scale.y | scale.y: 1.06 → 1    | inOutSine | await | cut  |
| rest |         | breath * 4        |        | characterBody | tween:scale.y | scale.y = 1          |           | await | now  |

# $seq character.react.win
$title: A win: squash, stretch, back with a bounce
$skip: on

| id      | t       | dur     | target    | action      | value                                  | ease    | sync  | skip |
|---------|---------|---------|-----------|-------------|----------------------------------------|---------|-------|------|
| squash  | 0       | hop     | character | tween:scale | scale.x: 1 → 1.12; scale.y: 1 → 0.88   | outQuad | await | cut  |
| stretch | hop     | hop     | character | tween:scale | scale.x: 1.12 → 0.92; scale.y: 0.88 → 1.14 | outQuad | await | cut  |
| rest    | hop * 2 | hop * 2 | character | tween:scale | scale.x → 1; scale.y → 1               | outBack | await | now  |

# $seq character.react.wild
$title: A wild: the character wobbles side to side

| id    | t       | dur     | target    | action         | value                 | ease      | sync  |
|-------|---------|---------|-----------|----------------|-----------------------|-----------|-------|
| left  | 0       | hop     | character | tween:rotation | rotation: 0 → -0.25   | outQuad   | await |
| right | hop     | hop * 2 | character | tween:rotation | rotation: -0.25 → 0.25 | inOutSine | await |
| rest  | hop * 3 | hop     | character | tween:rotation | rotation: 0.25 → 0    | inQuad    | await |

# $seq character.react.scatter
$title: Scatters: the character turns round to look

| id    | t       | dur     | target    | action      | value            | ease      | sync  |
|-------|---------|---------|-----------|-------------|------------------|-----------|-------|
| turn  | 0       | hop * 2 | character | tween:scale | scale.x: 1 → -1  | inOutSine | await |
| back  | hop * 3 | hop * 2 | character | tween:scale | scale.x: -1 → 1  | inOutSine | await |

# $seq character.react.bigwin
$title: A big win: three jumps of joy
$skip: on

| id      | each   | t           | dur     | target    | action      | value                                      | ease    | sync  | skip |
|---------|--------|-------------|---------|-----------|-------------|--------------------------------------------|---------|-------|------|
| squash  | j=0..2 | hop * 4 * j | hop     | character | tween:scale | scale.x: 1 → 1.15; scale.y: 1 → 0.85       | outQuad | await | cut  |
| stretch | j=0..2 | @squash.end | hop * 2 | character | tween:scale | scale.x: 1.15 → 0.88; scale.y: 0.85 → 1.2 | outQuad | await | cut  |
| land    | j=0..2 | @stretch.end | hop    | character | tween:scale | scale.x: 0.88 → 1; scale.y: 1.2 → 1       | inQuad  | await | cut  |
| rest    |        | hop * 12    | hop     | character | tween:scale | scale.x → 1; scale.y → 1                   | outBack | await | now  |
