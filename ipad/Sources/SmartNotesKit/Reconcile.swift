import Foundation

/// Reconciliation: fold a set of operations into replica state.
///
/// A port of `shared/src/reconcile.ts`. The fold is a pure function of the
/// operation *set*, not of arrival order. Each field keeps the antichain of
/// writes no later write has observed; the highest stamp in that antichain is
/// the value (per-field last-writer-wins) and everything else in it is a
/// recorded conflict rather than lost work. Deletes are tombstones with the
/// same stamps, so a delete and a later edit resolve the same way on the iPad
/// as they do on the server.

/// Field name used for a delete that raced a surviving edit.
public let DELETED_FIELD = "__deleted"

/// Bound on retained concurrent writes per field; keeps state size finite.
public let MAX_CONCURRENT_WRITES = 16

public struct Side: Codable, Hashable, Sendable {
    public var opId: String
    public var stamp: Stamp
    public var basis: Int
    public var value: JSONValue
    public var at: Int64

    public init(opId: String, stamp: Stamp, basis: Int, value: JSONValue, at: Int64) {
        self.opId = opId
        self.stamp = stamp
        self.basis = basis
        self.value = value
        self.at = at
    }
}

public struct FieldState: Codable, Hashable, Sendable {
    /// Maximal (mutually concurrent) writes, ascending by stamp.
    public var writes: [Side]

    public init(writes: [Side]) { self.writes = writes }
}

public struct EntityState: Codable, Hashable, Sendable {
    public var kind: SyncedKind
    public var id: String
    public var notebookId: String
    public var notebookStamp: Stamp
    public var fields: [String: FieldState]
    public var deleted: Side?

    public init(kind: SyncedKind, id: String, notebookId: String, notebookStamp: Stamp, fields: [String: FieldState], deleted: Side?) {
        self.kind = kind
        self.id = id
        self.notebookId = notebookId
        self.notebookStamp = notebookStamp
        self.fields = fields
        self.deleted = deleted
    }
}

public struct FoldState: Codable, Hashable, Sendable {
    public var schemaVersion: Int
    public var lamport: Int
    public var entities: [String: EntityState]

    public init(schemaVersion: Int = SCHEMA_VERSION, lamport: Int = 0, entities: [String: EntityState] = [:]) {
        self.schemaVersion = schemaVersion
        self.lamport = lamport
        self.entities = entities
    }

    public static func empty() -> FoldState { FoldState() }
}

public struct MaterializedEntity: Hashable, Sendable {
    public var kind: SyncedKind
    public var id: String
    public var notebookId: String
    public var record: JSONValue

    public init(kind: SyncedKind, id: String, notebookId: String, record: JSONValue) {
        self.kind = kind
        self.id = id
        self.notebookId = notebookId
        self.record = record
    }
}

public struct InvalidEntity: Hashable, Sendable {
    public var kind: SyncedKind
    public var id: String
    public var reason: String
    /// The fold's own answer for this entity, kept even though it does not
    /// satisfy the schema. Nothing renders it as a record — but a client that
    /// wrote one of these fields locally, and so knows what it means, can read
    /// its own edit back before a sync fills in the server-owned rest.
    public var partial: JSONValue

    public init(kind: SyncedKind, id: String, reason: String, partial: JSONValue = .object([:])) {
        self.kind = kind
        self.id = id
        self.reason = reason
        self.partial = partial
    }
}

public struct Materialized: Sendable {
    public var entities: [MaterializedEntity]
    public var tombstones: [Tombstone]
    public var conflicts: [Conflict]
    public var invalid: [InvalidEntity]

    public func records(of kind: SyncedKind) -> [JSONValue] {
        entities.filter { $0.kind == kind }.map(\.record)
    }

    public func decode<T: Decodable>(_ type: T.Type, of kind: SyncedKind) throws -> [T] {
        try records(of: kind).map { try $0.decode(type) }
    }
}

public enum Reconcile {
    public static func entityKey(_ kind: SyncedKind, _ id: String) -> String { "\(kind.rawValue):\(id)" }

    /// Applies one operation. Idempotent, and independent of call order.
    public static func apply(_ op: Operation, to state: inout FoldState) {
        let key = entityKey(op.entityKind, op.entityId)
        let stamp = op.stamp
        state.lamport = max(state.lamport, op.lamport)

        var entity = state.entities[key] ?? EntityState(
            kind: op.entityKind,
            id: op.entityId,
            notebookId: op.notebookId,
            notebookStamp: stamp,
            fields: [:],
            deleted: nil
        )
        if state.entities[key] != nil, Ops.compare(stamp, entity.notebookStamp) < 0 {
            // The earliest operation decides which notebook an entity belongs
            // to, so late-arriving creates cannot move it between notebooks.
            entity.notebookId = op.notebookId
            entity.notebookStamp = stamp
        }

        if op.kind == .delete {
            let side = Side(opId: op.opId, stamp: stamp, basis: op.basis, value: .null, at: op.at)
            if entity.deleted == nil || Ops.compare(side.stamp, entity.deleted!.stamp) > 0 {
                entity.deleted = side
            }
            state.entities[key] = entity
            return
        }

        for (field, value) in op.fields {
            let side = Side(opId: op.opId, stamp: stamp, basis: op.basis, value: value, at: op.at)
            let current = entity.fields[field] ?? FieldState(writes: [])
            entity.fields[field] = FieldState(writes: mergeWrite(current.writes, side))
        }
        state.entities[key] = entity
    }

    private static func mergeWrite(_ writes: [Side], _ side: Side) -> [Side] {
        if writes.contains(where: { $0.opId == side.opId }) { return writes }
        if writes.contains(where: { Ops.happensBefore(side.stamp, $0.stamp, basis: $0.basis) }) { return writes }
        var kept = writes.filter { !Ops.happensBefore($0.stamp, side.stamp, basis: side.basis) }
        kept.append(side)
        kept.sort { Ops.compare($0.stamp, $1.stamp) < 0 }
        if kept.count > MAX_CONCURRENT_WRITES { kept.removeFirst(kept.count - MAX_CONCURRENT_WRITES) }
        return kept
    }

    /// Folds operations into `base` (or a fresh state), returning the new state.
    public static func fold(_ ops: [Operation], base: FoldState = .empty()) throws -> FoldState {
        var state = base
        for op in Ops.sorted(try Ops.deduped(ops)) { apply(op, to: &state) }
        return state
    }

    /// Reconnect reconciliation: fold what we already had together with
    /// whatever the peer sends, from either direction, and get the same answer.
    public static func reconcile(_ base: FoldState, incoming: [Operation]) throws -> FoldState {
        try fold(incoming, base: base)
    }

    /// Projects fold state into validated entities, tombstones and conflicts.
    /// Nothing here reads a clock, so two replicas with the same operations
    /// produce byte-identical output.
    public static func materialize(_ state: FoldState) throws -> Materialized {
        var entities: [MaterializedEntity] = []
        var tombstones: [Tombstone] = []
        var conflicts: [Conflict] = []
        var invalid: [InvalidEntity] = []

        for key in state.entities.keys.sorted(by: JSONValue.utf16Ascending) {
            let entity = state.entities[key]!
            let fieldNames = entity.fields.keys.sorted(by: JSONValue.utf16Ascending)
            var winners: [(name: String, side: Side)] = []
            for name in fieldNames {
                guard let field = entity.fields[name], !field.writes.isEmpty else { continue }
                winners.append((name, field.writes.max { Ops.compare($0.stamp, $1.stamp) < 0 }!))
            }

            let highest = winners.map(\.side).max { Ops.compare($0.stamp, $1.stamp) < 0 }
            let deleted = entity.deleted
            let live = highest != nil && (deleted == nil || Ops.compare(highest!.stamp, deleted!.stamp) > 0)

            for name in fieldNames {
                guard let field = entity.fields[name], field.writes.count >= 2 else { continue }
                guard let winner = winners.first(where: { $0.name == name })?.side else { continue }
                let losers = field.writes.filter { $0.opId != winner.opId && $0.value != winner.value }
                if losers.isEmpty { continue }
                conflicts.append(
                    Conflict(
                        schemaVersion: SCHEMA_VERSION,
                        id: try conflictId(entity.kind, entity.id, name),
                        entityKind: entity.kind,
                        entityId: entity.id,
                        field: name,
                        winner: ConflictSide(opId: winner.opId, stamp: winner.stamp, value: winner.value),
                        losers: losers.map { ConflictSide(opId: $0.opId, stamp: $0.stamp, value: $0.value) },
                        detectedAt: max(winner.at, losers.map(\.at).max() ?? winner.at)
                    )
                )
            }

            if live, let deleted, let highest,
               Ops.isConcurrent(highest.stamp, basisA: highest.basis, deleted.stamp, basisB: deleted.basis) {
                conflicts.append(
                    Conflict(
                        schemaVersion: SCHEMA_VERSION,
                        id: try conflictId(entity.kind, entity.id, DELETED_FIELD),
                        entityKind: entity.kind,
                        entityId: entity.id,
                        field: DELETED_FIELD,
                        winner: ConflictSide(opId: highest.opId, stamp: highest.stamp, value: highest.value),
                        losers: [ConflictSide(opId: deleted.opId, stamp: deleted.stamp, value: deleted.value)],
                        detectedAt: max(highest.at, deleted.at)
                    )
                )
            }

            if !live {
                if let deleted {
                    tombstones.append(
                        Tombstone(
                            schemaVersion: SCHEMA_VERSION,
                            entityKind: entity.kind,
                            entityId: entity.id,
                            notebookId: entity.notebookId,
                            stamp: deleted.stamp,
                            deletedAt: deleted.at
                        )
                    )
                }
                continue
            }

            var record: [String: JSONValue] = [
                "schemaVersion": .int(Int64(SCHEMA_VERSION)),
                "id": .string(entity.id),
            ]
            for winner in winners { record[winner.name] = winner.side.value }
            if entity.kind != .notebook { record["notebookId"] = .string(entity.notebookId) }

            let candidate = JSONValue.object(record)
            do {
                try validateRecord(candidate, kind: entity.kind)
            } catch {
                invalid.append(
                    InvalidEntity(kind: entity.kind, id: entity.id, reason: "\(error)", partial: candidate)
                )
                continue
            }
            entities.append(MaterializedEntity(kind: entity.kind, id: entity.id, notebookId: entity.notebookId, record: candidate))
        }

        entities.sort { lhs, rhs in
            if lhs.kind != rhs.kind { return lhs.kind.order < rhs.kind.order }
            return JSONValue.utf16Ascending(lhs.id, rhs.id)
        }
        tombstones.sort { lhs, rhs in
            if lhs.entityKind != rhs.entityKind { return lhs.entityKind.order < rhs.entityKind.order }
            return JSONValue.utf16Ascending(lhs.entityId, rhs.entityId)
        }
        let keyed = try conflicts.map { (try sortKey($0), $0) }
        conflicts = keyed.sorted { JSONValue.utf16Ascending($0.0, $1.0) }.map(\.1)

        return Materialized(entities: entities, tombstones: tombstones, conflicts: conflicts, invalid: invalid)
    }

    /// Stable digest of reconciled state; equal digests mean converged replicas.
    public static func stateDigest(_ state: FoldState) throws -> String {
        let view = try materialize(state)
        let value = JSONValue.array([
            .array(view.entities.map(\.record)),
            .array(try view.tombstones.map { try JSONValue(encoding: $0) }),
            .array(try view.conflicts.map { try JSONValue(encoding: $0) }),
        ])
        return try Digest.hashJSON(value)
    }

    /// Decoding into the contract's types is the client-side equivalent of the
    /// server's JSON Schema pass: a record that cannot become a `Note` is not a
    /// note, and is reported rather than shown.
    private static func validateRecord(_ record: JSONValue, kind: SyncedKind) throws {
        switch kind {
        case .notebook: _ = try record.decode(Notebook.self)
        case .note: _ = try record.decode(Note.self)
        case .pdf: _ = try record.decode(PdfDocument.self)
        case .annotation: _ = try record.decode(Annotation.self)
        case .stroke: _ = try record.decode(InkStroke.self)
        }
    }

    private static func conflictId(_ kind: SyncedKind, _ id: String, _ field: String) throws -> String {
        String(try Digest.hashJSON(.array([.string(kind.rawValue), .string(id), .string(field)])).prefix(32))
    }

    private static func sortKey(_ conflict: Conflict) throws -> String {
        try JSONValue.array([
            .string(conflict.entityKind.rawValue),
            .string(conflict.entityId),
            .string(conflict.field),
        ]).canonicalString()
    }
}
