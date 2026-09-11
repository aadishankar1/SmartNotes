import Foundation

/// The wire contract, mirroring `shared/src/protocol.ts`.
///
/// The iPad speaks exactly the shapes the server validates, so a request that
/// type-checks here is one the server's JSON Schema pass will accept.
public enum API {
    public static let prefix = "/v1"
}

public struct ErrorBody: Codable, Sendable {
    public struct Payload: Codable, Sendable {
        public var code: String
        public var message: String
    }

    public var error: Payload

    public init(code: String, message: String) {
        self.error = Payload(code: code, message: message)
    }
}

public struct AuthResponse: Codable, Sendable {
    public var user: User
    public var token: String
    public var expiresAt: Int64

    public init(user: User, token: String, expiresAt: Int64) {
        self.user = user
        self.token = token
        self.expiresAt = expiresAt
    }
}

/// A client asks for everything after `cursor` and offers its own operations.
public struct SyncRequest: Codable, Sendable {
    public var schemaVersion: Int
    public var deviceId: String
    public var notebookId: String
    public var cursor: Int
    public var ops: [Operation]

    /// The server caps a sync push at 500 operations, so the outbox is drained
    /// in batches rather than rejected wholesale when a long offline session
    /// has piled up more than one request can carry.
    public static let maxOpsPerRequest = 500

    public init(schemaVersion: Int = SCHEMA_VERSION, deviceId: String, notebookId: String, cursor: Int, ops: [Operation]) {
        self.schemaVersion = schemaVersion
        self.deviceId = deviceId
        self.notebookId = notebookId
        self.cursor = cursor
        self.ops = ops
    }
}

public struct RejectedOperation: Codable, Hashable, Sendable {
    public var opId: String
    public var reason: String

    public init(opId: String, reason: String) {
        self.opId = opId
        self.reason = reason
    }
}

public enum SyncMode: String, Codable, Sendable {
    case delta
    case snapshot
}

public struct SyncResponse: Codable, Sendable {
    public var schemaVersion: Int
    public var notebookId: String
    /// Cursor to send on the next sync.
    public var cursor: Int
    public var mode: SyncMode
    /// Present when `mode` is `.delta`.
    public var ops: [Operation]
    /// Present when `mode` is `.snapshot`: adopt this state wholesale.
    public var state: FoldState?
    public var accepted: [String]
    public var rejected: [RejectedOperation]
    public var tombstones: [Tombstone]
    public var conflicts: [Conflict]
    public var serverLamport: Int

    public init(
        schemaVersion: Int = SCHEMA_VERSION,
        notebookId: String,
        cursor: Int,
        mode: SyncMode,
        ops: [Operation] = [],
        state: FoldState? = nil,
        accepted: [String] = [],
        rejected: [RejectedOperation] = [],
        tombstones: [Tombstone] = [],
        conflicts: [Conflict] = [],
        serverLamport: Int = 0
    ) {
        self.schemaVersion = schemaVersion
        self.notebookId = notebookId
        self.cursor = cursor
        self.mode = mode
        self.ops = ops
        self.state = state
        self.accepted = accepted
        self.rejected = rejected
        self.tombstones = tombstones
        self.conflicts = conflicts
        self.serverLamport = serverLamport
    }
}

// MARK: - REST envelopes

/// `GET /v1/notebooks/:id` — the notebook plus enough of its contents to open
/// it, and the cursor a first sync should start from.
public struct NotebookDetail: Codable, Sendable {
    public var notebook: Notebook
    public var notes: [Note]
    public var pdfs: [PdfDocument]
    public var conflicts: [Conflict]
    public var cursor: Int
}

public struct AnnotationsResponse: Codable, Sendable {
    public var annotations: [Annotation]
    public var strokes: [InkStroke]
}

struct NotebooksEnvelope: Codable { var notebooks: [Notebook] }
struct NotebookEnvelope: Codable { var notebook: Notebook }
struct UserEnvelope: Codable { var user: User }
struct PdfEnvelope: Codable { var pdf: PdfDocument }
struct PdfsEnvelope: Codable { var pdfs: [PdfDocument] }

struct PdfUploadRequest: Codable {
    var notebookId: String
    var filename: String
    /// base64 of the PDF bytes
    var content: String
    var pageCount: Int?
}

struct NotebookCreateRequest: Codable {
    var title: String
    var color: String?
}
