// 只替换仓储读入口，验证个人结果原因的冻结投影和历史兼容；不连接或写入业务库。
'use strict';
const assert = require('assert');
const repo = require('../repositories/stockSelectionRepository');
const service = require('../services/stockSelectionService');
const originals = {};
for (const key of ['findRun', 'listCandidates', 'listMembers', 'listCandidatesForProjection', 'findCandidate']) originals[key] = repo[key];
let pass = 0;
async function check(name, fn) { await fn(); pass += 1; console.log('[PASS] ' + name); }

async function main() {
  const rows = Array.from({ length: 40 }, (_, index) => ({
    instrument_id: index + 1, code: 'X' + (index + 1), company_id: null, filter_status: 'PASS',
    selection_order: index + 1, industry_code: index < 7 ? 'SAME' : 'I' + index,
    industry_system: 'SW', industry_version: '2021', detail: {}, rank_ready: true,
  }));
  rows[38].rank_ready = false;
  rows[39].detail.anomaly = { status: 'FAIL', reason: 'annual_profit_anomaly' };
  rows.push({ instrument_id: 41, code: 'X41', filter_status: 'FAIL', detail: {} });
  rows.push({ instrument_id: 42, code: 'X42', filter_status: 'PENDING', detail: {} });
  let run = { run_id: 1, run_kind: 'personal', owner_username: 'ux-projection-test', market: 'CN', position_ratio: 1, parameters: {},
    input_manifest: { settingsSnapshot: { industryFilters: { CN: [], HK: [] }, excludedInstruments: [] } } };
  let members = rows.filter(row => row.instrument_id <= 31 && row.instrument_id !== 7);
  let projectionReads = 0;
  let visibleIds = [7, 32, 39, 40, 41, 42];
  repo.findRun = async () => structuredClone(run);
  repo.listMembers = async () => structuredClone(members);
  repo.listCandidates = async () => ({ rows: structuredClone(rows.filter(row => visibleIds.includes(row.instrument_id))), total: rows.length });
  repo.findCandidate = async ({ code }) => structuredClone(rows.find(row => row.code === code));
  repo.listCandidatesForProjection = async () => { projectionReads += 1; return structuredClone(rows); };

  await check('旧个人结果按全量冻结候选解释行业上限和席位已满', async () => {
    const result = await service.getCandidates({ runId: 1, limit: 6, offset: 0 });
    const reason = id => result.rows.find(row => row.instrument_id === id).personalNonSelectionReasons;
    assert.deepStrictEqual(reason(7), ['industry_limit']);
    assert.deepStrictEqual(reason(32), ['slots_full']);
    assert.deepStrictEqual(reason(39), ['rule_or_data_pending']);
    assert.deepStrictEqual(reason(40), ['annual_anomaly']);
    assert.deepStrictEqual(reason(41), ['rule_not_passed']);
    assert.deepStrictEqual(reason(42), ['rule_or_data_pending']);
    assert.strictEqual(result.rows[0].filter_status, 'PASS');
    assert.strictEqual(projectionReads, 1);
  });
  await check('有冻结原因摘要时分页不重复读取完整候选', async () => {
    run.input_manifest.portfolio = { selectionOutcomes: [{ instrumentId: 7, reason: 'industry_limit' }, { instrumentId: 32, reason: 'slots_full' }] };
    const result = await service.getCandidates({ runId: 1 });
    assert.deepStrictEqual(result.rows[0].personalNonSelectionReasons, ['industry_limit']);
    assert.strictEqual(projectionReads, 1);
  });
  await check('股票与行业交叠排除均保留，恢复股票后仍解释行业排除', async () => {
    run.input_manifest.settingsSnapshot = { excludedInstruments: [{ market: 'CN', instrumentId: 7, code: 'X7' }],
      industryFilters: { CN: [{ code: 'SAME', system: 'SW', version: '2021' }], HK: [] } };
    let result = await service.getCandidates({ runId: 1 });
    assert.deepStrictEqual(result.rows[0].personalNonSelectionReasons, ['user_excluded_instrument', 'user_excluded_industry']);
    run.input_manifest.settingsSnapshot.excludedInstruments = [];
    result = await service.getCandidates({ runId: 1 });
    assert.deepStrictEqual(result.rows[0].personalNonSelectionReasons, ['user_excluded_industry']);
  });
  await check('个人详情与候选返回相同未入选原因', async () => {
    run.input_manifest.settingsSnapshot.industryFilters.CN = [];
    const detail = await service.getStockDetail({ runId: 1, code: 'X32' });
    assert.deepStrictEqual(detail.candidate.personalNonSelectionReasons, ['slots_full']);
    assert.strictEqual(detail.candidate.personalStatus, 'not_selected');
  });
  // 调用现役路由处理函数，不启动 HTTP 服务；已在上游鉴权合同内构造本人会话。
  const router = require('../routes/stockSelection');
  async function routeResponse(routePath) {
    const layer = router.stack.find(item => item.route && item.route.path === routePath);
    let payload;
    const res = { json(value) { payload = value; return this; }, status(code) { throw new Error('意外响应：' + code); } };
    await layer.route.stack[layer.route.stack.length - 1].handle({ params: { id: '1' }, query: {}, session: { user: 'ux-projection-test' } }, res, error => { throw error; });
    return payload;
  }
  await check('候选 API 透传未入选原因', async () => {
    const response = await routeResponse('/runs/:id/candidates');
    assert.deepStrictEqual(response.candidates.find(row => row.code === 'X32').personalNonSelectionReasons, ['slots_full']);
  });
  await check('批次 API 不下发整表原因摘要且不修改冻结数据', async () => {
    const response = await routeResponse('/runs/:id');
    assert.strictEqual(response.inputManifest.portfolio.selectionOutcomes, undefined);
    assert.strictEqual(run.input_manifest.portfolio.selectionOutcomes.length, 2);
  });
  await check('零仓位旧个人结果显示观察而非席位已满', async () => {
    delete run.input_manifest.portfolio;
    run.position_ratio = 0;
    members = [];
    visibleIds = [1];
    const result = await service.getCandidates({ runId: 1 });
    assert.deepStrictEqual(result.rows[0].personalNonSelectionReasons, ['zero_position']);
  });
  await check('旧代码排除语义按冻结载荷兼容，新身份键不按代码通配', async () => {
    run.input_manifest.excludedIndustryCodes = ['SAME'];
    let result = await service.getCandidates({ runId: 1 });
    assert.deepStrictEqual(result.rows[0].personalNonSelectionReasons, ['user_excluded_industry']);
    run.input_manifest.excludedIndustryKeys = [];
    result = await service.getCandidates({ runId: 1 });
    assert.strictEqual(result.rows[0].personalExcluded, false);
    assert.deepStrictEqual(result.rows[0].personalNonSelectionReasons, ['zero_position']);
  });
  await check('历史回放与实际成员不一致时保留未知，不编造席位原因', async () => {
    run.position_ratio = 1;
    visibleIds = [32];
    const result = await service.getCandidates({ runId: 1 });
    assert.deepStrictEqual(result.rows[0].personalNonSelectionReasons, ['not_selected']);
  });
  await check('公共候选不增加个人选择状态', async () => {
    run.run_kind = 'weekly';
    const result = await service.getCandidates({ runId: 1 });
    assert.strictEqual(result.rows[0].personalStatus, undefined);
  });
}

main().then(() => console.log(`PASS=${pass} FAIL=0`)).catch(error => {
  console.error(error); process.exitCode = 1;
}).finally(() => { for (const [key, value] of Object.entries(originals)) repo[key] = value; });
