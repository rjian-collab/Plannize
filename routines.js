// Recurring routines ("例行任務") — kept apart from projects.
//
// routine = {
//   id, title,
//   rule: { type: 'daily' | 'weekly' | 'monthly', weekdays: [0-6], monthDays: [1-31] },
//   startDate: 'YYYY-MM-DD', endDate: 'YYYY-MM-DD' | null,   // null = repeats forever
//   remind: { enabled, time: 'HH:MM', email },
//   log: { 'YYYY-MM-DD': true },                             // check-ins
//   archived, createdAt, updatedAt
// }
// Shared by the server (API + reminder scheduling) and notify mode.

const pad = (n) => String(n).padStart(2, '0');
const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dateOf = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
const DEFAULT_REMIND = { enabled: true, time: '09:00', email: true };

// Does the routine fall on this local date?
function occursOn(r, iso) {
  if (!r || r.archived) return false;
  if (r.startDate && iso < r.startDate) return false;
  if (r.endDate && iso > r.endDate) return false;
  const d = dateOf(iso);
  const rule = r.rule || {};
  if (rule.type === 'daily') return true;
  if (rule.type === 'weekly') return (rule.weekdays || []).includes(d.getDay());
  if (rule.type === 'monthly') {
    const day = d.getDate();
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    // the 31st (etc.) lands on the month's last day in shorter months
    return (rule.monthDays || []).some((md) => md === day || (md > last && day === last));
  }
  return false;
}

function remindOf(r) {
  const x = r.remind || {};
  return {
    enabled: x.enabled !== false,
    time: /^\d{2}:\d{2}$/.test(x.time || '') ? x.time : DEFAULT_REMIND.time,
    email: x.email !== false,
  };
}

// Reminder times over the next `days` days (only ones still in the future).
function upcomingReminders(r, days = 14, now = new Date()) {
  const rem = remindOf(r);
  if (!rem.enabled || r.archived) return [];
  const [hh, mm] = rem.time.split(':').map(Number);
  const out = [];
  for (let i = 0; i <= days; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    const iso = isoOf(d);
    if (!occursOn(r, iso) || (r.log && r.log[iso])) continue;
    const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm);
    if (at > now) out.push({ iso, at });
  }
  return out;
}

// Consecutive completed occurrences, counting back from today (today only
// counts once it's done — an unchecked today doesn't break the streak yet).
function streak(r, today = isoOf(new Date())) {
  let n = 0;
  const d = dateOf(today);
  for (let i = 0; i < 800; i++) {
    const iso = isoOf(d);
    if (r.startDate && iso < r.startDate) break;
    if (occursOn(r, iso)) {
      if (r.log && r.log[iso]) n++;
      else if (iso !== today) break;
    }
    d.setDate(d.getDate() - 1);
  }
  return n;
}

function cleanRule(rule) {
  if (!rule || !['daily', 'weekly', 'monthly'].includes(rule.type)) return null;
  const ints = (a, lo, hi) => [...new Set((a || []).map(Number).filter((x) => Number.isInteger(x) && x >= lo && x <= hi))].sort((a, b) => a - b);
  const out = { type: rule.type, weekdays: ints(rule.weekdays, 0, 6), monthDays: ints(rule.monthDays, 1, 31) };
  if (out.type === 'weekly' && !out.weekdays.length) return null;
  if (out.type === 'monthly' && !out.monthDays.length) return null;
  return out;
}

function cleanRemind(x) {
  const r = remindOf({ remind: x || {} });
  return { enabled: r.enabled, time: /^([01]\d|2[0-3]):[0-5]\d$/.test(r.time) ? r.time : DEFAULT_REMIND.time, email: r.email };
}

const validDate = (s) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);

module.exports = { occursOn, remindOf, upcomingReminders, streak, cleanRule, cleanRemind, validDate, isoOf, DEFAULT_REMIND };
