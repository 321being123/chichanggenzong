// 理杏仁官方开放平台来源登记（迁移179）。
//
// 与旧 GeoScope 中转严格区分：
//   - 新来源 source_code='lixinger_official'，凭据只读 LIXINGER_TOKEN；
//     旧中转的 source_code='geoscope_lixinger'、GEOSCOPE_API_KEY、旧缓存与旧权限结论一律不沿用。
//   - 旧来源只关闭启用开关，保留历史原始记录与策略证据，不删除任何历史数据。
//
// 额度口径：官方 skill 1.0.43 声明「每分钟最多 1000 次、每秒最多 36 次」，
// 未说明按账号还是按接口统计；同一 token 跨接口共享额度是更保守的假设，
// 因此把官方限额写在通配策略 api_name='*' 上，预算按账号共用一条计数。
// 每秒上限用 min_interval_ms=28 落实（1000/36≈27.8），由 Guard 的
// ops.source_endpoint_runtime.next_allowed_at 跨进程生效。
// 每日额度没有任何官方依据，保持 NULL，不自行编造。
async function migration179LixingerOfficialSource(pool) {
  await pool.query(`INSERT INTO ops.data_sources(source_code,source_name,source_type,priority)
    VALUES('lixinger_official','理杏仁开放平台','api',70)
    ON CONFLICT(source_code) DO NOTHING`);

  await pool.query(`INSERT INTO ops.source_endpoint_policies
      (source_id,api_name,credential_profile,permission_status,enabled,
       official_per_minute_limit,internal_per_minute_limit,internal_daily_limit,
       max_concurrency,min_interval_ms,timeout_ms,retry_policy,empty_policy,official_doc_url,notes)
    SELECT s.source_id,'*','primary','unknown',true,
       1000,NULL,NULL,
       1,28,30000,$1::jsonb,'preserve_last_success',
       'https://www.lixinger.com/api/open-api/url-doc',$2
      FROM ops.data_sources s WHERE s.source_code='lixinger_official'
    ON CONFLICT(source_id,api_name,credential_profile) DO NOTHING`,
    [
      JSON.stringify({ max_attempts: 5, backoff_ms: 1000, jitter_ms: 0,
        retry_on: ['network_timeout', 'upstream_5xx'] }),
      '官方 skill 1.0.43：1000 次/分、36 次/秒；按账号共享额度的保守假设记账；每日额度无依据保持 NULL',
    ]);

  // 旧中转停止使用：只关开关，保留来源、策略、原始记录和历史证据。
  await pool.query(`UPDATE ops.data_sources SET enabled=false WHERE source_code='geoscope_lixinger'`);
}

module.exports = { migration179LixingerOfficialSource };
