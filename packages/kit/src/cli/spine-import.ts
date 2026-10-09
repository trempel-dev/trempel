#!/usr/bin/env node
// spine-import.ts — the trempel-spine-import bin: Spine skeletons → Trempel scenes and md clips.
//
//   trempel-spine-import <skeleton.json | folder>… [--out <dir>] [--atlas x.atlas] [--fps 30]
//                        [--skin <name>] [--points 60] [--art false] [--verify false]
//                        [--frames 0,0.5,1 [--clip <name>]]
//
// Per skeleton (Spine JSON 3.5–4.2 + its atlas, `<name>.atlas` next to it by default): scene.svg —
// the sterile base (bone → nested <g id> with the setup pose, slot → <g id="<slot>-slot"> with its
// <image>s in the draw order, slot colour → data-tint, blend → mix-blend-mode); <name>.anim.md — md
// clips (bones → relative x y rotation scaleX scaleY, bezier → [x1,y1,x2,y2], stepped → step,
// slot alpha / colour → alpha / tint, attachments → tex or alpha 0/1, draw order timelines → z,
// events → $events) and the compiled <name>.anim.json; art/<region>.png — the atlas cut, no
// metadata; report.md — what was transferred and what not, and the verification: our own Spine
// pose sampler against Trempel's player (headless) at --points per animation. A folder → every
// Spine skeleton in it (*.json with bones and skeleton) into <out>/<name>/, plus <out>/summary.md.
// --frames: the clip frozen at those seconds as frames/<clip>@<t>.svg (any viewer draws them).
// The Spine runtime is not used: the JSON is read by our own code, from the format documentation.
// Exit: 0 — written (verification findings are in the reports); 1 — a skeleton failed (stderr);
// 2 — usage / input error.

import { realpathSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importSkeletons, skeletonFiles, type SpineImportOptions } from '../spine-import/import.js';

const USAGE =
  'usage: trempel-spine-import <skeleton.json | folder>… [--out dir] [--atlas x.atlas] [--fps 30] [--skin name] [--points 60] [--art false] [--verify false] [--frames 0,0.5,1 [--clip name]]';

const FLAGS = new Set(['out', 'atlas', 'fps', 'skin', 'points', 'art', 'verify', 'frames', 'clip']);

function parse(argv: string[]): { inputs: string[]; flags: Record<string, string>; help: boolean } {
  const o = { inputs: [] as string[], flags: {} as Record<string, string>, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') o.help = true;
    else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (!FLAGS.has(key)) throw new Error(`E_SPINE_IMPORT_USAGE: unknown option --${key}`);
      const value = eq > 0 ? a.slice(eq + 1) : argv[++i];
      if (value === undefined) throw new Error(`E_SPINE_IMPORT_USAGE: --${key} needs a value`);
      o.flags[key] = value;
    } else o.inputs.push(a);
  }
  return o;
}

export function main(argv = process.argv.slice(2)): number {
  let a: ReturnType<typeof parse>;
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
  if (!a.inputs.length) {
    console.error('E_SPINE_IMPORT_USAGE: no input');
    console.error(USAGE);
    return 2;
  }
  const cwd = process.env.INIT_CWD ?? process.cwd();
  const f = a.flags;
  const fps = Number(f.fps ?? 30);
  const points = Number(f.points ?? 60);
  if (!(fps > 0) || !(points >= 2)) {
    console.error('E_SPINE_IMPORT_USAGE: --fps > 0, --points >= 2');
    return 2;
  }
  const frames = f.frames?.split(',').map(Number);
  if (frames?.some((t) => !Number.isFinite(t) || t < 0)) {
    console.error('E_SPINE_IMPORT_USAGE: --frames 0,0.5,1 — seconds, comma separated');
    return 2;
  }
  try {
    const files = skeletonFiles(a.inputs.map((i) => resolve(cwd, i)));
    if (!files.length) {
      console.error('E_SPINE_IMPORT_INPUT: no Spine skeletons (*.json with bones and skeleton) found');
      return 2;
    }
    const out = resolve(cwd, f.out ?? (files.length > 1 ? 'out' : join('out', basename(files[0], '.json'))));
    const opts: SpineImportOptions = {
      out,
      atlas: f.atlas ? resolve(cwd, f.atlas) : undefined,
      fps,
      skin: f.skin,
      points,
      art: f.art !== 'false',
      verify: f.verify !== 'false',
      frames,
      clip: f.clip,
    };
    const r = importSkeletons(files, opts);
    for (const l of r.lines) console.log(l);
    for (const x of r.failed) console.error(/^[EW]_[A-Z0-9_]+: /.test(x.error) ? x.error : `E_SPINE_IMPORT: ${x.name}: ${x.error}`);
    console.log(`→ ${files.length > 1 ? join(out, 'summary.md') : out}`);
    return r.failed.length ? 1 : 0;
  } catch (e) {
    const m = (e as Error).message;
    console.error(/^[EW]_[A-Z0-9_]+: /.test(m) ? m : `E_SPINE_IMPORT: ${m}`);
    return 2;
  }
}

// Run as the bin (through npm's .bin link too), not when imported by tests.
const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) process.exitCode = main();
