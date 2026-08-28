import Foundation

/// What the notebook screen shows about its connection to the server.
public enum SyncStatus: Equatable, Sendable {
    case idle
    case syncing
    case synced(at: Int64)
    /// The request never reached the server; `pending` edits are safe locally.
    case offline(pending: Int)
    case failed(String)
}

public struct SyncOutcome: Equatable, Sendable {
    public var status: SyncStatus
    public var accepted: Int
    public var rejected: [RejectedOperation]
    public var mode: SyncMode?
    /// True while the outbox still holds work the server has not acknowledged.
    public var hasPending: Bool

    public init(status: SyncStatus, accepted: Int, rejected: [RejectedOperation], mode: SyncMode?, hasPending: Bool) {
        self.status = status
        self.accepted = accepted
        self.rejected = rejected
        self.mode = mode
        self.hasPending = hasPending
    }
}

/// A draft stroke as a pen hands it over, before it is given an identity.
public struct InkStrokeDraft: Hashable, Sendable {
    public var color: String
    public var width: Int
    public var points: [Int]

    public init(color: String, width: Int, points: [Int]) {
        self.color = color
        self.width = width
        self.points = points
    }
}

/// One notebook's replica: authors operations locally, folds them immediately
/// so the UI never waits for the network, and reconciles with the server when
/// it can.
///
/// Every local edit is durable before it is visible: `persist()` runs inside
/// the mutation, not after the sync. An edit made in airplane mode is on disk
/// by the time the view redraws.
public final class SyncEngine {
    public let notebookId: String
    public let deviceId: String
    private let store: LocalStore
    private let api: APIClient
    private let now: () -> Int64

    private var replica: NotebookReplica
    private var cachedView: Materialized?

    public private(set) var status: SyncStatus = .idle

    public init(
        notebookId: String,
        store: LocalStore,
        api: APIClient,
        deviceId: String,
        now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
    ) throws {
        self.notebookId = notebookId
        self.store = store
        self.api = api
        self.deviceId = deviceId
        self.now = now
        self.replica = try store.loadReplica(notebookId)
    }

    // MARK: - Reading

    public var cursor: Int { replica.cursor }
    public var pendingCount: Int { replica.outbox.count }
    public var rejected: [RejectedOperation] { replica.rejected }
    public var lastSyncedAt: Int64? { replica.lastSyncedAt }
    public var outbox: [Operation] { replica.outbox }
    public var state: FoldState { replica.state }

    public func view() throws -> Materialized {
        if let cachedView { return cachedView }
        let view = try Reconcile.materialize(replica.state)
        cachedView = view
        return view
    }

    public func notebook() throws -> Notebook? {
        try view().decode(Notebook.self, of: .notebook).first { $0.id == notebookId }
    }

    /// Notes in the order the notebook shows them: by position, then by id so
    /// two devices that pick the same position still agree on the order.
    public func notes() throws -> [Note] {
        try view().decode(Note.self, of: .note).sorted {
            $0.position != $1.position ? $0.position < $1.position : JSONValue.utf16Ascending($0.id, $1.id)
        }
    }

    public func note(_ id: String) throws -> Note? {
        try notes().first { $0.id == id }
    }

    public func pdfs() throws -> [PdfDocument] {
        try view().decode(PdfDocument.self, of: .pdf).sorted { JSONValue.utf16Ascending($0.id, $1.id) }
    }

    public func annotations(pdfId: String) throws -> [Annotation] {
        try view().decode(Annotation.self, of: .annotation)
            .filter { $0.pdfId == pdfId }
            .sorted { $0.page != $1.page ? $0.page < $1.page : JSONValue.utf16Ascending($0.id, $1.id) }
    }

    public func strokes(targetKind: StrokeTargetKind, targetId: String, page: Int? = nil) throws -> [InkStroke] {
        try view().decode(InkStroke.self, of: .stroke)
            .filter { $0.targetKind == targetKind && $0.targetId == targetId && (page == nil || $0.page == page) }
            .sorted { $0.createdAt != $1.createdAt ? $0.createdAt < $1.createdAt : JSONValue.utf16Ascending($0.id, $1.id) }
    }

    public func conflicts() throws -> [Conflict] {
        try view().conflicts
    }

    public func tombstones() throws -> [Tombstone] {
        try view().tombstones
    }

    // MARK: - Writing

    public func createNote(title: String, body: String = "", position: Double? = nil) throws -> Note {
        let at = now()
        let id = Self.newId("note")
        try commit([
            Draft(kind: .note, id: id, fields: [
                "title": .string(title),
                "body": .string(body),
                "position": .number(position ?? Double(at)),
                "createdAt": .int(at),
                "updatedAt": .int(at),
            ]),
        ])
        guard let note = try note(id) else { throw ContractError("note \(id) did not materialize") }
        return note
    }

    /// Writes only the fields that were supplied. Partial writes are the point:
    /// two devices editing different fields of the same note both keep their
    /// work, and only a genuine same-field race becomes a conflict.
    public func updateNote(_ id: String, title: String? = nil, body: String? = nil, position: Double? = nil) throws {
        var fields: [String: JSONValue] = [:]
        if let title { fields["title"] = .string(title) }
        if let body { fields["body"] = .string(body) }
        if let position { fields["position"] = .number(position) }
        guard !fields.isEmpty else { return }
        fields["updatedAt"] = .int(now())
        try commit([Draft(kind: .note, id: id, fields: fields)])
    }

    public func deleteNote(_ id: String) throws {
        try commit([Draft(kind: .note, id: id, delete: true)])
    }

    public func updateNotebook(title: String? = nil, color: String? = nil) throws {
        var fields: [String: JSONValue] = [:]
        if let title { fields["title"] = .string(title) }
        if let color { fields["color"] = .string(color) }
        guard !fields.isEmpty else { return }
        fields["updatedAt"] = .int(now())
        try commit([Draft(kind: .notebook, id: notebookId, fields: fields)])
    }

    @discardableResult
    public func addHighlight(pdfId: String, page: Int, rect: Rect, color: String = "#ffd60a", text: String? = nil) throws -> Annotation {
        let at = now()
        let id = Self.newId("anno")
        try commit([
            Draft(kind: .annotation, id: id, fields: [
                "pdfId": .string(pdfId),
                "page": .int(Int64(page)),
                "kind": .string(AnnotationKind.highlight.rawValue),
                "rect": try JSONValue(encoding: rect),
                "color": .string(color),
                "text": text.map { JSONValue.string($0) } ?? .null,
                "strokeId": .null,
                "createdAt": .int(at),
                "updatedAt": .int(at),
            ]),
        ])
        guard let annotation = try annotations(pdfId: pdfId).first(where: { $0.id == id }) else {
            throw ContractError("annotation \(id) did not materialize")
        }
        return annotation
    }

    /// A note anchored to a point on a page.
    @discardableResult
    public func addNoteAnnotation(pdfId: String, page: Int, rect: Rect, text: String, color: String = "#ffd60a") throws -> Annotation {
        let at = now()
        let id = Self.newId("anno")
        try commit([
            Draft(kind: .annotation, id: id, fields: [
                "pdfId": .string(pdfId),
                "page": .int(Int64(page)),
                "kind": .string(AnnotationKind.note.rawValue),
                "rect": try JSONValue(encoding: rect),
                "color": .string(color),
                "text": .string(text),
                "strokeId": .null,
                "createdAt": .int(at),
                "updatedAt": .int(at),
            ]),
        ])
        guard let annotation = try annotations(pdfId: pdfId).first(where: { $0.id == id }) else {
            throw ContractError("annotation \(id) did not materialize")
        }
        return annotation
    }

    public func updateAnnotation(_ id: String, rect: Rect? = nil, color: String? = nil, text: String?? = nil) throws {
        var fields: [String: JSONValue] = [:]
        if let rect { fields["rect"] = try JSONValue(encoding: rect) }
        if let color { fields["color"] = .string(color) }
        if let text { fields["text"] = text.map { JSONValue.string($0) } ?? .null }
        guard !fields.isEmpty else { return }
        fields["updatedAt"] = .int(now())
        try commit([Draft(kind: .annotation, id: id, fields: fields)])
    }

    public func deleteAnnotation(_ id: String) throws {
        var drafts = [Draft(kind: .annotation, id: id, delete: true)]
        if let annotation = try view().decode(Annotation.self, of: .annotation).first(where: { $0.id == id }),
           let strokeId = annotation.strokeId {
            drafts.append(Draft(kind: .stroke, id: strokeId, delete: true))
        }
        try commit(drafts)
    }

    /// Replaces the ink on one target with exactly `drafts`.
    ///
    /// PencilKit hands over a whole drawing rather than a delta, so the engine
    /// diffs it. Stroke ids are the hash of the stroke's own content, which
    /// makes saving an unchanged canvas a no-op instead of a fresh operation
    /// every time the view disappears.
    @discardableResult
    public func setInk(
        targetKind: StrokeTargetKind,
        targetId: String,
        page: Int?,
        drafts: [InkStrokeDraft]
    ) throws -> [InkStroke] {
        let at = now()
        let existing = try strokes(targetKind: targetKind, targetId: targetId, page: page)
        var wanted: [String: InkStrokeDraft] = [:]
        for draft in drafts {
            wanted[try Self.strokeId(targetKind: targetKind, targetId: targetId, page: page, draft: draft)] = draft
        }

        var commits: [Draft] = []
        for stroke in existing where wanted[stroke.id] == nil {
            commits.append(Draft(kind: .stroke, id: stroke.id, delete: true))
        }
        let present = Set(existing.map(\.id))
        for id in wanted.keys.sorted(by: JSONValue.utf16Ascending) where !present.contains(id) {
            let draft = wanted[id]!
            commits.append(Draft(kind: .stroke, id: id, fields: [
                "targetKind": .string(targetKind.rawValue),
                "targetId": .string(targetId),
                "page": page.map { JSONValue.int(Int64($0)) } ?? .null,
                "color": .string(draft.color),
                "width": .int(Int64(draft.width)),
                "points": .array(draft.points.map { .int(Int64($0)) }),
                "createdAt": .int(at),
            ]))
        }
        if !commits.isEmpty { try commit(commits) }
        return try strokes(targetKind: targetKind, targetId: targetId, page: page)
    }

    /// An ink annotation on a PDF page: the stroke carries the geometry, the
    /// annotation carries the page anchor and points at it.
    @discardableResult
    public func addInkAnnotation(pdfId: String, page: Int, draft: InkStrokeDraft) throws -> (Annotation, InkStroke) {
        let at = now()
        let strokeId = try Self.strokeId(targetKind: .pdf, targetId: pdfId, page: page, draft: draft)
        let annotationId = Self.newId("anno")
        try commit([
            Draft(kind: .stroke, id: strokeId, fields: [
                "targetKind": .string(StrokeTargetKind.pdf.rawValue),
                "targetId": .string(pdfId),
                "page": .int(Int64(page)),
                "color": .string(draft.color),
                "width": .int(Int64(draft.width)),
                "points": .array(draft.points.map { .int(Int64($0)) }),
                "createdAt": .int(at),
            ]),
            Draft(kind: .annotation, id: annotationId, fields: [
                "pdfId": .string(pdfId),
                "page": .int(Int64(page)),
                "kind": .string(AnnotationKind.ink.rawValue),
                "rect": .null,
                "color": .string(draft.color),
                "text": .null,
                "strokeId": .string(strokeId),
                "createdAt": .int(at),
                "updatedAt": .int(at),
            ]),
        ])
        guard let annotation = try annotations(pdfId: pdfId).first(where: { $0.id == annotationId }),
              let stroke = try strokes(targetKind: .pdf, targetId: pdfId).first(where: { $0.id == strokeId })
        else { throw ContractError("ink annotation \(annotationId) did not materialize") }
        return (annotation, stroke)
    }

    // MARK: - Syncing

    /// Pushes the outbox and pulls everything after the cursor.
    ///
    /// Never throws: a sync failure is a state the notebook screen displays,
    /// not an error that loses the edit that triggered it.
    @discardableResult
    public func sync() async -> SyncOutcome {
        status = .syncing
        let request = SyncRequest(
            deviceId: deviceId,
            notebookId: notebookId,
            cursor: replica.cursor,
            ops: Array(replica.outbox.prefix(SyncRequest.maxOpsPerRequest))
        )
        do {
            let response = try await api.sync(request)
            try ingest(response)
            let at = now()
            replica.lastSyncedAt = at
            try persist()
            status = replica.outbox.isEmpty ? .synced(at: at) : .offline(pending: replica.outbox.count)
            return SyncOutcome(
                status: status,
                accepted: response.accepted.count,
                rejected: response.rejected,
                mode: response.mode,
                hasPending: !replica.outbox.isEmpty
            )
        } catch let error as APIError where error.isOffline {
            status = .offline(pending: replica.outbox.count)
            return SyncOutcome(status: status, accepted: 0, rejected: [], mode: nil, hasPending: !replica.outbox.isEmpty)
        } catch {
            let message = (error as? APIError)?.userMessage ?? "\(error)"
            status = .failed(message)
            return SyncOutcome(status: status, accepted: 0, rejected: [], mode: nil, hasPending: !replica.outbox.isEmpty)
        }
    }

    /// Applies a sync response. Split out from `sync()` so the reconciliation
    /// rules are testable without a transport.
    public func ingest(_ response: SyncResponse) throws {
        guard response.notebookId == notebookId else {
            throw ContractError("sync response is for notebook \(response.notebookId), not \(notebookId)")
        }

        // The server has taken responsibility for these, either way: an
        // accepted operation is in the log, and a rejected one will never be.
        let settled = Set(response.accepted).union(response.rejected.map(\.opId))
        let unsent = replica.outbox.filter { !settled.contains($0.opId) }
        replica.outbox = unsent
        if !response.rejected.isEmpty {
            replica.rejected = (replica.rejected + response.rejected).suffix(50)
        }

        switch response.mode {
        case .delta:
            replica.state = try Reconcile.reconcile(replica.state, incoming: response.ops)
        case .snapshot:
            // Our cursor predates the server's checkpoint, so local history is
            // not enough to catch up. Adopt the server state, then re-fold the
            // operations it has not seen — otherwise a snapshot would silently
            // discard work still sitting in the outbox.
            guard let state = response.state else {
                throw ContractError("sync response claimed a snapshot but carried no state")
            }
            replica.state = try Reconcile.fold(unsent, base: state)
        }

        replica.cursor = response.cursor
        replica.lamport = max(replica.lamport, max(response.serverLamport, replica.state.lamport))
        cachedView = nil
    }

    /// Adopts the state a first open of the notebook fetched over REST.
    public func adoptCursor(_ cursor: Int) throws {
        replica.cursor = max(replica.cursor, cursor)
        try persist()
    }

    // MARK: - Internals

    struct Draft {
        var kind: SyncedKind
        var id: String
        var fields: [String: JSONValue] = [:]
        var delete: Bool = false
    }

    /// Authors, folds and persists a batch atomically in memory: either every
    /// operation is in the outbox and the state, or the batch throws before any
    /// of it is written.
    private func commit(_ drafts: [Draft]) throws {
        var lamport = replica.lamport
        var seq = replica.seq
        var authored: [Operation] = []
        let at = now()

        for draft in drafts {
            let basis = max(lamport, replica.state.lamport)
            lamport = basis + 1
            let op = try Ops.create(
                Ops.NewOperation(
                    entityKind: draft.kind,
                    entityId: draft.id,
                    notebookId: notebookId,
                    kind: draft.delete ? .delete : .set,
                    fields: draft.fields,
                    actor: deviceId,
                    lamport: lamport,
                    seq: seq,
                    basis: basis,
                    at: at
                )
            )
            try Ops.assertClientWritable(op)
            authored.append(op)
            seq += 1
        }

        var state = replica.state
        for op in authored { Reconcile.apply(op, to: &state) }

        replica.state = state
        replica.lamport = max(lamport, state.lamport)
        replica.seq = seq
        replica.outbox.append(contentsOf: authored)
        cachedView = nil
        try persist()
    }

    public func persist() throws {
        try store.saveReplica(replica)
    }

    static func newId(_ prefix: String) -> String {
        "\(prefix)_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    }

    /// Content-addressed, so the same drawing saved twice produces the same id.
    static func strokeId(targetKind: StrokeTargetKind, targetId: String, page: Int?, draft: InkStrokeDraft) throws -> String {
        let body = JSONValue.array([
            .string(targetKind.rawValue),
            .string(targetId),
            page.map { JSONValue.int(Int64($0)) } ?? .null,
            .string(draft.color),
            .int(Int64(draft.width)),
            .array(draft.points.map { .int(Int64($0)) }),
        ])
        return "ink_" + String(try Digest.hashJSON(body).prefix(28))
    }
}
