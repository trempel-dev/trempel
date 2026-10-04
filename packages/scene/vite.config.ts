/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// A checkout reached through symlinks: preserveSymlinks keeps Vite resolving modules against
// the paths as linked.
export default defineConfig({
  resolve: {
    preserveSymlinks: true,
  },
  test: {
    environment: 'node',
    // which files: the `unit` and `e2e` projects of vitest.workspace.ts
    // editor/ imports the core as its package entry (as it runs from dist); tests read the source.
    alias: { '@trempel/scene/core': fileURLToPath(new URL('./src/core.ts', import.meta.url)) },
  },
});
