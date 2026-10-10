#!/usr/bin/env node
// bin.mjs — `trempel-view` (also the package's default bin: `npx @trempel/scene view:shot …`): the
// scene viewer's tools without cloning the repository.
//
//   trempel-view view:shot <scene> [--out x.png] [--settle 2] [--clip <name> --t <sec>…] [--viewport …] [--state s.json]
//   trempel-view view <folder> [--port 5180] [--open]
//   trempel-view edit <folder> [--port 5181] [--module m.ts] [--open]   the editor page (= trempel-edit serve)
//
// The same scripts as `npm run view:shot` / `npm run view` in the repository (view/shot.mjs, view/cli.mjs).
// Vite and Playwright are optional peers (installed in the project, or with npx -p), else E_CLI with
// the command that installs them.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const COMMANDS = { 'view:shot': './shot.mjs', shot: './shot.mjs', view: './cli.mjs', edit: '../edit/cli.mjs' };
const [cmd, ...rest] = process.argv.slice(2);

function fail(message, code = 2) {
  console.log(JSON.stringify({ errors: [{ level: 'error', kind: 'cli', message: `E_CLI: ${message}` }] }, null, 2));
  process.exit(code);
}

if (!cmd || cmd === '-h' || cmd === '--help' || !COMMANDS[cmd]) {
  const usage = 'usage: trempel-view view:shot <scene> [--out x.png] [--settle 2] [--clip <name> --t <sec>] | trempel-view view <folder> | trempel-view edit <folder>';
  if (cmd && !COMMANDS[cmd] && cmd !== '-h' && cmd !== '--help') fail(`unknown command "${cmd}" — ${usage}`);
  console.log(usage);
  process.exit(cmd ? 0 : 2);
}

// The optional peers, as the scripts will import them: from the package (a project's node_modules above it).
const need = cmd === 'view' || cmd === 'edit' ? ['vite'] : ['vite', 'playwright'];
const require = createRequire(import.meta.url);
const missing = need.filter((m) => {
  try {
    require.resolve(m);
    return false;
  } catch {
    return true;
  }
});
if (missing.length) {
  fail(`${cmd} needs ${missing.join(' and ')} — npm i -D ${missing.join(' ')}${missing.includes('playwright') ? ' && npx playwright install chromium' : ''} (or npx -p @trempel/scene ${missing.map((m) => `-p ${m}`).join(' ')} trempel-view ${cmd} …)`);
}

// the editor's folder is relative to where the bin runs (edit/cli.mjs reads INIT_CWD of `npm run edit`)
if (cmd === 'edit') process.env.INIT_CWD = process.cwd();
process.argv = [process.argv[0], fileURLToPath(new URL(COMMANDS[cmd], import.meta.url)), ...rest];
await import(COMMANDS[cmd]);
