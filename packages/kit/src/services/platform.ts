// platform.ts — the old Platform and the contracts, both ways.
//
//   platformProviders(p)        a Platform adapter (web / youtube / mock / the game's own) as the
//                               implementations of lifecycle, save, audio, language and ads —
//                               what createGame provides for the build target;
//   platformFacade(services)    a Platform over those contracts: game.platform, game.save and
//                               game.ads keep working whatever implements the contracts.

import type { Platform, RewardedResult } from '../platform/types.js';
import { adapt, type AnyContract, type Named, type ServiceContext } from './contract.js';
import type { Services } from './services.js';
import { AdsService, AudioService, Language, Lifecycle, SaveService } from './standard.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Provision = readonly [AnyContract, Named<any, any, any>];

/** The implementations of the platform contracts backed by one Platform adapter (named after it). */
export function platformProviders(p: Platform): Provision[] {
  // Language and the ads' availability are known after init (youtube asks the SDK there).
  let lang: ServiceContext<{ lang: string }> | null = null;
  let ads: ServiceContext<{ available: boolean }> | null = null;
  const syncAds = () => {
    if (ads && ads.state.available !== p.adsAvailable()) {
      ads.state.available = p.adsAvailable();
      ads.emit('changed' as never, ads.state.available as never);
    }
  };
  const sync = () => {
    if (lang && lang.state.lang !== p.language()) {
      lang.state.lang = p.language();
      lang.emit('changed' as never, lang.state.lang as never);
    }
    syncAds();
  };
  const list = [
    [
      Lifecycle,
      adapt(
        Lifecycle,
        (ctx) => {
          p.onPause(() => {
            ctx.state.paused = true;
            ctx.emit('pause');
          });
          p.onResume(() => {
            ctx.state.paused = false;
            ctx.emit('resume');
          });
          return {
            async init() {
              await p.init();
              sync();
            },
            firstFrameReady: () => p.firstFrameReady(),
            gameReady: () => p.gameReady(),
          };
        },
        p.name,
      ),
    ],
    [SaveService, adapt(SaveService, () => ({ load: () => p.load(), save: (d: string) => p.save(d) }), p.name)],
    [
      AudioService,
      adapt(
        AudioService,
        (ctx) => {
          ctx.state.enabled = p.audioEnabled();
          p.onAudioChange((on) => {
            ctx.state.enabled = on;
            ctx.emit('changed', on);
          });
          return {};
        },
        p.name,
      ),
    ],
    [
      Language,
      adapt(
        Language,
        (ctx) => {
          lang = ctx as never;
          ctx.state.lang = p.language();
          return {};
        },
        p.name,
      ),
    ],
    [
      AdsService,
      adapt(
        AdsService,
        (ctx) => {
          ads = ctx as never;
          ctx.state.available = p.adsAvailable();
          // 2.0: the host changes availability during the game — the sticky state follows at once.
          p.onAdsChange?.(() => syncAds());
          return {
            async interstitial() {
              // A host that turned ads off without telling: never show after it (TRM-8a).
              syncAds();
              if (!p.adsAvailable()) return;
              try {
                await p.showInterstitial();
              } finally {
                syncAds();
              }
            },
            async rewarded(): Promise<RewardedResult> {
              try {
                return await p.showRewarded();
              } finally {
                syncAds();
              }
            },
          };
        },
        p.name,
      ),
    ],
  ];
  return list as unknown as Provision[];
}

/**
 * A Platform over the contracts of `services`. `source` — the adapter it was built from (its own
 * extra members, like the mock's `host`, stay reachable through the facade).
 */
export function platformFacade(services: Services, source?: Platform): Platform {
  const lc = services.get(Lifecycle);
  const save = services.get(SaveService);
  const ads = services.get(AdsService);
  const facade: Platform = Object.create(source ?? null);
  Object.defineProperty(facade, 'name', { get: () => services.implName(Lifecycle), enumerable: true });
  return Object.assign(facade, {
    init: () => lc.init(),
    firstFrameReady: () => lc.firstFrameReady(),
    gameReady: () => lc.gameReady(),
    load: () => save.load(),
    save: (data: string) => save.save(data),
    onPause: (cb: () => void) => void services.listen(Lifecycle.events.pause, cb),
    onResume: (cb: () => void) => void services.listen(Lifecycle.events.resume, cb),
    audioEnabled: () => services.state(AudioService).enabled,
    onAudioChange: (cb: (on: boolean) => void) => void services.listen(AudioService.events.changed, cb, { init: false }),
    language: () => services.state(Language).lang,
    adsAvailable: () => services.state(AdsService).available,
    // A failing ads implementation (a mock in fail mode) is "no ad", never a crash of the game.
    showInterstitial: () => Promise.resolve(ads.interstitial()).catch(() => {}),
    showRewarded: (): Promise<RewardedResult> => Promise.resolve(ads.rewarded()).catch(() => 'failed' as const),
  });
}
