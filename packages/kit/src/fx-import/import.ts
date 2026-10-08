// import.ts — trempel-fx-import: Unity particle systems straight from a Unity project (prefabs and
// scenes as YAML) → the kit's effects. An effect = a GameObject with a ParticleSystem and no particle
// system above it, with the systems under it (parent first) — what Unity plays as one prefab. Its
// name is the GameObject's path in its asset ('FindDiffPopup/PopupForm/CFX_Hit_C White'); every config
// keeps `key` (the same path of its own system) and `cls`.
//
// Output (writeImport): effects.json — { name: ParticleConfig[] }, createGame({ fx: { effects } }) as
// is; textures/<name>.png — the textures they use, without metadata; report.md / report.json — every
// system auto / manual / hard with what is exact, approximated, not played.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ParticleConfig, RGBA } from '../fx/types.js';
import { texturePng } from './image.js';
import { assetsUnder, fileStem, goPath, UnityProject, type UAsset, type UGameObject, type UObject } from './project.js';
import { BUILTIN_SHADERS, convertSystem, type MaterialInfo, type SystemClass, type SystemContext } from './shuriken.js';
import { isRepeated, list, map, num, ref, type YamlMap, type YamlValue } from './yaml.js';

export interface ImportOptions {
  /** Unity project folder, a folder inside it, or .prefab / .unity files. */
  inputs: string[];
  /** Pixels per world unit (sprites' pixelsPerUnit; default 100). */
  ppu?: number;
  /** Only effects whose name starts with one of these. */
  only?: string[];
}

export interface SystemReport {
  key: string;
  effect: string;
  asset: string;
  cls: SystemClass;
  /** Active in its asset's hierarchy (an inactive one is a template turned on by code — or dead). */
  active: boolean;
  space: SystemContext['space'];
  unit: [number, number];
  texture: string;
  exact: string[];
  approx: string[];
  unsupported: string[];
}

export interface ImportResult {
  project: string;
  effects: Record<string, ParticleConfig[]>;
  systems: SystemReport[];
  /** Texture name → source file (absolute). */
  textures: Map<string, string>;
  warnings: string[];
  assets: number;
}

const BUILTIN_GUID = '0000000000000000f000000000000000';

export function importUnity(opts: ImportOptions): ImportResult {
  if (!opts.inputs.length) throw new Error('E_FX_IMPORT_INPUT: nothing to import (a Unity project, a folder or .prefab / .unity files)');
  const first = resolve(opts.inputs[0]);
  const root = UnityProject.rootOf(first);
  if (!root) throw new Error(`E_FX_IMPORT_INPUT: ${opts.inputs[0]} is not inside a Unity project (no Assets/ above it)`);
  const project = new UnityProject(root);
  const files: string[] = [];
  for (const i of opts.inputs) {
    const p = resolve(i);
    if (!existsSync(p)) throw new Error(`E_FX_IMPORT_INPUT: ${i} not found`);
    if (statSync(p).isDirectory()) files.push(...assetsUnder(p === root ? join(root, 'Assets') : p));
    else if (/\.(prefab|unity)$/.test(p)) files.push(p);
    else throw new Error(`E_FX_IMPORT_INPUT: ${i}: not a .prefab / .unity`);
  }
  const ppu = opts.ppu ?? 100;
  const effects: Record<string, ParticleConfig[]> = {};
  const systems: SystemReport[] = [];
  const textures = new Map<string, string>();
  const warnings: string[] = [];
  const materials = new Map<string, MaterialInfo | null>();
  const scripts = new Map<string, string>();

  const scriptName = (o: UObject): string => {
    const g = ref(o.body.m_Script)?.guid;
    if (!g) return '';
    let n = scripts.get(g);
    if (n === undefined) {
      const p = project.pathOf(g);
      n = p ? fileStem(p) : '';
      scripts.set(g, n);
    }
    return n;
  };

  const material = (r: ReturnType<typeof ref>): MaterialInfo | null => {
    if (!r) return null;
    if (r.guid === BUILTIN_GUID) return { path: `builtin:${r.fileID}`, builtin: null, shader: `built-in material ${r.fileID}`, texture: null, colors: {} };
    const key = r.guid ?? '';
    if (materials.has(key)) return materials.get(key)!;
    const p = project.pathOf(r.guid);
    let info: MaterialInfo | null = null;
    if (p && p.endsWith('.mat')) {
      try {
        info = readMaterial(project, p);
      } catch (e) {
        warnings.push(`${project.rel(p)}: ${(e as Error).message}`);
      }
    } else warnings.push(`material ${r.guid} not found`);
    materials.set(key, info);
    return info;
  };

  const seen = new Set<string>();
  for (const file of files) {
    let asset: UAsset;
    try {
      asset = project.asset(file);
    } catch (e) {
      warnings.push(`${project.rel(file)}: ${(e as Error).message}`);
      continue;
    }
    warnings.push(...asset.warnings);
    const isPs = (go: UGameObject) => go.components.some((c) => c.type === 'ParticleSystem');
    const roots: UGameObject[] = [];
    const walk = (go: UGameObject, under: boolean) => {
      const ps = isPs(go);
      if (ps && !under) roots.push(go);
      for (const c of go.children) walk(c, under || ps);
    };
    for (const r of asset.roots) walk(r, false);
    for (const root of roots) {
      let name = goPath(root);
      if (opts.only?.length && !opts.only.some((o) => name.startsWith(o))) continue;
      if (seen.has(name)) name = `${project.rel(file)}#${name}`;
      seen.add(name);
      const members: UGameObject[] = [];
      const collect = (go: UGameObject) => {
        if (isPs(go)) members.push(go);
        for (const c of go.children) collect(c);
      };
      collect(root);
      const configs: ParticleConfig[] = [];
      for (const go of members) {
        const ps = go.components.find((c) => c.type === 'ParticleSystem')!;
        const renderer = go.components.find((c) => c.type === 'ParticleSystemRenderer')?.body ?? null;
        const behaviours = (g: UGameObject) => g.components.filter((c) => c.type === 'MonoBehaviour');
        const gui = behaviours(go).find((b) => scriptName(b) === 'UIParticleSystem');
        let coffee: UObject | undefined;
        for (let g: UGameObject | null = go; g && !coffee; g = g.parent) {
          coffee = behaviours(g).find((b) => scriptName(b) === 'UIParticle' && (g === go || list(b.body.m_Particles).some((x) => ref(x)?.fileID === ps.id)));
        }
        const chain = chainScale(go);
        let unit: [number, number];
        let space: SystemContext['space'];
        if (coffee) {
          const s = map(coffee.body.m_Scale3D);
          unit = [num(s.x, 1), num(s.y, 1)];
          space = 'coffee';
        } else if (gui) {
          unit = chain;
          space = 'ugui';
        } else {
          unit = [ppu * chain[0], ppu * chain[1]];
          space = 'world';
        }
        const mats = list(renderer?.m_Materials);
        const main = gui ? material(ref(gui.body.m_Material)) : material(ref(mats[0]));
        const trail = material(ref(mats[1]));
        const ctx: SystemContext = {
          unit,
          pos: go === root ? [0, 0] : posIn(go, root),
          material: main,
          trailMaterial: trail,
          rendered: !!gui || !!coffee || renderer?.m_Enabled !== '0',
          space,
          rotation: zRotation(go),
        };
        const c = convertSystem(ps.body, renderer, ctx);
        const key = goPath(go);
        configs.push({ key, cls: c.cls, ...c.config });
        if (main?.texture) textures.set(c.config.texture, main.texture);
        if (trail?.texture && c.config.trails?.texture) textures.set(c.config.trails.texture, trail.texture);
        systems.push({
          key,
          effect: name,
          asset: project.rel(file),
          cls: c.cls,
          active: activeIn(go),
          space,
          unit,
          texture: c.config.texture,
          exact: c.exact,
          approx: c.approx,
          unsupported: c.unsupported,
        });
      }
      effects[name] = configs;
    }
  }
  return { project: root, effects, systems, textures, warnings: [...new Set(warnings)], assets: files.length };
}

/** Product of the local scales up to the asset root (x, y). */
function chainScale(go: UGameObject): [number, number] {
  let x = 1;
  let y = 1;
  for (let g: UGameObject | null = go; g; g = g.parent) {
    const s = map(g.transform?.body.m_LocalScale);
    x *= num(s.x, 1);
    y *= num(s.y, 1);
  }
  return [round(x), round(y)];
}

/** Position of `go` in the space of `root` (local positions × the scales between), y down. */
function posIn(go: UGameObject, root: UGameObject): [number, number] {
  let x = 0;
  let y = 0;
  for (let g: UGameObject | null = go; g && g !== root; g = g.parent) {
    const t = map(g.transform?.body);
    const p = map(t.m_LocalPosition);
    const s = map(t.m_LocalScale);
    x = num(p.x) + num(s.x, 1) * x;
    y = num(p.y) + num(s.y, 1) * y;
  }
  return [round(x), round(-y)];
}

const round = (v: number) => Math.round(v * 1e6) / 1e6 || 0;

/** The z rotation of a GameObject (degrees), 0 when none. */
function zRotation(go: UGameObject): number {
  const q = map(go.transform?.body.m_LocalRotation);
  const z = num(q.z);
  const w = num(q.w, 1);
  const deg = (2 * Math.atan2(z, w) * 180) / Math.PI;
  return Math.abs(deg) < 0.01 ? 0 : deg;
}

const activeIn = (go: UGameObject): boolean => {
  for (let g: UGameObject | null = go; g; g = g.parent) if (!g.active) return false;
  return true;
};

/** A .mat: its shader (built-in id or the project shader's name), _MainTex, colours. */
export function readMaterial(project: UnityProject, abs: string): MaterialInfo {
  const m = project.first(abs, 'Material');
  if (!m) throw new Error('no Material in the file');
  const sh = ref(m.m_Shader);
  let builtin: number | null = null;
  let shader = '?';
  if (sh?.guid === BUILTIN_GUID) {
    builtin = Number(sh.fileID);
    shader = BUILTIN_SHADERS[builtin]?.name ?? `built-in shader ${sh.fileID}`;
  } else if (sh?.guid) {
    const p = project.pathOf(sh.guid);
    shader = p ? (/Shader\s+"([^"]+)"/.exec(readHead(p))?.[1] ?? fileStem(p)) : `shader ${sh.guid}`;
  }
  const props = map(m.m_SavedProperties);
  // Unity 2019+: a list; older: `data:` repeated (one property each) — or a single `data:`.
  const entries = (v: YamlValue | undefined): YamlValue[] => {
    if (Array.isArray(v)) return v;
    const d = map(v).data;
    return d === undefined ? [] : isRepeated(d) ? (d as YamlValue[]) : [d];
  };
  const named = (v: YamlValue | undefined): [string, unknown][] =>
    entries(v).map((e) => {
      const em = map(e);
      // Unity 2019+: `- _MainTex: {…}`; older: `- first: {name: _MainTex} second: {…}`.
      if (em.first !== undefined) return [String(map(em.first).name ?? ''), em.second];
      const k = Object.keys(em)[0] ?? '';
      return [k, em[k]];
    });
  let texture: string | null = null;
  for (const [k, v] of named(props.m_TexEnvs)) {
    if (k !== '_MainTex') continue;
    const g = ref(map(v as YamlMap).m_Texture)?.guid;
    const p = project.pathOf(g);
    if (p) texture = p;
  }
  const colors: Record<string, RGBA> = {};
  for (const [k, v] of named(props.m_Colors)) {
    const c = map(v as YamlMap);
    colors[k] = [num(c.r, 1), num(c.g, 1), num(c.b, 1), num(c.a, 1)];
  }
  return { path: project.rel(abs), builtin, shader, texture, colors };
}

function readHead(p: string): string {
  try {
    return readFileSync(p, 'utf8').slice(0, 2000);
  } catch {
    return '';
  }
}

// ── writing ───────────────────────────────────────────────────────────────────────────────────────

export interface WriteOptions {
  /** Write textures/*.png (default true). */
  textures?: boolean;
}

export interface Written {
  effects: string;
  report: string;
  textures: string[];
  /** Textures not written (format), name → reason. */
  skipped: Record<string, string>;
}

export function writeImport(r: ImportResult, out: string, opts: WriteOptions = {}): Written {
  mkdirSync(out, { recursive: true });
  const effectsFile = join(out, 'effects.json');
  writeFileSync(effectsFile, JSON.stringify(r.effects, null, 1) + '\n');
  const written: string[] = [];
  const skipped: Record<string, string> = {};
  if (opts.textures !== false) {
    const dir = join(out, 'textures');
    mkdirSync(dir, { recursive: true });
    for (const [name, src] of [...r.textures].sort(([a], [b]) => a.localeCompare(b))) {
      const res = texturePng(new Uint8Array(readFileSync(src)), src);
      if ('error' in res) {
        skipped[name] = res.error;
        continue;
      }
      const f = join(dir, `${name}.png`);
      writeFileSync(f, res.png);
      written.push(f);
    }
  }
  const json = {
    project: r.project,
    assets: r.assets,
    counts: counts(r.systems),
    systems: r.systems,
    textures: Object.fromEntries([...r.textures].map(([n, p]) => [n, { source: p, written: !skipped[n] && opts.textures !== false, error: skipped[n] }])),
    warnings: r.warnings,
  };
  writeFileSync(join(out, 'report.json'), JSON.stringify(json, null, 1) + '\n');
  const report = join(out, 'report.md');
  writeFileSync(report, reportMd(r, skipped));
  return { effects: effectsFile, report, textures: written, skipped };
}

export function counts(systems: SystemReport[]): Record<SystemClass | 'total', number> {
  const c = { auto: 0, manual: 0, hard: 0, total: systems.length };
  for (const s of systems) c[s.cls]++;
  return c;
}

const cell = (s: string) => s.replace(/\|/g, '\\|');

function reportMd(r: ImportResult, skipped: Record<string, string>): string {
  const c = counts(r.systems);
  const lines = [
    '# trempel-fx-import — report',
    '',
    `Project: \`${r.project}\` · ${r.assets} assets read · ${Object.keys(r.effects).length} effects · ${c.total} particle systems: **auto ${c.auto}**, **manual ${c.manual}**, **hard ${c.hard}**.`,
    '',
    '- `auto` — played exactly; `manual` — played, something approximated (look at it); `hard` — something it uses is not played.',
    '- `active` — active in its asset (an inactive system is a template turned on by code, or dead).',
    '',
    '| system | asset | class | active | space | unit | texture | approximated | not played |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  for (const s of r.systems) {
    lines.push(`| ${cell(s.key)} | ${cell(s.asset)} | ${s.cls} | ${s.active ? 'yes' : 'no'} | ${s.space} | ${s.unit.join('×')} | ${s.texture} | ${cell(s.approx.join('; ')) || '—'} | ${cell(s.unsupported.join('; ')) || '—'} |`);
  }
  if (Object.keys(skipped).length) {
    lines.push('', '## Textures not written', '');
    for (const [n, e] of Object.entries(skipped)) lines.push(`- \`${n}\` (${cell(r.textures.get(n) ?? '')}): ${e}`);
  }
  if (r.warnings.length) {
    lines.push('', '## Warnings', '');
    for (const w of r.warnings) lines.push(`- ${cell(w)}`);
  }
  return lines.join('\n') + '\n';
}
