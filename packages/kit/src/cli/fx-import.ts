#!/usr/bin/env node
// fx-import.ts — the trempel-fx-import bin: Unity particle systems → the kit's effects.
//
//   trempel-fx-import <unity project | folder | X.prefab | X.unity>… --out <dir>
//                     [--ppu 100] [--only <effect path prefix>]… [--no-textures] [--compare <configs.json>]
//
// Reads the YAML of the prefabs / scenes (Force Text serialization), nested prefabs and their
// overrides included; textures by GUID through the .meta files. Writes <out>/effects.json
// (createGame({ fx: { effects } })), <out>/textures/*.png (no metadata), <out>/report.md|json (every
// system auto / manual / hard and why); --compare — <out>/compare.md against a game's current
// configs (a list with `key`, or effects { name: [...] }).
// Exit: 0 — written; 2 — usage / input error.

import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareConfigs, compareMd } from '../fx-import/compare.js';
import { counts, importUnity, writeImport } from '../fx-import/import.js';

function parse(argv: string[]): { inputs: string[]; out?: string; ppu?: number; only: string[]; textures: boolean; compare?: string; help: boolean } {
  const o = { inputs: [] as string[], only: [] as string[], textures: true, help: false } as ReturnType<typeof parse>;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') o.out = argv[++i];
    else if (a === '--ppu') o.ppu = Number(argv[++i]);
    else if (a === '--only') o.only.push(argv[++i]);
    else if (a === '--no-textures') o.textures = false;
    else if (a === '--compare') o.compare = argv[++i];
    else if (a === '-h' || a === '--help') o.help = true;
    else if (a.startsWith('--')) throw new Error(`E_FX_IMPORT_USAGE: unknown option ${a}`);
    else o.inputs.push(a);
  }
  return o;
}

const USAGE = 'usage: trempel-fx-import <unity project | folder | X.prefab | X.unity>… --out <dir> [--ppu 100] [--only <prefix>]… [--no-textures] [--compare <configs.json>]';

export function main(argv = process.argv.slice(2)): number {
  let a: ReturnType<typeof parse>;
  try {
    a = parse(argv);
  } catch (e) {
    console.error((e as Error).message);
    console.error(USAGE);
    return 2;
  }
  if (a.help) {
    console.log(USAGE);
    return 0;
  }
  if (!a.inputs.length || !a.out) {
    console.error(`E_FX_IMPORT_USAGE: ${!a.out ? '--out is required' : 'no input'}`);
    console.error(USAGE);
    return 2;
  }
  if (a.ppu !== undefined && !(a.ppu > 0)) {
    console.error('E_FX_IMPORT_USAGE: --ppu expects a positive number');
    return 2;
  }
  const cwd = process.env.INIT_CWD ?? process.cwd();
  try {
    const r = importUnity({ inputs: a.inputs.map((i) => resolve(cwd, i)), ppu: a.ppu, only: a.only });
    const out = resolve(cwd, a.out);
    const w = writeImport(r, out, { textures: a.textures });
    const c = counts(r.systems);
    console.log(`trempel-fx-import: ${Object.keys(r.effects).length} effects, ${c.total} systems (auto ${c.auto}, manual ${c.manual}, hard ${c.hard}), ${w.textures.length} textures → ${out}`);
    for (const [n, e] of Object.entries(w.skipped)) console.warn(`W_FX_IMPORT_TEXTURE: ${n}: ${e}`);
    if (r.warnings.length) console.warn(`W_FX_IMPORT: ${r.warnings.length} warning(s) — ${join(out, 'report.md')}`);
    if (a.compare) {
      const file = resolve(cwd, a.compare);
      const rows = compareConfigs(JSON.parse(readFileSync(file, 'utf8')), r.effects);
      writeFileSync(join(out, 'compare.md'), compareMd(rows, basename(file)));
      const same = rows.filter((x) => x.status === 'same').length;
      console.log(`compare: ${rows.length} systems of ${basename(file)} — ${same} same, ${rows.filter((x) => x.status === 'different').length} different, ${rows.filter((x) => x.status === 'missing').length} missing → ${join(out, 'compare.md')}`);
    }
    return 0;
  } catch (e) {
    const m = (e as Error).message;
    console.error(/^[EW]_[A-Z0-9_]+: /.test(m) ? m : `E_FX_IMPORT: ${m}`);
    return 2;
  }
}

// Run as the bin (through npm's .bin link too), not when imported by tests.
const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) process.exitCode = main();
