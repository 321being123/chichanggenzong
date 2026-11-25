'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  isBondRatingDocument,
  isRatingResultNotice,
  inputDocuments,
} = require('../domain/convertibleBondAnalysisRules');
const { buildDatasetDiagnosticAlerts } = require('../services/jobOrchestrator');
const { callEndpoint } = require('../services/lixingerOfficial');
const { evaluateWorkerHealth } = require('../scripts/checkWorkerHealth');

async function run() {
  // 1. 纯主体信用评级结果公告不得误选为债项评级文档
  const issuerOnlyNotice = {
    title: '宝鸡钛业股份有限公司关于主体信用评级结果的公告',
    url: 'https://big5.sse.com.cn/site/cht/www.sse.com.cn/disclosure/listedinfo/announcement/c/new/2026-11-24/600456_20261124_3YA9.pdf',
    event_date: '2026-11-24',
  };
  assert.strictEqual(isRatingResultNotice(issuerOnlyNotice), false, '纯主体信用评级结果公告不是债项评级结果公告');
  assert.strictEqual(isBondRatingDocument(issuerOnlyNotice), false, '纯主体信用评级结果公告不得纳入债项评级文档');

  const bondNotice = {
    title: '宝鸡钛业股份有限公司关于“宝钛转债”跟踪信用评级结果的公告',
    url: 'https://example.com/bond-notice.pdf',
    event_date: '2026-07-25',
  };
  assert.strictEqual(isRatingResultNotice(bondNotice), true, '含转债的评级结果公告必须保留');
  assert.strictEqual(isBondRatingDocument(bondNotice), true, '含转债的评级结果公告必须入选');

  const dualNotice = {
    title: '某公司关于主体及可转换公司债券信用评级结果的公告',
    url: 'https://example.com/dual-notice.pdf',
    event_date: '2026-07-25',
  };
  assert.strictEqual(isRatingResultNotice(dualNotice), true, '同时含主体与可转换公司债券的评级结果公告必须保留');
  assert.strictEqual(isBondRatingDocument(dualNotice), true, '同时含主体与可转换公司债券的评级结果公告必须入选');

  const genericTrackingNotice = {
    title: '关于2026年度跟踪评级结果的公告',
    url: 'https://example.com/generic-notice.pdf',
    event_date: '2026-06-20',
  };
  assert.strictEqual(isRatingResultNotice(genericTrackingNotice), true, '未限定纯主体的常规跟踪评级结果公告仍保留');
  assert.strictEqual(isBondRatingDocument(genericTrackingNotice), true, '未限定纯主体的常规跟踪评级结果公告仍入选');

  const selected = inputDocuments(
    [
      issuerOnlyNotice,
      { title: '宝鸡钛业股份有限公司主体信用评级报告', url: 'https://example.com/issuer-report.pdf', event_date: '2026-11-24' },
      bondNotice,
    ],
    { bond_short_name: '宝钛转债', ts_code: '110101.SH', value_date: '2026-06-24' },
    {}
  );
  const selectedRatingUrls = selected.filter(item => item.kind === 'rating').map(item => item.event.url);
  assert.deepStrictEqual(selectedRatingUrls, [bondNotice.url], 'inputDocuments 只应选中债项评级文档，排除纯主体评级报告与结果公告');

  // 2. buildDatasetDiagnosticAlerts：verified_no_change 不误报，缺失 query_status 仍拦截
  const slot = { job_code: 'convertible_bond_universe_refresh', business_date: '2026-11-24' };
  const okAlerts = buildDatasetDiagnosticAlerts(slot, {
    publishDatasetCodes: ['bond_master', 'stock_adj_factor'],
    datasetDiagnostics: {
      bond_master: { dataAsOf: '2026-11-23', query_status: 'success', partition_row_count: 312 },
      stock_adj_factor: { dataAsOf: '2026-11-23', query_status: 'verified_no_change', partition_row_count: 0 },
    },
  });
  assert.strictEqual(okAlerts.length, 0, 'success 与 verified_no_change 不应触发分区降级告警');

  const missingStatusAlerts = buildDatasetDiagnosticAlerts(slot, {
    publishDatasetCodes: ['bond_master'],
    datasetDiagnostics: {
      bond_master: { dataAsOf: '2026-11-23', partition_row_count: 312 },
    },
  });
  assert.strictEqual(missingStatusAlerts.length, 1, '缺失 query_status 仍必须报降级告警，不得猜测成功');
  assert.ok(missingStatusAlerts[0].summary.includes('查询状态 unknown'), '缺失 query_status 应明确提示查询状态 unknown');

  // 静态守卫：修复的三处生产方均已显式写出 query_status
  const bondSafetySrc = fs.readFileSync(path.join(__dirname, '../services/bondSafetyService.js'), 'utf8');
  assert.ok(/bond_safety_snapshot:\s*\{[\s\S]*query_status:\s*'success'/.test(bondSafetySrc), 'bondSafetyService 必须显式写 query_status');
  const cbSyncSrc = fs.readFileSync(path.join(__dirname, '../services/convertibleBondAnalysisSync.js'), 'utf8');
  assert.ok(/bond_master:\s*\{[\s\S]*query_status:\s*'success'/.test(cbSyncSrc), 'convertibleBondAnalysisSync.bond_master 必须显式写 query_status');
  assert.ok(/stock_adj_factor:\s*\{[\s\S]*query_status:\s*stockAdjustmentRows\.length\s*\?\s*'success'\s*:\s*'verified_no_change'/.test(cbSyncSrc), 'convertibleBondAnalysisSync.stock_adj_factor 必须显式写 query_status');
  const finSyncSrc = fs.readFileSync(path.join(__dirname, '../services/companyFinancialIncrementalSync.js'), 'utf8');
  assert.ok(/failed_count:\s*failures\.length,\s*query_status:\s*complete\s*\?\s*'success'/.test(finSyncSrc), 'companyFinancialIncrementalSync 必须显式写 query_status');

  // 3. 理杏仁 403「时间跨度不能超过10年」必须归类为 INVALID_PARAMETER，不得误开 QUOTA_EXHAUSTED 熔断
  const prevToken = process.env.LIXINGER_TOKEN;
  process.env.LIXINGER_TOKEN = 'test-lixinger-token-for-403-param';
  try {
    let caught = null;
    try {
      await callEndpoint('cn/company/dividend', { stockCode: '600519', startDate: '2001-01-01', endDate: '2026-11-24' }, {
        client: {
          query: async (sql) => {
            if (/source_endpoint_policies/i.test(sql)) return { rows: [] };
            if (/external_circuits/i.test(sql)) return { rows: [] };
            if (/external_call_budgets/i.test(sql)) return { rows: [{ request_count: 1 }] };
            return { rows: [] };
          },
        },
        fetch: async () => ({
          ok: false,
          status: 403,
          text: async () => JSON.stringify({ code: 0, error: { name: 'ForbiddenError', message: '时间跨度不能超过10年。' } }),
        }),
      });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught, '403 时间跨度超限应抛出错误');
    assert.strictEqual(caught.code, 'INVALID_PARAMETER', '时间跨度超限应归类为 INVALID_PARAMETER 而非 ACCESS_FORBIDDEN');
  } finally {
    if (prevToken === undefined) delete process.env.LIXINGER_TOKEN;
    else process.env.LIXINGER_TOKEN = prevToken;
  }

  // 4. Worker 优雅重启过渡期判定
  assert.deepStrictEqual(evaluateWorkerHealth({ activeState: 'active', hasRecentHeartbeat: true }), { online: true, transitioning: false, summary: '' });
  assert.deepStrictEqual(evaluateWorkerHealth({ activeState: 'deactivating', hasRecentHeartbeat: true }), { online: true, transitioning: true, summary: '' });
  assert.deepStrictEqual(evaluateWorkerHealth({ activeState: 'activating', hasRecentHeartbeat: true }), { online: true, transitioning: true, summary: '' });
  assert.strictEqual(evaluateWorkerHealth({ activeState: 'deactivating', hasRecentHeartbeat: false }).online, false, '过渡期心跳超时仍必须判离线');
  assert.strictEqual(evaluateWorkerHealth({ activeState: 'inactive', hasRecentHeartbeat: true }).online, false, 'inactive 必须判离线');
  assert.strictEqual(evaluateWorkerHealth({ activeState: 'failed', hasRecentHeartbeat: true }).online, false, 'failed 必须判离线');
  assert.strictEqual(evaluateWorkerHealth({ activeState: 'active', hasRecentHeartbeat: false }).online, false, 'active 但无心跳必须判离线');

  console.log('online-alerts-20261124.test.js: all assertions passed');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
