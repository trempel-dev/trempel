// lib.config.ts — `npm run build:edit`: the editor page as a library (edit/lib.ts → dist/edit/):
// index.js (ESM; pixi.js and the package's dependencies stay external), index.html (the page
// markup, without its dev entry script), style.css. Types — tsc (edit/tsconfig.lib.json).

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const OUT = here('../dist/edit');

const page: Plugin = {
  name: 'trempel-edit-page',
  closeBundle() {
    mkdirSync(OUT, { recursive: true });
    const html = readFileSync(here('./app/index.html'), 'utf8').replace(/\s*<script type="module" src="\.\/main\.ts"><\/script>/, '');
    writeFileSync(`${OUT}/index.html`, html);
    copyFileSync(here('./app/style.css'), `${OUT}/style.css`);
  },
};

export default defineConfig({
  logLevel: 'warn',
  publicDir: false,
  resolve: {
    preserveSymlinks: true,
    alias: [
      { find: /^@trempel\/scene\/view$/, replacement: here('../view/api.ts') },
      { find: /^@trempel\/scene\/core$/, replacement: here('../src/core.ts') },
      { find: /^@trempel\/scene$/, replacement: here('../src/index.ts') },
    ],
  },
  build: {
    outDir: OUT,
    emptyOutDir: false,
    target: 'es2022',
    sourcemap: false,
    lib: { entry: here('./lib.ts'), formats: ['es'], fileName: () => 'index.js' },
    rollupOptions: { external: [/^pixi\.js(\/.*)?$/, '@xmldom/xmldom', 'svg-path-properties'] },
  },
  plugins: [page],
});
