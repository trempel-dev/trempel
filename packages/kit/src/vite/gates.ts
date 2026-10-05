// gates.ts — YouTube Playables gates over a built dist: size (initial bundle, whole bundle, file count, biggest file), sterility
// (localStorage, Page Visibility, code from strings, external URLs except the SDK), SDK before
// the game code, no web-only code (QA probe, fake ads, the services dev panel). Writes `build-report.md` and `<dist>.zip`.
//
// Initial bundle = everything in dist except files matching `lazy` globs (loaded after gameReady:
// sounds after the first gesture, lazy screen bundles). Without `lazy` the whole dist counts.
// `oneOf`: groups of which exactly ONE loads before gameReady (the current level of 125 —
// which one depends on the save): a glob of directories ending with '/' (`levels/*/`); the initial
// bundle counts the largest group (a returning player resumes on any). `forbid`: the game's own
// markers that must not ship (a publisher's name, its own web-only probe).

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { zipSync } from 'fflate';
import { NS } from '@trempel/scene/core';
import { LEGACY } from '@trempel/scene/internal/compat';
import { scanMetadata, type CleanResult } from './metadata.js';

const MiB = 1024 * 1024;
export const LIMITS = { initialFail: 30 * MiB, initialWarn: 15 * MiB, totalFail: 250 * MiB, files: 8000, fileFail: 30 * MiB };
export const SDK_URL = 'https://www.youtube.com/game_api/v1';
/** Namespace identifiers — compared as strings by XML parsers, never requested. */
export const XML_NAMESPACES = new Set([
  'http://www.w3.org/2000/svg',
  'http://www.w3.org/1999/xhtml',
  'http://www.w3.org/2000/xmlns/',
  'http://www.w3.org/XML/1998/namespace',
  'http://www.w3.org/1999/xlink',
  NS,
  // the format's previous namespace: Trempel's compat layer still reads it (one release)
  LEGACY.ns,
]);
export const FORBIDDEN = ['localStorage', 'visibilitychange', 'document.hidden'];
/** Markers of web-only code (QA probe, fake ads, the services dev panel) that must not reach the youtube bundle. */
export const WEB_ONLY = ['__trempel', 'fake-ad', 'trempel-services'];
/** Code generated from strings at runtime (needs CSP unsafe-eval). Not preceded by an identifier char or `.`. */
export const EVAL = [
  { what: 'new Function', re: /\bnew\s+Function\s*\(/ },
  { what: 'Function(', re: /(?<![\w$.])(?<!new\s+)Function\s*\(/ },
  { what: 'eval(', re: /(?<![\w$.])eval\s*\(/ },
];

export interface SterilityHit {
  file: string;
  what: string;
}

/**
 * Scan shipped code for forbidden APIs, code from strings and external URLs. `libraryUrls`: URLs
 * of bundled libraries that are text, never requested (a license comment, warning messages) —
 * allowed, but listed in the report; pass one only after checking the library never fetches it.
 */
export function scanSterility(
  files: { path: string; text: string }[],
  extraUrls: string[] = [],
  libraryUrls: string[] = [],
): { hits: SterilityHit[]; namespaces: Set<string>; libraryUrls: Set<string> } {
  const known = new Set(libraryUrls.map((u) => u.replace(/\/$/, '')));
  const hits: SterilityHit[] = [];
  const namespaces = new Set<string>();
  const libraries = new Set<string>();
  for (const { path, text } of files) {
    for (const word of FORBIDDEN) if (text.includes(word)) hits.push({ file: path, what: word });
    for (const { what, re } of EVAL) if (re.test(text)) hits.push({ file: path, what });
    for (const word of WEB_ONLY) if (text.includes(word)) hits.push({ file: path, what: `web-only ${word}` });
    for (const m of text.matchAll(/(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s"'`)<>\\]*)?/gi)) {
      const url = m[0];
      if (!/^https?:/i.test(url)) {
        if (/^\/\/[a-z]/i.test(url)) hits.push({ file: path, what: `URL ${url}` });
        continue;
      }
      if (url === SDK_URL || extraUrls.includes(url)) continue;
      if (XML_NAMESPACES.has(url)) {
        namespaces.add(url);
        continue;
      }
      if (known.has(url.replace(/\/$/, ''))) {
        libraries.add(url);
        continue;
      }
      hits.push({ file: path, what: `URL ${url}` });
    }
  }
  return { hits, namespaces, libraryUrls: libraries };
}

/** Minimal glob → RegExp: `**` any path, `*` within a segment, `?` one char. */
export function globRe(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
      if (glob[i + 1] === '/') i++;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

interface FileInfo {
  path: string;
  bytes: number;
}

function walk(dir: string, root = dir, out: FileInfo[] = []): FileInfo[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, root, out);
    else out.push({ path: relative(root, p).split('\\').join('/'), bytes: st.size });
  }
  return out;
}

export interface GateOptions {
  /** Built youtube dist. */
  dist: string;
  /** Globs (relative to dist) of files loaded after gameReady. */
  lazy?: string[];
  /** Where to write the report (default: build-report.md next to dist). */
  report?: string;
  /** Write `<dist>.zip` (default true). */
  zip?: boolean;
  /** Directory globs ending with '/' — one directory of each loads before gameReady (the largest is counted). */
  oneOf?: string[];
  /** The game's own forbidden markers in shipped code (string = substring, RegExp). */
  forbid?: (string | RegExp)[];
  /** URLs of bundled libraries that are text, never requested — allowed, listed in the report. */
  libraryUrls?: string[];
  /** What the build's metadata cleaning did (the plugin passes it; the report lists it). */
  metadata?: CleanResult;
}

/** Group of a file under the `oneOf` directory globs: the matched directory, or null. */
export function oneOfGroup(path: string, oneOf: string[]): string | null {
  const segs = path.split('/');
  for (const g of oneOf) {
    if (!g.endsWith('/')) throw new Error(`kit gates: oneOf "${g}" must be a directory glob ending with '/'`);
    const re = globRe(g.slice(0, -1));
    for (let i = 1; i < segs.length; i++) {
      const dir = segs.slice(0, i).join('/');
      if (re.test(dir)) return dir;
    }
  }
  return null;
}

export interface GateResult {
  ok: boolean;
  fails: string[];
  warns: string[];
  initial: number;
  /** The largest `oneOf` group counted in `initial` (null without oneOf). */
  worstOneOf: { dir: string; bytes: number } | null;
  total: number;
  files: number;
  report: string;
}

const mib = (b: number): string => `${(b / MiB).toFixed(2)} MiB`;

export function runGates(opts: GateOptions): GateResult {
  const dist = opts.dist;
  const files = walk(dist);
  const total = files.reduce((s, f) => s + f.bytes, 0);
  const lazy = (opts.lazy ?? []).map(globRe);
  const isLazy = (p: string) => lazy.some((r) => r.test(p));
  const groups = new Map<string, number>();
  let initial = 0;
  for (const f of files) {
    if (isLazy(f.path)) continue;
    const g = opts.oneOf?.length ? oneOfGroup(f.path, opts.oneOf) : null;
    if (g) groups.set(g, (groups.get(g) ?? 0) + f.bytes);
    else initial += f.bytes;
  }
  const worstEntry = [...groups].sort((a, b) => b[1] - a[1])[0];
  const worstOneOf = worstEntry ? { dir: worstEntry[0], bytes: worstEntry[1] } : null;
  if (worstOneOf) initial += worstOneOf.bytes;
  const biggest = [...files].sort((a, b) => b.bytes - a.bytes)[0];
  const fails: string[] = [];
  const warns: string[] = [];
  if (initial >= LIMITS.initialFail) fails.push(`начальный бандл ${mib(initial)} ≥ 30 MiB`);
  else if (initial >= LIMITS.initialWarn) warns.push(`начальный бандл ${mib(initial)} ≥ 15 MiB (SHOULD < 15)`);
  if (total >= LIMITS.totalFail) fails.push(`весь бандл ${mib(total)} ≥ 250 MiB`);
  if (files.length > LIMITS.files) fails.push(`файлов ${files.length} > 8000`);
  if (biggest && biggest.bytes >= LIMITS.fileFail) fails.push(`файл ${biggest.path} ${mib(biggest.bytes)} ≥ 30 MiB`);

  // Metadata in rasters / generation sidecars (the plugin cleaned the dist before; a hit here fails too).
  const meta = scanMetadata(dist);
  for (const h of meta) fails.push(`E_ASSET_METADATA: ${h.file}: ${h.what}`);

  const code = files.filter((f) => /\.(js|mjs|html|css)$/.test(f.path)).map((f) => ({ path: f.path, text: readFileSync(join(dist, f.path), 'utf8') }));
  const { hits, namespaces, libraryUrls } = scanSterility(code, [], opts.libraryUrls);
  for (const h of hits) fails.push(`стерильность: ${h.what} в ${h.file}`);
  for (const m of opts.forbid ?? []) {
    for (const f of code) if (typeof m === 'string' ? f.text.includes(m) : m.test(f.text)) fails.push(`запрещённый маркер игры ${m} в ${f.path}`);
  }
  let html = '';
  try {
    html = readFileSync(join(dist, 'index.html'), 'utf8');
  } catch {
    fails.push('нет index.html');
  }
  const sdkAt = html.indexOf(SDK_URL);
  const firstModule = html.search(/<script[^>]+type="module"/);
  if (sdkAt === -1) fails.push('index.html: нет SDK ytgame');
  else if (firstModule !== -1 && sdkAt > firstModule) fails.push('index.html: SDK грузится после кода игры');

  if (opts.zip !== false) {
    const entries: Record<string, Uint8Array> = {};
    for (const f of files) entries[f.path] = readFileSync(join(dist, f.path));
    writeFileSync(`${dist}.zip`, zipSync(entries, { level: 6 }));
  }

  const ok = fails.length === 0;
  const byKind = (re: RegExp) => files.filter((f) => re.test(f.path)).reduce((s, f) => s + f.bytes, 0);
  const lines = [
    '# Отчёт youtube-сборки',
    '',
    'Сгенерирован гейтами кита (`@trempel/kit/vite`, `npm run build:yt`) — не править руками.',
    '',
    `**Итог: ${ok ? 'PASS' : 'FAIL'}**${warns.length ? ` (варнингов: ${warns.length})` : ''}`,
    '',
    '## Размеры',
    '',
    '| что | значение | лимит |',
    '|---|---|---|',
    `| начальный бандл | ${mib(initial)} | MUST < 30 MiB, SHOULD < 15 MiB |`,
    `| весь бандл | ${mib(total)} | < 250 MiB |`,
    `| файлов | ${files.length} | ≤ 8000 |`,
    `| самый большой файл | ${biggest ? `${biggest.path} — ${mib(biggest.bytes)}` : '—'} | < 30 MiB |`,
    `| JS | ${mib(byKind(/\.js$/))} | — |`,
    ...(worstOneOf ? [`| один из N (${(opts.oneOf ?? []).map((g) => `\`${g}\``).join(', ')}): ${groups.size} групп, в начальном худшая | ${worstOneOf.dir} — ${mib(worstOneOf.bytes)} | — |`] : []),
    `| ленивое (${(opts.lazy ?? []).map((g) => `\`${g}\``).join(', ') || 'нет'}) | ${mib(total - initial)} | — |`,
    '',
    '## Стерильность',
    '',
    `- Запрещённое (${FORBIDDEN.map((f) => `\`${f}\``).join(', ')}): ${hits.filter((h) => FORBIDDEN.includes(h.what)).length || 'нет'}`,
    `- Код из строк (${EVAL.map((e) => `\`${e.what}\``).join(', ')}; CSP без unsafe-eval): ${hits.filter((h) => EVAL.some((e) => e.what === h.what)).length || 'нет'}`,
    `- Внешние URL кроме SDK: ${hits.filter((h) => h.what.startsWith('URL')).length || 'нет'}`,
    `- Web-only код (QA-проба, фейковая реклама): ${hits.filter((h) => h.what.startsWith('web-only')).length || 'нет'}`,
    `- SDK \`${SDK_URL}\` в index.html до кода игры: ${sdkAt !== -1 && (firstModule === -1 || sdkAt < firstModule) ? 'да' : 'НЕТ'}`,
    `- Пространства имён XML (идентификаторы, не запросы): ${[...namespaces].map((n) => `\`${n}\``).join(', ') || 'нет'}`,
    `- URL-строки библиотек (лицензии/предупреждения, не запросы): ${[...libraryUrls].map((n) => `\`${n}\``).join(', ') || 'нет'}`,
    '',
    '## Метаданные ассетов',
    '',
    `- Метаданные в растрах и сайдкары генерации после очистки: ${meta.length || 'нет'}`,
    ...(opts.metadata
      ? [
          `- Очищено сборкой: ${opts.metadata.cleaned.length} из ${opts.metadata.rasters} растров, −${(opts.metadata.bytesBefore - opts.metadata.bytesAfter).toLocaleString('en')} байт, без перекодирования (пиксели те же)`,
          ...opts.metadata.cleaned.slice(0, 50).map((c) => `  - \`${c.file}\`: ${[...new Set(c.removed)].join(', ')}`),
          ...(opts.metadata.cleaned.length > 50 ? [`  - … ещё ${opts.metadata.cleaned.length - 50}`] : []),
        ]
      : []),
    '',
  ];
  if (fails.length || warns.length) {
    lines.push('## Нарушения', '');
    for (const f of fails) lines.push(`- ✗ ${f}`);
    for (const w of warns) lines.push(`- ⚠ ${w}`);
    lines.push('');
  }
  const report = opts.report ?? join(dist, '..', 'build-report.md');
  writeFileSync(report, lines.join('\n'));
  return { ok, fails, warns, initial, worstOneOf, total, files: files.length, report };
}
