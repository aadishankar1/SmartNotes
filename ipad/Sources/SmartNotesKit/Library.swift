import Combine
import Foundation

/// The screens' state machine, kept out of SwiftUI so it can be tested on a
/// machine with no simulator.
///
/// `Combine` is imported for `ObservableObject` only; nothing here touches a UI
/// framework, which is what lets the whole app layer run under the plain
/// executable test suite.

/// What the notebook list is showing. The distinction that matters is between
/// "nothing yet" and "nothing at all": a first launch shows a spinner, an
/// account with no notebooks shows an invitation to make one, and a failed
/// load with a cache behind it shows the cache plus a banner rather than an
/// error page that hides work the user can still read.
public enum LibraryPhase: Equatable, Sendable {
    case signedOut
    case loading
    case empty
    case ready
    /// Loading failed and there is nothing cached to fall back to.
    case failed(String)
}

/// The one-line status the notebook screens show above their content.
public enum StatusBanner: Equatable, Sendable {
    case syncing
    case synced(at: Int64)
    /// The server was unreachable; `pending` local edits are safe on disk.
    case offline(pending: Int)
    case failed(String)
    /// Concurrent same-field writes the server settled; the losing values are
    /// kept so the user can put them back.
    case conflicts(count: Int)
    /// Operations the server refused. These never land, so saying so is the
    /// only honest option.
    case rejected(count: Int, reason: String)

    public var message: String {
        switch self {
        case .syncing:
            return "Syncing…"
        case let .synced(at):
            return "All changes synced \(StatusBanner.time(at))"
        case let .offline(pending):
            return pending == 0
                ? "Offline. This notebook is up to date on this iPad."
                : "Offline. \(pending) \(pending == 1 ? "change is" : "changes are") saved here and will sync when you reconnect."
        case let .failed(message):
            return message
        case let .conflicts(count):
            return "\(count) \(count == 1 ? "edit" : "edits") from another device conflicted. Review the versions that were replaced."
        case let .rejected(count, reason):
            return "The server refused \(count) \(count == 1 ? "change" : "changes"): \(reason)"
        }
    }

    /// Conflicts and rejections outrank a plain sync result: they are the only
    /// two the user has to act on.
    public var isActionable: Bool {
        switch self {
        case .conflicts, .rejected, .failed: return true
        case .syncing, .synced, .offline: return false
        }
    }

    static func time(_ millis: Int64) -> String {
        let formatter = DateFormatter()
        formatter.timeStyle = .short
        formatter.dateStyle = .none
        return formatter.string(from: Date(timeIntervalSince1970: TimeInterval(millis) / 1000))
    }
}

/// Signed-in state, the notebook list, and the factory for per-notebook
/// sessions.
///
/// The list is served from the local cache first and refreshed from the server
/// second, so the app opens to content in airplane mode rather than to a
/// spinner that never resolves.
@MainActor
public final class Library: ObservableObject {
    @Published public private(set) var phase: LibraryPhase = .signedOut
    @Published public private(set) var notebooks: [Notebook] = []
    @Published public private(set) var session: Session?
    /// Set when the last server call never reached the server. The cached list
    /// stays on screen underneath it.
    @Published public private(set) var offline = false
    /// A failure that must not replace the content, e.g. a refresh that failed
    /// while a cached list is showing.
    @Published public private(set) var notice: String?

    public let store: LocalStore
    public let deviceId: String
    private let makeTransport: (URL) -> Transport
    private let now: () -> Int64
    private var api: APIClient?

    public init(
        store: LocalStore,
        makeTransport: @escaping (URL) -> Transport = { URLSessionTransport(baseURL: $0) },
        now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
    ) throws {
        self.store = store
        self.makeTransport = makeTransport
        self.now = now
        self.deviceId = try store.deviceId()
    }

    // MARK: - Authentication

    /// Restores a saved session without a network call, so a relaunch in
    /// airplane mode still opens the user's notebooks.
    public func restore() throws {
        guard let saved = try store.loadSession(), let url = URL(string: saved.baseURL) else {
            phase = .signedOut
            return
        }
        session = saved
        api = APIClient(transport: makeTransport(url), token: saved.token)
        notebooks = try store.loadNotebooks()
        phase = notebooks.isEmpty ? .loading : .ready
    }

    /// The MVP has no signup: the user pastes a server-issued API token, and
    /// this call is the identity probe that turns it into a session.
    public func signIn(baseURL: String, token: String) async -> Bool {
        let trimmed = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed), url.scheme != nil else {
            notice = "Enter the server address as a full URL, for example https://smartnotes.example.com"
            return false
        }
        phase = .loading
        notice = nil
        let client = APIClient(transport: makeTransport(url), token: token.trimmingCharacters(in: .whitespacesAndNewlines))
        do {
            let user = try await client.me()
            let session = Session(baseURL: trimmed, token: client.token ?? token, user: user)
            try store.saveSession(session)
            self.session = session
            self.api = client
            self.notebooks = try store.loadNotebooks()
            self.offline = false
            await refresh()
            return true
        } catch {
            phase = .signedOut
            notice = (error as? APIError)?.userMessage ?? "\(error)"
            return false
        }
    }

    public func signOut() throws {
        try store.clearSession()
        session = nil
        api = nil
        notebooks = []
        offline = false
        notice = nil
        phase = .signedOut
    }

    // MARK: - Notebooks

    /// Pulls the notebook list. A failure never empties the screen: the cached
    /// list stays and the failure becomes a banner.
    public func refresh() async {
        guard let api else { return }
        if notebooks.isEmpty { phase = .loading }
        do {
            let fetched = try await api.notebooks()
            try store.saveNotebooks(fetched)
            notebooks = fetched
            offline = false
            notice = nil
            phase = fetched.isEmpty ? .empty : .ready
        } catch let error as APIError where error.isOffline {
            offline = true
            notice = error.userMessage
            phase = notebooks.isEmpty ? .empty : .ready
        } catch {
            let message = (error as? APIError)?.userMessage ?? "\(error)"
            notice = message
            phase = notebooks.isEmpty ? .failed(message) : .ready
        }
    }

    /// Creating a notebook is a REST call, not an operation, because the server
    /// owns `ownerId`. It therefore needs the network, and says so rather than
    /// queueing something it cannot honour.
    public func createNotebook(title: String, color: String? = nil) async -> Notebook? {
        guard let api else { return nil }
        do {
            let notebook = try await api.createNotebook(title: title, color: color)
            notebooks.append(notebook)
            try store.saveNotebooks(notebooks)
            phase = .ready
            offline = false
            notice = nil
            return notebook
        } catch let error as APIError where error.isOffline {
            offline = true
            notice = "New notebooks need a connection. Your existing notebooks still work offline."
            return nil
        } catch {
            notice = (error as? APIError)?.userMessage ?? "\(error)"
            return nil
        }
    }

    public func open(_ notebook: Notebook) throws -> NotebookSession {
        guard let api else { throw StoreError("no signed-in session") }
        return try NotebookSession(
            notebook: notebook,
            engine: SyncEngine(notebookId: notebook.id, store: store, api: api, deviceId: deviceId, now: now),
            store: store,
            api: api
        )
    }
}

/// One open notebook: the folded view its screens render, the banner that
/// explains its connection, and the writes the screens perform.
///
/// Every mutation is durable before `reload()` publishes it, so what the view
/// shows is what is on disk — not a hopeful copy waiting on a sync.
@MainActor
public final class NotebookSession: ObservableObject {
    @Published public private(set) var notebook: Notebook
    @Published public private(set) var notes: [Note] = []
    @Published public private(set) var pdfs: [PdfDocument] = []
    @Published public private(set) var conflicts: [Conflict] = []
    @Published public private(set) var banner: StatusBanner?
    @Published public private(set) var isLoading = false
    /// A local write that failed. Distinct from a sync failure: the edit is
    /// not saved, so the user must be told rather than reassured.
    @Published public private(set) var writeError: String?

    public let engine: SyncEngine
    private let store: LocalStore
    private let api: APIClient

    init(notebook: Notebook, engine: SyncEngine, store: LocalStore, api: APIClient) throws {
        self.notebook = notebook
        self.engine = engine
        self.store = store
        self.api = api
        try reload()
    }

    public var isEmpty: Bool { notes.isEmpty && pdfs.isEmpty }
    public var pendingCount: Int { engine.pendingCount }

    /// Re-reads the fold. Cheap: the engine caches the materialisation and
    /// invalidates it on write.
    public func reload() throws {
        notes = try engine.notes()
        pdfs = try engine.pdfs()
        conflicts = try engine.conflicts()
        if let folded = try engine.notebook() {
            notebook = folded
        } else if let partial = try engine.view().invalid.first(
            where: { $0.kind == .notebook && $0.id == notebook.id }
        ), case let .object(fields) = partial.partial {
            // A notebook this device has only renamed — and not yet synced —
            // has no `ownerId` or `createdAt` in the log, because those are
            // server-owned and a client may not write them. So the fold reports
            // it as invalid rather than as an entity, and applying the fields
            // that *are* there is the difference between an offline rename
            // showing and not.
            if case let .string(title)? = fields["title"] { notebook.title = title }
            if case let .string(color)? = fields["color"] { notebook.color = color }
        }
    }

    /// Pushes the outbox, pulls the log, and turns the outcome into the one
    /// line the screen shows.
    public func sync() async {
        isLoading = true
        banner = .syncing
        let outcome = await engine.sync()
        try? reload()
        isLoading = false
        banner = Self.banner(for: outcome, conflicts: conflicts.count)
    }

    /// Conflicts and rejections win over the transport result, because they are
    /// the states that need the user rather than merely inform them.
    public nonisolated static func banner(for outcome: SyncOutcome, conflicts: Int) -> StatusBanner {
        if let rejection = outcome.rejected.first {
            return .rejected(count: outcome.rejected.count, reason: rejection.reason)
        }
        if case .failed(let message) = outcome.status { return .failed(message) }
        if conflicts > 0 { return .conflicts(count: conflicts) }
        switch outcome.status {
        case let .offline(pending): return .offline(pending: pending)
        case let .synced(at): return .synced(at: at)
        case .syncing: return .syncing
        case .idle: return .synced(at: 0)
        case let .failed(message): return .failed(message)
        }
    }

    // MARK: - Writing

    /// Wraps a local write so a failure becomes a visible message instead of a
    /// silently dropped edit.
    @discardableResult
    public func edit<T>(_ body: (SyncEngine) throws -> T) -> T? {
        do {
            let result = try body(engine)
            try reload()
            writeError = nil
            return result
        } catch {
            writeError = "That change could not be saved: \(error)"
            return nil
        }
    }

    /// Surfaces something the screen needs to say that is not the result of a
    /// write — "select some text first" — through the same channel as a failed
    /// write, so there is one place a message can appear.
    public func report(_ message: String) {
        writeError = message
    }

    public func createNote(title: String) -> Note? {
        edit { try $0.createNote(title: title) }
    }

    public func updateNote(_ id: String, title: String? = nil, body: String? = nil) {
        edit { try $0.updateNote(id, title: title, body: body) }
    }

    public func deleteNote(_ id: String) {
        edit { try $0.deleteNote(id) }
    }

    /// Renaming the notebook is an ordinary operation, so it works offline and
    /// reconciles per-field like any other edit.
    public func renameNotebook(_ title: String) {
        edit { try $0.updateNotebook(title: title) }
    }

    // MARK: - PDFs

    /// Returns the cached bytes, or downloads and caches them. The cache is
    /// verified against the digest the server published, so a truncated
    /// download fails here rather than as an unreadable document.
    public func pdfData(_ document: PdfDocument) async throws -> Data {
        if let cached = try store.loadPdf(document.id), Digest.sha256Hex(cached) == document.sha256 {
            return cached
        }
        let bytes = try await api.pdfContent(document.id)
        try store.savePdf(bytes, for: document)
        return bytes
    }

    /// Uploads a PDF over REST, because the server owns its digest and byte
    /// size. The server records it as an operation in this notebook's log, so
    /// the following sync is what actually puts it on screen — here and on
    /// every other device.
    public func importPdf(filename: String, bytes: Data) async -> PdfDocument? {
        do {
            let document = try await api.uploadPdf(
                notebookId: engine.notebookId,
                filename: filename,
                bytes: bytes,
                pageCount: nil
            )
            // Caching now also checks the bytes against the digest the server
            // computed, so a mangled upload is caught immediately.
            try store.savePdf(bytes, for: document)
            await sync()
            writeError = nil
            return document
        } catch let error as APIError where error.isOffline {
            writeError = "Adding a PDF needs a connection. Your notes still work offline."
            return nil
        } catch {
            writeError = "That PDF could not be added: \((error as? APIError)?.userMessage ?? "\(error)")"
            return nil
        }
    }

    public func isPdfAvailableOffline(_ document: PdfDocument) -> Bool {
        store.hasPdf(document.id)
    }

    public func annotations(for document: PdfDocument) throws -> [Annotation] {
        try engine.annotations(pdfId: document.id)
    }

    public func strokes(for document: PdfDocument) throws -> [InkStroke] {
        try engine.strokes(targetKind: .pdf, targetId: document.id)
    }

    /// The losing side of a conflict, offered back as a fresh edit. Nothing is
    /// discarded automatically; restoring is the user's call.
    public func restore(_ conflict: Conflict) {
        guard let loser = conflict.losers.first else { return }
        edit { engine in
            switch (conflict.entityKind, conflict.field) {
            case (.note, "title"):
                if case let .string(value) = loser.value { try engine.updateNote(conflict.entityId, title: value) }
            case (.note, "body"):
                if case let .string(value) = loser.value { try engine.updateNote(conflict.entityId, body: value) }
            case (.notebook, "title"):
                if case let .string(value) = loser.value { try engine.updateNotebook(title: value) }
            default:
                break
            }
        }
    }
}
