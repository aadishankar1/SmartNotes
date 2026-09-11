/**
 * Regenerates `shared/fixtures/v1/*` — `npm run fixtures`.
 *
 * The fixtures are checked in so that a change to serialization or to the
 * schemas shows up as a diff rather than as a silently different corpus. Every
 * fixture is validated here before it is written.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SCHEMA_VERSION,
  assertValid,
  canonicalize,
  createOperation,
  encodeStroke,
  hashJson,
  schemaFor,
  sha256Hex,
  type EntityKind,
  type Operation,
} from '../src/index.js';
import { fixtureDir } from './fixtures.js';

const T0 = 1767225600000; // 2026-01-01T00:00:00Z
const NOTEBOOK = 'nb_field';

const noteBody = 'Kickoff\n- confirm the sensor layout\n- pack spare styluses';
const pdfDigest = sha256Hex('%PDF-1.7 smartnotes fixture syllabus');

const entities: Array<{ name: string; kind: EntityKind; value: Record<string, unknown> }> = [
  {
    name: 'user',
    kind: 'user',
    value: {
      schemaVersion: SCHEMA_VERSION,
      id: 'usr_alice',
      email: 'alice@example.com',
      displayName: 'Alice Nakamura',
      createdAt: T0,
    },
  },
  {
    name: 'notebook',
    kind: 'notebook',
    value: {
      schemaVersion: SCHEMA_VERSION,
      id: NOTEBOOK,
      ownerId: 'usr_alice',
      title: 'Field notes',
      color: '#2f80ed',
      createdAt: T0,
      updatedAt: T0 + 60000,
    },
  },
  {
    name: 'note',
    kind: 'note',
    value: {
      schemaVersion: SCHEMA_VERSION,
      id: 'note_kickoff',
      notebookId: NOTEBOOK,
      title: 'Kickoff',
      body: noteBody,
      position: 1,
      createdAt: T0,
      updatedAt: T0 + 120000,
    },
  },
  {
    name: 'revision',
    kind: 'revision',
    value: {
      schemaVersion: SCHEMA_VERSION,
      id: 'rev_kickoff_1',
      noteId: 'note_kickoff',
      body: noteBody,
      hash: sha256Hex(noteBody),
      actor: 'dev_ipad',
      createdAt: T0 + 120000,
    },
  },
  {
    name: 'tombstone',
    kind: 'tombstone',
    value: {
      schemaVersion: SCHEMA_VERSION,
      entityKind: 'note',
      entityId: 'note_scratch',
      notebookId: NOTEBOOK,
      stamp: { lamport: 9, actor: 'dev_ipad', seq: 4 },
      deletedAt: T0 + 300000,
    },
  },
  {
    name: 'pdf',
    kind: 'pdf',
    value: {
      schemaVersion: SCHEMA_VERSION,
      id: 'pdf_syllabus',
      notebookId: NOTEBOOK,
      filename: 'syllabus.pdf',
      byteSize: 35,
      sha256: pdfDigest,
      pageCount: 3,
      createdAt: T0 + 400000,
    },
  },
  {
    name: 'annotation',
    kind: 'annotation',
    value: {
      schemaVersion: SCHEMA_VERSION,
      id: 'anno_week3',
      pdfId: 'pdf_syllabus',
      notebookId: NOTEBOOK,
      page: 2,
      kind: 'highlight',
      rect: { x: 72, y: 320.5, width: 180, height: 14 },
      color: '#ffd60a',
      text: 'lab report due',
      strokeId: 'ink_week3',
      createdAt: T0 + 500000,
      updatedAt: T0 + 500000,
    },
  },
  {
    name: 'stroke',
    kind: 'stroke',
    value: {
      schemaVersion: SCHEMA_VERSION,
      id: 'ink_week3',
      notebookId: NOTEBOOK,
      targetKind: 'pdf',
      targetId: 'pdf_syllabus',
      page: 2,
      color: '#1f2933',
      width: 3,
      points: encodeStroke([
        { x: 72, y: 320.5, pressure: 0.4, t: 0 },
        { x: 74.25, y: 321, pressure: 0.62, t: 16 },
        { x: 78.5, y: 322.75, pressure: 0.71, t: 33 },
        { x: 84, y: 323, pressure: 0.5, t: 51 },
      ]),
      createdAt: T0 + 500000,
    },
  },
];

/** Two devices editing the same note while offline, plus a raced delete. */
function conflictingOperations(): Operation[] {
  const ipad = (lamport: number, seq: number, basis: number, fields: Record<string, unknown>): Operation =>
    createOperation({
      entityKind: 'note',
      entityId: 'note_kickoff',
      notebookId: NOTEBOOK,
      fields,
      actor: 'dev_ipad',
      lamport,
      seq,
      basis,
      at: T0 + lamport * 1000,
    });
  const mac = (lamport: number, seq: number, basis: number, fields: Record<string, unknown>): Operation =>
    createOperation({
      entityKind: 'note',
      entityId: 'note_kickoff',
      notebookId: NOTEBOOK,
      fields,
      actor: 'dev_mac',
      lamport,
      seq,
      basis,
      at: T0 + lamport * 1000,
    });

  return [
    ipad(1, 0, 0, {
      title: 'Kickoff',
      body: noteBody,
      position: 1,
      createdAt: T0,
      updatedAt: T0,
    }),
    // Both devices saw lamport 1 and then edited offline: concurrent.
    ipad(2, 1, 1, { title: 'Kickoff (field)', updatedAt: T0 + 2000 }),
    mac(2, 0, 1, { title: 'Kickoff (lab)', body: `${noteBody}\n- borrow the tripod`, updatedAt: T0 + 2000 }),
    // A third device deletes a scratch note that nobody else touched.
    createOperation({
      entityKind: 'note',
      entityId: 'note_scratch',
      notebookId: NOTEBOOK,
      fields: { title: 'Scratch', body: '', position: 2, createdAt: T0, updatedAt: T0 },
      actor: 'dev_phone',
      lamport: 1,
      seq: 0,
      basis: 0,
      at: T0 + 1000,
    }),
    createOperation({
      entityKind: 'note',
      entityId: 'note_scratch',
      notebookId: NOTEBOOK,
      kind: 'delete',
      actor: 'dev_phone',
      lamport: 3,
      seq: 1,
      basis: 2,
      at: T0 + 3000,
    }),
  ];
}

function main(): void {
  const dir = fixtureDir();
  mkdirSync(dir, { recursive: true });
  const digests: Record<string, string> = {};

  for (const { name, kind, value } of entities) {
    assertValid(value, schemaFor(kind), name);
    writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    digests[name] = hashJson(value);
  }

  const operations = conflictingOperations();
  const opsFixture = { schemaVersion: SCHEMA_VERSION, notebookId: NOTEBOOK, ops: operations };
  writeFileSync(join(dir, 'operations.json'), `${JSON.stringify(opsFixture, null, 2)}\n`, 'utf8');
  digests['operations'] = hashJson(opsFixture);

  const conflict = {
    schemaVersion: SCHEMA_VERSION,
    id: hashJson(['note', 'note_kickoff', 'title']).slice(0, 32),
    entityKind: 'note',
    entityId: 'note_kickoff',
    field: 'title',
    winner: { opId: operations[2]!.opId, stamp: { lamport: 2, actor: 'dev_mac', seq: 0 }, value: 'Kickoff (lab)' },
    losers: [{ opId: operations[1]!.opId, stamp: { lamport: 2, actor: 'dev_ipad', seq: 1 }, value: 'Kickoff (field)' }],
    detectedAt: T0 + 2000,
  };
  assertValid(conflict, schemaFor('conflict'), 'conflict');
  writeFileSync(join(dir, 'conflict.json'), `${JSON.stringify(conflict, null, 2)}\n`, 'utf8');
  digests['conflict'] = hashJson(conflict);

  writeFileSync(join(dir, 'digests.json'), `${JSON.stringify(digests, null, 2)}\n`, 'utf8');
  process.stdout.write(`wrote ${Object.keys(digests).length + 1} fixtures to ${dir}\n`);
  process.stdout.write(`${canonicalize(digests).slice(0, 80)}...\n`);
}

main();
