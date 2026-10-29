// 仓位对比 Presenter（批次4：View／Presenter 分离）。
// 职责：持有标杆/对比/复制测算状态（state）、经 siteApi 取数与提交（六处请求）、决定何时把结果交给 View。
// 边界：本文件不直接操作 DOM（静态门禁按 role=presenter、allowDom=false 校验），
//       按钮/弹窗/表格渲染在 position-comparison.js（View），经 window.positionComparisonView 回调 View；
//       View 不取数，只渲染并上报用户操作。
// 契约：docs/仓位对比功能_开发文档.md 5 节；window.PositionComparison 对外 API（HTML data-act 调用面）
//       仍由 View 组装，键名一字不变，取数入口转调本文件。
(function () {
  if (window.positionComparisonPresenter) return;
  var state = { benchmarks: [], currentBenchmark: null, compareData: null, replicateData: null };
  // 账户切换守卫（2026-10-29 验收反例修复）：身份（登录名＋账户实体）变化即作废在途请求、清对比状态，
  // 旧响应不得写入新身份页面；写操作响应同样按发起时身份校验后才提示/渲染。
  var pcEpoch = 0;
  function begin() {
    var user = typeof username === 'string' ? username : '';
    var identity = typeof accountIdentity === 'string' ? accountIdentity : '';
    var account = getAccount();
    if (state.ownerUser !== user || state.ownerIdentity !== identity || state.ownerAccount !== account) {
      state.ownerUser = user; state.ownerIdentity = identity; state.ownerAccount = account;
      pcEpoch += 1;
      state.benchmarks = []; state.currentBenchmark = null; state.compareData = null; state.replicateData = null;
    }
    var epoch = pcEpoch;
    return function current() {
      return pcEpoch === epoch
        && user === (typeof username === 'string' ? username : '')
        && identity === (typeof accountIdentity === 'string' ? accountIdentity : '')
        && account === getAccount();
    };
  }

  // 读取当前账户：window.currentAccount 由 index.html/core-account.js 同步维护（顶层 let 不在 window 上，必须经此读取）
  function getAccount() {
    return (typeof window.currentAccount === 'string' && window.currentAccount) || '默认账户';
  }

  // 读取当前账户公开状态
  async function loadVisibility(accountName) {
    if (!window.positionComparisonView.visibilitySelectReady()) return;
    var current = begin();
    try {
      var res = await window.siteApi.get('/api/position-comparisons/visibility?account=' + encodeURIComponent(accountName));
      if (!current()) return;
      var d = res.payload || {};
      if (d && VALID_VISIBILITY.indexOf(d.visibility) >= 0) window.positionComparisonView.applyVisibility(d.visibility);
    } catch (e) { /* 忽略：保持默认 */ }
  }

  var VALID_VISIBILITY = ['public', 'semi_public', 'private'];

  // 修改发布状态：完整标杆/脱敏标杆二次确认（不发布无需确认）
  async function changeVisibility(visibility) {
    var accountName = getAccount();
    var current = begin();
    if (visibility !== 'private') {
      var tip = visibility === 'public' ? '发布为完整标杆后，其他用户可查看你的完整持仓（含数量、市值）。确定发布吗？' : '发布为脱敏标杆后，其他用户可查看你的持仓比例和证券，但看不到数量、市值和总资产。确定发布吗？';
      var ok = await window.projectConfirm(tip, { title: '发布官方标杆确认', confirmText: '确定发布' });
      if (!current()) return;
      if (!ok) { window.positionComparisonView.initPositionControls(); return; }
    }
    try {
      var res = await window.siteApi.put('/api/accounts/' + encodeURIComponent(accountName) + '/position-visibility', { visibility: visibility });
      if (!current()) return;
      var d = res.payload || {};
      if (!res.ok) { showToast(d.error || '发布失败，请重试'); window.positionComparisonView.initPositionControls(); return; }
      showToast(visibility === 'private' ? '已取消发布（不发布）' : (visibility === 'public' ? '已发布为完整标杆' : '已发布为脱敏标杆'));
      refreshBenchmarkButton();
    } catch (e) { if (current()) { showToast('发布失败，请重试'); window.positionComparisonView.initPositionControls(); } }
  }

  // 有无可用标杆 → 控制"仓位对比"按钮显示
  async function refreshBenchmarkButton() {
    if (!window.positionComparisonView.compareButtonReady()) return;
    var current = begin();
    try {
      var res = await window.siteApi.get('/api/position-comparisons/benchmarks');
      if (!current()) return;
      state.benchmarks = res.ok ? (res.payload || []) : [];
      window.positionComparisonView.applyCompareButton();
    } catch (e) { if (current()) window.positionComparisonView.failCompareButton(); }
  }

  // ========== 标杆选择弹窗（5.2） ==========
  async function openBenchmarkPicker() {
    var current = begin();
    if (!state.benchmarks.length) {
      try {
        var res = await window.siteApi.get('/api/position-comparisons/benchmarks');
        if (!current()) return;
        state.benchmarks = res.ok ? (res.payload || []) : [];
      } catch (e) {}
    }
    if (!current()) return;
    if (!state.benchmarks.length) { showToast('暂无可对比的官方标杆'); return; }
    window.positionComparisonView.showBenchmarkPicker();
  }

  // 开始对比：请求 compare 接口 → 跳转到独立对比页并渲染
  async function startCompare(benchmarkAccountId) {
    var myAccountName = getAccount();
    var identityCurrent = begin();
    var seq = (state.compareSeq = (state.compareSeq || 0) + 1);
    state.replicateSeq = (state.replicateSeq || 0) + 1;
    function current() { return identityCurrent() && state.compareSeq === seq; }
    state.currentBenchmark = benchmarkAccountId;
    window.positionComparisonView.closeSelf();
    showToast('正在计算对比…');
    try {
      var res = await window.siteApi.post('/api/position-comparisons/compare', {
        myAccountName: myAccountName, benchmarkAccountId: benchmarkAccountId
      });
      if (!current()) return;
      var d = res.payload || {};
      if (!res.ok) { showToast(d.error || '对比失败，请重试'); return; }
      if (d.empty) { showToast(d.message || '没有可对比的资产'); return; }
      state.compareData = d;
      // 打开独立对比页（非弹框）
      if (typeof window.switchMain === 'function') window.switchMain('position-compare');
      window.positionComparisonView.renderCompare(d);
    } catch (e) { if (current()) showToast('对比失败，请重试'); }
  }

  async function doReplicate() {
    var availableCash = window.positionComparisonView.readAvailableCash();
    if (!Number.isFinite(availableCash) || availableCash <= 0) { showToast('请输入大于 0 的新增资金'); return; }
    var identityCurrent = begin();
    var benchmark = state.currentBenchmark;
    if (!benchmark) { showToast('请先选择标杆进行对比'); return; }
    var seq = (state.replicateSeq = (state.replicateSeq || 0) + 1);
    function current() { return identityCurrent() && state.replicateSeq === seq && state.currentBenchmark === benchmark; }
    showToast('正在测算…');
    try {
      var res = await window.siteApi.post('/api/position-comparisons/replicate', {
        myAccountName: getAccount(),
        benchmarkAccountId: benchmark,
        availableCash: availableCash
      });
      if (!current()) return;
      var d = res.payload || {};
      if (!res.ok) { showToast(d.error || '测算失败，请重试'); return; }
      state.replicateData = d;
      window.positionComparisonView.renderReplicate(d);
    } catch (e) { if (current()) showToast('测算失败，请重试'); }
  }

  // 最小桥：View（含 window.PositionComparison）经此转调取数；state 供 View 读写标杆与对比结果
  window.positionComparisonPresenter = {
    state: state,
    getAccount: getAccount,
    getCompareData: function () { begin(); return state.compareData; },
    loadVisibility: loadVisibility,
    changeVisibility: changeVisibility,
    refreshBenchmarkButton: refreshBenchmarkButton,
    openBenchmarkPicker: openBenchmarkPicker,
    startCompare: startCompare,
    doReplicate: doReplicate
  };
})();
