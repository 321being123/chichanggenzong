// 估值取数缺口的可查询质量证据（验收 V-01）。
//
// 背景：官方估值按「单证券 × 日期段」请求，某一段失败时数据层仍能用其它段+备源拼出结果，
// 只打一条 warn 的话没人能事后查"哪只证券、哪个区间、什么时候没取到、是否已恢复"。
// 这里把缺口写进既有的 `ops.data_quality_issues`（不新建进度表）：
//   - 同一作用域只保留一条 open 记录（先 UPDATE 命中则更新证据，否则 INSERT），避免每次读取都插一条；
//   - 同一作用域后续完整成功时把 open 记录置 resolved（恢复证据，而不是手工清空）；
//   - 只在 failures 非空时写，正常读取路径零额外开销；写失败只记日志，不影响业务返回。
const { pool } = require('../db/connection');

const DATASET_CODE = 'stock_valuation';
const ISSUE_TYPE = 'partial_fetch';

function scopeField(scope, key) {
  return `${scope}:${key}`.slice(0, 200);
}

/**
 * 记录一次取数缺口。
 * @param {object} params
 *   scope: 'series' | 'snapshot' | 'history'
 *   key: 作用域键（证券代码 / 交易日 / 证券+区间），用于去重与恢复匹配
 *   planned/succeeded/failed/notAttempted、failures、startDate/endDate、targetDate
 */
async function recordGap({ scope, key, planned, succeeded, failed, notAttempted, failures, startDate, endDate, targetDate }, client = pool) {
  const details = {
    scope, key,
    planned, succeeded, failed, notAttempted,
    startDate: startDate || null, endDate: endDate || null, targetDate: targetDate || null,
    failures: (failures || []).slice(0, 50),
    detectedAt: new Date().toISOString(),
  };
  const fieldCode = scopeField(scope, key || '');
  try {
    const updated = await client.query(
      `UPDATE ops.data_quality_issues SET details=$3::jsonb, severity=$4, detected_at=now()
        WHERE dataset_code=$1 AND field_code=$2 AND issue_type=$5 AND status='open'`,
      [DATASET_CODE, fieldCode, JSON.stringify(details), notAttempted || failed ? 'error' : 'warning', ISSUE_TYPE],
    );
    if (updated.rowCount) return { recorded: 'updated' };
    await client.query(
      `INSERT INTO ops.data_quality_issues(instrument_id,dataset_code,field_code,issue_type,severity,status,details)
       VALUES(NULL,$1,$2,$3,$4,'open',$5::jsonb)
       ON CONFLICT (instrument_id,dataset_code,field_code,issue_type,status) DO UPDATE
         SET details=EXCLUDED.details, severity=EXCLUDED.severity, detected_at=now()`,
      [DATASET_CODE, fieldCode, ISSUE_TYPE, notAttempted || failed ? 'error' : 'warning', JSON.stringify(details)],
    );
    return { recorded: 'inserted' };
  } catch (error) {
    console.warn(`[valuation-quality] 取数缺口留证失败（不影响业务返回）：${String(error && error.message).slice(0, 160)}`);
    return { recorded: null };
  }
}

/**
 * 同一作用域完整成功时关闭之前记录的缺口（恢复证据）。
 * 只关闭本作用域的 open 记录，不做批量清零。
 */
async function clearGap({ scope, key }, client = pool) {
  const fieldCode = scopeField(scope, key || '');
  try {
    // 先做一次走索引的存在性查询：正常读取路径不该每次都为"关闭缺口"付一次写事务。
    const present = await client.query(
      `SELECT 1 FROM ops.data_quality_issues
        WHERE dataset_code=$1 AND field_code=$2 AND issue_type=$3 AND status='open' LIMIT 1`,
      [DATASET_CODE, fieldCode, ISSUE_TYPE],
    );
    if (!present.rowCount) return { resolved: 0 };
    const result = await client.query(
      `UPDATE ops.data_quality_issues SET status='resolved', resolved_at=now()
        WHERE dataset_code=$1 AND field_code=$2 AND issue_type=$3 AND status='open'`,
      [DATASET_CODE, fieldCode, ISSUE_TYPE],
    );
    return { resolved: result.rowCount };
  } catch (error) {
    console.warn(`[valuation-quality] 缺口恢复留证失败：${String(error && error.message).slice(0, 160)}`);
    return { resolved: 0 };
  }
}

// 可查询：当前仍 open 的估值取数缺口（后台/脚本/测试用，不暴露给页面业务判断）。
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

module.exports = { DATASET_CODE, ISSUE_TYPE, recordGap, clearGap, listOpenGaps };
