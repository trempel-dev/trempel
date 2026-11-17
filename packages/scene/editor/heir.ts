// heir.ts — 2.3: the two narrow edits of the heir (X.tml.svg) — only for effect nodes.
//
// The rule stays: the base is edited, the heir is shown. Effects are the exception: an effect node
// (`tml:type="fx"`) is configured by attributes (`data-effect`, `data-scale`, `transform` of a node
// inserted by the heir; `tml:effect`… on a `<tml:ref>`), and a new one is inserted by the heir
// (`tml:insert="into <group>"`). Both go through the source-preserving DOM of the heir: a minimal
// diff, like the base. Nothing else of the heir is edited.

import type { SceneNode } from '@trempel/scene/core';
import type { Element } from '@xmldom/xmldom';
import { CommandError, type Ctx } from './ctx.js';
import { fmt } from './num.js';
import type { JSONSchema7 } from './schema.js';

const obj = (properties: Record<string, JSONSchema7>, required: string[] = []): JSONSchema7 => ({ type: 'object', properties, required, additionalProperties: false });
const NODE: JSONSchema7 = { type: 'string', pattern: '^[A-Za-z_][\\w./-]*$', description: 'id of a node of the composed scene (an instance\'s: "btn/label")' };
const ID: JSONSchema7 = { type: 'string', pattern: '^[A-Za-z_][\\w.-]*$', description: 'id (a letter or _, then letters, digits, _ . -)' };

function heirCtx(ctx: Ctx): Ctx {
  const h = ctx.env.heir?.();
  if (!h) throw new CommandError('E_EDITOR_NO_HEIR', 'the scene has no heir (X.tml.svg) — effect nodes live in the heir');
  return h;
}

/** A node of the composed scene by id (null — none, or in <defs>). */
function mergedNode(ctx: Ctx, id: string): SceneNode | null {
  let found: SceneNode | null = null;
  const visit = (n: SceneNode, defs: boolean): void => {
    if (found) return;
    if (n.attrs.id === id && !defs) found = n;
    for (const c of n.children) visit(c, defs || n.tag === 'defs');
  };
  visit(ctx.env.merged(), false);
  return found;
}

function heirElement(h: Ctx, id: string): Element | null {
  return h.byId(id)[0] ?? null;
}

export const heirCommands = {
  'heir.setAttr': {
    describe:
      'Effects only (2.3): set an attribute of an element of the heir — data-effect, data-scale, transform… of an fx node the heir inserts, tml:* of a <tml:ref> (one is added for a tml:* attribute of a base node the heir does not reference yet). value null — remove.',
    schema: obj({ node: NODE, name: { type: 'string', minLength: 1 }, value: { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }] } }, ['node', 'name', 'value']),
    run(ctx: Ctx, a: { node: string; name: string; value: string | number | null }) {
      const h = heirCtx(ctx);
      if (a.name === 'id' || a.name === 'tml:insert' || a.name === 'tml:extends' || a.name === 'xmlns' || a.name.startsWith('xmlns:')) {
        throw new CommandError('E_EDITOR_ATTR', `${a.name}: structure of the heir is not edited by heir.setAttr`);
      }
      const value = a.value == null ? null : typeof a.value === 'number' ? fmt(a.value) : a.value;
      let el = heirElement(h, a.node);
      if (!el) {
        if (!a.name.startsWith('tml:')) throw new CommandError('E_EDITOR_NO_NODE', `node: the heir has no element #${a.node} (a base node takes only tml:* through a <tml:ref>)`);
        if (!mergedNode(ctx, a.node)) throw new CommandError('E_EDITOR_NO_NODE', `node: the scene has no node #${a.node}`);
        if (value == null) return;
        el = h.doc.createElement('tml:ref');
        el.setAttribute('id', a.node);
        el.setAttribute(a.name, value);
        h.insert(h.root, el);
        return;
      }
      if (el.nodeName === 'tml:ref' && !a.name.startsWith('tml:')) {
        throw new CommandError('E_REF_FOREIGN', `#${a.node} is a <tml:ref> — it takes only tml:* (${a.name} is the base's: edit it there)`);
      }
      h.setAttr(el, a.name, value);
    },
  },

  'heir.insertFx': {
    describe:
      'Effects only (2.3): a new effect node in the heir — <g id tml:insert="into <into>" tml:type="fx" transform="translate(x y)" data-effect>, at (x, y) of the group\'s space.',
    schema: obj(
      { into: NODE, id: ID, effect: { type: 'string', minLength: 1 }, x: { type: 'number' }, y: { type: 'number' }, scale: { type: 'number', exclusiveMinimum: 0 } },
      ['into', 'id', 'effect'],
    ),
    run(ctx: Ctx, a: { into: string; id: string; effect: string; x?: number; y?: number; scale?: number }) {
      const h = heirCtx(ctx);
      const parent = mergedNode(ctx, a.into);
      if (!parent) throw new CommandError('E_EDITOR_NO_NODE', `into: the scene has no node #${a.into}`);
      if (parent.tag !== 'g' && parent.tag !== 'svg') throw new CommandError('E_EDITOR_TAG', `into: #${a.into} is a <${parent.tag}> — an effect goes into a group`);
      if (mergedNode(ctx, a.id) || heirElement(h, a.id) || ctx.byId(a.id).length) throw new CommandError('E_EDITOR_ID_TAKEN', `id: "${a.id}" is already in the scene`);
      const g = h.doc.createElement('g');
      g.setAttribute('id', a.id);
      g.setAttribute('tml:insert', `into ${a.into}`);
      g.setAttribute('tml:type', 'fx');
      const x = a.x ?? 0;
      const y = a.y ?? 0;
      if (x !== 0 || y !== 0) g.setAttribute('transform', `translate(${fmt(x)} ${fmt(y)})`);
      g.setAttribute('data-effect', a.effect);
      if (a.scale != null && a.scale !== 1) g.setAttribute('data-scale', fmt(a.scale));
      h.insert(h.root, g);
    },
  },
} satisfies Record<string, { describe: string; schema: JSONSchema7; run(ctx: Ctx, a: never): void }>;

/** Commands that write the heir, allowed when the base is read-only (a scene extending another). */
export const HEIR_COMMANDS = new Set(Object.keys(heirCommands));
