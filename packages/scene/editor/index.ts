// @trempel/scene/editor — the scene editor core: no browser DOM, no Pixi. A document over the base SVG,
// commands with JSON Schema arguments and undo/redo/batch, validation after every change, export
// with a minimal diff. The UI and agents (e.g. over ACP) call the same commands.

export { openDocument, EditorDocument } from './document.js';
export type { OpenOptions, CommandResult, CommandCall, HistoryEntry, TreeNode, ChangeEvent, InstanceInfo } from './document.js';
export { commands } from './commands.js';
export type { CommandName } from './commands.js';
export { checkSchema } from './schema.js';
export type { JSONSchema7 } from './schema.js';
