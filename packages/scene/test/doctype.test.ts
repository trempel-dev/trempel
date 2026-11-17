// A scene document never needs a DTD (TRM-7 §6): <!DOCTYPE> and <!ENTITY> are refused with
// E_DOCTYPE before any XML parser sees them — no entity expansion (billion laughs), no external
// entity read — in a base, an heir, a contract and a prefab.

import { describe, it, expect } from 'vitest';
import { checkScene, parse, parseContract, parseHeir } from '../src/core';
import { codesOf, thrown } from './helpers/codes';

const LAUGHS = `<?xml version="1.0"?>
<!DOCTYPE svg [
  <!ENTITY a "lollollollollollollollollollol">
  <!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">
  <!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">
  <!ENTITY d "&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;">
  <!ENTITY e "&d;&d;&d;&d;&d;&d;&d;&d;&d;&d;">
  <!ENTITY f "&e;&e;&e;&e;&e;&e;&e;&e;&e;&e;">
  <!ENTITY g "&f;&f;&f;&f;&f;&f;&f;&f;&f;&f;">
  <!ENTITY h "&g;&g;&g;&g;&g;&g;&g;&g;&g;&g;">
  <!ENTITY i "&h;&h;&h;&h;&h;&h;&h;&h;&h;&h;">
]>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text id="t">&i;</text></svg>`;
const EXTERNAL = `<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text id="t">&x;</text></svg>`;
const HEIR = (body: string) => `<!DOCTYPE svg>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:tml="https://trempel.dev/ns/scene" tml:extends="x.svg">${body}</svg>`;

describe('E_DOCTYPE — no DTD in scene documents', () => {
  it('billion laughs: refused at once, nothing expanded', () => {
    const t0 = Date.now();
    const e = thrown(() => parse(LAUGHS));
    expect(e).toMatchObject({ code: 'E_DOCTYPE' });
    expect(e.message).not.toMatch(/lol/);
    expect(Date.now() - t0).toBeLessThan(100);
  });

  it('an external entity: refused, the file is never read', () => {
    const e = thrown(() => parse(EXTERNAL));
    expect(e).toMatchObject({ code: 'E_DOCTYPE' });
    expect(e.message).not.toMatch(/root:/);
  });

  it('heir and contract too; a bare <!DOCTYPE svg> as well', () => {
    expect(thrown(() => parseHeir(HEIR('')))).toMatchObject({ code: 'E_DOCTYPE' });
    expect(thrown(() => parseContract('<!DOCTYPE contract>\n<contract/>'))).toMatchObject({ code: 'E_DOCTYPE' });
    expect(thrown(() => parseContract('<!ENTITY x "y"><contract/>'))).toMatchObject({ code: 'E_DOCTYPE' });
  });

  it('a prefab with a DTD: the instance reports E_DOCTYPE, the scene does not mount', () => {
    const base = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><use id="p" href="bad.svg"/></svg>';
    const r = checkScene({ base, loadScene: (url) => (url === 'bad.svg' ? { base: EXTERNAL } : null) });
    expect(codesOf(r.errors)).toEqual(['E_DOCTYPE']);
    expect(r.errors[0]).toContain('#p');
  });

  it('checkScene reports a base with a DTD as E_DOCTYPE', () => {
    expect(codesOf(checkScene({ base: LAUGHS }).errors)).toEqual(['E_DOCTYPE']);
  });
});
