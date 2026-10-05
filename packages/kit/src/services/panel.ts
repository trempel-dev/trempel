// panel.ts — the services dev panel (web build, ?services=1): every contract, who implements it
// (mock / the adapter's name), its state, the mock modes (fail, latency, the contract's own) and
// the log of calls and events. Loaded by createGame through a dynamic import the youtube build
// folds away (the build gate checks its marker is absent).

import type { Services } from './services.js';

export const PANEL_ID = 'trempel-services';

const css = `#${PANEL_ID}{position:fixed;top:8px;right:8px;width:320px;max-height:calc(100vh - 16px);overflow:auto;z-index:2000;
background:rgba(16,18,26,.92);color:#e6e8ee;font:11px/1.35 ui-monospace,Menlo,monospace;border-radius:8px;padding:8px;box-shadow:0 4px 18px rgba(0,0,0,.4)}
#${PANEL_ID} h4{margin:0 0 6px;font-size:12px;display:flex;justify-content:space-between}
#${PANEL_ID} .c{border-top:1px solid #333a4a;padding:5px 0}
#${PANEL_ID} .n{font-weight:bold;color:#9fd3ff}#${PANEL_ID} .i{color:#9aa3b5}
#${PANEL_ID} .s{white-space:pre-wrap;word-break:break-all;color:#cfe8c4}
#${PANEL_ID} label{margin-right:8px;white-space:nowrap}#${PANEL_ID} input[type=number]{width:52px}
#${PANEL_ID} .log{border-top:1px solid #333a4a;margin-top:4px;padding-top:4px;color:#b8bfcc}
#${PANEL_ID} .fail{color:#ff8a8a}#${PANEL_ID} .event{color:#ffd27a}
#${PANEL_ID} button{font:inherit;background:#2b3245;color:inherit;border:0;border-radius:4px;padding:1px 6px;cursor:pointer}`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

const short = (v: unknown) => {
  const s = v === undefined ? '' : JSON.stringify(v);
  return s && s.length > 60 ? s.slice(0, 57) + '…' : (s ?? '');
};

/** Mount the panel; returns its removal. */
export function installServicesPanel(services: Services): () => void {
  document.getElementById(PANEL_ID)?.remove();
  const root = el('div', { id: PANEL_ID });
  root.setAttribute('data-testid', PANEL_ID);
  const style = el('style', { textContent: css });
  // A phone-sized window: start folded (the toggle opens it over the game).
  let collapsed = innerWidth < 700;
  let queued = false;

  const render = () => {
    queued = false;
    root.replaceChildren();
    const toggle = el('button', { textContent: collapsed ? '+' : '–', onclick: () => ((collapsed = !collapsed), render()) });
    root.append(el('h4', {}, 'services', toggle));
    if (collapsed) return;
    for (const info of services.info()) {
      const box = el('div', { className: 'c' });
      box.setAttribute('data-contract', info.name);
      box.append(el('div', {}, el('span', { className: 'n' }, info.name), ' ', el('span', { className: 'i' }, `← ${info.impl}`)));
      if (Object.keys(info.state).length) box.append(el('div', { className: 's' }, JSON.stringify(info.state)));
      if (info.impl === 'mock') {
        const modes = el('div');
        const fail = el('select');
        for (const v of ['never', '0.5', 'always']) fail.append(el('option', { value: v, textContent: `fail ${v}`, selected: String(info.modes.fail ?? 'never') === v }));
        fail.onchange = () => services.mock(info.name, { fail: fail.value === 'always' || fail.value === 'never' ? fail.value : Number(fail.value) });
        const lat = el('input', { type: 'number', min: '0', step: '100', value: String(info.modes.latency ?? 0), title: 'latency, ms' });
        lat.onchange = () => services.mock(info.name, { latency: Number(lat.value) || 0 });
        modes.append(fail, ' ', el('label', {}, 'ms ', lat));
        for (const m of info.custom) {
          const cb = el('input', { type: 'checkbox', checked: !!info.modes[m] });
          cb.onchange = () => services.mock(info.name, { [m]: cb.checked });
          modes.append(el('label', {}, cb, ' ', m));
        }
        box.append(modes);
      }
      root.append(box);
    }
    const log = el('div', { className: 'log' });
    for (const e of services.log.slice(-30).reverse()) {
      const line = el('div', { className: e.kind === 'fail' ? 'fail' : e.kind === 'event' ? 'event' : '' });
      line.textContent = e.kind === 'provide' && e.name !== 'modes' ? `${e.contract} ← ${e.name}` : `${e.contract}.${e.name} ${e.kind === 'call' ? '(' + short(e.data).replace(/^\[|\]$/g, '') + ')' : e.kind === 'ok' ? '→ ' + short(e.data) : e.kind === 'fail' ? '✗ ' + short(e.data) : e.kind === 'event' ? '! ' + short(e.data) : e.name === 'modes' ? '= ' + short(e.data) : ''}`;
      log.append(line);
    }
    root.append(log);
  };
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(render);
  };
  const off = services.watch(schedule);
  document.head.append(style);
  document.body.append(root);
  render();
  return () => {
    off();
    root.remove();
    style.remove();
  };
}
