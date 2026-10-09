#!/usr/bin/env node
// anim-import.ts — the trempel-anim-import bin: Unity AnimationClips / Animator controllers → Trempel
// md clips (scene format §9).
//
//   trempel-anim-import <unity project | folder | X.prefab | X.controller | X.anim>… --out <dir>
//                       [--scene X.svg] [--map anim-map.md] [--ppu 100] [--ui-scale 1] [--fps 30]
//                       [--points 60] [--verify false] [--tex "{}.png"]
//
// Reads the YAML of the assets (Force Text serialization). A prefab with an Animator: its controller's
// states → clips named after the states, the Animator's GameObject is the root of the curve paths,
// the prefab gives the rest pose. A controller: its states. An .anim: one clip. Transitions are only
// listed in the report.
//
// Writes, per prefab / controller / loose clip, <out>/<name>.anim.md (every clip of it) and the
// compiled <name>.anim.json when it compiles; <out>/anim-map.md — every path, its node id (empty —
// unmatched) and how it was found: edit it and pass it back with --map (it wins over names);
// <out>/report.md|json — every clip auto / manual / hard per property, the events with their
// parameters, the transitions, and the verification: the md compiled and played by Trempel against
// Unity's own evaluation of the curves at --points times (position ±0.5 px, rotation ±0.5°,
// scale ±0.5 %, alpha ±0.01, tint ±1/255, tex exact).
//
//   --scene X.svg   a Trempel base made from the same prefab: ids by node name (the path's last
//                   segment), rest poses when there is no prefab, the scene the clips are verified on
//                   (without it — a synthetic one, a node per target)
//   --ppu           pixels per world unit — Transform positions (default 100)
//   --ui-scale      Trempel px per canvas px — RectTransform positions (default 1)
//   --fps           bake rate of the segments with no Trempel ease (default 30; refined where steep)
//   --tex           the md's $tex template of sprite names (default "{}.png")
//
// Exit: 0 — written (clips that fail the verification are findings in the report); 2 — usage / input
// error.

import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { counts, importAnim, verifyCounts, writeAnimImport } from '../anim-import/import.js';

interface Args {
  inputs: string[];
  out?: string;
  scene?: string;
  map?: string;
  ppu?: number;
  uiScale?: number;
  fps?: number;
  points?: number;
  verify: boolean;
  tex?: string;
  help: boolean;
}

const NUMERIC: Record<string, 'ppu' | 'uiScale' | 'fps' | 'points'> = { '--ppu': 'ppu', '--ui-scale': 'uiScale', '--fps': 'fps', '--points': 'points' };

function parse(argv: string[]): Args {
  const o: Args = { inputs: [], verify: true, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`E_ANIM_IMPORT_USAGE: ${a} needs a value`);
      return v;
    };
    if (a === '--out') o.out = value();
    else if (a === '--scene') o.scene = value();
    else if (a === '--map') o.map = value();
    else if (a === '--tex') o.tex = value();
    else if (a in NUMERIC) {
      const n = Number(value());
      if (!(n > 0)) throw new Error(`E_ANIM_IMPORT_USAGE: ${a} expects a positive number`);
      o[NUMERIC[a]] = n;
    } else if (a === '--verify') {
      const v = value();
      if (v !== 'true' && v !== 'false') throw new Error('E_ANIM_IMPORT_USAGE: --verify expects true or false');
      o.verify = v === 'true';
    } else if (a === '-h' || a === '--help') o.help = true;
    else if (a.startsWith('--')) throw new Error(`E_ANIM_IMPORT_USAGE: unknown option ${a}`);
    else o.inputs.push(a);
  }
  return o;
}

const USAGE =
  'usage: trempel-anim-import <unity project | folder | X.prefab | X.controller | X.anim>… --out <dir> [--scene X.svg] [--map anim-map.md] [--ppu 100] [--ui-scale 1] [--fps 30] [--points 60] [--verify false] [--tex "{}.png"]';

export function main(argv = process.argv.slice(2)): number {
  let a: Args;
  try {
    a = parse(argv);
  } catch (e) {
    console.error((e as Error).message);
    console.error(USAGE);
    return 2;
  }
  if (a.help) {
    console.log(USAGE);
    return 0;
  }
  if (!a.inputs.length || !a.out) {
    console.error(`E_ANIM_IMPORT_USAGE: ${!a.out ? '--out is required' : 'no input'}`);
    console.error(USAGE);
    return 2;
  }
  const cwd = process.env.INIT_CWD ?? process.cwd();
  try {
    const r = importAnim({
      inputs: a.inputs.map((i) => resolve(cwd, i)),
      scene: a.scene && resolve(cwd, a.scene),
      map: a.map && resolve(cwd, a.map),
      ppu: a.ppu,
      uiScale: a.uiScale,
      fps: a.fps,
      points: a.points,
      verify: a.verify,
      tex: a.tex,
    });
    const out = resolve(cwd, a.out);
    const w = writeAnimImport(r, out);
    const c = counts(r.clips);
    const v = verifyCounts(r.clips);
    console.log(`trempel-anim-import: ${w.md.length} md, ${c.total} clips (auto ${c.auto}, manual ${c.manual}, hard ${c.hard}), verification ${a.verify ? `${v.converged}/${v.checked} converged` : 'off'} → ${out}`);
    const unmatched = r.map.filter((m) => !m.id).length;
    if (unmatched) console.warn(`W_ANIM_IMPORT_UNMATCHED: ${unmatched} path(s) without a node id — ${join(out, 'anim-map.md')}`);
    const broken = r.groups.filter((g) => g.compileErrors.length).length;
    if (broken) console.warn(`W_ANIM_IMPORT_COMPILE: ${broken} md file(s) do not compile — ${join(out, 'report.md')}`);
    if (v.checked > v.converged) console.warn(`W_ANIM_IMPORT_VERIFY: ${v.checked - v.converged} clip(s) do not converge — ${join(out, 'report.md')}`);
    if (r.warnings.length) console.warn(`W_ANIM_IMPORT: ${r.warnings.length} warning(s) — ${join(out, 'report.md')}`);
    return 0;
  } catch (e) {
    const m = (e as Error).message;
    console.error(/^[EW]_[A-Z0-9_]+: /.test(m) ? m : `E_ANIM_IMPORT: ${m}`);
    return 2;
  }
}

// Run as the bin (through npm's .bin link too), not when imported by tests.
const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) process.exitCode = main();
