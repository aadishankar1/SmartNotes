import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { DATABASE_FILE, SCHEMA_USER_VERSION, SqliteStore, StoreError } from '../src/store/sqlite.js';
import { TABLES } from '../src/store/tables.js';
import { REVISION_HISTORY } from '../src/notebooks.js';
import { body, call, createNotebook, harness, samplePdf, signup, type Harness } from './helpers.js';

/** Reads the database the way an operator would: a second connection, plain SQL. */
function query<T = Record<string, unknown>>(dir: string, sql: string, ...params: string[]): T[] {
  const db = new DatabaseSync(join(dir, DATABASE_FILE), { readOnly: true });
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

describe('storage engine', () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'smartnotes-store-'));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('is a SQLite database with the declared tables and schema version', () => {
    const store = SqliteStore.open({ dir });
    try {
      assert.equal(store.stats().engine, 'sqlite');
      assert.ok(existsSync(join(dir, DATABASE_FILE)), 'the database file exists on disk');
      const tables = query<{ name: string }>(dir, `SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name`).map(
        (row) => row.name,
      );
      for (const table of Object.values(TABLES)) assert.ok(tables.includes(table), `missing table ${table}`);
      assert.equal(query<{ user_version: number }>(dir, 'PRAGMA user_version')[0]?.user_version, SCHEMA_USER_VERSION);
    } finally {
      store.close();
    }
  });

  it('survives a reopen', () => {
    const store = SqliteStore.open({ dir });
    store.transaction((tx) => {
      tx.put('widgets', { id: 'w1', label: 'first' });
      tx.put('widgets', { id: 'w2', label: 'second' });
    });
    store.close();

    const reopened = SqliteStore.open({ dir });
    assert.equal(reopened.all('widgets').length, 2);
    assert.equal(reopened.get('widgets', 'w1')?.['label'], 'first');
    reopened.close();
  });

  it('commits a transaction all-or-nothing', () => {
    const store = SqliteStore.open({ dir });
    assert.throws(() => {
      store.transaction((tx) => {
        tx.put('widgets', { id: 'w3', label: 'third' });
        assert.equal(tx.get('widgets', 'w3')?.['label'], 'third', 'a write is visible to its own transaction');
        throw new StoreError('rolled back');
      });
    }, StoreError);
    assert.equal(store.get('widgets', 'w3'), undefined);
    store.close();
    const reopened = SqliteStore.open({ dir });
    assert.equal(reopened.get('widgets', 'w3'), undefined, 'a failed transaction leaves no trace on disk');
    reopened.close();
  });

  it('rolls back a table it created, and stays usable afterwards', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'smartnotes-rollback-'));
    try {
      const store = SqliteStore.open({ dir: scratch });
      assert.throws(() => {
        store.transaction((tx) => {
          tx.put('gadgets', { id: 'g1' });
          throw new StoreError('rolled back');
        });
      }, StoreError);
      // The CREATE TABLE went with it, so reads must not claim the table exists.
      assert.equal(store.all('gadgets').length, 0);
      assert.equal(store.get('gadgets', 'g1'), undefined);
      store.transaction((tx) => tx.put('gadgets', { id: 'g2' }));
      assert.deepEqual(store.all('gadgets').map((row) => row['id']), ['g2']);
      store.close();
      assert.deepEqual(query<{ id: string }>(scratch, 'SELECT id FROM gadgets').map((row) => row.id), ['g2']);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('refuses a write outside a transaction and refuses nesting', () => {
    const store = SqliteStore.open({ dir });
    try {
      assert.throws(() => store.writeRecord('widgets', { id: 'w5' }), StoreError);
      assert.throws(() => store.transaction(() => store.transaction(() => undefined)), StoreError);
      assert.equal(store.get('widgets', 'w5'), undefined);
    } finally {
      store.close();
    }
  });

  it('stores records as canonical JSON readable by plain SQL', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'smartnotes-json-'));
    try {
      const store = SqliteStore.open({ dir: scratch });
      store.transaction((tx) => tx.put(TABLES.blobs, { id: 'b1', createdAt: 7, byteSize: 3 }));
      store.close();
      const rows = query<{ id: string; doc: string }>(scratch, 'SELECT id, doc FROM blobs');
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.doc, '{"byteSize":3,"createdAt":7,"id":"b1"}', 'keys are serialized in canonical order');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('indexes declared columns and refuses undeclared ones', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'smartnotes-index-'));
    try {
      const store = SqliteStore.open({ dir: scratch });
      store.transaction((tx) => {
        tx.put(TABLES.notebooks, { id: 'nb_b', ownerId: 'usr_1', createdAt: 2, serverSeq: 0 });
        tx.put(TABLES.notebooks, { id: 'nb_a', ownerId: 'usr_1', createdAt: 1, serverSeq: 0 });
        tx.put(TABLES.notebooks, { id: 'nb_c', ownerId: 'usr_2', createdAt: 3, serverSeq: 0 });
      });
      assert.deepEqual(
        store.findBy(TABLES.notebooks, 'ownerId', 'usr_1').map((row) => row['id']),
        ['nb_a', 'nb_b'],
        'an indexed read is ordered by id',
      );
      assert.equal(store.findBy(TABLES.notebooks, 'ownerId', 'nobody').length, 0);
      assert.throws(() => store.findBy(TABLES.notebooks, 'createdAt', '1'), StoreError);

      const plan = query<{ detail: string }>(
        scratch,
        `EXPLAIN QUERY PLAN SELECT doc FROM notebooks WHERE "ownerId" = ?`,
        'usr_1',
      );
      assert.match(String(plan[0]?.detail), /USING INDEX/, 'the lookup uses the generated-column index');
      store.close();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('rejects a database written by a newer schema version', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'smartnotes-version-'));
    try {
      SqliteStore.open({ dir: scratch }).close();
      const db = new DatabaseSync(join(scratch, DATABASE_FILE));
      db.exec(`PRAGMA user_version = ${SCHEMA_USER_VERSION + 1}`);
      db.close();
      assert.throws(() => SqliteStore.open({ dir: scratch }), StoreError);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('keeps reading correctly across many commits', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'smartnotes-bulk-'));
    try {
      const store = SqliteStore.open({ dir: scratch });
      for (let i = 0; i < 200; i++) store.transaction((tx) => tx.put('widgets', { id: `w${i}`, label: `label ${i}` }));
      const stats = store.stats();
      assert.equal(stats.commits, 200);
      assert.equal(stats.tables['widgets'], 200);
      assert.ok(stats.byteSize > 0);
      store.close();

      const reopened = SqliteStore.open({ dir: scratch });
      assert.equal(reopened.all('widgets').length, 200);
      assert.equal(reopened.get('widgets', 'w199')?.['label'], 'label 199');
      reopened.close();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe('restart durability', () => {
  let h: Harness;
  let token: string;
  let notebookId: string;
  let noteId: string;
  let pdfId: string;

  before(async () => {
    h = harness();
    const account = await signup(h.app, 'alice@example.com');
    token = account.token;
    notebookId = await createNotebook(h.app, token, 'Semester one');
    noteId = body<{ note: { id: string } }>(
      await call(h.app, 'POST', `/v1/notebooks/${notebookId}/notes`, { token, body: { title: 'Lecture 1', body: 'v1' } }),
    ).note.id;
    pdfId = body<{ pdf: { id: string } }>(
      await call(h.app, 'POST', '/v1/pdfs', {
        token,
        body: { notebookId, filename: 'handout.pdf', content: samplePdf(2).toString('base64') },
      }),
    ).pdf.id;
  });
  after(() => h.cleanup());

  it('keeps the session, the notebook and its contents after a restart', async () => {
    h.restart();
    const me = await call(h.app, 'GET', '/v1/me', { token });
    assert.equal(me.status, 200, 'sessions outlive the process');

    const notebooks = body<{ notebooks: Array<Record<string, unknown>> }>(await call(h.app, 'GET', '/v1/notebooks', { token }));
    assert.equal(notebooks.notebooks.length, 1);
    assert.equal(notebooks.notebooks[0]!['title'], 'Semester one');

    const note = await call(h.app, 'GET', `/v1/notes/${noteId}`, { token });
    assert.equal(body<{ note: Record<string, unknown> }>(note).note['body'], 'v1');
    assert.equal((await call(h.app, 'GET', `/v1/pdfs/${pdfId}`, { token })).status, 200);
  });

  it('keeps edits made after the restart', async () => {
    await call(h.app, 'PATCH', `/v1/notes/${noteId}`, { token, body: { body: 'v2' } });
    h.restart();
    const note = await call(h.app, 'GET', `/v1/notes/${noteId}`, { token });
    assert.equal(body<{ note: Record<string, unknown> }>(note).note['body'], 'v2');
  });

  it('keeps a bounded revision history for the note', async () => {
    for (let i = 3; i < 3 + REVISION_HISTORY + 5; i++) {
      await call(h.app, 'PATCH', `/v1/notes/${noteId}`, { token, body: { body: `v${i}` } });
    }
    h.restart();
    const revisions = body<{ revisions: Array<Record<string, unknown>> }>(
      await call(h.app, 'GET', `/v1/notes/${noteId}/revisions`, { token }),
    ).revisions;
    assert.ok(revisions.length <= REVISION_HISTORY, `history must stay bounded, saw ${revisions.length}`);
    assert.equal(revisions.at(-1)?.['body'], `v${3 + REVISION_HISTORY + 4}`);
  });

  it('reports a healthy store after the restart', async () => {
    h.restart();
    const health = await call(h.app, 'GET', '/health');
    assert.equal(health.status, 200);
    const payload = body<{ status: string; storage: { engine: string; records: number; durable: boolean; byteSize: number } }>(health);
    assert.equal(payload.status, 'ok');
    assert.equal(payload.storage.engine, 'sqlite');
    assert.ok(payload.storage.records > 0);
    assert.ok(payload.storage.byteSize > 0);
    assert.equal(payload.storage.durable, true);
  });

  it('has written the data to the database, not just to memory', () => {
    // Read the committed rows through an independent connection, so this proves
    // the data is in SQLite rather than in the running process.
    const logs = query<{ doc: string }>(h.dir, 'SELECT doc FROM logs');
    assert.ok(logs.some((row) => row.doc.includes(noteId)), 'the note is in the persisted operation log');
    const users = query<{ email: string }>(h.dir, `SELECT "email" AS email FROM users`);
    assert.deepEqual(users.map((row) => row.email), ['alice@example.com']);
    assert.equal(query(h.dir, 'SELECT id FROM blobs').length, 1, 'the PDF blob is recorded');
    assert.ok(existsSync(join(h.dir, 'blobs')));
  });
});
