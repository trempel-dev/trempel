// skin.ts — a skin at runtime: tokens, roles → looks, scene hrefs → art URLs. Scenes reference
// skin art three ways:
//   href="skin:<role>"           the role's art (or a procedural fill / hidden);
//   href="<root>/<file>"         an art file of the skin folder directly (root: e.g. 'art/ui/');
//   any href `hrefRole` maps     a game's own role convention (e.g. 'ui/<role>.webp' — a sprite
//                                inventory the game already has).
// Components ask `look(role)`: art (URL, size, 9-slice), a fill colour, hidden, or null — not in the
// map → the component draws it procedurally from the tokens.

import { ColorMatrixFilter } from 'pixi.js';
import { DEFAULT_SKIN } from './default.js';
import { validateSkin, type RoleValue, type SkinFile, type SkinJson, type SkinMap, type SlotIconMode } from './format.js';

/** Marker hrefs the kit's backend turns into procedural nodes (never loaded). */
export const NONE_HREF = 'skin:none';
export const FILL_PREFIX = 'skin:fill:';
export const ROLE_PREFIX = 'skin:';

export interface SkinSource {
  json: SkinJson;
  map?: SkinMap;
  /** Art file (relative to the skin folder, 'kit/btn.png') → bundle URL. `import.meta.glob` keys work too (see `artTable`). */
  art?: Record<string, string>;
  /** Scene hrefs under this prefix ('art/ui/') name skin files directly ('art/ui/kit/x.png' → 'kit/x.png'). */
  root?: string;
  /** A game's own role convention: scene href → role (undefined: not a role). */
  hrefRole?: (href: string) => string | undefined;
}

export type Look =
  | { kind: 'art'; role: string; file: string; url: string; size: [number, number]; slice?: [number, number, number, number] }
  | { kind: 'fill'; role: string; color: number; token: string }
  | { kind: 'none'; role: string };

export function parseHex(c: string): number {
  return parseInt(c.slice(1), 16);
}

/**
 * Art table from `import.meta.glob(...)` keys: strips everything up to `marker` (e.g. 'skin/') and
 * maps extension swaps back to the source names ('kit/x.webp' → 'kit/x.png' when `as` = '.png').
 */
export function artTable(glob: Record<string, string>, marker: string, as?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, url] of Object.entries(glob)) {
    const i = k.indexOf(marker);
    if (i < 0) continue;
    let f = k.slice(i + marker.length);
    if (as) f = f.replace(/\.[^.\/]+$/, as);
    out[f] = url;
  }
  return out;
}

export class Skin {
  readonly json: SkinJson;
  readonly map: SkinMap;
  readonly name: string;
  private readonly art: Map<string, string>;
  private readonly fileOfUrl: Map<string, string>;
  private readonly root: string | undefined;
  private readonly hrefRole: ((href: string) => string | undefined) | undefined;

  constructor(src: SkinSource) {
    const errors = validateSkin(src.json, src.map);
    if (errors.length) throw new Error(`kit skin "${src.json?.name ?? '?'}":\n  ${errors.join('\n  ')}`);
    this.json = src.json;
    this.map = src.map ?? { roles: {} };
    this.name = src.json.name ?? 'skin';
    this.art = new Map(Object.entries(src.art ?? {}));
    this.fileOfUrl = new Map([...this.art].map(([f, u]) => [u, f]));
    this.root = src.root?.replace(/^\.?\//, '');
    this.hrefRole = src.hrefRole;
    for (const [role, v] of Object.entries(this.map.roles)) {
      if (typeof v === 'string' && !this.art.has(v)) throw new Error(`kit skin "${this.name}": role ${role} → "${v}" has no bundle URL (art table)`);
    }
  }

  /** Colour token → 0xRRGGBB (fail loud). */
  color(token: string): number {
    const c = this.json.colors[token];
    if (!c) throw new Error(`kit skin "${this.name}": unknown colour token "${token}" (known: ${Object.keys(this.json.colors).join(', ')})`);
    return parseHex(c);
  }

  /** Colour token, or the first of the fallbacks that exists, or `last`. */
  colorOr(tokens: string[], last: number): number {
    for (const t of tokens) {
      const c = this.json.colors[t];
      if (c) return parseHex(c);
    }
    return last;
  }

  has(token: string): boolean {
    return token in this.json.colors;
  }

  font(role: 'heading' | 'text'): string {
    return this.json.fonts[role].family;
  }

  fontWeight(role: 'heading' | 'text'): string | undefined {
    return this.json.fonts[role].weight;
  }

  /** Corner radius of a component of height h (design units). */
  radius(component: string, h: number): number {
    const r = this.json.radii?.[component] ?? 0;
    return r === 'pill' ? h / 2 : Math.min(r, h / 2);
  }

  get outline(): number {
    return this.json.outline ?? 0;
  }

  get states() {
    return this.json.states;
  }

  get slotIcon(): SlotIconMode {
    return this.json.slotIcon ?? 'color';
  }

  /** The look of a role; null when the map does not name it (draw procedurally). */
  look(role: string): Look | null {
    if (!(role in this.map.roles)) return null;
    const v: RoleValue = this.map.roles[role];
    if (v === null) return { kind: 'none', role };
    if (typeof v === 'string') {
      const meta = this.fileMeta(v);
      return { kind: 'art', role, file: v, url: this.art.get(v)!, size: meta.size, slice: meta.slice };
    }
    if ('fill' in v) return { kind: 'fill', role, color: this.color(v.fill), token: v.fill };
    return null; // keep: the scene's own art
  }

  /** First role of the list the map names (button.green → button.primary…). */
  lookAny(roles: string[]): Look | null {
    for (const r of roles) {
      const l = this.look(r);
      if (l) return l;
    }
    return null;
  }

  /** Size and 9-slice of an art file (fail loud when not measured). */
  fileMeta(file: string): SkinFile {
    const m = this.json.files?.[file];
    if (!m) throw new Error(`kit skin "${this.name}": ${file} has no entry in skin.json files (run trempel-skin)`);
    return m;
  }

  /** Art meta of a resolved URL (size, 9-slice), or null when the URL is not this skin's art. */
  artMeta(url: string): (SkinFile & { file: string }) | null {
    const file = this.fileOfUrl.get(url);
    if (!file) return null;
    return { ...this.fileMeta(file), file };
  }

  /** Design units per art px of a 9-slice art in a box of height `boxH`. */
  sliceScale(file: string, artH: number, boxH: number): number {
    const s = this.json.slice?.[file] ?? this.json.slice?.default ?? 'height';
    return s === 'height' ? boxH / artH : s;
  }

  /**
   * A scene href through the skin: art URL, a marker (NONE_HREF, FILL_PREFIX + token), or undefined
   * when the skin does not own the href (the game's resolver gets it).
   */
  resolve(href: string): string | undefined {
    const h = href.replace(/^(\.\.\/|\.\/)+/, '');
    if (h.startsWith(ROLE_PREFIX) && !h.startsWith(FILL_PREFIX) && h !== NONE_HREF) return this.roleHref(h.slice(ROLE_PREFIX.length), true);
    if (this.root && h.startsWith(this.root)) {
      const f = h.slice(this.root.length);
      const url = this.art.get(f);
      if (!url) throw new Error(`kit skin "${this.name}": no art "${f}" (href ${href})`);
      return url;
    }
    const role = this.hrefRole?.(h);
    return role === undefined ? undefined : this.roleHref(role, false);
  }

  private roleHref(role: string, strict: boolean): string | undefined {
    const l = this.look(role);
    if (!l) {
      if (strict) throw new Error(`kit skin "${this.name}": role "${role}" is not in the skin map — kit components draw unmapped roles, scenes cannot`);
      return undefined;
    }
    return l.kind === 'art' ? l.url : l.kind === 'fill' ? FILL_PREFIX + l.token : NONE_HREF;
  }

  /** Every art URL the skin draws (preloaded with the initial bundle). */
  urls(): string[] {
    const used = new Set<string>();
    for (const v of Object.values(this.map.roles)) if (typeof v === 'string') used.add(v);
    for (const [k, f] of Object.entries(this.map.added ?? {})) if (!k.startsWith('$')) used.add(f);
    return [...used].map((f) => this.art.get(f)).filter((u): u is string => !!u);
  }

  /** Darkening multiplier of a held button, as a tint. */
  pressedTint(): number {
    const v = Math.round(255 * this.states.pressed.darken);
    return (v << 16) | (v << 8) | v;
  }

  /** The disabled state: desaturate + darken (a filter on the node). */
  disabledFilter(): ColorMatrixFilter {
    const d = this.states.disabled;
    const f = new ColorMatrixFilter();
    if (d.saturation <= 0) f.desaturate();
    else f.saturate(d.saturation - 1, false);
    if (d.darken !== 1) f.brightness(d.darken, true);
    return f;
  }
}

/** A skin from its data (fails loud on an invalid skin). */
export function createSkin(src: SkinSource): Skin {
  return new Skin(src);
}

/** The kit's default skin (procedural). */
export function defaultSkin(): Skin {
  return new Skin({ json: DEFAULT_SKIN });
}
