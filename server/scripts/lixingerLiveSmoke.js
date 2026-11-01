#!/usr/bin/env node
// 理杏仁实源最小样本合同验证（验收 T-002/S-004 交付项）。
//
// 定位：这是**受控、人工触发**的实源抽样，不是每日定时任务，也不替代确定性回归。
//   - 必须显式开关 `LIXINGER_LIVE_SMOKE=1` 才会发真实请求（没有开关就 SKIP，不动网络）；
//   - 缺凭据输出 SMOKE_NOT_RUN（标"未运行"，不当通过也不当失败）；
//   - 请求走既有 `callEndpoint`：目录白名单、统一 Guard、额度/熔断、权限留证、原始响应落库全部复用；
//   - 失败按权限拒绝 / 限流 / 网络 / 响应非法 / 合同变化分类，并接入既有来源告警与恢复链路，不只让步骤变黄。
//
// 用法：
//   LIXINGER_LIVE_SMOKE=1 LIXINGER_TOKEN=... node server/scripts/lixingerLiveSmoke.js
//   LIXINGER_LIVE_SMOKE=1 node server/scripts/lixingerLiveSmoke.js --code=600519 --date=2026-10-30 --json
// 退出码：0 正常/空结果/未运行/跳过；1 合同或接口失败。
'use strict';

const SOURCE_API = 'cn/company/fundamental/non_financial';
const SOURCE_API_NAME = 'cn.company.fundamental.non_financial';
const DEFAULT_CODE = '600519';

function arg(name, fallback) {
  const hit = process.argv.find(item => item.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function today() {
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  return now.toISOString().slice(0, 10);
}

// 合同判定：成功空结果 ≠ 失败；结构/单位异常才是"合同变化"，必须单独分类。
function classifySmokeResult(rows) {
  if (!Array.isArray(rows) || !rows.length) return { status: 'EMPTY_OK', detail: '接口成功但当日无数据（合法空结果，不推进覆盖水位）' };
  const row = rows[0];
  if (!row || typeof row !== 'object' || !('stockCode' in row)) {
    return { status: 'CONTRACT_CHANGED', detail: '响应行缺少 stockCode 字段' };
  }
  const mc = Number(row.mc);
  const dyr = Number(row.dyr);
  if (Number.isFinite(mc) && mc > 0 && mc < 1e6) {
    return { status: 'CONTRACT_CHANGED', detail: `总市值单位异常（mc=${row.mc}，预期为元）` };
  }
  if (Number.isFinite(dyr) && Math.abs(dyr) > 100) {
    return { status: 'CONTRACT_CHANGED', detail: `股息率单位异常（dyr=${row.dyr}，预期为小数）` };
  }
  const hasMetric = ['pe_ttm', 'pb', 'dyr', 'mc', 'cmc'].some(key => Number.isFinite(Number(row[key])));
  if (!hasMetric) return { status: 'CONTRACT_CHANGED', detail: '估值指标全部缺失' };
  return { status: 'OK', detail: `样例 stockCode=${row.stockCode} pe_ttm=${row.pe_ttm} pb=${row.pb}` };
}

function classifyError(error) {
  const code = String((error && error.code) || '');
  if (['INVALID_CREDENTIAL', 'ACCESS_FORBIDDEN', 'PERMISSION_DENIED', 'ENDPOINT_DISABLED'].includes(code)) return 'PERMISSION';
  if (code === 'RATE_LIMIT') return 'RATE_LIMIT';
  if (['NETWORK_ERROR', 'NETWORK_TIMEOUT', 'UPSTREAM_5XX'].includes(code)) return 'NETWORK';
  if (code === 'INVALID_RESPONSE' || code === 'CONTRACT_CHANGED') return 'CONTRACT';
  if (['POLICY_NOT_CONFIGURED', 'JOB_BUDGET_EXCEEDED', 'DATASET_LOCKED', 'DEADLINE_EXCEEDED', 'CANCELLED'].includes(code)) return 'BLOCKED';
  return 'UNKNOWN';
}

/**
 * 执行一次实源抽样。依赖可注入，便于离线回归。
 * @returns {Promise<{status:string, detail:string, apiName?:string, code?:string}>}
 */
async function runSmoke({
  callEndpoint, catalog, code = DEFAULT_CODE, date = today(), metricsList, env = process.env,
} = {}) {
  if (String(env.LIXINGER_LIVE_SMOKE || '') !== '1') {
    return { status: 'SMOKE_SKIPPED', detail: '未设置 LIXINGER_LIVE_SMOKE=1，未发起真实请求' };
  }
  if (!String(env.LIXINGER_TOKEN || '').trim()) {
    return { status: 'SMOKE_NOT_RUN', detail: '缺少 LIXINGER_TOKEN，本次未运行（不视为通过）' };
  }
  const call = callEndpoint || require('../services/lixingerOfficial').callEndpoint;
  const metrics = metricsList || require('../dataAccess/adapters/lixingerDatasetAdapter').VALUATION_METRICS;
  try {
    const result = await call(SOURCE_API, {
      stockCodes: [code], date, metricsList: metrics,
    }, { dataset: 'stock_valuation_smoke', targetDate: date });
    const verdict = classifySmokeResult(result && result.rows);
    return { ...verdict, apiName: (result && result.apiName) || SOURCE_API_NAME, code: String(code), date };
  } catch (error) {
    return {
      status: classifyError(error),
      detail: String((error && error.message) || '').slice(0, 200),
      code: String(code), date, errorCode: (error && error.code) || null,
      apiName: SOURCE_API_NAME,
    };
  }
}

async function reportResult(result, { env = process.env } = {}) {
  const failed = !['OK', 'EMPTY_OK', 'SMOKE_SKIPPED', 'SMOKE_NOT_RUN'].includes(result.status);
  const summary = `理杏仁实源抽样：${result.status}（${result.detail || ''}）`;
  if (failed) {
    // 接入既有告警链路：来源+接口作用域，恢复后由 reconcile 关闭，而不是只留一条黄色步骤。
    try {
      await require('../services/jobAlertMailer').notifyJobFailure({
        jobCode: 'lixinger_live_smoke',
        alertKey: `source:lixinger_official:${result.apiName || SOURCE_API_NAME}:live_smoke`,
        alertType: 'source_contract',
        scopeType: 'source_endpoint',
        scopeKey: `lixinger_official:${result.apiName || SOURCE_API_NAME}`,
        subject: `理杏仁实源合同验证失败：${result.status}`,
        summary,
      });
    } catch (error) {
      console.warn('[live-smoke] 告警投递失败（不影响结论）：', String(error && error.message).slice(0, 160));
    }
  } else if (result.status === 'OK' || result.status === 'EMPTY_OK') {
    // 恢复证据：只有真正成功的一次抽样才关闭该接口的来源告警。
    try {
      await require('../services/jobAlertMailer').resolveSourceEndpointAlerts('lixinger_official', result.apiName || SOURCE_API_NAME);
    } catch (error) {
      console.warn('[live-smoke] 告警恢复收敛失败：', String(error && error.message).slice(0, 160));
    }
  }
  const line = `${result.status} ${result.detail || ''}`.trim();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ ...result, reportedAt: new Date().toISOString() }, null, 0));
  } else {
    console.log(line);
  }
  return failed ? 1 : 0;
}

async function main() {
  const result = await runSmoke({
    code: arg('code', DEFAULT_CODE),
    date: arg('date', today()),
  });
  const code = await reportResult(result);
  // 需要数据库写入（原始记录/告警）时等待连接池关闭，避免进程悬挂。
  try { await require('../db/connection').pool.end(); } catch (_) { /* 未连接时忽略 */ }
  process.exit(code);
}

if (require.main === module) {
  main().catch(error => {
    console.error('SMOKE_FAILED', String(error && error.message || error).slice(0, 160));
    process.exit(1);
  });
}

module.exports = { runSmoke, classifySmokeResult, classifyError, reportResult, SOURCE_API, SOURCE_API_NAME, DEFAULT_CODE };
