/**
 * Mocked-backend Chromium run for the logging PWA. No Google, no token, no sheet:
 * the app is served from this repo over a local http server and every call to the
 * (fake) Apps Script URL is answered by tests/mock-backend.mjs via request routing.
 *
 *   node tests/run.mjs            (uses the globally installed playwright + bundled Chromium)
 *
 * Gates for the single-plan tracker (2026-09-02) plus the four-day regression: a
 * one-day sheet gets the simplified copy, a four-day sheet renders exactly as before,
 * and the client only ever talks to the endpoint it was configured with.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { makeBackend } from './mock-backend.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); }
catch (_) { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXEC_A = 'https://script.google.com/macros/s/MOCK-TRACKER-A/exec';
const EXEC_B = 'https://script.google.com/macros/s/MOCK-NEIL-B/exec';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = 'http://127.0.0.1:' + server.address().port + '/';

let passed = 0, failed = 0;
const results = [];
function check(name, cond, detail) {
  if (cond) { passed++; results.push('  ok   ' + name); }
  else { failed++; results.push('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
async function session(backends) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const foreign = [];
  await ctx.route(/script\.google\.com/, async (route) => {
    const req = route.request();
    const be = backends[req.url().split('?')[0]];
    if (!be) { foreign.push(req.url()); return route.fulfill({ status: 404, body: 'no such deployment' }); }
    const body = be.handle(req.url(), req.method(), req.postData());
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { failed++; results.push('  FAIL page error: ' + e.message); });
  return { ctx, page, foreign };
}
async function connect(page, execUrl, token) {
  await page.goto(BASE);
  await page.waitForSelector('input[type=url]');
  await page.fill('input[type=url]', execUrl);
  await page.fill('input[type=password]', token);
  await page.click('button.fabbtn');
}
const text = (page, sel) => page.locator(sel).first().textContent();
const chipsOf = (page, exName) => page.locator('article.ex', { has: page.locator('.name', { hasText: exName }) }).first().locator('button.setchip');

// ---------------------------------------------------------------- tracker (single plan)
{
  const A = makeBackend('tracker', { token: 'tok-A' });
  const { ctx, page, foreign } = await session({ [EXEC_A]: A });

  // 1. fresh device -> setup; bad token surfaces the API error; good token connects
  await page.goto(BASE);
  check('fresh device shows the setup screen', await page.locator('input[type=url]').count() === 1);
  await connect(page, EXEC_A, 'wrong');
  await page.waitForSelector('.err:not([hidden])');
  check('bad token: the API refusal is shown', /bad token/.test(await text(page, '.err')));
  await page.fill('input[type=password]', 'tok-A');
  await page.click('button.fabbtn');
  await page.waitForSelector('article.ex');

  // 2. single-plan render
  const names = await page.locator('article.ex .name').allTextContents();
  check('five exercise cards in program order', JSON.stringify(names) === JSON.stringify(['Romanian Deadlift', 'Bulgarian Split Squat', 'Bench Press', 'Assisted Pull-up', 'Hanging Leg Raise']), JSON.stringify(names));
  const rx = await page.locator('article.ex .rx').allTextContents();
  check('rx lines: 4 sets, 8–10 / 8–10 / 4–6 / 4–6 / 10–15 BW', JSON.stringify(rx) === JSON.stringify(['4×8–10', '4×8–10', '4×4–6', '4×4–6', '4×10–15 · BW']), JSON.stringify(rx));
  check('four chips per exercise', await page.locator('button.setchip').count() === 20);
  check('no rotation dots / next-day line in single-plan mode', await page.locator('.rot').count() === 0);
  check('header shows the day without an emphasis suffix', (await text(page, '.sessioncard .day')).trim() === 'Full Body');
  check('no Core badges (tracker notes carry no CORE prefix)', await page.locator('.badge').count() === 0);
  const btn = page.locator('main > button.fabbtn');
  check('primary button reads "Finish workout ✓"', (await btn.textContent()) === 'Finish workout ✓');
  check('finish is inert until something is logged', await btn.isDisabled());
  check('single-plan hint copy', /Log at least one set to finish/.test(await text(page, 'main .hint')));

  // 3. one-tap chip logs rx_reps_high
  await chipsOf(page, 'Romanian Deadlift').nth(0).click();
  await sleep(150);
  let ls = A.calls.filter((c) => c.body && c.body.action === 'log_set');
  check('one tap on RDL logs 10 reps (top of 8–10)', ls.length === 1 && ls[0].body.actual_reps === 10 && ls[0].body.set_id.endsWith('#1#1'), JSON.stringify(ls.map((c) => c.body)));
  await chipsOf(page, 'Bench Press').nth(0).click();
  await chipsOf(page, 'Hanging Leg Raise').nth(0).click();
  await sleep(150);
  ls = A.calls.filter((c) => c.body && c.body.action === 'log_set');
  check('bench tap logs 6, hanging leg raise tap logs 15', ls.length === 3 && ls[1].body.actual_reps === 6 && ls[2].body.actual_reps === 15);
  check('tapped chips render filled', await page.locator('button.setchip.filled').count() === 3);
  check('finish enabled after one logged set', !(await btn.isDisabled()));

  // 4. editor: blank load gets a stepper; typed load round-trips; assisted "-" notation
  await chipsOf(page, 'Bench Press').nth(1).click(); // empty chip -> logs 6 optimistically (top of range)
  await sleep(100);
  await chipsOf(page, 'Bench Press').nth(1).click(); // filled chip -> editor
  await page.waitForSelector('.sheet');
  check('editor titles the exercise and set', /Bench Press/.test(await text(page, '.sheet .t')) && /set 2 of 4/.test(await text(page, '.sheet .sub')));
  check('blank load still gets the numeric stepper in single-plan mode', await page.locator('.sheet .stepper input.stepval').count() === 2);
  const loadIn = page.locator('.sheet .stepper input.stepval').nth(1);
  await loadIn.fill('95');
  await page.click('.sheet .formbtns .primary');
  await sleep(150);
  ls = A.calls.filter((c) => c.body && c.body.action === 'log_set');
  const last = ls[ls.length - 1].body;
  check('typed load "95" reaches log_set verbatim with the reps', last.actual_load === '95' && last.actual_reps === 6, JSON.stringify(last));
  check('save auto-advances to the next unlogged bench set', /set 3 of 4/.test(await text(page, '.sheet .sub')));
  await page.click('.sheet .formbtns .ghostbtn'); // Skip set 3 (closes; auto-advance only on reps)
  await sleep(100);
  await page.locator('.sheetwrap').count() && await page.mouse.click(10, 10);
  await sleep(100);

  await chipsOf(page, 'Assisted Pull-up').nth(0).click(); // logs 6
  await sleep(100);
  await chipsOf(page, 'Assisted Pull-up').nth(0).click(); // editor
  await page.waitForSelector('.sheet');
  const apLoad = page.locator('.sheet .stepper input.stepval').nth(1);
  await apLoad.fill('-60');
  await sleep(50);
  check('typing "-60" flips the unit to "lb assist"', (await page.locator('.sheet .setrow .u').nth(1).textContent()) === 'lb assist');
  await page.locator('.sheet .stepper').nth(1).locator('button').nth(1).click(); // "+" steps the magnitude
  check('stepper on an assisted load moves the magnitude: -60 -> -65', (await apLoad.inputValue()) === '-65', await apLoad.inputValue());
  await page.click('.sheet .formbtns .primary');
  await sleep(150);
  ls = A.calls.filter((c) => c.body && c.body.action === 'log_set');
  check('assisted load "-65" reaches log_set verbatim', ls[ls.length - 1].body.actual_load === '-65', JSON.stringify(ls[ls.length - 1].body));
  await page.locator('.sheetwrap').count() && await page.mouse.click(10, 10);
  await sleep(100);
  const apGhostLoad = A.sessions[0].sets.find((s) => s.exercise === 'Assisted Pull-up' && s.set_no === '1').actual_load;
  check('mock sheet holds "-65" for the assisted set', apGhostLoad === '-65');

  // 5. finish flow: soft copy, quiet blanks, same day again, ghosts carried
  const firstId = A.sessions[0].session_id;
  await btn.click();
  await page.waitForSelector('.sheet');
  check('confirm sheet says "Finish this workout?"', (await text(page, '.sheet .t')) === 'Finish this workout?');
  check('blank sets are described quietly, not as a red warning', await page.locator('.sheet .err').count() === 0 && /left blank — that’s fine/.test(await page.locator('.sheet').textContent()));
  check('no rotation wording in the confirm sheet', !/advances the rotation|loads/.test(await page.locator('.sheet .hint').last().textContent()));
  await page.click('.sheet .formbtns .primary');
  await page.waitForFunction((id) => !document.body.textContent.includes('Loading') && document.querySelectorAll('button.setchip.filled').length === 0, firstId, { timeout: 10000 });
  check('complete_v2 was posted exactly once', A.calls.filter((c) => c.body && c.body.action === 'complete_v2').length === 1);
  check('the mock rolled to a NEW session on the same day', A.sessions.length === 2 && A.sessions[1].day_label === 'Full Body' && A.sessions[1].session_id !== firstId);
  check('all twenty chips are empty again', await page.locator('button.setchip').count() === 20 && await page.locator('button.setchip.filled').count() === 0);
  const toastText = await text(page, '#toast');
  check('toast says the workout was saved (no "next up")', /Workout saved/.test(toastText) && !/next up/.test(toastText), toastText);
  const ghostRdl = await page.locator('article.ex', { has: page.locator('.name', { hasText: 'Romanian Deadlift' }) }).locator('.ghost').textContent();
  check('last-time ghost shows after the first workout', /Last \(Full Body\)/.test(ghostRdl) && /10/.test(ghostRdl), ghostRdl);
  check('blank bench sets were closed as "(skipped for time)" server-side', A.sessions[0].sets.filter((s) => s.exercise === 'Bench Press' && s.comment === '(skipped for time)').length === 1);

  // 6. isolation: every request went to endpoint A with token A, nothing elsewhere
  check('every request targeted the configured endpoint only', A.calls.every((c) => c.url.startsWith(EXEC_A)) && foreign.length === 0, JSON.stringify(foreign));
  check('the token never rode on a request to another origin', foreign.length === 0);
  const afterConnect = A.calls.slice(A.calls.findIndex((c) => c.token === 'tok-A'));
  check('GET reads carry the token as a query param; POSTs carry it in the body only', afterConnect.length > 3
    && afterConnect.every((c) => c.method === 'GET' ? c.url.includes('token=tok-A') : (!c.url.includes('token=') && c.body.token === 'tok-A')));
  const swCaches = await page.evaluate(async () => { const keys = await caches.keys(); const out = []; for (const k of keys) { const c = await caches.open(k); (await c.keys()).forEach((r) => out.push(r.url)); } return out; });
  check('service worker cached the shell only, never the API', swCaches.length > 0 && swCaches.every((u) => u.startsWith(BASE)), JSON.stringify(swCaches));
  const stored = await page.evaluate(() => Object.keys(localStorage));
  check('secrets live only in localStorage keys ha.execUrl / ha.token', stored.includes('ha.execUrl') && stored.includes('ha.token'));

  await ctx.close();
}

// ---------------------------------------------------------------- four-day regression (Neil's shape)
{
  const B = makeBackend('four', { token: 'tok-B' });
  const { ctx, page, foreign } = await session({ [EXEC_B]: B });
  await connect(page, EXEC_B, 'tok-B');
  await page.waitForSelector('article.ex');
  check('[4-day] rotation dots and next-day line render', await page.locator('.rot').count() === 1 && /1 of 4 · next: Lower - Squat/.test(await text(page, '.rot em')));
  check('[4-day] emphasis suffix still renders', (await text(page, '.sessioncard .day')).trim() === 'Upper A — heavy');
  check('[4-day] rx line keeps the lb unit and "+35"', JSON.stringify(await page.locator('article.ex .rx').allTextContents()) === JSON.stringify(['4×4–6 · 180 lb', '4×4–6 · +35 lb', '2×15–20 · 10 lb']));
  const btn = page.locator('main > button.fabbtn');
  check('[4-day] button still reads "Complete Session ✓"', (await btn.textContent()) === 'Complete Session ✓');
  check('[4-day] original submit hint', /Log or skip at least one set to enable submitting/.test(await text(page, 'main .hint')));
  await chipsOf(page, 'Weighted Pull-up').nth(0).click();
  await sleep(100);
  await chipsOf(page, 'Weighted Pull-up').nth(0).click();
  await page.waitForSelector('.sheet');
  check('[4-day] "+35" shows "lb added" and the stepper keeps the plus', (await page.locator('.sheet .setrow .u').nth(1).textContent()) === 'lb added');
  await page.locator('.sheet .stepper').nth(1).locator('button').nth(1).click();
  check('[4-day] added-load stepper: +35 -> +37.5 (increment 2.5)', (await page.locator('.sheet .stepper input.stepval').nth(1).inputValue()) === '+37.5');
  await page.click('.sheet .formbtns .primary');
  await sleep(150);
  await page.locator('.sheetwrap').count() && await page.mouse.click(10, 10);
  await sleep(100);
  const ls = B.calls.filter((c) => c.body && c.body.action === 'log_set');
  check('[4-day] "+37.5" reaches log_set verbatim', ls[ls.length - 1].body.actual_load === '+37.5');
  await btn.click();
  await page.waitForSelector('.sheet');
  check('[4-day] confirm sheet is the original: "Complete this session?" + loud blank warning + rotation hint',
    (await text(page, '.sheet .t')) === 'Complete this session?' && /Heads up/.test(await page.locator('.sheet .err').textContent()) && /advances the rotation, and loads Lower - Squat/.test(await page.locator('.sheet .hint').last().textContent()));
  await page.click('.sheet .formbtns .primary');
  await page.waitForFunction(() => /Lower - Squat/.test(document.querySelector('.sessioncard .day')?.textContent || ''), null, { timeout: 10000 });
  check('[4-day] completion advances to Lower - Squat with the original toast', /Session complete — next up: Lower - Squat/.test(await text(page, '#toast')));
  check('[4-day] every request targeted endpoint B only', B.calls.every((c) => c.url.startsWith(EXEC_B)) && foreign.length === 0);
  await ctx.close();
}

// ---------------------------------------------------------------- two devices, two sheets: no bleed
{
  const A = makeBackend('tracker', { token: 'tok-A' });
  const B = makeBackend('four', { token: 'tok-B' });
  const dev1 = await session({ [EXEC_A]: A, [EXEC_B]: B });
  const dev2 = await session({ [EXEC_A]: A, [EXEC_B]: B });
  await connect(dev1.page, EXEC_A, 'tok-A');
  await connect(dev2.page, EXEC_B, 'tok-B');
  await dev1.page.waitForSelector('article.ex');
  await dev2.page.waitForSelector('article.ex');
  await chipsOf(dev1.page, 'Romanian Deadlift').nth(0).click();
  await chipsOf(dev2.page, 'Bench Press').nth(0).click();
  await sleep(200);
  check('[2 devices] the tracker device only ever called endpoint A with token A', A.calls.every((c) => c.token === 'tok-A' && c.url.startsWith(EXEC_A)) && !A.calls.some((c) => c.token === 'tok-B'));
  check('[2 devices] the four-day device only ever called endpoint B with token B', B.calls.every((c) => c.token === 'tok-B' && c.url.startsWith(EXEC_B)) && !B.calls.some((c) => c.token === 'tok-A'));
  check('[2 devices] a tap on one device never lands in the other sheet', A.sessions[0].sets.filter((s) => s.actual_reps !== '').length === 1 && A.sessions[0].sets[0].exercise === 'Romanian Deadlift'
    && B.sessions[0].sets.filter((s) => s.actual_reps !== '').length === 1 && B.sessions[0].sets[0].exercise === 'Bench Press');
  check('[2 devices] each device sees its own plan', await dev1.page.locator('.rot').count() === 0 && await dev2.page.locator('.rot').count() === 1);
  await dev1.ctx.close(); await dev2.ctx.close();
}

// ---------------------------------------------------------------- repo hygiene (public repo)
{
  const files = [];
  (function walk(d) { fs.readdirSync(d).forEach((n) => { if (n === '.git' || n === 'node_modules') return; const f = path.join(d, n); fs.statSync(f).isDirectory() ? walk(f) : files.push(f); }); })(ROOT);
  const offenders = files.filter((f) => /\.(js|mjs|html|css|md|json|webmanifest)$/.test(f))
    .filter((f) => /script\.google\.com\/macros\/s\/(?!MOCK-)[A-Za-z0-9_-]{20,}/.test(fs.readFileSync(f, 'utf8')));
  check('no real Apps Script deployment path anywhere in the tree', offenders.length === 0, offenders.join(', '));
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const v = (html.match(/app\.js\?v=(\d+)/) || [])[1];
  check('shell version is consistent across index.html and sw.js (v' + v + ')', v && html.includes('app.css?v=' + v) && sw.includes("'ha-shell-v" + v + "'") && sw.includes("'app.js?v=" + v + "'") && sw.includes("'app.css?v=" + v + "'"));
}

await browser.close();
server.close();
console.log(results.join('\n'));
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
