import type { Annotation, Notebook, Note, Operation, PdfDocument } from '../../shared/src/index.js';
export type { Annotation, Notebook, Note, PdfDocument } from '../../shared/src/index.js';

export interface Session { token: string; email: string; displayName: string; }
export interface Replica {
  notebook: Notebook;
  notes: Note[];
  pdfs: PdfDocument[];
  /** Cached annotations are part of the local replica so reopening works offline. */
  annotations: Annotation[];
  cursor: number;
  lamport: number;
}
export interface LocalState { session: Session | null; deviceId: string; activeNotebookId: string | null; replica: Replica | null; outbox: Operation[]; }
export interface AnnotationView { annotations: Annotation[]; strokes: Array<Record<string, unknown>>; }
