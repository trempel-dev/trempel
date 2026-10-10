# Free spins

The free-spin episode around its spins. Vars: `count` (spins won), `index` / `total` (the counter),
`total` (the episode's win, currency) at the outro.

# $seq fs.intro
$title: Free spins won — the banner over confetti
$skip: on

| id   | t | dur    | target | action      | sync     | skip |
|------|---|--------|--------|-------------|----------|------|
| fx   | 0 |        | winFx  | fx:confetti | parallel | cut  |
| hold | 0 | banner |        | wait        | await    | now  |

# $seq fs.next
$title: A breath between free spins
$skip: on

| id   | t | dur          | action | sync  | skip |
|------|---|--------------|--------|-------|------|
| hold | 0 | betweenSpins | wait   | await | now  |

# $seq fs.outro
$title: Free spins over — the total over coins
$skip: on

| id   | t | dur    | target | action   | sync     | skip |
|------|---|--------|--------|----------|----------|------|
| fx   | 0 |        | winFx  | fx:coins | parallel | cut  |
| hold | 0 | banner |        | wait     | await    | now  |
