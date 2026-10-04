#!/usr/bin/env node
// flatten-cli.ts — `trempel-flatten <scene> --out <file.svg> [--embed] [--state s.json] [--font-family F]`
// (`npm run flatten -- …` in this repo): a Trempel scene → one vanilla SVG any browser and Figma draw.
// Prints what was written, the warnings (what vanilla SVG cannot carry) and the errors.
// Exit code: 0 — written, no errors; 1 — the scene has errors (written when it can be); 2 — usage.

import { resolve } from 'node:path';
import { flattenFile } from './flatten.js';

const cwd = process.env.INIT_CWD ?? process.cwd();
const argv = process.argv.slice(2);
const args: { _: string[]; [k: string]: string | string[] | boolean } = { _: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--embed') args.embed = true;
  else if (a.startsWith('--')) args[a.slice(2)] = argv[++i];
  else args._.push(a);
}
const scene = args._[0];
if (!scene || typeof args.out !== 'string') {
  console.error('usage: trempel-flatten <scene> --out <file.svg> [--embed] [--state s.json] [--font-family Arial]');
  process.exit(2);
}
const r = flattenFile({
  scene: resolve(cwd, scene),
  out: resolve(cwd, args.out),
  embed: args.embed === true,
  state: typeof args.state === 'string' ? resolve(cwd, args.state) : undefined,
  fontFamily: typeof args['font-family'] === 'string' ? args['font-family'] : undefined,
});
if (r.out) console.log(`${r.errors.length ? '✗' : '✓'} ${r.out}${r.collections.length ? ` (коллекции: ${r.collections.map((n) => `@${n}`).join(', ')})` : ''}`);
for (const w of r.warnings) console.log(`  ! ${w}`);
for (const e of r.errors) console.error(`  • ${e}`);
process.exit(r.errors.length ? 1 : r.out ? 0 : 1);
