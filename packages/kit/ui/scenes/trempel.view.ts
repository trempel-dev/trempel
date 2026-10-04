// trempel.view.ts — the kit's UI components and screen templates in the Trempel viewer:
//   npm run view -- packages/kit/ui/scenes   (from the repo root; → «Галерея»)
// The kit's backend (skin attributes) and components with its default (procedural) skin; texts are
// the kit's strings; built-ins (close, toggleSfx…) log to the click panel; `kit` is a stand-in.

import { defineView } from '@trempel/scene/view';
import { Registry, reactive } from '@trempel/scene';
import { Tweens } from '../../src/anim/tweens';
import { I18n } from '../../src/data/i18n';
import { withKitStrings } from '../../src/data/kit-strings';
import { uiComponents } from '../../src/ui/components/index';
import { KitBackend } from '../../src/ui/kit-backend';
import { defaultSkin } from '../../src/ui/skin/skin';

const skin = defaultSkin();
const tweens = new Tweens();
const i18n = new I18n(withKitStrings(undefined), 'en');
const kit = reactive({ progress: 64, sfx: 1, music: 0, paused: false, screen: '', popup: '', lang: 'en', ads: true });
// Viewer frames (no game loop): tweens advance on the page's animation frame.
let last = performance.now();
const tick = (now: number) => {
  tweens.update(Math.min(0.1, (now - last) / 1000));
  last = now;
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);

export default defineView({
  backend: () => new KitBackend({ skin }),
  context: (state) => {
    const context: Record<string, unknown> = { kit, t: i18n.t };
    const log = (name: string) => (...a: unknown[]) => console.info(`[kit view] ${name}(${a.map((x) => JSON.stringify(x)).join(', ')})`);
    for (const n of ['show', 'popup', 'close', 'pause', 'resume', 'play', 'restart', 'toMenu', 'claim', 'double']) context[n] = log(n);
    context.toggleSfx = () => (kit.sfx = kit.sfx > 0 ? 0 : 1);
    context.toggleMusic = () => (kit.music = kit.music > 0 ? 0 : 1);
    context.setSfx = (v: number) => (kit.sfx = v);
    context.setMusic = (v: number) => (kit.music = v);
    void state;
    return context;
  },
  registry: () => {
    const reg = new Registry();
    // The components need the scene context (slider actions): the viewer builds it per mount, so
    // they get this module's built-ins.
    const context: Record<string, unknown> = {
      setSfx: (v: number) => (kit.sfx = v),
      setMusic: (v: number) => (kit.music = v),
    };
    for (const [name, f] of Object.entries(uiComponents({ skin, tweens, context }))) reg.register(name, f);
    return reg;
  },
  background: '#1b2131',
});
