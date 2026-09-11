/**
 * Save-status and fault-injection tests: the real web/src modules against the
 * real server app, exercising the acceptance criteria that a ?failSaves=1
 * fault surfaces a failed-to-save status while the draft op stays in the
 * IndexedDB outbox across a reload, that a retry succeeds once the fault is
 * cleared, that create/edit/reopen preserves title and body, and that the
 * saving, saved and failed states present visibly distinct.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from '../../server/test/helpers.js';
import { Api } from '../src/api.js';
import { LocalDatabase } from '../src/db.js';
import { SyncEngine } from '../src/sync.js';
import { armFaultsFromQuery, faults } from '../src/faults.js';
import { savePresentation } from '../src/status.js';
import type { Session } from '../src/types.js';
import { FakeOrigin, installFetch, installIndexedDB, installNavigator, type Connectivity } from './harness.js';

const EMAIL = 'status@example.com';
const PASSWORD = 'correct horse battery';

/** Opens (or reopens) a client on an origin; passing a session logs it in. */
async function client(origin: FakeOrigin, session: Session | null): Promise<SyncEngine> {
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
  return engine;
}

test('saving, saved and failed-to-save are visibly distinct states', () => {
  const saving = savePresentation('saving');
  const saved = savePresentation('saved');
  const failed = savePresentation('failed');
  for (const [a, b] of [[saving, saved], [saving, failed], [saved, failed]] as const) {
    assert.notEqual(a.label, b.label, 'labels differ');
    assert.notEqual(a.icon, b.icon, 'icons differ');
    assert.notEqual(a.tone, b.tone, 'tone classes differ');
  }
});

test('failSaves fault is armed only by the exact query parameter', () => {
  armFaultsFromQuery('');
  assert.equal(faults.failSaves, false, 'inert with no query string');
  armFaultsFromQuery('?theme=dark');
  assert.equal(faults.failSaves, false, 'inert without the failSaves parameter');
  armFaultsFromQuery('?failSaves=1');
  assert.equal(faults.failSaves, true, '?failSaves=1 arms the fault');
  armFaultsFromQuery('?failSaves=0');
  assert.equal(faults.failSaves, false, 'any other value stays inert');
});

test('web client: save status, failSaves draft retention, retry and reopen', async (t) => {
  const h = harness();
  t.after(() => { armFaultsFromQuery(''); h.cleanup(); });
  const connectivity: Connectivity = { online: true };
  installNavigator(connectivity);
  installFetch(h.app, connectivity);
  armFaultsFromQuery('');

  const anonymous = new Api(() => null);
  const signup = await anonymous.signup(EMAIL, PASSWORD, 'Status Tester');
  const session: Session = { token: signup.token, email: signup.user.email, displayName: signup.user.displayName };

  const origin = new FakeOrigin();
  let engine = await client(origin, session);
  await engine.addNotebook('Biology');
  const notebookId = engine.snapshot().replica!.notebook.id;
  const noteId = `note_${crypto.randomUUID().replaceAll('-', '')}`;
  const statusLog: string[] = [];
  engine.onStatus = (status) => statusLog.push(status);

  await t.test('creating and editing a note reaches saved only on server ack', async () => {
    const at = Date.now();
    engine.queue('note', noteId, { title: '', body: '', position: at, createdAt: at, updatedAt: at });
    const ok = await engine.saveNote(noteId, { title: 'Photosynthesis', body: 'Light reactions happen in the thylakoid.' });
    assert.equal(ok, true);
    assert.deepEqual(statusLog, ['saving', 'saved'], 'status passes through saving before saved');
    assert.equal(engine.saveStatus, 'saved');
    assert.equal(engine.snapshot().outbox.length, 0, 'server acknowledged every queued op');
  });

  await t.test('reopening the note preserves its title and body', async () => {
    engine = await client(origin, null);
    await engine.chooseNotebook(notebookId);
    const note = engine.snapshot().replica!.notes.find((n) => n.id === noteId);
    assert.ok(note, 'note is there after a reload');
    assert.equal(note.title, 'Photosynthesis');
    assert.equal(note.body, 'Light reactions happen in the thylakoid.');
  });

  await t.test('with failSaves armed, saving fails visibly and keeps the draft op queued', async () => {
    armFaultsFromQuery('?failSaves=1');
    const ok = await engine.saveNote(noteId, { title: 'Photosynthesis', body: 'Draft edited under the fault.' });
    assert.equal(ok, false, 'save reports failure');
    assert.equal(engine.saveStatus, 'failed', 'status is failed-to-save');
    assert.match(engine.lastSaveError, /could not save/i, 'failure carries an explanation');
    assert.equal(engine.pendingOps(noteId), 1, 'draft op stays in the outbox');
    const local = engine.snapshot().replica!.notes.find((n) => n.id === noteId);
    assert.equal(local!.body, 'Draft edited under the fault.', 'draft text stays visible locally');
  });

  await t.test('the draft op survives a simulated reload in the IndexedDB outbox', async () => {
    engine = await client(origin, null);
    const state = engine.snapshot();
    assert.equal(state.outbox.filter((op) => op.entityId === noteId).length, 1, 'outbox op survived the reload');
    const local = state.replica!.notes.find((n) => n.id === noteId);
    assert.equal(local!.body, 'Draft edited under the fault.', 'draft body survived the reload');
    const server = await new Api(() => state.session).viewNotebook(notebookId);
    assert.equal(server.notes.find((n) => n.id === noteId)!.body, 'Light reactions happen in the thylakoid.', 'server still has the pre-fault body');
  });

  await t.test('after clearing the fault, retry syncs the draft and status becomes saved', async () => {
    armFaultsFromQuery('');
    const ok = await engine.push();
    assert.equal(ok, true, 'retry succeeds once the fault is cleared');
    assert.equal(engine.saveStatus, 'saved');
    assert.equal(engine.snapshot().outbox.length, 0, 'outbox drained');
    const server = await new Api(() => engine.snapshot().session).viewNotebook(notebookId);
    assert.equal(server.notes.find((n) => n.id === noteId)!.body, 'Draft edited under the fault.', 'server acknowledged the retried draft');
  });
});
