// shared/bond-marks.js – 可转债列表「转债名称」旁的生命周期标记（强赎状态 + 到期提醒）。
// 上市可转债、可转债安全性、可转债估值、强赎监控、下修监控共用这一份，避免各页复制近似实现。
// 只有一个感叹号：先看强赎类状态（红色），没有状态时再看到期日分档——
//   最后 30 天＝红色（与后端 maturity_near 同色）、不到半年＝橘红、不到一年＝黄色，鼠标悬停给说明。
// 日期口径：到期日与「今天」都按上海时区，用 UTC 构造比较，不受运行环境时区影响。
(function (root) {
  'use strict';
  var DAY_MS = 86400000;
  var STATUS_MARKS = {
    announced: ['bond-lifecycle-mark-call', '已公告强赎'],
    maturity_redeem: ['bond-lifecycle-mark-maturity', '已公告到期兑付'],
    redemption_unconfirmed: ['bond-lifecycle-mark-maturity', '赎回方式待确认'],
    completed: ['bond-lifecycle-mark-call', '赎回已完成'],
    maturity_near: ['bond-lifecycle-mark-maturity', '临近到期']
  };

  function businessDate(value) {
    var text = String(value == null ? '' : value).slice(0, 10);
    if (root.CoreDate && root.CoreDate.normalizeBusinessDate) return root.CoreDate.normalizeBusinessDate(text);
    return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
  }

  function shanghaiToday(now) {
    if (root.CoreDate && root.CoreDate.todayInZone) return root.CoreDate.todayInZone('Asia/Shanghai', now);
    return null;
  }

  function daysBetween(from, to) {
    var start = Date.parse(from + 'T00:00:00Z');
    var end = Date.parse(to + 'T00:00:00Z');
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    return Math.round((end - start) / DAY_MS);
  }

  // 月末安全：1 月 31 日 + 1 个月＝2 月 28/29 日，不会溢出到下个月。
  function addMonths(text, months) {
    var total = Number(text.slice(0, 4)) * 12 + (Number(text.slice(5, 7)) - 1) + months;
    var year = Math.floor(total / 12);
    var month = total % 12 + 1;
    var lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    var day = Math.min(Number(text.slice(8, 10)), lastDay);
    return String(year).padStart(4, '0') + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
  }

  function mark(cls, tip) {
    return '<span class="bond-lifecycle-mark ' + cls + '" role="img" aria-label="' + tip + '" title="' + tip + '">!</span>';
  }

  // 到期提醒：只看到期日与今天，不依赖各列表是否带强赎状态。
  function maturityMark(maturityDate, now) {
    var maturity = businessDate(maturityDate);
    var today = shanghaiToday(now);
    if (!maturity || !today) return '';
    var days = daysBetween(today, maturity);
    if (days == null || days < 0) return '';
    var tip = '到期日 ' + maturity + '，还有 ' + days + ' 天';
    if (days <= 30) return mark('bond-lifecycle-mark-maturity', '临近到期：' + tip);
    if (maturity <= addMonths(today, 6)) return mark('bond-lifecycle-mark-expiry-6m', '距到期不到半年：' + tip);
    if (maturity <= addMonths(today, 12)) return mark('bond-lifecycle-mark-expiry-1y', '距到期不到一年：' + tip);
    return '';
  }

  // 列表名称旁统一入口：强赎类状态优先，其次到期提醒。
  function lifecycleMark(row, now) {
    if (!row) return '';
    var status = STATUS_MARKS[row.call_status];
    if (status) return mark(status[0], status[1]);
    return maturityMark(row.maturity_date, now);
  }

  root.bondLifecycleMark = lifecycleMark;
  root.bondMaturityMark = maturityMark;
  root.BondMarks = { lifecycle: lifecycleMark, maturity: maturityMark, daysBetween: daysBetween };
})(typeof self !== 'undefined' ? self : this);
