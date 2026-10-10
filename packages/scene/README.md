# Trempel

An agent-first, lightweight 2D game engine on [PixiJS](https://pixijs.com):

- **A scene format that is valid SVG.** The base `X.svg` is plain SVG any editor opens; behaviour lives in an heir `X.tml.svg` (`tml:` namespace: bindings, events, components, inserts) and an optional contract `X.contract.xml` that checks the view. Prefabs (`<use href>`), 9-slice, anchors, slots and shared collections (`@skin/…`) included.
- **A runtime** that mounts a scene over a renderer backend (PixiJS out of the box), with reactive state, an expression language without `eval`, and an animation player for clips written as Markdown tables.
- **An editor core** (`@trempel/scene/editor`) — every edit is a command an agent or a person runs the same way — and the editor page as a library (`@trempel/scene/edit`): a timeline over md clips (keys, eases, events, recording), the consumer's inspectors (the kit's particle editor), and an agent's line into the page a person has open (`trempel-edit eval`, an MCP server).

Docs: [trempel.dev](https://trempel.dev) · format, public API and error codes: [`docs/format/scene-format.md`](docs/format/scene-format.md) · for agents: [`CLAUDE.md`](../../CLAUDE.md) · [`CHANGELOG.md`](CHANGELOG.md) · migration: [`MIGRATION.md`](MIGRATION.md)

## Install

```bash
npm install @trempel/scene pixi.js
```

`pixi.js` (v8.19+) is a peer dependency. Tools that never render import `@trempel/scene/core` — no Pixi needed. The stable API is listed in the spec (§15); `@trempel/scene/internal/*` is for the kit and the editor, without a stability promise.

## A scene

`button.svg` — the base, plain SVG:

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 120">
  <rect id="bg" width="320" height="120" rx="16" fill="#2d6cdf"/>
  <text id="label" x="160" y="60" text-anchor="middle" dominant-baseline="middle" fill="#fff" font-size="40">Play</text>
</svg>
```

`button.tml.svg` — the heir: what the base means to the game:

```xml
<svg xmlns="http://www.w3.org/2000/svg" xmlns:tml="https://trempel.dev/ns/scene" tml:extends="button.svg">
  <tml:ref id="label" tml:bind="state.clicks ? 'Again (' + state.clicks + ')' : 'Play'"/>
  <tml:ref id="bg" tml:on-click="play()"/>
</svg>
```

## Mount it

```ts
import { Application } from 'pixi.js';
import { mount, PixiBackend, reactive } from '@trempel/scene';
import base from './button.svg?raw';
import heir from './button.tml.svg?raw';

const app = new Application();
await app.init({ width: 320, height: 120 });
document.body.appendChild(app.canvas);

const state = reactive({ clicks: 0 });
const scene = mount({
  base,
  heir,
  backend: new PixiBackend(),
  container: app.stage,
  context: { state, play: () => state.clicks++ },
});
await scene.ready;
```

Every problem (XML, merge, contract, expressions) is collected and reported together, each with a code (`E_CONTRACT_MISSING: …`; the catalog — spec §16); nothing is evaluated with `eval`. `checkScene()` runs the same checks without rendering.

## In the repository

`@trempel/scene` lives in `packages/scene` of the Trempel monorepo; the commands run from the repository root:

```bash
npm install
npm test               # unit tests (no browser)
npm run test:e2e       # editor and view:shot in headless Chromium
npm run view -- packages/scene/examples/motion           # scene viewer
npm run edit -- packages/scene/examples/prefabs          # editor page on a dev server
npm run check -- packages/scene/examples/motion          # validate scenes and clips from the CLI
npm run view:shot -- packages/scene/examples/motion --out shot.png   # a deterministic headless PNG
```

**A live snapshot without the repository.** `npx -p @trempel/scene -p vite -p playwright trempel-view view:shot scenes/menu.svg --out menu.png [--settle 2] [--clip intro --t 0.5]` — the same deterministic headless PNG + JSON of errors (in a project with `vite` and `playwright` installed: `npx trempel-view view:shot …`; once: `npx playwright install chromium`).

**The editor page without the repository** (2.3.1). `npx trempel-edit serve scenes [--port 5181]` (or `npx trempel-view edit scenes`) in a project with `vite` installed — the same page as `npm run edit` here, with the folder's `trempel.view.ts`; the kit's hub action `editor` starts it.

**Open a scene anywhere.** `npm run flatten -- packages/scene/examples/prefabs/menu.svg --out menu.svg --embed` (bin `trempel-flatten` in the package) turns a scene — heir, prefabs, 9-slice, slots, `@skin/…` collection links — into one vanilla SVG that any browser and Figma draw.

## License

MIT © 2026 Denys Vynohradskyi
