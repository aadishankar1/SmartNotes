/**
 * PDF documents: bytes on disk addressed by their SHA-256, metadata in the
 * notebook's operation log like any other entity, so a PDF and its annotations
 * synchronise through the same reconciliation rules.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { sha256Hex } from '../../shared/src/index.js';
import { SqliteStore } from './store/sqlite.js';
import { TABLES, asRow, toRecord, type BlobRow, type NotebookRow } from './store/tables.js';
import { ApiError, NotebookService, newId } from './notebooks.js';

/** 25 MiB is enough for a lecture handout and small enough to hold in memory. */
export const MAX_PDF_BYTES = 25 * 1024 * 1024;

const PDF_MAGIC = '%PDF-';

export class PdfService {
  constructor(
    private readonly store: SqliteStore,
    private readonly notebooks: NotebookService,
    private readonly now: () => number,
  ) {}

  /** Counts page objects; a cheap structural read, not a full PDF parse. */
  static countPages(bytes: Buffer): number {
    const matches = bytes.toString('latin1').match(/\/Type\s*\/Page[^s]/g);
    return matches ? matches.length : 0;
  }

  upload(notebook: NotebookRow, filename: string, bytes: Buffer, pageCount?: number): Record<string, unknown> {
    if (bytes.byteLength === 0) throw new ApiError(400, 'empty_pdf', 'the uploaded file is empty');
    if (bytes.byteLength > MAX_PDF_BYTES) throw new ApiError(413, 'pdf_too_large', `PDFs are limited to ${MAX_PDF_BYTES} bytes`);
    if (!bytes.subarray(0, PDF_MAGIC.length).toString('latin1').startsWith(PDF_MAGIC)) {
      throw new ApiError(415, 'not_a_pdf', 'file does not start with a PDF header');
    }

    const digest = sha256Hex(new Uint8Array(bytes));
    const path = this.store.blobPath(digest);
    if (!existsSync(path)) writeFileSync(path, bytes);
    const blob: BlobRow = { id: digest, byteSize: bytes.byteLength, createdAt: this.now() };
    this.store.transaction((tx) => tx.put(TABLES.blobs, toRecord(blob)));

    const id = newId('pdf');
    this.notebooks.commit(notebook, [
      {
        entityKind: 'pdf',
        entityId: id,
        fields: {
          filename,
          byteSize: bytes.byteLength,
          sha256: digest,
          pageCount: pageCount ?? PdfService.countPages(bytes),
          createdAt: this.now(),
        },
      },
    ]);
    const record = this.notebooks.entity(notebook.id, 'pdf', id);
    if (!record) throw new ApiError(500, 'pdf_not_materialized', 'PDF did not materialize after upload');
    return record;
  }

  /** Reads stored bytes back, verifying they still hash to their address. */
  read(record: Record<string, unknown>): Buffer {
    const digest = String(record['sha256']);
    const path = this.store.blobPath(digest);
    if (!existsSync(path)) throw new ApiError(410, 'pdf_content_missing', 'stored PDF content is no longer available');
    const bytes = readFileSync(path);
    if (sha256Hex(new Uint8Array(bytes)) !== digest) {
      throw new ApiError(500, 'pdf_content_corrupt', 'stored PDF content failed its checksum');
    }
    return bytes;
  }

  blob(digest: string): BlobRow | undefined {
    return asRow<BlobRow>(this.store.get(TABLES.blobs, digest));
  }
}
