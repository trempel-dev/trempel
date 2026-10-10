#!/usr/bin/env node
// editor-commands.mjs — regenerates the command list in editor/README.md from the registry, and
// edit/API.md — the `tml` scripting API (the console, macros, an agent's eval) in one file: the
// `Tml` interface from edit/app/tml.ts (between `// BEGIN tml-api` and `// END tml-api`) + the
// command table. API.md is what goes into an agent's context: keep it within two screens.
//
//   npm run editor:commands          (builds first; reads dist/editor — the package's @trempel/scene/editor)
//
// In the README only the block between the BEGIN/END markers is rewritten; API.md — whole.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { commands, clipCommands } = await import('../dist/editor/index.js');
const readme = fileURLToPath(new URL('../editor/README.md', import.meta.url));

const typeOf = (s) => {
  if (s.anyOf) return s.anyOf.map(typeOf).join(' \\| ');
  if (s.enum) return s.enum.map((e) => `'${e}'`).join(' \\| ');
  if (s.type === 'array') return s.minItems === 2 && s.maxItems === 2 ? '[x, y]' : `${typeOf(s.items ?? {})}[]`;
  if (s.type === 'object') return 'object';
  return s.type ?? 'any';
};

const args = (schema) => {
  const req = new Set(schema.required ?? []);
  const props = Object.entries(schema.properties ?? {});
  if (!props.length) return '—';
  return props.map(([k, s]) => `\`${k}${req.has(k) ? '' : '?'}\`: ${typeOf(s)}`).join(', ');
};

// Tags in descriptions (<defs>, <g>) as code, so markdown does not take them for HTML.
const cell = (t) => t.replace(/\|/g, '\\|').replace(/<[^>]+>/g, (m) => `\`${m}\``);
const tableOf = (reg) => ['| command | arguments | what it does |', '|---|---|---|', ...Object.entries(reg).map(([name, c]) => `| \`${name}\` | ${args(c.schema)} | ${cell(c.describe)} |`)].join('\n');
const rows = Object.keys(commands);
const block = tableOf(commands);
const clipBlock = tableOf(clipCommands);

const BEGIN = '<!-- BEGIN commands (scripts/editor-commands.mjs) -->';
const END = '<!-- END commands -->';
const text = readFileSync(readme, 'utf8');
const a = text.indexOf(BEGIN);
const b = text.indexOf(END);
if (a < 0 || b < a) {
  console.error(`E_CLI: editor/README.md: no markers ${BEGIN} … ${END}`);
  process.exit(2);
}
let out = `${text.slice(0, a + BEGIN.length)}\n${block}\n${text.slice(b)}`;
const CB = '<!-- BEGIN clip commands (scripts/editor-commands.mjs) -->';
const CE = '<!-- END clip commands -->';
const ca = out.indexOf(CB);
const cb = out.indexOf(CE);
if (ca < 0 || cb < ca) {
  console.error(`E_CLI: editor/README.md: no markers ${CB} … ${CE}`);
  process.exit(2);
}
out = `${out.slice(0, ca + CB.length)}\n${clipBlock}\n${out.slice(cb)}`;
writeFileSync(readme, out);
console.log(`editor/README.md: ${rows.length} commands, ${Object.keys(clipCommands).length} clip commands`);

// ---- edit/API.md ---------------------------------------------------------------------------------

const tmlSrc = readFileSync(fileURLToPath(new URL('../edit/app/tml.ts', import.meta.url)), 'utf8');
const ga = tmlSrc.indexOf('// BEGIN tml-api');
const gb = tmlSrc.indexOf('// END tml-api');
if (ga < 0 || gb < ga) {
  console.error('E_CLI: edit/app/tml.ts: no markers // BEGIN tml-api … // END tml-api');
  process.exit(2);
}
const types = tmlSrc
  .slice(tmlSrc.indexOf('\n', ga) + 1, gb)
  .replace(/^export /gm, '')
  .split('\n')
  .filter((l) => l.trim() !== '')
  .join('\n');
const api = `# tml — the scene editor API for scripts

<!-- Generated: npm run editor:commands (from edit/app/tml.ts and the command registry). Do not edit by hand. -->

\`window.tml\` is the Trempel scene editor as one object: the console (the Console tab, ⌘Enter), macros (\`<scene folder>/.trempel/macros/*.js\`, ⌘K), an agent (\`tml.run(code)\`). What gets edited is the scene **base** (\`X.svg\`, vanilla SVG), and only through core commands — \`tml.doc.exec(name, args)\`. A node is an \`id\` or a path of element indices from the root (\`"0/3/1"\`). Command coordinates are in the node's **parent** space; \`tml.bounds\` and \`tml.moveBy\` use **scene** units (the viewBox).

- A script is the body of an async function with \`tml\` and \`console\`; a single expression is returned as is. A whole \`tml.run\` is **one** undo entry; an exception rolls it all back. A command error is not an exception: \`{ ok: false, errors }\`.
- After commands the scene is redrawn asynchronously: \`bounds\` and \`scene\` are from the last render, fresh ones after \`await tml.idle()\`.
- A macro is the same script in a file, its first line \`// name: Title\`.

\`\`\`ts
${types}
\`\`\`

## Commands — \`tml.doc.exec(name, args)\`, as a batch — \`tml.doc.batch(label, [{ name, args }])\`

${block}

## Clips — \`tml.clipsDoc(file?).exec(name, args)\`

The scene's md clips (\`anim/*.md\`, \`X.anim.md\`) are edited by commands with a minimal diff of the md; each is one undo step in the scene's history (with the base), saved by ⌘S / \`tml.save()\`. \`file\` — default the clip on the Timeline (else the scene's first file). A command that adds compile errors is refused (\`ok: false\`). Keys are addressed \`{ target, column, t }\`; events \`{ t, event }\`. Read the clip as written: \`tml.clipsDoc().clip('win')\` → \`{ tracks: [{ target, columns, keys: { x: [{ t, value, ease, param? }] } }], events, duration, loop }\`.

${clipBlock}

## Effects — \`tml.inspect.fx\` (the kit's \`kitView()\`), \`heir.*\`

Effect nodes (\`tml:type="fx"\`) are configured in the heir: \`heir.setAttr\` (\`data-effect\` / \`data-scale\` / \`transform\` of a node the heir inserts, \`tml:effect\` of a \`<tml:ref>\`), a new one — \`heir.insertFx\`. The effects themselves (particle configs) — \`tml.inspect.fx\`: \`list()\` (\`{ name, origin: file | systems | preset | code }\`), \`origin(name)\`, \`get(name)\`, \`update(name, fn)\` (the preview plays it), \`save(name)\` (\`fx/<name>.json\` whole, a converter's \`systems.json\` — only that effect's systems), \`extract(name)\` (a preset / an effect from code → \`fx/<name>.json\`), \`unsaved()\`.

## Examples

\`\`\`js
tml.nodes().filter(n => n.tag === 'image').length              // how many images
tml.doc.exec('node.move', { node: 'settingsBtn', dx: 10, dy: 0 })
for (const id of tml.selection) tml.moveBy(id, 0, -20)          // the selection up by 20 scene units
tml.doc.errors                                                   // contract, geometry, clips — after every command
await tml.save()

// «move every key of the track card by 0.2 s»
const d = tml.clipsDoc(), tr = d.clip('collect').tracks.find((t) => t.target === 'card')
d.exec('key.move', { clip: 'collect', keys: tr.columns.flatMap((column) => tr.keys[column].map((k) => ({ target: 'card', column, t: k.t }))), dt: 0.2 })
// «put fx:fdFound@spot1 at 0.8»
tml.clipsDoc().exec('event.add', { clip: 'collect', t: 0.8, event: 'fx:fdFound@spot1' })
// «double the rate of fdHintButton» (and save it into its file)
tml.inspect.fx.update('fdHintButton', (c) => { for (const s of c) s.rate *= 2 }); await tml.inspect.fx.save('fdHintButton')
\`\`\`

From outside the page — the same scripts into the page a person has open: \`npx trempel-edit eval [--port 5181] '<code>'\` (\`--file x.js\`), \`trempel-edit save\`, \`trempel-edit state\`; \`trempel-edit mcp\` — an MCP server (stdio) with \`editor.eval\`, \`editor.save\`, \`editor.state\`. An agent's script is one undo step, marked «agent» in the log.
`;
writeFileSync(fileURLToPath(new URL('../edit/API.md', import.meta.url)), api);
console.log(`edit/API.md: ${api.split('\n').length} lines`);
