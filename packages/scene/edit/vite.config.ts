// vite.config.ts — the editor's dev server (npm run edit starts it with TML_VIEW_DIR = the scene
// folder, TML_VIEW_MODULE = an explicit consumer module). The viewer's plugin with writes on.
//
// `@trempel/scene`, `@trempel/scene/core` resolve to this runtime's sources and `pixi.js` to one copy, so a
// consumer module importing them (from any folder) shares classes with the editor.

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { findModule, trempelView } from '../view/plugin';

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

const dir = process.env.TML_VIEW_DIR;
if (!dir) throw new Error('TML_VIEW_DIR is not set — start the editor with `npm run edit -- <folder>`');
const module = findModule(dir, process.env.TML_VIEW_MODULE || undefined) ?? undefined;

export default defineConfig({
  root: here('./app'),
  cacheDir: here('../node_modules/.vite-edit'),
  logLevel: process.env.TML_VIEW_QUIET ? 'error' : 'info',
  clearScreen: false,
  resolve: {
    preserveSymlinks: true,
    alias: [
      { find: /^@trempel\/scene\/view$/, replacement: here('../view/api.ts') },
      { find: /^@trempel\/scene\/core$/, replacement: here('../src/core.ts') },
      { find: /^@trempel\/scene$/, replacement: here('../src/index.ts') },
    ],
    dedupe: ['pixi.js'],
  },
  optimizeDeps: {
    include: ['pixi.js', '@xmldom/xmldom', 'svg-path-properties'],
    entries: ['index.html', ...(module ? [module] : [])],
  },
  build: { target: 'es2022' },
  esbuild: { target: 'es2022' },
  server: { fs: { strict: false } },
  plugins: [trempelView({ dir, module, writable: true })],
});
