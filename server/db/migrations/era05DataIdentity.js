// 数据集分区/证券身份/接口策略（116-131、134-135、140-143、154-156、158-159、163、169）
// R-6 拆分自 ../migrations.js（2026-10-21）：本文件只放迁移函数体；执行顺序以 ../migrations.js 的 MIGRATIONS 注册表为准，禁止在本文件内重排。
const { pool, crypto, fs, path, DATA_DIR, DEFAULT_FEE_SETTINGS } = require('../connection');
const { uid, round, bulkInsert, hashPwd, safeEqual, verifyPwd, hashString } = require('../util');
const { seedBrokers } = require('../brokers');
const { migrateAccountsTable } = require('../accounts');
const { toNumber, normalizeMigrationDate, normalizeMigrationTimestamp, normalizeMigrationStockCode, scale100m } = require('./helpers');

// ========== 116：指数标准身份与供应商代码映射 =============
// 前端只传标准代码，Tushare/腾讯/新浪代码由 core.instrument_identifiers 统一解析。
async function migration116IndexInstrumentIdentifiers() {
  await pool.query(`
    INSERT INTO ops.data_sources(source_code,source_name,source_type,priority)
    VALUES ('sina','新浪行情','quote',30)
    ON CONFLICT(source_code) DO UPDATE SET source_name=EXCLUDED.source_name,source_type=EXCLUDED.source_type,priority=EXCLUDED.priority;

    INSERT INTO core.instruments(canonical_code,name,asset_class,market,exchange_code,currency_code,status,raw_data)
    VALUES
      ('000300.SH','沪深300','index','CN','SSE','CNY','listed','{"seed":"index-identifiers"}'::jsonb),
      ('000001.SH','上证指数','index','CN','SSE','CNY','listed','{"seed":"index-identifiers"}'::jsonb),
      ('000905.SH','中证500','index','CN','SSE','CNY','listed','{"seed":"index-identifiers"}'::jsonb),
      ('HSI.HK','恒生指数','index','HK','HKEX','HKD','listed','{"seed":"index-identifiers"}'::jsonb)
    ON CONFLICT(canonical_code) DO UPDATE SET name=EXCLUDED.name,asset_class=EXCLUDED.asset_class,
      market=EXCLUDED.market,exchange_code=EXCLUDED.exchange_code,currency_code=EXCLUDED.currency_code,updated_at=now();

    INSERT INTO core.instrument_identifiers(instrument_id,source_id,identifier_type,identifier_value,valid_from)
    SELECT i.instrument_id,d.source_id,x.identifier_type,x.identifier_value,NULL
      FROM (VALUES
        ('000300.SH','tushare','ts_code','000300.SH'),('000300.SH','tencent','quote_symbol','sh000300'),('000300.SH','sina','symbol','sh000300'),
        ('000001.SH','tushare','ts_code','000001.SH'),('000001.SH','tencent','quote_symbol','sh000001'),('000001.SH','sina','symbol','sh000001'),
        ('000905.SH','tushare','ts_code','000905.SH'),('000905.SH','tencent','quote_symbol','sh000905'),('000905.SH','sina','symbol','sh000905'),
        ('HSI.HK','tencent','quote_symbol','hkHSI'),('HSI.HK','sina','symbol','hkHSI')
      ) AS x(canonical_code,source_code,identifier_type,identifier_value)
      JOIN core.instruments i ON i.canonical_code=x.canonical_code
      JOIN ops.data_sources d ON d.source_code=x.source_code
    ON CONFLICT(source_id,identifier_type,identifier_value,valid_from) DO NOTHING;
  `);
}

// ========== 117：数据集分区发布水位 =============
// 采集成功、计算成功和可供页面读取是三个状态；页面只能读取 published 分区。
async function migration117DatasetPartitions() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ops.dataset_partitions (
      partition_id BIGSERIAL PRIMARY KEY,
      dataset_code TEXT NOT NULL,
      scope_key TEXT NOT NULL DEFAULT '',
      partition_key DATE NOT NULL,
      status TEXT NOT NULL DEFAULT 'loading'
        CHECK (status IN ('loading','published','rejected','stale')),
      data_as_of DATE,
      published_at TIMESTAMPTZ,
      is_stale BOOLEAN NOT NULL DEFAULT false,
      stale_reason TEXT NOT NULL DEFAULT '',
      row_count INTEGER NOT NULL DEFAULT 0,
      source_id SMALLINT REFERENCES ops.data_sources(source_id),
      diagnostics JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(dataset_code,scope_key,partition_key)
    );
    CREATE INDEX IF NOT EXISTS idx_dataset_partitions_latest
      ON ops.dataset_partitions(dataset_code,scope_key,status,partition_key DESC);
  `);
}

// ========== 118：证券历史合并候选（只记录审计结果，不自动删除旧ID） =============
// 历史证券主档合并是高风险操作。先保存候选、外键影响量和冲突说明，
// 由 dry-run 报告及人工审批驱动后续映射；本迁移不改写业务事实。
async function migration118InstrumentMergeCandidates() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS core.instrument_merge_candidates (
      candidate_id BIGSERIAL PRIMARY KEY,
      primary_instrument_id BIGINT NOT NULL REFERENCES core.instruments(instrument_id),
      duplicate_instrument_id BIGINT NOT NULL REFERENCES core.instruments(instrument_id),
      reason TEXT NOT NULL DEFAULT '',
      impact_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
      conflict_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'candidate'
        CHECK (status IN ('candidate','approved','migrated','rejected')),
      generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      reviewed_at TIMESTAMPTZ,
      notes TEXT NOT NULL DEFAULT '',
      UNIQUE(primary_instrument_id,duplicate_instrument_id),
      CHECK (primary_instrument_id <> duplicate_instrument_id)
    );
    CREATE INDEX IF NOT EXISTS idx_instrument_merge_candidates_status
      ON core.instrument_merge_candidates(status,generated_at DESC);
  `);
}

// ========== 119：Tushare daily_basic 股息率单位纠正 =============
// daily_basic.dv_ttm 的单位是百分数点（例如 5 表示 5%），标准层 dividend_yield_ttm 统一存比例小数。
// 仅依据已留存的 ops.raw_records 原始字段回填，不按数值大小猜测，避免误伤极端股息率。
async function migration119NormalizeDividendYieldUnit() {
  await pool.query(`
    WITH source_rows AS (
      SELECT DISTINCT ON (payload->>'ts_code', payload->>'trade_date')
             payload->>'ts_code' AS ts_code,
             to_date(payload->>'trade_date','YYYYMMDD') AS trade_date,
             NULLIF(payload->>'dv_ttm','')::numeric / 100 AS dividend_yield_ttm
        FROM ops.raw_records r
        JOIN ops.data_sources d ON d.source_id=r.source_id AND d.source_code='tushare'
       WHERE r.dataset_code='daily_basic'
         AND payload->>'ts_code' IS NOT NULL
         AND payload->>'trade_date' ~ '^[0-9]{8}$'
         AND payload->>'dv_ttm' IS NOT NULL
         AND NULLIF(payload->>'dv_ttm','') ~ '^-?[0-9]+(\\.[0-9]+)?$'
       ORDER BY payload->>'ts_code', payload->>'trade_date', r.ingested_at DESC, r.raw_record_id DESC
    )
    UPDATE market.daily_valuations v
       SET dividend_yield_ttm=s.dividend_yield_ttm, ingested_at=now()
      FROM source_rows s
      JOIN core.instruments i ON i.canonical_code=s.ts_code
     WHERE v.instrument_id=i.instrument_id AND v.trade_date=s.trade_date
       AND s.dividend_yield_ttm IS NOT NULL
  `);
}

// ========== 120：历史无原始留痕的 Tushare 股息率修复 =============
// 119 已按原始记录精确回填；老库部分日期没有 raw_records，但来源仍明确为 Tushare。
// 结合字段契约（dv_ttm 百分数点）和全量分布校验，仅修复 1～100 的异常百分数点，并留下审计标记。
async function migration120RepairLegacyDividendYieldUnit() {
  await pool.query(`
    ALTER TABLE market.daily_valuations ADD COLUMN IF NOT EXISTS data_quality JSONB NOT NULL DEFAULT '{}'::jsonb;
    UPDATE market.daily_valuations v
       SET dividend_yield_ttm=v.dividend_yield_ttm/100,
           data_quality=v.data_quality || '{"dividend_yield_unit":"percent_point_normalized","repair":"migration120"}'::jsonb,
           ingested_at=now()
      FROM ops.data_sources d
     WHERE d.source_id=v.source_id AND d.source_code='tushare'
       AND v.dividend_yield_ttm > 1 AND v.dividend_yield_ttm <= 100
  `);
}

// ========== 121：已有标准数据的分区水位初始化 =============
// 让升级后的页面立即能识别数据日期；后续采集任务继续按同一表更新。
async function migration121BackfillDatasetPartitions() {
  await pool.query(`
    INSERT INTO ops.dataset_partitions(dataset_code,scope_key,partition_key,status,data_as_of,published_at,is_stale,stale_reason,row_count,diagnostics)
    SELECT 'bond_daily','CN',MAX(trade_date),'published',MAX(trade_date),now(),false,'',COUNT(*),'{"backfill":"migration121"}'::jsonb
      FROM market.convertible_bond_daily_metrics WHERE trade_date IS NOT NULL HAVING COUNT(*)>0
    ON CONFLICT(dataset_code,scope_key,partition_key) DO NOTHING;
    INSERT INTO ops.dataset_partitions(dataset_code,scope_key,partition_key,status,data_as_of,published_at,is_stale,stale_reason,row_count,diagnostics)
    SELECT 'stock_daily','CN',MAX(trade_date),'published',MAX(trade_date),now(),false,'',COUNT(*),'{"backfill":"migration121"}'::jsonb
      FROM market.daily_bars WHERE trade_date IS NOT NULL HAVING COUNT(*)>0
    ON CONFLICT(dataset_code,scope_key,partition_key) DO NOTHING;
    INSERT INTO ops.dataset_partitions(dataset_code,scope_key,partition_key,status,data_as_of,published_at,is_stale,stale_reason,row_count,diagnostics)
    SELECT 'stock_valuation','CN',MAX(trade_date),'published',MAX(trade_date),now(),false,'',COUNT(*),'{"backfill":"migration121"}'::jsonb
      FROM market.daily_valuations WHERE trade_date IS NOT NULL HAVING COUNT(*)>0
    ON CONFLICT(dataset_code,scope_key,partition_key) DO NOTHING;
    INSERT INTO ops.dataset_partitions(dataset_code,scope_key,partition_key,status,data_as_of,published_at,is_stale,stale_reason,row_count,diagnostics)
    SELECT 'stock_adj_factor','CN',MAX(trade_date),'published',MAX(trade_date),now(),false,'',COUNT(*),'{"backfill":"migration121"}'::jsonb
      FROM market.adjustment_factors WHERE trade_date IS NOT NULL HAVING COUNT(*)>0
    ON CONFLICT(dataset_code,scope_key,partition_key) DO NOTHING;
    INSERT INTO ops.dataset_partitions(dataset_code,scope_key,partition_key,status,data_as_of,published_at,is_stale,stale_reason,row_count,diagnostics)
    SELECT 'bond_valuation','CN',MAX(trade_date),'published',MAX(trade_date),now(),false,'',COUNT(*),'{"backfill":"migration121"}'::jsonb
      FROM analytics.convertible_bond_valuation_daily WHERE trade_date IS NOT NULL HAVING COUNT(*)>0
    ON CONFLICT(dataset_code,scope_key,partition_key) DO NOTHING;
    INSERT INTO ops.dataset_partitions(dataset_code,scope_key,partition_key,status,data_as_of,published_at,is_stale,stale_reason,row_count,diagnostics)
    SELECT 'bond_safety_snapshot','CN',MAX(COALESCE(source_updated_at,refreshed_at))::date,'published',MAX(COALESCE(source_updated_at,refreshed_at))::date,now(),false,'',MAX(row_count),'{"backfill":"migration121"}'::jsonb
      FROM bond_safety_snapshots WHERE COALESCE(source_updated_at,refreshed_at) IS NOT NULL HAVING COUNT(*)>0
    ON CONFLICT(dataset_code,scope_key,partition_key) DO NOTHING;
  `);
}

// ========== 122：历史股票类型与公司关系归一 =============
// 旧链路曾把股票写成 equity，且没有同步 core.companies/company_instruments。
// 本迁移只做可逆的类型归一和幂等关系补齐，不合并证券 ID、不删除任何事实。
async function migration122NormalizeLegacyStockIdentity() {
  await pool.query(`
    WITH candidates AS (
      SELECT instrument_id, NULLIF(BTRIM(name), '') AS legal_name,
             CASE WHEN upper(market) = 'HK' OR currency_code = 'HKD' THEN 'HK' ELSE 'CN' END AS country_code
        FROM core.instruments
       WHERE asset_class IN ('stock','equity') AND NULLIF(BTRIM(name), '') IS NOT NULL
    ), company_rows AS (
      INSERT INTO core.companies(legal_name,short_name,country_code,raw_data)
      SELECT legal_name,legal_name,country_code,'{"backfill":"migration122"}'::jsonb
        FROM candidates
       GROUP BY legal_name,country_code
      ON CONFLICT(country_code,legal_name) DO UPDATE
        SET short_name=CASE WHEN core.companies.short_name='' THEN EXCLUDED.short_name ELSE core.companies.short_name END,
            updated_at=now()
      RETURNING company_id,legal_name,country_code
    )
    INSERT INTO core.company_instruments(company_id,instrument_id,relation_type,valid_from)
    SELECT c.company_id,x.instrument_id,'issued_by',i.list_date
      FROM candidates x
      JOIN company_rows c ON c.legal_name=x.legal_name AND c.country_code=x.country_code
      JOIN core.instruments i ON i.instrument_id=x.instrument_id
    ON CONFLICT(company_id,instrument_id,relation_type) DO UPDATE
      SET valid_from=COALESCE(core.company_instruments.valid_from,EXCLUDED.valid_from);

    UPDATE core.instruments
       SET asset_class='stock',updated_at=now()
     WHERE asset_class='equity';
  `);
}

// ========== 123：补齐迁移122遗漏的公司-证券关系 =============
// PostgreSQL 数据修改 CTE 的变更对同一语句普通表读取不可见；迁移122已建好公司，
// 本步单独按现存公司补关系，保证旧库升级和新库初始化最终结果一致。
async function migration123BackfillStockCompanyRelations() {
  await pool.query(`
    INSERT INTO core.company_instruments(company_id,instrument_id,relation_type,valid_from)
    SELECT c.company_id,i.instrument_id,'issued_by',i.list_date
      FROM core.instruments i
      JOIN core.companies c
        ON c.legal_name=NULLIF(BTRIM(i.name),'')
       AND c.country_code=CASE WHEN upper(i.market)='HK' OR i.currency_code='HKD' THEN 'HK' ELSE 'CN' END
     WHERE i.asset_class='stock' AND NULLIF(BTRIM(i.name),'') IS NOT NULL
    ON CONFLICT(company_id,instrument_id,relation_type) DO UPDATE
      SET valid_from=COALESCE(core.company_instruments.valid_from,EXCLUDED.valid_from);
  `);
}

// ========== 124：统一外部调用预算原子扣减入口 =============
// Node 与 Python 必须通过同一数据库函数扣减日/分钟预算，避免两套 SQL
// 在并发下出现语义漂移。函数只负责预算与计数，熔断/探测仍由 Guard 负责。
async function migration124ExternalCallBudgetFunction() {
  await pool.query(`
    CREATE OR REPLACE FUNCTION ops.consume_external_call_budget(
      p_source text,
      p_day_key text,
      p_minute_key text,
      p_day_limit integer,
      p_minute_limit integer
    )
    RETURNS TABLE(allowed boolean, wait_window text, day_count integer, minute_count integer)
    LANGUAGE plpgsql
    AS $$
    DECLARE
      v_day_count integer := 0;
      v_minute_count integer := 0;
    BEGIN
      IF NULLIF(BTRIM(p_source), '') IS NULL THEN
        RAISE EXCEPTION 'external budget source is required';
      END IF;
      IF p_day_limit IS NULL OR p_day_limit <= 0 OR p_minute_limit IS NULL OR p_minute_limit <= 0 THEN
        RAISE EXCEPTION 'external budget limits must be positive';
      END IF;

      PERFORM pg_advisory_xact_lock(hashtext('external_budget:' || p_source));

      SELECT call_count INTO v_day_count
        FROM ops.external_call_budgets
       WHERE source=p_source AND window_type='day' AND window_key=p_day_key
       FOR UPDATE;
      SELECT call_count INTO v_minute_count
        FROM ops.external_call_budgets
       WHERE source=p_source AND window_type='minute' AND window_key=p_minute_key
       FOR UPDATE;
      v_day_count := COALESCE(v_day_count, 0);
      v_minute_count := COALESCE(v_minute_count, 0);

      IF v_minute_count >= p_minute_limit THEN
        RETURN QUERY SELECT false, 'minute'::text, v_day_count, v_minute_count;
        RETURN;
      END IF;
      IF v_day_count >= p_day_limit THEN
        RETURN QUERY SELECT false, 'day'::text, v_day_count, v_minute_count;
        RETURN;
      END IF;

      INSERT INTO ops.external_call_budgets(source,window_type,window_key,call_count,budget_limit)
      VALUES(p_source,'day',p_day_key,1,p_day_limit)
      ON CONFLICT(source,window_type,window_key) DO UPDATE
        SET call_count=ops.external_call_budgets.call_count+1,
            budget_limit=EXCLUDED.budget_limit,
            updated_at=now();
      INSERT INTO ops.external_call_budgets(source,window_type,window_key,call_count,budget_limit)
      VALUES(p_source,'minute',p_minute_key,1,p_minute_limit)
      ON CONFLICT(source,window_type,window_key) DO UPDATE
        SET call_count=ops.external_call_budgets.call_count+1,
            budget_limit=EXCLUDED.budget_limit,
            updated_at=now();

      RETURN QUERY SELECT true, NULL::text, v_day_count + 1, v_minute_count + 1;
    END;
    $$;
  `);
}

// ========== 125：历史证券主档收敛到唯一标准代码 =============
// 删除可唯一映射的历史主档并迁移其业务外键；同时清理无效主档和重复公司关系，
// 最后用数据库约束阻止裸代码、错误市场代码和同数字重复主档再次写入。
async function migration125ConsolidateInstrumentMasters() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(904125)');
    await client.query(`
      -- 先为所有可识别的股票/转债计算唯一标准代码，再按“标准代码优先、其次标准格式、最后主档 ID”选唯一保留行。
      -- 这样既能处理裸代码，也能处理 836660.SH.SH 这类错误后缀；即使标准目标原本不存在，也能先合并后改名。
      CREATE TEMP TABLE tmp_instrument_expected(
        instrument_id bigint PRIMARY KEY,
        asset_class text NOT NULL,
        expected_code text NOT NULL
      ) ON COMMIT DROP;
      INSERT INTO tmp_instrument_expected(instrument_id,asset_class,expected_code)
      SELECT i.instrument_id,i.asset_class,CASE
        WHEN i.asset_class='stock' AND length(regexp_replace(i.canonical_code,'[^0-9]','','g'))=5
          THEN regexp_replace(i.canonical_code,'[^0-9]','','g') || '.HK'
        WHEN i.asset_class='stock' AND regexp_replace(i.canonical_code,'[^0-9]','','g') ~ '^(4|8|92)'
          THEN regexp_replace(i.canonical_code,'[^0-9]','','g') || '.BJ'
        WHEN i.asset_class='stock' AND regexp_replace(i.canonical_code,'[^0-9]','','g') ~ '^(6|9)'
          THEN regexp_replace(i.canonical_code,'[^0-9]','','g') || '.SH'
        WHEN i.asset_class='stock'
          THEN regexp_replace(i.canonical_code,'[^0-9]','','g') || '.SZ'
        WHEN i.asset_class='convertible_bond' AND regexp_replace(i.canonical_code,'[^0-9]','','g') ~ '^11'
          THEN regexp_replace(i.canonical_code,'[^0-9]','','g') || '.SH'
        ELSE regexp_replace(i.canonical_code,'[^0-9]','','g') || '.SZ' END
        FROM core.instruments i
       WHERE i.asset_class IN ('stock','convertible_bond')
         AND regexp_replace(i.canonical_code,'[^0-9]','','g') ~ '^[0-9]{5,6}$';

      CREATE TEMP TABLE tmp_instrument_survivors(
        asset_class text NOT NULL,
        expected_code text NOT NULL,
        survivor_id bigint NOT NULL,
        PRIMARY KEY(asset_class,expected_code)
      ) ON COMMIT DROP;
      INSERT INTO tmp_instrument_survivors(asset_class,expected_code,survivor_id)
      SELECT asset_class,expected_code,(array_agg(instrument_id ORDER BY
        CASE WHEN canonical_code=expected_code THEN 0
             WHEN canonical_code ~ '^[0-9]{5,6}\\.(SH|SZ|BJ|HK)$' THEN 1
             ELSE 2 END,
        instrument_id))[1]
        FROM (
          SELECT e.asset_class,e.expected_code,e.instrument_id,i.canonical_code
            FROM tmp_instrument_expected e
            JOIN core.instruments i ON i.instrument_id=e.instrument_id
        ) ranked
       GROUP BY asset_class,expected_code;

      CREATE TEMP TABLE tmp_instrument_merge(old_id bigint PRIMARY KEY,target_id bigint NOT NULL) ON COMMIT DROP;
      INSERT INTO tmp_instrument_merge(old_id,target_id)
      SELECT e.instrument_id,s.survivor_id
        FROM tmp_instrument_expected e
        JOIN tmp_instrument_survivors s
          ON s.asset_class=e.asset_class AND s.expected_code=e.expected_code
       WHERE e.instrument_id<>s.survivor_id;

      CREATE TEMP TABLE tmp_removed_companies(company_id bigint PRIMARY KEY) ON COMMIT DROP;
      INSERT INTO tmp_removed_companies(company_id)
      SELECT DISTINCT ci.company_id FROM core.company_instruments ci
       WHERE ci.instrument_id IN (SELECT old_id FROM tmp_instrument_merge)
      ON CONFLICT DO NOTHING;

      DELETE FROM core.company_instruments
       WHERE instrument_id IN (SELECT old_id FROM tmp_instrument_merge);
      DELETE FROM core.instrument_merge_candidates
       WHERE duplicate_instrument_id IN (SELECT old_id FROM tmp_instrument_merge)
          OR primary_instrument_id IN (SELECT old_id FROM tmp_instrument_merge);
    `);

    // 所有引用证券主档的业务外键统一改到标准 ID；公司关系和候选表已按各自语义单独处理。
    await client.query(`
      DO $$ DECLARE r record;
      BEGIN
        FOR r IN
          SELECT n.nspname AS schema_name,t.relname AS table_name,a.attname AS column_name
            FROM pg_constraint c
            JOIN pg_class t ON t.oid=c.conrelid
            JOIN pg_namespace n ON n.oid=t.relnamespace
            JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=c.conkey[1]
           WHERE c.contype='f' AND c.confrelid='core.instruments'::regclass
             AND NOT (n.nspname='core' AND t.relname IN ('company_instruments','instrument_merge_candidates'))
        LOOP
          EXECUTE format('UPDATE %I.%I x SET %I=m.target_id FROM tmp_instrument_merge m WHERE x.%I=m.old_id',
                         r.schema_name,r.table_name,r.column_name,r.column_name);
        END LOOP;
      END $$;
      DELETE FROM core.instruments WHERE instrument_id IN (SELECT old_id FROM tmp_instrument_merge);
    `);

    // 删除明确无效的 nan / HTML 拼接主档；空缺的转债正股关系恢复为 NULL。
    await client.query(`
      CREATE TEMP TABLE tmp_invalid_instruments(instrument_id bigint PRIMARY KEY) ON COMMIT DROP;
      INSERT INTO tmp_invalid_instruments
      SELECT instrument_id FROM core.instruments
       WHERE lower(canonical_code)='nan.sh' OR lower(canonical_code) LIKE '%<br/>%';
      INSERT INTO tmp_removed_companies(company_id)
      SELECT DISTINCT company_id FROM core.company_instruments
       WHERE instrument_id IN (SELECT instrument_id FROM tmp_invalid_instruments)
      ON CONFLICT DO NOTHING;
      UPDATE fundamental.convertible_bond_profiles
         SET stock_instrument_id=NULL,updated_at=now()
       WHERE stock_instrument_id IN (SELECT instrument_id FROM tmp_invalid_instruments);
      DELETE FROM core.instrument_merge_candidates
       WHERE primary_instrument_id IN (SELECT instrument_id FROM tmp_invalid_instruments)
          OR duplicate_instrument_id IN (SELECT instrument_id FROM tmp_invalid_instruments);
      DELETE FROM core.company_instruments
       WHERE instrument_id IN (SELECT instrument_id FROM tmp_invalid_instruments);
      DELETE FROM core.instruments
       WHERE instrument_id IN (SELECT instrument_id FROM tmp_invalid_instruments);

      -- 先合并再改名，避免 canonical_code 的既有唯一约束阻止错误后缀归一化。
      UPDATE core.instruments i SET canonical_code=e.expected_code,updated_at=now()
        FROM tmp_instrument_expected e
        JOIN tmp_instrument_survivors s
          ON s.asset_class=e.asset_class AND s.expected_code=e.expected_code
       WHERE i.instrument_id=s.survivor_id AND i.canonical_code<>e.expected_code;

      UPDATE core.instruments SET
        market='CN',currency_code='CNY',
        exchange_code=CASE WHEN canonical_code LIKE '%.SH' THEN 'SSE'
                           WHEN canonical_code LIKE '%.SZ' THEN 'SZSE' ELSE 'BSE' END,
        updated_at=now()
       WHERE asset_class IN ('stock','convertible_bond') AND canonical_code ~ '^\\d{6}\\.(SH|SZ|BJ)$';
      UPDATE core.instruments SET market='HK',currency_code='HKD',exchange_code='HKEX',updated_at=now()
       WHERE asset_class='stock' AND canonical_code ~ '^\\d{5}\\.HK$';
    `);

    // 每只证券只保留一条 issued_by，公司优先级：官方 ts_code > 非回填 > migration122 回填。
    await client.query(`
      CREATE TEMP TABLE tmp_extra_company_relations(company_id bigint,instrument_id bigint,relation_type text) ON COMMIT DROP;
      INSERT INTO tmp_extra_company_relations
      SELECT company_id,instrument_id,relation_type FROM (
        SELECT ci.*,
               row_number() OVER (PARTITION BY ci.instrument_id,ci.relation_type ORDER BY
                 CASE WHEN c.raw_data->>'ts_code'=i.canonical_code THEN 0
                      WHEN c.raw_data->>'backfill'='migration122' THEN 2 ELSE 1 END,
                 ci.valid_from DESC NULLS LAST,ci.company_id) AS rn
          FROM core.company_instruments ci
          JOIN core.companies c ON c.company_id=ci.company_id
          JOIN core.instruments i ON i.instrument_id=ci.instrument_id
         WHERE ci.relation_type='issued_by'
      ) ranked WHERE rn>1;
      INSERT INTO tmp_removed_companies(company_id)
      SELECT DISTINCT company_id FROM tmp_extra_company_relations ON CONFLICT DO NOTHING;
      DELETE FROM core.company_instruments ci USING tmp_extra_company_relations x
       WHERE ci.company_id=x.company_id AND ci.instrument_id=x.instrument_id AND ci.relation_type=x.relation_type;
      DELETE FROM core.instrument_merge_candidates;

      DO $$ DECLARE r record;
      BEGIN
        FOR r IN SELECT company_id FROM tmp_removed_companies LOOP
          BEGIN
            DELETE FROM core.companies c WHERE c.company_id=r.company_id
              AND NOT EXISTS (SELECT 1 FROM core.company_instruments ci WHERE ci.company_id=c.company_id);
          EXCEPTION WHEN foreign_key_violation THEN NULL;
          END;
        END LOOP;
      END $$;

      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_instruments_stock_canonical') THEN
          ALTER TABLE core.instruments ADD CONSTRAINT chk_instruments_stock_canonical CHECK (
            asset_class<>'stock' OR upper(market) NOT IN ('CN','HK') OR
            (upper(market)='CN' AND canonical_code ~ '^\\d{6}\\.(SH|SZ|BJ)$') OR
            (upper(market)='HK' AND canonical_code ~ '^\\d{5}\\.HK$'));
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_instruments_cb_canonical') THEN
          ALTER TABLE core.instruments ADD CONSTRAINT chk_instruments_cb_canonical CHECK (
            asset_class<>'convertible_bond' OR upper(market)<>'CN' OR canonical_code ~ '^\\d{6}\\.(SH|SZ)$');
        END IF;
      END $$;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_instruments_numeric_identity
        ON core.instruments(asset_class,(regexp_replace(canonical_code,'\\D','','g')))
       WHERE (asset_class='stock' AND canonical_code ~ '^\\d{5,6}\\.(SH|SZ|BJ|HK)$')
          OR (asset_class='convertible_bond' AND canonical_code ~ '^\\d{6}\\.(SH|SZ)$');
    `);

    const checks = await client.query(`
      SELECT
        (SELECT count(*) FROM (
          SELECT asset_class,regexp_replace(canonical_code,'\\D','','g') digits
            FROM core.instruments
           WHERE (asset_class='stock' AND canonical_code ~ '^\\d{5,6}\\.(SH|SZ|BJ|HK)$')
              OR (asset_class='convertible_bond' AND canonical_code ~ '^\\d{6}\\.(SH|SZ)$')
           GROUP BY asset_class,digits HAVING count(*)>1) d) AS duplicate_groups,
        (SELECT count(*) FROM core.instruments WHERE lower(canonical_code)='nan.sh' OR lower(canonical_code) LIKE '%<br/>%') AS invalid_rows,
        (SELECT count(*) FROM (SELECT instrument_id FROM core.company_instruments WHERE relation_type='issued_by' GROUP BY instrument_id HAVING count(*)>1) c) AS duplicate_companies,
        (SELECT count(*) FROM core.instrument_merge_candidates) AS pending_candidates
    `);
    const failed = Object.entries(checks.rows[0]).filter(([, value]) => Number(value) !== 0);
    if (failed.length) throw new Error('证券主档收敛验收失败：' + failed.map(([key, value]) => `${key}=${value}`).join(','));
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// ========== 126：正股代码后缀冲突校验 =============
// bond_unified 的历史兜底函数也必须遵守统一市场规则，不能直接信任输入后缀。
async function migration126NormalizeStockCodeSuffix() {
  await pool.query(`
    CREATE OR REPLACE FUNCTION normalize_stock_code(raw TEXT) RETURNS TEXT AS $$
      WITH value AS (
        SELECT upper(btrim(raw)) AS text
      ), digits AS (
        SELECT text,regexp_replace(text,'[^0-9]','','g') AS code FROM value
      )
      SELECT CASE
        WHEN raw IS NULL OR text='' THEN NULL
        WHEN text ~ '^(SH|SZ|BJ|HK)?[0-9]{5}(\\.(SH|SZ|BJ|HK))?$'
          THEN lpad(code,5,'0') || '.HK'
        WHEN text ~ '^(SH|SZ|BJ|HK)?[0-9]{6}(\\.(SH|SZ|BJ|HK))?$'
          THEN code || CASE
            WHEN code ~ '^(4|8|92)' THEN '.BJ'
            WHEN code ~ '^(6|9)' THEN '.SH'
            ELSE '.SZ' END
        ELSE text
      END
      FROM digits;
    $$ LANGUAGE sql IMMUTABLE;
  `);
}

// ========== 127：来源＋接口＋凭据策略与精确调用计数 =============
// 策略、运行状态和计数分离：策略是可维护配置，运行状态只保存最小间隔，
// 预算表保存每次真实请求的精确计数。Node/Python 均只能调用 reserve_external_call，
// 不允许从调用方传入限额，避免“表里有配置、运行时仍按旧默认值限流”。
async function migration127SourceEndpointPolicies() {
  await pool.query(`
    INSERT INTO ops.data_sources(source_code,source_name,source_type,priority) VALUES
      ('exchange-rate','汇率接口','official',20),
      ('chinabond','中债收益率','official',20),
      ('csindex','中证指数','official',20),
      ('hsi-official','恒生指数','official',20),
      ('stock-analysis','个股分析接口','official',20),
      ('bond-safety','可转债安全性接口','official',20),
      ('hkex','港交所披露易','official',10)
    ON CONFLICT(source_code) DO UPDATE SET
      source_name=EXCLUDED.source_name,source_type=EXCLUDED.source_type,
      priority=EXCLUDED.priority;

    CREATE TABLE IF NOT EXISTS ops.source_endpoint_policies (
      policy_id BIGSERIAL PRIMARY KEY,
      source_id SMALLINT NOT NULL REFERENCES ops.data_sources(source_id) ON DELETE CASCADE,
      api_name TEXT NOT NULL CHECK (api_name='*' OR api_name ~ '^[A-Za-z0-9_.:-]{1,64}$'),
      credential_profile TEXT NOT NULL DEFAULT 'anonymous'
        CHECK (credential_profile IN ('primary','backup','anonymous')),
      credential_fingerprint TEXT NOT NULL DEFAULT 'none',
      points_required INTEGER CHECK (points_required IS NULL OR points_required >= 0),
      permission_mode TEXT NOT NULL DEFAULT 'unknown',
      permission_status TEXT NOT NULL DEFAULT 'unknown'
        CHECK (permission_status IN ('unknown','available','permission_denied','rate_limited','not_configured','empty_but_accepted','error')),
      official_per_minute_limit INTEGER CHECK (official_per_minute_limit IS NULL OR official_per_minute_limit > 0),
      official_daily_limit INTEGER CHECK (official_daily_limit IS NULL OR official_daily_limit > 0),
      internal_per_minute_limit INTEGER CHECK (internal_per_minute_limit IS NULL OR internal_per_minute_limit > 0),
      internal_daily_limit INTEGER CHECK (internal_daily_limit IS NULL OR internal_daily_limit > 0),
      max_concurrency INTEGER NOT NULL DEFAULT 1 CHECK (max_concurrency > 0),
      min_interval_ms INTEGER NOT NULL DEFAULT 0 CHECK (min_interval_ms >= 0),
      row_limit INTEGER CHECK (row_limit IS NULL OR row_limit > 0),
      timeout_ms INTEGER NOT NULL DEFAULT 30000 CHECK (timeout_ms > 0),
      empty_policy TEXT NOT NULL DEFAULT 'preserve_last_success',
      retry_policy JSONB NOT NULL DEFAULT '{"max_attempts":1,"backoff_ms":0,"jitter_ms":0,"retry_on":[]}'::jsonb,
      official_doc_url TEXT,
      enabled BOOLEAN NOT NULL DEFAULT true,
      last_verified_at TIMESTAMPTZ,
      verification_message TEXT,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(source_id,api_name,credential_profile)
    );
    CREATE INDEX IF NOT EXISTS idx_source_endpoint_policies_lookup
      ON ops.source_endpoint_policies(source_id,credential_profile,api_name);
    CREATE INDEX IF NOT EXISTS idx_source_endpoint_policies_enabled
      ON ops.source_endpoint_policies(enabled,source_id);

    CREATE TABLE IF NOT EXISTS ops.source_endpoint_runtime (
      source_id SMALLINT NOT NULL REFERENCES ops.data_sources(source_id) ON DELETE CASCADE,
      api_name TEXT NOT NULL,
      credential_fingerprint TEXT NOT NULL DEFAULT 'none',
      next_allowed_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY(source_id,api_name,credential_fingerprint)
    );

    ALTER TABLE ops.external_call_budgets
      ADD COLUMN IF NOT EXISTS api_name TEXT NOT NULL DEFAULT '*',
      ADD COLUMN IF NOT EXISTS credential_profile TEXT NOT NULL DEFAULT 'legacy',
      ADD COLUMN IF NOT EXISTS credential_fingerprint TEXT NOT NULL DEFAULT 'legacy',
      ADD COLUMN IF NOT EXISTS policy_id BIGINT REFERENCES ops.source_endpoint_policies(policy_id) ON DELETE SET NULL;
    ALTER TABLE ops.external_call_budgets ALTER COLUMN budget_limit DROP NOT NULL;
    ALTER TABLE ops.external_call_budgets DROP CONSTRAINT IF EXISTS external_call_budgets_pkey;
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='external_call_budgets_dimensional_pkey') THEN
        ALTER TABLE ops.external_call_budgets
          ADD CONSTRAINT external_call_budgets_dimensional_pkey
          PRIMARY KEY(source,api_name,credential_fingerprint,window_type,window_key);
      END IF;
    END $$;
    CREATE INDEX IF NOT EXISTS idx_external_call_budgets_credential_window
      ON ops.external_call_budgets(source,credential_fingerprint,window_type,window_key);
    CREATE INDEX IF NOT EXISTS idx_external_call_budgets_api_window
      ON ops.external_call_budgets(source,api_name,window_type,window_key);

    -- 先写来源级通配策略（不设置内部限额），再写 Tushare 主/备和已知接口策略；不覆盖管理员已改配置。
    WITH defaults(source_code,minute_limit,day_limit) AS (
      VALUES
        ('tencent',NULL::integer,NULL::integer),('cninfo',NULL::integer,NULL::integer),
        ('tushare',NULL::integer,NULL::integer),
        ('exchange-rate',NULL::integer,NULL::integer),('chinabond',NULL::integer,NULL::integer),('csindex',NULL::integer,NULL::integer),
        ('hsi-official',NULL::integer,NULL::integer),('stock-analysis',NULL::integer,NULL::integer),('bond-safety',NULL::integer,NULL::integer),
        ('hkex',NULL::integer,NULL::integer),('sse',NULL::integer,NULL::integer),('szse',NULL::integer,NULL::integer),('eastmoney',NULL::integer,NULL::integer),
        ('sina',NULL::integer,NULL::integer),('xueqiu',NULL::integer,NULL::integer),('guba',NULL::integer,NULL::integer)
    )
    INSERT INTO ops.source_endpoint_policies
      (source_id,api_name,credential_profile,internal_per_minute_limit,internal_daily_limit,
       max_concurrency,min_interval_ms,timeout_ms,official_doc_url)
    SELECT ds.source_id,'*','anonymous',d.minute_limit,d.day_limit,1,0,30000,
           CASE WHEN d.source_code='tushare' THEN 'https://tushare.pro/document/1?doc_id=108' ELSE NULL END
      FROM defaults d JOIN ops.data_sources ds ON ds.source_code=d.source_code
    ON CONFLICT(source_id,api_name,credential_profile) DO NOTHING;

    INSERT INTO ops.source_endpoint_policies
      (source_id,api_name,credential_profile,internal_per_minute_limit,internal_daily_limit,
       max_concurrency,min_interval_ms,timeout_ms,official_doc_url)
    SELECT ds.source_id,'*',p.profile,NULL,NULL,3,0,30000,'https://tushare.pro/document/1?doc_id=108'
      FROM ops.data_sources ds
      CROSS JOIN (VALUES ('primary'),('backup')) p(profile)
     WHERE ds.source_code='tushare'
    ON CONFLICT(source_id,api_name,credential_profile) DO NOTHING;

    INSERT INTO ops.source_endpoint_policies
      (source_id,api_name,credential_profile,official_doc_url)
    SELECT ds.source_id,a.api_name,p.profile,'https://tushare.pro/document/1?doc_id=108'
      FROM ops.data_sources ds
      CROSS JOIN (VALUES
        ('trade_cal'),('stock_basic'),('daily'),('daily_basic'),('adj_factor'),
        ('income'),('balancesheet'),('cashflow'),('fina_indicator'),('forecast'),
        ('dividend'),('rt_min'),('new_share'),('cb_basic'),('cb_daily'),('cb_issue'),
        ('cb_price_chg'),('cb_rating'),('index_daily'),('index_dailybasic'),
        ('index_member_all'),('top10_cb_holders'),('pledge_stat'),('hk_basic'),
        ('cn_m'),('us_tycr'),('fina_mainbz'),('stock_company'),('anns_d'),
        ('cb_rate'),('disclosure_date'),('suspend_d')
      ) a(api_name)
      CROSS JOIN (VALUES ('primary'),('backup')) p(profile)
     WHERE ds.source_code='tushare'
    ON CONFLICT(source_id,api_name,credential_profile) DO NOTHING;

    CREATE OR REPLACE FUNCTION ops.reserve_external_call(
      p_source TEXT,
      p_api_name TEXT,
      p_credential_profile TEXT,
      p_credential_fingerprint TEXT
    )
    RETURNS TABLE(
      allowed BOOLEAN,
      reason TEXT,
      wait_until TIMESTAMPTZ,
      policy_id BIGINT,
      day_count INTEGER,
      minute_count INTEGER,
      effective_daily_limit INTEGER,
      effective_minute_limit INTEGER,
      timeout_ms INTEGER,
      retry_policy JSONB,
      empty_policy TEXT,
      concurrency_slot INTEGER
    )
    LANGUAGE plpgsql
    AS $fn$
    DECLARE
      v_source TEXT := NULLIF(BTRIM(p_source),'');
      v_api TEXT := LEFT(COALESCE(NULLIF(BTRIM(p_api_name),''),'*'),64);
      v_profile TEXT := CASE WHEN p_credential_profile IN ('primary','backup','anonymous') THEN p_credential_profile ELSE 'anonymous' END;
      v_fingerprint TEXT := COALESCE(NULLIF(BTRIM(p_credential_fingerprint),''),'none');
      v_source_id SMALLINT;
      v_exact ops.source_endpoint_policies%ROWTYPE;
      v_base ops.source_endpoint_policies%ROWTYPE;
      v_policy_id BIGINT;
      v_enabled BOOLEAN;
      v_permission TEXT;
      v_minute_limit INTEGER;
      v_day_limit INTEGER;
      v_credential_minute_limit INTEGER;
      v_credential_day_limit INTEGER;
      v_official_minute INTEGER;
      v_official_day INTEGER;
      v_concurrency INTEGER;
      v_interval INTEGER;
      v_timeout INTEGER;
      v_retry JSONB;
      v_empty TEXT;
      v_day_key TEXT;
      v_minute_key TEXT;
      v_next TIMESTAMPTZ;
      v_day_count INTEGER := 0;
      v_minute_count INTEGER := 0;
      v_credential_day_count INTEGER := 0;
      v_credential_minute_count INTEGER := 0;
      v_slot INTEGER := NULL;
      v_lock_key TEXT;
      v_i INTEGER;
    BEGIN
      IF v_source IS NULL THEN
        RETURN QUERY SELECT false,'policy_missing',NULL::timestamptz,NULL::bigint,0,0,NULL::integer,NULL::integer,30000,'{}'::jsonb,'preserve_last_success',NULL::integer;
        RETURN;
      END IF;
      SELECT source_id INTO v_source_id FROM ops.data_sources WHERE source_code=v_source AND enabled=true;
      IF v_source_id IS NULL THEN
        RETURN QUERY SELECT false,'policy_missing',NULL::timestamptz,NULL::bigint,0,0,NULL::integer,NULL::integer,30000,'{}'::jsonb,'preserve_last_success',NULL::integer;
        RETURN;
      END IF;
      SELECT * INTO v_base FROM ops.source_endpoint_policies
       WHERE source_id=v_source_id AND api_name='*' AND credential_profile=v_profile;
      SELECT * INTO v_exact FROM ops.source_endpoint_policies
       WHERE source_id=v_source_id AND api_name=v_api AND credential_profile=v_profile;
      IF v_base.policy_id IS NULL AND v_exact.policy_id IS NULL THEN
        RETURN QUERY SELECT false,'policy_missing',NULL::timestamptz,NULL::bigint,0,0,NULL::integer,NULL::integer,30000,'{}'::jsonb,'preserve_last_success',NULL::integer;
        RETURN;
      END IF;
      v_policy_id := COALESCE(v_exact.policy_id,v_base.policy_id);
      v_enabled := COALESCE(v_exact.enabled,v_base.enabled,false);
      v_permission := COALESCE(NULLIF(v_exact.permission_status,''),NULLIF(v_base.permission_status,''),'unknown');
      IF NOT v_enabled THEN
        RETURN QUERY SELECT false,'policy_disabled',NULL::timestamptz,v_policy_id,0,0,NULL::integer,NULL::integer,30000,'{}'::jsonb,'preserve_last_success',NULL::integer;
        RETURN;
      END IF;
      IF v_permission IN ('permission_denied','not_configured') THEN
        RETURN QUERY SELECT false,'permission_denied',NULL::timestamptz,v_policy_id,0,0,NULL::integer,NULL::integer,30000,'{}'::jsonb,'preserve_last_success',NULL::integer;
        RETURN;
      END IF;
      v_minute_limit := COALESCE(v_exact.internal_per_minute_limit,v_base.internal_per_minute_limit);
      v_day_limit := COALESCE(v_exact.internal_daily_limit,v_base.internal_daily_limit);
      v_official_minute := COALESCE(v_exact.official_per_minute_limit,v_base.official_per_minute_limit);
      v_official_day := COALESCE(v_exact.official_daily_limit,v_base.official_daily_limit);
      IF v_official_minute IS NOT NULL AND (v_minute_limit IS NULL OR v_minute_limit > v_official_minute) THEN v_minute_limit := v_official_minute; END IF;
      IF v_official_day IS NOT NULL AND (v_day_limit IS NULL OR v_day_limit > v_official_day) THEN v_day_limit := v_official_day; END IF;
      v_credential_minute_limit := COALESCE(v_base.internal_per_minute_limit,v_minute_limit);
      v_credential_day_limit := COALESCE(v_base.internal_daily_limit,v_day_limit);
      IF v_official_minute IS NOT NULL AND (v_credential_minute_limit IS NULL OR v_credential_minute_limit > v_official_minute) THEN v_credential_minute_limit := v_official_minute; END IF;
      IF v_official_day IS NOT NULL AND (v_credential_day_limit IS NULL OR v_credential_day_limit > v_official_day) THEN v_credential_day_limit := v_official_day; END IF;
      v_concurrency := COALESCE(v_exact.max_concurrency,v_base.max_concurrency,1);
      v_interval := COALESCE(v_exact.min_interval_ms,v_base.min_interval_ms,0);
      v_timeout := COALESCE(v_exact.timeout_ms,v_base.timeout_ms,30000);
      v_retry := COALESCE(v_exact.retry_policy,v_base.retry_policy,'{}'::jsonb);
      v_empty := COALESCE(v_exact.empty_policy,v_base.empty_policy,'preserve_last_success');

      PERFORM pg_advisory_xact_lock(hashtextextended('external_budget:'||v_source||':'||v_fingerprint,0));
      v_day_key := to_char(clock_timestamp() AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD');
      v_minute_key := floor(extract(epoch FROM clock_timestamp())/60)::bigint::text;
      INSERT INTO ops.source_endpoint_runtime(source_id,api_name,credential_fingerprint)
        VALUES(v_source_id,v_api,v_fingerprint)
        ON CONFLICT(source_id,api_name,credential_fingerprint) DO NOTHING;
      SELECT next_allowed_at INTO v_next FROM ops.source_endpoint_runtime
       WHERE source_id=v_source_id AND api_name=v_api AND credential_fingerprint=v_fingerprint FOR UPDATE;
      IF v_next IS NOT NULL AND v_next > clock_timestamp() THEN
        RETURN QUERY SELECT false,'interval',v_next,v_policy_id,0,0,v_day_limit,v_minute_limit,v_timeout,v_retry,v_empty,NULL::integer;
        RETURN;
      END IF;
      SELECT COALESCE(call_count,0) INTO v_day_count FROM ops.external_call_budgets
       WHERE source=v_source AND api_name=v_api AND credential_fingerprint=v_fingerprint AND window_type='day' AND window_key=v_day_key FOR UPDATE;
      SELECT COALESCE(call_count,0) INTO v_minute_count FROM ops.external_call_budgets
       WHERE source=v_source AND api_name=v_api AND credential_fingerprint=v_fingerprint AND window_type='minute' AND window_key=v_minute_key FOR UPDATE;
      v_day_count := COALESCE(v_day_count,0);
      v_minute_count := COALESCE(v_minute_count,0);
      SELECT COALESCE(SUM(call_count),0)::integer INTO v_credential_day_count FROM ops.external_call_budgets
       WHERE source=v_source AND credential_fingerprint=v_fingerprint AND api_name<>'*' AND window_type='day' AND window_key=v_day_key;
      SELECT COALESCE(SUM(call_count),0)::integer INTO v_credential_minute_count FROM ops.external_call_budgets
       WHERE source=v_source AND credential_fingerprint=v_fingerprint AND api_name<>'*' AND window_type='minute' AND window_key=v_minute_key;
      IF v_minute_limit IS NOT NULL AND v_minute_count >= v_minute_limit THEN
        RETURN QUERY SELECT false,'minute',NULL::timestamptz,v_policy_id,v_day_count,v_minute_count,v_day_limit,v_minute_limit,v_timeout,v_retry,v_empty,NULL::integer;
        RETURN;
      END IF;
      IF v_day_limit IS NOT NULL AND v_day_count >= v_day_limit THEN
        RETURN QUERY SELECT false,'day',NULL::timestamptz,v_policy_id,v_day_count,v_minute_count,v_day_limit,v_minute_limit,v_timeout,v_retry,v_empty,NULL::integer;
        RETURN;
      END IF;
      IF v_credential_minute_limit IS NOT NULL AND v_credential_minute_count >= v_credential_minute_limit THEN
        RETURN QUERY SELECT false,'credential_minute',NULL::timestamptz,v_policy_id,v_day_count,v_minute_count,v_credential_day_limit,v_credential_minute_limit,v_timeout,v_retry,v_empty,NULL::integer;
        RETURN;
      END IF;
      IF v_credential_day_limit IS NOT NULL AND v_credential_day_count >= v_credential_day_limit THEN
        RETURN QUERY SELECT false,'credential_day',NULL::timestamptz,v_policy_id,v_day_count,v_minute_count,v_credential_day_limit,v_credential_minute_limit,v_timeout,v_retry,v_empty,NULL::integer;
        RETURN;
      END IF;
      FOR v_i IN 0..(v_concurrency-1) LOOP
        v_lock_key := 'external_slot:'||v_source||':'||v_api||':'||v_fingerprint||':'||v_i;
        IF pg_try_advisory_lock(hashtextextended(v_lock_key,0)) THEN v_slot := v_i; EXIT; END IF;
      END LOOP;
      IF v_slot IS NULL THEN
        RETURN QUERY SELECT false,'concurrency',clock_timestamp()+interval '1 second',v_policy_id,v_day_count,v_minute_count,v_day_limit,v_minute_limit,v_timeout,v_retry,v_empty,NULL::integer;
        RETURN;
      END IF;
      INSERT INTO ops.external_call_budgets(source,api_name,credential_profile,credential_fingerprint,window_type,window_key,call_count,budget_limit,policy_id)
        VALUES(v_source,v_api,v_profile,v_fingerprint,'day',v_day_key,1,v_day_limit,v_policy_id)
        ON CONFLICT(source,api_name,credential_fingerprint,window_type,window_key) DO UPDATE SET
          call_count=ops.external_call_budgets.call_count+1,credential_profile=EXCLUDED.credential_profile,
          budget_limit=EXCLUDED.budget_limit,policy_id=EXCLUDED.policy_id,updated_at=now();
      INSERT INTO ops.external_call_budgets(source,api_name,credential_profile,credential_fingerprint,window_type,window_key,call_count,budget_limit,policy_id)
        VALUES(v_source,v_api,v_profile,v_fingerprint,'minute',v_minute_key,1,v_minute_limit,v_policy_id)
        ON CONFLICT(source,api_name,credential_fingerprint,window_type,window_key) DO UPDATE SET
          call_count=ops.external_call_budgets.call_count+1,credential_profile=EXCLUDED.credential_profile,
          budget_limit=EXCLUDED.budget_limit,policy_id=EXCLUDED.policy_id,updated_at=now();
      UPDATE ops.source_endpoint_runtime
         SET next_allowed_at=CASE WHEN v_interval>0 THEN clock_timestamp()+(v_interval*interval '1 millisecond') ELSE NULL END,
             updated_at=now()
       WHERE source_id=v_source_id AND api_name=v_api AND credential_fingerprint=v_fingerprint;
      RETURN QUERY SELECT true,'allowed',NULL::timestamptz,v_policy_id,v_day_count+1,v_minute_count+1,v_day_limit,v_minute_limit,v_timeout,v_retry,v_empty,v_slot;
    EXCEPTION WHEN OTHERS THEN
      IF v_slot IS NOT NULL THEN
        PERFORM pg_advisory_unlock(hashtextextended('external_slot:'||v_source||':'||v_api||':'||v_fingerprint||':'||v_slot,0));
      END IF;
      RAISE;
    END;
    $fn$;
  `);
}

// ========== 128：Tushare 双账号能力分级与官方文档规则 =============
// 主账号 6000 积分、备用账号 2000 积分分别按官方频率/权限表配置；
// 来源级通配策略不设置内部总量，具体接口如有核验限制才写入对应 api_name。
async function migration128TushareDualAccountPolicy() {
  await pool.query(`
    UPDATE ops.source_endpoint_policies p
       SET points_required=6000, permission_mode='points',
           official_per_minute_limit=500, official_daily_limit=NULL,
           internal_per_minute_limit=NULL, internal_daily_limit=NULL,
           max_concurrency=3,
           notes='主 Tushare 账号：6000积分；官方规则仅按具体接口策略执行，来源级不设内部总量'
      FROM ops.data_sources ds
     WHERE p.source_id=ds.source_id AND ds.source_code='tushare'
       AND p.api_name='*' AND p.credential_profile='primary';

    UPDATE ops.source_endpoint_policies p
       SET points_required=2000, permission_mode='points',
           official_per_minute_limit=200, official_daily_limit=100000,
           internal_per_minute_limit=NULL, internal_daily_limit=NULL,
           max_concurrency=2,
           notes='备用 Tushare 账号：2000积分；官方规则仅按具体接口策略执行，来源级不设内部总量'
      FROM ops.data_sources ds
     WHERE p.source_id=ds.source_id AND ds.source_code='tushare'
       AND p.api_name='*' AND p.credential_profile='backup';

    UPDATE ops.source_endpoint_policies p
       SET enabled=false,
           notes='历史匿名 Tushare 策略已停用；运行时必须明确使用6000积分主账号或2000积分备用账号'
      FROM ops.data_sources ds
     WHERE p.source_id=ds.source_id AND ds.source_code='tushare'
       AND p.api_name='*' AND p.credential_profile='anonymous';

    WITH rules(api_name,points_required,official_per_minute_limit,row_limit,official_doc_url,
               primary_minute,backup_minute,primary_enabled,backup_enabled,notes) AS (
      VALUES
        ('trade_cal',2000,NULL::integer,NULL::integer,'https://tushare.pro/document/2?doc_id=26',450,180,true,true,'官方最低2000积分，频率按积分档位保护'),
        ('stock_basic',2000,50,6000,'https://tushare.pro/document/1?doc_id=25',45,45,true,true,'官方每次最多6000行、50次/分钟'),
        ('daily',120,NULL,6000,'https://tushare.pro/document/1?doc_id=27',450,180,true,true,'官方最低120积分、每次最多6000行，分钟规则按积分档位'),
        ('daily_basic',2000,NULL,6000,'https://tushare.pro/document/2?doc_id=32',450,180,true,true,'官方页面注明5000积分以上无总量限制；备用账号仍受内部日止损'),
        ('adj_factor',NULL,NULL,6000,'https://tushare.pro/document/1?doc_id=28',450,180,true,true,'官方页面未公布独立频率，沿用积分档位保护'),
        ('income',2000,NULL,NULL,NULL,450,180,true,true,'官方权限按接口核验'),
        ('income_vip',5000,500,NULL,'https://tushare.pro/document/2?doc_id=33',450,180,true,false,'官方完整版财务接口要求5000积分，2000积分备用账号不得调用'),
        ('balancesheet',2000,NULL,NULL,NULL,450,180,true,true,'官方权限按接口核验'),
        ('balancesheet_vip',5000,500,NULL,'https://tushare.pro/document/2?doc_id=36',450,180,true,false,'官方完整版财务接口要求5000积分，2000积分备用账号不得调用'),
        ('cashflow',2000,NULL,NULL,'https://tushare.pro/document/2?doc_id=44',450,180,true,true,'官方权限按接口核验'),
        ('cashflow_vip',5000,500,NULL,'https://tushare.pro/document/2?doc_id=44',450,180,true,false,'官方完整版财务接口要求5000积分，2000积分备用账号不得调用'),
        ('fina_indicator',2000,NULL,NULL,'https://tushare.pro/document/2?doc_id=79',450,180,true,true,'官方单只股票最多100行，至少2000积分'),
        ('fina_indicator_vip',5000,500,NULL,'https://tushare.pro/document/2?doc_id=79',450,180,true,false,'官方完整版财务接口要求5000积分，2000积分备用账号不得调用'),
        ('forecast',2000,NULL,NULL,NULL,450,180,true,true,'官方权限按接口核验'),
        ('dividend',2000,NULL,NULL,NULL,450,180,true,true,'官方权限按接口核验'),
        ('new_share',120,NULL,2000,'https://tushare.pro/document/2?doc_id=123',450,180,true,true,'官方每次最多2000行，最低120积分'),
        ('cb_basic',2000,NULL,2000,'https://tushare.pro/document/2?doc_id=185',450,180,true,true,'官方每次最多2000行，最低2000积分'),
        ('cb_daily',2000,NULL,2000,'https://tushare.pro/document/2?doc_id=187',450,180,true,true,'官方每次最多2000行，最低2000积分'),
        ('cb_issue',2000,NULL,2000,'https://tushare.pro/document/2?doc_id=186',450,180,true,true,'官方每次最多2000行，最低2000积分'),
        ('cb_rating',2000,NULL,3000,'https://tushare.pro/document/2?doc_id=458',450,180,true,true,'官方每次最多3000行，最低2000积分'),
        ('index_daily',2000,NULL,NULL,'https://tushare.pro/document/1?doc_id=95',450,180,true,true,'官方权限按接口核验'),
        ('index_dailybasic',4000,NULL,3000,'https://tushare.pro/document/2?doc_id=128',450,NULL,true,false,'官方权限矩阵要求4000积分，2000积分备用账号不得调用'),
        ('index_member_all',2000,NULL,2000,'https://tushare.pro/document/2?doc_id=335',450,180,true,true,'官方单次最多2000行，最低2000积分'),
        ('pledge_stat',2000,NULL,1000,'https://tushare.pro/document/2?doc_id=110',450,180,true,true,'官方每次最多1000行，最低2000积分'),
        ('top10_cb_holders',5000,NULL,3000,'https://tushare.pro/document/2?doc_id=342',30,NULL,true,false,'官方最低5000积分；30次/分钟为生产实测内部保护，官方页面未公布独立频率'),
        ('hk_basic',2000,NULL,NULL,NULL,450,180,true,true,'官方权限按接口核验'),
        ('cn_m',2000,NULL,NULL,'https://tushare.pro/document/2?doc_id=314',450,180,true,true,'官方权限按接口核验'),
        ('us_tycr',2000,NULL,NULL,'https://tushare.pro/document/2?doc_id=313',450,180,true,true,'官方权限按接口核验'),
        ('fina_mainbz',2000,NULL,100,'https://tushare.pro/document/2?doc_id=81',450,180,true,true,'官方单次最多100行，至少2000积分'),
        ('stock_company',120,NULL,NULL,'https://tushare.pro/document/2?doc_id=112',450,180,true,true,'官方单次最多4500条，最低120积分'),
        ('suspend_d',2000,NULL,NULL,'https://tushare.pro/document/2?doc_id=214',450,180,true,true,'官方权限按接口核验')
    )
    INSERT INTO ops.source_endpoint_policies
      (source_id,api_name,credential_profile,points_required,permission_mode,
       official_per_minute_limit,official_daily_limit,internal_per_minute_limit,internal_daily_limit,
       max_concurrency,min_interval_ms,row_limit,timeout_ms,empty_policy,retry_policy,official_doc_url,enabled,notes)
    SELECT ds.source_id,r.api_name,p.profile,r.points_required,'points',r.official_per_minute_limit,
           CASE WHEN p.profile='backup' THEN 100000 ELSE NULL END,
           CASE WHEN p.profile='primary' THEN r.primary_minute ELSE r.backup_minute END,
           CASE WHEN p.profile='backup' THEN 90000 ELSE NULL END,
           CASE WHEN p.profile='primary' THEN 3 ELSE 2 END,0,r.row_limit,30000,'preserve_last_success',
           '{"max_attempts":1,"backoff_ms":0,"jitter_ms":0,"retry_on":[]}'::jsonb,r.official_doc_url,
           CASE WHEN p.profile='primary' THEN r.primary_enabled ELSE r.backup_enabled END,r.notes
      FROM ops.data_sources ds
      CROSS JOIN rules r
      CROSS JOIN (VALUES ('primary'),('backup')) p(profile)
     WHERE ds.source_code='tushare'
    ON CONFLICT(source_id,api_name,credential_profile) DO UPDATE SET
      points_required=EXCLUDED.points_required,permission_mode=EXCLUDED.permission_mode,
      official_per_minute_limit=EXCLUDED.official_per_minute_limit,official_daily_limit=EXCLUDED.official_daily_limit,
      internal_per_minute_limit=EXCLUDED.internal_per_minute_limit,internal_daily_limit=EXCLUDED.internal_daily_limit,
      max_concurrency=EXCLUDED.max_concurrency,row_limit=EXCLUDED.row_limit,official_doc_url=EXCLUDED.official_doc_url,
      enabled=CASE WHEN ops.source_endpoint_policies.permission_status IN ('permission_denied','not_configured')
                   THEN false ELSE EXCLUDED.enabled END,
      notes=EXCLUDED.notes,updated_at=now();

    UPDATE ops.source_endpoint_policies p
       SET internal_per_minute_limit=NULL,internal_daily_limit=NULL,
           notes='巨潮来源级不设置内部限额；真实接口异常按具体接口熔断'
      FROM ops.data_sources ds
     WHERE p.source_id=ds.source_id AND ds.source_code='cninfo'
       AND p.api_name='*' AND p.credential_profile='anonymous';

    UPDATE ops.source_endpoint_policies p
       SET internal_per_minute_limit=NULL,internal_daily_limit=NULL,min_interval_ms=3600000,
           official_doc_url='https://www.exchangerate-api.com/docs/free',
           notes='官方免费接口每日更新；文档建议每24小时请求一次，异常429按20分钟退避'
      FROM ops.data_sources ds
     WHERE p.source_id=ds.source_id AND ds.source_code='exchange-rate'
       AND p.api_name='*' AND p.credential_profile='anonymous';
  `);
}

// ========== 129：Tushare 双账号策略修复重放 =============
// 迁移128发布后发现部分环境可能已登记旧版128，重放同一组幂等策略，
// 确保四个财务VIP接口、匿名旧策略和主备额度在升级后最终一致。
async function migration129TushareDualAccountPolicyRepair() {
  await migration128TushareDualAccountPolicy();
}

// ========== 130：Tushare VIP策略字段补齐 =============
// 已登记128/129的环境也必须补齐VIP接口的官方频率与主备内部保护，
// 即使后台误操作重新启用备用VIP接口，也不能失去分钟级止损。
async function migration130TushareVipBackupMinuteLimit() {
  await pool.query(`
    UPDATE ops.source_endpoint_policies p
       SET points_required=5000,
           official_per_minute_limit=500,
           official_daily_limit=CASE WHEN p.credential_profile='backup' THEN 100000 ELSE NULL END,
           internal_per_minute_limit=CASE WHEN p.credential_profile='backup' THEN 180 ELSE 450 END,
           internal_daily_limit=CASE WHEN p.credential_profile='backup' THEN 90000 ELSE NULL END,
           enabled=CASE WHEN p.credential_profile='backup' THEN false ELSE p.enabled END,
           updated_at=now()
      FROM ops.data_sources ds
     WHERE p.source_id=ds.source_id
       AND ds.source_code='tushare'
       AND p.api_name IN ('income_vip','balancesheet_vip','cashflow_vip','fina_indicator_vip')
       AND p.credential_profile IN ('primary','backup');
  `);
}

// ========== 131：IPO业务下游暴露与风口校准字段 =============
// 保存招股书提取出的产品→下游证据，风口校准仍沿用原 sector_heat 表，
// 避免把宽泛行业词误当成当前热点，也便于历史预测追溯。
async function migration131IpoSectorExposureCalibration() {
  await pool.query(`
    ALTER TABLE ipo_history
      ADD COLUMN IF NOT EXISTS business_exposure JSONB NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE predictions
      ADD COLUMN IF NOT EXISTS base_pred_return REAL,
      ADD COLUMN IF NOT EXISTS sector_adjustment_pp REAL,
      ADD COLUMN IF NOT EXISTS sector_multiplier REAL,
      ADD COLUMN IF NOT EXISTS sector_confidence REAL,
      ADD COLUMN IF NOT EXISTS prediction_context JSONB NOT NULL DEFAULT '{}'::jsonb;
    CREATE INDEX IF NOT EXISTS idx_ipo_history_business_exposure
      ON ipo_history USING gin (business_exposure);
  `);
}

// ========== 134：财务增量同步与安全性快照发布门禁 =============
// 财务报告补齐公告日、报表类型和原始版本字段；安全性快照只允许通过质量门禁的
// 记录进入 published，历史全量未评级结果改为 rejected，读取端动态回退上一份有效快照。
async function migration134CompanyFinancialIncrementalSync() {
  await pool.query(`
    ALTER TABLE fundamental.financial_reports
      ADD COLUMN IF NOT EXISTS f_ann_date DATE,
      ADD COLUMN IF NOT EXISTS report_type TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS comp_type TEXT NOT NULL DEFAULT '';

    UPDATE fundamental.financial_reports
       SET f_ann_date=COALESCE(f_ann_date,announced_at),
           report_type=COALESCE(NULLIF(report_type,''),NULLIF(raw_payload->>'report_type',''),''),
           comp_type=COALESCE(NULLIF(comp_type,''),NULLIF(raw_payload->>'comp_type',''),'')
     WHERE f_ann_date IS NULL OR report_type='' OR comp_type='';

    CREATE INDEX IF NOT EXISTS idx_financial_reports_current_period
      ON fundamental.financial_reports(company_id,report_kind,report_type,is_current_version,period_end DESC);

    ALTER TABLE bond_safety_snapshots
      ADD COLUMN IF NOT EXISTS publication_status TEXT NOT NULL DEFAULT 'published',
      ADD COLUMN IF NOT EXISTS publication_reason TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS quality_gate JSONB NOT NULL DEFAULT '{}'::jsonb;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname='ck_bond_safety_snapshot_publication_status'
           AND conrelid='bond_safety_snapshots'::regclass
      ) THEN
        ALTER TABLE bond_safety_snapshots
          ADD CONSTRAINT ck_bond_safety_snapshot_publication_status
          CHECK (publication_status IN ('published','rejected'));
      END IF;
    END $$;

    UPDATE bond_safety_snapshots
       SET publication_status='rejected',
           publication_reason='历史快照为全量未评级结果',
           quality_gate=jsonb_build_object(
             'migrated_rejected',true,
             'reason','all_unrated_snapshot'
           )
     WHERE row_count > 0
       AND COALESCE(NULLIF(diagnostics->'rating_counts'->>'未评级',''),'0')::integer >= row_count;

    UPDATE ops.dataset_partitions p
       SET status='stale',is_stale=true,
           stale_reason='对应安全性快照已被质量门禁判定为全量未评级',updated_at=now()
     WHERE p.dataset_code='bond_safety_snapshot'
       AND EXISTS (
         SELECT 1 FROM bond_safety_snapshots s
          WHERE s.publication_status='rejected'
            AND COALESCE(s.source_updated_at,s.refreshed_at)::date=p.partition_key
       );
  `);
}

// ========== 135：汇率预算等待与历史误熔断修复 =============
// 统一汇率最小请求间隔为 24 小时；清理 0.7.0.27 之前把内部日预算等待误写成
// 永久来源熔断的历史记录，保留原错误码和详情供审计。
async function migration135ExchangeRateBudgetRecovery() {
  await pool.query(`
    UPDATE ops.source_endpoint_policies p
       SET internal_per_minute_limit=NULL, internal_daily_limit=NULL, min_interval_ms=86400000,
           official_doc_url='https://www.exchangerate-api.com/docs/free',
           notes='官方免费接口每日更新；文档建议每24小时请求一次；内部预算等待不写来源熔断，真实429按分钟退避'
      FROM ops.data_sources ds
     WHERE p.source_id=ds.source_id AND ds.source_code='exchange-rate'
       AND p.api_name='*' AND p.credential_profile='anonymous';

    UPDATE ops.external_circuits
       SET state='closed', recover_at=NULL, probe_in_flight=false,
           probe_owner=NULL, probe_token=NULL, probe_lease_until=NULL, updated_at=now()
     WHERE source='exchange-rate' AND api_name='*' AND token_fingerprint='none'
       AND state='open' AND error_code='CIRCUIT_OPEN' AND recover_at IS NULL
       AND detail LIKE '%达到日保护线%';
  `);
}

// ========== 140：IPO 事实复用统一证券身份（方案第 17 节） =============
// 首批只做兼容性加法：保留 security_code 主键，新增市场、生命周期和 instrument_id，
// 让已有 A 股读写不受影响，同时为港股上市前后复用同一主档提供幂等关联。
async function migration140IpoInstrumentIdentity() {
  await pool.query(`
    ALTER TABLE public.ipo_history
      ADD COLUMN IF NOT EXISTS instrument_id BIGINT,
      ADD COLUMN IF NOT EXISTS market_code TEXT NOT NULL DEFAULT 'CN',
      ADD COLUMN IF NOT EXISTS ipo_status TEXT NOT NULL DEFAULT 'active',
      ADD COLUMN IF NOT EXISTS ipo_status_at TIMESTAMPTZ;

    UPDATE public.ipo_history
       SET market_code='CN'
     WHERE market_code IS NULL OR market_code='';

    UPDATE public.ipo_history
       SET ipo_status=CASE
         WHEN listing_date ~ '^\\d{4}-\\d{2}-\\d{2}$'
              AND listing_date::date <= (timezone('Asia/Shanghai', now()))::date THEN 'listed'
         WHEN ipo_status IS NULL OR ipo_status='' THEN 'active'
         ELSE ipo_status
       END,
       ipo_status_at=COALESCE(ipo_status_at, now());

    WITH candidates AS (
      SELECT h.security_code, MIN(i.instrument_id) AS instrument_id
        FROM public.ipo_history h
        JOIN core.instruments i
          ON i.asset_class='stock'
         AND i.market='CN'
         AND regexp_replace(i.canonical_code,'[^0-9]','','g')=
             regexp_replace(h.security_code,'[^0-9]','','g')
       WHERE h.market_code='CN' AND h.instrument_id IS NULL
       GROUP BY h.security_code
      HAVING COUNT(DISTINCT i.instrument_id)=1
    )
    UPDATE public.ipo_history h
       SET instrument_id=c.instrument_id
      FROM candidates c
     WHERE h.security_code=c.security_code AND h.instrument_id IS NULL;

    CREATE INDEX IF NOT EXISTS idx_ipo_history_instrument_id
      ON public.ipo_history(instrument_id);
    CREATE INDEX IF NOT EXISTS idx_ipo_history_market_ipo_date
      ON public.ipo_history(market_code,ipo_date DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_ipo_history_market_instrument
      ON public.ipo_history(market_code,instrument_id)
      WHERE instrument_id IS NOT NULL;

    UPDATE ops.source_endpoint_policies p
       SET official_per_minute_limit=NULL,
           official_daily_limit=NULL,
           internal_per_minute_limit=NULL,
           internal_daily_limit=NULL,
           max_concurrency=1,
           min_interval_ms=500,
           row_limit=100,
           timeout_ms=15000,
           notes='港交所官方入口与分类事实；来源级不设置内部限额；适配器响应上限5MB，分页不完整时保留游标重试'
      FROM ops.data_sources ds
     WHERE p.source_id=ds.source_id
       AND ds.source_code='hkex'
       AND p.api_name='*'
       AND p.credential_profile='anonymous';
  `);

  const fk = await pool.query(`
    SELECT 1 FROM pg_constraint
     WHERE conname='fk_ipo_history_instrument_id'
       AND conrelid='public.ipo_history'::regclass
  `);
  if (fk.rowCount === 0) {
    await pool.query(`
      ALTER TABLE public.ipo_history
        ADD CONSTRAINT fk_ipo_history_instrument_id
        FOREIGN KEY (instrument_id) REFERENCES core.instruments(instrument_id)
        ON DELETE SET NULL NOT VALID
    `);
  }

  const statusCheck = await pool.query(`
    SELECT 1 FROM pg_constraint
     WHERE conname='ck_ipo_history_status'
       AND conrelid='public.ipo_history'::regclass
  `);
  if (statusCheck.rowCount === 0) {
    await pool.query(`
      ALTER TABLE public.ipo_history
        ADD CONSTRAINT ck_ipo_history_status CHECK (ipo_status IN (
          'active','priced','allotted','listed','postponed','withdrawn','rejected',
          'lapsed','returned','cancelled','introduction','gem_transfer','de_spac'
        )) NOT VALID
    `);
  }
}

// ========== 141：补齐既有 IPO 事实的缺失主档 =============
// 迁移 140 只回填已有主档；对历史 IPO 中尚未进入股票主档的证券，按明确市场规则创建候选身份，
// 避免同一 IPO 事实长期悬空。后续正式主档同步仍可复用并更新这条 instrument_id。
async function migration141BackfillIpoIdentityGaps() {
  await pool.query(`
    WITH missing AS (
      SELECT h.security_code, h.security_name, h.listing_date, h.ipo_status,
             CASE
               WHEN h.security_code ~ '^(920|82|83|87|43)' THEN h.security_code || '.BJ'
               WHEN h.security_code ~ '^(6|68)' THEN h.security_code || '.SH'
               ELSE h.security_code || '.SZ'
             END AS canonical_code
        FROM public.ipo_history h
       WHERE h.market_code='CN' AND h.instrument_id IS NULL
         AND h.security_code ~ '^[0-9]{6}$'
    )
    INSERT INTO core.instruments(
      canonical_code,name,asset_class,market,exchange_code,currency_code,list_date,status,raw_data
    )
    SELECT canonical_code,COALESCE(NULLIF(security_name,''),canonical_code),'stock','CN',
           split_part(canonical_code,'.',2),'CNY',
           CASE WHEN listing_date ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN listing_date::date END,
           COALESCE(NULLIF(ipo_status,''),'active'),
           jsonb_build_object('backfill','migration141','ipo_history',true)
      FROM missing
    ON CONFLICT(canonical_code) DO UPDATE SET
      name=CASE WHEN EXCLUDED.name<>'' THEN EXCLUDED.name ELSE core.instruments.name END,
      list_date=COALESCE(core.instruments.list_date,EXCLUDED.list_date),
      status=CASE WHEN core.instruments.status='listed' AND EXCLUDED.status<>'listed'
                  THEN core.instruments.status ELSE EXCLUDED.status END,
      raw_data=core.instruments.raw_data || EXCLUDED.raw_data,
      updated_at=now();

    UPDATE public.ipo_history h
       SET instrument_id=i.instrument_id
      FROM core.instruments i
     WHERE h.market_code='CN'
       AND h.instrument_id IS NULL
       AND i.asset_class='stock' AND i.market='CN'
       AND i.canonical_code=CASE
         WHEN h.security_code ~ '^(920|82|83|87|43)' THEN h.security_code || '.BJ'
         WHEN h.security_code ~ '^(6|68)' THEN h.security_code || '.SH'
         ELSE h.security_code || '.SZ'
       END;
  `);
}

// ========== 142：港股 IPO 事实字段、事件阶段与研究快照 =============
// 只扩展事实层，不生成正式投资建议。港股公开发行的阶段日期、费用和结构字段允许为空，
// 由官方披露易/新上市公告逐步补齐；空值必须在接口中明确为待公告或待补全。
async function migration142HongKongIpoFacts() {
  await pool.query(`
    -- 港股五位代码与 A 股六位代码可能去前导零后相同，唯一性必须包含市场维度。
    DROP INDEX IF EXISTS uq_instruments_numeric_identity;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_instruments_numeric_identity
      ON core.instruments(asset_class,upper(market),(regexp_replace(canonical_code,'\\D','','g')))
      WHERE (asset_class='stock' AND canonical_code ~ '^\\d{5,6}\\.(SH|SZ|BJ|HK)$')
         OR (asset_class='convertible_bond' AND canonical_code ~ '^\\d{6}\\.(SH|SZ)$');

    ALTER TABLE public.ipo_history
      ADD COLUMN IF NOT EXISTS offer_open_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS offer_close_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS pricing_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS allotment_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS listing_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS issue_price_low NUMERIC(20,8),
      ADD COLUMN IF NOT EXISTS issue_price_high NUMERIC(20,8),
      ADD COLUMN IF NOT EXISTS issue_price_final NUMERIC(20,8),
      ADD COLUMN IF NOT EXISTS lot_size_shares NUMERIC(20,4),
      ADD COLUMN IF NOT EXISTS lot_amount_hkd NUMERIC(20,4),
      ADD COLUMN IF NOT EXISTS application_fee_hkd NUMERIC(20,4),
      ADD COLUMN IF NOT EXISTS brokerage_fee_hkd NUMERIC(20,4),
      ADD COLUMN IF NOT EXISTS public_offer_ratio NUMERIC(12,8),
      ADD COLUMN IF NOT EXISTS international_offer_ratio NUMERIC(12,8),
      ADD COLUMN IF NOT EXISTS cornerstone_details JSONB NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS greenshoe_details JSONB NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS source_documents JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS data_completeness JSONB NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS facts_published_at TIMESTAMPTZ;

    CREATE INDEX IF NOT EXISTS idx_ipo_history_hk_offer_open
      ON public.ipo_history(market_code,offer_open_at)
      WHERE market_code='HK';
    CREATE INDEX IF NOT EXISTS idx_ipo_history_hk_listing_at
      ON public.ipo_history(market_code,listing_at)
      WHERE market_code='HK';

    ALTER TABLE event.instrument_events ADD COLUMN IF NOT EXISTS event_at TIMESTAMPTZ;
    UPDATE event.instrument_events SET event_at=event_date::timestamptz WHERE event_at IS NULL;
    ALTER TABLE event.instrument_events DROP CONSTRAINT IF EXISTS instrument_events_event_type_check;
    ALTER TABLE event.instrument_events DROP CONSTRAINT IF EXISTS ck_instrument_events_event_type;
    ALTER TABLE event.instrument_events ADD CONSTRAINT ck_instrument_events_event_type CHECK (event_type IN (
      'issue_announcement','shareholder_record','online_subscription','result_announcement','listing',
      'offer_open','offer_close','pricing','allotment_result','hk_listing'
    )) NOT VALID;
    CREATE INDEX IF NOT EXISTS idx_instrument_events_event_at
      ON event.instrument_events(event_type,event_at DESC);

    CREATE TABLE IF NOT EXISTS analytics.ipo_recommendation_snapshots (
      snapshot_id BIGSERIAL PRIMARY KEY,
      instrument_id BIGINT NOT NULL REFERENCES core.instruments(instrument_id) ON DELETE CASCADE,
      market_code TEXT NOT NULL CHECK (market_code IN ('CN','HK')),
      stage TEXT NOT NULL CHECK (stage IN ('facts','research','formal')),
      as_of_date DATE NOT NULL,
      model_version TEXT NOT NULL,
      score NUMERIC(12,6),
      advice TEXT,
      risk_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
      input_completeness JSONB NOT NULL DEFAULT '{}'::jsonb,
      data_as_of DATE,
      published_at TIMESTAMPTZ,
      is_stale BOOLEAN NOT NULL DEFAULT false,
      stale_reason TEXT NOT NULL DEFAULT '',
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(instrument_id,stage,as_of_date,model_version)
    );
    CREATE INDEX IF NOT EXISTS idx_ipo_recommendation_snapshots_market_date
      ON analytics.ipo_recommendation_snapshots(market_code,as_of_date DESC,stage);
  `);
}

// ========== 143：证券数字代码唯一性补充市场维度 =============
// 兼容已经执行 142 的数据库；00700.HK 与 000700.SZ 不能因去前导零后相同而互相阻塞。
async function migration143MarketScopedNumericIdentity() {
  await pool.query(`
    DROP INDEX IF EXISTS uq_instruments_numeric_identity;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_instruments_numeric_identity
      ON core.instruments(asset_class,upper(market),(regexp_replace(canonical_code,'\\D','','g')))
      WHERE (asset_class='stock' AND canonical_code ~ '^\\d{5,6}\\.(SH|SZ|BJ|HK)$')
         OR (asset_class='convertible_bond' AND canonical_code ~ '^\\d{6}\\.(SH|SZ)$');
  `);
}

// ========== 154：A股 IPO 交易所招股书主源策略 =============
// IPO 资料补全按交易所官方披露优先；巨潮资讯仅作为交易所候选、下载或解析失败时的备源。
// 交易所接口不设置本系统分钟/日预算，只保留并发去重和真实上游异常保护。
async function migration154IpoExchangeProspectusSources() {
  await pool.query(`
    INSERT INTO ops.data_sources(source_code,source_name,source_type,priority)
    VALUES ('bse','北交所公告','official',5)
    ON CONFLICT(source_code) DO UPDATE
      SET source_name=EXCLUDED.source_name,
          source_type=EXCLUDED.source_type,
          priority=EXCLUDED.priority;

    INSERT INTO ops.source_endpoint_policies
      (source_id,api_name,credential_profile,internal_per_minute_limit,internal_daily_limit,
       max_concurrency,min_interval_ms,timeout_ms,official_doc_url,notes)
    SELECT ds.source_id,'*','anonymous',NULL,NULL,1,0,30000,
           'https://www.bse.cn/issue/issue_disclosure.html',
           '北交所 IPO 官方披露；交易所主源，巨潮只作备源'
      FROM ops.data_sources ds
     WHERE ds.source_code='bse'
    ON CONFLICT(source_id,api_name,credential_profile) DO UPDATE
      SET internal_per_minute_limit=EXCLUDED.internal_per_minute_limit,
          internal_daily_limit=EXCLUDED.internal_daily_limit,
          max_concurrency=EXCLUDED.max_concurrency,
          min_interval_ms=EXCLUDED.min_interval_ms,
          timeout_ms=EXCLUDED.timeout_ms,
          official_doc_url=EXCLUDED.official_doc_url,
          notes=EXCLUDED.notes,
          updated_at=now();

    UPDATE ops.source_endpoint_policies p
       SET internal_per_minute_limit=NULL,
           internal_daily_limit=NULL,
           min_interval_ms=0,
           notes='A股 IPO 交易所官方招股书主源；保留并发去重和真实上游异常处理，巨潮只作备源',
           updated_at=now()
      FROM ops.data_sources ds
     WHERE p.source_id=ds.source_id
       AND ds.source_code IN ('sse','szse')
       AND p.api_name='*'
       AND p.credential_profile='anonymous';
  `);
}

// ========== 155：Agnes 视觉模型迁移 =============
// Agnes 官方已废弃 agnes-2.0-flash；将已保存的后台模型配置一次性迁移到兼容的新模型。
async function migration155AgnesVisionModel() {
  const { rows } = await pool.query(
    `SELECT value FROM platform_config WHERE key='ai_models' FOR UPDATE`
  );
  if (!rows.length) return;

  let models;
  try { models = JSON.parse(rows[0].value || '[]'); } catch (e) { return; }
  if (!Array.isArray(models)) return;

  let changed = false;
  const migrated = models.map(function (model) {
    if (!model || typeof model !== 'object' || model.model !== 'agnes-2.0-flash') return model;
    changed = true;
    return Object.assign({}, model, { model: 'agnes-2.5-flash' });
  });
  if (changed) {
    await pool.query(
      `UPDATE platform_config SET value=$1,updated_at=now() WHERE key='ai_models'`,
      [JSON.stringify(migrated)]
    );
  }
}

// ========== 156：接口级预算唯一化 =============
// 来源/凭据级内部数字保护线没有可靠上游依据，不能继续作为隐性总量限制。
// 只保留具体 api_name 的已核验策略；来源级通配策略仅承载并发、间隔、权限等配置。
async function migration156EndpointOnlyInternalLimits() {
  await pool.query(`
    CREATE OR REPLACE FUNCTION ops.reserve_external_call(
      p_source TEXT,
      p_api_name TEXT,
      p_credential_profile TEXT,
      p_credential_fingerprint TEXT
    )
    RETURNS TABLE(
      allowed BOOLEAN,
      reason TEXT,
      wait_until TIMESTAMPTZ,
      policy_id BIGINT,
      day_count INTEGER,
      minute_count INTEGER,
      effective_daily_limit INTEGER,
      effective_minute_limit INTEGER,
      timeout_ms INTEGER,
      retry_policy JSONB,
      empty_policy TEXT,
      concurrency_slot INTEGER
    )
    LANGUAGE plpgsql
    AS $fn$
    DECLARE
      v_source TEXT := NULLIF(BTRIM(p_source),'');
      v_api TEXT := LEFT(COALESCE(NULLIF(BTRIM(p_api_name),''),'*'),64);
      v_profile TEXT := CASE WHEN p_credential_profile IN ('primary','backup','anonymous') THEN p_credential_profile ELSE 'anonymous' END;
      v_fingerprint TEXT := COALESCE(NULLIF(BTRIM(p_credential_fingerprint),''),'none');
      v_source_id SMALLINT;
      v_exact ops.source_endpoint_policies%ROWTYPE;
      v_base ops.source_endpoint_policies%ROWTYPE;
      v_policy_id BIGINT;
      v_enabled BOOLEAN;
      v_permission TEXT;
      v_minute_limit INTEGER;
      v_day_limit INTEGER;
      v_official_minute INTEGER;
      v_official_day INTEGER;
      v_concurrency INTEGER;
      v_interval INTEGER;
      v_timeout INTEGER;
      v_retry JSONB;
      v_empty TEXT;
      v_day_key TEXT;
      v_minute_key TEXT;
      v_next TIMESTAMPTZ;
      v_day_count INTEGER := 0;
      v_minute_count INTEGER := 0;
      v_slot INTEGER := NULL;
      v_lock_key TEXT;
      v_i INTEGER;
    BEGIN
      IF v_source IS NULL THEN
        RETURN QUERY SELECT false,'policy_missing',NULL::timestamptz,NULL::bigint,0,0,NULL::integer,NULL::integer,30000,'{}'::jsonb,'preserve_last_success',NULL::integer;
        RETURN;
      END IF;
      SELECT source_id INTO v_source_id FROM ops.data_sources WHERE source_code=v_source AND enabled=true;
      IF v_source_id IS NULL THEN
        RETURN QUERY SELECT false,'policy_missing',NULL::timestamptz,NULL::bigint,0,0,NULL::integer,NULL::integer,30000,'{}'::jsonb,'preserve_last_success',NULL::integer;
        RETURN;
      END IF;
      SELECT * INTO v_base FROM ops.source_endpoint_policies
       WHERE source_id=v_source_id AND api_name='*' AND credential_profile=v_profile;
      SELECT * INTO v_exact FROM ops.source_endpoint_policies
       WHERE source_id=v_source_id AND api_name=v_api AND credential_profile=v_profile;
      IF v_base.policy_id IS NULL AND v_exact.policy_id IS NULL THEN
        RETURN QUERY SELECT false,'policy_missing',NULL::timestamptz,NULL::bigint,0,0,NULL::integer,NULL::integer,30000,'{}'::jsonb,'preserve_last_success',NULL::integer;
        RETURN;
      END IF;
      v_policy_id := COALESCE(v_exact.policy_id,v_base.policy_id);
      v_enabled := COALESCE(v_exact.enabled,v_base.enabled,false);
      v_permission := COALESCE(NULLIF(v_exact.permission_status,''),NULLIF(v_base.permission_status,''),'unknown');
      IF NOT v_enabled THEN
        RETURN QUERY SELECT false,'policy_disabled',NULL::timestamptz,v_policy_id,0,0,NULL::integer,NULL::integer,30000,'{}'::jsonb,'preserve_last_success',NULL::integer;
        RETURN;
      END IF;
      IF v_permission IN ('permission_denied','not_configured') THEN
        RETURN QUERY SELECT false,'permission_denied',NULL::timestamptz,v_policy_id,0,0,NULL::integer,NULL::integer,30000,'{}'::jsonb,'preserve_last_success',NULL::integer;
        RETURN;
      END IF;
      -- 只有精确 api_name 的内部限制可以生效；通配策略不得形成来源/凭据总量限制。
      v_minute_limit := v_exact.internal_per_minute_limit;
      v_day_limit := v_exact.internal_daily_limit;
      v_official_minute := COALESCE(v_exact.official_per_minute_limit,v_base.official_per_minute_limit);
      v_official_day := COALESCE(v_exact.official_daily_limit,v_base.official_daily_limit);
      IF v_official_minute IS NOT NULL AND (v_minute_limit IS NULL OR v_minute_limit > v_official_minute) THEN v_minute_limit := v_official_minute; END IF;
      IF v_official_day IS NOT NULL AND (v_day_limit IS NULL OR v_day_limit > v_official_day) THEN v_day_limit := v_official_day; END IF;
      v_concurrency := COALESCE(v_exact.max_concurrency,v_base.max_concurrency,1);
      v_interval := COALESCE(v_exact.min_interval_ms,v_base.min_interval_ms,0);
      v_timeout := COALESCE(v_exact.timeout_ms,v_base.timeout_ms,30000);
      v_retry := COALESCE(v_exact.retry_policy,v_base.retry_policy,'{}'::jsonb);
      v_empty := COALESCE(v_exact.empty_policy,v_base.empty_policy,'preserve_last_success');

      PERFORM pg_advisory_xact_lock(hashtextextended('external_budget:'||v_source||':'||v_fingerprint,0));
      v_day_key := to_char(clock_timestamp() AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD');
      v_minute_key := floor(extract(epoch FROM clock_timestamp())/60)::bigint::text;
      INSERT INTO ops.source_endpoint_runtime(source_id,api_name,credential_fingerprint)
        VALUES(v_source_id,v_api,v_fingerprint)
        ON CONFLICT(source_id,api_name,credential_fingerprint) DO NOTHING;
      SELECT next_allowed_at INTO v_next FROM ops.source_endpoint_runtime
       WHERE source_id=v_source_id AND api_name=v_api AND credential_fingerprint=v_fingerprint FOR UPDATE;
      IF v_next IS NOT NULL AND v_next > clock_timestamp() THEN
        RETURN QUERY SELECT false,'interval',v_next,v_policy_id,0,0,v_day_limit,v_minute_limit,v_timeout,v_retry,v_empty,NULL::integer;
        RETURN;
      END IF;
      SELECT COALESCE(call_count,0) INTO v_day_count FROM ops.external_call_budgets
       WHERE source=v_source AND api_name=v_api AND credential_fingerprint=v_fingerprint AND window_type='day' AND window_key=v_day_key FOR UPDATE;
      SELECT COALESCE(call_count,0) INTO v_minute_count FROM ops.external_call_budgets
       WHERE source=v_source AND api_name=v_api AND credential_fingerprint=v_fingerprint AND window_type='minute' AND window_key=v_minute_key FOR UPDATE;
      v_day_count := COALESCE(v_day_count,0);
      v_minute_count := COALESCE(v_minute_count,0);
      IF v_minute_limit IS NOT NULL AND v_minute_count >= v_minute_limit THEN
        RETURN QUERY SELECT false,'minute',NULL::timestamptz,v_policy_id,v_day_count,v_minute_count,v_day_limit,v_minute_limit,v_timeout,v_retry,v_empty,NULL::integer;
        RETURN;
      END IF;
      IF v_day_limit IS NOT NULL AND v_day_count >= v_day_limit THEN
        RETURN QUERY SELECT false,'day',NULL::timestamptz,v_policy_id,v_day_count,v_minute_count,v_day_limit,v_minute_limit,v_timeout,v_retry,v_empty,NULL::integer;
        RETURN;
      END IF;
      FOR v_i IN 0..(v_concurrency-1) LOOP
        v_lock_key := 'external_slot:'||v_source||':'||v_api||':'||v_fingerprint||':'||v_i;
        IF pg_try_advisory_lock(hashtextextended(v_lock_key,0)) THEN v_slot := v_i; EXIT; END IF;
      END LOOP;
      IF v_slot IS NULL THEN
        RETURN QUERY SELECT false,'concurrency',clock_timestamp()+interval '1 second',v_policy_id,v_day_count,v_minute_count,v_day_limit,v_minute_limit,v_timeout,v_retry,v_empty,NULL::integer;
        RETURN;
      END IF;
      INSERT INTO ops.external_call_budgets(source,api_name,credential_profile,credential_fingerprint,window_type,window_key,call_count,budget_limit,policy_id)
        VALUES(v_source,v_api,v_profile,v_fingerprint,'day',v_day_key,1,v_day_limit,v_policy_id)
        ON CONFLICT(source,api_name,credential_fingerprint,window_type,window_key) DO UPDATE SET
          call_count=ops.external_call_budgets.call_count+1,credential_profile=EXCLUDED.credential_profile,
          budget_limit=EXCLUDED.budget_limit,policy_id=EXCLUDED.policy_id,updated_at=now();
      INSERT INTO ops.external_call_budgets(source,api_name,credential_profile,credential_fingerprint,window_type,window_key,call_count,budget_limit,policy_id)
        VALUES(v_source,v_api,v_profile,v_fingerprint,'minute',v_minute_key,1,v_minute_limit,v_policy_id)
        ON CONFLICT(source,api_name,credential_fingerprint,window_type,window_key) DO UPDATE SET
          call_count=ops.external_call_budgets.call_count+1,credential_profile=EXCLUDED.credential_profile,
          budget_limit=EXCLUDED.budget_limit,policy_id=EXCLUDED.policy_id,updated_at=now();
      UPDATE ops.source_endpoint_runtime
         SET next_allowed_at=CASE WHEN v_interval>0 THEN clock_timestamp()+(v_interval*interval '1 millisecond') ELSE NULL END,
             updated_at=now()
       WHERE source_id=v_source_id AND api_name=v_api AND credential_fingerprint=v_fingerprint;
      RETURN QUERY SELECT true,'allowed',NULL::timestamptz,v_policy_id,v_day_count+1,v_minute_count+1,v_day_limit,v_minute_limit,v_timeout,v_retry,v_empty,v_slot;
    EXCEPTION WHEN OTHERS THEN
      IF v_slot IS NOT NULL THEN
        PERFORM pg_advisory_unlock(hashtextextended('external_slot:'||v_source||':'||v_api||':'||v_fingerprint||':'||v_slot,0));
      END IF;
      RAISE;
    END;
    $fn$;

    UPDATE ops.source_endpoint_policies
       SET internal_per_minute_limit=NULL,
           internal_daily_limit=NULL,
           notes=CASE
             WHEN notes LIKE '%巨潮仅保留20次/分钟内部保护%' THEN
               regexp_replace(notes,
                 '巨潮仅保留20次/分钟内部保护；日调用量只计数不拦截，真实上游429/额度错误才记录熔断',
                 '巨潮来源级不设置内部限额；具体接口限制由接口策略单独登记，真实上游429/额度错误才记录熔断')
             WHEN COALESCE(notes,'')='' THEN '来源级内部限额已清除；限制必须登记到具体接口'
             WHEN notes LIKE '%来源级内部限额已清除%' THEN notes
             ELSE notes || '；来源级内部限额已清除，限制必须登记到具体接口'
           END,
           updated_at=now()
     WHERE api_name='*'
       AND (internal_per_minute_limit IS NOT NULL OR internal_daily_limit IS NOT NULL);

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname='ck_source_endpoint_wildcard_no_internal_limits'
      ) THEN
        ALTER TABLE ops.source_endpoint_policies
          ADD CONSTRAINT ck_source_endpoint_wildcard_no_internal_limits
          CHECK (api_name <> '*' OR (internal_per_minute_limit IS NULL AND internal_daily_limit IS NULL));
      END IF;
    END $$;
  `);
}

// ========== 158：盘中实时汇率接口策略 =============
// 盘中汇率使用独立接口名，避免沿用 open.er-api 每 24 小时一次的每日接口保护；
// 上游官方分钟/日限额未知，只有本系统按页面刷新频率设置的 5 分钟最小间隔。
async function migration158RealtimeExchangeRatePolicy() {
  await pool.query(`
    INSERT INTO ops.source_endpoint_policies
      (source_id,api_name,credential_profile,permission_mode,permission_status,
       internal_per_minute_limit,internal_daily_limit,max_concurrency,min_interval_ms,
       timeout_ms,empty_policy,notes)
    SELECT ds.source_id,'exchange_rate_realtime','anonymous','unknown','unknown',
           NULL,NULL,1,300000,10000,'preserve_last_success',
           '盘中 HKDCNY=X 实时快照；上游官方限额未知，仅按本系统 5 分钟最小间隔保护'
      FROM ops.data_sources ds
     WHERE ds.source_code='exchange-rate'
    ON CONFLICT(source_id,api_name,credential_profile) DO NOTHING;
  `);
}

// ========== 159：移除臆造内部限额并强制熔断可恢复 =============
// 已核验的上游限制只写 official_*；内部分钟/日数字不再承担接口限流。
// 权限拒绝进入接口权限策略，临时熔断必须带 recover_at，避免永久卡死。
async function migration159VerifiedLimitsAndRecoverableCircuits() {
  await pool.query(`
    UPDATE ops.source_endpoint_policies
       SET internal_per_minute_limit=NULL,
           internal_daily_limit=NULL,
           notes=CASE
             WHEN COALESCE(notes,'')='' THEN '内部分钟/日限额已清除；仅保留已核验的官方限制'
             WHEN notes LIKE '%内部分钟/日限额已清除%' THEN notes
             ELSE notes || '；内部分钟/日限额已清除，仅保留已核验的官方限制'
           END,
           updated_at=now()
     WHERE internal_per_minute_limit IS NOT NULL OR internal_daily_limit IS NOT NULL;

    ALTER TABLE ops.source_endpoint_policies
      DROP CONSTRAINT IF EXISTS ck_source_endpoint_wildcard_no_internal_limits;
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname='ck_source_endpoint_no_internal_limits'
      ) THEN
        ALTER TABLE ops.source_endpoint_policies
          ADD CONSTRAINT ck_source_endpoint_no_internal_limits
          CHECK (internal_per_minute_limit IS NULL AND internal_daily_limit IS NULL);
      END IF;
    END $$;

    INSERT INTO ops.source_endpoint_policies
      (source_id,api_name,credential_profile,credential_fingerprint,
       permission_status,enabled,last_verified_at,verification_message,notes)
    SELECT ds.source_id,
           CASE WHEN ec.api_name='*' THEN '*' ELSE ec.api_name END,
           CASE WHEN ec.source='tushare_backup' THEN 'backup'
                WHEN ec.source='tushare' THEN 'primary' ELSE 'anonymous' END,
           ec.token_fingerprint,'permission_denied',false,COALESCE(ec.updated_at,now()),
           LEFT(COALESCE(ec.detail,'历史权限拒绝'),240),
           '权限拒绝已从永久熔断迁移为接口权限阻塞'
      FROM ops.external_circuits ec
      JOIN ops.data_sources ds
        ON ds.source_code=CASE WHEN ec.source='tushare_backup' THEN 'tushare' ELSE ec.source END
     WHERE ec.state='open' AND ec.recover_at IS NULL
       AND ec.error_code IN ('PERMISSION_DENIED','AUTH_ERROR')
    ON CONFLICT(source_id,api_name,credential_profile) DO UPDATE SET
      credential_fingerprint=EXCLUDED.credential_fingerprint,
      permission_status='permission_denied',enabled=false,
      last_verified_at=EXCLUDED.last_verified_at,
      verification_message=EXCLUDED.verification_message,
      notes=CASE WHEN COALESCE(ops.source_endpoint_policies.notes,'')=''
                 THEN EXCLUDED.notes ELSE ops.source_endpoint_policies.notes || '；' || EXCLUDED.notes END,
      updated_at=now();

    UPDATE ops.external_circuits
       SET state='closed',probe_in_flight=false,probe_owner=NULL,probe_token=NULL,
           probe_lease_until=NULL,updated_at=now()
     WHERE state='open' AND recover_at IS NULL;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname='ck_external_circuits_open_recover_at'
      ) THEN
        ALTER TABLE ops.external_circuits
          ADD CONSTRAINT ck_external_circuits_open_recover_at
          CHECK (state <> 'open' OR recover_at IS NOT NULL);
      END IF;
    END $$;
  `);
}

async function migration163ArbitrageSeenCases() {
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS arbitrage_seen_cases jsonb');
  // 仅首次启用时把当前公开机会作为老机会；重复执行不覆盖已保存的个人记录。
  const { PUBLIC_CASE_FILTER } = require('../../services/arbitrageService');
  await pool.query(`UPDATE users SET arbitrage_seen_cases = (
    SELECT COALESCE(jsonb_object_agg(c.case_id::text, true), '{}'::jsonb)
    FROM event.arbitrage_cases c WHERE ${PUBLIC_CASE_FILTER}
  ) WHERE arbitrage_seen_cases IS NULL`);
  await pool.query(`ALTER TABLE users ALTER COLUMN arbitrage_seen_cases SET DEFAULT '{}'::jsonb,
    ALTER COLUMN arbitrage_seen_cases SET NOT NULL`);
}

// ========== 169：转债主档脏名清理 ==========
// 公告正文残留曾污染 core.instruments.name（如「为"航亚转债」「常青转债二、可转换公司」），
// 流入打新日历与日报。沿统一主档 fundamental.convertible_bond_profiles.bond_short_name
// 官方简称纠正全部同类脏名（2026-10-21 审查 P-7）；没有干净官方简称的保留原值不猜测。
async function migration169InstrumentNameCleanup() {
  const { isCleanSecurityName } = require('../../services/securityIdentity');
  const { rows } = await pool.query(
    `SELECT i.instrument_id,i.name,p.bond_short_name
       FROM core.instruments i
       LEFT JOIN fundamental.convertible_bond_profiles p ON p.instrument_id=i.instrument_id
      WHERE i.asset_class='convertible_bond' AND COALESCE(i.name,'')<>''`
  );
  for (const row of rows) {
    if (isCleanSecurityName(row.name)) continue;
    const replacement = String(row.bond_short_name || '').trim();
    if (!isCleanSecurityName(replacement)) continue;
    await pool.query(
      'UPDATE core.instruments SET name=$2,updated_at=now() WHERE instrument_id=$1',
      [row.instrument_id, replacement]
    );
  }
}

module.exports = {
  migration116IndexInstrumentIdentifiers,
  migration117DatasetPartitions,
  migration118InstrumentMergeCandidates,
  migration119NormalizeDividendYieldUnit,
  migration120RepairLegacyDividendYieldUnit,
  migration121BackfillDatasetPartitions,
  migration122NormalizeLegacyStockIdentity,
  migration123BackfillStockCompanyRelations,
  migration124ExternalCallBudgetFunction,
  migration125ConsolidateInstrumentMasters,
  migration126NormalizeStockCodeSuffix,
  migration127SourceEndpointPolicies,
  migration128TushareDualAccountPolicy,
  migration129TushareDualAccountPolicyRepair,
  migration130TushareVipBackupMinuteLimit,
  migration131IpoSectorExposureCalibration,
  migration134CompanyFinancialIncrementalSync,
  migration135ExchangeRateBudgetRecovery,
  migration140IpoInstrumentIdentity,
  migration141BackfillIpoIdentityGaps,
  migration142HongKongIpoFacts,
  migration143MarketScopedNumericIdentity,
  migration154IpoExchangeProspectusSources,
  migration155AgnesVisionModel,
  migration156EndpointOnlyInternalLimits,
  migration158RealtimeExchangeRatePolicy,
  migration159VerifiedLimitsAndRecoverableCircuits,
  migration163ArbitrageSeenCases,
  migration169InstrumentNameCleanup,
};
