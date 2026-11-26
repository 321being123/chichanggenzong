'use strict';

// 财报行是否已经带着「上游真实应答留证」（INC-0054 第一阶段第 4 条）。
//
// 停写两条「转换后报文再存一份」的路径必须看来源，而不是看数据集名：
// - 理杏仁行由 lixingerOfficial 按「来源＋请求键＋内容哈希」把真实应答留在 ops.raw_records，
//   行内 __statement_coverage.audit 记录了请求摘要、内容摘要与原始记录 ID，可回溯；
// - 备源行（Tushare 等）没有这条真实应答留存，直接停写就等于丢掉备源原始证据。
// 所以只有「来源 = 理杏仁官方 且 带审计指纹」的行才允许跳过转换报文写入。
const UPSTREAM_SOURCE = 'lixinger_official';

function statementAuditOf(row) {
  const coverage = row && typeof row === 'object' ? row.__statement_coverage : null;
  if (!coverage || typeof coverage !== 'object') return null;
  const audit = coverage.audit;
  return audit && typeof audit === 'object' && Object.keys(audit).length ? audit : null;
}

function hasUpstreamStatementEvidence(row) {
  if (!row || typeof row !== 'object') return false;
  if (String(row.source_code || '') !== UPSTREAM_SOURCE) return false;
  return Boolean(statementAuditOf(row));
}

module.exports = {
  UPSTREAM_SOURCE,
  statementAuditOf,
  hasUpstreamStatementEvidence,
};
