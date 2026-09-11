import Foundation
import SmartNotesKit

/// The client half of the sync contract: what the engine sends, what it does
/// with each kind of answer, and what happens when there is no answer at all.
func runSyncTests(_ runner: TestRunner) async {
    runner.suite("synchronisation")

    struct Device {
        let engine: SyncEngine
        let transport: FakeTransport
        let store: LocalStore
        let temporary: TemporaryDirectory
    }

    func makeDevice(_ deviceId: String, server: FakeServer, at time: Int64 = 1_767_225_600_000) throws -> Device {
        let temporary = try TemporaryDirectory()
        let store = try LocalStore(root: temporary.url, fsync: false)
        let transport = FakeTransport(server: server)
        let engine = try SyncEngine(
            notebookId: server.notebookId,
            store: store,
            api: APIClient(transport: transport, token: "tok_test"),
            deviceId: deviceId,
            now: { time }
        )
        return Device(engine: engine, transport: transport, store: store, temporary: temporary)
    }

    await runner.test("a successful sync drains the outbox and advances the cursor") {
        let server = FakeServer(notebookId: "nb_field")
        let device = try makeDevice("dev_ipad", server: server)
        _ = try device.engine.createNote(title: "Kickoff", body: "notes")
        try expectEqual(device.engine.pendingCount, 1, "queued before sync")

        let outcome = await device.engine.sync()
        try expectEqual(outcome.rejected, [], "nothing should be rejected")
        try expectEqual(outcome.accepted, 1, "accepted count")
        try expectEqual(outcome.mode, .delta, "mode")
        try expect(!outcome.hasPending, "outbox should be empty after a clean sync")
        try expectEqual(device.engine.cursor, 1, "cursor")
        if case .synced = device.engine.status {} else { throw Failure("status should be synced, got \(device.engine.status)") }
    }

    await runner.test("an offline sync keeps the work and reports the pending count") {
        let server = FakeServer(notebookId: "nb_field")
        let device = try makeDevice("dev_ipad", server: server)
        device.transport.offline = true

        _ = try device.engine.createNote(title: "Written on the train")
        let outcome = await device.engine.sync()

        try expectEqual(outcome.status, .offline(pending: 1), "status")
        try expect(outcome.hasPending, "pending work must be reported")
        try expectEqual(device.engine.pendingCount, 1, "outbox retained")
        // The edit is still readable — offline is not a degraded read mode.
        try expectEqual(try device.engine.notes().first?.title, "Written on the train", "local read while offline")

        device.transport.offline = false
        let recovered = await device.engine.sync()
        try expect(!recovered.hasPending, "the queued edit should go up once the network returns")
        try expectEqual(try device.engine.notes().count, 1, "note survives the reconnect")
    }

    await runner.test("a server error is surfaced without losing the edit") {
        let server = FakeServer(notebookId: "nb_field")
        let device = try makeDevice("dev_ipad", server: server)
        device.transport.failure = (status: 500, code: "internal_error", message: "storage is unavailable")

        _ = try device.engine.createNote(title: "Kickoff")
        let outcome = await device.engine.sync()

        try expectEqual(outcome.status, .failed("storage is unavailable"), "status carries the server's message")
        try expectEqual(device.engine.pendingCount, 1, "the edit stays queued")
    }

    await runner.test("a rejected operation is reported and not retried forever") {
        let server = FakeServer(notebookId: "nb_field")
        let device = try makeDevice("dev_impostor", server: server)
        _ = try device.engine.createNote(title: "Kickoff")

        // A second device syncs the first device's operations: the server
        // refuses them because the actor does not match the caller.
        let borrowed = SyncRequest(
            deviceId: "dev_other",
            notebookId: "nb_field",
            cursor: 0,
            ops: device.engine.outbox
        )
        let response = try server.sync(borrowed)
        try expectEqual(response.rejected.count, 1, "server should refuse a borrowed actor")

        try device.engine.ingest(SyncResponse(
            notebookId: "nb_field",
            cursor: 0,
            mode: .delta,
            rejected: response.rejected
        ))
        try expectEqual(device.engine.pendingCount, 0, "a rejected operation must leave the outbox")
        try expectEqual(device.engine.rejected.count, 1, "and be recorded for the UI")
        try expect(device.engine.rejected[0].reason.contains("actor"), "reason: \(device.engine.rejected[0].reason)")
    }

    await runner.test("a snapshot is adopted without discarding unsent work") {
        let server = FakeServer(notebookId: "nb_field")
        let device = try makeDevice("dev_ipad", server: server)
        _ = try device.engine.createNote(title: "Synced note")
        _ = await device.engine.sync()

        // This device has been away longer than the server's log, and has one
        // more edit that never left the iPad.
        let stranded = try device.engine.createNote(title: "Stranded note")
        server.checkpoint = 99
        let outcome = await device.engine.sync()

        try expectEqual(outcome.mode, .snapshot, "mode")
        let titles = try device.engine.notes().map(\.title).sorted()
        try expectEqual(titles, ["Stranded note", "Synced note"], "a snapshot must not drop unacknowledged work")
        try expect(try device.engine.note(stranded.id) != nil, "the stranded note survived the snapshot")
    }

    await runner.test("two devices editing different fields both keep their work") {
        let server = FakeServer(notebookId: "nb_field")
        let alice = try makeDevice("dev_alice", server: server)
        let bob = try makeDevice("dev_bob", server: server)

        let note = try alice.engine.createNote(title: "Kickoff", body: "original")
        _ = await alice.engine.sync()
        _ = await bob.engine.sync()
        try expectEqual(try bob.engine.notes().count, 1, "bob pulled the note")

        // Both go offline and edit different fields of the same note.
        alice.transport.offline = true
        bob.transport.offline = true
        try alice.engine.updateNote(note.id, title: "Kickoff (field)")
        try bob.engine.updateNote(note.id, body: "original\n- borrow the tripod")
        _ = await alice.engine.sync()
        _ = await bob.engine.sync()

        alice.transport.offline = false
        bob.transport.offline = false
        _ = await alice.engine.sync()
        _ = await bob.engine.sync()
        _ = await alice.engine.sync()

        try expectEqual(
            try Reconcile.stateDigest(alice.engine.state),
            try Reconcile.stateDigest(bob.engine.state),
            "converged state digest"
        )
        let merged = try alice.engine.note(note.id)
        try expectEqual(merged?.title, "Kickoff (field)", "alice's title survives")
        try expectEqual(merged?.body, "original\n- borrow the tripod", "bob's body survives")
        try expectEqual(try alice.engine.conflicts().count, 0, "different fields are not a conflict")
    }

    await runner.test("two devices editing the same field converge and report the loser") {
        let server = FakeServer(notebookId: "nb_field")
        let alice = try makeDevice("dev_alice", server: server)
        let bob = try makeDevice("dev_bob", server: server)

        let note = try alice.engine.createNote(title: "Kickoff", body: "original")
        _ = await alice.engine.sync()
        _ = await bob.engine.sync()

        alice.transport.offline = true
        bob.transport.offline = true
        try alice.engine.updateNote(note.id, title: "Kickoff (field)")
        try bob.engine.updateNote(note.id, title: "Kickoff (lab)")
        alice.transport.offline = false
        bob.transport.offline = false

        _ = await alice.engine.sync()
        _ = await bob.engine.sync()
        _ = await alice.engine.sync()

        try expectEqual(
            try Reconcile.stateDigest(alice.engine.state),
            try Reconcile.stateDigest(bob.engine.state),
            "converged state digest"
        )
        // dev_bob outranks dev_alice on the actor tiebreak at equal lamport.
        try expectEqual(try alice.engine.note(note.id)?.title, "Kickoff (lab)", "winner")

        let conflicts = try alice.engine.conflicts()
        try expectEqual(conflicts.count, 1, "one conflict")
        try expectEqual(conflicts[0].field, "title", "conflicted field")
        try expectEqual(conflicts[0].losers.count, 1, "one loser")
        try expectEqual(conflicts[0].losers[0].value, .string("Kickoff (field)"), "the losing edit is offered back, not dropped")
        try expectEqual(try bob.engine.conflicts(), conflicts, "both devices see the same conflict")
    }

    await runner.test("ink and annotations travel over the same operation log") {
        let server = FakeServer(notebookId: "nb_field")
        let alice = try makeDevice("dev_alice", server: server)
        let bob = try makeDevice("dev_bob", server: server)

        let stroke = try Fixtures.decode(InkStroke.self, "stroke")
        let (annotation, inkStroke) = try alice.engine.addInkAnnotation(
            pdfId: "pdf_syllabus",
            page: 2,
            draft: InkStrokeDraft(color: stroke.color, width: stroke.width, points: stroke.points)
        )
        _ = try alice.engine.addHighlight(
            pdfId: "pdf_syllabus",
            page: 2,
            rect: Rect(x: 72, y: 320.5, width: 180, height: 14),
            text: "lab report due"
        )
        _ = await alice.engine.sync()
        _ = await bob.engine.sync()

        let pulled = try bob.engine.annotations(pdfId: "pdf_syllabus")
        try expectEqual(pulled.count, 2, "both annotations reached the other device")
        try expect(pulled.contains { $0.id == annotation.id && $0.kind == .ink }, "the ink annotation crossed")
        let pulledStrokes = try bob.engine.strokes(targetKind: .pdf, targetId: "pdf_syllabus")
        try expectEqual(pulledStrokes.count, 1, "stroke count")
        try expectEqual(pulledStrokes[0].points, inkStroke.points, "stroke points survived the round trip")
        try expectEqual(pulledStrokes[0].id, inkStroke.id, "stroke id")
    }

    await runner.test("saving the same canvas twice writes no new operations") {
        let server = FakeServer(notebookId: "nb_field")
        let device = try makeDevice("dev_ipad", server: server)
        let stroke = try Fixtures.decode(InkStroke.self, "stroke")
        let drafts = [InkStrokeDraft(color: stroke.color, width: stroke.width, points: stroke.points)]

        _ = try device.engine.setInk(targetKind: .note, targetId: "note_kickoff", page: nil, drafts: drafts)
        let after = device.engine.pendingCount
        _ = try device.engine.setInk(targetKind: .note, targetId: "note_kickoff", page: nil, drafts: drafts)
        try expectEqual(device.engine.pendingCount, after, "an unchanged canvas must not author operations")

        _ = try device.engine.setInk(targetKind: .note, targetId: "note_kickoff", page: nil, drafts: [])
        try expectEqual(try device.engine.strokes(targetKind: .note, targetId: "note_kickoff").count, 0, "erasing removes the stroke")
    }

    await runner.test("the engine refuses a sync response for another notebook") {
        let server = FakeServer(notebookId: "nb_field")
        let device = try makeDevice("dev_ipad", server: server)
        try expectThrows("mismatched notebook") {
            try device.engine.ingest(SyncResponse(notebookId: "nb_other", cursor: 0, mode: .delta))
        }
    }

    await runner.test("a snapshot response with no state is refused rather than emptying the notebook") {
        let server = FakeServer(notebookId: "nb_field")
        let device = try makeDevice("dev_ipad", server: server)
        _ = try device.engine.createNote(title: "Kickoff")
        try expectThrows("snapshot without state") {
            try device.engine.ingest(SyncResponse(notebookId: "nb_field", cursor: 5, mode: .snapshot, state: nil))
        }
        try expectEqual(try device.engine.notes().count, 1, "the notebook is untouched")
    }
}
