// trempel.view.ts — the kit's components (UI with the default skin, effect nodes) for the scene
// viewer, view:shot and the editor over scenes/ (the hub's `editor` and `shots` actions).
//
// The game's context the screens bind, as the game has it at start: its texts (`t`, the game's
// tables — main.ts gives the kit the same) and the services the HUD reads (`services.wallet.balance`
// — the wallet contract's starting state). Without them the viewer stubs `t` and `services`, and
// the game screen's coins plate fails its binding (E_EXPR_FIELD: view:shot exits 1).
import { Wallet } from '@trempel/kit';
import { kitView } from '@trempel/kit/view';
import { TEXTS } from '../src/texts';

const strings: Record<string, string> = TEXTS.en;
const t = (key: string, params: Record<string, unknown> = {}): string =>
  (strings[key] ?? key).replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));

export default kitView({
  context: () => ({ t, services: { wallet: { ...Wallet.state } } }),
});
