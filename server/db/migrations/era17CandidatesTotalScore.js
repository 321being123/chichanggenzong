// 候选表的排序分数放宽为 numeric。
//
// 背景（2026-11-23 生产实测）：投资要义的 total_score 是整数分值（三项名次加权的总分），
// 而格雷厄姆低估按方案 27.43 用「净流动资产盈余 ÷ 总市值」的比率排序（如 1.524293）。
// 原列是 integer，保存格雷厄姆批次时 PostgreSQL 直接报
//   invalid input syntax for type integer: "1.524293"
// 于是 0.9.4.17 上线后格雷厄姆从未成功落库：策略行、批次、候选全为 0，
// 页面按「已发布批次」展示，因此点进去始终是空的。
//
// 只放宽类型，不改变任何排序口径与投资要义已有整数值（整数在 numeric 中精确表示）。
// 列上索引由 PostgreSQL 在类型变更时自动重建，不额外维护。
async function migration209CandidatesTotalScoreNumeric(pool) {
  await pool.query(`ALTER TABLE analytics.stock_selection_candidates
    ALTER COLUMN total_score TYPE numeric(20,8)`);
}

module.exports = { migration209CandidatesTotalScoreNumeric };
