#!/usr/bin/env node
// Real-browser evidence capture for the SmartNotes note list and editor.
//
// Serves the built web client (web/dist) at a real http://localhost origin via
// Playwright route interception and proxies /v1/* into the compiled in-process
// server harness (dist/server/test/helpers.js), so IndexedDB, fetch and the
// sync contract are all exercised without binding a socket. It walks the four
// product flows, measures horizontal overflow at 768x1024 and 1440x900,
// activates dark mode through prefers-color-scheme emulation, drives the
// ?failSaves=1 fault, and writes screenshots plus checks.json into OUT.
//
// Prerequisites: `npm run build` (root, emits dist/server) and
//   `npm --prefix web run build` (emits web/dist); Playwright with Chromium.
// Usage: node web/scripts/verify-evidence.mjs
//   WS=<runtime root containing dist/ and web/dist>   (default: repo root)
//   OUT=<screenshot directory>                        (default: web/evidence)
//   PLAYWRIGHT_DIR=<playwright package dir>           (default: import "playwright")

import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WS = process.env.WS ?? root;
const OUT = process.env.OUT ?? join(root, 'web', 'evidence');
mkdirSync(OUT, { recursive: true });

const pw = await (process.env.PLAYWRIGHT_DIR
  ? import(join(process.env.PLAYWRIGHT_DIR, 'index.mjs'))
  : import('playwright'));
const { harness } = await import(join(WS, 'dist/server/test/helpers.js'));
const h = harness();
const app = h.app;

const DIST = join(WS, 'web/dist');
const types = { html: 'text/html', js: 'text/javascript', css: 'text/css', map: 'application/json' };
function staticFile(p) {
  const rel = p === '/' ? 'web/index.html' : p.startsWith('/shared/') ? p.slice(1) : join('web', p.slice(1));
  const full = join(DIST, rel);
  if (!existsSync(full)) return null;
  return { body: readFileSync(full), contentType: types[full.split('.').pop()] ?? 'application/octet-stream' };
}

// Host-side fault injection for loading/error states the client cannot self-trigger.
const faults = { failNotebooks: false, delayNotebooks: 0, delaySync: 0 };

let browser;
try {
  browser = await pw.chromium.launch();
} catch {
  // macOS sandboxes that deny Mach bootstrap need a single-process shell.
  browser = await pw.chromium.launch({ args: ['--single-process', '--no-zygote', '--in-process-gpu', '--disable-gpu'] });
}
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.route('**/*', async (route) => {
  const url = new URL(route.request().url());
  if (url.pathname.startsWith('/v1/') || url.pathname === '/health') {
    if (url.pathname === '/v1/notebooks' && route.request().method() === 'GET') {
      if (faults.delayNotebooks) await new Promise((r) => setTimeout(r, faults.delayNotebooks));
      if (faults.failNotebooks) return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { message: 'The notebook service is unavailable.' } }) });
    }
    if (url.pathname === '/v1/sync' && faults.delaySync) await new Promise((r) => setTimeout(r, faults.delaySync));
    const post = route.request().postData();
    const res = await app.handle({ method: route.request().method(), path: url.pathname + url.search, headers: route.request().headers(), body: post ? JSON.parse(post) : undefined });
    return route.fulfill({ status: res.status, contentType: 'application/json', body: res.body === undefined ? '' : JSON.stringify(res.body) });
  }
  const f = staticFile(url.pathname);
  return f ? route.fulfill({ status: 200, body: f.body, contentType: f.contentType }) : route.fulfill({ status: 404, body: 'not found' });
});

const page = await context.newPage();
const results = [];
const shots = {};
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };
const shot = async (name, meta) => {
  await page.screenshot({ path: join(OUT, name + '.png') });
  shots[name + '.png'] = meta;
};
const noHScroll = async (label) => {
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, bw: document.body.scrollWidth }));
  check(`no horizontal scroll (${label})`, m.sw <= m.iw && m.bw <= m.iw, `documentElement.scrollWidth=${m.sw} body.scrollWidth=${m.bw} innerWidth=${m.iw}`);
};

// ---- Flow 1: signup, create notebook, empty state, first note, save, reopen intact.
await page.goto('http://localhost/');
await page.fill('input[name=name]', 'Avery Student');
await page.fill('input[name=email]', 'avery@example.com');
await page.fill('input[name=password]', 'a sound password 42');
await page.click('button[value=signup]');
await page.waitForSelector('#notebook-form');
await page.fill('#new-book', 'Biology 101');
await page.click('#notebook-form button');
await page.waitForSelector('.empty-list h3');
const emptyText = (await page.locator('.empty-list').textContent()).trim();
check('note list empty state invites first note', emptyText.includes('Create your first note') && /New note/.test(await page.locator('#empty-new').textContent()), emptyText.slice(0, 90));
await noHScroll('empty list 1440x900');

await page.click('#empty-new');
await page.waitForSelector('#note-title');
check('new note opens with title focused', (await page.evaluate(() => document.activeElement?.id)) === 'note-title');
check('new note announces not-yet-saved', (await page.locator('#save-status').textContent()).includes('Not saved to server yet'));
await page.fill('#note-title', 'Photosynthesis basics');
await page.click('#note-body');
await page.keyboard.type('Light reactions split water; the Calvin cycle fixes carbon.');
check('editing shows dirty (Unsaved changes)', (await page.locator('#save-status').textContent()).includes('Unsaved changes'));
faults.delaySync = 400;
await page.click('#save-note');
await page.waitForSelector('#save-status.saving');
check('saving state has spinner + Saving…', (await page.locator('#save-status').textContent()).includes('Saving') && (await page.locator('#save-status .spinner').count()) > 0);
await page.waitForSelector('#save-status.saved');
faults.delaySync = 0;
check('saved means server-acknowledged (✓ Saved to server)', (await page.locator('#save-status').textContent()).includes('Saved to server'));
await page.reload();
await page.waitForSelector('[data-note]');
await page.click('[data-note]');
await page.waitForSelector('#note-title');
check('flow1: reopened note text intact', (await page.inputValue('#note-title')) === 'Photosynthesis basics' && (await page.inputValue('#note-body')).includes('Calvin cycle'));

// ---- Seed 200 notes server-side, one with a 120-character title.
const login = await app.handle({ method: 'POST', path: '/v1/auth/login', headers: {}, body: { email: 'avery@example.com', password: 'a sound password 42' } });
const token = login.body.token;
const nbList = await app.handle({ method: 'GET', path: '/v1/notebooks', headers: { authorization: `Bearer ${token}` } });
const nbId = nbList.body.notebooks[0].id;
const longTitle = 'Lecture 07 — Comparative anatomy of vascular plants and the long march of terrestrial adaptation across geological epochs, part two'.slice(0, 120);
let longNoteId = null;
for (let i = 0; i < 200; i += 1) {
  const title = i === 60 ? longTitle : `Note ${String(i + 1).padStart(3, '0')} — quick capture`;
  const res = await app.handle({ method: 'POST', path: `/v1/notebooks/${nbId}/notes`, headers: { authorization: `Bearer ${token}` }, body: { title, body: `Body of seeded note ${i + 1}.`, position: 1000 + i } });
  if (res.status !== 201) throw new Error('seed failed: ' + JSON.stringify(res.body));
  if (i === 60) longNoteId = res.body.note.id;
}

await page.click(`[data-notebook="${nbId}"]`);
await page.waitForFunction(() => document.querySelectorAll('[data-note]').length > 200);
check('list renders all 201 notes', (await page.locator('.note-row').count()) === 201);
check('editor empty state names next step (Select a note)', ((await page.locator('.editor-pane .blank').textContent()) ?? '').includes('Select a note'));
const scrollProbe = await page.locator('.note-list').evaluate(async (el) => {
  const frames = [];
  let last = performance.now();
  let done = false;
  const tick = () => { const now = performance.now(); frames.push(now - last); last = now; if (!done) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  const t0 = performance.now();
  for (let i = 0; i <= 20; i += 1) {
    el.scrollTop = (el.scrollHeight - el.clientHeight) * (i % 2 === 0 ? i / 20 : 1 - i / 20);
    await new Promise((r) => requestAnimationFrame(r));
  }
  done = true;
  const t1 = performance.now();
  frames.shift();
  return { totalMs: Math.round(t1 - t0), maxFrameMs: Math.round(Math.max(...frames)), avgFrameMs: Math.round(frames.reduce((a, b) => a + b, 0) / frames.length) };
});
check('200-note list scrolls without stutter', scrollProbe.totalMs < 1000 && scrollProbe.maxFrameMs < 100, `20 programmatic scroll hops in ${scrollProbe.totalMs}ms, frame avg ${scrollProbe.avgFrameMs}ms max ${scrollProbe.maxFrameMs}ms`);
const rowGeom = await page.evaluate((longId) => {
  const longRow = document.querySelector(`[data-note="${longId}"]`)?.closest('.note-row');
  const shortRow = [...document.querySelectorAll('.note-row')].find((r) => r !== longRow);
  const strong = longRow.querySelector('strong');
  return { long: longRow.getBoundingClientRect().height, short: shortRow.getBoundingClientRect().height, clipped: strong.scrollWidth > strong.clientWidth, overflow: getComputedStyle(strong).textOverflow };
}, longNoteId);
check('120-char title ellipsized, row height unchanged', rowGeom.long === rowGeom.short && rowGeom.clipped && rowGeom.overflow === 'ellipsis', JSON.stringify(rowGeom));
await page.evaluate((longId) => document.querySelector(`[data-note="${longId}"]`).scrollIntoView({ block: 'center' }), longNoteId);
await noHScroll('200-note list 1440x900');
await shot('note-list', '1440x900 light — 200-note list, 120-char title ellipsized mid-list');

// ---- Flow 2: open the long-titled note, edit without losing focus/selection.
await page.click(`[data-note="${longNoteId}"]`);
await page.waitForSelector('#note-body');
await page.click('#note-body');
await page.evaluate(() => { const b = document.querySelector('#note-body'); b.setSelectionRange(b.value.length, b.value.length); });
const beforeLen = await page.evaluate(() => document.querySelector('#note-body').value.length);
await page.keyboard.type('0123456789', { delay: 15 });
const afterEdit = await page.evaluate(() => ({ active: document.activeElement?.id, len: document.querySelector('#note-body').value.length, selStart: document.querySelector('#note-body').selectionStart }));
check('flow2: 10 keystrokes keep focus and caret', afterEdit.active === 'note-body' && afterEdit.len === beforeLen + 10 && afterEdit.selStart === beforeLen + 10, JSON.stringify(afterEdit));
await page.click('#save-note');
await page.waitForSelector('#save-status.saved');
await shot('note-editor', '1440x900 light — editor with ✓ Saved to server status after editing the long-titled note');

// ---- List loading and error states (host-injected faults).
faults.delayNotebooks = 800;
const reloadP = page.reload();
await page.waitForSelector('.app-status .spinner', { timeout: 5000 }).catch(() => {});
check('list loading state shows spinner + text', (await page.locator('.app-status', { hasText: 'Loading your notebook' }).count()) > 0);
await reloadP;
faults.delayNotebooks = 0;
faults.failNotebooks = true;
await page.reload();
await page.waitForSelector('.app-status.error');
check('list error state explains and offers Retry', ((await page.locator('.app-status.error').textContent()).includes('Something went wrong')) && (await page.locator('#retry').count()) === 1);
faults.failNotebooks = false;
await page.click('#retry');
await page.waitForFunction(() => !document.querySelector('.app-status.error'));
check('Retry recovers from list error', true);

// ---- Flow 3: ?failSaves=1 fails the save, keeps the draft, retry succeeds.
await page.goto('http://localhost/?failSaves=1');
await page.waitForSelector('[data-note]');
await page.click(`[data-note="${longNoteId}"]`);
await page.waitForSelector('#note-body');
await page.click('#note-body');
await page.keyboard.type(' DRAFT-EDIT-KEEP');
await page.evaluate(() => {
  window.__saveStates = [];
  const record = () => { const el = document.querySelector('#save-status'); if (!el) return; const cls = [...el.classList].filter((c) => c !== 'save-status').join(',') || 'idle'; if (window.__saveStates.at(-1) !== cls) window.__saveStates.push(cls); };
  record();
  new MutationObserver(record).observe(document.querySelector('.editor-top'), { childList: true, subtree: true, attributes: true });
});
await page.click('#save-note');
await page.waitForSelector('#save-status.failed');
const seq = await page.evaluate(() => window.__saveStates);
check('failSaves: status walks dirty → saving → failed', seq.includes('saving') && seq.indexOf('saving') < seq.indexOf('failed'), JSON.stringify(seq));
check('failed state keeps the draft in the editor', (await page.inputValue('#note-body')).includes('DRAFT-EDIT-KEEP'));
await shot('note-editor-failed', '1440x900 light — failed-to-save status under ?failSaves=1, draft still in the editor');
await page.goto('http://localhost/');
await page.waitForSelector('[data-note]');
await page.click(`[data-note="${longNoteId}"]`);
await page.waitForSelector('#note-body');
check('draft survives reload after failed save', (await page.inputValue('#note-body')).includes('DRAFT-EDIT-KEEP'));
await page.click('#save-note');
await page.waitForSelector('#save-status.saved');
const serverNote = await app.handle({ method: 'GET', path: `/v1/notes/${longNoteId}`, headers: { authorization: `Bearer ${token}` } });
check('flow3: retry reaches server acknowledgement', serverNote.body.note.body.includes('DRAFT-EDIT-KEEP'));

// ---- Theme tokens through prefers-color-scheme.
const light = await page.evaluate(() => ({ color: getComputedStyle(document.body).color, bg: getComputedStyle(document.body).backgroundColor }));
check('light tokens active (#202624 on #F6F5F1)', light.color === 'rgb(32, 38, 36)' && light.bg === 'rgb(246, 245, 241)', JSON.stringify(light));
await page.emulateMedia({ colorScheme: 'dark' });
const dark = await page.evaluate(() => ({ color: getComputedStyle(document.body).color, bg: getComputedStyle(document.body).backgroundColor }));
check('dark tokens active (#F0F3EF on #151B18)', dark.color === 'rgb(240, 243, 239)' && dark.bg === 'rgb(21, 27, 24)', JSON.stringify(dark));
await shot('note-editor-dark', '1440x900 dark (prefers-color-scheme: dark) — editor with dark theme tokens');
await page.emulateMedia({ colorScheme: 'light' });
await noHScroll('editor 1440x900');

// ---- Flow 4: portrait 768x1024, list↔editor navigation, no horizontal scroll.
await page.setViewportSize({ width: 768, height: 1024 });
await page.goto('http://localhost/');
await page.waitForSelector('[data-note]');
await noHScroll('list 768x1024');
const portrait = await page.evaluate(() => ({ notebooksHidden: getComputedStyle(document.querySelector('.notebooks')).display === 'none', editorHidden: getComputedStyle(document.querySelector('.editor-pane')).display === 'none' }));
check('portrait shows single-pane note list', portrait.notebooksHidden && portrait.editorHidden, JSON.stringify(portrait));
await shot('note-list-768', '768x1024 light — single-pane note list with the 200 seeded notes');
await page.click(`[data-note="${longNoteId}"]`);
await page.waitForSelector('#note-body');
check('portrait editor has persistent back action', await page.locator('#back').isVisible());
await noHScroll('editor 768x1024');
await shot('note-editor-768', '768x1024 light — portrait editor with ← Notes back action and save status');
await page.click('#back');
await page.waitForFunction(() => !document.querySelector('#note-body'));
check('back returns to list, focuses Notes heading', (await page.evaluate(() => document.activeElement?.id)) === 'notes-heading');
await noHScroll('list after back 768x1024');

// ---- Write metadata + results.
function pngSize(buf) { return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }; }
const screenshots = {};
for (const name of readdirSync(OUT).filter((f) => f.endsWith('.png')).sort()) {
  const buf = readFileSync(join(OUT, name));
  screenshots[name] = { ...pngSize(buf), bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex'), describes: shots[name] ?? 'supplementary' };
}
let commit = 'unknown';
try { commit = execSync('git rev-parse HEAD', { cwd: root }).toString().trim(); } catch {}
const failed = results.filter((r) => !r.ok);
writeFileSync(join(OUT, 'checks.json'), JSON.stringify({
  recordedAt: new Date().toISOString(),
  commit,
  node: process.version,
  chromium: browser.version(),
  origin: 'http://localhost (Playwright route-intercepted; /v1/* proxied to in-process server harness)',
  passed: results.length - failed.length,
  total: results.length,
  results,
  screenshots,
}, null, 2) + '\n');

console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) console.log('FAILED:', failed.map((f) => f.name).join('; '));
await browser.close();
h.cleanup();
process.exit(failed.length ? 1 : 0);
