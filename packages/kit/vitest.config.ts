import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // `npm run coverage`: coverage of src (v8).
    coverage: { provider: 'v8', include: ['src/**'], reporter: ['text-summary', 'text'] },
  },
});
