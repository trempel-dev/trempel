#!/usr/bin/env node
// migrate-v1.mjs — a folder of scenes to Trempel v1.0 (MIGRATION.md §9). Text edits only: the rest of
// every file stays byte for byte.
//
//   node scripts/migrate-v1.mjs <scenes-dir> [--slices slices.json] [--write]
//
//   1. --slices: a Unity-style table `{ "<sprite stem>": { "px": "WxH", "border": "L.. B.. R.. T.." } }`
//      → `data-slices="l t r b"` on every <image> of a base (*.svg, not *.tml.svg) whose href stem is
//      in the table and that has no data-slices yet. A border leaving the centre < 1 px (Unity allows
//      it, the format does not) is reported and skipped. data-slices are PNG pixels: when the file
//      is smaller than the table's `px` (a downscaled export) the borders are scaled to it (sharp).
//   2. v1.0 anchors need a box: a plain <g> holding data-anchor / data-stretch children (the kit
//      anchored them to the canvas whatever the nesting) gets `data-size="<viewBox w h>"
//      data-stretch="xy"` — when it has no transform and sits in the root (then it is the canvas,
//      exactly the kit's semantics). Anything else is reported for a hand fix.
//
// Without --write it only reports. Prints one line per change / problem; exit 0.

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { DOMParser } from '@xmldom/xmldom';

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--slices');
const slicesPath = args.includes('--slices') ? args[args.indexOf('--slices') + 1] : null;
const write = args.includes('--write');
if (!dir) {
  console.error('usage: node scripts/migrate-v1.mjs <scenes-dir> [--slices slices.json] [--write]');
  process.exit(2);
}

let sharp = null;
try {
  sharp = (await import('sharp')).default;
} catch {
  // no sharp: borders as in the table
}

/** The image's real pixel size, null when unknown. */
async function sizeOf(file) {
  if (!sharp) return null;
  try {
    const m = await sharp(file).metadata();
    return m.width && m.height ? [m.width, m.height] : null;
  } catch {
    return null;
  }
}

/** "L135 B0 R127 T0" + "380x188" (+ the file's real size) → [l, t, r, b] or a problem. */
function border(entry, real) {
  const v = (k) => Number(entry.border.match(new RegExp(`${k}(\\d+)`))?.[1] ?? 0);
  let s = [v('L'), v('T'), v('R'), v('B')];
  let [w, h] = (entry.px ?? '').split('x').map(Number);
  let note = '';
  if (real && w && h && (real[0] !== w || real[1] !== h)) {
    const kx = real[0] / w;
    const ky = real[1] / h;
    s = [Math.round(s[0] * kx), Math.round(s[1] * ky), Math.round(s[2] * kx), Math.round(s[3] * ky)];
    note = ` (from ${entry.px} → the file ${real[0]}×${real[1]})`;
    [w, h] = real;
  }
  if (w && h && (w - s[0] - s[2] < 1 || h - s[1] - s[3] < 1)) return { problem: `the centre ${w - s[0] - s[2]}×${h - s[1] - s[3]} px at ${w}×${h}` };
  return { slices: s, note };
}

const table = slicesPath ? JSON.parse(readFileSync(slicesPath, 'utf8')) : {};
const stem = (href) => href.replace(/[?#].*$/, '').replace(/^.*\//, '').replace(/\.[^.]+$/, '');

const files = [];
const walk = (d) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (f.endsWith('.svg') && !f.endsWith('.tml.svg')) files.push(p);
  }
};
walk(dir);

const kids = (el) => {
  const out = [];
  for (let c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) out.push(c);
  return out;
};
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

for (const file of files) {
  const rel = relative(dir, file);
  let text = readFileSync(file, 'utf8');
  const before = text;

  // 1. slices
  const real = new Map();
  for (const m of text.matchAll(/<image\b[^>]*\shref="([^"]*)"/g)) {
    if (table[stem(m[1])] && !real.has(m[1])) real.set(m[1], await sizeOf(resolve(dirname(file), m[1].replace(/[?#].*$/, ''))));
  }
  text = text.replace(/<image\b[^>]*>/g, (tag) => {
    const href = /\shref="([^"]*)"/.exec(tag)?.[1];
    if (!href || /\sdata-slices=/.test(tag)) return tag;
    const entry = table[stem(href)];
    if (!entry) return tag;
    const b = border(entry, real.get(href));
    const id = /\sid="([^"]*)"/.exec(tag)?.[1];
    if (b.problem) {
      console.log(`! ${rel} ${id ? '#' + id : href}: ${stem(href)} — ${b.problem}: the centre needs at least 1 px, data-slices not set`);
      return tag;
    }
    console.log(`+ ${rel} ${id ? '#' + id : href}: data-slices="${b.slices.join(' ')}"${b.note}`);
    return tag.replace(/\s*(\/?)>$/, ` data-slices="${b.slices.join(' ')}"$1>`);
  });

  // 2. boxes for nested anchors
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const root = doc.documentElement;
  const vb = (root?.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  const asks = (el) => kids(el).some((c) => c.hasAttribute('data-anchor') || c.hasAttribute('data-stretch'));
  const visit = (el) => {
    for (const c of kids(el)) {
      if (c.nodeName === 'g' && !c.hasAttribute('data-size') && asks(c)) {
        const id = c.getAttribute('id');
        const where = id ? `#${id}` : '<g>';
        if (el === root && !c.hasAttribute('transform') && id && vb.length === 4) {
          console.log(`+ ${rel} ${where}: data-size="${vb[2]} ${vb[3]}" data-stretch="xy" (the children's anchors follow the canvas, as in the kit)`);
          text = text.replace(new RegExp(`<g\\b([^>]*\\sid="${esc(id)}"[^>]*?)(\\s*/?)>`), `<g$1 data-size="${vb[2]} ${vb[3]}" data-stretch="xy"$2>`);
        } else {
          console.log(`! ${rel} ${where}: anchors in a group without a size — give it data-size="w h" (and data-stretch if it stretches with the canvas) or move the nodes to the root`);
        }
      }
      visit(c);
    }
  };
  if (root) visit(root);

  if (text !== before && write) writeFileSync(file, text);
}
if (!write) console.log('(a report; --write — write the changes)');
