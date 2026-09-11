import Foundation

/// Operation identity, ordering and causality, matching `shared/src/ops.ts`.
///
/// Ordering is the total order (lamport, actor, seq); causality is decided by
/// `basis`, the highest lamport an actor had seen when it produced the
/// operation. Two operations neither of which saw the other are concurrent, and
/// concurrency is what turns a plain overwrite into a recorded conflict.

public struct ContractError: Error, CustomStringConvertible {
    public let description: String
    public init(_ description: String) { self.description = description }
}

extension Operation {
    public var stamp: Stamp { Stamp(lamport: lamport, actor: actor, seq: seq) }
}

public enum Ops {
    public static func compare(_ lhs: Stamp, _ rhs: Stamp) -> Int {
        if lhs.lamport != rhs.lamport { return lhs.lamport - rhs.lamport }
        if lhs.actor != rhs.actor { return JSONValue.utf16Ascending(lhs.actor, rhs.actor) ? -1 : 1 }
        return lhs.seq - rhs.seq
    }

    /// True when `later` was produced with knowledge of `earlier`.
    public static func happensBefore(_ earlier: Stamp, _ later: Stamp, basis: Int) -> Bool {
        if earlier.actor == later.actor { return earlier.seq < later.seq }
        return earlier.lamport <= basis
    }

    public static func isConcurrent(_ a: Stamp, basisA: Int, _ b: Stamp, basisB: Int) -> Bool {
        !happensBefore(a, b, basis: basisB) && !happensBefore(b, a, basis: basisA)
    }

    public static func sorted(_ ops: [Operation]) -> [Operation] {
        ops.sorted { lhs, rhs in
            let order = compare(lhs.stamp, rhs.stamp)
            if order != 0 { return order < 0 }
            return JSONValue.utf16Ascending(lhs.opId, rhs.opId)
        }
    }

    /// Drops replays of the same operation. An identical replay is normal — a
    /// client resends after a dropped ack — but the same id carrying different
    /// bytes is corruption and is refused rather than merged.
    public static func deduped(_ ops: [Operation]) throws -> [Operation] {
        var seen: [String: String] = [:]
        var out: [Operation] = []
        for op in ops {
            let bytes = try JSONValue(encoding: op).canonicalString()
            if let previous = seen[op.opId] {
                if previous != bytes {
                    throw ContractError("operation \(op.opId) replayed with different content")
                }
            } else {
                seen[op.opId] = bytes
                out.append(op)
            }
        }
        return out
    }

    public struct NewOperation {
        public var entityKind: SyncedKind
        public var entityId: String
        public var notebookId: String
        public var kind: OperationKind
        public var fields: [String: JSONValue]
        public var actor: String
        public var lamport: Int
        public var seq: Int
        public var basis: Int?
        public var at: Int64

        public init(entityKind: SyncedKind, entityId: String, notebookId: String, kind: OperationKind = .set, fields: [String: JSONValue] = [:], actor: String, lamport: Int, seq: Int, basis: Int? = nil, at: Int64) {
            self.entityKind = entityKind
            self.entityId = entityId
            self.notebookId = notebookId
            self.kind = kind
            self.fields = fields
            self.actor = actor
            self.lamport = lamport
            self.seq = seq
            self.basis = basis
            self.at = at
        }
    }

    /// Builds an operation whose id is the hash of its own content, so a
    /// retried build produces the same id and deduplicates instead of
    /// duplicating. The hashed body must match `createOperation` in the shared
    /// contract field for field.
    public static func create(_ input: NewOperation) throws -> Operation {
        let fields = input.kind == .delete ? [:] : input.fields
        let basis = input.basis ?? max(0, input.lamport - 1)
        let body: JSONValue = .object([
            "schemaVersion": .int(Int64(SCHEMA_VERSION)),
            "entityKind": .string(input.entityKind.rawValue),
            "entityId": .string(input.entityId),
            "notebookId": .string(input.notebookId),
            "kind": .string(input.kind.rawValue),
            "fields": .object(fields),
            "actor": .string(input.actor),
            "lamport": .int(Int64(input.lamport)),
            "seq": .int(Int64(input.seq)),
            "basis": .int(Int64(basis)),
            "at": .int(input.at),
        ])
        let opId = String(try Digest.hashJSON(body).prefix(32))
        let operation = Operation(
            opId: opId,
            entityKind: input.entityKind,
            entityId: input.entityId,
            notebookId: input.notebookId,
            kind: input.kind,
            fields: fields,
            actor: input.actor,
            lamport: input.lamport,
            seq: input.seq,
            basis: basis,
            at: input.at
        )
        try validate(operation)
        return operation
    }

    @discardableResult
    public static func validate(_ op: Operation) throws -> Operation {
        guard op.schemaVersion == SCHEMA_VERSION else {
            throw ContractError("operation \(op.opId) has schema version \(op.schemaVersion)")
        }
        if op.kind == .set, op.fields.isEmpty {
            throw ContractError("operation \(op.opId) sets no fields")
        }
        if op.kind == .delete, !op.fields.isEmpty {
            throw ContractError("delete operation \(op.opId) must not carry fields")
        }
        if op.basis > op.lamport {
            throw ContractError("operation \(op.opId) has basis ahead of its lamport")
        }
        return op
    }

    /// The server rejects a device operation that writes a field it owns, so
    /// the client refuses to author one rather than discovering it at sync.
    public static func assertClientWritable(_ op: Operation) throws {
        guard op.kind == .set else { return }
        let allowed = op.entityKind.writableFields
        for field in op.fields.keys where !allowed.contains(field) {
            throw ContractError("field \(field) is not client-writable on \(op.entityKind.rawValue)")
        }
    }
}
