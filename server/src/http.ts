/**
 * Transport-free HTTP layer.
 *
 * Handlers see a plain request object and return a plain response, so the whole
 * API is exercisable in-process. `server.ts` is the only part that needs a
 * socket, which also keeps the tests runnable in sandboxes that forbid one.
 */

export interface ApiRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: unknown;
  params: Record<string, string>;
}

export interface ApiResponse {
  status: number;
  body?: unknown;
  /** Raw payload; when set it is sent verbatim instead of JSON. */
  bytes?: Buffer;
  headers?: Record<string, string>;
}

export type Handler = (request: ApiRequest) => ApiResponse | Promise<ApiResponse>;

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
}

export class Router {
  private readonly routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): this {
    this.routes.push({ method, segments: pattern.split('/').filter(Boolean), handler });
    return this;
  }

  get(pattern: string, handler: Handler): this {
    return this.add('GET', pattern, handler);
  }

  post(pattern: string, handler: Handler): this {
    return this.add('POST', pattern, handler);
  }

  patch(pattern: string, handler: Handler): this {
    return this.add('PATCH', pattern, handler);
  }

  delete(pattern: string, handler: Handler): this {
    return this.add('DELETE', pattern, handler);
  }

  match(method: string, path: string): { handler: Handler; params: Record<string, string> } | null {
    const parts = path.split('/').filter(Boolean);
    let pathExists = false;
    for (const route of this.routes) {
      if (route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const segment = route.segments[i]!;
        if (segment.startsWith(':')) params[segment.slice(1)] = decodeURIComponent(parts[i]!);
        else if (segment !== parts[i]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      pathExists = true;
      if (route.method === method) return { handler: route.handler, params };
    }
    if (pathExists) throw new MethodNotAllowed(path, method);
    return null;
  }
}

export class MethodNotAllowed extends Error {
  constructor(
    readonly path: string,
    readonly method: string,
  ) {
    super(`${method} is not allowed on ${path}`);
  }
}

export function bearerToken(headers: Record<string, string>): string | undefined {
  const header = headers['authorization'] ?? headers['Authorization'];
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : undefined;
}

export function json(status: number, body: unknown): ApiResponse {
  return { status, body };
}

export function errorResponse(status: number, code: string, message: string, details?: unknown): ApiResponse {
  return { status, body: { error: details === undefined ? { code, message } : { code, message, details } } };
}
