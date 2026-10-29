// 套利机会 Presenter（批次4：View／Presenter 分离）。
// 职责：持有页签/详情/已看与未读计数状态、决定何时取数、何时把结果交给 View。
// 边界：本文件不直接操作 DOM（静态门禁按 role=presenter、allowDom=false 校验），
//       需要改界面时只调用 View 暴露的入口；View 不取数，只渲染并上报用户操作。

var arbState = {
  type: 'a_stock',
  data: null,
  loading: false,
  detailCaseId: null,
  detailData: null,
  markingSeen: {},
  unreadVersion: 0,
  unreadLoading: false,
  unreadTimer: null,
  // 请求序号守卫（防旧响应覆盖新状态）：列表/详情/未读/已看四条取数流各自领号，
  // 流内旧响应直接丢弃（不渲染、不写状态、不提示），流间互不作废（轮询/标记不得杀掉在途列表或详情）。
  seq: 0,
  detailSeq: 0,
  unreadSeq: 0,
  seenSeq: 0,
};

async function loadArbUnreadCount() {
  if (typeof username === 'undefined' || !username) { renderArbUnreadCount(0); return; }
  if (arbPageHidden()) return;
  var seq = (arbState.unreadSeq = (arbState.unreadSeq || 0) + 1);
  arbState.unreadLoading = true;
  var version = arbState.unreadVersion;
  try {
    var res = await window.siteApi.get('/api/arbitrage/unread-count', { cache: 'no-store' });
    if (arbState.unreadSeq !== seq) return;
    if (!res.ok) return;
    if (version === arbState.unreadVersion) renderArbUnreadCount(res.payload.unreadCount);
  } catch (error) { /* 查询失败保留已确认的计数 */ }
  finally { if (arbState.unreadSeq === seq) arbState.unreadLoading = false; }
}

async function markArbSeen(caseId) {
  // 同一案件防重复提交（防抖），不同案件互不影响；不拦截其他案件/其他取数的新调用。
  if (arbState.markingSeen[caseId]) return;
  var seq = (arbState.seenSeq = (arbState.seenSeq || 0) + 1);
  arbState.markingSeen[caseId] = true;
  arbSetSeenBusy(caseId, true);
  try {
    var res = await window.siteApi.post('/api/arbitrage/' + caseId + '/seen', {});
    if (arbState.seenSeq !== seq) return;
    var result = res.payload || {};
    if (!res.ok || !result.ok) throw new Error(result.error || '标记失败，请重试');
    renderArbUnreadCount(result.unreadCount);
    if (arbState.data) {
      arbState.data.rows.forEach(function (row) { if (Number(row.case_id) === caseId) row.is_new = false; });
      renderArbTable(arbState.data);
    }
    if (arbState.detailData && Number(arbState.detailCaseId) === caseId) {
      arbState.detailData.is_new = false;
      renderArbDetail(arbState.detailData);
    }
  } catch (error) {
    if (arbState.seenSeq !== seq) return;
    if (typeof showToast === 'function') showToast(error.message || '标记失败，请重试');
    arbSetStatus(error.message || '标记失败，请重试');
  } finally {
    // 本案按钮/防抖复位只影响本案件自己的 UI，必须无条件执行（不得被其他案件的新请求吞掉）。
    delete arbState.markingSeen[caseId];
    arbSetSeenBusy(caseId, false);
  }
}

// 加载数据
async function loadArbitrage() {
  // 请求序号守卫（防旧响应覆盖新状态）：每次取数领新序号作废旧请求，loading 仅作 UI 提示，不再拦截新调用。
  var seq = (arbState.seq = (arbState.seq || 0) + 1);
  arbSyncTabFromUrl();
  arbState.loading = true;
  arbSetStatus('\u6b63\u5728\u8bfb\u53d6\u5957\u5229\u6570\u636e...');
  try {
    var res = await window.siteApi.get('/api/arbitrage?type=' + arbState.type + '&page=1&page_size=100');
    if (arbState.seq !== seq) return;
    if (!res.ok) throw new Error('\u63a5\u53e3\u8fd4\u56de ' + res.status);
    var json = res.payload;
    arbState.data = json;
    renderArbUnreadCount(json.unreadCount);
    renderArbTable(json);
    arbOpenDetailFromUrl();
    arbSetStatus('');
  } catch (e) {
    if (arbState.seq !== seq) return;
    arbSetStatus('\u6570\u636e\u52a0\u8f7d\u5931\u8d25\uff1a' + (e.message || e));
  } finally {
    if (arbState.seq === seq) arbState.loading = false;
  }
}

// 详情
async function openArbDetail(caseId, skipPush) {
  arbDetailUrlState(caseId, skipPush);
  arbState.detailCaseId = caseId;
  arbState.detailData = null;
  if (!arbDetailLoading()) return;

  // 取数段开头领序号：旧详情响应不得覆盖新详情/新列表。
  var seq = (arbState.detailSeq = (arbState.detailSeq || 0) + 1);
  try {
    var res = await window.siteApi.get('/api/arbitrage/' + caseId);
    if (arbState.detailSeq !== seq) return;
    if (!res.ok) throw new Error('\u63a5\u53e3\u8fd4\u56de ' + res.status);
    var d = res.payload;
    arbState.detailData = d;
    renderArbDetail(d);
    if (window.SiteTelemetry && window.SiteTelemetry.trackDetail) window.SiteTelemetry.trackDetail({ page_key: 'arbitrage.detail', module: 'arbitrage', entry: 'list', detail_key: String(caseId), properties: { detail_type: 'arbitrage' } });
  } catch (e) {
    if (arbState.detailSeq !== seq) return;
    arbDetailError(e);
  }
}
