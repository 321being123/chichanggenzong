/**
 * nav-math.js — 净值计算的单一真相源（前后端共用）
 *
 * 收口三处 investedAt() 与五处链式净值公式，避免分叉漂移：
 *   - public/shared/core-earnings.js（前端）
 *   - public/shared/core-returns.js（前端）
 *   - server/jobs/navSnapshot.js（后端）
 *   - server/jobs/replayNav.js（后端）
 *
 * 同时支持浏览器 <script> 全局调用与 Node require。
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && root.window) {
    root.window.NavMath = api;
    // 兼容既有全局函数调用（core-earnings.js / core-returns.js 直接调 investedAt / chainNav）
    root.window.investedAt = api.investedAt;
    root.window.chainNav = api.chainNav;
  }
})(globalThis, function (root) {
  var DateApi = typeof module !== 'undefined' && module.exports
    ? require('./core-date') : root.CoreDate;
  var FLOW_TYPES = ['external_transfer', 'dividend', 'dividend_tax', 'repo_interest', 'repo_fee'];
  function flowType(row) { return row.flow_type || row.flowType || 'external_transfer'; }
  function isEffectiveFlow(row) {
    var type = flowType(row), status = row.status || 'confirmed';
    return FLOW_TYPES.indexOf(type) >= 0 && (status === 'confirmed' ||
      (status === 'estimated' && (type === 'repo_interest' || type === 'repo_fee' ||
        (type === 'dividend' && row.quality_status === 'authorized_dividend_calculation' &&
          row.evidence && row.evidence.authorizedPolicy === 'cash-income-v1') ||
        (type === 'dividend_tax' && row.quality_status === 'authorized_deferred_tax_calculation' &&
          row.evidence && row.evidence.authorizedPolicy === 'cash-income-v1'))));
  }
  function isExternalTransfer(row) { return flowType(row) === 'external_transfer' && isEffectiveFlow(row); }
  function businessDay(value) {
    return typeof value === 'string' ? DateApi.normalizeBusinessDate(value.slice(0, 10)) : null;
  }
  // 金额以百万分之一元整数累计，最终显示/结算舍入由调用方决定。
  function moneyUnits(value) {
    if (value == null || value === '') return null;
    var text = String(value);
    if (!/^-?\d+(?:\.\d{1,6})?$/.test(text)) return null;
    var negative = text[0] === '-';
    if (negative) text = text.slice(1);
    var parts = text.split('.');
    var units = BigInt(parts[0]) * 1000000n + BigInt((parts[1] || '').padEnd(6, '0'));
    return negative ? -units : units;
  }
  // 业务生效时刻优先；补录创建时间不能把旧交易移到今天。
  function eventTime(row, date) {
    var value = row.settled_at || row.executed_at;
    if (!value && businessDay(row.created_at) === date) value = row.created_at;
    if (!value) return null;
    var text = typeof value === 'string' ? value : DateApi.dateTimeInZone(value, 'Asia/Shanghai');
    if (!text) return null;
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text)) text = text.replace(' ', 'T') + '+08:00';
    var t = new Date(text).getTime();
    return Number.isFinite(t) ? t : null;
  }
  function beforeCutoff(row, date, targetDate, cutoffAt) {
    if (date !== targetDate || !cutoffAt) return true;
    var eventAt = eventTime(row, date), cutoff = eventTime({ settled_at: cutoffAt }, targetDate);
    return eventAt == null || cutoff == null || eventAt <= cutoff;
  }
  function selectCashAnchor(navs, targetDate, cutoffAt) {
    var rows = (navs || []).filter(function(n) {
      var d = businessDay(n.date);
      return (n.snapshotSource || n.snapshot_source) === 'imported' &&
        (n.isLocked != null ? n.isLocked : n.is_locked) !== false && d && d <= targetDate &&
        moneyUnits(n.cashCny != null ? n.cashCny : n.cash_cny) != null &&
        beforeCutoff({ settled_at: n.snapshot_at }, d, targetDate, cutoffAt);
    }).sort(function(a,b) {
      return businessDay(a.date).localeCompare(businessDay(b.date)) ||
        (eventTime({settled_at:a.snapshot_at}, businessDay(a.date)) || 0) -
        (eventTime({settled_at:b.snapshot_at}, businessDay(b.date)) || 0);
    });
    return rows.length ? rows[rows.length - 1] : null;
  }
  function cashAt(data, targetDate, cutoffAt) {
    if (!DateApi.normalizeBusinessDate(targetDate)) throw new TypeError('现金目标日必须为有效业务日期');
    var anchor = selectCashAnchor(data.navHistory, targetDate, cutoffAt);
    var anchorDate = anchor ? businessDay(anchor.date) : null;
    var confirmed = moneyUnits(anchor ? (anchor.cashCny != null ? anchor.cashCny : anchor.cash_cny) : (data.cashBase || 0));
    var incomplete = confirmed == null, estimated = 0n;
    if (confirmed == null) confirmed = 0n;
    function included(row, d) {
      if (!d) { incomplete = true; return false; }
      return (!anchorDate || d > anchorDate) && d <= targetDate && beforeCutoff(row, d, targetDate, cutoffAt);
    }
    (data.cashFlows || []).forEach(function(f) {
      if (!included(f, businessDay(f.date))) return;
      if (FLOW_TYPES.indexOf(flowType(f)) < 0) { incomplete = true; return; }
      if (!isEffectiveFlow(f)) return;
      var amount = moneyUnits(f.amount_cny != null ? f.amount_cny : f.amount);
      if (amount == null) { incomplete = true; return; }
      if (f.status === 'estimated') estimated += amount; else confirmed += amount;
    });
    (data.trades || []).forEach(function(t) {
      if (!included(t, businessDay(t.trade_date || t.date)) || t.direction === 'open' || t.direction === 'adjust') return;
      if (t.direction !== 'buy' && t.direction !== 'sell') { incomplete = true; return; }
      var cny = t.amountCny != null && t.amountCny !== '' ? t.amountCny : t.amount_cny;
      var currency = String(t.quote_currency || t.quoteCurrency || (t.subtype === '港股' ? 'HKD' : 'CNY')).toUpperCase();
      if ((cny == null || cny === '') && currency !== 'CNY') { incomplete = true; return; }
      var amount = moneyUnits(cny != null && cny !== '' ? cny : (t.amount || 0));
      var fees = ['commission','stamp_tax','transfer_fee','other_fee'].map(function(k) { return moneyUnits(t[k] || 0); });
      if (amount == null || fees.some(function(v) { return v == null; })) { incomplete = true; return; }
      confirmed += (t.direction === 'buy' ? -amount : amount) - fees.reduce(function(a,b) { return a+b; }, 0n);
    });
    var delta = Number(estimated) / 1000000;
    return { value: Number(confirmed + estimated) / 1000000, incomplete: incomplete, anchor: anchor,
      cashConfirmed: Number(confirmed) / 1000000, cashEstimatedDelta: delta, cashIncludesEstimates: estimated !== 0n };
  }

  /**
   * 某日投入本金
   * 规则（与导入数据 / 现金流联动，原三处实现一致）：
   *  - 优先使用导入数据（navHistory 中存储的 invested）
   *  - 导入数据最后一列日期之后：投入本金 = 最后导入值 + 该日期之后的累计出入金
   *  - 完全没有导入数据：投入本金 = 期初本金(cashBase) + 截至该日累计出入金
   * @param {Array} navs 净值历史（含 invested/date）
   * @param {Array} cashFlows 现金流（含 date/amount）
   * @param {number} cashBase 期初本金
   * @param {string} date 目标日 YYYY-MM-DD
   */
  function investedAt(navs, cashFlows, cashBase, date) {
    var anchors = (navs || []).filter(function(n) {
      return n.invested != null && n.invested !== '' && Number.isFinite(Number(n.invested)) &&
        n.date <= date;
    }).sort(function(a,b) { return a.date.localeCompare(b.date); });
    var anchor = anchors.length ? anchors[anchors.length-1] : null;
    var value = moneyUnits(anchor ? anchor.invested : (cashBase || 0));
    if (value == null) throw new TypeError('无效投入本金');
    (cashFlows || []).filter(isExternalTransfer).forEach(function(c) {
      if ((!anchor || c.date > anchor.date) && c.date <= date) {
        var amount = moneyUnits(c.amount);
        if (amount == null) throw new TypeError('无效外部资金金额');
        value += amount;
      }
    });
    return Number(value) / 1000000;
  }

  /**
   * 链式净值：剔除「上期 → 本期净现金流」影响后的真实净值增长
   * newNav = prevNav * newTotal / (prevTotal + pcf)
   * 基准非正时返回上期净值（与调用方 if (base>0) 守卫等价，避免除零）
   */
  function chainNav(prevNav, prevTotal, newTotal, pcf) {
    var base = (prevTotal || 0) + (pcf || 0);
    if (base <= 0) return prevNav;
    return prevNav * (newTotal / base);
  }

  return { investedAt: investedAt, chainNav: chainNav, cashAt: cashAt, selectCashAnchor: selectCashAnchor,
    isExternalTransfer: isExternalTransfer, isEffectiveFlow: isEffectiveFlow, flowType: flowType, businessDay: businessDay, eventTime: eventTime };
});
