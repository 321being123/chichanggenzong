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
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') {
    window.NavMath = api;
    // 兼容既有全局函数调用（core-earnings.js / core-returns.js 直接调 investedAt / chainNav）
    window.investedAt = api.investedAt;
    window.chainNav = api.chainNav;
  }
})(typeof self !== 'undefined' ? self : this, function () {

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
    navs = navs || [];
    cashFlows = cashFlows || [];
    var lastImpDate = null, lastImp = 0;
    navs.forEach(function (n) {
      if (n.invested != null && n.invested !== '') { lastImpDate = n.date; lastImp = Number(n.invested); }
    });
    if (!lastImpDate) {
      var s = Number(cashBase) || 0;
      cashFlows.forEach(function (c) { if (c.date <= date) s += (c.amount || 0); });
      return s;
    }
    if (date <= lastImpDate) {
      var val = null;
      navs.forEach(function (n) { if (n.invested != null && n.invested !== '' && n.date <= date) val = Number(n.invested); });
      if (val != null) return val;
      var s2 = Number(cashBase) || 0;
      cashFlows.forEach(function (c) { if (c.date <= date) s2 += (c.amount || 0); });
      return s2;
    }
    var s3 = lastImp;
    cashFlows.forEach(function (c) { if (c.date > lastImpDate && c.date <= date) s3 += (c.amount || 0); });
    return s3;
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

  return { investedAt: investedAt, chainNav: chainNav };
});
