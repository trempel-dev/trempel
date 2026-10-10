# Slot choreography

The template's presentation as data (`@trempel/kit/choreo`): which rows play for each event of the round
feed, when (ms from the sequence start — formulas of the speed constants in `consts.md`) and what they move.
The bindings in `slot.json` name the sequences; a reskin never touches these files, a new game rewrites them.

| file | sequences |
|---|---|
| `spin.md` | `spin.start`, `spin.stop`, `reel.stop`, `anticipation`, `quickstop` |
| `wins.md` | `wild.expand`, `lines.show`, `lines.cycle`, `win.count`, `scatter.hit`, `skip` |
| `bigwin.md` | `bigwin.big`, `bigwin.mega`, `bigwin.epic` (+ their common `bigwin.show`) |
| `free.md` | `fs.intro`, `fs.next`, `fs.outro` |
| `idle.md` | `idle`; the character's hooks `character.idle`, `character.react.win` / `.wild` / `.bigwin` / `.scatter` |
| `consts.md` | the speed modes: normal / quick / turbo |

What the rows move: the reels and the lines (`reels:*`, `lines:*` of @trempel/slot), the state's numbers
(`tween:win`, `tween:bigWin` on `state`), scene nodes (`tween:<prop>` on an id), effects
(`fx:<effect>` at `winFx`), sounds (`sound:<cue>` — the cues of `sounds.json`). A skip press applies each
row's `skip` rule: `now` — jump to the end, `cut` — never play.

**The character is optional.** Every row that plays a `character.*` sequence has `when: has(nodes,
'character')` — `nodes` are the ids of the slot scene: a skin without a `#character` node (Fruity Spin)
silently plays without it. The default skin has a stub figure (`#character` / `#characterBody`) so the hooks
are visible; a game with a real character replaces the `character.*` sequences (a Spine clip, its own
tweens) and keeps the calls.

**Time grid.** Every constant is a multiple of 50 ms; the reels' own feel (spin speed, bounce, the delay of
a teased reel) is pixi-reels' profile of the mode (`slot.json` `timings` / `speeds`).
