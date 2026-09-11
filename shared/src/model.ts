/** Entity types of the SmartNotes contract. Schemas live in `schema.ts`. */

/** Bumped only for a breaking change; every stored record carries it. */
export const SCHEMA_VERSION = 1;

export type SchemaVersion = typeof SCHEMA_VERSION;

export const ENTITY_KINDS = [
  'user',
  'notebook',
  'note',
  'revision',
  'tombstone',
  'pdf',
  'annotation',
  'stroke',
  'conflict',
] as const;

export type EntityKind = (typeof ENTITY_KINDS)[number];

/** Entities that clients may write through the operation log. */
export const SYNCED_KINDS = ['notebook', 'note', 'pdf', 'annotation', 'stroke'] as const;

export type SyncedKind = (typeof SYNCED_KINDS)[number];

export function isSyncedKind(kind: string): kind is SyncedKind {
  return (SYNCED_KINDS as readonly string[]).includes(kind);
}

/**
 * Total order over operations. `lamport` is the logical clock, `actor` the
 * device, `seq` that device's own counter, so no two operations tie.
 */
export interface Stamp {
  lamport: number;
  actor: string;
  seq: number;
}

export interface User {
  schemaVersion: number;
  id: string;
  email: string;
  displayName: string;
  createdAt: number;
}

export interface Notebook {
  schemaVersion: number;
  id: string;
  ownerId: string;
  title: string;
  color: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Note {
  schemaVersion: number;
  id: string;
  notebookId: string;
  title: string;
  body: string;
  position: number;
  createdAt: number;
  updatedAt: number;
}

export interface Revision {
  schemaVersion: number;
  id: string;
  noteId: string;
  body: string;
  hash: string;
  actor: string;
  createdAt: number;
}

export interface Tombstone {
  schemaVersion: number;
  entityKind: SyncedKind;
  entityId: string;
  notebookId: string;
  stamp: Stamp;
  deletedAt: number;
}

export interface PdfDocument {
  schemaVersion: number;
  id: string;
  notebookId: string;
  filename: string;
  byteSize: number;
  sha256: string;
  pageCount: number;
  createdAt: number;
}

export type AnnotationKind = 'highlight' | 'note' | 'ink';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Annotation {
  schemaVersion: number;
  id: string;
  pdfId: string;
  notebookId: string;
  page: number;
  kind: AnnotationKind;
  rect: Rect | null;
  color: string;
  text: string | null;
  strokeId: string | null;
  createdAt: number;
  updatedAt: number;
}

export type StrokeTargetKind = 'note' | 'pdf';

/**
 * Ink is stored as a flat quantised integer array — [x, y, pressure, dt, ...] —
 * because float coordinates do not round-trip to identical bytes across
 * devices, and identical bytes are what make two replicas comparable.
 */
export interface InkStroke {
  schemaVersion: number;
  id: string;
  notebookId: string;
  targetKind: StrokeTargetKind;
  targetId: string;
  page: number | null;
  color: string;
  width: number;
  points: number[];
  createdAt: number;
}

export interface ConflictSide {
  opId: string;
  stamp: Stamp;
  value: unknown;
}

/**
 * A concurrent write that lost per-field last-writer-wins. The losing value is
 * kept so a client can offer it back to the user instead of silently dropping
 * work.
 */
export interface Conflict {
  schemaVersion: number;
  id: string;
  entityKind: SyncedKind;
  entityId: string;
  field: string;
  winner: ConflictSide;
  losers: ConflictSide[];
  detectedAt: number;
}

export type OperationKind = 'set' | 'delete';

export interface Operation {
  schemaVersion: number;
  opId: string;
  entityKind: SyncedKind;
  entityId: string;
  notebookId: string;
  kind: OperationKind;
  /** Present for `set`; a partial record of fields this operation writes. */
  fields: Record<string, unknown>;
  actor: string;
  lamport: number;
  seq: number;
  /** Highest lamport this actor had observed; makes causality decidable. */
  basis: number;
  at: number;
}
