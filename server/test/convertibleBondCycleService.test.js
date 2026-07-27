// 可转债周期：数据服务编排测试（内存 mock client，无需真实数据库）
// 运行：node server/test/convertibleBondCycleService.test.js
// 整改 P1-5：全部用例顺序 await 后再汇总，失败返回非零退出码，杜绝异步假通过。
const assert = require('assert');
const svc = require('../services/convertibleBondCycleService');

function makeMockClient() {
  const calls = { metrics: 0, bars: 0, cycleInsert: null, cursor: null };
  const client = {
    __prior: [],
    query: async (sql, params) => {
      if (/SELECT .* FROM core\.instruments WHERE canonical_code = ANY/.test(sql)) return { rows: [] };
      if (/INSERT INTO core\.instruments/.test(sql)) {
        const codes = params.filter((_, i) => i % 8 === 0);
        return { rows: codes.map((c, i) => ({ instrument_id: i + 1, canonical_code: c })) };
      }
      if (/INSERT INTO market\.convertible_bond_daily_metrics/.test(sql)) { calls.metrics++; return { rows: [] }; }
      if (/INSERT INTO market\.daily_bars/.test(sql)) { calls.bars++; return { rows: [] }; }
      if (/SELECT composite_value FROM analytics\.convertible_bond_cycle_daily/.test(sql)) {
        return { rows: client.__prior.map(v => ({ composite_value: v })) };
      }
      if (/INSERT INTO analytics\.convertible_bond_cycle_daily/.test(sql)) { calls.cycleInsert = params; return { rows: [] }; }
      if (/INSERT INTO ops\.sync_cursors/.test(sql)) { calls.cursor = params; return { rows: [] }; }
      return { rows: [] };
    },
  };
  return { client, calls };
}

function buildRows(n, opts) {
  opts = opts || {};
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      ts_code: '113' + String(100 + i).padStart(3, '0') + '.SH',
      trade_date: '20260727',
      close: opts.close == null ? 110 : opts.close,
      cb_value: opts.cb_value === undefined ? 90 : opts.cb_value,
      cb_over_rate: opts.premium === undefined ? 30 : opts.premium,
      vol: 1000, amount: 110000,
    });
  }
  return rows;
}

// 顺序执行的测试注册器：section 打标题，check 注册用例，最后统一 await
const tests = [];
function section(title) { tests.push({ title }); }
function check(name, fn) { tests.push({ name, fn }); }

section('A. rangeCutoff 纯函数');
check('all 返回 null，其余返回 YYYY-MM-DD', () => {
  assert.strictEqual(svc.rangeCutoff('all'), null);
  const r5 = svc.rangeCutoff('5y');
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(r5), '5y 格式异常');
  assert.ok(svc.rangeCutoff('5y') < svc.rangeCutoff('1y'), '5y 截止日应早于 1y');
});

section('B. 有效样本（>=100）写入聚合、保存事实、推进游标');
check('120 只有效样本：S=119、W=0.30、全相等分位=50.0、档位中位', async () => {
  const { client, calls } = makeMockClient();
  // 300 个历史样本全为 119，当天也是 119：
  // 相等值含当天自身 → less=0，equal=301，total=301，Q=(0+0.5×301)/301×100=50.0。
  client.__prior = new Array(300).fill(119);
  const res = await svc.processCycleDay('20260727', buildRows(120), { sourceId: 1, client });
  assert.strictEqual(res.stored, true, '应写入');
  assert.strictEqual(res.failed, false, '不应标记失败');
  assert.ok(calls.cycleInsert, '未写入周期聚合');
  const p = calls.cycleInsert;
  assert.strictEqual(p[3], 120);                       // bond_count
  assert.ok(Math.abs(p[6] - 110) < 1e-6, '价格中位数应为 110');
  assert.ok(Math.abs(p[8] - 30) < 1e-6, '溢价率中位数应为 30');
  assert.ok(Math.abs(p[9] - 0.30) < 1e-6, '权重应为 0.30');
  assert.ok(Math.abs(p[10] - 119) < 1e-6, '综合估值应为 119');
  assert.ok(Math.abs(p[11] - 50.0) < 1e-6, '全相等分位应为 50.0，实得 ' + p[11]);
  assert.strictEqual(p[12], '中位', '档位应为中位');
  assert.ok(calls.cursor, '未更新游标');
  assert.ok(calls.metrics > 0 && calls.bars > 0, '未保存原始事实');
});

section('C. 低质量样本（<100）不发布指标，但保存事实并推进游标');
check('50 只样本：未发布、failed=false、原因 insufficient_bond_count、仍存事实并推进游标', async () => {
  const { client, calls } = makeMockClient();
  client.__prior = new Array(300).fill(100);
  const res = await svc.processCycleDay('20260726', buildRows(50), { sourceId: 1, client });
  assert.strictEqual(res.stored, false);
  assert.strictEqual(res.failed, false, '低质量属市场事实，不应标记失败');
  assert.strictEqual(res.reason, 'insufficient_bond_count');
  assert.ok(!calls.cycleInsert, '低质量日不应写入聚合');
  assert.ok(calls.cursor, '低质量日仍应推进游标');
  assert.ok(calls.metrics > 0, '低质量日仍应保存原始事实');
});

section('D. 空数据不发布且不推进游标');
check('空数组：failed=true、原因 empty_rows、未更新游标', async () => {
  const { client, calls } = makeMockClient();
  const res = await svc.processCycleDay('20260725', [], { sourceId: 1, client });
  assert.strictEqual(res.stored, false);
  assert.strictEqual(res.failed, true, '空数据应标记失败');
  assert.strictEqual(res.reason, 'empty_rows');
  assert.ok(!calls.cursor, '空数据不应推进游标');
});

section('E. 上游返回达上限（>=2000 行）拒绝发布');
check('2001 行：failed=true、原因 upstream_row_limit_reached、不存事实不推游标', async () => {
  const { client, calls } = makeMockClient();
  const big = [];
  for (let i = 0; i < 2001; i++) big.push({ ts_code: '113' + String(100 + i).padStart(3, '0') + '.SH', trade_date: '20260724', close: 110, cb_value: 90, cb_over_rate: 30 });
  const res = await svc.processCycleDay('20260724', big, { sourceId: 1, client });
  assert.strictEqual(res.stored, false);
  assert.strictEqual(res.failed, true, '上游截断应标记失败');
  assert.strictEqual(res.reason, 'upstream_row_limit_reached');
  assert.ok(!calls.cycleInsert, '达上限不应写入聚合');
  assert.ok(!calls.cursor, '达上限不应推进游标');
});

section('F. 溢价率字段全缺判为数据异常（整改 P0-1）');
check('120 只样本价格正常但溢价率全空：failed=true、原因 premium_fields_missing、不存事实不推游标', async () => {
  const { client, calls } = makeMockClient();
  const res = await svc.processCycleDay('20260723', buildRows(120, { premium: null, cb_value: null }), { sourceId: 1, client });
  assert.strictEqual(res.stored, false);
  assert.strictEqual(res.failed, true, '溢价率全缺应标记失败');
  assert.strictEqual(res.reason, 'premium_fields_missing');
  assert.ok(!calls.cycleInsert, '异常日不应写入聚合');
  assert.ok(!calls.cursor, '异常日不应推进游标');
  assert.strictEqual(calls.metrics, 0, '异常日不应保存事实（防止半截数据永久驻留）');
});

section('G. 游标只前进 + 重复回填幂等（SQL 语义检查）');
check('游标更新使用 GREATEST（只前进不后退），事实/聚合写入使用 ON CONFLICT（重复不产生新记录）', async () => {
  const sqls = [];
  const { client } = makeMockClient();
  const origQuery = client.query;
  client.query = async (sql, params) => { sqls.push(String(sql)); return origQuery(sql, params); };
  client.__prior = new Array(300).fill(119);
  await svc.processCycleDay('20260727', buildRows(120), { sourceId: 1, client });
  const cursorSql = sqls.find(s => /INSERT INTO ops\.sync_cursors/.test(s));
  assert.ok(cursorSql && /GREATEST\(/.test(cursorSql), '游标 SQL 应使用 GREATEST 保证只前进');
  const metricsSql = sqls.find(s => /INSERT INTO market\.convertible_bond_daily_metrics/.test(s));
  assert.ok(metricsSql && /ON CONFLICT/.test(metricsSql), '事实写入应使用 ON CONFLICT 幂等');
  const cycleSql = sqls.find(s => /INSERT INTO analytics\.convertible_bond_cycle_daily/.test(s));
  assert.ok(cycleSql && /ON CONFLICT/.test(cycleSql), '聚合写入应使用 ON CONFLICT 幂等');
});

section('H. 版本隔离（formula_version + universe_version 双过滤）');
check('分位窗口/最新/历史查询 SQL 均含 universe_version 过滤', async () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'convertibleBondCycleService.js'), 'utf8');
  // fetchPriorComposites / getLatestCycle / getCycleHistory 的 SQL 必须同时按两个版本过滤
  const blocks = src.split(/async function /);
  for (const name of ['fetchPriorComposites', 'getLatestCycle', 'getCycleHistory']) {
    const block = blocks.find(b => b.startsWith(name));
    assert.ok(block, '缺少函数 ' + name);
    assert.ok(/formula_version\s*=/.test(block), name + ' 未按 formula_version 过滤');
    assert.ok(/universe_version\s*=/.test(block), name + ' 未按 universe_version 过滤');
  }
});

section('I. 过期判断用交易日历（节假日/盘中不误报）');
check('国庆假期、周末、盘中、发布后各场景预期数据日正确', async () => {
  const { expectedTradeDate } = require('../routes/bondCycle');
  assert.ok(typeof expectedTradeDate === 'function', '路由未导出 expectedTradeDate');
  // 2026-10-01（周四，法定节假日）→ 回退到 9-30（周三，交易日）
  assert.strictEqual(expectedTradeDate(new Date(2026, 9, 1, 10, 0)), '2026-09-30', '节假日应回退到上一交易日');
  // 2026-07-26（周日）→ 回退到 7-24（周五）
  assert.strictEqual(expectedTradeDate(new Date(2026, 6, 26, 12, 0)), '2026-07-24', '周末应回退到上一交易日');
  // 2026-07-27（周一，交易日）盘中 10:00（未到发布时刻）→ 允许展示 7-24，不误报
  assert.strictEqual(expectedTradeDate(new Date(2026, 6, 27, 10, 0)), '2026-07-24', '盘中应允许展示上一交易日');
  // 2026-07-27（周一，交易日）18:00（已过发布时刻）→ 预期当天
  assert.strictEqual(expectedTradeDate(new Date(2026, 6, 27, 18, 0)), '2026-07-27', '发布后预期应为当天');
});

section('J. 事务隔离（主同步先提交，周期用独立事务）');
check('主同步 COMMIT 在周期计算之前，周期计算使用独立连接', async () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'convertibleBondAnalysis.js'), 'utf8');
  const commitIdx = src.indexOf("await client.query('COMMIT')");
  const cycleIdx = src.indexOf('processCycleDay');
  assert.ok(commitIdx > -1, '未找到主同步 COMMIT');
  assert.ok(cycleIdx > -1, '未找到周期计算调用');
  assert.ok(commitIdx < cycleIdx, '主同步必须在周期计算之前提交');
  assert.ok(src.includes('cycleClient'), '周期计算应使用独立连接（cycleClient）');
});

// —— 顺序执行全部用例，全部 await 后再汇总；任一失败退出码非零 ——
(async () => {
  const results = [];
  for (const t of tests) {
    if (t.title) { console.log(t.title); continue; }
    try {
      await t.fn();
      results.push(['PASS', t.name]);
      console.log('  [PASS] ' + t.name);
    } catch (e) {
      results.push(['FAIL', t.name + ' :: ' + e.message]);
      console.log('  [FAIL] ' + t.name + ' :: ' + e.message);
    }
  }
  const pass = results.filter(r => r[0] === 'PASS').length;
  const fail = results.filter(r => r[0] === 'FAIL').length;
  console.log('\n===== convertibleBondCycleService 测试汇总 =====');
  console.log('PASS=' + pass + '  FAIL=' + fail);
  if (fail > 0) { console.log('HAS_ISSUES'); process.exit(1); }
  console.log('ALL PASS');
})().catch((e) => { console.error('测试执行器异常：', e); process.exit(1); });
