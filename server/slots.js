// Collection-slot logic.
//
// Rule (as specified by The Outlook at Fox's):
//  - Order placed before cutoff1 (default 09:15) -> can choose EITHER collection1 (10:30) OR collection2 (13:00)
//  - Order placed between cutoff1 and cutoff2 (default 11:15) -> can ONLY choose collection2 (13:00),
//    because the 10:30 kitchen email has already gone out
//  - Order placed after cutoff2 -> no same-day collection slots left

function timeToMinutes(str) {
  const [h, m] = str.split(':').map(Number);
  return h * 60 + m;
}

function nowMinutesInTZ(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(date);
  const h = parseInt(parts.find(p => p.type === 'hour').value, 10);
  const m = parseInt(parts.find(p => p.type === 'minute').value, 10);
  return h * 60 + m;
}

function getWeekdayName(date, timeZone) {
  return new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'long' }).format(date);
}

function isOpenToday(settings, now = new Date()) {
  const openDays = settings.openDays && settings.openDays.length
    ? settings.openDays
    : ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  return openDays.includes(getWeekdayName(now, settings.timezone || 'Europe/London'));
}

function getAvailableSlots(settings, now = new Date()) {
  if (!isOpenToday(settings, now)) {
    return [];
  }
  const nowMins = nowMinutesInTZ(now, settings.timezone || 'Europe/London');
  const cutoff1 = timeToMinutes(settings.cutoff1);
  const cutoff2 = timeToMinutes(settings.cutoff2);

  if (nowMins < cutoff1) {
    return [settings.collection1, settings.collection2];
  }
  if (nowMins < cutoff2) {
    return [settings.collection2];
  }
  return [];
}

function isSlotValid(settings, slot, now = new Date()) {
  return getAvailableSlots(settings, now).includes(slot);
}

// ---------- Advance ordering: "which day is this order for" ----------
//
// Staff/customers can place an order today for TODAY, or for a future day within the
// advanceDays window (default 7) — as long as that future day is one of the site's open
// days. Ordering FOR today is only allowed before the site's last-order cut-off:
//  - Bundle sites (Grab & Go): reuses the existing cutoff1/cutoff2 slot system — today is
//    orderable if getAvailableSlots() returns anything.
//  - Cart sites (On-Site Café): uses a dedicated settings.lastOrderTime, e.g. "14:00".
//    If not set, today has no time cut-off (only the "is today an open day" check applies).

function isBeforeLastOrderTime(settings, now = new Date()) {
  if (!settings.lastOrderTime) return true;
  const nowMins = nowMinutesInTZ(now, settings.timezone || 'Europe/London');
  return nowMins < timeToMinutes(settings.lastOrderTime);
}

// Returns [{ dateKey: 'YYYY-MM-DD', weekday: 'Monday', isToday: true }, ...] for every
// open day from today out to `advanceDays` days ahead (inclusive).
function getUpcomingOpenDates(settings, advanceDays = 7, now = new Date()) {
  const timeZone = settings.timezone || 'Europe/London';
  const openDays = settings.openDays && settings.openDays.length
    ? settings.openDays
    : ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now);
  const y = parseInt(parts.find(p => p.type === 'year').value, 10);
  const m = parseInt(parts.find(p => p.type === 'month').value, 10);
  const d = parseInt(parts.find(p => p.type === 'day').value, 10);

  const results = [];
  for (let i = 0; i <= advanceDays; i++) {
    const dt = new Date(Date.UTC(y, m - 1, d + i));
    const dateKey = dt.toISOString().slice(0, 10);
    const weekday = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'long' }).format(dt);
    if (!openDays.includes(weekday)) continue;
    results.push({ dateKey, weekday, isToday: i === 0 });
  }
  return results;
}

// The full picker list for a given site, filtering out "today" if it's no longer orderable.
function getSelectableForDates(site, now = new Date()) {
  const advanceDays = site.settings.advanceDays || 7;
  const dates = getUpcomingOpenDates(site.settings, advanceDays, now);
  const todayStillOrderable = site.type === 'cart'
    ? (isOpenToday(site.settings, now) && isBeforeLastOrderTime(site.settings, now))
    : getAvailableSlots(site.settings, now).length > 0;
  return dates.filter(d => !d.isToday || todayStillOrderable);
}

function isForDateValid(site, forDateKey, now = new Date()) {
  return getSelectableForDates(site, now).some(d => d.dateKey === forDateKey);
}

module.exports = {
  getAvailableSlots, isSlotValid, timeToMinutes, nowMinutesInTZ, isOpenToday, getWeekdayName,
  isBeforeLastOrderTime, getUpcomingOpenDates, getSelectableForDates, isForDateValid
};
