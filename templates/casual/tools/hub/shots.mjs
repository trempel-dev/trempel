// shots.mjs — the hub action `shots` (.trempel/actions.mdz): a PNG of each screen into shots/ by
// running the kit's `view:shot` for every scene (ctx.run — the same action a person runs by hand).
import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export default async (ctx) => {
  const dir = join(ctx.project.root, 'scenes');
  const all = readdirSync(dir)
    .filter((f) => f.endsWith('.tml.svg'))
    .map((f) => f.slice(0, -'.tml.svg'.length));
  const pick = ctx.input.scenes === 'all' ? all : all.filter((s) => s === ctx.input.scenes);
  mkdirSync(join(ctx.project.root, 'shots'), { recursive: true });
  let failed = 0;
  for (const s of pick) {
    const r = await ctx.run('view:shot', { scene: `scenes/${s}.tml.svg`, out: `shots/${s}.png`, settle: ctx.input.settle });
    if (r.status !== 'exited') failed++;
    ctx.log(`${s}: ${r.status === 'exited' ? `shots/${s}.png` : `${r.status} (exit ${r.code})`}`);
  }
  return failed ? 1 : 0;
};
