// codes.ts — assertions on message codes, not wording: a test says which problem (E_…/W_…) and,
// where it matters, which node or value the message names; the English text may change freely.

import { expect } from 'vitest';
import { codeOf, type Code } from '../../src/codes.js';

/** The codes of a list of messages (`undefined` for a message without one). */
export function codesOf(messages: readonly string[]): (Code | undefined)[] {
  return messages.map(codeOf);
}

/** What `fn` throws (fails the test when it does not throw). */
export function thrown(fn: () => unknown): Error & { code?: string; errors?: string[]; codes?: string[] } {
  try {
    fn();
  } catch (e) {
    return e as Error & { code?: string; errors?: string[]; codes?: string[] };
  }
  throw new Error('expected a throw');
}

/** What a promise rejects with (fails the test when it resolves). */
export async function rejected(p: Promise<unknown>): Promise<Error & { code?: string; errors?: string[]; codes?: string[] }> {
  try {
    await p;
  } catch (e) {
    return e as Error & { code?: string; errors?: string[]; codes?: string[] };
  }
  throw new Error('expected a rejection');
}

/**
 * The messages carrying `code` (at least one — the assertion fails otherwise). Each returned
 * message may then be checked for the node / value it names: `expect(m[0]).toContain('#board')`.
 */
export function withCode(messages: readonly string[], code: Code): string[] {
  const hit = messages.filter((m) => codeOf(m) === code);
  expect(hit, `no ${code} among:\n${messages.join('\n')}`).not.toHaveLength(0);
  return hit;
}
