import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SESSION_TTL_MS } from '../src/auth.js';
import { call, createNotebook, errorCode, harness, body, signup, type Harness } from './helpers.js';

const PASSWORD = 'correct horse battery';

describe('authentication', () => {
  let h: Harness;
  before(() => {
    h = harness();
  });
  after(() => h.cleanup());

  it('creates an account and returns a usable token', async () => {
    const response = await call(h.app, 'POST', '/v1/auth/signup', {
      body: { email: 'Alice@Example.com', password: PASSWORD, displayName: 'Alice' },
    });
    assert.equal(response.status, 201);
    const payload = body<{ token: string; user: Record<string, unknown> }>(response);
    assert.equal(payload.user['email'], 'alice@example.com', 'email is normalised');
    assert.equal(payload.user['displayName'], 'Alice');
    assert.ok(!('passwordHash' in payload.user), 'never expose the hash');
    assert.ok(!('salt' in payload.user));

    const me = await call(h.app, 'GET', '/v1/me', { token: payload.token });
    assert.equal(me.status, 200);
    assert.equal(body<{ user: { id: string } }>(me).user.id, payload.user['id']);
  });

  it('refuses a duplicate email and a weak password', async () => {
    const duplicate = await call(h.app, 'POST', '/v1/auth/signup', {
      body: { email: 'alice@example.com', password: PASSWORD },
    });
    assert.equal(duplicate.status, 409);
    assert.equal(errorCode(duplicate), 'email_taken');

    const weak = await call(h.app, 'POST', '/v1/auth/signup', { body: { email: 'bob@example.com', password: 'short' } });
    assert.equal(weak.status, 400);

    const malformed = await call(h.app, 'POST', '/v1/auth/signup', { body: { email: 'nope', password: PASSWORD } });
    assert.equal(malformed.status, 400);
  });

  it('logs in and gives the same answer for a wrong password and an unknown account', async () => {
    const ok = await call(h.app, 'POST', '/v1/auth/login', { body: { email: 'alice@example.com', password: PASSWORD } });
    assert.equal(ok.status, 200);

    const wrong = await call(h.app, 'POST', '/v1/auth/login', { body: { email: 'alice@example.com', password: 'wrong password' } });
    const unknown = await call(h.app, 'POST', '/v1/auth/login', { body: { email: 'ghost@example.com', password: PASSWORD } });
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.equal(errorCode(wrong), errorCode(unknown), 'must not reveal which emails exist');
  });

  it('rejects missing, malformed and revoked tokens', async () => {
    const anonymous = await call(h.app, 'GET', '/v1/notebooks');
    assert.equal(anonymous.status, 401);
    assert.equal(errorCode(anonymous), 'unauthenticated');

    const garbage = await call(h.app, 'GET', '/v1/notebooks', { token: 'not-a-real-token' });
    assert.equal(garbage.status, 401);

    const notBearer = await call(h.app, 'GET', '/v1/notebooks', { headers: { authorization: 'Basic abc' } });
    assert.equal(notBearer.status, 401);

    const session = await signup(h.app, 'carol@example.com', PASSWORD);
    assert.equal((await call(h.app, 'GET', '/v1/notebooks', { token: session.token })).status, 200);
    assert.equal((await call(h.app, 'POST', '/v1/auth/logout', { token: session.token })).status, 204);
    assert.equal((await call(h.app, 'GET', '/v1/notebooks', { token: session.token })).status, 401);
  });

  it('never writes the password to disk', async () => {
    const journal = readFileSync(join(h.dir, 'journal.log'), 'utf8');
    assert.ok(!journal.includes(PASSWORD), 'password must not appear in the journal');
    assert.ok(journal.includes('passwordHash'));
  });
});

describe('session expiry', () => {
  it('stops accepting a token past its lifetime', async () => {
    let clock = 1767225600000;
    const h = harness({ now: () => clock });
    try {
      const alice = await signup(h.app, 'alice@example.com', PASSWORD);
      assert.equal((await call(h.app, 'GET', '/v1/me', { token: alice.token })).status, 200);
      clock += SESSION_TTL_MS + 1;
      const expired = await call(h.app, 'GET', '/v1/me', { token: alice.token });
      assert.equal(expired.status, 401);
      assert.equal(errorCode(expired), 'session_expired');
    } finally {
      h.cleanup();
    }
  });
});

describe('per-user isolation', () => {
  let h: Harness;
  let alice: Awaited<ReturnType<typeof signup>>;
  let mallory: Awaited<ReturnType<typeof signup>>;
  let notebookId: string;
  let noteId: string;

  before(async () => {
    h = harness();
    alice = await signup(h.app, 'alice@example.com', PASSWORD);
    mallory = await signup(h.app, 'mallory@example.com', PASSWORD);
    notebookId = await createNotebook(h.app, alice.token, 'Private');
    const note = await call(h.app, 'POST', `/v1/notebooks/${notebookId}/notes`, {
      token: alice.token,
      body: { title: 'Secret', body: 'do not share' },
    });
    noteId = body<{ note: { id: string } }>(note).note.id;
  });
  after(() => h.cleanup());

  it('hides another account\'s notebook from every read path', async () => {
    assert.deepEqual(body<{ notebooks: unknown[] }>(await call(h.app, 'GET', '/v1/notebooks', { token: mallory.token })).notebooks, []);
    assert.equal((await call(h.app, 'GET', `/v1/notebooks/${notebookId}`, { token: mallory.token })).status, 404);
    assert.equal((await call(h.app, 'GET', `/v1/notebooks/${notebookId}/notes`, { token: mallory.token })).status, 404);
    assert.equal((await call(h.app, 'GET', `/v1/notes/${noteId}`, { token: mallory.token })).status, 404);
    assert.equal((await call(h.app, 'GET', `/v1/notes/${noteId}/revisions`, { token: mallory.token })).status, 404);
  });

  it('refuses every write path into another account\'s data', async () => {
    assert.equal((await call(h.app, 'PATCH', `/v1/notebooks/${notebookId}`, { token: mallory.token, body: { title: 'mine' } })).status, 404);
    assert.equal((await call(h.app, 'DELETE', `/v1/notebooks/${notebookId}`, { token: mallory.token })).status, 404);
    assert.equal((await call(h.app, 'PATCH', `/v1/notes/${noteId}`, { token: mallory.token, body: { body: 'tampered' } })).status, 404);
    assert.equal((await call(h.app, 'DELETE', `/v1/notes/${noteId}`, { token: mallory.token })).status, 404);
    assert.equal(
      (
        await call(h.app, 'POST', `/v1/notebooks/${notebookId}/notes`, { token: mallory.token, body: { title: 'inject' } })
      ).status,
      404,
    );
    assert.equal(
      (
        await call(h.app, 'POST', '/v1/sync', {
          token: mallory.token,
          body: { schemaVersion: 1, deviceId: 'dev_m', notebookId, cursor: 0, ops: [] },
        })
      ).status,
      404,
    );
  });

  it('leaves the owner\'s data untouched after the attempts', async () => {
    const note = await call(h.app, 'GET', `/v1/notes/${noteId}`, { token: alice.token });
    assert.equal(note.status, 200);
    assert.equal(body<{ note: Record<string, unknown> }>(note).note['body'], 'do not share');
    const notebooks = body<{ notebooks: unknown[] }>(await call(h.app, 'GET', '/v1/notebooks', { token: alice.token }));
    assert.equal(notebooks.notebooks.length, 1);
  });
});
