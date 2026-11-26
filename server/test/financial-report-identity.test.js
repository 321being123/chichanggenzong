'use strict';

// 2026-11-26 事故回归：财报版本键必须是业务身份，不能是整条 payload 的哈希。
// 原实现下同一份财报每次重采都会因为字段个数/覆盖标记变化而算出新版本、插入新行，
// 一天灌进 107.9 万行重复副本，把全市场选股拖到 8 分钟以上并触发 30 分钟任务超时。
const assert = require('assert');
const { pool } = require('../db/connection');
const projRepo = require('../repositories/stockProjectionRepository');

const { normalizeUpdateFlag, reportIdentityVersion } = projRepo;

async function run() {
  // --- 1) update_flag 归一：空值、null、'0' 是同一件事 ---
  assert.strictEqual(normalizeUpdateFlag(''), '0', '空 update_flag 必须归一为 0');
  assert.strictEqual(normalizeUpdateFlag(null), '0', 'null update_flag 必须归一为 0');
  assert.strictEqual(normalizeUpdateFlag(undefined), '0', 'undefined update_flag 必须归一为 0');
  assert.strictEqual(normalizeUpdateFlag('   '), '0', '纯空白 update_flag 必须归一为 0');
  assert.strictEqual(normalizeUpdateFlag('1'), '1', '更正标记 1 必须保留');
  assert.strictEqual(normalizeUpdateFlag(0), '0', '数字 0 必须归一为字符串 0');

  // --- 2) 身份键：内容不同不影响版本，身份不同必须区分 ---
  const identity = {
    companyId: 9219, kind: 'balance', periodEnd: '2017-06-30', sourceId: 30,
    tsCode: '600999.SH', reportType: '1', compType: '1', updateFlag: '',
    announcedAt: '2017-09-04', fAnnDate: '2017-09-04', currency: 'CNY', scope: 'consolidated',
  };
  const base = reportIdentityVersion(identity);
  assert.strictEqual(base.length, 64, '版本键必须是 sha256 hex');

  assert.strictEqual(reportIdentityVersion({ ...identity, updateFlag: '0' }), base,
    'update_flag 空与 0 必须算同一个版本（事故主因之一）');
  assert.strictEqual(reportIdentityVersion({ ...identity, updateFlag: null }), base,
    'update_flag null 与空必须算同一个版本');

  for (const [label, patch] of [
    ['更正标记', { updateFlag: '1' }],
    ['公告日', { announcedAt: '2017-10-01' }],
    ['实际公告日', { fAnnDate: '2017-10-01' }],
    ['币种', { currency: 'HKD' }],
    ['报告类型', { reportType: '2' }],
    ['合并口径', { scope: 'parent' }],
    ['来源', { sourceId: 31 }],
    ['公司', { companyId: 9220 }],
    ['报告期', { periodEnd: '2017-12-31' }],
    ['报表种类', { kind: 'income' }],
    ['证券代码', { tsCode: '000001.SZ' }],
  ]) {
    assert.notStrictEqual(reportIdentityVersion({ ...identity, ...patch }), base,
      `${label}不同必须算不同版本，否则真修订会被覆盖`);
  }

  // --- 3) 真实写入：同一份报告的不同采集形态只能落一行 ---
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sources = await projRepo.sourceIds(client);
    const sourceId = sources.lixinger_official || sources.tushare;
    const master = await projRepo.ensureMaster(client, '600988.SH', sources, {
      ts_code: '600988.SH', name: '测试财报去重', market: 'CN', list_date: '20040818',
    });
    const slim = {
      ts_code: '600988.SH', end_date: '20241231', ann_date: '20250328', f_ann_date: '20250328',
      report_type: '1', comp_type: '1', currency: 'CNY', period_type: 'annual', update_flag: null,
      total_assets: 100, net_profit_parent: 10,
    };
    const full = {
      ...slim, update_flag: '0', total_assets: 120, net_profit_parent: 12,
      __statement_coverage: { complete: true, requested_batch_count: 1, returned_batch_count: 1, returned_metric_codes: ['bs.ta'] },
      __statement_metrics: { 'bs.ta': 120 },
      __statement_comparisons: { yoy: { 'bs.ta': 0.2 } },
    };
    await projRepo.syncReportRows(client, [slim], 'balance', master.companyId, sourceId, { tsCode: '600988.SH', currency: 'CNY' });
    await projRepo.syncReportRows(client, [full], 'balance', master.companyId, sourceId, { tsCode: '600988.SH', currency: 'CNY' });
    await projRepo.syncReportRows(client, [{ ...full, total_assets: 130, __statement_metrics: { 'bs.ta': 130 } }],
      'balance', master.companyId, sourceId, { tsCode: '600988.SH', currency: 'CNY' });

    const { rows } = await client.query(
      `SELECT report_id, update_flag, source_version, period_type
         FROM fundamental.financial_reports
        WHERE company_id=$1 AND report_kind='balance'`, [master.companyId]);
    assert.strictEqual(rows.length, 1,
      '同一份财报被反复采集（形态从极简到完整）必须只保留一行，否则表会被重复副本灌爆');
    assert.strictEqual(rows[0].update_flag, '0', '落库的 update_flag 必须归一为 0');
    assert.strictEqual(rows[0].source_version, reportIdentityVersion({
      companyId: master.companyId, kind: 'balance', periodEnd: '2024-12-31', sourceId,
      tsCode: '600988.SH', reportType: '1', compType: '1', updateFlag: '0',
      announcedAt: '2025-03-28', fAnnDate: '2025-03-28', currency: 'CNY', scope: 'consolidated',
    }), '落库版本键必须等于按业务身份算出的键，否则下次重采又会插新行');

    const wide = await client.query(
      'SELECT bs_ta FROM fundamental.statement_balance_cas WHERE report_id=$1', [rows[0].report_id]);
    assert.strictEqual(wide.rowCount, 1, '科目宽表必须与报告同 id 落库');
    assert.strictEqual(Number(wide.rows[0].bs_ta), 130, '宽表科目必须随最后一次采集更新');

    const facts = await client.query(
      "SELECT numeric_value FROM fundamental.financial_facts WHERE report_id=$1 AND metric_code='total_assets'",
      [rows[0].report_id]);
    assert.strictEqual(Number(facts.rows[0].numeric_value), 130, '标准事实必须跟随最后一次采集更新');

    // 真修订（不同公告日）必须另起一行，不能被合并掉
    await projRepo.syncReportRows(client, [{ ...full, ann_date: '20250415', f_ann_date: '20250415' }],
      'balance', master.companyId, sourceId, { tsCode: '600988.SH', currency: 'CNY' });
    const after = await client.query(
      `SELECT report_id FROM fundamental.financial_reports WHERE company_id=$1 AND report_kind='balance'`,
      [master.companyId]);
    assert.strictEqual(after.rows.length, 2, '不同公告日的真修订必须保留独立版本，去重不能吞掉修订史');
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
  console.log('财报版本键（业务身份）与重复写入不变量验证通过');
}

run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => pool.end());
