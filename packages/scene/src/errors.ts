// errors.ts — the shared hard-error type. Merge, contract, prefab and expression failures are
// collected as a list and thrown together, so a designer or CI sees every problem at once instead
// of fixing them one reload at a time. Every message starts with its code (codes.ts).

import { CODE_NAMES } from './code-names.js';
import { codeOf, coded, type Code } from './codes.js';

export class TrempelError extends Error {
  /** All problems found, human-readable (`E_CODE: message`), in discovery order. */
  readonly errors: string[];
  /** The code of each message, in the same order (`undefined` for a message without one). */
  readonly codes: (Code | undefined)[];
  /** The code of the first message. */
  readonly code: Code | undefined;

  constructor(errors: string[]) {
    super(errors.join('\n'));
    this.name = 'TrempelError';
    this.errors = errors;
    this.codes = errors.map(codeOf);
    this.code = this.codes[0];
  }
}

/** A `TrempelError` with one coded message. */
export function trempelError(code: Code, text: string): TrempelError {
  return new TrempelError([coded(code, text)]);
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
  /** The code of the failure (`E_EXPR_UNDEF`, `E_EXPR_FIELD`…; `E_EXPR_RUNTIME` for a context function's own error). */
  readonly code: Code;
  readonly node: string;
  readonly attr: string;
  readonly expr: string;
  readonly error: unknown;

  constructor(info: ExpressionErrorInfo) {
    const e = info.error as { reason?: unknown; message?: unknown } | null;
    const why = typeof e?.reason === 'string' ? e.reason : typeof e?.message === 'string' ? e.message : String(info.error);
    const own = (info.error as { code?: unknown } | null)?.code;
    const code: Code = typeof own === 'string' && CODE_NAMES.has(own) ? (own as Code) : (codeOf(why) ?? 'E_EXPR_RUNTIME');
    const text = codeOf(why) ? why.replace(/^[EW]_[A-Z0-9_]+: /, '') : why;
    super(coded(code, `${info.node} ${info.attr}="${info.expr}": ${text}`), { cause: info.error });
    this.name = 'ExpressionRuntimeError';
    this.code = code;
    this.node = info.node;
    this.attr = info.attr;
    this.expr = info.expr;
    this.error = info.error;
  }
}
