// i18n.ts — minimal i18n: string tables per language, picked by the platform language (exact,
// then base "ru-RU" → "ru", then the fallback). `t('key', { n: 3 })` substitutes {n}. A missing
// key returns the key itself and is reported once (visible, not silent). In scenes: the kit puts
// `t` into the Trempel context, so `tml:bind="t('menu.play')"` works.

export type Strings = Record<string, string>;

export class I18n {
  readonly lang: string;
  private readonly table: Strings;
  private readonly fallback: Strings;
  private readonly missing = new Set<string>();

  constructor(tables: Record<string, Strings>, language: string, fallbackLang = 'en') {
    const langs = Object.keys(tables);
    const base = language.toLowerCase().split(/[-_]/)[0];
    const pick = langs.find((l) => l.toLowerCase() === language.toLowerCase()) ?? langs.find((l) => l.toLowerCase() === base);
    this.lang = pick ?? (fallbackLang in tables ? fallbackLang : (langs[0] ?? fallbackLang));
    this.table = tables[this.lang] ?? {};
    this.fallback = tables[fallbackLang] ?? {};
  }

  /** Translate; {name} placeholders from `params`. */
  t = (key: string, params?: Record<string, string | number>): string => {
    let s = this.table[key] ?? this.fallback[key];
    if (s === undefined) {
      if (!this.missing.has(key)) {
        this.missing.add(key);
        console.warn(`kit i18n: no string "${key}" for "${this.lang}"`);
      }
      return key;
    }
    if (params) s = s.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
    return s;
  };
}
