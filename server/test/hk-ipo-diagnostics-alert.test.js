// 港股动态信号告警契约：核心事实成功时，动态分区和具体接口仍各自保留证据。
const assert = require('assert');
const { buildDatasetDiagnosticAlerts } = require('../services/jobOrchestrator');

const slot = { slot_id: 123, job_code: 'hk_ipo_preopen', business_date: '2026-09-20' };
const failed = buildDatasetDiagnosticAlerts(slot, {
  dataAsOf: '2026-09-20',
  datasetDiagnostics: {
    hk_ipo_subscription_signals: {
      query_status: 'failed',
      coverage_status: 'unknown',
      degraded_reason: [
        { source: 'livermore', apiName: 'hk_ipo_current', error: '429' },
        { source: 'livermore', apiName: 'hk_ipo_current', error: '重复错误' },
        { source: 'vbkr-public', apiName: 'hk_ipo_current', error: '空响应' },
      ],
    },
  },
});
assert.strictEqual(failed.length, 3, '应生成一个数据集告警和两个去重后的来源告警');
assert.ok(failed.some(item => item.scopeType === 'dataset' && item.scopeKey === 'hk_ipo_subscription_signals:HK:2026-09-20'));
assert.ok(failed.some(item => item.scopeType === 'source_endpoint' && item.scopeKey === 'livermore:hk_ipo_current'));
assert.ok(failed.some(item => item.scopeType === 'source_endpoint' && item.scopeKey === 'vbkr-public:hk_ipo_current'));

const fallback = buildDatasetDiagnosticAlerts(slot, {
  dataAsOf: '2026-09-20',
  datasetDiagnostics: {
    hk_ipo_subscription_signals: {
      query_status: 'success',
      coverage_status: 'complete',
      degraded_reason: [{ source: 'livermore', apiName: 'hk_ipo_current', error: '主源失败，已由备源接管' }],
    },
  },
});
assert.strictEqual(fallback.length, 1, '备源成功时不应把动态数据集标成失败，但仍保留主源接口告警');
assert.strictEqual(fallback[0].scopeType, 'source_endpoint');

const notAdmitted = buildDatasetDiagnosticAlerts(slot, {
  publishDatasetCodes: ['hk_ipo_facts', 'hk_ipo_subscription_signals'],
  datasetDiagnostics: {
    hk_ipo_subscription_signals: {
      query_status: 'not_run', coverage_status: 'unknown', source_status: 'not_admitted', degraded_reason: [],
    },
  },
});
assert.deepStrictEqual(notAdmitted, [], '未获准入且本轮未请求的动态源不能产生故障告警');

const enrichmentAttempted = buildDatasetDiagnosticAlerts({ ...slot, job_code: 'hk_ipo_enrichment' }, {
  publishDatasetCodes: ['hk_ipo_subscription_signals'],
  datasetDiagnostics: {
    hk_ipo_subscription_signals: {
      query_status: 'failed', degraded_reason: [{ source: 'hkipox-public', apiName: 'hk_ipo_public_page' }],
    },
  },
});
assert.strictEqual(enrichmentAttempted.length, 2, '补全阶段已采集 HKIPOx，失败时应告警数据集和对应来源');
assert.ok(enrichmentAttempted.some(item => item.scopeType === 'dataset'
  && item.scopeKey === 'hk_ipo_subscription_signals:HK:2026-09-20'));
assert.ok(enrichmentAttempted.some(item => item.scopeType === 'source_endpoint'
  && item.scopeKey === 'hkipox-public:hk_ipo_public_page'));

const notDeclared = buildDatasetDiagnosticAlerts({ ...slot, job_code: 'hk_ipo_postclose' }, {
  datasetDiagnostics: {
    hk_ipo_subscription_signals: {
      query_status: 'failed', degraded_reason: [{ source: 'hkipox-public', apiName: 'hk_ipo_public_page' }],
    },
  },
});
assert.deepStrictEqual(notDeclared, [], '不能为当前任务契约未声明的数据集发告警');

const bondMorning = buildDatasetDiagnosticAlerts({
  slot_id: 124, job_code: 'convertible_bond_announcement_history_sync', business_date: '2026-09-22',
}, {
  mode: 'core',
  publishDatasetCodes: ['bond_announcement_facts', 'bond_issuance_events', 'bond_redemption_events'],
  datasetDiagnostics: {
    bond_listing_liquidity: { query_status: 'success', quality_status: 'stale', coverage_status: 'incomplete' },
  },
});
assert.deepStrictEqual(bondMorning, [], '早间槽位未执行流通规模时不应产生该数据集告警');

const bondEvening = buildDatasetDiagnosticAlerts({
  slot_id: 125, job_code: 'convertible_bond_announcement_history_sync', business_date: '2026-09-22',
}, {
  mode: 'calendar', datasetDiagnostics: {
    bond_listing_liquidity: { query_status: 'success', quality_status: 'stale', coverage_status: 'incomplete' },
  },
});
assert.strictEqual(bondEvening.length, 1, '17:30 已尝试但覆盖不完整时必须产生分区质量告警');
assert.strictEqual(bondEvening[0].scopeKey, 'bond_listing_liquidity:CN:2026-09-22');

console.log('OK hk-ipo-diagnostics-alert: 动态数据集与精确来源告警隔离契约通过');
