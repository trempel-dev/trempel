// server.ts — the hub page: a local HTTP server (127.0.0.1) with a JSON API over the same engine
// as the CLI, and the page itself (`ui/`). Requests that change something are POSTs with
// `X-Trempel-Hub: 1` (a page of another origin can't send it without a preflight the hub never
// answers); the Host must be local (no DNS rebinding).
//
//   GET  /api/state                     roots, projects (versions, git, pins, gates), services, templates
//   GET  /api/projects/:id              the project's actions (by layer, shown/off/overridden), runs
//   POST /api/projects/:id/run          { action, input, force } → the run
//   GET  /api/runs/:id                  the run's state
//   GET  /api/runs/:id/log?from=N       { text, size } — the log from byte N
//   POST /api/runs/:id/stop             stop its process tree
//   POST /api/projects                  { path } — add a project by hand; { path, remove: true }
//   POST /api/roots                     { roots: [...] }
//   POST /api/new                       { template, dir, name? } — a project from a template

import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { HubError, projectActions, startAction } from './engine.js';
import { expandHome, loadConfig, saveConfig } from './home.js';
import { HUB_PACKAGE } from './layers.js';
import { gitState, isProject, scanProjects, type ProjectInfo } from './project.js';
import { activeServices, listRuns, logFile, readRun, stopRun, type RunState } from './runs.js';
import { createProject, listTemplates } from './templates.js';

export interface HubServer {
  url: string;
  port: number;
  server: Server;
  close(): Promise<void>;
}

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    throw new HubError('E_HUB_API: the body is not JSON.', 2);
  }
}

function projects(): ProjectInfo[] {
  const cfg = loadConfig();
  return scanProjects(cfg.roots, cfg.projects, cfg.depth);
}

function findProject(id: string): ProjectInfo {
  const p = projects().find((x) => x.id === id);
  if (!p) throw new HubError(`E_HUB_PROJECT: no project ${id}.`, 4);
  return p;
}

/** The last finished run of each `gates` action. */
function gates(runs: RunState[], ids: Set<string>): { action: string; status: string; code: number | null; at?: string }[] {
  const out = new Map<string, { action: string; status: string; code: number | null; at?: string }>();
  for (const r of runs) {
    if (r.group !== 'gates' || !ids.has(r.action) || out.has(r.action) || r.status === 'running' || r.status === 'starting' || r.status === 'ready') continue;
    out.set(r.action, { action: r.action, status: r.status, code: r.code, at: r.endedAt });
  }
  return [...out.values()];
}

async function state(): Promise<unknown> {
  const cfg = loadConfig();
  const list = scanProjects(cfg.roots, cfg.projects, cfg.depth);
  const rows = await Promise.all(
    list.map(async (p) => {
      const pa = await projectActions(p);
      const runs = listRuns({ projectId: p.id, limit: 100 });
      const shown = [...pa.actions.values()].filter((a) => pa.visible.has(a.id));
      return {
        ...p,
        git: pa.git,
        pins: shown.filter((a) => a.pin).map((a) => ({ id: a.id, title: a.title, icon: a.icon, kind: a.kind, confirm: a.confirm, inputs: a.inputs, running: pa.running.get(a.id)?.id ?? null })),
        gates: gates(runs, new Set(shown.filter((a) => a.group === 'gates').map((a) => a.id))),
        services: [...pa.running.values()].map((r) => ({ id: r.id, action: r.action, url: r.url, status: r.status })),
        errors: pa.errors.length,
      };
    }),
  );
  return { roots: cfg.roots, projects: rows, services: activeServices(), templates: listTemplates().map((t) => ({ name: t.name, description: t.description })) };
}

async function projectPage(id: string): Promise<unknown> {
  const p = findProject(id);
  const pa = await projectActions(p);
  return {
    project: p,
    git: pa.git,
    layers: pa.sources,
    errors: pa.errors,
    actions: pa.all.map((a) => {
      const winner = pa.actions.get(a.id)!;
      return {
        ...a,
        wins: winner === a,
        overriddenBy: winner === a ? null : winner.layer,
        shown: winner === a && pa.visible.has(a.id),
        running: winner === a ? pa.running.get(a.id) ?? null : null,
      };
    }),
    runs: listRuns({ projectId: p.id, limit: 50 }),
  };
}

function staticFile(res: ServerResponse, path: string): boolean {
  const dir = join(HUB_PACKAGE, 'ui');
  const file = resolve(dir, '.' + (path === '/' ? '/index.html' : path));
  if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile()) return false;
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(readFileSync(file));
  return true;
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const host = (req.headers.host ?? '').replace(/:\d+$/, '');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) return send(res, 403, { error: 'E_HUB_HOST: the hub answers on localhost only.' });
  if (req.method === 'POST' && req.headers['x-trempel-hub'] !== '1') return send(res, 403, { error: 'E_HUB_API: a POST needs X-Trempel-Hub: 1.' });
  let m: RegExpExecArray | null;
  if (req.method === 'GET' && path === '/api/state') return send(res, 200, await state());
  if (req.method === 'GET' && (m = /^\/api\/projects\/([0-9a-f]+)$/.exec(path))) return send(res, 200, await projectPage(m[1]));
  if (req.method === 'POST' && (m = /^\/api\/projects\/([0-9a-f]+)\/run$/.exec(path))) {
    const b = await body(req);
    const p = findProject(m[1]);
    const r = await startAction(p, String(b.action ?? ''), { input: (b.input as Record<string, unknown>) ?? {}, force: b.force === true });
    return send(res, 200, r);
  }
  if ((m = /^\/api\/runs\/([\w-]+)(\/log|\/stop)?$/.exec(path))) {
    const id = m[1];
    if (!readRun(id)) return send(res, 404, { error: `E_HUB_RUN: no run ${id}.` });
    if (req.method === 'GET' && !m[2]) return send(res, 200, readRun(id));
    if (req.method === 'GET' && m[2] === '/log') {
      const from = Math.max(0, Number(url.searchParams.get('from') ?? 0) || 0);
      let buf: Buffer;
      try {
        buf = readFileSync(logFile(id));
      } catch {
        buf = Buffer.alloc(0);
      }
      const start = from > buf.length ? 0 : from;
      return send(res, 200, { text: buf.subarray(Math.max(start, buf.length - (2 << 20))).toString('utf8'), size: buf.length });
    }
    if (req.method === 'POST' && m[2] === '/stop') return send(res, 200, await stopRun(id));
  }
  if (req.method === 'POST' && path === '/api/projects') {
    const b = await body(req);
    const d = resolve(expandHome(String(b.path ?? '')));
    const cfg = loadConfig();
    if (b.remove === true) saveConfig({ projects: cfg.projects.filter((p) => p !== d) });
    else {
      if (!isProject(d)) throw new HubError(`E_HUB_PROJECT: ${d} is not a Trempel project.`, 2);
      saveConfig({ projects: [...new Set([...cfg.projects, d])] });
    }
    return send(res, 200, { ok: true, path: d });
  }
  if (req.method === 'POST' && path === '/api/roots') {
    const b = await body(req);
    if (!Array.isArray(b.roots)) throw new HubError('E_HUB_API: { roots: [ … ] }', 2);
    return send(res, 200, saveConfig({ roots: b.roots.map((r) => resolve(expandHome(String(r)))) }));
  }
  if (req.method === 'POST' && path === '/api/new') {
    const b = await body(req);
    const lines: string[] = [];
    const dir = createProject({ template: String(b.template ?? ''), dest: resolve(expandHome(String(b.dir ?? ''))), name: typeof b.name === 'string' && b.name ? b.name : undefined, log: (l) => lines.push(l) });
    const cfg = loadConfig();
    if (!cfg.roots.some((r) => dir.startsWith(r))) saveConfig({ projects: [...new Set([...cfg.projects, dir])] });
    return send(res, 200, { ok: true, path: dir, log: lines, git: await gitState(dir) });
  }
  if (req.method === 'GET' && !path.startsWith('/api/') && staticFile(res, path)) return;
  send(res, 404, { error: `E_HUB_API: ${req.method} ${path} — not found.` });
}

export function startHub(opts: { port?: number; host?: string } = {}): Promise<HubServer> {
  const server = createServer((req, res) => {
    route(req, res).catch((e: unknown) => {
      const status = e instanceof HubError ? (e.code === 4 ? 404 : e.code === 3 ? 409 : 400) : 500;
      send(res, status, { error: e instanceof Error ? e.message : String(e) });
    });
  });
  const host = opts.host ?? '127.0.0.1';
  return new Promise((res, rej) => {
    server.once('error', rej);
    server.listen(opts.port ?? 5170, host, () => {
      const a = server.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      res({
        url: `http://127.0.0.1:${port}/`,
        port,
        server,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
