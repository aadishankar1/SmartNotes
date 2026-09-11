import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createOperation, decodeStroke, encodeStroke, sha256Hex, type SyncResponse } from '../../shared/src/index.js';
import { body, call, createNotebook, errorCode, harness, samplePdf, signup, type Harness } from './helpers.js';

const T0 = 1767225600000;

async function upload(h: Harness, token: string, notebookId: string, filename = 'syllabus.pdf', bytes = samplePdf(3)) {
  const response = await call(h.app, 'POST', '/v1/pdfs', {
    token,
    body: { notebookId, filename, content: bytes.toString('base64') },
  });
  return { response, bytes };
}

describe('pdf documents', () => {
  let h: Harness;
  let token: string;
  let notebookId: string;
  let pdfId: string;
  let pdfBytes: Buffer;

  before(async () => {
    h = harness();
    token = (await signup(h.app, 'alice@example.com')).token;
    notebookId = await createNotebook(h.app, token);
    const uploaded = await upload(h, token, notebookId);
    assert.equal(uploaded.response.status, 201);
    pdfBytes = uploaded.bytes;
    pdfId = body<{ pdf: { id: string } }>(uploaded.response).pdf.id;
  });
  after(() => h.cleanup());

  it('records size, digest and page count', async () => {
    const listed = body<{ pdfs: Array<Record<string, unknown>> }>(
      await call(h.app, 'GET', `/v1/notebooks/${notebookId}/pdfs`, { token }),
    ).pdfs;
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!['filename'], 'syllabus.pdf');
    assert.equal(listed[0]!['byteSize'], pdfBytes.byteLength);
    assert.equal(listed[0]!['sha256'], sha256Hex(new Uint8Array(pdfBytes)));
    assert.equal(listed[0]!['pageCount'], 3);
  });

  it('returns the stored bytes unchanged', async () => {
    const response = await call(h.app, 'GET', `/v1/pdfs/${pdfId}/content`, { token });
    assert.equal(response.status, 200);
    assert.equal(response.headers?.['content-type'], 'application/pdf');
    assert.ok(response.bytes);
    assert.equal(Buffer.compare(response.bytes, pdfBytes), 0);
  });

  it('refuses content that is not a PDF', async () => {
    const response = await call(h.app, 'POST', '/v1/pdfs', {
      token,
      body: { notebookId, filename: 'notes.txt', content: Buffer.from('hello').toString('base64') },
    });
    assert.equal(response.status, 415);
    assert.equal(errorCode(response), 'not_a_pdf');
  });

  it('keeps documents inside their owner\'s account', async () => {
    const mallory = await signup(h.app, 'mallory@example.com');
    assert.equal((await call(h.app, 'GET', `/v1/pdfs/${pdfId}`, { token: mallory.token })).status, 404);
    assert.equal((await call(h.app, 'GET', `/v1/pdfs/${pdfId}/content`, { token: mallory.token })).status, 404);
    assert.equal((await call(h.app, 'DELETE', `/v1/pdfs/${pdfId}`, { token: mallory.token })).status, 404);
    const injected = await call(h.app, 'POST', '/v1/pdfs', {
      token: mallory.token,
      body: { notebookId, filename: 'evil.pdf', content: samplePdf(1).toString('base64') },
    });
    assert.equal(injected.status, 404);
  });
});

describe('pdf annotations', () => {
  let h: Harness;
  let token: string;
  let notebookId: string;
  let pdfId: string;
  let annotationId: string;
  let strokeId: string;

  before(async () => {
    h = harness();
    token = (await signup(h.app, 'alice@example.com')).token;
    notebookId = await createNotebook(h.app, token);
    const uploaded = await upload(h, token, notebookId);
    pdfId = body<{ pdf: { id: string } }>(uploaded.response).pdf.id;
  });
  after(() => h.cleanup());

  it('stores a highlight with its rectangle', async () => {
    const response = await call(h.app, 'POST', `/v1/pdfs/${pdfId}/annotations`, {
      token,
      body: {
        page: 2,
        kind: 'highlight',
        rect: { x: 72, y: 320.5, width: 180, height: 14 },
        color: '#ffd60a',
        text: 'lab report due',
      },
    });
    assert.equal(response.status, 201);
    const annotation = body<{ annotation: Record<string, unknown> }>(response).annotation;
    annotationId = String(annotation['id']);
    assert.equal(annotation['pdfId'], pdfId);
    assert.deepEqual(annotation['rect'], { x: 72, y: 320.5, width: 180, height: 14 });
  });

  it('stores an ink annotation together with its stroke', async () => {
    const points = encodeStroke([
      { x: 100, y: 200, pressure: 0.5, t: 0 },
      { x: 104.25, y: 203.5, pressure: 0.75, t: 16 },
    ]);
    const response = await call(h.app, 'POST', `/v1/pdfs/${pdfId}/annotations`, {
      token,
      body: { page: 1, kind: 'ink', color: '#1f2933', stroke: { color: '#1f2933', width: 3, points } },
    });
    assert.equal(response.status, 201);
    const payload = body<{ annotation: Record<string, unknown>; stroke: Record<string, unknown> }>(response);
    strokeId = String(payload.stroke['id']);
    assert.equal(payload.annotation['strokeId'], strokeId);
    assert.deepEqual(payload.stroke['points'], points);
    assert.equal(decodeStroke(payload.stroke['points'] as number[])[1]!.t, 16);
  });

  it('lists annotations with the strokes they reference', async () => {
    const listed = body<{ annotations: Array<Record<string, unknown>>; strokes: Array<Record<string, unknown>> }>(
      await call(h.app, 'GET', `/v1/pdfs/${pdfId}/annotations`, { token }),
    );
    assert.equal(listed.annotations.length, 2);
    assert.equal(listed.strokes.length, 1);
    assert.equal(listed.strokes[0]!['targetId'], pdfId);
  });

  it('rejects an edit that would break the schema', async () => {
    const bad = await call(h.app, 'PATCH', `/v1/annotations/${annotationId}`, { token, body: { color: 'yellow' } });
    assert.equal(bad.status, 400);
    assert.equal(errorCode(bad), 'invalid_annotation');
  });

  it('updates and deletes an annotation', async () => {
    const patched = await call(h.app, 'PATCH', `/v1/annotations/${annotationId}`, { token, body: { color: '#ff5252' } });
    assert.equal(patched.status, 200);
    assert.equal(body<{ annotation: Record<string, unknown> }>(patched).annotation['color'], '#ff5252');

    const deleted = await call(h.app, 'DELETE', `/v1/annotations/${annotationId}`, { token });
    assert.equal(deleted.status, 204);
    const remaining = body<{ annotations: unknown[] }>(await call(h.app, 'GET', `/v1/pdfs/${pdfId}/annotations`, { token }));
    assert.equal(remaining.annotations.length, 1);
  });

  it('keeps annotations and their PDF across a restart', async () => {
    h.restart();
    const listed = body<{ annotations: Array<Record<string, unknown>>; strokes: Array<Record<string, unknown>> }>(
      await call(h.app, 'GET', `/v1/pdfs/${pdfId}/annotations`, { token }),
    );
    assert.equal(listed.annotations.length, 1);
    assert.equal(listed.annotations[0]!['strokeId'], strokeId);
    assert.equal(listed.strokes.length, 1);

    const content = await call(h.app, 'GET', `/v1/pdfs/${pdfId}/content`, { token });
    assert.equal(content.status, 200);
    assert.equal(content.bytes?.subarray(0, 5).toString('latin1'), '%PDF-');
  });

  it('accepts an annotation authored by a device through sync', async () => {
    const op = createOperation({
      entityKind: 'annotation',
      entityId: 'anno_from_device',
      notebookId,
      fields: {
        pdfId,
        page: 0,
        kind: 'note',
        rect: null,
        color: '#2f80ed',
        text: 'written offline',
        strokeId: null,
        createdAt: T0,
        updatedAt: T0,
      },
      actor: 'dev_ipad',
      lamport: 50,
      seq: 0,
      basis: 49,
      at: T0,
    });
    const response = await call(h.app, 'POST', '/v1/sync', {
      token,
      body: { schemaVersion: 1, deviceId: 'dev_ipad', notebookId, cursor: 0, ops: [op] },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(body<SyncResponse>(response).rejected, []);

    h.restart();
    const listed = body<{ annotations: Array<Record<string, unknown>> }>(
      await call(h.app, 'GET', `/v1/pdfs/${pdfId}/annotations`, { token }),
    ).annotations;
    const fromDevice = listed.find((a) => a['id'] === 'anno_from_device');
    assert.ok(fromDevice, 'the device annotation must survive');
    assert.equal(fromDevice['text'], 'written offline');
  });
});
