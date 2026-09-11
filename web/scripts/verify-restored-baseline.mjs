// Run against an isolated local SmartNotes API + built web preview.
// BASE_URL=http://127.0.0.1:51007/web/index.html PLAYWRIGHT_DIR=/path/to/playwright node web/scripts/verify-restored-baseline.mjs
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const base = process.env.BASE_URL;
assert(base && ['127.0.0.1', 'localhost'].includes(new URL(base).hostname), 'Use an isolated local preview');
const pw = process.env.PLAYWRIGHT_DIR ? await import(join(process.env.PLAYWRIGHT_DIR, 'index.mjs')) : await import('playwright');
const out = process.env.OUT || 'web/evidence/restored-baseline';
mkdirSync(out, { recursive: true });
const browser = await pw.chromium.launch({ channel: 'chrome' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'dark' });
const page = await context.newPage();
const errors = []; page.on('pageerror', e => errors.push(e.message));
const checks = []; const pass = name => { checks.push(name); console.log('PASS', name); };
const email = `baseline-${Date.now()}@example.test`, password = 'Local preview verification 2026!';
const saved = () => page.waitForSelector('#save-status.pill-ok');
const tools = async () => { if (!await page.locator('.tools').evaluate(e => e.open)) await page.locator('.tools summary').click(); };
const createBook = async title => {
  await tools(); await page.locator('#notebook-form input').fill(title); await page.locator('#notebook-form button').click();
  await page.waitForFunction(t => document.querySelector('#notebook-picker option:checked')?.textContent === t, title);
  return page.locator('#notebook-picker').inputValue();
};
try {
  await page.goto(base);
  await page.getByLabel('Display name', { exact: true }).fill('Relay verification');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign up', exact: true }).click();
  await page.waitForSelector('#notebook-picker');
  const a = await createBook('Biology 101');
  assert.match(await page.locator('.list-pane').innerText(), /Create your first note/); pass('Account and notebook creation reach the empty note state');
  await page.locator('#new-note-empty').click(); await saved();
  await page.locator('#note-title').fill('Photosynthesis basics');
  await page.locator('#note-body').fill('Light reactions split water. The Calvin cycle fixes carbon.');
  await page.locator('#save-note').click(); await saved();
  await page.reload(); await page.locator('[data-note]').click();
  assert.match(await page.locator('#note-body').inputValue(), /Calvin cycle/); pass('Save and reload preserve the title and body');
  await tools(); await page.locator('#notebook-title').fill('Biology — renamed'); await page.locator('#save-notebook').click();
  await page.waitForFunction(() => document.querySelector('#notebook-picker option:checked')?.textContent === 'Biology — renamed'); pass('Rename uses the typed title before the busy render');
  const b = await createBook('Chemistry 101');
  await page.locator('#notebook-picker').selectOption(a); await page.locator('[data-note]').click();
  const draft = 'Unsaved lecture draft must survive a failed notebook read.';
  await page.locator('#note-body').fill(draft);
  const badUrl = `${new URL(base).origin}/v1/notebooks/${b}`;
  await page.route(badUrl, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({error:{message:'Notebook read unavailable for verification'}}) }));
  await page.locator('#notebook-picker').selectOption(b); await page.waitForSelector('#keep-notebook');
  await page.screenshot({ path: join(out, 'notebook-recovery.png') });
  await page.locator('#keep-notebook').click();
  assert.equal(await page.locator('#note-body').inputValue(), draft); pass('Failed notebook read leaves the current draft recoverable');
  await page.unroute(badUrl);
  await page.locator('#notebook-picker').selectOption(b); await page.waitForFunction(id => document.querySelector('#notebook-picker')?.value === id && !document.querySelector('.notebook-loading'), b);
  await page.locator('#notebook-picker').selectOption(a); await page.locator('[data-note]').click();
  assert.equal(await page.locator('#note-body').inputValue(), draft); pass('Queued draft survives switching away and back');
  await page.locator('#save-note').click(); await saved();
  await page.goto(base + '?failSaves=1'); await page.locator('[data-note]').click();
  const recovered = 'Lecture draft retained after a failed save and recovered to the server.';
  await page.locator('#note-body').fill(recovered); await page.locator('#save-note').click(); await page.waitForSelector('#save-status.pill-danger');
  await page.reload(); await page.locator('[data-note]').click(); assert.equal(await page.locator('#note-body').inputValue(), recovered);
  pass('Failed save keeps the draft through reload');
  await page.goto(base); await page.locator('[data-note]').click(); await page.locator('#retry-save').click(); await saved(); pass('Retry clears the failure only after server acknowledgement');
  await page.screenshot({ path: join(out, 'notebook-editor.png') });
  const other = await browser.newContext(); const second = await other.newPage();
  await second.goto(base); await second.getByLabel('Email', {exact:true}).fill(email); await second.getByLabel('Password',{exact:true}).fill(password);
  await second.getByRole('button',{name:'Log in',exact:true}).click(); await second.locator('#notebook-picker').selectOption(a); await second.locator('[data-note]').click();
  assert.equal(await second.locator('#note-body').inputValue(), recovered); pass('A separate device reads the recovered content from the server'); await other.close();
  for (const [width,height] of [[768,1024],[390,844]]) {
    await page.setViewportSize({width,height});
    assert(await page.locator('#note-body').isVisible());
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.locator('#back-to-list').click(); assert(await page.locator('[data-note]').isVisible()); await page.locator('[data-note]').click();
    pass(`Editor and note navigation fit ${width}x${height}`);
    await page.screenshot({path:join(out,`notebook-${width}.png`)});
  }
  assert.deepEqual(errors,[]); pass('No browser runtime errors');
  writeFileSync(join(out,'checks.json'),JSON.stringify({at:new Date().toISOString(),checks},null,2)+'\n');
} finally { await browser.close(); }
