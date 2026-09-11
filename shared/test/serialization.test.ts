import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  SerializationError,
  canonicalize,
  cloneJson,
  decodeStroke,
  encodeStroke,
  hashJson,
  jsonEquals,
  parseJson,
  schemaFor,
  strokeLength,
  validate,
  type EntityKind,
} from '../src/index.js';
import { fixtureNames, loadDigests, loadFixture } from './fixtures.js';

const ENTITY_FIXTURES: Record<string, EntityKind> = {
  user: 'user',
  notebook: 'notebook',
  note: 'note',
  revision: 'revision',
  tombstone: 'tombstone',
  pdf: 'pdf',
  annotation: 'annotation',
  stroke: 'stroke',
  conflict: 'conflict',
};

function shuffleKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shuffleKeys);
  if (value === null || typeof value !== 'object') return value;
  const entries = Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, shuffleKeys(v)] as const);
  return Object.fromEntries([...entries].reverse());
}

describe('canonical serialization', () => {
  it('is independent of key insertion order', () => {
    const a = { b: 1, a: { d: [1, 2], c: 'x' } };
    const b = { a: { c: 'x', d: [1, 2] }, b: 1 };
    assert.equal(canonicalize(a), canonicalize(b));
    assert.equal(canonicalize(a), '{"a":{"c":"x","d":[1,2]},"b":1}');
  });

  it('normalises negative zero and drops undefined members', () => {
    assert.equal(canonicalize({ x: -0, y: undefined, z: 1 }), '{"x":0,"z":1}');
    assert.equal(canonicalize([-0]), '[0]');
  });

  it('refuses values that cannot round-trip', () => {
    assert.throws(() => canonicalize({ x: NaN }), SerializationError);
    assert.throws(() => canonicalize({ x: Infinity }), SerializationError);
    assert.throws(() => canonicalize(() => 1), SerializationError);
  });

  it('is idempotent and stable through parse', () => {
    const value = loadFixture('annotation');
    const once = canonicalize(value);
    assert.equal(canonicalize(parseJson(once)), once);
    assert.equal(canonicalize(cloneJson(value as never)), once);
  });

  it('preserves array order while sorting object keys', () => {
    assert.equal(canonicalize([3, 1, 2]), '[3,1,2]');
    assert.ok(jsonEquals({ a: 1, b: 2 }, { b: 2, a: 1 }));
    assert.ok(!jsonEquals([1, 2], [2, 1]));
  });
});

describe('fixture corpus', () => {
  it('exposes a fixture for every entity kind', () => {
    const names = new Set(fixtureNames());
    for (const name of Object.keys(ENTITY_FIXTURES)) assert.ok(names.has(name), `missing fixture ${name}`);
    assert.ok(names.has('operations'), 'missing operations fixture');
  });

  it('validates every entity fixture against its versioned schema', () => {
    for (const [name, kind] of Object.entries(ENTITY_FIXTURES)) {
      const result = validate(loadFixture(name), schemaFor(kind));
      assert.deepEqual(result.issues, [], `${name} should validate`);
    }
  });

  it('hashes each fixture to its recorded digest', () => {
    const digests = loadDigests();
    for (const [name, expected] of Object.entries(digests)) {
      assert.equal(hashJson(loadFixture(name)), expected, `digest drift in ${name}`);
    }
    assert.ok(Object.keys(digests).length >= 10);
  });

  it('hashes the same regardless of key order', () => {
    for (const name of Object.keys(ENTITY_FIXTURES)) {
      const value = loadFixture(name);
      assert.equal(hashJson(shuffleKeys(value)), hashJson(value), `${name} hash depends on key order`);
    }
  });

  it('declares a versioned $id on every schema', () => {
    for (const kind of Object.values(ENTITY_FIXTURES)) {
      assert.match(String(schemaFor(kind).$id), /\/schemas\/v1\//);
    }
  });
});

describe('ink strokes', () => {
  const points = [
    { x: 10.004, y: 20.006, pressure: 0.3334, t: 1000 },
    { x: 11.5, y: 21.25, pressure: 0.9, t: 1016 },
  ];

  it('quantises to integers and re-encodes identically', () => {
    const encoded = encodeStroke(points);
    assert.ok(encoded.every(Number.isInteger));
    assert.deepEqual(encodeStroke(decodeStroke(encoded)), encoded);
    assert.equal(strokeLength(encoded), 2);
  });

  it('rebases time to the first sample', () => {
    const encoded = encodeStroke(points);
    assert.equal(decodeStroke(encoded)[0]!.t, 0);
    assert.equal(decodeStroke(encoded)[1]!.t, 16);
  });

  it('produces identical bytes for inputs that differ below the quantum', () => {
    const jittered = points.map((p) => ({ ...p, x: p.x + 0.0001 }));
    assert.equal(canonicalize(encodeStroke(points)), canonicalize(encodeStroke(jittered)));
  });

  it('round-trips the checked-in stroke fixture', () => {
    const stroke = loadFixture<{ points: number[] }>('stroke');
    assert.deepEqual(encodeStroke(decodeStroke(stroke.points)), stroke.points);
  });
});
