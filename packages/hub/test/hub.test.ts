// hub.test.ts — the HTTP API of the hub page, a new project from a template, `kit:update`.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activeServices, readLog, stopRun, waitRun } from '../src/runs.js';
import { startHub, type HubServer } from '../src/server.js';
import { createProject, listTemplates } from '../src/templates.js';
import { startAction } from '../src/engine.js';
import { fakeKit, freshHome, makeProject, tmp, until, write } from './helpers.js';

let hub: HubServer;
let roots: string;
let game: string;

const GIT_ENV = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };

beforeAll(async () => {
  freshHome();
  Object.assign(process.env, GIT_ENV);
  roots = tmp('hub-roots-');
  process.env.TREMPEL_HUB_ROOTS = roots;
  game = makeProject(join(roots, 'game'), { name: 'game', dependencies: { '@trempel/kit': '^2.4.0' } }, {
    '.trempel/project.mdz': '## actions\n\n### web\n$title: Web\n$pin: true\n$kind: service\n$shell: node -e "require(\'node:http\').createServer((q, s) => s.end(\'ok\')).listen(+process.env.PORT)"\n\n### check\n$title: Check\n$group: gates\n$shell: echo checked\n',
  });
  fakeKit(game, '2.4.0', '## actions\n\n### test\n$title: Tests\n$group: gates\n$shell: echo tests\n');
  hub = await startHub({ port: 0 });
});

afterAll(async () => {
  for (const r of activeServices()) await stopRun(r.id);
  await hub.close();
});

const api = (path: string, body?: unknown, headers: Record<string, string> = { 'X-Trempel-Hub': '1' }): Promise<Response> =>
  fetch(hub.url.replace(/\/$/, '') + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

describe('the API', () => {
  it('state: projects with versions, git, pins; the page itself', async () => {
    const st = (await (await api('/api/state')).json()) as { projects: { name: string; kit: string; pins: { id: string }[]; id: string }[]; roots: string[] };
    expect(st.roots).toEqual([roots]);
    const p = st.projects.find((x) => x.name === 'game')!;
    expect(p.kit).toBe('2.4.0');
    expect(p.pins.map((x) => x.id)).toContain('web');
    const page = await fetch(hub.url);
    expect(page.headers.get('content-type')).toMatch(/text\/html/);
    expect(await page.text()).toContain('<title>Trempel Hub</title>');
    expect((await fetch(hub.url + 'app.js')).status).toBe(200);
    expect((await fetch(hub.url + '../package.json')).status).toBe(404);
  });

  it('run → state → log → stop; gates on the card', async () => {
    const st = (await (await api('/api/state')).json()) as { projects: { name: string; id: string }[] };
    const id = st.projects.find((x) => x.name === 'game')!.id;
    const run = (await (await api(`/api/projects/${id}/run`, { action: 'web' })).json()) as { id: string; url: string };
    expect(run.url).toMatch(/^http:\/\/localhost:\d+\/$/);
    await until(async () => ((await (await api(`/api/runs/${run.id}`)).json()) as { status: string }).status === 'ready', 20_000, 'ready');
    expect(await (await fetch(run.url.replace('localhost', '127.0.0.1'))).text()).toBe('ok');
    const conflict = await api(`/api/projects/${id}/run`, { action: 'web' });
    expect(conflict.status).toBe(409);
    const log = (await (await api(`/api/runs/${run.id}/log?from=0`)).json()) as { text: string; size: number };
    expect(log.text).toContain('[hub] ready');
    const page = (await (await api(`/api/projects/${id}`)).json()) as { actions: { id: string; running: { id: string } | null; layer: string }[] };
    expect(page.actions.find((a) => a.id === 'web')!.running!.id).toBe(run.id);
    const stopped = (await (await api(`/api/runs/${run.id}/stop`, {})).json()) as { status: string };
    expect(stopped.status).toBe('stopped');

    const c = (await (await api(`/api/projects/${id}/run`, { action: 'check' })).json()) as { id: string };
    await waitRun(c.id, { timeoutMs: 20_000 });
    const st2 = (await (await api('/api/state')).json()) as { projects: { name: string; gates: { action: string; status: string }[] }[] };
    expect(st2.projects.find((x) => x.name === 'game')!.gates).toEqual([expect.objectContaining({ action: 'check', status: 'exited' })]);
  });

  it('refuses a POST without the hub header and a foreign Host', async () => {
    expect((await api('/api/roots', { roots: ['/'] }, {})).status).toBe(403);
    // fetch can't set Host; node:http can (a DNS-rebinding page would arrive with its own Host)
    const status = await new Promise<number>((res, rej) => {
      request({ host: '127.0.0.1', port: hub.port, path: '/api/state', headers: { Host: 'evil.example' } }, (r) => {
        r.resume();
        res(r.statusCode ?? 0);
      })
        .on('error', rej)
        .end();
    });
    expect(status).toBe(403);
  });

  it('an unknown action, a bad project — coded errors', async () => {
    const st = (await (await api('/api/state')).json()) as { projects: { name: string; id: string }[] };
    const id = st.projects.find((x) => x.name === 'game')!.id;
    const bad = await api(`/api/projects/${id}/run`, { action: 'nope' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/^E_HUB_NO_ACTION/);
    expect((await api('/api/projects/0000000000')).status).toBe(404);
  });
});

describe('a new project', () => {
  it('from the casual template: a copy with its name and the engine of this release, git init + a first commit', () => {
    const names = listTemplates().map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['casual', 'slot']));
    const dest = join(tmp(), 'my-game');
    createProject({ template: 'casual', dest });
    const pj = JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8')) as { name: string; dependencies: Record<string, string>; devDependencies: Record<string, string> };
    expect(pj.name).toBe('my-game');
    expect(pj.dependencies['@trempel/kit']).toBe('^2.4.1');
    expect(pj.devDependencies.vite).toBeDefined();
    expect(existsSync(join(dest, 'node_modules'))).toBe(false);
    expect(JSON.parse(readFileSync(join(dest, 'tsconfig.json'), 'utf8')).extends).toBeUndefined();
    const log = execFileSync('git', ['log', '--oneline'], { cwd: dest, encoding: 'utf8' });
    expect(log).toMatch(/New project from the casual template/);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: dest, encoding: 'utf8' })).toBe('');
    expect(() => createProject({ template: 'casual', dest })).toThrow(/E_HUB_NEW/);
    expect(() => createProject({ template: 'nope', dest: join(tmp(), 'x') })).toThrow(/E_HUB_TEMPLATE/);
  });
});

describe('kit:update', () => {
  it('raises the kit (an npm spec), runs the gates of the NEW kit, reports', async () => {
    const base = tmp('hub-kits-');
    const kit = (dir: string, version: string, actions: string): void => {
      write(join(base, dir, 'package.json'), JSON.stringify({ name: '@trempel/kit', version }));
      write(join(base, dir, 'hub', 'actions.mdz'), actions);
    };
    kit('kit-old', '2.2.0', '## actions\n\n### test\n$title: Old tests\n$group: gates\n$shell: echo old-gates\n');
    kit('kit-new', '2.4.0', '## actions\n\n### test\n$title: New tests\n$group: gates\n$shell: echo new-gates\n\n### lint\n$title: Lint\n$group: gates\n$shell: node -e "process.exit(1)"\n');
    const proj = makeProject(join(base, 'proj'), { name: 'proj', dependencies: { '@trempel/kit': 'file:../kit-old' } });
    execFileSync('npm', ['install', '--no-fund', '--no-audit', '--offline'], { cwd: proj, stdio: 'pipe' });
    const r = await startAction(proj, 'kit:update', { input: { version: 'file:../kit-new' } });
    const done = await waitRun(r.id, { timeoutMs: 90_000 });
    const log = readLog(r.id);
    expect(log).toContain('kit 2.2.0 → 2.4.0');
    expect(log).toContain('[test] new-gates');
    expect(log).not.toContain('old-gates');
    expect(log).toMatch(/ok {3}test/);
    expect(log).toMatch(/FAIL lint/);
    expect(log).toContain('roll back');
    expect(done.code).toBe(1);
    const pj = JSON.parse(readFileSync(join(proj, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    expect(pj.dependencies['@trempel/kit']).toBe('file:../kit-new');
  });
});
