/** Wire contract between the SmartNotes client and server. */

import { SCHEMA_VERSION, type Conflict, type Operation, type Tombstone, type User } from './model.js';
import type { FoldState } from './reconcile.js';
import { operationSchema } from './schema.js';
import type { JsonSchema } from './validate.js';

export const API_PREFIX = '/v1';

export interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export interface AuthCredentials {
  email: string;
  password: string;
  displayName?: string;
}

export interface AuthResponse {
  user: User;
  token: string;
  expiresAt: number;
}

/** A client asks for everything after `cursor` and offers its own operations. */
export interface SyncRequest {
  schemaVersion: number;
  deviceId: string;
  notebookId: string;
  cursor: number;
  ops: Operation[];
}

export interface RejectedOperation {
  opId: string;
  reason: string;
}

export interface SyncResponse {
  schemaVersion: number;
  notebookId: string;
  /** Cursor to send on the next sync. */
  cursor: number;
  mode: 'delta' | 'snapshot';
  /** Present when `mode` is "delta". */
  ops: Operation[];
  /** Present when `mode` is "snapshot": adopt this state wholesale. */
  state: FoldState | null;
  accepted: string[];
  rejected: RejectedOperation[];
  tombstones: Tombstone[];
  conflicts: Conflict[];
  serverLamport: number;
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  schemaVersion: number;
  uptimeMs: number;
  storage: { path: string; durable: boolean; records: number; journalBytes: number };
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
}

const EMAIL: JsonSchema = {
  type: 'string',
  minLength: 3,
  maxLength: 320,
  pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$',
};

export const signupSchema: JsonSchema = {
  $id: 'https://smartnotes.dev/schemas/v1/signup.json',
  type: 'object',
  additionalProperties: false,
  required: ['email', 'password'],
  properties: {
    email: EMAIL,
    password: { type: 'string', minLength: 10, maxLength: 200 },
    displayName: { type: 'string', minLength: 1, maxLength: 120 },
  },
};

export const loginSchema: JsonSchema = {
  $id: 'https://smartnotes.dev/schemas/v1/login.json',
  type: 'object',
  additionalProperties: false,
  required: ['email', 'password'],
  properties: { email: EMAIL, password: { type: 'string', minLength: 1, maxLength: 200 } },
};

export const syncRequestSchema: JsonSchema = {
  $id: 'https://smartnotes.dev/schemas/v1/sync-request.json',
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'deviceId', 'notebookId', 'cursor', 'ops'],
  properties: {
    schemaVersion: { type: 'integer', const: SCHEMA_VERSION },
    deviceId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_:.@-]+$' },
    notebookId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_:.@-]+$' },
    cursor: { type: 'integer', minimum: 0 },
    ops: { type: 'array', items: operationSchema, maxItems: 500 },
  },
};

export const pdfUploadSchema: JsonSchema = {
  $id: 'https://smartnotes.dev/schemas/v1/pdf-upload.json',
  type: 'object',
  additionalProperties: false,
  required: ['notebookId', 'filename', 'content'],
  properties: {
    notebookId: { type: 'string', minLength: 1, maxLength: 128 },
    filename: { type: 'string', minLength: 1, maxLength: 260 },
    /** base64 of the PDF bytes */
    content: { type: 'string', minLength: 1 },
    pageCount: { type: 'integer', minimum: 0 },
  },
};
