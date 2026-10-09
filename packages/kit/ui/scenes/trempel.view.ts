// trempel.view.ts — the kit's UI components and screen templates in the Trempel viewer:
//   npm run view -- packages/kit/ui/scenes   (from the repo root; → «Галерея»)
// The kit's view module (2.2: `@trempel/kit/view` — components with the default skin, effect
// nodes); texts are the kit's strings; built-ins (close, toggleSfx…) log to the click panel; `kit`
// is a stand-in.

import { reactive } from '@trempel/scene';
import { I18n } from '../../src/data/i18n';
import { withKitStrings } from '../../src/data/kit-strings';
import { kitView } from '../../src/view/index';

const i18n = new I18n(withKitStrings(undefined), 'en');
const kit = reactive({ progress: 64, sfx: 1, music: 0, paused: false, screen: '', popup: '', lang: 'en', ads: true });

export default kitView({
  // The components need the scene context (slider actions): the viewer builds it per mount, so
  // they get this module's built-ins.
  componentContext: {
    setSfx: (v: number) => (kit.sfx = v),
    setMusic: (v: number) => (kit.music = v),
  },
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
  background: '#1b2131',
});
