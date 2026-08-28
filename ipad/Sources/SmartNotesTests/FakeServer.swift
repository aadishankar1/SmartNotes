import Foundation
import SmartNotesKit

/// An in-process stand-in for `POST /v1/sync`.
///
/// It enforces the same three rules the real server enforces on an incoming
/// operation — right notebook, actor equal to the syncing device, no
/// server-owned fields — and folds the accepted log with the shared
/// reconciler. That is enough to exercise the client's half of the contract
/// without a socket, which matters because the sandboxes this is built in
/// cannot bind one.
final class FakeServer: @unchecked Sendable {
    let notebookId: String
    private(set) var ops: [Operation] = []
    /// Cursors at or below this need a snapshot rather than a delta; set it to
    /// simulate a client that has been away longer than the server's log.
    var checkpoint = 0
    private(set) var requests: [SyncRequest] = []

    init(notebookId: String) {
        self.notebookId = notebookId
    }

    func sync(_ request: SyncRequest) throws -> SyncResponse {
        requests.append(request)
        var accepted: [String] = []
        var rejected: [RejectedOperation] = []

        for op in request.ops {
            if let reason = rejection(op, deviceId: request.deviceId) {
                rejected.append(RejectedOperation(opId: op.opId, reason: reason))
                continue
            }
            if !ops.contains(where: { $0.opId == op.opId }) { ops.append(op) }
            accepted.append(op.opId)
        }

        let state = try Reconcile.fold(ops)
        let view = try Reconcile.materialize(state)
        let common = (
            cursor: ops.count,
            accepted: accepted,
            rejected: rejected,
            tombstones: view.tombstones,
            conflicts: view.conflicts,
            lamport: state.lamport
        )

        if request.cursor < checkpoint {
            return SyncResponse(
                notebookId: notebookId, cursor: common.cursor, mode: .snapshot, ops: [], state: state,
                accepted: common.accepted, rejected: common.rejected,
                tombstones: common.tombstones, conflicts: common.conflicts, serverLamport: common.lamport
            )
        }
        let from = min(max(0, request.cursor), ops.count)
        return SyncResponse(
            notebookId: notebookId, cursor: common.cursor, mode: .delta, ops: Array(ops[from...]), state: nil,
            accepted: common.accepted, rejected: common.rejected,
            tombstones: common.tombstones, conflicts: common.conflicts, serverLamport: common.lamport
        )
    }

    private func rejection(_ op: Operation, deviceId: String) -> String? {
        if op.notebookId != notebookId { return "operation targets a different notebook" }
        if op.actor != deviceId { return "operation actor does not match the syncing device" }
        if (try? Ops.validate(op)) == nil { return "invalid operation" }
        if op.kind == .set {
            let allowed = op.entityKind.writableFields
            for field in op.fields.keys where !allowed.contains(field) {
                return "field \(field) is not client-writable on \(op.entityKind.rawValue)"
            }
        }
        return nil
    }
}

/// Routes the handful of endpoints the client uses to a `FakeServer`, and can
/// be flipped offline to exercise the queueing path.
final class FakeTransport: Transport, @unchecked Sendable {
    let server: FakeServer
    var offline = false
    /// Set to fail every request with a server error instead of an outage.
    var failure: (status: Int, code: String, message: String)?
    /// What `GET /v1/notebooks` returns. The server owns `ownerId`, so a
    /// notebook only ever comes into existence here.
    var notebooks: [Notebook] = []

    init(server: FakeServer) {
        self.server = server
    }

    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        if offline { throw APIError.offline("simulated outage") }
        if let failure {
            let body = try JSONEncoder().encode(ErrorBody(code: failure.code, message: failure.message))
            return HTTPResponse(status: failure.status, body: body)
        }

        switch (request.method, request.path) {
        case ("POST", "\(API.prefix)/sync"):
            guard let body = request.body else { throw APIError.malformed("sync without a body") }
            let decoded = try JSONDecoder().decode(SyncRequest.self, from: body)
            let response = try server.sync(decoded)
            return HTTPResponse(status: 200, body: try JSONEncoder().encode(response))
        case ("GET", "\(API.prefix)/me"):
            let user = User(schemaVersion: SCHEMA_VERSION, id: "usr_alice", email: "alice@example.com", displayName: "Alice Nakamura", createdAt: 0)
            return HTTPResponse(status: 200, body: try JSONEncoder().encode(UserProbe(user: user)))
        case ("GET", "\(API.prefix)/notebooks"):
            return HTTPResponse(status: 200, body: try JSONEncoder().encode(NotebooksProbe(notebooks: notebooks)))
        case ("POST", "\(API.prefix)/notebooks"):
            guard let body = request.body,
                  let requested = try? JSONDecoder().decode(NotebookCreateProbe.self, from: body)
            else { throw APIError.malformed("notebook create without a body") }
            let notebook = Notebook(
                id: "nb_\(notebooks.count + 1)",
                ownerId: "usr_alice",
                title: requested.title,
                color: requested.color,
                createdAt: 0,
                updatedAt: 0
            )
            notebooks.append(notebook)
            return HTTPResponse(status: 201, body: try JSONEncoder().encode(NotebookProbe(notebook: notebook)))
        default:
            let body = try JSONEncoder().encode(ErrorBody(code: "not_found", message: "no route for \(request.method) \(request.path)"))
            return HTTPResponse(status: 404, body: body)
        }
    }

    private struct UserProbe: Codable {
        var user: User
    }

    private struct NotebooksProbe: Codable {
        var notebooks: [Notebook]
    }

    private struct NotebookProbe: Codable {
        var notebook: Notebook
    }

    private struct NotebookCreateProbe: Codable {
        var title: String
        var color: String?
    }
}
