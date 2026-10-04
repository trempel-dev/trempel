// Browser bundle for CDN use (jsdelivr/unpkg) and claude.ai artifacts: one ESM file per entry,
// pixi.js stays external (the page maps it with an import map or imports it from the same CDN).
//   dist/browser/trempel.js        — runtime + PixiBackend     (import '@trempel/scene')
//   dist/browser/trempel-core.js   — renderer-agnostic core    (import '@trempel/scene/core')
//   dist/browser/trempel-editor.js — editor core               (import '@trempel/scene/editor')
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  resolve: { preserveSymlinks: true },
  build: {
    outDir: 'dist/browser',
    emptyOutDir: true,
    target: 'es2022',
    lib: {
      entry: {
        trempel: fileURLToPath(new URL('./src/index.ts', import.meta.url)),
        'trempel-core': fileURLToPath(new URL('./src/core.ts', import.meta.url)),
        'trempel-editor': fileURLToPath(new URL('./editor/index.ts', import.meta.url)),
      },
      formats: ['es'],
      fileName: (_f, name) => `${name}.js`,
    },
    rollupOptions: {
      external: ['pixi.js'],
      output: { chunkFileNames: 'chunks/[name]-[hash].js' },
    },
    sourcemap: true,
  },
});
