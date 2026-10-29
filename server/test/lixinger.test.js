// 真实隔离 PG + 替代上游传输：验证落库、重复调用、权限隔离和失败保护。
const assert = require('assert');
require('dotenv').config();
const { pool } = require('../db/connection');
const { SOURCE, ENDPOINTS, extractLixingerData, extractWithLixingerBackup, fetchLixingerIndustry, unwrapResponse, validateRequest } = require('../services/lixinger');
const { migration178LixingerSource } = require('../db/migrations/lixingerSource');
const { getProviderRuntime, getExternalApiSettings, saveProviderSettings } = require('../services/externalApiConfig');

(async () => {
  await migration178LixingerSource(pool);
  await migration178LixingerSource(pool);
  assert.strictEqual((await pool.query('SELECT count(*)::int n FROM ops.data_sources WHERE source_code=$1', [SOURCE])).rows[0].n, 1);
  const policies = await pool.query(`SELECT p.* FROM ops.source_endpoint_policies p JOIN ops.data_sources s USING(source_id) WHERE s.source_code=$1`, [SOURCE]);
  assert.strictEqual(policies.rows.length, 8);
  for (const row of policies.rows) {
    assert.strictEqual(row.official_per_minute_limit, null);
    assert.strictEqual(row.internal_daily_limit, null);
    if (row.api_name === 'cn.index.fundamental' || row.api_name === 'cn.fund.net-value') assert.strictEqual(row.enabled, false);
  }
  for (const path of ['cn/fund/net-value', 'cn/index/fundamental', '../cn/company', 'https://example.com']) {
    assert.throws(() => validateRequest(path, {}), /未准入/);
  }
  assert.throws(() => validateRequest('cn/company', { token: 'never-send' }), /禁止携带凭据/);
  assert.throws(() => validateRequest('cn/company', { nested: { api_key: 'never-send' } }), /禁止携带凭据/);
  assert.throws(() => unwrapResponse({ code: -1, data: [] }), /业务错误/);
  assert.throws(() => unwrapResponse({ code: 1, data: {} }), /格式异常/);
  assert.deepStrictEqual(unwrapResponse({ data: { code: 1, data: [{ stockCode: '600519' }] } }), [{ stockCode: '600519' }]);

  const keyBefore = process.env.GEOSCOPE_API_KEY;
  process.env.GEOSCOPE_API_KEY = 'test-private-key-never-stored';
  await pool.query(`DELETE FROM ops.raw_records WHERE source_id=(SELECT source_id FROM ops.data_sources WHERE source_code=$1) AND dataset_code='lixinger_response'`, [SOURCE]);
  await pool.query(`UPDATE ops.source_endpoint_policies SET enabled=true,permission_status='unknown' WHERE source_id=(SELECT source_id FROM ops.data_sources WHERE source_code=$1) AND api_name='cn.company'`, [SOURCE]);
  let calls = 0;
  const transport = async (url, request) => {
    calls++;
    assert.strictEqual(url, 'https://geoscopeapp.com/api/v1/data/lixinger/cn/company');
    assert.strictEqual(request.redirect, 'error');
    assert.strictEqual(request.headers.Authorization, 'Bearer ' + process.env.GEOSCOPE_API_KEY);
    assert.deepStrictEqual(JSON.parse(request.body), { stockCodes: ['600519'] });
    return { ok: true, json: async () => ({ code: 1, data: [{ stockCode: '600519', name: '贵州茅台' }] }) };
  };
  const params = { stockCodes: ['600519'] };
  const first = await extractLixingerData('cn/company', params, { fetch: transport });
  const cached = await extractLixingerData('cn/company', params, { fetch: transport });
  assert.strictEqual(calls, 1);
  assert.strictEqual(first.source, SOURCE);
  assert.strictEqual(first.cached, false);
  assert.strictEqual(cached.cached, true);
  assert.strictEqual(cached.rawRecordId, first.rawRecordId);
  const raw = (await pool.query('SELECT payload FROM ops.raw_records WHERE raw_record_id=$1', [first.rawRecordId])).rows[0];
  assert(!JSON.stringify(raw).includes(process.env.GEOSCOPE_API_KEY), '原始记录不得包含密钥');

  const primary = { source: 'tushare', rows: [{ good: true }] };
  assert.strictEqual(await extractWithLixingerBackup(async () => primary, 'cn/company', params, { fetch: transport }), primary);
  assert.strictEqual(calls, 1, '主源有效时不访问备用源');
  const fallback = await extractWithLixingerBackup(async () => { throw Object.assign(new Error('主源无权限'), { code: 'PERMISSION_DENIED' }); }, 'cn/company', params, { fetch: transport });
  assert.strictEqual(fallback.rawRecordId, first.rawRecordId);
  await assert.rejects(extractWithLixingerBackup(async () => { throw Object.assign(new Error('任务止损'), { code: 'JOB_BUDGET_EXCEEDED' }); }, 'cn/company', params), /任务止损/);
  const industry = await fetchLixingerIndustry('600519.SH', { fetch: async (_url, request) => {
    assert.deepStrictEqual(JSON.parse(request.body), { stockCode: '600519' });
    return { ok: true, json: async () => ({ code: 1, data: [
      { stockCode: '460000', source: 'sw_2021', areaCode: 'cn', name: '食品饮料' },
      { stockCode: '460300', source: 'sw_2021', areaCode: 'cn', name: '白酒' },
      { stockCode: '460301', source: 'sw_2021', areaCode: 'cn', name: '白酒Ⅲ' },
      { stockCode: '999999', source: 'cni', areaCode: 'cn', name: '不混用国证分类' },
    ] }) };
  } });
  assert.strictEqual(industry.industry_source, SOURCE);
  assert.strictEqual(industry.industry_code, '460301');
  assert.deepStrictEqual(industry.industry_path, ['食品饮料', '白酒', '白酒Ⅲ']);
  assert(industry.industry_raw_record_id);

  // 并发相同证券与请求内容只发出一次；空结果落库留证但不能作为有效业务数据。
  let concurrentCalls = 0;
  const concurrentFetch = async () => { concurrentCalls++; return { ok: true, json: async () => ({ code: 1, data: [{ stockCode: '300750' }] }) }; };
  const pair = await Promise.all([1, 2].map(() => extractLixingerData('cn/company', { stockCodes: ['300750'] }, { fetch: concurrentFetch })));
  assert.strictEqual(concurrentCalls, 1);
  assert.strictEqual(pair[0].rawRecordId, pair[1].rawRecordId);
  let emptyCalls = 0;
  const emptyFetch = async () => { emptyCalls++; return { ok: true, json: async () => ({ code: 1, data: [] }) }; };
  for (let i = 0; i < 2; i++) await assert.rejects(extractLixingerData('macro/gdp', { areaCode: 'cn', startDate: '2026-04-01', endDate: '2026-06-30', metricsList: ['y.gdp.t'] }, { fetch: emptyFetch }), /空数据/);
  assert.strictEqual(emptyCalls, 1, '成功空结果仍复用缓存，不能反复撞击上游');
  await assert.rejects(extractLixingerData('cn/company', { stockCodes: ['601059'] }, { fetch: async () => { throw new Error(process.env.GEOSCOPE_API_KEY); } }), error => error.code === 'NETWORK_ERROR' && !error.message.includes(process.env.GEOSCOPE_API_KEY));

  await assert.rejects(extractLixingerData('cn/company', { stockCodes: ['601198'] }, { fetch: async () => ({ ok: false, status: 403 }) }), /HTTP 403/);
  const denied = await pool.query(`SELECT api_name,enabled FROM ops.source_endpoint_policies WHERE source_id=(SELECT source_id FROM ops.data_sources WHERE source_code=$1)`, [SOURCE]);
  assert.strictEqual(denied.rows.find(row => row.api_name === 'cn.company').enabled, false);
  assert.strictEqual(denied.rows.find(row => row.api_name === 'cn.company.fs.bank').enabled, true, '单接口拒绝不能禁用整个来源');
  const preserved = await extractLixingerData('cn/company', params, { fetch: () => { throw new Error('不应联网'); } });
  assert.strictEqual(preserved.rawRecordId, first.rawRecordId, '拒绝/失败不破坏已落库有效事实');

  for (const status of [400, 401, 403, 429, 503]) {
    await assert.rejects(extractLixingerData('cn/company', { stockCodes: [`600${status}`] }, {
      guard: async (_source, _dataset, _date, run) => run(),
      fetch: async () => ({ ok: false, status,
        json: async () => ({ code: `code_${status}`, error: `error_${status}`, request_id: `req_${status}` }) }),
    }), error => error.statusCode === status && error.upstreamCode === `code_${status}`
      && error.upstreamError === `error_${status}` && error.requestId === `req_${status}`,
    'HTTP状态、原始错误码及request_id必须完整保留');
  }
  await assert.rejects(extractLixingerData('cn/company', { stockCodes: ['600502'] }, {
    guard: async (_source, _dataset, _date, run) => run(),
    fetch: async () => ({ ok: false, status: 503,
      json: async () => ({ ok: false, data: { code: 'upstream_unavailable', error: 'temporary_failure', request_id: 'req_nested' } }) }),
  }), error => error.statusCode === 503 && error.upstreamCode === 'upstream_unavailable'
    && error.upstreamError === 'temporary_failure' && error.requestId === 'req_nested');

  assert.strictEqual((await getProviderRuntime(SOURCE)).primary, process.env.GEOSCOPE_API_KEY);
  const settings = await getExternalApiSettings();
  assert.strictEqual(settings[SOURCE].primary.configured, true);
  assert(!JSON.stringify(settings).includes(process.env.GEOSCOPE_API_KEY), '后台只返回配置掩码');
  await assert.rejects(saveProviderSettings(SOURCE, { primary_token: 'do-not-save' }), /只允许在 .env/);
  assert.strictEqual(Object.keys(ENDPOINTS).length, 6, '所有既有准入路径都有统一取数入口');

  // 不污染后续测试；只恢复本测试明确改动的接口状态，保留两条既有拒绝策略。
  await pool.query(`UPDATE ops.source_endpoint_policies SET enabled=true,permission_status='unknown' WHERE source_id=(SELECT source_id FROM ops.data_sources WHERE source_code=$1) AND api_name IN ('cn.company','macro.gdp')`, [SOURCE]);
  await pool.query(`DELETE FROM ops.external_circuits WHERE source=$1 AND token_fingerprint=$2`,
    [SOURCE, require('../services/externalCallGuard').tokenFingerprint(process.env.GEOSCOPE_API_KEY)]);
  if (keyBefore == null) delete process.env.GEOSCOPE_API_KEY; else process.env.GEOSCOPE_API_KEY = keyBefore;
  console.log('lixinger: 来源登记、受控请求、缓存去重、主备顺序、空结果、失败保留、权限隔离及密钥保护通过');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => pool.end());
