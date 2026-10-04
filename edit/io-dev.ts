// io-dev.ts — SceneIO over the editor's dev server (view/plugin.ts with `writable`):
//   GET /__tml/scenes → listing, GET /__tml/list?dir= → a subfolder, GET /__tml/files/<path> → a file, POST /__tml/write → { hash },
//   Vite ws 'tml:changed' → { file, hash } (our own writes are filtered out by the server).

import type { FileChange, FolderListing, SceneIO } from './io';

const FILES = '/__tml/files/';

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function devIO(hot?: { on(event: string, cb: (data: FileChange) => void): void; off?(event: string, cb: (data: FileChange) => void): void }): SceneIO {
  const url = (rel: string): string => new URL(FILES + rel.split('/').map(encodeURIComponent).join('/'), location.origin).href;
  return {
    async list(dir = ''): Promise<FolderListing> {
      if (dir) {
        const r = await fetch(`/__tml/list?dir=${encodeURIComponent(dir)}`, { cache: 'no-store' });
        const data = (await r.json().catch(() => ({}))) as { files?: string[]; error?: string };
        return { name: dir, files: data.files ?? [], module: null, writable: false, error: r.ok ? undefined : (data.error ?? `HTTP ${r.status}`) };
      }
      const r = await fetch('/__tml/scenes');
      const data = (await r.json()) as FolderListing;
      return { name: data.name, files: data.files ?? [], module: data.module, writable: !!data.writable, error: data.error };
    },
    async read(path) {
      const r = await fetch(url(path), { cache: 'no-store' });
      if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
      return r.text();
    },
    async write(path, data) {
      const body = typeof data === 'string' ? { path, text: data } : { path, base64: toBase64(data) };
      const r = await fetch('/__tml/write', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const res = (await r.json().catch(() => ({}))) as { hash?: string; error?: string };
      if (!r.ok || !res.hash) throw new Error(`запись ${path}: ${res.error ?? `HTTP ${r.status}`}`);
      return { hash: res.hash };
    },
    watch(_dir, cb) {
      if (!hot) return () => {};
      const fn = (data: FileChange): void => cb(data);
      hot.on('tml:changed', fn);
      return () => hot.off?.('tml:changed', fn);
    },
    url,
    folderUrl: () => new URL(FILES, location.origin).href,
  };
}
