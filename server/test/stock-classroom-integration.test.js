'use strict';

const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const { Client } = require('pg');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { createMigratedDatabase } = require('./helpers/migrated-database');
const { testDatabaseConfig } = require('./lib/testDatabase');

async function run() {
  const dbName = 'portfolio_test_cr_' + crypto.randomBytes(4).toString('hex');
  const admin = new Client({ ...testDatabaseConfig(), connectionTimeoutMillis: 10000 });
  await admin.connect();

  let pool;
  try {
    await createMigratedDatabase(admin, dbName);
    pool = require('../db/connection').pool;
    const classroomService = require('../services/classroomService');

    const teacherUser = { username: 'admin', role: 'admin', subject_identity: 'subj_admin_1' };
    const stu1 = { username: 'alice', role: 'user', subject_identity: 'subj_alice_1' };
    const stu2 = { username: 'bob', role: 'user', subject_identity: 'subj_bob_1' };
    const stu3 = { username: 'charlie', role: 'user', subject_identity: 'subj_charlie_1' };

    // 1. 真实场次在无 15 年数据时应被预检拦截
    let realBlocked = false;
    try {
      await classroomService.createClassroom({
        adminUser: teacherUser,
        title: '真实场次预检测试',
        mode: 'real',
        blindMode: true,
        startYear: 2011,
        industries: [
          { industryName: '能源', codes: ['600000.SH', '600001.SH', '600002.SH'] },
          { industryName: '制造', codes: ['600003.SH', '600004.SH', '600005.SH'] },
          { industryName: '金融', codes: ['600006.SH', '600007.SH', '600008.SH'] },
          { industryName: '零售', codes: ['600009.SH', '600010.SH', '600011.SH'] },
        ],
      });
    } catch (e) {
      realBlocked = e.status === 400;
    }
    assert.strictEqual(realBlocked, true, '真实场次数据不足时必须阻断创建');

    // 2. 创建演示场次（15 轮，盲玩开启，留空标题验证中性默认标题不泄露历史年份）
    const created = await classroomService.createClassroom({
      adminUser: teacherUser,
      title: '',
      mode: 'demo',
      blindMode: true,
      startYear: 2011,
    });
    const cid = created.classroom.classroomId;
    assert.strictEqual(created.classroom.status, 'pending');
    assert.strictEqual(created.classroom.title.includes('2011'), false, '盲玩默认标题不得包含历史年份');
    assert.strictEqual(created.classroom.title.includes('2025'), false, '盲玩默认标题不得包含历史年份');
    assert.ok(created.qrDataUrl && created.qrDataUrl.startsWith('data:image/png;base64,'));

    // 3. 学员 1 与 学员 3（重名）加入，并验证重复加入幂等
    const j1 = await classroomService.joinClassroom({ classroomId: cid, authUser: stu1, nickname: '小王' });
    assert.strictEqual(j1.member.displayNickname, '小王');
    const j1Repeat = await classroomService.joinClassroom({ classroomId: cid, authUser: stu1, nickname: '小王改名' });
    assert.strictEqual(j1Repeat.alreadyJoined, true);
    assert.strictEqual(j1Repeat.member.memberId, j1.member.memberId);

    const j3 = await classroomService.joinClassroom({ classroomId: cid, authUser: stu3, nickname: '小王' });
    assert.strictEqual(j3.nicknameAdjusted, true);
    assert.strictEqual(j3.member.displayNickname, '小王#2');

    // 开放第 1 轮配置
    let crState = await classroomService.openRound({ classroomId: cid, roundNo: 1, expectedStateVersion: 1 });
    assert.strictEqual(crState.status, 'configuring');

    // 4. 校验未揭晓防剧透 & 盲玩白名单（含场次起止年份与市场总体 PE/PB 分档）
    const st1R1 = await classroomService.getStudentState({ classroomId: cid, authUser: stu1 });
    assert.strictEqual(st1R1.classroom.startYear, null, '盲玩学员端不得返回真实起始年份');
    assert.strictEqual(st1R1.classroom.endYear, null, '盲玩学员端不得返回真实结束年份');
    assert.strictEqual(st1R1.round.marketHeaderTitle, '市场总体');
    assert.strictEqual(st1R1.round.calendarYear, null);
    assert.ok(st1R1.round.marketPeDisplay.includes('倍') || st1R1.round.marketPeDisplay === '不适用', '盲玩市场总体 PE 须分档');
    assert.ok(st1R1.round.marketPbDisplay.includes('倍') || st1R1.round.marketPbDisplay === '不适用', '盲玩市场总体 PB 须分档');
    assert.strictEqual(st1R1.round.assets[0].canonicalCode, undefined);
    assert.strictEqual(st1R1.round.assets[0].returnRate, undefined);
    assert.strictEqual(st1R1.round.assets[12].industryName, '债券');
    assert.strictEqual(st1R1.round.assets[12].alias, '十年期国债');

    const projR1 = await classroomService.getProjectorState({ classroomId: cid });
    assert.strictEqual(projR1.classroom.startYear, null, '盲玩投屏不得返回真实起始年份');
    assert.strictEqual(projR1.classroom.endYear, null, '盲玩投屏不得返回真实结束年份');
    assert.ok(projR1.round.marketPeDisplay.includes('倍') || projR1.round.marketPeDisplay === '不适用');

    const teacherR1 = await classroomService.getTeacherState({ classroomId: cid });
    assert.strictEqual(teacherR1.classroom.startYear, 2011, '教师管理端可看真实年份');
    assert.strictEqual(teacherR1.classroom.endYear, 2025);

    // 5. 草稿版本冲突（409）与超额提交拦截
    const d1 = await classroomService.saveDraft({
      classroomId: cid,
      roundNo: 1,
      authUser: stu1,
      allocations: { stk_energy_a: 50000000, bond_10y: 10000000 },
      expectedVersion: 0,
    });
    assert.strictEqual(d1.draftVersion, 1);

    let conflictCaught = false;
    try {
      await classroomService.saveDraft({
        classroomId: cid,
        roundNo: 1,
        authUser: stu1,
        allocations: { stk_energy_a: 30000000 },
        expectedVersion: 0,
      });
    } catch (e) {
      conflictCaught = e.status === 409 && e.extra && e.extra.serverVersion === 1;
    }
    assert.strictEqual(conflictCaught, true, '旧草稿版本写入必须返回 409 冲突');

    let overBudgetCaught = false;
    try {
      await classroomService.submitAllocation({
        classroomId: cid,
        roundNo: 1,
        authUser: stu1,
        allocations: { stk_energy_a: 100000001 },
        clientRequestId: 'over_1',
      });
    } catch (e) {
      overBudgetCaught = e.status === 400;
    }
    assert.strictEqual(overBudgetCaught, true, '超限提交必须被服务端拦截');

    // 6. 正式提交幂等 + 锁单/解锁保留提交 + 解锁与揭晓竞态
    const sub1 = await classroomService.submitAllocation({
      classroomId: cid,
      roundNo: 1,
      authUser: stu1,
      allocations: { stk_energy_a: 50000000, bond_10y: 20000000 },
      clientRequestId: 'r1_stu1_req1',
    });
    assert.strictEqual(sub1.idempotent, false);
    const sub1Dup = await classroomService.submitAllocation({
      classroomId: cid,
      roundNo: 1,
      authUser: stu1,
      allocations: { stk_energy_a: 50000000, bond_10y: 20000000 },
      clientRequestId: 'r1_stu1_req1',
    });
    assert.strictEqual(sub1Dup.idempotent, true);

    crState = await classroomService.lockRound({ classroomId: cid, roundNo: 1, expectedStateVersion: crState.stateVersion });
    assert.strictEqual(crState.status, 'locked');

    // 解锁后保留有效提交
    crState = await classroomService.unlockRound({ classroomId: cid, roundNo: 1, expectedStateVersion: crState.stateVersion });
    assert.strictEqual(crState.status, 'configuring');
    const afterUnlockState = await classroomService.getStudentState({ classroomId: cid, authUser: stu1 });
    assert.strictEqual(afterUnlockState.submission.allocations.stk_energy_a, 50000000);

    crState = await classroomService.lockRound({ classroomId: cid, roundNo: 1, expectedStateVersion: crState.stateVersion });

    // 并发竞态：解锁与揭晓同时使用同一 stateVersion，仅一方成功
    const raceResults = await Promise.allSettled([
      classroomService.revealRound({ classroomId: cid, roundNo: 1, expectedStateVersion: crState.stateVersion }),
      classroomService.unlockRound({ classroomId: cid, roundNo: 1, expectedStateVersion: crState.stateVersion }),
    ]);
    const fulfilledCount = raceResults.filter((r) => r.status === 'fulfilled').length;
    assert.strictEqual(fulfilledCount, 1, '解锁与揭晓并发只允许一方成功');

    // 确保第 1 轮最终处于已揭晓（若上面解锁先赢则补锁并揭晓）
    let tState = await classroomService.getTeacherState({ classroomId: cid });
    if (tState.round.status === 'configuring') {
      crState = await classroomService.lockRound({ classroomId: cid, roundNo: 1, expectedStateVersion: tState.classroom.stateVersion });
      crState = await classroomService.revealRound({ classroomId: cid, roundNo: 1, expectedStateVersion: crState.stateVersion });
    } else {
      crState = tState.classroom;
    }
    assert.strictEqual(crState.status, 'revealed');

    // 重复揭晓幂等
    const revealAgain = await classroomService.revealRound({ classroomId: cid, roundNo: 1, expectedStateVersion: crState.stateVersion });
    assert.strictEqual(revealAgain.status, 'revealed');

    // 7. 跑完第 2..15 轮，包含：
    // - 学员 2 在第 4 轮配置中迟到加入（第 1-3 轮补记全现金参考名次，旧榜不变）
    // - 第 8 轮标题切换「模拟综指」与策略基金开放
    // - 第 9 轮学员 1 买入低市盈率 8，第 10 轮该策略暂停且学员 1 缺交 -> 验证开盘前全额转现金且缺交沿用
    // - 第 11 轮买入可转债（100 元期初锚点）
    for (let roundNo = 2; roundNo <= 15; roundNo++) {
      crState = await classroomService.openRound({ classroomId: cid, roundNo, expectedStateVersion: crState.stateVersion });

      if (roundNo === 4) {
        const j2 = await classroomService.joinClassroom({ classroomId: cid, authUser: stu2, nickname: '迟到同学' });
        assert.strictEqual(j2.member.firstEligibleRound, 4);
      }

      const s1 = await classroomService.getStudentState({ classroomId: cid, authUser: stu1 });
      if (roundNo === 8) {
        assert.strictEqual(s1.round.marketHeaderTitle, '模拟综指');
        assert.strictEqual(s1.round.showIndexLevel, true);
        assert.ok(s1.round.assets.some((a) => a.assetId === 'idx_composite'));
      }
      if (roundNo === 9) {
        // 买入低市盈率 8
        const half = Math.floor(s1.account.openingTotalCents / 2);
        await classroomService.submitAllocation({
          classroomId: cid,
          roundNo: 9,
          authUser: stu1,
          allocations: { strat_low_pe_8: half, stk_energy_a: s1.account.openingTotalCents - half },
          clientRequestId: 'r9_stu1',
        });
      } else if (roundNo === 10) {
        // 第 10 轮低市盈率 8 暂停：验证已自动转为现金且不允许提交暂停策略，且本轮故意缺交
        assert.strictEqual(s1.account.liquidationEvents.length, 1);
        assert.strictEqual(s1.account.liquidationEvents[0].assetId, 'strat_low_pe_8');
      } else if (roundNo === 11) {
        const cb0 = s1.round.assets.find((a) => a.assetId === 'cb_0');
        assert.ok(cb0);
        assert.strictEqual(cb0.cbInfo.openPrice, 100);
        await classroomService.submitAllocation({
          classroomId: cid,
          roundNo: 11,
          authUser: stu1,
          allocations: { cb_0: s1.account.openingTotalCents },
          clientRequestId: 'r11_stu1',
        });
      } else {
        // 其余轮次满仓（含零头精确到分）
        await classroomService.submitAllocation({
          classroomId: cid,
          roundNo,
          authUser: stu1,
          allocations: { stk_energy_a: s1.account.openingTotalCents },
          clientRequestId: `r${roundNo}_stu1`,
        });
      }

      crState = await classroomService.lockRound({ classroomId: cid, roundNo, expectedStateVersion: crState.stateVersion });
      crState = await classroomService.revealRound({ classroomId: cid, roundNo, expectedStateVersion: crState.stateVersion });
    }

    assert.strictEqual(crState.status, 'completed');

    // 8. 全 15 轮自动对账：逐学员逐轮校验守恒不变量
    for (const user of [stu1, stu2, stu3]) {
      const rep = await classroomService.getMemberReport({ classroomId: cid, authUser: user });
      assert.strictEqual(rep.ready, true);
      assert.strictEqual(rep.rounds.length, 15);
      let prevEnd = 100000000;
      for (const r of rep.rounds) {
        assert.strictEqual(r.openingTotalCents, prevEnd, `${user.username} R${r.roundNo} 期初等于上轮期末`);
        const itemsEndingSum = r.itemDetails.reduce((a, b) => a + Number(b.endingCents), 0);
        const itemsPnlSum = r.itemDetails.reduce((a, b) => a + Number(b.pnlCents), 0);
        assert.strictEqual(r.endingCashCents + itemsEndingSum, r.endingTotalCents, `${user.username} R${r.roundNo} 期末汇总守恒`);
        assert.strictEqual(r.endingTotalCents - r.openingTotalCents, itemsPnlSum, `${user.username} R${r.roundNo} 盈亏守恒`);
        prevEnd = r.endingTotalCents;
      }
      assert.strictEqual(rep.summary.finalTotalCents, prevEnd);
    }

    // 9. 验证迟到学员第 1-3 轮补录与课后想法保存
    const rep2 = await classroomService.getMemberReport({ classroomId: cid, authUser: stu2 });
    assert.strictEqual(rep2.rounds[0].participationType, 'late_backfill');
    assert.strictEqual(rep2.rounds[0].isOfficialRanked, false);
    assert.strictEqual(rep2.rounds[0].officialParticipantCount, 2); // R1 只有 stu1 和 stu3 正式参排

    await classroomService.saveAfterClassNote({ classroomId: cid, authUser: stu1, note: '分散配置很重要' });
    const rep1After = await classroomService.getMemberReport({ classroomId: cid, authUser: stu1 });
    assert.strictEqual(rep1After.afterClassNote, '分散配置很重要');

    // 10. 场次完成后关闭新学员入场
    let closedJoinBlocked = false;
    try {
      await classroomService.joinClassroom({
        classroomId: cid,
        authUser: { username: 'latecomer', role: 'user', subject_identity: 'subj_late_99' },
        nickname: '已结束来迟',
      });
    } catch (e) {
      closedJoinBlocked = e.status === 403;
    }
    assert.strictEqual(closedJoinBlocked, true, '场次完成后必须关闭新学员入场');

    // 11. 真实场次数据完备时：预检返回逐年国债回报 + 转债样本校准，且能成功建场并结算
    const industries = [
      { industryName: '能源', codes: ['600028.SH', '601857.SH', '601088.SH'] },
      { industryName: '制造', codes: ['600104.SH', '000651.SZ', '000333.SZ'] },
      { industryName: '金融', codes: ['601398.SH', '600036.SH', '601318.SH'] },
      { industryName: '零售', codes: ['601933.SH', '002024.SZ', '600827.SH'] },
    ];
    const allCodes = industries.flatMap((ind) => ind.codes);
    const instIds = [];
    const taxRow = await pool.query(`SELECT taxonomy_id FROM core.industry_taxonomies WHERE taxonomy_code = 'SW2021'`);
    const swTaxId = taxRow.rows[0].taxonomy_id;
    const nodeIdsByInd = new Map();
    for (let g = 0; g < industries.length; g++) {
      const indName = industries[g].industryName;
      const nRes = await pool.query(
        `INSERT INTO core.industry_nodes (taxonomy_id, industry_code, industry_name, level)
         VALUES ($1, $2, $3, 1)
         ON CONFLICT (taxonomy_id, industry_code) DO UPDATE SET industry_name = EXCLUDED.industry_name
         RETURNING industry_node_id`,
        [swTaxId, `SW_TEST_${g + 1}`, indName]
      );
      nodeIdsByInd.set(indName, nRes.rows[0].industry_node_id);
    }

    let stockCounter = 0;
    for (const ind of industries) {
      const nodeId = nodeIdsByInd.get(ind.industryName);
      for (const code of ind.codes) {
        stockCounter++;
        const ins = await pool.query(
          `INSERT INTO core.instruments (canonical_code, name, asset_class, market, exchange_code, currency_code, status)
           VALUES ($1, $2, 'stock', 'CN', 'SSE', 'CNY', 'listed') RETURNING instrument_id`,
          [code, `真实测试股${stockCounter}`]
        );
        const instId = ins.rows[0].instrument_id;
        instIds.push(instId);

        const compRes = await pool.query(
          `INSERT INTO core.companies (legal_name, short_name, country_code)
           VALUES ($1, $2, 'CN') RETURNING company_id`,
          [`真实测试公司${stockCounter}`, `测试公司${stockCounter}`]
        );
        const compId = compRes.rows[0].company_id;
        await pool.query(
          `INSERT INTO core.company_instruments (company_id, instrument_id, relation_type)
           VALUES ($1, $2, 'issued_by')`,
          [compId, instId]
        );
        await pool.query(
          `INSERT INTO core.company_industry_memberships (company_id, industry_node_id, is_current)
           VALUES ($1, $2, TRUE)`,
          [compId, nodeId]
        );
      }
    }

    for (let yr = 2010; yr <= 2025; yr++) {
      const dStart = `${yr}-01-05`;
      const dEnd = `${yr}-12-30`;
      await pool.query(
        `INSERT INTO market.trade_calendar (exchange, trade_date, is_open, source_code)
         VALUES ('SSE', $1::date, TRUE, 'test'), ('SSE', $2::date, TRUE, 'test')
         ON CONFLICT DO NOTHING`,
        [dStart, dEnd]
      );
      if (yr >= 2011) {
        // 十年期国债财富净值每年固定涨 5%
        const openNav = 100 * Math.pow(1.05, yr - 2011);
        const closeNav = openNav * 1.05;
        await pool.query(
          `INSERT INTO market.index_valuation_history (index_code, valuation_method, trade_date, close, source_code)
           VALUES ('CN10Y_WEALTH', 'wealth_index', $1::date, $2, 'test'), ('CN10Y_WEALTH', 'wealth_index', $3::date, $4, 'test')
           ON CONFLICT DO NOTHING`,
          [dStart, openNav.toFixed(6), dEnd, closeNav.toFixed(6)]
        );
        for (let k = 0; k < instIds.length; k++) {
          await pool.query(
            `INSERT INTO market.daily_bars (instrument_id, trade_date, source_id, close, price_adjust, bar_status, quality_status)
             VALUES ($1, $2::date, 1, 10, 'none', 'terminal', 'passed'),
                    ($1, $3::date, 1, 11, 'none', 'terminal', 'passed')
             ON CONFLICT DO NOTHING`,
            [instIds[k], dStart, dEnd]
          );
          await pool.query(
            `INSERT INTO market.adjustment_factors (instrument_id, trade_date, source_id, adj_factor)
             VALUES ($1, $2::date, 1, 1.0), ($1, $3::date, 1, 1.0)
             ON CONFLICT DO NOTHING`,
            [instIds[k], dStart, dEnd]
          );
          await pool.query(
            `INSERT INTO market.daily_valuations (instrument_id, trade_date, source_id, pe_ttm, pb, total_market_cap)
             VALUES ($1, $2::date, 1, $3, $4, 10000000000)
             ON CONFLICT DO NOTHING`,
            [instIds[k], dStart, 10 + k, (1.2 + k * 0.1).toFixed(2)]
          );
        }
      }
    }

    const precheckService = require('../services/classroomPrecheckService');

    // 11a. 校验重复行业与重复证券代码必须被预检拦截
    const dupIndCheck = await precheckService.runRealPrecheck({
      industries: [
        { industryName: '能源', codes: ['600028.SH', '601857.SH', '601088.SH'] },
        { industryName: '能源', codes: ['600104.SH', '000651.SZ', '000333.SZ'] },
        { industryName: '金融', codes: ['601398.SH', '600036.SH', '601318.SH'] },
        { industryName: '零售', codes: ['601933.SH', '002024.SZ', '600827.SH'] },
      ],
      startYear: 2011,
      totalRounds: 15,
    });
    assert.strictEqual(dupIndCheck.pass, false, '重复行业必须被预检拦截');

    const dupCodeCheck = await precheckService.runRealPrecheck({
      industries: [
        { industryName: '能源', codes: ['600028.SH', '601857.SH', '601088.SH'] },
        { industryName: '制造', codes: ['600028.SH', '000651.SZ', '000333.SZ'] },
        { industryName: '金融', codes: ['601398.SH', '600036.SH', '601318.SH'] },
        { industryName: '零售', codes: ['601933.SH', '002024.SZ', '600827.SH'] },
      ],
      startYear: 2011,
      totalRounds: 15,
    });
    assert.strictEqual(dupCodeCheck.pass, false, '跨行业重复代码必须被预检拦截');

    // 11b. 仅 1 条转债样本未覆盖 9 格分桶时，真实场次必须被阻断（不得退回教学参数）
    await pool.query(
      `INSERT INTO market.convertible_bond_daily_metrics (instrument_id, trade_date, source_id, close, conversion_value, conversion_premium_pct, bond_value, bond_premium_pct, raw_payload)
       VALUES ($1, '2024-01-05', 1, 118, 95, 24.21, 98, 20.41, '{"remain_years":3.0}'::jsonb)
       ON CONFLICT DO NOTHING`,
      [instIds[0]]
    );
    const uncalibratedCheck = await precheckService.runRealPrecheck({ industries, startYear: 2011, totalRounds: 15 });
    assert.strictEqual(uncalibratedCheck.pass, false, '转债分桶样本不足时必须阻断真实场次');
    assert.strictEqual(uncalibratedCheck.cbCalibration.calibratedFromSample, false);

    // 11c. 行业归属错配反例：把 600028.SH(能源) 与 600104.SH(制造) 互换分组，必须被预检拦截
    const mismatchCheck = await precheckService.runRealPrecheck({
      industries: [
        { industryName: '能源', codes: ['600104.SH', '601857.SH', '601088.SH'] },
        { industryName: '制造', codes: ['600028.SH', '000651.SZ', '000333.SZ'] },
        { industryName: '金融', codes: ['601398.SH', '600036.SH', '601318.SH'] },
        { industryName: '零售', codes: ['601933.SH', '002024.SZ', '600827.SH'] },
      ],
      startYear: 2011,
      totalRounds: 15,
    });
    assert.strictEqual(mismatchCheck.pass, false, '证券与所选行业归属错配时必须被预检拦截');

    // 11d. 补齐剩余期限(short/mid/long) × 转股价值(otm/atm/itm) 9 格样本，但故意留空其中 1 格的 bond_premium_pct
    const cbSamples = [
      { id: instIds[1], dt: '2024-01-06', rem: 1.5, cv: 75, prem: 35.0, bprem: 6.0 },
      { id: instIds[2], dt: '2024-01-07', rem: 1.5, cv: 100, prem: 18.0, bprem: 18.0 },
      { id: instIds[3], dt: '2024-01-08', rem: 1.5, cv: 130, prem: 5.0, bprem: 38.0 },
      { id: instIds[4], dt: '2024-01-09', rem: 3.0, cv: 80, prem: 38.0, bprem: 9.0 },
      { id: instIds[5], dt: '2024-01-10', rem: 3.0, cv: 135, prem: 6.0, bprem: 42.0 },
      { id: instIds[6], dt: '2024-01-11', rem: 5.0, cv: 78, prem: 42.0, bprem: 12.0 },
      { id: instIds[7], dt: '2024-01-12', rem: 5.0, cv: 105, prem: 22.0, bprem: 24.0 },
      { id: instIds[8], dt: '2024-01-13', rem: 5.0, cv: 140, prem: 7.5, bprem: null },
    ];
    for (const cs of cbSamples) {
      await pool.query(
        `INSERT INTO market.convertible_bond_daily_metrics (instrument_id, trade_date, source_id, close, conversion_value, conversion_premium_pct, bond_value, bond_premium_pct, raw_payload)
         VALUES ($1, $2::date, 1, 115, $3, $4, 98, $5, $6::jsonb)
         ON CONFLICT DO NOTHING`,
        [cs.id, cs.dt, cs.cv, cs.prem, cs.bprem, JSON.stringify({ remain_years: cs.rem })]
      );
    }

    const partialFieldCheck = await precheckService.runRealPrecheck({ industries, startYear: 2011, totalRounds: 15 });
    assert.strictEqual(partialFieldCheck.pass, false, '分桶缺少纯债溢价率有效样本时不得用默认值放行');
    assert.strictEqual(partialFieldCheck.cbCalibration.calibratedFromSample, false);

    // 补齐最后一格的 bond_premium_pct 后通过预检并成功建场
    await pool.query(
      `UPDATE market.convertible_bond_daily_metrics SET bond_premium_pct = 48.0 WHERE instrument_id = $1 AND trade_date = '2024-01-13'::date`,
      [instIds[8]]
    );

    const realPrecheck = await precheckService.runRealPrecheck({ industries, startYear: 2011, totalRounds: 15 });
    assert.strictEqual(realPrecheck.pass, true, '完整 15 年数据 + 9 格转债校准预检必须通过');
    assert.strictEqual(Object.keys(realPrecheck.bondReturnsByYear).length, 15);
    assert.ok(Math.abs(realPrecheck.bondReturnsByYear[2011] - 0.05) < 1e-6);
    assert.strictEqual(realPrecheck.cbCalibration.calibratedFromSample, true);
    assert.strictEqual(realPrecheck.cbCalibration.coveredBuckets, 9);

    const realCreated = await classroomService.createClassroom({
      adminUser: teacherUser,
      title: '真实场次验证',
      mode: 'real',
      blindMode: true,
      startYear: 2011,
      industries,
    });
    const rcid = realCreated.classroom.classroomId;
    assert.strictEqual(realCreated.classroom.mode, 'real');
    await classroomService.joinClassroom({ classroomId: rcid, authUser: stu1, nickname: '真实测试学员' });
    let realState = await classroomService.openRound({ classroomId: rcid, roundNo: 1, expectedStateVersion: 1 });
    await classroomService.submitAllocation({
      classroomId: rcid,
      roundNo: 1,
      authUser: stu1,
      allocations: { bond_10y: 100000000 },
      clientRequestId: 'real_r1_bond',
    });
    realState = await classroomService.lockRound({ classroomId: rcid, roundNo: 1, expectedStateVersion: realState.stateVersion });
    realState = await classroomService.revealRound({ classroomId: rcid, roundNo: 1, expectedStateVersion: realState.stateVersion });
    const realRep = await classroomService.getMemberReport({ classroomId: rcid, authUser: stu1 });
    assert.strictEqual(realRep.rounds[0].endingTotalCents, 105000000, '真实场次国债 5% 回报结算精确为 105 万元');

    console.log('stock-classroom-integration.test.js: ALL PASSED');
  } finally {
    if (pool) await pool.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
