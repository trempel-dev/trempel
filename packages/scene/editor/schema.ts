// schema.ts — the JSON Schema subset the command registry uses, and a checker for it.
//
// Command arguments are described with plain JSON Schema (draft-07 keywords) so the registry can
// be handed to an agent as tool definitions as is. The checker covers exactly the keywords the
// commands use — no dependency, messages for a human ("node: ожидается строка").

import { coded } from '@trempel/scene/core';

export interface JSONSchema7 {
  type?: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'null' | 'array' | ('object' | 'string' | 'number' | 'integer' | 'boolean' | 'null' | 'array')[];
  description?: string;
  properties?: Record<string, JSONSchema7>;
  required?: string[];
  additionalProperties?: boolean | JSONSchema7;
  items?: JSONSchema7;
  minItems?: number;
  maxItems?: number;
  enum?: (string | number | boolean | null)[];
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  pattern?: string;
  anyOf?: JSONSchema7[];
  default?: unknown;
}

const TYPE_NAME: Record<string, string> = {
  object: 'an object',
  string: 'a string',
  number: 'a number',
  integer: 'an integer',
  boolean: 'true/false',
  null: 'null',
  array: 'an array',
};

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function matchesType(v: unknown, t: string): boolean {
  switch (t) {
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v);
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    default:
      return typeOf(v) === t;
  }
}

/** Every violation of `schema` by `value`; `at` prefixes the messages (the argument name). */
export function checkSchema(schema: JSONSchema7, value: unknown, at = ''): string[] {
  return violations(schema, value, at).map((e) => coded('E_EDITOR_ARGS', e));
}

function violations(schema: JSONSchema7, value: unknown, at: string): string[] {
  const where = at || 'arguments';
  if (schema.anyOf) {
    const fits = schema.anyOf.some((s) => violations(s, value, at).length === 0);
    if (fits) return [];
    const types = schema.anyOf.map((s) => (Array.isArray(s.type) ? s.type : [s.type])).flat().filter(Boolean) as string[];
    return [`${where}: expected ${[...new Set(types)].map((t) => TYPE_NAME[t] ?? t).join(' or ')}`];
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      return [`${where}: expected ${types.map((t) => TYPE_NAME[t] ?? t).join(' or ')}, got ${value === undefined ? 'nothing' : JSON.stringify(value)}`];
    }
  }
  const errors: string[] = [];
  if (schema.enum && !schema.enum.includes(value as never)) {
    errors.push(`${where}: one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}, got ${JSON.stringify(value)}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) errors.push(`${where}: at least ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) errors.push(`${where}: at most ${schema.maximum}`);
    if (schema.exclusiveMinimum != null && value <= schema.exclusiveMinimum) errors.push(`${where}: greater than ${schema.exclusiveMinimum}`);
    if (schema.exclusiveMaximum != null && value >= schema.exclusiveMaximum) errors.push(`${where}: less than ${schema.exclusiveMaximum}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) errors.push(`${where}: an empty string`);
    if (schema.pattern != null && !new RegExp(schema.pattern).test(value)) errors.push(`${where}: "${value}" does not match ${schema.pattern}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) errors.push(`${where}: at least ${schema.minItems} item(s)`);
    if (schema.maxItems != null && value.length > schema.maxItems) errors.push(`${where}: at most ${schema.maxItems} item(s)`);
    if (schema.items) value.forEach((v, i) => errors.push(...violations(schema.items!, v, `${where}[${i}]`)));
  }
  if (typeOf(value) === 'object') {
    const obj = value as Record<string, unknown>;
    for (const r of schema.required ?? []) {
      if (obj[r] === undefined) errors.push(`${at ? `${at}.` : ''}${r}: a required argument`);
    }
    for (const [k, v] of Object.entries(obj)) {
      const sub = schema.properties?.[k];
      const name = at ? `${at}.${k}` : k;
      if (sub) errors.push(...violations(sub, v, name));
      else if (schema.additionalProperties === false) {
        errors.push(`${name}: an unknown argument (known: ${Object.keys(schema.properties ?? {}).join(', ') || 'none'})`);
      } else if (typeof schema.additionalProperties === 'object') errors.push(...violations(schema.additionalProperties, v, name));
    }
  }
  return errors;
}
