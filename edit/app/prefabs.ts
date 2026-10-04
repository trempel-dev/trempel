// prefabs.ts — the prefab palette (⌘P, v0.9): every scene of the open folder (and of the folders the
// consumer module names in `prefabs`) as a card with a preview; drag a card onto the stage — an
// instance at the drop point (prefab.instantiate), Enter / double click — at the view's centre.
//
// Previews are drawn by the same runtime as the stage (the scene at its rest pose, its own state
// file ignored) into an offscreen container and kept by the hash of the scene's documents — a
// redraw happens only when a prefab file changed.

import { Container, Rectangle } from 'pixi.js';
import { sha1 } from '../io';
import type { Editor } from './editor';

const h = (tag: string, cls = '', text?: string): HTMLElement => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

/** The drag payload type of a card (a folder-relative base path). */
export const PREFAB_MIME = 'text/tml-prefab';
const THUMB = { w: 160, h: 96 };

export class PrefabPalette {
  readonly root = h('div');
  private readonly search = document.createElement('input');
  private readonly cards = h('div', 'cards');
  private readonly note = h('div', 'note');
  private readonly thumbs = new Map<string, string>();
  private picked = 0;
  private items: string[] = [];

  constructor(
    private readonly ed: Editor,
    /** Folders of the consumer module (`trempel.view.ts` → prefabs), relative to the scene folder. */
    private readonly dirs: string[] = [],
  ) {
    this.root.id = 'prefabs';
    this.root.hidden = true;
    const head = h('header');
    this.search.placeholder = 'префаб…';
    this.search.oninput = () => {
      this.picked = 0;
      this.draw();
    };
    this.search.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') this.close();
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') this.move(1);
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') this.move(-1);
      if (e.key === 'Enter' && this.items[this.picked]) void this.place(this.items[this.picked]);
    };
    const close = h('button', 'link', '×') as HTMLButtonElement;
    close.title = 'закрыть (Esc)';
    close.onclick = () => this.close();
    head.append(h('b', '', 'Префабы'), this.search, close);
    this.root.append(head, this.cards, this.note);
    document.body.append(this.root);
    ed.on('scenes', () => !this.root.hidden && this.draw());
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  toggle(): void {
    if (this.root.hidden) this.open();
    else this.close();
  }

  open(): void {
    this.root.hidden = false;
    this.search.value = '';
    this.picked = 0;
    this.draw();
    this.search.focus();
  }

  close(): void {
    this.root.hidden = true;
  }

  /** Candidates: the folder's scenes (not the open one) under the search words. */
  list(): string[] {
    const words = this.search.value.toLowerCase().split(/\s+/).filter(Boolean);
    return this.ed.prefabCandidates().filter((p) => words.every((w) => p.toLowerCase().includes(w)));
  }

  private move(d: number): void {
    if (!this.items.length) return;
    this.picked = (this.picked + d + this.items.length) % this.items.length;
    this.cards.querySelectorAll('.card').forEach((c, i) => c.classList.toggle('sel', i === this.picked));
  }

  async place(prefab: string, at?: { x: number; y: number }): Promise<void> {
    const r = await this.ed.instantiate(prefab, at);
    if (r?.ok) this.ed.log('info', `инстанс ${prefab}`);
  }

  private draw(): void {
    this.items = this.list();
    this.cards.replaceChildren();
    this.items.forEach((p, i) => {
      const card = h('div', i === this.picked ? 'card sel' : 'card');
      card.dataset.prefab = p;
      card.draggable = true;
      card.title = `${p} — перетащите на сцену (или Enter)`;
      const img = document.createElement('img');
      img.alt = '';
      const cached = this.thumbs.get(p);
      if (cached) img.src = cached;
      void this.thumb(p).then((src) => src && src !== img.src && (img.src = src));
      card.append(img, h('div', '', p.replace(/(\.tml)?\.svg$/, '')));
      card.ondragstart = (e) => {
        e.dataTransfer?.setData(PREFAB_MIME, p);
        e.dataTransfer?.setData('text/plain', p);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
      };
      card.onclick = () => {
        this.picked = i;
        this.move(0);
      };
      card.ondblclick = () => void this.place(p);
      this.cards.append(card);
    });
    const notes: string[] = [];
    if (!this.items.length) notes.push(this.search.value ? 'ничего не найдено' : 'в папке нет других сцен');
    const outside = this.dirs.filter((d) => d.startsWith('..') || d.startsWith('/'));
    if (outside.length) notes.push(`вне открытой папки (не видны редактору): ${outside.join(', ')} — откройте общую папку`);
    this.note.textContent = notes.join(' · ');
  }

  /** A preview of a scene of the folder (data: URL), cached by its documents' hash. */
  async thumb(prefab: string): Promise<string | null> {
    const ed = this.ed;
    try {
      await ed.loadPrefabsFor(prefab);
      const src = ed.sceneSources(prefab);
      if (!src) return null;
      const key = await sha1(`${prefab}\n${src.base ?? ''}\n${src.heir ?? ''}`);
      const hit = this.thumbs.get(key);
      if (hit) {
        this.thumbs.set(prefab, hit);
        return hit;
      }
      const target = new Container();
      const holder = new Container();
      holder.addChild(target);
      await ed.runtime.openInto(target, {
        id: prefab.replace(/(\.tml)?\.svg$/, ''),
        sources: src,
        docUrl: ed.io.url(prefab),
        viewport: { kind: 'size', w: THUMB.w, h: THUMB.h },
        loadScene: ed.sceneLoaderForRender(),
      });
      const url = await ed.app.renderer.extract.base64({ target: holder, frame: new Rectangle(0, 0, THUMB.w, THUMB.h) });
      holder.destroy({ children: true });
      this.thumbs.set(key, url);
      this.thumbs.set(prefab, url);
      return url;
    } catch (e) {
      ed.log('warn', `превью ${prefab}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /** A prefab file changed: its preview is redrawn next time. */
  forget(prefab: string): void {
    this.thumbs.delete(prefab);
  }
}
