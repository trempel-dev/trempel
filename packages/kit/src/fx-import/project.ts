// project.ts — a Unity project read from disk, as far as particle systems need it: the GUID index
// (every `*.meta` of Assets/, Packages/, Library/PackageCache/), assets parsed once, and prefabs /
// scenes FLATTENED — nested prefab instances expanded with their modifications applied — into one
// tree of GameObjects with their components.
//
// Nested prefabs (Unity 2018.3+): an object of a prefab instance P inside a file has the id
// (P ^ id-in-the-source) & 0x7fffffffffffffff; `stripped` documents are placeholders of such objects
// (the file's own children / components hang on them); m_Modifications target the source's objects
// by their source ids (`target: {fileID, guid}`) with a property path ('InitialModule.startSize.scalar',
// 'm_Materials.Array.data[0]', 'm_IsActive'…). Removed components / GameObjects are dropped. Children
// and components are found by back references (m_Father, m_GameObject), so added ones are in.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { list, map, num, parseUnityYaml, ref, type UnityDoc, type YamlMap, type YamlValue } from './yaml.js';

export interface UObject {
  classId: number;
  type: string;
  id: string;
  body: YamlMap;
}

export interface UGameObject {
  id: string;
  name: string;
  active: boolean;
  parent: UGameObject | null;
  children: UGameObject[];
  components: UObject[];
  transform: UObject | null;
}

/** A flattened asset: its objects by id and the tree of its GameObjects. */
export interface UAsset {
  path: string;
  objects: Map<string, UObject>;
  roots: UGameObject[];
  gameObjects: Map<string, UGameObject>;
  /** What could not be resolved (a missing nested prefab, a modification target not found). */
  warnings: string[];
}

const MASK = (1n << 63n) - 1n;
/** The id of a source object `id` inside the prefab instance `instance`. */
export const derivedId = (instance: string, id: string): string => ((BigInt(instance) ^ BigInt(id)) & MASK).toString();

const SKIP = new Set(['node_modules', '.git', 'Temp', 'Logs', 'obj', 'Build', 'Builds']);

export class UnityProject {
  /** guid → absolute path. */
  private readonly guids = new Map<string, string>();
  private readonly parsed = new Map<string, UnityDoc[]>();
  private readonly flat = new Map<string, Map<string, UObject>>();
  readonly warnings: string[] = [];

  /** `root` — the folder holding Assets/ (found upwards from a file or folder inside it). */
  constructor(readonly root: string) {
    for (const top of ['Assets', 'Packages', join('Library', 'PackageCache')]) {
      const dir = join(root, top);
      if (existsSync(dir)) this.index(dir);
    }
  }

  /** The project root of a path inside it (the nearest ancestor holding Assets/), or null. */
  static rootOf(p: string): string | null {
    let d = resolve(p);
    if (existsSync(d) && statSync(d).isFile()) d = dirname(d);
    for (;;) {
      if (existsSync(join(d, 'Assets')) && statSync(join(d, 'Assets')).isDirectory()) return d;
      const up = dirname(d);
      if (up === d) return null;
      d = up;
    }
  }

  /** Absolute path of an asset by GUID. */
  pathOf(guid: string | undefined): string | undefined {
    return guid ? this.guids.get(guid) : undefined;
  }

  /** The project-relative path (with / separators). */
  rel(abs: string): string {
    return relative(this.root, abs).split(sep).join('/');
  }

  get size(): number {
    return this.guids.size;
  }

  private index(dir: string): void {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (SKIP.has(n)) continue;
      const p = join(dir, n);
      if (n.endsWith('.meta')) {
        const head = readHead(p);
        const g = /^guid:\s*([0-9a-f]{32})/m.exec(head)?.[1];
        if (g) this.guids.set(g, p.slice(0, -5));
        continue;
      }
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) this.index(p);
    }
  }

  /** The documents of a YAML asset (parsed once). */
  docs(abs: string): UnityDoc[] {
    let d = this.parsed.get(abs);
    if (!d) {
      const text = readFileSync(abs, 'utf8');
      if (!text.startsWith('%YAML')) throw new Error(`${this.rel(abs)}: not a text-serialized Unity asset (Force Text serialization)`);
      d = parseUnityYaml(text);
      this.parsed.set(abs, d);
    }
    return d;
  }

  /** The first document of a type in an asset (a material's Material, a .meta's importer). */
  first(abs: string, type: string): YamlMap | null {
    return this.docs(abs).find((d) => d.type === type)?.body ?? null;
  }

  /** A prefab / scene with every nested prefab instance expanded. */
  asset(abs: string): UAsset {
    const warnings: string[] = [];
    const objects = this.objects(abs, [], warnings);
    return { path: abs, objects, ...tree(objects), warnings };
  }

  /** The flattened objects of a file (ids of this file), cached per file. */
  private objects(abs: string, stack: string[], warnings: string[]): Map<string, UObject> {
    const hit = this.flat.get(abs);
    if (hit) return hit;
    if (stack.includes(abs)) throw new Error(`prefab cycle: ${[...stack, abs].map((p) => this.rel(p)).join(' → ')}`);
    const out = new Map<string, UObject>();
    const docs = this.docs(abs);
    for (const d of docs) if (!d.stripped && d.classId !== 1001) out.set(d.fileID, { classId: d.classId, type: d.type, id: d.fileID, body: d.body });
    for (const d of docs) {
      if (d.classId !== 1001 || d.stripped) continue;
      const mod = map(d.body.m_Modification);
      const srcRef = ref(d.body.m_SourcePrefab);
      const src = this.pathOf(srcRef?.guid);
      if (!src) {
        warnings.push(`${this.rel(abs)}: nested prefab ${srcRef?.guid ?? '?'} not found`);
        continue;
      }
      const inner = this.objects(src, [...stack, abs], warnings);
      const P = d.fileID;
      const removed = new Set([...list(mod.m_RemovedComponents), ...list(mod.m_RemovedGameObjects)].map((r) => ref(r)).filter((r): r is NonNullable<typeof r> => !!r).map((r) => derivedId(P, r.fileID)));
      for (const o of inner.values()) {
        const id = derivedId(P, o.id);
        if (removed.has(id)) continue;
        out.set(id, { classId: o.classId, type: o.type, id, body: remap(o.body, P) as YamlMap });
      }
      // The instance's root under its parent in this file.
      const parent = ref(mod.m_TransformParent);
      for (const o of inner.values()) {
        if (o.type !== 'Transform' && o.type !== 'RectTransform') continue;
        if (ref(o.body.m_Father)) continue;
        const t = out.get(derivedId(P, o.id));
        if (t) t.body.m_Father = { fileID: parent?.fileID ?? '0' };
      }
      let stale = 0;
      for (const m of list(mod.m_Modifications)) {
        const mm = map(m);
        const target = ref(mm.target);
        const path = typeof mm.propertyPath === 'string' ? mm.propertyPath : '';
        if (!target || !path) continue;
        const o = out.get(derivedId(P, target.fileID));
        if (!o) {
          // Unity keeps overrides of objects the source no longer has (unused overrides).
          if (!removed.has(derivedId(P, target.fileID))) stale++;
          continue;
        }
        const objRef = ref(mm.objectReference);
        const value = typeof mm.value === 'string' ? mm.value : '';
        setPath(o.body, path, value === '' && objRef ? (mm.objectReference as YamlValue) : value);
      }
      if (stale) warnings.push(`${this.rel(abs)}: ${stale} unused override(s) of ${this.rel(src)} (their targets are gone) — ignored`);
    }
    this.flat.set(abs, out);
    return out;
  }
}

function readHead(p: string): string {
  try {
    return readFileSync(p, 'utf8').slice(0, 400);
  } catch {
    return '';
  }
}

/** A deep copy with the file-local references ({fileID} without a guid) moved into the instance. */
function remap(v: YamlValue, P: string): YamlValue {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((x) => remap(x, P));
  const keys = Object.keys(v);
  if (keys.includes('fileID') && !v.guid && typeof v.fileID === 'string' && v.fileID !== '0' && keys.every((k) => k === 'fileID')) return { fileID: derivedId(P, v.fileID) };
  const out: YamlMap = {};
  for (const k of keys) out[k] = remap(v[k], P);
  return out;
}

/** Set a property path of a serialized object: 'a.b', 'm_X.Array.data[2].y', 'm_X.Array.size'. */
export function setPath(body: YamlMap, path: string, value: YamlValue): void {
  const parts = path.split('.');
  let cur: YamlValue = body;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const last = i === parts.length - 1;
    if (p === 'Array' && Array.isArray(cur)) continue;
    if (Array.isArray(cur)) {
      const arr: YamlValue[] = cur;
      if (p === 'size') {
        const n = num(value as string);
        while (arr.length < n) arr.push({});
        arr.length = n;
        return;
      }
      const m = /^data\[(\d+)\]$/.exec(p);
      if (!m) return;
      const k = Number(m[1]);
      while (arr.length <= k) arr.push({});
      if (last) arr[k] = value;
      else {
        if (typeof arr[k] !== 'object') arr[k] = parts[i + 1] === 'Array' ? [] : {};
        cur = arr[k];
      }
      continue;
    }
    if (typeof cur !== 'object') return;
    const obj: YamlMap = cur;
    if (last) {
      obj[p] = value;
      return;
    }
    if (typeof obj[p] !== 'object' || obj[p] === null) obj[p] = parts[i + 1] === 'Array' ? [] : {};
    cur = obj[p];
  }
}

/** The GameObject tree of flattened objects (children by m_Father, components by m_GameObject). */
function tree(objects: Map<string, UObject>): { roots: UGameObject[]; gameObjects: Map<string, UGameObject> } {
  const gos = new Map<string, UGameObject>();
  for (const o of objects.values()) {
    if (o.type !== 'GameObject') continue;
    gos.set(o.id, { id: o.id, name: typeof o.body.m_Name === 'string' ? o.body.m_Name : '', active: o.body.m_IsActive !== '0', parent: null, children: [], components: [], transform: null });
  }
  for (const o of objects.values()) {
    const g = ref(o.body.m_GameObject);
    const go = g && !g.guid ? gos.get(g.fileID) : undefined;
    if (!go || o.type === 'GameObject') continue;
    go.components.push(o);
    if (o.type === 'Transform' || o.type === 'RectTransform') go.transform = o;
  }
  const goOfTransform = new Map<string, UGameObject>();
  for (const go of gos.values()) if (go.transform) goOfTransform.set(go.transform.id, go);
  const roots: UGameObject[] = [];
  for (const go of gos.values()) {
    const f = go.transform ? ref(go.transform.body.m_Father) : null;
    const parent = f ? goOfTransform.get(f.fileID) : undefined;
    if (parent) {
      go.parent = parent;
      parent.children.push(go);
    } else roots.push(go);
  }
  // Children in the order of m_Children (added ones after).
  for (const go of gos.values()) {
    if (!go.transform || go.children.length < 2) continue;
    const order = list(go.transform.body.m_Children).map((c) => ref(c)?.fileID);
    const at = (c: UGameObject) => {
      const i = order.indexOf(c.transform?.id);
      return i < 0 ? 1e9 : i;
    };
    go.children.sort((a, b) => at(a) - at(b));
  }
  roots.sort((a, b) => num(map(a.transform?.body).m_RootOrder) - num(map(b.transform?.body).m_RootOrder));
  return { roots, gameObjects: gos };
}

/** The path of a GameObject from its asset root ('Root/Child/Leaf'). */
export function goPath(go: UGameObject): string {
  const names: string[] = [];
  for (let g: UGameObject | null = go; g; g = g.parent) names.unshift(g.name);
  return names.join('/');
}

/** Every `.prefab` / `.unity` under a folder (Assets/ by default). */
export function assetsUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const n of names.sort()) {
      if (SKIP.has(n)) continue;
      const p = join(d, n);
      if (n.endsWith('.prefab') || n.endsWith('.unity')) out.push(p);
      else if (!n.includes('.')) {
        try {
          if (statSync(p).isDirectory()) walk(p);
        } catch {
          // unreadable: skipped
        }
      } else if (statSync(p).isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out;
}

export const fileStem = (p: string): string => basename(p).replace(/\.[^.]+$/, '');
