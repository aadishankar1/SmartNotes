import Foundation

/// A device's saved session. The MVP authenticates with a server-issued API
/// token, so there is no password on the device to protect or to rotate.
public struct Session: Codable, Hashable, Sendable {
    public var baseURL: String
    public var token: String
    public var user: User

    public init(baseURL: String, token: String, user: User) {
        self.baseURL = baseURL
        self.token = token
        self.user = user
    }
}

/// Everything the iPad needs to open a notebook with the network switched off:
/// the folded state, the cursor the next sync resumes from, this device's
/// clock, and the operations that have not been acknowledged yet.
public struct NotebookReplica: Codable, Sendable {
    public var schemaVersion: Int
    public var notebookId: String
    /// Server log index this replica has consumed up to.
    public var cursor: Int
    /// Highest lamport this device has observed; the `basis` of its next write.
    public var lamport: Int
    /// This device's own operation counter.
    public var seq: Int
    public var state: FoldState
    /// Authored locally and not yet acknowledged by the server.
    public var outbox: [Operation]
    /// Operations the server refused, kept so the UI can explain the loss.
    public var rejected: [RejectedOperation]
    public var lastSyncedAt: Int64?

    public init(
        schemaVersion: Int = SCHEMA_VERSION,
        notebookId: String,
        cursor: Int = 0,
        lamport: Int = 0,
        seq: Int = 0,
        state: FoldState = .empty(),
        outbox: [Operation] = [],
        rejected: [RejectedOperation] = [],
        lastSyncedAt: Int64? = nil
    ) {
        self.schemaVersion = schemaVersion
        self.notebookId = notebookId
        self.cursor = cursor
        self.lamport = lamport
        self.seq = seq
        self.state = state
        self.outbox = outbox
        self.rejected = rejected
        self.lastSyncedAt = lastSyncedAt
    }
}

public struct StoreError: Error, CustomStringConvertible {
    public let description: String
    public init(_ description: String) { self.description = description }
}

/// The on-disk replica.
///
/// Every file is written to a sibling temporary path, fsynced, and then
/// renamed over its target, so a crash or a kill mid-write leaves the previous
/// complete file rather than a truncated one. That is what makes "your edits
/// are safe on this iPad" true rather than merely likely.
public final class LocalStore {
    public let root: URL
    private let fileManager = FileManager.default
    /// Disabling fsync makes the tests fast; the app never does.
    private let fsync: Bool

    public init(root: URL, fsync: Bool = true) throws {
        self.root = root
        self.fsync = fsync
        for directory in [root, replicasDirectory(root), pdfsDirectory(root)] {
            try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        }
    }

    /// The default location: Application Support, which iOS backs up and does
    /// not purge under storage pressure the way Caches is purged.
    public static func defaultRoot() throws -> URL {
        let base = try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        return base.appendingPathComponent("SmartNotes", isDirectory: true)
    }

    // MARK: - Device identity

    /// A stable per-install actor id. It is generated once and kept, because
    /// the operation log's ordering rules assume a device keeps its identity
    /// across launches — a new id would make this device's own past writes look
    /// like a stranger's.
    public func deviceId() throws -> String {
        let url = root.appendingPathComponent("device.json")
        if let data = try? Data(contentsOf: url),
           let saved = try? JSONDecoder().decode([String: String].self, from: data),
           let id = saved["deviceId"], Self.isValidId(id) {
            return id
        }
        let id = "dev_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        try writeAtomically(try encode(["deviceId": id]), to: url)
        return id
    }

    // MARK: - Session

    public func loadSession() throws -> Session? {
        let url = root.appendingPathComponent("session.json")
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(Session.self, from: data)
    }

    public func saveSession(_ session: Session) throws {
        try writeAtomically(try encode(session), to: root.appendingPathComponent("session.json"))
    }

    public func clearSession() throws {
        try? fileManager.removeItem(at: root.appendingPathComponent("session.json"))
    }

    // MARK: - Notebook index

    /// The last known notebook list, so the notebook screen has something to
    /// show before — or without — a successful network call.
    public func loadNotebooks() throws -> [Notebook] {
        let url = root.appendingPathComponent("notebooks.json")
        guard let data = try? Data(contentsOf: url) else { return [] }
        return (try? JSONDecoder().decode([Notebook].self, from: data)) ?? []
    }

    public func saveNotebooks(_ notebooks: [Notebook]) throws {
        try writeAtomically(try encode(notebooks), to: root.appendingPathComponent("notebooks.json"))
    }

    // MARK: - Replicas

    public func replicaURL(_ notebookId: String) throws -> URL {
        guard Self.isValidId(notebookId) else { throw StoreError("unsafe notebook id \(notebookId)") }
        return replicasDirectory(root).appendingPathComponent("\(notebookId).json")
    }

    /// Returns the saved replica, or a fresh empty one for a notebook this
    /// device has not opened before.
    public func loadReplica(_ notebookId: String) throws -> NotebookReplica {
        let url = try replicaURL(notebookId)
        guard let data = try? Data(contentsOf: url) else { return NotebookReplica(notebookId: notebookId) }
        do {
            return try JSONDecoder().decode(NotebookReplica.self, from: data)
        } catch {
            throw StoreError("replica for \(notebookId) is unreadable: \(error)")
        }
    }

    public func saveReplica(_ replica: NotebookReplica) throws {
        try writeAtomically(try encode(replica), to: try replicaURL(replica.notebookId))
    }

    public func replicaIds() throws -> [String] {
        let contents = (try? fileManager.contentsOfDirectory(atPath: replicasDirectory(root).path)) ?? []
        return contents.filter { $0.hasSuffix(".json") }.map { String($0.dropLast(5)) }.sorted()
    }

    // MARK: - PDF cache

    public func pdfURL(_ pdfId: String) throws -> URL {
        guard Self.isValidId(pdfId) else { throw StoreError("unsafe pdf id \(pdfId)") }
        return pdfsDirectory(root).appendingPathComponent("\(pdfId).pdf")
    }

    public func hasPdf(_ pdfId: String) -> Bool {
        guard let url = try? pdfURL(pdfId) else { return false }
        return fileManager.fileExists(atPath: url.path)
    }

    /// Caches the bytes and verifies them against the digest the server
    /// published, so a truncated download fails here rather than as an
    /// unreadable document later.
    @discardableResult
    public func savePdf(_ bytes: Data, for document: PdfDocument) throws -> URL {
        let actual = Digest.sha256Hex(bytes)
        guard actual == document.sha256 else {
            throw StoreError("pdf \(document.id) hashed \(actual) but the server published \(document.sha256)")
        }
        let url = try pdfURL(document.id)
        try writeAtomically(bytes, to: url)
        return url
    }

    public func loadPdf(_ pdfId: String) throws -> Data? {
        try? Data(contentsOf: try pdfURL(pdfId))
    }

    // MARK: - Atomic writes

    /// Canonical bytes, so an unchanged record rewrites identically and a diff
    /// of the store is a diff of its meaning.
    private func encode<T: Encodable>(_ value: T) throws -> Data {
        try JSONValue(encoding: value).canonicalData()
    }

    private func writeAtomically(_ data: Data, to url: URL) throws {
        let temporary = url.deletingLastPathComponent()
            .appendingPathComponent(".\(url.lastPathComponent).\(UUID().uuidString).tmp")
        try data.write(to: temporary, options: fsync ? [.atomic] : [])
        if fsync {
            let handle = try FileHandle(forWritingTo: temporary)
            try handle.synchronize()
            try handle.close()
        }
        _ = try fileManager.replaceItemAt(url, withItemAt: temporary)
    }

    /// The shared `ID` schema: what the server accepts is also what is safe as
    /// a path component, since the pattern excludes `/`, `..` and whitespace.
    public static func isValidId(_ id: String) -> Bool {
        guard !id.isEmpty, id.count <= 128 else { return false }
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_:.@-")
        return id.unicodeScalars.allSatisfy { allowed.contains($0) } && id != "." && id != ".."
    }
}

private func replicasDirectory(_ root: URL) -> URL {
    root.appendingPathComponent("replicas", isDirectory: true)
}

private func pdfsDirectory(_ root: URL) -> URL {
    root.appendingPathComponent("pdfs", isDirectory: true)
}
