# Trempel

[![CI](https://github.com/trempel-dev/trempel/actions/workflows/ci.yml/badge.svg)](https://github.com/trempel-dev/trempel/actions/workflows/ci.yml)

An agent-first, lightweight 2D game engine on [PixiJS](https://pixijs.com). A scene is valid SVG any
editor opens; its behaviour lives in a second document; an agent or a person edits both as text.

## Install

```bash
npm install @trempel/scene pixi.js
```

## Thirty lines

```xml
<!-- hello.svg — the base: plain SVG, any SVG editor opens and saves it -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 120">
  <rect id="button" width="320" height="120" rx="16" fill="#2d6cdf"/>
  <text id="label" x="160" y="74" text-anchor="middle" font-size="40" fill="#fff">Play</text>
</svg>
```

```xml
<!-- hello.tml.svg — the heir: what the base means to the game -->
<svg xmlns="http://www.w3.org/2000/svg" xmlns:tml="https://trempel.dev/ns/scene" tml:extends="hello.svg">
  <tml:ref id="label" tml:bind="state.clicks ? 'Clicks: ' + state.clicks : 'Play'"/>
  <tml:ref id="button" tml:on-click="play()"/>
</svg>
```

```ts
import { Application } from 'pixi.js';
import { mount, PixiBackend, reactive } from '@trempel/scene';
import base from './hello.svg?raw';
import heir from './hello.tml.svg?raw';

const app = new Application();
await app.init({ width: 320, height: 120 });
document.body.appendChild(app.canvas);

const state = reactive({ clicks: 0 });
const scene = mount({ base, heir, backend: new PixiBackend(), container: app.stage, context: { state, play: () => state.clicks++ } });
await scene.ready;
```

Every problem (XML, merge, contract, expressions) is reported at once, each with a code
(`E_REF_MISSING: <tml:ref id="labl">: no such id in the base.`); nothing is evaluated with `eval`.

## Read next

- **The format** — [`packages/scene/docs/format/scene-format.md`](packages/scene/docs/format/scene-format.md): scenes, heirs, contracts, prefabs, clips, the public API, every error code. Its examples are tests.
- **For agents** — [`CLAUDE.md`](CLAUDE.md): the repository map, commands and invariants.
- **Changes** — [`packages/scene/CHANGELOG.md`](packages/scene/CHANGELOG.md), migration: [`packages/scene/MIGRATION.md`](packages/scene/MIGRATION.md).

| Package | What |
|---|---|
| [`@trempel/scene`](packages/scene) | the scene format (SVG + `tml:` namespace), the runtime, the animation player, the editor core and page, `view` / `check` / `flatten` tools |
| [`@trempel/kit`](packages/kit) | a game kit on Trempel scenes: services, platforms (web, YouTube Playables), screens and popups, layout, UI components, a default skin, sound, particles, save, build gates |
| [`@trempel/slot`](packages/slot) | a slot on the kit: the round feed ([format](packages/slot/docs/feed.md)) and its sources (fixtures, HTTP, a function), a round player that plays the feed through choreography bound by data, pixi-reels reels, the standard HUD and popups |
| [`templates/casual`](templates/casual) | a starting casual game on the kit (not published) |
| [`templates/slot`](templates/slot) | a 3×3 slot with lines, free spins and big win on `@trempel/slot`: synthetic rounds, two skins (not published) |

## In this repo

```bash
npm install
npm run build            # @trempel/scene, then @trempel/kit, then @trempel/slot
npm run typecheck
npm test                 # unit tests of every package (no browser)
npm run test:e2e         # editor and view:shot in headless Chromium; the templates' web and Playables builds
npm run view -- packages/scene/examples/motion          # scene viewer
npm run view:shot -- packages/scene/examples/motion --out shot.png   # a deterministic PNG
npm run edit -- packages/scene/examples/prefabs         # editor page on a dev server
npm run check -- packages/scene/examples/motion         # validate scenes and clips
```

Packages depend on each other by name only; npm workspaces link them locally. Dev tools (Vite,
Vitest, TypeScript, Playwright) live at the root.

## License

MIT © 2026 Denys Vynohradskyi
