// main.ts — a casual game on the Trempel kit. Everything that is not the game (boot, platform, loading,
// layout and the playfield, pause, settings, save, sound, input, i18n, ads, services, QA probe, UI
// kit) is the kit's: one createGame() call. What is left here is the game: its rules (logic.ts),
// its state, and the glue between the rules and the scenes.
//
// Coins live in the kit's `wallet` service: the HUD binds services.wallet.balance (no code), a won
// round pays through wallet.add(). The wallet runs on its mock (memory + the game's save) until an
// integration provides a real one — createGame({ provide: [[Wallet, impl]] }); nothing here changes.

import { createGame, inject, UI_SCENES, Wallet } from '@trempel/kit';
// Scenes: sterile base (.svg) + heir (.tml.svg, logic) + contract (.contract.xml).
import menuBase from '../scenes/menu.svg?raw';
import menuHeir from '../scenes/menu.tml.svg?raw';
import menuContract from '../scenes/menu.contract.xml?raw';
import gameBase from '../scenes/game.svg?raw';
import gameHeir from '../scenes/game.tml.svg?raw';
import gameContract from '../scenes/game.contract.xml?raw';
import { hit, newRound, reward, stars, tick, type Round } from './logic';
import { TEXTS } from './texts';

let round: Round = newRound();
// A lazy reference: resolves in the game's registry at the call.
const wallet = inject(Wallet);

const game = await createGame({
  // Reactive state: scenes bind to it (`state.score`), code writes to it. The kit's result screen
  // reads won / stars / score / best.
  state: { score: 0, time: round.time, best: 0, won: false, stars: 0 },
  // Saved through the platform (localStorage on web, ytgame saveData on YouTube). The kit keeps its own
  // sfx / music apart in the same save file.
  save: { version: 1, defaults: { best: 0 } },
  i18n: TEXTS,
  screens: {
    menu: { base: menuBase, heir: menuHeir, contract: menuContract },
    game: { base: gameBase, heir: gameHeir, contract: gameContract },
  },
  // The kit's screen templates (ui/scenes of @trempel/kit): copy them into scenes/ to change the layout.
  // A popup named `pause` is opened/closed by game.pause()/resume() automatically.
  popups: { pause: UI_SCENES.pause, settings: UI_SCENES.settings, result: UI_SCENES.result },
  // Over everything from the first frame; hidden once the game is ready (below).
  overlays: { loading: { ...UI_SCENES.loading, boot: true } },
  start: 'menu',
  // The HUD of the game screen covers its top 160 design units: the playfield is the rest (+ safe area).
  layout: { hud: { top: 160 } },
  // Functions the scenes call (tml:on-click="play()"). Built-ins: show, popup, close, pause, resume, toggleSfx, toggleMusic, setSfx, setMusic.
  actions: (g) => ({
    play: () => void startRound(),
    restart: () => void startRound(),
    toMenu: async () => {
      g.popups.closeAll();
      g.resume();
      await g.ads.interstitial(); // natural pause → interstitial (cooldown inside)
      // The menu comes back as a page turned back (kit 2.1: a transition by snapshots).
      await g.show('menu', { transition: { leaf: { dir: -1 } } });
    },
    hit: () => onHit(),
  }),
  ready: (g) => void g.hideOverlay('loading'),
  // Game-channel update: stops while paused (pause menu) and during platform pause.
  update: (dt) => {
    if (game.kit.screen !== 'game' || round.over) return;
    round = tick(round, dt);
    game.state.time = round.time;
    if (round.over) finish();
  },
  // The game's own e2e probe: the HUD's coin counter as drawn.
  probe: { coins: () => game.screen('game').component<{ root: { text: string } }>('coinsPlate').root.text },
  cheats: {
    /** Transitions k times slower (e2e: a snapshot in the middle of a turn). */
    slowTransitions: (k: unknown) => void (game.transitions.speed = Number(k) || 1),
    win: () => {
      round = { ...round, score: 9 };
      onHit();
    },
    lose: () => {
      round = tick(round, 999);
      finish();
    },
  },
});

game.state.best = game.save.data.best;
game.input.on((a) => {
  if (a === 'pause' && game.kit.screen === 'game' && !round.over) (game.kit.paused ? game.resume() : game.pause());
  if (a === 'action' && game.kit.screen === 'menu') void startRound();
});

// The world fits the playfield (HUD over the world): on every layout — resize, rotation, notch.
const scr = game.screen('game');
const field = scr.byId('field');
const fieldBg = scr.byId('fieldBg');
const MARGIN = 20;
function fitField(): void {
  const pf = game.playfield.in('game');
  field.position.set(pf.x + MARGIN, pf.y + MARGIN);
  fieldBg.scale.set(1);
  fieldBg.scale.set((pf.w - 2 * MARGIN) / fieldBg.width, (pf.h - 2 * MARGIN) / fieldBg.height);
}
game.bus.on('layout', fitField);
fitField();

async function startRound(): Promise<void> {
  game.popups.closeAll();
  game.resume();
  round = newRound();
  Object.assign(game.state, { score: 0, time: round.time, won: false, stars: 0 });
  moveTarget();
  // The menu turns away as a page over the game screen.
  await game.show('game', { transition: { leaf: { look: 'soft' } } });
}

function onHit(): void {
  if (round.over || game.kit.paused) return;
  round = hit(round);
  game.state.score = round.score;
  const target = scr.byId('target');
  game.fx.play('burst', target.parent!, target.x, target.y);
  game.sound.play('pop');
  if (round.over) finish();
  else moveTarget();
}

function moveTarget(): void {
  const target = scr.byId('target');
  const w = fieldBg.width;
  const h = fieldBg.height;
  target.position.set(80 + Math.random() * Math.max(0, w - 160), 80 + Math.random() * Math.max(0, h - 160));
  void game.tweens.from(target.scale, { x: 0.3, y: 0.3 }, 0.25, 'outBack');
}

function finish(): void {
  Object.assign(game.state, { won: round.won, stars: stars(round) });
  if (round.score > game.save.data.best) {
    game.state.best = round.score;
    void game.save.set({ best: round.score });
  }
  const coins = reward(round);
  if (coins) void wallet.add(coins, 'round');
  game.sound.play(round.won ? 'win' : 'lose');
  game.popup('result');
  if (round.won) game.fx.play('confetti', game.popups.def('result').screen.byId('fx'), 0, -200);
}
