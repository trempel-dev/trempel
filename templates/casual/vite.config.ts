import { defineConfig } from 'vite';
import { trempelKit } from '@trempel/kit/vite';

// `vite build --mode youtube` → YouTube Playables build + gates; anything else → web.
export default defineConfig({
  plugins: [trempelKit()],
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
} as never);
