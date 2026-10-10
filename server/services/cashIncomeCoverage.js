// 券商对账证据审计，只作可选实收核验，不是公告计算入账前置门禁。
const { pool } = require('../db/connection');
const { loadCashInputs } = require('./accountCash');
const { resolveInstrument } = require('./securityIdentity');
const NavMath = require('../../public/shared/nav-math');
const CoreDate = require('../../public/shared/core-date');
const classifyCode = require('../../public/js/code-classify');

async function auditCashIncomeCoverage(username, accountName, targetDate = CoreDate.todayInZone('Asia/Shanghai')) {
  if (!CoreDate.normalizeBusinessDate(targetDate)) throw new TypeError('无效覆盖审计日期');
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const account = (await client.query('SELECT id,cash_income_policy,cash_income_state FROM accounts WHERE username=$1 AND account_name=$2', [username,accountName])).rows[0];
    if (!account) throw Object.assign(new Error('账户不存在'), {status:404});
    const input = await loadCashInputs(username, accountName, client);
    const anchor = NavMath.selectCashAnchor(input.navHistory, targetDate);
    const rows = (await client.query(`SELECT code,name,type,subtype,instrument_id,'position' AS origin FROM positions WHERE username=$1 AND account_name=$2
      UNION ALL SELECT code,name,type,subtype,NULL,'trade' FROM trades WHERE username=$1 AND account_name=$2 AND COALESCE(trade_date,left(date,10)) <= $3
      UNION ALL SELECT instrument_code,'','','',NULL,'snapshot' FROM nav_position_snapshots WHERE username=$1 AND account_name=$2 AND snapshot_date <= $3::date`, [username,accountName,targetDate])).rows;
    const byCode = new Map();
    for (const r of rows) {
      if (!byCode.has(r.code)) byCode.set(r.code, { ...r, origins: new Set() });
      byCode.get(r.code).origins.add(r.origin);
    }
    const coverage = [];
    for (const row of byCode.values()) {
      const info = classifyCode(row.code,row.name);
      const explicitNonStock = row.type === '债权' || row.type === '现金' || /基金|可转债|现金/.test(row.subtype || '');
      const identity = await resolveInstrument({ instrumentId: row.instrument_id, canonicalCode: row.code }, client.query.bind(client));
      const reasons = [];
      if (!anchor) reasons.push('missing_cash_anchor');
      if (!identity) reasons.push('missing_or_ambiguous_identity');
      const snapshots = (await client.query(`SELECT snapshot_date::text,source FROM nav_position_snapshots
        WHERE username=$1 AND account_name=$2 AND instrument_code=$3 AND snapshot_date <= $4::date`, [username,accountName,row.code,targetDate])).rows;
      if (!snapshots.length) reasons.push('missing_historical_position_anchor');
      // 现有表尚无逐批次完整性/原单位证据合同。数量已存在不表示此门禁通过。
      reasons.push('unverified_trade_history_coverage', 'unverified_quantity_unit');
      const market = identity?.market || info?.market || 'unknown';
      if (market === 'HK' || info?.isHK) reasons.push('unrecorded_stock_connect_channel', 'missing_net_settlement_evidence');
      else reasons.push('missing_dividend_settlement_evidence');
      const facts = identity ? (await client.query(`SELECT count(*)::int AS count FROM fundamental.corporate_actions
        WHERE instrument_id=$1 AND action_type='dividend'`, [identity.instrument_id])).rows[0].count : 0;
      coverage.push({ code:row.code, instrumentId:identity?.instrument_id || null, market, origins:[...row.origins],
        historicalOnly: !row.origins.has('position'), cashAnchorDate:anchor?.date || null,
        positionAnchorDates:snapshots.map(r=>r.snapshot_date), facts,
        status:explicitNonStock ? 'explained_exclusion' : 'pending_verification',
        reasons:explicitNonStock ? ['outside_stock_dividend_scope'] : reasons });
    }
    const included = coverage.filter(r=>r.status !== 'explained_exclusion');
    const cash = NavMath.cashAt(input,targetDate);
    await client.query('COMMIT');
    return { accountId:account.id, targetDate, algorithm:'cash-income-coverage-v1', scope:'all_current_and_historical_securities',
      verificationScope:'broker_settlement_evidence', brokerStatementsRequired:false, calculationPolicy:account.cash_income_policy, calculationState:account.cash_income_state,
      cashAnchorDate:anchor?.date || null, cashDataIncomplete:cash.incomplete,
      repo:{status:account.cash_income_policy?.enabled ? 'calculated_policy_estimate_pending_broker_verification' : 'pending_verification', reasons:[...(!anchor ? ['missing_cash_anchor'] : []),
        'unverified_available_cny_cash','unverified_repo_settlement_calendar','unverified_fee_timing']},
      summary:{total:coverage.length, denominator:included.length, eligible:included.filter(r=>!r.reasons.length).length, pending:included.filter(r=>r.reasons.length).length,
        excluded:coverage.length-included.length, historicalOnly:coverage.filter(r=>r.historicalOnly).length}, rows:coverage };
  } catch(e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}
module.exports = { auditCashIncomeCoverage };
