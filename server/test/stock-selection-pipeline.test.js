// 投资策略选股中心：管道与落库专项测试（真实 PostgreSQL，任务隔离库）。
// 目的：证明「标准事实 → 四项规则 → 排名 → 30 席位 → 质量裁决 → 落库」在真库上可跑通，
// 并证明数据不完整时不会发布正式可投资组合（方案 7.3、9.3、10.5）。
// 夹具全部使用 ZZTEST 前缀并在 finally 清理，不触碰真实证券与历史数据。
'use strict';
const assert = require('assert');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const TEST_MARK = '6099';
const MARKET = 'CN';
const QUARTER = '2026Q3';
// 目标日由本地交易日历推导（不能用执行当天，也不能假设季度末必然是交易日）。
let AS_OF = null;
// 609xxx 为 A 股未分配号段，避免与真实证券碰撞；同时满足 core.instruments 的代码形态约束。
const CODES = [`${TEST_MARK}01.SH`, `${TEST_MARK}02.SH`, `${TEST_MARK}03.SH`, `${TEST_MARK}04.SH`];
// 公司名带唯一后缀，避免与历史残留或真实公司重名（companies 有 country+name 唯一约束）。
const COMPANY_NAME_PREFIX = '选股测试公司';
const RUN_TAG = Date.now().toString(36);

const tests = [];
function record(name, fn) {
  try { fn(); tests.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (error) { tests.push(['FAIL', name + ' :: ' + error.message]); console.log('  [FAIL] ' + name + ' :: ' + error.message); }
}

async function loadDeps() {
  const { pool } = require('../db/connection');
  const migrations = require('../db/migrations');
  await migrations.runMigrations();
  return { pool, service: require('../services/stockSelectionService') };
}

async function cleanup(pool) {
  const codes = CODES;
  await pool.query(`DELETE FROM analytics.stock_selection_runs WHERE market=$1 AND as_of_date=$2::date`, [MARKET, AS_OF]);
  await pool.query(`DELETE FROM analytics.stock_selection_backtests WHERE market=$1 AND start_date=$2::date`, [MARKET, AS_OF]);
  // 先按名称前缀兜底清扫（含上一次失败运行留下的残留公司），再按代码清理证券与事实。
  const stale = await pool.query(`SELECT company_id FROM core.companies WHERE legal_name LIKE $1`, [COMPANY_NAME_PREFIX + '%']);
  const staleIds = stale.rows.map(row => row.company_id);
  if (staleIds.length) {
    await pool.query(`DELETE FROM fundamental.financial_facts WHERE report_id IN (SELECT report_id FROM fundamental.financial_reports WHERE company_id = ANY($1::bigint[]))`, [staleIds]);
    await pool.query(`DELETE FROM fundamental.financial_reports WHERE company_id = ANY($1::bigint[])`, [staleIds]);
    await pool.query(`DELETE FROM core.company_industry_memberships WHERE company_id = ANY($1::bigint[])`, [staleIds]);
    await pool.query(`DELETE FROM core.company_instruments WHERE company_id = ANY($1::bigint[])`, [staleIds]);
    await pool.query(`DELETE FROM fundamental.corporate_actions WHERE instrument_id IN (SELECT instrument_id FROM core.instruments WHERE canonical_code = ANY($1))`, [codes]);
    await pool.query(`DELETE FROM core.instruments WHERE canonical_code = ANY($1)`, [codes]);
    await pool.query(`DELETE FROM core.companies WHERE company_id = ANY($1::bigint[])`, [staleIds]);
  }
  const { rows: instruments } = await pool.query(
    `SELECT instrument_id FROM core.instruments WHERE canonical_code = ANY($1)`, [codes]);
  const instrumentIds = instruments.map(row => row.instrument_id);
  if (instrumentIds.length) {
    await pool.query(`DELETE FROM market.daily_valuations WHERE instrument_id = ANY($1::bigint[]) AND trade_date=$2::date`, [instrumentIds, AS_OF]);
    await pool.query(`DELETE FROM market.daily_bars WHERE instrument_id = ANY($1::bigint[]) AND trade_date=$2::date`, [instrumentIds, AS_OF]);
    await pool.query(`DELETE FROM fundamental.corporate_actions WHERE instrument_id = ANY($1::bigint[])`, [instrumentIds]);
    await pool.query(`DELETE FROM core.company_instruments WHERE instrument_id = ANY($1::bigint[])`, [instrumentIds]);
    await pool.query(`DELETE FROM core.instruments WHERE instrument_id = ANY($1::bigint[])`, [instrumentIds]);
  }
  await pool.query(`DELETE FROM core.industry_nodes WHERE industry_code = $1`, [TEST_MARK + '_IND']);
  await pool.query(`DELETE FROM market.index_valuation_history WHERE index_code='000985' AND trade_date=$1::date`, [AS_OF]);
}

async function seed(pool) {
  const sourceRow = await pool.query(`SELECT source_id FROM ops.data_sources ORDER BY source_id LIMIT 1`);
  const sourceId = sourceRow.rows[0] ? sourceRow.rows[0].source_id : null;
  const taxonomy = await pool.query(`SELECT taxonomy_id FROM core.industry_taxonomies WHERE taxonomy_code='SW2021' LIMIT 1`);
  assert.ok(taxonomy.rows[0], '测试环境缺少 SW2021 行业分类，无法验证行业上限');

  const node = await pool.query(
    `INSERT INTO core.industry_nodes (taxonomy_id, industry_code, industry_name, level) VALUES ($1,$2,$3,1) RETURNING industry_node_id`,
    [taxonomy.rows[0].taxonomy_id, TEST_MARK + '_IND', '测试一级行业']);
  const nodeId = node.rows[0].industry_node_id;

  const instrumentIds = [];
  for (let index = 0; index < CODES.length; index++) {
    const code = CODES[index];
    const company = await pool.query(
      `INSERT INTO core.companies (legal_name, short_name, country_code, company_type) VALUES ($1,$2,'CN','listed') RETURNING company_id`,
      ['选股测试公司' + RUN_TAG + index, TEST_MARK + index]);
    const companyId = company.rows[0].company_id;
    const instrument = await pool.query(
      `INSERT INTO core.instruments (canonical_code, name, asset_class, market, exchange_code, currency_code, list_date, status)
       VALUES ($1,$2,'stock','CN','SSE','CNY','2010-01-01','listed') RETURNING instrument_id`,
      [code, '测试股票' + index]);
    const instrumentId = instrument.rows[0].instrument_id;
    instrumentIds.push(instrumentId);
    await pool.query(
      `INSERT INTO core.company_instruments (company_id, instrument_id, relation_type, valid_from) VALUES ($1,$2,'issued_by','2010-01-01')`,
      [companyId, instrumentId]);
    await pool.query(
      `INSERT INTO core.company_industry_memberships (company_id, industry_node_id, source_id, valid_from, is_current) VALUES ($1,$2,$3,'2010-01-01',true)`,
      [companyId, nodeId, sourceId]);
    // PB 逐档排列，便于验证名次：1.1 / 1.2 / 1.3 / 1.4
    await pool.query(
      `INSERT INTO market.daily_valuations (instrument_id, trade_date, source_id, pe_static, pb, dividend_yield_ttm, total_market_cap, currency_code)
       VALUES ($1,$2::date,$3,$4,$5,0.05,5e10,'CNY')`,
      [instrumentId, AS_OF, sourceId, 8 + index, 1.1 + index * 0.1]);
    await pool.query(
      `INSERT INTO market.daily_bars (instrument_id, trade_date, source_id, open, high, low, close, volume, amount)
       VALUES ($1,$2::date,$3,10,10,10,10,1000,10000)`,
      [instrumentId, AS_OF, sourceId]);
    // 11 个完整财年：利润与分红各年相等 → 最新年远小于十年合计，年度异常通过。
    // 分红必须按财年逐年有记录，否则"只有最新一年分红"本身就是方案 5.2 要排除的异常情形。
    for (let year = 2015; year <= 2025; year++) {
      const report = await pool.query(
        `INSERT INTO fundamental.financial_reports
           (company_id, report_kind, period_end, period_type, statement_scope, announced_at, source_id, source_version, update_flag, is_current_version, report_type)
         VALUES ($1,'income',$2::date,'annual','consolidated',$3::date,$4,'v1','',true,'1') RETURNING report_id`,
        [companyId, `${year}-12-31`, `${year + 1}-03-31`, sourceId]);
      const reportId = report.rows[0].report_id;
      await pool.query(
        `INSERT INTO fundamental.financial_facts (report_id, statement_type, metric_code, numeric_value, unit_code, currency_code, source_field, is_calculated)
         VALUES ($1,'income','net_profit_parent',1e9,'CNY','CNY','n_income_attr_p',false)`, [reportId]);
      await pool.query(
        `INSERT INTO fundamental.financial_facts (report_id, statement_type, metric_code, numeric_value, unit_code, currency_code, source_field, is_calculated)
         VALUES ($1,'balance','equity_parent',5e10,'CNY','CNY','total_hldr_eqy_exc_min_int',false)`, [reportId]);
      // 除息日：2025 财年的分红落在目标日前十二个月内（用于股息率），其余年份在窗口之外。
      const exDate = year === 2025 ? '2026-06-15' : `${year + 1}-06-15`;
      await pool.query(
        `INSERT INTO fundamental.corporate_actions (instrument_id, action_type, fiscal_period_end, announced_at, ex_date, status, cash_per_share_pre_tax, total_cash_amount, currency_code, source_id, source_key)
         VALUES ($1,'dividend',$2::date,$3::date,$4::date,'实施',0.5,1e8,'CNY',$5,$6)`,
        [instrumentId, `${year}-12-31`, `${year + 1}-05-01`, exDate, sourceId, `${TEST_MARK}-DIV-${index}-${year}`]);
    }
  }
  await pool.query(
    `INSERT INTO market.index_valuation_history (index_code, valuation_method, trade_date, close, pe_ttm, pb, source_code)
     VALUES ('000985','market_cap_weighted',$1::date,6000,15,1.5,'lixinger_official')
     ON CONFLICT DO NOTHING`, [AS_OF]);
  return { instrumentIds };
}

async function main() {
  const { pool, service } = await loadDeps();
  try {
    // 先由交易日历推出季度末目标日，再按该日铺夹具，避免"夹具日期与目标日错位"的假失败。
    const target = await service.resolveQuarterTarget({ market: MARKET, quarter: QUARTER });
    assert.ok(target.asOfDate, '本地交易日历应能推出季度末目标日：' + (target.reason || ''));
    AS_OF = target.asOfDate;
    await cleanup(pool);
    await seed(pool);

    const result = await service.runQuarterly({ market: MARKET, quarter: QUARTER, requestId: 'test-pipeline' });
    record('季度目标日由本地交易日历推导，不使用执行当天', () => {
      assert.strictEqual(result.ok, true, '季度执行应成功');
      assert.strictEqual(result.quarterDate, AS_OF, `季度末应解析为 ${AS_OF}`);
    });

    const run = await service.getRun(result.runId);
    record('运行批次保存执行/质量/业务三种状态', () => {
      assert.ok(run, '批次必须落库');
      assert.strictEqual(run.execution_status, 'succeeded');
      assert.ok(['partial', 'passed'].includes(run.quality_status));
      assert.ok(['insufficient_data', 'eligible', 'insufficient_candidates'].includes(run.business_status));
    });

    record('数据不完整时不得发布正式可投资组合', () => {
      // 全市场 5000+ 只里只有少数具备完整 11 年财报，必然存在待补对象。
      assert.strictEqual(Number(run.published_at === null), 1, '存在待补对象时 published_at 必须为空');
      assert.ok(Number(run.pending_count) > 0, '待补对象计数必须 > 0');
      assert.strictEqual(run.quality_status, 'partial');
    });

    const candidates = await service.getCandidates({ runId: result.runId, limit: 5000, offset: 0 });
    record('候选保存全市场逐项决策，测试股票为通过且有名次', () => {
      const ours = candidates.rows.filter(row => CODES.includes(row.code));
      assert.strictEqual(ours.length, CODES.length, '四只测试股票都必须保存决策，而不是只留最有希望的 30 只');
      ours.forEach(row => {
        assert.strictEqual(row.filter_status, 'PASS', `${row.code} 四项应通过：${JSON.stringify(row.exclusion_reasons)}`);
        assert.ok(row.selection_order !== null, `${row.code} 必须有 selection_order`);
        assert.ok(row.total_score !== null, `${row.code} 必须有总分`);
      });
      const orders = ours.map(row => Number(row.selection_order));
      assert.deepStrictEqual(orders.slice().sort((a, b) => a - b), orders, '名次必须与 PB 升序一致');
    });

    record('候选按 PB 升序取得更优名次（原始精度，不受页面舍入影响）', () => {
      const ours = candidates.rows.filter(row => CODES.includes(row.code))
        .sort((a, b) => Number(a.current_pb) - Number(b.current_pb));
      assert.strictEqual(ours[0].code, CODES[0]);
      assert.ok(Number(ours[0].selection_order) <= Number(ours[ours.length - 1].selection_order));
    });

    const second = await service.runQuarterly({ market: MARKET, quarter: QUARTER, requestId: 'test-pipeline' });
    record('同输入重复执行命中幂等键，不重复落库', () => {
      assert.strictEqual(second.runId, result.runId, '同目标日同输入必须复用同一批次');
      assert.strictEqual(second.reused, true);
    });

    const simulation = await service.createSimulation({ username: 'nonexistent-user', sourceRunId: result.runId, positionRatio: 0.7 })
      .then(() => null).catch(error => error);
    record('个人测算拒绝未发布的季度批次', () => {
      assert.ok(simulation, '未发布批次应被拒绝');
      assert.strictEqual(simulation.status, 409);
    });

    const portfolio = await service.getPortfolio(result.runId);
    record('组合席位权重固定为仓位/30，不因入选数量放大', () => {
      assert.ok(portfolio);
      assert.strictEqual(portfolio.slots, 30);
      const ours = portfolio.members.filter(member => CODES.includes(member.code));
      assert.strictEqual(ours.length, CODES.length, '四只测试股票都应进入组合席位');
      portfolio.members.forEach(member => {
        assert.ok(Math.abs(Number(member.weightInEquityTarget) - 1 / 30) < 1e-9, '每席占股票目标 1/30');
      });
      assert.ok(Math.abs(portfolio.equityWeightInMarketBudget - portfolio.selectedCount * portfolio.positionRatio / 30) < 1e-9);
      // 同一行业 4 只，占市场预算 13.33%，未超过 20% 上限。
      const industry = portfolio.industryBreakdown.find(item => item.industryCode === TEST_MARK + '_IND');
      assert.ok(industry, '测试行业必须出现在行业分布里');
      assert.strictEqual(industry.count, CODES.length);
      assert.ok(industry.weightInMarketBudget <= 0.2 + 1e-12);
    });

    record('季度调入调出在没有上一份正式组合时明确标注不可比', () => {
      assert.ok(portfolio.changes, '组合必须返回季度变动对象');
      assert.strictEqual(portfolio.changes.comparable, false, '首份组合没有可比对象');
      assert.strictEqual(portfolio.changes.added.length, portfolio.selectedCount, '无上一季时所有席位都算新进');
      assert.strictEqual(portfolio.changes.removed.length, 0);
    });

    const backtests = await service.listBacktests({ market: MARKET, limit: 5, offset: 0 });
    record('回测列表只读库并返回分页结构', () => {
      assert.ok(Array.isArray(backtests.rows));
      assert.strictEqual(typeof backtests.total, 'number');
    });

    const detail = await service.getStockDetail({ runId: result.runId, code: CODES[0] });    record('个股解释返回四规则结论与年度异常比较值', () => {
      assert.ok(detail, '必须能按代码取到属于本批次的股票解释');
      assert.ok(detail.candidate.detail.rules.R01, '必须带四规则结论');
      assert.ok(detail.candidate.detail.annual, '必须带年度事实');
    });

    const markets = await service.getMarkets();
    record('市场概览只读库并给出两市场准入结论', () => {
      assert.strictEqual(markets.markets.length, 2);
      const cn = markets.markets.find(item => item.market === 'CN');
      assert.strictEqual(cn.benchmarkCode, 'CSIALL');
      assert.strictEqual(cn.benchmarkLabel, '中证全指');
      assert.ok(['eligible', 'market_closed', 'data_missing'].includes(cn.gate.status));
    });

    const audit = await service.auditInputs({ market: MARKET, asOfDate: AS_OF });
    record('选股输入缺口审计产出可续跑队列，不自行外采', () => {
      assert.ok(audit.queueId, '缺口队列必须持久化');
      assert.ok(audit.gapCount > 0, '测试环境必然存在缺口');
      assert.ok(audit.coverage.universeCount > CODES.length);
    });
  } finally {
    try { await cleanup(pool); } catch (error) { console.error('清理夹具失败：', error.message); }
    await pool.end().catch(() => {});
  }

  const pass = tests.filter(item => item[0] === 'PASS').length;
  const fail = tests.length - pass;
  console.log(`PASS=${pass} FAIL=${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch(error => { console.error(error); process.exit(1); });
