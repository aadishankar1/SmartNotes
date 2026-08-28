import { SCHEMA_VERSION, createOperation, type Operation, type SyncedKind } from '../../shared/src/index.js';
import { Api } from './api.js';
import { LocalDatabase } from './db.js';
import type { LocalState, Replica } from './types.js';

export class SyncEngine {
  private state!: LocalState;
  private conflicts: string[] = [];
  constructor(private readonly db: LocalDatabase, private readonly api: Api) {}
  async load(): Promise<LocalState> { this.state = await this.db.read(); return this.state; }
  snapshot(): LocalState { return this.state; }
  conflictMessages(): readonly string[] { return this.conflicts; }
  async save(): Promise<void> { await this.db.write(this.state); }
  async chooseNotebook(id: string): Promise<void> {
    const view = await this.api.viewNotebook(id);
    const annotations = (await Promise.all(view.pdfs.map(async pdf => (await this.api.annotations(pdf.id)).annotations))).flat();
    this.state.activeNotebookId = id;
    this.state.replica = { ...view, annotations, lamport: Math.max(this.state.replica?.lamport ?? 0, view.cursor) };
    await this.save();
  }
  async addNotebook(title: string): Promise<void> { const created = await this.api.createNotebook(title); await this.chooseNotebook(created.notebook.id); }
  queue(kind: SyncedKind, entityId: string, fields: Record<string, unknown>, deleted = false): Operation {
    const replica = this.requireReplica(); const lamport = Math.max(replica.lamport, replica.cursor) + 1;
    const op = createOperation({ entityKind: kind, entityId, notebookId: replica.notebook.id, kind: deleted ? 'delete' : 'set', fields, actor: this.state.deviceId, lamport, seq: lamport, basis: Math.max(0, lamport - 1), at: Date.now() });
    replica.lamport = lamport; this.state.outbox.push(op); this.applyLocal(op); void this.save(); return op;
  }
  async sync(): Promise<void> {
    const replica = this.requireReplica();
    if (!navigator.onLine) throw new Error('You are offline. Changes are safely queued on this device.');
    // Only ship ops for the active notebook: the server rejects cross-notebook
    // ops, and dropping queued ops for another notebook would lose edits.
    const ops = this.state.outbox.filter(op => op.notebookId === replica.notebook.id);
    const response = await this.api.request<{ cursor:number; accepted:string[]; rejected:Array<{opId:string;reason:string}>; conflicts:Array<{field:string;entityId:string}> }>('/v1/sync', 'POST', { schemaVersion: SCHEMA_VERSION, deviceId: this.state.deviceId, notebookId: replica.notebook.id, cursor: replica.cursor, ops });
    const rejected = new Map(response.rejected.map(item => [item.opId, item.reason]));
    this.conflicts = [...response.conflicts.map(c => `Another device changed ${c.field} on ${c.entityId}. Your local change remains available to retry.`), ...response.rejected.map(r => `A queued change was rejected: ${r.reason}`)];
    this.state.outbox = this.state.outbox.filter(op => op.notebookId !== replica.notebook.id || rejected.has(op.opId));
    const view = await this.api.viewNotebook(replica.notebook.id);
    const annotations = (await Promise.all(view.pdfs.map(async pdf => (await this.api.annotations(pdf.id)).annotations))).flat();
    this.state.replica = { ...view, annotations, lamport: Math.max(replica.lamport, response.cursor) };
    await this.save();
  }
  private requireReplica(): Replica { if (!this.state.replica) throw new Error('Choose a notebook first.'); return this.state.replica; }
  private applyLocal(op: Operation): void {
    const replica = this.requireReplica();
    if (op.entityKind === 'note') {
      const index = replica.notes.findIndex(note => note.id === op.entityId);
      if (op.kind === 'delete') { if (index >= 0) replica.notes.splice(index, 1); return; }
      const existing = index >= 0 ? replica.notes[index]! : { schemaVersion: SCHEMA_VERSION, id: op.entityId, notebookId: op.notebookId, title: '', body: '', position: Date.now(), createdAt: op.at, updatedAt: op.at };
      const next = { ...existing, ...op.fields } as typeof existing; if (index >= 0) replica.notes[index] = next; else replica.notes.push(next);
    }
    if (op.entityKind === 'notebook' && op.entityId === replica.notebook.id && op.kind === 'set') replica.notebook = { ...replica.notebook, ...op.fields } as Replica['notebook'];
    if (op.entityKind === 'annotation') {
      const index = replica.annotations.findIndex(annotation => annotation.id === op.entityId);
      if (op.kind === 'delete') { if (index >= 0) replica.annotations.splice(index, 1); return; }
      const existing = index >= 0 ? replica.annotations[index]! : { schemaVersion: SCHEMA_VERSION, id: op.entityId, notebookId: op.notebookId, pdfId: '', page: 0, kind: 'note' as const, rect: null, color: '#ffd60a', text: null, strokeId: null, createdAt: op.at, updatedAt: op.at };
      const next = { ...existing, ...op.fields } as typeof existing;
      if (index >= 0) replica.annotations[index] = next; else replica.annotations.push(next);
    }
  }
}
