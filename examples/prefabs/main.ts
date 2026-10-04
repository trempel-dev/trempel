// main.ts — the Trempel v0.9 prefabs example (`npm run dev` → /examples/prefabs/).
//
//   - ui/button.svg (+ .tml.svg, .contract.xml) — a prefab: label and action are parameters
//     (data-label, data-action), hover/pressed swap the shade sprite (data-views + tml:bind-view),
//     the click calls the scene's function named by the action (self.call(self.action));
//   - ui/button-green.tml.svg — extends button.svg: its own backdrop (tml:href), its own label default;
//   - menu.svg — four instances, one line each; menu.tml.svg overrides two labels from inside
//     (`tml:ref id="playBtn/label"`), settingsBtn computes its label (`data-label="=t('settings')"`).
//
// Prefab documents are bundled here (import.meta.glob) and handed to mount() as a synchronous
// loader; in a plain page `mountAsync()` of the `trempel` entry fetches them next to the scene.

import { Application } from 'pixi.js';
import { mount, PixiBackend, reactive, type SceneSource } from '../../src/index';
import { translator } from './i18n';

const files = import.meta.glob<string>('./**/*.{svg,xml}', { query: '?raw', import: 'default', eager: true });
const art = import.meta.glob<string>('./ui/art/*.png', { query: '?url', import: 'default', eager: true });

/** A scene by its base path (`ui/button.svg`): base, heir, contract from the bundle. */
const loadScene = (url: string): SceneSource | null => {
  const stem = `./${url.replace(/\.svg$/, '')}`;
  const src = { base: files[`${stem}.svg`], heir: files[`${stem}.tml.svg`], contract: files[`${stem}.contract.xml`] };
  return src.base != null || src.heir != null ? src : null;
};

async function boot(): Promise<void> {
  const app = new Application();
  await app.init({ width: 800, height: 600, background: 0x141a2e, antialias: true });
  document.getElementById('stage')?.appendChild(app.canvas);
  const log = document.getElementById('log')!;
  const say = (text: string): void => {
    log.textContent = text;
  };

  const state = reactive({ lang: 'ru', coins: 120 });
  const scene = mount({
    ...loadScene('menu.svg')!,
    loadScene,
    resolveHref: (href) => art[`./${href}`] ?? href,
    backend: new PixiBackend(),
    context: {
      state,
      t: translator(state),
      play: () => {
        state.coins = Math.max(0, state.coins - 10);
        say(`play: монет ${state.coins}`);
      },
      openSettings: () => {
        state.lang = state.lang === 'ru' ? 'en' : 'ru';
        say(`settings: язык ${state.lang}`);
      },
      openShop: () => say('shop'),
      exit: () => say('exit'),
    },
    container: app.stage,
  });
  await scene.ready;
  say('наведите и нажмите кнопку; «Настройки» переключает язык');
}

boot().catch((e) => {
  console.error(e);
  document.body.textContent = String(e);
});
