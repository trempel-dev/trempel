// trempel.view.ts — the prefabs example in the viewer / editor (`npm run view -- examples/prefabs`,
// `npm run edit -- examples/prefabs`). Texts come from i18n.ts; the buttons' actions (play,
// openSettings…) are left to the viewer's stubs — a click goes to the log with the call it made.

import { defineView } from '../../view/api';
import { translator } from './i18n';

export default defineView({
  background: '#141a2e',
  context: (state) => ({ t: translator(state) }),
});
