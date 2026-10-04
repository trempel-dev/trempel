// commandpalette.ts — F3 (Blender; ⌘⇧P in the figma scheme): every core command of the registry,
// the transform operators and the folder's macros in one searchable list (name + description).
// A command with arguments opens a form built from its JSON Schema (string / number / boolean /
// enum / a pair of numbers; anything else — JSON text); `node` is prefilled with the selection.
// The command runs through the editor's exec (one undo entry, errors in the log).

import type { JSONSchema7 } from '../../editor/index.js';
import { openPalette, type PaletteItem } from './palette';

export interface CommandEntry {
  /** Registry name ('node.setId') or a pseudo-command ('op:G', 'macro:<name>'). */
  value: string;
  label: string;
  hint?: string;
}

const h = (tag: string, cls = '', text?: string): HTMLElement => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

let formOpen: ((v: Record<string, unknown> | null) => void) | null = null;

/** Whether the command form is on screen (the page's hot keys stay off meanwhile). */
export const commandFormOpen = (): boolean => formOpen != null;

/** The palette list: commands (name — description), then the extra entries (operators, macros). */
export function commandItems(registry: Record<string, { describe: string }>, extra: CommandEntry[] = []): PaletteItem[] {
  return [
    ...extra.map((e) => ({ label: e.label, hint: e.hint, value: e.value })),
    ...Object.entries(registry).map(([name, c]) => ({ label: name, hint: c.describe.length > 90 ? `${c.describe.slice(0, 88)}…` : c.describe, value: name })),
  ];
}

export function openCommandPalette(registry: Record<string, { describe: string }>, extra: CommandEntry[]): Promise<string | null> {
  return openPalette({ placeholder: 'Команда, оператор, макрос… (имя или описание)', items: commandItems(registry, extra), empty: 'команд нет' });
}

type Kind = 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'pair' | 'json';

/** How a property is edited in the form. */
export function fieldKind(s: JSONSchema7): Kind {
  if (s.enum) return 'enum';
  if (s.type === 'array' && s.minItems === 2 && s.maxItems === 2 && (s.items?.type === 'number' || s.items?.type === 'integer')) return 'pair';
  if (s.type === 'string' || s.type === 'number' || s.type === 'integer' || s.type === 'boolean') return s.type;
  return 'json';
}

/**
 * A form field's text → the argument value (undefined — left empty: omitted). Throws with a
 * human message when the text does not parse.
 */
export function parseField(s: JSONSchema7, raw: string, name: string): unknown {
  const text = raw.trim();
  const kind = fieldKind(s);
  if (kind === 'boolean') return raw === '' ? undefined : raw === 'true';
  if (text === '') return kind === 'string' && raw !== '' ? raw : undefined;
  switch (kind) {
    case 'string':
      return raw;
    case 'number':
    case 'integer': {
      const v = Number(text.replace(',', '.'));
      if (!Number.isFinite(v) || (kind === 'integer' && !Number.isInteger(v))) throw new Error(`${name}: ожидается ${kind === 'integer' ? 'целое ' : ''}число`);
      return v;
    }
    case 'enum': {
      const hit = s.enum!.find((e) => String(e) === raw);
      return hit;
    }
    case 'pair': {
      const v = text.split(/[\s,;]+/).map(Number);
      if (v.length !== 2 || !v.every(Number.isFinite)) throw new Error(`${name}: два числа через пробел`);
      return v;
    }
    default:
      // JSON when it parses (numbers, null, arrays), else the text itself
      try {
        return JSON.parse(text);
      } catch {
        return raw;
      }
  }
}

/** The form for a command's schema; resolves the arguments (null — cancelled). */
export function openCommandForm(name: string, describe: string, schema: JSONSchema7, defaults: Record<string, unknown> = {}): Promise<Record<string, unknown> | null> {
  formOpen?.(null);
  return new Promise((resolve) => {
    const root = h('div');
    root.id = 'cmd-form';
    const box = h('form', 'box') as HTMLFormElement;
    box.append(h('h4', '', name), h('p', 'muted', describe));
    const props = Object.entries(schema.properties ?? {});
    const required = new Set(schema.required ?? []);
    const read: (() => [string, unknown])[] = [];
    for (const [key, s] of props) {
      const row = h('label', 'row');
      row.append(h('span', 'key', `${key}${required.has(key) ? ' *' : ''}`));
      const kind = fieldKind(s);
      const def = defaults[key];
      let input: HTMLInputElement | HTMLSelectElement;
      if (kind === 'enum' || kind === 'boolean') {
        const sel = document.createElement('select');
        const opts = kind === 'enum' ? s.enum!.map(String) : ['true', 'false'];
        if (!required.has(key) || def === undefined) sel.append(new Option('—', ''));
        for (const o of opts) sel.append(new Option(o, o));
        sel.value = def === undefined ? '' : String(def);
        input = sel;
      } else {
        const inp = document.createElement('input');
        inp.spellcheck = false;
        if (kind === 'number' || kind === 'integer') inp.inputMode = 'decimal';
        inp.value = def === undefined ? '' : Array.isArray(def) ? def.join(' ') : typeof def === 'object' ? JSON.stringify(def) : String(def);
        inp.placeholder = kind === 'pair' ? 'x y' : s.description ?? (kind === 'json' ? 'JSON или текст' : kind);
        input = inp;
      }
      input.name = key;
      input.title = s.description ?? '';
      row.append(input);
      box.append(row);
      read.push(() => [key, parseField(s, input.value, key)]);
    }
    const err = h('div', 'err');
    const buttons = h('div', 'row buttons');
    const ok = h('button', 'on', 'выполнить') as HTMLButtonElement;
    ok.type = 'submit';
    const cancel = h('button', '', 'отмена') as HTMLButtonElement;
    cancel.type = 'button';
    buttons.append(cancel, ok);
    box.append(err, buttons);
    root.append(box);
    document.body.append(root);
    const done = (v: Record<string, unknown> | null): void => {
      if (formOpen !== done) return;
      formOpen = null;
      root.remove();
      resolve(v);
    };
    formOpen = done;
    box.onsubmit = (e) => {
      e.preventDefault();
      try {
        const args: Record<string, unknown> = {};
        for (const f of read) {
          const [k, v] = f();
          if (v !== undefined) args[k] = v;
        }
        const missing = [...required].filter((k) => args[k] === undefined);
        if (missing.length) throw new Error(`не заполнено: ${missing.join(', ')}`);
        done(args);
      } catch (x) {
        err.textContent = x instanceof Error ? x.message : String(x);
      }
    };
    cancel.onclick = () => done(null);
    root.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') done(null);
    };
    root.onpointerdown = (e) => {
      if (e.target === root) done(null);
    };
    const first = box.querySelector<HTMLElement>('input, select');
    // the first empty field (the node is usually prefilled)
    const empty = [...box.querySelectorAll<HTMLInputElement>('input')].find((i) => !i.value);
    (empty ?? first ?? ok).focus();
    if (!props.length) ok.focus();
  });
}
