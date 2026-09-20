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

console.log('OK hk-ipo-diagnostics-alert: 动态数据集与精确来源告警隔离契约通过');
