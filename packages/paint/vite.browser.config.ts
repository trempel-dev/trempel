import { defineConfig } from 'vite';

/** Browser bundle: one ESM file, no dependencies (`dist/browser/trempel-paint.js`). */
export default defineConfig({
  build: {
    outDir: 'dist/browser',
    emptyOutDir: true,
    lib: { entry: 'src/index.ts', formats: ['es'], fileName: () => 'trempel-paint.js' },
    minify: true,
    sourcemap: true,
  },
});
