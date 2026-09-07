/**
 * Deterministic save-fault tests: `?failSaves=1` on the page URL must reject
 * only the save/sync POST — authentication and notebook reads keep working,
 * behavior without the flag is unchanged — while the edited draft and its
 * queued operation survive in the IndexedDB replica across a database reopen.
 * Clearing the flag lets a retry reach the real server: the outbox empties
 * only after that success and the edited text round-trips from the server.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from '../../server/test/helpers.js';
import { Api, ApiError } from '../src/api.js';
import { LocalDatabase } from '../src/db.js';
import { SyncEngine } from '../src/sync.js';
import type { Session } from '../src/types.js';
import { FakeOrigin, installFetch, installIndexedDB, installNavigator, type Connectivity } from './harness.js';

const EMAIL = 'fault@example.com';
const PASSWORD = 'correct horse battery';
const EDITED_TITLE = 'Lecture 1 (edited under fault)';
const EDITED_BODY = 'This edited draft must survive the failed save.';

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

/** Models the page URL the Api reads its fault flag from. */
function setPageSearch(search: string): void {
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { search } });
}

test('web client: ?failSaves=1 fails only saves, keeps the draft across reopen, then retries clean', async (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const connectivity: Connectivity = { online: true };
  installNavigator(connectivity);
  installFetch(h.app, connectivity);
  setPageSearch('');

  const anonymous = new Api(() => null);
  const signup = await anonymous.signup(EMAIL, PASSWORD, 'Fault Tester');
  const session: Session = { token: signup.token, email: signup.user.email, displayName: signup.user.displayName };

  const origin = new FakeOrigin();
  let a = await client(origin, session);
  await a.engine.addNotebook('Biology');
  const notebookId = a.engine.snapshot().replica!.notebook.id;
  const noteId = `note_${crypto.randomUUID().replaceAll('-', '')}`;
  let queuedOpId = '';

  await t.test('without the flag, a save syncs to a real server acknowledgement', async () => {
    const at = Date.now();
    a.engine.queue('note', noteId, { title: 'Lecture 1', body: 'first draft', position: at, createdAt: at, updatedAt: at });
    await a.engine.sync();
    assert.equal(a.engine.snapshot().outbox.length, 0, 'outbox drains after an unflagged sync');
    const server = await a.api.viewNotebook(notebookId);
    assert.equal(server.notes.find((n) => n.id === noteId)?.title, 'Lecture 1', 'server acknowledged the unflagged save');
  });

  await t.test('?failSaves=1 rejects only the sync POST; auth and notebook reads still work', async () => {
    setPageSearch('?failSaves=1');
    const op = a.engine.queue('note', noteId, { title: EDITED_TITLE, body: EDITED_BODY, updatedAt: Date.now() });
    queuedOpId = op.opId;
    await a.engine.save();
    await assert.rejects(
      a.engine.sync(),
      (cause: unknown) => cause instanceof ApiError && cause.status === 503 && /failSaves/.test(cause.message),
      'the save/sync POST fails deterministically while the flag is set',
    );
    const login = await anonymous.login(EMAIL, PASSWORD);
    assert.ok(login.token, 'authentication POST still works under the fault');
    const books = await a.api.notebooks();
    assert.ok(books.notebooks.some((n) => n.id === notebookId), 'notebook list read still works under the fault');
    const view = await a.api.viewNotebook(notebookId);
    assert.equal(view.notes.find((n) => n.id === noteId)?.title, 'Lecture 1', 'server view read works and shows the pre-fault text');
  });

  await t.test('the edited draft and queued operation survive a database reopen', async () => {
    a = await client(origin, null);
    const state = a.engine.snapshot();
    assert.equal(state.session?.email, EMAIL, 'session survives the reopen');
    const note = state.replica!.notes.find((n) => n.id === noteId);
    assert.equal(note?.title, EDITED_TITLE, 'edited title remains in the local replica after reopen');
    assert.equal(note?.body, EDITED_BODY, 'edited body remains in the local replica after reopen');
    assert.equal(state.outbox.filter((op) => op.opId === queuedOpId).length, 1, 'queued operation remains in the IndexedDB outbox after reopen');
    await assert.rejects(a.engine.sync(), ApiError, 'a retry while the fault holds still fails');
    assert.ok(a.engine.snapshot().outbox.some((op) => op.opId === queuedOpId), 'a failed retry does not drain the outbox');
  });

  await t.test('clearing the flag lets a retry reach the server; the outbox empties only on success', async () => {
    setPageSearch('');
    assert.ok(a.engine.snapshot().outbox.some((op) => op.opId === queuedOpId), 'operation is still queued going into the retry');
    await a.engine.sync();
    assert.equal(a.engine.snapshot().outbox.length, 0, 'outbox empties only after the successful sync');
    assert.deepEqual(a.engine.conflictMessages(), [], 'the retried save lands without conflicts or rejections');

    const login = await anonymous.login(EMAIL, PASSWORD);
    const b = await client(new FakeOrigin(), { token: login.token, email: login.user.email, displayName: login.user.displayName });
    await b.engine.chooseNotebook(notebookId);
    const roundTripped = b.engine.snapshot().replica!.notes.find((n) => n.id === noteId);
    assert.equal(roundTripped?.title, EDITED_TITLE, 'edited title round-trips from the server to a fresh client');
    assert.equal(roundTripped?.body, EDITED_BODY, 'edited body round-trips from the server to a fresh client');
  });
});
