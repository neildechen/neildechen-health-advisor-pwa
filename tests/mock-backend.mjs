/**
 * In-memory stand-in for the gym-programmer Apps Script API (V2.gs), just enough
 * of view=ping / view=open / log_set / skip_exercise / session_note / complete_v2 /
 * undo_complete for the client to run a whole workout against it. Two fixtures:
 *   tracker()  — the single-plan Full Body sheet (Tracker.gs seed)
 *   fourDay()  — a Neil-shaped four-day rotation (regression: nothing may change)
 * The mock mirrors the server's display-value contract: everything is a string,
 * booleans are "TRUE"/"FALSE", reps numbers become strings, loads stay verbatim.
 */

// name, loggable sets, reps low, reps high, rx load, load type, [rec_sets, optional]
const TRACKER_PROGRAM = [
  ['Seated Cable RDL', 4, 8, 10, '', 'machine', '3', ''],
  ['Bulgarian Split Squat', 4, 6, 8, '', 'dumbbell', '3', ''],
  ['Glute Hip Thrust', 4, 8, 10, '', 'barbell', '3', 'Y'],
  ['Bench Press', 4, 4, 5, '', 'barbell', '3', ''],
  ['Lat Pulldown', 4, 8, 10, '', 'machine', '3', ''],
  ['Hanging Leg Raise', 4, 10, 15, 'BW', 'bodyweight', '3', ''],
];
const FOUR_DAY = {
  order: ['Upper A', 'Lower - Squat', 'Upper B', 'Lower - Hinge'],
  programs: {
    'Upper A': [['Bench Press', 4, 4, 6, '180', 'barbell'], ['Weighted Pull-up', 4, 4, 6, '+35', 'added'], ['Cuban Press', 2, 15, 20, '10', 'dumbbell']],
    'Lower - Squat': [['Barbell Box Squat', 4, 5, 6, '235', 'barbell']],
    'Upper B': [['Bench Press', 3, 6, 8, '175', 'barbell'], ['Weighted Pull-up', 3, 6, 8, '+30', 'added']],
    'Lower - Hinge': [['Heavy RDL', 3, 6, 8, '295', 'barbell']],
  },
};

export function makeBackend(kind, opts = {}) {
  const token = opts.token || 'mock-token';
  const order = kind === 'tracker' ? ['Full Body'] : FOUR_DAY.order;
  const programs = kind === 'tracker' ? { 'Full Body': TRACKER_PROGRAM } : FOUR_DAY.programs;
  const state = { nextUp: kind === 'tracker' ? 'Full Body' : 'Upper A', last: '' };
  const sessions = []; // { session_id, date, day_label, status, session_notes, sets: [] }
  const calls = [];    // every request the client made, for assertions
  let seq = 0;
  const today = () => new Date().toISOString().slice(0, 10);
  const slug = (d) => d.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const stamp = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

  function materialize() {
    if (sessions.some((s) => s.status !== 'complete')) return null;
    const day = state.nextUp;
    let id = today() + '-' + slug(day);
    for (let n = 2; sessions.some((s) => s.session_id === id); n++) id = today() + '-' + slug(day) + '-' + n;
    const sets = [];
    programs[day].forEach((ex, i) => {
      for (let s = 1; s <= ex[1]; s++) {
        sets.push({ set_id: id + '#' + (i + 1) + '#' + s, session_id: id, day_label: day, exercise: ex[0],
          order: String(i + 1), set_no: String(s), rx_reps_low: String(ex[2]), rx_reps_high: String(ex[3]),
          rx_load: ex[4], actual_reps: '', actual_load: ex[4], skipped: 'FALSE', comment: '', e1rm: '', volume: '',
          source: 'app', logged_at: '' });
      }
    });
    const sess = { session_id: id, date: today(), day_label: day, status: 'active', session_notes: '', started_at: stamp(), completed_at: '', sets };
    sessions.push(sess);
    return sess;
  }
  materialize();

  const open = () => sessions.find((s) => s.status !== 'complete') || null;
  function exercisesMeta(day) {
    const m = {};
    programs[day].forEach((ex) => { m[ex[0]] = { core: '', increment: ex[5] === 'bodyweight' ? '' : (ex[5] === 'added' ? '2.5' : '5'), rest: '2 min', progression: 'double progression', notes: '', rec_sets: ex[6] || '', optional: ex[7] || '' }; });
    return m;
  }
  function ghosts(sess) {
    const g = {};
    sessions.filter((s) => s !== sess && s.day_label === sess.day_label && s.status === 'complete').forEach((s) => {
      const byEx = {};
      s.sets.forEach((r) => { if (r.actual_reps !== '') (byEx[r.exercise] = byEx[r.exercise] || []).push(r); });
      Object.keys(byEx).forEach((ex) => {
        if (!g[ex] || s.date >= g[ex].date) {
          g[ex] = { session_id: s.session_id, date: s.date, load: byEx[ex][0].actual_load || byEx[ex][0].rx_load,
            reps: byEx[ex].map((r) => Number(r.actual_reps)), loads: byEx[ex].map((r) => r.actual_load) };
        }
      });
    });
    return g;
  }
  function openView() {
    const sess = open();
    const day = sess ? sess.day_label : state.nextUp;
    const idx = order.indexOf(day);
    const out = { session: sess ? { session_id: sess.session_id, date: sess.date, day_label: sess.day_label, status: sess.status,
      session_notes: sess.session_notes, started_at: sess.started_at, completed_at: sess.completed_at } : null,
      sets: sess ? sess.sets.map((s) => ({ ...s })) : [], ghosts: sess ? ghosts(sess) : {}, exercises: sess ? exercisesMeta(day) : {},
      rotation: { order, day, emphasis: kind === 'tracker' ? '' : (day === 'Upper A' ? 'heavy' : ''), position: idx + 1,
        next: order[(idx + 1) % order.length], last_session_date: state.last } };
    return out;
  }

  const handlers = {
    log_set(b) {
      const sess = open();
      const set = sess && sess.sets.find((s) => s.set_id === b.set_id);
      if (!set) return { ok: false, error: 'unknown set_id "' + b.set_id + '"' };
      if ('actual_reps' in b) set.actual_reps = b.actual_reps == null || b.actual_reps === '' ? '' : String(b.actual_reps);
      if ('actual_load' in b) set.actual_load = String(b.actual_load == null ? '' : b.actual_load).trim();
      if ('skipped' in b) set.skipped = (b.skipped === true || /^true$/i.test(String(b.skipped))) ? 'TRUE' : 'FALSE';
      if ('comment' in b) set.comment = String(b.comment == null ? '' : b.comment);
      set.logged_at = stamp(); set.source = 'app';
      return { ok: true, row: { ...set } };
    },
    skip_exercise(b) {
      const sess = open();
      if (!sess || sess.session_id !== b.session_id) return { ok: false, error: 'no SetLog rows' };
      let n = 0;
      sess.sets.forEach((s) => { if (s.exercise === b.exercise && s.actual_reps === '' && s.skipped !== 'TRUE') { s.skipped = 'TRUE'; if (!s.comment) s.comment = 'skipped for time'; n++; } });
      return { ok: true, skippedSets: n };
    },
    session_note(b) { const sess = open(); if (!sess) return { ok: false, error: 'unknown session_id' }; sess.session_notes = String(b.text); return { ok: true }; },
    complete_v2(b) {
      const sess = open();
      if (!sess) return { ok: true, completed: false, reason: 'no-open-session' };
      const logged = sess.sets.filter((s) => s.actual_reps !== '').length;
      if (!logged && !b.allowEmpty) return { ok: false, reason: 'empty', message: 'Open session ' + sess.session_id + ' has no logged sets' };
      sess.sets.forEach((s) => { if (s.actual_reps === '' && s.skipped !== 'TRUE' && !s.comment) s.comment = '(skipped for time)'; });
      sess.status = 'complete'; sess.completed_at = stamp(); state.last = sess.date;
      state.nextUp = order[(order.indexOf(sess.day_label) + 1) % order.length];
      const next = materialize();
      return { ok: true, completed: true, sessionId: sess.session_id, next: state.nextUp, materialized: next.session_id };
    },
    undo_complete(b) {
      if (b.session_id === 'capability-probe') return { ok: false, error: 'session_id not found' };
      const target = sessions.filter((s) => s.status === 'complete').pop();
      if (!target) return { ok: false, error: 'no completed session to reopen' };
      const cur = open();
      if (cur) sessions.splice(sessions.indexOf(cur), 1);
      target.status = 'active'; state.nextUp = target.day_label;
      return { ok: true, reopened: target.session_id, day: target.day_label };
    },
  };

  return {
    token, sessions, state, calls, seq: () => ++seq,
    handle(url, method, bodyText) {
      const u = new URL(url);
      const rec = { method, url, view: u.searchParams.get('view'), body: null, token: u.searchParams.get('token') };
      calls.push(rec);
      if (method === 'GET') {
        if (rec.token !== token) return { ok: false, error: 'bad token' };
        if (rec.view === 'ping') return { ok: true, version: 6, sheet: kind === 'tracker' ? 'Gym Tracker — Friend' : 'Health Advisor', time: new Date().toISOString() };
        if (rec.view === 'open') return { ok: true, version: 6, open: openView() };
        return { ok: true, version: 6, [rec.view]: { error: 'unknown view' } };
      }
      let b; try { b = JSON.parse(bodyText || '{}'); } catch (_) { return { ok: false, error: 'body must be JSON' }; }
      rec.body = b; rec.token = b.token;
      if (b.token !== token) return { ok: false, error: 'bad token' };
      const h = handlers[String(b.action || '').toLowerCase()];
      return h ? h(b) : { ok: false, error: 'unknown action — …' };
    },
  };
}
