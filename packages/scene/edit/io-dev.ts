// io-dev.ts — SceneIO over the editor's dev server (view/plugin.ts with `writable`):
//   GET /__tml/scenes → listing, GET /__tml/list?dir= → a subfolder, GET /__tml/files/<path> → a file, POST /__tml/write → { hash },
//   Vite ws 'tml:changed' → { file, hash } (our own writes are filtered out by the server).
// v1.1: files are served under the project root (/__tml/root/<folder>/…) so hrefs leaving the
// folder load; `@name/…` — a collection file (/__tml/c/<name>/…).

import type { FileChange, FolderListing, SceneIO } from './io';
import type { ProjectInfo } from '../view/plugin';
import { coded, codeOf, within } from '../src/core.js';

const FILES = '/__tml/files/';

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function devIO(hot?: { on(event: string, cb: (data: FileChange) => void): void; off?(event: string, cb: (data: FileChange) => void): void }): SceneIO {
  let project: ProjectInfo | null = null;
  const abs = (path: string): string => new URL(path, location.origin).href;
  const enc = (rel: string): string => rel.split('/').map(encodeURIComponent).join('/');
  const folderUrl = (): string => abs(project?.folderUrl ?? FILES);
  const url = (rel: string): string => {
    const m = /^@([a-z][a-z0-9-]*)\/(.*)$/.exec(rel);
    if (m && project?.collections[m[1]]) return abs(project.collections[m[1]] + enc(m[2]));
    return new URL(enc(rel), folderUrl()).href;
  };
  return {
    async list(dir = ''): Promise<FolderListing> {
      if (dir) {
        const r = await fetch(`/__tml/list?dir=${encodeURIComponent(dir)}`, { cache: 'no-store' });
        const data = (await r.json().catch(() => ({}))) as { files?: string[]; error?: string };
        return { name: dir, files: data.files ?? [], module: null, writable: false, error: r.ok ? undefined : (data.error ?? coded('E_FETCH', `${dir}: HTTP ${r.status}`)) };
      }
      const r = await fetch('/__tml/scenes');
      const data = (await r.json()) as FolderListing & { project?: ProjectInfo };
      project = data.project ?? null;
      const collections = project && Object.keys(project.collections).length ? Object.fromEntries(Object.entries(project.collections).map(([k, v]) => [k, abs(v)])) : undefined;
      const error = [data.error, ...(project?.errors ?? [])].filter(Boolean).join('; ') || undefined;
      const heirs = project && Object.keys(project.heirs ?? {}).length ? Object.fromEntries(Object.entries(project.heirs).map(([k, v]) => [k, abs(v)])) : undefined;
      return { name: data.name, files: data.files ?? [], module: data.module, writable: !!data.writable, error, collections, heirs };
    },
    async read(path) {
      const r = await fetch(url(path), { cache: 'no-store' });
      if (!r.ok) throw new Error(coded('E_FETCH', `${path}: HTTP ${r.status}`));
      return r.text();
    },
    async write(path, data) {
      const body = typeof data === 'string' ? { path, text: data } : { path, base64: toBase64(data) };
      const r = await fetch('/__tml/write', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const res = (await r.json().catch(() => ({}))) as { hash?: string; error?: string };
      if (!r.ok || !res.hash) {
        const m = res.error ?? `HTTP ${r.status}`;
        throw new Error(within(`write ${path}`, codeOf(m) ? m : coded('E_EDIT_WRITE', m)));
      }
      return { hash: res.hash };
    },
    watch(_dir, cb) {
      if (!hot) return () => {};
      const fn = (data: FileChange): void => cb(data);
      hot.on('tml:changed', fn);
      return () => hot.off?.('tml:changed', fn);
    },
    url,
    folderUrl,
  };
}
