/**
 * Versioned JSON Schemas for every entity in the contract.
 *
 * The schemas are the single source of truth shared by the server, the client
 * and the fixtures; the TypeScript interfaces in `model.ts` are the compile
 * time view of the same shapes and are checked against these at test time.
 */

import { SCHEMA_VERSION, type EntityKind } from './model.js';
import type { JsonSchema } from './validate.js';

const SCHEMA_BASE = 'https://smartnotes.dev/schemas/v1';

const ID: JsonSchema = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_:.@-]+$' };
const TIMESTAMP: JsonSchema = { type: 'integer', minimum: 0 };
const COLOR: JsonSchema = { type: 'string', pattern: '^#[0-9a-f]{6}$' };
const VERSION: JsonSchema = { type: 'integer', const: SCHEMA_VERSION };
const ANY: JsonSchema = {};

const STAMP: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['lamport', 'actor', 'seq'],
  properties: {
    lamport: { type: 'integer', minimum: 0 },
    actor: ID,
    seq: { type: 'integer', minimum: 0 },
  },
};

const RECT: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['x', 'y', 'width', 'height'],
  properties: {
    x: { type: 'number', minimum: 0 },
    y: { type: 'number', minimum: 0 },
    width: { type: 'number', minimum: 0 },
    height: { type: 'number', minimum: 0 },
  },
};

const CONFLICT_SIDE: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['opId', 'stamp', 'value'],
  properties: { opId: ID, stamp: STAMP, value: ANY },
};

function entity(kind: EntityKind, required: string[], properties: Record<string, JsonSchema>): JsonSchema {
  return {
    $id: `${SCHEMA_BASE}/${kind}.json`,
    title: kind,
    type: 'object',
    additionalProperties: false,
    required: ['schemaVersion', ...required],
    properties: { schemaVersion: VERSION, ...properties },
  };
}

export const userSchema = entity('user', ['id', 'email', 'displayName', 'createdAt'], {
  id: ID,
  email: { type: 'string', minLength: 3, maxLength: 320, pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$' },
  displayName: { type: 'string', minLength: 1, maxLength: 120 },
  createdAt: TIMESTAMP,
});

export const notebookSchema = entity('notebook', ['id', 'ownerId', 'title', 'color', 'createdAt', 'updatedAt'], {
  id: ID,
  ownerId: ID,
  title: { type: 'string', minLength: 1, maxLength: 200 },
  color: { anyOf: [COLOR, { type: 'null' }] },
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
});

export const noteSchema = entity('note', ['id', 'notebookId', 'title', 'body', 'position', 'createdAt', 'updatedAt'], {
  id: ID,
  notebookId: ID,
  title: { type: 'string', maxLength: 200 },
  body: { type: 'string', maxLength: 1000000 },
  position: { type: 'number' },
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
});

export const revisionSchema = entity('revision', ['id', 'noteId', 'body', 'hash', 'actor', 'createdAt'], {
  id: ID,
  noteId: ID,
  body: { type: 'string', maxLength: 1000000 },
  hash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
  actor: ID,
  createdAt: TIMESTAMP,
});

export const tombstoneSchema = entity('tombstone', ['entityKind', 'entityId', 'notebookId', 'stamp', 'deletedAt'], {
  entityKind: { enum: ['notebook', 'note', 'pdf', 'annotation', 'stroke'] },
  entityId: ID,
  notebookId: ID,
  stamp: STAMP,
  deletedAt: TIMESTAMP,
});

export const pdfSchema = entity('pdf', ['id', 'notebookId', 'filename', 'byteSize', 'sha256', 'pageCount', 'createdAt'], {
  id: ID,
  notebookId: ID,
  filename: { type: 'string', minLength: 1, maxLength: 260 },
  byteSize: { type: 'integer', minimum: 0 },
  sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
  pageCount: { type: 'integer', minimum: 0 },
  createdAt: TIMESTAMP,
});

export const annotationSchema = entity(
  'annotation',
  ['id', 'pdfId', 'notebookId', 'page', 'kind', 'rect', 'color', 'text', 'strokeId', 'createdAt', 'updatedAt'],
  {
    id: ID,
    pdfId: ID,
    notebookId: ID,
    page: { type: 'integer', minimum: 0 },
    kind: { enum: ['highlight', 'note', 'ink'] },
    rect: { anyOf: [RECT, { type: 'null' }] },
    color: COLOR,
    text: { anyOf: [{ type: 'string', maxLength: 10000 }, { type: 'null' }] },
    strokeId: { anyOf: [ID, { type: 'null' }] },
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  },
);

export const strokeSchema = entity(
  'stroke',
  ['id', 'notebookId', 'targetKind', 'targetId', 'page', 'color', 'width', 'points', 'createdAt'],
  {
    id: ID,
    notebookId: ID,
    targetKind: { enum: ['note', 'pdf'] },
    targetId: ID,
    page: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] },
    color: COLOR,
    width: { type: 'integer', minimum: 1, maximum: 1000 },
    points: { type: 'array', items: { type: 'integer' }, maxItems: 200000 },
    createdAt: TIMESTAMP,
  },
);

export const conflictSchema = entity(
  'conflict',
  ['id', 'entityKind', 'entityId', 'field', 'winner', 'losers', 'detectedAt'],
  {
    id: ID,
    entityKind: { enum: ['notebook', 'note', 'pdf', 'annotation', 'stroke'] },
    entityId: ID,
    field: { type: 'string', minLength: 1, maxLength: 64 },
    winner: CONFLICT_SIDE,
    losers: { type: 'array', items: CONFLICT_SIDE, minItems: 1 },
    detectedAt: TIMESTAMP,
  },
);

export const operationSchema: JsonSchema = {
  $id: `${SCHEMA_BASE}/operation.json`,
  title: 'operation',
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'opId',
    'entityKind',
    'entityId',
    'notebookId',
    'kind',
    'fields',
    'actor',
    'lamport',
    'seq',
    'basis',
    'at',
  ],
  properties: {
    schemaVersion: VERSION,
    opId: ID,
    entityKind: { enum: ['notebook', 'note', 'pdf', 'annotation', 'stroke'] },
    entityId: ID,
    notebookId: ID,
    kind: { enum: ['set', 'delete'] },
    fields: { type: 'object', additionalProperties: ANY },
    actor: ID,
    lamport: { type: 'integer', minimum: 0 },
    seq: { type: 'integer', minimum: 0 },
    basis: { type: 'integer', minimum: 0 },
    at: TIMESTAMP,
  },
};

/** Every entity schema, addressable by kind. */
export const SCHEMAS: Record<EntityKind, JsonSchema> = {
  user: userSchema,
  notebook: notebookSchema,
  note: noteSchema,
  revision: revisionSchema,
  tombstone: tombstoneSchema,
  pdf: pdfSchema,
  annotation: annotationSchema,
  stroke: strokeSchema,
  conflict: conflictSchema,
};

export function schemaFor(kind: EntityKind): JsonSchema {
  const schema = SCHEMAS[kind];
  if (!schema) throw new Error(`no schema for entity kind ${kind}`);
  return schema;
}

/**
 * Fields the server owns; a client operation that writes one is rejected.
 */
export const SERVER_OWNED_FIELDS: Record<string, readonly string[]> = {
  notebook: ['ownerId'],
  pdf: ['sha256', 'byteSize'],
};

/** Fields a client may write on a synced entity, derived from its schema. */
export function writableFields(kind: EntityKind): string[] {
  const owned = new Set<string>(['schemaVersion', 'id', 'notebookId', ...(SERVER_OWNED_FIELDS[kind] ?? [])]);
  return Object.keys(schemaFor(kind).properties ?? {}).filter((name) => !owned.has(name));
}
