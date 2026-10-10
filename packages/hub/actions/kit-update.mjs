// kit-update.mjs — raise the project's kit, run the new kit's gates, print the result.
// The gates are the actions of the `gates` group as the NEW kit declares them (ctx.actions() reads
// the layers again after the install).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (f) => JSON.parse(readFileSync(f, 'utf8'));

export default async (ctx) => {
  const root = ctx.project.root;
  const pj = read(join(root, 'package.json'));
  const spec = String(ctx.input.version || 'latest');
  const target = /^(?:file:|https?:|git\+|[./~])/.test(spec) ? spec : `@trempel/kit@${spec}`;
  const before = ctx.project.kit;
  const field = pj.dependencies?.['@trempel/kit'] ? '--save' : '--save-dev';
  ctx.log(`kit ${before ?? '—'} → ${spec}`);
  await ctx.exec(['npm', 'install', '--no-fund', '--no-audit', field, target]);
  const kitPj = read(join(root, 'node_modules', '@trempel', 'kit', 'package.json'));
  const sceneRange = kitPj.peerDependencies?.['@trempel/scene'];
  const hasScene = pj.dependencies?.['@trempel/scene'] || pj.devDependencies?.['@trempel/scene'];
  if (sceneRange && hasScene && !/^(?:file:|[./])/.test(spec)) {
    await ctx.exec(['npm', 'install', '--no-fund', '--no-audit', pj.dependencies?.['@trempel/scene'] ? '--save' : '--save-dev', `@trempel/scene@${sceneRange}`]);
  }
  ctx.log(`kit ${kitPj.version} installed${sceneRange ? ` (scene ${sceneRange})` : ''}`);
  const gates = (await ctx.actions()).filter((a) => a.group === 'gates' && a.kind === 'once');
  if (!gates.length) ctx.log('the kit declares no gates');
  const results = [];
  for (const g of gates) {
    const r = await ctx.run(g.id);
    results.push({ id: g.id, ok: r.status === 'exited', status: r.status, code: r.code });
  }
  ctx.log('');
  ctx.log(`kit ${before ?? '—'} → ${kitPj.version}`);
  for (const r of results) ctx.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.id}${r.ok ? '' : ` (${r.status}${r.code !== null ? `, exit ${r.code}` : ''})`}`);
  const failed = results.filter((r) => !r.ok).length;
  ctx.log(failed ? `${failed} gate(s) failed — roll back: git checkout package.json package-lock.json && npm install` : 'all gates passed — keep it with git:commit');
  return failed ? 1 : 0;
};
