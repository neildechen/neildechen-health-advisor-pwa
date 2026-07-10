/* Health Advisor logging PWA — P3: Today screen + 1-tap chips.
 * Spec: gym-programmer docs/pwa-build-spec.md. Design truth: designs/ cards.
 *
 * Security model: EXEC_URL and TOKEN live in localStorage ONLY — entered on the
 * first-run setup screen, never present in this repo, never cached by the
 * service worker, never placed in a URL for POSTs. GET reads carry the token as
 * a query param (Apps-Script-imposed; HTTPS). Rotating the sheet-side token
 * invalidates every device.
 */
'use strict';

const LS = { execUrl: 'ha.execUrl', token: 'ha.token', lastGood: 'ha.lastGood', queue: 'ha.queue' };

const cfg = {
  get execUrl() { return localStorage.getItem(LS.execUrl) || ''; },
  get token() { return localStorage.getItem(LS.token) || ''; },
  save(execUrl, token) {
    localStorage.setItem(LS.execUrl, execUrl);
    localStorage.setItem(LS.token, token);
  },
  get ready() { return !!(this.execUrl && this.token); },
};

// ---- API ---------------------------------------------------------------------

const api = {
  async get(view, extra) {
    const u = new URL(cfg.execUrl);
    u.searchParams.set('token', cfg.token);
    u.searchParams.set('view', view);
    if (extra) Object.entries(extra).forEach(([k, v]) => u.searchParams.set(k, String(v)));
    const res = await fetch(u.toString(), { redirect: 'follow' });
    return res.json(); // reads always come back JSON; a throw here is a network problem
  },
  /** POST with text/plain (application/json would trigger a preflight Apps Script
   *  cannot answer). Any non-JSON response (large-POST HTML quirk) throws
   *  {nonJson:true}: the write may have landed — verify by GET, never retry blind. */
  async post(body) {
    const res = await fetch(cfg.execUrl, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ token: cfg.token }, body)),
    });
    const text = await res.text();
    try { return JSON.parse(text); }
    catch (_) { const e = new Error('non-JSON response'); e.nonJson = true; throw e; }
  },
};

// ---- offline queue ---------------------------------------------------------------
// Failed WRITES (network-level, not API rejections) append here and flush FIFO on
// connectivity/visibility events. Reads render last-known-good with a stale marker.

const queue = {
  read() { try { return JSON.parse(localStorage.getItem(LS.queue)) || []; } catch (_) { return []; } },
  write(q) { localStorage.setItem(LS.queue, JSON.stringify(q)); updateBadge(); },
  push(body) { const q = this.read(); q.push({ body, ts: Date.now() }); this.write(q); },
  get length() { return this.read().length; },
};

function updateBadge() {
  const b = document.getElementById('queue-badge');
  const n = queue.length;
  b.hidden = n === 0;
  b.textContent = n + ' queued';
}

function isNetworkError(e) { return e instanceof TypeError || /fetch|network/i.test(e.message || ''); }

/** Write with offline fallback. Returns {queued:true} when the write was stored
 *  for later flush — callers apply the change optimistically. API rejections
 *  (ok:false) are real errors and are NOT queued. */
async function write(body) {
  try {
    return await api.post(body);
  } catch (e) {
    if (e.nonJson) throw e;           // landed-but-HTML: caller verifies by GET
    if (!isNetworkError(e)) throw e;
    queue.push(body);
    toast('Saved offline — will sync (' + queue.length + ' queued).');
    return { ok: true, queued: true };
  }
}

let flushing = false;
async function flushQueue() {
  if (flushing) return;
  const q = queue.read();
  if (!q.length) return;
  flushing = true;
  let landed = 0;
  try {
    while (q.length) {
      try {
        await api.post(q[0].body);      // nonJson counts as landed (verify by GET after)
        q.shift(); landed++;
        queue.write(q);
      } catch (e) {
        if (e.nonJson) { q.shift(); landed++; queue.write(q); continue; }
        break;                          // still offline — keep FIFO order, retry later
      }
    }
  } finally {
    flushing = false;
  }
  if (landed) {
    toast('Synced ' + landed + ' queued write' + (landed > 1 ? 's' : '') + '.');
    try { await refresh(); } catch (_) { /* offline again */ }
  }
}
window.addEventListener('online', flushQueue);
document.addEventListener('visibilitychange', () => { if (!document.hidden) flushQueue(); });

// ---- tiny DOM helpers ----------------------------------------------------------

const $ = (sel) => document.querySelector(sel);
function el(tag, attrs, ...children) {
  const n = document.createElement(tag);
  Object.entries(attrs || {}).forEach(([k, v]) => {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
  });
  children.flat().forEach((c) => { if (c != null) n.append(c); });
  return n;
}
function setSub(text) { $('#appbar-sub').textContent = text; }
function show(...nodes) { const s = $('#screen'); s.replaceChildren(...nodes.flat().filter(Boolean)); }

// ---- setup screen (first run / bad token) --------------------------------------

function renderSetup(prefillError) {
  setSub('Setup');
  const err = el('div', { class: 'err', hidden: !prefillError }, prefillError || '');
  const url = el('input', { type: 'url', placeholder: 'https://script.google.com/macros/s/…/exec',
    autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', value: cfg.execUrl });
  const tok = el('input', { type: 'password', placeholder: 'API token',
    autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', value: cfg.token });
  const btn = el('button', { class: 'fabbtn', onclick: connect }, 'Connect');

  async function connect() {
    const execUrl = url.value.trim().replace(/\?.*$/, '');
    const token = tok.value.trim();
    err.hidden = true;
    if (!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(execUrl)) {
      err.textContent = 'That does not look like an Apps Script /exec URL.';
      err.hidden = false; return;
    }
    if (!token) { err.textContent = 'Token is required.'; err.hidden = false; return; }
    btn.disabled = true; btn.textContent = 'Checking…';
    try {
      const u = new URL(execUrl);
      u.searchParams.set('token', token);
      u.searchParams.set('view', 'ping');
      const r = await (await fetch(u.toString(), { redirect: 'follow' })).json();
      if (!r.ok) throw new Error(r.error || 'API refused the request'); // e.g. "bad token"
      cfg.save(execUrl, token);
      boot();
    } catch (e) {
      err.textContent = e.message === 'bad token'
        ? 'The API said: bad token. Check the token (Sheet ▸ Setup ▸ Set API token…).'
        : 'Could not connect: ' + e.message;
      err.hidden = false;
      btn.disabled = false; btn.textContent = 'Connect';
    }
  }

  show(
    el('div', { class: 'formcard' },
      el('div', { class: 'label' }, 'Connect to your sheet'),
      el('div', { class: 'hint' },
        'Both values stay on this device (localStorage). Nothing is ever sent anywhere except your own Apps Script endpoint.'),
      err,
      el('div', { class: 'field' }, el('span', { class: 'label' }, 'Apps Script exec URL'), url),
      el('div', { class: 'field' }, el('span', { class: 'label' }, 'API token'), tok),
    ),
    btn,
  );
}

// ---- Today screen ---------------------------------------------------------------

const state = { open: null };

function fmtDate(iso) {
  const d = new Date(iso + 'T12:00:00');
  return isNaN(d) ? iso : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}
function daysAgoText(iso) {
  if (!iso) return '';
  const one = 24 * 3600 * 1000;
  const n = Math.round((new Date().setHours(12, 0, 0, 0) - new Date(iso + 'T12:00:00')) / one);
  if (n <= 0) return 'today';
  if (n === 1) return 'yesterday';
  return n + ' days ago';
}
/** "3×6–8 · 165 lb" (parts drop out when the program leaves them blank). */
function rxText(sets) {
  const s0 = sets[0];
  const n = sets.length;
  let reps = '';
  if (s0.rx_reps_low !== '' && s0.rx_reps_high !== '') {
    reps = s0.rx_reps_low === s0.rx_reps_high ? String(s0.rx_reps_low) : s0.rx_reps_low + '–' + s0.rx_reps_high;
  }
  const bits = [n + (reps ? '×' + reps : ' sets')];
  if (s0.rx_load) bits.push(s0.rx_load + (/^\d/.test(s0.rx_load) || s0.rx_load.startsWith('+') ? ' lb' : ''));
  return bits.join(' · ');
}

function sessionHeader(o) {
  const s = o.session, r = o.rotation;
  const dots = (r.order || []).map((_, i) =>
    el('span', { class: i < (r.position || 0) ? 'on' : '' }));
  return el('div', { class: 'sessioncard' },
    el('div', { class: 'day' }, s.day_label,
      state.stale ? el('span', { class: 'stale', style: 'margin-left:.5rem;vertical-align:middle' }, 'offline · stale') : null),
    el('div', { class: 'meta' },
      fmtDate(s.date) + (r.last_session_date ? ' · last session ' + daysAgoText(r.last_session_date) : '')),
    el('div', { class: 'rot' }, dots,
      el('em', {}, (r.position || '?') + ' of ' + (r.order || []).length + ' · next: ' + (r.next || '—'))),
  );
}

/** One tap on an empty chip logs the set: reps default to that set's last-time
 *  reps (fallback rx_reps_high); load is already prefilled server-side.
 *  A filled chip opens the set editor instead (tap-again-adjusts). */
async function tapChip(set, chipBtn, exName) {
  if (chipBtn.dataset.busy) return;
  if (set.actual_reps !== '' || String(set.skipped).toUpperCase() === 'TRUE') { openEditor(set, exName); return; }
  const ghost = state.open.ghosts[exName];
  const gReps = ghost && ghost.reps ? ghost.reps[Number(set.set_no) - 1] : null;
  const reps = gReps || Number(set.rx_reps_high) || Number(set.rx_reps_low);
  if (!reps) { openEditor(set, exName); return; } // AMRAP-style set: no sane default
  chipBtn.dataset.busy = '1';
  chipBtn.firstChild.textContent = '…';
  try {
    const r = await write({ action: 'log_set', set_id: set.set_id, actual_reps: reps });
    if (!r.ok) throw new Error(r.error);
    if (r.queued) set.actual_reps = String(reps);
    else Object.assign(set, r.row);
    renderToday();
  } catch (e) {
    if (e.nonJson) { await refresh(); return; } // write may have landed — verify by GET
    toast('Log failed: ' + e.message);
    renderToday();
  }
}

// ---- set editor (bottom sheet, screens/exercise-form card) ----------------------

const LOAD_SHAPE = /^\+?\d+(\.\d+)?$/;

function openEditor(set, exName) {
  const o = state.open;
  const meta = o.exercises[exName] || {};
  const ghost = o.ghosts[exName];
  const exSets = o.sets.filter((r) => r.exercise === exName);
  const inc = Number(meta.increment) || 5;

  // reps state
  let reps = Number(set.actual_reps) ||
    (ghost && ghost.reps && ghost.reps[Number(set.set_no) - 1]) ||
    Number(set.rx_reps_high) || Number(set.rx_reps_low) || 0;
  // load state — text end-to-end; "+" preserved
  let load = set.actual_load || set.rx_load || '';
  const plus = load.startsWith('+');
  const numericLoad = LOAD_SHAPE.test(load);

  const repsOut = el('output', {}, String(reps));
  const loadOut = el('output', {}, load || '—');
  const bump = (d) => { reps = Math.max(0, reps + d); repsOut.textContent = String(reps); };
  const bumpLoad = (d) => {
    const n = Math.max(0, (parseFloat(load.replace('+', '')) || 0) + d);
    load = (plus ? '+' : '') + (Number.isInteger(n) ? n : n.toFixed(1));
    loadOut.textContent = load;
  };
  const cmt = el('textarea', { class: 'cmt', rows: '2', placeholder: 'grip, pain, tempo… free text' }, set.comment || '');
  const loadFree = el('input', { type: 'text', value: load, autocapitalize: 'none',
    oninput: (e) => { load = e.target.value.trim(); } });

  const rxRange = set.rx_reps_low !== ''
    ? (set.rx_reps_low === set.rx_reps_high ? set.rx_reps_low : set.rx_reps_low + '–' + set.rx_reps_high)
    : '';
  const hint = meta.progression ? ' · progression: ' + meta.progression : '';

  async function save(fields) {
    sheetBusy(true);
    try {
      const body = Object.assign({ action: 'log_set', set_id: set.set_id }, fields);
      const r = await write(body);
      if (!r.ok) throw new Error(r.error);
      if (r.queued) {
        if (fields.actual_reps != null) set.actual_reps = String(fields.actual_reps);
        if (fields.actual_load != null) set.actual_load = fields.actual_load;
        if (fields.comment != null) set.comment = fields.comment;
        if (fields.skipped != null) set.skipped = fields.skipped ? 'TRUE' : 'FALSE';
      } else Object.assign(set, r.row);
      closeSheet();
      renderToday();
      // auto-advance: next unlogged, unskipped set of this exercise
      const next = exSets.find((s) => s.actual_reps === '' && String(s.skipped).toUpperCase() !== 'TRUE');
      if (fields.actual_reps != null && next) openEditor(next, exName);
    } catch (e) {
      sheetBusy(false);
      if (e.nonJson) { closeSheet(); await refresh(); return; }
      toast('Save failed: ' + e.message);
    }
  }

  openSheet(
    el('div', { class: 'appbar', style: 'border-radius:10px' },
      el('div', {},
        el('div', { class: 't' }, exName),
        el('div', { class: 'sub' }, o.session.day_label + ' · set ' + set.set_no + ' of ' + exSets.length))),
    el('div', { class: 'formcard' },
      el('div', { class: 'label' }, 'Prescribed'),
      el('div', { class: 'rxline' },
        el('span', {}, exSets.length + ' sets' + (rxRange ? ' × ' + rxRange + ' reps' : '')),
        el('b', {}, set.rx_load || '—')),
      ghost ? el('div', { class: 'lastline' }, 'Last session: ',
        el('b', {}, (ghost.load ? ghost.load + ' × ' : '') + ghost.reps.join(',')), hint) : (hint ? el('div', { class: 'lastline' }, hint.slice(3)) : null)),
    el('div', { class: 'formcard' },
      el('div', { class: 'label' }, 'This set'),
      el('div', { class: 'setrow' },
        el('span', { class: 'sn' }, 'Reps'),
        el('div', { class: 'stepper' },
          el('button', { type: 'button', onclick: () => bump(-1) }, '−'), repsOut,
          el('button', { type: 'button', onclick: () => bump(1) }, '+')),
        el('span', { class: 'u' }, rxRange ? 'target ' + rxRange : '')),
      numericLoad
        ? el('div', { class: 'setrow' },
            el('span', { class: 'sn' }, 'Load'),
            el('div', { class: 'stepper' },
              el('button', { type: 'button', onclick: () => bumpLoad(-inc) }, '−'), loadOut,
              el('button', { type: 'button', onclick: () => bumpLoad(inc) }, '+')),
            el('span', { class: 'u' }, plus ? 'lb added · stored as "' + load + '"' : 'lb'))
        : el('div', { class: 'setrow' },
            el('span', { class: 'sn' }, 'Load'),
            loadFree,
            el('span', { class: 'u' }, 'free text'))),
    el('div', { class: 'formcard' },
      el('div', { class: 'label' }, 'Comments'), cmt),
    el('div', { class: 'formbtns' },
      el('button', { class: 'primary', onclick: () =>
        save({ actual_reps: reps || null, actual_load: load, comment: cmt.value, skipped: false }) }, 'Save'),
      el('button', { class: 'ghostbtn', onclick: () =>
        save({ skipped: true, comment: cmt.value || 'skipped' }) }, 'Skip')),
  );
}

function openSheet(...children) {
  closeSheet();
  const sheet = el('div', { class: 'sheet' }, children);
  const wrap = el('div', { class: 'sheetwrap', onclick: (e) => { if (e.target === wrap) closeSheet(); } }, sheet);
  document.body.append(wrap);
}
function closeSheet() { const w = document.querySelector('.sheetwrap'); if (w) w.remove(); }
function sheetBusy(b) {
  document.querySelectorAll('.sheet .formbtns button').forEach((x) => { x.disabled = b; });
}

// ---- skip exercise / session notes / complete ------------------------------------

async function skipExercise(exName) {
  try {
    const r = await write({ action: 'skip_exercise', session_id: state.open.session.session_id, exercise: exName });
    if (!r.ok) throw new Error(r.error);
    if (r.queued) {
      state.open.sets.forEach((s) => {
        if (s.exercise === exName && s.actual_reps === '') { s.skipped = 'TRUE'; if (!s.comment) s.comment = 'skipped for time'; }
      });
      renderToday();
    } else await refresh();
  } catch (e) {
    if (e.nonJson) { await refresh(); return; }
    toast('Skip failed: ' + e.message);
  }
}

let noteTimer;
function saveNotes(text) {
  clearTimeout(noteTimer);
  noteTimer = setTimeout(async () => {
    try {
      const r = await write({ action: 'session_note', session_id: state.open.session.session_id, text });
      if (!r.ok) throw new Error(r.error);
      state.open.session.session_notes = text;
      if (!r.queued) toast('Notes saved.');
    } catch (e) {
      if (e.nonJson) { await refresh(); return; }
      toast('Notes failed: ' + e.message);
    }
  }, 600);
}

/** Complete → complete-requested → "Finishing…" → poll view=open (2s, ≤90s)
 *  until a NEW session materializes. Double-taps are idempotent server-side. */
async function completeSession(btn) {
  const prevId = state.open.session.session_id;
  const logged = state.open.sets.some((s) => s.actual_reps !== '');
  if (!logged && !confirm('No sets logged — complete anyway?')) return;
  btn.disabled = true; btn.textContent = 'Finishing…';
  setSub('Finishing…');
  try {
    const r = await write(Object.assign({ action: 'complete_v2' }, logged ? {} : { allowEmpty: true }));
    if (!r.ok && r.reason === 'empty') { toast(r.message); btn.disabled = false; btn.textContent = 'Complete Session ✓'; return; }
    if (!r.ok) throw new Error(r.error || 'complete failed');
    if (r.queued) { toast('Completion queued — will finish when back online.'); setSub('Offline'); return; }
  } catch (e) {
    if (!e.nonJson) {
      toast('Complete failed: ' + e.message);
      btn.disabled = false; btn.textContent = 'Complete Session ✓';
      setSub('Active session');
      return;
    } // non-JSON: the request very likely landed — fall through to polling
  }
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 2000));
    try {
      const r = await api.get('open');
      if (r.ok && r.open && r.open.session && r.open.session.session_id !== prevId) {
        state.open = r.open;
        renderToday();
        toast('Session complete — next up: ' + r.open.session.day_label);
        return;
      }
    } catch (_) { /* transient; keep polling */ }
  }
  toast('Still finishing server-side — pull to refresh in a minute.');
  await refresh();
}

function chip(set, exName) {
  const logged = set.actual_reps !== '';
  const below = logged && set.rx_reps_low !== '' && Number(set.actual_reps) < Number(set.rx_reps_low);
  const cls = 'setchip' + (logged ? (below ? ' low' : ' filled') : '');
  const b = el('button', { class: cls },
    el('span', {}, logged ? set.actual_reps : '–'),
    el('small', {}, logged ? (below ? 'below rx' : 'reps') : 'tap'));
  b.addEventListener('click', () => tapChip(set, b, exName));
  return b;
}

function exerciseCard(exName, sets) {
  const meta = state.open.exercises[exName] || {};
  const ghost = state.open.ghosts[exName];
  const done = sets.filter((s) => s.actual_reps !== '').length;
  const allSkipped = sets.every((s) => String(s.skipped).toUpperCase() === 'TRUE');
  const badges = [];
  if (String(meta.core).toUpperCase() === 'Y') badges.push(el('span', { class: 'badge' }, 'Core'));
  if (/cuban|cuff/i.test(exName)) badges.push(el('span', { class: 'badge' }, 'Cuff'));

  return el('article', { class: 'ex' + (allSkipped ? ' skipped' : '') },
    el('div', { class: 'row1' },
      el('span', { class: 'name' }, exName), badges,
      el('span', { class: 'rx' }, rxText(sets))),
    ghost ? el('div', { class: 'ghost' }, 'Last (' + state.open.session.day_label + '): ',
      el('b', {}, (ghost.load ? ghost.load + ' × ' : '') + ghost.reps.join(','))) : null,
    el('div', { class: 'sets' }, sets.map((s) => chip(s, exName))),
    el('div', { class: 'exfoot' },
      el('span', {}, allSkipped ? 'Skipped' : done ? done + ' of ' + sets.length + ' sets' : 'Not started'),
      done
        ? el('button', { class: 'linkbtn', onclick: () => openEditor(sets.find((s) => s.actual_reps !== '') || sets[0], exName) }, 'Add comment')
        : el('button', { class: 'linkbtn', onclick: () => { if (confirm('Skip ' + exName + ' today?')) skipExercise(exName); } }, 'Skip today')),
  );
}

function renderToday() {
  const o = state.open;
  const s = o.session;
  if (!s) {
    setSub('No open session');
    show(el('div', { class: 'sessioncard' },
      el('div', { class: 'day' }, 'No open session'),
      el('div', { class: 'meta' }, 'Materialize via the sheet API, then pull to refresh.')));
    return;
  }
  setSub('Active session');
  // group sets by exercise, program order (sets arrive pre-sorted by order, set_no)
  const groups = [];
  const byEx = {};
  o.sets.forEach((r) => {
    if (!byEx[r.exercise]) { byEx[r.exercise] = []; groups.push(r.exercise); }
    byEx[r.exercise].push(r);
  });
  show(
    sessionHeader(o),
    groups.map((ex) => exerciseCard(ex, byEx[ex])),
    el('div', { class: 'formcard', style: 'border-style:dashed' },
      el('textarea', { class: 'cmt', rows: '2',
        placeholder: 'Session notes — sleep, energy, knee/shoulder, time available…',
        onchange: (e) => saveNotes(e.target.value) },
        s.session_notes || '')),
    el('button', { class: 'fabbtn', onclick: (e) => completeSession(e.target) },
      'Complete Session ✓'),
  );
}

let toastTimer;
function toast(msg) {
  let t = $('#toast');
  if (!t) { t = el('div', { id: 'toast', class: 'toastbar' }); document.body.append(t); }
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 2600);
}

async function refresh() {
  const r = await api.get('open');
  if (!r.ok) throw new Error(r.error || 'API error');
  state.open = r.open;
  state.stale = false;
  localStorage.setItem(LS.lastGood, JSON.stringify({ open: r.open, ts: Date.now() }));
  renderToday();
}

// ---- start ----------------------------------------------------------------------

async function boot() {
  if (!cfg.ready) { renderSetup(); return; }
  updateBadge();
  setSub('Syncing…');
  show(el('div', { class: 'center' }, 'Loading session…'));
  try {
    await refresh();
    flushQueue();
  } catch (e) {
    if (/bad token/.test(e.message)) { renderSetup('The API said: bad token.'); return; }
    // offline: render last-known-good with a stale marker
    let last = null;
    try { last = JSON.parse(localStorage.getItem(LS.lastGood)); } catch (_) { /* none */ }
    if (last && last.open) {
      state.open = last.open;
      state.stale = last.ts;
      setSub('Offline');
      renderToday();
      return;
    }
    setSub('Offline');
    show(el('div', { class: 'err' }, 'Could not reach the API: ' + e.message));
  }
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
boot();
