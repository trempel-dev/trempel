# Fruity Spin

A skin of the slot template: a 1920×1080 landscape scene with generated art. `slot.svg` — the base of the
standard slot heir (the slot contract's ids; `#reels` is a 3×3 field of 230×200 cells — the tiles are drawn
cell by cell, so this skin plays the 3×3 grid only; no `#character` — the choreography's character hooks
are skipped), `popups/` — the free-spin and big win popups, `ui/` — its own prefabs (reel tile, spin
button, foliage), `art/` and `symbols/` — the art, `symbols.json` — feed letters → symbols (the wilds
`W` / `V` — placeholder tiles until their art exists). Panels, buttons and icons come from the kit's
default skin (`@skin/…`, the template's `.trempel/project.mdz`).
