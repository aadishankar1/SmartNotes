/**
 * A bounded, append-only operation log with a folded checkpoint.
 *
 * The log keeps at most `limit` operations. Older operations are folded into a
 * checkpoint and dropped, which bounds memory and disk without losing state:
 * a client whose cursor predates the checkpoint is answered with a snapshot
 * instead of a delta.
 */

import { applyOperation, cloneState, emptyState, type FoldState } from './reconcile.js';
import { sortOperations } from './ops.js';
import type { Operation } from './model.js';

export const DEFAULT_LOG_LIMIT = 512;

export interface LogEntry {
  index: number;
  op: Operation;
}

export interface Checkpoint {
  /** Every operation with index <= this one is folded into `state`. */
  index: number;
  state: FoldState;
}

export interface OperationLogSnapshot {
  limit: number;
  head: number;
  checkpoint: Checkpoint;
  entries: LogEntry[];
}

export interface AppendResult {
  index: number;
  duplicate: boolean;
}

export type SyncDelta =
  | { mode: 'delta'; cursor: number; ops: Operation[] }
  | { mode: 'snapshot'; cursor: number; state: FoldState };

export class OperationLog {
  readonly limit: number;
  private entries: LogEntry[];
  private checkpoint: Checkpoint;
  private headIndex: number;
  private retainedIds: Set<string>;

  constructor(snapshot?: Partial<OperationLogSnapshot>) {
    this.limit = Math.max(1, snapshot?.limit ?? DEFAULT_LOG_LIMIT);
    this.entries = snapshot?.entries ? [...snapshot.entries] : [];
    this.checkpoint = snapshot?.checkpoint ?? { index: 0, state: emptyState() };
    this.headIndex = snapshot?.head ?? (this.entries.at(-1)?.index ?? this.checkpoint.index);
    this.retainedIds = new Set(this.entries.map((entry) => entry.op.opId));
  }

  /** Index of the newest operation; also the cursor a caller is caught up to. */
  get head(): number {
    return this.headIndex;
  }

  /** Cursors at or below this are too old for a delta and need a snapshot. */
  get floor(): number {
    return this.checkpoint.index;
  }

  get size(): number {
    return this.entries.length;
  }

  has(opId: string): boolean {
    return this.retainedIds.has(opId);
  }

  /**
   * Appends unless the operation is already retained. Re-appending an
   * operation already folded into the checkpoint is harmless — the fold is
   * idempotent — but costs an index, so callers should push their cursor.
   */
  append(op: Operation): AppendResult {
    const existing = this.entries.find((entry) => entry.op.opId === op.opId);
    if (existing) return { index: existing.index, duplicate: true };
    this.headIndex += 1;
    this.entries.push({ index: this.headIndex, op });
    this.retainedIds.add(op.opId);
    this.compact();
    return { index: this.headIndex, duplicate: false };
  }

  private compact(): void {
    while (this.entries.length > this.limit) {
      const oldest = this.entries.shift()!;
      this.retainedIds.delete(oldest.op.opId);
      applyOperation(this.checkpoint.state, oldest.op);
      this.checkpoint.index = oldest.index;
    }
  }

  /** Full reconciled state: checkpoint plus everything still retained. */
  state(): FoldState {
    const state = cloneState(this.checkpoint.state);
    for (const op of sortOperations(this.entries.map((entry) => entry.op))) applyOperation(state, op);
    return state;
  }

  opsSince(cursor: number): Operation[] {
    return this.entries.filter((entry) => entry.index > cursor).map((entry) => entry.op);
  }

  /** What a client at `cursor` needs in order to catch up. */
  delta(cursor: number): SyncDelta {
    if (cursor < this.checkpoint.index) {
      return { mode: 'snapshot', cursor: this.headIndex, state: this.state() };
    }
    return { mode: 'delta', cursor: this.headIndex, ops: this.opsSince(cursor) };
  }

  toJSON(): OperationLogSnapshot {
    return { limit: this.limit, head: this.headIndex, checkpoint: this.checkpoint, entries: this.entries };
  }

  static fromJSON(snapshot: OperationLogSnapshot): OperationLog {
    return new OperationLog(snapshot);
  }
}
