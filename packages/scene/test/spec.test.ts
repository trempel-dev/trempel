// The spec as a test (TRM-7): every example of docs/format/scene-format.md — the ```svg, ```xml,
// ```md / ```markdown and ```mdz blocks — is a fixture, checked in document order:
//   - a block whose first line is `<!-- path -->` is a file of one virtual project (prefabs, heirs and
//     contracts find each other by path, e.g. `<!-- ui/button.svg -->`);
//   - a scene base (`<svg>` without tml:extends) is checked with its heir and contract from the
//     project (checkScene: parse, prefabs, contract, merge, geometry, attributes, expressions);
//   - an heir (tml:extends) is composed with the scene it extends when the project has it, else parsed;
//   - a contract (`<contract>`) is parsed; a fragment (`<use …>`) is checked inside an `<svg>`;
//   - md clips are compiled (no scene), an mdz project file is parsed;
//   - ```lang error=E_CODE — the block must fail, every problem with exactly that code.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { checkScene, codeOf, compileClipsResult, parseContract, parseHeir, parseProject, TrempelError, type SceneLoader } from '../src/core';

const DOC = readFileSync(new URL('../docs/format/scene-format.md', import.meta.url), 'utf8');
const LANGS = new Set(['svg', 'xml', 'md', 'markdown', 'mdz']);

interface Block {
  lang: string;
  error?: string;
  text: string;
  /** Line of the opening fence (1-based). */
  line: number;
  /** `<!-- path -->` on the first line. */
  file?: string;
}

function blocks(md: string): Block[] {
  const out: Block[] = [];
  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const open = /^(\s*)```(\w+)?([^`]*)$/.exec(lines[i]);
    if (!open) continue;
    const indent = open[1].length;
    let j = i + 1;
    while (j < lines.length && !/^\s*```\s*$/.test(lines[j])) j++;
    const lang = open[2] ?? '';
    if (LANGS.has(lang)) {
      const text = lines
        .slice(i + 1, j)
        .map((l) => l.slice(Math.min(indent, l.length - l.trimStart().length)))
        .join('\n');
      const error = /\berror=([EW]_[A-Z0-9_]+)/.exec(open[3])?.[1];
      const file = /^\s*<!--\s*([\w./@-]+)\s*-->/.exec(text)?.[1];
      out.push({ lang, error, text, line: i + 1, file });
    }
    i = j;
  }
  return out;
}

const all = blocks(DOC);
const files = new Map(all.filter((b) => b.file).map((b) => [b.file!, b.text]));

/** The virtual project as a scene loader: `X.svg` → X.svg, X.tml.svg, X.contract.xml. */
const loadScene: SceneLoader = (url) => {
  const stem = url.replace(/\.svg$/, '');
  const src = { base: files.get(`${stem}.svg`), heir: files.get(`${stem}.tml.svg`), contract: files.get(`${stem}.contract.xml`) };
  return src.base != null || src.heir != null ? src : null;
};

/** Hrefs of a document at `path` → paths of the project. */
const urlFor = (path: string) => (rel: string) => posix.normalize(posix.join(posix.dirname(path), rel));

const errorsOf = (fn: () => unknown): string[] => {
  try {
    fn();
    return [];
  } catch (e) {
    return e instanceof TrempelError ? e.errors : [(e as Error).message];
  }
};

/** Every problem of one example block. */
function problems(b: Block): string[] {
  if (b.lang === 'md' || b.lang === 'markdown') return compileClipsResult(b.text).errors;
  if (b.lang === 'mdz') return parseProject(b.text).errors;
  const body = b.text.replace(/^\s*<!--[\s\S]*?-->\s*/, '');
  const root = /^\s*(?:<!DOCTYPE[^>]*(?:\[[\s\S]*?\])?\s*>\s*)?<([\w:]+)/i.exec(body)?.[1];
  if (root === 'contract') return errorsOf(() => parseContract(b.text));
  if (root !== 'svg') {
    // A fragment of a scene (an instance, a slot child): checked inside a root <svg>.
    const base = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:tml="https://trempel.dev/ns/scene">\n${b.text}\n</svg>`;
    return checkScene({ base, path: 'example.svg', loadScene, url: urlFor('example.svg') }).errors;
  }
  const extendsOf = /\btml:extends="([^"]+)"/.exec(body)?.[1];
  if (extendsOf) {
    const path = b.file ? b.file.replace(/\.tml\.svg$/, '.svg') : 'example.svg';
    const target = urlFor(path)(extendsOf);
    if (!files.has(target) && !b.file) return errorsOf(() => parseHeir(b.text));
    return checkScene({ base: files.get(path), heir: b.text, contract: files.get(path.replace(/\.svg$/, '.contract.xml')), path, loadScene, url: urlFor(path) }).errors;
  }
  const path = b.file ?? 'example.svg';
  const stem = path.replace(/\.svg$/, '');
  return checkScene({ base: b.text, heir: files.get(`${stem}.tml.svg`), contract: files.get(`${stem}.contract.xml`), path, loadScene, url: urlFor(path) }).errors;
}

describe('scene-format.md — every example is checked', () => {
  it('the document has examples of every kind', () => {
    const kinds = new Set(all.map((b) => b.lang));
    for (const k of ['svg', 'xml', 'markdown', 'mdz']) expect(kinds, k).toContain(k);
    expect(all.some((b) => b.error)).toBe(true);
  });

  for (const b of all) {
    const name = `line ${b.line}: \`\`\`${b.lang}${b.error ? ` error=${b.error}` : ''}${b.file ? ` (${b.file})` : ''}`;
    it(name, () => {
      const got = problems(b);
      if (b.error) {
        expect(got.length, 'an error example must fail').toBeGreaterThan(0);
        expect([...new Set(got.map(codeOf))]).toEqual([b.error]);
      } else {
        expect(got).toEqual([]);
      }
    });
  }
});
