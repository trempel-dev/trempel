// actions.ts — an action as data and its mdz form. Any `actions.mdz` (the hub's, the user's, the
// kit's) and `.trempel/project.mdz` keep actions under one `## actions` heading, an action per
// `### <id>` heading, its fields as `$field: value` lines (the md of @trempel/scene, src/md/):
//
//   ## actions
//
//   ### levels
//   $title: Generate levels
//   $icon: sparkles
//   $group: content
//   $input.world: { type: "select", options: [1, 2, 3] }
//   $input.count: { type: "text", default: 5 }
//   $shell: node tools/gen-levels.js --world ${input.world} --count ${input.count}
//   $confirm: Spends API credits
//
// `$shell` — one command or a list (`$[npm ci, npm test]`, run in order, the first failure stops);
// a fenced ```sh block in the action's text is the same as a list of its lines. `$js` — a module,
// `export default async (ctx) => …`. Everything else under the heading is notes for people.

import { parse as parseMd } from '@trempel/scene/internal/md/parse';
import type { AttributeValue, InterpolatedValue } from '@trempel/scene/internal/md/types';

export type Layer = 'hub' | 'user' | 'kit' | 'project';
export const LAYERS: readonly Layer[] = ['hub', 'user', 'kit', 'project'];

export type InputType = 'text' | 'select' | 'file' | 'bool';
const INPUT_TYPES: readonly InputType[] = ['text', 'select', 'file', 'bool'];

export interface ActionInput {
  name: string;
  type: InputType;
  label?: string;
  default?: string | number | boolean;
  /** `select` only. */
  options?: (string | number)[];
  /** No default and not given → the run is refused (a person is asked). Default: true without a default. */
  required: boolean;
}

export interface Action {
  id: string;
  title: string;
  icon?: string;
  group: string;
  pin: boolean;
  /** Exactly one of shell / js. */
  shell?: string[];
  js?: string;
  kind: 'once' | 'service';
  inputs: ActionInput[];
  confirm?: string;
  /** `service`: 'auto' — the hub picks a free port (`${port}`); a number — that port. */
  port?: 'auto' | number;
  /** `service`: the URL shown once it answers; default `http://localhost:${port}/`. */
  url?: string;
  /** Conditions, all must hold (`git`, `git.dirty`, `file:<path>`, `dep:<pkg>`, `script:<name>`, `running:<id>`, `platform:<os>`; `!` negates). */
  when: string[];
  /** Working folder from the project root (default — the root). */
  cwd?: string;
  env: Record<string, string>;
  /** Notes under the heading (shown as the action's description). */
  description?: string;
  /** Where the action came from. */
  layer: Layer;
  /** The file that declares it; `js` and an icon path resolve from the folder that holds `.trempel/` (project) or the file's folder. */
  source: string;
  /** Folder relative paths of `js` / `icon` resolve against. */
  base: string;
}

export interface ParsedActions {
  actions: Action[];
  errors: string[];
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const FIELDS = new Set(['title', 'icon', 'group', 'pin', 'shell', 'js', 'kind', 'confirm', 'port', 'url', 'when', 'cwd', 'env']);

/** `${…}` values of the md parser back to their text. */
function text(v: AttributeValue | undefined): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'object' && !Array.isArray(v) && 'raw' in v && 'placeholders' in v) return (v as InterpolatedValue).raw;
  if (typeof v === 'object') return undefined;
  return String(v);
}

function list(v: AttributeValue | undefined): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) return v.map((x) => (x !== null && typeof x === 'object' ? x.raw : String(x)));
  const t = text(v);
  return t === undefined ? undefined : [t];
}

/** The `## actions` section of a file: each `### id` → its lines. */
function sections(src: string): { id: string; line: number; lines: string[] }[] {
  const out: { id: string; line: number; lines: string[] }[] = [];
  let inActions = false;
  let fence = false;
  let cur: { id: string; line: number; lines: string[] } | null = null;
  src
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .forEach((line, i) => {
      const isFence = /^\s*(```|~~~)/.test(line);
      if (isFence) fence = !fence;
      const h = fence || isFence ? null : /^(#{1,6})\s+(.*?)\s*$/.exec(line);
      if (h) {
        const level = h[1].length;
        if (level <= 2) {
          inActions = level === 2 && h[2].toLowerCase() === 'actions';
          cur = null;
          return;
        }
        if (inActions && level === 3) {
          cur = { id: h[2], line: i + 1, lines: [] };
          out.push(cur);
          return;
        }
      }
      if (inActions && cur) cur.lines.push(line);
    });
  return out;
}

/** Lines of the ```sh / ```bash / ```shell fences of a body (the commands of an action). */
function fencedShell(body: string): { shell: string[]; rest: string } {
  const shell: string[] = [];
  const rest: string[] = [];
  let inFence = false;
  for (const line of body.split('\n')) {
    const f = /^\s*(```|~~~)\s*(\w*)\s*$/.exec(line);
    if (f && !inFence && /^(sh|bash|shell|zsh)$/.test(f[2])) {
      inFence = true;
      continue;
    }
    if (f && inFence) {
      inFence = false;
      continue;
    }
    if (inFence) {
      if (line.trim() && !line.trim().startsWith('#')) shell.push(line.trim());
    } else rest.push(line);
  }
  return { shell, rest: rest.join('\n').trim() };
}

function parseInput(name: string, v: AttributeValue, where: string, errors: string[]): ActionInput | null {
  let spec: Record<string, unknown>;
  if (typeof v === 'string') spec = { type: v };
  else if (v && typeof v === 'object' && !Array.isArray(v) && !('raw' in v && 'placeholders' in v)) spec = v as Record<string, unknown>;
  else {
    errors.push(`E_HUB_ACTION: ${where}: $input.${name} — a type (text, select, file, bool) or an object { type, default, options, label }.`);
    return null;
  }
  const type = (spec.type ?? 'text') as InputType;
  if (!INPUT_TYPES.includes(type)) {
    errors.push(`E_HUB_ACTION: ${where}: $input.${name} — unknown type "${String(spec.type)}" (text, select, file, bool).`);
    return null;
  }
  const input: ActionInput = { name, type, required: spec.default === undefined && type !== 'bool' };
  if (typeof spec.label === 'string') input.label = spec.label;
  if (spec.default !== undefined && spec.default !== null) {
    if (!['string', 'number', 'boolean'].includes(typeof spec.default)) {
      errors.push(`E_HUB_ACTION: ${where}: $input.${name} — default is a string, a number or a boolean.`);
      return null;
    }
    input.default = spec.default as string | number | boolean;
  }
  if (typeof spec.required === 'boolean') input.required = spec.required;
  if (type === 'select') {
    if (!Array.isArray(spec.options) || !spec.options.length || !spec.options.every((o) => typeof o === 'string' || typeof o === 'number')) {
      errors.push(`E_HUB_ACTION: ${where}: $input.${name} — a select needs options: [ … ] (strings or numbers).`);
      return null;
    }
    input.options = spec.options as (string | number)[];
  }
  return input;
}

/**
 * The actions of one file. Never throws: a broken action is left out with a line in `errors`
 * (`E_HUB_ACTION: <file>:<line> …`), the others stay.
 */
export function parseActions(src: string, opts: { layer: Layer; source: string; base: string }): ParsedActions {
  const out: ParsedActions = { actions: [], errors: [] };
  const seen = new Set<string>();
  for (const sec of sections(src)) {
    const where = `${opts.source}:${sec.line}`;
    if (!ID.test(sec.id)) {
      out.errors.push(`E_HUB_ACTION: ${where}: "${sec.id}" — an action id is letters, digits and _ . : - (from a letter or a digit).`);
      continue;
    }
    if (seen.has(sec.id)) {
      out.errors.push(`E_HUB_ACTION: ${where}: the action "${sec.id}" is declared twice in this file.`);
      continue;
    }
    seen.add(sec.id);
    let root;
    try {
      root = parseMd(sec.lines.join('\n')).root;
    } catch (e) {
      out.errors.push(`E_HUB_ACTION: ${where}: ${(e as Error).message}`);
      continue;
    }
    const f = new Map<string, AttributeValue>();
    const inputs: ActionInput[] = [];
    let bad = false;
    for (const a of root.attrs) {
      const key = a.key.join('.');
      if (key.startsWith('input.')) {
        const inp = parseInput(key.slice(6), a.value, where, out.errors);
        if (!inp) bad = true;
        else inputs.push(inp);
      } else if (FIELDS.has(key)) f.set(key, a.value);
      else {
        out.errors.push(`E_HUB_ACTION: ${where}: unknown field $${key} (${[...FIELDS].join(', ')}, input.<name>).`);
        bad = true;
      }
    }
    if (bad) continue;
    const body = text(root.body as AttributeValue) ?? '';
    const fenced = fencedShell(body);
    const shell = list(f.get('shell')) ?? (fenced.shell.length ? fenced.shell : undefined);
    const js = text(f.get('js'));
    if (!!shell === !!js) {
      out.errors.push(`E_HUB_ACTION: ${where}: "${sec.id}" needs exactly one of $shell (or a \`\`\`sh block) and $js.`);
      continue;
    }
    const kind = text(f.get('kind')) ?? 'once';
    if (kind !== 'once' && kind !== 'service') {
      out.errors.push(`E_HUB_ACTION: ${where}: $kind is once or service, not "${kind}".`);
      continue;
    }
    const portRaw = f.get('port');
    let port: Action['port'];
    if (portRaw !== undefined) {
      if (portRaw === 'auto') port = 'auto';
      else if (typeof portRaw === 'number' && Number.isInteger(portRaw) && portRaw > 0 && portRaw < 65536) port = portRaw;
      else {
        out.errors.push(`E_HUB_ACTION: ${where}: $port is auto or a port number.`);
        continue;
      }
    }
    const envRaw = f.get('env');
    const env: Record<string, string> = {};
    if (envRaw !== undefined) {
      if (!envRaw || typeof envRaw !== 'object' || Array.isArray(envRaw) || 'placeholders' in envRaw) {
        out.errors.push(`E_HUB_ACTION: ${where}: $env is an object { NAME: "value" }.`);
        continue;
      }
      for (const [k, v] of Object.entries(envRaw)) env[k] = String(v);
    }
    const action: Action = {
      id: sec.id,
      title: text(f.get('title')) ?? sec.id,
      group: text(f.get('group')) ?? 'other',
      pin: f.get('pin') === true,
      kind,
      inputs,
      when: list(f.get('when')) ?? [],
      env,
      layer: opts.layer,
      source: opts.source,
      base: opts.base,
    };
    if (shell) action.shell = shell;
    if (js) action.js = js;
    const icon = text(f.get('icon'));
    if (icon) action.icon = icon;
    const confirm = text(f.get('confirm'));
    if (confirm) action.confirm = confirm;
    if (port !== undefined) action.port = port;
    else if (kind === 'service') action.port = 'auto';
    const url = text(f.get('url'));
    if (url) action.url = url;
    const cwd = text(f.get('cwd'));
    if (cwd) action.cwd = cwd;
    if (fenced.rest) action.description = fenced.rest;
    out.actions.push(action);
  }
  return out;
}
