// 渠道告警/站点分析/港股打新（138-139、144-145、148-151、157、160-162）
// R-6 拆分自 ../migrations.js（2026-10-21）：本文件只放迁移函数体；执行顺序以 ../migrations.js 的 MIGRATIONS 注册表为准，禁止在本文件内重排。
const { pool, crypto, fs, path, DATA_DIR, DEFAULT_FEE_SETTINGS } = require('../connection');
const { uid, round, bulkInsert, hashPwd, safeEqual, verifyPwd, hashString } = require('../util');
const { seedBrokers } = require('../brokers');
const { migrateAccountsTable } = require('../accounts');
const { toNumber, normalizeMigrationDate, normalizeMigrationTimestamp, normalizeMigrationStockCode, scale100m } = require('./helpers');

// ========== 138：网站数据看板事实与运行采样 =============
// 只保存聚合后的匿名标识和白名单事件；不保存完整 URL、搜索词、持仓、金额、邮箱或令牌。
async function migration138SiteAnalytics() {
  await pool.query(`
    ALTER TABLE ops.sync_cursors
      ADD COLUMN IF NOT EXISTS cursor_payload JSONB NOT NULL DEFAULT '{}'::jsonb;

    CREATE TABLE IF NOT EXISTS ops.site_events (
      event_id TEXT PRIMARY KEY,
      received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      occurred_at TIMESTAMPTZ NOT NULL,
      visitor_key TEXT,
      user_key TEXT,
      session_key TEXT,
      page_view_id TEXT,
      event_name TEXT NOT NULL CHECK (event_name IN (
        'page_view','engagement','detail_open','filter_apply','register_view',
        'register_submit','register_success','watchlist_add_success','import_result','telemetry_init'
      )),
      page_key TEXT NOT NULL CHECK (page_key ~ '^[a-z][a-z0-9._-]{0,63}$'),
      module TEXT NOT NULL DEFAULT '',
      entry TEXT NOT NULL DEFAULT '',
      device_type TEXT NOT NULL DEFAULT 'unknown' CHECK (device_type IN ('mobile','desktop','tablet','unknown')),
      source_domain TEXT NOT NULL DEFAULT '',
      is_internal BOOLEAN NOT NULL DEFAULT false,
      data_version INTEGER NOT NULL DEFAULT 1 CHECK (data_version > 0),
      properties JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(properties)='object' AND pg_column_size(properties) <= 4096)
    );
    CREATE INDEX IF NOT EXISTS idx_site_events_occurred ON ops.site_events(occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_site_events_name_time ON ops.site_events(event_name, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_site_events_page_time ON ops.site_events(page_key, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_site_events_visitor_time ON ops.site_events(visitor_key, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_site_events_user_time ON ops.site_events(user_key, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_site_events_session_time ON ops.site_events(session_key, occurred_at DESC);

    CREATE TABLE IF NOT EXISTS ops.site_runtime_minute (
      runtime_id BIGSERIAL PRIMARY KEY,
      layer TEXT NOT NULL CHECK (layer IN ('app','nginx')),
      bucket_start TIMESTAMPTZ NOT NULL,
      batch_id TEXT NOT NULL,
      process_instance TEXT NOT NULL DEFAULT '',
      route_key TEXT NOT NULL DEFAULT '',
      request_kind TEXT NOT NULL DEFAULT 'unknown',
      request_count BIGINT NOT NULL DEFAULT 0 CHECK (request_count >= 0),
      status_2xx BIGINT NOT NULL DEFAULT 0 CHECK (status_2xx >= 0),
      status_3xx BIGINT NOT NULL DEFAULT 0 CHECK (status_3xx >= 0),
      status_4xx BIGINT NOT NULL DEFAULT 0 CHECK (status_4xx >= 0),
      status_429 BIGINT NOT NULL DEFAULT 0 CHECK (status_429 >= 0),
      status_5xx BIGINT NOT NULL DEFAULT 0 CHECK (status_5xx >= 0),
      duration_buckets JSONB NOT NULL DEFAULT '{}'::jsonb,
      bytes_sent BIGINT NOT NULL DEFAULT 0 CHECK (bytes_sent >= 0),
      error_count BIGINT NOT NULL DEFAULT 0 CHECK (error_count >= 0),
      sample_type TEXT NOT NULL DEFAULT 'request',
      coverage_status TEXT NOT NULL DEFAULT 'complete',
      event_loop_p50_ms NUMERIC(12,1),
      event_loop_p95_ms NUMERIC(12,1),
      event_loop_max_ms NUMERIC(12,1),
      source_file TEXT NOT NULL DEFAULT '',
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(layer, batch_id)
    );
    CREATE INDEX IF NOT EXISTS idx_site_runtime_bucket ON ops.site_runtime_minute(bucket_start DESC);
    CREATE INDEX IF NOT EXISTS idx_site_runtime_layer_bucket ON ops.site_runtime_minute(layer, bucket_start DESC);

    INSERT INTO platform_config(key, value)
      VALUES ('site_analytics_enabled_at', to_char(now(), 'YYYY-MM-DD HH24:MI:SSOF'))
      ON CONFLICT (key) DO NOTHING;
  `);
}

// ========== 139：网站运行采样单独记录 429 =============
async function migration139SiteAnalytics429() {
  await pool.query(`ALTER TABLE ops.site_runtime_minute
    ADD COLUMN IF NOT EXISTS status_429 BIGINT NOT NULL DEFAULT 0`);
}

// ========== 144：港股 IPO P0 探针、覆盖与回测审计 =============
async function migration144HkIpoP0Audit() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS analytics.hk_ipo_backtests (
      backtest_id BIGSERIAL PRIMARY KEY,
      model_version TEXT NOT NULL,
      from_date DATE NOT NULL,
      to_date DATE NOT NULL,
      candidate_count INTEGER NOT NULL DEFAULT 0,
      eligible_count INTEGER NOT NULL DEFAULT 0,
      test_count INTEGER NOT NULL DEFAULT 0,
      first_day_coverage NUMERIC(8,6) NOT NULL DEFAULT 0,
      five_day_coverage NUMERIC(8,6) NOT NULL DEFAULT 0,
      metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
      windows JSONB NOT NULL DEFAULT '[]'::jsonb,
      gate_status TEXT NOT NULL CHECK (gate_status IN ('blocked','passed')),
      gate_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
      input_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_hk_ipo_backtests_created
      ON analytics.hk_ipo_backtests(created_at DESC);
  `);
}

// ========== 145：巨潮取消来源级日保护线 =============
// 先清理历史来源级日保护；迁移156再统一清除来源级分钟/日内部限额。
// 日调用量继续精确计数，但不由本站预设总量拦截，只有真实上游 429/额度错误
// 才进入 external_circuits 并记录 opened_at/recover_at。
async function migration145CninfoUnlimitedDailyBudget() {
  await pool.query(`
    UPDATE ops.source_endpoint_policies p
       SET internal_daily_limit=NULL,
           notes='巨潮来源级日保护已取消；具体接口限制由接口策略单独登记，真实上游429/额度错误才记录熔断'
      FROM ops.data_sources ds
     WHERE p.source_id=ds.source_id
       AND ds.source_code='cninfo';
  `);
}

// ========== 148：港股 IPO 中文名称与市场信号快照 =============
// 中文名只作为展示字段；申购期认购倍数与暗盘涨幅为非官方市场信号，必须与官方最终倍数分开保存。
async function migration148HkIpoMarketSignals() {
  await pool.query(`
    ALTER TABLE public.ipo_history
      ADD COLUMN IF NOT EXISTS security_name_cn TEXT;

    WITH latest AS (
      SELECT DISTINCT ON (symbol) symbol,name
        FROM market_quote_cache
       WHERE source='tencent' AND name ~ '[一-龥]'
       ORDER BY symbol,fetched_at DESC
    )
    UPDATE public.ipo_history h
       SET security_name_cn=latest.name
      FROM latest
     WHERE h.market_code='HK'
       AND latest.symbol='hk' || regexp_replace(h.security_code,'\\D','','g')
       AND COALESCE(NULLIF(h.security_name_cn,''),'')='';

    -- 三家境外注册实体没有独立中文挂牌名，使用公开资料中已广泛使用的中文品牌别名，
    -- 仅作为展示兜底，不覆盖后续官方/行情源提供的中文名称。
    UPDATE public.ipo_history h
       SET security_name_cn=names.security_name_cn
      FROM (VALUES
        ('00100.HK','稀宇科技-WP'),
        ('03887.HK','哈希控股'),
        ('06880.HK','魔门塔-W')
      ) AS names(security_code,security_name_cn)
     WHERE h.market_code='HK' AND h.security_code=names.security_code
       AND COALESCE(NULLIF(h.security_name_cn,''),'')='';

    CREATE TABLE IF NOT EXISTS analytics.hk_ipo_market_snapshots (
      snapshot_id BIGSERIAL PRIMARY KEY,
      security_code TEXT NOT NULL,
      instrument_id BIGINT REFERENCES core.instruments(instrument_id) ON DELETE SET NULL,
      source_code TEXT NOT NULL,
      signal_type TEXT NOT NULL CHECK (signal_type IN ('subscription','grey_market')),
      data_date DATE NOT NULL,
      observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      subscription_multiple NUMERIC(20,6),
      grey_market_price_hkd NUMERIC(20,6),
      grey_market_change_pct NUMERIC(20,6),
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(security_code,source_code,signal_type,data_date)
    );
    CREATE INDEX IF NOT EXISTS idx_hk_ipo_market_snapshots_lookup
      ON analytics.hk_ipo_market_snapshots(security_code,signal_type,observed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_hk_ipo_market_snapshots_date
      ON analytics.hk_ipo_market_snapshots(data_date DESC,source_code,signal_type);

    INSERT INTO ops.data_sources(source_code,source_name,source_type,priority) VALUES
      ('livermore','利弗莫尔公开新股数据','broker_public',30),
      ('futu-public','富途公开新股页面','broker_public',31)
    ON CONFLICT(source_code) DO UPDATE SET
      source_name=EXCLUDED.source_name,source_type=EXCLUDED.source_type,priority=EXCLUDED.priority;

    INSERT INTO ops.source_endpoint_policies
      (source_id,api_name,credential_profile,internal_per_minute_limit,internal_daily_limit,
       max_concurrency,min_interval_ms,row_limit,timeout_ms,empty_policy,official_doc_url,notes)
    SELECT ds.source_id,'*','anonymous',NULL,NULL,1,1000,200,15000,'preserve_last_success',
           'https://1877.jesselivermore.com/','公开页面/接口为补充信号，不是港交所官方事实源；空结果保留旧快照'
      FROM ops.data_sources ds WHERE ds.source_code='livermore'
    ON CONFLICT(source_id,api_name,credential_profile) DO UPDATE SET
      internal_per_minute_limit=EXCLUDED.internal_per_minute_limit,
      internal_daily_limit=EXCLUDED.internal_daily_limit,
      min_interval_ms=EXCLUDED.min_interval_ms,row_limit=EXCLUDED.row_limit,
      timeout_ms=EXCLUDED.timeout_ms,empty_policy=EXCLUDED.empty_policy,
      official_doc_url=EXCLUDED.official_doc_url,notes=EXCLUDED.notes,updated_at=now();

    INSERT INTO ops.source_endpoint_policies
      (source_id,api_name,credential_profile,internal_per_minute_limit,internal_daily_limit,
       max_concurrency,min_interval_ms,row_limit,timeout_ms,empty_policy,official_doc_url,notes)
    SELECT ds.source_id,'*','anonymous',NULL,NULL,1,1000,200,15000,'preserve_last_success',
           'https://www.futunn.com/quote/hk/ipo','公开网页抓取为补充信号；富途正式接口需另行配置授权'
      FROM ops.data_sources ds WHERE ds.source_code='futu-public'
    ON CONFLICT(source_id,api_name,credential_profile) DO UPDATE SET
      internal_per_minute_limit=EXCLUDED.internal_per_minute_limit,
      internal_daily_limit=EXCLUDED.internal_daily_limit,
      min_interval_ms=EXCLUDED.min_interval_ms,row_limit=EXCLUDED.row_limit,
      timeout_ms=EXCLUDED.timeout_ms,empty_policy=EXCLUDED.empty_policy,
      official_doc_url=EXCLUDED.official_doc_url,notes=EXCLUDED.notes,updated_at=now();
  `);
}

// ========== 149：港股 IPO 中文展示别名补齐 =============
// 仅补齐没有官方中文挂牌名且行情源也未提供中文名的三家境外注册实体；后续可靠中文源可覆盖。
async function migration149HkIpoChineseAliases() {
  await pool.query(`
    UPDATE public.ipo_history h
       SET security_name_cn=names.security_name_cn
      FROM (VALUES
        ('00100.HK','稀宇科技-WP'),
        ('03887.HK','哈希控股'),
        ('06880.HK','魔门塔-W')
      ) AS names(security_code,security_name_cn)
     WHERE h.market_code='HK' AND h.security_code=names.security_code
       AND COALESCE(NULLIF(h.security_name_cn,''),'')='';
  `);
}

// ========== 150：港股 IPO 华盛公开盘中备源 =============
// Livermore 盘中接口返回空/升级提示时，使用华盛公开接口的预计孖展倍数；
// 该来源只作为非官方补充信号，最终超购倍数仍以港交所配售结果为准。
async function migration150HkIpoVbkrFallback() {
  await pool.query(`
    INSERT INTO ops.data_sources(source_code,source_name,source_type,priority) VALUES
      ('vbkr-public','华盛公开新股数据（捷利交易宝汇总）','broker_public',29)
    ON CONFLICT(source_code) DO UPDATE SET
      source_name=EXCLUDED.source_name,source_type=EXCLUDED.source_type,priority=EXCLUDED.priority;

    INSERT INTO ops.source_endpoint_policies
      (source_id,api_name,credential_profile,internal_per_minute_limit,internal_daily_limit,
       max_concurrency,min_interval_ms,row_limit,timeout_ms,empty_policy,official_doc_url,notes)
    SELECT ds.source_id,'hk_ipo_current','anonymous',5,3,1,1000,200,15000,'preserve_last_success',
           'https://www.vbkr.com/ipo/hk/v2/ipo-hk-index',
           'Livermore 空/升级时的公开备源；字段为预计孖展，不是港交所最终超购事实'
      FROM ops.data_sources ds WHERE ds.source_code='vbkr-public'
    ON CONFLICT(source_id,api_name,credential_profile) DO UPDATE SET
      internal_per_minute_limit=EXCLUDED.internal_per_minute_limit,
      internal_daily_limit=EXCLUDED.internal_daily_limit,
      max_concurrency=EXCLUDED.max_concurrency,
      min_interval_ms=EXCLUDED.min_interval_ms,row_limit=EXCLUDED.row_limit,
      timeout_ms=EXCLUDED.timeout_ms,empty_policy=EXCLUDED.empty_policy,
      official_doc_url=EXCLUDED.official_doc_url,notes=EXCLUDED.notes,updated_at=now();
  `);
}

// ========== 151：告警作用域与巨潮 403 有界退避 =============
async function migration151AlertScopeAndCninfoBackoff() {
  await pool.query(`
    ALTER TABLE ops.alert_notifications
      ADD COLUMN IF NOT EXISTS scope_type TEXT,
      ADD COLUMN IF NOT EXISTS scope_key TEXT;

    UPDATE ops.alert_notifications
       SET scope_type='slot', scope_key=slot_id::text
     WHERE scope_type IS NULL AND slot_id IS NOT NULL;

    UPDATE ops.alert_notifications
       SET scope_type='job', scope_key=job_code
     WHERE scope_type IS NULL AND slot_id IS NULL AND NULLIF(job_code,'') IS NOT NULL;

    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_alert_notifications_scope') THEN
        ALTER TABLE ops.alert_notifications ADD CONSTRAINT chk_alert_notifications_scope
          CHECK ((scope_type IS NULL AND scope_key IS NULL)
              OR (scope_type IN ('slot','job','dataset','source_endpoint') AND NULLIF(scope_key,'') IS NOT NULL));
      END IF;
    END $$;
    CREATE INDEX IF NOT EXISTS idx_alert_notifications_scope_status
      ON ops.alert_notifications(scope_type,scope_key,status,last_seen_at DESC);

    ALTER TABLE ops.external_circuits
      ADD COLUMN IF NOT EXISTS consecutive_forbidden_count INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS last_forbidden_at TIMESTAMPTZ;
  `);
}

// ========== 157：部分分区与历史告警核对运行态 =============
// 部分事实允许页面展示，但不得被严格数据集依赖或告警恢复当作完整成功。
async function migration157AlertReconciliationAndPartialPartitions() {
  await pool.query(`
    ALTER TABLE ops.dataset_partitions
      DROP CONSTRAINT IF EXISTS dataset_partitions_status_check,
      DROP CONSTRAINT IF EXISTS ck_dataset_partitions_status;
    ALTER TABLE ops.dataset_partitions
      ADD CONSTRAINT ck_dataset_partitions_status
      CHECK (status IN ('loading','published','partial_published','rejected','stale'));

    ALTER TABLE ops.alert_notifications
      ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS next_check_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS idx_alert_notifications_reconciliation_due
      ON ops.alert_notifications(next_check_at, last_checked_at, alert_id)
      WHERE status NOT IN ('resolved','acknowledged');
    CREATE INDEX IF NOT EXISTS idx_alert_notifications_reconciliation_new
      ON ops.alert_notifications(last_checked_at, next_check_at, alert_id)
      WHERE status NOT IN ('resolved','acknowledged');

    ALTER TABLE ops.source_endpoint_runtime
      ADD COLUMN IF NOT EXISTS consecutive_fallback_count INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS last_fallback_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS last_primary_success_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS idx_source_endpoint_runtime_fallback
      ON ops.source_endpoint_runtime(source_id,api_name,credential_fingerprint,consecutive_fallback_count);
  `);
}

// ========== 160：真实限流熔断递增恢复退避 =============
// 只记录连续真实 RATE_LIMIT 次数，用于延长熔断恢复等待；不把退避时间冒充上游额度。
async function migration160RateLimitRecoveryBackoff() {
  await pool.query(`
    ALTER TABLE ops.external_circuits
      ADD COLUMN IF NOT EXISTS consecutive_rate_limit_count INTEGER NOT NULL DEFAULT 0;
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname='ck_external_circuits_rate_limit_count'
      ) THEN
        ALTER TABLE ops.external_circuits
          ADD CONSTRAINT ck_external_circuits_rate_limit_count
          CHECK (consecutive_rate_limit_count >= 0);
      END IF;
    END $$;
  `);
}

// ========== 161：港股 IPO 市场快照时间线与规范化幂等 =============
// 保留旧快照，取消“同日同源同类型只能一条”的约束；新写入按规范化业务内容哈希幂等，支持同日多时点留痕。
async function migration161HkIpoMarketSnapshotTimeline() {
  const client = await pool.connect();
  const quoteIdent = value => `"${String(value).replace(/"/g, '""')}"`;
  try {
    await client.query('BEGIN');
    const table = await client.query("SELECT to_regclass('analytics.hk_ipo_market_snapshots') AS name");
    if (!table.rows[0] || !table.rows[0].name) {
      throw new Error('analytics.hk_ipo_market_snapshots 不存在，拒绝执行 161 号迁移');
    }

    await client.query(`
      ALTER TABLE analytics.hk_ipo_market_snapshots
        ADD COLUMN IF NOT EXISTS source_observed_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        ADD COLUMN IF NOT EXISTS margin_amount_hkd NUMERIC(20,6),
        ADD COLUMN IF NOT EXISTS margin_multiple NUMERIC(20,6),
        ADD COLUMN IF NOT EXISTS signal_kind TEXT,
        ADD COLUMN IF NOT EXISTS source_record_hash TEXT,
        ADD COLUMN IF NOT EXISTS quality_status TEXT NOT NULL DEFAULT 'valid';

      UPDATE analytics.hk_ipo_market_snapshots
         SET last_seen_at=COALESCE(last_seen_at,observed_at,created_at,now()),
             quality_status=COALESCE(NULLIF(quality_status,''),'valid')
       WHERE last_seen_at IS NULL OR quality_status IS NULL OR quality_status='';
    `);

    for (const [name, definition] of [
      ['chk_hk_ipo_market_snapshots_signal_kind', `CHECK (signal_kind IS NULL OR signal_kind IN ('subscription_estimate','margin_estimate','grey_market_quote'))`],
      ['chk_hk_ipo_market_snapshots_quality_status', `CHECK (quality_status IN ('valid','empty','rejected'))`],
    ]) {
      const exists = await client.query(
        'SELECT 1 FROM pg_constraint WHERE conname=$1 AND conrelid=\'analytics.hk_ipo_market_snapshots\'::regclass',
        [name]
      );
      if (!exists.rowCount) await client.query(`ALTER TABLE analytics.hk_ipo_market_snapshots ADD CONSTRAINT ${quoteIdent(name)} ${definition}`);
    }

    const keyColumns = `ARRAY['security_code','source_code','signal_type','data_date']::text[]`;
    const constraints = await client.query(`
      SELECT c.conname
        FROM pg_constraint c
       WHERE c.conrelid='analytics.hk_ipo_market_snapshots'::regclass
         AND c.contype='u'
         AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
                FROM unnest(c.conkey) WITH ORDINALITY k(attnum,ord)
                JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum)=${keyColumns}
    `);
    if (constraints.rowCount > 1) {
      throw new Error(`161 号迁移识别到多个旧唯一约束：${constraints.rows.map(row => row.conname).join(',')}`);
    }
    if (constraints.rowCount === 1) {
      await client.query(`ALTER TABLE analytics.hk_ipo_market_snapshots DROP CONSTRAINT ${quoteIdent(constraints.rows[0].conname)}`);
    } else {
      const indexes = await client.query(`
        SELECT i.indexrelid::regclass::text AS index_name
          FROM pg_index i
         WHERE i.indrelid='analytics.hk_ipo_market_snapshots'::regclass
           AND i.indisunique
           AND NOT i.indisprimary
           AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
                  FROM unnest(i.indkey) WITH ORDINALITY k(attnum,ord)
                  JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum)=${keyColumns}
           AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid=i.indexrelid)
      `);
      if (indexes.rowCount > 1) {
        throw new Error(`161 号迁移识别到多个独立旧唯一索引：${indexes.rows.map(row => row.index_name).join(',')}`);
      }
      if (indexes.rowCount === 1) await client.query(`DROP INDEX ${indexes.rows[0].index_name}`);
      if (indexes.rowCount === 0) {
        throw new Error('161 号迁移未找到旧唯一约束或独立唯一索引，拒绝继续变更表结构');
      }
    }

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_hk_ipo_market_snapshots_record_hash
        ON analytics.hk_ipo_market_snapshots(
          security_code,source_code,signal_type,data_date,source_record_hash
        ) WHERE source_record_hash IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_hk_ipo_market_snapshots_source_time
        ON analytics.hk_ipo_market_snapshots(
          security_code,signal_type,source_observed_at DESC NULLS LAST,observed_at DESC
        );
    `);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// ========== 162：HKIPOx 港股 IPO 公开申购倍数来源 =============
// 仅登记匿名公开网页接口；倍数作为申购期参考信号，不代表孖展或港交所最终超购。
async function migration162HkIpoXPublicSource() {
  await pool.query(`
    INSERT INTO ops.data_sources(source_code,source_name,source_type,priority)
    VALUES ('hkipox-public','HKIPOx 公开新股页面','reference',35)
    ON CONFLICT(source_code) DO UPDATE
      SET source_name=EXCLUDED.source_name,source_type=EXCLUDED.source_type,priority=EXCLUDED.priority;

    INSERT INTO ops.source_endpoint_policies
      (source_id,api_name,credential_profile,max_concurrency,min_interval_ms,row_limit,timeout_ms,empty_policy,official_doc_url,notes)
    SELECT ds.source_id,'hk_ipo_public_page','anonymous',1,60000,200,20000,'preserve_last_success',
           'https://hkipox.com/','公开页面仅采集今日申购区明确展示的认购倍数；不作为孖展金额或最终超购事实'
      FROM ops.data_sources ds
     WHERE ds.source_code='hkipox-public'
    ON CONFLICT(source_id,api_name,credential_profile) DO UPDATE
      SET max_concurrency=EXCLUDED.max_concurrency,
          min_interval_ms=EXCLUDED.min_interval_ms,
          row_limit=EXCLUDED.row_limit,
          timeout_ms=EXCLUDED.timeout_ms,
          empty_policy=EXCLUDED.empty_policy,
          official_doc_url=EXCLUDED.official_doc_url,
          notes=EXCLUDED.notes,
          updated_at=now();
  `);
}

module.exports = {
  migration138SiteAnalytics,
  migration139SiteAnalytics429,
  migration144HkIpoP0Audit,
  migration145CninfoUnlimitedDailyBudget,
  migration148HkIpoMarketSignals,
  migration149HkIpoChineseAliases,
  migration150HkIpoVbkrFallback,
  migration151AlertScopeAndCninfoBackoff,
  migration157AlertReconciliationAndPartialPartitions,
  migration160RateLimitRecoveryBackoff,
  migration161HkIpoMarketSnapshotTimeline,
  migration162HkIpoXPublicSource,
};
