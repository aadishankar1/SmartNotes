import Foundation
import SmartNotesKit

/// Cross-implementation compatibility.
///
/// Every fixture is decoded into the Swift type, re-encoded, and hashed over
/// canonical bytes. Matching `digests.json` proves the iPad and the server
/// agree byte for byte, not merely field for field — which is the property the
/// operation ids and the state digests depend on.
func runFixtureTests(_ runner: TestRunner) {
    runner.suite("fixtures")

    runner.test("every fixture in the corpus is covered by a typed round trip") {
        let covered = Set(["user", "notebook", "note", "revision", "tombstone", "pdf", "annotation", "stroke", "conflict", "operations"])
        let names = Set(try Fixtures.names())
        try expect(
            names.subtracting(covered).isEmpty,
            "fixtures with no Swift round trip: \(names.subtracting(covered).sorted())"
        )
    }

    /// Decode into `T`, re-encode, and check both the digest manifest and the
    /// fixture's own bytes. The second check is what catches a dropped
    /// optional: a missing `color` would still hash to something, just not to
    /// the same thing.
    func roundTrip<T: Codable>(_ runner: TestRunner, _ type: T.Type, _ name: String) {
        runner.test("\(name) decodes and re-encodes to identical canonical bytes") {
            let digests = try Fixtures.digests()
            let value = try Fixtures.decode(type, name)
            let reencoded = try JSONValue(encoding: value)
            let original = try Fixtures.json(name)

            try expectEqual(try reencoded.canonicalString(), try original.canonicalString(), "\(name) canonical bytes")
            try expectEqual(try Digest.hashJSON(reencoded), digests[name] ?? "<missing>", "\(name) digest")
        }
    }

    roundTrip(runner, User.self, "user")
    roundTrip(runner, Notebook.self, "notebook")
    roundTrip(runner, Note.self, "note")
    roundTrip(runner, Revision.self, "revision")
    roundTrip(runner, Tombstone.self, "tombstone")
    roundTrip(runner, PdfDocument.self, "pdf")
    roundTrip(runner, Annotation.self, "annotation")
    roundTrip(runner, InkStroke.self, "stroke")
    roundTrip(runner, Conflict.self, "conflict")

    runner.test("operations fixture round trips through the Operation type") {
        let digests = try Fixtures.digests()
        let fixture = try Fixtures.decode(OperationsFixture.self, "operations")
        let reencoded = try JSONValue(encoding: fixture)
        try expectEqual(try reencoded.canonicalString(), try Fixtures.json("operations").canonicalString(), "operations bytes")
        try expectEqual(try Digest.hashJSON(reencoded), digests["operations"] ?? "<missing>", "operations digest")
    }

    runner.test("operation ids are reproducible from their own content") {
        // The id is the hash of the operation body, so rebuilding each fixture
        // operation from its fields has to land on the same id the server
        // computed. This is the check that would fail first if canonical JSON
        // ever drifted between the two implementations.
        let fixture = try Fixtures.decode(OperationsFixture.self, "operations")
        for op in fixture.ops {
            let rebuilt = try Ops.create(
                Ops.NewOperation(
                    entityKind: op.entityKind,
                    entityId: op.entityId,
                    notebookId: op.notebookId,
                    kind: op.kind,
                    fields: op.fields,
                    actor: op.actor,
                    lamport: op.lamport,
                    seq: op.seq,
                    basis: op.basis,
                    at: op.at
                )
            )
            try expectEqual(rebuilt.opId, op.opId, "opId for \(op.entityId)@\(op.lamport)")
            try expectEqual(try JSONValue(encoding: rebuilt).canonicalString(), try JSONValue(encoding: op).canonicalString(), "operation bytes")
        }
    }

    runner.test("ink quantisation matches the stroke fixture exactly") {
        let stroke = try Fixtures.decode(InkStroke.self, "stroke")
        let decoded = try Ink.decode(stroke.points)
        try expectEqual(decoded.count, 4, "sample count")
        try expectEqual(Ink.sampleCount(stroke.points), 4, "sampleCount helper")
        try expectClose(decoded[0].x, 72, 1e-9, "first x")
        try expectClose(decoded[0].y, 320.5, 1e-9, "first y")
        try expectClose(decoded[1].pressure, 0.62, 1e-9, "second pressure")
        try expectEqual(try Ink.encode(decoded), stroke.points, "re-encoded points")
    }

    runner.test("a non-finite coordinate is refused rather than serialised") {
        try expectThrows("non-finite ink") {
            _ = try Ink.encode([Ink.Point(x: .infinity, y: 0, pressure: 1, t: 0)])
        }
        try expectThrows("ragged stroke") {
            _ = try Ink.decode([1, 2, 3])
        }
    }

    runner.test("canonical JSON sorts keys by UTF-16 code unit like the server") {
        // Above the BMP, JavaScript's default sort and Swift's `<` disagree;
        // the contract is defined by the former.
        let value = JSONValue.object(["\u{1F600}": .int(1), "\u{FB00}": .int(2), "a": .int(3)])
        try expectEqual(try value.canonicalString(), "{\"a\":3,\"\u{1F600}\":1,\"\u{FB00}\":2}", "utf16 key order")
    }

    runner.test("canonical JSON normalises -0 and prints integral doubles as integers") {
        try expectEqual(try JSONValue.number(-0.0).canonicalString(), "0", "negative zero")
        try expectEqual(try JSONValue.number(1.0).canonicalString(), "1", "integral double")
        try expectEqual(try JSONValue.number(320.5).canonicalString(), "320.5", "fractional double")
        try expectThrows("non-finite number") { _ = try JSONValue.double(.nan).canonicalString() }
    }
}

/// The shape of `operations.json`: the notebook plus its conflicting log.
struct OperationsFixture: Codable {
    var schemaVersion: Int
    var notebookId: String
    var ops: [Operation]
}
