// 可转债名称裁决纯判定（2026-11-01 中科转债残名事故）。
// 约束：本文件只做「给定事实 → 判定结果」，不得出现 SQL、连接池、HTTP、子进程、req/res、DOM。
// 背景：公告解析出的简称会带正文残留（如「中科转债」被章节序号并成「中科转债二」），
// 而 cb_basic 官方简称（经主同步写入 fundamental.convertible_bond_profiles）是权威值。
// 判定顺序：官方简称 → 公告/发行名，官方简称存在时一律以它为准。

function pickAuthoritativeName(official, candidate) {
  return String(official || '').trim() || String(candidate || '').trim();
}

module.exports = { pickAuthoritativeName };
