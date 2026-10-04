// md/ — md clips (`# $clip`, `$key: value`, clip tables) as a block tree; anim/compile.ts reads it.

export { parse, MdParseError } from './parse.js';
export { parseJson5, Json5Error } from './json5.js';
export type { Document, Block, Attribute, AttributeValue, BodyValue, Scalar, ListItem, InterpolatedValue, Json5Object, Json5Value } from './types.js';
