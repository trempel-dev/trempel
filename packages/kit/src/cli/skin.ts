#!/usr/bin/env node
// skin.ts — `trempel-skin <skin-folder> [--bundle <dir>] [--scenes <dir,dir>] [--debug sheet.png]`
// Measures the skin's art into skin.json `files`: the pixel
// size of every PNG of the folder and the 9-slice borders of the files listed in skin.json
// `stretch` (measured on the art — never typed in). The hand-written part of skin.json (tokens,
// stretch, slice…) is kept. Validates the skin and its map.
//   --bundle  also write webp copies of the files the game uses (map roles + `added` + art hrefs
//             under the folder in the scene bases of --scenes) — what the game ships;
//   --root    the scene href prefix of the folder (default: the folder path as given, e.g. art/ui/).
// Needs `sharp` (an optional peer dependency of @trempel/kit).

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { validateSkin, type SkinFile, type SkinJson, type SkinMap } from '../ui/skin/format.js';
import { measureSlice, premultiply } from '../ui/skin/measure.js';

type Sharp = typeof import('sharp');

async function loadSharp(): Promise<Sharp> {
  try {
    return (await import('sharp')).default as unknown as Sharp;
  } catch {
    throw new Error('trempel-skin needs sharp: npm i -D sharp');
  }
}

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (f.endsWith('.png') && !f.includes('contact-sheet')) out.push(p);
  }
  return out;
}

/** Files the game draws: role targets, `added`, `<root><file>` hrefs in the scene bases. */
export function usedFiles(map: SkinMap, root: string, sceneDirs: string[]): string[] {
  const used = new Set<string>();
  for (const v of Object.values(map.roles)) if (typeof v === 'string') used.add(v);
  for (const [k, v] of Object.entries(map.added ?? {})) if (!k.startsWith('$')) used.add(v);
  const re = new RegExp(`${root.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}([\\w/-]+\\.png)`, 'g');
  for (const dir of sceneDirs) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.svg'))) for (const m of readFileSync(join(dir, f), 'utf8').matchAll(re)) used.add(m[1]);
  }
  return [...used].sort();
}

export async function skinCli(argv: string[]): Promise<void> {
  const opt = (k: string) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);
  const folder = argv.find((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
  if (!folder) throw new Error('usage: trempel-skin <skin-folder> [--bundle dir] [--scenes dir,dir] [--root art/ui/] [--debug sheet.png]');
  const sharp = await loadSharp();
  const jsonPath = join(folder, 'skin.json');
  const mapPath = join(folder, 'skin-map.json');
  const json = JSON.parse(readFileSync(jsonPath, 'utf8')) as SkinJson;
  const map: SkinMap = existsSync(mapPath) ? JSON.parse(readFileSync(mapPath, 'utf8')) : { roles: {} };
  const stretch = new Set(json.stretch ?? []);
  const files: Record<string, SkinFile> = {};
  for (const p of walk(folder).sort()) {
    const rel = relative(folder, p).split('\\').join('/');
    const { data, info } = await sharp(p).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    files[rel] = { size: [info.width, info.height] };
    if (stretch.has(rel)) files[rel].slice = measureSlice(premultiply(data, info.width, info.height));
  }
  for (const s of stretch) if (!files[s]) throw new Error(`trempel-skin: stretch ${s} is not in ${folder}`);
  const next = { ...json, files };
  const errors = validateSkin(next, map, (f) => existsSync(join(folder, f)));
  if (errors.length) throw new Error(`trempel-skin: the skin is invalid —\n  ${errors.join('\n  ')}`);
  writeFileSync(jsonPath, JSON.stringify(next, null, 2) + '\n');
  console.log(`trempel-skin: ${Object.keys(files).length} files, ${stretch.size} 9-slice → ${jsonPath}`);

  const bundle = opt('--bundle');
  if (bundle) {
    const root = (opt('--root') ?? folder).replace(/^\.\//, '').replace(/\/?$/, '/');
    const used = usedFiles(map, root, (opt('--scenes') ?? '').split(',').filter(Boolean));
    rmSync(bundle, { recursive: true, force: true });
    for (const f of used) {
      if (!files[f]) throw new Error(`trempel-skin: used file ${f} is not in ${folder}`);
      const out = join(bundle, f.replace(/\.png$/, '.webp'));
      mkdirSync(dirname(out), { recursive: true });
      await sharp(join(folder, f)).webp({ quality: 90, alphaQuality: 100 }).toFile(out);
    }
    console.log(`trempel-skin: ${used.length} used files → ${bundle}/*.webp`);
  }

  const dbg = opt('--debug');
  if (dbg) {
    // Contact sheet of the 9-slice art with the slice lines (eyeballing the borders).
    let y = 0;
    const comps: { input: Buffer; left: number; top: number }[] = [];
    for (const rel of stretch) {
      const { size, slice } = files[rel];
      const [L, T, R, B] = slice!;
      const [w, h] = size;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><g stroke="#ff00ff" stroke-width="1"><line x1="${L}" y1="0" x2="${L}" y2="${h}"/><line x1="${w - R}" y1="0" x2="${w - R}" y2="${h}"/><line x1="0" y1="${T}" x2="${w}" y2="${T}"/><line x1="0" y1="${h - B}" x2="${w}" y2="${h - B}"/></g></svg>`;
      comps.push({ input: await sharp(join(folder, rel)).composite([{ input: Buffer.from(svg) }]).png().toBuffer(), left: 0, top: y });
      y += h + 10;
    }
    const W = Math.max(1, ...[...stretch].map((r) => files[r].size[0]));
    await sharp({ create: { width: W, height: Math.max(1, y), channels: 4, background: '#30343c' } }).composite(comps).png().toFile(dbg);
  }
}

if (process.argv[1] && /skin\.(js|ts)$/.test(process.argv[1]) && !process.env.VITEST) {
  skinCli(process.argv.slice(2)).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
