'use strict';
// 格雷厄姆低估选股：真实 PostgreSQL 取数管线专项测试（方案 27.43 验收项）。
//
// 为什么必须有这个文件：`loadGrahamBalanceFacts` 的语句带大量 `${}` 动态拼接，
// 数据层静态扫描无法还原（`acceptanceRepositorySql.js` 把含 `${}` 的语句列为未覆盖），
// 规则域单元测试又只喂固定事实、不连库。2026-11-22 线上实测该函数报
// `42703 column r.currency_code does not exist`——功能整条不可用，却没有任何测试能拦住。
// 本文件让真实 PG 执行这条语句，覆盖：
//   1) A股走 statement_balance_cas、港股走 statement_balance_hkfrs，同一 report_id 取数；
//   2) 币种取宽表（financial_reports 根本没有 currency_code 列）；
//   3) 金融企业按 comp_type 判 NOT_APPLICABLE，缺科目的非金融才是 PENDING；
//   4) 港股币种佐证缺失时保守屏蔽，有佐证才放行；
//   5) 宽表缺科目且原件也无该字段时保留缺失，不伪造 0。
// 夹具全部用 6099xx 号段并在事务内 ROLLBACK，不写业务数据。
const assert = require('assert');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { pool } = require('../db/connection');
const repo = require('../repositories/stockSelectionRepository');
const GRAHAM = require('../domain/stockSelectionGrahamRules');
const { STATUS } = require('../domain/stockSelectionRules');

const AS_OF = '2099-12-31';
const PERIOD_END = '2099-09-30';
const ANNOUNCED = '2099-11-01';
const VERSION = 'v-test-graham';

async function sourceIdOf(client, code) {
  const { rows } = await client.query('SELECT source_id FROM ops.data_sources WHERE source_code=$1', [code]);
  if (rows.length) return rows[0].source_id;
  const inserted = await client.query(
    `INSERT INTO ops.data_sources(source_code,source_name,source_type,priority)
     VALUES($1,$2,'api',70) ON CONFLICT(source_code) DO UPDATE SET source_name=EXCLUDED.source_name
     RETURNING source_id`, [code, code === 'lixinger_official' ? '理杏仁开放平台' : code]
  );
  return inserted.rows[0].source_id;
}

async function createStock(client, { code, market, name, currency }) {
  const companyId = (await client.query(
    'INSERT INTO core.companies(legal_name) VALUES($1) RETURNING company_id', [name]
  )).rows[0].company_id;
  const instrumentId = (await client.query(
    `INSERT INTO core.instruments(canonical_code,name,asset_class,market,exchange_code,currency_code,status)
     VALUES($1,$2,'stock',$3,$4,$5,'listed') RETURNING instrument_id`,
    [code, name, market, market === 'HK' ? 'HKEX' : 'SSE', currency]
  )).rows[0].instrument_id;
  await client.query('INSERT INTO core.company_instruments(company_id,instrument_id) VALUES($1,$2)',
    [companyId, instrumentId]);
  return companyId;
}

async function insertReport(client, { companyId, sourceId, compType = '1', payload = {} }) {
  return (await client.query(
    `INSERT INTO fundamental.financial_reports
       (company_id,report_kind,period_end,period_type,announced_at,source_id,source_version,
        report_type,comp_type,is_current_version,raw_payload)
     VALUES($1,'balance',$2,'annual',$3,$4,$5,'1',$6,true,$7::jsonb) RETURNING report_id`,
    [companyId, PERIOD_END, ANNOUNCED, sourceId, VERSION, compType, JSON.stringify(payload)]
  )).rows[0].report_id;
}

async function insertCasWide(client, { reportId, companyId, sourceId, tca, tcl, currency }) {
  await client.query(
    `INSERT INTO fundamental.statement_balance_cas
       (report_id,company_id,period_end,accounting_standard,source_id,source_version,currency_code,bs_tca,bs_tcl)
     VALUES($1,$2,$3,'CAS',$4,$5,$6,$7,$8)`,
    [reportId, companyId, PERIOD_END, sourceId, VERSION, currency, tca, tcl]
  );
}

async function insertHkfrsWide(client, { reportId, companyId, sourceId, tca, tcl, currency }) {
  await client.query(
    `INSERT INTO fundamental.statement_balance_hkfrs
       (report_id,company_id,period_end,accounting_standard,source_id,source_version,currency_code,bs_tca,bs_tcl)
     VALUES($1,$2,$3,'HKFRS',$4,$5,$6,$7,$8)`,
    [reportId, companyId, PERIOD_END, sourceId, VERSION, currency, tca, tcl]
  );
}

(async () => {
  const client = await pool.connect();
  const original = pool.query;
  try {
    await client.query('BEGIN');
    // 让仓储内部的 pool.query 落到本事务，夹具对外不可见，结束时整体回滚。
    pool.query = client.query.bind(client);

    const tushare = await sourceIdOf(client, 'tushare');
    const lixinger = await sourceIdOf(client, 'lixinger_official');

    // --- A股：一般商业（tushare，comp_type=1），宽表币种 CNY、原件声明 USD，验证币种以宽表为准 ---
    const cnPlain = {
      code: '609901.SH', market: 'CN', name: '格雷厄姆测试-一般商业', currency: 'CNY',
    };
    const cnPlainId = await createStock(client, cnPlain);
    const cnPlainReport = await insertReport(client, {
      companyId: cnPlainId, sourceId: tushare, compType: '1',
      payload: { ts_code: cnPlain.code, currency: 'USD', total_cur_assets: null },
    });
    await insertCasWide(client, {
      reportId: cnPlainReport, companyId: cnPlainId, sourceId: tushare,
      tca: 10000000, tcl: 4000000, currency: 'CNY',
    });

    // --- A股：银行（comp_type=2），宽表无流动科目 ---
    const cnBank = { code: '609902.SH', market: 'CN', name: '格雷厄姆测试-银行', currency: 'CNY' };
    const cnBankId = await createStock(client, cnBank);
    const cnBankReport = await insertReport(client, {
      companyId: cnBankId, sourceId: tushare, compType: '2', payload: { ts_code: cnBank.code },
    });
    await insertCasWide(client, {
      reportId: cnBankReport, companyId: cnBankId, sourceId: tushare,
      tca: null, tcl: null, currency: 'CNY',
    });

    // --- A股：一般商业但宽表与原件都没有流动科目，必须保持缺失 ---
    const cnGap = { code: '609903.SH', market: 'CN', name: '格雷厄姆测试-缺科目', currency: 'CNY' };
    const cnGapId = await createStock(client, cnGap);
    const cnGapReport = await insertReport(client, {
      companyId: cnGapId, sourceId: tushare, compType: '1', payload: { ts_code: cnGap.code },
    });
    await insertCasWide(client, {
      reportId: cnGapReport, companyId: cnGapId, sourceId: tushare,
      tca: null, tcl: null, currency: 'CNY',
    });

    // --- 港股：HKD 报表，正常可取 ---
    const hkHkd = { code: '89911.HK', market: 'HK', name: '格雷厄姆测试-港股港元', currency: 'HKD' };
    const hkHkdId = await createStock(client, hkHkd);
    const hkHkdReport = await insertReport(client, {
      companyId: hkHkdId, sourceId: lixinger, compType: '1',
      payload: { ts_code: hkHkd.code, currency: 'HKD' },
    });
    await insertHkfrsWide(client, {
      reportId: hkHkdReport, companyId: hkHkdId, sourceId: lixinger,
      tca: 900000000, tcl: 300000000, currency: 'HKD',
    });

    // --- 港股：CNY 报表 + 佐证缺失，币种不可信，必须屏蔽 ---
    const hkCnyNoBasis = { code: '89912.HK', market: 'HK', name: '格雷厄姆测试-港股人民币无佐证', currency: 'HKD' };
    const hkCnyNoBasisId = await createStock(client, hkCnyNoBasis);
    const hkCnyNoBasisReport = await insertReport(client, {
      companyId: hkCnyNoBasisId, sourceId: lixinger, compType: '1',
      payload: { ts_code: hkCnyNoBasis.code, currency: 'CNY' },
    });
    await insertHkfrsWide(client, {
      reportId: hkCnyNoBasisReport, companyId: hkCnyNoBasisId, sourceId: lixinger,
      tca: 800000000, tcl: 200000000, currency: 'CNY',
    });

    // --- 港股：CNY 报表 + 原件原币佐证，应放行 ---
    const hkCnyBasis = { code: '89913.HK', market: 'HK', name: '格雷厄姆测试-港股人民币有佐证', currency: 'HKD' };
    const hkCnyBasisId = await createStock(client, hkCnyBasis);
    const hkCnyBasisReport = await insertReport(client, {
      companyId: hkCnyBasisId, sourceId: lixinger, compType: '1',
      payload: {
        ts_code: hkCnyBasis.code, currency: 'CNY',
        __statement_coverage: { market: 'HK', value_basis: 'source_original_t_o', fs_table_type: 'non_financial' },
      },
    });
    await insertHkfrsWide(client, {
      reportId: hkCnyBasisReport, companyId: hkCnyBasisId, sourceId: lixinger,
      tca: 700000000, tcl: 100000000, currency: 'CNY',
    });

    // ===== 执行仓储：这一步就是「SQL 能被真实 PG 执行」的证明 =====
    const cnFacts = await repo.loadGrahamBalanceFacts({
      companyIds: [String(cnPlainId), String(cnBankId), String(cnGapId)],
      asOfDate: AS_OF, availableBefore: null, market: 'CN',
    });
    const hkFacts = await repo.loadGrahamBalanceFacts({
      companyIds: [String(hkHkdId), String(hkCnyNoBasisId), String(hkCnyBasisId)],
      asOfDate: AS_OF, availableBefore: null, market: 'HK',
    });

    // 1) A股同一 report_id 取数，币种取自宽表而不是原件的 USD 声明
    const cn = cnFacts.get(String(cnPlainId));
    assert.ok(cn, 'A股必须取到资产负债表事实');
    assert.strictEqual(Number(cn.reportId), Number(cnPlainReport), 'A股必须命中同一 report_id');
    assert.strictEqual(Number(cn.currentAssets), 10000000, 'A股流动资产必须来自 statement_balance_cas');
    assert.strictEqual(Number(cn.currentLiabilities), 4000000, 'A股流动负债必须来自 statement_balance_cas');
    assert.strictEqual(cn.currency, 'CNY', '币种以宽表为准，不能取原件的 USD 声明');
    assert.strictEqual(cn.currencyUnverified, false, 'tushare 来源不参与港股币种屏蔽');

    // 2) 银行按 comp_type=2 识别为金融企业，而不是「缺数据 PENDING」
    const bank = cnFacts.get(String(cnBankId));
    assert.strictEqual(bank.fsTableType, 'bank', 'comp_type=2 必须映射为 bank');
    const bankEval = GRAHAM.evaluateGrahamCandidate({
      market: 'CN', asOfDate: AS_OF, tsCode: cnBank.code,
      hasBalanceReport: true, reportId: bank.reportId,
      currentAssets: bank.currentAssets, currentLiabilities: bank.currentLiabilities,
      totalMarketCap: '1000000', balanceCurrency: bank.currency, valuationCurrency: 'CNY',
      fsTableType: bank.fsTableType,
    });
    assert.strictEqual(bankEval.status, STATUS.NOT_APPLICABLE, '金融企业必须判不适用');
    assert.strictEqual(bankEval.reason, 'financial_statement_no_current_classification');

    // 3) 一般商业缺科目保持缺失，判 PENDING 而不是伪造 0，也不是不适用
    const gap = cnFacts.get(String(cnGapId));
    assert.strictEqual(gap.currentAssets, null, '缺科目必须保留 null');
    assert.strictEqual(gap.currentLiabilities, null, '缺科目必须保留 null');
    assert.strictEqual(gap.fsTableType, null, '一般商业不能带金融类型');
    const gapEval = GRAHAM.evaluateGrahamCandidate({
      market: 'CN', asOfDate: AS_OF, tsCode: cnGap.code,
      hasBalanceReport: true, reportId: gap.reportId,
      currentAssets: gap.currentAssets, currentLiabilities: gap.currentLiabilities,
      totalMarketCap: '1000000', balanceCurrency: gap.currency, valuationCurrency: 'CNY',
      fsTableType: gap.fsTableType,
    });
    assert.strictEqual(gapEval.status, STATUS.PENDING, '缺科目必须判待补');
    assert.strictEqual(gapEval.reason, 'current_assets_or_liabilities_unavailable');

    // 4) 港股同一 report_id 取数
    const hk = hkFacts.get(String(hkHkdId));
    assert.ok(hk, '港股必须取到资产负债表事实');
    assert.strictEqual(Number(hk.reportId), Number(hkHkdReport), '港股必须命中同一 report_id');
    assert.strictEqual(Number(hk.currentAssets), 900000000, '港股流动资产必须来自 statement_balance_hkfrs');
    assert.strictEqual(hk.currency, 'HKD');
    assert.strictEqual(hk.currencyUnverified, false, '港元报表币种自证一致');

    // 5) 港股非港元报表：缺佐证屏蔽、有佐证放行
    const noBasis = hkFacts.get(String(hkCnyNoBasisId));
    assert.strictEqual(noBasis.currency, 'CNY');
    assert.strictEqual(noBasis.currencyUnverified, true, '缺原币佐证的非港元报表必须判币种不可信');

    const withBasis = hkFacts.get(String(hkCnyBasisId));
    assert.strictEqual(withBasis.currency, 'CNY');
    assert.strictEqual(withBasis.currencyUnverified, false, '有原件原币佐证必须放行');
    assert.strictEqual(withBasis.fsTableType, 'non_financial', '佐证里的报表类型必须被采用');

    // 6) 迁移 216 物化元数据列触发器与未回填回退路径一致性
    const metaRow = (await client.query(
      `SELECT payload_meta_synced, payload_ts_code, payload_market, payload_currency,
              payload_value_basis, payload_fs_table_type
         FROM fundamental.financial_reports WHERE report_id=$1`, [hkCnyBasisReport]
    )).rows[0];
    assert.strictEqual(metaRow.payload_meta_synced, true, 'INSERT 触发器必须自动同步 payload_meta_synced');
    assert.strictEqual(metaRow.payload_market, 'HK', '触发器必须提取 __statement_coverage.market');
    assert.strictEqual(metaRow.payload_currency, 'CNY', '触发器必须提取并大写 currency');
    assert.strictEqual(metaRow.payload_value_basis, 'source_original_t_o', '触发器必须提取 value_basis');
    assert.strictEqual(metaRow.payload_fs_table_type, 'non_financial', '触发器必须提取 fs_table_type');

    await client.query(
      `UPDATE fundamental.financial_reports SET payload_meta_synced=false, payload_ts_code=NULL,
              payload_market=NULL, payload_currency=NULL, payload_value_basis=NULL, payload_fs_table_type=NULL
        WHERE report_id = ANY($1::bigint[])`,
      [[cnPlainReport, cnBankReport, cnGapReport, hkHkdReport, hkCnyNoBasisReport, hkCnyBasisReport]]
    );
    const cnFallback = await repo.loadGrahamBalanceFacts({
      companyIds: [cnPlainId, cnBankId, cnGapId], asOfDate: AS_OF, market: 'CN',
    });
    const hkFallback = await repo.loadGrahamBalanceFacts({
      companyIds: [hkHkdId, hkCnyNoBasisId, hkCnyBasisId], asOfDate: AS_OF, market: 'HK',
    });
    assert.deepStrictEqual(cnFallback, cnFacts, 'CN 同步态与未回填回退态取数结果必须完全一致');
    assert.deepStrictEqual(hkFallback, hkFacts, 'HK 同步态与未回填回退态取数结果必须完全一致');

    // 7) 两个方案码都必须被服务登记（双方案切换的入口前提）
    const service = require('../services/stockSelectionService');
    assert.ok(service.STRATEGY_CODES.includes('graham_net_net_v1'), '格雷厄姆方案必须登记');
    assert.ok(service.STRATEGY_CODES.includes(service.DEFAULT_STRATEGY_CODE), '投资要义方案必须登记');

    console.log('格雷厄姆选股真实 PostgreSQL 取数管线：双市场同报告取数、币种以宽表为准、'
      + '金融企业按 comp_type 判不适用、缺科目保留缺失、港股币种佐证分级及 216 物化列触发器/回退一致性通过');
  } finally {
    pool.query = original;
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
})().catch(async error => {
  console.error(error);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
