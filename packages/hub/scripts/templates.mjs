// templates.mjs — the monorepo's templates into the hub package (`templates/<name>/`), standalone:
// the engine packages at the versions of this release, the dev tools the monorepo root gives them,
// the base tsconfig inlined, a .gitignore. Run by `npm run build`.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..');
const repo = join(pkg, '..', '..');
const out = join(pkg, 'templates');
const NAMES = ['casual', 'slot'];
const SKIP = /^(?:node_modules|dist|dist-.*|\.e2e-.*|test-results|playwright-report|build-report\.md|\.code)$/;
const read = (f) => JSON.parse(readFileSync(f, 'utf8'));

const root = read(join(repo, 'package.json'));
const versions = {};
for (const p of ['scene', 'kit', 'slot']) {
  const pj = read(join(repo, 'packages', p, 'package.json'));
  versions[pj.name] = pj.version;
}
const DEV_TOOLS = ['@playwright/test', '@types/node', 'playwright', 'sharp', 'typescript', 'vite', 'vitest'];
const base = read(join(repo, 'tsconfig.base.json'));

rmSync(out, { recursive: true, force: true });
for (const name of NAMES) {
  const src = join(repo, 'templates', name);
  if (!existsSync(src)) continue;
  const dest = join(out, name);
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, {
    recursive: true,
    filter: (p) => !relative(src, p).split(sep).some((part) => SKIP.test(part)),
  });
  const pjFile = join(dest, 'package.json');
  const pj = read(pjFile);
  for (const field of ['dependencies', 'devDependencies']) {
    for (const dep of Object.keys(pj[field] ?? {})) if (versions[dep]) pj[field][dep] = `^${versions[dep]}`;
  }
  pj.devDependencies = { ...Object.fromEntries(DEV_TOOLS.filter((t) => root.devDependencies[t]).map((t) => [t, root.devDependencies[t]])), ...pj.devDependencies };
  if (root.overrides) pj.overrides = { ...root.overrides, ...pj.overrides };
  writeFileSync(pjFile, JSON.stringify(pj, null, 2) + '\n');
  const tsFile = join(dest, 'tsconfig.json');
  if (existsSync(tsFile)) {
    const ts = read(tsFile);
    if (ts.extends === '../../tsconfig.base.json') {
      delete ts.extends;
      ts.compilerOptions = { ...base.compilerOptions, ...ts.compilerOptions };
      writeFileSync(tsFile, JSON.stringify({ compilerOptions: ts.compilerOptions, include: ts.include }, null, 2) + '\n');
    }
  }
  const ignore = join(dest, '.gitignore');
  const have = existsSync(ignore) ? readFileSync(ignore, 'utf8') : '';
  const want = ['node_modules/', 'dist/', 'dist-*/', 'test-results/', 'playwright-report/', 'build-report.md', '.e2e-*/'];
  const lines = have.split('\n').filter(Boolean);
  for (const w of want) if (!lines.includes(w)) lines.push(w);
  writeFileSync(ignore, lines.join('\n') + '\n');
}
console.log(`templates: ${NAMES.join(', ')} → ${relative(repo, out)}`);
