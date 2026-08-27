import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ENTITY_KINDS,
  SCHEMA_VERSION,
  ValidationError,
  assertValid,
  createOperation,
  isSyncedKind,
  operationSchema,
  schemaFor,
  syncRequestSchema,
  validate,
  validateOperation,
  writableFields,
  ContractError,
} from '../src/index.js';
import { loadFixture } from './fixtures.js';

describe('schema validation', () => {
  it('rejects a record missing a required property', () => {
    const note = loadFixture<Record<string, unknown>>('note');
    delete note['body'];
    const result = validate(note, schemaFor('note'));
    assert.equal(result.valid, false);
    assert.ok(result.issues.some((i) => i.message.includes('missing required property "body"')));
  });

  it('rejects unknown properties rather than silently keeping them', () => {
    const note = { ...loadFixture<Record<string, unknown>>('note'), sneaky: true };
    const result = validate(note, schemaFor('note'));
    assert.equal(result.valid, false);
    assert.ok(result.issues.some((i) => i.message.includes('unexpected property "sneaky"')));
  });

  it('gates on schema version', () => {
    const note = { ...loadFixture<Record<string, unknown>>('note'), schemaVersion: SCHEMA_VERSION + 1 };
    assert.equal(validate(note, schemaFor('note')).valid, false);
  });

  it('enforces enums, patterns and bounds', () => {
    const annotation = loadFixture<Record<string, unknown>>('annotation');
    assert.equal(validate({ ...annotation, kind: 'scribble' }, schemaFor('annotation')).valid, false);
    assert.equal(validate({ ...annotation, color: 'yellow' }, schemaFor('annotation')).valid, false);
    assert.equal(validate({ ...annotation, page: -1 }, schemaFor('annotation')).valid, false);
    assert.equal(validate({ ...annotation, rect: null }, schemaFor('annotation')).valid, true);
  });

  it('reports a path for nested failures', () => {
    const annotation = loadFixture<Record<string, unknown>>('annotation');
    const result = validate({ ...annotation, rect: { x: 1, y: 2, width: 3, height: 'tall' } }, schemaFor('annotation'));
    assert.equal(result.valid, false);
    assert.ok(result.issues.some((i) => i.path === '$.rect.height'));
  });

  it('throws a typed error from assertValid', () => {
    assert.throws(() => assertValid({}, schemaFor('user'), 'user'), ValidationError);
  });

  it('has a schema for every declared entity kind', () => {
    for (const kind of ENTITY_KINDS) assert.ok(schemaFor(kind).properties);
  });
});

describe('writable fields', () => {
  it('excludes identity and server-owned fields', () => {
    assert.ok(!writableFields('notebook').includes('ownerId'));
    assert.ok(!writableFields('notebook').includes('id'));
    assert.ok(!writableFields('note').includes('notebookId'));
    assert.ok(!writableFields('pdf').includes('sha256'));
    assert.ok(!writableFields('pdf').includes('byteSize'));
  });

  it('keeps the fields a device legitimately edits', () => {
    assert.ok(writableFields('note').includes('body'));
    assert.ok(writableFields('annotation').includes('rect'));
    assert.ok(writableFields('stroke').includes('points'));
  });

  it('knows which kinds are syncable', () => {
    assert.ok(isSyncedKind('note'));
    assert.ok(!isSyncedKind('user'));
    assert.ok(!isSyncedKind('revision'));
  });
});

describe('operation contract', () => {
  const base = {
    entityKind: 'note' as const,
    entityId: 'note_1',
    notebookId: 'nb_1',
    actor: 'dev_a',
    lamport: 3,
    seq: 1,
    basis: 2,
    at: 1767225600000,
  };

  it('derives a content-addressed id, so a retry deduplicates', () => {
    const first = createOperation({ ...base, fields: { title: 'x' } });
    const second = createOperation({ ...base, fields: { title: 'x' } });
    assert.equal(first.opId, second.opId);
    assert.notEqual(first.opId, createOperation({ ...base, fields: { title: 'y' } }).opId);
    assert.equal(validate(first, operationSchema).valid, true);
  });

  it('refuses operations that violate the contract', () => {
    assert.throws(() => createOperation({ ...base, fields: {} }), ContractError);
    assert.throws(() => validateOperation({ ...createOperation({ ...base, fields: { title: 'x' } }), basis: 99 }), ContractError);
    const del = createOperation({ ...base, kind: 'delete' });
    assert.throws(() => validateOperation({ ...del, fields: { title: 'x' } }), ContractError);
  });

  it('validates the sync envelope', () => {
    const op = createOperation({ ...base, fields: { title: 'x' } });
    const request = { schemaVersion: SCHEMA_VERSION, deviceId: 'dev_a', notebookId: 'nb_1', cursor: 0, ops: [op] };
    assert.equal(validate(request, syncRequestSchema).valid, true);
    assert.equal(validate({ ...request, cursor: -1 }, syncRequestSchema).valid, false);
    assert.equal(validate({ ...request, ops: [{ ...op, entityKind: 'user' }] }, syncRequestSchema).valid, false);
  });
});
