/**
 * End-to-end web client tests: the real web/src modules against the real
 * server app, exercising the acceptance criteria that annotations persist
 * after reopening, that a second client receives each synchronized change
 * exactly once without corruption, and that the offline outbox survives
 * reloads and replays on reconnect.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from '../../server/test/helpers.js';
import { Api } from '../src/api.js';
import { LocalDatabase } from '../src/db.js';
import { SyncEngine } from '../src/sync.js';
import type { Session } from '../src/types.js';
import { FakeOrigin, installFetch, installIndexedDB, installNavigator, type Connectivity } from './harness.js';

const EMAIL = 'web@example.com';
const PASSWORD = 'correct horse battery';

interface Client {
  api: Api;
  engine: SyncEngine;
}

/** Opens (or reopens) a client on an origin; passing a session logs it in. */
async function client(origin: FakeOrigin, session: Session | null): Promise<Client> {
  installIndexedDB(origin);
  const db = await LocalDatabase.open();
  let engine: SyncEngine;
  const api = new Api(() => engine.snapshot().session);
  engine = new SyncEngine(db, api);
  const state = await engine.load();
  if (session) {
    state.session = session;
    await engine.save();
  }
  return { api, engine };
}

function newEntityId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

test('web client: offline replica, outbox replay and once-only cross-client sync', async (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const connectivity: Connectivity = { online: true };
  installNavigator(connectivity);
  installFetch(h.app, connectivity);

  const anonymous = new Api(() => null);
  const signup = await anonymous.signup(EMAIL, PASSWORD, 'Web Tester');
  const session: Session = { token: signup.token, email: signup.user.email, displayName: signup.user.displayName };

  const originA = new FakeOrigin();
  let a = await client(originA, session);
  await a.engine.addNotebook('Physics');
  const notebookId = a.engine.snapshot().replica!.notebook.id;
  const uploaded = await a.api.uploadPdf(notebookId, 'lecture.pdf', btoa('%PDF-1.4 fake lecture body'));
  const pdfId = uploaded.pdf.id;
  await a.engine.chooseNotebook(notebookId);

  const annotationId = newEntityId('anno');
  const createdAt = Date.now();
  const annotationOp = a.engine.queue('annotation', annotationId, {
    pdfId, page: 0, kind: 'note', rect: null, color: '#ffd60a', text: 'remember this',
    strokeId: null, createdAt, updatedAt: createdAt,
  });

  await t.test('annotation syncs to the server and survives an offline reopen', async () => {
    await a.engine.sync();
    assert.equal(a.engine.snapshot().outbox.length, 0, 'outbox drains after sync');

    connectivity.online = false;
    a = await client(originA, null);
    const state = a.engine.snapshot();
    assert.equal(state.session?.email, EMAIL, 'session survives reload');
    const offline = state.replica!.annotations.filter((x) => x.id === annotationId);
    assert.equal(offline.length, 1, 'annotation readable from IndexedDB while offline');
    assert.equal(offline[0]!.text, 'remember this');

    connectivity.online = true;
    await a.engine.chooseNotebook(notebookId);
    const reopened = a.engine.snapshot().replica!.annotations.filter((x) => x.id === annotationId);
    assert.equal(reopened.length, 1, 'annotation persisted server-side after reopening');
    assert.equal(reopened[0]!.text, 'remember this');
  });

  const originB = new FakeOrigin();
  let b: Client;

  await t.test('a second client receives each synchronized change exactly once, uncorrupted', async () => {
    const login = await anonymous.login(EMAIL, PASSWORD);
    b = await client(originB, { token: login.token, email: login.user.email, displayName: login.user.displayName });
    await b.engine.chooseNotebook(notebookId);
    const first = b.engine.snapshot().replica!.annotations.filter((x) => x.id === annotationId);
    assert.equal(first.length, 1, 'second client sees the annotation once');
    assert.equal(first[0]!.text, 'remember this');

    a.engine.queue('annotation', annotationId, { text: 'updated on device A', updatedAt: Date.now() });
    await a.engine.sync();
    await b.engine.sync();
    const updated = b.engine.snapshot().replica!.annotations.filter((x) => x.id === annotationId);
    assert.equal(updated.length, 1, 'update arrives once, not as a second copy');
    assert.equal(updated[0]!.text, 'updated on device A');

    // A replayed op (e.g. a retried request) must not duplicate or corrupt.
    await a.api.request('/v1/sync', 'POST', {
      schemaVersion: annotationOp.schemaVersion,
      deviceId: a.engine.snapshot().deviceId,
      notebookId, cursor: 0, ops: [annotationOp],
    });
    await b.engine.sync();
    const replayed = b.engine.snapshot().replica!.annotations.filter((x) => x.id === annotationId);
    assert.equal(replayed.length, 1, 'replayed op is deduplicated by opId');
    assert.equal(replayed[0]!.text, 'updated on device A', 'replay does not roll back the newer edit');
    const serverView = await b.api.annotations(pdfId);
    assert.deepEqual(
      replayed[0],
      serverView.annotations.find((x) => (x as { id?: string }).id === annotationId),
      'client replica matches the server record byte for byte',
    );
  });

  await t.test('offline note edits survive a reload and replay on reconnect', async () => {
    connectivity.online = false;
    const noteId = newEntityId('note');
    const at = Date.now();
    a.engine.queue('note', noteId, { title: 'Offline note', body: 'typed on a plane', position: at, createdAt: at, updatedAt: at });
    await a.engine.save();
    await assert.rejects(a.engine.sync(), /offline/i, 'sync refuses while offline and keeps the queue');

    a = await client(originA, null);
    const state = a.engine.snapshot();
    assert.ok(state.outbox.some((op) => op.entityId === noteId), 'outbox survives the reload');
    assert.ok(state.replica!.notes.some((n) => n.id === noteId), 'local edit visible before sync');

    connectivity.online = true;
    await a.engine.sync();
    assert.equal(a.engine.snapshot().outbox.length, 0, 'outbox replays and drains on reconnect');

    await b.engine.sync();
    const seen = b.engine.snapshot().replica!.notes.filter((n) => n.id === noteId);
    assert.equal(seen.length, 1, 'second client receives the replayed note once');
    assert.equal(seen[0]!.body, 'typed on a plane');
  });

  await t.test('queued ops for another notebook are kept, not lost, when syncing elsewhere', async () => {
    connectivity.online = false;
    const noteId = newEntityId('note');
    const at = Date.now();
    a.engine.queue('note', noteId, { title: 'First notebook note', body: 'queued offline', position: at, createdAt: at, updatedAt: at });
    await a.engine.save();

    connectivity.online = true;
    await a.engine.addNotebook('Chemistry');
    await a.engine.sync();
    assert.ok(
      a.engine.snapshot().outbox.some((op) => op.entityId === noteId),
      'op for the first notebook stays queued instead of being rejected away',
    );
    assert.deepEqual(a.engine.conflictMessages(), [], 'held ops do not surface as spurious rejections');

    await a.engine.chooseNotebook(notebookId);
    assert.equal(a.engine.snapshot().replica!.notes.find(n => n.id === noteId)?.body, 'queued offline', 'returning to a notebook shows its unsynced draft before pushing');
    a = await client(originA, null);
    assert.equal(a.engine.snapshot().replica!.notes.find(n => n.id === noteId)?.body, 'queued offline', 'returned draft survives another reload');
    await a.engine.sync();
    assert.equal(a.engine.snapshot().outbox.length, 0, 'queued op lands once its notebook is synced');
    assert.ok(a.engine.snapshot().replica!.notes.some((n) => n.id === noteId));
  });
});
