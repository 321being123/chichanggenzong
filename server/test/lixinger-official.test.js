// 理杏仁官方接口：目录白名单、协议、守卫、原始留证与失败分支验收。
// 上游一律用替代传输（注入 fetch），不产生真实外部请求；真实小样本见 options 中的
// LIXINGER_LIVE_SMOKE=1 分支，默认不执行。
process.env.NODE_ENV = 'test';
process.env.LIXINGER_TOKEN = process.env.LIXINGER_TOKEN || 'test-token-never-stored';

const assert = require('assert');
const { pool } = require('../db/connection');
const catalog = require('../dataAccess/lixingerCatalog');
const { callEndpoint, unwrapPayload, SOURCE } = require('../services/lixingerOfficial');
const { migration179LixingerOfficialSource } = require('../db/migrations/lixingerOfficialSource');

const PREFIX = '/api';

// ---------- 一、目录白名单（不发网络、不连数据库） ----------
const cat = catalog.loadCatalog();
assert.strictEqual(cat.docVersion, '1.0.43', '目录必须来自官方 skill 1.0.43');
assert.ok(cat.counts.total > 200, '目录条目应覆盖官方全部接口');
assert.ok(cat.counts.admitted > 150, '已准入接口数量明显偏低');
assert.strictEqual(cat.counts.excluded > 0, true);

for (const endpoint of cat.endpoints) {
  assert.ok(endpoint.path.startsWith(PREFIX + '/'), `接口路径异常：${endpoint.key}`);
  assert.strictEqual(endpoint.host, 'https://open.lixinger.com', `接口主机非官方：${endpoint.key}`);
  assert.strictEqual(endpoint.method, 'POST', `接口方法异常：${endpoint.key}`);
  assert.ok(Array.isArray(endpoint.params) && endpoint.params.some(p => p.name === 'token'),
    `${endpoint.key} 缺少 token 参数说明`);
  if (endpoint.status === 'admitted') {
    assert.ok(!endpoint.key.startsWith('cn/fund'), `基金接口不应准入：${endpoint.key}`);
    assert.ok(!endpoint.key.startsWith('us/'), `美股接口不应准入：${endpoint.key}`);
  }
}
assert.ok(cat.endpoints.some(e => e.key === 'cn/fund/net-value' && e.status === 'excluded'));
assert.ok(cat.endpoints.some(e => e.key === 'us/index' && e.status === 'excluded'));

assert.strictEqual(catalog.getEndpoint('cn/company').key, 'cn/company');
// 2026-10-30 实测后定稿的状态：基金产品/美股仍排除，A股公司股东数据与美元指数准入，
// 官方文档错误且实测恒空的 VIX、上游 404 的上海金价排除。
assert.strictEqual(catalog.getEndpoint('cn/company/fund-shareholders').key, 'cn/company/fund-shareholders');
assert.strictEqual(catalog.getEndpoint('macro/usdx').key, 'macro/usdx');
for (const bad of ['cn/fund/net-value', 'us/index', 'cn/index/tracking-fund', 'macro/vix-fear-index',
  'macro/sge-gold-price', '../cn/company', 'https://open.lixinger.com/api/cn/company', '']) {
  assert.throws(() => catalog.getEndpoint(bad), /未准入/, `应拒绝未准入接口：${bad}`);
}
assert.strictEqual(catalog.endpointUrl(catalog.getEndpoint('cn/company')), 'https://open.lixinger.com/api/cn/company');
assert.strictEqual(catalog.apiNameOf(catalog.getEndpoint('cn/company/industries')), 'cn.company.industries');

// 请求体白名单：未声明参数、凭据字段（任意层级）、缺必选参数都要在本地拦住。
const company = catalog.getEndpoint('cn/company');
assert.deepStrictEqual(catalog.buildRequestBody(company, { stockCodes: ['600519'], pageIndex: 0 }),
  { stockCodes: ['600519'], pageIndex: 0 });
assert.throws(() => catalog.buildRequestBody(company, { foo: 'x' }), /不接受参数/);
assert.throws(() => catalog.buildRequestBody(company, { token: 'x' }), /禁止携带凭据/);
assert.throws(() => catalog.buildRequestBody(company, { stockCodes: [{ api_key: 'x' }] }), /禁止携带凭据/);
// 带默认值的参数在官方文档里也标必选，本地不拦缺参，交给上游 400。
assert.deepStrictEqual(catalog.buildRequestBody(company, {}), {});

// 官方响应信封：成功{code:1,data:[]}；失败{code:0,error:{}}；
// 不再沿用 GeoScope 时代"code 不等于 1 就算成功"的判断。
assert.deepStrictEqual(unwrapPayload({ code: 1, message: 'success', data: [{ a: 1 }] }, company).rows, [{ a: 1 }]);
assert.throws(() => unwrapPayload({ code: 0, error: { name: 'UnauthorizedError', message: 'token权限验证错误。' } }, company),
  /业务错误/);
assert.throws(() => unwrapPayload({ code: 1, data: {} }, company), /缺少 data 数组/);
assert.throws(() => unwrapPayload([], company), /响应格式异常/);

// 业务收口静态断言：行业分类必须走"官方优先 + Tushare 备源"，身份映射必须登记官方来源。
const fs = require('fs');
const path = require('path');
const stockAnalysisSource = fs.readFileSync(path.join(__dirname, '..', 'services', 'stockAnalysis.js'), 'utf8');
assert.match(stockAnalysisSource, /fetchOfficialIndustry/, '股票分析未接入理杏仁行业');
assert.match(stockAnalysisSource, /lixinger_official/, '行业取数未经统一身份映射');
assert.match(stockAnalysisSource, /index_member_all/, 'Tushare 行业备源被删除');
const identitySource = fs.readFileSync(path.join(__dirname, '..', 'services', 'securityIdentity.js'), 'utf8');
assert.match(identitySource, /lixinger_official' && type === 'stock_code'/, '未登记理杏仁证券代码映射');

// ---------- 二、守卫、协议与落库（替代传输 + 测试库） ----------
function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

async function resetState() {
  await migration179LixingerOfficialSource(pool);
  await migration179LixingerOfficialSource(pool);
  await pool.query(`DELETE FROM ops.raw_records WHERE source_id=(SELECT source_id FROM ops.data_sources WHERE source_code=$1)`, [SOURCE]);
  await pool.query(`DELETE FROM ops.external_circuits WHERE source LIKE $1`, [`${SOURCE}%`]);
  await pool.query(`DELETE FROM ops.external_call_budgets WHERE source=$1`, [SOURCE]);
  await pool.query(`DELETE FROM ops.source_endpoint_runtime WHERE source_id=(SELECT source_id FROM ops.data_sources WHERE source_code=$1)`, [SOURCE]);
  await pool.query(`DELETE FROM ops.source_endpoint_policies WHERE source_id=(SELECT source_id FROM ops.data_sources WHERE source_code=$1) AND api_name<>'*'`, [SOURCE]);
  await pool.query(`UPDATE ops.source_endpoint_policies SET permission_status='unknown',enabled=true
    WHERE source_id=(SELECT source_id FROM ops.data_sources WHERE source_code=$1)`, [SOURCE]);
}

(async () => {
  await resetState();

  const sources = await pool.query('SELECT source_code,enabled FROM ops.data_sources WHERE source_code IN ($1,$2) ORDER BY source_code',
    [SOURCE, 'geoscope_lixinger']);
  assert.strictEqual(sources.rows.length, 2, '官方来源与旧中转来源都应存在（历史保留）');
  for (const row of sources.rows) {
    if (row.source_code === 'geoscope_lixinger') assert.strictEqual(row.enabled, false, '旧 GeoScope 中转必须停用');
    else assert.strictEqual(row.enabled, true);
  }
  const basePolicy = await pool.query(`SELECT official_per_minute_limit,internal_per_minute_limit,internal_daily_limit,
      official_daily_limit,min_interval_ms,max_concurrency,timeout_ms,retry_policy
    FROM ops.source_endpoint_policies WHERE source_id=(SELECT source_id FROM ops.data_sources WHERE source_code=$1) AND api_name='*'`, [SOURCE]);
  const base = basePolicy.rows[0];
  assert.strictEqual(base.official_per_minute_limit, 1000, '官方 1000 次/分必须写入 official_*');
  assert.strictEqual(base.min_interval_ms, 28, '每秒 36 次用最小间隔 28ms 落实');
  assert.strictEqual(base.internal_per_minute_limit, null, '不得自设内部预算');
  assert.strictEqual(base.internal_daily_limit, null);
  assert.strictEqual(base.official_daily_limit, null, '每日额度没有依据必须保持空值');
  assert.strictEqual(base.retry_policy.max_attempts, 5);

  // 正常路径：请求头、请求体、落库与权限证据。
  let seen = null;
  const okFetch = async (url, options) => {
    seen = { url, options };
    return jsonResponse({ code: 1, message: 'success', total: 1, data: [{ stockCode: '600519', name: '贵州茅台' }] });
  };
  const first = await callEndpoint('cn/company', { stockCodes: ['600519'] }, { fetch: okFetch, sleep: async () => {} });
  assert.strictEqual(first.rows.length, 1);
  assert.strictEqual(first.empty, false);
  assert.strictEqual(first.rawRecordId > 0, true, '原始响应必须落库');
  assert.strictEqual(seen.url, 'https://open.lixinger.com/api/cn/company');
  assert.strictEqual(seen.options.method, 'POST');
  assert.strictEqual(seen.options.redirect, 'error');
  assert.match(seen.options.headers['Accept-Encoding'], /gzip/);
  assert.match(seen.options.headers['User-Agent'], /Chrome/);
  const sentBody = JSON.parse(seen.options.body);
  assert.strictEqual(sentBody.token, process.env.LIXINGER_TOKEN, 'token 只在请求时注入');
  assert.deepStrictEqual(sentBody.stockCodes, ['600519']);
  const stored = await pool.query(`SELECT payload,payload_hash FROM ops.raw_records
     WHERE source_id=(SELECT source_id FROM ops.data_sources WHERE source_code=$1)`, [SOURCE]);
  assert.strictEqual(stored.rows.length, 1);
  assert.strictEqual(JSON.stringify(stored.rows[0].payload).includes(process.env.LIXINGER_TOKEN), false,
    '原始记录不得保存凭据');
  const perm = await pool.query(`SELECT permission_status FROM ops.source_endpoint_policies
     WHERE source_id=(SELECT source_id FROM ops.data_sources WHERE source_code=$1) AND api_name='cn.company'`, [SOURCE]);
  assert.strictEqual(perm.rows[0].permission_status, 'available');
  const budget = await pool.query(`SELECT COALESCE(SUM(call_count),0)::int n FROM ops.external_call_budgets
     WHERE source=$1 AND api_name='*' AND window_type='minute'`, [SOURCE]);
  assert.strictEqual(budget.rows[0].n >= 1, true, '真实调用必须计入账号级预算');

  // 成功空结果：留证为 empty_but_accepted，不冒充覆盖完成。
  await callEndpoint('cn/company/profile', { stockCodes: ['600519'] }, {
    fetch: async () => jsonResponse({ code: 1, message: 'success', data: [] }), sleep: async () => {},
  });
  const emptyPerm = await pool.query(`SELECT permission_status FROM ops.source_endpoint_policies
     WHERE source_id=(SELECT source_id FROM ops.data_sources WHERE source_code=$1) AND api_name='cn.company.profile'`, [SOURCE]);
  assert.strictEqual(emptyPerm.rows[0].permission_status, 'empty_but_accepted');

  // 401：凭据失效，不重试、留证、终止。
  let attempts401 = 0;
  await assert.rejects(callEndpoint('cn/company/industries', { stockCode: '600519' }, {
    fetch: async () => { attempts401 += 1; return jsonResponse({ code: 0, error: { name: 'UnauthorizedError', message: 'token权限验证错误。' } }, 401); },
    sleep: async () => {},
  }), error => error.code === 'INVALID_CREDENTIAL');
  assert.strictEqual(attempts401, 1, '401 不得重试');

  // 400：参数错误，不重试。
  let attempts400 = 0;
  await assert.rejects(callEndpoint('cn/company/candlestick', { stockCode: '600519' }, {
    fetch: async () => { attempts400 += 1; return jsonResponse({ code: 0, error: { name: 'ParamsError', message: 'bad' } }, 400); },
    sleep: async () => {},
  }), error => error.code === 'INVALID_REQUEST');
  assert.strictEqual(attempts400, 1, '400 不得重试');

  // 5xx：按 1/2/4/8/16 秒退避重试 5 次后放弃，共 6 次真实请求，全部计入预算。
  let attempts5xx = 0;
  const sleeps = [];
  await assert.rejects(callEndpoint('cn/company/dividend', { stockCode: '600519' }, {
    fetch: async () => { attempts5xx += 1; return jsonResponse({ code: 0, error: { name: 'BadGateway' } }, 502); },
    sleep: async ms => { sleeps.push(ms); },
  }), error => error.code === 'UPSTREAM_5XX');
  assert.strictEqual(attempts5xx, 6, '5xx 应重试 5 次后停止');
  assert.deepStrictEqual(sleeps, [1000, 2000, 4000, 8000, 16000]);

  // 429：等待 1 秒重试一次；仍限流则单接口熔断并保留恢复时间。
  let attempts429 = 0;
  await assert.rejects(callEndpoint('cn/company/announcement', { stockCode: '600519' }, {
    fetch: async () => { attempts429 += 1; return jsonResponse({ code: 0, error: { name: 'TooManyRequests' } }, 429); },
    sleep: async () => {},
  }), error => error.code === 'RATE_LIMIT');
  assert.strictEqual(attempts429, 2, '429 只允许一次有界重试');
  const circuit = await pool.query(`SELECT recover_at,error_code FROM ops.external_circuits WHERE source=$1 AND state='open'`,
    [`${SOURCE}:cn.company.announcement`]);
  assert.strictEqual(circuit.rows.length, 1, '真实限流必须写入接口级熔断');
  assert.ok(circuit.rows[0].recover_at, '临时熔断必须有恢复时间');
  const otherEndpointCircuit = await pool.query(`SELECT 1 FROM ops.external_circuits WHERE source=$1`,
    [`${SOURCE}:cn.company`]);
  assert.strictEqual(otherEndpointCircuit.rows.length, 0, '单接口限流不得熔断其他接口');

  // 错误分支不得把失败写成有效事实：401/400/5xx/429 都不应新增 raw_records。
  const afterFailures = await pool.query(`SELECT count(*)::int n FROM ops.raw_records
     WHERE source_id=(SELECT source_id FROM ops.data_sources WHERE source_code=$1)`, [SOURCE]);
  assert.strictEqual(afterFailures.rows[0].n, 2, '只有两次成功响应允许落库');

  // 未准入接口在本地就被拒绝，不产生任何外采。
  let forbiddenFetch = 0;
  await assert.rejects(callEndpoint('cn/fund/net-value', { stockCode: '600519' }, {
    fetch: async () => { forbiddenFetch += 1; return jsonResponse({ code: 1, data: [] }); },
  }), /未准入/);
  assert.strictEqual(forbiddenFetch, 0, '未准入接口不得发出请求');

  // 缺凭据：直接拒绝，不发请求。
  const token = process.env.LIXINGER_TOKEN;
  delete process.env.LIXINGER_TOKEN;
  await assert.rejects(callEndpoint('cn/company', { stockCodes: ['600519'] }, {
    fetch: okFetch,
  }), error => error.code === 'NOT_CONFIGURED');
  process.env.LIXINGER_TOKEN = token;

  await resetState();
  console.log('lixinger-official.test.js 通过');
  await pool.end();
})().catch(async error => {
  console.error('lixinger-official.test.js 失败:', (error && error.stack) || error);
  await pool.end().catch(() => {});
  process.exit(1);
});
