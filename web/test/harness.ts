/**
 * Browser-shim harness: runs the real web modules (Api, LocalDatabase,
 * SyncEngine) in Node against the real in-process server app. The sandbox has
 * no browser and cannot bind sockets, so IndexedDB, fetch and navigator are
 * shimmed here; everything under web/src runs unmodified.
 */

import type { App, RequestInput } from '../../server/src/app.js';

type StoreMap = Map<string, unknown>;

/**
 * One fake browser origin's IndexedDB backing. Opening the same origin again
 * models a page reload: the data survives, a new origin models a second
 * device/browser profile.
 */
export class FakeOrigin {
  readonly databases = new Map<string, Map<string, StoreMap>>();
}

interface FakeIDBRequest {
  result: unknown;
  error: Error | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onupgradeneeded?: (() => void) | null;
}

function settle(request: FakeIDBRequest, result: unknown, upgrade = false): void {
  request.result = result;
  queueMicrotask(() => {
    if (upgrade) request.onupgradeneeded?.();
    request.onsuccess?.();
  });
}

/** Installs a minimal IndexedDB (open/createObjectStore/get/put) over `origin`. */
export function installIndexedDB(origin: FakeOrigin): void {
  const factory = {
    open(name: string): FakeIDBRequest {
      let stores = origin.databases.get(name);
      const isNew = !stores;
      if (!stores) {
        stores = new Map();
        origin.databases.set(name, stores);
      }
      const backing = stores;
      const db = {
        createObjectStore(store: string) {
          if (!backing.has(store)) backing.set(store, new Map());
        },
        transaction(store: string, _mode: string) {
          const tx = {
            onerror: null as (() => void) | null,
            oncomplete: null as (() => void) | null,
            error: null as Error | null,
            objectStore() {
              const data = backing.get(store);
              if (!data) throw new Error(`no object store ${store}`);
              return {
                get(key: string): FakeIDBRequest {
                  const request: FakeIDBRequest = { result: undefined, error: null, onsuccess: null, onerror: null };
                  settle(request, data.has(key) ? structuredClone(data.get(key)) : undefined);
                  queueMicrotask(() => tx.oncomplete?.());
                  return request;
                },
                put(value: unknown, key: string): FakeIDBRequest {
                  const request: FakeIDBRequest = { result: undefined, error: null, onsuccess: null, onerror: null };
                  data.set(key, structuredClone(value));
                  settle(request, key);
                  queueMicrotask(() => tx.oncomplete?.());
                  return request;
                },
              };
            },
          };
          return tx;
        },
      };
      const request: FakeIDBRequest = { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      settle(request, db, isNew);
      return request;
    },
  };
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: factory });
}

export interface Connectivity {
  online: boolean;
}

/** Makes `navigator.onLine` read the shared connectivity flag. */
export function installNavigator(connectivity: Connectivity): void {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { get onLine() { return connectivity.online; } },
  });
}

/** Routes global fetch into app.handle; offline mode fails like a dead network. */
export function installFetch(app: App, connectivity: Connectivity): void {
  const bridged = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    if (!connectivity.online) throw new TypeError('fetch failed: network is offline');
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers as Record<string, string> | undefined) ?? {})) {
      headers[key.toLowerCase()] = String(value);
    }
    const request: RequestInput = {
      method: (init?.method ?? 'GET').toUpperCase(),
      path: String(input),
      headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    const response = await app.handle(request);
    if (response.bytes) {
      return new Response(new Uint8Array(response.bytes), { status: response.status, headers: response.headers });
    }
    return new Response(response.body === undefined ? null : JSON.stringify(response.body), {
      status: response.status,
      headers: { 'content-type': 'application/json', ...(response.headers ?? {}) },
    });
  };
  Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: bridged });
}
