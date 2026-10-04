#!/usr/bin/env node
// anim-compile.mjs — md clips → anim.json (the runtime form; never written by hand).
//
//   npm run anim:compile -- examples/motion/anim/motion.md [--scene examples/motion] [--out x.json]
//                                                           [--tex "art/{}.png"]
//
// Output: next to the source with .json (motion.md → motion.json) unless --out. With a scene (given,
// or the nearest folder up from the clip file holding scene.svg) targets and paths are checked
// against the merged scene — the same check as `npm run check -- --anim`. A `tex` cell becomes an href
// by the clips' own `$tex` (v0.9.1); --tex ("{}" — the cell) overrides it. Exit 1 with the list on any
// problem; nothing is written then.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { compileClipsResult, mergeScene, parse, parseHeir } from '../dist/core.js';

const cwd = process.env.INIT_CWD ?? process.cwd();
const args = process.argv.slice(2);
const opt = {};
const pos = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) opt[args[i].slice(2)] = args[++i];
  else pos.push(args[i]);
}
if (!pos[0]) {
  console.error('usage: npm run anim:compile -- <clips.md> [--scene <dir>] [--out <file.json>] [--tex "art/{}.png"]');
  process.exit(2);
}
const src = resolve(cwd, pos[0]);
if (!existsSync(src)) {
  console.error(`✗ ${pos[0]}: not found`);
  process.exit(2);
}

let sceneDir = opt.scene ? resolve(cwd, opt.scene) : null;
if (!sceneDir) {
  for (let d = dirname(src); ; d = dirname(d)) {
    if (existsSync(join(d, 'scene.svg'))) {
      sceneDir = d;
      break;
    }
    if (dirname(d) === d || existsSync(join(d, 'package.json'))) break;
  }
}

let scene;
if (sceneDir) {
  try {
    scene = parse(readFileSync(join(sceneDir, 'scene.svg'), 'utf8'));
    const heir = join(sceneDir, 'scene.tml.svg');
    if (existsSync(heir)) scene = mergeScene(scene, parseHeir(readFileSync(heir, 'utf8'))).tree;
  } catch (e) {
    console.error(`✗ scene ${relative(cwd, sceneDir)}: ${e.message}`);
    process.exit(1);
  }
}

const tex = opt.tex ? (name) => opt.tex.replaceAll('{}', name) : undefined;
const { clips, errors } = compileClipsResult(readFileSync(src, 'utf8'), scene, { tex });
if (errors.length) {
  console.error(`✗ ${relative(cwd, src)}: ${errors.length} problem(s):\n`);
  for (const e of errors) console.error(`  • ${e}`);
  process.exit(1);
}

/** JSON with small objects/arrays (keys, offsets, beziers) on one line — diffs by key, like DON's anim.json. */
function inline(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(inline).join(', ')}]`;
  return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`).join(', ')}}`;
}

function pretty(v, indent = '') {
  const flat = inline(v);
  const nested = v !== null && typeof v === 'object' && !Array.isArray(v) && ('tracks' in v || 'keys' in v);
  if (v === null || typeof v !== 'object' || (flat.length <= 72 && !nested)) return flat;
  const inner = indent + '  ';
  if (Array.isArray(v)) return `[\n${v.map((x) => inner + pretty(x, inner)).join(',\n')}\n${indent}]`;
  const entries = Object.entries(v).map(([k, x]) => `${inner}${JSON.stringify(k)}: ${pretty(x, inner)}`);
  return `{\n${entries.join(',\n')}\n${indent}}`;
}

const out = opt.out ? resolve(cwd, opt.out) : src.replace(/\.md$/, '') + '.json';
writeFileSync(out, pretty(clips) + '\n');
console.log(`✓ ${relative(cwd, src)} → ${relative(cwd, out)} (${Object.keys(clips).length} clip(s)${scene ? ', checked against the scene' : ''}).`);
