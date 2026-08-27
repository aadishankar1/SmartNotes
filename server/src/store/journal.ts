/**
 * Durable local storage: an append-only journal plus periodic snapshots.
 *
 * Every committed transaction is one CRC-checked line appended to
 * `journal.log` and fsynced before the in-memory tables are updated, so a
 * process that survives to see a write has that write on disk. Recovery reads
 * `snapshot.json` and replays the journal, stopping at the first torn line and
 * truncating it — a half-written tail from a crash is discarded, never
 * half-applied. Journal entries are absolute puts and deletes keyed by id, so
 * replaying a snapshotted prefix is idempotent.
 *
 * Why not SQLite: this server must run with zero installed dependencies, and
 * the Node runtime it targets (20.x) has no built-in SQLite binding — see
 * server/README.md. The durability contract implemented here is the one the
 * rest of the server relies on: atomic multi-table transactions, fsync before
 * acknowledgement, and crash-consistent restart.
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, truncateSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalize, type JsonObject } from '../../../shared/src/index.js';

export const JOURNAL_FORMAT = 1;

export interface StoreOptions {
  dir: string;
  /** Compact into a snapshot once the journal passes this size. */
  compactAfterBytes?: number;
  /** Disable fsync only in throwaway tests that do not assert durability. */
  fsync?: boolean;
}

export interface StoreStats {
  path: string;
  records: number;
  journalBytes: number;
  tables: Record<string, number>;
  commits: number;
  compactions: number;
}

interface Mutation {
  table: string;
  key: string;
  record: JsonObject | null;
}

export class StoreError extends Error {}

function crc32(text: string): number {
  let crc = 0xffffffff;
  const bytes = Buffer.from(text, 'utf8');
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A transaction handle. Mutations are visible only after a clean commit. */
export class Transaction {
  private readonly mutations: Mutation[] = [];

  constructor(private readonly store: JournalStore) {}

  get(table: string, key: string): JsonObject | undefined {
    const staged = this.mutations.filter((m) => m.table === table && m.key === key).at(-1);
    if (staged) return staged.record ?? undefined;
    return this.store.get(table, key);
  }

  put(table: string, record: JsonObject): void {
    const key = record['id'];
    if (typeof key !== 'string' || key.length === 0) throw new StoreError(`record in ${table} needs a string id`);
    this.mutations.push({ table, key, record: JSON.parse(canonicalize(record)) as JsonObject });
  }

  delete(table: string, key: string): void {
    this.mutations.push({ table, key, record: null });
  }

  /** @internal */
  drain(): Mutation[] {
    return this.mutations;
  }
}

export class JournalStore {
  private readonly tables = new Map<string, Map<string, JsonObject>>();
  private readonly journalPath: string;
  private readonly snapshotPath: string;
  private readonly compactAfterBytes: number;
  private readonly durable: boolean;
  private fd: number | null = null;
  private journalBytes = 0;
  private inTransaction = false;
  private commits = 0;
  private compactions = 0;

  private constructor(readonly dir: string, options: StoreOptions) {
    this.journalPath = join(dir, 'journal.log');
    this.snapshotPath = join(dir, 'snapshot.json');
    this.compactAfterBytes = options.compactAfterBytes ?? 1024 * 1024;
    this.durable = options.fsync !== false;
  }

  static open(options: StoreOptions): JournalStore {
    const store = new JournalStore(options.dir, options);
    mkdirSync(options.dir, { recursive: true });
    mkdirSync(join(options.dir, 'blobs'), { recursive: true });
    store.recover();
    store.fd = openSync(store.journalPath, 'a');
    return store;
  }

  private recover(): void {
    if (existsSync(this.snapshotPath)) {
      const snapshot = JSON.parse(readFileSync(this.snapshotPath, 'utf8')) as {
        format: number;
        tables: Record<string, Record<string, JsonObject>>;
      };
      if (snapshot.format !== JOURNAL_FORMAT) throw new StoreError(`unsupported snapshot format ${snapshot.format}`);
      for (const [table, rows] of Object.entries(snapshot.tables)) {
        this.tableOf(table);
        for (const [key, record] of Object.entries(rows)) this.tableOf(table).set(key, record);
      }
    }

    if (!existsSync(this.journalPath)) return;
    const raw = readFileSync(this.journalPath, 'utf8');
    let consumed = 0;
    for (const line of raw.split('\n')) {
      if (line.length === 0) {
        consumed += 1;
        continue;
      }
      const entry = this.parseLine(line);
      if (!entry) break; // torn tail: everything after this is unusable
      for (const mutation of entry) this.applyMutation(mutation);
      consumed += line.length + 1;
    }
    if (consumed < raw.length) truncateSync(this.journalPath, consumed);
    this.journalBytes = consumed;
  }

  private parseLine(line: string): Mutation[] | null {
    try {
      const parsed = JSON.parse(line) as { f: number; crc: number; m: Mutation[] };
      if (parsed.f !== JOURNAL_FORMAT) return null;
      const body = canonicalize(parsed.m as never);
      if (crc32(body) !== parsed.crc) return null;
      return parsed.m;
    } catch {
      return null;
    }
  }

  private applyMutation(mutation: Mutation): void {
    const table = this.tableOf(mutation.table);
    if (mutation.record === null) table.delete(mutation.key);
    else table.set(mutation.key, mutation.record);
  }

  private tableOf(name: string): Map<string, JsonObject> {
    let table = this.tables.get(name);
    if (!table) {
      table = new Map();
      this.tables.set(name, table);
    }
    return table;
  }

  get(table: string, key: string): JsonObject | undefined {
    return this.tables.get(table)?.get(key);
  }

  all(table: string): JsonObject[] {
    return [...(this.tables.get(table)?.values() ?? [])];
  }

  find(table: string, predicate: (record: JsonObject) => boolean): JsonObject[] {
    return this.all(table).filter(predicate);
  }

  first(table: string, predicate: (record: JsonObject) => boolean): JsonObject | undefined {
    return this.all(table).find(predicate);
  }

  /**
   * Runs `fn` and commits its mutations atomically. A throw discards every
   * mutation, including ones already staged, and leaves the journal untouched.
   */
  transaction<T>(fn: (tx: Transaction) => T): T {
    if (this.inTransaction) throw new StoreError('nested transactions are not supported');
    if (this.fd === null) throw new StoreError('store is closed');
    this.inTransaction = true;
    const tx = new Transaction(this);
    try {
      const result = fn(tx);
      const mutations = tx.drain();
      if (mutations.length > 0) {
        this.commit(mutations);
        for (const mutation of mutations) this.applyMutation(mutation);
        if (this.journalBytes >= this.compactAfterBytes) this.compact();
      }
      return result;
    } finally {
      this.inTransaction = false;
    }
  }

  private commit(mutations: Mutation[]): void {
    const body = canonicalize(mutations as never);
    const line = `${JSON.stringify({ f: JOURNAL_FORMAT, crc: crc32(body), m: mutations })}\n`;
    const buffer = Buffer.from(line, 'utf8');
    writeSync(this.fd!, buffer);
    if (this.durable) fsyncSync(this.fd!);
    this.journalBytes += buffer.byteLength;
    this.commits += 1;
  }

  /** Folds the journal into a snapshot and truncates it. Crash-safe by ordering. */
  compact(): void {
    const tables: Record<string, Record<string, JsonObject>> = {};
    for (const [name, rows] of this.tables) tables[name] = Object.fromEntries(rows);
    const tmp = `${this.snapshotPath}.tmp`;
    writeFileSync(tmp, JSON.stringify({ format: JOURNAL_FORMAT, tables }), 'utf8');
    if (this.durable) {
      const fd = openSync(tmp, 'r+');
      fsyncSync(fd);
      closeSync(fd);
    }
    renameSync(tmp, this.snapshotPath);
    if (this.fd !== null) closeSync(this.fd);
    truncateSync(this.journalPath, 0);
    this.fd = openSync(this.journalPath, 'a');
    this.journalBytes = 0;
    this.compactions += 1;
  }

  stats(): StoreStats {
    const tables: Record<string, number> = {};
    let records = 0;
    for (const [name, rows] of this.tables) {
      tables[name] = rows.size;
      records += rows.size;
    }
    const journalBytes = existsSync(this.journalPath) ? statSync(this.journalPath).size : 0;
    return { path: this.dir, records, journalBytes, tables, commits: this.commits, compactions: this.compactions };
  }

  blobPath(sha256: string): string {
    return join(this.dir, 'blobs', sha256);
  }

  close(): void {
    if (this.fd !== null) {
      fsyncSync(this.fd);
      closeSync(this.fd);
      this.fd = null;
    }
  }
}
