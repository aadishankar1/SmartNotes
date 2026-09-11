import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyOperation,
  createOperation,
  emptyState,
  foldOperations,
  materialize,
  stateDigest,
  type FoldState,
  type Operation,
  type SyncResponse,
  type SyncedKind,
} from '../../shared/src/index.js';
import type { App } from '../src/app.js';
import { body, call, createNotebook, harness, signup, type Harness } from './helpers.js';

const T0 = 1767225600000;

/** A device replica: local lamport clock, offline queue, and its own state. */
function device(app: App, token: string, notebookId: string, id: string) {
  let lamport = 0;
  let seq = 0;
  let basis = 0;
  let cursor = 0;
  let state: FoldState = emptyState();
  const queue: Operation[] = [];

  const author = (entityKind: SyncedKind, entityId: string, kind: 'set' | 'delete', fields: Record<string, unknown>): Operation => {
    lamport += 1;
    const op = createOperation({
      entityKind,
      entityId,
      notebookId,
      kind,
      fields,
      actor: id,
      lamport,
      seq: seq++,
      basis,
      at: T0 + lamport * 1000,
    });
    queue.push(op);
    applyOperation(state, op);
    return op;
  };

  return {
    id,
    get cursor() {
      return cursor;
    },
    get state() {
      return state;
    },
    entities() {
      return materialize(state).entities;
    },
    note(entityId: string, fields: Record<string, unknown>): Operation {
      return author('note', entityId, 'set', fields);
    },
    remove(entityKind: SyncedKind, entityId: string): Operation {
      return author(entityKind, entityId, 'delete', {});
    },
    enqueue(op: Operation): void {
      queue.push(op);
    },
    async sync(): Promise<{ status: number; payload: SyncResponse }> {
      const outgoing = queue.splice(0, queue.length);
      const response = await call(app, 'POST', '/v1/sync', {
        token,
        body: { schemaVersion: 1, deviceId: id, notebookId, cursor, ops: outgoing },
      });
      const payload = body<SyncResponse>(response);
      if (response.status === 200) {
        if (payload.mode === 'snapshot' && payload.state) state = payload.state;
        else state = foldOperations(payload.ops, state);
        cursor = payload.cursor;
        lamport = Math.max(lamport, payload.serverLamport);
        basis = lamport;
      }
      return { status: response.status, payload };
    },
  };
}

const NOTE_FIELDS = (title: string) => ({ title, body: '', position: 1, createdAt: T0, updatedAt: T0 });

describe('incremental sync', () => {
  let h: Harness;
  let token: string;
  let notebookId: string;

  before(async () => {
    h = harness();
    token = (await signup(h.app, 'alice@example.com')).token;
    notebookId = await createNotebook(h.app, token, 'Field notes');
  });
  after(() => h.cleanup());

  it('carries a new note from one device to another', async () => {
    const ipad = device(h.app, token, notebookId, 'dev_ipad');
    const mac = device(h.app, token, notebookId, 'dev_mac');
    await ipad.sync();
    await mac.sync();

    ipad.note('note_a', NOTE_FIELDS('From the iPad'));
    const pushed = await ipad.sync();
    assert.equal(pushed.status, 200);
    assert.equal(pushed.payload.accepted.length, 1);
    assert.deepEqual(pushed.payload.rejected, []);

    const pulled = await mac.sync();
    assert.equal(pulled.payload.mode, 'delta');
    const note = mac.entities().find((e) => e.id === 'note_a');
    assert.ok(note, 'the second device should receive the note');
    assert.equal(note.record['title'], 'From the iPad');
    assert.equal(stateDigest(ipad.state), stateDigest(mac.state), 'replicas converge');
  });

  it('only sends what is newer than the cursor', async () => {
    const mac = device(h.app, token, notebookId, 'dev_mac2');
    await mac.sync();
    const before = mac.cursor;
    const quiet = await mac.sync();
    assert.equal(quiet.payload.ops.length, 0);
    assert.equal(quiet.payload.cursor, before);
  });

  it('accepts a replay of the same operations without duplicating them', async () => {
    const ipad = device(h.app, token, notebookId, 'dev_replay');
    await ipad.sync();
    const op = ipad.note('note_replay', NOTE_FIELDS('Replayed'));
    await ipad.sync();
    ipad.enqueue(op);
    const second = await ipad.sync();
    assert.deepEqual(second.payload.rejected, []);
    assert.equal(second.payload.accepted.length, 1);
    const notes = ipad.entities().filter((e) => e.id === 'note_replay');
    assert.equal(notes.length, 1);
  });

  it('reconciles a REST edit made while a device was offline', async () => {
    const ipad = device(h.app, token, notebookId, 'dev_rest');
    await ipad.sync();
    ipad.note('note_rest', NOTE_FIELDS('Draft'));
    await ipad.sync();

    const patched = await call(h.app, 'PATCH', '/v1/notes/note_rest', { token, body: { body: 'edited on the web' } });
    assert.equal(patched.status, 200);

    await ipad.sync();
    const note = ipad.entities().find((e) => e.id === 'note_rest');
    assert.equal(note?.record['body'], 'edited on the web');
    assert.equal(note?.record['title'], 'Draft', 'the REST edit must not clobber untouched fields');
  });
});

describe('concurrent edits', () => {
  let h: Harness;
  let token: string;
  let notebookId: string;

  before(async () => {
    h = harness();
    token = (await signup(h.app, 'alice@example.com')).token;
    notebookId = await createNotebook(h.app, token);
  });
  after(() => h.cleanup());

  it('converges on one value per field and reports the loser', async () => {
    const ipad = device(h.app, token, notebookId, 'dev_ipad');
    const mac = device(h.app, token, notebookId, 'dev_mac');
    await ipad.sync();
    await mac.sync();

    ipad.note('note_c', NOTE_FIELDS('Shared'));
    await ipad.sync();
    await mac.sync();

    // Both go offline from the same baseline and edit the same field.
    ipad.note('note_c', { title: 'iPad title', updatedAt: T0 + 10 });
    mac.note('note_c', { title: 'Mac title', body: 'mac body', updatedAt: T0 + 11 });

    await ipad.sync();
    const macResult = await mac.sync();
    await ipad.sync();

    assert.equal(stateDigest(ipad.state), stateDigest(mac.state), 'both devices agree');
    const winner = ipad.entities().find((e) => e.id === 'note_c')!.record;
    assert.equal(winner['title'], 'Mac title', 'the higher stamp wins the contested field');
    assert.equal(winner['body'], 'mac body', 'the uncontested field is kept');
    assert.equal(ipad.entities().filter((e) => e.id === 'note_c').length, 1, 'no duplication');

    const conflict = macResult.payload.conflicts.find((c) => c.entityId === 'note_c' && c.field === 'title');
    assert.ok(conflict, 'the losing edit must be reported, not dropped');
    assert.equal(conflict.winner.value, 'Mac title');
    assert.deepEqual(
      conflict.losers.map((l) => l.value),
      ['iPad title'],
    );
  });

  it('propagates a delete as a tombstone', async () => {
    const ipad = device(h.app, token, notebookId, 'dev_ipad2');
    const mac = device(h.app, token, notebookId, 'dev_mac2');
    await ipad.sync();
    await mac.sync();
    ipad.note('note_gone', NOTE_FIELDS('Temporary'));
    await ipad.sync();
    await mac.sync();
    assert.ok(mac.entities().some((e) => e.id === 'note_gone'));

    ipad.remove('note', 'note_gone');
    await ipad.sync();
    const pulled = await mac.sync();

    assert.ok(pulled.payload.tombstones.some((t) => t.entityId === 'note_gone'));
    assert.ok(!mac.entities().some((e) => e.id === 'note_gone'));
    assert.equal((await call(h.app, 'GET', '/v1/notes/note_gone', { token })).status, 404);
  });
});

describe('reconnect after a long absence', () => {
  it('answers a cursor older than the log with a snapshot', async () => {
    const h = harness({ logLimit: 4 });
    try {
      const token = (await signup(h.app, 'alice@example.com')).token;
      const notebookId = await createNotebook(h.app, token);
      const online = device(h.app, token, notebookId, 'dev_online');
      const absent = device(h.app, token, notebookId, 'dev_absent');
      await online.sync();
      await absent.sync();

      for (let i = 0; i < 12; i++) {
        online.note(`note_${i}`, NOTE_FIELDS(`Note ${i}`));
        await online.sync();
      }

      const rejoin = await absent.sync();
      assert.equal(rejoin.payload.mode, 'snapshot', 'a lagging device needs a full snapshot');
      assert.ok(rejoin.payload.state, 'snapshot mode must carry state');
      assert.equal(stateDigest(absent.state), stateDigest(online.state));
      assert.equal(absent.entities().filter((e) => e.kind === 'note').length, 12, 'nothing lost to compaction');

      const caughtUp = await absent.sync();
      assert.equal(caughtUp.payload.mode, 'delta', 'once current, deltas resume');
    } finally {
      h.cleanup();
    }
  });
});

describe('operation authorization', () => {
  let h: Harness;
  let token: string;
  let notebookId: string;
  let otherNotebookId: string;

  before(async () => {
    h = harness();
    token = (await signup(h.app, 'alice@example.com')).token;
    notebookId = await createNotebook(h.app, token);
    otherNotebookId = await createNotebook(h.app, token, 'Other');
  });
  after(() => h.cleanup());

  const push = async (op: unknown, deviceId = 'dev_x'): Promise<SyncResponse> => {
    const response = await call(h.app, 'POST', '/v1/sync', {
      token,
      body: { schemaVersion: 1, deviceId, notebookId, cursor: 0, ops: [op] },
    });
    return body<SyncResponse>(response);
  };

  const base = (overrides: Record<string, unknown> = {}) =>
    createOperation({
      entityKind: 'note',
      entityId: 'note_auth',
      notebookId,
      fields: NOTE_FIELDS('Legit'),
      actor: 'dev_x',
      lamport: 5,
      seq: 0,
      basis: 4,
      at: T0,
      ...overrides,
    });

  it('rejects an operation aimed at another notebook', async () => {
    const foreign = base({ notebookId: otherNotebookId });
    const result = await push(foreign);
    assert.deepEqual(result.accepted, []);
    assert.match(result.rejected[0]!.reason, /different notebook/);
  });

  it('rejects an operation impersonating another device', async () => {
    const result = await push(base({ actor: 'dev_other' }));
    assert.match(result.rejected[0]!.reason, /actor does not match/);
  });

  it('rejects writes to server-owned fields', async () => {
    const op = createOperation({
      entityKind: 'notebook',
      entityId: notebookId,
      notebookId,
      fields: { ownerId: 'usr_someone_else' },
      actor: 'dev_x',
      lamport: 5,
      seq: 1,
      basis: 4,
      at: T0,
    });
    const result = await push(op);
    assert.match(result.rejected[0]!.reason, /not client-writable/);
    const notebook = body<{ notebook: Record<string, unknown> }>(
      await call(h.app, 'GET', `/v1/notebooks/${notebookId}`, { token }),
    ).notebook;
    assert.notEqual(notebook['ownerId'], 'usr_someone_else');
  });

  it('rejects a malformed operation without dropping the batch', async () => {
    const good = base({ entityId: 'note_good' });
    const bad = { ...base({ entityId: 'note_bad' }), lamport: -3 };
    const response = await call(h.app, 'POST', '/v1/sync', {
      token,
      body: { schemaVersion: 1, deviceId: 'dev_x', notebookId, cursor: 0, ops: [good, bad] },
    });
    // The envelope schema screens structurally invalid operations up front.
    assert.equal(response.status, 400);

    const semantic = { ...base({ entityId: 'note_bad2' }), basis: 99 };
    const result = await push(semantic);
    assert.equal(result.accepted.length, 0);
    assert.equal(result.rejected.length, 1);
  });
});
