#!/usr/bin/env node
// migrate-tml.mjs — move a consumer's scene folder from the previous names of the format to Trempel's.
//
//   node scripts/migrate-tml.mjs <folder> [--dry-run]
//
// Below <folder> (node_modules, dist, .git skipped):
//   X.gml.svg            → X.tml.svg
//   gameml.view.ts       → trempel.view.ts  (+ its imports 'gameml…' → '@trempel/scene…')
//   .gml/                → .trempel/        (+ macros: the `gml` object → `tml`)
//   *.svg                — prefix gml: → tml:, xmlns http://gameml.dev/ns → https://trempel.dev/ns/scene
//
// Idempotent: a second run changes nothing. A rename onto an existing file is reported, not done.
// Prints what it did (or would do, with --dry-run); exit 1 when a conflict was left.

import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const NS = 'https://trempel.dev/ns/scene';
const SKIP = new Set(['node_modules', 'dist', '.git']);

const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const folder = args.find((a) => !a.startsWith('--'));
if (!folder) {
  console.error('usage: node scripts/migrate-tml.mjs <folder> [--dry-run]');
  process.exit(2);
}
const root = resolve(folder);
if (!existsSync(root) || !statSync(root).isDirectory()) {
  console.error(`${folder}: not a folder`);
  process.exit(2);
}

const rel = (p) => relative(root, p) || '.';
let changes = 0;
let conflicts = 0;

/** Scene document: the prefix and the namespace. */
export function upgradeSvg(src) {
  return src
    .replace(/(\s)xmlns:gml(\s*=\s*)(["'])[^"']*\3/g, `$1xmlns:tml$2$3${NS}$3`)
    .replace(/(\s)xmlns:tml(\s*=\s*)(["'])http:\/\/gameml\.dev\/ns\3/g, `$1xmlns:tml$2$3${NS}$3`)
    .replace(/(<\/?)gml:/g, '$1tml:')
    .replace(/(\s)gml:([A-Za-z_][\w.-]*\s*=)/g, '$1tml:$2');
}

/** Consumer module: package specifiers. */
const upgradeModule = (src) => src.replace(/(['"])gameml(\/[\w-]+)?\1/g, (_, q, sub = '') => `${q}@trempel/scene${sub}${q}`);

/** Editor macro: the scripting object is `tml` now (`window.gml`, `gml.doc…`). */
const upgradeMacro = (src) => src.replace(/\bwindow\.gml\b/g, 'window.tml').replace(/(^|[^\w.$])gml(?=\s*[.([])/g, '$1tml');

function rewrite(file, fn) {
  const src = readFileSync(file, 'utf8');
  const out = fn(src);
  if (out === src) return;
  changes++;
  console.log(`${dry ? 'would edit' : 'edit'}  ${rel(file)}`);
  if (!dry) writeFileSync(file, out);
}

function move(from, to) {
  if (existsSync(to)) {
    conflicts++;
    console.log(`conflict  ${rel(from)} → ${rel(to)}: target exists, left as is`);
    return from;
  }
  changes++;
  console.log(`${dry ? 'would move' : 'move'}  ${rel(from)} → ${rel(to)}`);
  if (dry) return from;
  renameSync(from, to);
  return to;
}

function walk(dir, inMacros) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(ent.name)) continue;
    let p = join(dir, ent.name);
    if (ent.isDirectory()) {
      const macrosHere = inMacros || ent.name === '.gml' || ent.name === '.trempel';
      if (ent.name === '.gml') p = move(p, join(dir, '.trempel'));
      walk(p, macrosHere);
      continue;
    }
    if (ent.name.endsWith('.gml.svg')) p = move(p, join(dir, ent.name.slice(0, -'.gml.svg'.length) + '.tml.svg'));
    else if (ent.name === 'gameml.view.ts') p = move(p, join(dir, 'trempel.view.ts'));
    if (p.endsWith('.svg')) rewrite(p, upgradeSvg);
    else if (p.endsWith('.view.ts')) rewrite(p, upgradeModule);
    else if (inMacros && /\.(js|mjs)$/.test(p)) rewrite(p, upgradeMacro);
  }
}

walk(root, false);
console.log(`${changes} change(s)${dry ? ' (dry run)' : ''}${conflicts ? `, ${conflicts} conflict(s)` : ''}`);
process.exit(conflicts ? 1 : 0);
