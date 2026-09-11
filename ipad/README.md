# SmartNotes for iPad

A native SwiftUI iPad client for SmartNotes. It signs in with a server-issued
API token, lists and edits notebooks and notes, keeps every edit on disk before
it is visible, reads and annotates PDFs with PDFKit, captures handwriting with
PencilKit, and reconciles with the server through the same operation log the
web client and the server itself use.

## Layout

| Target | What it is | Platforms |
| --- | --- | --- |
| `SmartNotesKit` | The shared contract in Swift: model, canonical JSON, ink quantisation, operations, reconciliation, the on-disk store, the API client, the sync engine, and the screens' state machine (`Library`, `NotebookSession`, `StatusBanner`). No UI framework. | iOS, macOS |
| `SmartNotesDocuments` | The bridges: `PDFAnnotationBridge` (shared `Annotation` ⇄ PDFKit) and `PencilKitInk` (`InkStroke` ⇄ `PKDrawing`). | iOS, macOS |
| `SmartNotesUI` | The SwiftUI app: sign-in, notebook list, note editor with a handwriting canvas, PDF reader with highlights, notes and ink. Contains `@main`. | iOS |
| `SmartNotesTests` | The suite. An executable, not an XCTest bundle — see below. | iOS, macOS |

`SmartNotesKit` and `SmartNotesDocuments` build for macOS as well as iOS, which
is what lets the whole contract, the store, the sync rules, the PDF annotation
round trip and the PencilKit round trip be tested on a machine with no
simulator. Only the SwiftUI layer is iOS-only.

## Shared contract

Nothing here re-specifies the contract; it mirrors it, and the fixtures are the
proof. `Sources/SmartNotesTests/FixtureTests.swift` decodes every file in
`shared/fixtures/v1` into its Swift type and re-encodes it to canonical bytes,
asserting the result is byte-identical to what the server and the web client
produce. A serialisation change on either side fails here rather than silently
diverging.

- The PDF on disk stays exactly the bytes the server hashed. A highlight is
  durable because it is an operation in the notebook's log, drawn onto the page
  on open — which is why it survives reopening *and* arrives from other devices.
- Handwriting is quantised integers (`[x, y, pressure, dt, ...]`), so a stroke
  drawn on iPad and one replayed elsewhere serialise identically. Stroke ids are
  content hashes, so saving an unchanged canvas writes no operations.
- Every local edit is persisted inside the mutation, before the view redraws.
  An edit made in airplane mode is on disk by the time it is on screen.

## Authentication

The MVP authenticates with a server-issued API token and has no signup UI, per
the implementation decision recorded for this work item. The app asks for a
server address and a token, probes `GET /v1/me` to turn it into a session, and
stores that session in Application Support. Isolation is still enforced
per-token by the server; the demo starts from a pre-provisioned token.

## The five states the screens must show

`Library.phase`, `NotebookSession.banner` and `StatusBanner` exist so these are
states with tests rather than incidental UI:

| State | Where it shows | Test |
| --- | --- | --- |
| Loading | `MessageView` with a spinner, on startup, notebook open and PDF download | `an account with no notebooks reaches the empty state, not an error` and neighbours |
| Empty | No notebooks; a notebook with no notes or PDFs | `a fresh notebook reports the empty state` |
| Error | A rejected token, an unreachable notebook, an unreadable PDF, a failed write | `a rejected token leaves the app signed out and says why`, `a server error with nothing cached becomes a failed state carrying the server's message` |
| Offline | An orange banner that says the edits are safe here, with a pending count | `a refresh that cannot reach the server keeps the cached list and reports offline`, `a notebook opened offline still edits, and reports what is waiting to sync` |
| Conflict | A banner with a Review action, and a sheet showing both sides with restore | `a conflict from another device is surfaced and its losing value can be restored` |

Conflicts and rejections outrank a clean sync result in the banner, because
those are the two the user has to act on. Being offline is deliberately not
styled as an error: the work is safe.

## Building and testing

```sh
ipad/Scripts/build-and-test.sh            # build for the host, run the tests
ipad/Scripts/build-and-test.sh --ios      # also compile every target for iOS
ipad/Scripts/build-and-test.sh --app      # also link SmartNotes.app for the iPad simulator
```

The script prefers `swift build` and falls back to direct `swiftc` invocations
with an explicit `--module-cache-path` when SwiftPM cannot run. That fallback is
also why the suite is an executable target rather than an XCTest bundle: it then
runs under a plain `swiftc` build with no test runner.

`--app` links `Sources/SmartNotesUI` into the executable (rather than a library,
since `@main` must live in the binary the bundle launches) and assembles
`SmartNotes.app` with `App/Info.plist` and the two dylibs. The bundle is built
against the simulator SDK so it links without a signing identity; a device build
differs only in `--target` and needs signing.

### What was and was not verified here

Verified on Xcode 26.6 (Apple Swift 6.3.3), 2026-08-28:

- `ipad/Scripts/build-and-test.sh --ios --app` → **74 passed, 0 failed**, all
  three targets compiled for `arm64-apple-ios17.0`, and `SmartNotes.app` linked
  for `arm64-apple-ios17.0-simulator`.

Not verified, with the exact failing commands:

- `swift build --package-path ipad` — fails before reading `Package.swift`:
  `error opening '/var/folders/…/C/clang/ModuleCache/Swift-….swiftmodule' for
  output: Operation not permitted`, then `unable to load standard library for
  target 'arm64-apple-macosx14.0'`. The sandbox denies the Darwin user cache
  directory SwiftPM insists on for the manifest compile. This is why the script
  has a fallback at all.
- `xcrun simctl list devices available` and `xcrun simctl bootstatus` — both
  print `xcrun: error: couldn't create cache file '/var/folders/…/T/xcrun_db-…'
  (errno=Operation not permitted)` and then `CoreSimulatorService connection
  became invalid. Simulator services will no longer be available.` No simulator
  can be booted, so the app was linked but never launched, and no UI test or
  screenshot exists.
- No physical Apple Pencil workflow was exercised. Pressure, azimuth and
  altitude are carried through `PencilKitInk` and covered by round-trip tests
  over synthetic `PKStroke`s; palm rejection, hover and double-tap are untested.
- `npm start` for the server is not reachable from this sandbox either (it
  cannot bind a socket), so the client was exercised against `FakeServer`, an
  in-process stand-in that enforces the same three rules the real server
  enforces on an incoming operation.
