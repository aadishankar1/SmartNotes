import Foundation
import SmartNotesKit

/// The app layer: signing in with a server-issued token, the notebook list,
/// and the five states the screens have to be able to show — loading, empty,
/// error, offline and conflicted.
///
/// `Library` and `NotebookSession` are main-actor isolated because SwiftUI
/// observes them, so every call here is awaited.
func runLibraryTests(_ runner: TestRunner) async {
    runner.suite("app state")

    struct Harness {
        let library: Library
        let transport: FakeTransport
        let store: LocalStore
        let temporary: TemporaryDirectory
    }

    let alice = User(id: "usr_alice", email: "alice@example.com", displayName: "Alice Nakamura", createdAt: 0)

    @MainActor
    func makeHarness(notebooks: [Notebook] = [], server: FakeServer = FakeServer(notebookId: "nb_field")) throws -> Harness {
        let temporary = try TemporaryDirectory()
        let store = try LocalStore(root: temporary.url, fsync: false)
        let transport = FakeTransport(server: server)
        transport.notebooks = notebooks
        let library = try Library(
            store: store,
            makeTransport: { _ in transport },
            now: { 1_767_225_600_000 }
        )
        return Harness(library: library, transport: transport, store: store, temporary: temporary)
    }

    func notebook(_ id: String, _ title: String) -> Notebook {
        Notebook(id: id, ownerId: "usr_alice", title: title, color: "#4c6ef5", createdAt: 0, updatedAt: 0)
    }

    await runner.test("signing in with a server-issued token saves the session and loads the notebooks") {
        let harness = try await makeHarness(notebooks: [notebook("nb_field", "Field notes")])
        let ok = await harness.library.signIn(baseURL: "http://localhost:8787", token: "tok_alice")
        try expect(ok, "sign in should succeed")
        try await expectEqual(harness.library.session?.user.email, alice.email, "signed-in user")
        try await expectEqual(harness.library.notebooks.count, 1, "notebooks")
        try await expectEqual(harness.library.phase, .ready, "phase")
        try expect(try harness.store.loadSession() != nil, "the session is on disk, so a relaunch stays signed in")
    }

    await runner.test("a rejected token leaves the app signed out and says why") {
        let harness = try await makeHarness()
        harness.transport.failure = (401, "unauthorized", "token not recognised")
        let ok = await harness.library.signIn(baseURL: "http://localhost:8787", token: "tok_stale")
        try expect(!ok, "sign in should fail")
        try await expectEqual(harness.library.phase, .signedOut, "phase")
        try expect(try harness.store.loadSession() == nil, "a rejected token must not be saved")
        let notice = await harness.library.notice ?? ""
        try expect(notice.contains("token"), "the notice should name the token, got \(notice)")
    }

    await runner.test("an address that is not a URL is refused before any request") {
        let harness = try await makeHarness()
        let ok = await harness.library.signIn(baseURL: "localhost 8787", token: "tok_alice")
        try expect(!ok, "sign in should fail")
        try await expectEqual(harness.library.phase, .signedOut, "phase")
    }

    await runner.test("an account with no notebooks reaches the empty state, not an error") {
        let harness = try await makeHarness(notebooks: [])
        _ = await harness.library.signIn(baseURL: "http://localhost:8787", token: "tok_alice")
        try await expectEqual(harness.library.phase, .empty, "phase")
        try await expectEqual(harness.library.notebooks.isEmpty, true, "notebooks")
    }

    await runner.test("a saved session is restored from disk with no network at all") {
        let harness = try await makeHarness(notebooks: [notebook("nb_field", "Field notes")])
        _ = await harness.library.signIn(baseURL: "http://localhost:8787", token: "tok_alice")

        let reopened = try await Library(store: harness.store, makeTransport: { _ in harness.transport })
        harness.transport.offline = true
        try await reopened.restore()
        try await expectEqual(reopened.session?.user.id, "usr_alice", "restored user")
        try await expectEqual(reopened.notebooks.map(\.id), ["nb_field"], "the cached list is available offline")
        try await expectEqual(reopened.phase, .ready, "phase")
    }

    await runner.test("a refresh that cannot reach the server keeps the cached list and reports offline") {
        let harness = try await makeHarness(notebooks: [notebook("nb_field", "Field notes")])
        _ = await harness.library.signIn(baseURL: "http://localhost:8787", token: "tok_alice")
        harness.transport.offline = true
        await harness.library.refresh()

        try await expectEqual(harness.library.notebooks.count, 1, "the cached list is not thrown away")
        try await expectEqual(harness.library.offline, true, "offline flag")
        try await expectEqual(harness.library.phase, .ready, "phase")
    }

    await runner.test("a server error with nothing cached becomes a failed state carrying the server's message") {
        let harness = try await makeHarness()
        _ = await harness.library.signIn(baseURL: "http://localhost:8787", token: "tok_alice")
        harness.transport.failure = (500, "internal", "the notebook service is down")
        await harness.library.refresh()

        try await expectEqual(harness.library.phase, .failed("the notebook service is down"), "phase")
    }

    await runner.test("creating a notebook offline is refused rather than queued as an edit it cannot honour") {
        let harness = try await makeHarness(notebooks: [notebook("nb_field", "Field notes")])
        _ = await harness.library.signIn(baseURL: "http://localhost:8787", token: "tok_alice")
        harness.transport.offline = true
        let created = await harness.library.createNotebook(title: "Lab")

        try expect(created == nil, "no notebook should be invented locally")
        try await expectEqual(harness.library.notebooks.count, 1, "the list is unchanged")
        let notice = await harness.library.notice ?? ""
        try expect(notice.contains("connection"), "the notice should explain the requirement, got \(notice)")
    }

    await runner.test("creating a notebook online adds it to the list and the cache") {
        let harness = try await makeHarness()
        _ = await harness.library.signIn(baseURL: "http://localhost:8787", token: "tok_alice")
        let created = await harness.library.createNotebook(title: "Lab")

        try expect(created != nil, "the server should have created a notebook")
        try await expectEqual(harness.library.phase, .ready, "phase")
        try expectEqual(try harness.store.loadNotebooks().map(\.title), ["Lab"], "cached list")
    }

    await runner.test("signing out clears the session and the list") {
        let harness = try await makeHarness(notebooks: [notebook("nb_field", "Field notes")])
        _ = await harness.library.signIn(baseURL: "http://localhost:8787", token: "tok_alice")
        try await harness.library.signOut()

        try await expectEqual(harness.library.phase, .signedOut, "phase")
        try await expectEqual(harness.library.notebooks.isEmpty, true, "notebooks")
        try expect(try harness.store.loadSession() == nil, "the token must not survive signing out")
    }

    await runner.test("a notebook opened offline still edits, and reports what is waiting to sync") {
        let harness = try await makeHarness(notebooks: [notebook("nb_field", "Field notes")])
        _ = await harness.library.signIn(baseURL: "http://localhost:8787", token: "tok_alice")
        let session = try await harness.library.open(notebook("nb_field", "Field notes"))

        harness.transport.offline = true
        _ = await session.createNote(title: "Interview")
        await session.sync()

        try await expectEqual(session.notes.map(\.title), ["Interview"], "the note is readable immediately")
        try await expectEqual(session.pendingCount, 1, "the edit is queued, not lost")
        try await expectEqual(session.banner, .offline(pending: 1), "banner")
        try await expectEqual(session.isEmpty, false, "the notebook is no longer empty")

        // And it is on disk: a fresh session over the same store sees it.
        let reopened = try await harness.library.open(notebook("nb_field", "Field notes"))
        try await expectEqual(reopened.notes.map(\.title), ["Interview"], "the edit survived reopening the notebook")
    }

    await runner.test("renaming a notebook is an ordinary operation, so it works offline") {
        let harness = try await makeHarness(notebooks: [notebook("nb_field", "Field notes")])
        _ = await harness.library.signIn(baseURL: "http://localhost:8787", token: "tok_alice")
        let session = try await harness.library.open(notebook("nb_field", "Field notes"))

        harness.transport.offline = true
        await session.renameNotebook("Field notes (2027)")
        try await expectEqual(session.notebook.title, "Field notes (2027)", "the rename is visible immediately")
        try await expectEqual(session.pendingCount, 1, "and queued for the server")
    }

    await runner.test("adding a PDF offline is refused rather than half-added") {
        let harness = try await makeHarness(notebooks: [notebook("nb_field", "Field notes")])
        _ = await harness.library.signIn(baseURL: "http://localhost:8787", token: "tok_alice")
        let session = try await harness.library.open(notebook("nb_field", "Field notes"))

        harness.transport.offline = true
        let added = await session.importPdf(filename: "syllabus.pdf", bytes: Data("%PDF-1.7\n".utf8))
        try expect(added == nil, "no PDF should be invented locally")
        try await expectEqual(session.pdfs.isEmpty, true, "the notebook is unchanged")
        let message = await session.writeError ?? ""
        try expect(message.contains("connection"), "the message should explain the requirement, got \(message)")
    }

    await runner.test("a fresh notebook reports the empty state") {
        let harness = try await makeHarness(notebooks: [notebook("nb_field", "Field notes")])
        _ = await harness.library.signIn(baseURL: "http://localhost:8787", token: "tok_alice")
        let session = try await harness.library.open(notebook("nb_field", "Field notes"))
        try await expectEqual(session.isEmpty, true, "a notebook with no notes and no PDFs is empty")
    }

    await runner.test("a conflict from another device is surfaced and its losing value can be restored") {
        let server = FakeServer(notebookId: "nb_field")
        let harness = try await makeHarness(notebooks: [notebook("nb_field", "Field notes")], server: server)
        _ = await harness.library.signIn(baseURL: "http://localhost:8787", token: "tok_alice")
        let session = try await harness.library.open(notebook("nb_field", "Field notes"))

        let note = try await session.engine.createNote(title: "Kickoff")
        await session.sync()

        // A second device edits the same field concurrently: same lamport,
        // and `dev_zulu` outranks this device's id on the actor tiebreak.
        let other = try TemporaryDirectory()
        let otherStore = try LocalStore(root: other.url, fsync: false)
        let otherEngine = try SyncEngine(
            notebookId: "nb_field",
            store: otherStore,
            api: APIClient(transport: FakeTransport(server: server), token: "tok_alice"),
            deviceId: "dev_zulu",
            now: { 1_767_225_600_000 }
        )
        _ = await otherEngine.sync()
        try otherEngine.updateNote(note.id, title: "Kickoff (zulu)")
        try await session.engine.updateNote(note.id, title: "Kickoff (here)")
        _ = await otherEngine.sync()
        await session.sync()

        let conflicts = await session.conflicts
        try expectEqual(conflicts.count, 1, "one conflict")
        try await expectEqual(session.banner, .conflicts(count: 1), "the banner asks the user to review it")
        try expectEqual(conflicts[0].losers.first?.value, .string("Kickoff (here)"), "the losing edit is kept")

        await session.restore(conflicts[0])
        try await expectEqual(session.notes.first?.title, "Kickoff (here)", "restoring writes the losing value back")
    }

    runner.test("a rejected operation outranks a conflict in the banner, because only it needs explaining") {
        let rejected = SyncOutcome(
            status: .synced(at: 1),
            accepted: 0,
            rejected: [RejectedOperation(opId: "op_1", reason: "field ownerId is not client-writable")],
            mode: .delta,
            hasPending: false
        )
        try expectEqual(
            NotebookSession.banner(for: rejected, conflicts: 3),
            .rejected(count: 1, reason: "field ownerId is not client-writable"),
            "banner"
        )

        let offline = SyncOutcome(status: .offline(pending: 2), accepted: 0, rejected: [], mode: nil, hasPending: true)
        try expectEqual(NotebookSession.banner(for: offline, conflicts: 0), .offline(pending: 2), "offline banner")
        try expectEqual(NotebookSession.banner(for: offline, conflicts: 1), .conflicts(count: 1), "conflicts outrank offline")

        let failed = SyncOutcome(status: .failed("the notebook service is down"), accepted: 0, rejected: [], mode: nil, hasPending: true)
        try expectEqual(
            NotebookSession.banner(for: failed, conflicts: 2),
            .failed("the notebook service is down"),
            "a hard failure is not hidden behind a conflict count"
        )
    }

    runner.test("the offline banner distinguishes work waiting to sync from nothing waiting") {
        try expect(
            StatusBanner.offline(pending: 0).message.contains("up to date"),
            "an offline notebook with nothing pending must not imply lost work"
        )
        try expect(StatusBanner.offline(pending: 1).message.contains("1 change is"), "singular")
        try expect(StatusBanner.offline(pending: 3).message.contains("3 changes are"), "plural")
        try expect(StatusBanner.conflicts(count: 1).isActionable, "a conflict needs the user")
        try expect(!StatusBanner.offline(pending: 1).isActionable, "being offline does not")
    }
}
