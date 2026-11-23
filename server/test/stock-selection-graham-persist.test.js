'use strict';
// 格雷厄姆低估：批次落库与新策略首周回补回归测试（2026-11-23 生产事故）。
//
// 为什么必须有这个文件：0.9.4.17 上线后格雷厄姆方案在页面上始终空白，根因不在规则也不在取数，
// 而在「算出来的结果存不进库」——`analytics.stock_selection_candidates.total_score` 是 integer，
// 而格雷厄姆按方案 27.43 用「净流动资产盈余 ÷ 总市值」的比率排序（如 1.524293），
// 保存批次时 PostgreSQL 报 `invalid input syntax for type integer: "1.524293"`，
// 于是策略行、批次、候选全部为 0 条，页面按「已发布批次」展示只能显示空。
// 原有测试只覆盖规则与取数（computeSelection），没有一条会真的插候选行，所以拦不住。
//
// 第二个缺口是入队：周批次只在「本周最后一个开市日」入队，新策略上线若不在这个时点，
// 页面要空白整整一周。本文件同时锁定「该策略从未有批次时回补上一已结束周」的行为。
//
// 第三个缺口与第一个同源：格雷厄姆的成员对象由独立管线自己拼，缺 slot_no 与三套权重，
// 修完 total_score 之后立刻撞上 `null value in column "slot_no"`（2026-11-23 部署后实测）。
// 现在统一由 domain 的 buildSelectedPortfolio 产出，用例同时锁契约字段与真实插入。
//
// 夹具全部走 6098xx 号段并在事务内 ROLLBACK，不写业务数据。
const assert = require('assert');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { pool } = require('../db/connection');
const repo = require('../repositories/stockSelectionRepository');
const service = require('../services/stockSelectionService');
const PORTFOLIO = require('../domain/stockSelectionPortfolio');

const PROBE_CODE = 'graham_persist_probe_v1';
const AS_OF = '2099-12-31';
const CUTOFF = '2099-12-30T15:00:00+08:00';
const PROBE_CODE_STOCK = '609801';
// 探针证券与组合跨越两个用例块，用模块级变量接住（第三个用例由第二个用例创建）。
let otherInstrument = null;
let grahamPortfolio = null;

let passed = 0;
let failed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    failures.push({ name, message: error && error.message });
    console.log(`  ✗ ${name} —— ${error && error.message}`);
  }
}

/**
 * 就绪时段固定锚点：上海 2026-11-06 18:40（周五，已收盘）= UTC 10:40。
 * 为什么不用「今天」：CI 的交易日历是 ci-seed.sql 的最小样本（2026-10-17 ~ 2026-11-08），
 * 用当天日期会因日历不覆盖而拿到 null，失败原因就与本次要验证的逻辑无关了。
 * 该区间同时覆盖上一周（W:2026-10-26）与本周（W:2026-11-02），足够验证首周回补。
 */
const READY_NOW = new Date('2026-11-06T10:40:00Z');
const PREV_WEEK_KEY = 'W:2026-10-26';

async function main() {
  console.log('格雷厄姆低估：落库与新策略回补回归（真实 PostgreSQL）');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    /* ---------- 一、列类型与真实插入 ---------- */
    await check('候选表 total_score 必须是 numeric（格雷厄姆比率不能塞进 integer）', async () => {
      const { rows } = await client.query(`
        SELECT data_type FROM information_schema.columns
         WHERE table_schema='analytics' AND table_name='stock_selection_candidates'
           AND column_name='total_score'`);
      assert.ok(rows.length, '缺少 total_score 列');
      assert.strictEqual(rows[0].data_type, 'numeric',
        `total_score 仍是 ${rows[0].data_type}：格雷厄姆批次会再次报 invalid input syntax for type integer`);
    });

    // 造最小批次：策略 → 批次 → 候选
    const strategyId = await repo.upsertStrategy(client, {
      strategyCode: PROBE_CODE,
      market: 'CN',
      version: 'v1',
      formulaVersion: 'selection-formula-v1',
      adapterVersion: 'selection-adapter-v1',
      riskVersion: 'selection-risk-v1',
      industryVersion: 'selection-industry-v1',
      effectiveFrom: AS_OF,
      parameters: { probe: true },
      contentHash: 'probe-hash-graham-persist',
    });
    assert.ok(strategyId, '策略登记失败');

    const runId = (await client.query(
      `INSERT INTO analytics.stock_selection_runs
         (strategy_id, market, run_kind, as_of_date, knowledge_cutoff, input_hash, period_type, period_key)
       VALUES ($1,'CN','weekly',$2::date,$3::timestamptz,'probe-input-hash','week','W:2099-12-28')
       RETURNING run_id`, [strategyId, AS_OF, CUTOFF]
    )).rows[0].run_id;

    const instrument = (await client.query(
      `INSERT INTO core.instruments(canonical_code,name,asset_class,market,exchange_code,currency_code,status)
       VALUES($1,'格雷厄姆落库探针','stock','CN','SSE','CNY','listed') RETURNING instrument_id`,
      [`${PROBE_CODE_STOCK}.SH`]
    )).rows[0].instrument_id;

    await check('真实插入：格雷厄姆比率 1.524293 能写进 total_score 并原样读回', async () => {
      await repo.insertCandidates(client, runId, [{
        instrumentId: instrument,
        companyId: null,
        code: `${PROBE_CODE_STOCK}.SH`,
        name: '格雷厄姆落库探针',
        industry: null,
        currentPb: 0.62,
        currentPe: 6.1,
        profitStatus: 'profit',
        dividendYield: 0.071,
        equityAmount: 100,
        equityCurrency: 'CNY',
        equityCny: 100,
        fxRate: null,
        fxDate: null,
        pbRank: null,
        peRank: null,
        dividendRank: null,
        // 排序分数就是「净流动资产盈余 ÷ 总市值」，是比率而不是整数分值。
        totalScore: 1.524293,
        selectionOrder: 1,
        filterStatus: 'PASS',
        dataQualityStatus: 'ok',
        exclusionReasons: null,
        detail: { probe: true },
      }]);
      const { rows } = await client.query(
        'SELECT total_score::text AS score FROM analytics.stock_selection_candidates WHERE run_id=$1 AND instrument_id=$2',
        [runId, instrument]
      );
      assert.strictEqual(rows.length, 1, '候选行没有落库');
      assert.strictEqual(Number(rows[0].score).toFixed(6), '1.524293', `读回值不符：${rows[0].score}`);
    });

    await check('真实插入：整数分值（投资要义口径）不受类型放宽影响', async () => {
      otherInstrument = (await client.query(
        `INSERT INTO core.instruments(canonical_code,name,asset_class,market,exchange_code,currency_code,status)
         VALUES($1,'整数分探针','stock','CN','SSE','CNY','listed') RETURNING instrument_id`,
        [`609802.SH`]
      )).rows[0].instrument_id;
      await repo.insertCandidates(client, runId, [{
        instrumentId: otherInstrument, companyId: null, code: `609802.SH`, name: '整数分探针',
        industry: null, currentPb: 0.9, currentPe: 8, profitStatus: 'profit', dividendYield: 0.05,
        equityAmount: 50, equityCurrency: 'CNY', equityCny: 50, fxRate: null, fxDate: null,
        pbRank: 3, peRank: 5, dividendRank: 7, totalScore: 85, selectionOrder: 2,
        filterStatus: 'PASS', dataQualityStatus: 'ok', exclusionReasons: null, detail: { probe: true },
      }]);
      const { rows } = await client.query(
        'SELECT total_score::text AS score FROM analytics.stock_selection_candidates WHERE run_id=$1 AND instrument_id=$2',
        [runId, otherInstrument]
      );
      assert.strictEqual(Number(rows[0].score), 85, `整数分值被改写：${rows[0].score}`);
    });

    /* ---------- 三、组合成员字段契约 ----------
     * 第二处同类缺口：格雷厄姆的成员对象由独立管线自己拼，早期只给了 code/name/targetWeight，
     * 而 analytics.stock_selection_portfolio_members 的 slot_no、weight_in_market_budget、
     * weight_in_equity_target 都是 NOT NULL 且带范围检查，保存时报
     * `null value in column "slot_no"` 整批回滚——页面因此依旧空白。
     * 这里同时锁「构造器给出契约字段」与「真的能插进去」两件事。 */
    await check('格雷厄姆组合成员必须带席号与三套权重', async () => {
      grahamPortfolio = PORTFOLIO.buildSelectedPortfolio({
        selected: [
          { instrumentId: instrument, companyId: null, code: `${PROBE_CODE_STOCK}.SH`, name: '探针一', industry: null, selectionOrder: 1, totalScore: 1.524293 },
          { instrumentId: otherInstrument, companyId: null, code: '609802.SH', name: '探针二', industry: null, selectionOrder: 2, totalScore: 1.2 },
        ],
        positionRatio: 1,
        slots: 30,
        params: { slotsPerMarket: 30 },
      });
      assert.deepStrictEqual(grahamPortfolio.members.map(m => m.slotNo), [1, 2],
        `席号必须是 1..N：${JSON.stringify(grahamPortfolio.members.map(m => m.slotNo))}`);
      grahamPortfolio.members.forEach(member => {
        ['weightInMarketBudget', 'weightInEquityTarget', 'weightInInvestedEquity'].forEach(field => {
          const value = member[field];
          assert.ok(typeof value === 'number' && value > 0 && value <= 1,
            `${member.code} 的 ${field} 必须是 0~1 之间的数，实际：${value}`);
        });
      });
    });

    await check('真实插入：格雷厄姆成员能写进组合成员表（slot_no 非空约束不再报错）', async () => {
      await repo.insertMembers(client, runId, grahamPortfolio.members);
      const { rows } = await client.query(
        `SELECT slot_no, weight_in_market_budget::text AS wm, weight_in_equity_target::text AS we
           FROM analytics.stock_selection_portfolio_members WHERE run_id=$1 ORDER BY slot_no`, [runId]
      );
      assert.strictEqual(rows.length, 2, `成员行没有落库：${rows.length}`);
      assert.deepStrictEqual(rows.map(row => Number(row.slot_no)), [1, 2], '席号落库后不符');
      assert.ok(Number(rows[0].wm) > 0, `市场预算权重落库后非正：${rows[0].wm}`);
    });

    /* ---------- 二、新策略首周回补 ---------- */
    await check('已有批次的策略：就绪时段不再补上一周（避免重复建槽）', async () => {
      const noRun = await repo.hasNoPeriodRunAtAll({ market: 'CN', strategyCode: PROBE_CODE }, client);
      assert.strictEqual(noRun, false, '本用例已插入批次，前置条件不成立');
      const targets = await service.duePeriodicTargets(
        { market: 'CN', now: READY_NOW, strategyCode: PROBE_CODE }, client
      );
      assert.ok(!targets.some(item => item.periodType === 'week' && item.periodKey === PREV_WEEK_KEY),
        '该策略已有批次，不应再补上一周');
    });

    await check('完全没有批次的策略码：就绪时段补出上一已结束周的目标日', async () => {
      const fresh = 'graham_persist_fresh_probe_v1';
      const targets = await service.duePeriodicTargets(
        { market: 'CN', now: READY_NOW, strategyCode: fresh }, client
      );
      const week = targets.find(item => item.periodType === 'week' && item.periodKey === PREV_WEEK_KEY);
      assert.ok(week, `首次上线的策略必须补出上一已结束周（实际：${JSON.stringify(targets)}）`);
      assert.strictEqual(week.catchup, true, '回补目标必须标记为补算');
      assert.ok(week.targetDate < '2026-11-06', `补出的目标日必须早于当日：${week.targetDate}`);
      assert.ok(/^W:\d{4}-\d{2}-\d{2}$/.test(week.periodKey), `周键格式不符：${week.periodKey}`);
    });

    await client.query('ROLLBACK');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (ignored) {}
    throw error;
  } finally {
    client.release();
  }

  console.log(`\n结果：通过 ${passed} / 失败 ${failed}`);
  if (failed) {
    console.log(JSON.stringify(failures, null, 2));
    process.exitCode = 1;
  }
  await pool.end();
}

main().catch(async error => {
  console.error('测试异常：', error && error.message);
  process.exitCode = 1;
  try { await pool.end(); } catch (ignored) {}
});
