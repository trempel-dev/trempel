// texts.ts — string tables (the kit picks the platform language; scenes call t('key')). The kit's
// screens use `ui.*` keys with the kit's own strings — override any of them here.
export const TEXTS = {
  en: { 'ui.title': 'MY GAME', score: '{n}', 'ui.lose': 'TIME UP' },
  ru: { 'ui.title': 'МОЯ ИГРА', score: '{n}', 'ui.lose': 'ВРЕМЯ ВЫШЛО' },
};
