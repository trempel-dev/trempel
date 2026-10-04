// types.ts — the tree of an md-clips document (md/parse.ts).

export type Scalar = string | number | boolean | null;

/** A value that carries `${…}` (or the `\${` opt-out): kept raw, escapes not unfolded. */
export interface InterpolatedValue {
  raw: string;
  /** Offsets of each `${…}` in `raw` (start at `$`, end past `}`), and the text inside. */
  placeholders: { raw: string; start: number; end: number }[];
}

export type ListItem = Scalar | InterpolatedValue;

export type Json5Value = Scalar | Json5Value[] | Json5Object;
export interface Json5Object {
  [key: string]: Json5Value;
}

export type AttributeValue = Scalar | ListItem[] | InterpolatedValue | Json5Object;
export type BodyValue = string | InterpolatedValue;

/** `$key: value` — the key as one segment (a dot is part of the name). */
export interface Attribute {
  key: string[];
  value: AttributeValue;
}

/** `# $name id` and what follows it up to the next header of the same or a higher level. */
export interface Block {
  /** Name after `$` in the header; '' for the root. */
  name: string;
  /** The rest of the header line, if any. */
  id?: string;
  /** Heading level (1..6); the root is 0. */
  level: number;
  /** Attributes in order of appearance. */
  attrs: Attribute[];
  /** Text lines that are neither headers nor attributes (edge blank lines dropped). */
  body?: BodyValue;
  children: Block[];
}

export interface Document {
  root: Block;
}
