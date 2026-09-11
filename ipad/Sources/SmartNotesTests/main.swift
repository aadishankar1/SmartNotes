import Foundation

let runner = TestRunner()
print("SmartNotes for iPad — fixtures from \(Fixtures.directory().path)")

runFixtureTests(runner)
runReconcileTests(runner)
runStoreTests(runner)
await runSyncTests(runner)
runDocumentTests(runner)
await runLibraryTests(runner)

exit(runner.finish())
