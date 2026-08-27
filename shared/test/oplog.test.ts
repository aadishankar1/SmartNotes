import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { OperationLog, createOperation, foldOperations, materialize, stateDigest, type Operation } from '../src/index.js';

const T0 = 1767225600000;

function op(index: number, actor = 'dev_a'): Operation {
  return createOperation({
    entityKind: 'note',
    entityId: `note_${index}`,
    notebookId: 'nb_1',
    fields: { title: `note ${index}`, body: '', position: index, createdAt: T0, updatedAt: T0 + index },
    actor,
    lamport: index + 1,
    seq: index,
    basis: index,
    at: T0 + index,
  });
}

describe('bounded operation log', () => {
  it('assigns increasing indexes and deduplicates replays', () => {
    const log = new OperationLog({ limit: 10 });
    const first = log.append(op(1));
    const replay = log.append(op(1));
    assert.equal(replay.duplicate, true);
    assert.equal(replay.index, first.index);
    assert.equal(log.size, 1);
    assert.equal(log.head, 1);
  });

  it('never grows past its limit', () => {
    const log = new OperationLog({ limit: 8 });
    for (let i = 0; i < 50; i++) log.append(op(i));
    assert.equal(log.size, 8);
    assert.equal(log.head, 50);
    assert.ok(log.floor > 0, 'older operations should be folded into a checkpoint');
  });

  it('keeps the checkpoint faithful to the dropped operations', () => {
    const ops = Array.from({ length: 30 }, (_, i) => op(i));
    const log = new OperationLog({ limit: 5 });
    for (const entry of ops) log.append(entry);
    assert.equal(stateDigest(log.state()), stateDigest(foldOperations(ops)));
    assert.equal(materialize(log.state()).entities.length, 30);
  });

  it('serves a delta to a current client and a snapshot to a lagging one', () => {
    const log = new OperationLog({ limit: 5 });
    for (let i = 0; i < 12; i++) log.append(op(i));

    const fresh = log.delta(log.head - 2);
    assert.equal(fresh.mode, 'delta');
    assert.equal(fresh.mode === 'delta' && fresh.ops.length, 2);
    assert.equal(fresh.cursor, log.head);

    const stale = log.delta(0);
    assert.equal(stale.mode, 'snapshot');
    assert.equal(stale.mode === 'snapshot' && stateDigest(stale.state), stateDigest(log.state()));
  });

  it('round-trips through JSON so it can be persisted', () => {
    const log = new OperationLog({ limit: 4 });
    for (let i = 0; i < 9; i++) log.append(op(i));
    const restored = OperationLog.fromJSON(JSON.parse(JSON.stringify(log.toJSON())));
    assert.equal(restored.head, log.head);
    assert.equal(restored.floor, log.floor);
    assert.equal(stateDigest(restored.state()), stateDigest(log.state()));
    assert.deepEqual(restored.opsSince(restored.head - 1).length, 1);
  });

  it('folds interleaved actors identically to a plain fold', () => {
    const ops = Array.from({ length: 20 }, (_, i) => op(i, i % 2 === 0 ? 'dev_a' : 'dev_b'));
    const log = new OperationLog({ limit: 6 });
    for (const entry of [...ops].reverse()) log.append(entry);
    assert.equal(stateDigest(log.state()), stateDigest(foldOperations(ops)));
  });
});
