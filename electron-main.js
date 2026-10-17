const { app, BrowserWindow, ipcMain, shell, Notification, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const reminders = require('./reminders');
const google = require('./google');
const calendar = require('./calendar');
const routines = require('./routines');

const SERVER_URL = 'http://127.0.0.1:47821';
// Toasts are attributed to this ID; the Start Menu shortcut below carries it
// so Windows shows "Plannize" (not "electron.app.Electron") on notifications.
const AUMID = 'Plannize.App';
const APP_DIR = __dirname;
const { DATA_DIR } = require('./paths');
const DATA_PATH = path.join(DATA_DIR, 'projects.json');
// Installed build: the exe already is the app, so don't pass the app folder.
const LAUNCH_ARGS = app.isPackaged ? '' : `"${APP_DIR}"`;
const LAUNCH_CWD = app.isPackaged ? path.dirname(process.execPath) : APP_DIR;

app.setAppUserModelId(AUMID);

// The profile folder (Local State holds the key that encrypts the Google
// token) was created under the app's old package name. Renaming the app must
// not move it, or the saved Google link would silently stop decrypting.
// Installed builds start fresh under their own productName.
if (!app.isPackaged) app.setPath('userData', path.join(app.getPath('appData'), 'project-manager'));

const notifyArg = process.argv.find((a) => a.startsWith('--notify='));
if (notifyArg) runNotifyMode(notifyArg.slice('--notify='.length));
else runApp();

// ---------- Reminder toast (launched by Task Scheduler) ----------

function daysUntil(iso) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const [y, m, d] = iso.split('-').map(Number);
  return Math.round((new Date(y, m - 1, d) - today) / 86400000);
}

function reminderBody(p) {
  const n = daysUntil(p.deadline);
  const [, m, d] = p.deadline.split('-').map(Number);
  const when = n > 1 ? `還有 ${n} 天截止（${m}/${d}）` : n === 1 ? `明天截止（${m}/${d}）` : n === 0 ? '今天截止' : `已逾期 ${-n} 天`;
  const open = (p.subtasks || []).filter((s) => !s.done).length;
  return `${when} · 進度 ${p.progress}%` + (open ? ` · 還有 ${open} 個子工作項` : '');
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function reminderEmail(p) {
  const n = daysUntil(p.deadline);
  const [y, m, d] = p.deadline.split('-').map(Number);
  const when = n > 1 ? `還有 ${n} 天` : n === 1 ? '明天截止' : n === 0 ? '今天截止' : `已逾期 ${-n} 天`;
  const color = n < 0 ? '#f43f5e' : n <= 1 ? '#f59e0b' : '#6366f1';
  const open = (p.subtasks || []).filter((s) => !s.done);
  const pri = { High: '高', Medium: '中', Low: '低' }[p.priority] || p.priority;
  return {
    subject: `📌 截止提醒：${p.title}（${when}）`,
    html: `<div style="font-family:system-ui,'Microsoft JhengHei',sans-serif;max-width:520px;margin:auto;color:#1e2130">
  <div style="border-radius:16px;padding:22px 24px;background:#f5f4ff;border:1px solid #e3e1fb">
    <div style="font-size:12px;color:#6b7086;font-weight:700;letter-spacing:.05em">Plannize · 截止提醒</div>
    <h2 style="margin:6px 0 14px;font-size:20px">${esc(p.title)}</h2>
    <div style="display:inline-block;padding:5px 12px;border-radius:999px;background:${color};color:#fff;font-weight:700;font-size:13px">${when}</div>
    <table style="margin-top:16px;font-size:14px;border-collapse:collapse">
      <tr><td style="color:#6b7086;padding:3px 14px 3px 0">截止日</td><td><b>${y}/${m}/${d}</b></td></tr>
      <tr><td style="color:#6b7086;padding:3px 14px 3px 0">分類</td><td>${esc(p.category)}</td></tr>
      <tr><td style="color:#6b7086;padding:3px 14px 3px 0">優先級</td><td>${esc(pri)}</td></tr>
      <tr><td style="color:#6b7086;padding:3px 14px 3px 0">進度</td><td><b>${p.progress}%</b></td></tr>
    </table>
    <div style="margin-top:8px;height:8px;border-radius:999px;background:#e3e1fb;overflow:hidden">
      <div style="height:8px;width:${p.progress}%;background:linear-gradient(90deg,#6366f1,#a855f7)"></div>
    </div>
    ${open.length ? `<div style="margin-top:18px;font-size:13px;font-weight:700;color:#6b7086">還沒完成的子工作項</div>
    <ul style="margin:6px 0 0;padding-left:20px;font-size:14px;line-height:1.7">${open.map((s) => `<li>${esc(s.title)}</li>`).join('')}</ul>` : ''}
    ${p.notes ? `<div style="margin-top:16px;font-size:13px;color:#6b7086;white-space:pre-wrap">${esc(p.notes)}</div>` : ''}
  </div>
</div>`,
  };
}

// IPC handler wrapper: { ok: true, ...result } or { ok: false, error }
function wrapLater(fn) {
  return async (...args) => {
    try { return { ok: true, ...(await fn(...args)) }; } catch (e) { return { ok: false, error: e.message }; }
  };
}

function openMainApp() {
  // a normal launch; if the app is already open, its single-instance lock
  // makes this one exit and the existing window comes to the front instead
  spawn(process.execPath, app.isPackaged ? [] : [APP_DIR], { detached: true, stdio: 'ignore' }).unref();
}

function routineEmail(r) {
  const n = routines.streak(r);
  return {
    subject: `🔁 例行提醒：${r.title}`,
    html: `<div style="font-family:system-ui,'Microsoft JhengHei',sans-serif;max-width:520px;margin:auto;color:#1e2130">
  <div style="border-radius:16px;padding:22px 24px;background:#f5f4ff;border:1px solid #e3e1fb">
    <div style="font-size:12px;color:#6b7086;font-weight:700;letter-spacing:.05em">Plannize · 例行任務</div>
    <h2 style="margin:6px 0 10px;font-size:20px">${esc(r.title)}</h2>
    <div style="font-size:14px">今天記得完成，完成後在 App 裡打卡。</div>
    ${n ? `<div style="margin-top:12px;display:inline-block;padding:5px 12px;border-radius:999px;background:#f59e0b;color:#fff;font-weight:700;font-size:13px">🔥 已連續完成 ${n} 次</div>` : ''}
  </div>
</div>`,
  };
}

function runNotifyMode(taskName) {
  app.whenReady().then(async () => {
    const info = reminders.parseTaskName(taskName);
    let data = { projects: [], routines: [] };
    try { data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')); } catch {}
    data.projects = data.projects || [];
    data.routines = data.routines || [];
    // One-shot: this task has done its job whatever happens next.
    await reminders.deleteTask(taskName);
    // Keep the rolling routine window topped up even when the app itself
    // hasn't been opened for a while.
    reminders.configure({
      launcher: { command: process.execPath, args: LAUNCH_ARGS },
      readProjects: () => data.projects,
      readRoutines: () => data.routines,
    });
    await reminders.syncNow();
    if (info && info.kind === 'routine') { await notifyRoutine(info, data); return; }
    const project = data.projects.find((p) => p.id === info?.projectId);
    // Only remind if it still applies: not deleted/completed/archived, and the
    // deadline/reminder settings haven't changed since it was scheduled.
    const current = project && info && reminders.dueTimes(project)
      .some((t) => t.offset === info.offset && t.at.getTime() === info.at.getTime());
    if (!current) { app.quit(); return; }

    // Email (if the project wants it and a Google account is linked) runs
    // alongside the toast; the process only exits once the mail is out.
    let mailDone = Promise.resolve();
    if (reminders.remindOf(project).email) {
      google.configure({ safeStorage, openExternal: () => {} });
      const st = google.status();
      if (st.connected && st.canMail) {
        mailDone = google.sendMail(reminderEmail(project)).catch((e) => console.error('reminder mail failed:', e.message));
      }
    }
    const quit = () => mailDone.finally(() => app.quit());
    if (!Notification.isSupported()) { quit(); return; }

    const toast = new Notification({ title: `📌 截止提醒：${project.title}`, body: reminderBody(project), timeoutType: 'default' });
    toast.on('click', () => { openMainApp(); quit(); });
    toast.on('close', quit);
    toast.show();
    setTimeout(quit, 60000); // stay around briefly to handle a click, then free everything
  });
  app.on('window-all-closed', () => {}); // no windows in this mode; don't let that end it early
}

async function notifyRoutine(info, data) {
  const r = data.routines.find((x) => x.id === info.routineId);
  const iso = routines.isoOf(info.at);
  const rem = r ? routines.remindOf(r) : null;
  // still applies: routine exists and wasn't changed, falls on that day, not checked in yet
  const current = r && rem.enabled && routines.occursOn(r, iso) && !(r.log && r.log[iso])
    && rem.time === `${String(info.at.getHours()).padStart(2, '0')}:${String(info.at.getMinutes()).padStart(2, '0')}`;
  if (!current) { app.quit(); return; }

  let mailDone = Promise.resolve();
  if (rem.email) {
    google.configure({ safeStorage, openExternal: () => {} });
    const st = google.status();
    if (st.connected && st.canMail) mailDone = google.sendMail(routineEmail(r)).catch((e) => console.error('routine mail failed:', e.message));
  }
  const quit = () => mailDone.finally(() => app.quit());
  if (!Notification.isSupported()) { quit(); return; }
  const n = routines.streak(r);
  const toast = new Notification({ title: `🔁 例行提醒：${r.title}`, body: n ? `今天記得完成 · 已連續 ${n} 次 🔥` : '今天記得完成，完成後在 App 裡打卡', timeoutType: 'default' });
  toast.on('click', () => { openMainApp(); quit(); });
  toast.on('close', quit);
  toast.show();
  setTimeout(quit, 60000);
}

// ---------- Normal app ----------

function ensureStartMenuShortcut() {
  if (process.platform !== 'win32') return;
  const dir = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const lnk = path.join(dir, 'Plannize.lnk');
  // renamed twice (我的專案 -> Planglass -> Plannize): drop the old shortcuts, they carry old app ids
  for (const old of ['我的專案.lnk', 'Planglass.lnk']) { try { fs.rmSync(path.join(dir, old), { force: true }); } catch {} }
  const opts = { target: process.execPath, args: LAUNCH_ARGS, cwd: LAUNCH_CWD, appUserModelId: AUMID, description: 'Plannize 高效規劃' };
  try { shell.writeShortcutLink(lnk, fs.existsSync(lnk) ? 'update' : 'create', opts); } catch (e) { console.error('shortcut:', e); }
}

function runApp() {
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }

  // Runs the existing Express server (data/API layer) in the same process —
  // server.js calls app.listen() at module load and exports the http.Server
  // instance so we can wait for it to actually be accepting connections.
  const httpServer = require('./server.js');
  let win = null;

  function createWindow() {
    win = new BrowserWindow({
      width: 1320,
      height: 880,
      minWidth: 720,
      minHeight: 560,
      title: 'Plannize 高效規劃',
      autoHideMenuBar: true, // no File/Edit/View menu bar — keeps the chrome minimal
      // Real OS-level frosted glass: the window blurs whatever is behind it
      // (desktop, other windows) in real time. A clear background color is
      // enough for the acrylic material to show through our translucent CSS;
      // `transparent: true` is NOT used — on Windows it drops the native
      // frame (no rounded corners/shadow) and hid the caption buttons.
      backgroundColor: '#00000000',
      backgroundMaterial: process.platform === 'win32' ? 'acrylic' : undefined,
      // Custom title bar: our header is the drag area, and Windows draws its
      // own minimize / maximize (with Snap Layouts) / close on top-right.
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#00000000', symbolColor: '#1e2130', height: 40 },
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    // Drive / website links open in the user's default browser (where they're
    // signed in); the app's own pages (attachments) still open in-app.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith(SERVER_URL)) return { action: 'allow' };
      if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    win.loadURL(SERVER_URL);
  }

  // A second launch (e.g. clicking a reminder toast) focuses this window.
  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) { createWindow(); return; }
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  ipcMain.handle('open-path', (event, targetPath) => shell.openPath(targetPath));
  // caption-button glyph color follows the app theme
  ipcMain.on('titlebar-theme', (event, dark) => {
    if (win && !win.isDestroyed()) win.setTitleBarOverlay({ color: '#00000000', symbolColor: dark ? '#eef0ff' : '#1e2130', height: 40 });
  });
  // preview of a project's reminder email, sent now
  ipcMain.handle('google-test-reminder-mail', wrapLater(async (event, projectId) => {
    const p = httpServer.readData().projects.find((x) => x.id === projectId);
    if (!p) throw new Error('找不到這個專案');
    if (!p.deadline) throw new Error('這個專案還沒有截止日');
    return { to: await google.sendMail(reminderEmail(p)) };
  }));
  ipcMain.handle('test-notify', (event, title) => {
    if (!Notification.isSupported()) return false;
    new Notification({ title: `📌 截止提醒：${title || '範例專案'}`, body: '這是測試通知 · 提醒到時會長這樣' }).show();
    return true;
  });

  // Google account (settings popover in the UI)
  google.configure({ safeStorage, openExternal: (url) => shell.openExternal(url) });
  const wrap = (fn) => async (...args) => {
    try { return { ok: true, ...(await fn(...args)) }; } catch (e) { return { ok: false, error: e.message }; }
  };
  ipcMain.handle('google-status', wrap(async () => ({ ...google.status(), calendar: calendar.getStatus() })));
  ipcMain.handle('drive-list', wrap(async (event, opts) => google.driveList(opts || {})));
  ipcMain.handle('calendar-sync', wrap(async () => { await calendar.syncNow(); return { calendar: calendar.getStatus() }; }));

  // Google Calendar two-way sync
  calendar.configure({
    store: httpServer,
    // changes pulled from the calendar: tell the page to reload its data
    onExternalChange: () => { if (win && !win.isDestroyed()) win.webContents.send('data-changed'); },
  });
  httpServer.onWrite(() => calendar.onLocalWrite());
  ipcMain.handle('google-connect', wrap(async () => {
    const r = await google.connect();
    calendar.syncNow(); // first sync right away (creates the "Plannize" calendar)
    if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.focus(); } // back from the browser
    return r;
  }));
  ipcMain.handle('google-disconnect', wrap(async () => { await google.disconnect(); calendar.reset(); return {}; }));
  ipcMain.handle('google-test-mail', wrap(async () => ({
    to: await google.sendMail({
      subject: '📌 Plannize：測試信',
      html: '<div style="font-family:system-ui,Microsoft JhengHei;font-size:15px"><h2>Gmail 連結成功 ✅</h2><p>之後的截止提醒會寄到這個信箱。</p></div>',
    }),
  })));

  reminders.configure({
    launcher: { command: process.execPath, args: LAUNCH_ARGS },
    readProjects: () => httpServer.readData().projects,
    readRoutines: () => httpServer.readData().routines,
  });

  app.whenReady().then(() => {
    ensureStartMenuShortcut();
    reminders.syncNow(); // catch up with anything changed while the app was closed
    calendar.start();    // sync now, then every 5 minutes while the app is open
    const start = () => {
      createWindow();
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
      });
    };
    if (httpServer.listening) start();
    else httpServer.once('listening', start);
  }).catch((err) => console.error('Electron failed to start:', err));

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // finish registering reminders from the last edits before exiting
  let flushed = false;
  app.on('before-quit', (e) => {
    if (flushed) return;
    e.preventDefault();
    flushed = true;
    reminders.flush().finally(() => app.quit());
  });

  // Surfaces renderer/GPU crashes in the console instead of a silently dead window.
  app.on('render-process-gone', (e, wc, details) => console.error('Renderer process gone:', details));
  app.on('child-process-gone', (e, details) => console.error('Child process gone:', details));
}
