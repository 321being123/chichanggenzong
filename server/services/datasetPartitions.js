const { pool } = require('../db/connection');

// 数据集发布成功后的告警恢复钩子：由 jobAlertMailer 在加载时注册，
// 数据层不反向依赖告警服务（依赖倒置，消除跨层引用）。
let _onDatasetPublished = null;
function setDatasetPublishedHook(fn) {
  _onDatasetPublished = typeof fn === 'function' ? fn : null;
}

function dateText(value) {
  const text = String(value || '').replace(/-/g, '').slice(0, 8);
  return /^\d{8}$/.test(text) ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}` : null;
}

// 共享分区按维度（这里用于收盘终盘的股票/转债/基金）原子合并覆盖结论。
// 不能用「先读旧分区再整体写回」：转债与基金并发发布时会互相覆盖，
// 转债先写 partial、基金拿着旧 complete 提交就把它冲掉。
// 这里先 INSERT ... DO NOTHING 占位，再用 UPDATE 在数据库端把 coverage_by_kind
// 与旧行合并；UPDATE 会等行锁并使用最新已提交版本，结论不会丢。
// coverage_kinds 由合并后的品种键派生（与旧数组取并集），quality_status 取最差品种。
async function publishCoveragePartition(datasetCode, scopeKey, options = {}, executor = pool.query.bind(pool)) {
  const partitionKey = dateText(options.partitionKey || options.dataAsOf);
  const dataAsOf = dateText(options.dataAsOf || partitionKey) || partitionKey;
  if (!datasetCode || !partitionKey) throw new Error(`数据集分区缺少有效日期：${datasetCode}`);
  const status = options.status || 'published';
  if (!['loading', 'published', 'partial_published', 'rejected', 'stale'].includes(status)) {
    throw new Error(`不支持的数据集分区状态：${status}`);
  }
  const stale = status === 'stale' || Boolean(options.isStale);
  const coverageKind = options.coverageKind ? String(options.coverageKind) : null;
  const coverage = options.coverage || null;
  const incomingByKind = coverageKind && coverage
    ? {
      [coverageKind]: {
        expected: Number(coverage.expected || 0),
        covered: Number(coverage.covered || 0),
        status: String(coverage.status || 'no_target'),
      },
    }
    : {};
  const incomingDiagnostics = options.diagnostics || {};
  const initialKinds = Object.keys(incomingByKind);
  const initialQuality = Object.values(incomingByKind).some(item => item.status === 'partial') ? 'failed' : 'passed';
  const initialDiagnostics = coverageKind
    ? { ...incomingDiagnostics, coverage_by_kind: incomingByKind, coverage_kinds: initialKinds, quality_status: initialQuality }
    : incomingDiagnostics;
  await executor(
    `INSERT INTO ops.dataset_partitions
       (dataset_code,scope_key,partition_key,status,data_as_of,published_at,is_stale,stale_reason,row_count,source_id,diagnostics)
     VALUES($1,$2,$3,$4,$5,CASE WHEN $4='published' THEN now() ELSE NULL END,$6,$7,$8,$9,$10::jsonb)
     ON CONFLICT(dataset_code,scope_key,partition_key) DO NOTHING`,
    [String(datasetCode), String(scopeKey || ''), partitionKey, status, dataAsOf, stale,
      String(options.staleReason || ''), Number(options.rowCount || 0), options.sourceId || null,
      JSON.stringify(initialDiagnostics)],
  );
  const result = await executor(
    `UPDATE ops.dataset_partitions AS p
        SET status=$4, data_as_of=$5,
            published_at=CASE WHEN $4='published' THEN now() ELSE p.published_at END,
            is_stale=$6, stale_reason=$7, row_count=$8, source_id=$9,
            diagnostics = CASE WHEN $11::text IS NULL THEN $10::jsonb ELSE (
              SELECT jsonb_build_object(
                'coverage_by_kind', m.by_kind,
                'coverage_kinds', (
                  SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k),'[]'::jsonb)
                    FROM (
                      SELECT jsonb_array_elements_text(COALESCE(p.diagnostics->'coverage_kinds','[]'::jsonb)) AS k
                      UNION
                      SELECT jsonb_object_keys(m.by_kind) AS k
                    ) merged_kinds
                ),
                'quality_status', CASE WHEN EXISTS (
                  SELECT 1 FROM jsonb_each(m.by_kind) AS e(k,v) WHERE v->>'status'='partial'
                ) THEN 'failed' ELSE 'passed' END
              )
              FROM (
                SELECT COALESCE(p.diagnostics->'coverage_by_kind','{}'::jsonb) || $11::jsonb AS by_kind
              ) m
            ) || ($10::jsonb - 'coverage_by_kind' - 'coverage_kinds' - 'quality_status') END,
            updated_at=now()
      WHERE p.dataset_code=$1 AND p.scope_key=$2 AND p.partition_key=$3
      RETURNING dataset_code,scope_key,partition_key,status,data_as_of,published_at,is_stale,stale_reason,row_count,diagnostics`,
    [String(datasetCode), String(scopeKey || ''), partitionKey, status, dataAsOf, stale,
      String(options.staleReason || ''), Number(options.rowCount || 0), options.sourceId || null,
      JSON.stringify(incomingDiagnostics), JSON.stringify(incomingByKind)],
  );
  const published = result.rows[0] || null;
  const qualityStatus = published && published.diagnostics ? published.diagnostics.quality_status : null;
  if (published && published.status === 'published' && !published.is_stale
      && (!qualityStatus || qualityStatus === 'passed')) {
    if (_onDatasetPublished) await _onDatasetPublished(datasetCode, scopeKey, partitionKey);
  }
  return published;
}

async function publishDatasetPartition(datasetCode, scopeKey, options = {}, executor = pool.query.bind(pool)) {
  const partitionKey = dateText(options.partitionKey || options.dataAsOf);
  const dataAsOf = dateText(options.dataAsOf || partitionKey) || partitionKey;
  if (!datasetCode || !partitionKey) throw new Error(`数据集分区缺少有效日期：${datasetCode}`);
  const status = options.status || 'published';
  if (!['loading', 'published', 'partial_published', 'rejected', 'stale'].includes(status)) {
    throw new Error(`不支持的数据集分区状态：${status}`);
  }
  const stale = status === 'stale' || Boolean(options.isStale);
  const result = await executor(
    `INSERT INTO ops.dataset_partitions
       (dataset_code,scope_key,partition_key,status,data_as_of,published_at,is_stale,stale_reason,row_count,source_id,diagnostics)
     VALUES($1,$2,$3,$4,$5,CASE WHEN $4='published' THEN now() ELSE NULL END,$6,$7,$8,$9,$10::jsonb)
     ON CONFLICT(dataset_code,scope_key,partition_key) DO UPDATE SET
       status=EXCLUDED.status,data_as_of=EXCLUDED.data_as_of,
       published_at=CASE WHEN EXCLUDED.status='published' THEN now() ELSE ops.dataset_partitions.published_at END,
       is_stale=EXCLUDED.is_stale,stale_reason=EXCLUDED.stale_reason,row_count=EXCLUDED.row_count,
       source_id=EXCLUDED.source_id,diagnostics=EXCLUDED.diagnostics,updated_at=now()
     RETURNING dataset_code,scope_key,partition_key,status,data_as_of,published_at,is_stale,stale_reason,row_count`,
    [String(datasetCode), String(scopeKey || ''), partitionKey, status, dataAsOf, stale,
      String(options.staleReason || ''), Number(options.rowCount || 0), options.sourceId || null,
      JSON.stringify(options.diagnostics || {})]
  );
  const published = result.rows[0] || null;
  if (published && status === 'published' && !stale
      && (!options.diagnostics || !options.diagnostics.quality_status || options.diagnostics.quality_status === 'passed')) {
    if (_onDatasetPublished) await _onDatasetPublished(datasetCode, scopeKey, partitionKey);
  }
  return published;
}

// 按目标日精确读取分区：补跑历史日时"最新分区"往往是更晚的日期，
// 用它判断目标日是否已发布会把已存在的分区判成缺失、触发多余补发。
async function getPartition(datasetCode, scopeKey = '', partitionKey, executor = pool.query.bind(pool)) {
  const key = dateText(partitionKey);
  if (!datasetCode || !key) return null;
  const { rows } = await executor(
    `SELECT dataset_code,scope_key,partition_key::text,status,data_as_of::text,published_at,
            is_stale,stale_reason,row_count,source_id,diagnostics
       FROM ops.dataset_partitions
      WHERE dataset_code=$1 AND scope_key=$2 AND partition_key=$3::date
      LIMIT 1`,
    [String(datasetCode), String(scopeKey || ''), key],
  );
  return rows[0] || null;
}

async function getLatestPublishedPartition(datasetCode, scopeKey = '') {
  const { rows } = await pool.query(
    `SELECT dataset_code,scope_key,partition_key::text,data_as_of::text,published_at,is_stale,stale_reason,row_count,diagnostics
       FROM ops.dataset_partitions
      WHERE dataset_code=$1 AND scope_key=$2 AND status='published'
      ORDER BY partition_key DESC LIMIT 1`, [datasetCode, String(scopeKey || '')]
  );
  return rows[0] || null;
}

// 仅供允许展示部分事实的页面使用；严格依赖、任务完成和告警恢复继续调用 getLatestPublishedPartition。
async function getLatestReadablePartition(datasetCode, scopeKey = '') {
  const { rows } = await pool.query(
    `SELECT dataset_code,scope_key,partition_key::text,data_as_of::text,published_at,is_stale,stale_reason,row_count,diagnostics,status
       FROM ops.dataset_partitions
      WHERE dataset_code=$1 AND scope_key=$2 AND status IN ('published','partial_published')
      ORDER BY partition_key DESC LIMIT 1`, [datasetCode, String(scopeKey || '')]
  );
  return rows[0] || null;
}

async function getDatasetMetadata(datasetCode, scopeKey = '') {
  const published = await getLatestPublishedPartition(datasetCode, scopeKey);
  if (published) return {
    data_as_of: dateText(published.data_as_of || published.partition_key),
    published_at: published.published_at || null,
    is_stale: Boolean(published.is_stale),
    stale_reason: published.stale_reason || '',
    row_count: Number(published.row_count || 0),
    diagnostics: published.diagnostics || {},
  };
  return { data_as_of: null, published_at: null, is_stale: true, stale_reason: '尚无已发布数据分区', row_count: 0, diagnostics: {} };
}

module.exports = { dateText, publishDatasetPartition, publishCoveragePartition, getPartition, getLatestPublishedPartition, getLatestReadablePartition, getDatasetMetadata, setDatasetPublishedHook };
