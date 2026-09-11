/** Locating and loading the versioned fixture corpus. */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JsonValue } from '../src/index.js';

/**
 * Fixtures are data files, so they are not copied into the build output; the
 * tests read them from the source tree. SMARTNOTES_ROOT covers out-of-tree
 * builds, otherwise we walk up to the package root.
 */
export function repoRoot(): string {
  const override = process.env['SMARTNOTES_ROOT'];
  if (override) return resolve(override);
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('could not locate the SmartNotes package root');
}

export const FIXTURE_VERSION = 'v1';

export function fixtureDir(): string {
  return join(repoRoot(), 'shared', 'fixtures', FIXTURE_VERSION);
}

export function fixtureNames(): string[] {
  return readdirSync(fixtureDir())
    .filter((name) => name.endsWith('.json') && name !== 'digests.json')
    .map((name) => name.replace(/\.json$/, ''))
    .sort();
}

export function loadFixture<T = JsonValue>(name: string): T {
  return JSON.parse(readFileSync(join(fixtureDir(), `${name}.json`), 'utf8')) as T;
}

export function loadDigests(): Record<string, string> {
  return loadFixture<Record<string, string>>('digests');
}
