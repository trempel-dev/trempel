#!/usr/bin/env node
// shot.mjs — headless snapshot of one Trempel scene through the viewer page (Playwright, Chromium).
//
//   npm run view:shot -- <scene> [--state s.json] [--viewport 9:16|1080x1920|scene] [--out out.png]
//                        [--dir folder] [--module trempel.view.ts] [--clip <name> --t <sec> [--t <sec>…]]
//
// --clip poses the scene by a clip of the scene (anim/*.md, *.anim.md next to it — always the md clip;
// `tex` → href by its $tex, a compiled .json next to it is ignored) at each --t (seconds; default 0). One --t → --out as is;
// several → one PNG each with the time as a suffix (out-0.4.png, out-1.png).
//
// <scene> is any file of the scene (X.svg, X.tml.svg, X.contract.xml, X.state.json) or its stem;
// a folder holding scene.svg / scene.tml.svg means that scene.
// The scene folder is --dir, else the nearest ancestor (up to the project root) holding a
// trempel.view.ts, else the scene's own folder. X.state.json next to the scene is used unless
// --state is given.
//
// stdout: one JSON object { scene, dir, out, viewport, width, height, errors, warnings, stubs }
// (+ clip, frames: [{ t, out }] with --clip).
// Exit code: 0 — drawn, no errors; 1 — the scene has errors (PNG still written when possible);
// 2 — usage / infrastructure failure.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const cwd = process.env.INIT_CWD ?? process.cwd();
const SUFFIXES = ['.tml.svg', '.contract.xml', '.state.json', '.svg'];

function parseArgs(argv) {
  const out = { _: [], t: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--t') out.t.push(argv[++i]);
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
    else out._.push(a);
  }
  return out;
}

function fail(message, code = 2) {
  console.log(JSON.stringify({ errors: [{ level: 'error', kind: 'cli', message }] }, null, 2));
  process.exit(code);
}

/**
 * Nearest folder from `start` up holding a consumer module (trempel.view.ts — the plugin picks the
 * exact file); stops at a project root (package.json / .git).
 */
function findViewRoot(start) {
  let d = start;
  for (;;) {
    if (readdirSync(d).some((f) => f.endsWith('.view.ts'))) return d;
    if (existsSync(join(d, 'package.json')) || existsSync(join(d, '.git'))) return null;
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

const args = parseArgs(process.argv.slice(2));
const sceneArg = args._[0];
if (!sceneArg) fail('usage: npm run view:shot -- <scene> [--state s.json] [--viewport 9:16] [--out out.png]');

// A folder with the conventional scene (scene.svg / scene.tml.svg) stands for that scene.
let abs = resolve(cwd, sceneArg);
if (existsSync(abs) && statSync(abs).isDirectory() && SUFFIXES.some((s) => existsSync(join(abs, 'scene' + s)))) abs = join(abs, 'scene');
// X.svg, X.tml.svg (or an heir under an older name), X.contract.xml, X.state.json → X
const stem = abs.replace(/(\.[a-z]+)?\.svg$|\.contract\.xml$|\.state\.json$/, '');
if (!SUFFIXES.some((s) => existsSync(stem + s))) fail(`${sceneArg}: no scene files (${SUFFIXES.map((s) => basename(stem) + s).join(', ')})`);

const dir = args.dir ? resolve(cwd, args.dir) : (findViewRoot(dirname(stem)) ?? dirname(stem));
if (!stem.startsWith(dir + sep)) fail(`${sceneArg}: scene is outside the folder ${dir}`);
const id = relative(dir, stem).split(sep).join('/');
const out = resolve(cwd, args.out ?? `${basename(stem)}.png`);
const times = args.t.map((v) => {
  const n = Number(v);
  if (v == null || v === '' || !Number.isFinite(n) || n < 0) fail(`--t ${v}: нужно число секунд ≥ 0`);
  return n;
});
if (times.length && !args.clip) fail('--t без --clip: время — в каком клипе?');
/** PNG path of frame i: --out itself for one frame, with the time as a suffix for several. */
const frameOut = (t) => (times.length > 1 ? out.replace(/(\.png)?$/i, `-${t}.png`) : out);
let state;
if (args.state) {
  const p = resolve(cwd, args.state);
  if (!existsSync(p)) fail(`--state ${args.state}: file not found`);
  state = readFileSync(p, 'utf8');
}

process.env.TML_VIEW_DIR = dir;
process.env.TML_VIEW_QUIET = '1';
if (args.module) process.env.TML_VIEW_MODULE = resolve(cwd, args.module);

const { createServer } = await import('vite');
const { chromium } = await import('playwright');

let server;
let browser;
let code = 2;
try {
  server = await createServer({
    configFile: fileURLToPath(new URL('./vite.config.ts', import.meta.url)),
    // own optimizer cache: a running `npm run view` (.vite-view) never re-optimizes under us
    cacheDir: fileURLToPath(new URL('../node_modules/.vite-shot', import.meta.url)),
    server: { port: 0, strictPort: false, hmr: false },
  });
  await server.listen();
  const url = server.resolvedUrls?.local?.[0];
  if (!url) throw new Error('vite did not report a local URL');

  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(`${url}?headless=1`);
  await page.waitForFunction(() => !!window.tmlView, null, { timeout: 60_000 });
  const r = await page.evaluate(({ id, state, viewport, clip, t }) => window.tmlView.shoot(id, { state, viewport, clip, t }), {
    id,
    state,
    viewport: args.viewport,
    clip: args.clip,
    t: times,
  });

  const write = (file, data) => writeFileSync(file, Buffer.from(data.replace(/^data:image\/png;base64,/, ''), 'base64'));
  const frames = args.clip ? (r.frames ?? []).map((f) => ({ t: f.t, out: frameOut(f.t), png: f.png })) : null;
  if (frames?.length) for (const f of frames) write(f.out, f.png);
  else write(out, r.png);
  const errors = [...r.issues.filter((i) => i.level === 'error'), ...pageErrors.map((m) => ({ level: 'error', kind: 'page', message: m }))];
  const warnings = r.issues.filter((i) => i.level !== 'error');
  const clipInfo = frames ? { clip: args.clip, frames: frames.map(({ t, out: o }) => ({ t, out: o })) } : {};
  const first = frames?.[0]?.out ?? out;
  console.log(JSON.stringify({ scene: id, dir, out: first, viewport: r.viewport, width: r.width, height: r.height, ...clipInfo, errors, warnings, stubs: r.stubs }, null, 2));
  code = errors.length ? 1 : 0;
} catch (e) {
  console.log(JSON.stringify({ scene: id, dir, errors: [{ level: 'error', kind: 'cli', message: e instanceof Error ? e.message : String(e) }] }, null, 2));
  code = 2;
} finally {
  await browser?.close();
  await server?.close();
}
process.exit(code);
