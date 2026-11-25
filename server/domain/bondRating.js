// 可转债信用评级归一化（唯一实现）。
//
// 背景（2026-11-25 线上反馈 #103）：Tushare cb_basic / cb_rating 会把评级机构后缀拼在等级后，
// 科创转债实际落库为 `AAsti`、`AA+sti`、`BBB+sti` 等，直接进入列表「全部评级」下拉和
// 估值折现率映射。`sti` 是上海新世纪评级（Shanghai New Century）的供应商后缀，不是评级本身，
// 展示与计算前必须剥离；原始上游报文仍保留在 raw_payload，可追溯。
//
// 只处理大小写不敏感的结尾 `sti` 与多余空白，不改写其他字母，也不把未知值猜成已知等级。

const RATING_PATTERN = /^(AAA|AA|A|BBB|BB|B|CCC|CC|C|D)([+-])?$/;

function normalizeBondRating(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return '';
  // 去掉结尾的评级机构后缀；允许 "AA+ sti" / "AA+STI" 这类带空格或大小写混写。
  const withoutAgency = raw.replace(/\s*sti\s*$/i, '').trim().toUpperCase();
  if (!withoutAgency) return '';
  return RATING_PATTERN.test(withoutAgency) ? withoutAgency : raw;
}

module.exports = { RATING_PATTERN, normalizeBondRating };
