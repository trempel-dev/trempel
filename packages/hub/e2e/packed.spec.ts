// packed.spec.ts — a project that installs Trempel from npm, not from the monorepo: `npm pack` of
// @trempel/scene and @trempel/kit → a temporary project → the kit's `editor` action is on (its
// `when: file:${pkg:@trempel/scene}/edit/cli.mjs` holds), `trempel-edit serve` answers HTTP 200 on
// the root and the page lists the project's scene. The tarball carries no tests, e2e, snapshots or
// node_modules.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type APIRequestContext } from '@playwright/test';

// A child `npm` under `npm run`/`npm test` reads the parent's `allow-scripts` as a command-line flag
// and refuses (EALLOWSCRIPTS) on a machine that sets it in its user .npmrc — hand it a clean env.
const NPM_ENV: NodeJS.ProcessEnv = { ...process.env };
delete NPM_ENV.npm_config_allow_scripts;

const HUB = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(HUB, '..', '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function pack(pkg: string, dest: string): string {
  const out = execFileSync(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', dest], { cwd: join(REPO, 'packages', pkg), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: NPM_ENV });
  return join(dest, (JSON.parse(out) as { filename: string }[])[0].filename);
}

const installed = (m: string): string => (JSON.parse(readFileSync(join(REPO, 'node_modules', m, 'package.json'), 'utf8')) as { version: string }).version;

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        out.push(`${relative(dir, p)}/`);
        walk(p);
      } else out.push(relative(dir, p));
    }
  };
  walk(dir);
  return out;
}

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => res(port));
    });
  });
}

// A dev server listens on `localhost`: IPv4 on Linux, `::1` on macOS — try both loopbacks.
// The URL that answered 200, else null.
async function reach(request: APIRequestContext, url: string): Promise<string | null> {
  for (const host of ['127.0.0.1', '[::1]']) {
    const u = url.replace('localhost', host);
    try {
      if ((await request.get(u, { timeout: 3000 })).status() === 200) return u;
    } catch {
      // the other loopback
    }
  }
  return null;
}

let dir = '';
let server: ChildProcess | null = null;

test.afterAll(() => {
  if (server?.pid) {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      // gone
    }
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('scene + kit from npm pack: the editor action is on, trempel-edit serve answers 200', async ({ page, request }) => {
  test.setTimeout(240_000);
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'trempel-packed-')));
  const scene = pack('scene', dir);
  const kit = pack('kit', dir);

  const project = join(dir, 'game');
  mkdirSync(join(project, 'scenes'), { recursive: true });
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'packed-game', version: '1.0.0', private: true, type: 'module' }, null, 2));
  writeFileSync(join(project, 'scenes', 'menu.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect id="plate" width="50" height="50" fill="#36c"/></svg>\n');
  execFileSync(npm, ['install', '--prefer-offline', '--no-audit', '--no-fund', scene, kit, `pixi.js@${installed('pixi.js')}`, `vite@${installed('vite')}`], { cwd: project, stdio: 'ignore', timeout: 180_000, env: NPM_ENV });

  // the editor page and what it needs ship; tests, e2e, snapshots and node_modules do not
  const pkgDir = join(project, 'node_modules', '@trempel', 'scene');
  expect(statSync(join(pkgDir, 'edit', 'cli.mjs')).isFile()).toBe(true);
  expect(existsSync(join(pkgDir, 'edit', 'app', 'index.html'))).toBe(true);
  expect(existsSync(join(pkgDir, 'editor', 'index.ts'))).toBe(true);
  const shipped = filesUnder(pkgDir);
  expect(shipped.filter((f) => /\.test\.|(^|\/)e2e\/|(^|\/)node_modules\/|__snapshots__|\.snap$|(^|\/)test\/|(^|\/)golden\//.test(f))).toEqual([]);

  // the kit's `editor` action is on for this project
  process.env.TREMPEL_HOME = join(dir, 'hub-home');
  process.env.TREMPEL_HUB_ROOTS = '';
  const { projectActions } = (await import(join(HUB, 'dist', 'engine.js'))) as typeof import('../src/engine.js');
  const pa = await projectActions(project);
  expect(pa.project.kit).toBe(installed('@trempel/kit'));
  expect(pa.actions.get('editor')?.layer).toBe('kit');
  expect(pa.visible.has('editor')).toBe(true);

  // the bin starts the page
  const port = await freePort();
  server = spawn(join(project, 'node_modules', '.bin', process.platform === 'win32' ? 'trempel-edit.cmd' : 'trempel-edit'), ['serve', 'scenes', '--port', String(port)], { cwd: project, detached: true, stdio: 'ignore' });
  const url = `http://localhost:${port}/`;
  await expect.poll(() => reach(request, url), { timeout: 30_000, intervals: [250] }).not.toBeNull();
  await page.goto((await reach(request, url))!);
  await expect(page).toHaveTitle(/Trempel edit/);
  await expect(page.locator('body')).toContainText('menu', { timeout: 30_000 });
});
