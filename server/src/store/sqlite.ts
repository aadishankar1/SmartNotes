/**
 * Durable persistence: SQLite, through the `node:sqlite` binding that ships
 * with the runtime (Node 22.5+), so there is still nothing to install.
 *
 * Every table is a real SQLite table of `(id, doc)` where `doc` is the record
 * in canonical JSON, plus a generated column for each field the server looks
 * entities up by. Generated columns are derived from `doc` by SQLite itself, so
 * an index can never drift from the document it indexes, and lookups such as
 * "the user with this email" or "the notebooks owned by this account" are
 * indexed reads rather than scans.
 *
 * Durability contract relied on by the rest of the server:
 *   - `transaction` wraps its body in BEGIN IMMEDIATE … COMMIT, so a multi-row
 *     write lands whole or not at all and a throw rolls the whole thing back;
 *   - with `synchronous = FULL` (the default here) a commit is fsynced before
 *     it is acknowledged, so a write the caller has seen survives a crash;
 *   - reopening the same directory replays the write-ahead log automatically.
 */

import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { canonicalize, type JsonObject } from '../../../shared/src/index.js';
import { TABLE_INDEXES } from './tables.js';

/** Bumped when the physical layout changes; guards against older code opening a newer file. */
export const SCHEMA_USER_VERSION = 1;

export const DATABASE_FILE = 'smartnotes.db';

export interface StoreOptions {
  dir: string;
  /** Disable per-commit fsync. Only for throwaway tests that assert nothing about durability. */
  fsync?: boolean;
}

export interface StoreStats {
  path: string;
  engine: 'sqlite';
  schemaVersion: number;
  records: number;
  byteSize: number;
  tables: Record<string, number>;
  commits: number;
}

export class StoreError extends Error {}

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Table and column names come from code, but they still reach SQL as text. */
function quoteIdentifier(name: string): string {
  if (!IDENTIFIER.test(name)) throw new StoreError(`unsafe SQL identifier: ${name}`);
  return `"${name}"`;
}

/**
 * A transaction handle. Writes are applied to the open SQLite transaction as
 * they are made — and are therefore visible to reads on this store — but stay
 * invisible to anything else until the surrounding `transaction` commits.
 */
export class Transaction {
  constructor(private readonly store: SqliteStore) {}

  get(table: string, key: string): JsonObject | undefined {
    return this.store.get(table, key);
  }

  put(table: string, record: JsonObject): void {
    this.store.writeRecord(table, record);
  }

  delete(table: string, key: string): void {
    this.store.deleteRecord(table, key);
  }
}

export class SqliteStore {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private readonly tables = new Set<string>();
  private readonly path: string;
  private inTransaction = false;
  private closed = false;
  private commits = 0;

  private constructor(
    readonly dir: string,
    options: StoreOptions,
  ) {
    this.path = join(dir, DATABASE_FILE);
    this.db = new DatabaseSync(this.path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`PRAGMA synchronous = ${options.fsync === false ? 'OFF' : 'FULL'}`);
    this.db.exec('PRAGMA foreign_keys = ON');
    this.migrate();
    this.syncTables();
  }

  /** Rebuilds the known-table set from the database, discarding stale statements. */
  private syncTables(): void {
    this.tables.clear();
    this.statements.clear();
    for (const row of this.db.prepare(`SELECT name FROM sqlite_schema WHERE type = 'table'`).all()) {
      this.tables.add(String(row['name']));
    }
  }

  static open(options: StoreOptions): SqliteStore {
    mkdirSync(options.dir, { recursive: true });
    mkdirSync(join(options.dir, 'blobs'), { recursive: true });
    return new SqliteStore(options.dir, options);
  }

  private migrate(): void {
    const found = Number(this.db.prepare('PRAGMA user_version').get()?.['user_version'] ?? 0);
    if (found > SCHEMA_USER_VERSION) {
      throw new StoreError(`database schema ${found} is newer than this build understands (${SCHEMA_USER_VERSION})`);
    }
    // Version 1 is the initial layout: every declared table, created eagerly so
    // a fresh database is queryable before the first write.
    for (const table of Object.keys(TABLE_INDEXES)) this.createTable(table);
    if (found !== SCHEMA_USER_VERSION) this.db.exec(`PRAGMA user_version = ${SCHEMA_USER_VERSION}`);
  }

  /** Creates a table and its indexes. Tables not declared in tables.ts get no indexes. */
  private createTable(table: string): void {
    const name = quoteIdentifier(table);
    const indexes = TABLE_INDEXES[table] ?? {};
    const generated = Object.keys(indexes).map(
      (column) => `,\n  ${quoteIdentifier(column)} TEXT GENERATED ALWAYS AS (json_extract(doc, '$.${column}')) VIRTUAL`,
    );
    this.db.exec(`CREATE TABLE IF NOT EXISTS ${name} (\n  id TEXT PRIMARY KEY NOT NULL,\n  doc TEXT NOT NULL${generated.join('')}\n)`);
    for (const [column, kind] of Object.entries(indexes)) {
      const unique = kind === 'unique' ? 'UNIQUE ' : '';
      this.db.exec(`CREATE ${unique}INDEX IF NOT EXISTS ${quoteIdentifier(`${table}_${column}`)} ON ${name} (${quoteIdentifier(column)})`);
    }
    this.tables.add(table);
  }

  private statement(sql: string): StatementSync {
    let prepared = this.statements.get(sql);
    if (!prepared) {
      prepared = this.db.prepare(sql);
      this.statements.set(sql, prepared);
    }
    return prepared;
  }

  private parse(row: Record<string, unknown> | undefined): JsonObject | undefined {
    if (!row) return undefined;
    return JSON.parse(String(row['doc'])) as JsonObject;
  }

  get(table: string, key: string): JsonObject | undefined {
    if (!this.tables.has(table)) return undefined;
    return this.parse(this.statement(`SELECT doc FROM ${quoteIdentifier(table)} WHERE id = ?`).get(key));
  }

  /** Every read is ordered by id, so two replicas of the same rows list them identically. */
  all(table: string): JsonObject[] {
    if (!this.tables.has(table)) return [];
    return this.statement(`SELECT doc FROM ${quoteIdentifier(table)} ORDER BY id`)
      .all()
      .map((row) => this.parse(row)!);
  }

  /**
   * Indexed lookup by one of the columns declared for the table. Undeclared
   * columns are refused rather than silently turned into a table scan.
   */
  findBy(table: string, column: string, value: string): JsonObject[] {
    const indexes = TABLE_INDEXES[table];
    if (!indexes || !(column in indexes)) throw new StoreError(`${table}.${column} is not an indexed column`);
    if (!this.tables.has(table)) return [];
    return this.statement(`SELECT doc FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(column)} = ? ORDER BY id`)
      .all(value)
      .map((row) => this.parse(row)!);
  }

  firstBy(table: string, column: string, value: string): JsonObject | undefined {
    return this.findBy(table, column, value)[0];
  }

  count(table: string): number {
    if (!this.tables.has(table)) return 0;
    return Number(this.statement(`SELECT count(*) AS n FROM ${quoteIdentifier(table)}`).get()?.['n'] ?? 0);
  }

  /**
   * Runs `fn` inside one SQLite transaction. A throw rolls back every write it
   * made, including ones already applied, and rethrows.
   */
  transaction<T>(fn: (tx: Transaction) => T): T {
    if (this.closed) throw new StoreError('store is closed');
    if (this.inTransaction) throw new StoreError('nested transactions are not supported');
    this.db.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    try {
      const result = fn(new Transaction(this));
      this.db.exec('COMMIT');
      this.commits += 1;
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      // CREATE TABLE rolls back with everything else, so the table set this
      // store believes in has to be rebuilt from what actually survived.
      this.syncTables();
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  /** @internal — reached through {@link Transaction}, so every write is in a transaction. */
  writeRecord(table: string, record: JsonObject): void {
    this.requireTransaction();
    const key = record['id'];
    if (typeof key !== 'string' || key.length === 0) throw new StoreError(`record in ${table} needs a string id`);
    if (!this.tables.has(table)) this.createTable(table);
    const name = quoteIdentifier(table);
    this.statement(`INSERT INTO ${name} (id, doc) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET doc = excluded.doc`).run(
      key,
      canonicalize(record),
    );
  }

  /** @internal */
  deleteRecord(table: string, key: string): void {
    this.requireTransaction();
    if (!this.tables.has(table)) return;
    this.statement(`DELETE FROM ${quoteIdentifier(table)} WHERE id = ?`).run(key);
  }

  private requireTransaction(): void {
    if (!this.inTransaction) throw new StoreError('writes must happen inside store.transaction()');
  }

  stats(): StoreStats {
    const tables: Record<string, number> = {};
    let records = 0;
    for (const table of [...this.tables].sort()) {
      const rows = this.count(table);
      tables[table] = rows;
      records += rows;
    }
    let byteSize = 0;
    for (const suffix of ['', '-wal', '-shm']) {
      const file = `${this.path}${suffix}`;
      if (existsSync(file)) byteSize += statSync(file).size;
    }
    return { path: this.dir, engine: 'sqlite', schemaVersion: SCHEMA_USER_VERSION, records, byteSize, tables, commits: this.commits };
  }

  /** PDF bytes live beside the database, addressed by their SHA-256. */
  blobPath(sha256: string): string {
    return join(this.dir, 'blobs', sha256);
  }

  /** Path to the database file itself; tests and operators read it directly. */
  databasePath(): string {
    return this.path;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.statements.clear();
    this.db.close();
  }
}
