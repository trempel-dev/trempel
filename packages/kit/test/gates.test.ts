import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SDK_URL, globRe, oneOfGroup, runGates, scanSterility } from '../src/vite/gates.js';

const scan = (text: string) => scanSterility([{ path: 'a.js', text }]).hits.map((h) => h.what);

describe('youtube gates', () => {
  it('sterility: SDK and namespaces pass; identifiers ending in Function/eval are fine', () => {
    expect(scan(`s.src="${SDK_URL}";x="http://www.w3.org/2000/svg";y="https://trempel.dev/ns/scene"`)).toEqual([]);
    expect(scan('isFunction(x);a.eval(y);retrieval(z)')).toEqual([]);
  });
  it.each([
    ['localStorage.setItem("a",1)', 'localStorage'],
    ['addEventListener("visibilitychange",f)', 'visibilitychange'],
    ['new Function("a","return a")', 'new Function'],
    ['x=eval("1")', 'eval('],
    ['fetch("https://fonts.googleapis.com/css")', 'URL https://fonts.googleapis.com/css'],
    ['window.__trempel={}', 'web-only __trempel'],
  ])('fails on %s', (code, what) => {
    expect(scan(code)).toContain(what);
  });

  it('library URL strings (a license comment, warnings) are allowed only when listed, and reported', () => {
    const text = '/*! Subject to the terms at https://lib.example.com/license */ warn("not found. https://lib.example.com")';
    expect(scanSterility([{ path: 'a.js', text }]).hits.map((h) => h.what)).toEqual(['URL https://lib.example.com/license', 'URL https://lib.example.com']);
    const r = scanSterility([{ path: 'a.js', text }], [], ['https://lib.example.com', 'https://lib.example.com/license']);
    expect(r.hits).toEqual([]);
    expect([...r.libraryUrls].sort()).toEqual(['https://lib.example.com', 'https://lib.example.com/license']);
  });

  it('globs', () => {
    expect(globRe('assets/**/*.mp3').test('assets/sfx/a.mp3')).toBe(true);
    expect(globRe('assets/*.mp3').test('assets/sfx/a.mp3')).toBe(false);
  });

  it('runGates: report, zip, lazy excluded from initial, SDK order', () => {
    const root = mkdtempSync(join(tmpdir(), 'gk-gates-'));
    const dist = join(root, 'dist-yt');
    mkdirSync(join(dist, 'lazy'), { recursive: true });
    writeFileSync(join(dist, 'index.html'), `<html><head><script src="${SDK_URL}"></script><script type="module" src="a.js"></script></head></html>`);
    writeFileSync(join(dist, 'a.js'), 'console.log(1)');
    writeFileSync(join(dist, 'lazy', 'big.bin'), Buffer.alloc(2048));
    const ok = runGates({ dist, lazy: ['lazy/**'] });
    expect(ok.ok).toBe(true);
    expect(ok.total - ok.initial).toBe(2048);
    expect(readFileSync(join(root, 'build-report.md'), 'utf8')).toContain('PASS');
    writeFileSync(join(dist, 'a.js'), 'localStorage.x=1');
    writeFileSync(join(dist, 'index.html'), `<script type="module" src="a.js"></script>`);
    const bad = runGates({ dist, zip: false });
    expect(bad.ok).toBe(false);
    expect(bad.fails.join('\n')).toMatch(/localStorage[\s\S]*нет SDK/);
  });

  it('oneOf: one directory of N loads before gameReady — the largest counts; forbid: game markers', () => {
    expect(oneOfGroup('levels/a3/back.webp', ['levels/*/'])).toBe('levels/a3');
    expect(oneOfGroup('levels/levels.json', ['levels/*/'])).toBeNull();
    expect(() => oneOfGroup('x', ['levels/*'])).toThrow(/ending with '\/'/);
    const root = mkdtempSync(join(tmpdir(), 'gk-oneof-'));
    const dist = join(root, 'dist-yt');
    for (const [id, n] of [['a0', 100], ['a1', 3000], ['a2', 500]] as const) {
      mkdirSync(join(dist, 'levels', id), { recursive: true });
      writeFileSync(join(dist, 'levels', id, 'back.bin'), Buffer.alloc(n));
    }
    writeFileSync(join(dist, 'levels', 'levels.json'), '{}');
    writeFileSync(join(dist, 'index.html'), `<html><head><script src="${SDK_URL}"></script><script type="module" src="a.js"></script></head></html>`);
    writeFileSync(join(dist, 'a.js'), 'console.log("Acme Games")');
    const all = runGates({ dist, zip: false });
    const one = runGates({ dist, zip: false, oneOf: ['levels/*/'], forbid: [/acme\s*games/i] });
    expect(all.initial - one.initial).toBe(600);
    expect(one.worstOneOf).toEqual({ dir: 'levels/a1', bytes: 3000 });
    expect(one.ok).toBe(false);
    expect(one.fails.join('\n')).toMatch(/запрещённый маркер игры/);
    expect(readFileSync(join(root, 'build-report.md'), 'utf8')).toContain('один из N');
  });
});
