# @trempel/kit

A game kit on top of [Trempel](https://trempel.dev) scenes and [PixiJS](https://pixijs.com) v8. A game is one `createGame({...})` call plus its rules; boot, platform, loading, layout, pause, save, sound, input, i18n, ads, QA hooks and build gates are the kit's.

Docs: [trempel.dev](https://trempel.dev) · the scene format: [`scene-format.md`](../scene/docs/format/scene-format.md) · for agents: [`CLAUDE.md`](../../CLAUDE.md) · the template: [`templates/casual`](../../templates/casual)

- **Services** — every external thing (saves, ads, wallet, purchases, leaderboards, your backend) is a typed contract with a mandatory mock; the game runs on mocks until an integration provides real implementations.
- **Platforms** — web, YouTube Playables (`ytgame` SDK), mock (tests); they implement the platform contracts (lifecycle, save, audio, language, ads); the target is picked at build time, the other adapter never ships.
- **Screens, popups, overlays** — Trempel scenes (base SVG + heir + contract), layout by fit policy with safe area and a playfield, screen templates in `ui/scenes` (`UI_SCENES`).
- **UI kit** — components (`ui-button`, `ui-toggle`, `ui-panel`, `ui-progress`, `ui-slider`, `ui-stars`…) drawn from a skin; `trempel-skin` measures a skin's art into `skin.json`.
- **Default skin** — prefabs and art in `skins/default/ui`, used as a Trempel collection: `$skin: npm:@trempel/kit/skins/default/ui` in `.trempel/project.mdz`, then `href="@skin/button.svg"` in scenes.
- **Loop and time** — one game loop with injectable time and pause channels; tweens, Trempel clips, an event player, a state machine, an event bus; particles; sound over zvuk with procedural placeholder sounds.
- **Build** — `@trempel/kit/vite`: `plugins: [trempelKit()]`; every build rewrites the bundle's images without metadata (ComfyUI workflows and prompts in PNG text chunks, EXIF / XMP, C2PA — no re-encoding, the pixels stay bit-identical) and fails with `E_ASSET_METADATA` on anything left or on generation sidecars (`*.png.json`…); `vite build --mode youtube` also runs the Playables gates (size, sterility, no-eval) and writes `build-report.md`. `@trempel/kit/e2e` — Playwright helpers.

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
