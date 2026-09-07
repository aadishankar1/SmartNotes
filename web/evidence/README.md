# SmartNotes web — recorded evidence

Real-browser checks of the note list and editor, recorded on 2026-09-07 (UTC
2026-09-07T19:40:55Z) against source commit `a1cca5f2234b8ee41e67510d775e4bfcca210a41`
with Node v22.23.2 and headless Chromium 147.0.7727.15 (Playwright 1.59). The
built client (`web/dist`) was served at a real `http://localhost` origin via
Playwright route interception, with every `/v1/*` request proxied into the
compiled in-process server harness (`dist/server/test/helpers.js`), so fetch,
IndexedDB and the real sync contract were exercised end to end. All 29 checks
passed; the machine-readable log is [`checks.json`](./checks.json).

## Reproducing

```sh
npm run build                 # root: emits dist/server (in-process harness)
npm --prefix web run build    # emits web/dist
npm --prefix web run typecheck
npm --prefix web test         # 10/10, includes offline outbox + replay coverage
node web/scripts/contrast.mjs # WCAG body-text contrast gate (see below)
node web/scripts/verify-evidence.mjs   # re-runs every check below, rewrites the
                                       # screenshots and checks.json in this folder
```

`verify-evidence.mjs` needs Playwright with Chromium (`PLAYWRIGHT_DIR=<pkg dir>`
if it is not importable as `playwright`; `WS=<dir>` if `dist/` and `web/dist`
were built outside the repo root, `OUT=<dir>` to write elsewhere).

## Screenshots

| File | Size | Viewport / theme | Shows |
| --- | --- | --- | --- |
| [`note-list.png`](./note-list.png) | 1440×900, 79 754 B | 1440×900 light | 200-note list; the 120-character "Lecture 07 — Comparative …" title ellipsized to one line mid-list |
| [`note-editor.png`](./note-editor.png) | 1440×900, 100 176 B | 1440×900 light | Editor on the long-titled note with the ✓ "Saved to server" status after a server-acknowledged save |
| [`note-editor-failed.png`](./note-editor-failed.png) | 1440×900, 104 488 B | 1440×900 light | Failed-to-save status ("! The server could not save this note. Your draft is still here.") with the DRAFT-EDIT-KEEP draft still in the editor |
| [`note-editor-dark.png`](./note-editor-dark.png) | 1440×900, 104 985 B | 1440×900 dark | Dark theme activated purely by `prefers-color-scheme: dark` emulation |
| [`note-list-768.png`](./note-list-768.png) | 768×1024, 69 191 B | 768×1024 light | Portrait single-pane note list (notebook rail and editor pane collapsed) |
| [`note-editor-768.png`](./note-editor-768.png) | 768×1024, 40 602 B | 768×1024 light | Portrait editor with the persistent "← Notes" back action and save status |

SHA-256 (also in `checks.json`):

```
103446fe03f7258aaaf7a4489cfa3f38f0c51c01567b6a84c02c2b23b3737ee3  note-list.png
06331e0f2dec2470612238551ffb970003965972ac44fad2987f00fd2dd1bf95  note-editor.png
34c925778a2c5143570d2f3f83a4b45f7b1099c986b56ea1ed87b042f9ff6bd1  note-editor-failed.png
71e2bf78164ea7cf4f966e0caa514aadac3b4cd4fd98427c0f6ac01b66a34595  note-editor-dark.png
fc9401551448c814a0ec2d0066b3bad7f84b68c7f5d6f09c6c3538d8ec0ab827  note-list-768.png
670541a680512e0ce4b8f0287e41cd814fc61fb80b57eed3d1f430c84b458f75  note-editor-768.png
```

## Responsive: 768×1024 and 1440×900, no horizontal overflow

Measured as `document.documentElement.scrollWidth`, `document.body.scrollWidth`
and `window.innerWidth` after each navigation; overflow is absent when both
scroll widths are ≤ the inner width.

| Screen / state | Viewport | documentElement | body | innerWidth |
| --- | --- | --- | --- | --- |
| Note list, empty state | 1440×900 | 1440 | 1440 | 1440 |
| Note list, 200 notes | 1440×900 | 1440 | 1440 | 1440 |
| Editor, long-titled note | 1440×900 | 1440 | 1440 | 1440 |
| Note list (single pane) | 768×1024 | 768 | 768 | 768 |
| Editor (single pane) | 768×1024 | 768 | 768 | 768 |
| Note list after "← Notes" | 768×1024 | 768 | 768 | 768 |

At 768×1024 the notebook rail and editor pane collapse to single-pane
navigation (`display: none` verified via computed style); the editor keeps a
visible "← Notes" back action, and activating it returns to the list and moves
focus to the "Notes" heading. Moving list ↔ editor at both viewports never
produced horizontal scrolling.

## 200-note list performance and truncation

- 200 notes were seeded server-side (201 total with the note created in flow 1);
  the list rendered all 201 rows.
- 20 programmatic full-height scroll hops across the 201-row list completed in
  345 ms with requestAnimationFrame deltas averaging 17 ms and peaking at 17 ms
  (~60 fps, no dropped frames observed).
- The 120-character title renders on one line with `text-overflow: ellipsis`
  (`scrollWidth > clientWidth` confirmed clipping) and its row height (58 px)
  equals a short-titled row — the long title truncates rather than breaking the
  row. Visible in `note-list.png`.

## Light and dark via `prefers-color-scheme`

No in-app toggle exists; themes switched solely through media emulation:

- Light (default): body text `rgb(32, 38, 36)` (#202624) on background
  `rgb(246, 245, 241)` (#F6F5F1) — matches the design tokens.
- `page.emulateMedia({ colorScheme: 'dark' })`: body text `rgb(240, 243, 239)`
  (#F0F3EF) on background `rgb(21, 27, 24)` (#151B18). `note-editor-dark.png`
  captures the dark activation.

## Contrast gate

`node web/scripts/contrast.mjs` parses the shipped `web/src/styles.css` (not a
copy of its values) and exits 0 only when body text reaches 4.5:1 against both
background and surface in both themes. Recorded run:

| Theme | body on background | body on surface |
| --- | --- | --- |
| Light (#202624) | 14.11:1 vs #F6F5F1 | 15.39:1 vs #FFFFFF |
| Dark (#F0F3EF) | 15.62:1 vs #151B18 | 13.54:1 vs #1F2823 |

Negative test: degrading `--body` to `#9aa5a0` in a scratch copy made the same
script report 2.33:1 / 2.54:1 and exit 1, so the gate fails when tokens regress.

## Persistence walkthrough (create → save → reopen)

Signed up, created the "Biology 101" notebook, saw the "Create your first note"
empty state, created a note ("Not saved to server yet"), typed a title and body
("Unsaved changes"), saved — status walked through "Saving…" (spinner) to
"✓ Saved to server" only after the `/v1/sync` round trip acknowledged. After a
full page reload the note reopened with title and body intact from IndexedDB +
server.

## Failed-save / draft-retention / retry walkthrough (`?failSaves=1`)

1. Loaded `http://localhost/?failSaves=1`, opened the long-titled note, appended
   " DRAFT-EDIT-KEEP".
2. Clicked **Save note**. A MutationObserver recorded the status classes in
   order: `dirty → saving → failed` — the failure was observed, not inferred.
   The failed status reads "! The server could not save this note. Your draft
   is still here." in the danger tone (`note-editor-failed.png`), and the draft
   text remained in the editor.
3. Navigated back to `http://localhost/` (fault cleared). The draft, including
   " DRAFT-EDIT-KEEP", survived the reload via the queued outbox operation.
4. Clicked **Save note** again: status reached "✓ Saved to server", and a
   direct server read (`GET /v1/notes/:id` through the harness) returned a body
   containing "DRAFT-EDIT-KEEP" — the retry was server-acknowledged, not just
   locally displayed.

## Other recorded states

- List loading: delayed `/v1/notebooks` showed the reserved "Loading your
  notebook…" status with spinner.
- List error: a 500 from `/v1/notebooks` showed "Something went wrong." with a
  Retry action; clicking Retry after clearing the fault recovered without
  losing state.
- Editor states: empty ("Select a note"), default, dirty, saving, saved and
  failed-to-save were each observed during the flows above.
