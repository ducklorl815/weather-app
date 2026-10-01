'use strict';

function parseTime(hhmm) {
  const m = String(hhmm || '16:00').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return { hours: 16, minutes: 0 };
  return {
    hours: Math.min(23, Math.max(0, Number(m[1]))),
    minutes: Math.min(59, Math.max(0, Number(m[2])))
  };
}

function atLocalDate(base, hours, minutes) {
  const d = new Date(base.getTime());
  d.setSeconds(0, 0);
  d.setHours(hours, minutes, 0, 0);
  return d;
}

function parseStartAt(schedule) {
  if (!schedule?.startAt) return null;
  const d = new Date(schedule.startAt);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 以 startAt 為錨點，回傳第一個 > now 的 startAt + n * stepMs
 */
function nextFromAnchor(startAt, now, stepMs) {
  const step = Math.max(1, Number(stepMs) || 1);
  if (startAt > now) return new Date(startAt.getTime());
  const elapsed = now.getTime() - startAt.getTime();
  const n = Math.floor(elapsed / step) + 1;
  return new Date(startAt.getTime() + n * step);
}

/**
 * 計算下次執行時間（本機時區）。
 * schedule.startAt：排程起始／錨點；未到此時間不執行。
 * @param {object} schedule
 * @param {Date} [from]
 * @returns {Date}
 */
function computeNextRunAt(schedule, from = new Date()) {
  if (!schedule) return from;
  const now = new Date(from.getTime());
  const type = schedule.type;
  const startAt = parseStartAt(schedule);

  if (type === 'EveryNMinutes') {
    const interval = Math.max(1, Number(schedule.interval) || 1);
    if (startAt) {
      return nextFromAnchor(startAt, now, interval * 60 * 1000);
    }
    const next = new Date(now.getTime());
    next.setSeconds(0, 0);
    const mins = next.getMinutes();
    const add = interval - (mins % interval);
    if (!(add === interval && next > now)) {
      next.setMinutes(mins + (add === 0 ? interval : add));
    }
    if (next <= now) next.setMinutes(next.getMinutes() + interval);
    return next;
  }

  if (type === 'EveryNHours') {
    const interval = Math.max(1, Number(schedule.interval) || 1);
    if (startAt) {
      return nextFromAnchor(startAt, now, interval * 60 * 60 * 1000);
    }
    const next = new Date(now.getTime());
    next.setMinutes(0, 0, 0);
    const h = next.getHours();
    const add = interval - (h % interval);
    next.setHours(h + (add === 0 ? interval : add));
    if (next <= now) next.setHours(next.getHours() + interval);
    return next;
  }

  const { hours, minutes } = parseTime(schedule.time);
  // 日／週／月：不得早於 startAt
  const notBefore = startAt && startAt > now ? startAt : now;

  if (type === 'Daily') {
    let next = atLocalDate(notBefore, hours, minutes);
    if (next <= notBefore) {
      next = atLocalDate(notBefore, hours, minutes);
      next.setDate(next.getDate() + 1);
    }
    return next;
  }

  if (type === 'Weekly') {
    const days = (schedule.weekDays && schedule.weekDays.length)
      ? [...new Set(schedule.weekDays.map(Number))].sort((a, b) => a - b)
      : [1];
    for (let i = 0; i < 14; i++) {
      const cand = new Date(notBefore.getTime());
      cand.setDate(notBefore.getDate() + i);
      const dow = cand.getDay();
      if (!days.includes(dow)) continue;
      const at = atLocalDate(cand, hours, minutes);
      if (at > notBefore) return at;
    }
    const fallback = atLocalDate(notBefore, hours, minutes);
    fallback.setDate(fallback.getDate() + 7);
    return fallback;
  }

  if (type === 'Monthly') {
    const day = Math.min(31, Math.max(1, Number(schedule.dayOfMonth) || 1));
    const tryMonth = (base) => {
      const y = base.getFullYear();
      const m = base.getMonth();
      const lastDay = new Date(y, m + 1, 0).getDate();
      const useDay = Math.min(day, lastDay);
      return new Date(y, m, useDay, hours, minutes, 0, 0);
    };
    let next = tryMonth(notBefore);
    if (next <= notBefore) {
      const nextMonth = new Date(notBefore.getFullYear(), notBefore.getMonth() + 1, 1);
      next = tryMonth(nextMonth);
    }
    return next;
  }

  return now;
}

function scheduleSignature(schedule) {
  if (!schedule) return '';
  return JSON.stringify({
    type: schedule.type || '',
    interval: Number(schedule.interval) || 1,
    time: schedule.time || '',
    weekDays: Array.isArray(schedule.weekDays) ? [...schedule.weekDays].map(Number).sort((a, b) => a - b) : [],
    dayOfMonth: Number(schedule.dayOfMonth) || 1,
    startAt: schedule.startAt || '',
    timezone: schedule.timezone || 'Asia/Taipei'
  });
}

function formatScheduleSummary(schedule) {
  if (!schedule) return '—';
  const t = schedule.time || '16:00';
  let base;
  switch (schedule.type) {
    case 'EveryNMinutes':
      base = `每 ${schedule.interval || 1} 分鐘`;
      break;
    case 'EveryNHours':
      base = `每 ${schedule.interval || 1} 小時`;
      break;
    case 'Daily':
      base = `每天 ${t}`;
      break;
    case 'Weekly': {
      const names = ['日', '一', '二', '三', '四', '五', '六'];
      const days = (schedule.weekDays || []).map((d) => names[d] || d).join('、');
      base = `每週${days || '—'} ${t}`;
      break;
    }
    case 'Monthly':
      base = `每月 ${schedule.dayOfMonth || 1} 日 ${t}`;
      break;
    default:
      base = String(schedule.type || '—');
  }
  const startAt = parseStartAt(schedule);
  if (!startAt) return base;
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${startAt.getMonth() + 1}/${startAt.getDate()} ${p(startAt.getHours())}:${p(startAt.getMinutes())}`;
  return `${base}（起 ${stamp}）`;
}

module.exports = {
  computeNextRunAt,
  formatScheduleSummary,
  parseTime,
  scheduleSignature,
  parseStartAt
};
