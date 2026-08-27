/** Shared harness: a real app on a scratch data directory, driven in process. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type App, type AppOptions, type RequestInput } from '../src/app.js';
import type { ApiResponse } from '../src/http.js';

export interface Harness {
  app: App;
  dir: string;
  /** Closes and reopens the app on the same directory, as a restart would. */
  restart(): Harness;
  cleanup(): void;
}

export function harness(options: Partial<AppOptions> = {}): Harness {
  const dir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'smartnotes-test-'));
  const open = (): App => createApp({ ...options, dataDir: dir });
  let app = open();
  const self: Harness = {
    get app() {
      return app;
    },
    dir,
    restart() {
      app.close();
      app = open();
      return self;
    },
    cleanup() {
      app.close();
      if (!options.dataDir) rmSync(dir, { recursive: true, force: true });
    },
  };
  return self;
}

export interface CallOptions {
  token?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export async function call(app: App, method: string, path: string, options: CallOptions = {}): Promise<ApiResponse> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.token) headers['authorization'] = `Bearer ${options.token}`;
  const request: RequestInput = { method, path, headers, body: options.body };
  return app.handle(request);
}

export function body<T = Record<string, unknown>>(response: ApiResponse): T {
  return response.body as T;
}

export function errorCode(response: ApiResponse): string {
  return (response.body as { error?: { code?: string } })?.error?.code ?? '';
}

export interface Account {
  token: string;
  userId: string;
  email: string;
}

export async function signup(app: App, email: string, password = 'correct horse battery'): Promise<Account> {
  const response = await call(app, 'POST', '/v1/auth/signup', { body: { email, password } });
  if (response.status !== 201) throw new Error(`signup failed: ${JSON.stringify(response.body)}`);
  const payload = body<{ token: string; user: { id: string } }>(response);
  return { token: payload.token, userId: payload.user.id, email };
}

export async function createNotebook(app: App, token: string, title = 'Field notes'): Promise<string> {
  const response = await call(app, 'POST', '/v1/notebooks', { token, body: { title } });
  if (response.status !== 201) throw new Error(`notebook create failed: ${JSON.stringify(response.body)}`);
  return body<{ notebook: { id: string } }>(response).notebook.id;
}

/** A minimal well-formed PDF, small enough to embed in a test. */
export function samplePdf(pages = 2): Buffer {
  const objects = Array.from({ length: pages }, (_, i) => `${i + 3} 0 obj\n<< /Type /Page >>\nendobj\n`).join('');
  return Buffer.from(`%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n${objects}trailer\n<< /Root 1 0 R >>\n%%EOF\n`, 'latin1');
}
