// 估值取数缺口的可查询质量证据（验收 V-01，复验 RV-01 修正）。
// 2026-11-02 分层整改：SQL 统一归到数据访问层（原在 server/services/valuationFetchQuality.js，
// 触发 SQL_IN_NON_DATA_LAYER 与数据层反向依赖）。services 下同名文件只做转发，行为不变。
//
// 背景：官方估值按「单证券 × 日期段」请求，某一段失败时数据层仍能用其它段+备源拼出结果，
// 只打一条 warn 的话没人能事后查"哪只证券、哪个区间、什么时候没取到、是否已恢复"。
// 这里把缺口写进既有的 `ops.data_quality_issues`（不新建进度表）。
//
// 复验 RV-01 的核心修正：缺口身份与恢复判据都必须带「证券 + 区间」两个维度。
// 之前按「读取请求」记一条（history 只看证券、series 只看日期+数量），恢复时也按同一把粗键整片关闭，
// 结果"只补了一个月"或"换成另一只股票成功"都能把长期的 open 记录标成 resolved —— 假恢复。
// 现在改为按「失败单元」逐条记录，恢复只关闭被这次成功完整覆盖的单元：
//   - 序列类单元：(证券, 段起, 段止)；只有同一证券、且该段被本次成功区间包含时才关闭；
//   - 快照类单元：(交易日, 证券集合)；只有同一交易日、且单元里每只证券这次都成功时才关闭。
// 任一维度不满足就保持 open，续跑范围可直接从 details.unit 查出来。
//
// 写失败只记日志，不影响业务返回；正常读取路径只多一次走索引的 SELECT。
const crypto = require('crypto');
const { pool } = require('../db/connection');

const DATASET_CODE = 'stock_valuation';
const ISSUE_TYPE = 'partial_fetch';

function shortHash(text) {
  return crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 10);
}

function uniqueCodes(codes) {
  return [...new Set((codes || []).map(item => String(item || '').trim()).filter(Boolean))].sort();
}

// 单元键只用于"同一单元重复失败时更新同一条 open 记录"，不参与恢复判定。
function seriesFieldCode(tsCode, from, to) {
  return `series:${tsCode}|${from}~${to}`.slice(0, 200);
}

function snapshotFieldCode(tradeDate, codes) {
  return `snapshot:${tradeDate}|${codes.length}只#${shortHash(codes.join(','))}`.slice(0, 200);
}

/**
 * 把一次详细结果里的失败段拆成"失败单元"。
 * @param {'series'|'snapshot'} kind
 * @param {object} detail 适配层详细结果（含 failures 与 scope）
 * @returns {object[]} [{ fieldCode, unit, severity }]
 */
function unitsFromDetail(kind, detail) {
  const failures = (detail && detail.failures) || [];
  const units = [];
  for (const failure of failures) {
    if (kind === 'snapshot') {
      // 单元身份用站内代码（tsCodes），供应商代码只留在 failures 证据里。
      const codes = uniqueCodes(failure.tsCodes || failure.stockCodes);
      const tradeDate = String(failure.tradeDate || (detail.scope && detail.scope.tradeDate) || '');
      if (!tradeDate || !codes.length) continue;
      units.push({
        fieldCode: snapshotFieldCode(tradeDate, codes),
        unit: { kind: 'snapshot', tradeDate, codes },
      });
    } else {
      const tsCode = String(failure.tsCode || '');
      const from = String(failure.from || '');
      const to = String(failure.to || '');
      if (!tsCode || !from || !to) continue;
      units.push({
        fieldCode: seriesFieldCode(tsCode, from, to),
        unit: { kind: 'series', tsCode, from, to },
      });
    }
  }
  return units;
}

function severityFor(planned, notAttempted) {
  return notAttempted ? 'error' : (planned > 1 ? 'warning' : 'warning');
}

/**
 * 逐单元记录取数缺口（同一单元只保留一条 open 记录，重复失败只更新证据）。
 * @param {object} params
 *   kind: 'series' | 'snapshot'
 *   stage: 采集阶段标记（history/series_backfill/snapshot），仅作留证
 *   detail: 适配层详细结果
 */
async function recordGaps({ kind, stage, detail }, client = pool) {
  const units = unitsFromDetail(kind, detail);
  if (!units.length) return { recorded: 0 };
  let recorded = 0;
  for (const item of units) {
    const details = {
      scope: kind,
      stage: stage || null,
      unit: item.unit,
      planned: detail.planned,
      succeeded: detail.succeeded,
      failed: detail.failed,
      notAttempted: detail.notAttempted,
      emptyBatches: detail.emptyBatches,
      range: { startDate: (detail.scope && detail.scope.startDate) || null, endDate: (detail.scope && detail.scope.endDate) || null, tradeDate: (detail.scope && detail.scope.tradeDate) || null },
      // 该单元本身的失败诊断（只留本单元相关的，避免把别的证券的错误混进来）。
      failures: ((detail.failures || []).filter(failure => (kind === 'snapshot'
        ? String(failure.tradeDate || '') === item.unit.tradeDate
          && uniqueCodes(failure.tsCodes || failure.stockCodes).join(',') === item.unit.codes.join(',')
        : String(failure.tsCode || '') === item.unit.tsCode && String(failure.from || '') === item.unit.from && String(failure.to || '') === item.unit.to))).slice(0, 5),
      detectedAt: new Date().toISOString(),
    };
    try {
      const updated = await client.query(
        `UPDATE ops.data_quality_issues SET details=$3::jsonb, severity=$4, detected_at=now()
          WHERE dataset_code=$1 AND field_code=$2 AND issue_type=$5 AND status='open'`,
        [DATASET_CODE, item.fieldCode, JSON.stringify(details), severityFor(detail.planned, detail.notAttempted), ISSUE_TYPE],
      );
      if (updated.rowCount) { recorded += 1; continue; }
      await client.query(
        `INSERT INTO ops.data_quality_issues(instrument_id,dataset_code,field_code,issue_type,severity,status,details)
         VALUES(NULL,$1,$2,$3,$4,'open',$5::jsonb)
         ON CONFLICT (instrument_id,dataset_code,field_code,issue_type,status) DO UPDATE
           SET details=EXCLUDED.details, severity=EXCLUDED.severity, detected_at=now()`,
        [DATASET_CODE, item.fieldCode, ISSUE_TYPE, severityFor(detail.planned, detail.notAttempted), JSON.stringify(details)],
      );
      recorded += 1;
    } catch (error) {
      console.warn(`[valuation-quality] 取数缺口留证失败（不影响业务返回）：${String(error && error.message).slice(0, 160)}`);
    }
  }
  return { recorded };
}

// series 的覆盖是按证券给区间的：只有"这只证券、这一区间"这次真的成功，才算覆盖那个单元。
// 不能只按整体请求区间算——同一请求里另一段失败了，那只证券就没被完整覆盖。
function seriesUnitCovered(unit, coverage) {
  if (!unit || unit.kind !== 'series') return false;
  return (coverage || []).some(item => String(item.tsCode) === String(unit.tsCode)
    && String(unit.from) >= String(item.from) && String(unit.to) <= String(item.to));
}

function snapshotUnitCovered(unit, { tradeDate, securities }) {
  if (!unit || unit.kind !== 'snapshot') return false;
  if (String(unit.tradeDate) !== String(tradeDate)) return false;
  const codes = unit.codes || [];
  if (!codes.length) return false;
  // 单元里每只证券这次都必须成功（本批成功集合是按代码逐批确认的）。
  return codes.every(code => securities.has(String(code)));
}

/**
 * 只在"本次成功完整覆盖了原失败单元"时关闭缺口。
 * 短区间成功、其他证券成功、别的交易日成功都不构成恢复证据。
 * @param {object} params
 *   kind: 'series' | 'snapshot'
 *   coverage: series 用，成功覆盖区间数组 [{tsCode, from, to}]
 *   securities: snapshot 用，本次成功批次覆盖的证券列表
 *   tradeDate: snapshot 用，本次成功读取的交易日
 *   stage：留证用
 */
async function resolveGaps({ kind, coverage, securities, tradeDate, stage }, client = pool) {
  const covered = new Set(uniqueCodes(securities));
  const coveredRanges = (coverage || []).filter(item => item && item.tsCode && item.from && item.to);
  if (kind === 'series' ? !coveredRanges.length : !covered.size) return { resolved: 0 };
  let rows;
  try {
    // 走索引取仍 open 的缺口（正常路径没有 open 记录时只有这一次轻量查询）。
    const result = await client.query(
      `SELECT issue_id, field_code, details FROM ops.data_quality_issues
        WHERE dataset_code=$1 AND issue_type=$2 AND status='open'`,
      [DATASET_CODE, ISSUE_TYPE],
    );
    rows = result.rows;
  } catch (error) {
    console.warn(`[valuation-quality] 缺口恢复留证失败：${String(error && error.message).slice(0, 160)}`);
    return { resolved: 0 };
  }
  if (!rows.length) return { resolved: 0 };
  const matched = [];
  for (const row of rows) {
    const details = row.details || {};
    const unit = details.unit || null;
    const ok = kind === 'snapshot'
      ? snapshotUnitCovered(unit, { tradeDate, securities: covered })
      : seriesUnitCovered(unit, coveredRanges);
    if (ok) matched.push(row.issue_id);
  }
  if (!matched.length) return { resolved: 0, kept: rows.length };
  try {
    const evidence = JSON.stringify({
      resolvedBy: {
        kind, stage: stage || null, tradeDate: tradeDate || null,
        coverage: kind === 'series' ? coveredRanges.slice(0, 50) : null,
        securities: kind === 'snapshot' ? [...covered].slice(0, 50) : null,
      },
      resolvedAt: new Date().toISOString(),
    });
    const result = await client.query(
      `UPDATE ops.data_quality_issues SET status='resolved', resolved_at=now(), details = details || $2::jsonb
        WHERE issue_id = ANY($1::bigint[]) AND status='open'`,
      [matched, evidence],
    );
    return { resolved: result.rowCount, kept: rows.length - matched.length };
  } catch (error) {
    console.warn(`[valuation-quality] 缺口恢复留证失败：${String(error && error.message).slice(0, 160)}`);
    return { resolved: 0 };
  }
}

// 可查询：当前仍 open 的估值取数缺口（后台/脚本/测试用，不暴露给页面业务判断）。
// details.unit 就是续跑范围（哪只证券的哪一段 / 哪个交易日的哪批代码）。
async function listOpenGaps(client = pool) {
  const { rows } = await client.query(
    `SELECT issue_id, field_code, severity, status, details, detected_at
       FROM ops.data_quality_issues
      WHERE dataset_code=$1 AND issue_type=$2 AND status='open'
      ORDER BY detected_at DESC`,
    [DATASET_CODE, ISSUE_TYPE],
  );
  return rows;
}

module.exports = {
  DATASET_CODE, ISSUE_TYPE,
  recordGaps, resolveGaps, listOpenGaps,
  unitsFromDetail, seriesUnitCovered, snapshotUnitCovered,
};
