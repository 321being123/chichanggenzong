// 统一的「数据组水位」读写：ops.sync_cursors + ops.data_quality_issues。
// 只封装访问方式，不新建表、不建立第二套数据链路。
// ops.sync_cursors 的唯一键是 (scope_key, dataset_code)，不含 instrument_id，
// 因此单只证券的水位必须把证券编进 scope_key（见 datasetScope）。

const { pool } = require('../db/connection');

// 单只证券的数据组 TTL（分钟）。TTL 只用于抑制重复请求，
// 不代表 TTL 内数据必然正确：数据库已发现变化时调用方仍须刷新。
const DATASET_TTL_MINUTES = {
  // 可转债
  cb_basic: 15,
  conversion_price_announcements: 30,
  cb_rating: 24 * 60,
  cb_rate: 24 * 60,
  top10_cb_holders: 24 * 60,
  bond_dividend: 12 * 60,
  // 股票
  stock_basic: 7 * 24 * 60,
  stock_dividend: 12 * 60,
  stock_forecast: 12 * 60,
  stock_industry: 7 * 24 * 60,
  stock_controller: 7 * 24 * 60,
};

// scope_key 约定：'stock:600519.SH' / 'convertible_bond:113050.SH'
function datasetScope(kind, key) {
  if (!kind || !key) return null;
  return `${kind}:${key}`;
}

// 一次取回该证券的多个数据组水位，避免逐组往返
async function getDatasetCursors(scopeKey, datasetCodes, client = pool) {
  const codes = Array.isArray(datasetCodes) ? datasetCodes.filter(Boolean) : [];
  const map = new Map();
  if (!scopeKey || !codes.length) return map;
  try {
    const { rows } = await client.query(
      `SELECT dataset_code,last_success_date,last_source_update,last_attempt_at,last_error,retry_count
         FROM ops.sync_cursors WHERE scope_key=$1 AND dataset_code = ANY($2::text[])`,
      [scopeKey, codes]
    );
    for (const row of rows) map.set(row.dataset_code, row);
  } catch (_) {
    // 水位不可读时按「无水位」处理：调用方会照常拉取，不阻断分析
  }
  return map;
}

async function getDatasetCursor(scopeKey, datasetCode, client = pool) {
  const map = await getDatasetCursors(scopeKey, [datasetCode], client);
  return map.get(datasetCode) || null;
}

// TTL 内且上次成功过 → 视为新鲜，可跳过本次上游请求
function isDatasetFresh(cursor, datasetCode, options = {}) {
  if (options.force) return false;
  if (!cursor) return false;
  if (cursor.last_error) return false;
  const ttl = Number(options.ttlMinutes != null ? options.ttlMinutes : DATASET_TTL_MINUTES[datasetCode]);
  if (!Number.isFinite(ttl) || ttl <= 0) return false;
  const stamp = cursor.last_source_update || cursor.last_attempt_at;
  if (!stamp) return false;
  const at = new Date(stamp).getTime();
  if (!Number.isFinite(at)) return false;
  const now = options.now ? new Date(options.now).getTime() : Date.now();
  return now - at < ttl * 60 * 1000;
}

async function markDatasetSuccess(scopeKey, datasetCode, options = {}) {
  if (!scopeKey || !datasetCode) return;
  const client = options.client || pool;
  const lastSuccessDate = options.lastSuccessDate || null;
  try {
    await client.query(
      `INSERT INTO ops.sync_cursors(instrument_id,company_id,scope_key,dataset_code,last_success_date,last_source_update,last_attempt_at,last_error,retry_count,updated_at)
       VALUES($1,$2,$3,$4,$5,now(),now(),'',0,now())
       ON CONFLICT(scope_key,dataset_code) DO UPDATE SET
         instrument_id=COALESCE(EXCLUDED.instrument_id,sync_cursors.instrument_id),
         company_id=COALESCE(EXCLUDED.company_id,sync_cursors.company_id),
         last_success_date=COALESCE(GREATEST(sync_cursors.last_success_date,EXCLUDED.last_success_date),sync_cursors.last_success_date),
         last_source_update=now(),last_attempt_at=now(),last_error='',retry_count=0,updated_at=now()`,
      [options.instrumentId || null, options.companyId || null, scopeKey, datasetCode, lastSuccessDate]
    );
  } catch (_) {
    // 水位写入失败不得影响主流程
  }
}

// 失败只记录原因，不推进 last_success_date，供下次续跑与排查
async function markDatasetFailure(scopeKey, datasetCode, reason, options = {}) {
  if (!scopeKey || !datasetCode) return;
  const client = options.client || pool;
  const text = String(reason || '').slice(0, 500);
  try {
    await client.query(
      `INSERT INTO ops.sync_cursors(instrument_id,company_id,scope_key,dataset_code,last_success_date,last_source_update,last_attempt_at,last_error,retry_count,updated_at)
       VALUES($1,$2,$3,$4,NULL,now(),now(),$5,1,now())
       ON CONFLICT(scope_key,dataset_code) DO UPDATE SET
         last_attempt_at=now(),last_error=EXCLUDED.last_error,retry_count=sync_cursors.retry_count+1,updated_at=now()`,
      [options.instrumentId || null, options.companyId || null, scopeKey, datasetCode, text]
    );
  } catch (_) {
    // 同上
  }
}

// 记录数据质量问题。UNIQUE(instrument_id,dataset_code,field_code,issue_type,status)
// 在 instrument_id 为 NULL 时不生效，故缺少 instrument_id 时直接跳过，避免重复堆积。
async function recordQualityIssue(issue = {}, options = {}) {
  const client = options.client || pool;
  if (!issue.instrumentId || !issue.datasetCode || !issue.issueType) return;
  try {
    await client.query(
      `INSERT INTO ops.data_quality_issues(instrument_id,company_id,dataset_code,field_code,issue_type,severity,details)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)
       ON CONFLICT(instrument_id,dataset_code,field_code,issue_type,status)
       DO UPDATE SET details=EXCLUDED.details,severity=EXCLUDED.severity,detected_at=now(),resolved_at=NULL`,
      [issue.instrumentId, issue.companyId || null, issue.datasetCode, issue.fieldCode || '',
        issue.issueType, issue.severity || 'warning', JSON.stringify(issue.details || {})]
    );
  } catch (_) {
    // 质量记录失败不得影响主流程
  }
}

// 问题恢复：保留发现时间，补写恢复时间，供追溯
async function resolveQualityIssue(issue = {}, options = {}) {
  const client = options.client || pool;
  if (!issue.instrumentId || !issue.datasetCode || !issue.issueType) return;
  try {
    await client.query(
      `UPDATE ops.data_quality_issues SET status='resolved',resolved_at=now()
        WHERE instrument_id=$1 AND dataset_code=$2 AND field_code=$3 AND issue_type=$4 AND status='open'`,
      [issue.instrumentId, issue.datasetCode, issue.fieldCode || '', issue.issueType]
    );
  } catch (_) {
    // 同上
  }
}

module.exports = {
  DATASET_TTL_MINUTES,
  datasetScope,
  getDatasetCursor,
  getDatasetCursors,
  isDatasetFresh,
  markDatasetSuccess,
  markDatasetFailure,
  recordQualityIssue,
  resolveQualityIssue,
};
