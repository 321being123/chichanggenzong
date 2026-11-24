'use strict';

const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const { Client } = require('pg');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { createMigratedDatabase } = require('./helpers/migrated-database');
const { testDatabaseConfig } = require('./lib/testDatabase');
const { buildDemoScenario } = require('../domain/classroomDemoScenario');

function runPureUnitChecks(precheckService) {
  const {
    validateWindowBounds,
    validateYearTradeCalendar,
    resolveSw2021Level1Map,
    groupCandidatesByLevel1Industry,
    buildRandomUniverseSelection,
  } = precheckService;
  // 1. 窗口边界：非整数或未结束自然年（以 2026 上海年份为例）
  const now2026 = new Date('2026-11-24T10:00:00+08:00');
  assert.strictEqual(validateWindowBounds(2011.5, 15, now2026).valid, false);
  assert.strictEqual(validateWindowBounds(2012, 15, now2026).valid, false, '2012-2026 含未结束年 2026 须被拒绝');
  assert.strictEqual(validateWindowBounds(2011, 15, now2026).valid, true, '2011-2025 应通过');
  assert.strictEqual(validateYearTradeCalendar(2011, ['2011-01-04', '2011-12-31']).ok, false, '仅两天日历须被拦截');

  // 2. SW2021 一级行业归并、证券 ID 去重与冲突排除
  const nodes = [
    { industry_node_id: 1, parent_id: null, industry_code: 'SW1_A', industry_name: '一级甲', level: 1 },
    { industry_node_id: 2, parent_id: 1, industry_code: 'SW2_A', industry_name: '二级甲', level: 2 },
    { industry_node_id: 3, parent_id: 2, industry_code: 'SW3_A', industry_name: '三级甲', level: 3 },
    { industry_node_id: 10, parent_id: null, industry_code: 'SW1_B', industry_name: '一级乙', level: 1 },
  ];
  const l1Map = resolveSw2021Level1Map(nodes);
  assert.strictEqual(l1Map.get('3').level1NodeId, '1');
  assert.strictEqual(l1Map.get('10').level1NodeId, '10');

  const grouped = groupCandidatesByLevel1Industry([
    // 同一证券映射到同一一级行业下的不同子节点 -> 按证券 ID 去重保留
    { instrument_id: 101, canonical_code: '600101.SH', name: '甲一', list_date: '2010-01-01', delist_date: null, industry_node_id: 2 },
    { instrument_id: 101, canonical_code: '600101.SH', name: '甲一', list_date: '2010-01-01', delist_date: null, industry_node_id: 3 },
    // 冲突归属（跨两个一级行业） -> 排除
    { instrument_id: 102, canonical_code: '600102.SH', name: '冲突股', list_date: '2010-01-01', delist_date: null, industry_node_id: 3 },
    { instrument_id: 102, canonical_code: '600102.SH', name: '冲突股', list_date: '2010-01-01', delist_date: null, industry_node_id: 10 },
    // 缺失 SW2021 归属 -> 排除
    { instrument_id: 103, canonical_code: '600103.SH', name: '无行业', list_date: '2010-01-01', delist_date: null, industry_node_id: null },
  ], l1Map);

  assert.strictEqual(grouped.industries.length, 1);
  assert.strictEqual(grouped.industries[0].candidates.length, 1);
  assert.strictEqual(grouped.industries[0].candidates[0].instrumentId, '101');
  assert.strictEqual(grouped.excluded.length, 2);

  // 3. 随机抽样：同种子可复现、4×3 不重复、单组重抽保留其余 3 组、3 股行业说明
  const enabledIndustries = [1, 2, 3, 4, 5].map((i) => ({
    industryNodeId: String(i),
    industryName: `行业${i}`,
    qualifiedStocks: (i === 1 ? [1, 2, 3] : [1, 2, 3, 4, 5]).map((j) => ({
      instrumentId: String(i * 100 + j),
      canonicalCode: `600${i}0${j}.SH`,
      stockName: `股票${i}_${j}`,
    })),
  }));
  const s1 = buildRandomUniverseSelection({ enabledIndustries, seed: 'seed-alpha' });
  const s2 = buildRandomUniverseSelection({ enabledIndustries, seed: 'seed-alpha' });
  assert.deepStrictEqual(s1.groups, s2.groups, '同种子抽样须完全一致');
  assert.strictEqual(s1.groups.length, 4);
  const uniqInds = new Set(s1.groups.map((g) => g.industryNodeId));
  const uniqCodes = new Set(s1.groups.flatMap((g) => g.codes));
  assert.strictEqual(uniqInds.size, 4, '须为 4 个不同一级行业');
  assert.strictEqual(uniqCodes.size, 12, '须为 12 只不重复证券');

  const resampled = buildRandomUniverseSelection({
    enabledIndustries,
    lockedGroups: s1.groups,
    targetGroupIndex: 2,
    seed: 'seed-beta',
  });
  assert.deepStrictEqual(resampled.groups[0], s1.groups[0]);
  assert.deepStrictEqual(resampled.groups[1], s1.groups[1]);
  assert.deepStrictEqual(resampled.groups[3], s1.groups[3]);

  // 4. 演示随机化：固定剧本可复现、同种子重建一致、异种子有差异且满足约束
  const fixedDemo = buildDemoScenario({ demoVariant: 'fixed' });
  assert.strictEqual(fixedDemo.demoVariant, 'fixed');
  assert.ok(fixedDemo.rounds[9].stocks.filter((s) => s.peTtm < 0).length >= 5, '固定剧本第 10 轮须保留教学策略暂停案例');

  const randA1 = buildDemoScenario({ demoVariant: 'random', seed: 'demo-seed-1' });
  const randA2 = buildDemoScenario({ demoVariant: 'random', seed: 'demo-seed-1' });
  const randB = buildDemoScenario({ demoVariant: 'random', seed: 'demo-seed-2' });
  assert.deepStrictEqual(randA1, randA2, '同版本同种子随机演示须可重现');
  assert.notDeepStrictEqual(randA1.rounds[0].stocks, randB.rounds[0].stocks, '异种子应产生不同演示序列');
  for (const r of randA1.rounds) {
    assert.strictEqual(r.stocks.length, 12);
    for (const st of r.stocks) {
      assert.ok(Number.isFinite(st.returnRate) && st.returnRate > -1);
      assert.ok(st.marketCap > 0 && st.pb > 0 && Number.isFinite(st.peTtm));
    }
  }
}

async function seedRealWindowData(pool, { fullCalendar = false } = {}) {
  // 构造 2010-12 至 2025-12 的 SSE 日历、中债净值、转债校准分桶及 4+1 个 SW2021 一级行业股票池
  for (let yr = 2010; yr <= 2025; yr++) {
    if (fullCalendar) {
      const fromD = yr === 2010 ? '2010-12-27' : `${yr}-01-04`;
      const toD = `${yr}-12-31`;
      await pool.query(
        `INSERT INTO market.trade_calendar (exchange, trade_date, is_open, source_code)
         SELECT 'SSE', d::date, TRUE, 'test'
         FROM generate_series($1::date, $2::date, '1 day'::interval) AS d
         WHERE EXTRACT(ISODOW FROM d) <= 5 OR d::date IN ($1::date, $2::date)
         ON CONFLICT DO NOTHING`,
        [fromD, toD]
      );
    } else {
      const dates = yr === 2010
        ? ['2010-12-27', '2010-12-28', '2010-12-29', '2010-12-30', '2010-12-31']
        : [`${yr}-01-04`, `${yr}-12-31`];
      for (const d of dates) {
        await pool.query(
          `INSERT INTO market.trade_calendar (exchange, trade_date, is_open)
           VALUES ('SSE', $1::date, TRUE) ON CONFLICT (exchange, trade_date) DO NOTHING`,
          [d]
        );
      }
    }
    if (yr >= 2011) {
      await pool.query(
        `INSERT INTO market.index_valuation_history (index_code, valuation_method, source_code, trade_date, close)
         VALUES ('CBA00601', 'total_return', 'chinabond', $1::date, $2), ('CBA00601', 'total_return', 'chinabond', $3::date, $4)
         ON CONFLICT DO NOTHING`,
        [`${yr}-01-04`, 100 + yr - 2011, `${yr}-12-31`, 104 + yr - 2011]
      );
    }
  }

  // 9 格转债校准样本
  const { rows: srcRows } = await pool.query(`SELECT source_id FROM ops.data_sources LIMIT 1`);
  const sourceId = srcRows[0].source_id;
  const { rows: cbInst } = await pool.query(
    `INSERT INTO core.instruments (canonical_code, name, asset_class, market, exchange_code, currency_code, status)
     VALUES ('119901.SH', '测试转债', 'convertible_bond', 'CN', 'SSE', 'CNY', 'active')
     ON CONFLICT (canonical_code) DO UPDATE SET name = EXCLUDED.name
     RETURNING instrument_id`
  );
  const cbId = cbInst[0].instrument_id;
  const tenors = [1.0, 3.0, 5.0];
  const convPrices = [70, 100, 130]; // conv_value vs 100 -> otm, atm, itm
  let dayIdx = 1;
  for (const rem of tenors) {
    for (const cv of convPrices) {
      await pool.query(
        `INSERT INTO market.convertible_bond_daily_metrics
         (instrument_id, trade_date, source_id, conversion_value, conversion_premium_pct, bond_premium_pct, raw_payload)
         VALUES ($1, $2::date, $3, $4, 12.5, 14.3, $5::jsonb)
         ON CONFLICT DO NOTHING`,
        [cbId, `2025-01-${String(dayIdx).padStart(2, '0')}`, sourceId, cv, JSON.stringify({ remain_years: rem })]
      );
      dayIdx++;
    }
  }

  // 5 个 SW2021 一级行业（其中第 5 个行业故意只设 2 只合格股，其余 10 只缺数据，用于验证 8-10 首批续查与不足禁用）
  await pool.query(
    `INSERT INTO core.industry_taxonomies (taxonomy_code, taxonomy_name, version)
     VALUES ('SW2021', '申万行业', '2021') ON CONFLICT (taxonomy_code) DO NOTHING`
  );
  const { rows: taxRows } = await pool.query(`SELECT taxonomy_id FROM core.industry_taxonomies WHERE taxonomy_code = 'SW2021'`);
  const taxId = taxRows[0].taxonomy_id;

  const indIds = [];
  for (let i = 1; i <= 5; i++) {
    const { rows: nRows } = await pool.query(
      `INSERT INTO core.industry_nodes (taxonomy_id, industry_code, industry_name, level, parent_id)
       VALUES ($1, $2, $3, 1, NULL)
       ON CONFLICT (taxonomy_id, industry_code) DO UPDATE SET industry_name = EXCLUDED.industry_name
       RETURNING industry_node_id`,
      [taxId, `CR_SW1_${i}`, `测试一级行业${i}`]
    );
    indIds.push(nRows[0].industry_node_id);
  }

  // 插入股票：前 4 个行业各 3 只合格股（其中第 1 只在 2011-01-04 首日上市），第 5 个行业 12 只中前 10 只缺数、第 11 只合格（共 1 只合格 -> 禁用），
  // 另有 1 只在 2025-12-31 末轮最后交易日退市（不得进入候选）
  const createdCodes = [];
  async function createStock({ code, name, listDate, delistDate = null, nodeId, withFullData = true }) {
    const { rows: iRows } = await pool.query(
      `INSERT INTO core.instruments (canonical_code, name, asset_class, market, exchange_code, currency_code, list_date, delist_date, status)
       VALUES ($1, $2, 'stock', 'CN', 'SSE', 'CNY', $3::date, $4::date, 'active')
       RETURNING instrument_id`,
      [code, name, listDate, delistDate]
    );
    const instId = iRows[0].instrument_id;
    const { rows: cRows } = await pool.query(
      `INSERT INTO core.companies (legal_name, short_name, country_code) VALUES ($1, $2, 'CN') RETURNING company_id`,
      [`公司_${code}`, code]
    );
    const compId = cRows[0].company_id;
    await pool.query(
      `INSERT INTO core.company_instruments (company_id, instrument_id, relation_type) VALUES ($1, $2, 'issued_by')`,
      [compId, instId]
    );
    await pool.query(
      `INSERT INTO core.company_industry_memberships (company_id, industry_node_id, source_id, is_current)
       VALUES ($1, $2, $3, TRUE)`,
      [compId, nodeId, sourceId]
    );
    if (withFullData) {
      for (let yr = 2011; yr <= 2025; yr++) {
        await pool.query(
          `INSERT INTO market.daily_bars (instrument_id, trade_date, source_id, open, high, low, close, volume, price_adjust, bar_status, quality_status)
           VALUES ($1, $2::date, $3, 10, 10, 10, 10, 1000, 'none', 'terminal', 'passed'),
                  ($1, $4::date, $3, 11, 11, 11, 11, 1000, 'none', 'terminal', 'passed')`,
          [instId, `${yr}-01-04`, sourceId, `${yr}-12-31`]
        );
        await pool.query(
          `INSERT INTO market.adjustment_factors (instrument_id, trade_date, source_id, adj_factor)
           VALUES ($1, $2::date, $3, 1.0), ($1, $4::date, $3, 1.0)`,
          [instId, `${yr}-01-04`, sourceId, `${yr}-12-31`]
        );
        await pool.query(
          `INSERT INTO market.daily_valuations (instrument_id, trade_date, source_id, pe_ttm, pb, total_market_cap)
           VALUES ($1, $2::date, $3, 15.5, 1.8, 1000000000)`,
          [instId, `${yr}-01-04`, sourceId]
        );
      }
    }
    return { instId, code };
  }

  const prefix = '98' + String(crypto.randomInt(10, 99));
  for (let g = 0; g < 4; g++) {
    for (let j = 0; j < 3; j++) {
      const code = `${prefix}${g}${j}.SH`;
      await createStock({
        code,
        name: `合格股${g}_${j}`,
        listDate: (g === 0 && j === 0) ? '2011-01-04' : '2008-01-01', // 首日上市测试
        nodeId: indIds[g],
        withFullData: true,
      });
      createdCodes.push(code);
    }
  }
  // 末轮最后交易日退市（2025-12-31）不应进入候选
  await createStock({
    code: `${prefix}99.SH`,
    name: '末日退市股',
    listDate: '2008-01-01',
    delistDate: '2025-12-31',
    nodeId: indIds[0],
    withFullData: true,
  });

  // 第 4 个测试行业（indIds[3]）：再增加 1 只合格股（共 4 只），第 5 个行业（indIds[4]）：前 10 只不合格、第 11 只合格（共 1 只，启用失败）
  await createStock({
    code: `${prefix}39.SH`,
    name: '合格股3_3',
    listDate: '2008-01-01',
    nodeId: indIds[3],
    withFullData: true,
  });
  for (let k = 0; k < 11; k++) {
    await createStock({
      code: `${prefix}${String(40 + k)}.SH`,
      name: `五组股${k}`,
      listDate: '2008-01-01',
      nodeId: indIds[4],
      withFullData: k === 10, // 第 11 只才合格
    });
  }

  return { indIds, createdCodes, prefix };
}

async function run() {
  const dbName = 'portfolio_test_cr_rnd_' + crypto.randomBytes(4).toString('hex');
  const admin = new Client({ ...testDatabaseConfig(), connectionTimeoutMillis: 10000 });
  await admin.connect();

  let pool;
  try {
    await createMigratedDatabase(admin, dbName);
    pool = require('../db/connection').pool;
    const precheckService = require('../services/classroomPrecheckService');
    const classroomService = require('../services/classroomService');
    runPureUnitChecks(precheckService);

    // 0. 先验证仅每年 2 个交易日的残缺日历必须被窗口门禁拦截
    const { indIds, prefix } = await seedRealWindowData(pool, { fullCalendar: false });
    const sparseOpts = await precheckService.getCreationOptions({
      startYear: 2011,
      now: new Date('2026-11-24T10:00:00+08:00'),
    });
    assert.strictEqual(sparseOpts.availableWindows.length, 0, '每年仅 2 个交易日不得进入可建场窗口');
    assert.strictEqual(sparseOpts.windowStatus.calendarOk, false, '残缺交易日历须判为不通过');

    // 补齐 2011 至 2025 每年 01-04 至 12-31 完整工作日日历（含周末/节假日 is_open=FALSE）
    for (let yr = 2011; yr <= 2025; yr++) {
      await pool.query(
        `INSERT INTO market.trade_calendar (exchange, trade_date, is_open, source_code)
         SELECT 'SSE',
                d::date,
                (d::date >= $1::date AND d::date <= $2::date AND (EXTRACT(ISODOW FROM d) <= 5 OR d::date IN ($1::date, $2::date))),
                'test'
         FROM generate_series(make_date($3::int, 1, 1), make_date($3::int, 12, 31), '1 day'::interval) AS d
         ON CONFLICT DO NOTHING`,
        [`${yr}-01-04`, `${yr}-12-31`, yr]
      );
    }

    // 0a. 删掉 2011 年首个开市日（2011-01-04）即使其余工作日完整也必须拦截
    await pool.query(`DELETE FROM market.trade_calendar WHERE exchange = 'SSE' AND trade_date = '2011-01-04'::date`);
    const missingFirstDayOpts = await precheckService.getCreationOptions({
      startYear: 2011,
      now: new Date('2026-11-24T10:00:00+08:00'),
    });
    assert.strictEqual(missingFirstDayOpts.availableWindows.length, 0, '删掉首个开市日后不得判定为可建场窗口');
    assert.strictEqual(missingFirstDayOpts.windowStatus.calendarOk, false);
    await pool.query(
      `INSERT INTO market.trade_calendar (exchange, trade_date, is_open, source_code)
       VALUES ('SSE', '2011-01-04'::date, TRUE, 'test') ON CONFLICT DO NOTHING`
    );

    const teacherUser = { username: 'admin', role: 'admin', subject_identity: 'subj_admin_rnd' };
    const stu1 = { username: 'alice', role: 'user', subject_identity: 'subj_alice_rnd' };

    // 0b. 超时未核验完时禁止从未核验完的子集抽样
    let timeoutErr = null;
    try {
      await precheckService.sampleRealClassroomSelection({
        startYear: 2011,
        seed: 'timeout-check',
        timeoutMs: 1, // 强制极短超时，触发未完成拦截
        now: new Date('2026-11-24T10:00:00+08:00'),
      });
    } catch (e) {
      timeoutErr = e;
    }
    assert.ok(timeoutErr && timeoutErr.status === 409 && timeoutErr.extra.code === 'POOL_VERIFICATION_INCOMPLETE', '超时未核验完时必须拒绝抽样');

    // 0c. 查询失败一次后重试不得跳过该批股票
    const classroomRepo = require('../repositories/classroomRepository');
    const origFetchBars = classroomRepo.fetchDailyBarsWithAdj;
    let failOnce = true;
    classroomRepo.fetchDailyBarsWithAdj = async (...args) => {
      if (failOnce) {
        failOnce = false;
        throw new Error('模拟瞬时查询失败');
      }
      return origFetchBars(...args);
    };
    let caughtBatchErr = null;
    try {
      await precheckService.verifyIndustryPool({
        startYear: 2011,
        now: new Date('2026-11-24T10:00:00+08:00'),
      });
    } catch (e) {
      caughtBatchErr = e;
    } finally {
      classroomRepo.fetchDailyBarsWithAdj = origFetchBars;
    }
    assert.ok(caughtBatchErr, '瞬时查询失败应向上抛出');
    // 0d. 并发核验同一未缓存窗口不得重复计数或重复入池
    const [retriedPool, concurrentPool] = await Promise.all([
      precheckService.verifyIndustryPool({
        startYear: 2011,
        now: new Date('2026-11-24T10:00:00+08:00'),
      }),
      precheckService.verifyIndustryPool({
        startYear: 2011,
        now: new Date('2026-11-24T10:00:00+08:00'),
      }),
    ]);
    const ind1AfterRetry = retriedPool.industries.find((i) => i.industryNodeId === String(indIds[0]));
    const ind1Concurrent = concurrentPool.industries.find((i) => i.industryNodeId === String(indIds[0]));
    assert.strictEqual(ind1AfterRetry.qualifiedCount, 3, '查询失败重试后不得漏掉该批股票');
    assert.strictEqual(ind1Concurrent.qualifiedCount, 3, '并发核验同一窗口不得重复计入合格股');
    assert.strictEqual(ind1Concurrent.verifiedCount, 3, '并发核验同一窗口不得重复累计已核验数');

    // 1. 窗口与行业选项核验：2011 窗口可用；第 5 个行业首批 10 只不合格并续查第 11 只，仍不足 3 只故禁用；末日退市股不入候选
    const opts = await precheckService.getCreationOptions({
      startYear: 2011,
      now: new Date('2026-11-24T10:00:00+08:00'),
    });
    assert.strictEqual(opts.availableWindows.length, 1);
    assert.strictEqual(opts.availableWindows[0].startYear, 2011);
    assert.ok(opts.onlyOneWindowNote, '仅一个窗口时须返回说明');

    const ind1 = opts.industries.find((i) => i.industryNodeId === String(indIds[0]));
    const ind5 = opts.industries.find((i) => i.industryNodeId === String(indIds[4]));
    assert.strictEqual(ind1.enabled, true);
    assert.strictEqual(ind1.qualifiedCount, 3, '首日上市 600000.SH 纳入且末日退市 609999.SH 排除');
    assert.strictEqual(ind5.enabled, false, '第 5 行业不足 3 只合格股须禁用');
    assert.strictEqual(ind5.verifiedCount, 11, '首批 10 只未达 3 只时须继续核验至耗尽');
    assert.strictEqual(ind5.qualifiedCount, 1);

    // 2. 随机抽样 4×3
    const sampled = await precheckService.sampleRealClassroomSelection({
      startYear: 2011,
      seed: 'real-sample-seed',
      now: new Date('2026-11-24T10:00:00+08:00'),
    });
    assert.strictEqual(sampled.groups.length, 4);
    assert.strictEqual(new Set(sampled.groups.flatMap((g) => g.codes)).size, 12);

    // 3. 预览建场 + 幂等确认（并发/重复确认只生成一个场次）
    const preview = await classroomService.createCreationPreview({
      adminUser: teacherUser,
      title: '',
      mode: 'real',
      blindMode: true,
      startYear: 2011,
      industries: sampled.groups,
    });
    assert.strictEqual(preview.pass, true);
    assert.ok(preview.previewId);

    const reqId = 'cfm_idem_001';
    const [c1, c2] = await Promise.all([
      classroomService.confirmCreationPreview({ adminUser: teacherUser, previewId: preview.previewId, confirmRequestId: reqId }),
      classroomService.confirmCreationPreview({ adminUser: teacherUser, previewId: preview.previewId, confirmRequestId: reqId }),
    ]);
    assert.strictEqual(c1.classroom.classroomId, c2.classroom.classroomId, '重复确认只能生成一个场次');
    assert.strictEqual(c1.classroom.classroomCode, c2.classroom.classroomCode);

    // 3b. 交换两组各一只股票（跨一级行业混入）须被预览预检拦截
    const swappedGroups = sampled.groups.map((g) => ({ ...g, codes: g.codes.slice() }));
    const tmpCode = swappedGroups[0].codes[0];
    swappedGroups[0].codes[0] = swappedGroups[1].codes[0];
    swappedGroups[1].codes[0] = tmpCode;
    const swappedPreview = await classroomService.createCreationPreview({
      adminUser: teacherUser,
      title: '混入校验',
      mode: 'real',
      blindMode: true,
      startYear: 2011,
      industries: swappedGroups,
    });
    assert.strictEqual(swappedPreview.pass, false, '手填或交换股票混入其他一级行业必须拦截');

    // 4. 原地修改一条入选股票的年末收盘价（行数与最大日期不变） -> 确认旧预览须返回 409 PREVIEW_REFRESH_REQUIRED
    const preview2 = await classroomService.createCreationPreview({
      adminUser: teacherUser,
      title: '数据变化测试',
      mode: 'real',
      blindMode: true,
      startYear: 2011,
      industries: sampled.groups,
    });
    await pool.query(
      `UPDATE market.daily_bars
       SET close = close + 1.5
       WHERE instrument_id = (SELECT instrument_id FROM core.instruments WHERE canonical_code = $1)
         AND trade_date = '2025-12-31'::date`,
      [`${prefix}00.SH`]
    );
    let refreshedErr = null;
    try {
      await classroomService.confirmCreationPreview({
        adminUser: teacherUser,
        previewId: preview2.previewId,
        confirmRequestId: 'cfm_stale_001',
      });
    } catch (e) {
      refreshedErr = e;
    }
    assert.ok(refreshedErr && refreshedErr.status === 409, '数据变化后确认旧预览须返回 409');
    assert.strictEqual(refreshedErr.extra.code, 'PREVIEW_REFRESH_REQUIRED');
    assert.ok(refreshedErr.extra.newPreview && refreshedErr.extra.newPreview.previewId);

    // 4b. 转债校准样本被原地等和改写（70->105 且 130->95，总和不变）导致分桶失效 -> 旧预览不得建场，重检返回 pass=false
    const previewCb = await classroomService.createCreationPreview({
      adminUser: teacherUser,
      title: '转债校准失效测试',
      mode: 'real',
      blindMode: true,
      startYear: 2011,
      industries: sampled.groups,
    });
    assert.strictEqual(previewCb.pass, true);
    await pool.query(
      `UPDATE market.convertible_bond_daily_metrics
       SET conversion_value = CASE
         WHEN conversion_value = 70 THEN 105
         WHEN conversion_value = 130 THEN 95
         ELSE conversion_value
       END
       WHERE conversion_value IN (70, 130)`
    );
    let cbInvalidErr = null;
    try {
      await classroomService.confirmCreationPreview({
        adminUser: teacherUser,
        previewId: previewCb.previewId,
        confirmRequestId: 'cfm_cb_stale_001',
      });
    } catch (e) {
      cbInvalidErr = e;
    }
    assert.ok(cbInvalidErr && cbInvalidErr.status === 409, '转债校准失效后确认旧预览须被拦截');
    assert.strictEqual(cbInvalidErr.extra.code, 'PREVIEW_REFRESH_REQUIRED');
    assert.strictEqual(cbInvalidErr.extra.newPreview.pass, false, '重检后的新预览须显示转债校准不通过');

    // 4c. 恢复转债样本后，将 2012 年首个开市日从 2012-01-04 改到 2012-01-03（开市日总数不变） -> 旧预览不得建场
    await pool.query(
      `UPDATE market.convertible_bond_daily_metrics
       SET conversion_value = CASE
         WHEN conversion_value = 105 THEN 70
         WHEN conversion_value = 95 THEN 130
         ELSE conversion_value
       END
       WHERE conversion_value IN (105, 95)`
    );
    const previewCal = await classroomService.createCreationPreview({
      adminUser: teacherUser,
      title: '日历修订测试',
      mode: 'real',
      blindMode: true,
      startYear: 2011,
      industries: sampled.groups,
    });
    assert.strictEqual(previewCal.pass, true);
    await pool.query(
      `UPDATE market.trade_calendar
       SET is_open = CASE
         WHEN trade_date = '2012-01-03'::date THEN TRUE
         WHEN trade_date = '2012-01-04'::date THEN FALSE
         ELSE is_open
       END
       WHERE exchange = 'SSE' AND trade_date IN ('2012-01-03'::date, '2012-01-04'::date)`
    );
    let calChangedErr = null;
    try {
      await classroomService.confirmCreationPreview({
        adminUser: teacherUser,
        previewId: previewCal.previewId,
        confirmRequestId: 'cfm_cal_stale_001',
      });
    } catch (e) {
      calChangedErr = e;
    }
    assert.ok(calChangedErr && calChangedErr.status === 409, '交易日历修订后确认旧预览须返回 409');
    assert.strictEqual(calChangedErr.extra.code, 'PREVIEW_REFRESH_REQUIRED');
    assert.strictEqual(calChangedErr.extra.newPreview.pass, false, '重检后因 2012-01-03 缺行情须判定不通过');

    // 4d. 恢复日历后，将行业树中一个入选一级行业调整为另一入选行业的子节点 -> 旧预览须失效并返回重检阻断原因
    await pool.query(
      `UPDATE market.trade_calendar
       SET is_open = CASE
         WHEN trade_date = '2012-01-03'::date THEN FALSE
         WHEN trade_date = '2012-01-04'::date THEN TRUE
         ELSE is_open
       END
       WHERE exchange = 'SSE' AND trade_date IN ('2012-01-03'::date, '2012-01-04'::date)`
    );
    const previewTree = await classroomService.createCreationPreview({
      adminUser: teacherUser,
      title: '行业树修订测试',
      mode: 'real',
      blindMode: true,
      startYear: 2011,
      industries: sampled.groups,
    });
    assert.strictEqual(previewTree.pass, true);
    await pool.query(
      `UPDATE core.industry_nodes
       SET parent_id = $1, level = 2
       WHERE industry_node_id = $2`,
      [indIds[0], indIds[1]]
    );
    let treeChangedErr = null;
    try {
      await classroomService.confirmCreationPreview({
        adminUser: teacherUser,
        previewId: previewTree.previewId,
        confirmRequestId: 'cfm_tree_stale_001',
      });
    } catch (e) {
      treeChangedErr = e;
    }
    assert.ok(treeChangedErr && treeChangedErr.status === 409, '行业树变更后确认旧预览须返回 409');
    assert.strictEqual(treeChangedErr.extra.code, 'PREVIEW_REFRESH_REQUIRED');
    assert.strictEqual(treeChangedErr.extra.newPreview.pass, false, '重检后因不再对应 4 个不同一级行业须判定不通过');
    assert.ok(Array.isArray(treeChangedErr.extra.newPreview.blockers) && treeChangedErr.extra.newPreview.blockers.length > 0);

    // 4e. 恢复行业树后，将一只停牌股票的年末停牌记录改归另一只股票（总数与最大日期不变） -> 旧预览须失效并返回阻断原因
    await pool.query(
      `UPDATE core.industry_nodes SET parent_id = NULL, level = 1 WHERE industry_node_id = $1`,
      [indIds[1]]
    );
    const { rows: suspTargetRows } = await pool.query(
      `SELECT instrument_id FROM core.instruments WHERE canonical_code = ANY($1::text[]) ORDER BY canonical_code ASC`,
      [[`${prefix}00.SH`, `${prefix}01.SH`]]
    );
    const suspInstA = suspTargetRows[0].instrument_id;
    const suspInstB = suspTargetRows[1].instrument_id;
    // 删掉 A 在 2025-12-31 的行情，补入 2025-12-30 行情与复权因子并插入 2025-12-31 停牌证据（预检黄灯通过）
    await pool.query(
      `DELETE FROM market.daily_bars WHERE instrument_id = $1 AND trade_date = '2025-12-31'::date`,
      [suspInstA]
    );
    await pool.query(
      `INSERT INTO market.daily_bars (instrument_id, trade_date, source_id, open, high, low, close, volume, price_adjust, bar_status, quality_status)
       VALUES ($1, '2025-12-30'::date, (SELECT source_id FROM ops.data_sources LIMIT 1), 11, 11, 11, 11, 100, 'none', 'terminal', 'passed')
       ON CONFLICT DO NOTHING`,
      [suspInstA]
    );
    await pool.query(
      `INSERT INTO market.adjustment_factors (instrument_id, trade_date, source_id, adj_factor)
       VALUES ($1, '2025-12-30'::date, (SELECT source_id FROM ops.data_sources LIMIT 1), 1.0)
       ON CONFLICT DO NOTHING`,
      [suspInstA]
    );
    await pool.query(
      `INSERT INTO market.stock_suspend_calendar (instrument_id, trade_date, suspend_type, suspend_reason, source_id)
       VALUES ($1, '2025-12-31'::date, 'full', '测试停牌', (SELECT source_id FROM ops.data_sources LIMIT 1))
       ON CONFLICT DO NOTHING`,
      [suspInstA]
    );
    const previewSusp = await classroomService.createCreationPreview({
      adminUser: teacherUser,
      title: '停牌归属修订测试',
      mode: 'real',
      blindMode: true,
      startYear: 2011,
      industries: sampled.groups,
    });
    assert.strictEqual(previewSusp.pass, true);
    // 将该条停牌记录改归 B（行数和最大日期均不变）
    await pool.query(
      `UPDATE market.stock_suspend_calendar
       SET instrument_id = $2
       WHERE instrument_id = $1 AND trade_date = '2025-12-31'::date`,
      [suspInstA, suspInstB]
    );
    let suspChangedErr = null;
    try {
      await classroomService.confirmCreationPreview({
        adminUser: teacherUser,
        previewId: previewSusp.previewId,
        confirmRequestId: 'cfm_susp_stale_001',
      });
    } catch (e) {
      suspChangedErr = e;
    }
    assert.ok(suspChangedErr && suspChangedErr.status === 409, '停牌记录改归另一只股票后确认旧预览须返回 409');
    assert.strictEqual(suspChangedErr.extra.code, 'PREVIEW_REFRESH_REQUIRED');
    assert.strictEqual(suspChangedErr.extra.newPreview.pass, false, '重检后因原股票缺年末行情和停牌证据须判定不通过');

    // 4f. 恢复停牌记录后，更正一只入选股票的证券-发行人关系（company_instruments.relation_type 改写） -> 旧预览须失效并返回 409
    await pool.query(
      `UPDATE market.stock_suspend_calendar
       SET instrument_id = $1
       WHERE instrument_id = $2 AND trade_date = '2025-12-31'::date`,
      [suspInstA, suspInstB]
    );
    const previewCi = await classroomService.createCreationPreview({
      adminUser: teacherUser,
      title: '证券发行人关系修订测试',
      mode: 'real',
      blindMode: true,
      startYear: 2011,
      industries: sampled.groups,
    });
    assert.strictEqual(previewCi.pass, true);
    await pool.query(
      `UPDATE core.company_instruments
       SET relation_type = 'legacy_issued_by'
       WHERE instrument_id = $1 AND relation_type = 'issued_by'`,
      [suspInstA]
    );
    let ciChangedErr = null;
    try {
      await classroomService.confirmCreationPreview({
        adminUser: teacherUser,
        previewId: previewCi.previewId,
        confirmRequestId: 'cfm_ci_stale_001',
      });
    } catch (e) {
      ciChangedErr = e;
    }
    assert.ok(ciChangedErr && ciChangedErr.status === 409, '证券与发行人关系更正后确认旧预览须返回 409');
    assert.strictEqual(ciChangedErr.extra.code, 'PREVIEW_REFRESH_REQUIRED');
    assert.strictEqual(ciChangedErr.extra.newPreview.pass, false, '重检后因无法确认行业归属须判定不通过');

    // 4g. 恢复发行人关系后，验证并发更新国债年末净值时，预检结果与 dataVersion 来自同一一致快照（绝不会旧收益标成新版本）
    await pool.query(
      `UPDATE core.company_instruments
       SET relation_type = 'issued_by'
       WHERE instrument_id = $1 AND relation_type = 'legacy_issued_by'`,
      [suspInstA]
    );
    const origFetchBond = classroomRepo.fetchBondWealthIndexSeries;
    let bondFetchCount = 0;
    let injectedBondUpdate = false;
    classroomRepo.fetchBondWealthIndexSeries = async (sDate, eDate, client) => {
      const rows = await origFetchBond(sDate, eDate, client);
      bondFetchCount++;
      // createCreationPreview 会先调用一次 runRealPrecheck，再在 prepareScenarioAndSummary 中调用第二次；
      // 在第二次（实际落盘预览的那次）读取国债净值后、fetchFactsDataVersion 前并发提交年末净值更新
      if (bondFetchCount === 2 && !injectedBondUpdate) {
        injectedBondUpdate = true;
        await pool.query(
          `UPDATE market.index_valuation_history
           SET close = close * 1.15
           WHERE index_code = 'CBA00601' AND trade_date = '2025-12-31'::date`
        );
      }
      return rows;
    };
    let previewSnap = null;
    try {
      previewSnap = await classroomService.createCreationPreview({
        adminUser: teacherUser,
        title: '快照一致性测试',
        mode: 'real',
        blindMode: true,
        startYear: 2011,
        industries: sampled.groups,
      });
    } finally {
      classroomRepo.fetchBondWealthIndexSeries = origFetchBond;
    }
    assert.strictEqual(injectedBondUpdate, true);
    assert.strictEqual(previewSnap.pass, true);
    // 由于快照隔离，previewSnap 读取的是旧净值并绑定旧 dataVersion；确认时面对已提交的新净值必须返回 409
    let snapStaleErr = null;
    try {
      await classroomService.confirmCreationPreview({
        adminUser: teacherUser,
        previewId: previewSnap.previewId,
        confirmRequestId: 'cfm_snap_stale_001',
      });
    } catch (e) {
      snapStaleErr = e;
    }
    assert.ok(snapStaleErr && snapStaleErr.status === 409, '预览期间净值已更新时，旧快照预览确认须返回 409 而非被标成新版本');
    assert.strictEqual(snapStaleErr.extra.code, 'PREVIEW_REFRESH_REQUIRED');
    assert.notStrictEqual(snapStaleErr.extra.newPreview.dataVersion, previewSnap.dataVersion, '旧快照数据版本不得与新净值版本混同');

    // 5. 随机演示建场 + 盲玩防剧透检查
    const demoPrev = await classroomService.createCreationPreview({
      adminUser: teacherUser,
      title: '',
      mode: 'demo',
      blindMode: true,
      startYear: 2011,
      demoVariant: 'random',
      demoSeed: 'blind-demo-seed-99',
    });
    assert.strictEqual(demoPrev.pass, true);
    assert.strictEqual(demoPrev.demoSeed, 'blind-demo-seed-99');
    const demoCreated = await classroomService.confirmCreationPreview({
      adminUser: teacherUser,
      previewId: demoPrev.previewId,
      confirmRequestId: 'cfm_demo_001',
    });
    const dcid = demoCreated.classroom.classroomId;
    await classroomService.joinClassroom({ classroomId: dcid, authUser: stu1, nickname: '盲玩学员' });
    await classroomService.openRound({ classroomId: dcid, roundNo: 1, expectedStateVersion: 1 });
    const stuState = await classroomService.getStudentState({ classroomId: dcid, authUser: stu1 });
    const serialized = JSON.stringify(stuState);
    assert.strictEqual(serialized.includes('blind-demo-seed-99'), false, '盲玩学员响应不得暴露随机种子');
    assert.strictEqual(serialized.includes('2011'), false, '盲玩学员响应不得暴露历史年份');
    assert.strictEqual(serialized.includes('DEMO_'), false, '盲玩学员响应不得暴露证券代码');

    console.log('stock-classroom-random-creation.test.js: ALL PASSED');
  } finally {
    if (pool) {
      await pool.end().catch(() => {});
    }
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
