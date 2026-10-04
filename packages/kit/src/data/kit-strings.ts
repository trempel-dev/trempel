// kit-strings.ts — strings of the kit's screen templates (`ui.*`), merged UNDER the game's i18n
// tables: a game overrides any of them by declaring the same key.

import type { Strings } from './i18n.js';

export const KIT_STRINGS: Record<string, Strings> = {
  en: {
    'ui.title': 'MY GAME',
    'ui.play': 'PLAY',
    'ui.settings': 'SETTINGS',
    'ui.sound': 'SOUND',
    'ui.music': 'MUSIC',
    'ui.pause': 'PAUSE',
    'ui.resume': 'RESUME',
    'ui.menu': 'MENU',
    'ui.restart': 'RESTART',
    'ui.continue': 'CONTINUE',
    'ui.ok': 'OK',
    'ui.close': 'CLOSE',
    'ui.win': 'YOU WIN!',
    'ui.lose': 'GAME OVER',
    'ui.score': 'SCORE {n}',
    'ui.best': 'BEST {n}',
    'ui.reward': 'REWARD',
    'ui.claim': 'CLAIM',
    'ui.double': 'x2',
    'ui.loading': 'LOADING',
    'ui.level': 'LEVEL {n}',
  },
  ru: {
    'ui.title': 'МОЯ ИГРА',
    'ui.play': 'ИГРАТЬ',
    'ui.settings': 'НАСТРОЙКИ',
    'ui.sound': 'ЗВУК',
    'ui.music': 'МУЗЫКА',
    'ui.pause': 'ПАУЗА',
    'ui.resume': 'ДАЛЬШЕ',
    'ui.menu': 'МЕНЮ',
    'ui.restart': 'ЗАНОВО',
    'ui.continue': 'ДАЛЕЕ',
    'ui.ok': 'ОК',
    'ui.close': 'ЗАКРЫТЬ',
    'ui.win': 'ПОБЕДА!',
    'ui.lose': 'ИГРА ОКОНЧЕНА',
    'ui.score': 'СЧЁТ {n}',
    'ui.best': 'РЕКОРД {n}',
    'ui.reward': 'НАГРАДА',
    'ui.claim': 'ЗАБРАТЬ',
    'ui.double': 'x2',
    'ui.loading': 'ЗАГРУЗКА',
    'ui.level': 'УРОВЕНЬ {n}',
  },
};

/** The game's tables with the kit's strings under them (the game's languages; none → the kit's). */
export function withKitStrings(game: Record<string, Strings> | undefined): Record<string, Strings> {
  const langs = game && Object.keys(game).length ? Object.keys(game) : Object.keys(KIT_STRINGS);
  return Object.fromEntries(langs.map((l) => [l, { ...(KIT_STRINGS[l.toLowerCase().split(/[-_]/)[0]] ?? KIT_STRINGS.en), ...(game?.[l] ?? {}) }]));
}
