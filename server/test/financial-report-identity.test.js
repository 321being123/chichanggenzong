'use strict';

// 2026-11-26 事故回归：财报版本键必须是业务身份，不能是整条 payload 的哈希。
// 原实现下同一份财报每次重采都会因为字段个数/覆盖标记变化而算出新版本、插入新行，
// 一天灌进 107.9 万行重复副本，把全市场选股拖到 8 分钟以上并触发 30 分钟任务超时。
const assert = require('assert');
const { pool } = require('../db/connection');
const projRepo = require('../repositories/stockProjectionRepository');

const { normalizeUpdateFlag, reportIdentityVersion } = projRepo;
const { shouldPersistRawDataset } = require('../services/financialDataArchitecture');

async function run() {
  // --- 0) 转换报文留证：只有已具备上游真实应答留证的行才停写（INC-0054 第一阶段第 4 条）---
  const audited = {
    source_code: 'lixinger_official',
    __statement_coverage: { audit: { source: 'lixinger_official', request_digest: 'x' } },
  };
  for (const dataset of ['income', 'balance', 'cashflow', 'indicators']) {
    assert.strictEqual(shouldPersistRawDataset(dataset, audited), false,
      `${dataset}：理杏仁行已有真实应答与审计指纹，不得再整包落一份转换报文`);
    assert.strictEqual(shouldPersistRawDataset(dataset, { source_code: 'tushare' }), true,
      `${dataset}：备源没有上游应答留证，停写等于丢证据`);
    assert.strictEqual(shouldPersistRawDataset(dataset, { source_code: 'lixinger_official' }), true,
      `${dataset}：来源是理杏仁但缺审计指纹时仍要留证（无法回溯到原文批次）`);
  }
  for (const dataset of ['dividends', 'forecasts', 'daily', 'basics', 'factors']) {
    assert.strictEqual(shouldPersistRawDataset(dataset, audited), true, `${dataset} 仍按原样留证，不能顺带停写`);
  }

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
      __statement_coverage: {
        complete: true, comparison_requested: true, comparison_complete: true,
        requested_batch_count: 1, returned_batch_count: 1, returned_metric_codes: ['bs.ta'],
      },
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

    // --- 4) 内容完全一致的重复采集不得重写任何一行（INC-0054 第一阶段）---
    // 原来每次重采都无条件 upsert + ingested_at=now()，行数不变也会不断产生新行版本、
    // 重写整条 raw_payload 与 TOAST。这里用 ctid 判断「有没有被重写」。
    const ctidOf = async (sql, params) => (await client.query(sql, params)).rows[0].ctid;
    const beforeReportCtid = await ctidOf(
      'SELECT ctid::text AS ctid FROM fundamental.financial_reports WHERE report_id=$1', [rows[0].report_id]);
    const beforeWideCtid = await ctidOf(
      'SELECT ctid::text AS ctid FROM fundamental.statement_balance_cas WHERE report_id=$1', [rows[0].report_id]);
    const beforeFactCtid = await ctidOf(
      "SELECT ctid::text AS ctid FROM fundamental.financial_facts WHERE report_id=$1 AND metric_code='total_assets'",
      [rows[0].report_id]);
    const replay = { ...full, total_assets: 130, __statement_metrics: { 'bs.ta': 130 } };
    await projRepo.syncReportRows(client, [replay], 'balance', master.companyId, sourceId, { tsCode: '600988.SH', currency: 'CNY' });
    assert.strictEqual(await ctidOf('SELECT ctid::text AS ctid FROM fundamental.financial_reports WHERE report_id=$1',
      [rows[0].report_id]), beforeReportCtid, '内容一致的重采不得重写报告行（否则行数与磁盘都会继续长）');
    assert.strictEqual(await ctidOf('SELECT ctid::text AS ctid FROM fundamental.statement_balance_cas WHERE report_id=$1',
      [rows[0].report_id]), beforeWideCtid, '内容一致的重采不得重写宽表行');
    assert.strictEqual(await ctidOf(
      "SELECT ctid::text AS ctid FROM fundamental.financial_facts WHERE report_id=$1 AND metric_code='total_assets'",
      [rows[0].report_id]), beforeFactCtid, '内容一致的重采不得重写财务事实行');

    // 真的换了值仍必须写进去（守卫不能把有效更新一起挡掉）
    await projRepo.syncReportRows(client, [{ ...replay, total_assets: 140, __statement_metrics: { 'bs.ta': 140 } }],
      'balance', master.companyId, sourceId, { tsCode: '600988.SH', currency: 'CNY' });
    const updated = await client.query(
      'SELECT bs_ta FROM fundamental.statement_balance_cas WHERE report_id=$1', [rows[0].report_id]);
    assert.strictEqual(Number(updated.rows[0].bs_ta), 140, '值确实变化时仍必须更新宽表');

    // 真修订（不同公告日）必须另起一行，不能被合并掉
    await projRepo.syncReportRows(client, [{ ...full, ann_date: '20250415', f_ann_date: '20250415' }],
      'balance', master.companyId, sourceId, { tsCode: '600988.SH', currency: 'CNY' });
    const after = await client.query(
      `SELECT report_id FROM fundamental.financial_reports WHERE company_id=$1 AND report_kind='balance'`,
      [master.companyId]);
    assert.strictEqual(after.rows.length, 2, '不同公告日的真修订必须保留独立版本，去重不能吞掉修订史');

    // --- 5) 存量「三表全量比较值」必须收敛（INC-0054 第二阶段：合并规则从 SQL 搬到 JS）---
    const legacyWide = {
      ts_code: '600988.SH', end_date: '20241231', ann_date: '20250328', f_ann_date: '20250328',
      report_type: '1', comp_type: '1', currency: 'CNY', period_type: 'annual', update_flag: null,
      total_assets: 140,
      __statement_coverage: {
        complete: true, comparison_requested: true, comparison_complete: true,
        requested_batch_count: 1, returned_batch_count: 1, returned_metric_codes: ['bs.ta'],
      },
      __statement_metrics: { 'bs.ta': 140 },
      __statement_comparisons: { yoy: { 'bs.ta': 0.2 } },
    };
    // 模拟存量行：历史写入口径把三表全量比较值都塞进同一行
    await client.query(
      `UPDATE fundamental.financial_reports SET raw_payload=jsonb_set(raw_payload,'{__statement_comparisons}',$2::jsonb)
        WHERE report_id=$1`,
      [rows[0].report_id, JSON.stringify({ yoy: { 'bs.ta': 0.2, 'ps.toi': 0.9, 'cfs.ncffoa': 0.7 } })]);
    await projRepo.syncReportRows(client, [legacyWide], 'balance', master.companyId, sourceId, { tsCode: '600988.SH', currency: 'CNY' });
    const normalized = await client.query(
      "SELECT raw_payload->'__statement_comparisons' AS cmp FROM fundamental.financial_reports WHERE report_id=$1",
      [rows[0].report_id]);
    assert.deepStrictEqual(normalized.rows[0].cmp, { yoy: { 'bs.ta': 0.2 } },
      '存量行的三表全量比较值必须在下次采集时裁回本表口径，否则永远不收敛');
    const convergedCtid = await ctidOf(
      'SELECT ctid::text AS ctid FROM fundamental.financial_reports WHERE report_id=$1', [rows[0].report_id]);
    await projRepo.syncReportRows(client, [legacyWide], 'balance', master.companyId, sourceId, { tsCode: '600988.SH', currency: 'CNY' });
    assert.strictEqual(await ctidOf(
      'SELECT ctid::text AS ctid FROM fundamental.financial_reports WHERE report_id=$1', [rows[0].report_id]),
    convergedCtid, '归一之后再重放同一份输入必须真正跳过更新（存量行收敛）');

    // --- 6) 审计指纹是易变元数据，不得单独触发主表重写（INC-0054 第一阶段第 1 条）---
    // 原实现把 audit（含 range/request_digest/payload_digest/raw_record_ids）算进「有没有变化」：
    // endDate 推进一天、新季报发布或 7 天原文缓存过期都会让 10-12 年未变的历史行整行重写。
    const auditedRow = (audit, extra = {}) => ({
      ts_code: '600988.SH', source_code: 'lixinger_official',
      end_date: '20231231', ann_date: '20240328', f_ann_date: '20240328',
      report_type: '1', comp_type: '1', currency: 'CNY', period_type: 'annual', update_flag: null,
      total_assets: 500,
      __statement_coverage: {
        complete: true, comparison_requested: true, comparison_complete: true,
        requested_batch_count: 1, returned_batch_count: 1, returned_metric_codes: ['bs.ta'],
        audit: { source: 'lixinger_official', endpoint: 'cn/company/fs/non_financial', ...audit },
      },
      __statement_metrics: { 'bs.ta': 500 },
    });
    const firstAudit = {
      range: { start: '2014-01-01', end: '2023-12-31' },
      request_count: 2, request_digest: 'aaa', payload_digest: 'bbb',
      raw_record_ids: { count: 2, first: 11, last: 12 },
    };
    // auditedRow() 会把 source/endpoint 一并写进审计指纹，落库读回自然带这两个字段。
    const storedFirstAudit = { source: 'lixinger_official', endpoint: 'cn/company/fs/non_financial', ...firstAudit };
    await projRepo.syncReportRows(client, [auditedRow(firstAudit)], 'balance', master.companyId, sourceId,
      { tsCode: '600988.SH', currency: 'CNY' });
    const auditedReport = (await client.query(
      `SELECT report_id FROM fundamental.financial_reports
        WHERE company_id=$1 AND report_kind='balance' AND period_end='2023-12-31'`, [master.companyId])).rows[0];
    assert.ok(auditedReport, '首次写入必须落库');
    const auditedCtid = await ctidOf(
      'SELECT ctid::text AS ctid FROM fundamental.financial_reports WHERE report_id=$1', [auditedReport.report_id]);
    const storedAudit = (await client.query(
      "SELECT raw_payload->'__statement_coverage'->'audit' AS audit FROM fundamental.financial_reports WHERE report_id=$1",
      [auditedReport.report_id])).rows[0].audit;
    assert.deepStrictEqual(storedAudit, storedFirstAudit, '首次写入必须带上审计指纹');

    // 跨天 endDate 推进 + 新季报发布 + 原文缓存过期：只有 audit 变了，业务值不变
    const shiftedAudit = {
      range: { start: '2014-01-01', end: '2024-06-30' },
      request_count: 3, request_digest: 'ccc', payload_digest: 'ddd',
      raw_record_ids: { count: 3, first: 31, last: 33 },
    };
    await projRepo.syncReportRows(client, [auditedRow(shiftedAudit)], 'balance', master.companyId, sourceId,
      { tsCode: '600988.SH', currency: 'CNY' });
    assert.strictEqual(await ctidOf(
      'SELECT ctid::text AS ctid FROM fundamental.financial_reports WHERE report_id=$1', [auditedReport.report_id]),
    auditedCtid, '只有采集窗口/缓存/审计指纹变化时不得重写主表行（ctid 必须不变）');

    // 旧行还没有审计指纹时仍必须写一次，保证升级后的行都能回溯到原文批次
    await client.query(
      `UPDATE fundamental.financial_reports SET raw_payload=raw_payload #- '{__statement_coverage,audit}'
        WHERE report_id=$1`, [auditedReport.report_id]);
    await projRepo.syncReportRows(client, [auditedRow(firstAudit)], 'balance', master.companyId, sourceId,
      { tsCode: '600988.SH', currency: 'CNY' });
    const backfilled = await client.query(
      "SELECT raw_payload->'__statement_coverage'->'audit' AS audit FROM fundamental.financial_reports WHERE report_id=$1",
      [auditedReport.report_id]);
    assert.deepStrictEqual(backfilled.rows[0].audit, storedFirstAudit, '旧行缺审计指纹时必须补写一次');

    // 业务科目真的变了仍必须重写（守卫不能把有效更新一起挡掉）
    await projRepo.syncReportRows(client, [{ ...auditedRow(shiftedAudit), total_assets: 600, __statement_metrics: { 'bs.ta': 600 } }],
      'balance', master.companyId, sourceId, { tsCode: '600988.SH', currency: 'CNY' });
    assert.notStrictEqual(await ctidOf(
      'SELECT ctid::text AS ctid FROM fundamental.financial_reports WHERE report_id=$1', [auditedReport.report_id]),
    auditedCtid, '业务值变化时主表必须更新');

    // --- 7) 存量宽覆盖清单必须收敛到本表前缀（INC-0054 第一阶段第 2 条）---
    // 存量行带三表全量 returned_metric_codes；不先按本表前缀裁剪，droppedCoverageMetrics 恒为真，
    // 每次重采都把 ps.*/cfs.* 灌回来并强制保留旧字段，覆盖清单永远不收敛。
    const wideCoverageRow = () => ({
      ts_code: '600988.SH', end_date: '20221231', ann_date: '20230328', f_ann_date: '20230328',
      report_type: '1', comp_type: '1', currency: 'CNY', period_type: 'annual', update_flag: null,
      total_assets: 700,
      __statement_coverage: {
        complete: true, comparison_requested: true, comparison_complete: true,
        requested_batch_count: 1, returned_batch_count: 1,
        returned_metric_codes: ['bs.ta', 'ps.toi', 'cfs.ncffoa'],
      },
      __statement_metrics: { 'bs.ta': 700 },
    });
    await projRepo.syncReportRows(client, [wideCoverageRow()], 'balance', master.companyId, sourceId,
      { tsCode: '600988.SH', currency: 'CNY' });
    const wideReport = (await client.query(
      `SELECT report_id FROM fundamental.financial_reports
        WHERE company_id=$1 AND report_kind='balance' AND period_end='2022-12-31'`, [master.companyId])).rows[0];
    const narrowCoverageRow = {
      ...wideCoverageRow(),
      __statement_coverage: { ...wideCoverageRow().__statement_coverage, returned_metric_codes: ['bs.ta'] },
    };
    await projRepo.syncReportRows(client, [narrowCoverageRow], 'balance', master.companyId, sourceId,
      { tsCode: '600988.SH', currency: 'CNY' });
    const convergedCodes = (await client.query(
      "SELECT raw_payload->'__statement_coverage'->'returned_metric_codes' AS codes FROM fundamental.financial_reports WHERE report_id=$1",
      [wideReport.report_id])).rows[0].codes;
    assert.deepStrictEqual(convergedCodes, ['bs.ta'],
      '存量宽覆盖清单重采后必须收敛到本表前缀（不得把 ps.*/cfs.* 留回来）');
    const narrowCtid = await ctidOf(
      'SELECT ctid::text AS ctid FROM fundamental.financial_reports WHERE report_id=$1', [wideReport.report_id]);
    await projRepo.syncReportRows(client, [narrowCoverageRow], 'balance', master.companyId, sourceId,
      { tsCode: '600988.SH', currency: 'CNY' });
    assert.strictEqual(await ctidOf(
      'SELECT ctid::text AS ctid FROM fundamental.financial_reports WHERE report_id=$1', [wideReport.report_id]),
    narrowCtid, '覆盖清单收敛之后再重采必须真正跳过更新');

    // --- 8) 带 runId 的第二条留证路径同样只给「没有上游原文」的行留证（第 4 条）---
    const auditedRunId = await projRepo.createIngestionRun({ sourceId, datasetCode: 'stock_financial_balance' }, client);
    await projRepo.syncReportRows(client, [{
      ...auditedRow(firstAudit), end_date: '20211231', ann_date: '20220328', f_ann_date: '20220328',
    }], 'balance', master.companyId, sourceId, { tsCode: '600988.SH', currency: 'CNY', runId: auditedRunId });
    assert.strictEqual((await client.query('SELECT count(*)::int AS n FROM ops.raw_records WHERE run_id=$1', [auditedRunId])).rows[0].n, 0,
      '理杏仁带审计指纹的财报行不得再写一份转换报文');

    const backupRunId = await projRepo.createIngestionRun({ sourceId, datasetCode: 'stock_financial_balance' }, client);
    const backupRow = {
      ...auditedRow(firstAudit), end_date: '20201231', ann_date: '20210328', f_ann_date: '20210328',
      source_code: 'tushare',
    };
    delete backupRow.__statement_coverage.audit;
    await projRepo.syncReportRows(client, [backupRow], 'balance', master.companyId, sourceId,
      { tsCode: '600988.SH', currency: 'CNY', runId: backupRunId });
    const backupRaw = await client.query(
      'SELECT payload, raw_record_id FROM ops.raw_records WHERE run_id=$1', [backupRunId]);
    assert.strictEqual(backupRaw.rowCount, 1, '备源（无上游原文留证）必须保留原始留证，不得静默丢失');
    assert.strictEqual(backupRaw.rows[0].payload.__statement_metrics['bs.ta'], 500,
      '备源留证必须保留科目明细（这条路径原本就承担来源审计）');

    // --- 9) 停止刷新 ingested_at 后，同日更正版本仍按 update_flag 优先（F-09）---
    // 同一公告日同时存在原报（update_flag='0'）与更正报（update_flag='1'）时，
    // 原报即使因字段补全/审计补写而刷新了 ingested_at，也不得反超更正报成为当前版本。
    const flagRow = (flag, value) => ({
      ts_code: '600988.SH', end_date: '20181231', ann_date: '20190420', f_ann_date: '20190420',
      report_type: '1', comp_type: '1', currency: 'CNY', period_type: 'annual', update_flag: flag,
      total_assets: value,
      __statement_coverage: {
        complete: true, comparison_requested: false, comparison_complete: false,
        requested_batch_count: 1, returned_batch_count: 1, returned_metric_codes: ['bs.ta'],
      },
      __statement_metrics: { 'bs.ta': value },
    });
    await projRepo.syncReportRows(client, [flagRow('0', 800)], 'balance', master.companyId, sourceId,
      { tsCode: '600988.SH', currency: 'CNY' });
    await projRepo.syncReportRows(client, [flagRow('1', 900)], 'balance', master.companyId, sourceId,
      { tsCode: '600988.SH', currency: 'CNY' });
    const flagRows = await client.query(
      `SELECT report_id, update_flag FROM fundamental.financial_reports
        WHERE company_id=$1 AND report_kind='balance' AND period_end='2018-12-31' ORDER BY update_flag`,
      [master.companyId]);
    assert.strictEqual(flagRows.rowCount, 2, '同日原报与更正报身份不同，必须各自留行');
    const originalId = flagRows.rows.find(row => row.update_flag === '0').report_id;
    const correctionId = flagRows.rows.find(row => row.update_flag === '1').report_id;
    // 模拟原报后来因字段补全/审计补写刷新了 ingested_at，比更正报更新。
    await client.query(
      `UPDATE fundamental.financial_reports SET ingested_at = now() + interval '1 hour' WHERE report_id=$1`,
      [originalId]);
    // 内容一致的重采只触发 current 标记重算，不应重写原报；若排序只看 ingested_at，
    // 原报就会在这里反超更正报。
    await projRepo.syncReportRows(client, [flagRow('0', 800)], 'balance', master.companyId, sourceId,
      { tsCode: '600988.SH', currency: 'CNY' });
    const currentFlags = await client.query(
      `SELECT report_id, update_flag, is_current_version FROM fundamental.financial_reports
        WHERE company_id=$1 AND report_kind='balance' AND period_end='2018-12-31'`,
      [master.companyId]);
    const currentRow = currentFlags.rows.find(row => row.is_current_version);
    assert.ok(currentRow, '同日版本必须有一个 current');
    assert.strictEqual(String(currentRow.report_id), String(correctionId),
      'F-09: 同日更正报（update_flag=1）必须优先于后刷新 ingested_at 的原报');
    assert.strictEqual(
      currentFlags.rows.find(row => String(row.report_id) === String(originalId)).is_current_version,
      false,
      'F-09: 原报不得因 ingested_at 更新而成为当前版本');

    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
  console.log('财报版本键（业务身份）与重复写入不变量验证通过');
}

run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => pool.end());
