// Every string the package shows a person is English (TRM-7): string literals and template texts of
// src/, editor/, edit/ and view/ hold no Cyrillic; comments may (they are not user text). Markdown,
// HTML and CSS of those folders are user-facing and English as a whole (HTML/CSS comments aside).

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('..', import.meta.url));
const CYR = /[Ѐ-ӿ]/;
const FOLDERS = ['src', 'editor', 'edit', 'view'];
const SKIP = new Set(['node_modules', 'dist', 'fixtures']);

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return SKIP.has(e.name) || e.name.startsWith('.') ? [] : files(join(dir, e.name));
    return [join(dir, e.name)];
  });
}

/** Cyrillic in the non-comment tokens of a TS/JS file: `line: text`. */
function codeHits(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
  const hits: string[] = [];
  const K = ts.SyntaxKind;
  // Brace depth, and the depths at which a template literal's `${` opened: the `}` closing one of
  // them continues the template (its middle / tail text is rescanned as text).
  let depth = 0;
  const templates: number[] = [];
  let prev: ts.SyntaxKind = K.Unknown;
  const VALUE_END = new Set([K.Identifier, K.NumericLiteral, K.StringLiteral, K.CloseParenToken, K.CloseBracketToken, K.CloseBraceToken, K.NoSubstitutionTemplateLiteral, K.TemplateTail, K.ThisKeyword, K.TrueKeyword, K.FalseKeyword, K.NullKeyword]);
  for (let t = scanner.scan(); t !== K.EndOfFileToken; t = scanner.scan()) {
    if (t === K.OpenBraceToken) depth++;
    else if (t === K.TemplateHead) templates.push(depth);
    else if (t === K.CloseBraceToken) {
      if (templates.length && templates[templates.length - 1] === depth) {
        t = scanner.reScanTemplateToken(false);
        if (t === K.TemplateTail) templates.pop();
      } else depth--;
    } else if ((t === K.SlashToken || t === K.SlashEqualsToken) && !VALUE_END.has(prev)) t = scanner.reScanSlashToken();
    if (t === K.SingleLineCommentTrivia || t === K.MultiLineCommentTrivia || t === K.WhitespaceTrivia || t === K.NewLineTrivia) continue;
    prev = t;
    const s = scanner.getTokenText();
    if (CYR.test(s)) hits.push(`${text.slice(0, scanner.getTokenStart()).split('\n').length}: ${s.trim().slice(0, 80)}`);
  }
  return hits;
}

/** Cyrillic outside <!-- --> and /* *\/ comments of a markup / style / markdown file. */
function textHits(file: string): string[] {
  const text = readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return text.split('\n').flatMap((l, i) => (CYR.test(l) ? [`${i + 1}: ${l.trim().slice(0, 80)}`] : []));
}

describe('user-facing text is English', () => {
  for (const folder of FOLDERS) {
    it(`${folder}/: no Cyrillic outside comments`, () => {
      const bad: string[] = [];
      for (const f of files(join(root, folder))) {
        const rel = relative(root, f);
        if (/\.(ts|mts|js|mjs)$/.test(f)) bad.push(...codeHits(f).map((h) => `${rel}:${h}`));
        else if (/\.(md|html|css)$/.test(f)) bad.push(...textHits(f).map((h) => `${rel}:${h}`));
      }
      expect(bad).toEqual([]);
    });
  }
});
