# @trempel/kit

A game kit on top of [Trempel](https://trempel.dev) scenes and [PixiJS](https://pixijs.com) v8. A game is one `createGame({...})` call plus its rules; boot, platform, loading, layout, pause, save, sound, input, i18n, ads, QA hooks and build gates are the kit's.

- **Platforms** — web, YouTube Playables (`ytgame` SDK), mock (tests); the target is picked at build time, the other adapter never ships.
- **Screens, popups, overlays** — Trempel scenes (base SVG + heir + contract), layout by fit policy with safe area and a playfield, screen templates in `ui/scenes` (`UI_SCENES`).
- **UI kit** — components (`ui-button`, `ui-toggle`, `ui-panel`, `ui-progress`, `ui-slider`, `ui-stars`…) drawn from a skin; `trempel-skin` measures a skin's art into `skin.json`.
- **Default skin** — prefabs and art in `skins/default/ui`, used as a Trempel collection: `$skin: npm:@trempel/kit/skins/default/ui` in `.trempel/project.mdz`, then `href="@skin/button.svg"` in scenes.
- **Loop and time** — one game loop with injectable time and pause channels; tweens, Trempel clips, an event player, a state machine, an event bus; particles; sound over zvuk with procedural placeholder sounds.
- **Build** — `@trempel/kit/vite`: `plugins: [trempelKit()]`; `vite build --mode youtube` runs the Playables gates (size, sterility, no-eval) and writes `build-report.md`. `@trempel/kit/e2e` — Playwright helpers.

## Install

```bash
npm install @trempel/kit @trempel/scene pixi.js
```

`@trempel/scene` and `pixi.js` are peer dependencies; `vite` and `sharp` are optional peers (build plugin, skin CLI).

## A game

```ts
import { createGame, UI_SCENES } from '@trempel/kit';
import base from './scenes/game.svg?raw';
import heir from './scenes/game.tml.svg?raw';

const game = await createGame({
  state: { score: 0 },
  save: { version: 1, defaults: { best: 0 } },
  screens: { game: { base, heir } },
  popups: { pause: UI_SCENES.pause, settings: UI_SCENES.settings },
  start: 'game',
  actions: () => ({ hit: () => void game.state.score++ }),
});
```

A complete starting point is the casual template in this repository (`templates/casual`): menu, game screen, pause, settings, result, save, web and Playables builds with e2e tests.

## License

MIT © 2026 Denys Vynohradskyi
