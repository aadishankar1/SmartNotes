import Foundation

/// The SmartNotes entity types, mirroring `shared/src/model.ts`.
///
/// Optional members are encoded explicitly rather than through the synthesised
/// `encodeIfPresent`, because the shared schemas require the key to be present
/// and null — an omitted `color` is an invalid notebook, not a default one.

public let SCHEMA_VERSION: Int = 1

public enum EntityKind: String, Codable, CaseIterable, Sendable {
    case user, notebook, note, revision, tombstone, pdf, annotation, stroke, conflict
}

/// Entities that clients may write through the operation log, in the order the
/// shared contract materialises them.
public enum SyncedKind: String, Codable, CaseIterable, Sendable {
    case notebook, note, pdf, annotation, stroke

    public var order: Int { SyncedKind.allCases.firstIndex(of: self) ?? 0 }

    /// Fields a client may write; anything else is server-owned and rejected.
    public var writableFields: Set<String> {
        switch self {
        case .notebook: return ["title", "color", "createdAt", "updatedAt"]
        case .note: return ["title", "body", "position", "createdAt", "updatedAt"]
        case .pdf: return ["filename", "pageCount", "createdAt"]
        case .annotation: return ["pdfId", "page", "kind", "rect", "color", "text", "strokeId", "createdAt", "updatedAt"]
        case .stroke: return ["targetKind", "targetId", "page", "color", "width", "points", "createdAt"]
        }
    }
}

/// Total order over operations: `lamport` is the logical clock, `actor` the
/// device, `seq` that device's own counter, so no two operations tie.
public struct Stamp: Codable, Hashable, Sendable {
    public var lamport: Int
    public var actor: String
    public var seq: Int

    public init(lamport: Int, actor: String, seq: Int) {
        self.lamport = lamport
        self.actor = actor
        self.seq = seq
    }
}

public struct User: Codable, Hashable, Sendable {
    public var schemaVersion: Int
    public var id: String
    public var email: String
    public var displayName: String
    public var createdAt: Int64

    public init(schemaVersion: Int = SCHEMA_VERSION, id: String, email: String, displayName: String, createdAt: Int64) {
        self.schemaVersion = schemaVersion
        self.id = id
        self.email = email
        self.displayName = displayName
        self.createdAt = createdAt
    }
}

public struct Notebook: Codable, Hashable, Sendable, Identifiable {
    public var schemaVersion: Int
    public var id: String
    public var ownerId: String
    public var title: String
    public var color: String?
    public var createdAt: Int64
    public var updatedAt: Int64

    public init(schemaVersion: Int = SCHEMA_VERSION, id: String, ownerId: String, title: String, color: String?, createdAt: Int64, updatedAt: Int64) {
        self.schemaVersion = schemaVersion
        self.id = id
        self.ownerId = ownerId
        self.title = title
        self.color = color
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    private enum CodingKeys: String, CodingKey {
        case schemaVersion, id, ownerId, title, color, createdAt, updatedAt
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(schemaVersion, forKey: .schemaVersion)
        try container.encode(id, forKey: .id)
        try container.encode(ownerId, forKey: .ownerId)
        try container.encode(title, forKey: .title)
        try container.encode(color, forKey: .color)
        try container.encode(createdAt, forKey: .createdAt)
        try container.encode(updatedAt, forKey: .updatedAt)
    }
}

public struct Note: Codable, Hashable, Sendable, Identifiable {
    public var schemaVersion: Int
    public var id: String
    public var notebookId: String
    public var title: String
    public var body: String
    public var position: Double
    public var createdAt: Int64
    public var updatedAt: Int64

    public init(schemaVersion: Int = SCHEMA_VERSION, id: String, notebookId: String, title: String, body: String, position: Double, createdAt: Int64, updatedAt: Int64) {
        self.schemaVersion = schemaVersion
        self.id = id
        self.notebookId = notebookId
        self.title = title
        self.body = body
        self.position = position
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

public struct Revision: Codable, Hashable, Sendable, Identifiable {
    public var schemaVersion: Int
    public var id: String
    public var noteId: String
    public var body: String
    public var hash: String
    public var actor: String
    public var createdAt: Int64

    public init(schemaVersion: Int = SCHEMA_VERSION, id: String, noteId: String, body: String, hash: String, actor: String, createdAt: Int64) {
        self.schemaVersion = schemaVersion
        self.id = id
        self.noteId = noteId
        self.body = body
        self.hash = hash
        self.actor = actor
        self.createdAt = createdAt
    }
}

public struct Tombstone: Codable, Hashable, Sendable {
    public var schemaVersion: Int
    public var entityKind: SyncedKind
    public var entityId: String
    public var notebookId: String
    public var stamp: Stamp
    public var deletedAt: Int64

    public init(schemaVersion: Int = SCHEMA_VERSION, entityKind: SyncedKind, entityId: String, notebookId: String, stamp: Stamp, deletedAt: Int64) {
        self.schemaVersion = schemaVersion
        self.entityKind = entityKind
        self.entityId = entityId
        self.notebookId = notebookId
        self.stamp = stamp
        self.deletedAt = deletedAt
    }
}

public struct PdfDocument: Codable, Hashable, Sendable, Identifiable {
    public var schemaVersion: Int
    public var id: String
    public var notebookId: String
    public var filename: String
    public var byteSize: Int64
    public var sha256: String
    public var pageCount: Int
    public var createdAt: Int64

    public init(schemaVersion: Int = SCHEMA_VERSION, id: String, notebookId: String, filename: String, byteSize: Int64, sha256: String, pageCount: Int, createdAt: Int64) {
        self.schemaVersion = schemaVersion
        self.id = id
        self.notebookId = notebookId
        self.filename = filename
        self.byteSize = byteSize
        self.sha256 = sha256
        self.pageCount = pageCount
        self.createdAt = createdAt
    }
}

public enum AnnotationKind: String, Codable, Hashable, Sendable {
    case highlight, note, ink
}

public struct Rect: Codable, Hashable, Sendable {
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }
}

public struct Annotation: Codable, Hashable, Sendable, Identifiable {
    public var schemaVersion: Int
    public var id: String
    public var pdfId: String
    public var notebookId: String
    public var page: Int
    public var kind: AnnotationKind
    public var rect: Rect?
    public var color: String
    public var text: String?
    public var strokeId: String?
    public var createdAt: Int64
    public var updatedAt: Int64

    public init(schemaVersion: Int = SCHEMA_VERSION, id: String, pdfId: String, notebookId: String, page: Int, kind: AnnotationKind, rect: Rect?, color: String, text: String?, strokeId: String?, createdAt: Int64, updatedAt: Int64) {
        self.schemaVersion = schemaVersion
        self.id = id
        self.pdfId = pdfId
        self.notebookId = notebookId
        self.page = page
        self.kind = kind
        self.rect = rect
        self.color = color
        self.text = text
        self.strokeId = strokeId
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    private enum CodingKeys: String, CodingKey {
        case schemaVersion, id, pdfId, notebookId, page, kind, rect, color, text, strokeId, createdAt, updatedAt
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(schemaVersion, forKey: .schemaVersion)
        try container.encode(id, forKey: .id)
        try container.encode(pdfId, forKey: .pdfId)
        try container.encode(notebookId, forKey: .notebookId)
        try container.encode(page, forKey: .page)
        try container.encode(kind, forKey: .kind)
        try container.encode(rect, forKey: .rect)
        try container.encode(color, forKey: .color)
        try container.encode(text, forKey: .text)
        try container.encode(strokeId, forKey: .strokeId)
        try container.encode(createdAt, forKey: .createdAt)
        try container.encode(updatedAt, forKey: .updatedAt)
    }
}

public enum StrokeTargetKind: String, Codable, Hashable, Sendable {
    case note, pdf
}

/// Ink is a flat quantised integer array — `[x, y, pressure, dt, ...]` —
/// because float coordinates do not round-trip to identical bytes across
/// devices, and identical bytes are what make two replicas comparable.
public struct InkStroke: Codable, Hashable, Sendable, Identifiable {
    public var schemaVersion: Int
    public var id: String
    public var notebookId: String
    public var targetKind: StrokeTargetKind
    public var targetId: String
    public var page: Int?
    public var color: String
    public var width: Int
    public var points: [Int]
    public var createdAt: Int64

    public init(schemaVersion: Int = SCHEMA_VERSION, id: String, notebookId: String, targetKind: StrokeTargetKind, targetId: String, page: Int?, color: String, width: Int, points: [Int], createdAt: Int64) {
        self.schemaVersion = schemaVersion
        self.id = id
        self.notebookId = notebookId
        self.targetKind = targetKind
        self.targetId = targetId
        self.page = page
        self.color = color
        self.width = width
        self.points = points
        self.createdAt = createdAt
    }

    private enum CodingKeys: String, CodingKey {
        case schemaVersion, id, notebookId, targetKind, targetId, page, color, width, points, createdAt
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(schemaVersion, forKey: .schemaVersion)
        try container.encode(id, forKey: .id)
        try container.encode(notebookId, forKey: .notebookId)
        try container.encode(targetKind, forKey: .targetKind)
        try container.encode(targetId, forKey: .targetId)
        try container.encode(page, forKey: .page)
        try container.encode(color, forKey: .color)
        try container.encode(width, forKey: .width)
        try container.encode(points, forKey: .points)
        try container.encode(createdAt, forKey: .createdAt)
    }
}

public struct ConflictSide: Codable, Hashable, Sendable {
    public var opId: String
    public var stamp: Stamp
    public var value: JSONValue

    public init(opId: String, stamp: Stamp, value: JSONValue) {
        self.opId = opId
        self.stamp = stamp
        self.value = value
    }
}

/// A concurrent write that lost per-field last-writer-wins. The losing value is
/// kept so the iPad can offer it back to the user instead of dropping work.
public struct Conflict: Codable, Hashable, Sendable, Identifiable {
    public var schemaVersion: Int
    public var id: String
    public var entityKind: SyncedKind
    public var entityId: String
    public var field: String
    public var winner: ConflictSide
    public var losers: [ConflictSide]
    public var detectedAt: Int64

    public init(schemaVersion: Int = SCHEMA_VERSION, id: String, entityKind: SyncedKind, entityId: String, field: String, winner: ConflictSide, losers: [ConflictSide], detectedAt: Int64) {
        self.schemaVersion = schemaVersion
        self.id = id
        self.entityKind = entityKind
        self.entityId = entityId
        self.field = field
        self.winner = winner
        self.losers = losers
        self.detectedAt = detectedAt
    }
}

public enum OperationKind: String, Codable, Hashable, Sendable {
    case set, delete
}

public struct Operation: Codable, Hashable, Sendable {
    public var schemaVersion: Int
    public var opId: String
    public var entityKind: SyncedKind
    public var entityId: String
    public var notebookId: String
    public var kind: OperationKind
    /// Present for `set`; a partial record of the fields this operation writes.
    public var fields: [String: JSONValue]
    public var actor: String
    public var lamport: Int
    public var seq: Int
    /// Highest lamport this actor had observed; makes causality decidable.
    public var basis: Int
    public var at: Int64

    public init(schemaVersion: Int = SCHEMA_VERSION, opId: String, entityKind: SyncedKind, entityId: String, notebookId: String, kind: OperationKind, fields: [String: JSONValue], actor: String, lamport: Int, seq: Int, basis: Int, at: Int64) {
        self.schemaVersion = schemaVersion
        self.opId = opId
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
