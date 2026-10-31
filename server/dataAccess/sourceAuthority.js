// 数据层：来源权威等级的唯一判定处。
//
// 业务层只表达「同一事件有多份记录时，按权威等级选一份」，不需要知道具体是哪家供应商；
// 谁是交易所原文、谁更权威，集中定义在这里。等级越小越权威。
//
// 现状依据（写在这里，避免上层再散落同名判断）：
//   0 带原文凭据（raw_payload.documentId）—— 交易所公告原文解析出来的行
//   1 交易所站点来源（sse/szse/hkex/cninfo）—— 直接就着交易所页面采集
//   2 理杏仁官方 API —— 聚合口径，字段经指标字典换算
//   3 其他供应商（含历史 Tushare 行）
const EXCHANGE_SOURCE_CODES = Object.freeze(['sse', 'szse', 'hkex', 'cninfo']);
const OFFICIAL_API_SOURCE_CODE = 'lixinger_official';

// 分红/派息事件的来源权威等级。
function rankDividendSource(action) {
  if (action && action.raw_payload && action.raw_payload.documentId) return 0;
  const code = String((action && action.source_code) || '');
  if (EXCHANGE_SOURCE_CODES.includes(code)) return 1;
  if (code === OFFICIAL_API_SOURCE_CODE) return 2;
  return 3;
}

// 「备源快照」的来源判定：可转债财务兜底快照只在备源跑成功时才算可用，
// 上层只问"这份快照是不是备源产物"，不判断具体是哪家。
const FALLBACK_SOURCE_CODE = 'tushare';
function isFallbackSource(sourceCode) {
  return String(sourceCode || '') === FALLBACK_SOURCE_CODE;
}

module.exports = { rankDividendSource, isFallbackSource };
