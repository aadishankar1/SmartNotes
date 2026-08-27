/** `npm start` entry point. */

import { resolve } from 'node:path';
import { startServer } from './server.js';

const dataDir = resolve(process.env['SMARTNOTES_DATA_DIR'] ?? './.smartnotes-data');
const port = Number(process.env['PORT'] ?? 8787);
const host = process.env['HOST'] ?? '127.0.0.1';

startServer({ dataDir, port, host })
  .then((running) => {
    process.stdout.write(`smartnotes server listening on ${running.url} (data: ${dataDir})\n`);
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        void running.close().then(() => process.exit(0));
      });
    }
  })
  .catch((error: unknown) => {
    process.stderr.write(`failed to start: ${(error as Error).message}\n`);
    process.exit(1);
  });
