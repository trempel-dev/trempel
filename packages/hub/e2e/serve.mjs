// serve.mjs — the hub for its e2e: a fresh home (os.tmpdir()/trempel-hub-e2e-<port>), the roots it
// scans — one fixture project on an old kit (2.2.0, its own hub actions); the monorepo's casual
// template added by hand. Stops every service it started on exit.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.argv[2] ?? 4390);
const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const home = join(tmpdir(), `trempel-hub-e2e-${port}`);
rmSync(home, { recursive: true, force: true });
const roots = join(home, 'projects');
const old = join(roots, 'old-game');
const w = (f, t) => {
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, t);
};
w(join(old, 'package.json'), JSON.stringify({ name: 'old-game', version: '1.0.0', dependencies: { '@trempel/kit': '2.2.0' } }, null, 2));
w(join(old, 'node_modules', '@trempel', 'kit', 'package.json'), JSON.stringify({ name: '@trempel/kit', version: '2.2.0' }));
w(
  join(old, 'node_modules', '@trempel', 'kit', 'hub', 'actions.mdz'),
  '## actions\n\n### editor\n$title: Scene editor\n$group: run\n$pin: true\n$shell: echo the editor of kit 2.2.0\n\nThe editor of kit 2.2.0.\n',
);
w(join(home, 'hub', 'config.json'), JSON.stringify({ roots: [roots], projects: [join(repo, 'templates', 'casual')] }, null, 2));
process.env.TREMPEL_HOME = home;
delete process.env.TREMPEL_HUB_ROOTS;

const { startHub } = await import('../dist/server.js');
const { activeServices, stopRun } = await import('../dist/runs.js');
const hub = await startHub({ port });
console.log(`hub e2e: ${hub.url} (home ${home})`);
const bye = async () => {
  for (const r of activeServices()) await stopRun(r.id);
  process.exit(0);
};
process.on('SIGTERM', bye);
process.on('SIGINT', bye);
