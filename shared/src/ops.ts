/**
 * Operation identity, ordering and causality.
 *
 * Ordering is the total order (lamport, actor, seq); causality is decided by
 * `basis`, the highest lamport an actor had seen when it produced the
 * operation. Two operations neither of which saw the other are concurrent, and
 * concurrency is what turns a plain overwrite into a recorded conflict.
 */

import { canonicalize } from './json.js';
import { hashJson } from './hash.js';
import { assertValid } from './validate.js';
import { operationSchema } from './schema.js';
import { SCHEMA_VERSION, type Operation, type Stamp, type SyncedKind } from './model.js';

export class ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractError';
  }
}

export function stampOf(op: Operation): Stamp {
  return { lamport: op.lamport, actor: op.actor, seq: op.seq };
}

export function compareStamps(a: Stamp, b: Stamp): number {
  if (a.lamport !== b.lamport) return a.lamport - b.lamport;
  if (a.actor !== b.actor) return a.actor < b.actor ? -1 : 1;
  return a.seq - b.seq;
}

export function stampKey(stamp: Stamp): string {
  return `${stamp.lamport}:${stamp.actor}:${stamp.seq}`;
}

/** True when `b` was produced with knowledge of `a`. */
export function happensBefore(a: Stamp, b: Stamp & { basis: number }): boolean {
  if (a.actor === b.actor) return a.seq < b.seq;
  return a.lamport <= b.basis;
}

export interface Causal {
  stamp: Stamp;
  basis: number;
}

export function isConcurrent(a: Causal, b: Causal): boolean {
  return (
    !happensBefore(a.stamp, { ...b.stamp, basis: b.basis }) &&
    !happensBefore(b.stamp, { ...a.stamp, basis: a.basis })
  );
}

export function sortOperations(ops: readonly Operation[]): Operation[] {
  return [...ops].sort((a, b) => compareStamps(stampOf(a), stampOf(b)) || (a.opId < b.opId ? -1 : a.opId > b.opId ? 1 : 0));
}

/**
 * Drop replays of the same operation. An identical replay is normal (a client
 * resends after a dropped ack); the same id carrying different bytes is
 * corruption and is refused rather than merged.
 */
export function dedupeOperations(ops: readonly Operation[]): Operation[] {
  const seen = new Map<string, string>();
  const out: Operation[] = [];
  for (const op of ops) {
    const bytes = canonicalize(op);
    const previous = seen.get(op.opId);
    if (previous === undefined) {
      seen.set(op.opId, bytes);
      out.push(op);
    } else if (previous !== bytes) {
      throw new ContractError(`operation ${op.opId} replayed with different content`);
    }
  }
  return out;
}

export function validateOperation(value: unknown): Operation {
  const op = assertValid<Operation>(value, operationSchema, 'operation');
  if (op.kind === 'set' && Object.keys(op.fields).length === 0) {
    throw new ContractError(`operation ${op.opId} sets no fields`);
  }
  if (op.kind === 'delete' && Object.keys(op.fields).length > 0) {
    throw new ContractError(`delete operation ${op.opId} must not carry fields`);
  }
  if (op.basis > op.lamport) {
    throw new ContractError(`operation ${op.opId} has basis ahead of its lamport`);
  }
  return op;
}

export interface NewOperationInput {
  entityKind: SyncedKind;
  entityId: string;
  notebookId: string;
  kind?: 'set' | 'delete';
  fields?: Record<string, unknown>;
  actor: string;
  lamport: number;
  seq: number;
  basis?: number;
  at: number;
}

/**
 * Builds an operation whose id is the hash of its own content, so a retried
 * build produces the same id and deduplicates instead of duplicating.
 */
export function createOperation(input: NewOperationInput): Operation {
  const kind = input.kind ?? 'set';
  const body = {
    schemaVersion: SCHEMA_VERSION,
    entityKind: input.entityKind,
    entityId: input.entityId,
    notebookId: input.notebookId,
    kind,
    fields: kind === 'delete' ? {} : (input.fields ?? {}),
    actor: input.actor,
    lamport: input.lamport,
    seq: input.seq,
    basis: input.basis ?? Math.max(0, input.lamport - 1),
    at: input.at,
  };
  return validateOperation({ ...body, opId: hashJson(body).slice(0, 32) });
}
