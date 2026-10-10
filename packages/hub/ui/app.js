// app.js — the hub page: projects, a project's actions and runs, processes, a new project.
// Everything goes through the hub's JSON API (the same engine as `trempel run`).

const $ = (sel) => document.querySelector(sel);
const view = $('#view');

/** h('div.card', { onclick }, ...children) — a DOM element; strings are text, never HTML. */
function h(tag, props, ...kids) {
  const [name, ...cls] = tag.split('.');
  const el = document.createElement(name);
  if (cls.length) el.className = cls.join(' ');
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    kids.unshift(props);
    props = null;
  }
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className += ' ' + v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

async function api(path, body) {
  const r = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Trempel-Hub': '1' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
  return data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 3500);
}

const ago = (iso) => {
  if (!iso) return '';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
};
const dur = (s) => (s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`);
const status = (r) => h(`span.st.st-${r.status}`, { 'data-testid': 'run-status' }, r.status, r.code !== null && r.code !== undefined && r.status !== 'exited' ? ` (${r.code})` : '');

function gitLine(git) {
  if (!git) return h('span.tag', 'no git');
  return h(
    'span.row',
    h(`span.dot${git.dirty ? '.dirty' : ''}`, { title: git.dirty ? `${git.changes} changed` : 'clean' }),
    h('span.mono', git.branch ?? 'detached'),
    git.dirty ? h('span.muted', `${git.changes} changed`) : h('span.muted', 'clean'),
    git.ahead ? h('span.tag', `↑${git.ahead}`) : null,
    git.behind ? h('span.tag', `↓${git.behind}`) : null,
  );
}

// ---- running an action ----------------------------------------------------------------------

/** Ask for the inputs (and the confirmation) of an action; null — cancelled. */
function askInputs(action) {
  if (!action.inputs.length && !action.confirm) return Promise.resolve({});
  const dlg = $('#dlg');
  $('#dlg-title').textContent = action.title;
  $('#dlg-note').textContent = action.confirm ?? '';
  const fields = $('#dlg-fields');
  fields.replaceChildren(
    ...action.inputs.map((inp) => {
      const label = inp.label ?? inp.name;
      let field;
      if (inp.type === 'select') field = h('select', { name: inp.name }, inp.options.map((o) => h('option', { value: o, selected: String(o) === String(inp.default) }, o)));
      else if (inp.type === 'bool') return h('label.inline', h('input', { type: 'checkbox', name: inp.name, checked: inp.default === true }), label);
      else field = h('input', { type: 'text', name: inp.name, value: inp.default ?? '', required: inp.required, placeholder: inp.type === 'file' ? 'path from the project root' : '' });
      return h('label', label, field);
    }),
  );
  $('#dlg-ok').textContent = action.confirm ? 'Run anyway' : 'Run';
  dlg.showModal();
  return new Promise((res) => {
    dlg.addEventListener(
      'close',
      () => {
        if (dlg.returnValue !== 'ok') return res(null);
        const input = {};
        for (const el of fields.querySelectorAll('[name]')) input[el.name] = el.type === 'checkbox' ? el.checked : el.value;
        res(input);
      },
      { once: true },
    );
  });
}

async function runAction(projectId, action) {
  const input = await askInputs(action);
  if (input === null) return null;
  try {
    const run = await api(`/api/projects/${projectId}/run`, { action: action.id, input });
    toast(`${action.title}: started`);
    return run;
  } catch (e) {
    toast(e.message);
    return null;
  }
}

async function stop(runId) {
  try {
    await api(`/api/runs/${runId}/stop`, {});
    toast('stopped');
  } catch (e) {
    toast(e.message);
  }
}

// ---- log panel -----------------------------------------------------------------------------

let logTimer = null;
function showLog(container, run) {
  clearInterval(logTimer);
  let from = 0;
  const pre = h('pre.log', { 'data-testid': 'log' });
  const head = h('div.row', h('strong', run.title), h('span.mono.muted', run.id), h('span', { 'data-testid': 'log-status' }, status(run)));
  container.replaceChildren(head, pre);
  const tick = async () => {
    try {
      const [log, st] = await Promise.all([api(`/api/runs/${run.id}/log?from=${from}`), api(`/api/runs/${run.id}`)]);
      if (log.size < from) pre.textContent = '';
      from = log.size;
      if (log.text) {
        const stick = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
        pre.textContent += log.text;
        if (stick) pre.scrollTop = pre.scrollHeight;
      }
      head.lastChild.replaceChildren(status(st));
      if (!['starting', 'running', 'ready'].includes(st.status)) clearInterval(logTimer);
    } catch {
      clearInterval(logTimer);
    }
  };
  void tick();
  logTimer = setInterval(tick, 500);
}

// ---- views ---------------------------------------------------------------------------------

async function projectsView() {
  const st = await api('/api/state');
  $('#svc-count').textContent = st.services.length || '';
  if (!st.projects.length) {
    return [h('h1', 'Projects'), h('p.empty', 'No projects under ', st.roots.join(', ') || '—', '. Change the roots in Settings or add a project there.')];
  }
  return [
    h('div.row', h('h1', 'Projects'), h('span.muted', `${st.projects.length} · roots: ${st.roots.join(', ')}`)),
    h(
      'div.grid',
      { 'data-testid': 'projects' },
      st.projects.map((p) =>
        h(
          'div.card',
          { 'data-testid': 'project-card', 'data-project': p.name },
          h('h3', h('a', { href: `#/p/${p.id}`, 'data-testid': 'project-link' }, p.name)),
          h('div.path', p.root),
          h('div.row', h('span.tag', { 'data-testid': 'kit-version' }, `kit ${p.kit ?? '—'}`), h('span.tag', `scene ${p.scene ?? '—'}`), p.manual ? h('span.tag', 'added') : null),
          gitLine(p.git),
          p.gates.length ? h('div.row', h('span.muted', 'gates'), p.gates.map((g) => h(`span.st.st-${g.status}`, { title: g.at ?? '' }, `${g.action} ${g.status === 'exited' ? '✓' : '✗'}`))) : null,
          p.services.length ? h('div.row', p.services.map((s) => h('a', { href: s.url, target: '_blank', rel: 'noopener' }, `${s.action} ↗`))) : null,
          p.pins.length
            ? h(
                'div.row',
                p.pins.map((a) =>
                  a.running
                    ? h('button.danger', { onclick: async () => (await stop(a.running), render()) }, `Stop ${a.title}`)
                    : h('button', { onclick: async () => (await runAction(p.id, a), render()) }, a.title),
                ),
              )
            : null,
        ),
      ),
    ),
  ];
}

async function projectView(id) {
  const d = await api(`/api/projects/${id}`);
  const p = d.project;
  const shown = d.actions.filter((a) => a.shown);
  const rest = d.actions.filter((a) => !a.shown);
  const groups = new Map();
  for (const a of shown) {
    if (!groups.has(a.group)) groups.set(a.group, []);
    groups.get(a.group).push(a);
  }
  const logBox = h('div', { 'data-testid': 'log-box' });
  const actionCard = (a) =>
    h(
      `div.action${a.shown ? '' : '.off'}`,
      { 'data-testid': 'action', 'data-action': a.id },
      h('div.row', h('span.t', a.title), h(`span.tag.layer-${a.layer}`, a.layer), a.kind === 'service' ? h('span.tag', 'service') : null),
      h('span.id', a.id),
      a.description ? h('span.muted.desc', { title: a.description }, a.description) : null,
      !a.wins ? h('span.muted', `overridden by ${a.overriddenBy}`) : !a.shown ? h('span.muted', `off: ${a.when.join(', ')}`) : null,
      a.shown
        ? a.running
          ? h(
              'div.row',
              a.running.url ? h('a', { href: a.running.url, target: '_blank', rel: 'noopener', 'data-testid': 'service-url' }, a.running.url) : null,
              status(a.running),
              h('button.danger', { 'data-testid': 'stop', onclick: async () => (await stop(a.running.id), render()) }, 'Stop'),
              h('button.ghost', { onclick: () => showLog(logBox, a.running) }, 'Log'),
            )
          : h(
              'div.row',
              h(
                'button.primary',
                {
                  'data-testid': 'run',
                  onclick: async () => {
                    const r = await runAction(p.id, a);
                    if (r) {
                      await render();
                      showLog($('[data-testid=log-box]'), r);
                    }
                  },
                },
                'Run',
              ),
            )
        : null,
    );
  return [
    h('div.row', h('a', { href: '#/' }, '← Projects')),
    h('h1', { 'data-testid': 'project-name' }, p.name),
    h('div.path', p.root),
    h('div.row', h('span.tag', `kit ${p.kit ?? '—'}`), h('span.tag', `scene ${p.scene ?? '—'}`), gitLine(d.git)),
    d.errors.length ? h('div.errors', d.errors.join('\n')) : null,
    [...groups].map(([g, list]) => [h('h2', g), h('div.actions', list.map(actionCard))]),
    rest.length ? h('details', h('summary', `${rest.length} more — off here or overridden by a higher layer`), h('div.actions', rest.map(actionCard))) : null,
    h('h2', 'Runs'),
    d.runs.length
      ? h(
          'table',
          { 'data-testid': 'runs' },
          h('tr', h('th', 'when'), h('th', 'action'), h('th', 'status'), h('th.hide-sm', 'took'), h('th.hide-sm', 'command')),
          d.runs.map((r) => {
            const tr = h(
              'tr',
              { style: 'cursor:pointer', onclick: () => (view.querySelectorAll('tr.sel').forEach((x) => x.classList.remove('sel')), tr.classList.add('sel'), showLog(logBox, r)) },
              h('td', ago(r.startedAt)),
              h('td', h('span.mono', r.action)),
              h('td', status(r)),
              h('td.hide-sm', dur(r.seconds)),
              h('td.hide-sm', h('span.mono.muted', r.command.length > 90 ? r.command.slice(0, 90) + '…' : r.command)),
            );
            return tr;
          }),
        )
      : h('p.muted', 'No runs yet.'),
    logBox,
    h('details', h('summary', 'Layers'), h('ul', d.layers.map((l) => h('li', h(`span.tag.layer-${l.layer}`, l.layer), ' ', h('span.mono', l.file), l.legacy ? h('span.muted', ' (the kit has no hub/actions.mdz — the npm scripts stand in)') : null)))),
  ];
}

async function processesView() {
  const st = await api('/api/state');
  $('#svc-count').textContent = st.services.length || '';
  const logBox = h('div');
  return [
    h('h1', 'Processes'),
    st.services.length
      ? h(
          'table',
          { 'data-testid': 'processes' },
          h('tr', h('th', 'project'), h('th', 'action'), h('th', 'URL'), h('th', 'up'), h('th', 'status'), h('th', '')),
          st.services.map((r) =>
            h(
              'tr',
              { 'data-testid': 'process', 'data-action': r.action },
              h('td', h('a', { href: `#/p/${r.projectId}` }, r.projectName)),
              h('td', h('span.mono', r.action)),
              h('td', r.url ? h('a', { href: r.url, target: '_blank', rel: 'noopener' }, r.url) : '—'),
              h('td', dur(r.seconds)),
              h('td', status(r)),
              h('td', h('div.row', h('button.ghost', { onclick: () => showLog(logBox, r) }, 'Log'), h('button.danger', { 'data-testid': 'stop', onclick: async () => (await stop(r.id), render()) }, 'Stop'))),
            ),
          ),
        )
      : h('p.empty', 'No services running.'),
    logBox,
  ];
}

async function newView() {
  const st = await api('/api/state');
  const out = h('pre.log', { hidden: true });
  const form = h(
    'form.panel',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        const f = new FormData(form);
        try {
          const r = await api('/api/new', { template: f.get('template'), dir: f.get('dir'), name: f.get('name') });
          out.hidden = false;
          out.textContent = [...r.log, `→ ${r.path}`].join('\n');
          toast('project created');
        } catch (err) {
          toast(err.message);
        }
      },
    },
    h('label', 'Template', h('select', { name: 'template' }, st.templates.map((t) => h('option', { value: t.name }, `${t.name} — ${t.description.slice(0, 80)}`)))),
    h('label', 'Folder', h('input', { type: 'text', name: 'dir', required: true, value: st.roots[0] ? `${st.roots[0]}/my-game` : '' })),
    h('label', 'Package name (default — the folder name)', h('input', { type: 'text', name: 'name' })),
    h('p.muted', 'The template is copied, then git init and a first commit. Run npm install in it next (or the "terminal" action).'),
    h('button.primary', { type: 'submit' }, 'Create'),
  );
  return [h('h1', 'New project'), st.templates.length ? form : h('p.empty', 'No templates in this build of the hub.'), out];
}

async function settingsView() {
  const st = await api('/api/state');
  const roots = h('textarea', { rows: 4 }, st.roots.join('\n'));
  const add = h('input', { type: 'text', placeholder: '/path/to/project' });
  return [
    h('h1', 'Settings'),
    h(
      'div.panel',
      h('label', 'Roots to scan (one per line)', roots),
      h('button', { onclick: async () => (await api('/api/roots', { roots: roots.value.split('\n').map((s) => s.trim()).filter(Boolean) }), toast('saved')) }, 'Save roots'),
      h('label', 'Add a project by hand', add),
      h('button', { onclick: async () => { try { await api('/api/projects', { path: add.value }); toast('added'); } catch (e) { toast(e.message); } } }, 'Add'),
    ),
  ];
}

// ---- router ----------------------------------------------------------------------------------

let refresh = null;
async function render() {
  const hash = location.hash || '#/';
  const m = /^#\/p\/([0-9a-f]+)/.exec(hash);
  const nav = m ? 'projects' : hash.startsWith('#/processes') ? 'processes' : hash.startsWith('#/new') ? 'new' : hash.startsWith('#/settings') ? 'settings' : 'projects';
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('on', a.dataset.nav === nav));
  const keep = view.querySelector('[data-testid=log-box]')?.firstChild ? view.querySelector('[data-testid=log-box]') : null;
  try {
    const nodes = m ? await projectView(m[1]) : nav === 'processes' ? await processesView() : nav === 'new' ? await newView() : nav === 'settings' ? await settingsView() : await projectsView();
    view.replaceChildren(...nodes.flat(Infinity).filter(Boolean));
    if (keep && m) view.querySelector('[data-testid=log-box]')?.replaceWith(keep);
  } catch (e) {
    view.replaceChildren(h('p.errors', e.message));
  }
  clearInterval(refresh);
  if (nav === 'projects' || nav === 'processes') refresh = setInterval(() => !document.querySelector('dialog[open]') && render(), m ? 3000 : 5000);
}

window.addEventListener('hashchange', () => {
  clearInterval(logTimer);
  void render();
});
void render();
