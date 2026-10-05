#!/usr/bin/env node
// cli.mjs — the scene viewer: a Vite dev page over a folder of Trempel scenes.
//
//   npm run view -- <folder> [--module path/trempel.view.ts] [--port 5180] [--open]
//
// The folder is scanned for X.svg / X.tml.svg / X.contract.xml / X.state.json (recursively);
// `<folder>/trempel.view.ts`, if present, plugs in the consumer's components, backend and assets.

import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const cwd = process.env.INIT_CWD ?? process.cwd(); // npm run moves cwd to the package root

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--open') out.open = true;
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
    else out._.push(a);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const folder = args._[0];
if (!folder) {
  console.error('E_CLI: usage: npm run view -- <folder> [--module trempel.view.ts] [--port N] [--open]');
  process.exit(2);
}
const dir = resolve(cwd, folder);
if (!existsSync(dir) || !statSync(dir).isDirectory()) {
  console.error(`E_CLI: ${folder}: not a folder`);
  process.exit(2);
}

process.env.TML_VIEW_DIR = dir;
if (args.module) process.env.TML_VIEW_MODULE = resolve(cwd, args.module);

const server = await createServer({
  configFile: fileURLToPath(new URL('./vite.config.ts', import.meta.url)),
  server: { port: args.port ? Number(args.port) : 5180, open: !!args.open },
});
await server.listen();
server.printUrls();
console.log(`  scenes: ${dir}`);
