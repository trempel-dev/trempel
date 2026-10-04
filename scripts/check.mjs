#!/usr/bin/env node
// check.mjs — CLI validator for a Trempel scene directory (parser + merge + contract + expressions +
// v0.7 geometry, v0.8 presentation attributes, no Pixi), and for md clips.
//
//   npm run check -- examples/motion
//   npm run check -- examples/motion --anim anim/motion.md     (clip path: from cwd, else from the scene dir)
//   npm run check -- --anim examples/motion/anim/motion.md     (scene: nearest folder up with scene.svg)
//   npm run check -- examples/prefabs/menu.svg                  (v0.9: one scene file)
//   npm run check -- examples/prefabs                           (a folder without scene.svg — every scene in it)
//
// Reads scene.svg (base), scene.tml.svg (heir, optional), scene.contract.xml (contract, optional),
// runs the same pipeline mount() uses (v0.9: prefab instances expanded, the tml:extends chain
// resolved from the files next to the scene — checks run over the expanded tree), prints a human-readable report, and exits
// non-zero on any problem. With --anim, also compiles the clips and checks their targets and paths
// against the merged scene. For CI and the "designer saved → pipeline complains BEFORE it ships" loop.
//
// v1.1: `@name/…` hrefs resolve by the project's collections (.trempel/project.mdz in the nearest
// ancestor of the scene); an unknown collection is an error.
//
// Imports the compiled Pixi-free core (dist/core.js — the package's `@trempel/scene/core` entry); the
// `check` npm script builds first.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { bindingErrors, collectionErrors, compileClipsResult, composeScene, expandCollection, geometryErrors, heirSuffix, propErrors, readHeir, sceneStem, usedCollections } from '../dist/core.js';
import { loadProject } from '../dist/node/project.js';

const cwd = process.env.INIT_CWD ?? process.cwd();
const args = process.argv.slice(2);
let dir = null;
let anim = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--anim') anim = args[++i];
  else if (!dir) dir = args[i];
}
if (!dir && !anim) {
  console.error('usage: npm run check -- <scene-dir> [--anim <clips.md>]');
  process.exit(2);
}

let animPath = null;
if (anim) {
  animPath = [resolve(cwd, anim), dir ? resolve(cwd, dir, anim) : null].find((p) => p && existsSync(p));
  if (!animPath) {
    console.error(`✗ --anim ${anim}: file not found`);
    process.exit(2);
  }
}
if (!dir) {
  // The scene the clips animate: the nearest folder up from the clip file holding scene.svg.
  for (let d = dirname(animPath); ; d = dirname(d)) {
    if (existsSync(join(d, 'scene.svg'))) {
      dir = relative(cwd, d) || '.';
      break;
    }
    if (dirname(d) === d || existsSync(join(d, 'package.json'))) break;
  }
}

const errors = [];
let tree = null;
let checked = [];
const used = new Set();

/** v1.1: the project's collections (name → absolute folder), from the scene (or clip) location. */
const project = loadProject(resolve(cwd, dir ?? dirname(animPath)));
errors.push(...project.errors);
const collections = project.collections;

/** Synchronous loader over the file system: `X.svg` → X.svg, X.tml.svg, X.contract.xml (absent — undefined). */
const fileLoader = (url) => {
  const stem = url.replace(/\.svg$/, '');
  const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : undefined);
  const src = { base: read(`${stem}.svg`), heir: readHeir(read, stem), contract: read(`${stem}.contract.xml`) };
  return src.base != null || src.heir != null ? src : null;
};

/** Check one scene by its stem (absolute path without .svg): the same pipeline mount() runs. */
function checkScene(stem, label) {
  const src = fileLoader(`${stem}.svg`);
  if (!src) {
    errors.push(`${label}: нет ни ${label}.svg, ни ${label}.tml.svg`);
    return null;
  }
  const out = [];
  let t = null;
  try {
    const url = (rel) => resolve(dirname(stem), expandCollection(rel, collections));
    const c = composeScene({ ...src, path: `${stem}.svg`, loadScene: fileLoader, url });
    out.push(...c.errors.parse, ...c.errors.contract, ...c.errors.merge, ...c.errors.prefab);
    t = c.tree;
    if (t) {
      // defs / clipPath / clip-path / geometry data (v0.7); v0.8 attributes; expressions — over the expanded tree.
      out.push(...geometryErrors(t), ...propErrors(t), ...bindingErrors(t), ...collectionErrors(t, collections));
      for (const name of usedCollections(t)) used.add(name);
    }
  } catch (e) {
    out.push(e.message);
  }
  errors.push(...out.map((e) => (label ? `${label}: ${e}` : e)));
  checked.push(label);
  return t;
}

/** Scene stems below a folder (X.svg / X.tml.svg, not node_modules / dot-folders). */
function sceneStems(root) {
  const out = new Set();
  const walk = (d) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      if (ent.name.startsWith('.') || ent.name === 'node_modules' || ent.name === 'dist') continue;
      const p = join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (heirSuffix(ent.name)) out.add(p.slice(0, -heirSuffix(ent.name).length));
      else if (ent.name.endsWith('.svg') && !/[\\/]art[\\/]/.test(p)) out.add(p.slice(0, -'.svg'.length));
    }
  };
  walk(root);
  return [...out].sort();
}

if (dir) {
  const root = resolve(cwd, dir);
  if (existsSync(root) && statSync(root).isFile()) {
    // One scene file: X.svg or X.tml.svg.
    tree = checkScene(sceneStem(root), '');
  } else if (existsSync(join(root, 'scene.svg')) || readHeir((f) => (existsSync(join(root, f)) ? f : undefined), 'scene')) {
    tree = checkScene(join(root, 'scene'), '');
  } else if (existsSync(root)) {
    // A folder of scenes (v0.9 prefabs): every scene in it, each prefixed with its name.
    const stems = sceneStems(root);
    if (!stems.length) {
      console.error(`✗ ${dir}: scene.svg not found (и других сцен в папке нет)`);
      process.exit(2);
    }
    for (const stem of stems) checkScene(stem, relative(root, stem));
  } else {
    console.error(`✗ ${dir}: not found`);
    process.exit(2);
  }
}

let clipCount = 0;
if (animPath) {
  const name = relative(cwd, animPath);
  const { clips, errors: clipErrors } = compileClipsResult(readFileSync(animPath, 'utf8'), tree ?? undefined);
  clipCount = Object.keys(clips).length;
  errors.push(...clipErrors.map((e) => `${name}: ${e}`));
}

const unique = [...new Set(errors)];
const what = [dir && `${dir}`, animPath && relative(cwd, animPath)].filter(Boolean).join(' + ');

if (unique.length === 0) {
  const scenes = checked.length > 1 ? `${checked.length} scenes: ` : '';
  const parts = [dir && `${scenes}base + prefabs + heir + contract + geometry + v0.8 attributes + expressions`, animPath && `${clipCount} clip(s)`].filter(Boolean);
  console.log(`✓ ${what}: valid (${parts.join('; ')}).`);
  if (used.size) console.log(`  использует коллекции: ${[...used].sort().map((n) => `@${n}`).join(', ')}`);
  process.exit(0);
}

console.error(`✗ ${what}: ${unique.length} problem(s):\n`);
for (const e of unique) console.error(`  • ${e}`);
process.exit(1);
