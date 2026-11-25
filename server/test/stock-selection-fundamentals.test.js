// 目标组合基本面补充指标（#39）：资产负债率与最近财报利润同比。
// 只替换 pool.query，验证派生口径与可见性过滤；不连接数据库。
'use strict';
const assert = require('assert');
const { pool } = require('../db/connection');
const repo = require('../repositories/stockSelectionRepository');

const original = pool.query;
const calls = [];
const BALANCE = [
  { company_id: '1', report_id: 11, period_end: '2026-09-30', total_assets: '100', total_liabilities: '40', assets_currency: 'CNY', liabilities_currency: 'CNY', currency_unverified: false },
  { company_id: '2', report_id: 12, period_end: '2026-09-30', total_assets: '100', total_liabilities: '40', assets_currency: 'CNY', liabilities_currency: 'HKD', currency_unverified: false },
  { company_id: '3', report_id: 13, period_end: '2026-09-30', total_assets: '0', total_liabilities: '40', assets_currency: 'CNY', liabilities_currency: 'CNY', currency_unverified: false },
  { company_id: '4', report_id: 14, period_end: '2026-09-30', total_assets: '100', total_liabilities: null, assets_currency: 'CNY', liabilities_currency: null, currency_unverified: false },
];
const INCOME = [
  { company_id: '1', report_id: 21, period_end: '2026-09-30', period_type: 'q3', net_profit: '100', currency_code: 'CNY', currency_unverified: false },
  { company_id: '1', report_id: 20, period_end: '2025-09-30', period_type: 'q3', net_profit: '80', currency_code: 'CNY', currency_unverified: false },
  { company_id: '2', report_id: 22, period_end: '2026-06-30', period_type: 'semiannual', net_profit: '50', currency_code: 'CNY', currency_unverified: false },
  { company_id: '2', report_id: 23, period_end: '2025-06-30', period_type: 'semiannual', net_profit: '0', currency_code: 'CNY', currency_unverified: false },
  { company_id: '3', report_id: 24, period_end: '2026-06-30', period_type: 'semiannual', net_profit: '60', currency_code: 'CNY', currency_unverified: false },
  { company_id: '5', report_id: 25, period_end: '2026-03-31', period_type: 'q1', net_profit: '10', currency_code: 'CNY', currency_unverified: false },
  { company_id: '5', report_id: 26, period_end: '2025-03-31', period_type: 'q1', net_profit: '-20', currency_code: 'CNY', currency_unverified: false },
  { company_id: '6', report_id: 27, period_end: '2026-09-30', period_type: 'q3', net_profit: '100', currency_code: 'CNY', currency_unverified: false },
  { company_id: '6', report_id: 28, period_end: '2025-09-30', period_type: 'q3', net_profit: '80', currency_code: 'HKD', currency_unverified: false },
  // 反馈 #102：02314.HK 同类——2026 中报 period_type 仍是 unknown，但同公司有已标注年报。
  { company_id: '7', report_id: 29, period_end: '2026-06-30', period_type: 'unknown', report_period_label: null, net_profit: '50', currency_code: 'HKD', currency_unverified: false },
  { company_id: '7', report_id: 30, period_end: '2025-06-30', period_type: 'unknown', report_period_label: null, net_profit: '40', currency_code: 'HKD', currency_unverified: false },
  { company_id: '7', report_id: 31, period_end: '2025-12-31', period_type: 'annual', report_period_label: 'annual_report', net_profit: '100', currency_code: 'HKD', currency_unverified: false },
  // 没有任何可靠年报锚点的 unknown 不得猜成半年报。
  { company_id: '8', report_id: 32, period_end: '2026-06-30', period_type: 'unknown', report_period_label: null, net_profit: '10', currency_code: 'HKD', currency_unverified: false },
];

pool.query = async (sql, params) => {
  calls.push({ sql, params });
  if (/total_assets/.test(sql)) return { rows: BALANCE };
  if (/net_profit_parent/.test(sql)) return { rows: INCOME };
  return { rows: [] };
};

(async () => {
  try {
    const map = await repo.loadMemberFundamentals({
      companyIds: [1, 2, 3, 4, 5, 6, 7, 8], asOfDate: '2026-09-30', availableBefore: '2026-10-01T00:00:00Z', market: 'CN',
    });
    // 只按批次可见时点读取合并报表，不新增表结构。
    assert.strictEqual(calls.length, 2);
    assert.ok(calls[0].sql.includes('announced_at < $2::date') && calls[0].sql.includes('available_at < $3::timestamptz'),
      '资产负债表必须按批次公告日与可见截止过滤');
    assert.ok(calls[0].sql.includes("r.statement_scope = 'consolidated'") && calls[0].sql.includes("r.report_kind = 'balance'"),
      '资产负债率只取合并资产负债表');
    assert.ok(calls[1].sql.includes("period_type IN ('annual','semiannual','q1','q3')"),
      '利润同比需覆盖一季报/半年报/三季报/年报');
    assert.ok(calls[1].sql.includes("r.period_type = 'unknown'"),
      '反馈 #102：unknown 历史记录必须进入读端归一化，不能整条过滤');
    assert.deepStrictEqual(calls[0].params, [[1, 2, 3, 4, 5, 6, 7, 8], '2026-09-30', '2026-10-01T00:00:00Z']);

    // 资产负债率 = 负债合计 / 资产合计；币种不一致、资产非正或缺值均为 null。
    assert.strictEqual(map.get('1').debtToAssetRatio, 0.4);
    assert.strictEqual(map.get('1').debtToAssetPeriodEnd, '2026-09-30');
    assert.strictEqual(map.get('2').debtToAssetRatio, null, '两科目币种不同不得相除');
    assert.strictEqual(map.get('3').debtToAssetRatio, null, '资产合计为 0 不得相除');
    assert.strictEqual(map.get('4').debtToAssetRatio, null, '负债缺失不得当 0');

    // 利润同比：上年同期匹配同报告期，零基数不可比，负基数按绝对值分母。
    assert.strictEqual(map.get('1').latestProfitYoy, 0.25);
    assert.strictEqual(map.get('1').latestProfitPeriodEnd, '2026-09-30');
    assert.strictEqual(map.get('2').latestProfitYoy, null, '上年同期为 0 不得计算同比');
    assert.strictEqual(map.get('3').latestProfitYoy, null, '缺上年同期不得计算同比');
    assert.strictEqual(map.get('5').latestProfitYoy, 1.5, '负基数按绝对值作分母');
    assert.strictEqual(map.get('6').latestProfitYoy, null, '币种不一致不得计算同比');
    assert.strictEqual(map.get('7').latestProfitPeriodEnd, '2026-06-30', 'unknown 中报必须凭同公司年报锚点识别为半年报');
    assert.strictEqual(map.get('7').latestProfitYoy, 0.25, '上年同期同样识别为半年报后计算同比');
    assert.strictEqual((map.get('8') || {}).latestProfitPeriodEnd || null, null, '没有可靠财年锚点时不得猜测 unknown 报告期');

    // 空输入不查库；没有资产负债表时仍可单独返回利润同比。
    calls.length = 0;
    const empty = await repo.loadMemberFundamentals({ companyIds: [], asOfDate: '2026-09-30' });
    assert.strictEqual(empty.size, 0);
    assert.strictEqual(calls.length, 0);
    console.log('stock selection fundamentals: ratio, yoy and visibility rules passed');
  } finally { pool.query = original; await pool.end(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
