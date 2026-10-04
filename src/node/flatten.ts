// node/flatten.ts — flatten a scene file into a vanilla SVG file (the `trempel-flatten` CLI, the
// `npm run flatten` script): read the documents and the project's collections, measure the
// pictures, write hrefs relative to the output (or embed them as data: URIs with --embed).

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { readHeir, sceneStem } from '../compat.js';
import { flattenLeftovers, flattenScene } from '../flatten.js';
import type { SceneSource } from '../prefab.js';
import { imageSize, mimeOf } from './imagesize.js';
import { loadProject } from './project.js';

export interface FlattenFileOptions {
  /** The scene: X.svg, X.tml.svg, its stem, or a folder holding scene.svg / scene.tml.svg. */
  scene: string;
  /** The output file (.svg). */
  out: string;
  /** Pictures as data: URIs — one self-contained file. */
  embed?: boolean;
  /** A state file (JSON); default — X.state.json next to the scene when present. */
  state?: string;
  /** font-family on the root (default Arial — what the runtime draws text without one with). */
  fontFamily?: string;
}

export interface FlattenFileResult {
  scene: string;
  out: string | null;
  errors: string[];
  warnings: string[];
  /** Collections the scene uses. */
  collections: string[];
}

const posix = (p: string): string => p.split(sep).join('/');

/** X.svg / X.tml.svg / X / a folder with scene.* → the stem (absolute), or null. */
export function sceneStemOf(arg: string): string | null {
  let abs = resolve(arg);
  if (existsSync(abs) && statSync(abs).isDirectory()) abs = join(abs, 'scene');
  const stem = sceneStem(abs);
  const read = (f: string): string | undefined => (existsSync(f) ? f : undefined);
  return read(`${stem}.svg`) || readHeir(read, stem) ? stem : null;
}

/** Synchronous scene loader over the file system: an absolute `X.svg` → its documents. */
function fileLoader(url: string): SceneSource | null {
  const stem = sceneStem(url);
  const read = (p: string): string | undefined => (existsSync(p) ? readFileSync(p, 'utf8') : undefined);
  const src = { base: read(`${stem}.svg`), heir: readHeir(read, stem), contract: read(`${stem}.contract.xml`) };
  return src.base != null || src.heir != null ? src : null;
}

/** Clip files next to a scene (anim/*.md, *.anim.md) — flatten cannot carry them. */
function clipsOf(stem: string): string[] {
  const dir = dirname(stem);
  const out: string[] = [];
  const anim = join(dir, 'anim');
  if (existsSync(anim) && statSync(anim).isDirectory()) out.push(...readdirSync(anim).filter((f) => f.endsWith('.md')).map((f) => `anim/${f}`));
  out.push(...readdirSync(dir).filter((f) => f.endsWith('.anim.md')));
  return out;
}

export function flattenFile(opts: FlattenFileOptions): FlattenFileResult {
  const stem = sceneStemOf(opts.scene);
  if (!stem) return { scene: opts.scene, out: null, errors: [`${opts.scene}: сцены нет (ни X.svg, ни X.tml.svg)`], warnings: [], collections: [] };
  const src = fileLoader(`${stem}.svg`)!;
  const project = loadProject(dirname(stem));
  const out = resolve(opts.out);
  const outDir = dirname(out);

  let state: Record<string, unknown> | undefined;
  const errors: string[] = [...project.errors];
  const stateFile = opts.state ? resolve(opts.state) : existsSync(`${stem}.state.json`) ? `${stem}.state.json` : null;
  if (stateFile) {
    try {
      const v: unknown = JSON.parse(readFileSync(stateFile, 'utf8'));
      if (v && typeof v === 'object' && !Array.isArray(v)) state = v as Record<string, unknown>;
      else errors.push(`${stateFile}: состояние должно быть JSON-объектом`);
    } catch (e) {
      errors.push(`${stateFile}: ${(e as Error).message}`);
    }
  }

  const local = (href: string): boolean => href.startsWith('/') && !href.startsWith('//');
  const r = flattenScene({
    ...src,
    path: `${stem}.svg`,
    loadScene: fileLoader,
    baseUrl: posix(`${stem}.svg`),
    collections: Object.fromEntries(Object.entries(project.collections).map(([k, v]) => [k, posix(v)])),
    state,
    fontFamily: opts.fontFamily ?? 'Arial',
    imageSize: (href) => (local(href) ? imageSize(href) : null),
    mapHref: (href) => {
      if (!local(href)) return href;
      if (opts.embed) {
        try {
          return `data:${mimeOf(href)};base64,${readFileSync(href).toString('base64')}`;
        } catch {
          errors.push(`${href}: картинки нет — не встроить`);
          return href;
        }
      }
      return posix(relative(outDir, href)) || basename(href);
    },
  });
  errors.push(...r.errors);
  const warnings = [...r.warnings];
  const clips = clipsOf(stem);
  if (clips.length) warnings.push(`клипы в ванильный SVG не переносятся (сцена в позе покоя): ${clips.join(', ')}`);
  if (!r.svg) return { scene: stem, out: null, errors, warnings, collections: r.collections };
  const left = flattenLeftovers(r.svg);
  if (left.length) errors.push(`в выходе остались: ${left.join(', ')}`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(out, r.svg);
  return { scene: stem, out, errors, warnings, collections: r.collections };
}
