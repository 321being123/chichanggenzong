// ========== 可转债估值 Node 接口回归测试（e2e，挂真实 router + 本地 PG）==========
// 运行：node server/test/convertibleBondValuation.test.js
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const express = require('express');
const assert = require('assert');

const bondValuationRouter = require('../routes/bondValuation');

let server, base;
const results = [];
function check(name, fn) {
  try { fn(); results.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (e) { results.push(['FAIL', name + ' :: ' + e.message]); console.log('  [FAIL] ' + name + ' :: ' + e.message); }
}

async function main() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.session = { user: 'test' }; next(); });
  app.use('/api/bond-valuation', bondValuationRouter);
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;

  // 1. 列表
  console.log('== 1. GET /api/bond-valuation/bonds ==');
  let r = await fetch(base + '/api/bond-valuation/bonds');
  check('HTTP 200', () => assert.strictEqual(r.status, 200));
  let j = await r.json();
  check('返回 as_of_date', () => assert.ok('as_of_date' in j));
  check('返回 data 数组', () => assert.ok(Array.isArray(j.data)));
  check('返回 counts 对象', () => assert.strictEqual(typeof j.counts, 'object'));
  check('模型版本存在', () => assert.ok(j.model_version));
  let sample = null;
  if (j.data.length) {
    sample = j.data[0];
    check('行含 bond_code/bond_name', () => assert.ok(sample.bond_code && sample.bond_name));
    check('行含 fair_price 三件套', () => assert.ok('fair_price' in sample && 'fair_price_low' in sample && 'fair_price_high' in sample));
    // 业务规则校验（方案红线）
    for (const row of j.data) {
      if (row.fair_price_low != null && row.fair_price_high != null) {
        assert.ok(Number(row.fair_price_low) <= Number(row.fair_price_high), row.bond_code + ' 区间下限>上限');
      }
      if (row.valuation_percentile != null) {
        const p = Number(row.valuation_percentile);
        assert.ok(p >= 0 && p <= 100, row.bond_code + ' 分位越界:' + p);
      }
    }
    check('全部行：公允区间有序 & 分位 0-100', () => assert.ok(true));
    check('评价文案不含买卖建议', () => {
      for (const row of j.data) {
        const t = String(row.final_evaluation || '');
        assert.ok(!/买入|卖出|建议申购|建议持有/.test(t), row.bond_code + ' 出现建议性文案: ' + t);
      }
    });
    // 页面可用性红线：六档评价不能全为 0（全部"数据不足"= 页面不可用）
    check('六档评价非全零（页面可用）', () => {
      const c = j.counts || {};
      const valued = ['低估', '偏低估', '合理', '偏高估', '高估', '风险折价']
        .reduce((s, k) => s + (Number(c[k]) || 0), 0);
      assert.ok(valued > 0, '全部债券均为"数据不足"，页面不可用: ' + JSON.stringify(c));
      assert.ok(valued * 2 > j.data.length, '过半债券为"数据不足"(' + valued + '/' + j.data.length + ')');
    });
    // 数据新鲜度红线：估值日不得落后最新行情日
    const { pool } = require('../db');
    const { rows: mktRows } = await pool.query('SELECT MAX(trade_date)::text AS d FROM market.convertible_bond_daily_metrics');
    const latestMkt = mktRows[0] && mktRows[0].d ? String(mktRows[0].d).slice(0, 10) : null;
    check('估值日不过期（=最新行情日）', () => {
      assert.ok(!latestMkt || j.as_of_date === latestMkt, '估值日 ' + j.as_of_date + ' 落后最新行情日 ' + latestMkt);
    });
  } else {
    console.log('  (本地无估值数据，跳过行级校验)');
  }

  // 2. 筛选
  console.log('== 2. GET /bonds?final_evaluation=高估 ==');
  r = await fetch(base + '/api/bond-valuation/bonds?final_evaluation=' + encodeURIComponent('高估'));
  check('HTTP 200', () => assert.strictEqual(r.status, 200));
  j = await r.json();
  check('筛选结果全部含"高估"标签', () => {
    for (const row of j.data) assert.ok(String(row.final_evaluation).includes('高估'), '非高估: ' + row.final_evaluation);
  });

  // 3. 单券详情
  if (sample) {
    console.log('== 3. GET /bonds/:code ==');
    r = await fetch(base + '/api/bond-valuation/bonds/' + sample.bond_code);
    check('HTTP 200', () => assert.strictEqual(r.status, 200));
    j = await r.json();
    check('详情含 current/breakdown/safety/credit', () =>
      assert.ok('current' in j && 'breakdown' in j && 'safety' in j && 'credit' in j));
    check('breakdown 含锚定值与公允价', () =>
      assert.ok('anchor_value' in j.breakdown && 'fair_price' in j.breakdown));
    // 3b. 详情新字段（P1-2：数据状态/缺失字段/训练截止日/模型年份/历史安全性）
    check('详情含 data_status/model_version', () =>
      assert.ok('data_status' in j && 'model_version' in j));
    check('详情含 model_year/model_training_end_date/historical_safety', () =>
      assert.ok('model_year' in j && 'model_training_end_date' in j && 'historical_safety' in j));
    check('详情 missing_fields 为数组', () =>
      assert.ok(Array.isArray(j.missing_fields)));

    // 4. 历史
    console.log('== 4. GET /bonds/:code/history ==');
    r = await fetch(base + '/api/bond-valuation/bonds/' + sample.bond_code + '/history?range=all');
    check('HTTP 200', () => assert.strictEqual(r.status, 200));
    j = await r.json();
    check('历史 data 非空', () => assert.ok(Array.isArray(j.data) && j.data.length > 0));
    check('历史按日期升序', () => {
      for (let i = 1; i < j.data.length; i++) assert.ok(j.data[i].date >= j.data[i - 1].date);
    });
    check('历史返回模型固化边界 boundaries', () => {
      assert.ok(j.boundaries && j.boundaries.q20 != null && j.boundaries.q80 != null, '缺 boundaries');
      assert.ok(j.boundaries.q20 < j.boundaries.q40 && j.boundaries.q40 < j.boundaries.q60 &&
        j.boundaries.q60 < j.boundaries.q80, '边界不单调');
    });
    // 边界固化：不同查看范围返回的边界必须一致（不随范围重算）
    const rAllBoundaries = j.boundaries;
    r = await fetch(base + '/api/bond-valuation/bonds/' + sample.bond_code + '/history?range=1y');
    if (r.status === 200) {
      const j1y = await r.json();
      check('边界不随查看范围变化', () =>
        assert.deepStrictEqual(j1y.boundaries, rAllBoundaries, '1y 与 all 边界不一致'));
    }

    // 5. 非法 range
    r = await fetch(base + '/api/bond-valuation/bonds/' + sample.bond_code + '/history?range=10y');
    check('非法 range 返回 400', () => assert.strictEqual(r.status, 400));

    // 6. 单券预警
    console.log('== 5. GET /bonds/:code/alerts ==');
    r = await fetch(base + '/api/bond-valuation/bonds/' + sample.bond_code + '/alerts');
    check('HTTP 200', () => assert.strictEqual(r.status, 200));
    j = await r.json();
    check('返回 data 数组', () => assert.ok(Array.isArray(j.data)));
  }

  // 6b. 数据不足债券详情（P0-3 / P1-2：核心字段缺失仍保存并标记）
  console.log('== 6b. GET /bonds?data_status=数据不足 ==');
  r = await fetch(base + '/api/bond-valuation/bonds?data_status=' + encodeURIComponent('数据不足'));
  check('HTTP 200', () => assert.strictEqual(r.status, 200));
  let jd = await r.json();
  check('存在数据不足债券', () => assert.ok(Array.isArray(jd.data) && jd.data.length > 0));
  if (jd.data && jd.data.length) {
    const ins = jd.data[0];
    check('数据不足行 data_status=数据不足', () => assert.strictEqual(ins.data_status, '数据不足'));
    r = await fetch(base + '/api/bond-valuation/bonds/' + ins.bond_code);
    check('详情 HTTP 200', () => assert.strictEqual(r.status, 200));
    let dins = await r.json();
    check('数据不足详情 missing_fields 非空（含缺失列名）', () =>
      assert.ok(Array.isArray(dins.missing_fields) && dins.missing_fields.length > 0));
  }

  // 8b. 预警语义校验（P1-3：状态机字段齐全；安全性恶化仅中/高风险）
  console.log('== 8b. 预警语义校验 ==');
  r = await fetch(base + '/api/bond-valuation/alerts?limit=2000');
  check('HTTP 200', () => assert.strictEqual(r.status, 200));
  let ja = await r.json();
  const arows = ja.data || [];
  check('预警含状态机字段', () => {
    assert.ok(arows.length > 0, '无预警数据');
    for (const a of arows) assert.ok('alert_type' in a && 'current_state' in a && 'is_active' in a, '缺状态机字段');
  });
  check('安全性恶化不含 安全/低风险 档位', () => {
    for (const a of arows) {
      if (a.alert_type === '安全性恶化') {
        assert.ok(a.current_state !== '安全' && a.current_state !== '低风险', '安全性恶化误报:' + a.current_state);
      }
    }
  });
  check('恢复类预警不保持活动状态', () => {
    for (const a of arows) {
      if (String(a.alert_type).endsWith('（恢复）')) {
        assert.ok(!a.is_active, a.bond_code + ' 恢复记录仍为 active，会产生"恢复的恢复"');
      }
    }
  });
  check('高位类预警状态值不含每日分位', () => {
    for (const a of arows) {
      if (/估值进入(极端)?高位|估值进入低位/.test(a.alert_type) && !String(a.alert_type).endsWith('（恢复）')) {
        assert.ok(!/:\d/.test(String(a.current_state)), a.bond_code + ' 状态值含每日分位: ' + a.current_state);
      }
    }
  });
  check('单交易日预警量级正常（<600 条/日，防重复累加）', () => {
    const byDay = {};
    for (const a of arows) byDay[a.trade_date] = (byDay[a.trade_date] || 0) + 1;
    for (const d in byDay) assert.ok(byDay[d] < 600, d + ' 单日 ' + byDay[d] + ' 条预警，疑似重复触发');
  });

  // 7. 不存在的代码
  console.log('== 6. GET /bonds/999999.SH（不存在）==');
  r = await fetch(base + '/api/bond-valuation/bonds/999999.SH');
  check('返回 404', () => assert.strictEqual(r.status, 404));

  // 8. 预警总表
  console.log('== 7. GET /alerts ==');
  r = await fetch(base + '/api/bond-valuation/alerts');
  check('HTTP 200', () => assert.strictEqual(r.status, 200));
  j = await r.json();
  check('返回 total + data', () => assert.ok('total' in j && Array.isArray(j.data)));

  // 9. refresh 需要管理员（桩 session 无 admin → 应拒绝）
  console.log('== 8. POST /refresh 权限 ==');
  r = await fetch(base + '/api/bond-valuation/refresh', { method: 'POST' });
  check('非管理员被拒（401/403）', () => assert.ok(r.status === 401 || r.status === 403));

  server.close();
  const fail = results.filter(x => x[0] === 'FAIL').length;
  console.log(`\n结果：${results.length - fail}/${results.length} 通过`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
