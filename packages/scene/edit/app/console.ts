// console.ts — the «Консоль» tab of the bottom panel: a multi-line script over `tml`, ⌘Enter runs
// it (tml.run — one undo step), ↑/↓ walk the history (localStorage, per scene folder); the output
// shows the script's console.log, the result and errors.

import { formatValue, type Tml, type TmlSink } from './tml';

const PLACEHOLDER = "tml.nodes().filter(n => n.tag==='image').length\n\n⌘Enter — run (one ⌘Z step), ↑/↓ — history, ⌘K — macros";
const MAX_HISTORY = 100;
const MAX_LINES = 400;

export class ConsolePanel implements TmlSink {
  tml: Tml | null = null;
  private history: string[] = [];
  /** Position while walking the history (history.length — the draft). */
  private at = 0;
  private draft = '';
  private key = '';

  constructor(
    private readonly out: HTMLElement,
    private readonly input: HTMLTextAreaElement,
  ) {
    input.placeholder = PLACEHOLDER;
    input.spellcheck = false;
    input.addEventListener('keydown', (e) => this.keydown(e));
  }

  /** History store for a folder (its name): read it. */
  useStore(folder: string): void {
    this.key = `tml-console:${folder}`;
    try {
      const raw = localStorage.getItem(this.key);
      this.history = raw ? (JSON.parse(raw) as string[]).filter((x) => typeof x === 'string') : [];
    } catch {
      this.history = [];
    }
    this.at = this.history.length;
  }

  print(level: 'log' | 'warn' | 'error' | 'result' | 'input', parts: unknown[]): void {
    const line = document.createElement('div');
    line.className = `c-${level}`;
    line.textContent = (level === 'result' ? '← ' : level === 'input' ? '› ' : '') + parts.map(formatValue).join(' ');
    this.out.append(line);
    while (this.out.childElementCount > MAX_LINES) this.out.firstElementChild!.remove();
    this.out.scrollTop = this.out.scrollHeight;
  }

  clear(): void {
    this.out.replaceChildren();
  }

  /** Run what is in the field. */
  async submit(): Promise<void> {
    const code = this.input.value;
    if (!code.trim() || !this.tml) return;
    this.remember(code);
    this.input.value = '';
    this.print('input', [code]);
    await this.exec(() => this.tml!.run(code));
  }

  /** Run something (a script, a macro) and print its result or error here. */
  async exec(fn: () => Promise<unknown>): Promise<boolean> {
    try {
      const v = await fn();
      this.print('result', [v]);
      return true;
    } catch (e) {
      this.print('error', [e instanceof Error ? `${e.name === 'Error' ? '' : e.name + ': '}${e.message}` : e]);
      return false;
    }
  }

  private remember(code: string): void {
    if (this.history[this.history.length - 1] !== code) this.history.push(code);
    if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
    this.at = this.history.length;
    this.draft = '';
    try {
      if (this.key) localStorage.setItem(this.key, JSON.stringify(this.history));
    } catch {
      // private mode / quota: the history lives for the session only
    }
  }

  private keydown(e: KeyboardEvent): void {
    const ta = this.input;
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      void this.submit();
      return;
    }
    if (e.key === 'k' && (e.metaKey || e.ctrlKey)) return; // the palette (window handler)
    e.stopPropagation(); // the page's hot keys stay out of the field
    const firstLine = !ta.value.slice(0, ta.selectionStart).includes('\n');
    const lastLine = !ta.value.slice(ta.selectionEnd).includes('\n');
    if (e.key === 'ArrowUp' && firstLine && this.at > 0) {
      e.preventDefault();
      if (this.at === this.history.length) this.draft = ta.value;
      this.at--;
      ta.value = this.history[this.at];
    } else if (e.key === 'ArrowDown' && lastLine && this.at < this.history.length) {
      e.preventDefault();
      this.at++;
      ta.value = this.at === this.history.length ? this.draft : this.history[this.at];
    } else if (e.key === 'Escape') ta.blur();
  }
}
