// 统一游客 / 会员 / 管理员页面级访问矩阵（单一事实来源）
// switchMain()、首次 URL 解析、导航显示共用本配置。
// 口径见《产品功能架构分析整改报告_20260804.md》ACCESS-01。
(function () {
  // 游客可只读的页面（无需登录）
  var publicPages = [
    'home',             // 首页
    'knowledge',        // 已发布投资笔记
    'stock-analysis',   // 个券分析已有快照
    'bond-safety',      // 可转债安全性 / 周期 / 估值
    'market-volatility',// 市场周期
    'ipo',              // 打新日历
    'arbitrage',        // 套利机会
    'changelog'         // 版本记录
  ];

  // 需要登录的页面（本人资产 / 个人中心 / 仓位对比）
  var protectedPages = [
    'holdings',
    'profile',
    'position-compare'
  ];

  // 所有可作为 ?main= 的页面（公开 + 受限的并集）
  var allowedPages = publicPages.concat(protectedPages);

  window.ACCESS_POLICY = {
    publicPages: publicPages,
    protectedPages: protectedPages,
    allowedPages: allowedPages,
    isPublic: function (page) { return publicPages.indexOf(page) >= 0; },
    requiresLogin: function (page) { return protectedPages.indexOf(page) >= 0; },
    isAllowed: function (page) { return allowedPages.indexOf(page) >= 0; }
  };
})();
