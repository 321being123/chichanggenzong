// 后台人工补跑入口。使用现有任务实现，避免在管理路由里复制业务逻辑。
async function runJobByCode(jobCode, reason = 'manual-retry', businessDate, context = {}) {
  switch (jobCode) {
    case 'bond_safety_refresh':
      {
        const { expectedDataDate } = require('./jobScheduleSlots');
        const targetTradeDate = expectedDataDate('bond_safety_refresh', businessDate);
        return require('../jobs/bondSafetyRefresh').runBondSafetyRefresh(reason, { targetTradeDate });
      }
    case 'hk_rate':
      return require('../jobs/hkRate').runHkRateJob();
    case 'nav_snapshot':
      return require('../jobs/navSnapshot').runNavSnapshotJob();
    case 'index_baseline':
      return require('../jobs/indexBaseline').runIndexBaselineJob(reason);
    case 'index_recent':
      return require('../jobs/indexBaseline').runIndexRecentJob();
    case 'market_volatility_sync':
      return require('../jobs/marketVolatilitySync').runMarketVolatilitySync(context);
    case 'stock_analysis_refresh':
      return require('../jobs/stockAnalysisRefresh').runStockAnalysisRefresh(reason, context);
    case 'ipo_history_sync':
      return require('../jobs/ipoHistorySync').runIpoHistorySync(reason, businessDate, context);
    case 'hk_trade_rules_sync':
      return require('../jobs/hkTradeRulesSync').runHkTradeRulesSync(reason);
    case 'arbitrage_sync':
      return require('../jobs/arbitrageSync').runArbitrageSync(reason);
    case 'arbitrage_reparse': {
      const { pool } = require('../db');
      const { rows } = await pool.query(
        'SELECT request_payload FROM ops.job_schedule_slots WHERE slot_id=$1',
        [context.slotId]
      );
      const caseId = Number(rows[0] && rows[0].request_payload && rows[0].request_payload.caseId);
      if (!Number.isSafeInteger(caseId) || caseId <= 0) {
        return { ok: false, error: '重新解析任务缺少有效事件编号' };
      }
      return require('../jobs/arbitrageReparse').runArbitrageReparse(caseId, reason);
    }
    case 'holiday_sync':
      return require('../jobs/holidaySync').ensureHolidaysCurrent().then(() => ({ ok: true }));
    case 'convertible_bond_universe_refresh': {
      const { expectedDataDate } = require('./jobScheduleSlots');
      const targetTradeDate = expectedDataDate('convertible_bond_universe_refresh', businessDate);
      return require('../services/convertibleBondAnalysis').syncConvertibleBondUniverseWithBackfill(reason, { targetTradeDate });
    }
    case 'convertible_bond_redemption_announcement_sync':
      return require('../services/convertibleBondRedemptionSync').syncConvertibleBondCallAnnouncements({
        toDate: businessDate && /^\d{4}-\d{2}-\d{2}$/.test(String(businessDate)) ? String(businessDate) : undefined,
      });
    case 'convertible_bond_revision_motive_inputs_sync':
      return require('../services/convertibleBondRevisionMotiveService').syncRevisionMotiveInputs({
        businessDate: businessDate && /^\d{4}-\d{2}-\d{2}$/.test(String(businessDate)) ? String(businessDate) : undefined,
        limit: context.limit,
      });
    case 'convertible_bond_revision_motive_calculate':
      return require('../services/convertibleBondRevisionMotiveService').calculateConvertibleBondRevisionMotiveScores(
        businessDate && /^\d{4}-\d{2}-\d{2}$/.test(String(businessDate)) ? String(businessDate) : undefined
      );
    case 'convertible_bond_announcement_history_sync':
      return require('../services/convertibleBondAnalysis').syncConvertibleBondAnnouncementHistories({
        tsCodes: context.tsCodes || context.bondCodes || [],
        fromDate: context.fromDate,
        toDate: businessDate && /^\d{4}-\d{2}-\d{2}$/.test(String(businessDate)) ? String(businessDate) : context.toDate,
        limit: context.limit,
        cachedOnly: false,
      });
    case 'convertible_bond_announcement_reparse':
      return require('../services/convertibleBondAnalysis').syncConvertibleBondAnnouncementHistories({
        cachedOnly: true,
        retryFailed: true,
        limit: context.limit,
      });
    case 'convertible_bond_valuation_refresh':
      return require('../jobs/convertibleBondRefresh').runRefreshChain(reason, businessDate);
    case 'ipo_calendar_refresh':
      return require('../jobs/ipoCalendarRefresh').runIpoCalendarRefresh(reason, context);
    default:
      if (jobCode && jobCode.indexOf('market_close:') === 0) {
        const label = jobCode.slice('market_close:'.length);
        return require('../jobs/marketClose').runMarketCloseByLabel(label, businessDate, context);
      }
      return { ok: false, unsupported: true, error: `暂未开放 ${jobCode} 的安全人工补跑入口` };
  }
}

module.exports = { runJobByCode };
