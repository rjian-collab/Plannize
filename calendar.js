// Two-way sync between projects and a dedicated Google Calendar ("Plannize").
//
// App -> Calendar: every project with a deadline is an all-day event on that
//   day (✓ prefix once completed/archived; progress + notes in the
//   description). Removing a deadline or deleting a project removes its event.
// Calendar -> App (incremental via syncToken):
//   event moved to another day   -> project deadline follows
//   new event in this calendar   -> new project (category Others)
//   event deleted                -> project's deadline cleared (project kept)
//
// Each event carries extendedProperties.private.projectId, so the link
// survives either side being edited. A per-project hash of what we last
// pushed avoids re-sending unchanged events. Sync state lives in
// data/google-sync.json; the event id is also kept on the project
// (calendarEventId) for reference.
const fs = require('fs');
const path = require('path');
const google = require('./google');

const API = 'https://www.googleapis.com/calendar/v3';
const STATE_PATH = path.join(require('./paths').DATA_DIR, 'google-sync.json');
const CAL_NAME = 'Plannize';
const LEGACY_CAL_NAMES = ['我的專案', 'Planglass']; // names the app's calendar had before the rename
const PERIODIC_MS = 5 * 60 * 1000;

let store = null;       // { readData, writeData } from server.js
let onExternalChange = () => {};
let status = { lastSync: null, error: null, running: false };

function configure(opts) {
  store = opts.store;
  onExternalChange = opts.onExternalChange || onExternalChange;
}

// ---------- state ----------

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return { calendarId: null, syncToken: null, events: {} }; }
}
function saveState(st) { fs.writeFileSync(STATE_PATH, JSON.stringify(st, null, 2)); }

// ---------- HTTP ----------

async function api(method, url, body) {
  const token = await google.accessToken();
  const res = await fetch(API + url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((j.error && j.error.message) || `Calendar API ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return j;
}

// ---------- mapping ----------

const nextDay = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  return t.toISOString().slice(0, 10);
};

function eventBody(p) {
  const done = p.progress >= 100 || p.archived;
  const lines = [`進度：${p.progress}%`];
  const open = (p.subtasks || []).filter((s) => !s.done);
  if (open.length) lines.push('未完成子工作項：\n' + open.map((s) => '・' + s.title).join('\n'));
  if (p.notes) lines.push(p.notes);
  lines.push('— 由 Plannize 同步');
  return {
    summary: (done ? '✓ ' : '') + p.title,
    description: lines.join('\n\n'),
    start: { date: p.deadline },
    end: { date: nextDay(p.deadline) },
    transparency: 'transparent',                      // doesn't block the day as "busy"
    reminders: { useDefault: false, overrides: [] },   // the app sends its own reminders
    extendedProperties: { private: { projectId: p.id } },
  };
}

const hashOf = (b) => JSON.stringify(b);

// local date of an event's start (all-day or timed)
function eventDate(ev) {
  if (ev.start && ev.start.date) return ev.start.date;
  if (ev.start && ev.start.dateTime) {
    const d = new Date(ev.start.dateTime);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return null;
}

// ---------- calendar ----------

async function ensureCalendar(st) {
  if (st.calendarId) {
    try {
      const cal = await api('GET', `/calendars/${encodeURIComponent(st.calendarId)}`);
      // one-time rename of the calendar the app made under its old name; a
      // name the user chose themselves is left alone
      if (cal && LEGACY_CAL_NAMES.includes(cal.summary)) {
        try { await api('PATCH', `/calendars/${encodeURIComponent(st.calendarId)}`, { summary: CAL_NAME }); } catch {}
      }
      return;
    } catch (e) {
      if (e.status !== 404 && e.status !== 403) throw e;
    }
  }
  // (re)create: the old one is gone, so every link to it is stale too
  const cal = await api('POST', '/calendars', {
    summary: CAL_NAME,
    description: '由 Plannize 管理：專案截止日會出現在這裡，在這裡新增或移動活動也會同步回 App。',
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  st.calendarId = cal.id;
  st.syncToken = null;
  st.events = {};
  const data = store.readData();
  data.projects.forEach((p) => { p.calendarEventId = null; });
  internalWrite(data);
}

let internal = false;
function internalWrite(data) {
  internal = true;
  try { store.writeData(data); } finally { internal = false; }
}

// ---------- pull: Calendar -> App ----------

async function pull(st) {
  const cal = encodeURIComponent(st.calendarId);
  const changed = [];
  let pageToken = null, nextSyncToken = null;
  do {
    const q = new URLSearchParams({ showDeleted: 'true', maxResults: '250' });
    if (st.syncToken) q.set('syncToken', st.syncToken);
    if (pageToken) q.set('pageToken', pageToken);
    let r;
    try {
      r = await api('GET', `/calendars/${cal}/events?${q}`);
    } catch (e) {
      if (e.status === 410) { st.syncToken = null; return pull(st); } // token expired: full resync
      throw e;
    }
    changed.push(...(r.items || []));
    pageToken = r.nextPageToken || null;
    nextSyncToken = r.nextSyncToken || nextSyncToken;
  } while (pageToken);

  let externalChanges = 0;
  const newEvents = [];
  // apply everything in one synchronous read-modify-write
  const data = store.readData();
  const byId = new Map(data.projects.map((p) => [p.id, p]));
  for (const ev of changed) {
    const pid = ev.extendedProperties && ev.extendedProperties.private && ev.extendedProperties.private.projectId;
    const p = pid ? byId.get(pid) : data.projects.find((x) => x.calendarEventId === ev.id);
    if (ev.status === 'cancelled') {
      if (p && p.calendarEventId === ev.id) {
        if (p.deadline) { p.deadline = null; externalChanges++; }
        p.calendarEventId = null;
        delete st.events[p.id];
      }
      continue;
    }
    if (p) {
      const day = eventDate(ev);
      if (day && day !== p.deadline) { p.deadline = day; p.updatedAt = new Date().toISOString().slice(0, 19); externalChanges++; }
      if (p.calendarEventId !== ev.id) p.calendarEventId = ev.id;
    } else if (!pid && !ev.recurrence && !ev.recurringEventId && eventDate(ev)) {
      newEvents.push(ev); // made on the phone / in Google Calendar
    }
  }
  for (const ev of newEvents) {
    const now = new Date().toISOString().slice(0, 19);
    const project = {
      id: require('crypto').randomUUID(), legacyId: null,
      title: (ev.summary || '（未命名活動）').trim(), category: 'Others', priority: 'Medium',
      startDate: null, deadline: eventDate(ev), progress: 0, progressLabel: null,
      relatedDocuments: null, driveLink: null, websiteLink: null, localFilePath: null,
      calendarEventId: ev.id, notes: ev.description || null, subtasks: [], attachments: [],
      remind: null, archived: false, createdAt: now, updatedAt: now,
    };
    data.projects.push(project);
    externalChanges++;
  }
  if (externalChanges || changed.length) internalWrite(data);
  st.syncToken = nextSyncToken;
  return externalChanges;
}

// ---------- push: App -> Calendar ----------

async function push(st) {
  const cal = encodeURIComponent(st.calendarId);
  const data = store.readData();
  const ids = {}; // projectId -> eventId learned during this push
  const live = new Set();
  for (const p of data.projects) {
    const known = st.events[p.id];
    if (!p.deadline) {
      if (known) {
        try { await api('DELETE', `/calendars/${cal}/events/${encodeURIComponent(known.eventId)}`); } catch (e) { if (![404, 410].includes(e.status)) throw e; }
        delete st.events[p.id];
        ids[p.id] = null;
      }
      continue;
    }
    live.add(p.id);
    const body = eventBody(p);
    const h = hashOf(body);
    const eventId = (known && known.eventId) || p.calendarEventId;
    if (known && known.hash === h && known.eventId === eventId) continue;
    let ev = null;
    if (eventId) {
      try { ev = await api('PATCH', `/calendars/${cal}/events/${encodeURIComponent(eventId)}`, body); } catch (e) { if (![404, 410].includes(e.status)) throw e; }
    }
    if (!ev) ev = await api('POST', `/calendars/${cal}/events`, body);
    st.events[p.id] = { eventId: ev.id, hash: h };
    if (p.calendarEventId !== ev.id) ids[p.id] = ev.id;
  }
  // projects deleted from the app
  for (const pid of Object.keys(st.events)) {
    if (live.has(pid) || data.projects.some((p) => p.id === pid)) continue;
    try { await api('DELETE', `/calendars/${cal}/events/${encodeURIComponent(st.events[pid].eventId)}`); } catch (e) { if (![404, 410].includes(e.status)) throw e; }
    delete st.events[pid];
  }
  if (Object.keys(ids).length) {
    const fresh = store.readData(); // re-read: the user may have edited meanwhile
    fresh.projects.forEach((p) => { if (p.id in ids) p.calendarEventId = ids[p.id]; });
    internalWrite(fresh);
  }
}

// ---------- orchestration ----------

let timer = null, periodic = null, again = false;

async function syncNow() {
  const gs = google.status();
  if (!store || !gs.connected || !gs.canCalendar) return { skipped: true };
  if (status.running) { again = true; return { queued: true }; }
  status.running = true;
  let changes = 0;
  try {
    const st = loadState();
    await ensureCalendar(st);
    changes = await pull(st);
    await push(st);
    saveState(st);
    status.lastSync = Date.now();
    status.error = null;
    if (changes) onExternalChange();
  } catch (e) {
    status.error = e.message;
    console.error('calendar sync failed:', e.message);
  } finally {
    status.running = false;
    if (again) { again = false; schedule(); }
  }
  return { changes };
}

// local edits: push soon (debounced — the detail panel saves field by field)
function schedule(delay = 3000) {
  clearTimeout(timer);
  timer = setTimeout(syncNow, delay);
}

function onLocalWrite() { if (!internal) schedule(); }

function start() {
  syncNow();
  clearInterval(periodic);
  periodic = setInterval(syncNow, PERIODIC_MS);
}

// forget the link (used when the Google account is disconnected)
function reset() {
  fs.rmSync(STATE_PATH, { force: true });
  status = { lastSync: null, error: null, running: false };
}

function getStatus() {
  const st = loadState();
  return { lastSync: status.lastSync, error: status.error, running: status.running, calendarId: st.calendarId, eventCount: Object.keys(st.events || {}).length };
}

module.exports = { configure, syncNow, schedule, onLocalWrite, start, reset, getStatus };
