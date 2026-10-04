// default.ts — the kit's default skin: neutral and fully procedural (no art at all — every role is
// drawn from these tokens), so the templates and an agent work out of the box. A game's own skin
// (art + map) replaces it: createGame({ skin: createSkin({ json, map, art }) }).

import type { SkinJson } from './format.js';

export const DEFAULT_SKIN: SkinJson = {
  name: 'default',
  colors: {
    bg: '#1b2131',
    onBg: '#f2f4f8',
    'onBg.muted': '#9aa3b5',
    primary: '#3d7bfd',
    onPrimary: '#ffffff',
    secondary: '#24a865',
    onSecondary: '#ffffff',
    danger: '#e5484d',
    onDanger: '#ffffff',
    neutral: '#e4e7ee',
    onNeutral: '#1f2430',
    accent: '#ffb020',
    onAccent: '#1f2430',
    surface: '#f6f7fa',
    onSurface: '#1f2430',
    'surface.dark': '#2a2f3a',
    'onSurface.dark': '#f2f4f8',
    muted: '#6b7280',
    outline: '#c9ced8',
    shade: '#000000',
    dim: '#0b0e14',
    track: '#d5d9e2',
    fill: '#3d7bfd',
    found: '#24a865',
    hint: '#ffb020',
    star: '#ffc531',
    'star.empty': '#cfd4de',
    silhouette: '#2a2f3a',
  },
  fonts: { heading: { family: 'sans-serif', weight: 'bold' }, text: { family: 'sans-serif' } },
  radii: { button: 'pill', iconButton: 'pill', plate: 'pill', panel: 28, popup: 40, progress: 'pill', badge: 'pill' },
  outline: 0,
  states: {
    pressed: { scale: 0.8, darken: 0.85 },
    disabled: { saturation: 0, darken: 0.95, alpha: 0.6 },
    hover: { brighten: 1.06 },
  },
  slotIcon: 'color',
  slice: { default: 'height' },
};
