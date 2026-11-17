// prefab-art.mjs — the art of examples/prefabs, drawn (no third-party art): plaques for 9-slice with a
// uniform middle (borders hold the corners and the bevel; the middle is a flat run that stretches).
//
//   node scripts/prefab-art.mjs     → examples/prefabs/ui/art/*.png
//
// btn / green — 240×72, slices "28 0" (data-resizable="x": only the width stretches);
// shade / shade-hover / shade-down — the same plaque's light / dark overlay;
// panel — 320×240, slices "40 72 40 40" (a header band in the top border).

import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const out = fileURLToPath(new URL('../examples/prefabs/ui/art/', import.meta.url));
mkdirSync(out, { recursive: true });

/** A horizontal plaque: rounded ends, vertical gradient and a top gloss — nothing varies along x in the middle. */
const plaque = (w, h, top, bottom, edge) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/>
    </linearGradient>
    <linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.45"/><stop offset="1" stop-color="#ffffff" stop-opacity="0.05"/>
    </linearGradient>
  </defs>
  <rect x="2" y="2" width="${w - 4}" height="${h - 4}" rx="16" fill="url(#fill)" stroke="${edge}" stroke-width="3"/>
  <rect x="10" y="7" width="${w - 20}" height="${(h - 14) / 2}" rx="10" fill="url(#gloss)"/>
</svg>`;

/** The shade overlays: the same outline, flat colour. */
const shade = (w, h, color, opacity) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect x="2" y="2" width="${w - 4}" height="${h - 4}" rx="16" fill="${color}" fill-opacity="${opacity}"/>
</svg>`;

/** A popup panel: a frame with a header band (in the top border) and a flat body. */
const panel = (w, h) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="head" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#6a7cff"/><stop offset="1" stop-color="#3f4fd0"/>
    </linearGradient>
  </defs>
  <rect x="3" y="3" width="${w - 6}" height="${h - 6}" rx="26" fill="#f4efe2" stroke="#2b2f55" stroke-width="5"/>
  <path d="M 6 29 Q 6 6 29 6 L ${w - 29} 6 Q ${w - 6} 6 ${w - 6} 29 L ${w - 6} 64 L 6 64 Z" fill="url(#head)"/>
  <rect x="6" y="62" width="${w - 12}" height="4" fill="#2b2f55" fill-opacity="0.35"/>
  <rect x="16" y="78" width="${w - 32}" height="${h - 96}" rx="14" fill="#e6dfcc"/>
</svg>`;

const files = {
  'btn.png': plaque(240, 72, '#5b8cff', '#2f5fd6', '#1d3f9e'),
  'green.png': plaque(240, 72, '#5fd17a', '#2f9e4a', '#1d6e33'),
  'shade.png': shade(240, 72, '#000000', 0),
  'shade-hover.png': shade(240, 72, '#ffffff', 0.18),
  'shade-down.png': shade(240, 72, '#000000', 0.25),
  'panel.png': panel(320, 240),
};

for (const [name, svg] of Object.entries(files)) {
  await sharp(Buffer.from(svg)).png().toFile(out + name);
  console.log(`ui/art/${name}`);
}
