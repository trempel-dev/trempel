import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { defineConfig } from 'vite';
import { trempelKit } from '@trempel/kit/vite';
import { LIBRARY_URLS } from '@trempel/slot/gates';

// The kit's default skin folder (the `@skin` collection of .trempel/project.mdz): its art is bundled
// through `import.meta.glob('#kit-skin/art/**/*.png')` in main.ts.
const kitSkin = join(dirname(createRequire(import.meta.url).resolve('@trempel/kit/package.json')), 'skins/default/ui');

// `vite build --mode youtube` → YouTube Playables build + gates; anything else → web.
export default defineConfig({
  plugins: [trempelKit({ libraryUrls: LIBRARY_URLS })],
  resolve: { alias: { '#kit-skin': kitSkin } },
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
} as never);
