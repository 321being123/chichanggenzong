// 券商对账证据审计，只作可选实收核验，不是公告计算入账前置门禁。
const { pool } = require('../db/connection');
const { loadCashInputs } = require('./accountCash');
const { resolveInstrument } = require('./securityIdentity');
const NavMath = require('../../public/shared/nav-math');
const CoreDate = require('../../public/shared/core-date');
const classifyCode = require('../../public/js/code-classify');
const txControl = require('../repositories/transactionControl');
const repository = require('../repositories/cashIncomeCoverageRepository.js');

async function auditCashIncomeCoverage(username, accountName, targetDate = CoreDate.todayInZone('Asia/Shanghai')) {
  if (!CoreDate.normalizeBusinessDate(targetDate)) throw new TypeError('无效覆盖审计日期');
  const client = await pool.connect();
  try {
    await txControl.begin(client, { isolation: 'REPEATABLE READ', readOnly: true });
    const account = (await repository.select_accounts([username,accountName], client)).rows[0];
    if (!account) throw Object.assign(new Error('账户不存在'), {status:404});
    const input = await loadCashInputs(username, accountName, client);
    const anchor = NavMath.selectCashAnchor(input.navHistory, targetDate);
    const rows = (await repository.select_positions([username,accountName,targetDate], client)).rows;
    const byCode = new Map();
    for (const r of rows) {
      if (!byCode.has(r.code)) byCode.set(r.code, { ...r, origins: new Set() });
      byCode.get(r.code).origins.add(r.origin);
    }
    const coverage = [];
    for (const row of byCode.values()) {
      const info = classifyCode(row.code,row.name);
      let explicitNonStock = row.type === '债权' || row.type === '现金' || /基金|可转债|现金/.test(row.subtype || '');
      const identity = await resolveInstrument({ instrumentId: row.instrument_id, canonicalCode: row.code }, client.query.bind(client));
      if(identity?.asset_class==='convertible_bond')explicitNonStock=false;
      const reasons = [];
      if (!anchor) reasons.push('missing_cash_anchor');
      if (!identity) reasons.push('missing_or_ambiguous_identity');
      const snapshots = (await repository.select_nav_position_snapshots([username,accountName,row.code,targetDate], client)).rows;
      if (!snapshots.length) reasons.push('missing_historical_position_anchor');
      // 现有表尚无逐批次完整性/原单位证据合同。数量已存在不表示此门禁通过。
      reasons.push('unverified_trade_history_coverage', 'unverified_quantity_unit');
      const market = identity?.market || info?.market || 'unknown';
      if (market === 'HK' || info?.isHK) reasons.push('unrecorded_stock_connect_channel', 'missing_net_settlement_evidence');
      else reasons.push('missing_dividend_settlement_evidence');
      const facts = identity ? (await repository.select_fundamental_corporate_actions([identity.instrument_id], client)).rows[0].count : 0;
      coverage.push({ code:row.code, instrumentId:identity?.instrument_id || null, market, origins:[...row.origins],
        historicalOnly: !row.origins.has('position'), cashAnchorDate:anchor?.date || null,
        positionAnchorDates:snapshots.map(r=>r.snapshot_date), facts,
        status:explicitNonStock ? 'explained_exclusion' : 'pending_verification',
        reasons:explicitNonStock ? ['outside_stock_dividend_scope'] : reasons });
    }
    const included = coverage.filter(r=>r.status !== 'explained_exclusion');
    const cash = NavMath.cashAt(input,targetDate);
    await txControl.commit(client);
    return { accountId:account.id, targetDate, algorithm:'cash-income-coverage-v1', scope:'all_current_and_historical_securities',
      verificationScope:'broker_settlement_evidence', brokerStatementsRequired:false, calculationPolicy:account.cash_income_policy, calculationState:account.cash_income_state,
      cashAnchorDate:anchor?.date || null, cashDataIncomplete:cash.incomplete,
      repo:{status:account.cash_income_policy?.enabled ? 'calculated_policy_estimate_pending_broker_verification' : 'pending_verification', reasons:[...(!anchor ? ['missing_cash_anchor'] : []),
        'unverified_available_cny_cash','unverified_repo_settlement_calendar','unverified_fee_timing']},
      summary:{total:coverage.length, denominator:included.length, eligible:included.filter(r=>!r.reasons.length).length, pending:included.filter(r=>r.reasons.length).length,
        excluded:coverage.length-included.length, historicalOnly:coverage.filter(r=>r.historicalOnly).length}, rows:coverage };
  } catch(e) { await txControl.rollback(client); throw e; }
  finally { client.release(); }
}
module.exports = { auditCashIncomeCoverage };
