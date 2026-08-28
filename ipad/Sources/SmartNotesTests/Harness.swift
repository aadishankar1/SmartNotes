import Foundation
import SmartNotesKit

/// `Foundation.Operation` is `NSOperation`, which is ambiguous with the
/// contract's `Operation` in any file that imports both. The contract wins.
typealias Operation = SmartNotesKit.Operation

/// A minimal runner.
///
/// The suite is an executable rather than an XCTest bundle so it runs under a
/// direct `swiftc` build, which is the only option when SwiftPM cannot write
/// the Clang module cache. See `Scripts/build-and-test.sh`.
final class TestRunner {
    private(set) var passed = 0
    private(set) var failures: [String] = []
    private var current = ""

    func suite(_ name: String) {
        print("\n\(name)")
    }

    func test(_ name: String, _ body: () throws -> Void) {
        current = name
        do {
            try body()
            record(name, nil)
        } catch {
            record(name, error)
        }
    }

    /// Syncing is asynchronous end to end, so its tests are too.
    func test(_ name: String, _ body: () async throws -> Void) async {
        current = name
        do {
            try await body()
            record(name, nil)
        } catch {
            record(name, error)
        }
    }

    private func record(_ name: String, _ error: Error?) {
        if let error {
            failures.append("\(name): \(error)")
            print("  FAIL \(name): \(error)")
        } else {
            passed += 1
            print("  ok   \(name)")
        }
    }

    func finish() -> Int32 {
        print("\n\(passed) passed, \(failures.count) failed")
        for failure in failures { print("  - \(failure)") }
        return failures.isEmpty ? 0 : 1
    }
}

struct Failure: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

func expect(_ condition: Bool, _ message: @autoclosure () -> String) throws {
    if !condition { throw Failure(message()) }
}

func expectEqual<T: Equatable>(_ actual: T, _ expected: T, _ label: String) throws {
    if actual != expected { throw Failure("\(label): expected \(expected), got \(actual)") }
}

func expectClose(_ actual: Double, _ expected: Double, _ tolerance: Double, _ label: String) throws {
    if abs(actual - expected) > tolerance {
        throw Failure("\(label): expected \(expected) ± \(tolerance), got \(actual)")
    }
}

func expectThrows(_ label: String, _ body: () throws -> Void) throws {
    do {
        try body()
    } catch {
        return
    }
    throw Failure("\(label): expected a throw, but it succeeded")
}

/// The fixture corpus is shared with the server and the browser client, and is
/// read from the source tree rather than copied into the build, so a fixture
/// change is a diff in one place.
enum Fixtures {
    static let version = "v1"

    static func repoRoot() -> URL {
        if let override = ProcessInfo.processInfo.environment["SMARTNOTES_ROOT"], !override.isEmpty {
            return URL(fileURLWithPath: override)
        }
        var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<8 {
            if FileManager.default.fileExists(atPath: directory.appendingPathComponent("package.json").path) {
                return directory
            }
            directory = directory.deletingLastPathComponent()
        }
        fatalError("could not locate the SmartNotes package root; set SMARTNOTES_ROOT")
    }

    static func directory() -> URL {
        repoRoot().appendingPathComponent("shared/fixtures/\(version)", isDirectory: true)
    }

    /// Fixture names in the corpus, excluding the digest manifest itself.
    static func names() throws -> [String] {
        try FileManager.default.contentsOfDirectory(atPath: directory().path)
            .filter { $0.hasSuffix(".json") && $0 != "digests.json" }
            .map { String($0.dropLast(5)) }
            .sorted()
    }

    static func data(_ name: String) throws -> Data {
        try Data(contentsOf: directory().appendingPathComponent("\(name).json"))
    }

    static func json(_ name: String) throws -> JSONValue {
        try JSONValue(parsing: try data(name))
    }

    static func decode<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
        try JSONDecoder().decode(type, from: try data(name))
    }

    static func digests() throws -> [String: String] {
        try JSONDecoder().decode([String: String].self, from: try data("digests"))
    }
}

/// A scratch directory that cleans up after itself.
final class TemporaryDirectory {
    let url: URL

    init() throws {
        // `NSTemporaryDirectory()` resolves the per-user Darwin cache directory
        // rather than `$TMPDIR`, and sandboxes that grant only the latter deny
        // writes to it. Honour the environment first.
        let environment = ProcessInfo.processInfo.environment["TMPDIR"]
        let base = (environment?.isEmpty == false ? environment! : NSTemporaryDirectory())
        url = URL(fileURLWithPath: base)
            .appendingPathComponent("smartnotes-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    }

    deinit {
        try? FileManager.default.removeItem(at: url)
    }
}
