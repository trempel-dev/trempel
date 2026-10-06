// scenes.ts — the scene documents of a game for the kit's runtime (2.0), and md clips at build time.
//
// The scene table. The kit's screens mount prefabs (`<use href>`), tml:extends chains and
// collection documents through a loader; the plugin gives it the documents, so the game configures
// nothing (no prefab glob, no `@trempel/scene` substitute, no hand-made pre-bundle). At build / dev
// start it reads the project (`.trempel/project.mdz` of the Vite root: collections, project heirs),
// takes the game's scene documents — every heir, contract, and base with an heir, a contract or
// instances, outside node_modules / builds / dot-folders — and follows their `<use href>` and
// `tml:extends` (collections included) to what they reach. A virtual module imports those files
// (`?raw` — the same modules as the game's own imports, one copy in the bundle) and puts the table
// on `globalThis.TREMPEL_SCENE_TABLE`; a <script type="module"> injected before the game's runs it.
// The collections' folders are added to the dev server's fs.allow.
//
// md clips: `import clips from './anim/win.md?clips=popup-win'` compiles the clip file at build time
// (`compileClips`) and checks its targets against the composed scene (`popup-win`, a scene path from
// the md's folder, or from its parent for `anim/*.md` — the format's place of clips); a bad clip or
// scene fails the build with its codes (`E_ANIM_*`, …). `?clips` alone — compiled without a scene.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { searchForWorkspaceRoot, type Plugin } from 'vite';
import { checkScene, compileClipsResult, expandCollection, within, type SceneSource } from '@trempel/scene/core';
import { heirsOf, isInside, loadProject, type Project } from '@trempel/scene/node';
import { resolveHref } from '@trempel/scene/internal/href';
import { SCENE_TABLE_KEY } from '../ui/scene-table.js';

const VIRTUAL = 'virtual:trempel-kit/scenes';
const RESOLVED = '\0' + VIRTUAL;
/** The URL the injected script asks for (resolved to the virtual module by this plugin). */
const SCRIPT = '/@trempel-kit/scenes.js';
const SKIP = /^(?:node_modules|dist|dist-.*|build|coverage|test-results|playwright-report)$/;

const posix = (p: string): string => p.split(sep).join('/');
const read = (f: string): string | undefined => (existsSync(f) ? readFileSync(f, 'utf8') : undefined);

/** The scene documents a game's screens can reach: table key (`scenes/x.svg`, `@ui/x.svg`) → absolute file. */
export interface SceneFiles {
  files: Map<string, string>;
  /** Project heirs: collection document → the heir's scene path from the root. */
  heirs: Record<string, string>;
  collections: string[];
  errors: string[];
}

/** The table key of an absolute file: from the root, or `@name/…` in a collection. */
function keyOf(file: string, root: string, project: Project): string | null {
  let best: { name: string; dir: string } | null = null;
  for (const [name, dir] of Object.entries(project.collections)) if (isInside(dir, file) && (!best || dir.length > best.dir.length)) best = { name, dir };
  if (best) return `@${best.name}/${posix(relative(best.dir, file))}`;
  return isInside(root, file) ? posix(relative(root, file)) : null;
}

/** The absolute file of a table key. */
function fileOf(key: string, root: string, project: Project): string | null {
  const m = /^@([a-z][a-z0-9-]*)\/(.*)$/.exec(key);
  if (!m) return join(root, ...key.split('/'));
  const dir = project.collections[m[1]];
  return dir ? join(dir, ...m[2].split('/')) : null;
}

/** Collect the game's scene documents (see the header). */
export function collectScenes(root: string, project: Project = loadProject(root)): SceneFiles {
  const files = new Map<string, string>();
  const errors = [...project.errors];
  const queue: string[] = [];
  const add = (key: string): void => {
    const stem = key.replace(/(\.tml)?\.svg$|\.contract\.xml$/, '');
    for (const ext of ['.svg', '.tml.svg', '.contract.xml']) {
      const k = stem + ext;
      if (files.has(k)) continue;
      const f = fileOf(k, root, project);
      if (f && existsSync(f)) {
        files.set(k, f);
        queue.push(k);
      }
    }
  };
  // The game's own documents (outside its collections).
  const walk = (d: string): void => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      if (ent.name.startsWith('.')) continue;
      const p = join(d, ent.name);
      if (ent.isDirectory()) {
        if (!SKIP.test(ent.name) && !Object.values(project.collections).some((c) => isInside(c, p))) walk(p);
        continue;
      }
      const n = ent.name;
      const isScene =
        n.endsWith('.tml.svg') ||
        n.endsWith('.contract.xml') ||
        (n.endsWith('.svg') && (existsSync(p.replace(/\.svg$/, '.tml.svg')) || existsSync(p.replace(/\.svg$/, '.contract.xml')) || /<use\b/.test(readFileSync(p, 'utf8'))));
      if (isScene) add(posix(relative(root, p)));
    }
  };
  walk(root);
  // What they reach: instances and tml:extends, in collections too.
  while (queue.length) {
    const key = queue.shift()!;
    if (key.endsWith('.contract.xml')) continue;
    const text = read(files.get(key)!) ?? '';
    const refs = [...text.matchAll(/<use\b[^>]*?\shref="([^"]+)"/g), ...text.matchAll(/\btml:extends="([^"]+)"/g)].map((m) => m[1]);
    for (const href of refs) {
      if (/^[a-z][a-z\d+.-]*:|^\/|^#/i.test(href)) continue;
      add(resolveHref(href, key));
    }
  }
  const heirs: Record<string, string> = {};
  for (const [doc, scene] of Object.entries(project.heirs)) {
    const k = keyOf(scene, root, project);
    if (k) heirs[doc] = k;
  }
  return { files, heirs, collections: Object.keys(project.collections), errors };
}

/** The virtual module: the documents as `?raw` imports, the table (by stem) on globalThis. */
export function tableModule(s: SceneFiles): string {
  const lines: string[] = [];
  const stems = new Map<string, (string | undefined)[]>();
  const EXT: [string, number][] = [['.tml.svg', 1], ['.contract.xml', 2], ['.svg', 0]];
  let i = 0;
  for (const [key, file] of [...s.files].sort(([a], [b]) => a.localeCompare(b))) {
    const [ext, slot] = EXT.find(([e]) => key.endsWith(e))!;
    const stem = key.slice(0, -ext.length);
    lines.push(`import d${i} from ${JSON.stringify(posix(file) + '?raw')};`);
    const row = stems.get(stem) ?? [];
    row[slot] = `d${i}`;
    stems.set(stem, row);
    i++;
  }
  const rows = [...stems].map(([stem, r]) => `${JSON.stringify(stem)}:[${[0, 1, 2].map((k) => r[k] ?? '').join(',')}]`);
  lines.push(`globalThis[${JSON.stringify(SCENE_TABLE_KEY)}] = { scenes: { ${rows.join(', ')} }, heirs: ${JSON.stringify(s.heirs)}, collections: ${JSON.stringify(s.collections)} };`);
  return lines.join('\n') + '\n';
}

/** A scene composed from disk (the clips' check): the same pipeline as mount, with the project. */
export function composeOnDisk(sceneFile: string, project: Project): ReturnType<typeof checkScene> {
  const stem = sceneFile.replace(/(\.tml)?\.svg$/, '');
  const load = (url: string): SceneSource | null => {
    const s = url.replace(/\.svg$/, '');
    const src = { base: read(`${s}.svg`), heir: read(`${s}.tml.svg`), contract: read(`${s}.contract.xml`) };
    return src.base != null || src.heir != null ? src : null;
  };
  const top = load(`${stem}.svg`);
  return checkScene({
    base: top?.base,
    heir: top?.heir,
    contract: top?.contract,
    path: `${stem}.svg`,
    loadScene: load,
    url: (rel) => resolve(dirname(stem), expandCollection(rel, project.collections)),
    collections: project.collections,
    heirs: heirsOf(project, `${stem}.svg`),
  });
}

export function scenesPlugin(): Plugin[] {
  let root = process.cwd();
  let project: Project | null = null;
  const projectOf = (): Project => (project ??= loadProject(root));

  const table: Plugin = {
    name: 'trempel-kit:scenes',
    config(user) {
      const r = resolve(user.root ?? process.cwd());
      const p = loadProject(r);
      const allow = Object.values(p.collections);
      return {
        // The collections usually live next to the game (a UI kit's repository): the dev server may serve them.
        server: allow.length ? { fs: { allow: [searchForWorkspaceRoot(r), ...allow] } } : undefined,
        optimizeDeps: { include: ['pixi.js', 'pixi.js/unsafe-eval'] },
      };
    },
    configResolved(c) {
      root = c.root;
      project = null;
    },
    resolveId(id) {
      if (id === VIRTUAL || id === SCRIPT) return RESOLVED;
      return null;
    },
    load(id) {
      if (id !== RESOLVED) return null;
      project = null;
      const s = collectScenes(root, projectOf());
      for (const e of s.errors) this.warn(e);
      for (const f of s.files.values()) this.addWatchFile(f);
      return tableModule(s);
    },
    transformIndexHtml: {
      order: 'pre',
      handler: () => [{ tag: 'script', attrs: { type: 'module', src: SCRIPT }, injectTo: 'head-prepend' }],
    },
  };

  const clips: Plugin = {
    name: 'trempel-kit:clips',
    enforce: 'pre',
    configResolved(c) {
      root = c.root;
    },
    load(id) {
      const q = id.indexOf('?');
      if (q < 0) return null;
      const file = id.slice(0, q);
      const params = new URLSearchParams(id.slice(q + 1));
      if (!params.has('clips') || !file.endsWith('.md')) return null;
      const md = readFileSync(file, 'utf8');
      this.addWatchFile(file);
      const scene = params.get('clips');
      let tree = undefined;
      if (scene) {
        const dir = dirname(file);
        const candidates = [join(dir, scene), join(dir, '..', scene)].map((p) => p.replace(/(\.tml)?\.svg$/, ''));
        const stem = candidates.find((c) => existsSync(`${c}.svg`) || existsSync(`${c}.tml.svg`));
        if (!stem) this.error(`E_ANIM_TARGET: ${relative(root, file)}?clips=${scene}: no scene ${scene}.svg / ${scene}.tml.svg next to the clips (or above their anim/ folder).`);
        const proj = loadProject(dirname(stem!));
        const c = composeOnDisk(`${stem}.svg`, proj);
        for (const f of ['.svg', '.tml.svg', '.contract.xml']) if (existsSync(stem + f)) this.addWatchFile(stem + f);
        if (c.errors.length || !c.tree) this.error((c.errors.length ? c.errors : ['E_EMPTY_SCENE: nothing to compose']).map((e) => within(`${relative(root, file)}?clips=${scene}`, e)).join('\n'));
        tree = c.tree!;
      }
      const r = compileClipsResult(md, tree);
      if (r.errors.length) this.error(r.errors.map((e) => within(`${relative(root, file)}${scene ? `?clips=${scene}` : ''}`, e)).join('\n'));
      return `export default ${JSON.stringify(r.clips)};`;
    },
  };

  return [table, clips];
}
