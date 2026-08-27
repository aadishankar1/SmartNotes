/**
 * `npm run health`.
 *
 * With SMARTNOTES_URL set it probes a running server over HTTP. Without it,
 * the check runs the real route in-process against a scratch data directory,
 * which exercises the build, the storage engine and the router without needing
 * a listening socket — the only form of health check available in sandboxes
 * that forbid bind(2).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.js';
import type { HealthResponse } from '../../shared/src/index.js';

async function probeHttp(url: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(new URL('/health', url));
  return { status: response.status, body: await response.json() };
}

async function probeInProcess(): Promise<{ status: number; body: unknown }> {
  const dir = mkdtempSync(join(tmpdir(), 'smartnotes-health-'));
  const app = createApp({ dataDir: dir });
  try {
    const response = await app.handle({ method: 'GET', path: '/health' });
    return { status: response.status, body: response.body };
  } finally {
    app.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const url = process.env['SMARTNOTES_URL'];
  const result = url ? await probeHttp(url) : await probeInProcess();
  const body = result.body as HealthResponse;
  process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
  if (result.status !== 200 || body.status !== 'ok') process.exit(1);
}

void main().catch((error: unknown) => {
  process.stderr.write(`health check failed: ${(error as Error).message}\n`);
  process.exit(1);
});
