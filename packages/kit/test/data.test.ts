import { describe, expect, it } from 'vitest';
import { Save, parseSave } from '../src/data/save.js';
import { I18n } from '../src/data/i18n.js';
import { Ads } from '../src/data/ads.js';
import { createMockPlatform } from '../src/platform/mock.js';
import { swipeDirection, keyAction } from '../src/input/input.js';
import { renderSynth, SYNTH_PRESETS } from '../src/audio/synth.js';
import { seededRandom } from '../src/qa/random.js';
import { canvas, column, viewBoxOf } from '../src/ui/layout.js';

const opts = { version: 2, defaults: { best: 0, name: 'cat', levels: {} as Record<string, number>, sfx: 1 } };

describe('save — through the platform, defensive', () => {
  it('parse: defaults, wrong types, corrupt, migrate', () => {
    expect(parseSave(null, opts)).toEqual(opts.defaults);
    expect(parseSave('{oops', opts)).toEqual(opts.defaults);
    expect(parseSave(JSON.stringify({ v: 2, best: 'x', name: 'dog', levels: { a: 3 } }), opts)).toEqual({ best: 0, name: 'dog', levels: { a: 3 }, sfx: 1 });
    const mig = parseSave(JSON.stringify({ v: 1, record: 7 }), { ...opts, migrate: (o) => ({ best: o.record }) });
    expect(mig.best).toBe(7);
  });

  it('survives a reload (new Save on the same platform), coalesces writes', async () => {
    const platform = createMockPlatform();
    const s = new Save(platform, opts);
    await s.load();
    void s.set({ best: 5 });
    await s.set({ name: 'x' });
    expect(platform.host.calls.filter((c) => c === 'save').length).toBe(1);
    const again = new Save(platform, opts);
    expect((await again.load()).best).toBe(5);
    await again.reset();
    expect(JSON.parse(platform.host.saved!)).toMatchObject({ v: 2, best: 0 });
  });
});

describe('i18n', () => {
  it('picks exact, base, fallback; substitutes; missing key → key', () => {
    const tables = { en: { hi: 'Hi {name}', only: 'EN' }, ru: { hi: 'Привет {name}' } };
    expect(new I18n(tables, 'ru-RU').t('hi', { name: 'Кот' })).toBe('Привет Кот');
    expect(new I18n(tables, 'ru').t('only')).toBe('EN');
    expect(new I18n(tables, 'de').lang).toBe('en');
    expect(new I18n(tables, 'en').t('nope')).toBe('nope');
  });
});

describe('ads', () => {
  it('pauses around ads, honours availability and cooldown', async () => {
    const p = createMockPlatform();
    let now = 0;
    const log: boolean[] = [];
    const ads = new Ads(p, { now: () => now, cooldown: 30, onAd: (on) => log.push(on) });
    expect(await ads.rewarded()).toBe('rewarded');
    expect(await ads.interstitial()).toBe(true);
    expect(await ads.interstitial()).toBe(false);
    now = 31;
    expect(await ads.interstitial()).toBe(true);
    p.host.ads = false;
    expect(await ads.rewarded()).toBe('failed');
    expect(log).toEqual([true, false, true, false, true, false]);
  });
});

describe('input, synth, random, layout', () => {
  it('swipes and keys', () => {
    expect(swipeDirection(40, 5)).toBe('right');
    expect(swipeDirection(-3, -50)).toBe('up');
    expect(swipeDirection(5, 5)).toBeNull();
    expect(keyAction('KeyW')).toBe('up');
    expect(keyAction('Escape')).toBe('pause');
  });
  it('synth renders bounded samples deterministically', () => {
    const a = renderSynth(SYNTH_PRESETS.hit, 8000, seededRandom(1));
    const b = renderSynth(SYNTH_PRESETS.hit, 8000, seededRandom(1));
    expect(a).toEqual(b);
    expect(Math.max(...a.map(Math.abs))).toBeLessThanOrEqual(1);
    expect(renderSynth(SYNTH_PRESETS.win, 8000).length).toBe(Math.round(0.11 * 8000) * 4);
  });
  it('layout math', () => {
    expect(column(1600, 900, 0.75)).toEqual({ x: (1600 - 675) / 2, y: 0, w: 675, h: 900 });
    const fit = canvas('expand', 720, 1600, 720, 1280);
    expect(fit.scale).toBe(1);
    expect(fit.h).toBe(1600);
    expect(viewBoxOf('<svg xmlns="x" viewBox="0 0 720 1280">')).toEqual([0, 0, 720, 1280]);
    expect(() => viewBoxOf('<svg>')).toThrow(/viewBox/);
  });
});
