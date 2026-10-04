// io.ts — SceneIO: how the editor reaches the scene folder. One seam, any host:
//   - io-dev.ts — the editor's Vite dev server (`npm run edit`);
//   - a host of the page library (`@trempel/scene/edit`) brings its own (a desktop shell, a tab…).
// Paths are relative to the scene folder, '/'-separated; the folder itself is fixed when the IO
// is created (the dev server's folder, the folder of the file the host was opened on).

export interface FolderListing {
  /** Folder name for the header. */
  name: string;
  /** Every file below the folder (relative), what discoverScenes groups into scenes. */
  files: string[];
  /** Consumer module in use (trempel.view.ts), if any. */
  module: string | null;
  /** The host lets the editor write. */
  writable: boolean;
  /** Listing problem (the folder is gone…). */
  error?: string;
}

export interface FileChange {
  /** Relative path of the changed file. */
  file: string;
  /** Content hash when the host knows it — a write of our own comes back with our hash. */
  hash?: string;
}

export interface SceneIO {
  /**
   * List the folder (`dir` — a subfolder, '' — the folder itself). Paths are relative to the folder;
   * dot-folders are skipped unless named by `dir` (the macros: `.trempel/macros`).
   */
  list(dir?: string): Promise<FolderListing>;
  /** Text of a file. @throws when it cannot be read. */
  read(path: string): Promise<string>;
  /**
   * Write a scene base (text), or a render (bytes — a PNG into `renders/` of the folder, batch 2);
   * resolves with the content hash. @throws (403 — outside the folder / not a base / not renders/*.png;
   * a host that cannot write bytes).
   */
  write(path: string, data: string | Uint8Array): Promise<{ hash: string }>;
  /** Changes of files in the folder; returns unsubscribe. */
  watch(dir: string, cb: (change: FileChange) => void): () => void;
  /** URL a file is served at (scene documents — relative hrefs resolve against it; art; fonts). */
  url(path: string): string;
  /** URL of the folder itself (ends with '/'). */
  folderUrl(): string;
  /**
   * Host only: the native file picker; resolves a path relative to the folder (null — cancelled).
   * Without it the page offers its own list of the folder's files (the dev server).
   * @throws when the picked file is outside the folder.
   */
  pick?(opts: { title: string; extensions: string[] }): Promise<string | null>;
  /** Host only: the URL the runtime fetches for one resolved from url() (virtual base → real). */
  assetUrl?(url: string): string;
}

/** sha1 hex of a text (the dev server's textHash, in the browser); FNV-1a where WebCrypto is absent (insecure origin). */
export async function sha1(text: string): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return `fnv-${h.toString(16)}-${text.length}`;
}

/** Clip files of a scene: `anim/*.md` next to it and `*.anim.md` in its folder (view/discover.ts). */
export { clipFiles } from '../view/discover';

/** Raster/vector images an `<image href>` can take. */
export const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'svg'];

/** `file` (relative to the folder) as seen from the folder of `from` (a scene base): for href. */
export function relativeTo(from: string, file: string): string {
  const a = from.split('/').slice(0, -1);
  const b = file.split('/');
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
}
