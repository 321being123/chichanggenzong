// 平台治理与数据修复（049-057、059-078：会话权限审计、套利、汇率、打新报表、任务编排、告警、价格日期修复、保护电路）
// R-6 拆分自 ../migrations.js（2026-10-21）：本文件只放迁移函数体；执行顺序以 ../migrations.js 的 MIGRATIONS 注册表为准，禁止在本文件内重排。
const { pool, crypto, fs, path, DATA_DIR, DEFAULT_FEE_SETTINGS } = require('../connection');
const { uid, round, bulkInsert, hashPwd, safeEqual, verifyPwd, hashString } = require('../util');
const { seedBrokers } = require('../brokers');
const { migrateAccountsTable } = require('../accounts');
const { toNumber, normalizeMigrationDate, normalizeMigrationTimestamp, normalizeMigrationStockCode, scale100m } = require('./helpers');

// 已登记的升级步骤（按数组顺序执行；新增表/字段时追加 002、003… 步骤，勿往 001 堆 SQL）
// ========== 049：会话吊销（AUTH-01，P0）==========
// users 增加 auth_version（正整数，默认 1）。登录成功写入会话；禁用/删号/改密/重置密码后递增，
// 旧 Session 的版本号与库不一致 → 下次受保护请求立即 401，实现"禁用即失效、改密即吊销"。
async function migration049SessionRevocation() {
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 1`);
  const ex = await pool.query(`SELECT 1 FROM pg_constraint WHERE conname='chk_users_auth_version_positive' AND conrelid='users'::regclass`);
  if (ex.rowCount === 0) {
    await pool.query(`ALTER TABLE users ADD CONSTRAINT chk_users_auth_version_positive CHECK (auth_version > 0)`);
  }
}

// ========== 050：轻量能力权限基础（PERM-01，P1）==========
// users 增加 permissions JSONB（能力白名单布尔集合，默认空对象）。
// 现有 knowledge_enabled=true 的用户映射为 knowledge_write=true，保留 knowledge_enabled 字段兼容一个版本。
async function migration050CapabilityPermissions() {
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '{}'::jsonb`);
  await pool.query(`UPDATE users SET permissions = jsonb_set(permissions, '{knowledge_write}', 'true') WHERE knowledge_enabled = true`);
}

// ========== 051：审计记录补充结果、请求 ID 与参数摘要（AUDIT-01，P1）==========
// 旧记录默认视为成功；metadata 仅存必要参数摘要，严禁写入密码/密钥/Token 等敏感信息。
async function migration051AuditResultMetadata() {
  await pool.query(`ALTER TABLE admin_audit_log ADD COLUMN IF NOT EXISTS result TEXT NOT NULL DEFAULT 'success'`);
  await pool.query(`ALTER TABLE admin_audit_log ADD COLUMN IF NOT EXISTS request_id TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE admin_audit_log ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_audit_log_action ON admin_audit_log (action)`);
}

// ========== 057：新股历史独立同步的状态、原始响应与补偿字段 ==========
async function migration057IpoHistorySync() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ipo_history (
      security_code TEXT PRIMARY KEY,
      security_name TEXT,
      market_type TEXT,
      listing_date TEXT,
      ld_close_change REAL,
      board_key TEXT,
      updated_at TEXT,
      issue_price REAL,
      issue_pe REAL,
      industry_pe REAL,
      fund_raised REAL,
      total_shares REAL,
      online_shares REAL,
      online_lottery_rate REAL,
      oversubscribe_multiple REAL,
      subscribe_upper_limit REAL,
      main_business TEXT,
      industry TEXT,
      circulation_mv REAL,
      pe_ratio REAL,
      ipo_date TEXT
    );
    ALTER TABLE ipo_history ADD COLUMN IF NOT EXISTS issue_pe_status TEXT NOT NULL DEFAULT 'pending';
    ALTER TABLE ipo_history ADD COLUMN IF NOT EXISTS source_payload JSONB NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE ipo_history ADD COLUMN IF NOT EXISTS data_quality_status JSONB NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE ipo_history ADD COLUMN IF NOT EXISTS first_day_retry_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE ipo_history ADD COLUMN IF NOT EXISTS first_day_last_attempt_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS idx_ipo_history_listing_date ON ipo_history(listing_date DESC);
    CREATE INDEX IF NOT EXISTS idx_ipo_history_incomplete
      ON ipo_history(listing_date DESC)
      WHERE data_quality_status->>'status' = 'missing';
  `);
}

// ========== 059：打新日报入库表纳入版本化迁移 ==========
async function migration059IpoReportsSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ipo_reports (
      report_date  TEXT PRIMARY KEY,
      html         TEXT,
      md           TEXT,
      summary_json JSONB,
      created_at   TIMESTAMPTZ DEFAULT now()
    )
  `);
}

// ========== 060：可转债上市公告数据源分类 ==========
async function migration060SseListingAnnouncementSource() {
  await pool.query(`
    INSERT INTO ops.data_sources(source_code,source_name,source_type,priority)
    VALUES ('sse_listing_announcements','上交所上市/退市公告','official',5)
    ON CONFLICT(source_code) DO UPDATE SET
      source_name=EXCLUDED.source_name,
      source_type=EXCLUDED.source_type,
      priority=EXCLUDED.priority
  `);
}

// ========== 061：后台任务持久化计划、告警与 Worker 心跳 ==========
async function migration061JobOrchestration() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ops.job_schedule_slots (
      slot_id             BIGSERIAL PRIMARY KEY,
      job_code            TEXT NOT NULL,
      scheduled_for       TIMESTAMPTZ NOT NULL,
      business_date       DATE NOT NULL,
      status              TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','running','succeeded','degraded','failed','blocked','skipped')),
      attempt_count       INTEGER NOT NULL DEFAULT 0,
      next_attempt_at     TIMESTAMPTZ,
      lease_owner         TEXT,
      lease_until         TIMESTAMPTZ,
      heartbeat_at        TIMESTAMPTZ,
      last_run_id         INTEGER,
      trigger_type        TEXT NOT NULL DEFAULT 'scheduled',
      data_as_of          TIMESTAMPTZ,
      result_summary      JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_error          TEXT,
      acknowledged_at     TIMESTAMPTZ,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(job_code, scheduled_for)
    );
    CREATE INDEX IF NOT EXISTS idx_job_schedule_slots_status_time
      ON ops.job_schedule_slots(status, scheduled_for DESC);
    CREATE INDEX IF NOT EXISTS idx_job_schedule_slots_business_date
      ON ops.job_schedule_slots(business_date, scheduled_for DESC);

    CREATE TABLE IF NOT EXISTS ops.alert_notifications (
      alert_id            BIGSERIAL PRIMARY KEY,
      alert_key           TEXT NOT NULL UNIQUE,
      alert_type          TEXT NOT NULL,
      severity            TEXT NOT NULL DEFAULT 'critical',
      status              TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','sent','suppressed','resolved','send_failed','acknowledged')),
      job_code            TEXT,
      slot_id             BIGINT REFERENCES ops.job_schedule_slots(slot_id) ON DELETE SET NULL,
      subject             TEXT NOT NULL,
      summary             TEXT NOT NULL DEFAULT '',
      occurrence_count    INTEGER NOT NULL DEFAULT 1,
      send_attempts       INTEGER NOT NULL DEFAULT 0,
      recovery_attempts   INTEGER NOT NULL DEFAULT 0,
      first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_sent_at        TIMESTAMPTZ,
      next_send_at        TIMESTAMPTZ,
      sending_started_at  TIMESTAMPTZ,
      resolved_at         TIMESTAMPTZ,
      acknowledged_at     TIMESTAMPTZ,
      last_send_error     TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_alert_notifications_status_time
      ON ops.alert_notifications(status, last_seen_at DESC);

    CREATE TABLE IF NOT EXISTS ops.worker_heartbeats (
      worker_id           TEXT PRIMARY KEY,
      role                TEXT NOT NULL DEFAULT 'worker',
      pid                 TEXT,
      app_version         TEXT,
      status              TEXT NOT NULL DEFAULT 'running',
      started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_worker_heartbeats_last_seen
      ON ops.worker_heartbeats(last_seen_at DESC);

    ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS slot_id BIGINT;
    ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS attempt_no INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS trigger_type TEXT NOT NULL DEFAULT 'scheduled';
    ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS worker_id TEXT;
    ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ;
    ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS result_json JSONB;
    ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS error_code TEXT;
    CREATE INDEX IF NOT EXISTS idx_job_runs_slot_id ON job_runs(slot_id);
    CREATE INDEX IF NOT EXISTS idx_job_runs_job_started_at ON job_runs(job, started_at DESC);
  `);
}

// ========== 062：告警投递重试索引 ==========
async function migration062AlertDeliveryRetry() {
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_alert_notifications_due
      ON ops.alert_notifications(status, next_send_at, alert_id)
      WHERE status IN ('pending','send_failed');
  `);
}

// ========== 063：告警投递中的并发状态 ==========
async function migration063AlertSendingStatus() {
  await pool.query(`
    ALTER TABLE ops.alert_notifications DROP CONSTRAINT IF EXISTS alert_notifications_status_check;
    ALTER TABLE ops.alert_notifications
      ADD CONSTRAINT alert_notifications_status_check
      CHECK (status IN ('pending','sending','sent','suppressed','resolved','send_failed','acknowledged'));
  `);
}

// ========== 064：告警发送开始时间（避免持续故障刷新 updated_at 导致 sending 僵尸无法回收） ==========
async function migration064AlertSendingStartedAt() {
  await pool.query(`
    ALTER TABLE ops.alert_notifications
      ADD COLUMN IF NOT EXISTS sending_started_at TIMESTAMPTZ;
    UPDATE ops.alert_notifications
       SET sending_started_at=COALESCE(sending_started_at, updated_at)
     WHERE status='sending' AND sending_started_at IS NULL;
  `);
}

// ========== 065：SMTP 恢复摘要有限重试 ==========
async function migration065AlertRecoveryAttempts() {
  await pool.query(`
    ALTER TABLE ops.alert_notifications
      ADD COLUMN IF NOT EXISTS recovery_attempts INTEGER NOT NULL DEFAULT 0;
  `);
}

// ========== 066：套利公告 PDF 解析有限重试 ==========
async function migration066ArbitrageParseRetry() {
  await pool.query(`
    ALTER TABLE event.arbitrage_case_documents
      ADD COLUMN IF NOT EXISTS parse_attempts INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS next_parse_attempt_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS last_parse_error TEXT;
    UPDATE event.arbitrage_case_documents
       SET parse_attempts=1,
           next_parse_attempt_at=COALESCE(next_parse_attempt_at, now())
     WHERE parse_status='failed' AND parse_attempts=0;
    CREATE INDEX IF NOT EXISTS idx_arb_case_docs_parse_retry
      ON event.arbitrage_case_documents(parse_status, next_parse_attempt_at, parse_attempts)
      WHERE parse_status='failed';
  `);
}

async function migration067JobRequestPayload() {
  await pool.query(`
    ALTER TABLE ops.job_schedule_slots
      ADD COLUMN IF NOT EXISTS request_payload JSONB NOT NULL DEFAULT '{}'::jsonb;
  `);
}

// ========== 068：新债流通规模动态校准字段 ==========
async function migration068IpoBondLiquidityCalibration() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS analytics.convertible_bond_listing_liquidity (
      instrument_id BIGINT PRIMARY KEY REFERENCES core.instruments(instrument_id) ON DELETE CASCADE,
      listing_date DATE,
      circulation_scale_100m_yuan NUMERIC(20,4) NOT NULL CHECK (circulation_scale_100m_yuan > 0),
      lock_scale_100m_yuan NUMERIC(20,4) NOT NULL CHECK (lock_scale_100m_yuan >= 0),
      controller_quantity_zhang BIGINT CHECK (controller_quantity_zhang >= 0),
      total_quantity_zhang BIGINT CHECK (total_quantity_zhang > 0),
      controller_ratio_pct NUMERIC(10,4),
      source_id SMALLINT REFERENCES ops.data_sources(source_id),
      source_code TEXT NOT NULL DEFAULT 'cninfo_announcements',
      source_detail JSONB NOT NULL DEFAULT '{}'::jsonb,
      formula_version TEXT NOT NULL DEFAULT 'controller_locked_v1',
      calculated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_cb_listing_liquidity_date
      ON analytics.convertible_bond_listing_liquidity(listing_date DESC);
    ALTER TABLE predictions
      ADD COLUMN IF NOT EXISTS transfer_value REAL,
      ADD COLUMN IF NOT EXISTS circulation_scale REAL,
      ADD COLUMN IF NOT EXISTS base_price_no_liquidity REAL,
      ADD COLUMN IF NOT EXISTS liquidity_adjustment_pp REAL,
      ADD COLUMN IF NOT EXISTS liquidity_sample_count INTEGER,
      ADD COLUMN IF NOT EXISTS valuation_model_version TEXT,
      ADD COLUMN IF NOT EXISTS valuation_context JSONB NOT NULL DEFAULT '{}'::jsonb;
    CREATE INDEX IF NOT EXISTS idx_predictions_bond_liquidity_calibration
      ON predictions(type, listing_date, circulation_scale)
      WHERE type='bond' AND actual_price IS NOT NULL AND base_price_no_liquidity IS NOT NULL;
  `);
}

// ========== 069：修复收盘价历史日期格式 ==========
async function migration069NormalizeDailyPriceDates() {
  await pool.query(`
    WITH anchor AS (
      SELECT EXTRACT(YEAR FROM COALESCE(
        MAX(CASE WHEN date ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN date::date END),
        CURRENT_DATE
      ))::int AS year
      FROM daily_prices
    ), normalized AS (
      SELECT dp.ctid,
             to_char(to_date(dp.date || ' ' || anchor.year, 'Dy Mon DD YYYY'), 'YYYY-MM-DD') AS normalized_date
      FROM daily_prices dp
      CROSS JOIN anchor
      WHERE dp.date ~ '^[A-Za-z]{3} [A-Za-z]{3} [0-9]{1,2}$'
    )
    UPDATE daily_prices dp
       SET date = normalized.normalized_date
      FROM normalized
     WHERE dp.ctid = normalized.ctid
       AND NOT EXISTS (
         SELECT 1
         FROM daily_prices existing
         WHERE existing.username = dp.username
           AND existing.account_name = dp.account_name
           AND existing.code = dp.code
           AND existing.date = normalized.normalized_date
       )
  `);
}

// ========== 070：清理已有标准日期对应的旧格式重复收盘价 ==========
async function migration070RemoveDuplicateLegacyPriceDates() {
  await pool.query(`
    WITH anchor AS (
      SELECT EXTRACT(YEAR FROM COALESCE(
        MAX(CASE WHEN date ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN date::date END),
        CURRENT_DATE
      ))::int AS year
      FROM daily_prices
    ), duplicates AS (
      SELECT dp.ctid
      FROM daily_prices dp
      CROSS JOIN anchor
      WHERE dp.date ~ '^[A-Za-z]{3} [A-Za-z]{3} [0-9]{1,2}$'
        AND EXISTS (
          SELECT 1
          FROM daily_prices existing
          WHERE existing.username = dp.username
            AND existing.account_name = dp.account_name
            AND existing.code = dp.code
            AND existing.date = to_char(to_date(dp.date || ' ' || anchor.year, 'Dy Mon DD YYYY'), 'YYYY-MM-DD')
        )
    )
    DELETE FROM daily_prices dp
    USING duplicates
    WHERE dp.ctid = duplicates.ctid
  `);
}

// ========== 071：可转债发行事件按业务键去重并加唯一约束 ==========
// 同一标的、同一事件类型、同一日期只保留一条最完整且最新的事实，避免不同来源键重复写入。
async function migration071DeduplicateInstrumentEvents() {
  await pool.query(`
    WITH ranked AS (
      SELECT event_id,
             ROW_NUMBER() OVER (
               PARTITION BY instrument_id,event_type,event_date
               ORDER BY
                 CASE WHEN details IS NOT NULL AND details <> '{}'::jsonb THEN 1 ELSE 0 END DESC,
                 source_updated_at DESC NULLS LAST,
                 updated_at DESC NULLS LAST,
                 event_id DESC
             ) AS rn
        FROM event.instrument_events
    )
    DELETE FROM event.instrument_events e
     USING ranked r
     WHERE e.event_id=r.event_id AND r.rn>1
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_instrument_events_business
      ON event.instrument_events(instrument_id,event_type,event_date)
  `);
}

// ========== 072：权威收益导入锚点（日期/净值/总资产/投入/现金） ==========
// 导入总资产来自券商，持仓数量仍由 positions 表维护；导入后按券商现金/持仓总值锚点叠加本系统持仓增量。
async function migration072AuthoritativeNavImportAnchor() {
  await pool.query(`
    ALTER TABLE nav_history
      ADD COLUMN IF NOT EXISTS cash_cny numeric(20,2),
      ADD COLUMN IF NOT EXISTS market_value_cny numeric(20,2),
      ADD COLUMN IF NOT EXISTS system_market_value_at_snapshot numeric(20,2),
      ADD COLUMN IF NOT EXISTS broker_fx_rate numeric(20,8),
      ADD COLUMN IF NOT EXISTS snapshot_source text NOT NULL DEFAULT 'legacy',
      ADD COLUMN IF NOT EXISTS source_priority integer NOT NULL DEFAULT 10,
      ADD COLUMN IF NOT EXISTS import_batch_id text,
      ADD COLUMN IF NOT EXISTS calc_status text NOT NULL DEFAULT 'complete',
      ADD COLUMN IF NOT EXISTS diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS is_locked boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS input_hash text
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_nav_history_import_anchor
      ON nav_history(username, account_name, date, source_priority)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS nav_import_batches (
      id text PRIMARY KEY,
      username text NOT NULL,
      account_name text NOT NULL,
      imported_at timestamptz NOT NULL DEFAULT now(),
      range_start date NOT NULL,
      range_end date NOT NULL,
      row_count integer NOT NULL,
      input_hash text NOT NULL,
      status text NOT NULL,
      backup_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_nav_import_batches_account
      ON nav_import_batches(username, account_name, imported_at DESC)
  `);
}

// ========== 073：净值归因与币种结算完整性 ==========
// 历史导入锚点必须能按导入日重建；交易金额统一保留原币金额并落人民币结算金额。
async function migration073NavAttributionIntegrity() {
  await pool.query(`
    ALTER TABLE trades
      ADD COLUMN IF NOT EXISTS quote_currency CHAR(3),
      ADD COLUMN IF NOT EXISTS fx_rate_to_cny numeric(20,8),
      ADD COLUMN IF NOT EXISTS amount_cny numeric(20,4),
      ADD COLUMN IF NOT EXISTS currency_status TEXT NOT NULL DEFAULT 'legacy'
  `);
  // 旧版 amount_rel 是 NOT VALID，但 PostgreSQL 更新同一行时仍会重新校验；
  // 先临时拆除，回填币种金额后按原语义恢复。
  await pool.query(`ALTER TABLE trades DROP CONSTRAINT IF EXISTS chk_trades_amount_rel`);
  await pool.query(`
    UPDATE trades
       SET quote_currency = CASE WHEN subtype = '港股' THEN 'HKD' ELSE 'CNY' END,
           fx_rate_to_cny = CASE WHEN subtype = '港股' THEN NULL ELSE 1 END,
           amount_cny = CASE WHEN subtype = '港股' THEN NULL ELSE amount END,
           currency_status = CASE WHEN subtype = '港股' THEN 'needs_review' ELSE 'complete' END
     WHERE quote_currency IS NULL OR amount_cny IS NULL
  `);
  await pool.query(`
    ALTER TABLE trades ADD CONSTRAINT chk_trades_amount_rel
      CHECK (direction IN ('open','adjust') OR amount IS NULL OR ABS(amount - ROUND(price*quantity, 2)) < 0.02) NOT VALID
  `);
  await pool.query(`ALTER TABLE account_data ADD COLUMN IF NOT EXISTS nav_dirty_from DATE`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS nav_position_snapshots (
      snapshot_id TEXT NOT NULL,
      username TEXT NOT NULL,
      account_name TEXT NOT NULL,
      snapshot_date DATE NOT NULL,
      instrument_code TEXT NOT NULL,
      quantity numeric(20,4) NOT NULL,
      price numeric(20,8) NOT NULL,
      quote_currency CHAR(3) NOT NULL,
      fx_rate_to_cny numeric(20,8) NOT NULL,
      market_value_cny numeric(20,4) NOT NULL,
      source TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, instrument_code)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_nav_position_snapshots_account_date ON nav_position_snapshots(username, account_name, snapshot_date)`);
  // 历史版本允许同文件产生多个随机批次；先把引用归并到最新批次，再建立唯一约束。
  await pool.query(`
    WITH ranked AS (
      SELECT id, username, account_name, input_hash,
             first_value(id) OVER (PARTITION BY username, account_name, input_hash ORDER BY imported_at DESC, id DESC) AS keep_id,
             row_number() OVER (PARTITION BY username, account_name, input_hash ORDER BY imported_at DESC, id DESC) AS rn
        FROM nav_import_batches
    )
    UPDATE nav_history n SET import_batch_id = r.keep_id
      FROM ranked r
     WHERE n.import_batch_id = r.id AND r.rn > 1
  `);
  await pool.query(`
    DELETE FROM nav_import_batches b
     USING nav_import_batches k
     WHERE b.username=k.username AND b.account_name=k.account_name AND b.input_hash=k.input_hash
       AND (b.imported_at < k.imported_at OR (b.imported_at = k.imported_at AND b.id < k.id))
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_nav_import_content
      ON nav_import_batches(username, account_name, input_hash)
  `);
  for (const c of [
    ['chk_trades_quote_currency', `CHECK (quote_currency IS NULL OR quote_currency IN ('CNY','HKD','USD'))`],
    ['chk_trades_fx_rate_to_cny', `CHECK (fx_rate_to_cny IS NULL OR fx_rate_to_cny > 0)`],
    ['chk_trades_amount_cny', `CHECK (amount_cny IS NULL OR amount_cny >= 0)`]
  ]) {
    const ex = await pool.query(`SELECT 1 FROM pg_constraint WHERE conname=$1 AND conrelid='trades'::regclass`, [c[0]]);
    if (ex.rowCount === 0) await pool.query(`ALTER TABLE trades ADD CONSTRAINT ${c[0]} ${c[1]}`);
  }
}

// ========== 074：历史港股人民币结算回填 ==========
// 旧导入记录的 amount 是券商成交结算金额，不能用 price×quantity 反推（部分券商数量单位不同）。
// 有成交日历史汇率时直接补齐 amount_cny；没有可靠汇率的记录继续保持 needs_review，禁止静默入账。
async function migration074BackfillLegacyHkdSettlement() {
  await pool.query(`ALTER TABLE trades DROP CONSTRAINT IF EXISTS chk_trades_amount_rel`);
  await pool.query(`
    WITH candidates AS (
      SELECT t.id, fx.rate
        FROM trades t
        CROSS JOIN LATERAL (
          SELECT rate::numeric AS rate
            FROM market.fx_rates
           WHERE base_currency='HKD' AND quote_currency='CNY'
             AND rate_date <= COALESCE(t.trade_date, left(t.date, 10))::date
           ORDER BY rate_date DESC, fetched_at DESC, source_id DESC
           LIMIT 1
        ) fx
       WHERE t.quote_currency='HKD'
         AND t.amount_cny IS NULL
         AND t.amount IS NOT NULL
         AND t.currency_status <> 'complete'
    )
    UPDATE trades t
       SET fx_rate_to_cny = c.rate,
           amount_cny = ROUND(t.amount * c.rate, 4),
           currency_status = 'complete'
      FROM candidates c
     WHERE t.id = c.id
  `);
  await pool.query(`
    ALTER TABLE trades ADD CONSTRAINT chk_trades_amount_rel
      CHECK (direction IN ('open','adjust') OR amount IS NULL OR ABS(amount - ROUND(price*quantity, 2)) < 0.02) NOT VALID
  `);
}

// ========== 075：任务执行结果与外部请求保护 ==========
async function migration075JobExecutionProtection() {
  await pool.query(`
    ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS external_call_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS external_sources JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS datasets JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS error_type TEXT;
    CREATE INDEX IF NOT EXISTS idx_job_runs_slot_status ON job_runs(slot_id,status);
  `);
}

// ========== 076：跨 Worker 外部请求预算与数据集锁 ==========
async function migration076ExternalCallProtection() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ops.external_call_budgets (
      source TEXT NOT NULL,
      window_type TEXT NOT NULL CHECK (window_type IN ('minute','day')),
      window_key TEXT NOT NULL,
      call_count INTEGER NOT NULL DEFAULT 0,
      budget_limit INTEGER NOT NULL,
      circuit_open BOOLEAN NOT NULL DEFAULT false,
      last_error TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (source, window_type, window_key)
    );
    CREATE INDEX IF NOT EXISTS idx_external_call_budgets_updated
      ON ops.external_call_budgets(updated_at);
  `);
}

// ========== 078：按 Token＋接口隔离外部熔断 ==========
async function migration078ExternalCircuits() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ops.external_circuits (
      source TEXT NOT NULL,
      api_name TEXT NOT NULL,
      token_fingerprint TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','closed')),
      opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      recover_at TIMESTAMPTZ,
      probe_in_flight BOOLEAN NOT NULL DEFAULT false,
      error_code TEXT,
      error_type TEXT,
      detail TEXT,
      last_success_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (source, api_name, token_fingerprint)
    );
    CREATE INDEX IF NOT EXISTS idx_external_circuits_open
      ON ops.external_circuits(source, state, recover_at);
    -- 预算表只负责调用计数；旧版本熔断列不再参与路由判断。
    ALTER TABLE ops.external_call_budgets DROP COLUMN IF EXISTS circuit_open;
  `);
}

// ========== 053：指数基线"已确认最早可用日期"落库（避免每次重启重复联网全量拉指数） ==========
// 此前用进程内存 Set 记录"数据源最早只能拉到这"，进程一重启就丢，导致每次启动都把
// 五个指数从基线到今天重新拉一遍。改为落库后：净值起点没变更早就不再联网重查。
async function migration053IndexBaselineSettled() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS index_baseline_settled (
      username TEXT NOT NULL,
      account_name TEXT NOT NULL,
      index_name TEXT NOT NULL,
      baseline_date TEXT NOT NULL,
      earliest_date TEXT,
      settled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (username, account_name, index_name)
    )
  `);
}

// ========== 054：套利机会模块——event.arbitrage_cases + event.arbitrage_case_documents ==========
// 套利机会模块（A 股套利 / 港股私有化 / 港股供股权）的两张核心业务表。
// 复用现有 event.documents、event.company_events、ops.data_sources、ops.raw_records、ops.sync_cursors。
async function migration054ArbitrageCases() {
  // 1. 登记数据源（hkex_announcements 新增；cninfo 已存在，补登记 cninfo_announcements 作为独立数据集标识）
  await pool.query(`
    INSERT INTO ops.data_sources(source_code,source_name,source_type,priority) VALUES
      ('hkex_announcements','港交所披露易','official',5),
      ('cninfo_announcements','巨潮资讯公告','official',5)
    ON CONFLICT(source_code) DO UPDATE SET source_name=EXCLUDED.source_name,source_type=EXCLUDED.source_type,priority=EXCLUDED.priority;
  `);

  // 2. event.arbitrage_cases —— 套利事件主表
  await pool.query(`
    CREATE TABLE IF NOT EXISTS event.arbitrage_cases (
      case_id              BIGSERIAL PRIMARY KEY,
      market               TEXT NOT NULL CHECK (market IN ('CN','HK')),
      strategy_type        TEXT NOT NULL CHECK (strategy_type IN ('a_cash_offer','a_share_swap','hk_privatisation','hk_rights')),
      source_id            SMALLINT NOT NULL REFERENCES ops.data_sources(source_id),
      source_key           TEXT NOT NULL,

      target_instrument_id  BIGINT REFERENCES core.instruments(instrument_id) ON DELETE SET NULL,
      reference_instrument_id BIGINT REFERENCES core.instruments(instrument_id) ON DELETE SET NULL,
      rights_instrument_id   BIGINT REFERENCES core.instruments(instrument_id) ON DELETE SET NULL,

      company_event_id     BIGINT REFERENCES event.company_events(event_id) ON DELETE SET NULL,
      primary_document_id  BIGINT REFERENCES event.documents(document_id) ON DELETE SET NULL,

      event_status         TEXT NOT NULL DEFAULT 'proposed'
                             CHECK (event_status IN ('proposed','in_progress','completed','terminated','expired')),
      review_status        TEXT NOT NULL DEFAULT 'pending'
                             CHECK (review_status IN ('pending','approved','rejected')),
      reviewed_by          TEXT,
      reviewed_at          TIMESTAMPTZ,

      -- 通用条款
      currency_code        TEXT,
      offer_price          NUMERIC(20,6) CHECK (offer_price IS NULL OR offer_price > 0),
      cash_choice_price    NUMERIC(20,6) CHECK (cash_choice_price IS NULL OR cash_choice_price > 0),
      cash_component       NUMERIC(20,6) CHECK (cash_component IS NULL OR cash_component >= 0),
      swap_ratio           NUMERIC(20,8) CHECK (swap_ratio IS NULL OR swap_ratio > 0),

      -- 供股条款
      subscription_price       NUMERIC(20,6) CHECK (subscription_price IS NULL OR subscription_price > 0),
      rights_units_per_new_share INTEGER CHECK (rights_units_per_new_share IS NULL OR rights_units_per_new_share > 0),
      rights_ratio_numerator   INTEGER CHECK (rights_ratio_numerator IS NULL OR rights_ratio_numerator > 0),
      rights_ratio_denominator INTEGER CHECK (rights_ratio_denominator IS NULL OR rights_ratio_denominator > 0),

      -- 日期
      announced_at          DATE,
      terms_updated_at      TIMESTAMPTZ,
      expected_completion_date DATE,
      rights_trade_start    DATE,
      rights_trade_end      DATE,
      payment_deadline      DATE,
      listing_date          DATE,

      -- 港股字段
      offeror               TEXT,
      offeror_holding_pct   NUMERIC(8,4),
      registrar             TEXT,
      transaction_method    TEXT,
      headcount_required    BOOLEAN,
      shortable             BOOLEAN,

      -- 审计
      description           TEXT,
      raw_payload           JSONB NOT NULL DEFAULT '{}'::jsonb,
      formula_version       TEXT,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

      UNIQUE(source_id, source_key)
    );
  `);

  // 3. 索引
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_arb_cases_type_status ON event.arbitrage_cases(strategy_type, event_status, review_status);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_arb_cases_target ON event.arbitrage_cases(target_instrument_id) WHERE target_instrument_id IS NOT NULL;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_arb_cases_updated ON event.arbitrage_cases(updated_at DESC);`);

  // 4. event.arbitrage_case_documents —— 公告链
  await pool.query(`
    CREATE TABLE IF NOT EXISTS event.arbitrage_case_documents (
      case_id      BIGINT NOT NULL REFERENCES event.arbitrage_cases(case_id) ON DELETE CASCADE,
      document_id  BIGINT NOT NULL REFERENCES event.documents(document_id) ON DELETE CASCADE,
      relation_type TEXT NOT NULL DEFAULT 'announcement',
      announced_at DATE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (case_id, document_id)
    );
  `);
}

// ========== 055：套利解析准确性——稳定事件键、字段证据、固定换股价格 ==========
async function migration055ArbitrageParserAccuracy() {
  await pool.query(`
    ALTER TABLE event.arbitrage_cases
      ADD COLUMN IF NOT EXISTS event_key TEXT,
      ADD COLUMN IF NOT EXISTS target_swap_price NUMERIC(20,6),
      ADD COLUMN IF NOT EXISTS reference_swap_price NUMERIC(20,6),
      ADD COLUMN IF NOT EXISTS parse_status TEXT NOT NULL DEFAULT 'unparsed',
      ADD COLUMN IF NOT EXISTS parser_version TEXT,
      ADD COLUMN IF NOT EXISTS terms_confidence NUMERIC(5,4)
  `);
  await pool.query(`
    ALTER TABLE event.arbitrage_case_documents
      ADD COLUMN IF NOT EXISTS document_role TEXT NOT NULL DEFAULT 'other',
      ADD COLUMN IF NOT EXISTS parsed_payload JSONB,
      ADD COLUMN IF NOT EXISTS parser_version TEXT,
      ADD COLUMN IF NOT EXISTS parse_status TEXT NOT NULL DEFAULT 'unparsed',
      ADD COLUMN IF NOT EXISTS parsed_at TIMESTAMPTZ
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_arb_cases_event_key ON event.arbitrage_cases(event_key) WHERE event_key IS NOT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_arb_case_docs_parse ON event.arbitrage_case_documents(case_id, parse_status, document_role)`);
}

// ========== 056：全局港币汇率单一来源 ==========
// accounts.hk_rate / nav_history.hk_rate 仅保留为兼容缓存；所有新估值统一读取 market.fx_rates。
async function migration056GlobalFxRateSource() {
  await pool.query(`
    ALTER TABLE market.fx_rates
      ADD COLUMN IF NOT EXISTS fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_market_fx_rates_authoritative_day
      ON market.fx_rates(base_currency, quote_currency, rate_date)
  `);
  // 只有历史记录中的所有账户汇率一致时才自动回填，冲突日期留给专用修复脚本核对后处理。
  await pool.query(`
    INSERT INTO market.fx_rates(base_currency, quote_currency, rate_date, source_id, rate, fetched_at)
    SELECT 'HKD','CNY', nh.date::date, 7, MIN(nh.hk_rate), now()
      FROM nav_history nh
     WHERE nh.hk_rate IS NOT NULL AND nh.hk_rate > 0
     GROUP BY nh.date::date
    HAVING COUNT(DISTINCT nh.hk_rate) = 1
    ON CONFLICT (base_currency, quote_currency, rate_date) DO NOTHING
  `);
  // 当天没有净值记录时，用现有账户缓存初始化当天的全局值；后续由汇率任务更新。
  await pool.query(`
    INSERT INTO market.fx_rates(base_currency, quote_currency, rate_date, source_id, rate, fetched_at)
    SELECT 'HKD','CNY',(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date, 7, MIN(a.hk_rate), now()
      FROM accounts a
     WHERE a.hk_rate IS NOT NULL AND a.hk_rate > 0
    HAVING MIN(a.hk_rate) IS NOT NULL
    ON CONFLICT (base_currency, quote_currency, rate_date) DO NOTHING
  `);
}

// ========== 052：nav_history 记录每条快照所用港币汇率（治本：今日涨跌可正确拆分汇率影响） ==========
// 历史快照此前不记录汇率，导致"总资产今日涨跌"把汇率波动混进差额、且浮框无法正确拆分汇率影响。
// 加可空列 hk_rate，recordNav / 后台快照任务写入时带上当时 data.hkRate；旧行留 NULL（浮框残差兜底）。
async function migration052NavHistoryHkRate() {
  await pool.query(`ALTER TABLE nav_history ADD COLUMN IF NOT EXISTS hk_rate numeric(10,6)`);
  // 历史快照此前无汇率记录 → 用账户当前 hk_rate 近似回填（HKD/CNY 极稳定，误差可忽略），
  // 让浮框"汇率影响"可立刻基于昨日快照汇率直接算，而非残差兜底。
  await pool.query(`
    UPDATE nav_history nh
    SET hk_rate = a.hk_rate
    FROM accounts a
    WHERE nh.hk_rate IS NULL
      AND a.username = nh.username
      AND a.account_name = nh.account_name
      AND a.hk_rate IS NOT NULL
      AND a.hk_rate > 0
  `);
}

// ========== 177：套利换股结算（套利事件 → 持仓账本自动转换） ==========
// 换股吸收合并完成后，被合并方退市、持仓失去行情；按公告换股比例把持仓转为合并方证券。
// 该表保存每个账户的结算计划与执行结果，唯一键保证同一案件/账户/来源证券只结算一次。
async function migration177StockSwapSettlement() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS event.stock_swap_settlements (
      settlement_id BIGSERIAL PRIMARY KEY,
      case_id INTEGER NOT NULL REFERENCES event.arbitrage_cases(case_id) ON DELETE CASCADE,
      username TEXT NOT NULL,
      account_name TEXT NOT NULL,
      account_id TEXT,
      source_instrument_id BIGINT NOT NULL,
      target_instrument_id BIGINT NOT NULL,
      settlement_date DATE NOT NULL,
      ratio_applied NUMERIC(20,6) NOT NULL,
      source_quantity NUMERIC(20,4) NOT NULL,
      target_quantity NUMERIC(20,4) NOT NULL,
      existing_target_quantity NUMERIC(20,4) NOT NULL DEFAULT 0,
      cost_total_before NUMERIC(20,4) NOT NULL,
      cost_unit_after NUMERIC(20,6) NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      applied_trade_ids JSONB,
      evidence_document_id BIGINT,
      error_message TEXT,
      applied_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT chk_stock_swap_settlement_status
        CHECK (status IN ('pending','applied','failed','skipped'))
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_swap_settlement_scope
      ON event.stock_swap_settlements(case_id, username, account_name, source_instrument_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_stock_swap_settlement_status
      ON event.stock_swap_settlements(status, settlement_date DESC, settlement_id DESC)
  `);
}

// ========== 179：持仓基准快照「同账户同日同证券唯一」（2026-10-30，并发重复写入的防线二）==========
// 背景：基准补齐原先在同一条 INSERT 的 CTE 里取 advisory lock，READ COMMITTED 下等待者仍用旧快照，
// 并发两次调用会给同一证券写两条（隔离库复现）。代码侧已改为「独立语句取锁 + 同事务写入」，
// 本迁移再加一道库级约束：同一账户同一业务日同一证券只允许一条【基准】行。
// 只约束 source='manual_reconciliation'：券商导入允许同日期多批次并存（各有 batch_id，
// 读取侧按 nav_history.import_batch_id 过滤），不能被这条约束挡住。
// 建索引前清理该子集已有的重复行（只可能来自修复前的并发写）：同一事实的重复写入，
// 保留 snapshot_id 最小的一条，删除条数写日志；生产核对时该子集 0 组重复，此清理通常为空跑。
async function migration179NavBasisUniqueness() {
  // 注意：数据修改语句只能放在 WITH 里，不能写成 FROM (DELETE ... RETURNING)。
  const { rows } = await pool.query(`
    WITH deleted AS (
      DELETE FROM nav_position_snapshots s
       USING (
         SELECT ctid, row_number() OVER (
                  PARTITION BY username, account_name, snapshot_date, instrument_code
                  ORDER BY snapshot_id
                ) AS rn
           FROM nav_position_snapshots
          WHERE source = 'manual_reconciliation'
       ) d
       WHERE s.ctid = d.ctid AND d.rn > 1
      RETURNING 1
    )
    SELECT count(*)::int AS deleted FROM deleted
  `);
  const deleted = (rows[0] && rows[0].deleted) || 0;
  if (deleted > 0) {
    console.warn('[migrate] 179 清理持仓基准重复行', deleted, '条（同一账户同日同证券，保留 snapshot_id 最小的一条）');
  }
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_nav_position_basis_scope
      ON nav_position_snapshots(username, account_name, snapshot_date, instrument_code)
      WHERE source = 'manual_reconciliation'
  `);
}

module.exports = {
  migration049SessionRevocation,
  migration050CapabilityPermissions,
  migration051AuditResultMetadata,
  migration057IpoHistorySync,
  migration059IpoReportsSchema,
  migration060SseListingAnnouncementSource,
  migration061JobOrchestration,
  migration062AlertDeliveryRetry,
  migration063AlertSendingStatus,
  migration064AlertSendingStartedAt,
  migration065AlertRecoveryAttempts,
  migration066ArbitrageParseRetry,
  migration067JobRequestPayload,
  migration068IpoBondLiquidityCalibration,
  migration069NormalizeDailyPriceDates,
  migration070RemoveDuplicateLegacyPriceDates,
  migration071DeduplicateInstrumentEvents,
  migration072AuthoritativeNavImportAnchor,
  migration073NavAttributionIntegrity,
  migration074BackfillLegacyHkdSettlement,
  migration075JobExecutionProtection,
  migration076ExternalCallProtection,
  migration078ExternalCircuits,
  migration053IndexBaselineSettled,
  migration054ArbitrageCases,
  migration055ArbitrageParserAccuracy,
  migration056GlobalFxRateSource,
  migration177StockSwapSettlement,
  migration179NavBasisUniqueness,
  migration052NavHistoryHkRate,
};
