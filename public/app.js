const API = '/api';

const state = {
  projects: [],
  routines: [],
  categories: [],
  filters: { priorities: new Set(), categories: new Set(), showArchived: false, search: '' },
  sortKey: 'deadline',
  sortDir: 'asc',
  view: 'list',
  calendarMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  openProjectId: null,
  isNewPanelOpen: false,
  layout: (() => { try { return localStorage.getItem('pm-layout') || 'rows'; } catch { return 'rows'; } })(), // list view: 'rows' | 'cards'
  expanded: new Set(), // row ids whose subtasks are shown
};

const SORT_OPTIONS = [
  { key: 'deadline', label: '截止日' },
  { key: 'priority', label: '優先級' },
  { key: 'progress', label: '完成度' },
  { key: 'category', label: '分類' },
  { key: 'title', label: '名稱' },
  { key: 'createdAt', label: '建立時間' },
];

const PRIORITY_ORDER = { High: 0, Medium: 1, Low: 2 };
const CATEGORY_PALETTE = ['#6366f1', '#ec4899', '#14b8a6', '#f59e0b', '#8b5cf6', '#22c55e', '#0ea5e9', '#f43f5e'];

// ---------- API ----------

async function apiGet(path) {
  const res = await fetch(API + path);
  if (!res.ok) throw new Error('GET ' + path + ' failed');
  return res.json();
}
async function apiSend(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(method + ' ' + path + ' failed');
  return res.json();
}

// ---------- Helpers ----------

function categoryColor(name) {
  let hash = 0;
  for (let i = 0; i < (name || '').length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return CATEGORY_PALETTE[hash % CATEGORY_PALETTE.length];
}

function fmtDate(iso) {
  if (!iso) return null;
  const d = new Date(iso + 'T00:00:00');
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function daysUntil(iso) {
  if (!iso) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(iso + 'T00:00:00');
  return Math.round((target - today) / 86400000);
}

function deadlineBadge(project) {
  if (!project.deadline) return { text: '無截止日', cls: '' };
  const d = daysUntil(project.deadline);
  const dateStr = fmtDate(project.deadline);
  if (project.progress >= 100) return { text: dateStr, cls: '' };
  if (d < 0) return { text: `逾期 ${Math.abs(d)} 天`, cls: 'overdue' };
  if (d === 0) return { text: '今天截止', cls: 'soon' };
  if (d <= 3) return { text: `還有 ${d} 天`, cls: 'soon' };
  return { text: `${dateStr}（還有 ${d} 天）`, cls: '' };
}

// Deadline reminders — same rules as reminders.js on the server:
// remind null = default schedule, { days: [] } = off.
const DEFAULT_REMIND = { days: [3, 1, 0], time: '09:00', email: true };
const REMIND_OPTIONS = [{ d: 7, label: '前 7 天' }, { d: 3, label: '前 3 天' }, { d: 1, label: '前 1 天' }, { d: 0, label: '當天' }];

function remindOf(p) {
  const r = p.remind;
  if (!r || !Array.isArray(r.days)) return DEFAULT_REMIND;
  return { days: r.days, time: /^\d{2}:\d{2}$/.test(r.time || '') ? r.time : DEFAULT_REMIND.time, email: r.email !== false };
}

// Next upcoming reminder as a Date, or null.
function nextReminder(p) {
  if (!p.deadline || p.archived || p.progress >= 100) return null;
  const { days, time } = remindOf(p);
  const [hh, mm] = time.split(':').map(Number);
  const [y, m, d] = p.deadline.split('-').map(Number);
  const now = Date.now();
  const future = days.map((off) => new Date(y, m - 1, d - off, hh, mm)).filter((t) => t.getTime() > now);
  future.sort((a, b) => a - b);
  return future[0] || null;
}

function fmtReminder(t) {
  return `${t.getMonth() + 1}/${t.getDate()} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
}

function toast(msg) {
  const stack = document.getElementById('toastStack');
  const el = document.createElement('div');
  el.className = 'toast glass';
  el.textContent = msg;
  stack.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Data loading ----------

async function loadAll() {
  const [projData, catData, rtData] = await Promise.all([
    apiGet('/projects'), apiGet('/categories'),
    apiGet('/routines').catch(() => ({ routines: [] })), // older server without routines: still load projects
  ]);
  state.projects = projData.projects;
  state.routines = rtData.routines;
  state.categories = catData.categories;
  renderFilterChips();
  renderCurrentView();
}

function visibleProjects() {
  let list = state.projects.filter((p) => (state.filters.showArchived ? true : !p.archived));
  if (state.filters.priorities.size) list = list.filter((p) => state.filters.priorities.has(p.priority));
  if (state.filters.categories.size) list = list.filter((p) => state.filters.categories.has(p.category));
  if (state.filters.search) {
    const q = state.filters.search.toLowerCase();
    list = list.filter((p) => p.title.toLowerCase().includes(q));
  }
  const dir = state.sortDir === 'asc' ? 1 : -1;
  list.sort((a, b) => {
    const key = state.sortKey;
    let av, bv;
    if (key === 'priority') { av = PRIORITY_ORDER[a.priority] ?? 9; bv = PRIORITY_ORDER[b.priority] ?? 9; }
    else if (key === 'deadline') { av = a.deadline || '9999'; bv = b.deadline || '9999'; }
    else if (key === 'progress') { av = a.progress; bv = b.progress; }
    else { av = (a[key] || '').toString().toLowerCase(); bv = (b[key] || '').toString().toLowerCase(); }
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  });
  return list;
}

// ---------- Filter chips ----------

function renderFilterChips() {
  // Chips are rebuilt only here (init + when the category list itself
  // changes), NOT on every click — toggling just flips classes on the
  // existing element (see toggleChip) so the pop animation has something
  // stable to animate instead of a freshly-replaced node.
  const prBox = document.getElementById('priorityChips');
  prBox.innerHTML = ['High', 'Medium', 'Low'].map((p) => {
    const active = state.filters.priorities.has(p) ? 'active' : '';
    const label = { High: '高', Medium: '中', Low: '低' }[p];
    return `<button class="chip ${active}" data-priority="${p}">${label}優先</button>`;
  }).join('');
  prBox.querySelectorAll('.chip').forEach((btn) => {
    btn.onclick = () => toggleChip(btn, state.filters.priorities, btn.dataset.priority);
  });

  const catBox = document.getElementById('categoryChips');
  catBox.innerHTML = state.categories.map((c) => {
    const active = state.filters.categories.has(c) ? 'active' : '';
    return `<button class="chip ${active}" data-cat="${escapeHtml(c)}">${escapeHtml(c)}</button>`;
  }).join('');
  catBox.querySelectorAll('.chip').forEach((btn) => {
    btn.onclick = () => toggleChip(btn, state.filters.categories, btn.dataset.cat);
    btn.oncontextmenu = (e) => {
      e.preventDefault();
      const name = btn.dataset.cat;
      openContextMenu(e.clientX, e.clientY, [
        { label: '✏️ 重新命名', onSelect: () => openCategoryAction(btn, name, 'rename') },
        { label: '🗑 刪除分類', danger: true, onSelect: () => openCategoryAction(btn, name, 'delete') },
      ]);
    };
  });
}

function toggleChip(btn, set, value) {
  set.has(value) ? set.delete(value) : set.add(value);
  btn.classList.toggle('active');
  btn.classList.remove('pop');
  void btn.offsetWidth; // reflow so re-adding 'pop' restarts the animation
  btn.classList.add('pop');
  renderCurrentView();
}

// ---------- List view ----------

function renderCurrentView() {
  if (state.holdRender) return; // a completion celebration still needs its card in place
  const listView = document.getElementById('listView');
  listView.className = state.layout === 'rows' ? 'row-table' : 'project-grid';
  listView.style.display = state.view === 'list' ? (state.layout === 'rows' ? 'block' : 'grid') : 'none';
  document.getElementById('layoutSwitch').style.display = state.view === 'list' ? '' : 'none';
  document.getElementById('calendarView').style.display = state.view === 'calendar' ? 'block' : 'none';
  if (state.view === 'list') renderList(); else renderCalendar();
  renderRoutineStrip();
}

// Fades the currently-visible container out, runs `changeFn` (which is
// expected to mutate state and call renderCurrentView()), then fades the
// (possibly different) resulting container back in. Used for view-mode
// switches and the archive toggle — not for every filter/search keystroke,
// which would make typing feel laggy.
function transitionSwitch(changeFn) {
  const activeEl = document.getElementById(state.view === 'list' ? 'listView' : 'calendarView');
  activeEl.classList.add('view-fade', 'fading');
  setTimeout(() => {
    changeFn();
    const newActiveEl = document.getElementById(state.view === 'list' ? 'listView' : 'calendarView');
    newActiveEl.classList.add('view-fade', 'fading');
    void newActiveEl.offsetWidth;
    requestAnimationFrame(() => newActiveEl.classList.remove('fading'));
  }, 190);
}

function renderList() {
  const list = visibleProjects();
  const container = document.getElementById('listView');
  if (!list.length) {
    container.innerHTML = `<div class="empty-state">目前沒有符合條件的專案</div>`;
    return;
  }
  if (state.layout === 'rows') { renderRows(list, container); return; }
  container.innerHTML = list.map(cardHtml).join('');
  container.querySelectorAll('.project-card').forEach((card) => {
    card.onclick = (e) => openDetail(card.dataset.id, card);
    card.oncontextmenu = (e) => openItemContextMenu(e, card.dataset.id);
  });
}

function openItemContextMenu(e, id) {
  e.preventDefault();
  const project = state.projects.find((x) => x.id === id);
  if (!project) return;
  const willComplete = project.progress < 100;
  openContextMenu(e.clientX, e.clientY, [
    {
      label: willComplete ? '✓ 標示為完成' : '↺ 取消完成標記',
      onSelect: () => toggleCardComplete(project),
    },
    { label: project.archived ? '📤 取消封存' : '🗄 封存', onSelect: () => toggleArchive(project) },
    { label: '✏️ 編輯', onSelect: () => openDetail(id, document.querySelector(`#listView [data-id="${id}"]`)) },
  ]);
}

function toggleCardComplete(project) {
  return setProgress(project, project.progress >= 100 ? 90 : 100);
}

// Saves a new progress value. Crossing into 100% plays the completion
// celebration on the project's card/row while the save runs.
async function setProgress(project, val) {
  const wasDone = project.progress >= 100;
  const save = apiSend('PUT', `/projects/${project.id}`, { progress: val });
  if (val >= 100 && !wasDone) {
    state.holdRender = true;
    try { await celebrateCard(project); } finally { state.holdRender = false; }
  }
  let updated;
  try { updated = await save; } catch { toast('儲存失敗，請稍後再試'); renderCurrentView(); return; }
  const idx = state.projects.findIndex((x) => x.id === project.id);
  state.projects[idx] = updated;
  renderCurrentView();
  if (val >= 100 && !wasDone) toast('已標示為完成');
  else if (wasDone && val < 100) toast('已取消完成標記');
}

async function toggleArchive(project) {
  const archiving = !project.archived;
  const save = apiSend('PUT', `/projects/${project.id}`, { archived: archiving });
  const el = document.querySelector(`#listView [data-id="${project.id}"]`);
  // the item leaves the list (unless archived items are shown): fold it away first
  if (el && archiving && !state.filters.showArchived && !prefersReducedMotion()) {
    el.style.height = el.offsetHeight + 'px';
    void el.offsetWidth;
    el.classList.add('leaving');
    await new Promise((r) => setTimeout(r, 320));
  }
  try {
    const updated = await save;
    const idx = state.projects.findIndex((x) => x.id === project.id);
    state.projects[idx] = updated;
  } catch { toast('儲存失敗，請稍後再試'); }
  renderCurrentView();
  toast(archiving ? '已封存' : '已取消封存');
}

// ---------- Row layout (list view) ----------
// One project per row, so progress, files and status read at a glance and
// can be changed in place. Clicking a row slides its subtasks open.

const ROW_COLUMNS = [
  { key: null, label: '' },
  { key: 'title', label: '專案' },
  { key: 'category', label: '分類', cls: 'c-cat' },
  { key: 'priority', label: '優先', cls: 'c-pri' },
  { key: 'deadline', label: '截止日' },
  { key: 'progress', label: '進度' },
  { key: null, label: '檔案' },
  { key: null, label: '' },
];

function renderRows(list, container) {
  const head = `<div class="row-head">${ROW_COLUMNS.map((c) => {
    if (!c.key) return `<div class="${c.cls || ''}">${c.label}</div>`;
    const on = state.sortKey === c.key;
    return `<div class="sortable ${c.cls || ''} ${on ? 'on' : ''}" data-sort="${c.key}">${c.label}${on ? (state.sortDir === 'asc' ? ' ↑' : ' ↓') : ''}</div>`;
  }).join('')}</div>`;
  container.innerHTML = head + list.map(rowHtml).join('');
  container.querySelectorAll('.row-head .sortable').forEach((el) => {
    el.onclick = () => setSort(el.dataset.sort);
  });
  container.querySelectorAll('.proj-row').forEach(wireRow);
}

function setSort(key) {
  if (key === state.sortKey) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
  else { state.sortKey = key; state.sortDir = 'asc'; }
  document.getElementById('sortTrigger').textContent = `排序：${SORT_OPTIONS.find((o) => o.key === key).label} ▾`;
  renderCurrentView();
}

function rowHtml(p) {
  const badge = deadlineBadge(p);
  const done = p.progress >= 100;
  const subtasks = p.subtasks || [];
  const doneCount = subtasks.filter((s) => s.done).length;
  const open = state.expanded.has(p.id);
  const files = [];
  if (p.driveLink) files.push(`<button class="file-ico" data-act="drive" title="${escapeHtml(p.driveName || 'Google 雲端硬碟')}">📁</button>`);
  if (p.websiteLink) files.push(`<button class="file-ico" data-act="web" title="網站連結">🔗</button>`);
  if (p.localFilePath) files.push(`<button class="file-ico" data-act="local" title="${escapeHtml(p.localFilePath)}">💻</button>`);
  if ((p.attachments || []).length) files.push(`<button class="file-ico" data-act="attach" title="附件">📎<span>${p.attachments.length}</span></button>`);
  const tag = `<span class="tag" style="background:${categoryColor(p.category)}">${escapeHtml(p.category)}</span>`;
  return `
  <div class="proj-row glass ${p.archived ? 'archived' : ''} ${done ? 'done' : ''} ${open ? 'open' : ''}" data-id="${p.id}">
    <div class="row-main">
      <button class="row-check" data-act="complete" title="${done ? '取消完成' : '標示為完成'}">${done ? '✓' : ''}</button>
      <div class="row-title">
        <span class="caret">▸</span>
        <div class="row-title-text">
          <div class="t">${escapeHtml(p.title)}</div>
          <div class="row-meta">${tag}<span class="priority-dot priority-${p.priority}"></span></div>
        </div>
        ${subtasks.length ? `<span class="subtask-count">☑ ${doneCount}/${subtasks.length}</span>` : ''}
      </div>
      <div class="c-cat">${tag}</div>
      <div class="c-pri"><span class="priority-dot priority-${p.priority}"></span>${priorityLabel(p.priority)}</div>
      <div class="c-due"><span class="deadline-badge ${badge.cls}">${badge.text}</span>${bellHtml(p)}</div>
      <div class="row-progress">
        <div class="progress-track"><div class="progress-fill ${done ? 'done' : ''}" style="width:${p.progress}%"></div></div>
        <button class="pct" data-act="progress" title="點一下調整進度">${p.progress}%</button>
      </div>
      <div class="row-files">${files.join('') || '<span class="none">—</span>'}</div>
      <div class="row-actions">
        <button class="row-btn" data-act="archive" title="${p.archived ? '取消封存' : '封存'}">${p.archived ? '📤' : '🗄'}</button>
        <button class="row-btn" data-act="edit" title="編輯">✏️</button>
      </div>
    </div>
    <div class="row-sub"><div class="row-sub-inner">
      <div class="sub-items">
        ${subtasks.map(subtaskHtml).join('')}
        <div class="subtask-add"><input type="text" class="row-sub-input" placeholder="${subtasks.length ? '新增子工作項，按 Enter 加入' : '還沒有子工作項，輸入後按 Enter 加入'}"></div>
      </div>
    </div></div>
  </div>`;
}

function wireRow(row) {
  const main = row.querySelector('.row-main');
  main.onclick = (e) => {
    const project = state.projects.find((x) => x.id === row.dataset.id);
    if (!project) return;
    const act = e.target.closest('[data-act]');
    if (!act) { toggleRowOpen(row); return; }
    e.stopPropagation();
    switch (act.dataset.act) {
      case 'complete': toggleCardComplete(project); break;
      case 'progress': openProgressPopover(act, row, project); break;
      case 'archive': toggleArchive(project); break;
      case 'edit': openDetail(project.id, row); break;
      case 'drive': openExternal(project.driveLink); break;
      case 'web': openExternal(project.websiteLink); break;
      case 'local': openLocal(project.localFilePath); break;
      case 'attach': openAttachmentPopover(act, project); break;
    }
  };
  main.ondblclick = (e) => { if (!e.target.closest('[data-act]')) openDetail(row.dataset.id, row); };
  row.oncontextmenu = (e) => openItemContextMenu(e, row.dataset.id);
  wireRowSubtasks(row);
}

function toggleRowOpen(row) {
  const id = row.dataset.id;
  const opening = !row.classList.contains('open');
  if (opening) state.expanded.add(id); else state.expanded.delete(id);
  row.classList.toggle('open', opening);
  if (!opening || prefersReducedMotion()) return;
  // items drift in one after another; as the drawer finishes sliding open,
  // the last one lands with a jelly wobble
  const items = row.querySelectorAll('.sub-items > *');
  items.forEach((el, i) => { el.style.animationDelay = `${i * 28}ms`; });
  row.classList.remove('sub-enter');
  void row.offsetWidth;
  row.classList.add('sub-enter');
  const last = items[items.length - 1];
  if (last) {
    last.classList.remove('jelly');
    setTimeout(() => { if (row.classList.contains('open')) last.classList.add('jelly'); }, 230);
  }
  setTimeout(() => {
    row.classList.remove('sub-enter');
    if (last) last.classList.remove('jelly');
    items.forEach((el) => { el.style.animationDelay = ''; });
  }, 1000);
}

// Re-renders one row in place (keeps its open state, no animation).
function refreshRow(id) {
  const row = document.querySelector(`#listView .proj-row[data-id="${id}"]`);
  const project = state.projects.find((x) => x.id === id);
  if (!row || !project) return null;
  const tmp = document.createElement('div');
  tmp.innerHTML = rowHtml(project);
  const fresh = tmp.firstElementChild;
  fresh.classList.add('no-anim');
  row.replaceWith(fresh);
  wireRow(fresh);
  requestAnimationFrame(() => fresh.classList.remove('no-anim'));
  return fresh;
}

function wireRowSubtasks(row) {
  const id = row.dataset.id;
  const project = () => state.projects.find((x) => x.id === id);
  row.querySelectorAll('.sub-items .subtask-row').forEach((sr) => {
    const subId = sr.dataset.id;
    sr.querySelector('.subtask-check').onclick = async () => {
      const sub = project().subtasks.find((s) => s.id === subId);
      sub.done = !sub.done;
      try { await apiSend('PUT', `/projects/${id}/subtasks/${subId}`, { done: sub.done }); }
      catch { toast('儲存失敗，請稍後再試'); }
      refreshRow(id);
    };
    sr.querySelector('.subtask-del').onclick = async () => {
      try { await apiSend('DELETE', `/projects/${id}/subtasks/${subId}`); }
      catch { toast('刪除失敗，請稍後再試'); return; }
      const p = project();
      p.subtasks = p.subtasks.filter((s) => s.id !== subId);
      refreshRow(id);
    };
  });
  const input = row.querySelector('.row-sub-input');
  input.onkeydown = async (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    const title = input.value.trim();
    if (!title) return;
    input.value = '';
    let sub;
    try { sub = await apiSend('POST', `/projects/${id}/subtasks`, { title }); }
    catch { toast('新增失敗，請稍後再試'); return; }
    const p = project();
    (p.subtasks ||= []).push(sub);
    const fresh = refreshRow(id);
    if (!fresh) return;
    fresh.querySelector('.row-sub-input').focus();
    const rows = fresh.querySelectorAll('.sub-items .subtask-row');
    const added = rows[rows.length - 1];
    if (added && !prefersReducedMotion()) added.classList.add('jelly');
  };
}

function openExternal(url) {
  if (!url) return;
  const href = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : 'https://' + url;
  window.open(href, '_blank', 'noopener'); // the desktop app hands this to the default browser
}

async function openLocal(path) {
  if (!path) return;
  if (!window.electronAPI) { toast('只有桌面版 App 能直接開啟本機檔案'); return; }
  const err = await window.electronAPI.openPath(path);
  if (err) toast('開啟失敗：' + err);
}

// ---------- Row popovers (progress slider, attachment list) ----------

let rowPopoverClose = null;
function showRowPopover(anchor, html, cls) {
  if (rowPopoverClose) rowPopoverClose();
  const pop = document.createElement('div');
  pop.className = 'row-popover glass ' + (cls || '');
  pop.innerHTML = html;
  document.body.appendChild(pop);
  const a = anchor.getBoundingClientRect();
  const w = pop.offsetWidth, h = pop.offsetHeight;
  const left = Math.max(10, Math.min(innerWidth - w - 10, a.left + a.width / 2 - w / 2));
  let top = a.bottom + 8;
  const above = top + h > innerHeight - 10;
  if (above) top = a.top - h - 8;
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
  pop.style.transformOrigin = `${a.left + a.width / 2 - left}px ${above ? '100%' : '0'}`;
  const onDoc = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const close = () => {
    if (rowPopoverClose === close) rowPopoverClose = null;
    document.removeEventListener('mousedown', onDoc, true);
    document.removeEventListener('keydown', onKey);
    pop.classList.add('closing');
    setTimeout(() => pop.remove(), 140);
  };
  setTimeout(() => {
    document.addEventListener('mousedown', onDoc, true);
    document.addEventListener('keydown', onKey);
  }, 0);
  rowPopoverClose = close;
  return { pop, close };
}

function openProgressPopover(anchor, row, project) {
  if (rowPopoverClose && document.querySelector('.row-popover.progress-pop:not(.closing)')) { rowPopoverClose(); return; }
  const { pop, close } = showRowPopover(anchor, `
    <div class="pp-head"><span>完成度</span><b class="pp-val">${project.progress}%</b></div>
    <input type="range" min="0" max="100" step="5" value="${project.progress}">
    <div class="pp-marks"><span>0</span><span>50</span><span>100</span></div>`, 'progress-pop');
  const range = pop.querySelector('input');
  const valEl = pop.querySelector('.pp-val');
  const fill = row.querySelector('.progress-fill');
  const pct = row.querySelector('.pct');
  const paint = () => {
    const v = Number(range.value);
    valEl.textContent = v + '%';
    pct.textContent = v + '%';
    fill.style.width = v + '%';
    range.style.setProperty('--v', v + '%');
  };
  paint();
  range.oninput = paint;
  range.onchange = () => {
    const v = Number(range.value);
    if (v === project.progress) return;
    if (v >= 100) close(); // get out of the way of the celebration
    setProgress(project, v);
  };
  range.focus();
}

function openAttachmentPopover(anchor, project) {
  showRowPopover(anchor, `
    <div class="pp-head"><span>附件</span><b>${project.attachments.length}</b></div>
    <div class="attachment-list">${project.attachments.map((a) => `
      <div class="attachment-row"><a href="/attachments/${project.id}/${a.storedName}" target="_blank" rel="noopener">📎 ${escapeHtml(a.originalName)}</a></div>`).join('')}
    </div>`, 'attach-pop');
}

// Magic-circle + butterfly celebration (complete.js) on the project's card,
// if it's on screen in the list view. Resolves when the animation is over.
function celebrateCard(project) {
  if (prefersReducedMotion() || document.hidden || CompleteFX.busy) return Promise.resolve();
  const card = document.querySelector(`#listView .project-card[data-id="${project.id}"], #listView .proj-row[data-id="${project.id}"]`);
  if (!card || state.view !== 'list') return Promise.resolve();
  const r = card.getBoundingClientRect();
  if (r.bottom < 0 || r.top > innerHeight || !r.width) return Promise.resolve();
  return CompleteFX.play(card, { accent: categoryColor(project.category) });
}

function bellHtml(p) {
  const next = nextReminder(p);
  return next ? `<span class="bell" title="下次提醒：${fmtReminder(next)}">🔔</span>` : '';
}

function cardHtml(p) {
  const badge = deadlineBadge(p);
  const done = p.progress >= 100;
  const subtasks = p.subtasks || [];
  const doneCount = subtasks.filter((s) => s.done).length;
  return `
  <div class="project-card glass ${p.archived ? 'archived' : ''}" data-id="${p.id}">
    <div class="card-top">
      <h3 class="card-title">${escapeHtml(p.title)}</h3>
      <span class="priority-dot priority-${p.priority}"></span>
    </div>
    <div class="card-meta">
      <span class="tag" style="background:${categoryColor(p.category)}">${escapeHtml(p.category)}</span>
    </div>
    <div class="progress-track"><div class="progress-fill ${done ? 'done' : ''}" style="width:${p.progress}%"></div></div>
    <div class="card-bottom">
      <span class="deadline-badge ${badge.cls}">${badge.text}${bellHtml(p)}</span>
      ${subtasks.length ? `<span class="subtask-count">☑ ${doneCount}/${subtasks.length}</span>` : ''}
    </div>
  </div>`;
}

// ---------- Calendar view ----------

function renderCalendar() {
  const month = state.calendarMonth;
  document.getElementById('calTitle').textContent = `${month.getFullYear()} 年 ${month.getMonth() + 1} 月`;

  const firstDay = new Date(month.getFullYear(), month.getMonth(), 1);
  const startOffset = firstDay.getDay();
  const gridStart = new Date(firstDay);
  gridStart.setDate(gridStart.getDate() - startOffset);

  const byDate = {};
  visibleProjects().forEach((p) => {
    if (!p.deadline) return;
    (byDate[p.deadline] ||= []).push(p);
  });

  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);

  const dows = ['日', '一', '二', '三', '四', '五', '六'];
  let html = dows.map((d) => `<div class="calendar-dow">${d}</div>`).join('');

  for (let i = 0; i < 42; i++) {
    const cellDate = new Date(gridStart);
    cellDate.setDate(cellDate.getDate() + i);
    const iso = cellDate.toISOString().slice(0, 10);
    const outside = cellDate.getMonth() !== month.getMonth();
    const isToday = iso === todayStr;
    const items = byDate[iso] || [];
    html += `<div class="calendar-cell glass ${outside ? 'outside' : ''} ${isToday ? 'today' : ''}">
      <div class="calendar-date">${cellDate.getDate()}</div>
      ${items.slice(0, 3).map((p) => `<div class="calendar-chip" style="background:${categoryColor(p.category)}" data-id="${p.id}">${escapeHtml(p.title)}</div>`).join('')}
      ${items.length > 3 ? `<div class="calendar-date">+${items.length - 3} 項</div>` : ''}
    </div>`;
  }
  const grid = document.getElementById('calendarGrid');
  grid.innerHTML = html;
  grid.querySelectorAll('.calendar-chip').forEach((chip) => {
    chip.onclick = () => openDetail(chip.dataset.id, chip);
  });
}

// ---------- Detail panel ----------

function openDetail(id, sourceEl) {
  const project = state.projects.find((p) => p.id === id);
  if (!project) return;
  state.openProjectId = id;
  const panel = document.getElementById('detailPanel');
  panel.innerHTML = detailHtml(project);
  wireDetailPanel(project);
  watchScrollCue(panel);
  openPanel(panel, sourceEl, `[data-id="${id}"]`);
}

// Shows the "more below" cue only while there's unseen content under the
// fold; re-checks when content grows (subtasks/attachments added).
let scrollCueObserver = null;
function watchScrollCue(panel) {
  const update = () => panel.classList.toggle('more-below', panel.scrollTop + panel.clientHeight < panel.scrollHeight - 8);
  panel.onscroll = update;
  if (scrollCueObserver) scrollCueObserver.disconnect();
  scrollCueObserver = new ResizeObserver(update);
  scrollCueObserver.observe(panel);
  const grid = panel.querySelector('.detail-grid');
  if (grid) scrollCueObserver.observe(grid);
  update();
}

function detailHtml(p) {
  const subtasks = p.subtasks || [];
  return `
    <div class="panel-header">
      <h2>${escapeHtml(p.title)}</h2>
      <span class="panel-close-hint">點空白處或 Esc 關閉</span>
    </div>

    <div class="detail-grid">
    <div class="detail-col">
    <div class="field">
      <label>標題</label>
      <input type="text" id="f-title" value="${escapeHtml(p.title)}">
    </div>

    <div class="field-row">
      <div class="field">
        <label>分類</label>
        <div class="dropdown"><button class="dropdown-trigger dropdown-trigger-block" type="button" id="f-category-trigger">${escapeHtml(p.category)} ▾</button></div>
      </div>
      <div class="field">
        <label>優先級</label>
        <div class="dropdown" id="priorityDropdown">
          <button class="dropdown-trigger dropdown-trigger-block" type="button" id="priorityTrigger">${priorityLabel(p.priority)} ▾</button>
        </div>
      </div>
    </div>

    <div class="field-row">
      <div class="field">
        <label>開始日</label>
        <button class="dropdown-trigger dropdown-trigger-block" type="button" id="f-start-trigger">${p.startDate ? fmtFullDate(p.startDate) : '未設定'} 📅</button>
      </div>
      <div class="field">
        <label>截止日</label>
        <button class="dropdown-trigger dropdown-trigger-block" type="button" id="f-deadline-trigger">${p.deadline ? fmtFullDate(p.deadline) : '未設定'} 📅</button>
      </div>
    </div>

    <div class="field">
      <label>完成度 <span id="progressVal">${p.progress}%</span></label>
      <div class="progress-edit">
        <input type="range" id="f-progress" min="0" max="100" step="5" value="${p.progress}">
      </div>
    </div>

    ${remindFieldHtml(p)}

    <div class="field">
      <label>子工作項</label>
      <div class="subtask-list" id="subtaskList">${subtasks.map(subtaskHtml).join('')}</div>
      <div class="subtask-add">
        <input type="text" id="subtaskInput" placeholder="新增子工作項，按 Enter 加入">
      </div>
    </div>
    </div>

    <div class="detail-col">
    <div class="field">
      <label>連結</label>
      <div class="link-stack">
        <div class="path-field">
          <input type="url" id="f-driveLink" placeholder="Google 雲端硬碟連結" value="${escapeHtml(p.driveLink || '')}" title="${escapeHtml(p.driveName || '')}">
          <button class="btn-ghost" type="button" id="drivePickBtn" title="從 Google 雲端硬碟選擇檔案或資料夾">選擇</button>
        </div>
        <input type="url" id="f-websiteLink" placeholder="網站連結" value="${escapeHtml(p.websiteLink || '')}">
        <div class="path-field" id="localPathDrop">
          <input type="text" id="f-localFilePath" placeholder="本機檔案路徑（可把檔案拖到這裡）" value="${escapeHtml(p.localFilePath || '')}">
          <button class="btn-ghost" type="button" id="openLocalPathBtn" title="用系統預設程式開啟">開啟</button>
        </div>
      </div>
    </div>

    <div class="field">
      <label>附件</label>
      <div class="dropzone" id="dropzone">拖曳檔案到這裡，或點擊選擇</div>
      <input type="file" id="fileInput" style="display:none" multiple>
      <div class="field-hint">存一份副本在 App 裡；要連到原始檔案位置請用上面的「本機檔案路徑」。</div>
      <div class="attachment-list" id="attachmentList">${(p.attachments || []).map((a) => attachmentHtml(a, p.id)).join('')}</div>
    </div>

    <div class="field">
      <label>備註</label>
      <textarea id="f-notes">${escapeHtml(p.notes || '')}</textarea>
    </div>
    </div>
    </div>

    <div class="panel-footer" id="panelFooter">
      <button class="btn-ghost" id="deleteProjectBtn" style="color:var(--danger)">刪除專案</button>
      <label class="toggle-archived"><input type="checkbox" id="f-archived" ${p.archived ? 'checked' : ''}> 已封存</label>
    </div>
    <div class="scroll-cue" aria-hidden="true">︾</div>
  `;
}

function priorityLabel(p) { return { High: '高', Medium: '中', Low: '低' }[p] || p; }

function subtaskHtml(s) {
  return `<div class="subtask-row ${s.done ? 'done' : ''}" data-id="${s.id}">
    <div class="subtask-check">${s.done ? '✓' : ''}</div>
    <div class="st-title">${escapeHtml(s.title)}</div>
    <button class="subtask-del" title="刪除">✕</button>
  </div>`;
}

function attachmentHtml(a, projectId) {
  return `<div class="attachment-row" data-id="${a.id}">
    <a href="/attachments/${projectId}/${a.storedName}" target="_blank" rel="noopener">📎 ${escapeHtml(a.originalName)}</a>
    <button class="attachment-del" title="刪除">✕</button>
  </div>`;
}

function wireDetailPanel(project) {
  const panel = document.getElementById('detailPanel');

  // Field edits are merged and sent together: calling save() for two
  // different fields within the debounce window used to keep only the last
  // patch, silently dropping the first edit. Requests are also chained so an
  // older save can never land after a newer one.
  let pending = {};
  let chain = Promise.resolve();
  const flush = debounce(() => {
    const patch = pending;
    pending = {};
    if (!Object.keys(patch).length) return;
    chain = chain.then(async () => {
      try {
        const updated = await apiSend('PUT', `/projects/${project.id}`, patch);
        const idx = state.projects.findIndex((p) => p.id === project.id);
        if (idx !== -1) state.projects[idx] = updated;
        Object.assign(project, updated);
        renderCurrentView();
      } catch (e) { toast('儲存失敗，請稍後再試'); }
    });
  }, 400);
  const save = (patch) => { Object.assign(pending, patch); flush(); };

  ['title', 'driveLink', 'websiteLink', 'localFilePath', 'notes'].forEach((field) => {
    const el = panel.querySelector(`#f-${field}`);
    if (!el) return;
    el.oninput = () => save({ [field]: el.value });
  });

  wireLocalPathField(panel, (realPath) => save({ localFilePath: realPath }));

  const catTrigger = panel.querySelector('#f-category-trigger');
  catTrigger.onclick = (e) => {
    e.stopPropagation();
    openCategoryPicker(catTrigger, project.category, (val) => {
      catTrigger.textContent = val + ' ▾';
      project.category = val;
      save({ category: val });
    });
  };

  const startTrigger = panel.querySelector('#f-start-trigger');
  startTrigger.onclick = (e) => {
    e.stopPropagation();
    openDatePicker(startTrigger, project.startDate, (val) => {
      startTrigger.textContent = (val ? fmtFullDate(val) : '未設定') + ' 📅';
      project.startDate = val;
      save({ startDate: val });
    });
  };

  const deadlineTrigger = panel.querySelector('#f-deadline-trigger');
  deadlineTrigger.onclick = (e) => {
    e.stopPropagation();
    openDatePicker(deadlineTrigger, project.deadline, (val) => {
      deadlineTrigger.textContent = (val ? fmtFullDate(val) : '未設定') + ' 📅';
      project.deadline = val;
      save({ deadline: val });
      updateRemindHint(panel, project);
    });
  };

  const progressInput = panel.querySelector('#f-progress');
  progressInput.oninput = () => {
    panel.querySelector('#progressVal').textContent = progressInput.value + '%';
  };
  progressInput.onchange = () => {
    const val = Number(progressInput.value);
    const wasDone = project.progress >= 100;
    save({ progress: val });
    if (val >= 100 && !wasDone) {
      // close the panel so the card is visible, then celebrate on it
      state.holdRender = true;
      closePanel(panel, () => celebrateCard(project).finally(() => {
        state.holdRender = false;
        renderCurrentView();
        toast('已標記為完成，已自動封存');
      }));
    }
  };

  panel.querySelector('#f-archived').onchange = (e) => save({ archived: e.target.checked });

  wireRemindField(panel, project);
  panel.querySelector('#drivePickBtn').onclick = () => openDrivePicker((file) => {
    const input = panel.querySelector('#f-driveLink');
    input.value = file.webViewLink;
    input.title = file.name;
    save({ driveLink: file.webViewLink, driveName: file.name });
  });

  // priority dropdown
  const triggerBtn = panel.querySelector('#priorityTrigger');
  triggerBtn.onclick = (e) => {
    e.stopPropagation();
    openCustomMenu(triggerBtn, ['High', 'Medium', 'Low'].map((v) => ({ value: v, label: priorityLabel(v) })), project.priority, (val) => {
      triggerBtn.textContent = priorityLabel(val) + ' ▾';
      save({ priority: val });
    });
  };

  // subtasks
  panel.querySelector('#subtaskInput').addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const input = e.target;
    const title = input.value.trim();
    if (!title) return;
    input.value = '';
    const sub = await apiSend('POST', `/projects/${project.id}/subtasks`, { title });
    project.subtasks.push(sub);
    refreshSubtaskList(project);
  });

  refreshSubtaskList(project);

  wireDropzone(panel, (files) => uploadFiles(project, files));

  const deleteBtn = panel.querySelector('#deleteProjectBtn');
  deleteBtn.onclick = () => {
    const footer = panel.querySelector('#panelFooter');
    footer.innerHTML = `
      <span style="font-size:12px;color:var(--danger);font-weight:700">確定要刪除「${escapeHtml(project.title)}」？無法復原</span>
      <div style="display:flex;gap:8px">
        <button class="btn-ghost" id="cancelDeleteBtn">取消</button>
        <button class="btn-primary" id="confirmDeleteBtn" style="background:var(--danger)">確定刪除</button>
      </div>
    `;
    footer.querySelector('#cancelDeleteBtn').onclick = () => {
      footer.innerHTML = `
        <button class="btn-ghost" id="deleteProjectBtn" style="color:var(--danger)">刪除專案</button>
        <label class="toggle-archived"><input type="checkbox" id="f-archived" ${project.archived ? 'checked' : ''}> 已封存</label>
      `;
      footer.querySelector('#deleteProjectBtn').onclick = deleteBtn.onclick;
      footer.querySelector('#f-archived').onchange = (e) => save({ archived: e.target.checked });
    };
    footer.querySelector('#confirmDeleteBtn').onclick = async () => {
      await apiSend('DELETE', `/projects/${project.id}`);
      state.projects = state.projects.filter((p) => p.id !== project.id);
      closePanel(panel);
      renderCurrentView();
      toast('已刪除專案');
    };
  };
}

function refreshSubtaskList(project) {
  const panel = document.getElementById('detailPanel');
  const list = panel.querySelector('#subtaskList');
  list.innerHTML = (project.subtasks || []).map(subtaskHtml).join('');
  list.querySelectorAll('.subtask-row').forEach((row) => {
    const subId = row.dataset.id;
    row.querySelector('.subtask-check').onclick = async () => {
      const sub = project.subtasks.find((s) => s.id === subId);
      sub.done = !sub.done;
      await apiSend('PUT', `/projects/${project.id}/subtasks/${subId}`, { done: sub.done });
      refreshSubtaskList(project);
      renderCurrentView();
    };
    row.querySelector('.subtask-del').onclick = async () => {
      await apiSend('DELETE', `/projects/${project.id}/subtasks/${subId}`);
      project.subtasks = project.subtasks.filter((s) => s.id !== subId);
      refreshSubtaskList(project);
      renderCurrentView();
    };
  });
}

// ---------- Reminder settings (detail panel) ----------

function updateRemindHint(panel, project) {
  const el = panel.querySelector('#remindNext');
  if (!el) return;
  const { days } = remindOf(project);
  const next = nextReminder(project);
  el.classList.toggle('off', !next);
  if (!project.deadline) el.textContent = '（尚未設定截止日，不會提醒）';
  else if (!days.length) el.textContent = '（已關閉）';
  else if (project.archived || project.progress >= 100) el.textContent = '（已完成／封存，不會提醒）';
  else el.textContent = next ? `下次：${fmtReminder(next)}` : '（提醒時間都已過）';
}

// Used by both the detail panel and the new-project panel.
function remindFieldHtml(p) {
  const { days, time, email } = remindOf(p);
  return `<div class="field">
      <label>截止提醒 <span class="remind-next" id="remindNext"></span></label>
      <div class="remind-row">
        <div class="remind-chips" id="remindChips">${REMIND_OPTIONS.map((o) =>
          `<button type="button" class="chip ${days.includes(o.d) ? 'active' : ''}" data-d="${o.d}">${o.label}</button>`).join('')}</div>
        <button type="button" class="dropdown-trigger" id="remindTime" data-value="${time}" title="提醒時間">🕘 ${time}</button>
        <button type="button" class="btn-ghost" id="remindTestBtn" title="馬上跳一則範例通知">測試通知</button>
      </div>
      <div class="remind-row">
        <button type="button" class="chip ${email ? 'active' : ''}" id="remindEmail" title="提醒時也寄一封信到連結的 Google 帳號">✉️ 同時寄 Email</button>
        ${p.id ? '<button type="button" class="btn-ghost" id="remindMailTestBtn" title="現在就寄一封這個專案的提醒信">寄一封看看</button>' : ''}
      </div>
    </div>`;
}

// `project` can be a draft (new-project panel): pass { save: false } and the
// chosen settings just stay on project.remind until the project is created.
function wireRemindField(panel, project, { save = true } = {}) {
  const chips = panel.querySelectorAll('#remindChips .chip');
  const timeInput = panel.querySelector('#remindTime');
  // saved on its own (not through the panel's shared debounced save, which
  // keeps only the last patch when two fields change within 400ms)
  const persist = debounce(async () => {
    try {
      const updated = await apiSend('PUT', `/projects/${project.id}`, { remind: project.remind });
      const idx = state.projects.findIndex((x) => x.id === project.id);
      if (idx !== -1) state.projects[idx] = { ...state.projects[idx], remind: updated.remind };
      renderCurrentView();
    } catch { toast('儲存失敗，請稍後再試'); }
  }, 300);
  const collect = () => {
    const days = [...chips].filter((c) => c.classList.contains('active')).map((c) => Number(c.dataset.d));
    project.remind = { days, time: timeInput.dataset.value || DEFAULT_REMIND.time, email: emailChip.classList.contains('active') };
    updateRemindHint(panel, project);
    if (save) persist();
  };
  chips.forEach((chip) => {
    chip.onclick = () => {
      chip.classList.toggle('active');
      chip.classList.remove('pop');
      void chip.offsetWidth;
      chip.classList.add('pop');
      collect();
    };
  });
  const emailChip = panel.querySelector('#remindEmail');
  emailChip.onclick = () => {
    emailChip.classList.toggle('active');
    emailChip.classList.remove('pop');
    void emailChip.offsetWidth;
    emailChip.classList.add('pop');
    collect();
  };
  const mailTest = panel.querySelector('#remindMailTestBtn');
  if (mailTest) mailTest.onclick = async () => {
    const api = window.electronAPI && window.electronAPI.google;
    if (!api) { toast('只有桌面版 App 能寄信'); return; }
    mailTest.disabled = true;
    mailTest.textContent = '寄送中…';
    const r = await api.testReminderMail(project.id);
    toast(r.ok ? `提醒信已寄到 ${r.to}` : '寄信失敗：' + r.error);
    mailTest.disabled = false;
    mailTest.textContent = '寄一封看看';
  };
  timeInput.onclick = (e) => {
    e.stopPropagation();
    openTimePicker(timeInput, timeInput.dataset.value, (val) => {
      timeInput.dataset.value = val;
      timeInput.textContent = '🕘 ' + val;
      collect();
    });
  };
  panel.querySelector('#remindTestBtn').onclick = async () => {
    if (!window.electronAPI || !window.electronAPI.testNotify) { toast('只有桌面版 App 能發 Windows 通知'); return; }
    const ok = await window.electronAPI.testNotify(project.title || panel.querySelector('#n-title')?.value.trim());
    if (!ok) toast('這台電腦目前不支援桌面通知');
  };
  updateRemindHint(panel, project);
}

// ---------- Clock-face time picker (glass popup) ----------
// 24-hour clock like a watch face: hours 1–12 on the outer ring, 13–23 and
// 00 on the inner ring; after picking the hour it turns into a minute dial.
// Tap a number or drag the hand; the hand always swings the short way round.

const TP_SIZE = 232, TP_C = TP_SIZE / 2, TP_OUTER = 90, TP_INNER = 60;

function openTimePicker(triggerEl, value, onSelect) {
  document.querySelector('.time-popup')?.remove();
  let [h, m] = (/^\d{2}:\d{2}$/.test(value || '') ? value : '09:00').split(':').map(Number);
  let mode = 'hour';
  let handDeg = null; // unwrapped angle, so transitions take the short way

  const pop = document.createElement('div');
  pop.className = 'time-popup glass';
  pop.innerHTML = `
    <div class="tp-display">
      <button type="button" class="tp-seg" data-mode="hour"></button><span class="tp-colon">:</span><button type="button" class="tp-seg" data-mode="minute"></button>
    </div>
    <svg class="tp-face" viewBox="0 0 ${TP_SIZE} ${TP_SIZE}" width="${TP_SIZE}" height="${TP_SIZE}">
      <circle class="tp-dial" cx="${TP_C}" cy="${TP_C}" r="${TP_C - 4}"/>
      <g class="tp-hand" style="transform-origin:${TP_C}px ${TP_C}px">
        <rect class="tp-arm" x="${TP_C - 1}" width="2"/>
        <circle class="tp-knob" cx="${TP_C}" r="17"/>
        <circle class="tp-knob-dot" cx="${TP_C}" r="3"/>
      </g>
      <circle class="tp-pivot" cx="${TP_C}" cy="${TP_C}" r="4"/>
      <g class="tp-labels"></g>
    </svg>
    <div class="date-popup-footer">
      <button type="button" class="btn-ghost" data-act="cancel">取消</button>
      <button type="button" class="btn-primary tp-ok" data-act="ok">確定</button>
    </div>`;
  document.body.appendChild(pop);

  const pad2 = (n) => String(n).padStart(2, '0');
  const labels = pop.querySelector('.tp-labels');
  const hand = pop.querySelector('.tp-hand');
  const arm = pop.querySelector('.tp-arm');
  const knob = pop.querySelector('.tp-knob');
  const dot = pop.querySelector('.tp-knob-dot');

  const pos = (frac, r) => {
    const a = frac * Math.PI * 2 - Math.PI / 2;
    return [TP_C + Math.cos(a) * r, TP_C + Math.sin(a) * r];
  };
  const hourRadius = (hh) => (hh === 0 || hh > 12 ? TP_INNER : TP_OUTER);

  function drawLabels() {
    let html = '';
    if (mode === 'hour') {
      for (let i = 1; i <= 12; i++) {
        const [x, y] = pos(i / 12, TP_OUTER);
        html += `<text x="${x}" y="${y}" class="${h === i ? 'sel' : ''}">${i}</text>`;
      }
      for (let i = 13; i <= 24; i++) {
        const hh = i % 24;
        const [x, y] = pos((i - 12) / 12, TP_INNER);
        html += `<text x="${x}" y="${y}" class="inner ${h === hh ? 'sel' : ''}">${pad2(hh)}</text>`;
      }
    } else {
      for (let i = 0; i < 60; i += 5) {
        const [x, y] = pos(i / 60, TP_OUTER);
        html += `<text x="${x}" y="${y}" class="${m === i ? 'sel' : ''}">${pad2(i)}</text>`;
      }
    }
    labels.innerHTML = html;
    labels.classList.remove('swap');
    void labels.getBBox();
    labels.classList.add('swap');
  }

  function drawHand() {
    const frac = mode === 'hour' ? (h % 12) / 12 : m / 60;
    const r = mode === 'hour' ? hourRadius(h) : TP_OUTER;
    let deg = frac * 360;
    if (handDeg !== null) deg += Math.round((handDeg - deg) / 360) * 360; // nearest equivalent angle
    handDeg = deg;
    hand.style.transform = `rotate(${deg}deg)`;
    arm.style.y = `${TP_C - r}px`;
    arm.style.height = `${r}px`;
    knob.style.cy = `${TP_C - r}px`;
    dot.style.cy = `${TP_C - r}px`;
    // the small dot marks a minute that has no printed label under the knob
    dot.style.opacity = mode === 'minute' && m % 5 ? '1' : '0';
    pop.querySelectorAll('.tp-seg').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
    pop.querySelector('[data-mode="hour"]').textContent = pad2(h);
    pop.querySelector('[data-mode="minute"]').textContent = pad2(m);
    labels.querySelectorAll('text').forEach((t) => {
      const v = Number(t.textContent);
      t.classList.toggle('sel', mode === 'hour' ? v === h : v === m);
    });
  }

  function setMode(next) {
    if (next === mode) return;
    mode = next;
    drawLabels();
    drawHand();
  }

  // pointer -> value
  const svg = pop.querySelector('.tp-face');
  function pick(e) {
    const r = svg.getBoundingClientRect();
    const x = (e.clientX - r.left) * (TP_SIZE / r.width) - TP_C;
    const y = (e.clientY - r.top) * (TP_SIZE / r.height) - TP_C;
    let a = Math.atan2(y, x) + Math.PI / 2;
    if (a < 0) a += Math.PI * 2;
    if (mode === 'hour') {
      const k = Math.round(a / (Math.PI * 2) * 12) % 12;
      const inner = Math.hypot(x, y) < (TP_OUTER + TP_INNER) / 2;
      h = inner ? (k === 0 ? 0 : k + 12) : (k === 0 ? 12 : k);
    } else {
      m = Math.round(a / (Math.PI * 2) * 60) % 60;
    }
    drawHand();
  }
  let dragging = false;
  svg.addEventListener('pointerdown', (e) => {
    dragging = true;
    svg.setPointerCapture(e.pointerId);
    pop.classList.add('dragging');
    pick(e);
  });
  svg.addEventListener('pointermove', (e) => { if (dragging) pick(e); });
  svg.addEventListener('pointerup', () => {
    if (!dragging) return;
    dragging = false;
    pop.classList.remove('dragging');
    if (mode === 'hour') setTimeout(() => setMode('minute'), 180); // like a watch: hour first, then minutes
  });

  pop.querySelectorAll('.tp-seg').forEach((b) => { b.onclick = () => setMode(b.dataset.mode); });

  const close = () => {
    document.removeEventListener('mousedown', onDoc, true);
    document.removeEventListener('keydown', onKey);
    pop.classList.add('closing');
    setTimeout(() => pop.remove(), 150);
  };
  const onDoc = (e) => { if (!pop.contains(e.target) && e.target !== triggerEl) close(); };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    if (e.key === 'Enter') { onSelect(`${pad2(h)}:${pad2(m)}`); close(); }
  };
  pop.querySelector('[data-act="cancel"]').onclick = close;
  pop.querySelector('[data-act="ok"]').onclick = () => { onSelect(`${pad2(h)}:${pad2(m)}`); close(); };
  setTimeout(() => {
    document.addEventListener('mousedown', onDoc, true);
    document.addEventListener('keydown', onKey);
  }, 0);

  // place under the trigger (above it if there's no room), inside the window
  const tr = triggerEl.getBoundingClientRect();
  const w = pop.offsetWidth, ph = pop.offsetHeight;
  const left = Math.max(10, Math.min(innerWidth - w - 10, tr.left));
  let top = tr.bottom + 8;
  if (top + ph > innerHeight - 10) top = Math.max(10, tr.top - ph - 8);
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
  pop.style.transformOrigin = `${tr.left + tr.width / 2 - left}px ${top > tr.top ? '0' : '100%'}`;

  drawLabels();
  pop.classList.add('no-anim'); // first placement of the hand: no swing-in from 12
  drawHand();
  requestAnimationFrame(() => requestAnimationFrame(() => pop.classList.remove('no-anim')));
}

// ---------- Google Drive picker ----------
// Browse / search the linked Drive (names and links only) and pick a file or
// folder; the chosen item's link goes into the project's Drive field.

const DRIVE_TABS = [
  { mode: 'recent', label: '最近使用' },
  { mode: 'folder', label: '我的雲端硬碟' },
  { mode: 'shared', label: '與我共用' },
];

function driveIcon(mime) {
  if (mime === 'application/vnd.google-apps.folder') return '📁';
  if (mime === 'application/vnd.google-apps.document') return '📝';
  if (mime === 'application/vnd.google-apps.spreadsheet') return '📊';
  if (mime === 'application/vnd.google-apps.presentation') return '📽️';
  if (mime === 'application/vnd.google-apps.form') return '📋';
  if (mime === 'application/pdf') return '📕';
  if (/^image\//.test(mime)) return '🖼️';
  if (/^video\//.test(mime)) return '🎬';
  if (/^audio\//.test(mime)) return '🎵';
  if (/zip|compressed/.test(mime)) return '🗜️';
  return '📄';
}

async function openDrivePicker(onPick) {
  const api = window.electronAPI && window.electronAPI.google;
  if (!api) { toast('只有桌面版 App 能連 Google 雲端硬碟'); return; }
  const st = await api.status();
  if (!st.ok || !st.connected) { toast('請先在右上角 ⚙️ 連結 Google 帳號'); return; }
  if (!st.canDrive) { toast('還沒有雲端硬碟權限：請到 ⚙️ 按「重新連結」並勾選雲端硬碟'); return; }

  const shade = document.createElement('div');
  shade.className = 'drive-shade';
  shade.innerHTML = `
    <div class="drive-picker glass">
      <div class="dp-head">
        <div class="dp-title">從 Google 雲端硬碟選擇</div>
        <div class="dp-tabs">${DRIVE_TABS.map((t) => `<button type="button" data-mode="${t.mode}">${t.label}</button>`).join('')}</div>
      </div>
      <div class="dp-search"><span>🔍</span><input type="text" placeholder="搜尋檔案名稱…"></div>
      <div class="dp-crumbs"></div>
      <div class="dp-list"></div>
      <div class="dp-foot">
        <button type="button" class="btn-ghost" data-act="cancel">取消</button>
        <button type="button" class="btn-primary" data-act="pickFolder" hidden>選擇這個資料夾</button>
      </div>
    </div>`;
  document.body.appendChild(shade);
  const picker = shade.querySelector('.drive-picker');
  const list = shade.querySelector('.dp-list');
  const crumbs = shade.querySelector('.dp-crumbs');
  const search = shade.querySelector('.dp-search input');
  const pickFolderBtn = shade.querySelector('[data-act="pickFolder"]');

  const MY_ROOT = { id: 'root', name: '我的雲端硬碟' };
  const SHARED_ROOT = { id: '__shared__', name: '與我共用' };
  let view = { mode: 'recent', query: '', path: [MY_ROOT] };
  let token = 0; // ignore responses that arrive after the view changed

  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    shade.classList.add('closing');
    setTimeout(() => shade.remove(), 160);
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  shade.addEventListener('mousedown', (e) => { if (e.target === shade) close(); });
  shade.querySelector('[data-act="cancel"]').onclick = close;

  const pick = (file) => { onPick(file); close(); toast(`已連結「${file.name}」`); };

  async function load(pageToken = null) {
    const my = ++token;
    const folder = view.path[view.path.length - 1];
    // a folder opened from 與我共用 keeps that tab lit
    const tab = view.mode === 'folder' && view.path[0] === SHARED_ROOT ? 'shared' : view.mode;
    shade.querySelectorAll('.dp-tabs button').forEach((b) => b.classList.toggle('on', !view.query && b.dataset.mode === tab));
    crumbs.innerHTML = view.query
      ? `<span class="dim">搜尋「${escapeHtml(view.query)}」的結果</span>`
      : view.mode === 'folder' || (view.mode === 'shared' && view.path[0] === SHARED_ROOT && view.path.length > 1)
        ? view.path.map((f, i) => `<button type="button" data-i="${i}">${escapeHtml(f.name)}</button>`).join('<span class="sep">›</span>')
        : '';
    crumbs.querySelectorAll('button').forEach((b) => {
      b.onclick = () => {
        view.path = view.path.slice(0, Number(b.dataset.i) + 1);
        if (view.path.length === 1 && view.path[0] === SHARED_ROOT) view.mode = 'shared';
        load();
      };
    });
    pickFolderBtn.hidden = !(view.mode === 'folder' && !view.query && view.path.length > 1);
    if (!pageToken) list.innerHTML = '<div class="dp-empty">讀取中…</div>';

    const opts = view.query ? { mode: 'search', query: view.query } : { mode: view.mode, folderId: folder.id };
    const r = await api.driveList({ ...opts, pageToken });
    if (my !== token) return;
    if (!r.ok) { list.innerHTML = `<div class="dp-empty err">讀取失敗：${escapeHtml(r.error)}</div>`; return; }
    if (!pageToken) list.innerHTML = '';
    list.querySelector('.dp-more')?.remove();
    if (!r.files.length && !pageToken) { list.innerHTML = '<div class="dp-empty">這裡沒有檔案</div>'; return; }
    r.files.forEach((f, i) => {
      const isFolder = f.mimeType === 'application/vnd.google-apps.folder';
      const row = document.createElement('div');
      row.className = 'dp-row';
      row.style.animationDelay = `${Math.min(i, 12) * 18}ms`;
      const when = f.modifiedTime ? new Date(f.modifiedTime) : null;
      row.innerHTML = `
        <span class="dp-ico">${driveIcon(f.mimeType)}</span>
        <span class="dp-name">${escapeHtml(f.name)}</span>
        <span class="dp-date">${when ? `${when.getMonth() + 1}/${when.getDate()}` : ''}</span>
        ${isFolder ? '<span class="dp-open">›</span>' : ''}`;
      // folders always open; a folder itself is linked with 選擇這個資料夾
      row.onclick = () => {
        if (!isFolder) { pick(f); return; }
        const inFolder = view.mode === 'folder' && !view.query;
        const origin = view.mode === 'shared' && !view.query ? SHARED_ROOT : MY_ROOT;
        view = { mode: 'folder', query: '', path: (inFolder ? view.path : [origin]).concat({ id: f.id, name: f.name }) };
        search.value = '';
        load();
      };
      list.appendChild(row);
    });
    if (r.nextPageToken) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'btn-ghost dp-more';
      more.textContent = '載入更多';
      more.onclick = () => { more.disabled = true; more.textContent = '讀取中…'; load(r.nextPageToken); };
      list.appendChild(more);
    }
  }

  shade.querySelectorAll('.dp-tabs button').forEach((b) => {
    b.onclick = () => {
      view = { mode: b.dataset.mode, query: '', path: [b.dataset.mode === 'shared' ? SHARED_ROOT : MY_ROOT] };
      search.value = '';
      load();
    };
  });
  search.oninput = debounce(() => {
    view.query = search.value.trim();
    if (!view.query && view.mode === 'folder') { view.path = view.path.slice(0, 1); if (view.path[0] === SHARED_ROOT) view.mode = 'shared'; }
    load();
  }, 350);
  pickFolderBtn.onclick = () => {
    const f = view.path[view.path.length - 1];
    pick({ id: f.id, name: f.name, webViewLink: `https://drive.google.com/drive/folders/${f.id}` });
  };

  requestAnimationFrame(() => picker.classList.add('in'));
  search.focus();
  load();
}

// ---------- Shared: local path field + attachment dropzone ----------
// Used by both the detail panel and the new-project panel.

// Dropping a file on the local-path field fills in its real absolute path
// (only possible in the Electron desktop build — window.electronAPI is
// injected by preload.js there and doesn't exist in a plain browser tab,
// where the drop is caught and explained instead).
function wireLocalPathField(root, onPath) {
  const pathDrop = root.querySelector('#localPathDrop');
  const pathInput = root.querySelector('#f-localFilePath');
  ['dragenter', 'dragover'].forEach((evt) => pathDrop.addEventListener(evt, (e) => {
    e.preventDefault(); e.stopPropagation(); pathDrop.classList.add('dragover');
  }));
  ['dragleave', 'drop'].forEach((evt) => pathDrop.addEventListener(evt, (e) => {
    e.preventDefault(); e.stopPropagation(); pathDrop.classList.remove('dragover');
  }));
  pathDrop.addEventListener('drop', (e) => {
    const file = e.dataTransfer.files[0];
    if (!file) return;
    if (!window.electronAPI) {
      toast('瀏覽器無法取得檔案的真實路徑，請改用桌面版 App，或手動貼上路徑');
      return;
    }
    const realPath = window.electronAPI.getPathForFile(file);
    pathInput.value = realPath;
    onPath && onPath(realPath);
  });

  root.querySelector('#openLocalPathBtn').onclick = async () => {
    const p = pathInput.value.trim();
    if (!p) { toast('尚未設定本機檔案路徑'); return; }
    if (!window.electronAPI) { toast('只有桌面版 App 能直接開啟本機檔案'); return; }
    const err = await window.electronAPI.openPath(p);
    if (err) toast('開啟失敗：' + err);
  };
}

function wireDropzone(root, onFiles) {
  const dropzone = root.querySelector('#dropzone');
  const fileInput = root.querySelector('#fileInput');
  dropzone.onclick = () => fileInput.click();
  fileInput.onchange = () => { onFiles(Array.from(fileInput.files)); fileInput.value = ''; };
  ['dragenter', 'dragover'].forEach((evt) => dropzone.addEventListener(evt, (e) => {
    e.preventDefault(); e.stopPropagation(); dropzone.classList.add('dragover');
  }));
  ['dragleave', 'drop'].forEach((evt) => dropzone.addEventListener(evt, (e) => {
    e.preventDefault(); e.stopPropagation(); dropzone.classList.remove('dragover');
  }));
  dropzone.addEventListener('drop', (e) => onFiles(Array.from(e.dataTransfer.files)));
}

// Uploads each file as an attachment copy; returns the created records.
async function uploadAttachments(projectId, files) {
  const records = [];
  for (const file of files) {
    const fd = new FormData();
    fd.append('file', file);
    try {
      const res = await fetch(`${API}/projects/${projectId}/attachments`, { method: 'POST', body: fd });
      if (!res.ok) throw new Error('upload failed');
      records.push(await res.json());
    } catch (e) { toast(`「${file.name}」上傳失敗`); }
  }
  return records;
}

async function uploadFiles(project, files) {
  const records = await uploadAttachments(project.id, files);
  if (!records.length) return;
  project.attachments = (project.attachments || []).concat(records);
  refreshAttachmentList(project);
  toast(`已上傳 ${records.length} 個檔案`);
}

function refreshAttachmentList(project) {
  const panel = document.getElementById('detailPanel');
  const list = panel.querySelector('#attachmentList');
  list.innerHTML = (project.attachments || []).map((a) => attachmentHtml(a, project.id)).join('');
  list.querySelectorAll('.attachment-row').forEach((row) => {
    const attId = row.dataset.id;
    row.querySelector('.attachment-del').onclick = async () => {
      await apiSend('DELETE', `/projects/${project.id}/attachments/${attId}`);
      project.attachments = project.attachments.filter((a) => a.id !== attId);
      refreshAttachmentList(project);
    };
  });
}

// ---------- New project panel ----------

function openNewPanel(sourceEl) {
  const panel = document.getElementById('newPanel');
  panel.innerHTML = `
    <div class="panel-header">
      <h2>新增專案</h2>
      <span class="panel-close-hint">點空白處或 Esc 關閉</span>
    </div>
    <div class="detail-grid">
    <div class="detail-col">
    <div class="field"><label>標題</label><input type="text" id="n-title" placeholder="專案名稱" autofocus></div>
    <div class="field-row">
      <div class="field">
        <label>分類</label>
        <div class="dropdown"><button class="dropdown-trigger dropdown-trigger-block" type="button" id="nCategoryTrigger">選擇分類 ▾</button></div>
      </div>
      <div class="field">
        <label>優先級</label>
        <div class="dropdown" id="nPriorityDropdown">
          <button class="dropdown-trigger dropdown-trigger-block" type="button" id="nPriorityTrigger">中 ▾</button>
        </div>
      </div>
    </div>
    <div class="field-row">
      <div class="field"><label>開始日</label><button class="dropdown-trigger dropdown-trigger-block" type="button" id="nStartTrigger">未設定 📅</button></div>
      <div class="field"><label>截止日</label><button class="dropdown-trigger dropdown-trigger-block" type="button" id="nDeadlineTrigger">未設定 📅</button></div>
    </div>
    ${remindFieldHtml({ remind: null })}
    <div class="field"><label>備註</label><textarea id="n-notes"></textarea></div>
    </div>

    <div class="detail-col">
    <div class="field">
      <label>連結</label>
      <div class="link-stack">
        <div class="path-field">
          <input type="url" id="f-driveLink" placeholder="Google 雲端硬碟連結">
          <button class="btn-ghost" type="button" id="drivePickBtn" title="從 Google 雲端硬碟選擇檔案或資料夾">選擇</button>
        </div>
        <input type="url" id="f-websiteLink" placeholder="網站連結">
        <div class="path-field" id="localPathDrop">
          <input type="text" id="f-localFilePath" placeholder="本機檔案路徑（可把檔案拖到這裡）">
          <button class="btn-ghost" type="button" id="openLocalPathBtn" title="用系統預設程式開啟">開啟</button>
        </div>
      </div>
    </div>
    <div class="field">
      <label>附件</label>
      <div class="dropzone" id="dropzone">拖曳檔案到這裡，或點擊選擇</div>
      <input type="file" id="fileInput" style="display:none" multiple>
      <div class="field-hint">建立專案時一起上傳，存一份副本在 App 裡。</div>
      <div class="attachment-list" id="pendingList"></div>
    </div>
    </div>
    </div>
    <div class="panel-footer">
      <span></span>
      <button class="btn-primary" id="createBtn">建立專案</button>
    </div>
  `;
  let selectedPriority = 'Medium';
  let selectedCategory = null;
  let selectedStart = null;
  let selectedDeadline = null;
  // Attachments need a project id, which doesn't exist yet — queue the files
  // and upload them right after the project is created.
  let pendingFiles = [];
  // stands in for the project until it exists, so the reminder hint can
  // follow the chosen deadline
  const draft = { remind: null, deadline: null, progress: 0, archived: false, title: '' };
  wireRemindField(panel, draft, { save: false });
  panel.querySelector('#drivePickBtn').onclick = () => openDrivePicker((file) => {
    const input = panel.querySelector('#f-driveLink');
    input.value = file.webViewLink;
    input.title = file.name;
    draft.driveName = file.name;
  });

  const renderPending = () => {
    const list = panel.querySelector('#pendingList');
    list.innerHTML = pendingFiles.map((f, i) => `<div class="attachment-row" data-i="${i}">
      <span class="pending-name">📎 ${escapeHtml(f.name)}</span>
      <button class="attachment-del" title="移除">✕</button>
    </div>`).join('');
    list.querySelectorAll('.attachment-row').forEach((row) => {
      row.querySelector('.attachment-del').onclick = () => {
        pendingFiles.splice(Number(row.dataset.i), 1);
        renderPending();
      };
    });
  };
  wireDropzone(panel, (files) => { pendingFiles = pendingFiles.concat(files); renderPending(); });
  wireLocalPathField(panel, null);

  const priorityTrigger = panel.querySelector('#nPriorityTrigger');
  priorityTrigger.onclick = (e) => {
    e.stopPropagation();
    openCustomMenu(priorityTrigger, ['High', 'Medium', 'Low'].map((v) => ({ value: v, label: priorityLabel(v) })), selectedPriority, (val) => {
      selectedPriority = val;
      priorityTrigger.textContent = priorityLabel(val) + ' ▾';
    });
  };

  const categoryTrigger = panel.querySelector('#nCategoryTrigger');
  categoryTrigger.onclick = (e) => {
    e.stopPropagation();
    openCategoryPicker(categoryTrigger, selectedCategory, (val) => {
      selectedCategory = val;
      categoryTrigger.textContent = val + ' ▾';
    });
  };

  const startTrigger = panel.querySelector('#nStartTrigger');
  startTrigger.onclick = (e) => {
    e.stopPropagation();
    openDatePicker(startTrigger, selectedStart, (val) => {
      selectedStart = val;
      startTrigger.textContent = (val ? fmtFullDate(val) : '未設定') + ' 📅';
    });
  };

  const deadlineTrigger = panel.querySelector('#nDeadlineTrigger');
  deadlineTrigger.onclick = (e) => {
    e.stopPropagation();
    openDatePicker(deadlineTrigger, selectedDeadline, (val) => {
      selectedDeadline = val;
      deadlineTrigger.textContent = (val ? fmtFullDate(val) : '未設定') + ' 📅';
      draft.deadline = val;
      updateRemindHint(panel, draft);
    });
  };

  panel.querySelector('#createBtn').onclick = async () => {
    const title = panel.querySelector('#n-title').value.trim();
    if (!title) { toast('請輸入專案標題'); return; }
    const body = {
      title,
      category: selectedCategory || 'Others',
      priority: selectedPriority,
      startDate: selectedStart,
      deadline: selectedDeadline,
      notes: panel.querySelector('#n-notes').value || null,
      driveLink: panel.querySelector('#f-driveLink').value.trim() || null,
      websiteLink: panel.querySelector('#f-websiteLink').value.trim() || null,
      localFilePath: panel.querySelector('#f-localFilePath').value.trim() || null,
      remind: draft.remind, // null unless changed = default schedule
      driveName: draft.driveName || null,
    };
    const files = pendingFiles;
    const project = await apiSend('POST', '/projects', body);
    state.projects.push(project);
    if (!state.categories.includes(project.category)) {
      state.categories.push(project.category);
      state.categories.sort();
      renderFilterChips();
    }
    closePanel(panel);
    renderCurrentView();
    if (!files.length) { toast('已建立專案'); return; }
    const records = await uploadAttachments(project.id, files);
    project.attachments = (project.attachments || []).concat(records);
    toast(`已建立專案，並上傳 ${records.length} 個附件`);
  };

  openPanel(panel, sourceEl, '#newProjectBtn');
}

// ---------- Generic dropdown ----------

function openCustomMenu(triggerEl, options, currentValue, onSelect) {
  // Appended directly to <body> (see globalDropdownMenu in index.html) so that
  // position:fixed coordinates are relative to the viewport, not to some
  // ancestor panel — any ancestor with backdrop-filter/transform (our .glass
  // panels have both) would otherwise become the containing block and throw
  // the menu's math off.
  const menu = document.getElementById('globalDropdownMenu');
  const rect = triggerEl.getBoundingClientRect();
  menu.style.left = rect.left + 'px';
  menu.style.top = (rect.bottom + 6) + 'px';
  menu.style.minWidth = rect.width + 'px';
  menu.innerHTML = options.map((o) => `<div class="dropdown-item ${o.value === currentValue ? 'selected' : ''}" data-val="${o.value}">${o.label}${o.value === currentValue ? ' ✓' : ''}</div>`).join('');
  menu.classList.add('open');

  const closeMenu = () => { menu.classList.remove('open'); document.removeEventListener('click', closeMenu); };
  setTimeout(() => document.addEventListener('click', closeMenu), 0);

  menu.querySelectorAll('.dropdown-item').forEach((item) => {
    item.onclick = (e) => {
      e.stopPropagation();
      // Close (and unregister this menu's document-click listener) BEFORE
      // calling onSelect — onSelect may itself re-open this same menu
      // element (e.g. the "+ new category" prompt). Closing afterwards
      // would leave this listener live and immediately hide whatever
      // onSelect just opened, since both fire off the same click event.
      closeMenu();
      onSelect(item.dataset.val);
    };
  });
}

// ---------- Date picker ----------

function fmtFullDate(iso) {
  if (!iso) return null;
  const d = new Date(iso + 'T00:00:00');
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}

let datePopupMonth = new Date();

function openDatePicker(triggerEl, currentValue, onSelect) {
  const popup = document.getElementById('globalDatePopup');
  const rect = triggerEl.getBoundingClientRect();
  popup.style.left = rect.left + 'px';
  popup.style.top = (rect.bottom + 6) + 'px';
  popup.classList.remove('open');
  void popup.offsetWidth;
  datePopupMonth = currentValue ? new Date(currentValue + 'T00:00:00') : new Date();
  renderDatePopup(popup, currentValue, onSelect);
  popup.classList.add('open');

  const closeMenu = (e) => {
    if (popup.contains(e.target)) return;
    popup.classList.remove('open');
    document.removeEventListener('click', closeMenu);
  };
  setTimeout(() => document.addEventListener('click', closeMenu), 0);
}

function renderDatePopup(popup, currentValue, onSelect) {
  const month = datePopupMonth;
  const firstDay = new Date(month.getFullYear(), month.getMonth(), 1);
  const gridStart = new Date(firstDay);
  gridStart.setDate(gridStart.getDate() - firstDay.getDay());
  const todayStr = new Date().toISOString().slice(0, 10);
  const dows = ['日', '一', '二', '三', '四', '五', '六'];

  let cells = '';
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart);
    d.setDate(d.getDate() + i);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const cls = ['date-popup-cell'];
    if (d.getMonth() !== month.getMonth()) cls.push('outside');
    if (iso === todayStr) cls.push('today');
    if (iso === currentValue) cls.push('selected');
    cells += `<div class="${cls.join(' ')}" data-date="${iso}">${d.getDate()}</div>`;
  }

  popup.innerHTML = `
    <div class="date-popup-header">
      <button class="icon-btn" id="dpPrev" style="width:26px;height:26px;font-size:12px">‹</button>
      <span class="dp-title">${month.getFullYear()} 年 ${month.getMonth() + 1} 月</span>
      <button class="icon-btn" id="dpNext" style="width:26px;height:26px;font-size:12px">›</button>
    </div>
    <div class="date-popup-grid">
      ${dows.map((d) => `<div class="date-popup-dow">${d}</div>`).join('')}
      ${cells}
    </div>
    <div class="date-popup-footer">
      <button class="btn-ghost" id="dpClear">清除</button>
      <button class="btn-ghost" id="dpToday">今天</button>
    </div>
  `;
  popup.querySelector('#dpPrev').onclick = (e) => { e.stopPropagation(); datePopupMonth = new Date(month.getFullYear(), month.getMonth() - 1, 1); renderDatePopup(popup, currentValue, onSelect); };
  popup.querySelector('#dpNext').onclick = (e) => { e.stopPropagation(); datePopupMonth = new Date(month.getFullYear(), month.getMonth() + 1, 1); renderDatePopup(popup, currentValue, onSelect); };
  popup.querySelector('#dpClear').onclick = (e) => { e.stopPropagation(); popup.classList.remove('open'); onSelect(null); };
  popup.querySelector('#dpToday').onclick = (e) => { e.stopPropagation(); popup.classList.remove('open'); onSelect(todayStr); };
  popup.querySelectorAll('.date-popup-cell').forEach((cell) => {
    cell.onclick = (e) => { e.stopPropagation(); popup.classList.remove('open'); onSelect(cell.dataset.date); };
  });
}

// ---------- Category picker (dropdown + inline "add new") ----------

function openCategoryPicker(triggerEl, currentValue, onSelect) {
  const options = state.categories.map((c) => ({ value: c, label: c }));
  options.push({ value: '__new__', label: '＋ 新增分類…' });
  openCustomMenu(triggerEl, options, currentValue, (val) => {
    if (val === '__new__') promptNewCategory(triggerEl, onSelect);
    else onSelect(val);
  });
  // right-click an option: rename / delete that category
  document.querySelectorAll('#globalDropdownMenu .dropdown-item').forEach((item) => {
    if (item.dataset.val === '__new__') return;
    item.title = '右鍵：重新命名或刪除這個分類';
    item.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const name = item.dataset.val;
      document.getElementById('globalDropdownMenu').classList.remove('open');
      const menu = [
        { label: '✏️ 重新命名', onSelect: () => openCategoryAction(triggerEl, name, 'rename', (to) => { if (currentValue === name) onSelect(to); }) },
        { label: '🗑 刪除分類', danger: true, onSelect: () => openCategoryAction(triggerEl, name, 'delete', (to) => { if (currentValue === name) onSelect(to); }) },
      ];
      setTimeout(() => openContextMenu(e.clientX, e.clientY, menu), 0);
    };
  });
}

// ---------- Category rename / delete ----------

function projectsIn(name) { return state.projects.filter((p) => p.category === name); }

// After the server moved projects from one category to another, mirror it
// locally (projects, filter, chip list) and redraw.
function applyCategoryMove(from, to) {
  state.projects.forEach((p) => { if (p.category === from) p.category = to; });
  state.categories = [...new Set(state.categories.filter((c) => c !== from).concat(to ? [to] : []))].sort();
  if (state.filters.categories.has(from)) {
    state.filters.categories.delete(from);
    if (to) state.filters.categories.add(to);
  }
  renderFilterChips();
  renderCurrentView();
  // an open edit panel showing the old name
  const trig = document.querySelector('#detailPanel #f-category-trigger');
  if (trig && trig.textContent.trim() === from + ' ▾' && to) trig.textContent = to + ' ▾';
}

function openCategoryAction(anchor, name, mode, onMoved) {
  const count = projectsIn(name).length;
  if (mode === 'rename') {
    const { pop, close } = showRowPopover(anchor, `
      <div class="pp-head"><span>重新命名分類</span></div>
      <input type="text" class="cat-input" value="${escapeHtml(name)}">
      <div class="gs-line dim">${count ? `底下 ${count} 個專案會一起改成新名稱。` : '目前沒有專案使用這個分類。'}</div>
      <div class="gs-actions"><button class="btn-ghost" data-act="cancel">取消</button><button class="btn-primary gs-btn" data-act="ok">確定</button></div>`, 'cat-pop');
    const input = pop.querySelector('.cat-input');
    input.select();
    const go = async () => {
      const to = input.value.trim();
      if (!to) { toast('請輸入分類名稱'); return; }
      if (to === name) { close(); return; }
      try {
        if (count) await apiSend('POST', '/categories/rename', { from: name, to });
        applyCategoryMove(name, to);
        onMoved && onMoved(to);
        toast(`已改名為「${to}」`);
        close();
      } catch { toast('改名失敗，請稍後再試'); }
    };
    pop.querySelector('[data-act="ok"]').onclick = go;
    pop.querySelector('[data-act="cancel"]').onclick = close;
    input.onkeydown = (e) => { if (e.key === 'Enter') go(); };
    return;
  }

  // delete
  if (!count) {
    applyCategoryMove(name, null);
    toast(`已刪除分類「${name}」`);
    return;
  }
  const targets = [...new Set(['Others', ...state.categories])].filter((c) => c !== name);
  let target = targets[0];
  const { pop, close } = showRowPopover(anchor, `
    <div class="pp-head"><span>刪除分類「${escapeHtml(name)}」</span></div>
    <div class="gs-line">底下還有 <b>${count}</b> 個專案，要移到哪個分類？</div>
    <div class="cat-targets">${targets.map((c, i) => `<button type="button" class="chip ${i === 0 ? 'active' : ''}" data-cat="${escapeHtml(c)}">${escapeHtml(c)}</button>`).join('')}</div>
    <div class="gs-actions"><button class="btn-ghost" data-act="cancel">取消</button><button class="btn-primary gs-btn gs-danger-bg" data-act="ok">刪除並移動</button></div>`, 'cat-pop');
  pop.querySelectorAll('.cat-targets .chip').forEach((b) => {
    b.onclick = () => {
      target = b.dataset.cat;
      pop.querySelectorAll('.cat-targets .chip').forEach((x) => x.classList.toggle('active', x === b));
    };
  });
  pop.querySelector('[data-act="cancel"]').onclick = close;
  pop.querySelector('[data-act="ok"]').onclick = async () => {
    try {
      const r = await apiSend('POST', '/categories/delete', { name, moveTo: target });
      applyCategoryMove(name, target);
      onMoved && onMoved(target);
      toast(`已刪除分類「${name}」，${r.moved} 個專案移到「${target}」`);
      close();
    } catch { toast('刪除失敗，請稍後再試'); }
  };
}

function promptNewCategory(triggerEl, onSelect) {
  const menu = document.getElementById('globalDropdownMenu');
  const rect = triggerEl.getBoundingClientRect();
  menu.style.left = rect.left + 'px';
  menu.style.top = (rect.bottom + 6) + 'px';
  menu.style.minWidth = Math.max(rect.width, 180) + 'px';
  menu.classList.remove('open');
  void menu.offsetWidth;
  menu.innerHTML = `<div style="padding:6px"><input type="text" id="newCatInput" placeholder="新分類名稱，按 Enter 新增" style="width:100%;border:1px solid var(--field-border);background:var(--field-bg);border-radius:8px;padding:7px 9px;font-size:12.5px;color:var(--text);outline:none"></div>`;
  menu.classList.add('open');
  const input = menu.querySelector('#newCatInput');
  input.focus();
  input.addEventListener('click', (e) => e.stopPropagation());

  const closeMenu = () => { menu.classList.remove('open'); document.removeEventListener('click', closeMenu); };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const name = input.value.trim();
      if (name) {
        if (!state.categories.includes(name)) {
          state.categories.push(name);
          state.categories.sort();
          renderFilterChips();
        }
        onSelect(name);
      }
      closeMenu();
    } else if (e.key === 'Escape') {
      closeMenu();
    }
  });
  setTimeout(() => document.addEventListener('click', closeMenu), 0);
}

// ---------- Context menu (right-click) ----------

function openContextMenu(x, y, items) {
  const menu = document.getElementById('globalDropdownMenu');
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.style.minWidth = '170px';
  menu.classList.remove('open');
  void menu.offsetWidth;
  menu.innerHTML = items.map((it, i) => `<div class="dropdown-item ${it.danger ? 'danger' : ''}" data-i="${i}">${it.label}</div>`).join('');
  menu.classList.add('open');

  const closeMenu = () => { menu.classList.remove('open'); document.removeEventListener('click', closeMenu); };
  setTimeout(() => document.addEventListener('click', closeMenu), 0);

  menu.querySelectorAll('.dropdown-item').forEach((el, i) => {
    el.onclick = (e) => { e.stopPropagation(); items[i].onSelect(); closeMenu(); };
  });
}

// ---------- Panel show/close ----------
// The motion itself lives in cloth.js (ClothFX): the panel is rasterized
// and drawn as a warped mesh that's sucked into / bursts out of whatever
// opened it, corner-first like macOS's Genie. The real DOM panel stays
// invisible while the mesh stands in for it, then swaps back in.

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Re-find the opener at close time (cards re-render while a panel is open,
// so a stored element reference can go stale); fall back to where it was.
function originRectOf(panel) {
  const el = panel._originSelector && document.querySelector(panel._originSelector);
  const r = el && el.getBoundingClientRect();
  if (r && r.width > 0 && r.height > 0) return { x: r.left, y: r.top, w: r.width, h: r.height };
  return panel._originRect;
}

function pulse(el) {
  if (!el) return;
  el.classList.remove('absorb-pulse');
  void el.offsetWidth;
  el.classList.add('absorb-pulse');
  el.addEventListener('animationend', () => el.classList.remove('absorb-pulse'), { once: true });
}

// Plain scale+fade, only used if WebGL or the snapshot isn't available.
function fallbackAnimate(panel, origin, direction) {
  const r = panel.getBoundingClientRect();
  panel.style.transformOrigin = origin
    ? `${origin.x + origin.w / 2 - r.left}px ${origin.y + origin.h / 2 - r.top}px`
    : '50% 50%';
  const frames = [{ transform: 'scale(0.2)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }];
  panel._fallbackAnim = panel.animate(direction === 'open' ? frames : frames.slice().reverse(),
    { duration: 260, easing: 'ease-out', fill: 'forwards' });
  return panel._fallbackAnim;
}

function openPanel(panel, sourceEl, originSelector) {
  const token = (panel._token = {});
  if (panel._fallbackAnim) { panel._fallbackAnim.cancel(); panel._fallbackAnim = null; }
  document.getElementById('backdrop').classList.add('show');
  panel.classList.remove('closing');
  panel.classList.add('show');
  panel.style.opacity = '0';
  panel.style.pointerEvents = 'none';

  const r = sourceEl ? sourceEl.getBoundingClientRect() : null;
  panel._originRect = r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
  panel._originSelector = originSelector || null;

  const reveal = () => {
    if (panel._token !== token) return;
    panel.style.opacity = '1';
    panel.style.pointerEvents = '';
  };
  if (prefersReducedMotion() || document.hidden || !panel._originRect) { reveal(); return; }

  pulse(sourceEl);
  ClothFX.play({ el: panel, target: panel._originRect, direction: 'open', onEnd: reveal }).then((res) => {
    if (panel._token !== token) return; // this panel's own close/reopen already owns cleanup
    if (res === false) { reveal(); fallbackAnimate(panel, panel._originRect, 'open'); return; }
    if (res === 'cancelled') {
      // A different panel's open interrupted this one (ClothFX only plays one
      // animation at a time) before it ever became visible. Previously this
      // left the panel stuck at opacity:0/pointer-events:none with class
      // "show" and the backdrop still up - invisible and unclickable until
      // the backdrop was clicked or the panel was reopened.
      panel.classList.remove('show');
      panel.style.opacity = '0'; panel.style.pointerEvents = '';
      const anyOpen = ['detailPanel', 'newPanel', 'routinePanel'].some((id) => id !== panel.id && document.getElementById(id).classList.contains('show'));
      if (!anyOpen) document.getElementById('backdrop').classList.remove('show');
    }
  });
}

function closePanel(panel, onDone) {
  const token = (panel._token = {});
  panel.classList.add('closing');
  panel.classList.remove('show');
  panel.style.pointerEvents = 'none';
  state.openProjectId = null;

  const finish = () => {
    if (panel._token !== token) return;
    panel.classList.remove('closing');
    panel.style.opacity = '0';
    panel.style.pointerEvents = '';
    if (panel._fallbackAnim) { panel._fallbackAnim.cancel(); panel._fallbackAnim = null; }
    panel.innerHTML = '';
    const anyOpen = ['detailPanel', 'newPanel', 'routinePanel'].some((id) => id !== panel.id && document.getElementById(id).classList.contains('show'));
    if (!anyOpen) document.getElementById('backdrop').classList.remove('show');
    onDone && onDone();
  };

  const target = originRectOf(panel);
  const interrupted = ClothFX.cancel();
  const sameOpen = interrupted && interrupted.el === panel && interrupted.direction === 'open';
  // Closed before the opening snapshot was even ready: nothing is on screen to animate.
  if (prefersReducedMotion() || document.hidden || !target || (sameOpen && interrupted.t == null)) { finish(); return; }

  ClothFX.play({
    el: panel, target, direction: 'close',
    fromT: sameOpen ? interrupted.t : undefined, // continue from mid-open instead of snapping back to full size
    onStart: () => { panel.style.opacity = '0'; },
    onEnd: () => pulse(panel._originSelector && document.querySelector(panel._originSelector)),
  }).then((res) => {
    if (res === false && panel._token === token) { fallbackAnimate(panel, target, 'close').onfinish = finish; return; }
    finish();
  });
}

function closeAllPanels() {
  const detail = document.getElementById('detailPanel');
  if (detail.classList.contains('show')) closePanel(detail);
  const newPanel = document.getElementById('newPanel');
  if (newPanel.classList.contains('show')) closePanel(newPanel);
  const routinePanel = document.getElementById('routinePanel');
  if (routinePanel.classList.contains('show')) closePanel(routinePanel);
}

document.getElementById('backdrop').addEventListener('click', closeAllPanels);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  // Close just the topmost layer per press: a dropdown/date-popup sitting
  // on top of a panel closes first, and only a second Esc closes the panel
  // itself — otherwise editing a field's picker would blow away the whole
  // detail panel in one keystroke.
  const openMenus = ['globalDropdownMenu', 'sortMenu', 'globalDatePopup']
    .map((id) => document.getElementById(id))
    .filter((el) => el.classList.contains('open'));
  if (openMenus.length) {
    openMenus.forEach((el) => el.classList.remove('open'));
    return;
  }
  if (document.querySelector('.time-popup:not(.closing), .row-popover:not(.closing), .drive-shade')) return; // they close themselves
  closeAllPanels();
});

// ---------- Debounce ----------

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ---------- Theme ----------

function initTheme() {
  const saved = localStorage.getItem('pm-theme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);
  updateThemeIcon();
}
function isDarkNow() {
  const current = document.documentElement.getAttribute('data-theme');
  return current === 'dark' || (!current && window.matchMedia('(prefers-color-scheme: dark)').matches);
}
function updateThemeIcon() {
  document.getElementById('themeToggleBtn').textContent = isDarkNow() ? '☀️' : '🌙';
  // native caption buttons (desktop app) follow the theme too
  if (window.electronAPI && window.electronAPI.setTitleBarTheme) window.electronAPI.setTitleBarTheme(isDarkNow());
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', updateThemeIcon);
// Straight light <-> dark flip of what's actually on screen. (It used to
// cycle through a third "follow system" state, which is a click that
// visibly does nothing whenever the system theme matches the current one.)
document.getElementById('themeToggleBtn').onclick = (e) => {
  const next = isDarkNow() ? 'light' : 'dark';
  const apply = () => {
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('pm-theme', next);
    updateThemeIcon();
  };
  if (RippleFX.busy) return; // a flood is already in progress
  if (prefersReducedMotion() || document.hidden) { apply(); return; }
  const r = e.currentTarget.getBoundingClientRect();
  RippleFX.play({
    origin: { x: r.left + r.width / 2, y: r.top + r.height / 2 },
    fromTheme: isDarkNow() ? 'dark' : 'light',
    toTheme: next,
    apply,
  }).then((ok) => {
    // No WebGL2 / snapshot failed before anything changed: plain cross-fade.
    if (!ok) { if (document.startViewTransition) document.startViewTransition(apply); else apply(); }
  });
};

// ---------- View switch ----------

document.getElementById('viewListBtn').onclick = () => setView('list');
document.getElementById('viewCalendarBtn').onclick = () => setView('calendar');
function setView(v) {
  if (v === state.view) return;
  transitionSwitch(() => {
    state.view = v;
    document.getElementById('viewListBtn').classList.toggle('active', v === 'list');
    document.getElementById('viewCalendarBtn').classList.toggle('active', v === 'calendar');
    renderCurrentView();
  });
}

// ---------- List layout switch (rows / cards) ----------

function syncLayoutSwitch() {
  document.querySelectorAll('#layoutSwitch button').forEach((b) => b.classList.toggle('active', b.dataset.layout === state.layout));
}
document.querySelectorAll('#layoutSwitch button').forEach((b) => {
  b.onclick = () => {
    if (b.dataset.layout === state.layout) return;
    transitionSwitch(() => {
      state.layout = b.dataset.layout;
      try { localStorage.setItem('pm-layout', state.layout); } catch {}
      syncLayoutSwitch();
      renderCurrentView();
    });
  };
});
syncLayoutSwitch();

// ---------- Calendar nav ----------

document.getElementById('calPrevBtn').onclick = () => { state.calendarMonth.setMonth(state.calendarMonth.getMonth() - 1); renderCalendar(); };
document.getElementById('calNextBtn').onclick = () => { state.calendarMonth.setMonth(state.calendarMonth.getMonth() + 1); renderCalendar(); };
document.getElementById('calTodayBtn').onclick = () => { state.calendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1); renderCalendar(); };

// ---------- Search / sort / archive toggle ----------

document.getElementById('searchInput').oninput = debounce((e) => { state.filters.search = e.target.value; renderCurrentView(); }, 200);
document.getElementById('showArchivedToggle').onchange = (e) => {
  transitionSwitch(() => { state.filters.showArchived = e.target.checked; renderCurrentView(); });
};

const sortTrigger = document.getElementById('sortTrigger');
const sortMenu = document.getElementById('sortMenu');
sortTrigger.onclick = (e) => {
  e.stopPropagation();
  const rect = sortTrigger.getBoundingClientRect();
  sortMenu.style.left = rect.left + 'px';
  sortMenu.style.top = (rect.bottom + 6) + 'px';
  sortMenu.innerHTML = SORT_OPTIONS.map((o) => `<div class="dropdown-item ${o.key === state.sortKey ? 'selected' : ''}" data-key="${o.key}">${o.label}${o.key === state.sortKey ? (state.sortDir === 'asc' ? ' ↑' : ' ↓') : ''}</div>`).join('');
  sortMenu.classList.add('open');
  const closeMenu = () => { sortMenu.classList.remove('open'); document.removeEventListener('click', closeMenu); };
  setTimeout(() => document.addEventListener('click', closeMenu), 0);
  sortMenu.querySelectorAll('.dropdown-item').forEach((item) => {
    item.onclick = (e2) => {
      e2.stopPropagation();
      const key = item.dataset.key;
      if (key === state.sortKey) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      else { state.sortKey = key; state.sortDir = 'asc'; }
      sortTrigger.textContent = `排序：${SORT_OPTIONS.find((o) => o.key === key).label} ▾`;
      closeMenu();
      renderCurrentView();
    };
  });
};

// ---------- Settings: Google account ----------

document.getElementById('settingsBtn').onclick = (e) => {
  e.stopPropagation();
  const btn = e.currentTarget;
  if (document.querySelector('.row-popover.settings-pop:not(.closing)')) { rowPopoverClose && rowPopoverClose(); return; }
  const { pop } = showRowPopover(btn, '<div class="gs-body"><div class="gs-line dim">讀取中…</div></div><div class="bk-body"></div>', 'settings-pop');
  renderGoogleSettings(pop);
  renderBackupSettings(pop);
};

function calendarStatusText(c) {
  if (!c) return '尚未同步';
  if (c.running) return '同步中…';
  if (c.error) return `<span class="gs-err">失敗（${escapeHtml(c.error)}）</span>`;
  if (!c.lastSync) return c.calendarId ? '等待下次同步' : '尚未同步';
  const t = new Date(c.lastSync);
  return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')} · ${c.eventCount} 個活動`;
}

// Google Calendar changes (pulled by the main process) -> reload the data,
// but never under an open panel or a running animation — wait for those.
function reloadFromDisk() {
  const busy = state.holdRender || document.querySelector('.jelly-panel.show') || (typeof CompleteFX !== 'undefined' && CompleteFX.busy);
  if (busy) { setTimeout(reloadFromDisk, 1500); return; }
  loadAll().then(() => toast('已從 Google 日曆同步更新'));
}
if (window.electronAPI && window.electronAPI.onDataChanged) window.electronAPI.onDataChanged(reloadFromDisk);

async function renderGoogleSettings(pop) {
  const body = pop.querySelector('.gs-body');
  const api = window.electronAPI && window.electronAPI.google;
  if (!api) {
    body.innerHTML = `<div class="pp-head"><span>Google 帳號</span></div><div class="gs-line dim">請在桌面版 App 裡設定 Google 帳號。</div>`;
    return;
  }
  const st = await api.status();
  if (!st.ok) { body.innerHTML = `<div class="gs-line err">${escapeHtml(st.error)}</div>`; return; }
  const head = `<div class="pp-head"><span>Google 帳號</span>${st.connected ? '<b class="gs-badge">已連結</b>' : ''}</div>`;
  if (!st.hasCredentials) {
    body.innerHTML = head + `<div class="gs-line err">找不到金鑰檔 data\\google-credentials.json</div>`;
    return;
  }
  if (!st.connected) {
    body.innerHTML = head + `
      <div class="gs-line dim">連結後可以寄 Email 提醒、同步 Google 日曆。會開啟瀏覽器請你登入並同意。</div>
      <button class="btn-primary gs-btn" data-act="connect">連結 Google 帳號</button>`;
  } else {
    body.innerHTML = head + `
      <div class="gs-account">👤 ${escapeHtml(st.email || '（未知帳號）')}</div>
      <div class="gs-perms">
        <span class="${st.canMail ? 'on' : 'off'}">${st.canMail ? '✓' : '✕'} 寄信</span>
        <span class="${st.canCalendar ? 'on' : 'off'}">${st.canCalendar ? '✓' : '✕'} 日曆</span>
        <span class="${st.canDrive ? 'on' : 'off'}">${st.canDrive ? '✓' : '✕'} 雲端硬碟</span>
      </div>
      ${st.canMail && st.canCalendar && st.canDrive ? '' : `<div class="gs-line dim">有權限還沒開啟（例如新加的雲端硬碟）：按「重新連結」並勾選全部權限。</div>
      <button class="btn-primary gs-btn" data-act="connect">重新連結</button>`}
      ${st.canCalendar ? `<div class="gs-cal">
        <div class="gs-cal-line">📅 日曆同步：${calendarStatusText(st.calendar)}</div>
        <button class="btn-ghost" data-act="sync" ${st.calendar && st.calendar.running ? 'disabled' : ''}>立即同步</button>
      </div>` : ''}
      <div class="gs-actions">
        <button class="btn-ghost" data-act="mail" ${st.canMail ? '' : 'disabled'}>寄測試信</button>
        <button class="btn-ghost gs-danger" data-act="disconnect">中斷連結</button>
      </div>`;
  }
  body.querySelectorAll('[data-act]').forEach((b) => {
    b.onclick = async () => {
      const act = b.dataset.act;
      b.disabled = true;
      if (act === 'connect') {
        b.textContent = '請在瀏覽器完成登入…';
        const r = await api.connect();
        if (!r.ok) toast('連結失敗：' + r.error);
        else if (r.missing && r.missing.length) toast('已連結，但有權限沒有勾選，部分功能無法使用');
        else toast('已連結 Google 帳號');
      } else if (act === 'mail') {
        b.textContent = '寄送中…';
        const r = await api.testMail();
        toast(r.ok ? `測試信已寄到 ${r.to}` : '寄信失敗：' + r.error);
      } else if (act === 'sync') {
        b.textContent = '同步中…';
        const r = await api.calendarSync();
        toast(!r.ok ? '同步失敗：' + r.error : r.calendar.error ? '同步失敗：' + r.calendar.error : '已與 Google 日曆同步');
      } else if (act === 'disconnect') {
        const r = await api.disconnect();
        toast(r.ok ? '已中斷連結' : '中斷失敗：' + r.error);
      }
      if (pop.isConnected) renderGoogleSettings(pop);
    };
  });
}

// ---------- Routines (recurring tasks) ----------
// Same rules as routines.js on the server.

const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];
const isoOfDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const todayIso = () => isoOfDate(new Date());

function routineOccursOn(r, iso) {
  if (!r || r.archived) return false;
  if (r.startDate && iso < r.startDate) return false;
  if (r.endDate && iso > r.endDate) return false;
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const rule = r.rule || {};
  if (rule.type === 'daily') return true;
  if (rule.type === 'weekly') return (rule.weekdays || []).includes(date.getDay());
  if (rule.type === 'monthly') {
    const last = new Date(y, m, 0).getDate();
    return (rule.monthDays || []).some((md) => md === d || (md > last && d === last));
  }
  return false;
}

function routineStreak(r) {
  const today = todayIso();
  let n = 0;
  const d = new Date();
  for (let i = 0; i < 800; i++) {
    const iso = isoOfDate(d);
    if (r.startDate && iso < r.startDate) break;
    if (routineOccursOn(r, iso)) {
      if (r.log && r.log[iso]) n++;
      else if (iso !== today) break;
    }
    d.setDate(d.getDate() - 1);
  }
  return n;
}

// completion over the last 30 days (today counts only once done)
function routineRate(r) {
  const today = todayIso();
  let due = 0, done = 0;
  const d = new Date();
  for (let i = 0; i < 30; i++) {
    const iso = isoOfDate(d);
    if (routineOccursOn(r, iso) && (iso !== today || (r.log && r.log[iso]))) { due++; if (r.log && r.log[iso]) done++; }
    d.setDate(d.getDate() - 1);
  }
  return due ? Math.round((done / due) * 100) : null;
}

function ruleText(r) {
  const rule = r.rule || {};
  let t = rule.type === 'daily' ? '每天'
    : rule.type === 'weekly' ? (rule.weekdays.length === 7 ? '每天' : '每週' + rule.weekdays.map((w) => WEEKDAY_LABELS[w]).join('、'))
    : '每月 ' + rule.monthDays.join('、') + ' 號';
  if (r.endDate) t += `，到 ${fmtFullDate(r.endDate)}`;
  return t;
}

let routineStripCollapsed = (() => { try { return localStorage.getItem('pm-routines-collapsed') === '1'; } catch { return false; } })();

function renderRoutineStrip() {
  const strip = document.getElementById('routineStrip');
  if (state.view !== 'list') { strip.hidden = true; return; }
  strip.hidden = false;
  const today = todayIso();
  const due = state.routines.filter((r) => routineOccursOn(r, today));
  const doneCount = due.filter((r) => r.log && r.log[today]).length;
  const active = state.routines.filter((r) => !r.archived && (!r.endDate || r.endDate >= today));
  strip.classList.toggle('collapsed', routineStripCollapsed);
  strip.innerHTML = `
    <div class="rt-head">
      <button type="button" class="rt-toggle" title="${routineStripCollapsed ? '展開' : '收合'}">
        <span class="caret">▸</span> 今日例行
        ${due.length ? `<span class="rt-count ${doneCount === due.length ? 'all' : ''}">${doneCount}/${due.length}</span>` : ''}
      </button>
      <div class="rt-progress"><div style="width:${due.length ? (doneCount / due.length) * 100 : 0}%"></div></div>
      <button type="button" class="btn-ghost rt-manage">管理例行</button>
    </div>
    <div class="rt-body"><div class="rt-body-inner">
      ${due.length ? `<div class="rt-chips">${due.map((r) => {
        const on = !!(r.log && r.log[today]);
        const n = routineStreak(r);
        return `<button type="button" class="rt-chip ${on ? 'on' : ''}" data-id="${r.id}">
          <span class="rt-check">${on ? '✓' : ''}</span>
          <span class="rt-title">${escapeHtml(r.title)}</span>
          ${n ? `<span class="rt-streak">🔥${n}</span>` : ''}
        </button>`;
      }).join('')}</div>`
      : `<div class="rt-empty">${active.length ? '今天沒有例行任務，休息一下 ☕' : '還沒有例行任務：每天、每週或每月重複的事，放在這裡打卡。'}
         ${active.length ? '' : '<button type="button" class="btn-ghost rt-new">＋ 新增例行任務</button>'}</div>`}
    </div></div>`;

  strip.querySelector('.rt-toggle').onclick = () => {
    routineStripCollapsed = !routineStripCollapsed;
    try { localStorage.setItem('pm-routines-collapsed', routineStripCollapsed ? '1' : '0'); } catch {}
    strip.classList.toggle('collapsed', routineStripCollapsed);
  };
  strip.querySelector('.rt-manage').onclick = (e) => openRoutinePanel(e.currentTarget);
  const newBtn = strip.querySelector('.rt-new');
  if (newBtn) newBtn.onclick = (e) => openRoutinePanel(e.currentTarget, 'new');
  strip.querySelectorAll('.rt-chip').forEach((chip) => {
    chip.onclick = () => checkInRoutine(chip.dataset.id, today, !chip.classList.contains('on'), chip);
  });
}

async function checkInRoutine(id, date, done, chipEl) {
  const r = state.routines.find((x) => x.id === id);
  if (!r) return;
  r.log = r.log || {};
  if (done) r.log[date] = true; else delete r.log[date];
  if (chipEl && !prefersReducedMotion()) {
    chipEl.classList.toggle('on', done);
    chipEl.querySelector('.rt-check').textContent = done ? '✓' : '';
    chipEl.classList.remove('jelly');
    void chipEl.offsetWidth;
    chipEl.classList.add('jelly');
  }
  try {
    const updated = await apiSend('POST', `/routines/${id}/log`, { date, done });
    Object.assign(r, updated);
  } catch { toast('儲存失敗，請稍後再試'); }
  setTimeout(renderRoutineStrip, chipEl ? 420 : 0); // let the jelly finish before redrawing
  const panel = document.getElementById('routinePanel');
  if (panel.classList.contains('show') && panel._selected === id) renderRoutineEditor(panel, r);
  if (done) {
    const n = routineStreak(r);
    toast(n > 1 ? `完成「${r.title}」· 連續 ${n} 次 🔥` : `完成「${r.title}」`);
  }
}

// ---------- Routine manager panel ----------

function openRoutinePanel(sourceEl, selectId) {
  const panel = document.getElementById('routinePanel');
  panel._selected = selectId || (state.routines.find((r) => !r.archived) || {}).id || 'new';
  renderRoutinePanel(panel);
  openPanel(panel, sourceEl, null);
}

function renderRoutinePanel(panel) {
  const list = [...state.routines].sort((a, b) => (a.archived - b.archived) || a.title.localeCompare(b.title, 'zh-Hant'));
  panel.innerHTML = `
    <div class="panel-header">
      <h2>例行任務</h2>
      <span class="panel-close-hint">點空白處或 Esc 關閉</span>
    </div>
    <div class="rt-manager">
      <div class="rt-list">
        <button type="button" class="rt-item rt-item-new ${panel._selected === 'new' ? 'on' : ''}" data-id="new">＋ 新增例行任務</button>
        ${list.map((r) => {
          const ended = r.archived || (r.endDate && r.endDate < todayIso());
          const n = routineStreak(r);
          return `<button type="button" class="rt-item ${panel._selected === r.id ? 'on' : ''} ${ended ? 'ended' : ''}" data-id="${r.id}">
            <span class="rt-item-title">${escapeHtml(r.title)}</span>
            <span class="rt-item-sub">${escapeHtml(ruleText(r))}${ended ? ' · 已結束' : ''}${n ? ` · 🔥${n}` : ''}</span>
          </button>`;
        }).join('')}
      </div>
      <div class="rt-editor"></div>
    </div>`;
  panel.querySelectorAll('.rt-item').forEach((b) => {
    b.onclick = () => { panel._selected = b.dataset.id; renderRoutinePanel(panel); };
  });
  const r = panel._selected === 'new' ? null : state.routines.find((x) => x.id === panel._selected);
  renderRoutineEditor(panel, r);
}

function renderRoutineEditor(panel, r) {
  const box = panel.querySelector('.rt-editor');
  const isNew = !r;
  const draft = r
    ? JSON.parse(JSON.stringify({ title: r.title, rule: r.rule, startDate: r.startDate, endDate: r.endDate, remind: { enabled: true, time: '09:00', email: true, ...(r.remind || {}) } }))
    : { title: '', rule: { type: 'daily', weekdays: [new Date().getDay()], monthDays: [new Date().getDate()] }, startDate: todayIso(), endDate: null, remind: { enabled: true, time: '09:00', email: true } };
  draft.rule.weekdays = draft.rule.weekdays && draft.rule.weekdays.length ? draft.rule.weekdays : [new Date().getDay()];
  draft.rule.monthDays = draft.rule.monthDays && draft.rule.monthDays.length ? draft.rule.monthDays : [new Date().getDate()];

  box.innerHTML = `
    <div class="field"><label>名稱</label><input type="text" id="rt-title" placeholder="例如：雅思聽力 30 分鐘" value="${escapeHtml(draft.title)}"></div>
    <div class="field">
      <label>重複</label>
      <div class="view-switch rt-type">
        ${[['daily', '每天'], ['weekly', '每週'], ['monthly', '每月']].map(([t, l]) => `<button type="button" data-type="${t}">${l}</button>`).join('')}
      </div>
      <div class="rt-weekdays">${[1, 2, 3, 4, 5, 6, 0].map((w) => `<button type="button" class="chip" data-w="${w}">${WEEKDAY_LABELS[w]}</button>`).join('')}</div>
      <div class="rt-monthdays">${Array.from({ length: 31 }, (_, i) => `<button type="button" class="md" data-d="${i + 1}">${i + 1}</button>`).join('')}</div>
      <div class="field-hint rt-md-hint">選 29–31 號時，遇到沒有那天的月份會改在該月最後一天。</div>
    </div>
    <div class="field-row">
      <div class="field"><label>開始日</label><button type="button" class="dropdown-trigger dropdown-trigger-block" id="rt-start"></button></div>
      <div class="field"><label>結束重複</label><button type="button" class="dropdown-trigger dropdown-trigger-block" id="rt-end"></button></div>
    </div>
    <div class="field">
      <label>提醒</label>
      <div class="remind-row">
        <button type="button" class="chip" id="rt-remind-on">🔔 提醒我</button>
        <button type="button" class="dropdown-trigger" id="rt-time" title="提醒時間"></button>
        <button type="button" class="chip" id="rt-email">✉️ 同時寄 Email</button>
      </div>
    </div>
    ${r ? `<div class="field">
      <label>打卡紀錄</label>
      <div class="rt-stats">
        <div><b>${routineStreak(r)}</b><span>連續次數 🔥</span></div>
        <div><b>${routineRate(r) == null ? '—' : routineRate(r) + '%'}</b><span>近 30 天完成率</span></div>
        <div><b>${Object.keys(r.log || {}).length}</b><span>累計打卡</span></div>
      </div>
      ${heatmapHtml(r)}
    </div>` : ''}
    <div class="panel-footer">
      ${r ? '<button type="button" class="btn-ghost" id="rt-delete" style="color:var(--danger)">刪除</button>' : '<span></span>'}
      <button type="button" class="btn-primary" id="rt-save">${isNew ? '建立例行任務' : '儲存變更'}</button>
    </div>`;

  const q = (sel) => box.querySelector(sel);
  const paint = () => {
    box.querySelectorAll('.rt-type button').forEach((b) => b.classList.toggle('active', b.dataset.type === draft.rule.type));
    q('.rt-weekdays').hidden = draft.rule.type !== 'weekly';
    q('.rt-monthdays').hidden = draft.rule.type !== 'monthly';
    q('.rt-md-hint').hidden = !(draft.rule.type === 'monthly' && draft.rule.monthDays.some((d) => d > 28));
    box.querySelectorAll('.rt-weekdays .chip').forEach((c) => c.classList.toggle('active', draft.rule.weekdays.includes(Number(c.dataset.w))));
    box.querySelectorAll('.rt-monthdays .md').forEach((c) => c.classList.toggle('active', draft.rule.monthDays.includes(Number(c.dataset.d))));
    q('#rt-start').textContent = fmtFullDate(draft.startDate) + ' 📅';
    q('#rt-end').textContent = (draft.endDate ? fmtFullDate(draft.endDate) : '不結束') + ' 📅';
    q('#rt-remind-on').classList.toggle('active', draft.remind.enabled);
    q('#rt-time').textContent = '🕘 ' + draft.remind.time;
    q('#rt-time').disabled = !draft.remind.enabled;
    q('#rt-email').classList.toggle('active', draft.remind.enabled && draft.remind.email);
    q('#rt-email').disabled = !draft.remind.enabled;
  };
  const pop = (el) => { el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); };
  const toggleIn = (arr, v) => (arr.includes(v) ? arr.filter((x) => x !== v) : arr.concat(v));

  box.querySelectorAll('.rt-type button').forEach((b) => { b.onclick = () => { draft.rule.type = b.dataset.type; paint(); }; });
  box.querySelectorAll('.rt-weekdays .chip').forEach((c) => {
    c.onclick = () => { draft.rule.weekdays = toggleIn(draft.rule.weekdays, Number(c.dataset.w)); pop(c); paint(); };
  });
  box.querySelectorAll('.rt-monthdays .md').forEach((c) => {
    c.onclick = () => { draft.rule.monthDays = toggleIn(draft.rule.monthDays, Number(c.dataset.d)); pop(c); paint(); };
  });
  q('#rt-start').onclick = (e) => {
    e.stopPropagation();
    openDatePicker(q('#rt-start'), draft.startDate, (v) => { if (v) draft.startDate = v; paint(); });
  };
  q('#rt-end').onclick = (e) => {
    e.stopPropagation();
    openDatePicker(q('#rt-end'), draft.endDate, (v) => {
      if (v && v < draft.startDate) { toast('結束日不能早於開始日'); return; }
      draft.endDate = v; // 清除 = 不結束
      paint();
    });
  };
  q('#rt-remind-on').onclick = (e) => { draft.remind.enabled = !draft.remind.enabled; pop(e.currentTarget); paint(); };
  q('#rt-email').onclick = (e) => { draft.remind.email = !draft.remind.email; pop(e.currentTarget); paint(); };
  q('#rt-time').onclick = (e) => {
    e.stopPropagation();
    openTimePicker(q('#rt-time'), draft.remind.time, (v) => { draft.remind.time = v; paint(); });
  };
  box.querySelectorAll('.rt-heat .cell[data-date]').forEach((c) => {
    c.onclick = () => checkInRoutine(r.id, c.dataset.date, !c.classList.contains('done'));
  });

  q('#rt-save').onclick = async () => {
    draft.title = q('#rt-title').value.trim();
    if (!draft.title) { toast('請輸入名稱'); q('#rt-title').focus(); return; }
    if (draft.rule.type === 'weekly' && !draft.rule.weekdays.length) { toast('請至少選一個星期幾'); return; }
    if (draft.rule.type === 'monthly' && !draft.rule.monthDays.length) { toast('請至少選一個日期'); return; }
    try {
      const saved = isNew ? await apiSend('POST', '/routines', draft) : await apiSend('PUT', `/routines/${r.id}`, draft);
      if (isNew) state.routines.push(saved); else Object.assign(r, saved);
      panel._selected = saved.id;
      renderRoutinePanel(panel);
      renderRoutineStrip();
      toast(isNew ? `已建立「${saved.title}」` : '已儲存');
    } catch { toast('儲存失敗，請稍後再試'); }
  };
  const del = q('#rt-delete');
  if (del) del.onclick = async () => {
    if (del.dataset.confirm !== '1') { del.dataset.confirm = '1'; del.textContent = '再按一次確定刪除'; return; }
    try {
      await apiSend('DELETE', `/routines/${r.id}`);
      state.routines = state.routines.filter((x) => x.id !== r.id);
      panel._selected = (state.routines[0] || {}).id || 'new';
      renderRoutinePanel(panel);
      renderRoutineStrip();
      toast('已刪除例行任務');
    } catch { toast('刪除失敗，請稍後再試'); }
  };
  paint();
}

// 12 weeks × 7 days check-in grid, like the weekly sheet in the old Excel.
// Past scheduled days can be clicked to fix a missed check-in.
function heatmapHtml(r) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - start.getDay() - 7 * 11); // Sunday, 11 weeks back
  const todayStr = todayIso();
  let cols = '';
  for (let w = 0; w < 12; w++) {
    let cells = '';
    for (let d = 0; d < 7; d++) {
      const day = new Date(start);
      day.setDate(start.getDate() + w * 7 + d);
      const iso = isoOfDate(day);
      if (iso > todayStr) { cells += '<span class="cell future"></span>'; continue; }
      const due = routineOccursOn(r, iso);
      const done = !!(r.log && r.log[iso]);
      const cls = done ? 'done' : due ? (iso === todayStr ? 'today' : 'missed') : 'off';
      cells += `<span class="cell ${cls}" ${due || done ? `data-date="${iso}"` : ''} title="${day.getMonth() + 1}/${day.getDate()}${done ? ' ✓' : due ? ' 未完成' : ''}"></span>`;
    }
    cols += `<div class="col">${cells}</div>`;
  }
  return `<div class="rt-heat"><div class="rows">${['日', '', '二', '', '四', '', '六'].map((l) => `<span>${l}</span>`).join('')}</div>${cols}</div>
    <div class="field-hint">綠色＝完成，紅色＝漏掉；點過去的格子可以補打卡。</div>`;
}

// ---------- Settings: data backups ----------

function fmtBackupTime(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
const BACKUP_KIND = { auto: '自動', manual: '手動', 'before-restore': '還原前' };

async function renderBackupSettings(pop, showList = false) {
  const box = pop.querySelector('.bk-body');
  if (!box) return;
  let info;
  try { info = await apiGet('/backups'); } catch { box.innerHTML = '<div class="gs-line err">讀不到備份資訊（請重開 App 以啟用備份功能）</div>'; return; }
  const latest = info.backups[0];
  box.innerHTML = `
    <div class="pp-head"><span>資料備份</span></div>
    <div class="gs-line dim">每天自動備份一次，保留 14 天。${latest ? `最新：${fmtBackupTime(latest.savedAt)}` : '還沒有備份'}</div>
    <div class="gs-actions">
      <button class="btn-ghost" data-act="now">立即備份</button>
      <button class="btn-ghost" data-act="list">${showList ? '收起' : '還原…'}</button>
      <button class="btn-ghost" data-act="folder">開啟資料夾</button>
    </div>
    ${showList ? `<div class="bk-list">${info.backups.length ? info.backups.map((b) => `
      <div class="bk-row">
        <div class="bk-info">
          <b>${fmtBackupTime(b.savedAt)}</b> <span class="bk-kind ${b.kind}">${BACKUP_KIND[b.kind] || b.kind}</span>
          <div class="bk-meta">${b.projects == null ? '無法讀取' : `${b.projects} 個專案 · ${b.routines} 個例行`}</div>
        </div>
        <button class="btn-ghost bk-restore" data-name="${escapeHtml(b.name)}" ${b.projects == null ? 'disabled' : ''}>還原</button>
      </div>`).join('') : '<div class="gs-line dim">還沒有備份</div>'}</div>` : ''}`;

  box.querySelector('[data-act="now"]').onclick = async (e) => {
    e.currentTarget.disabled = true;
    try { await apiSend('POST', '/backups'); toast('已備份目前的資料'); } catch { toast('備份失敗'); }
    renderBackupSettings(pop, showList);
  };
  box.querySelector('[data-act="list"]').onclick = () => renderBackupSettings(pop, !showList);
  box.querySelector('[data-act="folder"]').onclick = async () => {
    if (!window.electronAPI) { toast('只有桌面版 App 能開啟資料夾'); return; }
    const err = await window.electronAPI.openPath(info.dir);
    if (err) toast('開啟失敗：' + err);
  };
  box.querySelectorAll('.bk-restore').forEach((b) => {
    b.onclick = async () => {
      if (b.dataset.confirm !== '1') {
        box.querySelectorAll('.bk-restore').forEach((x) => { x.dataset.confirm = ''; x.textContent = '還原'; x.classList.remove('gs-danger'); });
        b.dataset.confirm = '1';
        b.textContent = '確定還原？';
        b.classList.add('gs-danger');
        return;
      }
      b.disabled = true;
      b.textContent = '還原中…';
      try {
        const r = await apiSend('POST', `/backups/${encodeURIComponent(b.dataset.name)}/restore`);
        await loadAll();
        toast(`已還原：${r.projects} 個專案、${r.routines} 個例行（原本的資料已另存備份）`);
      } catch { toast('還原失敗'); }
      renderBackupSettings(pop, true);
    };
  });
}

// ---------- New project button ----------

document.getElementById('newProjectBtn').onclick = (e) => openNewPanel(e.currentTarget);

// ---------- Init ----------

initTheme();
loadAll();
