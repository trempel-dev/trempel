Clips of the effects showcase: markers `fx:<effect>@<node>` fire effects — at an effect node it plays
there, at any other node a one-shot in its place (`view:shot effects --clip celebrate --t 0.8`).

# $clip celebrate
$duration: 1.6

## $track star
| t   | scale | ease    |
|-----|-------|---------|
| 0   | 1     | outBack |
| 0.3 | 1.4   | inOut   |
| 0.8 | 1     |         |

## $track trail
| t   | x   | ease  |
|-----|-----|-------|
| 0   | 0   | inOut |
| 1.6 | 400 |       |

## $events
| t   | event           |
|-----|-----------------|
| 0.3 | fx:burst@star   |
| 0.5 | fx:confetti@top |
