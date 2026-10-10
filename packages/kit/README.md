# @trempel/kit

A game kit on top of [Trempel](https://trempel.dev) scenes and [PixiJS](https://pixijs.com) v8. A game is one `createGame({...})` call plus its rules; boot, platform, loading, layout, pause, save, sound, input, i18n, ads, QA hooks and build gates are the kit's.

Docs: [trempel.dev](https://trempel.dev) · the scene format: [`scene-format.md`](../scene/docs/format/scene-format.md) · for agents: [`CLAUDE.md`](../../CLAUDE.md) · the template: [`templates/casual`](../../templates/casual)

- **Services** — every external thing (saves, ads, wallet, purchases, leaderboards, your backend) is a typed contract with a mandatory mock; the game runs on mocks until an integration provides real implementations.
- **Platforms** — web, YouTube Playables (`ytgame` SDK), mock (tests); they implement the platform contracts (lifecycle, save, audio, language, ads); the target is picked at build time, the other adapter never ships.
- **Screens, popups, overlays** — Trempel scenes (base SVG + heir + contract), with prefabs (`<use href>`), collections and project heirs — the Vite plugin collects the scenes, the game configures nothing; layout by fit policy with safe area and a playfield; a popup takes the input while it is open; screen templates in `ui/scenes` (`UI_SCENES`). `game.destroy()` takes the game down.
- **UI kit** — components (`ui-button`, `ui-toggle`, `ui-panel`, `ui-progress`, `ui-slider`, `ui-stars`…) drawn from a skin; `trempel-skin` measures a skin's art into `skin.json`.
- **Default skin** — prefabs and art in `skins/default/ui`, used as a Trempel collection: `$skin: npm:@trempel/kit/skins/default/ui` in `.trempel/project.mdz`, then `href="@skin/button.svg"` in scenes.
- **Loop and time** — one game loop with injectable time and pause channels; tweens, Trempel clips, an event player, a state machine, an event bus; sound over zvuk with procedural placeholder sounds (volume / pitch in the table, popup sounds, a click silent when it opened a popup, no lag on the first tap).
- **Transitions and effects** — `game.show(name, { transition: { leaf: { dir, look: 'hard' | 'soft' } } })` turns a screen as a page (`PageLeaf`, by snapshots; a function transition for anything else), `game.transitions.turn()` / `.drag()` turn pages inside a screen; particles in the Unity Shuriken model with trails and a lazy effects table (`createGame({ fx: { effects, textures } })`); `trempel-fx-import` converts Unity particle systems straight from a Unity project (prefabs / scenes, nested prefabs, materials and textures by GUID) — or (`--cocos`) Cocos particle plists — with a report auto / manual / hard; `trempel-anim-import` turns Unity AnimationClips (prefabs, Animator controllers, `.anim`) into md clips, verified against Unity's own curves.
- **Build** — `@trempel/kit/vite`: `plugins: [trempelKit()]`; it injects the game's scene table (prefabs, collections of `.trempel/project.mdz`, project heirs) and compiles md clips — `import clips from './anim/win.md?clips=popup-win'` is checked against the scene, a bad clip fails the build; every build rewrites the bundle's images without metadata (ComfyUI workflows and prompts in PNG text chunks, EXIF / XMP, C2PA — no re-encoding, the pixels stay bit-identical) and fails with `E_ASSET_METADATA` on anything left or on generation sidecars (`*.png.json`…); `vite build --mode youtube` also runs the Playables gates (size, sterility, no-eval) and writes `build-report.md`. `@trempel/kit/e2e` — Playwright helpers.

## Entries

`@trempel/kit` — the stable API: `createGame` and its options and types, the types of the game's members, the services and the kit's contracts, the UI components and the skin. `@trempel/kit/vite`, `@trempel/kit/testing`, `@trempel/kit/e2e`, `@trempel/kit/skin-cli`, `@trempel/kit/view` (2.2: `kitView()` for a game's `trempel.view.ts`). Everything else is `@trempel/kit/internal/<module>` (no stability promise) — see CHANGELOG.md 2.0.0.

The save: `game.save` is the game's own data; the kit keeps the sound settings and the services' store apart in the same save file — the game cannot overwrite them.

## Spine skeletons

```bash
npx trempel-spine-import spine/hero.json --out scenes/hero [--atlas spine/hero.atlas] [--fps 30] [--frames 0.2,0.5 --clip idle]
npx trempel-spine-import spine/ --out scenes/spine        # every skeleton of the folder + summary.md
```

`scene.svg` (bones → nested groups, slots in the draw order, slot colour → `data-tint`, blend → `mix-blend-mode`), `<name>.anim.md` (+ `.anim.json`), `art/` cut from the atlas, `report.md` — what was transferred and the check of every animation against Trempel's own player.

## Effects in scenes

```xml
<!-- X.svg (base): a placeholder dot -->      <g id="sparkle" transform="translate(360 640)" data-effect="sparkle" data-scale="1.5"><circle r="8"/></g>
<!-- X.tml.svg (heir) -->                      <tml:ref id="sparkle" tml:type="fx"/>
```

An effect node plays from the mount (`data-autostart="false"` — on `play()`); a clip's `$events` row `fx:burst@star` plays an effect at a node. In the viewer, the editor and `view:shot`, `export default kitView({ effects, textures })` (`@trempel/kit/view`) draws them — seeded, on the page's clock, the same picture every run.

## Choreography

```ts
const choreo = loadChoreo(import.meta.glob('./choreo/*.md', { eager: true, query: '?raw', import: 'default' }));
const director = new Director({ choreo, loop: game.loop, actions: kitActions({ scene: screen.scene, tweens: game.tweens, clips: game.clips, clipOf, fx: game.fx, sound: game.sound }) });
const end = await director.run('deal', { count: 5 });
```

Sequences of named steps as md tables (formula times, `@row.end`, instances, speed modes, skip rules, nested sequences) on the loop's logical time; `verifyLog` checks the log against a reference timeline.

## Effects from Unity

```bash
npx trempel-fx-import ../MyUnityGame --out src/fx/unity [--only PopupWin/] [--ppu 100] [--compare old-configs.json]
```

`effects.json` goes to `createGame({ fx: { effects, textures } })` as is (`textures`: texture name → URL, e.g. `import.meta.glob('./fx/unity/textures/*.png')`); `report.md` lists every system: `auto` — played exactly, `manual` — approximated (what), `hard` — something it uses is not played (what).

## Effects from Cocos

```bash
npx trempel-fx-import --cocos fx/cocos --out src/fx/cocos [--scale 1] [--only fire] [--compare old-configs.json]
```

Particle Designer / Particle2dx emitters (an XML `.plist` or the `.json` variant; a folder — every one in it), both modes (gravity and radius), the texture next to the file or embedded (`textureImageData`). Same output as for Unity; `report.md` also has the check of every emitter against a model of Cocos' particles (position / size / colour / rotation, every frame).

## Clips from Unity

```bash
npx trempel-anim-import ../MyUnityGame/Assets/Hero.prefab --out scenes/anim [--scene scenes/hero.svg] [--map anim-map.md] [--ppu 100] [--ui-scale 1] [--tex "art/{}.png"]
```

AnimationClips (of a prefab's Animator, a controller or loose `.anim` files) become md clips — `<out>/<name>.anim.md` with a clip per state, the compiled `.anim.json` next to it. Curves keep Unity's shape (Hermite and weighted tangents as cubic eases, constants as steps); x / y / rotation are offsets of the rest pose, scale a multiplier. `anim-map.md` lists every animated path and its node id (by name in `--scene`; edit it and pass it back with `--map`). `report.md`: every clip `auto` / `manual` / `hard` per property, the transitions (listed, never run), and the verification — each clip played by Trempel against Unity's own evaluation of its curves.

## The hub's actions

`hub/actions.mdz` is this kit version's layer of actions for [`@trempel/hub`](../hub): `trempel run dev`
in a project starts its dev server on a free port, `trempel run editor` — the scene editor of the
scene package this kit runs with, `trempel run --list` shows them with the hub's, the user's and the
project's own.

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

## Services

A contract is methods + events + a state slice, and a mock — declaring one without a mock is a type and a runtime error.

```ts
import { contract, sticky, once, inject, listen, provide, services, Wallet } from '@trempel/kit';

export const Shop = contract('shop', {
  state: { open: false },
  events: { changed: sticky<boolean>('open'), sold: once<{ id: string }>() },
  modes: ['offline'],                                  // the mock's own modes (dev panel, ?svc.shop=offline)
  mock: (ctx) => ({                                    // ctx: { state, emit, mode, store }
    async buy(id: string) { if (ctx.mode.offline) return false; ctx.emit('sold', { id }); return true; },
  }),
})<{ buy(id: string): Promise<boolean> }>();

class ShopScreen {                                     // createGame({ screens: { shop: { …, controller: () => new ShopScreen() } } })
  private shop = inject(Shop);                         // resolved at mount; an unregistered contract fails there
  private wallet = inject(Wallet);
  private off = listen(Wallet.events.changed, (b) => console.log('balance', b));   // sticky: the current value first; dropped at unmount
}

await createGame({ /* … */ services: [Shop], provide: [[Shop, (ctx) => myBackendShop(ctx), 'backend']] });
provide(Wallet, firebaseWallet(cfg));                  // before or after get / inject — references are lazy
services.mock('wallet', { latency: 300, fail: 0.2 }); // mock modes; also ?svc.wallet=fail and the dev panel (?services=1, web build only)
```

Scenes bind the state without code: `tml:bind-text="services.wallet.balance"`. Events are on `game.bus` as `<contract>:<event>`. The kit's contracts: `lifecycle`, `save`, `audio`, `language`, `ads` (implemented by the platform adapter; `game.platform`, `game.save`, `game.ads` are facades over them), `wallet`, `iap`, `leaderboard` (mock + local: the wallet keeps its balance in the game's save). `extend(C, { mock, … })` adds to a contract (its mock is mandatory too), `adapt(C, (ctx) => impl, name)` puts another model under a contract. Contract names are unique; on the dev server a contract re-declared by HMR replaces the old one (state and subscriptions stay while the state's shape is the same), in a build a second declaration is an error.

A complete starting point is the casual template in this repository (`templates/casual`): menu, game screen, pause, settings, result, save, web and Playables builds with e2e tests.

## License

MIT © 2026 Denys Vynohradskyi
