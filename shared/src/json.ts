/**
 * Deterministic JSON handling.
 *
 * Every byte that crosses the wire or lands on disk is produced by
 * `canonicalize`, so two replicas that agree on a value agree on its bytes.
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export class SerializationError extends Error {}

/**
 * Canonical JSON: object keys sorted by UTF-16 code unit, no insignificant
 * whitespace, `undefined` members dropped, `-0` normalised to `0`, and
 * non-finite numbers rejected rather than silently turned into `null`.
 */
export function canonicalize(value: unknown, path = '$'): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number': {
      if (!Number.isFinite(value)) {
        throw new SerializationError(`non-finite number at ${path}`);
      }
      return Object.is(value, -0) ? '0' : JSON.stringify(value);
    }
    case 'string':
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new SerializationError(`unserializable ${typeof value} at ${path}`);
  }

  if (Array.isArray(value)) {
    const parts = value.map((item, i) =>
      item === undefined ? 'null' : canonicalize(item, `${path}[${i}]`),
    );
    return `[${parts.join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const child = record[key];
    if (child === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalize(child, `${path}.${key}`)}`);
  }
  return `{${parts.join(',')}}`;
}

/** Parse canonical (or any) JSON into a `JsonValue`. */
export function parseJson(text: string): JsonValue {
  return JSON.parse(text) as JsonValue;
}

/** Structural clone through the canonical form; strips prototypes and `undefined`. */
export function cloneJson<T extends JsonValue>(value: T): T {
  return JSON.parse(canonicalize(value)) as T;
}

/** Deep equality decided by canonical bytes, so it never depends on key order. */
export function jsonEquals(a: unknown, b: unknown): boolean {
  return canonicalize(a) === canonicalize(b);
}
