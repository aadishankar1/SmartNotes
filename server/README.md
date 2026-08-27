# SmartNotes server

A locally runnable API for notebooks, notes and annotated PDFs, with
email/password accounts, per-user isolation, durable SQLite persistence, and
incremental synchronisation for offline-capable devices.

It has **no runtime dependencies** — only Node's standard library, including the
built-in `node:sqlite` binding — and shares its schemas, serialization and
reconciliation rules with clients through [`shared/`](../shared).

**Requires Node 22.5 or newer**, which is where `node:sqlite` appears.

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
| `src/store/sqlite.ts` | Durable SQLite persistence and transactions |
| `src/store/tables.ts` | Table names, row shapes and indexed columns |

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

**Storage is SQLite.** `smartnotes.db` in the data directory, opened through
the runtime's own `node:sqlite` binding, so there is still nothing to install
and no native addon to compile. Writes run inside `BEGIN IMMEDIATE … COMMIT`, so
a multi-row change lands whole or not at all, and `synchronous = FULL` fsyncs a
commit before it is acknowledged; a reopen replays the write-ahead log. The
physical layout is deliberately narrow — each table is `(id, doc)` with `doc`
holding the record as canonical JSON, plus a *generated* column per indexed
field (`users.email` unique, `sessions.userId`, `notebooks.ownerId`,
`revisions.noteId`, `revisions.notebookId`). SQLite derives those columns from
`doc` itself, so an index cannot drift from the record it indexes, and every
lookup the server performs is an indexed read rather than a scan. `findBy`
refuses a column that was not declared, so an unindexed scan cannot be
introduced by accident. `PRAGMA user_version` guards the layout: a database
written by a newer build is refused rather than misread.

`server/test/durability.test.ts` checks these claims against the file — tables,
`user_version`, canonical-JSON rows, the query plan for an indexed lookup, and
rollback — through a second connection, not through the running process.

**Blobs.** PDF bytes live under `blobs/<sha256>` and are verified against that
digest on read. Deleting a PDF tombstones the metadata and leaves the blob,
since content-addressed bytes may be shared by another document.
