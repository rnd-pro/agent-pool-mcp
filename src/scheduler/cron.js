/**
 * Minimal cron expression parser.
 * Supports: star, star/N (step), N, N-M (range), N,M (list), MON-FRI for weekdays (0=Sun, 6=Sat).
 * 5 fields: minute hour day month weekday
 */

const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
const DAYS = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };

function parseField(value, target, min, max, aliases) {
  if (value === '*') return true;
  const parts = value.split(',');
  for (let part of parts) {
    let step = 1;
    let range = part;
    if (part.includes('/')) {
      const split = part.split('/');
      range = split[0];
      step = parseInt(split[1], 10);
      if (isNaN(step)) return false;
    }
    if (range === '*') {
      if ((target - min) % step === 0) return true;
      continue;
    }
    let start, end;
    if (range.includes('-')) {
      const bounds = range.split('-');
      start = aliases[bounds[0].toUpperCase()] ?? parseInt(bounds[0], 10);
      end = aliases[bounds[1].toUpperCase()] ?? parseInt(bounds[1], 10);
    } else {
      start = aliases[range.toUpperCase()] ?? parseInt(range, 10);
      end = start;
    }
    if (isNaN(start) || isNaN(end)) continue;
    if (target >= start && target <= end && (target - start) % step === 0) {
      return true;
    }
  }
  return false;
}

/**
 * Checks if a given Date matches the cron expression.
 * @param {string} cronExpr - 5-field cron expression
 * @param {Date} date - Date to check
 * @returns {boolean} True if matches, false otherwise
 */
export function matchesCron(cronExpr, date) {
  if (typeof cronExpr !== 'string' || !(date instanceof Date) || isNaN(date.getTime())) return false;
  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  try {
    return parseField(fields[0], date.getMinutes(), 0, 59, {}) &&
           parseField(fields[1], date.getHours(), 0, 23, {}) &&
           parseField(fields[2], date.getDate(), 1, 31, {}) &&
           parseField(fields[3], date.getMonth() + 1, 1, 12, MONTHS) &&
           parseField(fields[4], date.getDay(), 0, 6, DAYS);
  } catch {
    return false;
  }
}

/**
 * Finds the next Date (minute resolution) that matches the cron expression.
 * @param {string} cronExpr - 5-field cron expression
 * @param {Date} fromDate - Starting date
 * @returns {Date|null} Next matching date or null if invalid
 */
export function nextCronRun(cronExpr, fromDate) {
  if (typeof cronExpr !== 'string' || !(fromDate instanceof Date) || isNaN(fromDate.getTime())) return null;
  if (cronExpr.trim().split(/\s+/).length !== 5) return null;
  let nextDate = new Date(fromDate.getTime());
  nextDate.setSeconds(0, 0);
  nextDate.setMinutes(nextDate.getMinutes() + 1);
  const maxYear = nextDate.getFullYear() + 5;
  while (nextDate.getFullYear() < maxYear) {
    if (matchesCron(cronExpr, nextDate)) {
      return new Date(nextDate.getTime());
    }
    nextDate.setMinutes(nextDate.getMinutes() + 1);
  }
  return null;
}