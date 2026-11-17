// names.ts — what a composed scene's expressions read from the context: every free name, plus the
// on-click source of each node with an id. The viewer stubs the names nobody provides (clicks go to
// its log); flatten stubs them too, so a static render evaluates like the viewer's.
//
// @internal — `@trempel/scene/internal/names`, for the kit and the editor: no stability promise.

import { isExprKey } from './binding.js';
import { compile, type Node as ExprNode } from './expr.js';
import type { SceneNode } from './parser.js';
import { paramName } from './prefab.js';

/** Free names of an expression AST (what it reads from the context). */
function freeNames(n: ExprNode, out: Set<string>): void {
  switch (n.k) {
    case 'name':
      out.add(n.name);
      return;
    case 'member':
      freeNames(n.obj, out);
      if (typeof n.prop !== 'string') freeNames(n.prop, out);
      return;
    case 'call':
      freeNames(n.callee, out);
      n.args.forEach((a) => freeNames(a, out));
      return;
    case 'unary':
      freeNames(n.arg, out);
      return;
    case 'binary':
    case 'logical':
      freeNames(n.l, out);
      freeNames(n.r, out);
      return;
    case 'cond':
      freeNames(n.test, out);
      freeNames(n.a, out);
      freeNames(n.b, out);
      return;
    case 'array':
      n.items.forEach((x) => freeNames(x, out));
      return;
    case 'object':
      n.props.forEach(([, v]) => freeNames(v, out));
      return;
    case 'lit':
      return;
  }
}

/** Every context name a (merged) tree's expressions use, plus on-click sources by node id. */
export function sceneNames(tree: SceneNode): { names: string[]; clicks: Map<string, string> } {
  const names = new Set<string>();
  const clicks = new Map<string, string>();
  const add = (src: string): void => {
    try {
      freeNames(compile(src).ast, names);
    } catch {
      // syntax errors are reported by bindingErrors / the expansion
    }
  };
  // v0.9: what `self.call(self.x)` calls is the value of parameter x — a name of the scene's context.
  const calls = new Set<string>();
  const visit = (n: SceneNode): void => {
    for (const [k, v] of Object.entries(n.tml)) {
      if (!isExprKey(k)) continue;
      add(v);
      for (const m of v.matchAll(/self\.call\(\s*self\.(\w+)/g)) calls.add(m[1]);
      if (k === 'on-click' && n.attrs.id) clicks.set(n.attrs.id, v);
    }
    n.children.forEach(visit);
  };
  visit(tree);
  const params: Record<string, string>[] = [Object.fromEntries(Object.entries(tree.attrs).filter(([k]) => k.startsWith('data-')))];
  const collect = (n: SceneNode): void => {
    if (n.instance) {
      params.push(n.instance.params);
      for (const v of Object.values(n.instance.params)) if (v.startsWith('=')) add(v.slice(1));
    }
    n.children.forEach(collect);
  };
  collect(tree);
  for (const p of params) {
    for (const [k, v] of Object.entries(p)) if (calls.has(paramName(k)) && /^[A-Za-z_$][\w$]*$/.test(v)) names.add(v);
  }
  names.delete('self'); // the runtime gives it (instances; a prefab opened alone — its root's defaults)
  return { names: [...names].sort(), clicks };
}

/** Free names one expression reads (`state.a + t('x')` → state, t). @throws ExpressionError on bad syntax. */
export function exprNames(src: string): string[] {
  const out = new Set<string>();
  freeNames(compile(src).ast, out);
  return [...out];
}
