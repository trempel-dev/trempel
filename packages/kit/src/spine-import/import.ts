// import.ts — trempel-spine-import: Spine skeletons (JSON 3.5–4.2 + atlas) → Trempel data. Per
// skeleton: scene.svg (the sterile base), <name>.anim.md (md clips) and the compiled
// <name>.anim.json, art/<region>.png cut from the atlas (no metadata), report.md with what was / was
// not transferred and the verification against Trempel's own player; a folder of skeletons also
// gets summary.md.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { compileClipsResult, parse } from '@trempel/scene';
import { cutRegions } from './art.js';
import { parseAtlas } from './atlas.js';
import { buildClips } from './clips.js';
import { clipsOf, posedSvg } from './frames.js';
import { convergedCount, skeletonReport, summaryReport, type SkeletonOutcome } from './report.js';
import { buildRig, defaultHref, sceneSvg } from './rig.js';
import { isSkeleton, readSkeleton } from './spine.js';
import { verify } from './verify.js';

export interface SpineImportOptions {
  /** Atlas of a single skeleton (default `<skeleton>.atlas` next to it). */
  atlas?: string;
  out: string;
  fps?: number;
  skin?: string;
  points?: number;
  art?: boolean;
  verify?: boolean;
  /** Times (s) to freeze `clip` at as static scenes in frames/ (render check). */
  frames?: number[];
  clip?: string;
}

/** Inputs: files as given, folders → every *.json in them that is a Spine skeleton. */
export function skeletonFiles(args: string[]): string[] {
  const out: string[] = [];
  for (const a of args) {
    if (!existsSync(a)) throw new Error(`E_SPINE_IMPORT_INPUT: ${a} not found`);
    if (statSync(a).isDirectory()) {
      for (const f of readdirSync(a).sort()) {
        if (!f.endsWith('.json')) continue;
        const p = join(a, f);
        try {
          if (isSkeleton(JSON.parse(readFileSync(p, 'utf8')))) out.push(p);
        } catch {
          // not JSON — not a skeleton
        }
      }
    } else out.push(a);
  }
  return out;
}

/** Import one skeleton into `opts.out`. @throws with a code when it cannot be imported. */
export function importSkeleton(file: string, opts: SpineImportOptions): SkeletonOutcome {
  const name = basename(file, '.json');
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`E_SPINE_IMPORT_INPUT: ${name}: ${(e as Error).message}`);
  }
  const sk = readSkeleton(json, name);
  const rig = buildRig(sk, { skin: opts.skin });
  const svg = sceneSvg(sk, rig);
  const { md, stats } = buildClips(sk, rig, { fps: opts.fps, skin: opts.skin });
  mkdirSync(opts.out, { recursive: true });
  writeFileSync(join(opts.out, 'scene.svg'), svg);
  writeFileSync(join(opts.out, `${name}.anim.md`), md);

  const compiled = compileClipsResult(md, parse(svg), { tex: defaultHref });
  if (!compiled.errors.length) writeFileSync(join(opts.out, `${name}.anim.json`), JSON.stringify(compiled.clips, null, 1) + '\n');

  let missingRegions: string[] = [];
  let artWritten = 0;
  if (opts.art !== false) {
    const atlasFile = opts.atlas ?? file.replace(/\.json$/, '.atlas');
    if (!existsSync(atlasFile)) throw new Error(`E_SPINE_IMPORT_INPUT: ${name}: atlas ${atlasFile} not found (--atlas)`);
    const atlas = parseAtlas(readFileSync(atlasFile, 'utf8'), basename(atlasFile));
    const cut = cutRegions(atlas, dirname(atlasFile), rig.regions, join(opts.out, 'art'));
    missingRegions = cut.missing;
    artWritten = cut.written.length;
  }
  const v = opts.verify !== false ? verify(sk, rig, svg, md, stats, { points: opts.points, skin: opts.skin }) : null;
  if (opts.frames?.length) {
    const clips = clipsOf(svg, md);
    const want = opts.clip ?? stats[0]?.clip;
    const clip = want ? clips[want] : undefined;
    if (!clip) throw new Error(`E_SPINE_IMPORT_USAGE: ${name}: no clip "${want ?? ''}" (clips: ${Object.keys(clips).join(', ')})`);
    mkdirSync(join(opts.out, 'frames'), { recursive: true });
    for (const t of opts.frames) writeFileSync(join(opts.out, 'frames', `${want}@${t}.svg`), posedSvg(svg, clip, t, (h) => `../${h}`));
  }
  const outcome: SkeletonOutcome = { sk, rig, stats, verify: v, missingRegions, artWritten };
  writeFileSync(join(opts.out, 'report.md'), skeletonReport(outcome));
  return outcome;
}

export interface FolderResult {
  outcomes: SkeletonOutcome[];
  failed: { name: string; error: string }[];
  /** One line per skeleton (stdout of the bin). */
  lines: string[];
}

/** Import several skeletons: each into `<out>/<name>/` (one — into `out` itself), summary.md for many. */
export function importSkeletons(files: string[], opts: SpineImportOptions): FolderResult {
  const many = files.length > 1;
  if (many && opts.atlas) throw new Error('E_SPINE_IMPORT_USAGE: --atlas is for one skeleton (several look for <name>.atlas next to each)');
  const outcomes: SkeletonOutcome[] = [];
  const failed: { name: string; error: string }[] = [];
  const lines: string[] = [];
  for (const f of files) {
    const name = basename(f, '.json');
    try {
      const o = importSkeleton(f, { ...opts, out: many ? join(opts.out, name) : opts.out });
      outcomes.push(o);
      const v = o.verify ? `check ${convergedCount(o)}/${o.stats.length}` : 'not checked';
      lines.push(`${name}: ${o.sk.bones.length} bones, ${o.sk.slots.length} slots, ${o.stats.length} clips, ${v}`);
    } catch (e) {
      const m = (e as Error).message;
      failed.push({ name, error: m.split('\n')[0] });
    }
  }
  if (many) {
    mkdirSync(opts.out, { recursive: true });
    writeFileSync(join(opts.out, 'summary.md'), summaryReport(outcomes, failed));
  }
  return { outcomes, failed, lines };
}
