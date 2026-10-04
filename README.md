# Trempel

An agent-first, lightweight 2D game engine on [PixiJS](https://pixijs.com). Scenes are valid SVG that any editor opens; behaviour lives in a second document; an agent or a person edits both as plain text.

| package | what |
|---|---|
| [`@trempel/scene`](packages/scene) | the scene format (SVG + `tml:` namespace), the runtime, the animation player, the editor core and the editor page, `view` / `check` / `flatten` tools |
| [`@trempel/kit`](packages/kit) | a game kit on Trempel scenes: platforms (web, YouTube Playables), screens and popups, layout, UI components, a default skin, sound, particles, save, build gates |
| [`templates/casual`](templates/casual) | a starting casual game on the kit (not published) |

Docs: [trempel.dev](https://trempel.dev) · format: [`packages/scene/docs/format/scene-format.md`](packages/scene/docs/format/scene-format.md) · migration: [`packages/scene/MIGRATION.md`](packages/scene/MIGRATION.md)

## In this repo

```bash
npm install
npm run build            # @trempel/scene, then @trempel/kit
npm run typecheck
npm test                 # unit tests of every package (no browser)
npm run test:e2e         # editor and view:shot in headless Chromium; the template's web and Playables builds
npm run view -- packages/scene/examples/motion          # scene viewer
npm run edit -- packages/scene/examples/prefabs         # editor page on a dev server
npm run check -- packages/scene/examples/motion         # validate scenes and clips
npm run flatten -- packages/scene/examples/prefabs/menu.svg --out menu.svg --embed
```

Packages depend on each other by name only; npm workspaces link them locally. Versions move together.

## License

MIT © 2026 Denys Vynohradskyi
