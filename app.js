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
    el('div', { class: 'day' }, s.day_label),
    el('div', { class: 'meta' },
      fmtDate(s.date) + (r.last_session_date ? ' · last session ' + daysAgoText(r.last_session_date) : '')),
    el('div', { class: 'rot' }, dots,
      el('em', {}, (r.position || '?') + ' of ' + (r.order || []).length + ' · next: ' + (r.next || '—'))),
  );
}

/** One tap on an empty chip logs the set: reps default to that set's last-time
 *  reps (fallback rx_reps_high); load is already prefilled server-side. */
async function tapChip(set, chipBtn, exName) {
  if (chipBtn.dataset.busy) return;
  const ghost = state.open.ghosts[exName];
  const gReps = ghost && ghost.reps ? ghost.reps[Number(set.set_no) - 1] : null;
  const reps = Number(set.actual_reps) || gReps || Number(set.rx_reps_high) || Number(set.rx_reps_low);
  if (set.actual_reps !== '') { toast('Set editor lands in the next build stage.'); return; }
  if (!reps) { toast('No default reps for this set — editor lands next stage.'); return; }
  chipBtn.dataset.busy = '1';
  chipBtn.firstChild.textContent = '…';
  try {
    const r = await api.post({ action: 'log_set', set_id: set.set_id, actual_reps: reps });
    if (!r.ok) throw new Error(r.error);
    Object.assign(set, r.row);
    renderToday();
  } catch (e) {
    if (e.nonJson) { await refresh(); return; } // write may have landed — verify by GET
    toast('Log failed: ' + e.message);
    renderToday();
  }
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
      el('button', { class: 'linkbtn', onclick: () => toast('Skip / comments land in the next build stage.') },
        done ? 'Add comment' : 'Skip today')),
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
        onchange: () => toast('Notes save lands in the next build stage.') },
        s.session_notes || '')),
    el('button', { class: 'fabbtn', onclick: () => toast('Complete flow lands in the next build stage.') },
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
  renderToday();
}

// ---- start ----------------------------------------------------------------------

async function boot() {
  if (!cfg.ready) { renderSetup(); return; }
  setSub('Syncing…');
  show(el('div', { class: 'center' }, 'Loading session…'));
  try {
    await refresh();
  } catch (e) {
    if (/bad token/.test(e.message)) { renderSetup('The API said: bad token.'); return; }
    setSub('Offline');
    show(el('div', { class: 'err' }, 'Could not reach the API: ' + e.message));
  }
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
boot();
