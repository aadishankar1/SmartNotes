/**
 * Notebook state: one bounded operation log per notebook, and every write —
 * REST or sync — goes through it.
 *
 * There is deliberately one write path. A REST edit is an operation authored
 * by the server on behalf of the caller, so it reconciles against concurrent
 * device edits under exactly the rules the shared contract tests cover.
 */

import { randomUUID } from 'node:crypto';
import {
  DEFAULT_LOG_LIMIT,
  OperationLog,
  createOperation,
  dedupeOperations,
  isSyncedKind,
  materialize,
  sha256Hex,
  validateOperation,
  writableFields,
  SCHEMA_VERSION,
  type Materialized,
  type Operation,
  type SyncRequest,
  type SyncResponse,
  type SyncedKind,
} from '../../shared/src/index.js';
import { JournalStore, type Transaction } from './store/journal.js';
import { TABLES, asRow, toRecord, type LogRow, type NotebookRow, type RevisionRow } from './store/tables.js';
import type { UserRow } from './store/tables.js';

/** Revisions retained per note; older ones are pruned on write. */
export const REVISION_HISTORY = 20;

export const SERVER_ACTOR = 'server';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}

export interface ServerOpInput {
  entityKind: SyncedKind;
  entityId: string;
  kind?: 'set' | 'delete';
  fields?: Record<string, unknown>;
}

export class NotebookService {
  constructor(
    private readonly store: JournalStore,
    private readonly now: () => number,
    /** Operations retained per notebook before older ones fold into a checkpoint. */
    private readonly logLimit: number = DEFAULT_LOG_LIMIT,
  ) {}

  private loadLog(notebookId: string): OperationLog {
    const row = asRow<LogRow>(this.store.get(TABLES.logs, notebookId));
    return new OperationLog({ ...(row?.snapshot ?? {}), limit: this.logLimit });
  }

  private saveLog(tx: Transaction, notebookId: string, log: OperationLog): void {
    tx.put(TABLES.logs, toRecord({ id: notebookId, snapshot: log.toJSON() } satisfies LogRow));
  }

  /** Ownership check. Notebooks of other users are invisible, not forbidden. */
  requireNotebook(user: UserRow, notebookId: string): NotebookRow {
    const row = asRow<NotebookRow>(this.store.get(TABLES.notebooks, notebookId));
    if (!row || row.ownerId !== user.id) {
      throw new ApiError(404, 'notebook_not_found', `no notebook ${notebookId} for this account`);
    }
    return row;
  }

  view(notebookId: string): Materialized {
    return materialize(this.loadLog(notebookId).state());
  }

  entity(notebookId: string, kind: SyncedKind, id: string): Record<string, unknown> | undefined {
    return this.view(notebookId).entities.find((e) => e.kind === kind && e.id === id)?.record;
  }

  /** Resolves the notebook that owns an entity, enforcing ownership. */
  locate(user: UserRow, kind: SyncedKind, id: string): { notebook: NotebookRow; record: Record<string, unknown> } {
    for (const row of this.store.find(TABLES.notebooks, (r) => r['ownerId'] === user.id)) {
      const notebook = row as unknown as NotebookRow;
      const record = this.entity(notebook.id, kind, id);
      if (record) return { notebook, record };
    }
    throw new ApiError(404, `${kind}_not_found`, `no ${kind} ${id} for this account`);
  }

  createNotebook(user: UserRow, title: string, color: string | null): Record<string, unknown> {
    const id = newId('nb');
    const at = this.now();
    this.store.transaction((tx) => {
      const row: NotebookRow = { id, ownerId: user.id, createdAt: at, serverSeq: 0 };
      tx.put(TABLES.notebooks, toRecord(row));
      const log = new OperationLog({ limit: this.logLimit });
      log.append(
        createOperation({
          entityKind: 'notebook',
          entityId: id,
          notebookId: id,
          fields: { ownerId: user.id, title, color, createdAt: at, updatedAt: at },
          actor: SERVER_ACTOR,
          lamport: 1,
          seq: 0,
          basis: 0,
          at,
        }),
      );
      this.saveLog(tx, id, log);
    });
    const record = this.entity(id, 'notebook', id);
    if (!record) throw new ApiError(500, 'notebook_not_materialized', 'notebook did not materialize after creation');
    return record;
  }

  listNotebooks(user: UserRow): Array<Record<string, unknown>> {
    const rows = this.store.find(TABLES.notebooks, (r) => r['ownerId'] === user.id);
    const notebooks: Array<Record<string, unknown>> = [];
    for (const row of rows) {
      const record = this.entity(String(row['id']), 'notebook', String(row['id']));
      if (record) notebooks.push(record);
    }
    return notebooks.sort((a, b) => Number(a['createdAt']) - Number(b['createdAt']));
  }

  /**
   * Authors an operation as the server, at a lamport strictly above everything
   * the notebook has seen, and commits it with any derived rows.
   */
  commit(notebook: NotebookRow, inputs: ServerOpInput[]): Operation[] {
    const at = this.now();
    const written: Operation[] = [];
    this.store.transaction((tx) => {
      const log = this.loadLog(notebook.id);
      const state = log.state();
      let lamport = state.lamport;
      let seq = notebook.serverSeq;
      for (const input of inputs) {
        lamport += 1;
        const op = createOperation({
          entityKind: input.entityKind,
          entityId: input.entityId,
          notebookId: notebook.id,
          kind: input.kind ?? 'set',
          fields: input.fields ?? {},
          actor: SERVER_ACTOR,
          lamport,
          seq,
          basis: lamport - 1,
          at,
        });
        seq += 1;
        log.append(op);
        written.push(op);
        this.recordRevision(tx, notebook.id, op);
      }
      this.saveLog(tx, notebook.id, log);
      tx.put(TABLES.notebooks, toRecord({ ...notebook, serverSeq: seq } satisfies NotebookRow));
    });
    return written;
  }

  /** Ingests device operations, rejecting anything outside the caller's reach. */
  ingest(user: UserRow, notebook: NotebookRow, deviceId: string, ops: readonly Operation[]) {
    const accepted: string[] = [];
    const rejected: Array<{ opId: string; reason: string }> = [];
    this.store.transaction((tx) => {
      const log = this.loadLog(notebook.id);
      let changed = false;
      for (const candidate of dedupeOperations(ops)) {
        const reason = this.rejectionReason(candidate, notebook, deviceId);
        if (reason) {
          rejected.push({ opId: String(candidate.opId ?? 'unknown'), reason });
          continue;
        }
        const result = log.append(candidate);
        accepted.push(candidate.opId);
        if (!result.duplicate) {
          changed = true;
          this.recordRevision(tx, notebook.id, candidate);
        }
      }
      if (changed) this.saveLog(tx, notebook.id, log);
    });
    void user;
    return { accepted, rejected };
  }

  private rejectionReason(candidate: Operation, notebook: NotebookRow, deviceId: string): string | null {
    let op: Operation;
    try {
      op = validateOperation(candidate);
    } catch (error) {
      return error instanceof Error ? error.message : 'invalid operation';
    }
    if (op.notebookId !== notebook.id) return 'operation targets a different notebook';
    if (!isSyncedKind(op.entityKind)) return `entity kind ${op.entityKind} is not syncable`;
    if (op.actor !== deviceId) return 'operation actor does not match the syncing device';
    if (op.kind === 'set') {
      const allowed = new Set(writableFields(op.entityKind));
      for (const field of Object.keys(op.fields)) {
        if (!allowed.has(field)) return `field ${field} is not client-writable on ${op.entityKind}`;
      }
    }
    return null;
  }

  private recordRevision(tx: Transaction, notebookId: string, op: Operation): void {
    if (op.entityKind !== 'note' || op.kind !== 'set') return;
    const body = op.fields['body'];
    if (typeof body !== 'string') return;
    const revision: RevisionRow = {
      id: sha256Hex(`${op.opId}:${op.entityId}`).slice(0, 32),
      noteId: op.entityId,
      notebookId,
      body,
      hash: sha256Hex(body),
      actor: op.actor,
      createdAt: op.at,
    };
    tx.put(TABLES.revisions, toRecord({ schemaVersion: SCHEMA_VERSION, ...revision }));
    const existing = this.revisions(op.entityId);
    for (const stale of existing.slice(0, Math.max(0, existing.length + 1 - REVISION_HISTORY))) {
      tx.delete(TABLES.revisions, stale.id);
    }
  }

  revisions(noteId: string): RevisionRow[] {
    return this.store
      .find(TABLES.revisions, (row) => row['noteId'] === noteId)
      .map((row) => row as unknown as RevisionRow)
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  }

  /** Push device operations and pull everything after the device's cursor. */
  sync(user: UserRow, request: SyncRequest): SyncResponse {
    const notebook = this.requireNotebook(user, request.notebookId);
    const { accepted, rejected } = this.ingest(user, notebook, request.deviceId, request.ops);
    const log = this.loadLog(notebook.id);
    const delta = log.delta(request.cursor);
    const view = materialize(log.state());
    return {
      schemaVersion: SCHEMA_VERSION,
      notebookId: notebook.id,
      cursor: delta.cursor,
      mode: delta.mode,
      ops: delta.mode === 'delta' ? delta.ops : [],
      state: delta.mode === 'snapshot' ? delta.state : null,
      accepted,
      rejected,
      tombstones: view.tombstones,
      conflicts: view.conflicts,
      serverLamport: log.state().lamport,
    };
  }

  cursorOf(notebookId: string): number {
    return this.loadLog(notebookId).head;
  }
}
