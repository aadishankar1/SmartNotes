# SmartNotes

SmartNotes is a local-first notebook MVP. It supports account signup and login,
isolated notebooks and notes, PDF imports and annotations, and offline editing
that reconciles through a custom operation log. Conflicting fields use
last-writer-wins ordering; deleted records are kept as tombstones so they do
not reappear during sync.

## Run locally

Requirements: Node.js 22.5 or newer, npm, and Docker Compose (for the demo).

```sh
npm install
npm run build
npm test
npm --prefix web run build
docker compose up --build -d
SMARTNOTES_URL=http://localhost:8787 npm run health
```

Open http://localhost:8080. The browser app proxies `/v1/*` calls to the API;
the API health endpoint is available at http://localhost:8787/health. Data is
stored in the Compose volume `smartnotes-data` and therefore survives container
restarts. Stop the demo with `docker compose down` (use `-v` only when you want
to discard local data).

For a development server without Docker, run `npm start`; set
`SMARTNOTES_DATA_DIR` to choose its data location and `PORT`/`HOST` to choose
its address.

## Verify a clean checkout

Run the same installation, build, test, deploy, health, and web-journey steps
used by CI:

```sh
./scripts/verify.sh
```

The script requires Docker Compose and leaves the stack running on success so
the demo remains available. Use `docker compose down` when finished. It runs
the shared/server tests, the browser-shim end-to-end journey, and iPad checks
when the Apple toolchain is available. On non-macOS hosts, the iPad check is
reported as skipped with its exact unavailable command; it is never treated as
a passing iPad result.

## Test coverage

`e2e/browser-journey.sh` runs the real web modules against the real server API
with an IndexedDB and network browser shim, alongside the server API suite. It
covers signup/login, isolated CRUD, offline note edits followed by reconnect,
PDF annotation persistence, second-client convergence, duplicate-operation
rejection, and durable SQLite recovery after restart.

The iPad package has a separate command for an Apple/Xcode host:

```sh
./ipad/Scripts/build-and-test.sh --ios --app
```

## Architecture

- `shared/`: protocol, schemas, operation-log reconciliation, and fixtures.
- `server/`: Node HTTP API backed by durable SQLite (`node:sqlite`).
- `web/`: browser client with IndexedDB replica and sync outbox.
- `ipad/`: SwiftUI/PDFKit/PencilKit client and shared-fixture tests.
- `deploy/`: Docker images and reverse-proxy configuration for the local demo.
