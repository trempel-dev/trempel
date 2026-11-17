// report.ts — report.md of one skeleton (what was transferred, what not and why, the verification)
// and the summary of a folder (one row per skeleton: names and counts only).

import { fmt } from '../clip-import/tables.js';
import type { ClipStats } from './clips.js';
import { cloneCount, type Rig } from './rig.js';
import type { SkeletonData } from './spine.js';
import { TOL, type VerifyResult } from './verify.js';

export interface SkeletonOutcome {
  sk: SkeletonData;
  rig: Rig;
  stats: ClipStats[];
  verify: VerifyResult | null;
  missingRegions: string[];
  artWritten: number;
}

/** Why the skeleton is not region-only (empty — it is). */
export function nonRegionReasons(o: SkeletonOutcome): string[] {
  const r = [...o.rig.nonRegion];
  if (o.sk.ik.length) r.push(`IK ×${o.sk.ik.length}`);
  if (o.sk.transform.length) r.push(`transform constraint ×${o.sk.transform.length}`);
  if (o.sk.path.length) r.push(`path constraint ×${o.sk.path.length}`);
  if (o.sk.physics.length) r.push(`physics ×${o.sk.physics.length}`);
  if (o.sk.bones.some((b) => b.inherit !== 'normal')) r.push('inheritance other than normal');
  if (o.sk.bones.some((b) => b.shearX || b.shearY) || o.sk.animations.some((a) => a.bones.some((t) => t.prop === 'shearX' || t.prop === 'shearY'))) r.push('shear');
  const deform = o.sk.animations.some((a) => a.unsupported.some((u) => /^(deform|sequence)/.test(u)));
  if (deform && !r.includes('mesh')) r.push('deform/sequence');
  return [...new Set(r)];
}

/** What the 1.3 format now carries (counts), for the report and the summary. */
export function carried(o: SkeletonOutcome): { blend: number; tintSlots: number; tintTracks: number; drawOrderZ: number; drawOrderLost: number } {
  const slots = [...o.rig.slots.values()];
  const tintTracks = new Set(o.sk.animations.flatMap((a) => a.tinted.filter((s) => o.rig.slots.get(s)?.groupTint)));
  return {
    blend: slots.filter((s) => s.blend).length,
    tintSlots: slots.filter((s) => s.tint || s.images.some((i) => i.tint)).length,
    tintTracks: tintTracks.size,
    drawOrderZ: o.stats.reduce((n, s) => n + s.drawOrder.z, 0),
    drawOrderLost: o.stats.reduce((n, s) => n + s.drawOrder.lost, 0),
  };
}

/** Lost in every case (not a reason to call a skeleton unsupported, but listed). */
function losses(o: SkeletonOutcome): string[] {
  const out: string[] = [];
  const unknownBlend = o.sk.slots.filter((s) => s.blend !== 'normal' && !o.rig.slots.get(s.name)?.blend);
  if (unknownBlend.length) out.push(`unknown blend modes at ${unknownBlend.length} slots — drawn normal`);
  const dark = new Set([...o.sk.slots.filter((s) => s.dark).map((s) => s.name), ...o.sk.animations.flatMap((a) => a.dark)]);
  if (dark.size) out.push(`dark colour (two-colour tint) of ${dark.size} slots — the light colour is transferred`);
  const lostTint = new Set(o.sk.animations.flatMap((a) => a.tinted.filter((s) => !o.rig.slots.get(s)?.groupTint)));
  if (lostTint.size) out.push(`animated colour of ${lostTint.size} slots with coloured attachments`);
  const c = carried(o);
  if (c.drawOrderLost) out.push(`${c.drawOrderLost} draw order keys reorder across bone groups — setup order kept there`);
  if (o.sk.animations.some((a) => a.events.some((e) => e.payload))) out.push('event data (int/float/string/audio) — $events has only the name');
  return out;
}

export function convergedCount(o: SkeletonOutcome): number {
  return o.verify ? o.verify.anims.filter((a) => a.ok).length : 0;
}

export function skeletonReport(o: SkeletonOutcome): string {
  const { sk, rig, stats, verify } = o;
  const L: string[] = [];
  const reasons = nonRegionReasons(o);
  const c = carried(o);
  L.push(`# ${sk.name} — trempel-spine-import report`, '');
  L.push(`Spine ${sk.version || '?'} · bones ${sk.bones.length} · slots ${sk.slots.length} · animations ${sk.animations.length} · regions ${rig.regions.size} (cut ${o.artWritten}).`, '');
  L.push(reasons.length ? `**Not region-only:** ${reasons.join(', ')}.` : '**Region-only** — transferred whole (except the general losses below).', '');

  L.push('## Transferred', '');
  L.push(`- The bone hierarchy → nested \`<g>\` with the setup pose (translate/rotate/scale, y flipped); the root — \`<g id="${rig.rootId}">\`.`);
  const clones = cloneCount(rig);
  L.push(`- Slots → \`<g id="<slot>-slot">\` in the setup draw order${clones ? `; the draw order disagrees with the hierarchy — ${clones} bone group clone(s) (\`bone--N\`), their tracks duplicated` : ''}.`);
  const multi = [...rig.slots.values()].filter((s) => s.mode === 'multi').length;
  L.push(`- Attachments → \`<image>\`: frames of one geometry — \`tex\`, of different geometry — an image per attachment and \`alpha\` 0/1 (${multi} slots).`);
  const bz = stats.reduce((n, s) => n + s.bezier, 0);
  const bk = stats.reduce((n, s) => n + s.baked, 0);
  const sp = stats.reduce((n, s) => n + s.stepped, 0);
  L.push(`- Curves: bezier → ease \`[x1, y1, x2, y2]\` (${bz}), stepped → \`step\` (${sp}), baked into linear keys (${bk} segments).`);
  L.push(`- Slot colour → \`data-tint\` (${c.tintSlots} slots) and the \`tint\` column (${c.tintTracks} slots); blend modes → \`mix-blend-mode\` (${c.blend} slots); draw order timelines → \`z\` of siblings (${c.drawOrderZ} keys).`);
  L.push('- Slot alpha → `alpha`; events → `$events`.', '');

  const general = losses(o);
  if (general.length || rig.warnings.length) {
    L.push('## Not transferred / warnings', '');
    for (const g of general) L.push(`- ${g}.`);
    const shown = [...new Set(rig.warnings)];
    for (const w of shown.slice(0, 60)) L.push(`- ${w}`);
    if (shown.length > 60) L.push(`- … ${shown.length - 60} more.`);
    if (sk.path.length) L.push(`- path constraints (${sk.path.map((p) => p.name).join(', ')}): bones follow a path — a candidate for a motion track (\`$path\` + \`motion\`), not transferred.`);
    if (sk.ik.length) L.push(`- IK (${sk.ik.map((p) => p.name).join(', ')}) — not transferred, bones posed without IK.`);
    if (sk.transform.length) L.push(`- transform constraints (${sk.transform.map((p) => p.name).join(', ')}) — not transferred.`);
    if (o.missingRegions.length) L.push(`- regions missing from the atlas: ${o.missingRegions.join(', ')}.`);
    L.push('');
  }

  L.push('## Animations', '');
  L.push('| animation | clip | length, s | tables | check | max Δpos, px | max Δangle, ° | max Δscale, % | max Δalpha | max Δcolour | not transferred |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const s of stats) {
    const v = verify?.anims.find((a) => a.anim === s.name);
    const cell = v ? (v.ok ? 'converged' : `**${v.bad} off**`) : verify?.compileErrors ? 'not compiled' : '—';
    const lost = [...new Set(s.warnings.map((w) => w.replace(/: .*$/, '').replace(/^not transferred — /, '')))].join('; ');
    L.push(`| ${s.name} | ${s.clip} | ${fmt(s.duration, 3)} | ${s.tracks} | ${cell} | ${v ? fmt(v.max.pos, 3) : ''} | ${v ? fmt(v.max.rot, 3) : ''} | ${v ? fmt(v.max.scale * 100, 3) : ''} | ${v ? fmt(v.max.alpha, 3) : ''} | ${v ? fmt(v.max.color, 3) : ''} | ${lost} |`);
  }
  L.push('');

  if (verify) {
    L.push('## Verification', '');
    L.push(`Our own Spine sampler (from the format documentation) against Trempel: scene.svg → mountScene on the headless backend, clips → compileClips → Animator; ${verify.anims[0]?.points ?? 60} points per animation. Tolerances: position ±${TOL.pos} px, rotation ±${TOL.rot}°, scale ±${TOL.scale * 100} %, alpha ±${TOL.alpha}, colour ±${TOL.color}; attachment and draw order — exact.`, '');
    if (verify.compileErrors) L.push('The clips did not compile:', '', ...verify.compileErrors.map((e) => `- ${e}`), '');
    if (verify.excluded.length) {
      L.push(`Excluded from the check (${verify.excluded.length} bones and their slots): ${verify.excluded.slice(0, 20).map((e) => `${e.bone} (${e.reason})`).join(', ')}${verify.excluded.length > 20 ? ', …' : ''}.`, '');
    }
    for (const a of verify.anims.filter((x) => !x.ok)) {
      L.push(`### ${a.anim} — ${a.bad} off (attachments: ${a.attachmentBad}, draw order: ${a.orderBad})`, '');
      for (const e of a.examples) L.push(`- ${e}`);
      L.push('');
    }
    for (const s of stats.filter((x) => x.warnings.length)) {
      L.push(`### ${s.name} — warnings`, '');
      for (const w of [...new Set(s.warnings)].slice(0, 30)) L.push(`- ${w}`);
      L.push('');
    }
  }
  return L.join('\n');
}

/** Folder summary: one row per skeleton + totals. Only names and counts — no content. */
export function summaryReport(outcomes: SkeletonOutcome[], failed: { name: string; error: string }[]): string {
  const L: string[] = [];
  const regionOnly = outcomes.filter((o) => !nonRegionReasons(o).length);
  const anims = outcomes.reduce((n, o) => n + o.stats.length, 0);
  const conv = outcomes.reduce((n, o) => n + convergedCount(o), 0);
  const roAnims = regionOnly.reduce((n, o) => n + o.stats.length, 0);
  const roConv = regionOnly.reduce((n, o) => n + convergedCount(o), 0);
  const roFull = regionOnly.filter((o) => convergedCount(o) === o.stats.length).length;
  const sum = (f: (c: ReturnType<typeof carried>) => number) => outcomes.reduce((n, o) => n + f(carried(o)), 0);
  L.push('# trempel-spine-import — summary', '');
  L.push(`Skeletons: ${outcomes.length + failed.length} (imported ${outcomes.length}, failed ${failed.length}). Animations: ${anims}, converged: ${conv}.`);
  L.push(`Region-only: ${regionOnly.length} skeletons, ${roAnims} animations — converged ${roConv}; skeletons converged whole: ${roFull}.`);
  L.push(`Bone group clones: ${outcomes.reduce((n, o) => n + cloneCount(o.rig), 0)}. Blend modes: ${sum((c) => c.blend)} slots; tint: ${sum((c) => c.tintSlots)} slots in the base, ${sum((c) => c.tintTracks)} animated; draw order keys as z: ${sum((c) => c.drawOrderZ)} (not representable: ${sum((c) => c.drawOrderLost)}).`, '');
  L.push('| skeleton | regions? | why not | animations | converged | clones | blend | tint | draw order z / lost | main losses |');
  L.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const o of outcomes) {
    const r = nonRegionReasons(o);
    const c = carried(o);
    L.push(`| ${o.sk.name} | ${r.length ? 'no' : 'yes'} | ${r.join(', ')} | ${o.stats.length} | ${convergedCount(o)} | ${cloneCount(o.rig)} | ${c.blend} | ${c.tintSlots}/${c.tintTracks} | ${c.drawOrderZ}/${c.drawOrderLost} | ${losses(o).map((x) => x.replace(/ \(.*?\)| — .*$/g, '')).join('; ')} |`);
  }
  for (const f of failed) L.push(`| ${f.name} | — | error: ${f.error} | | | | | | | |`);
  L.push('');
  return L.join('\n');
}
