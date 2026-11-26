'use strict';

// INC-0054 同类范围整改：备源分红与业绩预告原先用「整条报文哈希」当业务键，
// 同一笔分红/同一次预告只要字段补录或文字微调，就会新增一条业务记录。
// 现改为事件身份键（分红：证券＋财年期末＋公告日＋除净/付款日；预告：公司＋报告期＋类型＋公告日），
// 并用「同事件已有历史行就沿用其键」的兼容查询，改键当天不会又灌一批重复。
const assert = require('assert');
const { pool } = require('../db/connection');
const projRepo = require('../repositories/stockProjectionRepository');
const { summarizeCollectionSources } = require('../services/financialDataArchitecture');
const { asDate } = require('../domain/stockFacts');

const TS_CODE = '600989.SH';

async function run() {
  // 0) 采集批次的来源登记（INC-0054 第一阶段第 3 条）：不能一律记在 tushare 名下
  assert.deepStrictEqual(
    summarizeCollectionSources({
      income: [{ source_code: 'lixinger_official' }, {}],
      dividends: [{ source_code: 'lixinger_official' }],
      valuationIssues: [{ field: 'pe' }],
    }),
    { lixinger_official: 2, tushare: 1 },
    '批次必须按行内真实来源统计，valuationIssues 不是数据集不能计入',
  );

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sources = await projRepo.sourceIds(client);
    const sourceId = sources.tushare;
    assert.ok(sourceId, 'tushare 来源必须已登记');
    const master = await projRepo.ensureMaster(client, TS_CODE, sources, {
      ts_code: TS_CODE, name: '事件键测试', market: 'CN', list_date: '20040818',
    });

    const dividend = {
      ts_code: TS_CODE, end_date: '20241231', ann_date: '20250410', imp_ann_date: '20250410',
      ex_date: '20250612', pay_date: '20250701', record_date: '20250613',
      cash_div_tax: 0.5, cash_div: 0.5, stk_bo_rate: null, stk_co_rate: null,
      base_share: 100, div_proc: '实施', currency: 'CNY', source_code: 'tushare',
    };
    const writeDividend = async row => {
      const sourceKey = await projRepo.resolveDefaultDividendSourceKey(client, {
        instrumentId: master.instrumentId, sourceId, row, fallbackCode: TS_CODE,
      });
      return projRepo.upsertCorporateAction({
        instrumentId: master.instrumentId, fiscalPeriodEnd: asDate(row.end_date),
        announcedAt: asDate(row.ann_date), recordDate: asDate(row.record_date), exDate: asDate(row.ex_date),
        payDate: asDate(row.pay_date), status: row.div_proc,
        cashPerSharePreTax: row.cash_div_tax, cashPerShareAfterTax: row.cash_div,
        stockDividendRatio: row.stk_bo_rate, capitalizationRatio: row.stk_co_rate,
        baseShares: 1000000, totalCashAmount: 500000, currencyCode: row.currency,
        sourceId, sourceKey, legacySourceKeys: [], protectedSourceKeys: [], batchPeers: [], rawPayload: row,
      }, client);
    };
    const dividendRows = async () => (await client.query(
      `SELECT action_id FROM fundamental.corporate_actions
        WHERE instrument_id=$1 AND source_id=$2 AND action_type='dividend'`, [master.instrumentId, sourceId])).rows.length;

    const firstKey = await writeDividend(dividend);
    assert.strictEqual(await dividendRows(), 1, '同一笔分红首次采集只有一行');

    // 1) 字段补录 / 报文变化（旧实现会生成新 source_key → 新增一条）
    const refilled = { ...dividend, imp_ann_date: '20250411', extra_note: '补录字段' };
    const refilledKey = await writeDividend(refilled);
    assert.strictEqual(refilledKey, firstKey, '同一事件补录字段必须沿用同一业务键');
    assert.strictEqual(await dividendRows(), 1, '同一笔分红字段变化不得新增业务记录');

    // 2) 真修订（不同公告日）必须留独立版本
    await writeDividend({ ...dividend, ann_date: '20250420', imp_ann_date: '20250420', cash_div_tax: 0.55 });
    assert.strictEqual(await dividendRows(), 2, '不同公告日的真实修订必须保留独立记录');

    // 3) 历史哈希键的行必须被认回，不能因为改键再新增一条
    const legacyKey = `${TS_CODE}:9f8e7d6c5b4a39281706f5e4d3c2b1a0`; // 旧实现：整条报文哈希
    await client.query(
      `INSERT INTO fundamental.corporate_actions(instrument_id,action_type,fiscal_period_end,announced_at,ex_date,
         cash_per_share_pre_tax,total_cash_amount,currency_code,source_id,source_key,raw_payload)
       VALUES($1,'dividend','20231231','20240415','20240620',0.3,300000,'CNY',$2,$3,'{}'::jsonb)`,
      [master.instrumentId, sourceId, legacyKey]);
    const legacyRow = {
      ts_code: TS_CODE, end_date: '20231231', ann_date: '20240415', ex_date: '20240620',
      cash_div_tax: 0.3, base_share: 100, div_proc: '实施', currency: 'CNY', source_code: 'tushare',
    };
    const inheritedKey = await writeDividend(legacyRow);
    assert.strictEqual(inheritedKey, legacyKey, '历史哈希键的行必须被认回（沿用旧键），改键不能新增重复');
    assert.strictEqual(await dividendRows(), 3, '认回历史行后不得多出一行');

    // 3.1) 同财年同公告日、不同除净日的两笔分红是两笔独立事件（INC-0054 修复项 4）：
    // 历史键认回原先只按 (证券, 来源, 财年期末, 公告日) 匹配，会把第二笔认成第一笔并互相覆盖。
    // 现在只认旧哈希键且要求除净/付款/登记日一致——不同除净日必须各自留行。
    const twinBase = {
      ts_code: TS_CODE, end_date: '20221231', ann_date: '20230415', imp_ann_date: '20230415',
      cash_div_tax: 0.2, base_share: 100, div_proc: '实施', currency: 'CNY', source_code: 'tushare',
    };
    const twinA = { ...twinBase, ex_date: '20230510', pay_date: '20230601' };
    const twinB = { ...twinBase, ex_date: '20230920', pay_date: '20231001' };
    const twinLegacyKey = `${TS_CODE}:00112233445566778899aabbccddeeff`;
    await client.query(
      `INSERT INTO fundamental.corporate_actions(instrument_id,action_type,fiscal_period_end,announced_at,ex_date,
         pay_date,cash_per_share_pre_tax,total_cash_amount,currency_code,source_id,source_key,raw_payload)
       VALUES($1,'dividend','20221231','20230415','20230510','20230601',0.2,200000,'CNY',$2,$3,'{}'::jsonb)`,
      [master.instrumentId, sourceId, twinLegacyKey]);
    const twinKeyA = await writeDividend(twinA);
    assert.strictEqual(twinKeyA, twinLegacyKey, '同一除净日的历史哈希行必须被认回');
    const twinKeyB = await writeDividend(twinB);
    assert.notStrictEqual(twinKeyB, twinLegacyKey, '不同除净日不得继承同公告日另一笔的旧键');
    const twinRows = async () => (await client.query(
      `SELECT source_key FROM fundamental.corporate_actions
        WHERE instrument_id=$1 AND source_id=$2 AND action_type='dividend' AND fiscal_period_end='2022-12-31'`,
      [master.instrumentId, sourceId])).rows;
    assert.strictEqual((await twinRows()).length, 2, '同财年同公告日、不同除净日的两笔分红必须保留为 2 行');
    await writeDividend(twinA);
    await writeDividend(twinB);
    const twinReplay = await twinRows();
    assert.strictEqual(twinReplay.length, 2, '重放两笔分红不得新增或合并');
    assert.deepStrictEqual(twinReplay.map(row => row.source_key).sort(), [twinKeyB, twinLegacyKey].sort(),
      '两笔分红的业务键必须各自稳定');

    // 4) 业绩预告：摘要文字变化不新增，不同公告日新增
    const guidanceRows = async () => (await client.query(
      `SELECT guidance_id FROM fundamental.earnings_guidance WHERE company_id=$1 AND source_id=$2`,
      [master.companyId, sourceId])).rows.length;
    const writeGuidance = async row => {
      const sourceKey = await projRepo.resolveEarningsGuidanceSourceKey(client, {
        companyId: master.companyId, sourceId, row, fallbackCode: TS_CODE,
      });
      await projRepo.upsertEarningsGuidance({
        companyId: master.companyId, periodEnd: asDate(row.end_date), guidanceType: row.type || 'forecast',
        announcedAt: asDate(row.ann_date), profitMin: row.net_profit_min * 10000, profitMax: row.net_profit_max * 10000,
        changeMin: row.p_change_min, changeMax: row.p_change_max, summary: row.summary,
        changeReason: row.change_reason, sourceId, sourceKey, rawPayload: row,
      }, client);
      return sourceKey;
    };
    const forecast = {
      ts_code: TS_CODE, end_date: '20241231', ann_date: '20250120', type: 'forecast',
      net_profit_min: 10000, net_profit_max: 12000, p_change_min: 0.2, p_change_max: 0.4,
      summary: '预计净利润增长', change_reason: '主营业务增长', source_code: 'tushare',
    };
    const guidanceKey = await writeGuidance(forecast);
    await writeGuidance({ ...forecast, summary: '预计净利润同比增长（文字勘误）' });
    assert.strictEqual(await guidanceRows(), 1, '同一次预告的文字微调不得新增业务记录');
    await writeGuidance({ ...forecast, net_profit_max: 13000 });
    assert.strictEqual(await guidanceRows(), 1, '同一次预告的数值修正必须在原记录上更新');
    const corrected = await client.query(
      `SELECT profit_max FROM fundamental.earnings_guidance WHERE source_id=$1 AND source_key=$2`,
      [sourceId, guidanceKey]);
    assert.strictEqual(Number(corrected.rows[0].profit_max), 130000000,
      '数值修正必须真正写入（守卫不能把有效更新挡掉）');
    await writeGuidance({ ...forecast, ann_date: '20250420', net_profit_max: 15000 });
    assert.strictEqual(await guidanceRows(), 2, '不同公告日的新预告必须独立留版');

    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
  console.log('备源分红与业绩预告事件身份键验证通过');
}

run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => pool.end());
