// Gate: the built package must run under a CSP without 'unsafe-eval' — no runtime code generation
// anywhere in dist. Builds with the real build config into a temp dir and scans every .js file.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
let out = '';

const jsFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? jsFiles(join(dir, e.name)) : e.name.endsWith('.js') ? [join(dir, e.name)] : [],
  );

beforeAll(() => {
  // Inside the repo so the built files resolve @xmldom/xmldom from its node_modules.
  out = mkdtempSync(join(root, '.dist-gate-'));
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  execFileSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.build.json'), '--outDir', out], { cwd: root });
  // @trempel/scene/editor: its own build next to the core; '@trempel/scene/core' is resolved against the fresh core build.
  const cfg = join(out, 'tsconfig.editor.json');
  writeFileSync(
    cfg,
    JSON.stringify({
      extends: join(root, 'editor', 'tsconfig.build.json'),
      compilerOptions: {
        outDir: join(out, 'editor'),
        rootDir: join(root, 'editor'),
        paths: { '@trempel/scene/core': [join(out, 'core.d.ts')], '@trempel/scene/internal/*': [join(out, '*')] },
      },
      include: [join(root, 'editor', '*.ts')],
      exclude: [join(root, 'editor', '*.test.ts')],
    }),
  );
  execFileSync(process.execPath, [tsc, '-p', cfg], { cwd: root });
}, 60_000);

afterAll(() => {
  if (out) rmSync(out, { recursive: true, force: true });
});

describe('dist gate — no eval', () => {
  it('builds the package', () => {
    const files = jsFiles(out).map((f) => f.slice(out.length + 1));
    expect(files).toContain('index.js');
    expect(files).toContain('core.js');
    expect(files).toContain('expr.js');
    expect(files).toContain(join('editor', 'index.js'));
  });

  it('@trempel/scene/editor imports only the core entry, internal core modules, xmldom and its own files — no pixi, no browser DOM', () => {
    const bad: string[] = [];
    for (const f of jsFiles(join(out, 'editor'))) {
      for (const m of readFileSync(f, 'utf8').matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)) {
        const ok = m[1].startsWith('./') || m[1] === '@trempel/scene/core' || m[1] === '@xmldom/xmldom' || (m[1].startsWith('@trempel/scene/internal/') && !m[1].includes('render/'));
        if (!ok) bad.push(`${f.slice(out.length + 1)} → ${m[1]}`);
      }
      if (/\bwindow\.|(?<![\w./])document\.(?!js\b)|\bnew DOMParser\b/.test(readFileSync(f, 'utf8').replace(/\/\/.*$/gm, ''))) bad.push(`${f}: browser DOM`);
    }
    expect(bad).toEqual([]);
  });

  it('contains no new Function / Function( / eval(', () => {
    const offenders: string[] = [];
    for (const f of jsFiles(out)) {
      const src = readFileSync(f, 'utf8');
      for (const re of [/new\s+Function\b/, /\bFunction\s*\(/, /\beval\s*\(/]) {
        if (re.test(src)) offenders.push(`${f.slice(out.length + 1)}: ${re}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every relative import in dist carries an explicit .js extension (runs under bare node)', () => {
    const bad: string[] = [];
    for (const f of jsFiles(out)) {
      for (const m of readFileSync(f, 'utf8').matchAll(/from\s+'(\.[^']*)'/g)) {
        if (!m[1].endsWith('.js')) bad.push(`${f.slice(out.length + 1)} → ${m[1]}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('the Pixi-free core entry imports under plain node and does not pull pixi.js', () => {
    const script = `import(${JSON.stringify(join(out, 'core.js'))}).then((m) => {
      const ok = typeof m.mount === 'function' && typeof m.checkScene === 'function' && typeof m.compile === 'undefined';
      const pixi = Object.keys(globalThis).some((k) => k === 'PIXI');
      console.log(JSON.stringify({ ok, pixi }));
    })`;
    const res = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root }).toString());
    expect(res).toEqual({ ok: true, pixi: false });
    const coreSources = jsFiles(out)
      .filter((f) => !f.includes(`${join(out, 'render')}`) && !f.endsWith('index.js'))
      .filter((f) => /from\s+'pixi\.js'/.test(readFileSync(f, 'utf8')));
    expect(coreSources).toEqual([]);
  });
});
