# SmartNotes server

A locally runnable API for notebooks, notes and annotated PDFs, with
email/password accounts, per-user isolation, durable storage on the local
filesystem, and incremental synchronisation for offline-capable devices.

It has **no runtime dependencies** — only Node's standard library — and shares
its schemas, serialization and reconciliation rules with clients through
[`shared/`](../shared).

## Running it

```bash
npm run build        # tsc -b server
npm test             # shared + server suites (node:test)
npm run health       # health probe, exits non-zero when degraded
SMARTNOTES_DATA_DIR=./.smartnotes-data npm start
```

`npm run health` probes `SMARTNOTES_URL` when that is set; otherwise it runs the
real `/health` route in process against a scratch data directory, which
exercises the build, storage engine and router without needing a listening
socket.

## Shape

| File | Role |
| --- | --- |
| `src/app.ts` | Routes and error translation; returns an in-process handler |
| `src/server.ts` | The only module that touches a socket |
| `src/auth.ts` | scrypt password hashing, bearer sessions |
| `src/notebooks.ts` | One bounded operation log per notebook; the single write path |
| `src/pdfs.ts` | Content-addressed PDF blobs |
| `src/store/journal.ts` | Durable storage: journal + snapshots |

## Endpoints

```
GET    /health
POST   /v1/auth/signup | /v1/auth/login | /v1/auth/logout
GET    /v1/me
GET    /v1/notebooks                       POST /v1/notebooks
GET    /v1/notebooks/:id                   PATCH/DELETE /v1/notebooks/:id
GET    /v1/notebooks/:id/notes             POST /v1/notebooks/:id/notes
GET    /v1/notes/:id                       PATCH/DELETE /v1/notes/:id
GET    /v1/notes/:id/revisions
POST   /v1/pdfs                            GET /v1/notebooks/:id/pdfs
GET    /v1/pdfs/:id                        GET /v1/pdfs/:id/content   DELETE /v1/pdfs/:id
GET    /v1/pdfs/:id/annotations            POST /v1/pdfs/:id/annotations
PATCH  /v1/annotations/:id                 DELETE /v1/annotations/:id
POST   /v1/sync
```

## Design notes

**One write path.** A REST edit is an operation authored by the server on the
caller's behalf, appended to the same per-notebook log a device pushes into. A
web edit and an offline iPad edit therefore reconcile under identical rules, and
those rules are tested once, in `shared/test/reconcile.test.ts`.

**Bounded log, snapshot fallback.** Each notebook retains the most recent
operations (512 by default, `logLimit`); older ones fold into a checkpoint.
`POST /v1/sync` answers a current cursor with a delta and a cursor older than
the checkpoint with a full state snapshot, so a device that was away for a month
still converges.

**Missing entities look absent, not forbidden.** Another account's notebook
answers `404`, never `403`: a `403` would confirm the id exists.

**Storage is a journal, not SQLite.** Every committed transaction is one
CRC-checked line appended to `journal.log` and `fsync`ed before the write is
acknowledged; recovery replays it over `snapshot.json` and truncates a torn
tail. The durability contract — atomic multi-table transactions, fsync before
acknowledgement, crash-consistent restart — is the one the server relies on and
`server/test/durability.test.ts` proves.

SQLite was the obvious choice and was rejected for a concrete reason: the target
runtime here is Node 20, which has no built-in SQLite binding (`node:sqlite`
arrived in 22.5), and this repository is built with zero installed runtime
dependencies, so `better-sqlite3` — a native addon needing a compile or a
prebuilt download — was not available to depend on. Swapping in SQLite later is
a change to `src/store/journal.ts` alone: the rest of the server only uses
`get` / `all` / `find` / `transaction`.

**Blobs.** PDF bytes live under `blobs/<sha256>` and are verified against that
digest on read. Deleting a PDF tombstones the metadata and leaves the blob,
since content-addressed bytes may be shared by another document.
