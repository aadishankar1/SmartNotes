/**
 * The SmartNotes API, assembled over the durable store.
 *
 * `createApp` returns an in-process handler; `server.ts` binds it to a socket.
 * Every route resolves the caller first and then the notebook that owns the
 * entity, so per-user isolation is enforced in one place rather than per route.
 */

import {
  API_PREFIX,
  SCHEMA_VERSION,
  assertValid,
  loginSchema,
  pdfUploadSchema,
  schemaFor,
  signupSchema,
  syncRequestSchema,
  validate,
  ValidationError,
  ContractError,
  type AuthCredentials,
  type HealthResponse,
  type SyncRequest,
  type SyncedKind,
} from '../../shared/src/index.js';
import { AuthError, AuthService, publicUser } from './auth.js';
import { ApiError, NotebookService, newId } from './notebooks.js';
import { PdfService } from './pdfs.js';
import { JournalStore } from './store/journal.js';
import { type NotebookRow, type UserRow } from './store/tables.js';
import {
  MethodNotAllowed,
  Router,
  bearerToken,
  errorResponse,
  json,
  type ApiRequest,
  type ApiResponse,
} from './http.js';

export interface AppOptions {
  dataDir: string;
  now?: () => number;
  fsync?: boolean;
  compactAfterBytes?: number;
  /** Bound on the per-notebook operation log; lower values force snapshots sooner. */
  logLimit?: number;
}

export interface App {
  handle(request: RequestInput): Promise<ApiResponse>;
  store: JournalStore;
  auth: AuthService;
  notebooks: NotebookService;
  pdfs: PdfService;
  close(): void;
}

export interface RequestInput {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}

function record(source: Record<string, unknown> | undefined, fields: Record<string, unknown>, id: string, notebookId: string, kind: SyncedKind): Record<string, unknown> {
  const merged: Record<string, unknown> = { schemaVersion: SCHEMA_VERSION, id, ...(source ?? {}), ...fields };
  if (kind !== 'notebook') merged['notebookId'] = notebookId;
  return merged;
}

function ensureValid(kind: SyncedKind, candidate: Record<string, unknown>): void {
  const result = validate(candidate, schemaFor(kind));
  if (!result.valid) {
    throw new ApiError(400, `invalid_${kind}`, `${kind} would become invalid`, result.issues);
  }
}

function asObject(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'invalid_body', 'a JSON object body is required');
  }
  return body as Record<string, unknown>;
}

function pick(body: Record<string, unknown>, allowed: readonly string[]): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!allowed.includes(key)) throw new ApiError(400, 'unknown_field', `field ${key} cannot be set here`);
    fields[key] = value;
  }
  return fields;
}

export function createApp(options: AppOptions): App {
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  const store = JournalStore.open({
    dir: options.dataDir,
    fsync: options.fsync,
    compactAfterBytes: options.compactAfterBytes,
  });
  const auth = new AuthService(store, now);
  const notebooks = new NotebookService(store, now, options.logLimit);
  const pdfs = new PdfService(store, notebooks, now);
  const router = new Router();

  const requireUser = (request: ApiRequest): UserRow => auth.authenticate(bearerToken(request.headers));

  const requireNotebook = (request: ApiRequest, user: UserRow): NotebookRow =>
    notebooks.requireNotebook(user, request.params['notebookId']!);

  router.get('/health', () => {
    const checks: HealthResponse['checks'] = [];
    let ok = true;
    try {
      store.transaction((tx) => tx.put('health', { id: 'probe', at: now() }));
      checks.push({ name: 'storage_writable', ok: true });
    } catch (error) {
      ok = false;
      checks.push({ name: 'storage_writable', ok: false, detail: (error as Error).message });
    }
    const stats = store.stats();
    checks.push({ name: 'storage_readable', ok: true, detail: `${stats.records} records` });
    checks.push({ name: 'schema_version', ok: true, detail: String(SCHEMA_VERSION) });
    const body: HealthResponse = {
      status: ok ? 'ok' : 'degraded',
      schemaVersion: SCHEMA_VERSION,
      uptimeMs: now() - startedAt,
      storage: {
        path: stats.path,
        durable: options.fsync !== false,
        records: stats.records,
        journalBytes: stats.journalBytes,
      },
      checks,
    };
    return json(ok ? 200 : 503, body);
  });

  router.post(`${API_PREFIX}/auth/signup`, (request) => {
    const input = assertValid<AuthCredentials>(request.body, signupSchema, 'signup');
    const session = auth.signup(input.email, input.password, input.displayName);
    return json(201, { user: publicUser(session.user), token: session.token, expiresAt: session.expiresAt });
  });

  router.post(`${API_PREFIX}/auth/login`, (request) => {
    const input = assertValid<AuthCredentials>(request.body, loginSchema, 'login');
    const session = auth.login(input.email, input.password);
    return json(200, { user: publicUser(session.user), token: session.token, expiresAt: session.expiresAt });
  });

  router.post(`${API_PREFIX}/auth/logout`, (request) => {
    auth.logout(bearerToken(request.headers));
    return { status: 204 };
  });

  router.get(`${API_PREFIX}/me`, (request) => json(200, { user: publicUser(requireUser(request)) }));

  router.get(`${API_PREFIX}/notebooks`, (request) => json(200, { notebooks: notebooks.listNotebooks(requireUser(request)) }));

  router.post(`${API_PREFIX}/notebooks`, (request) => {
    const user = requireUser(request);
    const fields = pick(asObject(request.body), ['title', 'color']);
    const title = typeof fields['title'] === 'string' ? fields['title'] : '';
    const color = fields['color'] === undefined ? null : fields['color'];
    ensureValid('notebook', {
      schemaVersion: SCHEMA_VERSION,
      id: 'nb_placeholder',
      ownerId: user.id,
      title,
      color,
      createdAt: 0,
      updatedAt: 0,
    });
    return json(201, { notebook: notebooks.createNotebook(user, title, color as string | null) });
  });

  router.get(`${API_PREFIX}/notebooks/:notebookId`, (request) => {
    const user = requireUser(request);
    const notebook = requireNotebook(request, user);
    const view = notebooks.view(notebook.id);
    const entity = view.entities.find((e) => e.kind === 'notebook' && e.id === notebook.id);
    if (!entity) throw new ApiError(404, 'notebook_not_found', 'notebook has been deleted');
    return json(200, {
      notebook: entity.record,
      notes: view.entities.filter((e) => e.kind === 'note').map((e) => e.record),
      pdfs: view.entities.filter((e) => e.kind === 'pdf').map((e) => e.record),
      conflicts: view.conflicts,
      cursor: notebooks.cursorOf(notebook.id),
    });
  });

  router.patch(`${API_PREFIX}/notebooks/:notebookId`, (request) => {
    const user = requireUser(request);
    const notebook = requireNotebook(request, user);
    const current = notebooks.entity(notebook.id, 'notebook', notebook.id);
    if (!current) throw new ApiError(404, 'notebook_not_found', 'notebook has been deleted');
    const fields = { ...pick(asObject(request.body), ['title', 'color']), updatedAt: now() };
    ensureValid('notebook', record(current, fields, notebook.id, notebook.id, 'notebook'));
    notebooks.commit(notebook, [{ entityKind: 'notebook', entityId: notebook.id, fields }]);
    return json(200, { notebook: notebooks.entity(notebook.id, 'notebook', notebook.id) });
  });

  router.delete(`${API_PREFIX}/notebooks/:notebookId`, (request) => {
    const user = requireUser(request);
    const notebook = requireNotebook(request, user);
    notebooks.commit(notebook, [{ entityKind: 'notebook', entityId: notebook.id, kind: 'delete' }]);
    return { status: 204 };
  });

  router.get(`${API_PREFIX}/notebooks/:notebookId/notes`, (request) => {
    const user = requireUser(request);
    const notebook = requireNotebook(request, user);
    const notes = notebooks
      .view(notebook.id)
      .entities.filter((e) => e.kind === 'note')
      .map((e) => e.record);
    return json(200, { notes });
  });

  router.post(`${API_PREFIX}/notebooks/:notebookId/notes`, (request) => {
    const user = requireUser(request);
    const notebook = requireNotebook(request, user);
    const input = pick(asObject(request.body), ['title', 'body', 'position']);
    const at = now();
    const id = newId('note');
    const fields = {
      title: input['title'] ?? '',
      body: input['body'] ?? '',
      position: input['position'] ?? at,
      createdAt: at,
      updatedAt: at,
    };
    ensureValid('note', record(undefined, fields, id, notebook.id, 'note'));
    notebooks.commit(notebook, [{ entityKind: 'note', entityId: id, fields }]);
    return json(201, { note: notebooks.entity(notebook.id, 'note', id) });
  });

  router.get(`${API_PREFIX}/notes/:noteId`, (request) => {
    const user = requireUser(request);
    const { record: note } = notebooks.locate(user, 'note', request.params['noteId']!);
    return json(200, { note });
  });

  router.patch(`${API_PREFIX}/notes/:noteId`, (request) => {
    const user = requireUser(request);
    const noteId = request.params['noteId']!;
    const { notebook, record: current } = notebooks.locate(user, 'note', noteId);
    const fields = { ...pick(asObject(request.body), ['title', 'body', 'position']), updatedAt: now() };
    ensureValid('note', record(current, fields, noteId, notebook.id, 'note'));
    notebooks.commit(notebook, [{ entityKind: 'note', entityId: noteId, fields }]);
    return json(200, { note: notebooks.entity(notebook.id, 'note', noteId) });
  });

  router.delete(`${API_PREFIX}/notes/:noteId`, (request) => {
    const user = requireUser(request);
    const noteId = request.params['noteId']!;
    const { notebook } = notebooks.locate(user, 'note', noteId);
    notebooks.commit(notebook, [{ entityKind: 'note', entityId: noteId, kind: 'delete' }]);
    return { status: 204 };
  });

  router.get(`${API_PREFIX}/notes/:noteId/revisions`, (request) => {
    const user = requireUser(request);
    const noteId = request.params['noteId']!;
    notebooks.locate(user, 'note', noteId);
    return json(200, { revisions: notebooks.revisions(noteId) });
  });

  router.post(`${API_PREFIX}/pdfs`, (request) => {
    const user = requireUser(request);
    const input = assertValid<{ notebookId: string; filename: string; content: string; pageCount?: number }>(
      request.body,
      pdfUploadSchema,
      'pdf upload',
    );
    const notebook = notebooks.requireNotebook(user, input.notebookId);
    const bytes = Buffer.from(input.content, 'base64');
    return json(201, { pdf: pdfs.upload(notebook, input.filename, bytes, input.pageCount) });
  });

  router.get(`${API_PREFIX}/notebooks/:notebookId/pdfs`, (request) => {
    const user = requireUser(request);
    const notebook = requireNotebook(request, user);
    const documents = notebooks
      .view(notebook.id)
      .entities.filter((e) => e.kind === 'pdf')
      .map((e) => e.record);
    return json(200, { pdfs: documents });
  });

  router.get(`${API_PREFIX}/pdfs/:pdfId`, (request) => {
    const user = requireUser(request);
    const { record: pdf } = notebooks.locate(user, 'pdf', request.params['pdfId']!);
    return json(200, { pdf });
  });

  router.get(`${API_PREFIX}/pdfs/:pdfId/content`, (request) => {
    const user = requireUser(request);
    const { record: pdf } = notebooks.locate(user, 'pdf', request.params['pdfId']!);
    return {
      status: 200,
      bytes: pdfs.read(pdf),
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `attachment; filename="${String(pdf['filename']).replace(/"/g, '')}"`,
      },
    };
  });

  router.delete(`${API_PREFIX}/pdfs/:pdfId`, (request) => {
    const user = requireUser(request);
    const pdfId = request.params['pdfId']!;
    const { notebook } = notebooks.locate(user, 'pdf', pdfId);
    notebooks.commit(notebook, [{ entityKind: 'pdf', entityId: pdfId, kind: 'delete' }]);
    return { status: 204 };
  });

  router.get(`${API_PREFIX}/pdfs/:pdfId/annotations`, (request) => {
    const user = requireUser(request);
    const pdfId = request.params['pdfId']!;
    const { notebook } = notebooks.locate(user, 'pdf', pdfId);
    const view = notebooks.view(notebook.id);
    const annotations = view.entities.filter((e) => e.kind === 'annotation' && e.record['pdfId'] === pdfId).map((e) => e.record);
    const strokeIds = new Set(annotations.map((a) => a['strokeId']).filter((id): id is string => typeof id === 'string'));
    const strokes = view.entities.filter((e) => e.kind === 'stroke' && strokeIds.has(e.id)).map((e) => e.record);
    return json(200, { annotations, strokes });
  });

  router.post(`${API_PREFIX}/pdfs/:pdfId/annotations`, (request) => {
    const user = requireUser(request);
    const pdfId = request.params['pdfId']!;
    const { notebook } = notebooks.locate(user, 'pdf', pdfId);
    const input = pick(asObject(request.body), ['page', 'kind', 'rect', 'color', 'text', 'strokeId', 'stroke']);
    const at = now();
    const commits: Parameters<NotebookService['commit']>[1] = [];

    let strokeId = (input['strokeId'] as string | undefined) ?? null;
    if (input['stroke'] !== undefined) {
      const stroke = asObject(input['stroke']);
      strokeId = newId('ink');
      const strokeFields = {
        targetKind: 'pdf',
        targetId: pdfId,
        page: input['page'] ?? 0,
        color: stroke['color'] ?? '#1f2933',
        width: stroke['width'] ?? 2,
        points: stroke['points'] ?? [],
        createdAt: at,
      };
      ensureValid('stroke', record(undefined, strokeFields, strokeId, notebook.id, 'stroke'));
      commits.push({ entityKind: 'stroke', entityId: strokeId, fields: strokeFields });
    }

    const id = newId('anno');
    const fields = {
      pdfId,
      page: input['page'] ?? 0,
      kind: input['kind'] ?? (strokeId ? 'ink' : 'highlight'),
      rect: input['rect'] ?? null,
      color: input['color'] ?? '#ffd60a',
      text: input['text'] ?? null,
      strokeId,
      createdAt: at,
      updatedAt: at,
    };
    ensureValid('annotation', record(undefined, fields, id, notebook.id, 'annotation'));
    commits.push({ entityKind: 'annotation', entityId: id, fields });
    notebooks.commit(notebook, commits);
    return json(201, {
      annotation: notebooks.entity(notebook.id, 'annotation', id),
      stroke: strokeId ? notebooks.entity(notebook.id, 'stroke', strokeId) : null,
    });
  });

  router.patch(`${API_PREFIX}/annotations/:annotationId`, (request) => {
    const user = requireUser(request);
    const annotationId = request.params['annotationId']!;
    const { notebook, record: current } = notebooks.locate(user, 'annotation', annotationId);
    const fields = { ...pick(asObject(request.body), ['page', 'kind', 'rect', 'color', 'text', 'strokeId']), updatedAt: now() };
    ensureValid('annotation', record(current, fields, annotationId, notebook.id, 'annotation'));
    notebooks.commit(notebook, [{ entityKind: 'annotation', entityId: annotationId, fields }]);
    return json(200, { annotation: notebooks.entity(notebook.id, 'annotation', annotationId) });
  });

  router.delete(`${API_PREFIX}/annotations/:annotationId`, (request) => {
    const user = requireUser(request);
    const annotationId = request.params['annotationId']!;
    const { notebook } = notebooks.locate(user, 'annotation', annotationId);
    notebooks.commit(notebook, [{ entityKind: 'annotation', entityId: annotationId, kind: 'delete' }]);
    return { status: 204 };
  });

  router.post(`${API_PREFIX}/sync`, (request) => {
    const user = requireUser(request);
    const input = assertValid<SyncRequest>(request.body, syncRequestSchema, 'sync request');
    return json(200, notebooks.sync(user, input));
  });

  async function handle(input: RequestInput): Promise<ApiResponse> {
    const [rawPath, rawQuery] = input.path.split('?');
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.headers ?? {})) headers[key.toLowerCase()] = value;

    try {
      const matched = router.match(input.method.toUpperCase(), rawPath ?? '/');
      if (!matched) return errorResponse(404, 'not_found', `no route for ${input.method} ${rawPath}`);
      const request: ApiRequest = {
        method: input.method.toUpperCase(),
        path: rawPath ?? '/',
        query: new URLSearchParams(rawQuery ?? ''),
        headers,
        body: input.body ?? null,
        params: matched.params,
      };
      return await matched.handler(request);
    } catch (error) {
      return translate(error);
    }
  }

  return { handle, store, auth, notebooks, pdfs, close: () => store.close() };
}

function translate(error: unknown): ApiResponse {
  if (error instanceof ApiError) return errorResponse(error.status, error.code, error.message, error.details);
  if (error instanceof AuthError) return errorResponse(error.status, error.code, error.message);
  if (error instanceof ValidationError) return errorResponse(400, 'invalid_request', error.message, error.issues);
  if (error instanceof ContractError) return errorResponse(400, 'contract_violation', error.message);
  if (error instanceof MethodNotAllowed) return errorResponse(405, 'method_not_allowed', error.message);
  const message = error instanceof Error ? error.message : 'unexpected error';
  return errorResponse(500, 'internal_error', message);
}
