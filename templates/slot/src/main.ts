// main.ts — a slot with five lines, expanding multiplier wilds, free spins and big win on @trempel/slot.
// Everything that makes this slot is data: slot.json (grid, lines, wilds, bets, the source, the bindings of
// the feed's events to sequences), choreo/*.md (the presentation), sounds.json (the cues), fixtures/*.json
// (the rounds), skins/<name>/ (the look: the base scene, the popups, the art, symbols.json — feed letters →
// art). This file only wires them.
//   ?grid=5x3           — the 5×3 variant: slot.5x3.json and fixtures/5x3/ (web build; the default skin)
//   ?skin=fruity-spin   — another skin (web build; default: slot.json "skin")
//   ?fixture=05-free    — play only this round; default: the normal-spin rounds in order
//   ?cheat=1            — window.__trempel.cheats: fixture(name), buy(), balance(v), log()
// RESKIN: a new folder in skins/. ROUNDS FROM A SERVER: slot.json "source": { "type": "http", "url": … }.

import { assetTable, createGame, loadChoreo, type SoundSource } from '@trempel/kit';
import { SLOT_CONTRACT, SLOT_HEIR, SLOT_POPUPS, createSlot, fixtureSource, httpSource, type FixtureFile, type RoundSource, type SlotConfig, type SymbolLookData } from '@trempel/slot';
import config3x3 from '../slot.json';
import config5x3 from '../slot.5x3.json';
import sounds from '../sounds.json';

declare const __TREMPEL_TARGET__: string | undefined;

const BASES = import.meta.glob<string>('../skins/*/slot.svg', { query: '?raw', import: 'default' });
const POPUPS = import.meta.glob<string>('../skins/*/popups/*.svg', { query: '?raw', import: 'default' });
const SYMBOLS = import.meta.glob<Record<string, SymbolLookData>>('../skins/*/symbols.json', { import: 'default' });
const ART = import.meta.glob<string>('../skins/*/**/*.png', { query: '?url', import: 'default' });
// The kit's default skin (the `@skin` collection of .trempel/project.mdz): its art, for the skins that use it.
const KIT_ART = import.meta.glob<string>('#kit-skin/art/**/*.png', { eager: true, query: '?url', import: 'default' });
const CHOREO = import.meta.glob<string>(['../choreo/*.md', '!../choreo/README.md'], { eager: true, query: '?raw', import: 'default' });
const FIXTURES: Record<string, FixtureFile[]> = {
  '3x3': Object.values(import.meta.glob<FixtureFile>('../fixtures/*.json', { eager: true, import: 'default' })),
  '5x3': Object.values(import.meta.glob<FixtureFile>('../fixtures/5x3/*.json', { eager: true, import: 'default' })),
};

const web = typeof __TREMPEL_TARGET__ === 'undefined' || __TREMPEL_TARGET__ !== 'youtube';
const params = new URLSearchParams(location.search);
const variant = (web && params.get('grid')) || '3x3';
if (!FIXTURES[variant]) throw new Error(`E_SLOT_CONFIG: no grid variant "${variant}" (known: ${Object.keys(FIXTURES).join(', ')})`);
const config = variant === '5x3' ? config5x3 : config3x3;
const skin = (web && params.get('skin')) || config.skin;
const dir = `../skins/${skin}/`;
if (!BASES[`${dir}slot.svg`]) throw new Error(`E_SLOT_SKIN: no skin "${skin}" (known: ${Object.keys(BASES).map((k) => k.split('/')[2]).join(', ')})`);
const load = async <T>(table: Record<string, () => Promise<T>>, file: string): Promise<T> => table[`${dir}${file}`]();

// The skin's art: scene hrefs come from the skin's folder (`skins/<skin>/art/bg.png`), symbol looks from
// symbols.json relative to it (`symbols/lemon.png`) — one table for both.
const art: Record<string, string> = {};
await Promise.all(Object.entries(ART).filter(([k]) => k.startsWith(dir)).map(async ([k, url]) => void (art[k] = await url())));
const skinArt = assetTable(art, '../');
// glob keys of an aliased folder are paths from here (they differ by install layout): keep the part in the skin
const KIT_DIR = '/skins/default/ui/';
const kitArt = assetTable(Object.fromEntries(Object.entries(KIT_ART).map(([k, url]) => [k.slice(k.indexOf(KIT_DIR) + KIT_DIR.length), url])), '');
const resolve = (href: string): string => {
  if (href.startsWith('kit-skin/')) return kitArt(href.slice('kit-skin/'.length));
  const inSkin = skinArt(`skins/${skin}/${href.replace(/^(\.\.\/)+|^\.\//, '')}`);
  return inSkin.startsWith('skins/') ? skinArt(href) : inSkin;
};

const fixtures = fixtureSource(FIXTURES[variant], { pin: (web && params.get('fixture')) || undefined });
const src = config.source as { type: string; url?: string };
const source: RoundSource = src.type === 'http' && web && src.url ? httpSource(src.url) : fixtures;

const slot = createSlot({
  config: config as SlotConfig,
  symbols: await load(SYMBOLS, 'symbols.json'),
  source,
  choreo: loadChoreo(Object.fromEntries(Object.entries(CHOREO).map(([k, md]) => [k.replace('../', ''), md]))),
  onRoundEnd: () => void game.save.set({ balance: game.state.balance }),
});

const game = await createGame({
  state: slot.state,
  save: { version: 1, defaults: { balance: config.balance } },
  screens: { slot: { base: await load(BASES, 'slot.svg'), heir: SLOT_HEIR, contract: SLOT_CONTRACT } },
  popups: {
    fsIntro: { base: await load(POPUPS, 'popups/fs-intro.svg'), ...SLOT_POPUPS.fsIntro },
    fsOutro: { base: await load(POPUPS, 'popups/fs-outro.svg'), ...SLOT_POPUPS.fsOutro },
    bigwin: { base: await load(POPUPS, 'popups/bigwin.svg'), ...SLOT_POPUPS.bigwin },
  },
  start: 'slot',
  sounds: sounds as Record<string, SoundSource>,
  components: slot.components,
  actions: slot.actions,
  collections: { skin: 'kit-skin' },
  assets: { resolve, initial: [...Object.values(art), ...Object.values(KIT_ART)] },
  cheats: {
    fixture: (name: unknown) => fixtures.select(String(name)),
    buy: () => void slot.player.spin('fs'),
    balance: (v: unknown): void => {
      game.state.balance = Number(v);
    },
    /** The choreography log (seq, row, action) — e2e evidence. */
    log: () => slot.player.director.log.map((e) => ({ t: e.t, seq: e.seq, row: e.row, action: e.action, dur: e.dur })),
    /** The choreography's clock, ms (the loop's game time). */
    now: () => slot.player.director.now(),
    /** The reels' grid (feed letters). */
    grid: () => slot.reels.grid(),
  },
});

slot.attach(game);
game.state.balance = game.save.data.balance > 0 ? game.save.data.balance : config.balance;
// Space / Enter = spin (or stop); taps go through the scene buttons.
game.input.on((a) => a === 'action' && slot.actions.spinOrStop());
