import Foundation
import SmartNotesKit

/// The fold is supposed to be a pure function of the operation *set*. These
/// tests are the ones that would catch it quietly becoming a function of
/// arrival order instead.
func runReconcileTests(_ runner: TestRunner) {
    runner.suite("reconciliation")

    func fixtureOps() throws -> [Operation] {
        try Fixtures.decode(OperationsFixture.self, "operations").ops
    }

    runner.test("the fixture log folds to the same conflict the server publishes") {
        let state = try Reconcile.fold(try fixtureOps())
        let view = try Reconcile.materialize(state)
        let expected = try Fixtures.json("conflict")

        try expectEqual(view.conflicts.count, 1, "conflict count")
        let produced = try JSONValue(encoding: view.conflicts[0])
        try expectEqual(try produced.canonicalString(), try expected.canonicalString(), "conflict bytes")
    }

    runner.test("per-field last-writer-wins keeps the uncontested field") {
        let view = try Reconcile.materialize(try Reconcile.fold(try fixtureOps()))
        let notes = try view.decode(Note.self, of: .note)
        try expectEqual(notes.count, 1, "surviving notes")
        let note = notes[0]
        // dev_mac beats dev_ipad at the same lamport because the actor breaks
        // the tie, so its title wins...
        try expectEqual(note.title, "Kickoff (lab)", "title winner")
        // ...and its body edit survives too, because nothing raced that field.
        try expect(note.body.hasSuffix("- borrow the tripod"), "body should carry the mac edit, got \(note.body)")
    }

    runner.test("an uncontested delete becomes a tombstone, not a conflict") {
        let view = try Reconcile.materialize(try Reconcile.fold(try fixtureOps()))
        try expectEqual(view.tombstones.count, 1, "tombstone count")
        try expectEqual(view.tombstones[0].entityId, "note_scratch", "tombstoned entity")
        try expectEqual(view.tombstones[0].entityKind, .note, "tombstoned kind")
        try expect(!view.conflicts.contains { $0.field == DELETED_FIELD }, "an unraced delete must not conflict")
    }

    runner.test("the fold is independent of arrival order") {
        let ops = try fixtureOps()
        let reference = try Reconcile.stateDigest(try Reconcile.fold(ops))
        // Every rotation, plus the full reverse: enough orders that an
        // order-dependent merge cannot survive all of them.
        for offset in 0..<ops.count {
            let rotated = Array(ops[offset...] + ops[..<offset])
            try expectEqual(try Reconcile.stateDigest(try Reconcile.fold(rotated)), reference, "rotation \(offset)")
        }
        try expectEqual(try Reconcile.stateDigest(try Reconcile.fold(ops.reversed())), reference, "reversed")
    }

    runner.test("re-delivering the whole log changes nothing") {
        let ops = try fixtureOps()
        let once = try Reconcile.fold(ops)
        let twice = try Reconcile.reconcile(once, incoming: ops)
        try expectEqual(try Reconcile.stateDigest(twice), try Reconcile.stateDigest(once), "digest after replay")
    }

    runner.test("a replayed operation id carrying different bytes is refused") {
        var ops = try fixtureOps()
        var forged = ops[0]
        forged.fields["title"] = .string("tampered")
        ops.append(forged)
        try expectThrows("forged replay") { _ = try Reconcile.fold(ops) }
    }

    runner.test("reconnecting from either direction converges") {
        // Split the log the way two devices would have seen it, fold each side
        // separately, then exchange. Both must land on the same digest.
        let ops = try fixtureOps()
        let left = Array(ops.prefix(2))
        let right = Array(ops.suffix(from: 2))

        let leftThenRight = try Reconcile.reconcile(try Reconcile.fold(left), incoming: right)
        let rightThenLeft = try Reconcile.reconcile(try Reconcile.fold(right), incoming: left)
        try expectEqual(
            try Reconcile.stateDigest(leftThenRight),
            try Reconcile.stateDigest(rightThenLeft),
            "converged digest"
        )
        try expectEqual(
            try Reconcile.stateDigest(leftThenRight),
            try Reconcile.stateDigest(try Reconcile.fold(ops)),
            "matches the single-pass fold"
        )
    }

    runner.test("a delete racing a later edit is reported, not silently applied") {
        let notebook = "nb_race"
        let create = try Ops.create(Ops.NewOperation(
            entityKind: .note, entityId: "note_x", notebookId: notebook,
            fields: ["title": "X", "body": "", "position": .int(1), "createdAt": .int(1), "updatedAt": .int(1)],
            actor: "dev_a", lamport: 1, seq: 0, basis: 0, at: 1
        ))
        // Both devices saw lamport 1 and then acted without seeing each other.
        let edit = try Ops.create(Ops.NewOperation(
            entityKind: .note, entityId: "note_x", notebookId: notebook,
            fields: ["title": "X edited", "updatedAt": .int(3)],
            actor: "dev_b", lamport: 2, seq: 0, basis: 1, at: 3
        ))
        let remove = try Ops.create(Ops.NewOperation(
            entityKind: .note, entityId: "note_x", notebookId: notebook, kind: .delete,
            actor: "dev_a", lamport: 2, seq: 1, basis: 1, at: 3
        ))

        let view = try Reconcile.materialize(try Reconcile.fold([create, edit, remove]))
        // dev_b's edit outranks dev_a's delete on the actor tiebreak, so the
        // note survives — but the delete is surfaced rather than dropped.
        try expectEqual(view.entities.count, 1, "surviving entity")
        try expect(view.conflicts.contains { $0.field == DELETED_FIELD }, "the raced delete must be reported")
    }

    runner.test("a client cannot author a server-owned field") {
        let op = try Ops.create(Ops.NewOperation(
            entityKind: .notebook, entityId: "nb_x", notebookId: "nb_x",
            fields: ["ownerId": "usr_someone_else"],
            actor: "dev_a", lamport: 1, seq: 0, basis: 0, at: 1
        ))
        try expectThrows("server-owned field") { try Ops.assertClientWritable(op) }
    }

    runner.test("malformed operations are refused at construction") {
        try expectThrows("empty set") {
            _ = try Ops.create(Ops.NewOperation(
                entityKind: .note, entityId: "note_x", notebookId: "nb_x",
                actor: "dev_a", lamport: 1, seq: 0, basis: 0, at: 1
            ))
        }
        try expectThrows("delete with fields") {
            var op = try Ops.create(Ops.NewOperation(
                entityKind: .note, entityId: "note_x", notebookId: "nb_x", kind: .delete,
                actor: "dev_a", lamport: 1, seq: 0, basis: 0, at: 1
            ))
            op.fields = ["title": "x"]
            _ = try Ops.validate(op)
        }
        try expectThrows("basis ahead of lamport") {
            var op = try Ops.create(Ops.NewOperation(
                entityKind: .note, entityId: "note_x", notebookId: "nb_x",
                fields: ["title": "x"], actor: "dev_a", lamport: 1, seq: 0, basis: 0, at: 1
            ))
            op.basis = 9
            _ = try Ops.validate(op)
        }
    }

    runner.test("a record that cannot satisfy the contract is reported, not shown") {
        // `width` must be an integer of at least 1; a stroke that folded to
        // zero width is invalid and must not reach the canvas.
        let op = try Ops.create(Ops.NewOperation(
            entityKind: .stroke, entityId: "ink_bad", notebookId: "nb_x",
            fields: [
                "targetKind": "note", "targetId": "note_x", "page": .null,
                "color": "#000000", "width": .string("thick"), "points": .array([]),
                "createdAt": .int(1),
            ],
            actor: "dev_a", lamport: 1, seq: 0, basis: 0, at: 1
        ))
        let view = try Reconcile.materialize(try Reconcile.fold([op]))
        try expectEqual(view.entities.count, 0, "invalid entities must not materialize")
        try expectEqual(view.invalid.count, 1, "invalid count")
        try expectEqual(view.invalid[0].id, "ink_bad", "invalid id")
    }
}
