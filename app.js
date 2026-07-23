/* Health Advisor logging PWA — P5: optimistic writes (Instagram model).
 * Set-level writes render as committed the moment they're tapped; the POST
 * reconciles in the background. Transient failures keep the optimistic state
 * (offline queue, as before); hard API rejections revert exactly the touched
 * fields and say so. Complete/Undo stay deliberately pessimistic — they are
 * state-machine transitions, and Complete first settles every pending write
 * so the server never snapshots a half-landed session.
 * Spec: gym-programmer docs/pwa-build-spec.md. Design truth: designs/ cards.
 *
 * Security model: EXEC_URL and TOKEN live in localStorage ONLY — entered on the
 * first-run setup screen, never present in this repo, never cached by the
 * service worker, never placed in a URL for POSTs. GET reads carry the token as
 * a query param (Apps-Script-imposed; HTTPS). Rotating the sheet-side token
 * invalidates every device.
 */
'use strict';

const LS = { execUrl: 'ha.execUrl', token: 'ha.token', lastGood: 'ha.lastGood', queue: 'ha.queue',
  lastComplete: 'ha.lastComplete', undoCap: 'ha.undoCap' };

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

/** fetch with a hard timeout — a hung request must fail like a network error so
 *  writes fall into the offline queue instead of leaving the UI stuck. */
function timedFetch(url, opts, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  return fetch(url, Object.assign({}, opts, { signal: ctl.signal }))
    .then((res) => {
      if (!res.ok) throw new TypeError('HTTP ' + res.status); // 5xx et al. = transient
      return res;
    })
    .catch((e) => {
      if (e.name === 'AbortError') throw new TypeError('timeout');
      throw e;
    })
    .finally(() => clearTimeout(timer));
}

const api = {
  async get(view, extra) {
    const u = new URL(cfg.execUrl);
    u.searchParams.set('token', cfg.token);
    u.searchParams.set('view', view);
    if (extra) Object.entries(extra).forEach(([k, v]) => u.searchParams.set(k, String(v)));
    const res = await timedFetch(u.toString(), { redirect: 'follow' }, 15000);
    return res.json(); // reads always come back JSON; a throw here is a network problem
  },
  /** POST with text/plain (application/json would trigger a preflight Apps Script
   *  cannot answer). Any non-JSON response (large-POST HTML quirk) throws
   *  {nonJson:true}: the write may have landed — verify by GET, never retry blind. */
  async post(body) {
    const res = await timedFetch(cfg.execUrl, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ token: cfg.token }, body)),
    }, 25000);
    const text = await res.text();
    try { return JSON.parse(text); }
    catch (_) { const e = new Error('non-JSON response'); e.nonJson = true; throw e; }
  },
};

// ---- offline queue ---------------------------------------------------------------
// Failed WRITES (network-level, not API rejections) append here and flush FIFO on
// connectivity/visibility events. Reads render last-known-good with a stale marker.

// Per-page-load nonce: overlay versions only mean anything within one load
// (optimistic.mut is memory-only), so queued items are stamped with the load
// they came from — a flush landing an item from an OLDER load must never clear
// this load's overlay entries (they are newer by construction).
const LOAD_ID = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

const queue = {
  read() { try { return JSON.parse(localStorage.getItem(LS.queue)) || []; } catch (_) { return []; } },
  write(q) {
    try { localStorage.setItem(LS.queue, JSON.stringify(q)); }
    catch (_) { toast('Storage full — queued writes may not survive a reload.'); }
    updateBadge();
  },
  push(body, v) { const q = this.read(); q.push({ body, ts: Date.now(), lid: LOAD_ID, v: v || 0 }); this.write(q); },
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
 *  (ok:false) are real errors and are NOT queued.
 *  FIFO integrity: a new write never overtakes older queued writes — with
 *  anything still queued we first try to drain, and if the queue survives
 *  (offline/busy) the new write joins it in order instead of jumping ahead. */
async function write(body, v) {
  if (queue.length) {
    await flushQueue();
    if (queue.length) {
      queue.push(body, v);
      toast('Saved offline — will sync (' + queue.length + ' queued).');
      return { ok: true, queued: true };
    }
  }
  try {
    const r = await api.post(body);
    // The script lock rejects writes while a completion is running ("busy — another
    // write is running"). That's transient, not a user error: queue and move on.
    if (r && r.ok === false && /busy/i.test(r.error || '')) {
      queue.push(body, v);
      toast('Server busy — queued, will retry.');
      return { ok: true, queued: true };
    }
    return r;
  } catch (e) {
    if (e.nonJson) throw e;           // landed-but-HTML: caller verifies by GET
    if (!isNetworkError(e)) throw e;
    queue.push(body, v);
    toast('Saved offline — will sync (' + queue.length + ' queued).');
    return { ok: true, queued: true };
  }
}

/** Concurrent-safe: callers awaiting a flush that's already running get the REAL
 *  completion promise (Complete's settle-then-flush gate depends on this — an
 *  instant no-op return would let it submit over an undrained queue). */
let flushP = null;
function flushQueue() {
  if (flushP) return flushP;
  flushP = flushQueueRun().finally(() => { flushP = null; });
  return flushP;
}
async function flushQueueRun() {
  const q = queue.read();
  if (!q.length) return;
  let landed = 0, dropped = 0, dropErr = '';
  while (q.length) {
    try {
      const r = await api.post(q[0].body); // nonJson counts as landed (verify by GET after)
      if (r && r.ok === false && /busy/i.test(r.error || '')) break; // transient — retry later
      if (r && r.ok === false) {
        // Permanent rejection (e.g. set_id from a superseded session): drop it
        // rather than wedging the queue — but SAY so; the user believes it saved.
        dropped++; dropErr = r.error || 'rejected';
      } else landed++;
      clearOptimisticFor(q[0]);
      q.shift();
      queue.write(q);
    } catch (e) {
      if (e.nonJson) { clearOptimisticFor(q[0]); q.shift(); landed++; queue.write(q); continue; }
      break;                          // still offline — keep FIFO order, retry later
    }
  }
  if (dropped) {
    toast(dropped + ' queued write' + (dropped > 1 ? 's were' : ' was') + ' rejected and dropped: ' + dropErr);
  } else if (landed) {
    toast('Synced ' + landed + ' queued write' + (landed > 1 ? 's' : '') + '.');
  }
  if (landed || dropped) {
    try { await refresh(); } catch (_) { /* offline again */ }
  }
}
/** A queued write that finally lands stops being "pending" — release its overlay
 *  entries so the follow-up refresh's server truth stands on its own. VERSIONED:
 *  an item from an older page load, or one older than the set's current overlay
 *  entry, must never clear it — the entry is protecting a NEWER value. */
function clearOptimisticFor(item) {
  const body = item.body || item; // tolerate raw bodies
  const stale = item.lid !== LOAD_ID; // older load: this load's overlay is newer
  const release = (setId) => {
    if (stale) return;
    const e = optimistic.mut.get(setId);
    if (e && e.v <= (item.v || 0)) optimistic.clear(setId);
  };
  if (body.set_id) release(body.set_id);
  else if (body.action === 'skip_exercise' && state.open && state.open.sets) {
    state.open.sets.forEach((s) => { if (s.exercise === body.exercise) release(s.set_id); });
  }
}

window.addEventListener('online', flushQueue);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  flushQueue();
  resyncOnResume();
});

/** App resume: iOS keeps the PWA alive for days, and boot() only runs on a real
 *  page load — a resumed app renders whatever session was in memory when it was
 *  backgrounded (2026-07-23 incident: a Tuesday screen surfaced on Thursday and
 *  its Complete hit a different open session). Re-fetch server truth on every
 *  resume; offline keeps the stale render, marked as such in the header. */
let resyncP = null;
function resyncOnResume() {
  if (!cfg.ready || !state.open || resyncP) return;
  if (state.lastSync && Date.now() - state.lastSync < 60000) return; // just synced
  resyncP = (async () => {
    try {
      const prevId = state.open.session && state.open.session.session_id;
      await refresh();
      const curId = state.open.session && state.open.session.session_id;
      if (prevId && curId && prevId !== curId) {
        toast('Screen was out of date — now showing ' + state.open.session.day_label + '.', { ms: 5000 });
      }
    } catch (_) {
      if (!state.stale) { state.stale = Date.now(); renderToday(); } // can't verify — say so
    } finally { resyncP = null; }
  })();
}

// ---- optimistic writes ------------------------------------------------------------
// The UI is the instant truth; the sheet catches up. Every set-level mutation is
// applied to state immediately and tracked here until the server acks it, so a
// concurrent refresh() can't clobber a pending write with a stale snapshot, and
// Complete can wait for the sheet to actually hold what the screen shows.

const optimistic = {
  // set_id -> { fields, base, v }: the locally-applied fields not yet acked,
  // the ORIGINAL server truth from before the first optimistic touch (reverts
  // always land there, never on an intermediate optimistic value), and a
  // version stamp so an older write's ack/revert can't disturb a newer one.
  mut: new Map(),
  ctr: 0,
  inflight: new Set(), // unresolved reconcile promises
  snapshot(set) {
    return { actual_reps: set.actual_reps, actual_load: set.actual_load,
      comment: set.comment, skipped: set.skipped };
  },
  /** Perform an optimistic mutation: snapshot the original server truth FIRST
   *  (only on the set's first pending touch), then apply the fields to the set
   *  and record them. Returns the mutation's version stamp. Callers must NOT
   *  pre-mutate the set — the base snapshot is what reverts restore. */
  apply(set, fields) {
    let e = this.mut.get(set.set_id);
    if (!e) { e = { fields: {}, base: this.snapshot(set), v: 0 }; this.mut.set(set.set_id, e); }
    Object.assign(set, fields);
    Object.assign(e.fields, fields);
    e.v = ++this.ctr;
    return e.v;
  },
  /** Ack from the write that produced version v. Clears the entry ONLY when no
   *  newer write is stacked on the same set (else that write's ack finishes the
   *  job). Returns whether the caller may merge the server row. */
  ack(setId, v) {
    const e = this.mut.get(setId);
    if (!e) return false;
    if (e.v !== v) return false; // newer optimistic value pending — don't clobber
    this.mut.delete(setId);
    return true;
  },
  /** Revert to the original server truth — but only if the rejected write is
   *  still the newest for this set; a newer stacked write's own reconcile
   *  decides otherwise (its base is the same original truth). */
  revertIfCurrent(setId, v) {
    const e = this.mut.get(setId);
    if (!e || e.v !== v) return false;
    const s = findSet(setId);
    if (s) Object.assign(s, e.base);
    this.mut.delete(setId);
    return true;
  },
  clear(setId) { this.mut.delete(setId); },
  /** After refresh(): pending local truth wins over the fetched snapshot. Entries
   *  whose set_id no longer exists (session rolled over) are dropped. */
  reapply(open) {
    if (!open || !open.sets) return;
    this.mut.forEach((e, id) => {
      const s = open.sets.find((r) => r.set_id === id);
      if (s) Object.assign(s, e.fields); else this.mut.delete(id);
    });
  },
  /** Resolve when nothing is in flight (Complete gates on this — the server must
   *  hold every logged set before it snapshots the session). */
  async settle() {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  },
};

function findSet(setId) {
  return state.open && state.open.sets
    ? state.open.sets.find((r) => r.set_id === setId) : null;
}

/** Per-set write serialization: two quick writes to the same set must reach the
 *  sheet in tap order — concurrent fetches carry no ordering guarantee, and a
 *  reordered pair would leave the sheet holding the OLDER value. */
const setChains = new Map();
function chainFor(setIds, fn) {
  const prev = Promise.allSettled(setIds.map((id) => setChains.get(id) || Promise.resolve()));
  const run = prev.then(fn, fn);
  setIds.forEach((id) => setChains.set(id, run));
  run.finally(() => setIds.forEach((id) => { if (setChains.get(id) === run) setChains.delete(id); }));
  return run;
}

/** Background reconcile of one optimistic write. targets = [{set_id, v}] with v
 *  the overlay version this write produced. Outcomes: ack -> clear pending and
 *  merge the canonical row (unless a newer write is stacked); queued
 *  (offline/busy) -> optimistic state stands, the flush->refresh path finishes
 *  the job; non-JSON -> probably landed, verify by GET; hard rejection ->
 *  revert to original server truth and tell the user. */
function reconcile(body, targets) {
  const p = chainFor(targets.map((t) => t.set_id), async () => {
    try {
      const r = await write(body, Math.max.apply(null, targets.map((t) => t.v)));
      if (r && r.ok === false) throw new Error(r.error || 'rejected');
      if (r && r.queued) return; // overlay stands until the queue flushes
      let mergeable = true;
      targets.forEach((t) => { if (!optimistic.ack(t.set_id, t.v)) mergeable = false; });
      if (mergeable && r && r.row) { const s = findSet(r.row.set_id); if (s) Object.assign(s, r.row); }
      renderToday();
    } catch (e) {
      if (e.nonJson) { // write may have landed — the sheet is the tiebreaker
        targets.forEach((t) => optimistic.clear(t.set_id));
        try { await refresh(); } catch (_) { /* offline right after */ }
        return;
      }
      let reverted = 0;
      targets.forEach((t) => { if (optimistic.revertIfCurrent(t.set_id, t.v)) reverted++; });
      if (reverted) {
        renderToday();
        toast('Didn’t save — reverted: ' + e.message);
      }
    }
  });
  optimistic.inflight.add(p);
  p.finally(() => optimistic.inflight.delete(p));
  return p;
}

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

const state = { open: null, apiVersion: 0, undoDeployed: false };

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
  const rc = recentComplete();
  return el('div', { class: 'sessioncard' },
    el('div', { class: 'day' }, s.day_label + (r.emphasis ? ' — ' + r.emphasis : ''),
      state.stale ? el('span', { class: 'stale', style: 'margin-left:.5rem;vertical-align:middle' }, 'offline · stale') : null),
    el('div', { class: 'meta' },
      fmtDate(s.date) + (r.last_session_date ? ' · last session ' + daysAgoText(r.last_session_date) : '')),
    el('div', { class: 'rot' }, dots,
      el('em', {}, (r.position || '?') + ' of ' + (r.order || []).length + ' · next: ' + (r.next || '—'))),
    state.undoDeployed && rc ? el('div', { class: 'undoline' },
      'Submitted ' + rc.day + ' by mistake? ',
      el('button', { class: 'linkbtn', onclick: () => startUndo(false, 0) }, 'Undo')) : null,
  );
}

/** Logged / skipped / blank tallies for the guard dialog and the submit gate. */
function setCounts(sets) {
  const c = { logged: 0, skipped: 0, blank: 0, total: sets.length };
  sets.forEach((s) => {
    if (s.actual_reps !== '') c.logged++;
    else if (String(s.skipped).toUpperCase() === 'TRUE') c.skipped++;
    else c.blank++;
  });
  return c;
}

/** The completion this device performed in the last 20 minutes, if any — the
 *  window in which "wait, that submit was an accident" realistically happens. */
function recentComplete() {
  try {
    const c = JSON.parse(localStorage.getItem(LS.lastComplete));
    if (c && c.id && Date.now() - c.ts < 20 * 60 * 1000) return c;
  } catch (_) { /* corrupt/missing */ }
  return null;
}

/** One tap on an empty chip logs the set: reps default to that set's last-time
 *  reps (fallback rx_reps_high); load is already prefilled server-side.
 *  A filled chip opens the set editor instead (tap-again-adjusts).
 *  OPTIMISTIC: the chip fills the instant it's tapped; the POST reconciles in
 *  the background and reverts the chip only on a hard rejection. */
function tapChip(set, chipBtn, exName) {
  if (set.actual_reps !== '' || String(set.skipped).toUpperCase() === 'TRUE') { openEditor(set, exName); return; }
  const ghost = state.open.ghosts[exName];
  const gReps = ghost && ghost.reps ? ghost.reps[Number(set.set_no) - 1] : null;
  const reps = gReps || Number(set.rx_reps_high) || Number(set.rx_reps_low);
  if (!reps) { openEditor(set, exName); return; } // AMRAP-style set: no sane default
  const v = optimistic.apply(set, { actual_reps: String(reps) });
  renderToday();
  reconcile({ action: 'log_set', set_id: set.set_id, actual_reps: reps },
    [{ set_id: set.set_id, v }]);
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

  /** OPTIMISTIC: apply locally, close the sheet, auto-advance immediately — the
   *  between-sets flow never waits on the network. Reverts on hard rejection. */
  function save(fields) {
    const local = {};
    if ('actual_reps' in fields) local.actual_reps = fields.actual_reps == null ? '' : String(fields.actual_reps);
    if ('actual_load' in fields) local.actual_load = fields.actual_load;
    if ('comment' in fields) local.comment = fields.comment;
    if ('skipped' in fields) local.skipped = fields.skipped ? 'TRUE' : 'FALSE';
    const v = optimistic.apply(set, local);
    closeSheet();
    renderToday();
    reconcile(Object.assign({ action: 'log_set', set_id: set.set_id }, fields),
      [{ set_id: set.set_id, v }]);
    // auto-advance: next unlogged, unskipped set of this exercise
    const next = exSets.find((s) => s.actual_reps === '' && String(s.skipped).toUpperCase() !== 'TRUE');
    if (fields.actual_reps != null && next) openEditor(next, exName);
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

/** OPTIMISTIC: the card greys out instantly; one background POST covers every
 *  affected set, and a hard rejection restores each of them. */
function skipExercise(exName) {
  const targets = [];
  state.open.sets.forEach((s) => {
    if (s.exercise !== exName || s.actual_reps !== '' || String(s.skipped).toUpperCase() === 'TRUE') return;
    const fields = { skipped: 'TRUE', comment: s.comment || 'skipped for time' };
    targets.push({ set_id: s.set_id, v: optimistic.apply(s, fields) });
  });
  if (!targets.length) return;
  renderToday();
  reconcile({ action: 'skip_exercise', session_id: state.open.session.session_id, exercise: exName }, targets);
}

let noteTimer;
function saveNotes(text) {
  const sessionId = state.open.session.session_id; // capture NOW — session may roll over mid-debounce
  state.open.session.session_notes = text; // optimistic; the textarea already shows it
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => {
    const p = (async () => {
      try {
        const r = await write({ action: 'session_note', session_id: sessionId, text });
        if (!r.ok) throw new Error(r.error);
      } catch (e) {
        if (e.nonJson) { try { await refresh(); } catch (_) { /* offline */ } return; }
        toast('Notes didn’t save: ' + e.message);
      }
    })();
    optimistic.inflight.add(p); // Complete waits for notes too
    p.finally(() => optimistic.inflight.delete(p));
  }, 600);
}

/** Submit guard (2026-07-11 incident: one stray tap completed a mid-workout
 *  session and advanced the rotation). The bare button now only opens this
 *  sheet; completing takes a second, separated tap on a dialog that shows
 *  exactly what will be submitted, and blank-heavy submits warn loudly. */
function confirmComplete(btn) {
  const o = state.open;
  const c = setCounts(o.sets);
  const loud = c.blank > 0 && c.blank >= c.logged;
  openSheet(
    el('div', { class: 'appbar', style: 'border-radius:10px' },
      el('div', {},
        el('div', { class: 't' }, 'Complete this session?'),
        el('div', { class: 'sub' }, o.session.day_label + ' · ' + fmtDate(o.session.date)))),
    el('div', { class: 'formcard' },
      el('div', { class: 'label' }, 'What gets submitted'),
      el('div', { class: 'rxline' }, el('span', {}, 'Logged sets'), el('b', {}, c.logged + ' of ' + c.total)),
      c.skipped ? el('div', { class: 'rxline' }, el('span', {}, 'Skipped'), el('b', {}, String(c.skipped))) : null,
      c.blank ? el('div', { class: 'err' },
        (loud ? 'Heads up — most of this session is still blank. ' : '') +
        c.blank + ' blank set' + (c.blank > 1 ? 's' : '') + ' will be marked "(skipped for time)".') : null,
      el('div', { class: 'hint' },
        'This closes today, advances the rotation, and loads ' + (o.rotation.next || 'the next day') + '.')),
    el('div', { class: 'formbtns' },
      el('button', { class: 'primary', onclick: () => { closeSheet(); completeSession(btn); } }, 'Complete Session'),
      el('button', { class: 'ghostbtn', onclick: closeSheet }, 'Cancel')),
  );
}

/** Complete → complete-requested → "Finishing…" → poll view=open (2s, ≤90s)
 *  until a NEW session materializes. Double-taps are idempotent server-side. */
async function completeSession(btn) {
  const prevId = state.open.session.session_id;
  const prevDay = state.open.session.day_label;
  btn.disabled = true; btn.textContent = 'Syncing…';
  setSub('Syncing…');
  // Optimism ends here: complete_v2 snapshots the SHEET, so every pending write
  // must land (or queue) first — otherwise an in-flight set would be stamped
  // "(skipped for time)" by the very completion that raced past it.
  await optimistic.settle();
  if (queue.length && navigator.onLine) await flushQueue();
  // Fossil-screen guard (2026-07-23 incident): the submit — and especially the
  // allowEmpty escalation — must be decided against the SERVER's open session,
  // not this screen's. A resumed app can render a long-completed session; its
  // Complete would otherwise close (or empty-complete) a session the user never
  // saw. Offline: proceed without allowEmpty — the server's own empty guard
  // stays the backstop, and an intentional empty complete can wait for signal.
  let logged = state.open.sets.some((s) => s.actual_reps !== '');
  let verified = false;
  try {
    const chk = await api.get('open');
    if (chk.ok && chk.open) {
      const sid = chk.open.session && chk.open.session.session_id;
      if (sid !== prevId) {
        state.open = chk.open;
        optimistic.reapply(state.open);
        renderToday();
        setSub('Active session');
        toast('This screen was out of date — loaded the real open session ('
          + (chk.open.session ? chk.open.session.day_label : 'none') + '). Nothing was submitted.', { ms: 6000 });
        return;
      }
      verified = true;
      logged = chk.open.sets.some((s) => s.actual_reps !== '');
    }
  } catch (_) { /* offline/transient — fall through, allowEmpty stays off */ }
  btn.textContent = 'Finishing…';
  setSub('Finishing…');
  try {
    const r = await write(Object.assign({ action: 'complete_v2' }, (verified && !logged) ? { allowEmpty: true } : {}));
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
        optimistic.reapply(state.open); // drops entries orphaned by the rollover
        try { localStorage.setItem(LS.lastComplete, JSON.stringify({ id: prevId, day: prevDay, ts: Date.now() })); }
        catch (_) { /* quota: the post-submit snackbar still offers Undo */ }
        renderToday();
        if (state.undoDeployed) {
          toast('Session complete — next up: ' + r.open.session.day_label,
            { action: 'Undo', onAction: () => startUndo(false, 0), ms: 15000 });
        } else {
          toast('Session complete — next up: ' + r.open.session.day_label);
        }
        return;
      }
    } catch (_) { /* transient; keep polling */ }
  }
  toast('Still finishing server-side — pull to refresh in a minute.');
  await refresh();
}

// ---- undo_complete (accidental-submit recovery) -----------------------------------
// Backend contract (gym-programmer V2.gs undoCompleteV2_): reopens the last completed
// session (or body.session_id), discards the materialized open session — refusing with
// {touched:N} when it has logged/skipped sets unless force:true — restores Next-Up,
// clears auto "(skipped for time)" comments.

/** Undo confirmation sheet. force=true is the second, louder confirmation shown
 *  only after the server refused because the open session has touched sets. */
function startUndo(force, touched) {
  const rc = recentComplete();
  const cur = state.open && state.open.session;
  openSheet(
    el('div', { class: 'appbar', style: 'border-radius:10px' },
      el('div', {},
        el('div', { class: 't' }, 'Undo last submit'),
        el('div', { class: 'sub' }, rc ? 'Reopen ' + rc.day : 'Reopen the last completed session'))),
    el('div', { class: 'formcard' },
      el('div', { class: 'label' }, 'What this does'),
      el('div', { class: 'lastline' },
        'Reopens ' + (rc ? rc.day : 'the last completed session') +
        ' with everything already logged intact, points Next-Up back at it, and clears the auto "(skipped for time)" comments.'),
      cur ? el('div', { class: 'lastline' },
        'The ' + cur.day_label + ' session it materialized will be discarded.') : null,
      force ? el('div', { class: 'err' },
        'The open ' + (cur ? cur.day_label + ' ' : '') + 'session already has ' + touched +
        ' logged/skipped set' + (touched === 1 ? '' : 's') + '. Forcing the undo DELETES ' +
        (touched === 1 ? 'it' : 'them') + ' permanently.') : null),
    el('div', { class: 'formbtns' },
      el('button', { class: 'primary' + (force ? ' danger' : ''), onclick: () => doUndo(force) },
        force ? 'Delete sets & undo' : 'Undo submit'),
      el('button', { class: 'ghostbtn', onclick: closeSheet }, 'Cancel')),
  );
}

/** Fires undo_complete directly (never queued — replaying an undo later against
 *  moved state would be worse than failing now). */
async function doUndo(force) {
  sheetBusy(true);
  const rc = recentComplete();
  const body = { action: 'undo_complete' };
  if (rc) body.session_id = rc.id; // pin the target when this device did the submit
  if (force) body.force = true;
  let r;
  try { r = await api.post(body); }
  catch (e) {
    sheetBusy(false);
    if (e.nonJson) { closeSheet(); await refresh(); return; } // may have landed — show truth
    toast(isNetworkError(e) ? 'Undo needs a connection — try again once online.' : 'Undo failed: ' + e.message);
    return;
  }
  if (r.ok) {
    try { localStorage.removeItem(LS.lastComplete); } catch (_) { /* fine */ }
    closeSheet();
    toast('Reopened ' + (r.day || r.reopened) + '.');
    try { await refresh(); } catch (_) { /* went offline right after — stale render stands */ }
    return;
  }
  sheetBusy(false);
  const err = r.error || 'undo failed';
  if (r.touched) { startUndo(true, Number(r.touched)); return; } // force path, second confirmation
  if (/unknown action/i.test(err)) { // deployed build predates undo_complete
    state.undoDeployed = false;
    try { localStorage.removeItem(LS.undoCap); } catch (_) { /* fine */ }
    closeSheet();
    renderToday();
    toast('Undo is not on the deployed API yet — it arrives with the next paste-deploy.');
    return;
  }
  if (/busy/i.test(err)) { toast('Server busy — try again in a moment.'); return; }
  if (/not complete|not found|no completed|no sessions/i.test(err)) {
    closeSheet();
    toast('Nothing to undo: ' + err);
    try { await refresh(); } catch (_) { /* offline */ }
    return;
  }
  toast('Undo failed: ' + err);
}

/** Is undo_complete live on the pinned deployment? ping can't say — API_VERSION
 *  is 4 on both sides of that paste-deploy — so probe with a session_id that can
 *  never exist: the new build answers 'session_id not found' (read-only path, no
 *  write happens), an older build answers 'unknown action — …'. The positive
 *  result is cached; a stale positive self-heals in doUndo's unknown-action arm. */
async function probeUndo() {
  if (state.undoDeployed) return;
  if (localStorage.getItem(LS.undoCap) === '1') { state.undoDeployed = true; return; }
  if (state.apiVersion && Number(state.apiVersion) < 4) return;
  try {
    const r = await api.post({ action: 'undo_complete', session_id: 'capability-probe' });
    if (r && r.error === 'session_id not found') {
      state.undoDeployed = true;
      try { localStorage.setItem(LS.undoCap, '1'); } catch (_) { /* re-probe next boot */ }
    }
  } catch (_) { /* offline or busy — stay pessimistic, re-probe next boot */ }
}

function chip(set, exName) {
  const logged = set.actual_reps !== '';
  const below = logged && set.rx_reps_low !== '' && Number(set.actual_reps) < Number(set.rx_reps_low);
  const cls = 'setchip' + (logged ? (below ? ' low' : ' filled') : '')
    + (optimistic.mut.has(set.set_id) ? ' pending' : '');
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
  // Defense in depth: nothing logged or skipped yet → the submit button is inert
  // (an untouched session has nothing to submit; empty completes stay curl-only).
  const c = setCounts(o.sets);
  const canSubmit = c.logged + c.skipped > 0;
  show(
    sessionHeader(o),
    groups.map((ex) => exerciseCard(ex, byEx[ex])),
    el('div', { class: 'formcard', style: 'border-style:dashed' },
      el('textarea', { class: 'cmt', rows: '2',
        placeholder: 'Session notes — sleep, energy, knee/shoulder, time available…',
        onchange: (e) => saveNotes(e.target.value) },
        s.session_notes || '')),
    el('button', { class: 'fabbtn', disabled: !canSubmit,
      onclick: (e) => confirmComplete(e.target) }, 'Complete Session ✓'),
    canSubmit ? null : el('div', { class: 'hint', style: 'text-align:center' },
      'Log or skip at least one set to enable submitting.'),
  );
}

let toastTimer;
/** opts.action + opts.onAction render a snackbar button (e.g. post-submit Undo);
 *  opts.ms overrides the auto-hide delay. */
function toast(msg, opts) {
  let t = $('#toast');
  if (!t) { t = el('div', { id: 'toast', class: 'toastbar' }); document.body.append(t); }
  t.replaceChildren(...[el('span', {}, msg),
    opts && opts.action
      ? el('button', { class: 'tact', onclick: () => { t.classList.remove('on'); opts.onAction(); } }, opts.action)
      : null].filter(Boolean));
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), (opts && opts.ms) || 2600);
}

async function refresh() {
  const r = await api.get('open');
  if (!r.ok) throw new Error(r.error || 'API error');
  state.open = r.open;
  optimistic.reapply(state.open); // pending writes beat the fetched snapshot
  state.stale = false;
  state.lastSync = Date.now();
  state.apiVersion = Number(r.version) || 0;
  try { localStorage.setItem(LS.lastGood, JSON.stringify({ open: r.open, ts: Date.now() })); }
  catch (_) { /* private mode / quota: offline fallback just won't have data */ }
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
    // capability check is async — repaint if it unlocks a visible undo affordance
    probeUndo().then(() => { if (state.undoDeployed && recentComplete() && state.open) renderToday(); });
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
