/* 浏览器与 Node 共用的业务日期和明确时刻转换工具。 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CoreDate = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var formatters = new Map();

  function validParts(year, month, day) {
    if (!Number.isInteger(year) || year < 1 || year > 9999 ||
        !Number.isInteger(month) || month < 1 || month > 12 ||
        !Number.isInteger(day) || day < 1) return false;
    var days = [31, (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 29 : 28,
      31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return day <= days[month - 1];
  }

  function normalizeBusinessDate(value) {
    if (typeof value !== 'string') return null;
    var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return null;
    return validParts(Number(match[1]), Number(match[2]), Number(match[3])) ? value : null;
  }

  function compactDateToIso(value) {
    if (typeof value !== 'string' || !/^\d{8}$/.test(value)) return null;
    var iso = value.slice(0, 4) + '-' + value.slice(4, 6) + '-' + value.slice(6, 8);
    return normalizeBusinessDate(iso);
  }

  function instant(value) {
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
    if (!normalizeBusinessDate(value.slice(0, 10))) return null;
    var date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  function formatter(timeZone, withTime) {
    var key = timeZone + (withTime ? '|time' : '|date');
    if (!formatters.has(key)) {
      var options = { timeZone: timeZone, year: 'numeric', month: '2-digit', day: '2-digit' };
      if (withTime) Object.assign(options, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
      formatters.set(key, new Intl.DateTimeFormat('en-CA', options));
    }
    return formatters.get(key);
  }

  function partsFor(value, timeZone, withTime) {
    var date = instant(value);
    if (!date || typeof timeZone !== 'string' || !timeZone) return null;
    try {
      var parts = {};
      formatter(timeZone, withTime).formatToParts(date).forEach(function (part) {
        if (part.type !== 'literal') parts[part.type] = part.value;
      });
      return parts;
    } catch (_) {
      return null;
    }
  }

  function dateInZone(value, timeZone) {
    var date = instant(value);
    var zone = timeZone || 'Asia/Shanghai';
    if (!date || typeof zone !== 'string' || !zone) return null;
    try {
      var formatted = formatter(zone, false).format(date);
      if (/^\d{4}-\d{2}-\d{2}$/.test(formatted)) return formatted;
    } catch (_) {
      return null;
    }
    var parts = partsFor(date, zone, false);
    return parts ? String(parts.year).padStart(4, '0') + '-' + parts.month + '-' + parts.day : null;
  }

  function dateTimeInZone(value, timeZone) {
    var parts = partsFor(value, timeZone || 'Asia/Shanghai', true);
    return parts ? String(parts.year).padStart(4, '0') + '-' + parts.month + '-' + parts.day + ' ' +
      parts.hour + ':' + parts.minute + ':' + parts.second : null;
  }

  function todayInZone(timeZone, now) {
    return dateInZone(now == null ? new Date() : now, timeZone || 'Asia/Shanghai');
  }

  function subtractYears(dateText, years) {
    var date = normalizeBusinessDate(dateText);
    if (!date || !Number.isInteger(years) || years < 0) return null;
    var year = Number(date.slice(0, 4)) - years;
    if (year < 1) return null;
    var month = Number(date.slice(5, 7));
    var day = Number(date.slice(8, 10));
    if (!validParts(year, month, day)) {
      if (month === 2 && day === 29 && validParts(year, month, 28)) day = 28;
      else return null;
    }
    return String(year).padStart(4, '0') + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
  }

  return { normalizeBusinessDate: normalizeBusinessDate, compactDateToIso: compactDateToIso,
    dateInZone: dateInZone, dateTimeInZone: dateTimeInZone, todayInZone: todayInZone, subtractYears: subtractYears };
});
