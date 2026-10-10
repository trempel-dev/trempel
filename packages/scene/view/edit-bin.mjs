#!/usr/bin/env node
// edit-bin.mjs — `trempel-edit` (2.3): an agent's line to the editor page a person has open
// (`npm run edit -- <folder>`): the same document, the same undo, ⌘S — not a file written past it.
//
//   trempel-edit eval [--port 5181] '<code>'     a tml script (edit/API.md) in the open page: one undo step
//   trempel-edit eval [--port 5181] --file x.js
//   trempel-edit save [--port 5181]              = ⌘S (the base, the heir, the clips)
//   trempel-edit state [--port 5181]             scene, unsaved, errors, selection, the clip shown
//   trempel-edit mcp [--port 5181]               an MCP server (stdio): editor.eval, editor.save, editor.state
//   trempel-edit serve <folder> [--port 5181] [--module m.ts] [--open]
//                                                the editor page itself (edit/cli.mjs; needs vite in the project)
//
// Output: the page's answer as JSON ({ ok, value, errors, dirty }); exit 1 when not ok. The bridge
// answers only on localhost (POST /__tml/agent of the editor's dev server).

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const USAGE = "usage: trempel-edit eval [--port N] '<code>' | eval --file x.js | save | state | mcp [--port N] | serve <folder> [--port N]";

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
    else out._.push(a);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const [cmd, ...rest] = args._;
const port = Number(args.port ?? process.env.TREMPEL_EDIT_PORT ?? 5181);

/** One request to the bridge. */
export async function call(op, code, p = port) {
  let r;
  try {
    r = await fetch(`http://localhost:${p}/__tml/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(op === 'eval' ? { op, code } : { op }),
    });
  } catch (e) {
    return { ok: false, errors: [`E_EDIT_NO_PAGE: no editor at localhost:${p} (npm run edit -- <folder> starts it; --port N): ${e instanceof Error ? e.message : String(e)}`] };
  }
  try {
    return await r.json();
  } catch {
    return { ok: false, errors: [`E_EDIT_NO_PAGE: localhost:${p} answered HTTP ${r.status} — is it the editor (npm run edit)?`] };
  }
}

// ---- MCP over stdio (newline-delimited JSON-RPC 2.0) ------------------------------------------------

const TOOLS = [
  {
    name: 'editor.eval',
    description:
      'Run a script in the open Trempel scene editor page: the body of an async function with `tml` (the editor API — edit/API.md: tml.doc.exec for the base, tml.clipsDoc(file).exec for clips, heir.* for effects) and `console`; a single expression is returned. One undo step, visible to the person at once.',
    inputSchema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'], additionalProperties: false },
  },
  { name: 'editor.save', description: 'Save the open scene (= ⌘S): the base, the heir, the clips.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  {
    name: 'editor.state',
    description: 'The open scene: its id, unsaved changes, errors, the selection, the clip shown on the timeline.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

function mcp() {
  const out = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  const rl = createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return out({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    }
    const { id, method, params } = msg;
    if (id === undefined) return; // a notification (initialized, cancelled…)
    if (method === 'initialize') {
      return out({
        jsonrpc: '2.0',
        id,
        result: { protocolVersion: params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'trempel-edit', version: '2.3.0' } },
      });
    }
    if (method === 'ping') return out({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/list') return out({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    if (method === 'tools/call') {
      const name = params?.name;
      const op = name === 'editor.eval' ? 'eval' : name === 'editor.save' ? 'save' : name === 'editor.state' ? 'state' : null;
      if (!op) return out({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${name}` } });
      const r = await call(op, params?.arguments?.code);
      return out({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }], isError: !r.ok } });
    }
    out({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  });
}

if (cmd === 'serve') {
  // The page: the same dev server as `npm run edit` in the repository, from the installed package.
  const require = createRequire(import.meta.url);
  try {
    require.resolve('vite');
  } catch {
    console.log(JSON.stringify({ ok: false, errors: ['E_CLI: serve needs vite — npm i -D vite (or npx -p @trempel/scene -p vite trempel-edit serve <folder>)'] }, null, 2));
    process.exit(2);
  }
  const argv = process.argv.slice(2);
  // a bin's folder is relative to where it runs: INIT_CWD is `npm run edit`'s, and leaks from an npm parent
  process.env.INIT_CWD = process.cwd();
  process.argv = [process.argv[0], fileURLToPath(new URL('../edit/cli.mjs', import.meta.url)), ...argv.slice(argv.indexOf('serve') + 1)];
  await import('../edit/cli.mjs');
} else if (cmd === 'mcp') mcp();
else if (cmd === 'eval' || cmd === 'save' || cmd === 'state') {
  let code;
  if (cmd === 'eval') {
    code = args.file ? readFileSync(args.file, 'utf8') : rest.join(' ');
    if (!code.trim()) {
      console.log(JSON.stringify({ ok: false, errors: [`E_CLI: eval needs code — ${USAGE}`] }, null, 2));
      process.exit(2);
    }
  }
  const r = await call(cmd, code);
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
} else {
  console.log(cmd && cmd !== '-h' && cmd !== '--help' ? JSON.stringify({ ok: false, errors: [`E_CLI: unknown command "${cmd}" — ${USAGE}`] }, null, 2) : USAGE);
  process.exit(cmd && cmd !== '-h' && cmd !== '--help' ? 2 : 0);
}
