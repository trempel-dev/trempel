// storage.ts — the browser's local storage for mocks, folded out of the youtube build (Playables:
// saves only through saveData; the build gate rejects the API name). Null in node and on youtube.

declare const __TREMPEL_TARGET__: string | undefined;

export function webStorage(): Storage | null {
  if (typeof __TREMPEL_TARGET__ !== 'undefined' && __TREMPEL_TARGET__ === 'youtube') return null;
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}
