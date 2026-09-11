import { Api } from './api.js';
import { escapeHtml as esc } from './ui/html.js';
import { LocalDatabase } from './db.js';
import { SyncEngine } from './sync.js';
import { armFaultsFromQuery } from './faults.js';
import { savePresentation, type SavePresentation } from './status.js';
import type { Note, Notebook, PdfDocument } from './types.js';

const root = document.querySelector<HTMLElement>('#app')!;
let engine: SyncEngine;
let notebooks: Notebook[] = [];
let selectedNoteId: string | null = null;
let selectedPdfId: string | null = null;
let selectedPdfUrl: string | null = null;
let busy = false;
let message = '';
let error = '';
let notebookLoad: { id: string; title: string; phase: 'loading' | 'error' } | null = null;
/** Which note the editor fields currently in the DOM belong to. */
let renderedNoteId: string | null = null;
/** Note-list scroll offset, preserved across re-renders and portrait trips. */
let listScrollTop = 0;

function state() { return engine.snapshot(); }
function setMessage(value = '') { message = value; error = ''; render(); }
function setError(value: unknown) { error = value instanceof Error ? value.message : String(value); message = ''; render(); }
async function act(action: () => Promise<void>) { if (busy) return; busy = true; render(); try { await action(); } catch (cause) { setError(cause); } finally { busy = false; render(); } }

/** Keep the current replica and locally saved draft until the new read succeeds. */
async function openNotebook(id: string): Promise<void> {
  if (busy) return;
  stashEditor();
  busy = true;
  error = '';
  notebookLoad = { id, title: notebooks.find(book => book.id === id)?.title ?? 'notebook', phase: 'loading' };
  render();
  let draftStored = false;
  try {
    await engine.save();
    draftStored = true;
    await engine.chooseNotebook(id);
    selectedNoteId = null; selectedPdfId = null; listScrollTop = 0;
    notebookLoad = null;
  } catch {
    if (draftStored && notebookLoad) notebookLoad.phase = 'error';
    else { notebookLoad = null; error = 'Could not store your draft on this device. Keep this page open and try saving again.'; }
  } finally { busy = false; render(); }
}

function notebookLoadingTemplate(editor = false): string {
  return `<div class="notebook-loading" role="status" aria-label="${editor ? 'Editor' : 'Note list'} loading"><p>Opening ${esc(notebookLoad?.title ?? 'notebook')}…</p><div aria-hidden="true">${'<div class="skeleton-row"></div>'.repeat(editor ? 4 : 6)}</div></div>`;
}
function notebookErrorTemplate(): string {
  return `<div class="empty-state" role="alert"><h2>Could not open ${esc(notebookLoad!.title)}</h2><p>Your current notes and draft are still on this device. Check your connection, then try again.</p><button id="retry-notebook" class="primary">Retry opening notebook</button><button id="keep-notebook" class="secondary">Back to current notebook</button></div>`;
}

function currentNote(): Note | null { return state().replica?.notes.find(note => note.id === selectedNoteId) ?? null; }
function currentPdf(): PdfDocument | null { return state().replica?.pdfs.find(pdf => pdf.id === selectedPdfId) ?? null; }

/** How the save pill should read right now, including the queued-draft case. */
function pillPresentation(): SavePresentation {
  const status = engine.saveStatus;
  if (status === 'failed') return savePresentation('failed', engine.lastSaveError);
  if (status === 'idle' && selectedNoteId && engine.pendingOps(selectedNoteId) > 0) {
    return savePresentation('failed', 'Not saved to the server yet — your draft is kept on this device');
  }
  return savePresentation(status);
}

function pillHtml(): string {
  const p = pillPresentation();
  return `<span id="save-status" class="pill pill-${p.tone}" role="status"><span class="pill-icon" aria-hidden="true">${esc(p.icon)}</span><span>${esc(p.label)}</span></span>`;
}

function retryVisible(): boolean {
  return pillPresentation().tone === 'danger';
}

/** Updates the save pill and retry button in place, so typing focus survives. */
function updateSaveUi(): void {
  const pill = document.querySelector<HTMLElement>('#save-status');
  if (pill) {
    const p = pillPresentation();
    pill.className = `pill pill-${p.tone}`;
    pill.innerHTML = `<span class="pill-icon" aria-hidden="true">${esc(p.icon)}</span><span>${esc(p.label)}</span>`;
  }
  const retry = document.querySelector<HTMLButtonElement>('#retry-save');
  if (retry) retry.hidden = !retryVisible();
}

function render(): void {
  const current = state(); const session = current.session;
  // Carry any in-progress editor text across the re-render: a render must
  // never discard a draft the user has typed but not yet saved.
  const titleField = document.querySelector<HTMLInputElement>('#note-title');
  const bodyField = document.querySelector<HTMLTextAreaElement>('#note-body');
  const carried = renderedNoteId && (titleField || bodyField)
    ? { noteId: renderedNoteId, title: titleField?.value ?? null, body: bodyField?.value ?? null }
    : null;
  const oldList = document.querySelector<HTMLElement>('.note-list');
  if (oldList && oldList.offsetParent) listScrollTop = oldList.scrollTop;
  const active = document.activeElement;
  const focusId = active instanceof HTMLElement ? active.id : '';
  const selection = (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)
    ? { start: active.selectionStart, end: active.selectionEnd } : null;

  if (!session) { renderedNoteId = null; root.innerHTML = authTemplate(); bindAuth(); return; }
  const replica = current.replica; const offline = !navigator.onLine;
  const draft = carried && carried.noteId === selectedNoteId ? carried : null;
  root.innerHTML = `<div class="shell">
  <header class="topbar"><h1>SmartNotes</h1><div class="row"><span class="muted">${esc(session.displayName)}</span><button class="ghost" id="logout">Log out</button></div></header>
  <p id="app-status" class="app-status ${error ? 'is-error' : offline ? 'is-offline' : ''}" role="status"><span>${esc(error || (busy ? 'Loading…' : offline ? `Offline — ${current.outbox.length} change(s) queued on this device.` : message || (current.outbox.length ? `${current.outbox.length} change(s) waiting to sync.` : 'All changes synced.')))}</span>${!offline ? '<button class="ghost" id="sync">Sync now</button>' : ''}</p>
  <div class="layout ${!notebookLoad && (selectedNoteId || selectedPdfId) ? 'show-editor' : ''}">
    <aside class="list-pane">
      <div class="pane-head">
        <label class="visually-hidden" for="notebook-picker">Notebook</label>
        <select id="notebook-picker" ${!notebooks.length || busy ? 'disabled' : ''}>${notebooks.length ? '' : '<option value="">No notebooks yet</option>'}${!replica ? '<option value="" selected disabled>Choose a notebook…</option>' : ''}${notebooks.map(notebook => `<option value="${esc(notebook.id)}" ${(notebookLoad?.id ?? replica?.notebook.id) === notebook.id ? 'selected' : ''}>${esc(notebook.title)}</option>`).join('')}</select>
        <button id="new-note" class="primary" ${notebookLoad ? 'disabled' : ''}>New note</button>
      </div>
      ${listTemplate(replica)}
      ${notebookLoad ? '' : `<details class="tools"><summary>Notebook tools &amp; PDFs</summary><div class="stack">
        <form id="notebook-form" class="row"><input name="title" required placeholder="New notebook title" aria-label="New notebook title" /><button class="secondary">Create notebook</button></form>
        ${replica ? `<div class="row"><input id="notebook-title" value="${esc(replica.notebook.title)}" aria-label="Notebook title" /><button id="save-notebook" class="secondary">Rename</button></div>
        <div class="row"><button id="delete-notebook" class="ghost-danger">Delete notebook</button><label class="secondary file-btn"><input id="pdf-upload" type="file" accept="application/pdf" hidden />Import PDF</label></div>
        ${replica.pdfs.length ? `<div class="stack">${replica.pdfs.map(pdf => `<button class="pdf-open" data-pdf="${esc(pdf.id)}">PDF: ${esc(pdf.filename)}</button>`).join('')}</div>` : ''}` : ''}
      </div></details>`}
    </aside>
    <section class="editor-pane" aria-busy="${notebookLoad?.phase === 'loading'}">${notebookLoad?.phase === 'loading' ? notebookLoadingTemplate(true) : notebookLoad?.phase === 'error' ? '<div class="empty-state"><p>Your current draft is kept. Retry opening the notebook or return to your current notes.</p></div>' : currentNote() ? editorTemplate(currentNote()!, draft) : currentPdf() ? pdfTemplate(currentPdf()!) : replica ? '<div class="empty-state"><p>Select a note to read or edit — or create a new one.</p></div>' : ''}</section>
  </div></div>`;
  renderedNoteId = notebookLoad ? null : currentNote()?.id ?? null;
  bindApp();
  const newList = document.querySelector<HTMLElement>('.note-list');
  if (newList) newList.scrollTop = listScrollTop;
  if (focusId) {
    const el = document.getElementById(focusId);
    if (el) {
      el.focus();
      if (selection && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && selection.start !== null) {
        try { el.setSelectionRange(selection.start, selection.end); } catch { /* not a text-selection input */ }
      }
    }
  }
}

function listTemplate(replica: ReturnType<typeof state>['replica']): string {
  if (notebookLoad?.phase === 'loading') return notebookLoadingTemplate();
  if (notebookLoad?.phase === 'error') return notebookErrorTemplate();
  if (busy && !replica) return `<div class="note-list" aria-hidden="true">${'<div class="skeleton-row"></div>'.repeat(6)}</div>`;
  if (!replica) {
    return notebooks.length
      ? '<div class="empty-state"><p>Choose a notebook above to see its notes.</p></div>'
      : '<div class="empty-state"><h2>Welcome to SmartNotes</h2><p>Create a notebook below, then create your first note inside it.</p></div>';
  }
  const notes = [...replica.notes].sort((a, b) => a.position - b.position);
  if (!notes.length) {
    return '<div class="empty-state"><h2>Create your first note</h2><p>Notes are saved on this device and synced to your account, so they follow you everywhere.</p><button id="new-note-empty" class="primary">New note</button></div>';
  }
  return `<nav class="note-list" aria-label="Notes">${notes.map((note, index) => `<div class="note-row ${selectedNoteId === note.id ? 'is-selected' : ''}"><button class="note-open" data-note="${esc(note.id)}" ${selectedNoteId === note.id ? 'aria-current="true"' : ''}>${esc(note.title || 'Untitled note')}</button><button class="icon-btn" data-move="${esc(note.id)}" data-direction="-1" aria-label="Move note up" ${index === 0 ? 'disabled' : ''}>↑</button><button class="icon-btn" data-move="${esc(note.id)}" data-direction="1" aria-label="Move note down" ${index === notes.length - 1 ? 'disabled' : ''}>↓</button></div>`).join('')}</nav>`;
}

function editorTemplate(note: Note, draft: { title: string | null; body: string | null } | null): string {
  const title = draft?.title ?? note.title;
  const body = draft?.body ?? note.body;
  return `<div class="editor">
    <div class="editor-bar">
      <button id="back-to-list" class="ghost back-btn">← Notes</button>
      ${pillHtml()}
      <span class="grow"></span>
      <button id="retry-save" class="secondary" ${retryVisible() ? '' : 'hidden'}>Retry</button>
      <button id="save-note" class="primary">Save</button>
      <button id="delete-note" class="ghost-danger">Delete</button>
    </div>
    <div class="editor-body">
      <input id="note-title" class="note-title-input" value="${esc(title)}" aria-label="Note title" placeholder="Untitled note" />
      <textarea id="note-body" aria-label="Note body" placeholder="Start writing…">${esc(body)}</textarea>
    </div>
  </div>`;
}

function pdfTemplate(pdf: PdfDocument): string {
  const replica = state().replica!;
  const annotations = replica.annotations.filter(annotation => annotation.pdfId === pdf.id);
  return `<div class="editor"><div class="editor-bar"><button id="back-to-list" class="ghost back-btn">← Notes</button><h3 class="pdf-title">${esc(pdf.filename)}</h3></div><div class="editor-body stack">${selectedPdfUrl ? `<object class="pdf" data="${esc(selectedPdfUrl)}" type="application/pdf">PDF preview unavailable.</object>` : '<p class="muted">Loading PDF…</p>'}<form id="annotation" class="row"><input name="text" required placeholder="Add an annotation" aria-label="Annotation text" /><button class="secondary">Add annotation</button></form><div class="stack"><strong>Annotations</strong>${annotations.length ? annotations.map(annotation => `<div class="row annotation"><span>${esc(annotation.text || annotation.kind)}</span><button data-delete-annotation="${esc(annotation.id)}" class="ghost-danger">Delete</button></div>`).join('') : '<p class="muted">No annotations yet.</p>'}</div></div></div>`;
}

function authTemplate() { return `<section class="auth stack"><h1>SmartNotes</h1><p class="muted">Your notes stay available offline and synchronize when you reconnect.</p><p class="app-status ${error ? 'is-error' : ''}" role="status">${esc(error || message)}</p><form id="auth" class="stack"><input name="name" placeholder="Display name (for signup)" aria-label="Display name" /><input name="email" type="email" required placeholder="you@example.com" aria-label="Email" /><input name="password" type="password" required minlength="10" placeholder="Password (10+ characters)" aria-label="Password" /><div class="row"><button name="mode" value="login" class="primary">Log in</button><button class="secondary" name="mode" value="signup">Sign up</button></div></form></section>`; }

/** Queues any unsaved editor text locally before navigating away from a note. */
function stashEditor(): void {
  const note = state().replica?.notes.find(item => item.id === renderedNoteId);
  if (!note) return;
  const title = document.querySelector<HTMLInputElement>('#note-title')?.value;
  const body = document.querySelector<HTMLTextAreaElement>('#note-body')?.value;
  if (title === undefined && body === undefined) return;
  if ((title ?? note.title) !== note.title || (body ?? note.body) !== note.body) {
    engine.queue('note', note.id, { title: title ?? note.title, body: body ?? note.body, updatedAt: Date.now() });
  }
}

async function createNote(): Promise<void> {
  if (!state().replica) { setError('Create a notebook first — notes live inside one.'); return; }
  stashEditor();
  const id = `note_${crypto.randomUUID().replaceAll('-', '')}`; const at = Date.now();
  engine.queue('note', id, { title: '', body: '', position: at, createdAt: at, updatedAt: at });
  selectedNoteId = id; selectedPdfId = null;
  await engine.save();
  render();
  document.querySelector<HTMLInputElement>('#note-title')?.focus();
  if (navigator.onLine) { await engine.push(); render(); }
}

async function saveSelectedNote(): Promise<void> {
  const note = currentNote(); if (!note) return;
  const title = document.querySelector<HTMLInputElement>('#note-title')?.value ?? note.title;
  const body = document.querySelector<HTMLTextAreaElement>('#note-body')?.value ?? note.body;
  await engine.saveNote(note.id, { title, body });
  render();
}

function bindAuth() { document.querySelector<HTMLFormElement>('#auth')!.addEventListener('submit', event => { event.preventDefault(); const submitter = (event as SubmitEvent).submitter as HTMLButtonElement; const form = new FormData(event.currentTarget as HTMLFormElement); act(async () => { const email = String(form.get('email')); const password = String(form.get('password')); const api = new Api(() => null); const response = submitter.value === 'signup' ? await api.signup(email, password, String(form.get('name'))) : await api.login(email, password); state().session = { token: response.token, email: response.user.email, displayName: response.user.displayName }; await engine.save(); notebooks = (await new Api(() => state().session).notebooks()).notebooks; setMessage('Welcome to SmartNotes.'); }); }); }

function bindApp() {
  document.querySelector('#retry-notebook')?.addEventListener('click', () => { if (notebookLoad) void openNotebook(notebookLoad.id); });
  document.querySelector('#keep-notebook')?.addEventListener('click', () => { notebookLoad = null; render(); });
  document.querySelector('#logout')?.addEventListener('click', () => act(async () => { state().session = null; state().replica = null; state().outbox = []; notebookLoad = null; selectedNoteId = null; selectedPdfId = null; notebooks = []; await engine.save(); }));
  document.querySelector('#sync')?.addEventListener('click', () => act(async () => { if (!state().replica) return; const ok = await engine.push(); notebooks = (await new Api(() => state().session).notebooks()).notebooks; if (!ok) throw new Error(engine.lastSaveError); setMessage(engine.conflictMessages().join(' ') || 'All changes synchronized.'); }));
  document.querySelector<HTMLSelectElement>('#notebook-picker')?.addEventListener('change', event => { const id = (event.currentTarget as HTMLSelectElement).value; if (!id) return; void openNotebook(id); });
  document.querySelector<HTMLFormElement>('#notebook-form')?.addEventListener('submit', event => { event.preventDefault(); const title = String(new FormData(event.currentTarget as HTMLFormElement).get('title')); act(async () => { await engine.addNotebook(title); notebooks = (await new Api(() => state().session).notebooks()).notebooks; selectedNoteId = null; selectedPdfId = null; setMessage('Notebook created.'); }); });
  document.querySelector('#save-notebook')?.addEventListener('click', () => { const title = document.querySelector<HTMLInputElement>('#notebook-title')!.value.trim(); void act(async () => { const replica = state().replica!; if (!title) throw new Error('A notebook needs a title.'); if (!navigator.onLine) { engine.queue('notebook', replica.notebook.id, { title, updatedAt: Date.now() }); await engine.save(); setMessage('Notebook rename saved locally.'); return; } const updated = await new Api(() => state().session).updateNotebook(replica.notebook.id, title); replica.notebook = updated.notebook; await engine.save(); notebooks = (await new Api(() => state().session).notebooks()).notebooks; setMessage('Notebook renamed.'); }); });
  document.querySelector('#delete-notebook')?.addEventListener('click', () => act(async () => { const replica = state().replica!; if (!navigator.onLine) throw new Error('Notebook deletion needs a connection.'); await new Api(() => state().session).deleteNotebook(replica.notebook.id); notebooks = (await new Api(() => state().session).notebooks()).notebooks; state().replica = null; state().activeNotebookId = null; selectedNoteId = null; selectedPdfId = null; await engine.save(); setMessage('Notebook deleted.'); }));
  document.querySelector('#new-note')?.addEventListener('click', () => void createNote());
  document.querySelector('#new-note-empty')?.addEventListener('click', () => void createNote());
  document.querySelectorAll<HTMLButtonElement>('[data-note]').forEach(button => button.addEventListener('click', () => { stashEditor(); selectedPdfId = null; selectedNoteId = button.dataset['note']!; render(); }));
  document.querySelector('#back-to-list')?.addEventListener('click', () => { stashEditor(); selectedNoteId = null; selectedPdfId = null; render(); });
  document.querySelectorAll<HTMLButtonElement>('[data-move]').forEach(button => button.addEventListener('click', () => act(async () => { const replica = state().replica!; const ordered = [...replica.notes].sort((a, b) => a.position - b.position); const index = ordered.findIndex(note => note.id === button.dataset['move']); const other = ordered[index + Number(button.dataset['direction'])]; const note = ordered[index]; if (!note || !other) return; const at = Date.now(); engine.queue('note', note.id, { position: other.position, updatedAt: at }); engine.queue('note', other.id, { position: note.position, updatedAt: at }); await engine.save(); if (navigator.onLine) await engine.push(); })));
  document.querySelectorAll<HTMLButtonElement>('[data-pdf]').forEach(button => button.addEventListener('click', () => act(async () => { stashEditor(); selectedNoteId = null; selectedPdfId = button.dataset['pdf']!; if (selectedPdfUrl) URL.revokeObjectURL(selectedPdfUrl); selectedPdfUrl = null; if (navigator.onLine) { const view = await new Api(() => state().session).annotations(selectedPdfId); state().replica!.annotations = [...state().replica!.annotations.filter(annotation => annotation.pdfId !== selectedPdfId), ...view.annotations]; await engine.save(); selectedPdfUrl = await new Api(() => state().session).pdfUrl(selectedPdfId); } })));
  document.querySelector('#save-note')?.addEventListener('click', () => void saveSelectedNote());
  document.querySelector('#retry-save')?.addEventListener('click', () => { void engine.push().then(() => render()); });
  document.querySelector('#delete-note')?.addEventListener('click', () => act(async () => { if (!selectedNoteId) return; engine.queue('note', selectedNoteId, {}, true); selectedNoteId = null; await engine.save(); if (navigator.onLine) await engine.push(); }));
  document.querySelector<HTMLInputElement>('#pdf-upload')?.addEventListener('change', event => { const file = (event.currentTarget as HTMLInputElement).files?.[0]; if (!file) return; act(async () => { if (!navigator.onLine) throw new Error('PDF import needs a connection; your existing notes can still be edited offline.'); const raw = new Uint8Array(await file.arrayBuffer()); let binary = ''; raw.forEach(byte => { binary += String.fromCharCode(byte); }); const pdf = await new Api(() => state().session).uploadPdf(state().replica!.notebook.id, file.name, btoa(binary)); state().replica!.pdfs.push(pdf.pdf); await engine.save(); selectedPdfId = pdf.pdf.id; selectedNoteId = null; setMessage('PDF imported.'); }); });
  document.querySelector<HTMLFormElement>('#annotation')?.addEventListener('submit', event => { event.preventDefault(); if (!selectedPdfId) return; const text = String(new FormData(event.currentTarget as HTMLFormElement).get('text')); act(async () => { const id = `anno_${crypto.randomUUID().replaceAll('-', '')}`; const at = Date.now(); engine.queue('annotation', id, { pdfId: selectedPdfId, page: 0, kind: 'note', rect: null, color: '#ffd60a', text, strokeId: null, createdAt: at, updatedAt: at }); await engine.save(); if (navigator.onLine) await engine.push(); setMessage('Annotation saved locally and queued for synchronization.'); }); });
  document.querySelectorAll<HTMLButtonElement>('[data-delete-annotation]').forEach(button => button.addEventListener('click', () => act(async () => { engine.queue('annotation', button.dataset['deleteAnnotation']!, {}, true); await engine.save(); if (navigator.onLine) await engine.push(); })));
}

async function start() {
  armFaultsFromQuery(window.location.search);
  const db = await LocalDatabase.open();
  let local: Awaited<ReturnType<LocalDatabase['read']>> | null = null;
  const api = new Api(() => local?.session ?? null);
  engine = new SyncEngine(db, api);
  engine.onStatus = updateSaveUi;
  local = await engine.load();
  if (local.session && navigator.onLine) { try { notebooks = (await api.notebooks()).notebooks; } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); } }
  window.addEventListener('online', () => { if (state().replica && state().outbox.length) void act(async () => { await engine.push(); notebooks = (await api.notebooks()).notebooks; setMessage('Queued changes synchronized.'); }); else render(); });
  window.addEventListener('offline', render);
  render();
}
void start().catch(setError);
