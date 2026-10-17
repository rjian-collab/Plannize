// Deadline reminders as one-shot Windows scheduled tasks.
//
// Nothing stays resident: each reminder is its own task under the
// "\ProjMgr\" folder of Task Scheduler (current user, no admin rights).
// When it fires, Task Scheduler starts the app in notify mode
// (electron-main.js --notify=<task>), which shows one toast, deletes its own
// task and exits. StartWhenAvailable makes a reminder missed while the PC
// was off or asleep fire as soon as it's back.
//
// sync() is declarative: it computes the set of tasks that *should* exist
// from projects.json and diffs it against what Task Scheduler actually has,
// so edits, completions, archiving and deletions all converge without
// tracking individual changes. Task names encode project, due time and
// offset, so a changed deadline simply becomes a different name.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const routines = require('./routines');

const FOLDER = 'ProjMgr';
const DEFAULT_REMIND = { days: [3, 1, 0], time: '09:00', email: true };

// null/undefined -> the default schedule; { days: [] } -> reminders off
function remindOf(project) {
  const r = project.remind;
  if (!r || !Array.isArray(r.days)) return DEFAULT_REMIND;
  return { days: r.days, time: /^\d{2}:\d{2}$/.test(r.time || '') ? r.time : DEFAULT_REMIND.time, email: r.email !== false };
}

const pad = (n) => String(n).padStart(2, '0');

// Local due times for a project's reminders (past ones included).
function dueTimes(project) {
  if (!project.deadline || project.archived || project.progress >= 100) return [];
  const { days, time } = remindOf(project);
  const [hh, mm] = time.split(':').map(Number);
  const [y, m, d] = project.deadline.split('-').map(Number);
  return [...new Set(days)].map((offset) => ({
    offset,
    at: new Date(y, m - 1, d - offset, hh, mm, 0),
  }));
}

function taskName(projectId, at, offset) {
  const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}${pad(at.getHours())}${pad(at.getMinutes())}`;
  return `R_${projectId}_${stamp}_${offset}`;
}

const stampOf = (at) => `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}${pad(at.getHours())}${pad(at.getMinutes())}`;
const fromStamp = (s) => new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12));

// "R_<uuid>_<yyyymmddHHMM>_<offset>"  project deadline reminder
// "RT_<uuid>_<yyyymmddHHMM>"          routine reminder
function parseTaskName(name) {
  let m = /^R_([0-9a-f-]+)_(\d{12})_(\d+)$/i.exec(name || '');
  if (m) return { kind: 'project', projectId: m[1], at: fromStamp(m[2]), offset: Number(m[3]) };
  m = /^RT_([0-9a-f-]+)_(\d{12})$/i.exec(name || '');
  if (m) return { kind: 'routine', routineId: m[1], at: fromStamp(m[2]) };
  return null;
}

// Routine reminders are scheduled a rolling 14 days ahead; every sync (app
// start, any edit, and each reminder as it fires) tops the window back up.
const ROUTINE_WINDOW_DAYS = 14;

function desiredTasks(projects, routineList = []) {
  const now = Date.now();
  const map = new Map();
  for (const p of projects) {
    for (const { offset, at } of dueTimes(p)) {
      if (at.getTime() <= now) continue; // already past: never schedule backwards
      map.set(taskName(p.id, at, offset), at);
    }
  }
  for (const r of routineList) {
    for (const { at } of routines.upcomingReminders(r, ROUTINE_WINDOW_DAYS)) {
      map.set(`RT_${r.id}_${stampOf(at)}`, at);
    }
  }
  return map;
}

function run(args) {
  return new Promise((resolve) => {
    execFile('schtasks', args, { windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

async function existingTasks() {
  const res = await run(['/query', '/tn', `\\${FOLDER}\\`, '/fo', 'csv', '/nh']);
  if (!res.ok) return new Set(); // folder doesn't exist yet
  const names = new Set();
  for (const line of res.stdout.split(/\r?\n/)) {
    const m = /^"\\?(?:ProjMgr\\)?(RT?_[^"]+)"/i.exec(line.trim());
    if (m) names.add(m[1]);
  }
  return names;
}

const xmlEsc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

function taskXml(at, command, args) {
  const start = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}:00`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Plannize 截止提醒</Description></RegistrationInfo>
  <Triggers><TimeTrigger><StartBoundary>${start}</StartBoundary><Enabled>true</Enabled></TimeTrigger></Triggers>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT5M</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author"><Exec><Command>${xmlEsc(command)}</Command><Arguments>${xmlEsc(args)}</Arguments></Exec></Actions>
</Task>`;
}

async function createTask(name, at, launcher) {
  const file = path.join(os.tmpdir(), `projmgr-${process.pid}-${Date.now()}.xml`);
  // Task Scheduler wants UTF-16 XML (with BOM) to read non-ASCII paths correctly
  fs.writeFileSync(file, '﻿' + taskXml(at, launcher.command, `${launcher.args} --notify=${name}`), 'utf16le');
  const res = await run(['/create', '/tn', `\\${FOLDER}\\${name}`, '/xml', file, '/f']);
  fs.rmSync(file, { force: true });
  if (!res.ok) console.error('reminder: create failed', name, res.stderr.trim());
  return res.ok;
}

function deleteTask(name) {
  return run(['/delete', '/tn', `\\${FOLDER}\\${name}`, '/f']);
}

// ---- debounced, non-overlapping sync ----

let launcher = null;   // { command, args } that starts the app in notify mode
let readProjects = null;
let readRoutines = () => [];
let timer = null, running = false, again = false;

function configure(opts) {
  launcher = opts.launcher;
  readProjects = opts.readProjects;
  if (opts.readRoutines) readRoutines = opts.readRoutines;
}

async function syncNow() {
  if (process.platform !== 'win32' || !launcher || !readProjects) return;
  if (running) { again = true; return; }
  running = true;
  try {
    const want = desiredTasks(readProjects(), readRoutines());
    const have = await existingTasks();
    for (const name of have) if (!want.has(name)) await deleteTask(name);
    for (const [name, at] of want) if (!have.has(name)) await createTask(name, at, launcher);
  } catch (e) {
    console.error('reminder sync failed:', e);
  } finally {
    running = false;
    if (again) { again = false; scheduleSync(); }
  }
}

// Detail-panel edits save field by field; wait for them to settle.
function scheduleSync(delay = 1500) {
  clearTimeout(timer);
  timer = setTimeout(() => { timer = null; syncNow(); }, delay);
}

// On quit: run a pending (debounced) sync right away and wait for it.
async function flush() {
  if (timer) { clearTimeout(timer); timer = null; await syncNow(); }
  while (running) await new Promise((r) => setTimeout(r, 50));
}

module.exports = { configure, scheduleSync, syncNow, flush, remindOf, dueTimes, parseTaskName, deleteTask, existingTasks, DEFAULT_REMIND };
