const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const reminders = require('./reminders');
const routines = require('./routines');

const { DATA_DIR } = require('./paths');
const DATA_PATH = path.join(DATA_DIR, 'projects.json');
const ATTACH_DIR = path.join(DATA_DIR, 'attachments');
const PORT = 47821;
const BACKUP_DIR = path.join(DATA_DIR, 'backup');
const AUTO_KEEP = 14; // daily automatic backups kept

fs.mkdirSync(ATTACH_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(ATTACH_DIR, req.params.id);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, crypto.randomUUID() + ext);
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB per file — plenty for docs/images, keeps disk use sane
});

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/attachments', express.static(ATTACH_DIR));

function readData() {
  if (!fs.existsSync(DATA_PATH)) {
    return { projects: [], routines: [] }; // fresh install: no data file yet
  }
  const raw = fs.readFileSync(DATA_PATH, 'utf-8');
  const data = raw.trim() ? JSON.parse(raw) : { projects: [] };
  // Older records (e.g. the initial xlsx import) predate the attachments
  // field — default it so downstream code can always assume an array.
  data.projects.forEach((p) => {
    if (!Array.isArray(p.attachments)) p.attachments = [];
    if (!Array.isArray(p.subtasks)) p.subtasks = [];
  });
  if (!Array.isArray(data.routines)) data.routines = []; // recurring routines live beside projects
  return data;
}

// ---- Backups ----
// Once per day, the data file is copied before its first write that day
// (and at startup), so a bad edit, import or sync can always be rolled back.
// Automatic copies: backup/auto-YYYY-MM-DD.json, newest 14 kept.
// Manual / safety copies (backup/manual-*.json, before-restore-*.json) are
// never pruned.

const stampNow = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return { day: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, time: `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}` };
};

function autoBackup() {
  try {
    if (!fs.existsSync(DATA_PATH)) return;
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const target = path.join(BACKUP_DIR, `auto-${stampNow().day}.json`);
    if (fs.existsSync(target)) return;
    fs.copyFileSync(DATA_PATH, target);
    const autos = fs.readdirSync(BACKUP_DIR).filter((f) => /^auto-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    autos.slice(0, Math.max(0, autos.length - AUTO_KEEP)).forEach((f) => fs.rmSync(path.join(BACKUP_DIR, f), { force: true }));
  } catch (e) {
    console.error('auto backup failed:', e.message);
  }
}

function manualBackup(prefix) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const s = stampNow();
  const name = `${prefix}-${s.day}-${s.time}.json`;
  fs.copyFileSync(DATA_PATH, path.join(BACKUP_DIR, name));
  return name;
}

function writeData(data) {
  autoBackup();
  const tmpPath = DATA_PATH + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmpPath, DATA_PATH);
  reminders.scheduleSync(); // bring the scheduled reminder tasks in line with the new data
  writeHooks.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });
}

// other modules (Google Calendar sync) that react to data changes
const writeHooks = [];

// { days: [..], time: 'HH:MM' } with sane values; null = use the default schedule
function cleanRemind(r) {
  if (r === null) return null;
  if (!r || !Array.isArray(r.days)) return undefined;
  const days = [...new Set(r.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 60))].sort((a, b) => b - a);
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(r.time || '') ? r.time : reminders.DEFAULT_REMIND.time;
  return { days, time, email: r.email !== false };
}

function nowIso() {
  return new Date().toISOString().slice(0, 19);
}

function newId() {
  return crypto.randomUUID();
}

// ---- Projects ----

app.get('/api/projects', (req, res) => {
  res.json(readData());
});

app.post('/api/projects', (req, res) => {
  const data = readData();
  const body = req.body || {};
  const project = {
    id: newId(),
    legacyId: null,
    title: (body.title || '').trim(),
    category: (body.category || 'Others').trim(),
    priority: body.priority || 'Medium',
    startDate: body.startDate || null,
    deadline: body.deadline || null,
    progress: clampProgress(body.progress),
    progressLabel: null,
    relatedDocuments: body.relatedDocuments || null,
    driveLink: body.driveLink || null,
    websiteLink: body.websiteLink || null,
    localFilePath: body.localFilePath || null,
    calendarEventId: null,
    notes: body.notes || null,
    subtasks: [],
    attachments: [],
    remind: cleanRemind(body.remind) ?? null,
    archived: false,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  if (!project.title) {
    return res.status(400).json({ error: 'title is required' });
  }
  data.projects.push(project);
  writeData(data);
  res.status(201).json(project);
});

app.put('/api/projects/:id', (req, res) => {
  const data = readData();
  const idx = data.projects.findIndex((p) => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });

  const existing = data.projects[idx];
  const body = req.body || {};
  const updated = {
    ...existing,
    ...body,
    id: existing.id,
    subtasks: existing.subtasks,
    attachments: existing.attachments,
    updatedAt: nowIso(),
  };
  if (body.progress !== undefined) {
    updated.progress = clampProgress(body.progress);
  }
  if (body.remind !== undefined) {
    const r = cleanRemind(body.remind); // null = back to the default schedule
    updated.remind = r === undefined ? (existing.remind ?? null) : r;
  }
  // Auto-archive the moment progress reaches 100, unless the request itself
  // set `archived` explicitly. We never auto-*un*archive from a progress
  // edit alone — a project the user archived on purpose (even below 100%)
  // should stay archived until they uncheck it themselves.
  if (body.archived === undefined && updated.progress >= 100) {
    updated.archived = true;
  }
  data.projects[idx] = updated;
  writeData(data);
  res.json(updated);
});

app.delete('/api/projects/:id', (req, res) => {
  const data = readData();
  const idx = data.projects.findIndex((p) => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  const [removed] = data.projects.splice(idx, 1);
  writeData(data);
  const dir = path.join(ATTACH_DIR, removed.id);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  res.json(removed);
});

// ---- Subtasks ----

app.post('/api/projects/:id/subtasks', (req, res) => {
  const data = readData();
  const project = data.projects.find((p) => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'not found' });
  const title = (req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'title is required' });
  const subtask = {
    id: newId(),
    title,
    done: false,
    createdAt: nowIso(),
    deleted: false,
  };
  project.subtasks.push(subtask);
  project.updatedAt = nowIso();
  writeData(data);
  res.status(201).json(subtask);
});

app.put('/api/projects/:id/subtasks/:subId', (req, res) => {
  const data = readData();
  const project = data.projects.find((p) => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'not found' });
  const subtask = project.subtasks.find((s) => s.id === req.params.subId);
  if (!subtask) return res.status(404).json({ error: 'subtask not found' });
  if (req.body.title !== undefined) subtask.title = req.body.title;
  if (req.body.done !== undefined) subtask.done = !!req.body.done;
  project.updatedAt = nowIso();
  writeData(data);
  res.json(subtask);
});

app.delete('/api/projects/:id/subtasks/:subId', (req, res) => {
  const data = readData();
  const project = data.projects.find((p) => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'not found' });
  const idx = project.subtasks.findIndex((s) => s.id === req.params.subId);
  if (idx === -1) return res.status(404).json({ error: 'subtask not found' });
  project.subtasks.splice(idx, 1);
  project.updatedAt = nowIso();
  writeData(data);
  res.json({ ok: true });
});

// ---- Attachments ----
// Note: browsers never expose a dropped/selected file's original filesystem
// path (security restriction), so this always stores a COPY under
// data/attachments/<projectId>/. It's for "keep a copy inside the app", not
// a link to the original file — that's what `localFilePath` is for.

app.post('/api/projects/:id/attachments', (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, (req, res) => {
  const data = readData();
  const project = data.projects.find((p) => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'not found' });
  if (!req.file) return res.status(400).json({ error: 'no file' });
  const record = {
    id: newId(),
    // multer/busboy decode multipart filename headers as latin1 by default
    // regardless of the actual UTF-8 bytes sent — re-decode or non-ASCII
    // names (Chinese, etc.) come out as mojibake.
    originalName: Buffer.from(req.file.originalname, 'latin1').toString('utf8'),
    storedName: req.file.filename,
    size: req.file.size,
    uploadedAt: nowIso(),
  };
  project.attachments = project.attachments || [];
  project.attachments.push(record);
  project.updatedAt = nowIso();
  writeData(data);
  res.status(201).json(record);
});

app.delete('/api/projects/:id/attachments/:attId', (req, res) => {
  const data = readData();
  const project = data.projects.find((p) => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'not found' });
  const idx = (project.attachments || []).findIndex((a) => a.id === req.params.attId);
  if (idx === -1) return res.status(404).json({ error: 'attachment not found' });
  const [removed] = project.attachments.splice(idx, 1);
  const filePath = path.join(ATTACH_DIR, project.id, removed.storedName);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  project.updatedAt = nowIso();
  writeData(data);
  res.json({ ok: true });
});

// ---- Routines (recurring tasks; separate from projects) ----

app.get('/api/routines', (req, res) => {
  res.json({ routines: readData().routines });
});

app.post('/api/routines', (req, res) => {
  const data = readData();
  const body = req.body || {};
  const rule = routines.cleanRule(body.rule);
  const title = (body.title || '').trim();
  if (!title) return res.status(400).json({ error: '請輸入名稱' });
  if (!rule) return res.status(400).json({ error: '請選擇重複的星期或日期' });
  const routine = {
    id: newId(),
    title,
    rule,
    startDate: routines.validDate(body.startDate) || routines.isoOf(new Date()),
    endDate: routines.validDate(body.endDate),
    remind: routines.cleanRemind(body.remind),
    log: {},
    archived: false,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  data.routines.push(routine);
  writeData(data);
  res.status(201).json(routine);
});

app.put('/api/routines/:id', (req, res) => {
  const data = readData();
  const r = data.routines.find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });
  const body = req.body || {};
  if (body.title !== undefined) {
    const t = String(body.title).trim();
    if (!t) return res.status(400).json({ error: '請輸入名稱' });
    r.title = t;
  }
  if (body.rule !== undefined) {
    const rule = routines.cleanRule(body.rule);
    if (!rule) return res.status(400).json({ error: '請選擇重複的星期或日期' });
    r.rule = rule;
  }
  if (body.startDate !== undefined) r.startDate = routines.validDate(body.startDate) || r.startDate;
  if (body.endDate !== undefined) r.endDate = routines.validDate(body.endDate);
  if (body.remind !== undefined) r.remind = routines.cleanRemind(body.remind);
  if (body.archived !== undefined) r.archived = !!body.archived;
  r.updatedAt = nowIso();
  writeData(data);
  res.json(r);
});

app.delete('/api/routines/:id', (req, res) => {
  const data = readData();
  const idx = data.routines.findIndex((x) => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  const [removed] = data.routines.splice(idx, 1);
  writeData(data);
  res.json(removed);
});

// check-in: { date: 'YYYY-MM-DD', done: bool }
app.post('/api/routines/:id/log', (req, res) => {
  const data = readData();
  const r = data.routines.find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });
  const date = routines.validDate((req.body || {}).date);
  if (!date) return res.status(400).json({ error: 'bad date' });
  r.log = r.log || {};
  if (req.body.done) r.log[date] = true; else delete r.log[date];
  r.updatedAt = nowIso();
  writeData(data);
  res.json(r);
});

// ---- Backups API ----

app.get('/api/backups', (req, res) => {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const list = fs.readdirSync(BACKUP_DIR)
    .filter((f) => /^(auto|manual|before-restore)-.+\.json$/.test(f))
    .map((name) => {
      const full = path.join(BACKUP_DIR, name);
      const st = fs.statSync(full);
      let projects = null, routines = null;
      try {
        const d = JSON.parse(fs.readFileSync(full, 'utf-8'));
        projects = (d.projects || []).length;
        routines = (d.routines || []).length;
      } catch {}
      return { name, kind: name.split('-')[0] === 'before' ? 'before-restore' : name.split('-')[0], savedAt: st.mtime.toISOString(), size: st.size, projects, routines };
    })
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  res.json({ dir: BACKUP_DIR, backups: list });
});

app.post('/api/backups', (req, res) => {
  try { res.status(201).json({ name: manualBackup('manual') }); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/backups/:name/restore', (req, res) => {
  const name = path.basename(req.params.name); // no path tricks
  const full = path.join(BACKUP_DIR, name);
  if (!/\.json$/.test(name) || !fs.existsSync(full)) return res.status(404).json({ error: '找不到這份備份' });
  let data;
  try { data = JSON.parse(fs.readFileSync(full, 'utf-8')); } catch { return res.status(400).json({ error: '備份檔損壞，無法讀取' }); }
  if (!data || !Array.isArray(data.projects)) return res.status(400).json({ error: '這不是有效的備份檔' });
  if (!Array.isArray(data.routines)) data.routines = [];
  const safety = manualBackup('before-restore'); // current state, in case this restore was a mistake
  writeData(data); // hooks re-sync reminders and Google Calendar to the restored data
  res.json({ ok: true, safety, projects: data.projects.length, routines: data.routines.length });
});

// ---- Categories: rename / delete ----
// Categories aren't stored on their own — they're whatever the projects use —
// so renaming or deleting one means moving its projects.

app.post('/api/categories/rename', (req, res) => {
  const from = String((req.body || {}).from || '').trim();
  const to = String((req.body || {}).to || '').trim();
  if (!from || !to) return res.status(400).json({ error: '請輸入分類名稱' });
  const data = readData();
  let moved = 0;
  data.projects.forEach((p) => { if (p.category === from) { p.category = to; p.updatedAt = nowIso(); moved++; } });
  if (moved) writeData(data);
  res.json({ moved });
});

// delete = move its projects to another category (default Others)
app.post('/api/categories/delete', (req, res) => {
  const name = String((req.body || {}).name || '').trim();
  const moveTo = String((req.body || {}).moveTo || 'Others').trim() || 'Others';
  if (!name) return res.status(400).json({ error: '缺少分類名稱' });
  if (name === moveTo) return res.status(400).json({ error: '不能移到同一個分類' });
  const data = readData();
  let moved = 0;
  data.projects.forEach((p) => { if (p.category === name) { p.category = moveTo; p.updatedAt = nowIso(); moved++; } });
  if (moved) writeData(data);
  res.json({ moved });
});

// ---- Categories (derived, for autocomplete) ----

app.get('/api/categories', (req, res) => {
  const data = readData();
  const set = new Set(data.projects.map((p) => p.category).filter(Boolean));
  res.json({ categories: Array.from(set).sort() });
});

function clampProgress(value) {
  const n = Number(value);
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

autoBackup(); // startup: today's copy exists even if nothing gets edited

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`Project Manager running at http://127.0.0.1:${PORT}`);
});

// Exported so electron-main.js can wait for the 'listening' event instead
// of guessing with an arbitrary timer before pointing the window at it.
module.exports = server;
server.readData = readData;
server.writeData = writeData;
server.onWrite = (fn) => writeHooks.push(fn);
