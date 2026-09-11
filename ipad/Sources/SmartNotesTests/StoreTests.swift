import Foundation
import SmartNotesKit

/// Offline durability. The claim these tests defend is "your edits are on this
/// iPad before the view redraws", so every one of them reopens the store from
/// disk rather than reading back the object that wrote it.
func runStoreTests(_ runner: TestRunner) {
    runner.suite("local persistence")

    runner.test("the device id is generated once and survives reopening") {
        let temporary = try TemporaryDirectory()
        let first = try LocalStore(root: temporary.url, fsync: false).deviceId()
        let second = try LocalStore(root: temporary.url, fsync: false).deviceId()
        try expectEqual(first, second, "device id")
        try expect(LocalStore.isValidId(first), "generated device id \(first) must satisfy the shared id pattern")
    }

    runner.test("a session round trips and can be cleared") {
        let temporary = try TemporaryDirectory()
        let store = try LocalStore(root: temporary.url, fsync: false)
        let session = Session(
            baseURL: "https://smartnotes.example",
            token: "tok_abc",
            user: try Fixtures.decode(User.self, "user")
        )
        try store.saveSession(session)
        try expectEqual(try LocalStore(root: temporary.url, fsync: false).loadSession(), session, "reloaded session")
        try store.clearSession()
        try expect(try store.loadSession() == nil, "session should be gone after clearing")
    }

    runner.test("the notebook list is cached so the list screen works offline") {
        let temporary = try TemporaryDirectory()
        let store = try LocalStore(root: temporary.url, fsync: false)
        let notebook = try Fixtures.decode(Notebook.self, "notebook")
        try store.saveNotebooks([notebook])
        try expectEqual(try LocalStore(root: temporary.url, fsync: false).loadNotebooks(), [notebook], "cached notebooks")
    }

    runner.test("edits made offline survive reopening the store") {
        let temporary = try TemporaryDirectory()
        let notebookId = "nb_field"
        var noteId = ""

        do {
            let store = try LocalStore(root: temporary.url, fsync: false)
            let engine = try SyncEngine(
                notebookId: notebookId,
                store: store,
                api: APIClient(transport: FakeTransport(server: FakeServer(notebookId: notebookId))),
                deviceId: "dev_ipad",
                now: { 1_767_225_600_000 }
            )
            let note = try engine.createNote(title: "Kickoff", body: "packed the styluses")
            noteId = note.id
            try engine.updateNote(note.id, body: "packed the styluses\n- and the tripod")
            try expectEqual(engine.pendingCount, 2, "outbox after two edits")
        }

        // A fresh process: nothing in memory, everything from disk.
        let store = try LocalStore(root: temporary.url, fsync: false)
        let engine = try SyncEngine(
            notebookId: notebookId,
            store: store,
            api: APIClient(transport: FakeTransport(server: FakeServer(notebookId: notebookId))),
            deviceId: "dev_ipad"
        )
        let notes = try engine.notes()
        try expectEqual(notes.count, 1, "notes after reopening")
        try expectEqual(notes[0].id, noteId, "note id")
        try expectEqual(notes[0].title, "Kickoff", "title")
        try expectEqual(notes[0].body, "packed the styluses\n- and the tripod", "body")
        try expectEqual(engine.pendingCount, 2, "the outbox must survive too, or the edits never reach the server")
        try expectEqual(engine.cursor, 0, "cursor stays at zero until a sync succeeds")
    }

    runner.test("a deleted note stays deleted across a reopen") {
        let temporary = try TemporaryDirectory()
        let server = FakeServer(notebookId: "nb_field")
        var noteId = ""
        do {
            let engine = try SyncEngine(
                notebookId: "nb_field",
                store: try LocalStore(root: temporary.url, fsync: false),
                api: APIClient(transport: FakeTransport(server: server)),
                deviceId: "dev_ipad"
            )
            noteId = try engine.createNote(title: "Scratch").id
            try engine.deleteNote(noteId)
            try expectEqual(try engine.notes().count, 0, "note should be gone immediately")
        }
        let engine = try SyncEngine(
            notebookId: "nb_field",
            store: try LocalStore(root: temporary.url, fsync: false),
            api: APIClient(transport: FakeTransport(server: server)),
            deviceId: "dev_ipad"
        )
        try expectEqual(try engine.notes().count, 0, "notes after reopening")
        try expectEqual(try engine.tombstones().first?.entityId, noteId, "tombstone survives")
    }

    runner.test("the replica is written as canonical bytes, so an unchanged save is byte-identical") {
        let temporary = try TemporaryDirectory()
        let store = try LocalStore(root: temporary.url, fsync: false)
        let engine = try SyncEngine(
            notebookId: "nb_field",
            store: store,
            api: APIClient(transport: FakeTransport(server: FakeServer(notebookId: "nb_field"))),
            deviceId: "dev_ipad",
            now: { 1_767_225_600_000 }
        )
        _ = try engine.createNote(title: "Kickoff")
        let url = try store.replicaURL("nb_field")
        let first = try Data(contentsOf: url)
        try engine.persist()
        try expectEqual(try Data(contentsOf: url), first, "rewriting unchanged state must not change bytes")
    }

    runner.test("a cached PDF is verified against the digest the server published") {
        let temporary = try TemporaryDirectory()
        let store = try LocalStore(root: temporary.url, fsync: false)
        let bytes = Data("%PDF-1.7 smartnotes fixture syllabus".utf8)
        var document = try Fixtures.decode(PdfDocument.self, "pdf")

        try expectEqual(Digest.sha256Hex(bytes), document.sha256, "the fixture digest is over these bytes")
        try store.savePdf(bytes, for: document)
        try expect(store.hasPdf(document.id), "pdf should be cached")
        try expectEqual(try store.loadPdf(document.id), bytes, "cached bytes")

        document.sha256 = String(repeating: "0", count: 64)
        try expectThrows("truncated download") { try store.savePdf(bytes, for: document) }
    }

    runner.test("an id that is not path-safe is refused rather than escaping the store") {
        let temporary = try TemporaryDirectory()
        let store = try LocalStore(root: temporary.url, fsync: false)
        try expectThrows("traversal") { _ = try store.replicaURL("../../etc/passwd") }
        try expectThrows("empty") { _ = try store.pdfURL("") }
        try expect(LocalStore.isValidId("nb_field"), "ordinary ids stay valid")
    }
}
