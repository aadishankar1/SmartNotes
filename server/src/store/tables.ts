/** Table names and row shapes held in the durable store. */

import type { JsonObject } from '../../../shared/src/index.js';
import type { OperationLogSnapshot } from '../../../shared/src/index.js';

export const TABLES = {
  users: 'users',
  sessions: 'sessions',
  notebooks: 'notebooks',
  logs: 'logs',
  revisions: 'revisions',
  blobs: 'blobs',
} as const;

export interface UserRow {
  id: string;
  email: string;
  displayName: string;
  createdAt: number;
  passwordHash: string;
  salt: string;
}

export interface SessionRow {
  /** SHA-256 of the bearer token; the token itself is never stored. */
  id: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
}

export interface NotebookRow {
  id: string;
  ownerId: string;
  createdAt: number;
  /** Sequence counter for operations the server itself authors. */
  serverSeq: number;
}

export interface LogRow {
  /** Notebook id. */
  id: string;
  snapshot: OperationLogSnapshot;
}

export interface RevisionRow {
  id: string;
  noteId: string;
  notebookId: string;
  body: string;
  hash: string;
  actor: string;
  createdAt: number;
}

export interface BlobRow {
  /** SHA-256 of the content, which is also its filename under blobs/. */
  id: string;
  byteSize: number;
  createdAt: number;
}

export function asRow<T>(record: JsonObject | undefined): T | undefined {
  return record as T | undefined;
}

export function toRecord(row: unknown): JsonObject {
  return row as JsonObject;
}
