import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { once } from 'node:events';

import { SCHEMA_VERSION } from '../../shared/src/index.js';
import { createRequestListener } from '../src/server.js';
import { body, call, createNotebook, errorCode, harness, signup, type Harness } from './helpers.js';

describe('service surface', () => {
  let h: Harness;

  before(() => {
    h = harness();
  });
  after(() => h.cleanup());

  it('reports health without authentication', async () => {
    const response = await call(h.app, 'GET', '/health');
    assert.equal(response.status, 200);
    const payload = body<{ status: string; schemaVersion: number; checks: Array<{ name: string; ok: boolean }> }>(response);
    assert.equal(payload.status, 'ok');
    assert.equal(payload.schemaVersion, SCHEMA_VERSION);
    assert.ok(payload.checks.every((check) => check.ok));
    assert.ok(payload.checks.some((check) => check.name === 'storage_writable'));
  });

  it('answers unknown routes and wrong methods distinctly', async () => {
    const missing = await call(h.app, 'GET', '/v1/nothing-here');
    assert.equal(missing.status, 404);
    assert.equal(errorCode(missing), 'not_found');

    const wrongMethod = await call(h.app, 'DELETE', '/health');
    assert.equal(wrongMethod.status, 405);
    assert.equal(errorCode(wrongMethod), 'method_not_allowed');
  });

  it('ignores a query string when routing', async () => {
    const response = await call(h.app, 'GET', '/health?verbose=1');
    assert.equal(response.status, 200);
  });
});

/**
 * Exercises the node:http adapter without binding a socket, by driving the
 * request listener with a stream and a recording response.
 */
describe('http transport', () => {
  let h: Harness;
  before(() => {
    h = harness();
  });
  after(() => h.cleanup());

  interface Recorded {
    status: number;
    headers: Record<string, string>;
    payload: Buffer;
  }

  async function drive(method: string, path: string, payload?: unknown): Promise<Recorded> {
    const listener = createRequestListener(h.app);
    const chunks = payload === undefined ? [] : [Buffer.from(JSON.stringify(payload), 'utf8')];
    const request = Object.assign(Readable.from(chunks), {
      method,
      url: path,
      headers: { 'content-type': 'application/json' } as Record<string, string>,
    }) as unknown as IncomingMessage;

    const recorded: Recorded = { status: 0, headers: {}, payload: Buffer.alloc(0) };
    const finished = new (class extends Readable {
      override _read(): void {}
    })();
    const response = {
      writeHead(status: number, headers: Record<string, string>) {
        recorded.status = status;
        recorded.headers = headers;
        return this;
      },
      end(chunk?: Buffer) {
        recorded.payload = chunk ?? Buffer.alloc(0);
        finished.emit('done');
      },
    } as unknown as ServerResponse;

    listener(request, response);
    await once(finished, 'done');
    return recorded;
  }

  it('serves JSON with a content length', async () => {
    const recorded = await drive('GET', '/health');
    assert.equal(recorded.status, 200);
    assert.equal(recorded.headers['content-length'], String(recorded.payload.byteLength));
    assert.equal(JSON.parse(recorded.payload.toString('utf8')).status, 'ok');
  });

  it('reads a JSON body from the request stream', async () => {
    const recorded = await drive('POST', '/v1/auth/signup', { email: 'stream@example.com', password: 'correct horse battery' });
    assert.equal(recorded.status, 201);
    assert.ok(JSON.parse(recorded.payload.toString('utf8')).token);
  });

  it('answers a malformed body with 400 rather than crashing', async () => {
    const listener = createRequestListener(h.app);
    const request = Object.assign(Readable.from([Buffer.from('{not json', 'utf8')]), {
      method: 'POST',
      url: '/v1/auth/login',
      headers: {} as Record<string, string>,
    }) as unknown as IncomingMessage;
    let status = 0;
    const done = new Promise<void>((resolve) => {
      const response = {
        writeHead(code: number) {
          status = code;
          return this;
        },
        end() {
          resolve();
        },
      } as unknown as ServerResponse;
      listener(request, response);
    });
    await done;
    assert.equal(status, 400);
  });
});

describe('notebook and note CRUD', () => {
  let h: Harness;
  let token: string;
  let notebookId: string;

  before(async () => {
    h = harness();
    token = (await signup(h.app, 'alice@example.com')).token;
    notebookId = await createNotebook(h.app, token, 'Field notes');
  });
  after(() => h.cleanup());

  it('creates, reads, updates and deletes a notebook', async () => {
    const read = await call(h.app, 'GET', `/v1/notebooks/${notebookId}`, { token });
    assert.equal(read.status, 200);
    assert.equal(body<{ notebook: Record<string, unknown> }>(read).notebook['title'], 'Field notes');

    const patched = await call(h.app, 'PATCH', `/v1/notebooks/${notebookId}`, { token, body: { title: 'Fieldwork', color: '#2f80ed' } });
    assert.equal(patched.status, 200);
    assert.equal(body<{ notebook: Record<string, unknown> }>(patched).notebook['color'], '#2f80ed');

    const second = await createNotebook(h.app, token, 'Archive');
    assert.equal((await call(h.app, 'DELETE', `/v1/notebooks/${second}`, { token })).status, 204);
    const list = body<{ notebooks: Array<Record<string, unknown>> }>(await call(h.app, 'GET', '/v1/notebooks', { token }));
    assert.deepEqual(
      list.notebooks.map((n) => n['id']),
      [notebookId],
    );
    assert.equal((await call(h.app, 'GET', `/v1/notebooks/${second}`, { token })).status, 404);
  });

  it('validates fields instead of storing something unusable', async () => {
    const badColor = await call(h.app, 'PATCH', `/v1/notebooks/${notebookId}`, { token, body: { color: 'blue' } });
    assert.equal(badColor.status, 400);
    assert.equal(errorCode(badColor), 'invalid_notebook');

    const unknownField = await call(h.app, 'PATCH', `/v1/notebooks/${notebookId}`, { token, body: { ownerId: 'usr_x' } });
    assert.equal(unknownField.status, 400);
    assert.equal(errorCode(unknownField), 'unknown_field');

    const emptyTitle = await call(h.app, 'POST', '/v1/notebooks', { token, body: { title: '' } });
    assert.equal(emptyTitle.status, 400);

    const stillFine = await call(h.app, 'GET', `/v1/notebooks/${notebookId}`, { token });
    assert.equal(body<{ notebook: Record<string, unknown> }>(stillFine).notebook['title'], 'Fieldwork');
  });

  it('creates notes and lists them under their notebook', async () => {
    const created = await call(h.app, 'POST', `/v1/notebooks/${notebookId}/notes`, {
      token,
      body: { title: 'Site visit', body: 'sensor layout' },
    });
    assert.equal(created.status, 201);
    const noteId = body<{ note: { id: string } }>(created).note.id;

    const listed = body<{ notes: Array<Record<string, unknown>> }>(
      await call(h.app, 'GET', `/v1/notebooks/${notebookId}/notes`, { token }),
    );
    assert.equal(listed.notes.length, 1);
    assert.equal(listed.notes[0]!['id'], noteId);

    const patched = await call(h.app, 'PATCH', `/v1/notes/${noteId}`, { token, body: { body: 'sensor layout v2' } });
    assert.equal(body<{ note: Record<string, unknown> }>(patched).note['body'], 'sensor layout v2');

    const revisions = body<{ revisions: Array<Record<string, unknown>> }>(
      await call(h.app, 'GET', `/v1/notes/${noteId}/revisions`, { token }),
    ).revisions;
    assert.deepEqual(
      revisions.map((r) => r['body']),
      ['sensor layout', 'sensor layout v2'],
    );

    assert.equal((await call(h.app, 'DELETE', `/v1/notes/${noteId}`, { token })).status, 204);
    assert.equal((await call(h.app, 'GET', `/v1/notes/${noteId}`, { token })).status, 404);
    const afterDelete = body<{ notes: unknown[] }>(await call(h.app, 'GET', `/v1/notebooks/${notebookId}/notes`, { token }));
    assert.equal(afterDelete.notes.length, 0);
  });

  it('rejects a body that is not a JSON object', async () => {
    const response = await call(h.app, 'POST', '/v1/notebooks', { token, body: ['not', 'an', 'object'] });
    assert.equal(response.status, 400);
    assert.equal(errorCode(response), 'invalid_body');
  });
});
