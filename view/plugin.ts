// plugin.ts — the viewer's Vite plugin (node side): scene listing, the scene folder's files, and
// the consumer module as a virtual import.
//
//   GET /__tml/scenes        → { name, module, scenes: SceneEntry[] } (rescanned per request)
//   GET /__tml/files/<path>  → a file of the scene folder (documents, art, fonts, macros)
//   GET /__tml/list?dir=<sub> → { files } below a subfolder (relative to the folder; `.trempel/macros`)
//   import 'virtual:trempel-view-module' → the folder's trempel.view.ts default export, or null
//   ws 'tml:changed'         → a scene file changed on disk (the page reopens the scene);
//                              { file, hash } — a write of our own (same hash) is not announced
//   POST /__tml/write        → (editor, `writable`) { path, text } → { hash }; only a base X.svg
//                              inside the folder — 403 for anything else (../, contract, heir)

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import type { Plugin } from 'vite';
import { isHeirFile, legacyName, VIEW_MODULE, VIEW_MODULES } from '../src/compat.js';
import { discoverScenes, SKIP_DIRS, type SceneEntry } from './discover';

export const MODULE_NAME = VIEW_MODULE;
const VIRTUAL = 'virtual:trempel-view-module';

const TYPES: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.xml': 'application/xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

/** Relative paths of every file under `dir` (skipping node_modules, dist, dot-folders). */
export function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(join(d, e.name));
      } else if (e.isFile()) {
        out.push(relative(dir, join(d, e.name)).split(sep).join('/'));
      }
    }
  };
  walk(dir);
  return out;
}

/**
 * Files below a subfolder `sub` of `dir`, relative to `dir` (a dot-folder named explicitly — e.g. the
 * editor's `.trempel/macros` — is listed; nested dot-folders are not). null — `sub` is outside `dir`.
 */
export function listSubdir(dir: string, sub: string): string[] | null {
  const root = resolve(dir);
  const d = resolve(root, sub);
  if (d !== root && !d.startsWith(root + sep)) return null;
  if (!existsSync(d) || !statSync(d).isDirectory()) return [];
  const rel = relative(root, d).split(sep).join('/');
  return listFiles(d).map((f) => (rel ? `${rel}/${f}` : f));
}

export function scanScenes(dir: string): SceneEntry[] {
  return discoverScenes(listFiles(dir));
}

export interface ViewPluginOptions {
  /** Scene folder (absolute). */
  dir: string;
  /** Consumer module (absolute); default — `<dir>/trempel.view.ts` when it exists. */
  module?: string;
  /** Accept POST /__tml/write (the editor). */
  writable?: boolean;
}

/** Content hash the editor and the watcher compare (sha1, hex). */
export const textHash = (text: string | Buffer): string => createHash('sha1').update(text).digest('hex');

export type WriteResult = { status: 200; file: string; hash: string } | { status: 400 | 403; error: string };

/**
 * Write a scene base inside `dir`: only `X.svg` (not the heir `X.tml.svg`), only below the folder.
 * Contract, heir, state and clips are read-only for the editor — except a NEW heir: v0.9
 * prefab.extract creates `X.tml.svg` next to a new prefab (an existing heir is never overwritten).
 */
export function writeSceneFile(dir: string, rel: unknown, text: unknown): WriteResult {
  if (typeof rel !== 'string' || !rel || typeof text !== 'string') return { status: 400, error: 'ожидается { path: string, text: string }' };
  const root = resolve(dir);
  const file = resolve(root, rel);
  if (!file.startsWith(root + sep)) return { status: 403, error: `${rel}: вне папки сцен` };
  if (isHeirFile(file) && existsSync(file)) return { status: 403, error: `${rel}: наследник уже есть — редактор не переписывает .tml.svg` };
  if (!file.endsWith('.svg')) return { status: 403, error: `${rel}: редактор пишет только базу сцены (X.svg)` };
  const parts = relative(root, file).split(sep);
  if (parts.some((p) => p.startsWith('.') || SKIP_DIRS.has(p))) return { status: 403, error: `${rel}: служебная папка` };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return { status: 200, file, hash: textHash(text) };
}

/**
 * Write a render of the editor (batch 2, «снимок для видео»): a PNG, base64 in the body, only into a
 * `renders/` folder below the scene folder (created when missing).
 */
export function writeRenderFile(dir: string, rel: unknown, base64: unknown): WriteResult {
  if (typeof rel !== 'string' || !rel || typeof base64 !== 'string') return { status: 400, error: 'ожидается { path: string, base64: string }' };
  const root = resolve(dir);
  const file = resolve(root, rel);
  if (!file.startsWith(root + sep)) return { status: 403, error: `${rel}: вне папки сцен` };
  const parts = relative(root, file).split(sep);
  if (!file.endsWith('.png') || parts.at(-2) !== 'renders') return { status: 403, error: `${rel}: картинки пишутся только в renders/*.png` };
  if (parts.some((p) => p.startsWith('.') || SKIP_DIRS.has(p))) return { status: 403, error: `${rel}: служебная папка` };
  const data = Buffer.from(base64, 'base64');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
  return { status: 200, file, hash: textHash(data) };
}

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
    req.on('error', fail);
  });
}

/** The consumer module for a folder: explicit, else `<dir>/trempel.view.ts` when present. */
export function findModule(dir: string, module?: string): string | null {
  if (module) return resolve(module);
  const own = VIEW_MODULES.map((name) => join(resolve(dir), name)).find((f) => existsSync(f));
  if (own) legacyName(own);
  return own ?? null;
}

export function trempelView(opts: ViewPluginOptions): Plugin {
  const dir = resolve(opts.dir);
  const mod = findModule(dir, opts.module);

  return {
    name: 'trempel-view',
    resolveId(id) {
      return id === VIRTUAL ? '\0' + VIRTUAL : null;
    },
    load(id) {
      if (id !== '\0' + VIRTUAL) return null;
      if (!mod) return 'export default null;';
      return `export { default } from ${JSON.stringify(mod.split(sep).join('/'))};`;
    },
    configureServer(server) {
      /** Hashes of our own writes, by absolute file: their change events are not news. */
      const own = new Map<string, string>();
      server.watcher.add(dir);
      server.watcher.on('change', (file) => {
        if (file.startsWith(dir + sep) && /\.(svg|xml|json|md)$/.test(file)) {
          let hash = '';
          try {
            hash = textHash(readFileSync(file));
          } catch {
            // gone between the event and the read: still a change
          }
          if (hash && own.get(file) === hash) return;
          own.delete(file);
          server.ws.send({ type: 'custom', event: 'tml:changed', data: { file: relative(dir, file).split(sep).join('/'), hash } });
        }
      });

      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://x');
        if (url.pathname === '/__tml/scenes') {
          let files: string[] = [];
          let scenes: SceneEntry[] = [];
          let error: string | undefined;
          try {
            files = listFiles(dir);
            scenes = discoverScenes(files);
          } catch (e) {
            error = e instanceof Error ? e.message : String(e);
          }
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify({ name: basename(dir), module: mod ? basename(mod) : null, scenes, files, writable: !!opts.writable, error }));
          return;
        }
        if (url.pathname === '/__tml/list') {
          const files = listSubdir(dir, url.searchParams.get('dir') ?? '');
          res.statusCode = files ? 200 : 403;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify(files ? { files } : { error: 'вне папки сцен' }));
          return;
        }
        if (url.pathname === '/__tml/write' && req.method === 'POST') {
          const send = (status: number, body: unknown): void => {
            res.statusCode = status;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify(body));
          };
          if (!opts.writable) return send(403, { error: 'папка открыта только на чтение (npm run view) — запись есть в npm run edit' });
          readBody(req)
            .then((raw) => {
              let body: { path?: unknown; text?: unknown; base64?: unknown } = {};
              try {
                body = JSON.parse(raw) as typeof body;
              } catch {
                return send(400, { error: 'тело — не JSON' });
              }
              const r = body.base64 !== undefined ? writeRenderFile(dir, body.path, body.base64) : writeSceneFile(dir, body.path, body.text);
              if (r.status !== 200) return send(r.status, { error: r.error });
              own.set(r.file, r.hash);
              send(200, { hash: r.hash });
            })
            .catch((e: unknown) => send(500, { error: e instanceof Error ? e.message : String(e) }));
          return;
        }
        if (url.pathname.startsWith('/__tml/files/')) {
          const rel = decodeURIComponent(url.pathname.slice('/__tml/files/'.length));
          const file = resolve(dir, rel);
          if (!file.startsWith(dir + sep) || !existsSync(file) || !statSync(file).isFile()) {
            res.statusCode = 404;
            res.end(`not found: ${rel}`);
            return;
          }
          res.setHeader('Content-Type', TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream');
          res.setHeader('Cache-Control', 'no-store');
          createReadStream(file).pipe(res);
          return;
        }
        next();
      });
    },
  };
}
