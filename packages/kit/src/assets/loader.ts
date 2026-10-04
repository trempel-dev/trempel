// loader.ts — asset bundles over Pixi `Assets`: an initial
// bundle loaded before gameReady (with progress for the loading screen), lazy bundles loaded on
// demand (screen show) or in the background. The size budget of the initial bundle (Playables
// MUST < 30 MiB, SHOULD < 15 MiB) is a BUILD gate (../vite/gates.ts): the runtime cannot measure
// bytes reliably, the build can.

import { Assets } from 'pixi.js';
import { expandCollection } from '@trempel/scene';

export type AssetSpec = string | { src: string; data?: Record<string, unknown> };

export interface BundleMap {
  [bundle: string]: AssetSpec[];
}

export class Loader {
  private readonly loaded = new Set<string>();
  private readonly loading = new Map<string, Promise<void>>();

  constructor(
    private readonly bundles: BundleMap = {},
    private readonly resolve: (href: string) => string = (h) => h,
  ) {}

  has(bundle: string): boolean {
    return bundle in this.bundles;
  }

  isLoaded(bundle: string): boolean {
    return this.loaded.has(bundle);
  }

  /** Load a bundle (idempotent). `onProgress` 0..1. Unknown bundle → throws. */
  load(bundle: string, onProgress?: (p: number) => void): Promise<void> {
    if (this.loaded.has(bundle)) {
      onProgress?.(1);
      return Promise.resolve();
    }
    const busy = this.loading.get(bundle);
    if (busy) return busy;
    const list = this.bundles[bundle];
    if (!list) throw new Error(`Loader: unknown bundle "${bundle}" (known: ${Object.keys(this.bundles).join(', ') || 'none'})`);
    const p = this.loadList(list, onProgress).then(() => {
      this.loaded.add(bundle);
      this.loading.delete(bundle);
    });
    this.loading.set(bundle, p);
    return p;
  }

  /** Start loading without waiting (next level, bonus art). Errors are reported on load(). */
  background(bundle: string): void {
    this.load(bundle).catch(() => this.loading.delete(bundle));
  }

  /** Load arbitrary assets (scene-relative hrefs or URLs). */
  async loadList(list: AssetSpec[], onProgress?: (p: number) => void): Promise<void> {
    if (!list.length) {
      onProgress?.(1);
      return;
    }
    const specs = list.map((a) => (typeof a === 'string' ? { src: this.resolve(a) } : { ...a, src: this.resolve(a.src) }));
    await Assets.load(specs, onProgress);
  }
}

/**
 * Asset URL table from a Vite glob: `assetTable(import.meta.glob('./art/**', { eager: true, query: '?url', import: 'default' }), './')`
 * → resolveHref for scenes ('art/hero.png' → hashed URL). Unknown hrefs pass through.
 */
export function assetTable(glob: Record<string, string>, prefix = './'): (href: string) => string {
  const table = new Map<string, string>();
  for (const [path, url] of Object.entries(glob)) table.set(path.startsWith(prefix) ? path.slice(prefix.length) : path, url);
  return (href) => table.get(href.replace(/^(\.\.\/)+|^\.\//, '')) ?? href;
}

/**
 * Trempel collections (v1.1) in front of an href resolver: `@name/path` → `<collections[name]>/path`
 * first, so the bundler's table (assetTable) sees an ordinary path. Unknown name → throws. Without
 * collections — `resolve` itself.
 */
export function withCollections(resolve: (href: string) => string, collections?: Record<string, string>): (href: string) => string {
  return collections ? (href) => resolve(expandCollection(href, collections)) : resolve;
}
