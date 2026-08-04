// ============== 仓位对比（公开状态 / 标杆列表 / 对比 / 复制测算） ==============
// 对应 docs/仓位对比功能_开发文档.md 5 节
// 依赖：window.api / showToast / projectConfirm / escapeHtml / fmt 等全局函数（utils.js / core-quote.js / dialog.js）
(function () {
  if (window.PositionComparison) return;
  var state = { benchmarks: [], currentBenchmark: null, compareData: null, replicateData: null };

  // 读取当前账户：window.currentAccount 由 index.html/core-account.js 同步维护（顶层 let 不在 window 上，必须经此读取）
  function getAccount() {
    return (typeof window.currentAccount === 'string' && window.currentAccount) || '默认账户';
  }

  // 当前用户是否可发布官方标杆（管理员，或拥有 benchmark_publish 能力的受信任人员；普通用户不可自行发布）
  // ⚠️ myProfile 是 index.html 顶层 let（不在 window 上）；同页 script 共享全局词法环境，直接按名引用
  function canPublishBenchmark() {
    if (typeof myProfile === 'undefined' || !myProfile) return false;
    if (myProfile.role === 'admin') return true;
    var caps = myProfile.capabilities;
    return !!(caps && caps.benchmark_publish);
  }

  // ========== 公开状态控件 ==========
  // 持仓页标题区：状态下拉（仅管理员）+ 对比按钮。initPositionControls() 在每次持仓页激活/账户切换时调用
  function initPositionControls() {
    var wrap = document.getElementById('position-comp-controls');
    if (!wrap) return;
    var current = getAccount();
    var visibilityHtml = canPublishBenchmark()
      ? '<span class="pc-label">官方标杆发布：</span>' +
        '<select id="position-visibility-select" class="pc-select" onchange="PositionComparison.changeVisibility(this.value)">' +
          '<option value="private">不发布</option>' +
          '<option value="semi_public">脱敏标杆</option>' +
          '<option value="public">完整标杆</option>' +
        '</select>'
      : '';
    wrap.innerHTML = visibilityHtml +
      '<button type="button" class="btn btn-outline btn-sm pc-compare-btn" id="pc-open-btn" onclick="PositionComparison.openBenchmarkPicker()">仓位对比</button>';
    if (canPublishBenchmark()) loadVisibility(current);
    refreshBenchmarkButton();
  }

  // 读取当前账户公开状态
  async function loadVisibility(accountName) {
    var sel = document.getElementById('position-visibility-select');
    if (!sel) return;
    try {
      var r = await fetch(api('/api/position-comparisons/visibility?account=' + encodeURIComponent(accountName)));
      var d = await r.json().catch(function () { return {}; });
      if (d && VALID_VISIBILITY.indexOf(d.visibility) >= 0) sel.value = d.visibility;
    } catch (e) { /* 忽略：保持默认 */ }
  }

  var VALID_VISIBILITY = ['public', 'semi_public', 'private'];

  // 修改发布状态：完整标杆/脱敏标杆二次确认（不发布无需确认）
  async function changeVisibility(visibility) {
    var accountName = getAccount();
    if (visibility !== 'private') {
      var tip = visibility === 'public' ? '发布为完整标杆后，其他用户可查看你的完整持仓（含数量、市值）。确定发布吗？' : '发布为脱敏标杆后，其他用户可查看你的持仓比例和证券，但看不到数量、市值和总资产。确定发布吗？';
      var ok = await window.projectConfirm(tip, { title: '发布官方标杆确认', confirmText: '确定发布' });
      if (!ok) { initPositionControls(); return; }
    }
    try {
      var r = await fetch(api('/api/accounts/' + encodeURIComponent(accountName) + '/position-visibility'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visibility: visibility })
      });
      var d = await r.json().catch(function () { return {}; });
      if (!r.ok) { showToast(d.error || '发布失败，请重试'); initPositionControls(); return; }
      showToast(visibility === 'private' ? '已取消发布（不发布）' : (visibility === 'public' ? '已发布为完整标杆' : '已发布为脱敏标杆'));
      refreshBenchmarkButton();
    } catch (e) { showToast('发布失败，请重试'); initPositionControls(); }
  }

  // 有无可用标杆 → 控制"仓位对比"按钮显示
  async function refreshBenchmarkButton() {
    var btn = document.getElementById('pc-open-btn');
    if (!btn) return;
    try {
      var r = await fetch(api('/api/position-comparisons/benchmarks'));
      state.benchmarks = r.ok ? (await r.json()) : [];
      btn.style.display = state.benchmarks.length ? '' : 'none';
    } catch (e) { btn.style.display = 'none'; }
  }

  // ========== 标杆选择弹窗（5.2） ==========
  async function openBenchmarkPicker() {
    if (!state.benchmarks.length) {
      try {
        var r = await fetch(api('/api/position-comparisons/benchmarks'));
        state.benchmarks = r.ok ? (await r.json()) : [];
      } catch (e) {}
    }
    if (!state.benchmarks.length) { showToast('暂无可对比的官方标杆'); return; }
    var rows = state.benchmarks.map(function (b) {
      return '<tr onclick="PositionComparison.startCompare(\'' + b.accountId + '\')" style="cursor:pointer;">' +
        '<td>' + escapeHtml(b.displayName) + '</td>' +
        '<td>' + (b.visibility === 'public' ? '完整标杆' : '脱敏标杆') + '</td>' +
        '<td>' + escapeHtml(b.positionUpdatedAt || '--') + '</td>' +
        '<td>' + b.securityCount + '</td>' +
        '<td><button type="button" class="btn btn-primary btn-sm">开始对比</button></td>' +
      '</tr>';
    }).join('');
    var html =
      '<h2>选择对比标杆</h2><span class="modal-close" onclick="PositionComparison.closeSelf()">&times;</span>' +
      '<p style="font-size:12px;color:#888;margin:-6px 0 12px;">选择其他用户的完整标杆或脱敏标杆账户，进行仓位对比与复制测算。</p>' +
      '<div class="table-wrap" style="margin-bottom:0;"><table class="pc-bench-table">' +
        '<thead><tr><th>账户</th><th>公开类型</th><th>持仓更新时间</th><th>证券只数</th><th>操作</th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table></div>' +
        '<div class="modal-actions"><button type="button" class="btn btn-outline" onclick="PositionComparison.closeSelf()">关闭</button></div>';
    openBox('position-comp-modal', html);
  }

  // 开始对比：请求 compare 接口 → 跳转到独立对比页并渲染
  async function startCompare(benchmarkAccountId) {
    var myAccountName = getAccount();
    state.currentBenchmark = benchmarkAccountId;
    closeSelf();
    showToast('正在计算对比…');
    try {
      var r = await fetch(api('/api/position-comparisons/compare'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ myAccountName: myAccountName, benchmarkAccountId: benchmarkAccountId })
      });
      var d = await r.json().catch(function () { return {}; });
      if (!r.ok) { showToast(d.error || '对比失败，请重试'); return; }
      if (d.empty) { showToast(d.message || '没有可对比的资产'); return; }
      state.compareData = d;
      // 打开独立对比页（非弹框）
      if (typeof window.switchMain === 'function') window.switchMain('position-compare');
      renderCompare(d);
    } catch (e) { showToast('对比失败，请重试'); }
  }

  // 对比页进入时：有数据则重渲染（刷新/URL 直达场景），无数据保持空态
  function onPageEnter() {
    var body = document.getElementById('position-compare-page-body');
    if (!body) return;
    if (state.compareData) renderCompare(state.compareData);
  }

  // 返回持仓页
  function goBackHoldings() {
    if (typeof window.switchMain === 'function') window.switchMain('holdings');
  }

  // ========== 对比结果渲染（5.3） ==========
  function renderCompare(d) {
    var benchName = (state.benchmarks.find(function (b) { return b.accountId === state.currentBenchmark; }) || {}).displayName || '标杆账户';
    var semi = d.benchmarkAccount.visibility === 'semi_public';
    var sim = fmtPct(d.overview.similarity / 100);

    var secRows = d.securities.map(function (s) {
      var statusText = s.status === 'both' ? '双方持有' : (s.status === 'benchmark_only' ? '我未持有' : '仅我持有');
      var diffCls = s.diff >= 0 ? 'pc-up' : 'pc-down';
      var priceText = s.price != null ? fmt(s.price) : '--';
      var changeText = s.change != null ? (s.change >= 0 ? '+' : '') + s.change.toFixed(2) + '%' : '--';
      return '<tr>' +
        '<td>' + escapeHtml(s.code) + '<br><span style="font-size:11px;color:#888;">' + escapeHtml(s.name) + '</span></td>' +
        '<td>' + statusText + '</td>' +
        '<td>' + fmtPct(s.myRatio) + '</td>' +
        '<td>' + fmtPct(s.benchmarkRatio) + '</td>' +
        '<td class="' + diffCls + '">' + (s.diff >= 0 ? '+' : '') + fmtPct(s.diff) + '</td>' +
        '<td>' + priceText + '<br><span style="font-size:11px;color:#888;">' + changeText + '</span></td>' +
        '<td>' + fmtQty(s.myQuantity) + '</td><td>' + fmt(s.myMarketValue) + '</td>' +
        // 标杆数量/市值仅公开仓位展示；半公开时服务端已删除这些字段
        (s.benchmarkQuantity === undefined ? '' : '<td>' + fmtQty(s.benchmarkQuantity) + '</td><td>' + fmt(s.benchmarkMarketValue) + '</td>') +
      '</tr>';
    }).join('');

    var typeRows = d.typeGroups.map(function (g) {
      return '<tr><td>' + escapeHtml(g.name) + '</td><td>' + fmtPct(g.myRatio) + '</td><td>' + fmtPct(g.benchmarkRatio) + '</td><td>' + (g.diff >= 0 ? '+' : '') + fmtPct(g.diff) + '</td></tr>';
    }).join('');
    var subtypeRows = d.subtypeGroups.map(function (g) {
      return '<tr><td>' + escapeHtml(g.name) + '</td><td>' + fmtPct(g.myRatio) + '</td><td>' + fmtPct(g.benchmarkRatio) + '</td><td>' + (g.diff >= 0 ? '+' : '') + fmtPct(g.diff) + '</td></tr>';
    }).join('');

    var html =
      '<div class="pc-meta">标杆：<b>' + escapeHtml(benchName) + '</b>（' + (semi ? '脱敏标杆' : '完整标杆') + '）<br>' +
      '<span style="font-size:11px;color:#888;">我的持仓更新：' + escapeHtml(d.overview.myUpdatedAt || '--') + '　标杆持仓更新：' + escapeHtml(d.overview.benchmarkUpdatedAt || '--') + '<br>' +
      '本次估值时间：' + escapeHtml(d.overview.valuationTime || '--') + '　港币汇率：' + (d.overview.hkRate || '--') + '</span></div>' +
      '<div class="pc-overview">' +
        '<div class="pc-ov-item"><span>仓位相似度</span><b>' + sim + '</b></div>' +
        '<div class="pc-ov-item"><span>共同持有</span><b>' + d.overview.commonCount + ' 只</b></div>' +
        '<div class="pc-ov-item"><span>我未持有</span><b>' + d.overview.mineMissingCount + ' 只</b></div>' +
        '<div class="pc-ov-item"><span>仅我持有</span><b>' + d.overview.mineOnlyCount + ' 只</b></div>' +
        '<div class="pc-ov-item"><span>最大类型差异</span><b>' + fmtPct(d.overview.maxTypeDiff) + '</b></div>' +
        '<div class="pc-ov-item"><span>最大细类差异</span><b>' + fmtPct(d.overview.maxSubtypeDiff) + '</b></div>' +
      '</div>' +
      '<div class="table-wrap"><div class="table-header"><h3>证券持仓对比</h3></div>' +
        '<div style="overflow-x:auto;"><table class="pc-table"><thead><tr>' +
          '<th>证券</th><th>状态</th><th>我的占比</th><th>标杆占比</th><th>占比差异</th><th>最新价格/涨跌幅</th>' +
          '<th>我的数量</th><th>我的市值</th>' +
          (semi ? '' : '<th>标杆数量</th><th>标杆市值</th>') +
        '</tr></thead><tbody>' + secRows + '</tbody></table></div></div>' +
      '<div class="table-wrap"><div class="table-header"><h3>资产类型对比</h3></div>' +
        '<div style="overflow-x:auto;"><table class="pc-table"><thead><tr><th>资产类型</th><th>我的占比</th><th>标杆占比</th><th>占比差异</th></tr></thead>' +
        '<tbody>' + typeRows + '</tbody></table></div></div>' +
      '<div class="table-wrap"><div class="table-header"><h3>持仓细类对比</h3></div>' +
        '<div style="overflow-x:auto;"><table class="pc-table"><thead><tr><th>持仓细类</th><th>我的占比</th><th>标杆占比</th><th>占比差异</th></tr></thead>' +
        '<tbody>' + subtypeRows + '</tbody></table></div></div>' +
      '<div class="pc-page-actions">' +
        '<button type="button" class="btn btn-outline btn-sm" onclick="PositionComparison.openBenchmarkPicker()">切换标杆</button>' +
        '<button type="button" class="btn btn-primary btn-sm" onclick="PositionComparison.openReplicatePanel()">模拟复制仓位</button>' +
      '</div>';
    var body = document.getElementById('position-compare-page-body');
    if (body) body.innerHTML = html;
    else openBox('position-comp-modal', html, true);
  }

  // ========== 复制测算（7 节，页面内联，不用弹框） ==========
  function openReplicatePanel() {
    if (!state.compareData) { showToast('请先完成对比'); return; }
    var body = document.getElementById('position-compare-page-body');
    if (!body) return;
    // 在对比结果后追加测算区（避免重复追加：先移除旧测算区）
    var old = document.getElementById('pc-replicate-section');
    if (old) old.remove();
    var html =
      '<div id="pc-replicate-section" class="table-wrap" style="margin-top:18px;">' +
        '<div class="table-header"><h3>模拟复制仓位</h3>' +
          '<button type="button" class="btn btn-outline btn-sm" onclick="PositionComparison.closeReplicate()">收起</button></div>' +
        '<div style="padding:18px;">' +
          '<p style="font-size:12px;color:#888;margin:0 0 12px;">按标杆仓位比例，在不卖出现有持仓的前提下，用指定新增资金买入。仅模拟测算，不会发起真实交易。</p>' +
          '<div class="form-group"><label>计划新增资金（元）</label>' +
            '<input id="pc-available-cash" type="number" step="100" min="100" placeholder="如 100000" style="width:260px;padding:8px 10px;border:1px solid #ddd;border-radius:8px;"></div>' +
          '<div style="margin-top:12px;">' +
            '<button type="button" class="btn btn-primary" onclick="PositionComparison.doReplicate()">开始测算</button>' +
          '</div>' +
          '<div id="pc-replicate-result" style="margin-top:14px;"></div>' +
        '</div>' +
      '</div>';
    body.insertAdjacentHTML('beforeend', html);
    var input = document.getElementById('pc-available-cash');
    if (input) input.focus();
  }

  function closeReplicate() {
    var old = document.getElementById('pc-replicate-section');
    if (old) old.remove();
  }

  async function doReplicate() {
    var cashInput = document.getElementById('pc-available-cash');
    var availableCash = cashInput ? Number(cashInput.value) : NaN;
    if (!Number.isFinite(availableCash) || availableCash <= 0) { showToast('请输入大于 0 的新增资金'); return; }
    showToast('正在测算…');
    try {
      var r = await fetch(api('/api/position-comparisons/replicate'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          myAccountName: getAccount(),
          benchmarkAccountId: state.currentBenchmark,
          availableCash: availableCash
        })
      });
      var d = await r.json().catch(function () { return {}; });
      if (!r.ok) { showToast(d.error || '测算失败，请重试'); return; }
      state.replicateData = d;
      renderReplicate(d);
    } catch (e) { showToast('测算失败，请重试'); }
  }

  function renderReplicate(d) {
    var STATUS_TEXT = {
      suggest: '建议买入', over_weighted: '当前已超配', insufficient_cash: '资金不足',
      no_lot_data: '缺少每手数据', no_quote: '缺少行情'
    };
    var hkRate = (d.hkRate != null && d.hkRate > 0) ? d.hkRate : 0.868;
    // 每手数据来源映射（code → {source, sourceUpdatedAt, cached}）
    var ruleMap = {};
    (d.tradeRuleSources || []).forEach(function (r) { ruleMap[r.code] = r; });
    var rows = d.items.map(function (it) {
      var amountText;
      if (it.market === 'HK') {
        var hkAmount = it.suggestedAmount / hkRate; // 人民币 ÷ 真实汇率 = 港币
        amountText = 'HK$' + fmt(hkAmount) + '<br><span style="font-size:11px;color:#888;">¥' + fmt(it.suggestedAmount) + '</span>';
      } else {
        amountText = '¥' + fmt(it.suggestedAmount);
      }
      var rule = ruleMap[it.code] || {};
      var lotSourceText = rule.source === 'tushare:hk_basic'
        ? 'Tushare hk_basic' + (rule.cached ? '（缓存）' : '')
        : '市场规则';
      var lotTime = rule.sourceUpdatedAt ? String(rule.sourceUpdatedAt).replace('T', ' ').slice(0, 19) : '--';
      var quoteTime = it.quoteTime ? String(it.quoteTime).replace('T', ' ').slice(0, 19) : '--';
      return '<tr>' +
        '<td>' + escapeHtml(it.code) + '<br><span style="font-size:11px;color:#888;">' + escapeHtml(it.name) + '</span></td>' +
        '<td>' + (it.market === 'HK' ? '港股' : 'A股') + '</td>' +
        '<td>' + fmtPct(it.benchmarkRatio) + '</td>' +
        '<td>' + fmtQty(it.myQuantity) + '</td>' +
        '<td>' + fmtQty(it.theoreticalShares) + '</td>' +
        '<td>' + (it.lotSize || '--') + '<br><span style="font-size:11px;color:#888;">' + escapeHtml(lotSourceText) + '</span></td>' +
        '<td><b>' + fmtQty(it.suggestedShares) + '</b></td>' +
        '<td>' + amountText + '</td>' +
        '<td>' + fmtPct(it.afterRatio) + '</td>' +
        '<td>' + (it.diff >= 0 ? '+' : '') + fmtPct(it.diff) + '</td>' +
        '<td>' + (STATUS_TEXT[it.status] || it.status) + '</td>' +
      '</tr>' +
      '<tr style="background:#fafbfe;"><td colspan="11" style="font-size:11px;color:#999;padding:3px 10px;">' +
        '行情时间：' + quoteTime + '　每手数据更新：' + lotTime + '　汇率：' + hkRate.toFixed(4) +
      '</td></tr>';
    }).join('');
    var summary = d.summary;
    var html =
      '<div class="pc-summary">' +
        '<div class="pc-ov-item"><span>预计使用资金</span><b>¥' + fmt(summary.usedCash) + '</b></div>' +
        '<div class="pc-ov-item"><span>剩余现金</span><b>¥' + fmt(summary.remainingCash) + '</b></div>' +
        '<div class="pc-ov-item"><span>复制前总误差</span><b>' + (summary.errorBefore * 100).toFixed(2) + '%</b></div>' +
        '<div class="pc-ov-item"><span>复制后总误差</span><b>' + (summary.errorAfter * 100).toFixed(2) + '%</b></div>' +
        '<div class="pc-ov-item"><span>误差改善</span><b>' + (summary.improvement * 100).toFixed(2) + '%</b></div>' +
      '</div>' +
      '<div class="table-wrap"><div class="table-header"><h3>建议买入明细</h3></div>' +
        '<div style="overflow-x:auto;"><table class="pc-table"><thead><tr>' +
          '<th>证券</th><th>市场</th><th>标杆占比</th><th>我的当前股数</th><th>理论股数</th><th>每手（来源）</th><th>建议买入</th><th>预计金额</th><th>复制后占比</th><th>占比误差</th><th>状态</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table></div></div>' +
      '<p style="font-size:11px;color:#999;margin-top:10px;">本结果仅根据当前持仓比例、参考价格和交易单位进行模拟，不构成投资建议，也不会自动发起交易。实际成交价格和数量以交易结果为准。</p>';
    var resultEl = document.getElementById('pc-replicate-result');
    if (resultEl) resultEl.innerHTML = html;
    else {
      var body = document.getElementById('position-compare-page-body');
      if (body) body.insertAdjacentHTML('beforeend', '<div class="table-wrap" style="margin-top:18px;">' + html + '</div>');
    }
  }

  // ========== 弹窗通用 ==========
  function openBox(id, innerHTML, wide) {
    var existing = document.getElementById(id);
    if (!existing) {
      existing = document.createElement('div');
      existing.id = id;
      existing.className = 'modal-overlay';
      document.body.appendChild(existing);
    }
    existing.className = 'modal-overlay show';
    existing.innerHTML = '<div class="modal" style="width:' + (wide ? '860px' : '620px') + ';max-width:95vw;">' + innerHTML + '</div>';
  }

  function closeSelf() {
    var el = document.getElementById('position-comp-modal');
    if (el) el.classList.remove('show');
  }

  // 暴露给全局（HTML 内联事件调用）
  window.PositionComparison = {
    initPositionControls: initPositionControls,
    changeVisibility: changeVisibility,
    openBenchmarkPicker: openBenchmarkPicker,
    startCompare: startCompare,
    onPageEnter: onPageEnter,
    goBackHoldings: goBackHoldings,
    openReplicatePanel: openReplicatePanel,
    closeReplicate: closeReplicate,
    doReplicate: doReplicate,
    closeSelf: closeSelf,
  };
})();
