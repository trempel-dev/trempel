#!/usr/bin/env node
// shot.mjs — headless snapshot of one Trempel scene through the viewer page (Playwright, Chromium).
//
//   npm run view:shot -- <scene> [--state s.json] [--viewport 9:16|1080x1920|scene] [--out out.png]
//                        [--dir folder] [--module trempel.view.ts] [--settle <sec>] [--clip <name> --t <sec> [--t <sec>…]]
//
// The page runs on Playwright's virtual clock (page.clock): time stands still while the scene loads,
// then moves only in fixed frame steps of 1/60 s. --settle (default 2) plays that many seconds of
// virtual time after the mount before the picture — intro animations finish; --settle 0 is the
// frame right after the mount. Same scene, same flags → the same PNG, bit for bit.
//
// --clip poses the scene by a clip of the scene (anim/*.md, *.anim.md next to it — always the md clip;
// `tex` → href by its $tex, a compiled .json next to it is ignored) at each --t (seconds; default 0). One --t → --out as is;
// several → one PNG each with the time as a suffix (out-0.4.png, out-1.png).
//
// <scene> is any file of the scene (X.svg, X.tml.svg, X.contract.xml, X.state.json) or its stem;
// a folder holding scene.svg / scene.tml.svg means that scene.
// The scene folder is --dir, else the nearest ancestor (up to the project root) holding a
// trempel.view.ts, else — v1.1 — the Trempel project root (the folder with .trempel/project.mdz:
// its collections and every file under it are served), else the scene's own folder. X.state.json next to the scene is used unless
// --state is given.
//
// stdout: one JSON object { scene, dir, out, viewport, width, height, errors, warnings, stubs }
// (+ clip, frames: [{ t, out }] with --clip).
// Exit code: 0 — drawn, no errors; 1 — the scene has errors (PNG still written when possible);
// 2 — usage / infrastructure failure.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const cwd = process.env.INIT_CWD ?? process.cwd();
const SUFFIXES = ['.tml.svg', '.contract.xml', '.state.json', '.svg'];
/** Virtual clock: start time (ms since the epoch — a fixed date) and one frame step. */
const CLOCK_START = Date.UTC(2026, 0, 1);
/** install() this far before CLOCK_START, so pauseAt(CLOCK_START) is always ahead of the running clock. */
const PAUSE_AHEAD = 10_000;
/** 2.3: the scene mounts at this moment — always ahead of what loading the page leaked onto the clock. */
const CLOCK_OPEN = CLOCK_START + 60_000;
const FRAME_MS = 1000 / 60;

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
  console.log(JSON.stringify({ errors: [{ level: 'error', kind: 'cli', message: `E_CLI: ${message}` }] }, null, 2));
  process.exit(code);
}

/**
 * Nearest folder from `start` up holding a consumer module (trempel.view.ts — the plugin picks the
 * exact file); stops at a project root (package.json / .git), v1.1 — at a Trempel project root
 * (.trempel/project.mdz), which is the folder then.
 */
function findViewRoot(start) {
  let d = start;
  for (;;) {
    if (readdirSync(d).some((f) => f.endsWith('.view.ts'))) return d;
    if (existsSync(join(d, '.trempel', 'project.mdz'))) return d;
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
  if (v == null || v === '' || !Number.isFinite(n) || n < 0) fail(`--t ${v}: expected seconds >= 0`);
  return n;
});
if (times.length && !args.clip) fail('--t without --clip: a time in which clip?');
const settle = args.settle == null ? 2 : Number(args.settle);
if (!Number.isFinite(settle) || settle < 0) fail(`--settle ${args.settle}: expected seconds >= 0`);
/** Frames of virtual time played before the picture (--settle seconds at 60 fps). */
const settleFrames = Math.round(settle * 60);
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
    // own optimizer cache per folder: a running `npm run view` (.vite-view) never re-optimizes under
    // us, and shots of different projects do not re-bundle each other's dependencies
    cacheDir: fileURLToPath(new URL(`../node_modules/.vite-shot/${createHash('sha1').update(`${dir}\n${args.module ?? ''}`).digest('hex').slice(0, 12)}`, import.meta.url)),
    server: { port: 0, strictPort: false, hmr: false },
  });
  await server.listen();
  const url = server.resolvedUrls?.local?.[0];
  if (!url) throw new Error('vite did not report a local URL');

  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  // Virtual time: performance.now, Date, requestAnimationFrame and timers of the page are fake and
  // stand still; only the frame steps below move them. Loading (fetch, textures) does not depend on
  // them, so the picture depends on the scene and the number of frames, never on the machine.
  let page;
  let pageErrors = [];
  for (let attempt = 1; ; attempt++) {
    page = await browser.newPage();
    pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    // install() starts the fake clock running; by the time pauseAt() comes a few real ms have passed,
    // and pausing at a moment already past leaves them on the clock (2.2: a frame more or less on the
    // 16 ms frame grid — effects of the kit differed). Pausing at a moment ahead is exact.
    await page.clock.install({ time: CLOCK_START - PAUSE_AHEAD });
    await page.clock.pauseAt(CLOCK_START);
    await page.goto(`${url}?headless=1`);
    const deadline = Date.now() + 60_000;
    while (!(await page.evaluate(() => !!window.tmlView))) {
      if (Date.now() > deadline) throw new Error('the viewer page did not start in 60 s');
      await new Promise((r) => setTimeout(r, 50));
    }
    // A cold optimizer cache may re-bundle the dependencies while the page loads (a dependency of
    // the consumer module found late): the page then holds chunks of two bundles — two pixi.js.
    // Such a page is thrown away; the next one loads the settled bundle.
    const bundles = await page.evaluate(() => [
      ...new Set(performance.getEntriesByType('resource').map((e) => /\/deps\/[^?]+\?v=([0-9a-f]+)/.exec(e.name)?.[1]).filter(Boolean)),
    ]);
    if (bundles.length <= 1 || attempt >= 3) break;
    await page.close();
  }
  // 2.3: loading the page leaks real time onto the paused clock (a new document picks the clock up
  // where it is now) — a few ms, more under load; a node that counts its time from its mount (an
  // effect) then started a tick later on a busy machine. The scene mounts at a fixed moment ahead.
  await page.clock.pauseAt(CLOCK_OPEN);
  const opened = await page.evaluate(({ id, state, viewport }) => window.tmlView.open(id, { state, viewport }), { id, state, viewport: args.viewport });
  // Settle to fixed moments of the page clock (CLOCK_OPEN + i frames), not by steps from "now" (2.2).
  for (let i = 1; i <= settleFrames; i++) {
    const now = await page.evaluate(() => Date.now());
    const ahead = Math.round(CLOCK_OPEN + i * FRAME_MS) - now;
    if (ahead > 0) await page.clock.runFor(ahead);
  }
  const r = { ...opened, ...(await page.evaluate(({ clip, t }) => window.tmlView.snap({ clip, t }), { clip: args.clip, t: times })) };

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
  const message = e instanceof Error ? e.message : String(e);
  console.log(JSON.stringify({ scene: id, dir, errors: [{ level: 'error', kind: 'cli', message: /^[EW]_[A-Z0-9_]+: /.test(message) ? message : `E_CLI: ${message}` }] }, null, 2));
  code = 2;
} finally {
  await browser?.close();
  await server?.close();
}
process.exit(code);
