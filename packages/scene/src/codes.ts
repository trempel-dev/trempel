// codes.ts — the catalog of message codes: every error (E_…) and warning (W_…) a user of the
// package sees starts with its code — `E_CODE: message (place)`. The code is the stable part:
// tests and tools match codes, never the wording. The "Error codes" section of
// docs/format/scene-format.md is generated from this catalog (scripts/error-codes.mjs), and so is
// code-names.ts — the names alone, which is all the runtime reads (the descriptions stay out of
// bundles that never show them).

import { CODE_NAMES } from './code-names.js';

export const CODES = {
  // ---- XML and documents ----------------------------------------------------------------------
  E_XML: 'the document is not well-formed XML',
  E_DOCTYPE: 'a <!DOCTYPE> or an entity in a scene document (never needed; refused for safety)',
  E_ROOT: 'wrong root element (<svg> for a scene or an heir, <contract> for a contract)',
  E_TAG: 'an element outside the format (the message lists what is supported)',
  E_TEXT: 'text where the format has none (a <use>, a group)',
  E_EMPTY_SCENE: 'nothing to draw: no base and no tml:extends',

  // ---- base, heir, merge ----------------------------------------------------------------------
  E_STERILE: 'the base carries tml:* attributes — logic lives in the heir',
  E_DUP_ID: 'an id is used more than once in a document',
  E_REF_NO_ID: '<tml:ref> without an id',
  E_REF_FOREIGN: '<tml:ref> with non-tml attributes (geometry and style are edited in the base)',
  E_REF_TWICE: 'the same id referenced by two <tml:ref>',
  E_REF_MISSING: '<tml:ref> to an id the base does not have',
  E_REF_DEFS: '<tml:ref> or tml:* on service geometry in <defs>',
  E_REF_HREF: 'tml:href on a node that is not an <image>',
  E_INSERT_SYNTAX: "malformed tml:insert (expected 'after <id>' or 'into <id>')",
  E_INSERT_TARGET: 'tml:insert into or after a node the base does not have',
  E_INSERT_ROOT: "tml:insert 'after' the root (it has no parent)",
  E_HEIR_STRAY: 'a child of the heir that is neither <tml:ref> nor a tml:insert subtree',
  E_EXTENDS_BASE: 'an own base and tml:extends of another scene (one base)',
  E_EXTENDS_MISSING: 'tml:extends names a scene that does not exist',
  E_EXTENDS_CYCLE: 'a tml:extends cycle',

  // ---- transforms, geometry, masks ------------------------------------------------------------
  E_TRANSFORM: 'a transform that cannot be parsed (unknown function, wrong argument count)',
  E_PATH_DATA: 'path data (d) or a geometry attribute that cannot be parsed',
  E_GEOMETRY: 'a node that is not geometry where geometry is needed',
  E_PATH_SIMILARITY: "a path whose transform stretches or skews it (lengths along it are undefined)",
  E_DEFS_PLACE: '<defs> or <clipPath> outside its place, or a child they do not allow',
  E_CLIP_PATH: 'a clip-path value, target or host the format does not allow',
  E_CLIP_NO_ID: '<clipPath> without an id',
  E_CLIP_UNITS: 'clipPathUnits other than userSpaceOnUse',

  // ---- presentation attributes ----------------------------------------------------------------
  E_STYLE: 'a style property other than mix-blend-mode',
  E_BLEND: 'an unknown mix-blend-mode, or one on a tag that does not blend',
  E_BIND_STYLE: 'tml:bind-style (blend modes do not switch)',
  E_TINT: 'malformed data-tint, or data-tint on a tag that is not tinted',
  E_Z: 'malformed data-z, or data-z on a node that is not drawn',
  E_PIVOT: 'malformed data-pivot, or data-pivot on a node that is not drawn',
  E_VIEWS: 'malformed data-views, or data-views on a node that is not an <image>',
  E_NUMBER: 'an attribute that must be a number is not',
  E_STROKE: 'a stroke attribute (dasharray, dashoffset, linecap, linejoin, pathLength) that is malformed or on a tag without a stroke',

  // ---- layout ---------------------------------------------------------------------------------
  E_SLICES: 'malformed data-slices, or data-slices on a tag that is not an <image>',
  E_TILE: 'data-tile on a tag that is not an <image>, or together with data-slices',
  E_ANCHOR: 'malformed data-anchor',
  E_AXES: 'an axes value other than x, y or xy (data-stretch, data-tile, data-resizable)',
  E_SIZE: 'malformed data-size',
  E_ASPECT: 'a malformed preserveAspectRatio on an <image>, or one with data-slices / data-tile',
  E_STRETCH: 'data-stretch on a node that cannot stretch, or without a size',
  E_NO_BOX: 'an anchored or stretched node whose parent is not a box',
  E_RESIZABLE: 'data-resizable misplaced, without a viewBox or without a stretching background',

  // ---- expressions and bindings ---------------------------------------------------------------
  E_EXPR_SYNTAX: 'an expression that cannot be parsed (the message has the position and a caret)',
  E_EXPR_UNDEF: 'a name the expression context does not define',
  E_EXPR_FIELD: 'reading a field of undefined or null',
  E_EXPR_FORBIDDEN: 'access to a forbidden member (constructor, prototype, __proto__…)',
  E_EXPR_CALL: 'calling something that is not a function',
  E_EXPR_RUNTIME: 'an expression failed at run time (the cause is attached)',
  E_PIPE_UNKNOWN: 'an unknown pipe',
  E_BIND_DEFAULT: 'tml:bind on a tag without a default property (use tml:bind-<attr>)',
  E_SELF_CALL: 'self.call() of a function the scene context does not have',

  // ---- prefabs and slots ----------------------------------------------------------------------
  E_USE_NO_ID: 'a <use> instance without an id',
  E_USE_NO_HREF: 'a <use> instance without an href',
  E_USE_ATTR: 'an attribute an instance does not take (instances are configured by data-* parameters and transform)',
  E_PARAM_RESERVED: 'a parameter named data-id, data-call, data-state or data-set',
  E_PARAM_MISSING: 'a required parameter (contract params) not set',
  E_PREFAB_CYCLE: 'a prefab cycle',
  E_PREFAB_MISSING: 'a prefab that does not exist or failed to load',
  E_PROJECT_HEIR: 'a project heir that is not an heir of its collection document, or two heirs of one document',
  E_PREFAB_LOADER: 'no scene loader, or an asynchronous one for mount() (use mountAsync)',
  E_PREFAB_RESIZE: 'width/height on an instance of a prefab that does not resize along that axis',
  E_PREFAB_MIN_SIZE: 'an instance smaller than its prefab’s viewBox (the minimum size)',
  E_SLOT: 'a malformed slot (not a <g>, a name twice, two defaults)',
  E_SLOT_UNKNOWN: 'a child of <use> for a slot the prefab does not have',

  // ---- the contract ---------------------------------------------------------------------------
  E_CONTRACT_SYNTAX: 'a contract that cannot be read (attribute values, id and match together, children of a pattern)',
  E_CONTRACT_MISSING: 'a node the contract requires is missing from the base',
  E_CONTRACT_TWICE: 'a node the contract requires is in the base more than once',
  E_CONTRACT_TAG: 'a node of another tag (or not an instance of the prefab) than the contract says',
  E_CONTRACT_EMPTY: 'a node the contract wants empty has children',
  E_CONTRACT_ATTR: 'a base attribute the contract requires is missing (attrs, anchor, slices, params, resizable)',
  E_CONTRACT_PLACE: 'a node outside the node the contract puts it in',
  E_CONTRACT_VIEWBOX: 'the base viewBox breaks the contract rule (value, list, aspect)',
  E_CONTRACT_COUNT: 'a pattern matches a number of nodes the contract does not allow',
  E_CONTRACT_PARTNER: 'a pattern match without its required partner node',
  E_CONTRACT_SLOT: 'a group the contract wants as a slot is not marked tml:slot',

  // ---- collections and the project ------------------------------------------------------------
  E_COLLECTION_UNKNOWN: 'an @name/… href to a collection the project does not declare',
  E_PROJECT: '.trempel/project.mdz: a malformed or missing collection',

  // ---- md clips -------------------------------------------------------------------------------
  E_ANIM_SYNTAX: 'an md clip file that cannot be read (blocks, attributes, tables)',
  E_ANIM_COLUMN: 'an unknown or conflicting column in a clip table',
  E_ANIM_VALUE: 'a cell value of the wrong kind (number, colour, integer, range)',
  E_ANIM_TIME: 'a key time that is not a number ≥ 0, not ascending, or past $duration',
  E_ANIM_EASE: 'an unknown ease',
  E_ANIM_TARGET: 'a clip target that does not exist, is in <defs>, or cannot take the column',
  E_ANIM_TEX: 'a malformed $tex template or table',
  E_ANIM_MOTION: 'a motion track that is inconsistent ($path, $orient, $offset, x/y, rotation)',
  E_ANIM_TWICE: 'a property of a target keyed twice in one clip, or a clip name twice',
  E_ANIM_UNKNOWN: 'a clip name the scene’s clip files do not have',
  E_ANIM_PLAY: 'a clip that cannot be played (motion without a path, no rest pose)',
  E_ANIM_PARAM: 'a clip parameter ($name cell) not given at play time, or not a number',

  // ---- runtime: mounting, the backend, the scene API ------------------------------------------
  E_NO_REGISTRY: 'tml:type without a component registry',
  E_COMPONENT: 'an unknown component, or a component API used outside a scene',
  E_NODE: 'a scene API call (path, hitTest, setView, setSize) with an id the scene does not have',
  E_VIEW: 'an unknown data-views variant, or no <image> with data-views',
  E_BACKEND: 'the backend lacks what the scene needs (setClip, onPointer, getProp) or got a bad value',
  E_TEXTURE: 'a texture did not load',
  E_SLICES_FIT: 'data-slices do not fit the texture (the centre needs at least 1 px)',
  E_RESIZE: 'resize or setSize the scene cannot do',
  E_FETCH: 'a document could not be fetched',

  // ---- tools: flatten, check, the viewer ------------------------------------------------------
  E_STATE: 'stand-in state that is not a JSON object',
  E_IMAGE_MISSING: 'an image file that does not exist',
  E_FLATTEN_LEFTOVER: 'flatten output still has tml:, data-* or @-hrefs',
  E_CLI: 'a command-line usage error',
  W_FLATTEN: 'something vanilla SVG cannot show (a component, a clip, a binding, an unknown image size)',
  W_CONTEXT_STUB: 'names the scene uses that nobody provides — the viewer stubs them',

  // ---- the editor -----------------------------------------------------------------------------
  // (editor/ commands and the editor page add their codes here)
  E_EDITOR_COMMAND: 'an unknown editor command',
  E_EDITOR_ARGS: 'command arguments that do not fit its schema (type, required, unknown, range, pattern)',
  E_EDITOR_API: 'EditorDocument misused (an unknown event, end/abort without begin)',
  E_EDITOR_NO_NODE: 'a node reference (id or index path) that matches no node',
  E_EDITOR_NODE_AMBIGUOUS: 'an id used by several nodes — address the node by its index path',
  E_EDITOR_INDEX: 'a child index out of range',
  E_EDITOR_ID_TAKEN: 'a new id that is already in the document',
  E_EDITOR_ATTR: 'an attribute the command does not set (xmlns, id outside node.setId)',
  E_EDITOR_TAG: 'a command applied to a node of a tag it does not work on',
  E_EDITOR_ROOT: 'a command the root <svg> cannot take (remove, move, copy, transform)',
  E_EDITOR_VALUE: 'an attribute value the command cannot work with (a list, not a number, a degenerate transform)',
  E_EDITOR_TEXT: 'replacing the text of an element with element children',
  E_EDITOR_FRAGMENT: 'an XML fragment that is not exactly one element, or is an <svg>',
  E_EDITOR_REPARENT: 'a node moved into itself',
  E_EDITOR_PATH: 'an impossible path edit (no such point, segment or subpath; a handle without a segment; the last point)',
  E_EDITOR_NOT_INSTANCE: 'a prefab command on a node that is not a <use> instance',
  E_EDITOR_NOT_EXPANDED: 'an instance that is not expanded (the prefab is missing or has errors)',
  E_EDITOR_PARAM: 'a prefab parameter that cannot be one (a presentation attribute, not a child of the group, the wrong tag)',
  E_EDITOR_NO_ID: 'a group without an id where the command needs one (prefab.extract)',
  E_EDITOR_FILE_EXISTS: 'a file the command would create already exists',
  E_EDITOR_CLIP_NONE: 'a clip the md clip file does not have',
  E_EDITOR_CLIP_TAKEN: 'a clip name the md clip file already has',
  E_EDITOR_CLIP_TRACK: 'a track (## $track) the clip does not have, or a column it already keys',
  E_EDITOR_CLIP_KEY: 'a key the track does not have, or a key moved onto another key of its column',
  E_EDITOR_CLIP_EVENT: 'an event ($events) the clip does not have',
  E_EDITOR_CLIP_VALUE: 'a clip cell or attribute value of the wrong kind (a string in a number column, | in a cell)',
  E_EDITOR_NO_HEIR: 'an heir command on a scene without an heir (X.tml.svg)',
  E_EDITOR_READONLY: 'a base command on a scene whose base lives in another scene (tml:extends) — read-only here',
  W_EDITOR_CLIP_REF: 'a clip refers to a renamed or removed id',
  W_EDITOR_PATH_REWRITTEN: 'd rewritten as absolute M L C Z (arcs approximated by cubics)',
  W_EDITOR_DETACH: 'prefab logic (the tml of its heir) is not carried into a detached copy',
  W_EDITOR_EXTRACT: 'prefab.extract changed an id or left a clip-path outside the prefab',
  E_EDIT_NO_SCENE: 'no scene is open or drawn in the editor',
  E_EDIT_NO_BASE: 'a scene without its base X.svg (the editor edits only the base)',
  E_EDIT_NODE: 'a node (id or index path) the open scene does not have',
  E_EDIT_SELECTION: 'nothing selected for an action that needs a selection',
  W_EDIT_SELECTION: 'an editor action that does not apply to the selected nodes',
  E_EDIT_ARGS: 'malformed arguments of a tml call, an operator or a command field',
  E_EDIT_SINGULAR: 'a degenerate transform (scale 0) cannot be inverted',
  E_EDIT_SCENE: 'a scene the open folder does not have',
  E_EDIT_CLIP: 'a clip the scene does not have, no clips, or no clip selected',
  E_EDIT_REC: 'a recorded edit (● Rec) that cannot become clip keys (a node without an id)',
  E_EDIT_HOST: 'a feature only the editor page provides (clips, reference, snapshots, prefabs)',
  E_EDIT_NO_PAGE: 'the agent bridge has no open editor page to run in (or it did not answer)',
  E_EDIT_SCRIPT: 'a console script or macro failed (or the page CSP forbids running scripts)',
  E_EDIT_MACRO: 'a macro the folder does not have',
  W_EDIT_MACRO: 'a macro file that could not be read',
  E_EDIT_WRITE: 'a file could not be written to the folder',
  E_EDIT_SNAPSHOT: 'the video snapshot failed',
  W_EDIT_SNAPSHOT: 'the video snapshot could not be written to the folder — offered as a download',
  E_EDIT_REFERENCE: 'the reference picture could not be loaded',
  E_EDIT_RENDER: 'the stage failed to render the scene',
  W_EDIT_PREVIEW: 'a prefab preview could not be drawn',
  W_EDIT_OUTSIDE: 'a prefab outside the open folder (the editor cannot see it)',
  W_EDIT_COMPONENT: 'components without an implementation — their base is drawn',
  W_EDIT_DISK: 'a file changed on disk while the editor has unsaved changes',
  W_EDIT_READ_ONLY: 'the stage is read-only (a clip is posed)',

  // ---- the viewer -----------------------------------------------------------------------------
  E_VIEW_ACCESS: 'a path outside the scene folder, the project and its collections, or in a service folder',
  E_VIEW_WRITE: 'a write the dev server refuses (read-only folder, an heir, not a base, not renders/*.png)',
  E_VIEW_REQUEST: 'a malformed request to the dev server',
  E_VIEW_MODULE: 'the folder view module (trempel.view.ts) failed: loading, setup(), context(), onMount()',
  E_VIEW_VIEWPORT: 'a viewport that cannot be parsed (expected scene, W:H or WxH)',
  W_VIEW_HEIR: 'the heir is not applied — the base is shown without it',
  W_VIEW_TEXTURE_TIMEOUT: 'textures did not load within the timeout',

  // ---- compatibility (one release) ------------------------------------------------------------
  W_COMPAT_GML: 'the previous namespace prefix (gml:) — write tml:',
  W_COMPAT_HEIR: 'an heir under the previous file suffix',
  W_COMPAT_VIEW_MODULE: 'a consumer module under the previous name',
  W_COMPAT_PROJECT_DIR: 'a project folder under the previous name',
} as const;

export type Code = keyof typeof CODES;

const CODE_AT = /^([EW]_[A-Z0-9_]+): /;

/** `E_CODE: text` — a message with its code in front. */
export function coded(code: Code, text: string): string {
  return `${code}: ${text}`;
}

/** The code a message starts with, if any. */
export function codeOf(message: string): Code | undefined {
  const m = CODE_AT.exec(message);
  return m && CODE_NAMES.has(m[1]) ? (m[1] as Code) : undefined;
}

/**
 * A message with a place in front of its text, the code still first: `within('#a (x.svg)',
 * 'E_REF_MISSING: …')` → `E_REF_MISSING: #a (x.svg): …`. A message without a code gets the place
 * only.
 */
export function within(place: string, message: string): string {
  if (!place) return message;
  const m = CODE_AT.exec(message);
  return m ? `${m[0]}${place}: ${message.slice(m[0].length)}` : `${place}: ${message}`;
}
