// 上市可转债列表 Presenter（批次4：View／Presenter 分离）。
// 职责：持有列表与加载状态、决定何时取数、何时把结果交给 View。
// 边界：本文件不直接操作 DOM（静态门禁按 role=presenter、allowDom=false 校验），
//       需要改界面时只调用 View 暴露的入口；View 不取数，只渲染并上报用户操作。
var bondListState = { rows: [], filtered: [], sortKey: 'double_low', sortDir: 1, loaded: false, loading: false, lastRefreshAt: 0, refreshTimer: null, seq: 0, exportSeq: 0, tradeDate: null };

async function loadBondList(forceRefresh) {
  forceRefresh = Boolean(forceRefresh);
  if (!forceRefresh && bondListState.loaded && Date.now() - bondListState.lastRefreshAt < BOND_LIST_REFRESH_MS) {
    bondListApplyFilters();
    return;
  }
  // 请求序号守卫（防旧响应覆盖新状态）：真正发请求才领序号，旧响应直接丢弃（不渲染、不写状态、不提示）。
  // loading 仅作 UI 提示，不再拦截新调用，每次取数都领新序号作废旧请求。
  var seq = (bondListState.seq = (bondListState.seq || 0) + 1);
  bondListState.loading = true;
  bondListSetRefreshButton(true);
  try {
    var url = '/api/bond-analysis/bonds?limit=1000' + (forceRefresh ? '&refresh=1' : '');
    // 批次4：取数统一走 siteApi（View 不直接 fetch），错误与 JSON 解析由客户端归一。
    var result = await window.siteApi.get(url, { cache: 'no-store' });
    if (bondListState.seq !== seq) return;
    if (!result.ok) throw new Error('接口返回 ' + result.status);
    var data = result.payload;
    bondListState.rows = Array.isArray(data.data) ? data.data : [];
    bondListState.tradeDate = data.trade_date || null;
    bondListState.loaded = true;
    bondListState.lastRefreshAt = Date.now();
    bondListShowUpdated(data, forceRefresh);
    bondListApplyFilters();
  } catch (error) {
    if (bondListState.seq !== seq) return;
    bondListShowError(error);
  } finally {
    if (bondListState.seq === seq) {
      bondListState.loading = false;
      bondListSetRefreshButton(false);
      bondListStartAutoRefresh();
    }
  }
}

async function exportBondList() {
  // 点击瞬间冻结当前展示顺序与日期；异步完成后不得再读状态决定文件名或内容。
  var tradeDate = bondListState.tradeDate ? String(bondListState.tradeDate).slice(0, 10) : null;
  var fallbackDate = window.CoreDate && window.CoreDate.todayInZone
    ? window.CoreDate.todayInZone('Asia/Shanghai')
    : new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
  var filenameDate = tradeDate || fallbackDate;
  var rows = bondListState.filtered.map(bondListExportRow);
  var payload = { tradeDate: tradeDate, rows: rows };
  bondListSetExportButton(true, '导出中...');
  // 与列表取数分离的请求序号：旧导出响应直接丢弃，按钮复位由最后一次导出负责。
  var seq = (bondListState.exportSeq = (bondListState.exportSeq || 0) + 1);
  try {
    var exported = await window.siteApi.requestRaw('/api/bond-analysis/bonds/export', {
      method: 'POST',
      headers: window.siteApi.jsonHeaders(),
      body: JSON.stringify(payload),
    });
    if (bondListState.exportSeq !== seq) return;
    if (!exported.ok) {
      var error = exported.response ? await exported.response.json().catch(function () { return {}; }) : {};
      if (bondListState.exportSeq !== seq) return;
      throw new Error(error.error || exported.error || '导出失败');
    }
    var blob = await exported.response.blob();
    if (bondListState.exportSeq !== seq) return;
    bondListDownload(blob, filenameDate);
  } catch (error) {
    if (bondListState.exportSeq !== seq) return;
    if (typeof showToast === 'function') showToast(error.message || String(error));
  } finally {
    if (bondListState.exportSeq === seq) bondListSetExportButton(false, '导出 Excel');
  }
}
