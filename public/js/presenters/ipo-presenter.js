// 打新日历 Presenter（批次4：View／Presenter 分离）。
// 职责：持有市场/历史标签与响应序号状态、决定何时取数、何时把结果交给 View。
// 边界：本文件不直接操作 DOM（静态门禁按 role=presenter、allowDom=false 校验），
//       需要改界面时只调用 View 暴露的入口（window.ipoPaint*）；View 不取数，只渲染并上报用户操作。

// 标签、请求和内容共用同一状态；请求序号防止旧响应（含同市场分页）覆盖新选择。
var ipoHistoryType = 'stock';
var ipoHistoryRequestId = 0;
var ipoHistoryOffset = 0;
var ipoCalendarMarket = 'CN';
var ipoCalendarRequestId = 0;

// 主入口
async function loadIpo() {
  var initialMarket = ipoCalendarMarket;
  var initialCalendar = ipoSwitchMarket(initialMarket);
  ipoLoadHistory(ipoHistoryType);
  try {
    var rr = await window.siteApi.get('/api/ipo/report');
    if (!rr.ok) throw new Error('日报接口返回 ' + rr.status);
    var rep = rr.payload;
    var cal;
    if (initialMarket === 'CN') {
      cal = await initialCalendar;
      if (!cal) throw new Error('日历读取失败');
    } else {
      var rc = await window.siteApi.get('/api/ipo/calendar?days=90&market=CN');
      if (!rc.ok) throw new Error('日历接口返回 ' + rc.status);
      cal = rc.payload;
    }
    window.ipoPaintAdviceResult(rep, cal);
  } catch (e) {
    window.ipoPaintAdviceError();
  }
}

async function ipoSwitchMarket(market) {
  ipoCalendarMarket = market;
  var requestId = ++ipoCalendarRequestId;
  window.ipoPaintCalendarLoading(market);
  try {
    var r = await window.siteApi.get('/api/ipo/calendar?days=90&market=' + encodeURIComponent(market));
    if (!r.ok) throw new Error('日历接口返回 ' + r.status);
    var d = r.payload;
    if (requestId !== ipoCalendarRequestId) return d;
    window.ipoPaintCalendarResult(d);
    return d;
  } catch (e) {
    if (requestId !== ipoCalendarRequestId) return;
    window.ipoPaintCalendarError(e);
  }
}

// ========== 打新历史（集思录式列表） ==========
async function ipoLoadHistory(type) {
  return ipoLoadHistoryPage(type, 0, '1');
}

function ipoRefreshHistory() {
  return ipoLoadHistoryPage(ipoHistoryType, ipoHistoryOffset, 'force');
}

async function ipoLoadHistoryPage(type, offset, refreshQuotes) {
  var silent = refreshQuotes === 'force';
  ipoHistoryType = type;
  var requestId = ++ipoHistoryRequestId;
  var scrollLeft = window.ipoPaintHistoryLoading(type, silent);
  try {
    var pageSize = 200;
    var pageOffset = Math.max(Number(offset) || 0, 0);
    var r = await window.siteApi.get('/api/ipo/history?type=' + type + '&limit=' + pageSize + '&offset=' + pageOffset
      + (type !== 'bond' && refreshQuotes ? '&refresh_quotes=' + refreshQuotes : ''));
    if (!r.ok) throw new Error('历史接口返回 ' + r.status);
    var d = r.payload;
    if (requestId !== ipoHistoryRequestId) return;
    if (d.type !== type) throw new Error('历史接口返回的市场与所选市场不一致');
    ipoHistoryOffset = pageOffset;
    window.ipoPaintHistoryResult(type, d, pageOffset, pageSize, silent, scrollLeft);
  } catch (e) {
    if (requestId !== ipoHistoryRequestId) return;
    window.ipoPaintHistoryError(e, silent);
    if (silent && typeof showToast === 'function') showToast('行情刷新失败，保留原数据');
  } finally {
    if (requestId === ipoHistoryRequestId) window.ipoPaintHistoryDone();
  }
}
