// main.ts — the editor page on the dev server (`npm run edit -- <folder>`): SceneIO over the
// server, the folder's trempel.view.ts as a virtual module. `window.tmlEdit` is the page API the
// e2e tests drive (the same Editor the UI uses).

import { devIO } from '../io-dev';
import { mountEditor } from './ui';

// URL: ?scene=<id>&zoom=<fit|0.05…8>&ox=<px>&oy=<px> — the scene and the view (as in `view`).
const params = new URLSearchParams(location.search);
const num = (k: string): number => {
  const v = Number(params.get(k));
  return Number.isFinite(v) ? v : 0;
};
const zoomParam = Number(params.get('zoom'));
const ed = await mountEditor({
  io: devIO(import.meta.hot ?? undefined),
  loadModule: () => import('virtual:trempel-view-module'),
  scene: params.get('scene') ?? undefined,
  view: { zoom: Number.isFinite(zoomParam) && zoomParam > 0 ? zoomParam : null, offset: { x: num('ox'), y: num('oy') } },
});
window.tmlEdit = ed;
let urlTimer = 0;
const syncUrl = (): void => {
  clearTimeout(urlTimer);
  urlTimer = window.setTimeout(() => {
    const p = new URLSearchParams(location.search);
    if (ed.entry) p.set('scene', ed.entry.id);
    const r = (v: number): string => String(Math.round(v));
    if (ed.zoom == null) p.delete('zoom');
    else p.set('zoom', String(Math.round(ed.zoom * 1000) / 1000));
    if (ed.offset.x || ed.offset.y) {
      p.set('ox', r(ed.offset.x));
      p.set('oy', r(ed.offset.y));
    } else {
      p.delete('ox');
      p.delete('oy');
    }
    history.replaceState(null, '', `${location.pathname}?${p}`);
  }, 150);
};
ed.on('scenes', syncUrl);
ed.on('layout', syncUrl);
