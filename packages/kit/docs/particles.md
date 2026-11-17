# Particles

The kit's particles are configs (`ParticleConfig`, `src/fx/types.ts`) in the model of Unity's Shuriken
— plus the fields Cocos particles need (2.2) — simulated without a renderer (`src/fx/sim.ts`) and
drawn into one Pixi `ParticleContainer` per system (`src/fx/emitter.ts`). A game plays them by name:

```ts
const game = await createGame({
  fx: {
    effects: { win: winConfigs },                 // a config or a group (parent first); trempel-fx-import's effects.json fits
    textures: { spark: sparkUrl, coin: coinSheet }, // texture names → URLs, or (2.5) atlases
  },
  // …
});
game.fx.play('win', container, x, y);
```

Presets play without art: `burst`, `confetti`, `sparkle`, `smoke`, `coins`, `trail`, and (2.5)
`coinFountain`, `coinBurst`. An effect is also a node of a scene (`tml:type="fx"`, `data-effect`) and a
clip marker (`fx:<name>@<node>`); the scene editor edits it in its inspector (`kitView()`).

## Frames: a grid or an atlas

A particle's picture can change over its life — its **frame**:

- `sheet` — a grid of `tilesX × tilesY` tiles of one texture, the frame by a curve over the life
  (Shuriken's texture sheet animation);
- `atlas` (2.5) — frames of a sprite atlas, by name.

One of them: a config with both fails with `E_FX_CONFIG`.

## Atlas (2.5)

An atlas is a **TexturePacker "JSON hash"**: a `.json` whose `frames` map a frame name to its rect in
one image — `frame`, `rotated`, `trimmed`, `spriteSourceSize`, `sourceSize` — and `meta.image`, the
image next to it. Frames may be trimmed (the empty margin cut off, `sourceSize` keeps the original box)
and rotated; Pixi's own `Spritesheet` reads them, so a trimmed frame is drawn in its place inside the
original box and a rotated one upright.

```ts
atlas?: {
  texture: string;               // the atlas: a name of the effects' textures
  prefix?: string;               // the frames whose names start with it (default — all), natural order
  mode?: 'animate' | 'random';   // animate (default) — the frames change in flight; random — one random frame per particle, still
  fps?: number;                  // animate: frames a second (default 24)
  randomStart?: boolean;         // animate: a random start frame per particle — out of phase (default true)
  pingpong?: boolean;            // animate: 0 → n → 0 instead of a cycle
  keepAspect?: boolean;          // the size is the original picture's larger side, both axes alike (default true)
}
```

**The texture of an atlas** — an entry of the effects' textures (`createGame({ fx: { textures } })`,
`kitView({ textures })`):

- a **URL of the atlas's `.json`** — loaded at the first play that needs it (or `fx.preload()`), with
  its image from `meta.image` next to it. Works where the `.json` and its image are served side by side
  (a dev server, a static folder);
- a **`Spritesheet`** — the game loads it itself; a bundler that renames files (Vite) imports the
  data and the image's URL apart:

```ts
import { Assets, Spritesheet, type Texture } from 'pixi.js';
import coinAtlas from './fx/coin.json';
import coinImage from './fx/coin.png?url';

const coin = new Spritesheet(await Assets.load<Texture>(coinImage), coinAtlas);
await coin.parse();
const game = await createGame({ fx: { textures: { coin } }, /* … */ });
```

**Frames.** The atlas's frames whose names start with `prefix`, in natural order (`coin_2` before
`coin_10`): `coin_` takes `coin_00.png … coin_15.png` and leaves `spark_1.png`. All the frames of one
atlas share its image — one batch.

**Which frame.** `animate`: a particle `age` seconds old shows frame `(⌊age · fps⌋ + start) mod n`
(ping-pong: over `0 … n−1 … 1`); `start` is random per particle (`randomStart`, default) or 0. `random`:
one random frame at the spawn for the whole life. The draw is the particle's last random draw and
comes from the effect's random source — a seeded effect (an effect node, view:shot) shows the same
frames every run; a config without `atlas` draws exactly as before.

**Size.** `size` (× `sizeOverLifetime`, × the effect's scale) is the larger side of the frame's
**original** picture (`sourceSize`), both axes scaled alike: a trimmed frame is smaller but sits in the
same box, so a coin turning edge-on does not jump or grow. `keepAspect: false` — every frame stretched
to a `size × size` square (as a plain texture is).

**Without the atlas.** An atlas that is not in the textures (or has no frames by the prefix) — the
config plays its `texture`, one picture; a warning `W_FX_ATLAS` once. The presets `coinFountain` and
`coinBurst` take the atlas named `coin` and fall back to white circles.

**The editor.** The particle inspector (`kitView()`) has the group «atlas»: the atlas (the names of the
textures), the prefix with the prefixes found and the number of frames it takes, mode, fps, random
start, ping-pong, keep aspect; the preview on the node plays the edit, save writes it into the
effect's file like any other field.

### coinFountain, coinBurst

`coinFountain` — the fountain of a big win: 45 coins a second for 1.5 s from an 80 px strip, up in a
±20° fan at 700…1150 px/s, falling back under 1400 px/s², spinning 100…450°/s either way, growing
0.5 → 1 over a life of ~3 s (up to 500). `coinBurst` — a short dense volley (0.2 s at 125/s, up to 100)
for the finale. Both: frames of the `coin` atlas, `animate` at 24 fps, out of phase. They play by name
(`fx.play('coinFountain', …)`, a choreography's `fx:coinFountain`); another look — a config of the
game's effects table with its own `atlas` (`{ texture: 'gems', prefix: 'gem_' }`).
