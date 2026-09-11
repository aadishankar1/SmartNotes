/**
 * Reconciliation: fold a set of operations into replica state.
 *
 * The fold is a pure function of the operation *set*, not of arrival order.
 * Each field keeps the antichain of writes no later write has observed; the
 * highest stamp in that antichain is the value (per-field last-writer-wins)
 * and everything else in it is a recorded conflict rather than lost work.
 * Deletes are tombstones with the same stamps, so a delete and a later edit
 * resolve the same way on every device.
 */

import { canonicalize, jsonEquals } from './json.js';
import { hashJson } from './hash.js';
import {
  compareStamps,
  dedupeOperations,
  happensBefore,
  sortOperations,
  stampOf,
} from './ops.js';
import { schemaFor } from './schema.js';
import { validate, type ValidationIssue } from './validate.js';
import {
  SCHEMA_VERSION,
  SYNCED_KINDS,
  type Conflict,
  type ConflictSide,
  type Operation,
  type Stamp,
  type SyncedKind,
  type Tombstone,
} from './model.js';

/** Field name used for a delete that raced a surviving edit. */
export const DELETED_FIELD = '__deleted';

/** Bound on retained concurrent writes per field; keeps state size finite. */
export const MAX_CONCURRENT_WRITES = 16;

export interface Side {
  opId: string;
  stamp: Stamp;
  basis: number;
  value: unknown;
  at: number;
}

export interface FieldState {
  /** Maximal (mutually concurrent) writes, ascending by stamp. */
  writes: Side[];
}

export interface EntityState {
  kind: SyncedKind;
  id: string;
  notebookId: string;
  notebookStamp: Stamp;
  fields: Record<string, FieldState>;
  deleted: Side | null;
}

export interface FoldState {
  schemaVersion: number;
  lamport: number;
  entities: Record<string, EntityState>;
}

export interface MaterializedEntity {
  kind: SyncedKind;
  id: string;
  notebookId: string;
  record: Record<string, unknown>;
}

export interface Materialized {
  entities: MaterializedEntity[];
  tombstones: Tombstone[];
  conflicts: Conflict[];
  invalid: Array<{ kind: SyncedKind; id: string; issues: ValidationIssue[] }>;
}

export function emptyState(): FoldState {
  return { schemaVersion: SCHEMA_VERSION, lamport: 0, entities: {} };
}

export function entityKey(kind: SyncedKind, id: string): string {
  return `${kind}:${id}`;
}

function sideOf(op: Operation, value: unknown): Side {
  return { opId: op.opId, stamp: stampOf(op), basis: op.basis, value, at: op.at };
}

function mergeWrite(writes: Side[], side: Side): Side[] {
  if (writes.some((w) => w.opId === side.opId)) return writes;
  if (writes.some((w) => happensBefore(side.stamp, { ...w.stamp, basis: w.basis }))) return writes;
  const kept = writes.filter((w) => !happensBefore(w.stamp, { ...side.stamp, basis: side.basis }));
  kept.push(side);
  kept.sort((a, b) => compareStamps(a.stamp, b.stamp));
  return kept.length > MAX_CONCURRENT_WRITES ? kept.slice(kept.length - MAX_CONCURRENT_WRITES) : kept;
}

/** Applies one operation in place. Idempotent, and independent of call order. */
export function applyOperation(state: FoldState, op: Operation): FoldState {
  const key = entityKey(op.entityKind, op.entityId);
  const stamp = stampOf(op);
  state.lamport = Math.max(state.lamport, op.lamport);

  let entity = state.entities[key];
  if (!entity) {
    entity = {
      kind: op.entityKind,
      id: op.entityId,
      notebookId: op.notebookId,
      notebookStamp: stamp,
      fields: {},
      deleted: null,
    };
    state.entities[key] = entity;
  } else if (compareStamps(stamp, entity.notebookStamp) < 0) {
    // The earliest operation decides which notebook an entity belongs to, so
    // late-arriving creates cannot move an entity between notebooks.
    entity.notebookId = op.notebookId;
    entity.notebookStamp = stamp;
  }

  if (op.kind === 'delete') {
    const side = sideOf(op, null);
    if (!entity.deleted || compareStamps(side.stamp, entity.deleted.stamp) > 0) entity.deleted = side;
    return state;
  }

  for (const [field, value] of Object.entries(op.fields)) {
    const current = entity.fields[field] ?? { writes: [] };
    entity.fields[field] = { writes: mergeWrite(current.writes, sideOf(op, value)) };
  }
  return state;
}

/** Folds operations into `base` (or a fresh state), returning the new state. */
export function foldOperations(ops: readonly Operation[], base?: FoldState): FoldState {
  const state = base ?? emptyState();
  for (const op of sortOperations(dedupeOperations(ops))) applyOperation(state, op);
  return state;
}

function winnerOf(field: FieldState): Side {
  return field.writes.reduce((best, side) => (compareStamps(side.stamp, best.stamp) > 0 ? side : best));
}

function toConflictSide(side: Side): ConflictSide {
  return { opId: side.opId, stamp: side.stamp, value: side.value as never };
}

function conflictId(kind: SyncedKind, id: string, field: string): string {
  return hashJson([kind, id, field]).slice(0, 32);
}

/**
 * Projects fold state into validated entities, tombstones and conflicts.
 * Nothing here reads a clock, so two replicas with the same operations
 * produce byte-identical output.
 */
export function materialize(state: FoldState): Materialized {
  const entities: MaterializedEntity[] = [];
  const tombstones: Tombstone[] = [];
  const conflicts: Conflict[] = [];
  const invalid: Materialized['invalid'] = [];

  const keys = Object.keys(state.entities).sort();
  for (const key of keys) {
    const entity = state.entities[key]!;
    const fieldNames = Object.keys(entity.fields).sort();
    const winners = new Map<string, Side>();
    for (const name of fieldNames) {
      const field = entity.fields[name]!;
      if (field.writes.length === 0) continue;
      winners.set(name, winnerOf(field));
    }

    const highest = [...winners.values()].reduce<Side | null>(
      (best, side) => (best === null || compareStamps(side.stamp, best.stamp) > 0 ? side : best),
      null,
    );
    const deleted = entity.deleted;
    const live = highest !== null && (deleted === null || compareStamps(highest.stamp, deleted.stamp) > 0);

    for (const name of fieldNames) {
      const field = entity.fields[name]!;
      const winner = winners.get(name);
      if (!winner || field.writes.length < 2) continue;
      const losers = field.writes.filter((side) => side.opId !== winner.opId && !jsonEquals(side.value, winner.value));
      if (losers.length === 0) continue;
      conflicts.push({
        schemaVersion: SCHEMA_VERSION,
        id: conflictId(entity.kind, entity.id, name),
        entityKind: entity.kind,
        entityId: entity.id,
        field: name,
        winner: toConflictSide(winner),
        losers: losers.map(toConflictSide),
        detectedAt: Math.max(winner.at, ...losers.map((side) => side.at)),
      });
    }

    if (live && deleted && highest && isConcurrentSides(highest, deleted)) {
      conflicts.push({
        schemaVersion: SCHEMA_VERSION,
        id: conflictId(entity.kind, entity.id, DELETED_FIELD),
        entityKind: entity.kind,
        entityId: entity.id,
        field: DELETED_FIELD,
        winner: toConflictSide(highest),
        losers: [toConflictSide(deleted)],
        detectedAt: Math.max(highest.at, deleted.at),
      });
    }

    if (!live) {
      if (deleted) {
        tombstones.push({
          schemaVersion: SCHEMA_VERSION,
          entityKind: entity.kind,
          entityId: entity.id,
          notebookId: entity.notebookId,
          stamp: deleted.stamp,
          deletedAt: deleted.at,
        });
      }
      continue;
    }

    const record: Record<string, unknown> = { schemaVersion: SCHEMA_VERSION, id: entity.id };
    for (const [name, side] of winners) record[name] = side.value;
    if (entity.kind !== 'notebook') record['notebookId'] = entity.notebookId;

    const result = validate(record, schemaFor(entity.kind));
    if (!result.valid) {
      invalid.push({ kind: entity.kind, id: entity.id, issues: result.issues });
      continue;
    }
    entities.push({ kind: entity.kind, id: entity.id, notebookId: entity.notebookId, record });
  }

  const order = (kind: SyncedKind): number => SYNCED_KINDS.indexOf(kind);
  entities.sort((a, b) => order(a.kind) - order(b.kind) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  tombstones.sort(
    (a, b) => order(a.entityKind) - order(b.entityKind) || (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0),
  );
  conflicts.sort((a, b) => (canonicalize([a.entityKind, a.entityId, a.field]) < canonicalize([b.entityKind, b.entityId, b.field]) ? -1 : 1));
  return { entities, tombstones, conflicts, invalid };
}

function isConcurrentSides(a: Side, b: Side): boolean {
  return (
    !happensBefore(a.stamp, { ...b.stamp, basis: b.basis }) && !happensBefore(b.stamp, { ...a.stamp, basis: a.basis })
  );
}

/**
 * Reconnect reconciliation: fold what we already had together with whatever
 * the peer sends, from either direction, and get the same answer.
 */
export function reconcile(base: FoldState, incoming: readonly Operation[]): FoldState {
  return foldOperations(incoming, base);
}

export function cloneState(state: FoldState): FoldState {
  return JSON.parse(canonicalize(state)) as FoldState;
}

/** Stable digest of reconciled state; equal digests mean converged replicas. */
export function stateDigest(state: FoldState): string {
  const view = materialize(state);
  return hashJson([view.entities, view.tombstones, view.conflicts]);
}
