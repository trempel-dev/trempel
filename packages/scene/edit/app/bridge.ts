// bridge.ts — 2.3: the agent's way into the open page (view/plugin.ts POST /__tml/agent → ws
// 'tml:agent' → here → 'tml:agent-result'). An agent edits the same document the person sees: an
// eval is `tml.run(code, 'agent')` — one undo step, drawn at once, marked «agent» in the log; save is
// ⌘S; state — what is open, unsaved, broken, selected.

import { formatValue, type Tml } from './tml';
import type { Editor } from './editor';
import type { Clips } from './clips';

interface Hot {
  on(event: string, cb: (data: { id: string; op: 'eval' | 'save' | 'state'; code?: string; label?: string }) => void): void;
  send(event: string, data: unknown): void;
}

/** A value as JSON (what JSON cannot carry — its console form). */
function plain(v: unknown): unknown {
  if (v === undefined) return null;
  try {
    const s = JSON.stringify(v);
    return s === undefined ? formatValue(v) : (JSON.parse(s) as unknown);
  } catch {
    return formatValue(v);
  }
}

/** What an agent asks with editor.state(). */
export function editorState(ed: Editor, clips?: Clips): Record<string, unknown> {
  const doc = ed.doc;
  return {
    scene: ed.entry?.id ?? null,
    dirty: !!doc?.dirty,
    errors: ed.issues().filter((i) => i.level === 'error').map((i) => i.message),
    selection: ed.selection.map((p) => ed.ref(p)),
    clips: doc?.clipFiles() ?? [],
    clip: clips?.selected ? { name: clips.selected, file: clips.current?.file ?? null, t: clips.time, rec: clips.rec } : null,
    heirOnly: !!doc?.heirOnly,
  };
}

export function connectBridge(hot: Hot, ed: Editor, tml: Tml, clips?: Clips): void {
  hot.on('tml:agent', (msg) => {
    void (async () => {
      const reply = (r: Record<string, unknown>): void => hot.send('tml:agent-result', { id: msg.id, ...r, dirty: !!ed.doc?.dirty });
      try {
        if (msg.op === 'state') return reply({ ok: true, value: editorState(ed, clips) });
        if (msg.op === 'save') {
          const ok = await tml.save();
          ed.log(ok ? 'info' : 'error', `agent: save${ok ? '' : ' failed'}`);
          return reply({ ok, errors: ok ? [] : ['E_EDIT_WRITE: the save failed — see the editor log'] });
        }
        const first = (msg.code ?? '').trim().split('\n')[0].slice(0, 80);
        ed.log('info', `agent: ${first}`);
        const value = await tml.run(msg.code ?? '', msg.label ?? 'agent');
        reply({ ok: true, value: plain(value), errors: [] });
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        ed.log('error', `agent: ${m}`);
        reply({ ok: false, errors: [m] });
      }
    })();
  });
  hot.send('tml:agent-hello', {});
}
