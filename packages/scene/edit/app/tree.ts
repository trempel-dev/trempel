// tree.ts — the layers panel: the merged tree (base elements selectable, heir inserts grey), drag
// and drop → node.reorder / node.reparent, double click on the name → node.setId, the eye and the
// lock (this session only, never written), <defs> folded by default, a context menu.

import type { Editor, Row } from './editor';
import { parentPath } from '../geometry';

const CONTAINERS = new Set(['svg', 'g', 'defs', 'clipPath']);

const h = (tag: string, cls = '', text?: string): HTMLElement => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

export class Tree {
  private dragging: string | null = null;

  constructor(
    private readonly ed: Editor,
    private readonly ul: HTMLElement,
    private readonly menu: (x: number, y: number) => void,
  ) {
    for (const e of ['render', 'selection', 'doc'] as const) ed.on(e, () => this.draw());
  }

  draw(): void {
    const ed = this.ed;
    const ul = this.ul;
    const scroll = ul.scrollTop;
    ul.replaceChildren();
    const walk = (r: Row, depth: number): void => {
      ul.append(this.row(r, depth));
      if (r.path != null && this.ed.collapsed.has(r.path)) return;
      for (const c of r.children) walk(c, depth + 1);
    };
    for (const r of ed.rows) walk(r, 0);
    ul.scrollTop = scroll;
    const first = ul.querySelector('li.sel');
    if (first && 'scrollIntoView' in first) (first as HTMLElement).scrollIntoView({ block: 'nearest' });
  }

  private row(r: Row, depth: number): HTMLElement {
    const ed = this.ed;
    const li = h('li');
    li.style.paddingLeft = `${4 + depth * 12}px`;
    const path = r.path;
    if (path == null) li.classList.add('foreign');
    if (path != null && ed.selection.includes(path)) li.classList.add('sel');
    if (path != null && path === ed.scope && path !== '') li.classList.add('scope');
    if (path != null) li.dataset.path = path;

    const tw = h('span', 'tw', r.children.length ? (path != null && ed.collapsed.has(path) ? '▸' : '▾') : '');
    tw.onclick = (e) => {
      e.stopPropagation();
      if (path == null || !r.children.length) return;
      if (ed.collapsed.has(path)) ed.collapsed.delete(path);
      else ed.collapsed.add(path);
      this.draw();
    };
    li.append(tw);
    li.append(h('span', 'tag', `<${r.tag}>`));
    const name = h('span', 'name', r.id ? `#${r.id}` : path == null ? '(heir)' : '');
    if (r.type) name.textContent += ` ⧉${r.type}`;
    li.append(name);
    // v0.9: an instance — one node; its rows below are the prefab's (read-only, grey)
    if (r.href != null) {
      li.classList.add('instance');
      const b = h('span', 'href', `⟶ ${r.href}`);
      b.title = 'prefab instance: double-click opens the prefab';
      li.append(b);
    }
    // v0.8 badges: draw order among siblings, blend mode, sprite variants
    if (r.z != null) {
      const b = h('span', 'badge z', `z${r.z}`);
      b.title = `data-z=${r.z}: order among siblings`;
      li.append(b);
    }
    if (r.blend && r.blend !== 'normal') {
      const b = h('span', 'badge blend', r.blend === 'plus-lighter' ? '✚' : r.blend === 'multiply' ? '✕' : '◐');
      b.title = `mix-blend-mode: ${r.blend}`;
      li.append(b);
    }
    if (r.views) {
      const b = h('span', 'badge views', '⧉');
      b.title = `data-views: ${r.views}`;
      li.append(b);
    }
    li.title =
      path == null
        ? r.id?.includes('/')
          ? 'inside an instance — edited in the prefab (double-click the instance)'
          : 'inserted by the heir — drawn, edited in .tml.svg'
        : `path ${path || '(root)'}`;

    // 2.3: a component the heir inserts (an effect node) — inspected by its id
    if (path == null && r.id && r.type && !r.id.includes('/')) {
      li.classList.add('inspectable');
      if (ed.inspected === r.id) li.classList.add('sel');
      li.onclick = () => ed.inspect(r.id!);
    }
    if (path == null || path === '') return li;

    const ico = h('span', 'ico');
    const eye = h('button', ed.hidden.has(path) ? 'off' : '', ed.hidden.has(path) ? '◌' : '●') as HTMLButtonElement;
    eye.title = 'show/hide (in the editor only)';
    eye.onclick = (e) => {
      e.stopPropagation();
      ed.toggleHidden(path);
    };
    const lock = h('button', ed.locked.has(path) ? 'off' : '', ed.locked.has(path) ? '🔒' : '·') as HTMLButtonElement;
    lock.title = 'lock: not selectable on the stage (in the editor only)';
    lock.onclick = (e) => {
      e.stopPropagation();
      ed.toggleLocked(path);
    };
    ico.append(eye, lock);
    li.append(ico);

    li.onclick = (e) => ed.select([path], { add: e.shiftKey || e.metaKey, scope: parentPath(path) });
    li.oncontextmenu = (e) => {
      e.preventDefault();
      if (!ed.selection.includes(path)) ed.select([path], { scope: parentPath(path) });
      this.menu(e.clientX, e.clientY);
    };
    name.ondblclick = (e) => {
      e.stopPropagation();
      if (r.href != null) void ed.openPrefab(path);
      else this.rename(li, name, path, r.id ?? '');
    };
    if (r.href != null) {
      li.ondblclick = (e) => {
        e.stopPropagation();
        void ed.openPrefab(path);
      };
    }

    // drag and drop
    li.draggable = true;
    li.ondragstart = (e) => {
      this.dragging = path;
      e.dataTransfer?.setData('text/plain', path);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    };
    li.ondragend = () => {
      this.dragging = null;
      this.clearDrop();
    };
    li.ondragover = (e) => {
      const from = this.dragging;
      if (from == null || from === path || path.startsWith(from + '/')) return;
      e.preventDefault();
      this.clearDrop();
      li.classList.add(`drop-${this.zone(e, li, r.tag)}`);
    };
    li.ondragleave = () => li.classList.remove('drop-before', 'drop-after', 'drop-into');
    li.ondrop = (e) => {
      e.preventDefault();
      const from = this.dragging;
      this.dragging = null;
      this.clearDrop();
      if (from == null || from === path) return;
      this.drop(from, path, this.zone(e, li, r.tag));
    };
    return li;
  }

  private zone(e: DragEvent, li: HTMLElement, tag: string): 'before' | 'after' | 'into' {
    const r = li.getBoundingClientRect();
    const k = (e.clientY - r.top) / r.height;
    if (CONTAINERS.has(tag) && k > 0.3 && k < 0.7) return 'into';
    return k < 0.5 ? 'before' : 'after';
  }

  private clearDrop(): void {
    for (const li of this.ul.querySelectorAll('.drop-before, .drop-after, .drop-into')) li.classList.remove('drop-before', 'drop-after', 'drop-into');
  }

  /** Move `from` before/after/into `to`: node.reorder within one parent, node.reparent across. */
  drop(from: string, to: string, where: 'before' | 'after' | 'into'): void {
    const ed = this.ed;
    const node = ed.ref(from);
    const toNode = ed.node(to);
    if (!toNode) return;
    if (where === 'into') {
      const res = ed.exec('node.reparent', { node, parent: ed.ref(to) });
      if (res?.ok) ed.select([`${to}/${toNode.children.length - (parentPath(from) === to ? 1 : 0)}`]);
      return;
    }
    const parent = parentPath(to);
    const toIdx = Number(to.split('/').pop());
    const fromIdx = Number(from.split('/').pop());
    if (parentPath(from) === parent) {
      let index = where === 'before' ? toIdx : toIdx + 1;
      if (fromIdx < index) index--;
      if (index === fromIdx) return;
      const res = ed.exec('node.reorder', { node, index });
      if (res?.ok) ed.select([parent === '' ? String(index) : `${parent}/${index}`], { scope: parent });
      return;
    }
    // another parent: the target's index may shift when `from` was before it in a common ancestor
    const index = where === 'before' ? toIdx : toIdx + 1;
    const res = ed.exec('node.reparent', { node, parent: ed.ref(parent), index });
    if (res?.ok) {
      // `from` was an earlier sibling of one of the target's ancestors: that ancestor moved up by one
      const newParent = isAncestorShift(from, parent) ? shiftPath(parent, from) : parent;
      ed.select([newParent === '' ? String(index) : `${newParent}/${index}`], { scope: newParent });
    }
  }

  private rename(li: HTMLElement, name: HTMLElement, path: string, id: string): void {
    const input = document.createElement('input');
    input.value = id;
    li.draggable = false;
    name.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (commit: boolean): void => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      if (commit && v && v !== id) this.ed.exec('node.setId', { node: this.ed.ref(path), id: v });
      this.draw();
    };
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    };
    input.onblur = () => finish(true);
  }
}

/** True when `from` sits before an ancestor of (or at) `parent` among that ancestor's siblings. */
function isAncestorShift(from: string, parent: string): boolean {
  const fp = parentPath(from);
  const fi = Number(from.split('/').pop());
  const parts = parent === '' ? [] : parent.split('/');
  const base = fp === '' ? [] : fp.split('/');
  if (parts.length <= base.length) return false;
  if (base.join('/') !== parts.slice(0, base.length).join('/')) return false;
  return fi < Number(parts[base.length]);
}

/** `path` after `removed` left its parent (an earlier sibling of one of path's ancestors). */
function shiftPath(path: string, removed: string): string {
  const base = parentPath(removed);
  const parts = path.split('/');
  const k = base === '' ? 0 : base.split('/').length;
  parts[k] = String(Number(parts[k]) - 1);
  return parts.join('/');
}
