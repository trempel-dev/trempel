#!/usr/bin/env node
// migrate-collections.mjs — v1.1: rewrite a consumer folder's relative links into the project's
// collections as `@name/…` (MIGRATION.md §11).
//
//   npm run build && node scripts/migrate-collections.mjs <folder> [--dry-run]
//
// The project is the nearest ancestor of <folder> holding .trempel/project.mdz; its collections
// are the folders links are moved into. Rewritten (in files below <folder>, not inside a collection
// itself — a collection's own relative links stay relative):
//   - *.svg (bases, heirs): href / xlink:href / tml:href / tml:extends, data-views variants, data-*
//     parameter values that are paths;
//   - md clips (*.md): `$tex:` values and table cells;
//   - *.json (a manifest): string values that are paths.
// A link is rewritten when, resolved against its file, it lands inside a collection folder.
// Idempotent (`@…` links are left alone); --dry-run prints the changes without writing.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { collectionPath, loadProject } from '../dist/node/project.js';

const cwd = process.env.INIT_CWD ?? process.cwd();
const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const folderArg = args.find((a) => !a.startsWith('--'));
if (!folderArg) {
  console.error('usage: node scripts/migrate-collections.mjs <folder> [--dry-run]');
  process.exit(2);
}
const folder = resolve(cwd, folderArg);
if (!existsSync(folder) || !statSync(folder).isDirectory()) {
  console.error(`✗ ${folderArg}: not a folder`);
  process.exit(2);
}
const project = loadProject(folder);
if (!project.root) {
  console.error(`✗ E_PROJECT: ${folderArg}: no .trempel/project.mdz above — collections are declared there (## collections)`);
  process.exit(2);
}
for (const e of project.errors) console.error(`  • ${e}`);
const dirs = Object.values(project.collections);
if (!dirs.length) {
  console.error(`✗ E_PROJECT: ${project.root}/.trempel/project.mdz: no collections`);
  process.exit(1);
}

const inside = (dir, file) => file === dir || file.startsWith(dir + sep);
const isLink = (v) => v !== '' && !/^(?:[a-zA-Z][a-zA-Z\d+.-]*:|\/|#|@)/.test(v);

/** A link written in `file` → `@name/…` when it lands in a collection, else null. */
function rewrite(file, value) {
  const raw = value.trim();
  if (!isLink(raw)) return null;
  const m = /^([^?#]*)([?#].*)?$/.exec(raw);
  const at = collectionPath(resolve(dirname(file), m[1]), project.collections);
  return at ? at + (m[2] ?? '') : null;
}

/** A link-ish value of a data-* / JSON string: has a folder part. */
const pathLike = (v) => v.includes('/') && !/\s/.test(v.trim());

function migrateSvg(file, text) {
  return text.replace(/(\s)((?:xlink:)?href|tml:href|tml:extends|data-[\w-]+)(\s*=\s*)(["'])([^"']*)\4/g, (all, sp, name, eq, q, value) => {
    let out = null;
    if (name === 'data-views') {
      const parts = value.split(',').map((part) => {
        const i = part.indexOf(':');
        if (i < 0) return part;
        const lead = /^\s*/.exec(part.slice(i + 1))[0];
        const r = rewrite(file, part.slice(i + 1));
        return r ? `${part.slice(0, i + 1)}${lead}${r}` : part;
      });
      out = parts.join(',');
      if (out === value) out = null;
    } else if (name.startsWith('data-')) {
      out = pathLike(value) && !value.startsWith('=') ? rewrite(file, value) : null;
    } else out = rewrite(file, value);
    return out == null ? all : `${sp}${name}${eq}${q}${out}${q}`;
  });
}

function migrateMd(file, text) {
  return text
    .split('\n')
    .map((line) => {
      const tex = /^(\$tex:\s*)(\S+)(\s*)$/.exec(line);
      if (tex) {
        const r = rewrite(file, tex[2]);
        return r ? `${tex[1]}${r}${tex[3]}` : line;
      }
      if (/^\s*\|.*\|\s*$/.test(line)) {
        return line.replace(/(\|\s*)([^|\s]+)(?=\s*\|)/g, (all, lead, cell) => {
          const r = pathLike(cell) ? rewrite(file, cell) : null;
          return r ? `${lead}${r}` : all;
        });
      }
      return line;
    })
    .join('\n');
}

function migrateJson(file, text) {
  return text.replace(/"((?:[^"\\]|\\.)*)"(\s*[,}\]\n])/g, (all, value, tail) => {
    const r = pathLike(value) && !value.includes('\\') ? rewrite(file, value) : null;
    return r ? `"${r}"${tail}` : all;
  });
}

const SKIP = new Set(['node_modules', 'dist', '.git']);
const files = [];
(function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
    const p = join(d, e.name);
    if (e.isDirectory()) {
      if (!dirs.some((c) => inside(c, p))) walk(p);
    } else if (/\.(svg|md|json)$/.test(e.name) && !dirs.some((c) => inside(c, p))) files.push(p);
  }
})(folder);

let changed = 0;
let links = 0;
for (const file of files.sort()) {
  const text = readFileSync(file, 'utf8');
  const out = file.endsWith('.svg') ? migrateSvg(file, text) : file.endsWith('.md') ? migrateMd(file, text) : migrateJson(file, text);
  if (out === text) continue;
  const n = text.split('\n').filter((l, i) => l !== out.split('\n')[i]).length;
  changed++;
  links += n;
  console.log(`${dry ? '~' : '✓'} ${relative(cwd, file)} (${n} line(s))`);
  if (dry) {
    const a = text.split('\n');
    const b = out.split('\n');
    a.forEach((l, i) => l !== b[i] && console.log(`    - ${l.trim()}\n    + ${b[i].trim()}`));
  } else writeFileSync(file, out);
}
console.log(changed ? `${dry ? 'would change' : 'changed'}: ${changed} file(s), ${links} line(s)` : 'nothing to change — the links already use collections');
