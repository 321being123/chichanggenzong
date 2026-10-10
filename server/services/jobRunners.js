// 后台人工补跑入口。使用现有任务实现，避免在管理路由里复制业务逻辑。
async function runJobByCode(jobCode, reason = 'manual-retry', businessDate, context = {}) {
  switch (jobCode) {
    case 'company_financial_incremental_sync':
      {
        const targetTradeDate = context.targetTradeDate || context.targetDate || businessDate;
        return require('../jobs/companyFinancialIncrementalSync').runCompanyFinancialIncrementalSync(reason, {
          ...context,
          targetTradeDate,
          asOfDate: context.asOfDate || targetTradeDate,
        });
      }
    case 'bond_safety_refresh':
      {
        const { expectedDataDate } = require('./jobScheduleSlots');
        const targetTradeDate = expectedDataDate('bond_safety_refresh', businessDate);
        return require('../jobs/bondSafetyRefresh').runBondSafetyRefresh(reason, { targetTradeDate, readOnly: true });
      }
    case 'hk_rate':
      return require('../jobs/hkRate').runHkRateJob({ final: true, targetDate: businessDate });
    case 'nav_snapshot':
      if(context.mode==='cash_income') return require('./cashIncomeQueue').run({...context,targetDate:context.targetDate||businessDate});
      return {...await require('../jobs/navSnapshot').runNavSnapshotJob({ targetDate: businessDate }),mode:'core',publishDatasetCodes:['nav_snapshot']};
    case 'index_baseline':
      return require('../jobs/indexBaseline').runIndexBaselineJob(reason);
    case 'index_recent':
      return require('../jobs/indexBaseline').runIndexRecentJob();
    case 'market_volatility_sync':
      return require('../jobs/marketVolatilitySync').runMarketVolatilitySync(context);
    case 'stock_analysis_refresh':
      return require('../jobs/stockAnalysisRefresh').runStockAnalysisRefresh(reason, {
        ...context,
        targetDate: context.targetDate || businessDate,
      });
    case 'ipo_history_sync':
      return require('../jobs/ipoHistorySync').runIpoHistorySync(reason, businessDate, context);
    case 'hk_trade_rules_sync':
      return require('../jobs/hkTradeRulesSync').runHkTradeRulesSync(reason);
    case 'hk_trade_calendar_sync':
      return require('../jobs/hkTradeCalendarSyncJob').runHkTradeCalendarSync(reason, context);
    case 'hk_ipo_preopen':
      return require('../jobs/hkIpoSync').runHkIpoSync(
        ['subscription_midday', 'subscription_close'].includes(context.mode) ? context.mode : 'preopen',
        reason,
        { ...context, targetDate: context.targetDate || businessDate }
      );
    case 'hk_ipo_postclose':
      return require('../jobs/hkIpoSync').runHkIpoSync('postclose', reason, { ...context, targetDate: context.targetDate || businessDate });
    case 'hk_ipo_enrichment':
      return require('../jobs/hkIpoSync').runHkIpoSync('enrichment', reason, { ...context, targetDate: context.targetDate || businessDate });
    case 'arbitrage_sync':
      {const result=await require('../jobs/arbitrageSync').runArbitrageSync(reason, {...context,targetDate:context.targetDate||businessDate});
      return {...result,mode:context.mode==='cash_dividends'?'cash_dividends':'core',publishDatasetCodes:context.mode==='cash_dividends'?['stock_cash_dividend_facts']:['arbitrage_cases']};}
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
      return require('../jobs/holidaySync').ensureHolidaysCurrent({ businessDate });
    case 'site_analytics_retention':
      return require('./siteAnalytics').purgeAnalyticsData();
    case 'convertible_bond_universe_refresh': {
      const { expectedDataDate } = require('./jobScheduleSlots');
      const targetTradeDate = expectedDataDate('convertible_bond_universe_refresh', businessDate);
      if (process.env.NODE_ENV === 'test' && context.testScenario === 'suspension-failure') {
        return {
          ok: false,
          status: 'partial',
          error: '模拟停牌数据集失败',
          errorCode: 'DATASET_INCOMPLETE',
          errorType: 'data_quality',
          dataAsOf: targetTradeDate,
          failedDatasets: ['stock_suspend_calendar'],
          missingDates: [targetTradeDate],
          publishDatasets: false,
          testRunnerMode: 'suspension-failure',
        };
      }
      if (process.env.NODE_ENV === 'test' && context.testScenario === 'suspension-rate-limit') {
        return {
          ok: false,
          status: 'partial',
          error: '模拟 suspend_d 限流',
          errorCode: 'RATE_LIMIT',
          errorType: 'rate_limit',
          source: 'tushare',
          apiName: 'suspend_d',
          recoverAt: new Date(Date.now() + 60000).toISOString(),
          dataAsOf: targetTradeDate,
          failedDatasets: ['stock_suspend_calendar'],
          missingDates: [targetTradeDate],
          publishDatasets: false,
          testRunnerMode: 'suspension-rate-limit',
        };
      }
      if (process.env.NODE_ENV === 'test' && context.testScenario === 'suspension-success') {
        const { publishDatasetPartition } = require('./datasetPartitions');
        await publishDatasetPartition('stock_suspend_calendar', 'CN', {
          partitionKey: targetTradeDate,
          dataAsOf: targetTradeDate,
          rowCount: 0,
          diagnostics: {
            api_name: 'suspend_d',
            query_status: 'success',
            coverage_status: 'verified_no_suspension',
          },
        });
        return {
          ok: true,
          status: 'succeeded',
          dataAsOf: targetTradeDate,
          trade_date: targetTradeDate,
          failedDatasets: [],
          missingDates: [],
          publishDatasets: false,
          testRunnerMode: 'suspension-only',
          stageComplete: true,
          receivedFailedDatasets: context.failedDatasets || [],
        };
      }
      return require('../services/convertibleBondAnalysis').syncConvertibleBondUniverseWithBackfill(reason, {
        mode:context.mode,
        targetTradeDate,
        failedDatasets: context.failedDatasets || [],
        pendingStages: context.pendingStages || [],
        continuationCount: context.continuationCount,
        initialRemaining: context.initialRemaining,
        lastRemaining: context.lastRemaining,
        noProgressCount: context.noProgressCount,
        continuationMaxBatches: context.continuationMaxBatches,
        continuationStartedAt: context.continuationStartedAt,
        continuationMaxAgeHours: context.continuationMaxAgeHours,
        slotExternalCallsTotal: context.slotExternalCallsTotal,
        slotExternalCallsLimit: context.slotExternalCallsLimit,
        windowDays: context.windowDays,
        slotId: context.slotId,
      });
    }
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
        mode: context.mode || 'core',
      });
    case 'convertible_bond_announcement_reparse':
      return require('../services/convertibleBondAnalysis').syncConvertibleBondAnnouncementHistories({
        cachedOnly: true,
        retryFailed: true,
        limit: context.limit,
      });
    case 'convertible_bond_valuation_refresh':
      return require('../jobs/convertibleBondRefresh').runRefreshChain(reason, businessDate);
    case 'ipo_calendar_refresh': {
      const { expectedDataDate } = require('./jobScheduleSlots');
      const targetDate = expectedDataDate('ipo_calendar_refresh', businessDate);
      return require('../jobs/ipoCalendarRefresh').runIpoCalendarRefresh(reason, {
        ...context,
        targetDate,
        businessDate,
      });
    }
    default:
      if (jobCode && jobCode.indexOf('market_close:') === 0) {
        const label = jobCode.slice('market_close:'.length);
        return require('../jobs/marketClose').runMarketCloseByLabel(label, businessDate, context);
      }
      return { ok: false, unsupported: true, error: `暂未开放 ${jobCode} 的安全人工补跑入口` };
  }
}

module.exports = { runJobByCode };
