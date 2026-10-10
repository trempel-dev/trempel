// run.test.ts — runs for real: a once action (log, code, history), a js action with inputs and
// ctx.run, a service on an auto port (answers, survives the starter, stops by its process tree and
// nothing else), the CLI around them. Needs `dist/` (npm test builds first).

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HubError, startAction } from '../src/engine.js';
import { activeServices, listRuns, readLog, readRun, stopRun, waitRun } from '../src/runs.js';
import { CLI, alive, cli, freshHome, makeProject, sleep, tmp, until } from './helpers.js';

// A service: an HTTP server on $PORT that also starts a child in its group and one that leaves the
// group (setsid) — both must go when the service is stopped.
const SERVER = `
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
const runaway = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });
writeFileSync('pids.json', JSON.stringify({ server: process.pid, kid: kid.pid, runaway: runaway.pid }));
createServer((q, s) => s.end('hello from ' + process.env.PORT)).listen(Number(process.env.PORT));
console.log('listening on', process.env.PORT);
`;

const PIPELINE = `
export default async (ctx) => {
  ctx.log('pipeline for', ctx.input.who, 'times', ctx.input.times);
  const r = await ctx.run('greet', { name: ctx.input.who });
  ctx.log('greet ended', r.status, r.code);
  const { stdout } = await ctx.exec('node -e "console.log(40 + 2)"');
  ctx.log('exec said', stdout.trim());
  const failed = await ctx.exec('node -e "process.exit(3)"', { check: false });
  ctx.log('failed with', failed.code);
  const shown = (await ctx.actions()).map((a) => a.id);
  ctx.log('has greet', shown.includes('greet'));
  return ctx.input.loud ? 0 : 7;
};
`;

const PROJECT_MDZ = `# fixture

## actions

### greet
$title: Greet
$input.name: { type: "text", default: "world" }
$shell: echo hello \${input.name}

### pipeline
$title: Pipeline
$group: content
$input.who: text
$input.times: { type: "select", options: [1, 2, 3], default: 2 }
$input.loud: bool
$js: tools/pipeline.mjs

### fail
$title: Fails
$group: gates
$shell: $[echo first, node -e "process.exit(4)", echo never]

### web
$title: Web
$kind: service
$port: auto
$shell: node server.mjs

### where
$title: Where
$shell: node -e "console.log('init-cwd=' + process.env.INIT_CWD)"

### danger
$title: Danger
$confirm: Deletes everything
$shell: echo boom
`;

let root: string;
beforeAll(() => {
  freshHome();
  root = makeProject(tmp(), { name: 'fixture', dependencies: { '@trempel/scene': '^2.3.0' } }, {
    '.trempel/project.mdz': PROJECT_MDZ,
    'tools/pipeline.mjs': PIPELINE,
    'server.mjs': SERVER,
  });
});

afterAll(async () => {
  for (const r of activeServices()) await stopRun(r.id);
});

describe('once actions', () => {
  it('a shell action: log, exit code, history', async () => {
    const r = await startAction(root, 'greet', { input: { name: "Ann O'Neil" } });
    const done = await waitRun(r.id, { timeoutMs: 20_000 });
    expect(done.status).toBe('exited');
    expect(done.code).toBe(0);
    expect(readLog(r.id)).toContain("hello Ann O'Neil");
    expect(listRuns({ projectId: done.projectId }).some((x) => x.id === r.id)).toBe(true);
  });

  it('2.4.1: INIT_CWD is the action\'s folder, not the one of an npm that started the hub', async () => {
    const was = process.env.INIT_CWD;
    process.env.INIT_CWD = '/somewhere/else';
    try {
      const r = await startAction(root, 'where');
      await waitRun(r.id, { timeoutMs: 20_000 });
      expect(readLog(r.id)).toContain(`init-cwd=${root}`);
    } finally {
      if (was === undefined) delete process.env.INIT_CWD;
      else process.env.INIT_CWD = was;
    }
  });

  it('a list of commands stops at the first failure', async () => {
    const r = await startAction(root, 'fail');
    const done = await waitRun(r.id, { timeoutMs: 20_000 });
    expect(done.status).toBe('failed');
    expect(done.code).toBe(4);
    const log = readLog(r.id);
    expect(log).toContain('first');
    expect(log).not.toContain('never');
  });

  it('a js action with inputs and ctx.run', async () => {
    const r = await startAction(root, 'pipeline', { input: { who: 'Bob', loud: 'false' } });
    const done = await waitRun(r.id, { timeoutMs: 30_000 });
    const log = readLog(r.id);
    expect(log).toContain('pipeline for Bob times 2');
    expect(log).toContain('[greet] hello Bob');
    expect(log).toContain('greet ended exited 0');
    expect(log).toContain('exec said 42');
    expect(log).toContain('failed with 3');
    expect(log).toContain('has greet true');
    expect(done.code).toBe(7);
    // the nested run is a run of its own, with its parent
    const child = listRuns({ projectId: done.projectId }).find((x) => x.parent === r.id);
    expect(child?.action).toBe('greet');
    expect(child?.input).toEqual({ name: 'Bob' });
  });

  it('inputs are checked', async () => {
    await expect(startAction(root, 'pipeline', { input: {} })).rejects.toThrow(/E_HUB_INPUT: .*"who"/);
    await expect(startAction(root, 'pipeline', { input: { who: 'x', times: 9 } })).rejects.toThrow(/one of 1, 2, 3/);
    await expect(startAction(root, 'greet', { input: { nmae: 'x' } })).rejects.toThrow(/no input "nmae"/);
    await expect(startAction(root, 'nope')).rejects.toBeInstanceOf(HubError);
  });
});

describe('services', () => {
  it('auto port, answers, stop kills its tree (and only it)', async () => {
    const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      const r = await startAction(root, 'web');
      expect(r.port).toBeGreaterThan(0);
      expect(r.url).toBe(`http://localhost:${r.port}/`);
      const ready = await waitRun(r.id, { ready: true, timeoutMs: 20_000 });
      expect(ready.status).toBe('ready');
      expect(await (await fetch(`http://127.0.0.1:${r.port}/`)).text()).toBe(`hello from ${r.port}`);
      await expect(startAction(root, 'web')).rejects.toThrow(/E_HUB_RUNNING/);
      const pids = await until(() => (existsSync(join(root, 'pids.json')) ? (JSON.parse(readFileSync(join(root, 'pids.json'), 'utf8')) as Record<string, number>) : null), 5000, 'pids');
      expect(alive(pids.kid) && alive(pids.runaway)).toBe(true);
      const stopped = await stopRun(r.id);
      expect(stopped?.status).toBe('stopped');
      for (const p of [r.pid!, pids.server, pids.kid, pids.runaway]) expect(alive(p), `pid ${p}`).toBe(false);
      expect(alive(bystander.pid!)).toBe(true);
      await expect(fetch(`http://127.0.0.1:${r.port}/`)).rejects.toThrow();
    } finally {
      bystander.kill();
    }
  });

  it('outlives the process that started it: another process sees it and stops it', async () => {
    const env = { TREMPEL_HOME: process.env.TREMPEL_HOME! };
    const up = await cli(['run', 'web', '--project', root, '--detach'], { env });
    expect(up.code).toBe(0);
    const url = up.stdout.trim();
    expect(url).toMatch(/^http:\/\/localhost:\d+\/$/);
    expect((await fetch(url.replace('localhost', '127.0.0.1'))).status).toBe(200);
    // the CLI is gone; the service is not
    const ps = await cli(['ps', '--json'], { env });
    const runs = JSON.parse(ps.stdout) as { id: string; action: string; url: string }[];
    const web = runs.find((x) => x.action === 'web')!;
    expect(web.url).toBe(url);
    const st = await cli(['stop', 'web', '--project', root], { env });
    expect(st.stdout).toContain(`${web.id}: stopped`);
    expect(readRun(web.id)?.status).toBe('stopped');
  });

  it('2.4.1: stop <action> outside a project: the one project running it, else the run ids', async () => {
    const env = { TREMPEL_HOME: process.env.TREMPEL_HOME! };
    const nowhere = tmp('hub-nowhere-');
    // a live copy of the same game: the same package name, another folder
    const twin = makeProject(tmp(), { name: 'fixture', dependencies: { '@trempel/scene': '^2.3.0' } }, { '.trempel/project.mdz': PROJECT_MDZ, 'server.mjs': SERVER });
    expect((await cli(['stop', 'web'], { cwd: nowhere, env })).stderr).toMatch(/E_HUB_NOT_RUNNING/);

    const one = await cli(['run', 'web', '--project', root, '--detach'], { env });
    expect(one.code).toBe(0);
    const id = activeServices().find((r) => r.action === 'web' && r.projectRoot === root)!.id;
    const st = await cli(['stop', 'web'], { cwd: nowhere, env });
    expect(st.code).toBe(0);
    expect(st.stdout).toContain(`${id}: stopped`);

    expect((await cli(['run', 'web', '--project', root, '--detach'], { env })).code).toBe(0);
    expect((await cli(['run', 'web', '--project', twin, '--detach'], { env })).code).toBe(0);
    const both = activeServices().filter((r) => r.action === 'web').map((r) => r.id);
    expect(both).toHaveLength(2);
    const amb = await cli(['stop', 'web'], { cwd: nowhere, env });
    expect(amb.code).toBe(2);
    expect(amb.stderr).toMatch(/^E_HUB_AMBIGUOUS: "web" runs in 2 projects/m);
    for (const x of both) expect(amb.stderr).toContain(x);
    expect(activeServices().filter((r) => r.action === 'web')).toHaveLength(2); // nothing stopped
    // inside a project: only its own
    const own = await cli(['stop', 'web'], { cwd: twin, env });
    expect(own.code).toBe(0);
    expect(activeServices().filter((r) => r.action === 'web').map((r) => r.projectRoot)).toEqual([root]);
    expect((await cli(['stop', 'web'], { cwd: nowhere, env })).code).toBe(0);
    expect(activeServices().filter((r) => r.action === 'web')).toHaveLength(0);
  });
});

describe('the CLI', () => {
  it('run --list shows the layers, what wins and what is off', async () => {
    const r = await cli(['run', '--list', '--project', root]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^hub {2}.*actions\.mdz/m);
    expect(r.stdout).toMatch(/^kit {2}.*legacy-kit\.mdz \(the kit has no hub\/actions\.mdz/m);
    expect(r.stdout).toMatch(/^project {2}.*project\.mdz/m);
    expect(r.stdout).toMatch(/ {2}pipeline +Pipeline +content/);
    expect(r.stdout).toMatch(/git:commit .*\[off: git\.dirty\]/);
    const json = JSON.parse((await cli(['run', '--list', '--project', root, '--json'])).stdout) as { actions: { id: string; layer: string; wins: boolean }[] };
    expect(json.actions.find((a) => a.id === 'web')).toMatchObject({ layer: 'project', wins: true });
  });

  it('run: the action\'s exit code and output; --input; confirm needs --yes off a terminal', async () => {
    const g = await cli(['run', 'greet', '--input', 'name=CLI'], { cwd: join(root, 'tools') });
    expect(g.code).toBe(0);
    expect(g.stdout).toContain('hello CLI');
    const f = await cli(['run', 'fail', '--project', root]);
    expect(f.code).toBe(4);
    const d = await cli(['run', 'danger', '--project', root]);
    expect(d.code).toBe(2);
    expect(d.stderr).toMatch(/^E_HUB_CONFIRM: .*--yes/);
    const y = await cli(['run', 'danger', '--project', root, '--yes']);
    expect(y.code).toBe(0);
    expect(y.stdout).toContain('boom');
    const missing = await cli(['run', 'pipeline', '--project', root]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toMatch(/^E_HUB_INPUT/);
  });

  it('run of a service in the foreground prints its URL; SIGINT stops the tree', async () => {
    const child = spawn(process.execPath, [CLI, 'run', 'web', '--project', root], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (b: Buffer) => (out += b));
    const url = await until(() => /\[hub\] ready: (\S+)/.exec(out)?.[1], 20_000, 'ready line');
    expect((await fetch(url.replace('localhost', '127.0.0.1'))).status).toBe(200);
    const code = new Promise<number | null>((r) => child.once('exit', (c) => r(c)));
    child.kill('SIGINT');
    expect(await code).toBe(130);
    await sleep(200);
    await expect(fetch(url.replace('localhost', '127.0.0.1'))).rejects.toThrow();
    expect(activeServices().filter((r) => r.action === 'web')).toEqual([]);
  });
});
