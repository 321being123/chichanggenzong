// AUDIT-01 人工共享数据操作审计测试（运行态 + 源码静态断言）
// 运行态：审计表新增 result/request_id/metadata；对象式入口写入成功与失败记录；
//         旧签名兼容；列表支持模块/操作者/结果筛选；敏感字段被过滤。
// 静态：7 类人工共享数据操作在成功与失败路径都记审计；后台审计页有筛选控件。
// 缺库时打印 ADMIN-AUDIT-SKIP 并跳过（不计入失败）。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { pool, runMigrations, auditLog, auditEvent, listAudit } = require('../db');

const results = [];
async function check(name, fn) {
  try { await fn(); results.push('PASS'); console.log('  [PASS] ' + name); }
  catch (e) { results.push('FAIL'); console.log('  [FAIL] ' + name + ' :: ' + (e && e.message ? e.message : e)); }
}

const ROOT = path.join(__dirname, '..', '..');
function readSrc(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

(async () => {
  // ===== 静态断言（不依赖数据库）=====
  const adminSrc = readSrc('server/routes/admin.js');
  const bondSafetySrc = readSrc('server/routes/bondSafety.js');
  const bondValuationSrc = readSrc('server/routes/bondValuation.js');
  const marketVolatilitySrc = readSrc('server/routes/marketVolatility.js');
  const positionComparisonSrc = readSrc('server/routes/positionComparison.js');
  const adminJsSrc = readSrc('public/js/admin.js');
  const adminHtmlSrc = readSrc('public/admin.html');
  const auditDbSrc = readSrc('server/db/config.js');

  await check('用户权限修改记审计（成功与失败）', () => {
    assert.ok(/auditEvent\(/.test(adminSrc), '后台未使用对象式审计入口');
    assert.ok(adminSrc.includes("'user_role'") && adminSrc.includes("result: 'failure'"),
      '用户权限修改缺少成功/失败审计');
  });
  await check('人工任务记审计（成功与失败）', () => {
    assert.ok(adminSrc.includes("'job_backfill'") && adminSrc.includes("'job_holiday_sync'"),
      '人工任务缺少审计');
  });
  await check('可转债安全性刷新记审计', () => {
    assert.ok(/auditEvent\(/.test(bondSafetySrc) && bondSafetySrc.includes("'bond_safety_refresh'"),
      '安全性刷新缺少审计');
    assert.ok(bondSafetySrc.includes("result: 'failure'"), '安全性刷新缺少失败审计');
  });
  await check('可转债估值刷新记审计', () => {
    assert.ok(/auditEvent\(/.test(bondValuationSrc) && bondValuationSrc.includes("'bond_valuation_refresh'"),
      '估值刷新缺少审计');
    assert.ok(bondValuationSrc.includes("result: 'failure'"), '估值刷新缺少失败审计');
  });
  await check('利率文件导入与首页周期配置记审计', () => {
    assert.ok(marketVolatilitySrc.includes("'market_rate_import'"), '利率导入缺少审计');
    assert.ok(marketVolatilitySrc.includes("'market_cycle_home'"), '首页周期配置缺少审计');
    assert.ok(marketVolatilitySrc.includes("result: 'failure'"), '共享数据操作缺少失败审计');
  });
  await check('官方标杆发布记审计', () => {
    assert.ok(/auditEvent\(/.test(positionComparisonSrc) && positionComparisonSrc.includes("'benchmark_publish'"),
      '标杆发布缺少审计');
    assert.ok(positionComparisonSrc.includes("result: 'failure'"), '标杆发布缺少失败审计');
  });
  await check('审计不写入敏感信息（源码不把密码/密钥塞进审计）', () => {
    const all = adminSrc + bondSafetySrc + bondValuationSrc + marketVolatilitySrc + positionComparisonSrc;
    const audits = all.match(/auditEvent\(\{[\s\S]{0,600}?\}\)/g) || [];
    audits.forEach(function (blk) {
      assert.ok(!/password|apiKey|api_key|token|secret|REGISTER_CODE/i.test(blk), '审计块疑似含敏感字段：' + blk.slice(0, 80));
    });
  });
  await check('审计错误摘要写入和读取均统一脱敏', () => {
    assert.ok(/sanitizeJobError\(e\.detail/.test(auditDbSrc), '审计 detail 写入前未脱敏');
    assert.ok(/detail: sanitizeJobError\(row\.detail/.test(auditDbSrc), '历史审计 detail 返回前未脱敏');
    assert.ok(/metadata: sanitizeJobResult\(row\.metadata/.test(auditDbSrc), '历史审计 metadata 返回前未递归脱敏');
    assert.ok(/out\[k\] = sanitizeJobError\(v, 200\)/.test(auditDbSrc), '审计 metadata 字符串值落库前未脱敏');
  });
  await check('后台审计页提供模块/操作者/结果筛选', () => {
    assert.ok(/audit-filter-module|auditFilter/.test(adminJsSrc + adminHtmlSrc), '审计页缺少筛选控件');
    assert.ok(adminJsSrc.includes('module=') && adminJsSrc.includes('result='), '审计列表未按模块/结果查询');
  });

  // ===== 运行态（需要数据库）=====
  let hasDb = true;
  try { await pool.query('SELECT 1'); } catch (e) { hasDb = false; }
  if (!hasDb) {
    console.log('ADMIN-AUDIT-SKIP (no database)');
    process.exit(0);
  }
  try { await runMigrations(); } catch (e) { /* 交由后续查询暴露 */ }

  const actor = 'audit_test_actor';
  await pool.query('DELETE FROM admin_audit_log WHERE actor=$1', [actor]).catch(function () {});

  await check('审计表具备 result / request_id / metadata 字段', async () => {
    const { rows } = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name='admin_audit_log'"
    );
    const cols = rows.map(function (r) { return r.column_name; });
    ['result', 'request_id', 'metadata'].forEach(function (c) {
      assert.ok(cols.indexOf(c) !== -1, '缺少字段 ' + c);
    });
  });
  await check('对象式入口写入成功记录（含请求 ID 与参数摘要）', async () => {
    await auditEvent({ actor, action: 'bond_safety_refresh', target: 'all', result: 'success',
      requestId: 'rid-success-1', metadata: { count: 3 } });
    const { rows } = await pool.query(
      "SELECT result, request_id, metadata FROM admin_audit_log WHERE actor=$1 AND request_id='rid-success-1'", [actor]);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].result, 'success');
    assert.strictEqual(rows[0].metadata.count, 3);
  });
  await check('对象式入口写入失败记录（含错误摘要）', async () => {
    await auditEvent({ actor, action: 'bond_valuation_refresh', target: 'all', result: 'failure',
      requestId: 'rid-fail-1', detail: '外部数据源超时' });
    const { rows } = await pool.query(
      "SELECT result, detail FROM admin_audit_log WHERE actor=$1 AND request_id='rid-fail-1'", [actor]);
    assert.strictEqual(rows[0].result, 'failure');
    assert.ok(rows[0].detail.indexOf('超时') !== -1);
  });
  await check('旧签名 auditLog 仍可用且默认标记成功', async () => {
    await auditLog(actor, 'user_role', 'someone', '设为管理员');
    const { rows } = await pool.query(
      "SELECT result FROM admin_audit_log WHERE actor=$1 AND action='user_role' ORDER BY id DESC LIMIT 1", [actor]);
    assert.strictEqual(rows[0].result, 'success');
  });
  await check('敏感字段不落库（密码/密钥/Token 被过滤）', async () => {
    await auditEvent({ actor, action: 'user_password', target: 'someone', requestId: 'rid-mask-1',
      metadata: { password: 'p@ss', apiKey: 'sk-123', token: 'tk', error: 'DB_PASS=raw-secret', ok: true } });
    const { rows } = await pool.query(
      "SELECT metadata FROM admin_audit_log WHERE actor=$1 AND request_id='rid-mask-1'", [actor]);
    const m = rows[0].metadata;
    assert.strictEqual(m.password, undefined, 'password 落库');
    assert.strictEqual(m.apiKey, undefined, 'apiKey 落库');
    assert.strictEqual(m.token, undefined, 'token 落库');
    assert.ok(!String(m.error || '').includes('raw-secret'), 'metadata 字符串中的密码原样落库');
    assert.strictEqual(m.ok, true, '正常字段被误删');
  });
  await check('列表支持按操作者、结果、模块筛选', async () => {
    const byActor = await listAudit(50, { actor });
    assert.ok(byActor.length >= 4, '按操作者筛选结果异常');
    const failures = await listAudit(50, { actor, result: 'failure' });
    assert.ok(failures.length >= 1 && failures.every(function (r) { return r.result === 'failure'; }),
      '结果筛选未生效');
    const bondOnly = await listAudit(50, { actor, module: 'bond' });
    assert.ok(bondOnly.length >= 2 && bondOnly.every(function (r) { return r.action.indexOf('bond_') === 0; }),
      '模块筛选未生效');
  });
  await check('列表返回请求 ID，可定位单次请求', async () => {
    const rows = await listAudit(50, { actor });
    assert.ok(rows.some(function (r) { return r.request_id === 'rid-success-1'; }), '列表缺少 request_id');
  });

  await pool.query('DELETE FROM admin_audit_log WHERE actor=$1', [actor]).catch(function () {});
  const failed = results.filter(function (r) { return r === 'FAIL'; }).length;
  console.log('admin-audit: ' + results.length + ' 项检查，失败 ' + failed);
  process.exit(failed ? 1 : 0);
})().catch(function (e) { console.error(e); process.exit(1); });
