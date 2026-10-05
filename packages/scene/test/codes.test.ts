// The catalog of message codes (src/codes.ts) and the "Error codes" section of the spec are one
// list: the section is generated (npm run error-codes) and must not drift.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { CODES, codeOf, coded, within } from '../src/codes';
import { BEGIN, END, readCatalog, renderCodes } from '../scripts/error-codes.mjs';

const read = (p: string): string => readFileSync(new URL(p, import.meta.url), 'utf8');

describe('error codes', () => {
  it('the catalog parses from src/codes.ts with every code (no entry missed by the generator)', () => {
    const catalog = readCatalog(read('../src/codes.ts'));
    expect(catalog.map((c) => c.code)).toEqual(Object.keys(CODES));
    expect(catalog.map((c) => c.text)).toEqual(Object.values(CODES));
    for (const c of catalog) expect(c.group, c.code).not.toBe('');
  });

  it('codes are E_/W_ upper snake case, descriptions are short English', () => {
    for (const [code, text] of Object.entries(CODES)) {
      expect(code).toMatch(/^[EW]_[A-Z][A-Z0-9_]*$/);
      expect(text, code).not.toMatch(/[а-яА-ЯёЁ]/);
      expect(text.length, code).toBeLessThan(160);
    }
  });

  it('the "Error codes" section of scene-format.md is the catalog (npm run error-codes)', () => {
    const doc = read('../docs/format/scene-format.md');
    const a = doc.indexOf(BEGIN);
    const b = doc.indexOf(END);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(doc.slice(a + BEGIN.length, b).trim()).toBe(renderCodes(readCatalog(read('../src/codes.ts'))).trim());
  });

  it('coded / codeOf / within keep the code first', () => {
    const m = coded('E_REF_MISSING', '<tml:ref id="x">: no such id');
    expect(codeOf(m)).toBe('E_REF_MISSING');
    expect(within('#a (b.svg)', m)).toBe('E_REF_MISSING: #a (b.svg): <tml:ref id="x">: no such id');
    expect(within('heir', 'plain')).toBe('heir: plain');
    expect(codeOf('E_NOT_A_CODE: x')).toBeUndefined();
  });
});
