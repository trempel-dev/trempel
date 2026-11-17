// json-edit.ts — 2.3: effect data saved with a minimal diff. A converter's systems.json (an array of
// particle systems) gets only the edited systems rewritten — every other byte of the file stays as
// it was; a project effect file (fx/<name>.json) is written whole, formatted.

/** [start, end) of each element of the top-level array of a JSON text; null — not an array. */
export function arrayItems(text: string): [number, number][] | null {
  let i = 0;
  const ws = (): void => {
    while (i < text.length && /\s/.test(text[i])) i++;
  };
  ws();
  if (text[i] !== '[') return null;
  i++;
  const out: [number, number][] = [];
  for (;;) {
    ws();
    if (text[i] === ']') return out;
    const start = i;
    let depth = 0;
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === '"') {
        for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      } else if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') {
        if (depth === 0) break;
        depth--;
      } else if (c === ',' && depth === 0) break;
    }
    let end = i;
    while (end > start && /\s/.test(text[end - 1])) end--;
    out.push([start, end]);
    if (i >= text.length) return null;
    if (text[i] === ',') i++;
    else if (text[i] === ']') return out;
  }
}

/** The indent unit of a pretty JSON text (its first indented line), '' — compact. */
export function indentUnit(text: string): string {
  const m = /\n([ \t]+)\S/.exec(text);
  return m ? m[1] : '';
}

/** A value as JSON at a position indented by `base` (pretty in the file's unit, or compact). */
function stringifyAt(value: unknown, unit: string, base: string): string {
  if (!unit) return JSON.stringify(value);
  return JSON.stringify(value, null, unit).replace(/\n/g, `\n${base}`);
}

/**
 * Replace elements of the top-level array (index → new value), the rest of the text byte for byte.
 * @throws when the text is not a JSON array or an index is out of it.
 */
export function replaceItems(text: string, items: Map<number, unknown>): string {
  const ranges = arrayItems(text);
  if (!ranges) throw new Error('E_FX_EDIT: the effect file is not a JSON array of particle systems');
  const unit = indentUnit(text);
  let out = text;
  for (const [index, value] of [...items].sort((a, b) => b[0] - a[0])) {
    const r = ranges[index];
    if (!r) throw new Error(`E_FX_EDIT: the effect file has no system #${index} (${ranges.length} systems)`);
    const lineStart = text.lastIndexOf('\n', r[0] - 1) + 1;
    const base = /^[ \t]*/.exec(text.slice(lineStart, r[0]))![0];
    out = out.slice(0, r[0]) + stringifyAt(value, unit, base) + out.slice(r[1]);
  }
  return out;
}

/** A whole effect file: pretty, two spaces, a newline at the end. */
export function formatEffectFile(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
