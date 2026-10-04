// i18n.ts — the example's texts (main.ts and trempel.view.ts share them).

export const TEXTS: Record<string, Record<string, string>> = {
  ru: { menu: 'Меню', play: 'Играть', settings: 'Настройки', exit: 'Выход', paused: 'Игра на паузе' },
  en: { menu: 'Menu', play: 'Play', settings: 'Settings', exit: 'Exit', paused: 'Paused' },
};

/** t(key) over a state with `lang`. */
export const translator =
  (state: Record<string, unknown>) =>
  (key: string): string =>
    TEXTS[String(state.lang ?? 'ru')]?.[key] ?? key;
