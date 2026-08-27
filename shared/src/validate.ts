/**
 * A validator for the JSON Schema subset the SmartNotes contract uses:
 * type, enum, const, properties, required, additionalProperties, items,
 * numeric and length bounds, pattern, and local `$ref` into `$defs`.
 *
 * Vendoring ~120 lines beats a schema library here because the contract has to
 * validate identically on the server, in tests, and in a browser client with
 * no bundler step.
 */

import type { JsonValue } from './json.js';

export interface JsonSchema {
  $id?: string;
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  title?: string;
  description?: string;
  type?: SchemaType | SchemaType[];
  enum?: JsonValue[];
  const?: JsonValue;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  anyOf?: JsonSchema[];
}

export type SchemaType = 'null' | 'boolean' | 'integer' | 'number' | 'string' | 'array' | 'object';

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

export class ValidationError extends Error {
  constructor(
    message: string,
    readonly issues: ValidationIssue[],
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

function typeOf(value: unknown): SchemaType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  if (t === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (t === 'boolean' || t === 'string') return t;
  return 'object';
}

function matchesType(value: unknown, type: SchemaType): boolean {
  const actual = typeOf(value);
  if (type === 'number') return actual === 'number' || actual === 'integer';
  if (type === 'object') return actual === 'object' && typeof value === 'object';
  return actual === type;
}

function resolve(schema: JsonSchema, root: JsonSchema): JsonSchema {
  if (!schema.$ref) return schema;
  const ref = schema.$ref;
  if (!ref.startsWith('#/$defs/')) throw new Error(`unsupported $ref: ${ref}`);
  const target = root.$defs?.[ref.slice('#/$defs/'.length)];
  if (!target) throw new Error(`unresolved $ref: ${ref}`);
  return resolve(target, root);
}

function check(value: unknown, schema: JsonSchema, root: JsonSchema, path: string, issues: ValidationIssue[]): void {
  const node = resolve(schema, root);
  const fail = (message: string): void => {
    issues.push({ path, message });
  };

  if (node.type !== undefined) {
    const types = Array.isArray(node.type) ? node.type : [node.type];
    if (!types.some((t) => matchesType(value, t))) {
      fail(`expected ${types.join(' or ')}, got ${typeOf(value)}`);
      return;
    }
  }

  if (node.const !== undefined && JSON.stringify(value) !== JSON.stringify(node.const)) {
    fail(`expected constant ${JSON.stringify(node.const)}`);
  }

  if (node.enum && !node.enum.some((option) => JSON.stringify(option) === JSON.stringify(value))) {
    fail(`expected one of ${node.enum.map((o) => JSON.stringify(o)).join(', ')}`);
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('number must be finite');
    if (node.minimum !== undefined && value < node.minimum) fail(`must be >= ${node.minimum}`);
    if (node.maximum !== undefined && value > node.maximum) fail(`must be <= ${node.maximum}`);
  }

  if (typeof value === 'string') {
    if (node.minLength !== undefined && value.length < node.minLength) fail(`must be at least ${node.minLength} characters`);
    if (node.maxLength !== undefined && value.length > node.maxLength) fail(`must be at most ${node.maxLength} characters`);
    if (node.pattern !== undefined && !new RegExp(node.pattern, 'u').test(value)) fail(`must match ${node.pattern}`);
  }

  if (Array.isArray(value)) {
    if (node.minItems !== undefined && value.length < node.minItems) fail(`must have at least ${node.minItems} items`);
    if (node.maxItems !== undefined && value.length > node.maxItems) fail(`must have at most ${node.maxItems} items`);
    if (node.items) value.forEach((item, i) => check(item, node.items!, root, `${path}[${i}]`, issues));
  }

  if (typeOf(value) === 'object' && typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    for (const key of node.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) fail(`missing required property "${key}"`);
    }
    for (const [key, child] of Object.entries(record)) {
      const childSchema = node.properties?.[key];
      if (childSchema) {
        check(child, childSchema, root, `${path}.${key}`, issues);
      } else if (node.additionalProperties === false) {
        fail(`unexpected property "${key}"`);
      } else if (typeof node.additionalProperties === 'object') {
        check(child, node.additionalProperties, root, `${path}.${key}`, issues);
      }
    }
  }

  if (node.anyOf) {
    const attempts = node.anyOf.map((option) => validateWith(value, option, root, path));
    if (!attempts.some((attempt) => attempt.valid)) {
      fail('did not match any permitted variant');
      // Surface the closest variant's issues so nested paths are not lost.
      const closest = attempts.reduce((best, attempt) => (attempt.issues.length < best.issues.length ? attempt : best));
      issues.push(...closest.issues);
    }
  }
}

function validateWith(value: unknown, schema: JsonSchema, root: JsonSchema, path = '$'): ValidationResult {
  const issues: ValidationIssue[] = [];
  check(value, schema, root, path, issues);
  return { valid: issues.length === 0, issues };
}

export function validate(value: unknown, schema: JsonSchema): ValidationResult {
  return validateWith(value, schema, schema);
}

export function assertValid<T>(value: unknown, schema: JsonSchema, label: string): T {
  const result = validate(value, schema);
  if (!result.valid) {
    const detail = result.issues.map((i) => `${i.path}: ${i.message}`).join('; ');
    throw new ValidationError(`invalid ${label}: ${detail}`, result.issues);
  }
  return value as T;
}
