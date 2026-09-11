import type { LocalState } from './types.js';

const DB = 'smartnotes-web-v1'; const STORE = 'state'; const KEY = 'current';
function fresh(): LocalState { return { session: null, deviceId: crypto.randomUUID(), activeNotebookId: null, replica: null, outbox: [] }; }

export class LocalDatabase {
  private constructor(private readonly db: IDBDatabase) {}
  static async open(): Promise<LocalDatabase> {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    const db = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    return new LocalDatabase(db);
  }
  async read(): Promise<LocalState> {
    const saved = await this.get<LocalState>(KEY);
    if (!saved) return fresh();
    // Keep pre-annotation replicas readable after a production update.
    return { ...fresh(), ...saved, replica: saved.replica ? { ...saved.replica, annotations: saved.replica.annotations ?? [] } : null };
  }
  async write(state: LocalState): Promise<void> { await this.put(KEY, state); }
  private async get<T>(key: string): Promise<T | undefined> { return this.run('readonly', store => store.get(key)); }
  private async put(key: string, value: unknown): Promise<void> { await this.run('readwrite', store => store.put(value, key)); }
  private run<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE, mode);
      const request = operation(tx.objectStore(STORE));
      // A successful put can still roll back on reload before the transaction
      // commits. Acknowledge local storage only after that commit.
      tx.oncomplete = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('Local note storage was interrupted.'));
    });
  }
}
