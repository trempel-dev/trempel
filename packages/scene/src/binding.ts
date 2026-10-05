// binding.ts — parse & apply tml:bind / tml:visible / tml:bind-<attr>, plus the pipe layer.
// Attribute values are bare expressions (no {curly} syntax), optionally followed by pipes:
//   tml:bind="state.balance | fixed:2"
// Expressions are parsed once (expr.ts) — a syntax error surfaces at mount, not on first change.
// v0.6.1: a runtime failure (field of undefined, a throwing context function, a pipe) is loud by
// default — reported to `onError`, or thrown with its place; v0.5 silence only with `lenient`.
//
// @internal — `@trempel/scene/internal/binding`, for the kit and the editor: no stability promise.

import { applyPipes, compile, ExpressionError, run, unknownPipes, type CompiledExpr } from './expr.js';
import { PIPES } from './pipes.js';
import { effect } from './reactive.js';
import { ExpressionRuntimeError, trempelError, type ExpressionErrorInfo } from './errors.js';
import { coded } from './codes.js';
import type { SceneNode } from './parser.js';
import type { NodeHandle, RendererBackend } from './render/backend.js';
import { walk } from './tree.js';

export { PIPES, type PipeFn } from './pipes.js';

interface ParsedBind {
  expr: string;
  pipes: { name: string; arg?: string }[];
}

/** Split a bind source into its expression part and pipes. @throws ExpressionError on bad syntax. */
export function parseBind(src: string): ParsedBind {
  const c = compile(src);
  return { expr: c.expr, pipes: c.pipes };
}

/** Evaluate a compiled bind: an evaluation error yields undefined (v0.5 leniency), pipes then apply. */
function evalCompiled(c: CompiledExpr, context: Record<string, unknown>): unknown {
  let value: unknown;
  try {
    value = run(c, context);
  } catch {
    value = undefined;
  }
  return c.pipes.length ? applyPipes(value, c.pipes) : value;
}

/** What to do when an expression fails while running (v0.6.1). */
export interface ExpressionErrorOptions {
  /**
   * Receives every runtime failure with its place. The failed write is skipped (the node keeps
   * its last value; a failed on-click does nothing). Without it, failures throw ExpressionRuntimeError.
   */
  onError?: (info: ExpressionErrorInfo) => void;
  /**
   * v0.5 silence: a failed expression yields `undefined` (written as is), a failed on-click is
   * swallowed. `onError`, if also given, is still told.
   */
  lenient?: boolean;
}

/** Marks "evaluation failed and was reported — do not write". */
const FAILED: unique symbol = Symbol('failed');

/** Run an expression (pipes included) at a place, applying the error policy. */
export function evalAt(
  c: CompiledExpr,
  context: Record<string, unknown>,
  where: { node: string; attr: string },
  opts: ExpressionErrorOptions,
): unknown {
  try {
    const value = run(c, context);
    return c.pipes.length ? applyPipes(value, c.pipes) : value;
  } catch (error) {
    const info: ExpressionErrorInfo = { node: where.node, attr: where.attr, expr: c.src, error };
    opts.onError?.(info);
    if (opts.lenient) return undefined;
    if (opts.onError) return FAILED;
    throw new ExpressionRuntimeError(info);
  }
}

/** True when evalAt reported a failure and the result must not be written. */
export const failed = (v: unknown): v is typeof FAILED => v === FAILED;

/** Evaluate a bind expression (with its pipes) against a context. @throws on bad syntax / unknown pipe. */
export function evalBinding(src: string, context: Record<string, unknown>): unknown {
  return evalCompiled(compile(src), context);
}

/** Default bind target property per element tag, or null if an explicit tml:bind-<attr> is required. */
export function defaultBindProp(tag: string): string | null {
  if (tag === 'text') return 'text';
  if (tag === 'image') return 'href';
  return null; // g / rect
}

/** tml keys whose values are expressions (v0.9: + on-over / on-out / on-down / on-up). */
export const isExprKey = (k: string): boolean =>
  k === 'bind' || k === 'visible' || k === 'on-click' || k.startsWith('bind-') || k === 'on-over' || k === 'on-out' || k === 'on-down' || k === 'on-up';

/** The source line holding `pos` (expressions may span lines in the heir), with a caret under it. */
function pointAt(src: string, pos: number): string {
  const start = src.lastIndexOf('\n', pos - 1) + 1;
  const endNl = src.indexOf('\n', pos);
  const line = src.slice(start, endNl === -1 ? undefined : endNl);
  const indent = line.length - line.trimStart().length;
  return `      ${line.trim()}\n      ${' '.repeat(Math.max(0, pos - start - indent))}^`;
}

/**
 * Every expression problem in a (merged) tree — syntax errors with position, unknown pipes —
 * phrased for a human, one line each. Used by mount() and the CLI checker.
 */
export function bindingErrors(tree: SceneNode): string[] {
  const errors: string[] = [];
  walk(tree, (n) => {
    for (const [k, v] of Object.entries(n.tml)) {
      if (!isExprKey(k)) continue;
      const where = n.attrs.id ? `#${n.attrs.id}` : `<${n.tag}>`;
      try {
        const c = compile(v);
        for (const p of unknownPipes(c)) {
          errors.push(coded('E_PIPE_UNKNOWN', `${where} tml:${k}: unknown pipe "${p}" (pipes: ${Object.keys(PIPES).join(', ')}).`));
        }
      } catch (e) {
        if (!(e instanceof ExpressionError)) throw e;
        errors.push(coded(e.code, `${where} tml:${k}: ${e.reason} (col ${e.pos + 1}):\n${pointAt(e.src, e.pos)}`));
      }
    }
  });
  return errors;
}

/** Options of applyBindings: the error policy plus the node's place for messages. */
export interface BindingOptions extends ExpressionErrorOptions {
  /** Node id (messages say `#id`; `<tag>` without it). */
  id?: string;
}

/**
 * Wire up reactive bindings for a single node.
 * Reads tml.bind, tml.visible, and any tml['bind-<attr>'] keys, installing an effect() each.
 * A runtime failure follows `opts` (v0.6.1): onError / lenient / otherwise ExpressionRuntimeError —
 * thrown from here on the first run, from the state write that re-ran the effect later.
 */
export function applyBindings(
  handle: NodeHandle,
  tag: string,
  tml: Record<string, string>,
  backend: RendererBackend,
  context: Record<string, unknown>,
  opts: BindingOptions = {},
): void {
  const node = opts.id ? `#${opts.id}` : `<${tag}>`;
  const bind = (key: string, prop: string, map: (v: unknown) => unknown = (v) => v): void => {
    const c = compile(tml[key]);
    const where = { node, attr: `tml:${key}` };
    effect(() => {
      const v = evalAt(c, context, where, opts);
      if (!failed(v)) backend.setProp(handle, prop, map(v));
    });
  };

  if (tml.bind !== undefined) {
    const prop = defaultBindProp(tag);
    if (!prop) {
      throw trempelError('E_BIND_DEFAULT', `<${tag}> has no default bind property — use tml:bind-<attr> instead.`);
    }
    bind('bind', prop);
  }

  for (const key of Object.keys(tml)) {
    if (key.startsWith('bind-')) bind(key, key.slice('bind-'.length));
  }

  if (tml.visible !== undefined) bind('visible', 'visible', Boolean);
}
