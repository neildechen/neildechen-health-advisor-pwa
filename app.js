/* Health Advisor logging PWA — app shell (P2).
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
    else n.setAttribute(k, v);
  });
  children.flat().forEach((c) => n.append(c));
  return n;
}
function setSub(text) { $('#appbar-sub').textContent = text; }
function show(...nodes) { const s = $('#screen'); s.replaceChildren(...nodes); }

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

// ---- connected shell (P3 replaces this with the Today screen) -------------------

async function boot() {
  if (!cfg.ready) { renderSetup(); return; }
  setSub('Syncing…');
  show(el('div', { class: 'center' }, 'Loading session…'));
  let r;
  try {
    r = await api.get('open');
  } catch (e) {
    setSub('Offline');
    show(el('div', { class: 'err' }, 'Could not reach the API: ' + e.message));
    return;
  }
  if (!r.ok) { renderSetup(r.error === 'bad token' ? 'The API said: bad token.' : r.error); return; }
  const o = r.open || {};
  const s = o.session;
  setSub(s ? 'Active session' : 'No open session');
  show(
    el('div', { class: 'sessioncard' },
      el('div', { class: 'day' }, s ? s.day_label : 'No open session'),
      el('div', { class: 'meta' },
        s ? `${s.date} · ${o.sets.length} sets · status: ${s.status}` : 'Materialize from the sheet API, then reload.'),
    ),
    el('div', { class: 'center' }, 'Shell connected. Today screen lands in the next build stage.'),
  );
}

// ---- start ----------------------------------------------------------------------

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
boot();
