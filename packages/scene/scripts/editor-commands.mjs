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

const { commands } = await import('../dist/editor/index.js');
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
const rows = Object.entries(commands).map(([name, c]) => `| \`${name}\` | ${args(c.schema)} | ${cell(c.describe)} |`);
const block = ['| команда | аргументы | что делает |', '|---|---|---|', ...rows].join('\n');

const BEGIN = '<!-- BEGIN commands (scripts/editor-commands.mjs) -->';
const END = '<!-- END commands -->';
const text = readFileSync(readme, 'utf8');
const a = text.indexOf(BEGIN);
const b = text.indexOf(END);
if (a < 0 || b < a) {
  console.error(`editor/README.md: нет маркеров ${BEGIN} … ${END}`);
  process.exit(2);
}
writeFileSync(readme, `${text.slice(0, a + BEGIN.length)}\n${block}\n${text.slice(b)}`);
console.log(`editor/README.md: ${rows.length} команд`);

// ---- edit/API.md ---------------------------------------------------------------------------------

const tmlSrc = readFileSync(fileURLToPath(new URL('../edit/app/tml.ts', import.meta.url)), 'utf8');
const ga = tmlSrc.indexOf('// BEGIN tml-api');
const gb = tmlSrc.indexOf('// END tml-api');
if (ga < 0 || gb < ga) {
  console.error('edit/app/tml.ts: нет маркеров // BEGIN tml-api … // END tml-api');
  process.exit(2);
}
const types = tmlSrc
  .slice(tmlSrc.indexOf('\n', ga) + 1, gb)
  .replace(/^export /gm, '')
  .split('\n')
  .filter((l) => l.trim() !== '')
  .join('\n');
const api = `# tml — API редактора сцен для скриптов

<!-- Сгенерировано: npm run editor:commands (из edit/app/tml.ts и реестра команд). Не править руками. -->

\`window.tml\` — редактор сцен Trempel одним объектом: консоль (вкладка «Консоль», ⌘Enter), макросы (\`<папка сцен>/.trempel/macros/*.js\`, ⌘K), агент (\`tml.run(code)\`). Правится **база** сцены (\`X.svg\`, ванильный SVG): только командами ядра — \`tml.doc.exec(name, args)\`. Узел — \`id\` или путь индексов элементов от корня (\`"0/3/1"\`). Координаты команд — пространство **родителя** узла; \`tml.bounds\` и \`tml.moveBy\` — единицы **сцены** (viewBox).

- Скрипт = тело async-функции с \`tml\` и \`console\`; одно выражение возвращается само. Весь \`tml.run\` — **одна** запись undo; исключение откатывает всё. Ошибка команды — не исключение: \`{ ok: false, errors }\`.
- После команд сцена перерисовывается асинхронно: \`bounds\` и \`scene\` — с прошлой отрисовки, свежие — после \`await tml.idle()\`.
- Макрос — тот же скрипт в файле, первая строка \`// name: Подпись\`.

\`\`\`ts
${types}
\`\`\`

## Команды — \`tml.doc.exec(name, args)\`, пачкой — \`tml.doc.batch(label, [{ name, args }])\`

${block}

## Примеры

\`\`\`js
tml.nodes().filter(n => n.tag === 'image').length              // сколько картинок
tml.doc.exec('node.move', { node: 'settingsBtn', dx: 10, dy: 0 })
for (const id of tml.selection) tml.moveBy(id, 0, -20)          // выделение вверх на 20 единиц сцены
tml.doc.errors                                                   // контракт, геометрия, клипы — после каждой команды
await tml.save()
\`\`\`
`;
writeFileSync(fileURLToPath(new URL('../edit/API.md', import.meta.url)), api);
console.log(`edit/API.md: ${api.split('\n').length} строк`);
