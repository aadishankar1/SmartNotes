import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JournalStore, StoreError } from '../src/store/journal.js';
import { REVISION_HISTORY } from '../src/notebooks.js';
import { body, call, createNotebook, harness, samplePdf, signup, type Harness } from './helpers.js';

describe('storage engine', () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'smartnotes-store-'));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('survives a reopen', () => {
    const store = JournalStore.open({ dir });
    store.transaction((tx) => {
      tx.put('widgets', { id: 'w1', label: 'first' });
      tx.put('widgets', { id: 'w2', label: 'second' });
    });
    store.close();

    const reopened = JournalStore.open({ dir });
    assert.equal(reopened.all('widgets').length, 2);
    assert.equal(reopened.get('widgets', 'w1')?.['label'], 'first');
    reopened.close();
  });

  it('commits a transaction all-or-nothing', () => {
    const store = JournalStore.open({ dir });
    assert.throws(() => {
      store.transaction((tx) => {
        tx.put('widgets', { id: 'w3', label: 'third' });
        throw new StoreError('rolled back');
      });
    }, StoreError);
    assert.equal(store.get('widgets', 'w3'), undefined);
    store.close();
    const reopened = JournalStore.open({ dir });
    assert.equal(reopened.get('widgets', 'w3'), undefined, 'a failed transaction leaves no trace on disk');
    reopened.close();
  });

  it('discards a torn tail instead of half-applying it', () => {
    const store = JournalStore.open({ dir });
    store.transaction((tx) => tx.put('widgets', { id: 'w4', label: 'fourth' }));
    store.close();

    // Simulate a crash mid-write: a partial line with no newline.
    appendFileSync(join(dir, 'journal.log'), '{"f":1,"crc":123,"m":[{"table":"widg');
    const recovered = JournalStore.open({ dir });
    assert.equal(recovered.get('widgets', 'w4')?.['label'], 'fourth');
    assert.equal(recovered.all('widgets').length, 3);
    recovered.close();

    const again = JournalStore.open({ dir });
    assert.equal(again.all('widgets').length, 3, 'the truncated tail stays gone');
    again.close();
  });

  it('rejects a journal line whose checksum does not match', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'smartnotes-crc-'));
    try {
      const store = JournalStore.open({ dir: scratch });
      store.transaction((tx) => tx.put('widgets', { id: 'w1', label: 'kept' }));
      store.close();
      const line = JSON.stringify({ f: 1, crc: 1, m: [{ table: 'widgets', key: 'w9', record: { id: 'w9' } }] });
      appendFileSync(join(scratch, 'journal.log'), `${line}\n`);
      const reopened = JournalStore.open({ dir: scratch });
      assert.equal(reopened.get('widgets', 'w9'), undefined, 'a corrupt record must not be applied');
      assert.equal(reopened.get('widgets', 'w1')?.['label'], 'kept');
      reopened.close();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('compacts into a snapshot and keeps reading correctly', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'smartnotes-compact-'));
    try {
      const store = JournalStore.open({ dir: scratch, compactAfterBytes: 512 });
      for (let i = 0; i < 200; i++) store.transaction((tx) => tx.put('widgets', { id: `w${i}`, label: `label ${i}` }));
      const stats = store.stats();
      assert.ok(stats.compactions > 0, 'the journal should have been folded into snapshots');
      assert.ok(existsSync(join(scratch, 'snapshot.json')));
      assert.ok(statSync(join(scratch, 'journal.log')).size < 512 * 4);
      store.close();

      const reopened = JournalStore.open({ dir: scratch });
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
    const payload = body<{ status: string; storage: { records: number; durable: boolean } }>(health);
    assert.equal(payload.status, 'ok');
    assert.ok(payload.storage.records > 0);
    assert.equal(payload.storage.durable, true);
  });

  it('has written the data to disk, not just to memory', () => {
    const journal = readFileSync(join(h.dir, 'journal.log'), 'utf8');
    const snapshot = existsSync(join(h.dir, 'snapshot.json')) ? readFileSync(join(h.dir, 'snapshot.json'), 'utf8') : '';
    assert.ok(`${journal}${snapshot}`.includes(noteId));
    assert.ok(existsSync(join(h.dir, 'blobs')));
  });
});
