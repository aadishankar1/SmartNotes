/** Socket wiring for the API. Everything interesting lives in `app.ts`. */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createApp, type App, type AppOptions } from './app.js';

export const MAX_BODY_BYTES = 32 * 1024 * 1024;

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.byteLength;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buffer);
  }
  if (total === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

export function createRequestListener(app: App): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void (async () => {
      let body: unknown = null;
      try {
        body = await readBody(req);
      } catch (error) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'invalid_body', message: (error as Error).message } }));
        return;
      }

      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers[key] = value;
      }
      const response = await app.handle({ method: req.method ?? 'GET', path: req.url ?? '/', headers, body });
      const payload = response.bytes ?? Buffer.from(response.body === undefined ? '' : JSON.stringify(response.body), 'utf8');
      res.writeHead(response.status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(payload.byteLength),
        ...response.headers,
      });
      res.end(payload);
    })();
  };
}

export interface RunningServer {
  server: Server;
  app: App;
  url: string;
  close(): Promise<void>;
}

export function startServer(options: AppOptions & { port?: number; host?: string }): Promise<RunningServer> {
  const app = createApp(options);
  const server = createServer(createRequestListener(app));
  const host = options.host ?? '127.0.0.1';
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 8787, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : options.port;
      resolve({
        server,
        app,
        url: `http://${host}:${port}`,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => {
              app.close();
              done();
            });
          }),
      });
    });
  });
}
