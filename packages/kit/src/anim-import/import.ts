// import.ts — trempel-anim-import: Unity AnimationClips (and the Animator controllers / prefabs that
// use them) → Trempel md clips, with a report (auto / manual / hard per property) and a verification
// of every clip against Unity's own evaluation of its curves (verify.ts).
//
// Inputs: a Unity project (its Assets/), a folder, .prefab / .controller / .overrideController /
// .anim files. Groups, one md per group (`<out>/<group>.anim.md` + the compiled `.anim.json`):
//   - a prefab with an Animator (or a legacy Animation): its controller's states → clips named after
//     the states; the Animator's GameObject is the root of the curve paths and the prefab gives the
//     rest pose of every animated node;
//   - a controller no prefab of the inputs uses: its states, no rest pose;
//   - an .anim no controller of the inputs uses: one clip named after it.
// Transitions are listed in the report, never executed. Paths → ids: with a scene, by the node name
// (the path's last segment, idified; ambiguous / missing → unmatched); `--map anim-map.md` (the
// table this tool writes, edited) wins; without a scene — the idified last segments, unique.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { compileClipsResult, parse, type AnimClip, type SceneNode } from '@trempel/scene';
import { Ids, eventsTable, idify, strictTimes, trackTables, fmt, type Column } from '../clip-import/index.js';
import { fileStem, UnityProject, type UGameObject } from '../fx-import/project.js';
import { list, map, parseYaml, ref, type Ref, type UnityDoc } from '../fx-import/yaml.js';
import { readClip, type UClip } from './clip.js';
import { convertClip, type ClipConv, type Cls, type ConvertCtx, type EventOut, type PropItem, type SceneRest } from './convert.js';
import { readController, type UController, type UState } from './controller.js';
import { sceneRests, syntheticScene, verifyMd, type ClipCheck } from './verify.js';

export interface AnimImportOptions {
  /** A Unity project, a folder inside it, .prefab / .controller / .overrideController / .anim files. */
  inputs: string[];
  /** A Trempel base (X.svg) made from the same prefab: ids by node name, rest poses, the verification scene. */
  scene?: string;
  /** An edited anim-map.md (path → id): wins over name matching. */
  map?: string;
  /** Pixels per world unit (Transform positions; default 100). */
  ppu?: number;
  /** Trempel px per canvas px (RectTransform positions; default 1). */
  uiScale?: number;
  /** Bake rate of segments with no Trempel ease (default 30). */
  fps?: number;
  /** Verification points per clip (default 60). */
  points?: number;
  /** Verify (default true). */
  verify?: boolean;
  /** `$tex` template of sprite names (default `{}.png`). */
  tex?: string;
}

export interface ClipReport {
  group: string;
  clip: string;
  /** The .anim (or controller#id) it was read from, project-relative. */
  source: string;
  state?: string;
  layer?: string;
  duration: number;
  loop: boolean;
  cls: Cls;
  items: PropItem[];
  events: EventOut[];
  notes: string[];
  verification?: ClipCheck;
}

export interface GroupOut {
  name: string;
  kind: 'prefab' | 'controller' | 'clip';
  source: string;
  controller?: string;
  md: string;
  convs: ClipConv[];
  clips: ClipReport[];
  notes: string[];
  transitions: string[];
  /** Compiled clips (when the md compiles). */
  json: Record<string, AnimClip> | null;
  compileErrors: string[];
  /** The scene the verification played on. */
  verifiedOn: 'scene' | 'synthetic' | 'none';
}

export interface MapRow {
  path: string;
  id: string;
  note: string;
}

export interface AnimImportResult {
  project: string;
  groups: GroupOut[];
  clips: ClipReport[];
  map: MapRow[];
  /** How the ids were made. */
  ids: 'scene' | 'names';
  scene?: string;
  warnings: string[];
  points: number;
}

interface PendingClip {
  clip: UClip;
  name: string;
  source: string;
  state?: UState;
  notes: string[];
  hard: string[];
}

interface PendingGroup {
  name: string;
  kind: GroupOut['kind'];
  source: string;
  controller?: string;
  rootName?: string;
  goOf: (path: string) => UGameObject | null;
  clips: PendingClip[];
  notes: string[];
  transitions: string[];
}

const IMAGE_EXT = /\.(png|jpe?g|psd|psb|tga|tif|tiff|gif|bmp|exr|hdr|webp)$/i;
const KNOWN_SCRIPTS: Record<string, string> = {
  fe87c0e1cc204ed48ad3b37840f39efc: 'Image',
  '1344c3c82d62a2a41a3576d8abb8e3ea': 'RawImage',
  '5f7201a12d95ffc409449d95f23cf332': 'Text',
  f4688fdb7df04437aeb418b961361dc5: 'TextMeshProUGUI',
  '9541d86e2fd84c1d9990edf0852d74ab': 'TextMeshPro',
};
const SKIP = new Set(['node_modules', '.git', 'Temp', 'Logs', 'obj', 'Build', 'Builds']);
export const ROOT_PATH = '(root)';

export function importAnim(opts: AnimImportOptions): AnimImportResult {
  if (!opts.inputs.length) throw new Error('E_ANIM_IMPORT_INPUT: nothing to import (a Unity project, a folder or .prefab / .controller / .anim files)');
  const ppu = opts.ppu ?? 100;
  const uiScale = opts.uiScale ?? 1;
  const fps = opts.fps ?? 30;
  const points = opts.points ?? 60;
  const template = opts.tex ?? '{}.png';
  if (!template.includes('{}')) throw new Error(`E_ANIM_IMPORT_USAGE: --tex "${template}" has no {}`);
  const first = resolve(opts.inputs[0]);
  if (!existsSync(first)) throw new Error(`E_ANIM_IMPORT_INPUT: ${opts.inputs[0]} not found`);
  const root = UnityProject.rootOf(first) ?? (statSync(first).isDirectory() ? first : dirname(first));
  const project = new UnityProject(root);
  const warnings: string[] = [];

  // ── files ──
  const files: string[] = [];
  const explicit = new Set<string>();
  for (const i of opts.inputs) {
    const p = resolve(i);
    if (!existsSync(p)) throw new Error(`E_ANIM_IMPORT_INPUT: ${i} not found`);
    if (statSync(p).isDirectory()) files.push(...animAssets(p === root && existsSync(join(root, 'Assets')) ? join(root, 'Assets') : p));
    else if (/\.(prefab|controller|overrideController|anim)$/.test(p)) {
      files.push(p);
      explicit.add(p);
    } else throw new Error(`E_ANIM_IMPORT_INPUT: ${i}: not a .prefab / .controller / .overrideController / .anim`);
  }

  // ── scene and map ──
  let sceneNode: SceneNode | undefined;
  let sceneSvg: string | undefined;
  let rests: Map<string, SceneRest> | null = null;
  const sceneIds = new Set<string>();
  if (opts.scene) {
    const sp = resolve(opts.scene);
    if (!existsSync(sp)) throw new Error(`E_ANIM_IMPORT_SCENE: ${opts.scene} not found`);
    sceneSvg = readFileSync(sp, 'utf8');
    try {
      sceneNode = parse(sceneSvg);
    } catch (e) {
      throw new Error(`E_ANIM_IMPORT_SCENE: ${opts.scene}: ${(e as Error).message}`);
    }
    const walk = (n: SceneNode): void => {
      if (n.attrs.id) sceneIds.add(n.attrs.id);
      for (const c of n.children) walk(c);
    };
    walk(sceneNode);
    rests = sceneRests(sceneSvg);
    if (!rests) warnings.push(`${basename(sp)} does not mount on its own (prefabs / collections?) — no rest poses from it; clips verified on a synthetic scene`);
  }
  const mapped = new Map<string, string>();
  if (opts.map) {
    const mp = resolve(opts.map);
    if (!existsSync(mp)) throw new Error(`E_ANIM_IMPORT_INPUT: --map ${opts.map} not found`);
    for (const r of readMap(readFileSync(mp, 'utf8'))) if (r.id) mapped.set(r.path, r.id);
  }

  // ── groups ──
  const groupNames = new Ids();
  const groups: PendingGroup[] = [];
  const claimedCtl = new Set<string>();
  const claimedClip = new Set<string>();
  const scriptName = (guid: string | undefined): string => {
    if (!guid) return '';
    const p = project.pathOf(guid);
    return p ? fileStem(p) : (KNOWN_SCRIPTS[guid] ?? '');
  };
  const docsOf = (abs: string): UnityDoc[] => {
    try {
      return project.docs(abs);
    } catch (e) {
      throw new Error(`E_ANIM_IMPORT_CLIP: ${project.rel(abs)}: ${(e as Error).message}`);
    }
  };

  /** A clip by reference from a file (`from` — the file a guid-less reference points into). */
  const clipOf = (r: Ref | null, from: string): { clip: UClip; source: string } | { error: string } => {
    if (!r) return { error: 'no motion' };
    const file = r.guid ? project.pathOf(r.guid) : from;
    if (!file) return { error: `clip ${r.guid} not found in the project` };
    if (!/\.(anim|controller|overrideController)$/.test(file)) return { error: `the clip is inside ${project.rel(file)} (a model / other asset) — not read` };
    let docs: UnityDoc[];
    try {
      docs = docsOf(file);
    } catch (e) {
      return { error: (e as Error).message };
    }
    const d = docs.find((x) => x.fileID === r.fileID) ?? (file.endsWith('.anim') ? docs.find((x) => x.classId === 74) : undefined);
    if (!d) return { error: `${project.rel(file)}: object ${r.fileID} not found` };
    if (d.classId === 206) return { error: `BlendTree "${String(d.body.m_Name ?? '')}" — not transferred (blends clips by parameters)` };
    if (d.classId !== 74) return { error: `${project.rel(file)}: object ${r.fileID} is not an AnimationClip (classID ${d.classId})` };
    try {
      claimedClip.add(`${file}#${d.fileID}`);
      return { clip: readClip(d.body, fileStem(file)), source: `${project.rel(file)}${file.endsWith('.anim') ? '' : `#${d.fileID}`}` };
    } catch (e) {
      return { error: (e as Error).message };
    }
  };

  const fromController = (g: PendingGroup, file: string): void => {
    let ctl: UController;
    ctl = readController(docsOf(file), project.rel(file));
    claimedCtl.add(file);
    let swaps = new Map<string, Ref | null>();
    let ctlFile = file;
    if (ctl.base !== undefined) {
      const base = project.pathOf(ctl.base?.guid);
      if (!base) {
        g.notes.push(`override controller: its base controller is not found`);
        return;
      }
      swaps = new Map((ctl.overrides ?? []).filter((o) => o.original && o.override).map((o) => [`${o.original!.guid}#${o.original!.fileID}`, o.override]));
      g.notes.push(`override controller over ${project.rel(base)}: ${swaps.size} clip(s) swapped`);
      ctlFile = base;
      claimedCtl.add(base);
      ctl = readController(docsOf(base), project.rel(base));
    }
    g.controller = project.rel(file);
    g.transitions.push(...ctl.transitions);
    if (ctl.parameters.length) g.notes.push(`parameters: ${ctl.parameters.join(', ')} (the game's logic)`);
    if (ctl.layers.length > 1) g.notes.push(`layers: ${ctl.layers.join(', ')} — Unity blends them; each state is its own clip here`);
    const names = new Ids();
    for (const s of ctl.states) {
      const swapped = s.motion?.guid ? swaps.get(`${s.motion.guid}#${s.motion.fileID}`) : undefined;
      const c = clipOf(swapped ?? s.motion, ctlFile);
      if ('error' in c) {
        g.notes.push(`state ${s.name}: ${c.error}`);
        continue;
      }
      const notes: string[] = [];
      const hard: string[] = [];
      if (s.speed !== 1) notes.push(`state speed ${s.speed} — play with { speed: ${s.speed} }`);
      if (ctl.layers.length > 1 && s.layer !== ctl.layers[0]) notes.push(`layer ${s.layer}: Unity plays it over the base layer`);
      if (s.isDefault) notes.push('the default state');
      g.clips.push({ clip: c.clip, name: names.take(s.name || c.clip.name), source: c.source, state: s, notes, hard });
    }
  };

  // Prefabs (Animator → controller; legacy Animation → its clips).
  // Only prefabs that have an Animator / Animation, or nest one, are flattened.
  const animates = new Map<string, boolean>();
  const mayAnimate = (file: string, stack: string[]): boolean => {
    const hit = animates.get(file);
    if (hit !== undefined) return hit;
    let text = '';
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      // unreadable: not animated
    }
    let yes = /^--- !u!(95|111) /m.test(text);
    for (const m of text.matchAll(/m_SourcePrefab: \{fileID: -?\d+, guid: ([0-9a-f]{32})/g)) {
      if (yes) break;
      const src = project.pathOf(m[1]);
      if (src?.endsWith('.prefab') && !stack.includes(src)) yes = mayAnimate(src, [...stack, file]);
    }
    animates.set(file, yes);
    return yes;
  };
  for (const file of files.filter((f) => f.endsWith('.prefab'))) {
    if (!mayAnimate(file, [])) {
      if (explicit.has(file)) warnings.push(`${project.rel(file)}: no Animator / Animation in the prefab`);
      continue;
    }
    let asset;
    try {
      asset = project.asset(file);
    } catch (e) {
      warnings.push(`${project.rel(file)}: ${(e as Error).message}`);
      continue;
    }
    const animated = [...asset.gameObjects.values()].filter((go) => go.components.some((c) => c.classId === 95 || c.classId === 111));
    for (const go of animated) {
      const comp = go.components.find((c) => c.classId === 95 || c.classId === 111)!;
      const name = groupNames.take(animated.length > 1 ? `${fileStem(file)}_${go.name}` : fileStem(file));
      const g: PendingGroup = { name, kind: 'prefab', source: project.rel(file), rootName: go.name, goOf: (p) => goAt(go, p), clips: [], notes: [], transitions: [] };
      groups.push(g);
      if (go.parent) g.notes.push(`the ${comp.classId === 95 ? 'Animator' : 'Animation'} is on ${go.name} (paths are relative to it)`);
      if (comp.classId === 95) {
        if (comp.body.m_ApplyRootMotion === '1') g.notes.push('Apply Root Motion is on — root motion is not transferred');
        const cr = ref(comp.body.m_Controller);
        const cf = project.pathOf(cr?.guid);
        if (!cf) {
          g.notes.push(cr ? `controller ${cr.guid} not found` : 'the Animator has no controller');
          continue;
        }
        try {
          fromController(g, cf);
        } catch (e) {
          g.notes.push((e as Error).message);
        }
      } else {
        g.notes.push('legacy Animation component');
        const names = new Ids();
        for (const r of list(comp.body.m_Animations)) {
          const c = clipOf(ref(r), file);
          if ('error' in c) g.notes.push(c.error);
          else g.clips.push({ clip: c.clip, name: names.take(c.clip.name), source: c.source, notes: [], hard: [] });
        }
      }
    }
    if (!animated.length && explicit.has(file)) warnings.push(`${project.rel(file)}: no Animator / Animation in the prefab`);
  }
  // Controllers no prefab uses.
  for (const file of files.filter((f) => /\.(controller|overrideController)$/.test(f))) {
    if (claimedCtl.has(file)) continue;
    const g: PendingGroup = { name: groupNames.take(fileStem(file)), kind: 'controller', source: project.rel(file), goOf: () => null, clips: [], notes: [], transitions: [] };
    try {
      fromController(g, file);
    } catch (e) {
      if (explicit.has(file)) throw e;
      warnings.push((e as Error).message);
      continue;
    }
    groups.push(g);
  }
  // Clips no controller uses.
  for (const file of files.filter((f) => f.endsWith('.anim'))) {
    let docs: UnityDoc[];
    try {
      docs = docsOf(file);
    } catch (e) {
      if (explicit.has(file)) throw e;
      warnings.push((e as Error).message);
      continue;
    }
    const clipDocs = docs.filter((d) => d.classId === 74);
    if (!clipDocs.length) {
      const m = `E_ANIM_IMPORT_CLIP: ${project.rel(file)}: no AnimationClip in the file`;
      if (explicit.has(file)) throw new Error(m);
      warnings.push(m);
      continue;
    }
    for (const d of clipDocs) {
      if (claimedClip.has(`${file}#${d.fileID}`)) continue;
      let clip: UClip;
      try {
        clip = readClip(d.body, fileStem(file));
      } catch (e) {
        if (explicit.has(file)) throw new Error(`${(e as Error).message} (${project.rel(file)})`);
        warnings.push((e as Error).message);
        continue;
      }
      const name = groupNames.take(clip.name);
      groups.push({ name, kind: 'clip', source: project.rel(file), goOf: () => null, clips: [{ clip, name: idify(clip.name), source: project.rel(file), notes: [], hard: [] }], notes: [], transitions: [] });
    }
  }

  // ── paths → ids ──
  const keys: string[] = [];
  for (const g of groups) for (const c of g.clips) for (const b of [...c.clip.floats, ...c.clip.pptr]) if (!keys.includes(pathKey(b.path, g.rootName))) keys.push(pathKey(b.path, g.rootName));
  const rows = resolveIds(keys, { mapped, sceneIds: opts.scene ? sceneIds : null });
  const idByKey = new Map(rows.map((r) => [r.path, r.id || null]));

  // ── sprites ──
  const spriteCache = new Map<string, { name: string; note?: string }>();
  const sprite = (r: Ref | null): { name: string; note?: string } => {
    if (!r) return { name: 'none', note: 'a key with no sprite → tex "none"' };
    const key = `${r.guid}#${r.fileID}`;
    let hit = spriteCache.get(key);
    if (!hit) {
      hit = spriteName(project, r);
      spriteCache.set(key, hit);
    }
    return hit;
  };

  // ── convert, write md, compile, verify ──
  const out: GroupOut[] = [];
  const reports: ClipReport[] = [];
  for (const g of groups) {
    const ctx: ConvertCtx = {
      ppu,
      uiScale,
      fps,
      idOf: (p) => idByKey.get(pathKey(p, g.rootName)) ?? null,
      prefab: g.kind === 'prefab',
      goOf: g.goOf,
      sceneRest: (id) => rests?.get(id) ?? null,
      sprite,
      href: (n) => template.split('{}').join(n),
      scriptName,
    };
    const convs = g.clips.map((c) => convertClip(c.clip, c.name, ctx));
    const md = writeMd(g, convs, template);
    const compiled = compileClipsResult(md, sceneNode);
    const clipReports: ClipReport[] = g.clips.map((c, i) => {
      const conv = convs[i];
      const notes = [...c.notes, ...conv.notes];
      return { group: g.name, clip: c.name, source: c.source, state: c.state?.name, layer: c.state?.layer, duration: conv.duration, loop: conv.loop, cls: 'auto', items: conv.items, events: conv.events, notes };
    });
    let verifiedOn: GroupOut['verifiedOn'] = 'none';
    if (opts.verify !== false && convs.length) {
      const useScene = sceneSvg !== undefined && rests !== null;
      verifiedOn = useScene ? 'scene' : 'synthetic';
      const svg = useScene ? sceneSvg! : syntheticScene(convs.flatMap((c) => c.columns));
      const checks = verifyMd(md, svg, convs, points);
      checks.forEach((ch, i) => {
        clipReports[i].verification = ch;
        // Weighted tangents: 'manual' unless every column of the item converged.
        for (const it of clipReports[i].items) {
          if (!it.weighted) continue;
          const ok = it.columns.every((col) => ch.columns.some((x) => x.target === it.target && x.col === col && x.ok));
          if (ok && !ch.error) it.notes.push('weighted tangents: verified exact against Unity’s evaluation');
          else if (it.cls === 'auto') {
            it.cls = 'manual';
            it.notes.push('weighted tangents: approximated');
          }
        }
      });
    } else {
      for (const r of clipReports) for (const it of r.items) if (it.weighted && it.cls === 'auto') {
        it.cls = 'manual';
        it.notes.push('weighted tangents: not verified (--verify false)');
      }
    }
    for (const r of clipReports) r.cls = clipCls(r);
    reports.push(...clipReports);
    out.push({ name: g.name, kind: g.kind, source: g.source, controller: g.controller, md, convs, clips: clipReports, notes: g.notes, transitions: g.transitions, json: compiled.errors.length ? null : compiled.clips, compileErrors: compiled.errors, verifiedOn });
  }
  return { project: root, groups: out, clips: reports, map: rows, ids: opts.scene ? 'scene' : 'names', scene: opts.scene, warnings, points };
}

function clipCls(r: ClipReport): Cls {
  let c: Cls = 'auto';
  const worse = (x: Cls): void => {
    if (x === 'hard' || (x === 'manual' && c === 'auto')) c = x;
  };
  for (const it of r.items) worse(it.cls);
  if (r.notes.some((n) => /^m_Compressed|compressed rotation curves/.test(n))) worse('hard');
  if (r.notes.some((n) => /^state speed|^layer |^m_StartTime|^legacy clip|^m_WrapMode/.test(n))) worse('manual');
  return c;
}

/** The GameObject at `path` under `root` (Unity: the first child of each name). */
function goAt(root: UGameObject, path: string): UGameObject | null {
  if (!path) return root;
  let cur: UGameObject | undefined = root;
  for (const seg of path.split('/')) {
    cur = cur?.children.find((c) => c.name === seg);
    if (!cur) return null;
  }
  return cur;
}

/** .prefab / .controller / .overrideController / .anim under a folder. */
function animAssets(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let names: string[];
    try {
      names = readdirSync(d).sort();
    } catch {
      return;
    }
    for (const n of names) {
      if (SKIP.has(n)) continue;
      const p = join(d, n);
      if (/\.(prefab|controller|overrideController|anim)$/.test(n)) out.push(p);
      else if (!n.endsWith('.meta')) {
        try {
          if (statSync(p).isDirectory()) walk(p);
        } catch {
          // unreadable: skipped
        }
      }
    }
  };
  walk(dir);
  return out;
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** The map key of a path: the path itself, or `(root)` / `(root <name>)` for the Animator's own GameObject. */
export const pathKey = (path: string, rootName?: string): string => path || (rootName ? `${ROOT_PATH} ${rootName}` : ROOT_PATH);

/** The name a key is matched by: the last path segment, the root's GameObject name (null — unknown). */
const nameOf = (key: string): string | null => {
  if (key === ROOT_PATH) return null;
  if (key.startsWith(`${ROOT_PATH} `)) return key.slice(ROOT_PATH.length + 1);
  return key.split('/').pop()!;
};

/** Map keys (pathKey) → ids (see the header). */
export function resolveIds(keys: string[], o: { mapped: Map<string, string>; sceneIds: Set<string> | null }): MapRow[] {
  const rows: MapRow[] = [];
  if (!o.sceneIds) {
    const ids = new Ids();
    for (const id of o.mapped.values()) ids.take(id);
    for (const p of keys) {
      const m = o.mapped.get(p);
      rows.push(m ? { path: p, id: m, note: 'from the map' } : { path: p, id: ids.take(nameOf(p) ?? 'root'), note: 'the idified name (no scene)' });
    }
    return rows;
  }
  const scene = o.sceneIds;
  const byNorm = new Map<string, string[]>();
  for (const id of scene) byNorm.set(norm(id), [...(byNorm.get(norm(id)) ?? []), id]);
  for (const p of keys) {
    const m = o.mapped.get(p);
    if (m) {
      rows.push({ path: p, id: m, note: scene.has(m) ? 'from the map' : `from the map — no node "${m}" in the scene` });
      continue;
    }
    const name = nameOf(p);
    if (name === null) {
      rows.push({ path: p, id: '', note: 'unmatched: the Animator root (no prefab — set its id)' });
      continue;
    }
    const want = idify(name);
    if (scene.has(want)) rows.push({ path: p, id: want, note: 'matched by name' });
    else {
      const c = byNorm.get(norm(want)) ?? [];
      if (c.length === 1) rows.push({ path: p, id: c[0], note: 'matched by name (case / separators ignored)' });
      else if (c.length > 1) rows.push({ path: p, id: '', note: `unmatched: ambiguous — ${c.map((x) => `#${x}`).join(', ')}` });
      else rows.push({ path: p, id: '', note: `unmatched: no node named "${name}" in the scene` });
    }
  }
  // Two paths on one node: both unmatched (unless the map says so).
  const claim = new Map<string, MapRow[]>();
  for (const r of rows) if (r.id && !o.mapped.has(r.path)) claim.set(r.id, [...(claim.get(r.id) ?? []), r]);
  for (const [id, rs] of claim) {
    if (rs.length < 2) continue;
    for (const r of rs) {
      r.note = `unmatched: ambiguous — ${rs.map((x) => x.path).join(', ')} all match #${id}`;
      r.id = '';
    }
  }
  return rows;
}

const cellOut = (s: string): string => s.replace(/\|/g, '\\|');

/** anim-map.md: every path used, its id (empty — unmatched) and how it was found. */
export function mapMd(rows: MapRow[]): string {
  return [
    '# anim-map — Unity animation paths → Trempel node ids (trempel-anim-import)',
    '',
    `Fill or fix the ids, then run again with \`--map anim-map.md\` (the map wins over name matching). \`${ROOT_PATH} <name>\` is the GameObject of the Animator (\`${ROOT_PATH}\` — of a clip or controller without a prefab).`,
    '',
    '| path | id | note |',
    '| --- | --- | --- |',
    ...rows.map((r) => `| ${cellOut(r.path)} | ${r.id} | ${cellOut(r.note)} |`),
  ].join('\n') + '\n';
}

/** Rows of an anim-map.md (a table with `path` and `id` columns). */
export function readMap(md: string): MapRow[] {
  const rows: MapRow[] = [];
  let cols: string[] | null = null;
  for (const line of md.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('|')) {
      cols = null;
      continue;
    }
    const cells = t
      .slice(1, t.endsWith('|') && !t.endsWith('\\|') ? -1 : undefined)
      .split(/(?<!\\)\|/)
      .map((c) => c.trim().replace(/\\\|/g, '|'));
    if (!cols) {
      cols = cells.map((c) => c.toLowerCase());
      continue;
    }
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    const pi = cols.indexOf('path');
    const ii = cols.indexOf('id');
    if (pi < 0 || ii < 0) continue;
    const path = cells[pi] ?? '';
    rows.push({ path, id: (cells[ii] ?? '').replace(/^#/, ''), note: cells[cols.indexOf('note')] ?? '' });
  }
  return rows;
}

/** The texture name of a sprite: a single sprite — its file's stem; a sprite of a sheet — its name. */
function spriteName(project: UnityProject, r: Ref): { name: string; note?: string } {
  const file = project.pathOf(r.guid);
  if (!file) return { name: `${(r.guid ?? 'local').slice(0, 8)}_${r.fileID}`, note: 'a sprite not found in the project (named by its GUID)' };
  const stem = fileStem(file);
  if (!IMAGE_EXT.test(file)) return { name: stem };
  let meta;
  try {
    meta = parseYaml(readFileSync(`${file}.meta`, 'utf8'));
  } catch {
    return { name: stem };
  }
  const imp = map(meta.TextureImporter ?? meta.ScriptedImporter);
  if (imp.spriteMode !== '2' && r.fileID === '21300000') return { name: stem };
  for (const e of list(imp.internalIDToNameTable)) {
    const m = map(e);
    if (Object.values(map(m.first)).includes(r.fileID) && typeof m.second === 'string') return { name: m.second };
  }
  const recycle = map(imp.fileIDToRecycleName);
  if (typeof recycle[r.fileID] === 'string') return { name: recycle[r.fileID] as string };
  for (const s of list(map(imp.spriteSheet).sprites)) {
    const m = map(s);
    if (m.internalID === r.fileID && typeof m.name === 'string') return { name: m.name };
  }
  if (imp.spriteMode !== '2') return { name: stem };
  return { name: `${stem}_${r.fileID}`, note: `a sprite of ${basename(file)} not named in its .meta` };
}

const COL_ORDER = ['x', 'y', 'rotation', 'scale', 'scaleX', 'scaleY', 'alpha', 'tint', 'tex', 'width', 'height'];

/** The md of a group: a clip per state / .anim, a table per target (columns grouped by times and eases). */
export function writeMd(g: { name: string; source: string; kind: string; controller?: string }, convs: ClipConv[], template: string): string {
  const lines: string[] = [`Clips of ${g.source}${g.controller && g.controller !== g.source ? ` (controller ${g.controller})` : ''}, imported from Unity by trempel-anim-import.`];
  if (convs.some((c) => c.columns.some((x) => x.col === 'tex'))) lines.push(`$tex: ${template}`);
  for (const c of convs) {
    lines.push('', `# $clip ${c.name}`);
    if (c.duration > 0) lines.push(`$duration: ${fmt(c.duration, 5)}`);
    if (c.loop) lines.push('$loop: true');
    const targets = [...new Set(c.columns.map((x) => x.target))];
    for (const t of targets) {
      const cols: Column[] = c.columns
        .filter((x) => x.target === t)
        .sort((a, b) => COL_ORDER.indexOf(a.col) - COL_ORDER.indexOf(b.col))
        .map((x) => {
          const keys = x.keys.map((k) => ({ ...k, t: Number(fmt(k.t, 5)) }));
          strictTimes(keys);
          return { col: x.col, keys };
        });
      for (const table of trackTables(t, cols)) lines.push('', table);
    }
    if (c.events.length) lines.push('', eventsTable(c.events));
  }
  return lines.join('\n') + '\n';
}

// ── writing ───────────────────────────────────────────────────────────────────────────────────────

export interface AnimWritten {
  md: string[];
  json: string[];
  map: string;
  report: string;
}

export function counts(clips: ClipReport[]): Record<Cls | 'total', number> {
  const c = { auto: 0, manual: 0, hard: 0, total: clips.length };
  for (const x of clips) c[x.cls]++;
  return c;
}

export function verifyCounts(clips: ClipReport[]): { checked: number; converged: number } {
  const v = clips.filter((c) => c.verification);
  return { checked: v.length, converged: v.filter((c) => c.verification!.converged).length };
}

export function writeAnimImport(r: AnimImportResult, out: string): AnimWritten {
  mkdirSync(out, { recursive: true });
  const w: AnimWritten = { md: [], json: [], map: join(out, 'anim-map.md'), report: join(out, 'report.md') };
  for (const g of r.groups) {
    const f = join(out, `${g.name}.anim.md`);
    writeFileSync(f, g.md);
    w.md.push(f);
    if (g.json) {
      const j = join(out, `${g.name}.anim.json`);
      writeFileSync(j, JSON.stringify(g.json, null, 1) + '\n');
      w.json.push(j);
    }
  }
  writeFileSync(w.map, mapMd(r.map));
  const json = {
    project: r.project,
    ids: r.ids,
    scene: r.scene,
    counts: counts(r.clips),
    verification: { points: r.points, ...verifyCounts(r.clips) },
    groups: r.groups.map((g) => ({
      name: g.name,
      kind: g.kind,
      source: g.source,
      controller: g.controller,
      file: `${g.name}.anim.md`,
      compiled: !!g.json,
      compileErrors: g.compileErrors,
      verifiedOn: g.verifiedOn,
      notes: g.notes,
      transitions: g.transitions,
      clips: g.clips,
    })),
    map: r.map,
    warnings: r.warnings,
  };
  writeFileSync(join(out, 'report.json'), JSON.stringify(json, (_k, v) => (v === Infinity ? 'Infinity' : v), 1) + '\n');
  writeFileSync(w.report, reportMd(r));
  return w;
}

const attrList = (a: string[]): string => (a.length > 6 ? `${a.slice(0, 5).join(', ')} … (${a.length} in all)` : a.join(', '));
const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const num = (n: number): string => (Number.isFinite(n) ? fmt(n, 3) : '∞');

function verdict(c: ClipReport): string {
  const v = c.verification;
  if (!v) return 'not run';
  if (v.error) return `no: ${v.error}`;
  if (v.converged) return `yes (${v.points} points)`;
  const bad = v.columns.filter((x) => !x.ok).map((x) => `${x.target}.${x.col} off by ${num(x.maxErr)} at ${num(x.at)} s (±${x.tol})`);
  return `no: ${[...bad, ...v.events.map((e) => `event ${e} missing`)].join('; ')}`;
}

function reportMd(r: AnimImportResult): string {
  const c = counts(r.clips);
  const v = verifyCounts(r.clips);
  const lines = [
    '# trempel-anim-import — report',
    '',
    `Project: \`${r.project}\` · ${r.groups.length} md file(s) · ${c.total} clips: **auto ${c.auto}**, **manual ${c.manual}**, **hard ${c.hard}** · verification: **${v.converged} of ${v.checked} converged** (${r.points} points per clip).`,
    '',
    r.ids === 'scene'
      ? `Ids: nodes of the scene \`${r.scene}\` matched by name (the last path segment); unmatched paths are left out — see anim-map.md.`
      : 'Ids: the idified last segments of the paths (no --scene) — check them against your scene, or pass --scene / --map.',
    '',
    '- `auto` — transferred exactly (Hermite / weighted Bézier segments as cubic eases, steps, baked spots within the tolerance); `manual` — transferred, something approximated (look at it); `hard` — something the clip does not carry over (what).',
    '- Verification: the md compiled and played by Trempel vs Unity’s evaluation of the curves, per column — position ±0.5 px, rotation ±0.5°, scale ±0.5 %, alpha ±0.01, tint ±1/255, tex exact, events.',
    '',
    '| md | clip | state | source | duration | loop | class | verified |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const x of r.clips) lines.push(`| ${x.group}.anim.md | ${cell(x.clip)} | ${cell(x.state ?? '—')} | ${cell(x.source)} | ${num(x.duration)} | ${x.loop ? 'yes' : 'no'} | ${x.cls} | ${cell(verdict(x))} |`);
  for (const g of r.groups) {
    lines.push('', `## ${g.name}.anim.md — ${g.kind} \`${g.source}\``, '');
    if (g.controller && g.controller !== g.source) lines.push(`Controller: \`${g.controller}\`.`, '');
    for (const n of g.notes) lines.push(`- ${cell(n)}`);
    if (g.transitions.length) {
      lines.push('', '**Transitions — hard: not executed (the game plays the clips; these are its logic):**', '');
      for (const t of g.transitions) lines.push(`- ${cell(t)}`);
    }
    if (g.compileErrors.length) {
      lines.push('', '**Compile errors:**', '');
      for (const e of g.compileErrors) lines.push(`- ${cell(e)}`);
    }
    lines.push('', `Verified on: ${g.verifiedOn === 'none' ? 'not verified' : g.verifiedOn === 'scene' ? 'the scene' : 'a synthetic scene (a node per target)'}.`);
    for (const x of g.clips) {
      lines.push('', `### ${x.clip} — ${x.cls}`, '');
      for (const n of x.notes) lines.push(`- ${cell(n)}`);
      if (x.notes.length) lines.push('');
      lines.push('| path | id | attributes | columns | class | notes |', '|---|---|---|---|---|---|');
      for (const it of x.items) lines.push(`| ${cell(it.path || ROOT_PATH)} | ${it.target ?? '—'} | ${cell(attrList(it.attributes))} | ${it.columns.join(', ') || '—'} | ${it.cls} | ${cell(it.notes.join('; ')) || '—'} |`);
      if (x.events.length) {
        lines.push('', '| t | event | parameters |', '|---|---|---|');
        for (const e of x.events) lines.push(`| ${num(e.t)} | ${cell(e.name)} | ${cell(e.params ?? '—')} |`);
      }
      lines.push('', `Verification: ${verdict(x)}.`);
    }
  }
  if (r.warnings.length) {
    lines.push('', '## Warnings', '');
    for (const w of r.warnings) lines.push(`- ${cell(w)}`);
  }
  return lines.join('\n') + '\n';
}


