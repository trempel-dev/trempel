// palette.ts — a command-palette list over the page: a search field and items, ↑/↓ + Enter or a
// click picks, Esc cancels. The ⌘K macro palette and the href file picker (dev server) use it.

export interface PaletteItem {
  label: string;
  hint?: string;
  value: string;
}

const h = (tag: string, cls = '', text?: string): HTMLElement => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

let open: ((v: string | null) => void) | null = null;

/** Whether a palette is on screen (the page's hot keys stay off meanwhile). */
export const paletteOpen = (): boolean => open != null;

/** Words of the query, each somewhere in label + hint (case-insensitive). */
export function matches(item: PaletteItem, query: string): boolean {
  const hay = `${item.label} ${item.hint ?? ''}`.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

/** Show the palette; resolves the picked item's value (null — cancelled). */
export function openPalette(opts: { placeholder: string; items: PaletteItem[]; empty: string }): Promise<string | null> {
  open?.(null);
  return new Promise((resolve) => {
    const root = h('div', '');
    root.id = 'palette';
    const box = h('div', 'box');
    const input = document.createElement('input');
    input.placeholder = opts.placeholder;
    input.spellcheck = false;
    const ul = h('ul');
    box.append(input, ul);
    root.append(box);
    document.body.append(root);
    let shown: PaletteItem[] = [];
    let k = 0;
    const done = (v: string | null): void => {
      if (open !== done) return;
      open = null;
      root.remove();
      resolve(v);
    };
    open = done;
    const draw = (): void => {
      shown = opts.items.filter((i) => matches(i, input.value));
      k = Math.min(k, Math.max(0, shown.length - 1));
      ul.replaceChildren();
      if (!shown.length) ul.append(h('li', 'empty', opts.items.length ? 'ничего не найдено' : opts.empty));
      shown.forEach((it, i) => {
        const li = h('li', i === k ? 'on' : '');
        li.append(h('span', '', it.label));
        if (it.hint) li.append(h('span', 'hint', it.hint));
        li.onpointerdown = (e) => {
          e.preventDefault();
          done(it.value);
        };
        ul.append(li);
      });
      (ul.children[k] as HTMLElement | undefined)?.scrollIntoView?.({ block: 'nearest' });
    };
    input.oninput = () => {
      k = 0;
      draw();
    };
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') done(null);
      else if (e.key === 'Enter') {
        e.preventDefault();
        if (shown[k]) done(shown[k].value);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (shown.length) k = (k + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length;
        draw();
      }
    };
    root.onpointerdown = (e) => {
      if (e.target === root) done(null);
    };
    draw();
    input.focus();
  });
}
