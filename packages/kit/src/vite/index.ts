// index.ts — the kit's Vite plugin: `plugins: [trempelKit()]` in vite.config.ts.
//
// Build target = vite mode: `vite build --mode youtube` → YouTube Playables, anything else → web.
//   - defines __TREMPEL_TARGET__ so the platform adapter is picked at build time (the other
//     adapter and the QA probe are tree-shaken out);
//   - youtube: injects the ytgame SDK <script> before the game code, strips Pixi's banner URL,
//     neutralises dead `new Function(` code generators left in Pixi after 'pixi.js/unsafe-eval'
//     (no-eval), and zvuk's Page Visibility listener (disabled by the kit at
//     runtime, but the API name must not ship), then runs the Playables gates after the build
//     (size, sterility, no-eval) — a failed gate fails the build;
//   - outDir: dist-web / dist-yt; Pixi in its own chunk (top-level await in main.ts is safe).

import { resolve } from 'node:path';
import type { Plugin, UserConfig } from 'vite';
import { runGates, SDK_URL } from './gates.js';

export interface TrempelKitPluginOptions {
  /** Globs (relative to the youtube dist) loaded after gameReady — excluded from the initial bundle. */
  lazy?: string[];
  /** Directory globs ending with a slash, e.g. levels/STAR/, of which ONE directory loads before gameReady: the largest is counted. */
  oneOf?: string[];
  /** The game's own markers that must not ship in the youtube bundle. */
  forbid?: (string | RegExp)[];
  /** URLs of bundled libraries that are text, never requested (license comments, warnings) — allowed, listed in the report. */
  libraryUrls?: string[];
  /** Skip the gates (never for a release). */
  gates?: boolean;
}

export function trempelKit(opts: TrempelKitPluginOptions = {}): Plugin[] {
  let youtube = false;
  let outDir = 'dist-web';
  let root = process.cwd();

  const config: Plugin = {
    name: 'trempel-kit:config',
    config(_user, env): UserConfig {
      youtube = env.mode === 'youtube';
      return {
        base: './',
        define: { __TREMPEL_TARGET__: JSON.stringify(youtube ? 'youtube' : 'web') },
        build: {
          outDir: youtube ? 'dist-yt' : 'dist-web',
          emptyOutDir: true,
          target: 'es2022',
          assetsInlineLimit: 0,
          chunkSizeWarningLimit: 2048,
          sourcemap: false,
          // Pixi in its own chunk: Pixi's lazy renderer chunks would otherwise import the entry
          // chunk back, which deadlocks when the entry uses top-level await
          // (`const game = await createGame(...)` in main.ts).
          rollupOptions: { output: { manualChunks: (id: string) => (/[\\/]node_modules[\\/]pixi\.js[\\/]/.test(id) ? 'pixi' : undefined) } },
        },
        optimizeDeps: { esbuildOptions: { define: { __TREMPEL_TARGET__: JSON.stringify(youtube ? 'youtube' : 'web') } } },
      };
    },
    configResolved(c) {
      outDir = c.build.outDir;
      root = c.root;
    },
  };

  const sdk: Plugin = {
    name: 'trempel-kit:yt-sdk',
    transformIndexHtml: {
      order: 'pre',
      handler: (html) => {
        if (!youtube) return html;
        const tag = `<script src="${SDK_URL}"></script>`;
        return html.includes('<!--platform-sdk-->') ? html.replace('<!--platform-sdk-->', tag) : html.replace(/<head([^>]*)>/i, `<head$1>\n    ${tag}`);
      },
    },
  };

  const sterile: Plugin = {
    name: 'trempel-kit:yt-sterile',
    apply: 'build',
    transform(code, id) {
      if (!youtube) return null;
      let out = code;
      if (id.includes('pixi.js')) {
        if (id.endsWith('sayHello.mjs')) out = out.replaceAll(' - http://www.pixijs.com/', '').replaceAll(' http://www.pixijs.com/', '');
        if (out.includes('new Function(')) {
          const stub = '((..._) => { throw new Error("kit: code generation is disabled (CSP), pixi.js/unsafe-eval polyfills are used"); })(';
          out = out.replaceAll('new Function(', stub);
        }
      }
      if (id.includes('@schmooky/zvuk') && out.includes('visibilitychange')) out = out.replaceAll('"visibilitychange"', '"trempel-no-page-visibility"');
      return out === code ? null : { code: out, map: null };
    },
  };

  const gates: Plugin = {
    name: 'trempel-kit:yt-gates',
    apply: 'build',
    enforce: 'post',
    closeBundle: {
      sequential: true,
      handler() {
        if (!youtube || opts.gates === false) return;
        const dist = resolve(root, outDir);
        const r = runGates({ dist, lazy: opts.lazy, oneOf: opts.oneOf, forbid: opts.forbid, libraryUrls: opts.libraryUrls, report: resolve(root, 'build-report.md') });
        const sum = `initial ${(r.initial / 1048576).toFixed(2)} MiB${r.worstOneOf ? ` (with ${r.worstOneOf.dir})` : ''}, total ${(r.total / 1048576).toFixed(2)} MiB, ${r.files} files`;
        for (const w of r.warns) this.warn(w);
        if (!r.ok) {
          this.error(`kit yt-gates FAIL (${sum}):\n${r.fails.map((f) => `  ✗ ${f}`).join('\n')}\n→ ${r.report}`);
        }
        console.log(`✓ kit yt-gates PASS: ${sum} → build-report.md, ${outDir}.zip`);
      },
    },
  };

  return [config, sdk, sterile, gates];
}

export { runGates, scanSterility, globRe, oneOfGroup, SDK_URL, LIMITS } from './gates.js';
export type { GateOptions, GateResult, SterilityHit } from './gates.js';
