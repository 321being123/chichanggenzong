require('dotenv').config();

const { pool } = require('../db/connection');
const {
  normalizeBondCode,
  isoDate,
  refreshConvertibleBondAnalysis,
} = require('../services/convertibleBondAnalysis');

async function main() {
  const { rows } = await pool.query(
    `SELECT code,MAX(name) AS name
       FROM positions
      WHERE code ~ '^[0-9]{6}$'
      GROUP BY code
      ORDER BY code`
  );
  const requestedCode = normalizeBondCode(process.argv[2]);
  const holdings = rows
    .map(row => ({ ...row, tsCode: normalizeBondCode(row.code) }))
    .filter(row => row.tsCode && (!requestedCode || row.tsCode === requestedCode));
  const results = [];

  for (const holding of holdings) {
    process.stderr.write(`核验 ${holding.name || ''} ${holding.tsCode}...\n`);
    try {
      const analysis = await refreshConvertibleBondAnalysis(holding.tsCode, 'held-no-revision-audit');
      const latest = (((analysis || {}).history || {}).no_revision || [])[0] || null;
      const unresolved = latest && !latest.next_eligible_date;
      const purposes = String(analysis.basic && analysis.basic.fundraising_purpose || '').split(/\r?\n/).filter(Boolean);
      const incompletePrices = (analysis.history && analysis.history.price_changes || [])
        .filter(row => row.price_before == null || row.price_after == null);
      const missingRevisionFloors = (analysis.history && analysis.history.price_changes || []).filter(row =>
        /向下修正|下修/.test(String(row.reason || '')) && row.revision_floor_price == null);
      const emptyOutlooks = (analysis.rating_history || []).filter(row => !String(row.rating_outlook || '').trim());
      const missing = [];
      if (!purposes.length || purposes.some(item => /^\d+\.\d+$/.test(item.trim()) || /备案证明|有效期|受托管理/.test(item))) missing.push('募资用途');
      if (incompletePrices.length) missing.push(`转股价历史(${incompletePrices.length})`);
      if (missingRevisionFloors.length) missing.push(`下修底价(${missingRevisionFloors.length})`);
      if (analysis.bond && analysis.bond.pure_bond_value == null) missing.push('纯债价值');
      if (analysis.bond && analysis.bond.bond_floor_premium == null) missing.push('债底溢价率');
      if (analysis.option && analysis.option.option_value == null) missing.push('期权价值');
      if (analysis.option && analysis.option.theoretical_value == null) missing.push('理论价值');
      if (analysis.stock && analysis.stock.asset_liability_ratio == null) missing.push('资产负债率');
      if (analysis.stock && analysis.stock.dividend_yield == null) missing.push('股息率');
      if (analysis.basic && analysis.basic.fund_holding && analysis.basic.fund_holding.holding_ratio == null) missing.push('基金持仓占比');
      if (analysis.safety && analysis.safety.interest_coverage == null && analysis.safety.interest_coverage !== '行业豁免') missing.push('利息保障倍数');
      if (!(analysis.bond && analysis.bond.coupons || []).some(row => row.is_current)) missing.push('当前计息年度');
      if (emptyOutlooks.length) missing.push(`评级展望(${emptyOutlooks.length})`);
      if (unresolved) missing.push('不下修期限');
      results.push({
        code: holding.tsCode,
        name: holding.name,
        status: missing.length ? '数据不完整' : '通过',
        missing,
        fundraising_items: purposes.length,
        price_change_rows: (analysis.history && analysis.history.price_changes || []).length,
        rating_rows: (analysis.rating_history || []).length,
        latest_announcement: latest && latest.summary,
        source_url: latest && latest.source_url,
        valid_until: latest && isoDate(latest.valid_until),
        next_eligible_date: latest && isoDate(latest.next_eligible_date),
        put: analysis && analysis.basic ? {
          start_date: analysis.basic.earliest_put_trigger_date,
          maturity_date: analysis.basic.maturity_date,
          clause: analysis.terms && analysis.terms.put && analysis.terms.put.text,
          day_count: analysis.basic.put_day_count,
          observed_days: analysis.basic.put_observed_days,
          met: analysis.basic.put_met,
        } : null,
      });
    } catch (error) {
      results.push({ code: holding.tsCode, name: holding.name, status: '失败', error: error.message });
    }
  }

  console.log(JSON.stringify({ total: results.length, results }, null, 2));
  if (results.some(row => row.status !== '通过')) process.exitCode = 1;
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
