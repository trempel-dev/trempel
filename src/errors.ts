// errors.ts — the shared hard-error type for the merge/contract pipeline.
// Merge and contract failures are collected as a list and thrown together, so a designer
// or CI sees every problem at once instead of fixing them one reload at a time.

export class TrempelError extends Error {
  /** All problems found, human-readable, in discovery order. */
  readonly errors: string[];

  constructor(errors: string[]) {
    super(errors.join('\n'));
    this.name = 'TrempelError';
    this.errors = errors;
  }
}

/** Where a runtime expression failure happened (v0.6.1): passed to `mount({ onError })`. */
export interface ExpressionErrorInfo {
  /** `#id` of the node, or `<tag>` when it has no id. */
  node: string;
  /** The tml attribute, e.g. `tml:bind`, `tml:visible`, `tml:on-click`, `tml:bind-y`. */
  attr: string;
  /** Expression source as written (pipes included). */
  expr: string;
  /** What was thrown: an ExpressionError (field of undefined, unknown name…) or a context function's own error. */
  error: unknown;
}

/**
 * A runtime expression failure with its place (v0.6.1). Thrown by mount-built bindings and
 * on-click handlers when the host gave neither `onError` nor `lenient: true`.
 */
export class ExpressionRuntimeError extends Error implements ExpressionErrorInfo {
  readonly node: string;
  readonly attr: string;
  readonly expr: string;
  readonly error: unknown;

  constructor(info: ExpressionErrorInfo) {
    const e = info.error as { reason?: unknown; message?: unknown } | null;
    const why = typeof e?.reason === 'string' ? e.reason : typeof e?.message === 'string' ? e.message : String(info.error);
    super(`${info.node} ${info.attr}="${info.expr}": ${why}`, { cause: info.error });
    this.name = 'ExpressionRuntimeError';
    this.node = info.node;
    this.attr = info.attr;
    this.expr = info.expr;
    this.error = info.error;
  }
}
