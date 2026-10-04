// pipes.ts — the pipe layer of binding expressions: `expr | name[:arg]`.
// A registry (plain object) so a host can add its own pipes before mounting.

export type PipeFn = (value: unknown, arg?: string) => unknown;

/** Built-in pipes: fixed:N (toFixed), int (Math.floor), money[:symbol] (en-US, 2 decimals). */
export const PIPES: Record<string, PipeFn> = {
  fixed: (value, arg) => Number(value).toFixed(arg ? parseInt(arg, 10) : 0),
  int: (value) => Math.floor(Number(value)),
  money: (value, arg) =>
    `${arg ?? '$'}${Number(value).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`,
};
