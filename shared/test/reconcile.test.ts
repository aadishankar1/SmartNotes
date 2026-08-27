import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ContractError,
  DELETED_FIELD,
  createOperation,
  foldOperations,
  materialize,
  stateDigest,
  type Operation,
} from '../src/index.js';
import { loadFixture } from './fixtures.js';

const NOTEBOOK = 'nb_field';
const T0 = 1767225600000;

function edit(actor: string, lamport: number, seq: number, basis: number, fields: Record<string, unknown>, entityId = 'note_1'): Operation {
  return createOperation({
    entityKind: 'note',
    entityId,
    notebookId: NOTEBOOK,
    fields,
    actor,
    lamport,
    seq,
    basis,
    at: T0 + lamport * 1000,
  });
}

function remove(actor: string, lamport: number, seq: number, basis: number, entityId = 'note_1'): Operation {
  return createOperation({
    entityKind: 'note',
    entityId,
    notebookId: NOTEBOOK,
    kind: 'delete',
    actor,
    lamport,
    seq,
    basis,
    at: T0 + lamport * 1000,
  });
}

const create = edit('dev_a', 1, 0, 0, { title: 'Kickoff', body: '', position: 1, createdAt: T0, updatedAt: T0 });

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of permutations(rest)) out.push([items[i]!, ...tail]);
  }
  return out;
}

describe('reconciliation is order independent', () => {
  const ops = [
    create,
    edit('dev_a', 2, 1, 1, { title: 'Kickoff (field)', updatedAt: T0 + 2000 }),
    edit('dev_b', 2, 0, 1, { title: 'Kickoff (lab)', body: 'borrow tripod', updatedAt: T0 + 2000 }),
    edit('dev_b', 3, 1, 2, { position: 4, updatedAt: T0 + 3000 }),
  ];

  it('produces one digest across every arrival order', () => {
    const digests = new Set(permutations(ops).map((order) => stateDigest(foldOperations(order))));
    assert.equal(digests.size, 1, 'fold must not depend on arrival order');
  });

  it('is idempotent under replay', () => {
    const once = foldOperations(ops);
    const twice = foldOperations([...ops, ...ops].reverse(), foldOperations(ops));
    assert.equal(stateDigest(once), stateDigest(twice));
    assert.equal(materialize(twice).entities.length, 1, 'replay must not duplicate the entity');
  });

  it('refuses two different payloads under one operation id', () => {
    const forged = { ...ops[1]!, fields: { title: 'forged' } } as Operation;
    assert.throws(() => foldOperations([ops[1]!, forged]), ContractError);
  });
});

describe('per-field last writer wins', () => {
  const ops = [
    create,
    edit('dev_a', 2, 1, 1, { title: 'Kickoff (field)', updatedAt: T0 + 2000 }),
    edit('dev_b', 2, 0, 1, { title: 'Kickoff (lab)', body: 'borrow tripod', updatedAt: T0 + 2000 }),
  ];

  it('keeps the highest stamp per field, not per record', () => {
    const view = materialize(foldOperations(ops));
    const note = view.entities[0]!.record;
    assert.equal(note['title'], 'Kickoff (lab)'); // dev_b wins the tie at lamport 2
    assert.equal(note['body'], 'borrow tripod'); // uncontested field survives
    assert.equal(note['position'], 1); // untouched field is not clobbered
  });

  it('records the losing concurrent write instead of dropping it', () => {
    const view = materialize(foldOperations(ops));
    const conflict = view.conflicts.find((c) => c.field === 'title');
    assert.ok(conflict, 'concurrent title writes must surface a conflict');
    assert.equal(conflict.winner.value, 'Kickoff (lab)');
    assert.deepEqual(
      conflict.losers.map((l) => l.value),
      ['Kickoff (field)'],
    );
    assert.equal(view.conflicts.filter((c) => c.field === 'body').length, 0);
  });

  it('does not call a causal overwrite a conflict', () => {
    const later = edit('dev_a', 5, 2, 4, { title: 'Kickoff final', updatedAt: T0 + 5000 });
    const view = materialize(foldOperations([...ops, later]));
    assert.equal(view.entities[0]!.record['title'], 'Kickoff final');
    assert.equal(view.conflicts.length, 0, 'a write that observed the others is not concurrent');
  });

  it('bounds retained concurrent writes per field', () => {
    const many = Array.from({ length: 40 }, (_, i) => edit(`dev_${String(i).padStart(2, '0')}`, 2, 0, 1, { title: `t${i}` }));
    const state = foldOperations([create, ...many]);
    const field = state.entities['note:note_1']!.fields['title']!;
    assert.ok(field.writes.length <= 16, 'antichain must stay bounded');
    assert.equal(materialize(state).entities[0]!.record['title'], 't39');
  });
});

describe('tombstones', () => {
  it('removes an entity and reports it as a tombstone', () => {
    const view = materialize(foldOperations([create, remove('dev_b', 4, 0, 3)]));
    assert.equal(view.entities.length, 0);
    assert.equal(view.tombstones.length, 1);
    assert.equal(view.tombstones[0]!.entityId, 'note_1');
    assert.equal(view.tombstones[0]!.notebookId, NOTEBOOK);
  });

  it('lets a strictly later edit resurrect the record and flags the race', () => {
    const ops = [create, remove('dev_b', 4, 0, 3), edit('dev_a', 5, 1, 3, { title: 'back', updatedAt: T0 + 5000 })];
    const view = materialize(foldOperations(ops));
    assert.equal(view.entities.length, 1);
    assert.equal(view.tombstones.length, 0);
    assert.ok(view.conflicts.some((c) => c.field === DELETED_FIELD));
  });

  it('keeps the delete when no write observed or beat it', () => {
    const ops = [create, edit('dev_a', 2, 1, 1, { title: 'edited' }), remove('dev_b', 3, 0, 2)];
    const view = materialize(foldOperations(ops));
    assert.equal(view.entities.length, 0);
    assert.equal(view.tombstones.length, 1);
  });

  it('converges no matter which side arrives first', () => {
    const ops = [create, remove('dev_b', 4, 0, 3), edit('dev_a', 5, 1, 3, { title: 'back', updatedAt: T0 + 5000 })];
    assert.equal(stateDigest(foldOperations(ops)), stateDigest(foldOperations([...ops].reverse())));
  });
});

describe('reconnect reconciliation', () => {
  it('merges a peer log into local state without duplication', () => {
    const local = foldOperations([create, edit('dev_a', 2, 1, 1, { body: 'local work' })]);
    const remoteOps = [create, edit('dev_b', 3, 0, 1, { body: 'remote work' })];
    const merged = foldOperations(remoteOps, local);
    const other = foldOperations([create, edit('dev_a', 2, 1, 1, { body: 'local work' })], foldOperations(remoteOps));
    assert.equal(stateDigest(merged), stateDigest(other));
    assert.equal(materialize(merged).entities.length, 1);
    assert.equal(materialize(merged).entities[0]!.record['body'], 'remote work');
  });

  it('reproduces the checked-in operations fixture exactly', () => {
    const fixture = loadFixture<{ ops: Operation[] }>('operations');
    const view = materialize(foldOperations(fixture.ops));
    assert.equal(view.entities.length, 1);
    assert.equal(view.entities[0]!.record['title'], 'Kickoff (lab)');
    assert.equal(view.tombstones.length, 1);
    assert.equal(view.tombstones[0]!.entityId, 'note_scratch');
    assert.deepEqual(loadFixture('conflict'), { ...view.conflicts[0] });
    assert.deepEqual(view.invalid, []);
  });
});
