// 本文件由 server/db.js 物理拆分而来，函数体未改动，仅调整文件归属。
const { pool, crypto, fs, path, DATA_DIR, DEFAULT_FEE_SETTINGS } = require('./connection');
const { uid, round, bulkInsert, hashPwd, safeEqual, verifyPwd, hashString } = require('./util');
const { seedBrokers } = require('./brokers');
const { migrateAccountsTable } = require('./accounts');

async function migration001Init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      password TEXT NOT NULL,
      accounts TEXT NOT NULL DEFAULT '[]'
    );
    -- 用户资料列（头像/昵称/简介/邮箱/最后登录），幂等补齐，可重复执行
    ALTER TABLE users ADD COLUMN IF NOT EXISTS nickname text;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS bio text;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar text;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email text;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login timestamptz;
    -- 平台管理后台：用户角色/状态/注册时间（默认普通用户、正常状态）
    ALTER TABLE users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'user';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
    CREATE TABLE IF NOT EXISTS account_data (
      username TEXT NOT NULL,
      account_name TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
      PRIMARY KEY (username, account_name)
    );
    CREATE TABLE IF NOT EXISTS positions (
      id TEXT NOT NULL,
      username TEXT NOT NULL,
      account_name TEXT NOT NULL,
      code TEXT NOT NULL DEFAULT '',
      name TEXT DEFAULT '',
      price double precision DEFAULT 0,
      quantity double precision DEFAULT 0,
      cost double precision DEFAULT 0,
      type TEXT DEFAULT '',
      subtype TEXT DEFAULT '',
      note TEXT DEFAULT '',
      PRIMARY KEY (id, username, account_name)
    );
    CREATE TABLE IF NOT EXISTS trades (
      id TEXT NOT NULL,
      username TEXT NOT NULL,
      account_name TEXT NOT NULL,
      date TEXT DEFAULT '',
      created_at TEXT DEFAULT '',
      code TEXT DEFAULT '',
      name TEXT DEFAULT '',
      direction TEXT DEFAULT 'buy',
      price double precision DEFAULT 0,
      quantity double precision DEFAULT 0,
      amount double precision DEFAULT 0,
      type TEXT DEFAULT '',
      subtype TEXT DEFAULT '',
      note TEXT DEFAULT '',
      PRIMARY KEY (id, username, account_name)
    );
    CREATE TABLE IF NOT EXISTS nav_history (
      username TEXT NOT NULL,
      account_name TEXT NOT NULL,
      date TEXT NOT NULL,
      nav double precision DEFAULT 1.0,
      total_asset double precision DEFAULT 0,
      invested double precision DEFAULT NULL,
      PRIMARY KEY (username, account_name, date)
    );
    CREATE TABLE IF NOT EXISTS cash_flows (
      id TEXT NOT NULL,
      username TEXT NOT NULL,
      account_name TEXT NOT NULL,
      date TEXT DEFAULT '',
      created_at TEXT DEFAULT '',
      amount double precision DEFAULT 0,
      note TEXT DEFAULT '',
      PRIMARY KEY (id, username, account_name)
    );
    CREATE TABLE IF NOT EXISTS daily_prices (
      username TEXT NOT NULL,
      account_name TEXT NOT NULL,
      date TEXT NOT NULL,
      code TEXT NOT NULL,
      name TEXT DEFAULT '',
      price double precision DEFAULT 0,
      PRIMARY KEY (username, account_name, date, code)
    );
    CREATE TABLE IF NOT EXISTS index_history (
      username TEXT NOT NULL,
      account_name TEXT NOT NULL,
      date TEXT NOT NULL,
      name TEXT NOT NULL,
      close double precision DEFAULT 0,
      PRIMARY KEY (username, account_name, date, name)
    );
  `);
  // 旧库已存在 nav_history（无 invested 列）时补列；幂等，可重复执行
  await pool.query('ALTER TABLE nav_history ADD COLUMN IF NOT EXISTS invested double precision DEFAULT NULL');
  // 乐观锁版本号：每次整包保存自增；并发保存靠条件更新检测到冲突（默认 0，旧数据不受影响）
  await pool.query('ALTER TABLE account_data ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0');

  // ===== P2-4：金额/价格/净值由 double precision 改为 numeric(p,s)，消除浮点累计误差 =====
  // 旧列为 double，USING 表达式可无损转换；重复执行幂等（已是 numeric 则 no-op）
  const numericAlters = [
    'ALTER TABLE positions ALTER COLUMN price TYPE numeric(20,4) USING price::numeric(20,4)',
    'ALTER TABLE positions ALTER COLUMN quantity TYPE numeric(20,4) USING quantity::numeric(20,4)',
    'ALTER TABLE positions ALTER COLUMN cost TYPE numeric(20,4) USING cost::numeric(20,4)',
    'ALTER TABLE trades ALTER COLUMN price TYPE numeric(20,4) USING price::numeric(20,4)',
    'ALTER TABLE trades ALTER COLUMN quantity TYPE numeric(20,4) USING quantity::numeric(20,4)',
    'ALTER TABLE trades ALTER COLUMN amount TYPE numeric(20,4) USING amount::numeric(20,4)',
    'ALTER TABLE nav_history ALTER COLUMN nav TYPE numeric(30,6) USING nav::numeric(30,6)',
    'ALTER TABLE nav_history ALTER COLUMN total_asset TYPE numeric(20,2) USING total_asset::numeric(20,2)',
    'ALTER TABLE nav_history ALTER COLUMN invested TYPE numeric(20,2) USING invested::numeric(20,2)',
    'ALTER TABLE cash_flows ALTER COLUMN amount TYPE numeric(20,2) USING amount::numeric(20,2)',
    'ALTER TABLE daily_prices ALTER COLUMN price TYPE numeric(20,4) USING price::numeric(20,4)',
    'ALTER TABLE index_history ALTER COLUMN close TYPE numeric(20,4) USING close::numeric(20,4)'
  ];
  for (const sql of numericAlters) {
    try { await pool.query(sql); } catch (e) { console.warn('[schema] numeric 转换跳过:', e.message); }
  }

  // ===== 费用列：trades 增加 commission/stamp_tax/transfer_fee/other_fee =====
  const feeAlters = [
    'ALTER TABLE trades ADD COLUMN IF NOT EXISTS commission numeric(20,4) DEFAULT 0',
    'ALTER TABLE trades ADD COLUMN IF NOT EXISTS stamp_tax numeric(20,4) DEFAULT 0',
    'ALTER TABLE trades ADD COLUMN IF NOT EXISTS transfer_fee numeric(20,4) DEFAULT 0',
    'ALTER TABLE trades ADD COLUMN IF NOT EXISTS other_fee numeric(20,4) DEFAULT 0'
  ];
  for (const sql of feeAlters) {
    try { await pool.query(sql); } catch (e) { console.warn('[schema] 费用列跳过:', e.message); }
  }

  // ===== 券商字段：accounts 表补 broker 列（已存在则幂等跳过）=====
  try { await pool.query('ALTER TABLE accounts ADD COLUMN IF NOT EXISTS broker TEXT NOT NULL DEFAULT \'other\''); } catch (e) { console.warn('[schema] broker 列跳过:', e.message); }

  // ===== P2-3：账户元数据表（cash_base/hk_rate 结构化，FK 指向 users）=====
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL REFERENCES users(username),
      account_name TEXT NOT NULL,
      broker TEXT NOT NULL DEFAULT 'other',
      cash_base numeric(20,2) NOT NULL DEFAULT 0,
      hk_rate numeric(10,6) NOT NULL DEFAULT 0.868,
      version INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
      updated_at TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
      UNIQUE (username, account_name)
    );
  `);

  // ===== 券商字典表：A股/港股/美股券商清单（市场用 market 区分，方便日后扩展）=====
  await pool.query(`
    CREATE TABLE IF NOT EXISTS brokers (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      market TEXT NOT NULL DEFAULT 'A',
      sort_order INTEGER NOT NULL DEFAULT 0,
      import_unit TEXT NOT NULL DEFAULT 'sheet'
    );
  `);
  // 兼容已存在表：补齐 import_unit 列（导入持仓时数量按「手」还是「张」换算的依据）
  await pool.query("ALTER TABLE brokers ADD COLUMN IF NOT EXISTS import_unit TEXT NOT NULL DEFAULT 'sheet'");
  await seedBrokers();

  // ===== P2-5：任务执行记录表（worker 幂等锁 + 执行历史 + 告警依据）=====
  await pool.query(`
    CREATE TABLE IF NOT EXISTS job_runs (
      id SERIAL PRIMARY KEY,
      job TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      started_at TIMESTAMPTZ DEFAULT now(),
      finished_at TIMESTAMPTZ,
      detail TEXT DEFAULT ''
    );
  `);
  // 兼容早期残留表（缺 locked_until 列）：补齐，保证幂等可重复执行
  await pool.query('ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ');

  // ===== 后台：平台配置（注册开关/邀请码/邮箱验证等，DB 优先于 env）=====
  await pool.query(`
    CREATE TABLE IF NOT EXISTS platform_config (
      key TEXT PRIMARY KEY,
      value TEXT DEFAULT '',
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  // ===== 后台：操作审计日志 =====
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_audit_log (
      id SERIAL PRIMARY KEY,
      actor TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL DEFAULT '',
      target TEXT NOT NULL DEFAULT '',
      detail TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  // 账户元数据表幂等迁移（从旧 users.accounts JSON + account_data JSON 填充，不覆盖已有）
  await migrateAccountsTable();
}

// 可转债安全性：只写入“成功刷新”的不可变快照。
// 上游失败或数据校验失败时不落库，读取端会自然回退到最后一份有效数据。
async function migration002BondSafetySnapshots() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bond_safety_snapshots (
      id BIGSERIAL PRIMARY KEY,
      refreshed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      source_updated_at TIMESTAMPTZ,
      row_count INTEGER NOT NULL CHECK (row_count >= 0),
      data JSONB NOT NULL,
      diagnostics JSONB NOT NULL DEFAULT '{}'::jsonb,
      refresh_reason TEXT NOT NULL DEFAULT 'scheduled'
    );
    CREATE INDEX IF NOT EXISTS idx_bond_safety_snapshots_refreshed
      ON bond_safety_snapshots (refreshed_at DESC);
  `);
}

// 上游市场数据共享缓存：跨用户、跨 Web/worker 进程复用，刷新失败时保留最后成功值。
async function migration003MarketDataCache() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS market_instruments (
      ts_code TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'tushare',
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_market_instruments_fetched
      ON market_instruments (fetched_at DESC);

    CREATE TABLE IF NOT EXISTS market_quote_cache (
      symbol TEXT NOT NULL,
      source TEXT NOT NULL,
      code TEXT NOT NULL,
      market TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      price NUMERIC(20,4),
      change_pct NUMERIC(20,6),
      quote_time TIMESTAMPTZ,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (symbol, source)
    );
    CREATE INDEX IF NOT EXISTS idx_market_quote_cache_fetched
      ON market_quote_cache (source, fetched_at DESC);
  `);
}

// Tushare 2000积分财务接口需逐只股票读取；结果持久化，后续仅按 TTL 增量更新。
async function migration004BondSafetyFinancialCache() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bond_safety_financial_cache (
      ts_code TEXT PRIMARY KEY,
      stock_name TEXT NOT NULL DEFAULT '',
      report_end_date TEXT,
      announced_at TEXT,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_bond_safety_financial_fetched
      ON bond_safety_financial_cache (fetched_at DESC);
  `);
}

// 个股分析：财务事实全局共享，自选股按用户隔离；原始财报保留全部公告版本。
async function migration005StockAnalysis() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stock_analysis_stocks (
      ts_code TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      industry TEXT NOT NULL DEFAULT '',
      market TEXT NOT NULL DEFAULT '',
      list_date TEXT,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS stock_watchlist (
      username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      ts_code TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (username, ts_code)
    );

    CREATE TABLE IF NOT EXISTS stock_income_statements (
      id BIGSERIAL PRIMARY KEY,
      ts_code TEXT NOT NULL,
      version_key TEXT NOT NULL,
      end_date TEXT NOT NULL,
      ann_date TEXT,
      f_ann_date TEXT,
      report_type TEXT,
      comp_type TEXT,
      update_flag TEXT,
      data JSONB NOT NULL,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (ts_code, version_key)
    );
    CREATE INDEX IF NOT EXISTS idx_stock_income_period ON stock_income_statements (ts_code, end_date DESC);

    CREATE TABLE IF NOT EXISTS stock_balance_sheets (
      id BIGSERIAL PRIMARY KEY,
      ts_code TEXT NOT NULL,
      version_key TEXT NOT NULL,
      end_date TEXT NOT NULL,
      ann_date TEXT,
      f_ann_date TEXT,
      report_type TEXT,
      comp_type TEXT,
      update_flag TEXT,
      data JSONB NOT NULL,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (ts_code, version_key)
    );
    CREATE INDEX IF NOT EXISTS idx_stock_balance_period ON stock_balance_sheets (ts_code, end_date DESC);

    CREATE TABLE IF NOT EXISTS stock_cashflow_statements (
      id BIGSERIAL PRIMARY KEY,
      ts_code TEXT NOT NULL,
      version_key TEXT NOT NULL,
      end_date TEXT NOT NULL,
      ann_date TEXT,
      f_ann_date TEXT,
      report_type TEXT,
      comp_type TEXT,
      update_flag TEXT,
      data JSONB NOT NULL,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (ts_code, version_key)
    );
    CREATE INDEX IF NOT EXISTS idx_stock_cashflow_period ON stock_cashflow_statements (ts_code, end_date DESC);

    CREATE TABLE IF NOT EXISTS stock_financial_indicators (
      id BIGSERIAL PRIMARY KEY,
      ts_code TEXT NOT NULL,
      version_key TEXT NOT NULL,
      end_date TEXT NOT NULL,
      ann_date TEXT,
      data JSONB NOT NULL,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (ts_code, version_key)
    );
    CREATE INDEX IF NOT EXISTS idx_stock_indicator_period ON stock_financial_indicators (ts_code, end_date DESC);

    CREATE TABLE IF NOT EXISTS stock_dividends (
      id BIGSERIAL PRIMARY KEY,
      ts_code TEXT NOT NULL,
      version_key TEXT NOT NULL,
      end_date TEXT,
      ann_date TEXT,
      ex_date TEXT,
      pay_date TEXT,
      div_proc TEXT,
      data JSONB NOT NULL,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (ts_code, version_key)
    );
    CREATE INDEX IF NOT EXISTS idx_stock_dividend_period ON stock_dividends (ts_code, end_date DESC);

    CREATE TABLE IF NOT EXISTS stock_forecasts (
      id BIGSERIAL PRIMARY KEY,
      ts_code TEXT NOT NULL,
      version_key TEXT NOT NULL,
      end_date TEXT,
      ann_date TEXT,
      data JSONB NOT NULL,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (ts_code, version_key)
    );
    CREATE INDEX IF NOT EXISTS idx_stock_forecast_period ON stock_forecasts (ts_code, end_date DESC);

    CREATE TABLE IF NOT EXISTS stock_daily_valuations (
      ts_code TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      close NUMERIC(20,4),
      adj_factor NUMERIC(24,8),
      pe NUMERIC(24,8),
      pe_ttm NUMERIC(24,8),
      pb NUMERIC(24,8),
      dv_ttm NUMERIC(24,8),
      total_share NUMERIC(24,4),
      total_mv NUMERIC(24,4),
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (ts_code, trade_date)
    );
    CREATE INDEX IF NOT EXISTS idx_stock_valuation_date ON stock_daily_valuations (ts_code, trade_date DESC);

    CREATE TABLE IF NOT EXISTS stock_events (
      id BIGSERIAL PRIMARY KEY,
      ts_code TEXT NOT NULL,
      source TEXT NOT NULL,
      event_key TEXT NOT NULL,
      event_date TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '',
      is_official BOOLEAN NOT NULL DEFAULT false,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (source, event_key)
    );
    CREATE INDEX IF NOT EXISTS idx_stock_events_date ON stock_events (ts_code, event_date DESC);

    CREATE TABLE IF NOT EXISTS stock_analysis_snapshots (
      ts_code TEXT PRIMARY KEY,
      refreshed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      source_updated_at TIMESTAMPTZ,
      formula_version TEXT NOT NULL DEFAULT '1',
      data JSONB NOT NULL,
      diagnostics JSONB NOT NULL DEFAULT '{}'::jsonb
    );

    CREATE TABLE IF NOT EXISTS stock_data_sync_state (
      ts_code TEXT NOT NULL,
      dataset TEXT NOT NULL,
      last_success_date TEXT,
      last_attempt_at TIMESTAMPTZ,
      last_error TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (ts_code, dataset)
    );
  `);
}

async function migration006StockAnalysisOverview() {
  await pool.query(`
    ALTER TABLE stock_daily_valuations ADD COLUMN IF NOT EXISTS float_share NUMERIC(24,4);
    ALTER TABLE stock_daily_valuations ADD COLUMN IF NOT EXISTS free_share NUMERIC(24,4);
    ALTER TABLE stock_daily_valuations ADD COLUMN IF NOT EXISTS circ_mv NUMERIC(24,4);
  `);
}

async function migration007FinancialDataArchitecture() {
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS ops;
    CREATE SCHEMA IF NOT EXISTS core;
    CREATE SCHEMA IF NOT EXISTS market;
    CREATE SCHEMA IF NOT EXISTS fundamental;
    CREATE SCHEMA IF NOT EXISTS event;
    CREATE SCHEMA IF NOT EXISTS analytics;

    CREATE TABLE IF NOT EXISTS ops.data_sources (
      source_id SMALLSERIAL PRIMARY KEY,
      source_code TEXT NOT NULL UNIQUE,
      source_name TEXT NOT NULL,
      source_type TEXT NOT NULL DEFAULT 'official',
      priority SMALLINT NOT NULL DEFAULT 100,
      enabled BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    INSERT INTO ops.data_sources(source_code,source_name,source_type,priority) VALUES
      ('tushare','Tushare','official',10),('tencent','腾讯行情','quote',10),
      ('cninfo','巨潮资讯','official',5),('eastmoney','东方财富','reference',20),
      ('xueqiu','雪球','discussion',80),('guba','股吧','discussion',90),
      ('calculated','系统计算','calculated',1)
    ON CONFLICT(source_code) DO UPDATE SET source_name=EXCLUDED.source_name,source_type=EXCLUDED.source_type,priority=EXCLUDED.priority;

    CREATE TABLE IF NOT EXISTS ops.ingestion_runs (
      run_id BIGSERIAL PRIMARY KEY,
      source_id SMALLINT REFERENCES ops.data_sources(source_id),
      dataset_code TEXT NOT NULL,
      request_range JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'running',
      row_count INTEGER NOT NULL DEFAULT 0,
      error_message TEXT NOT NULL DEFAULT '',
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_ingestion_runs_dataset ON ops.ingestion_runs(dataset_code,started_at DESC);

    CREATE TABLE IF NOT EXISTS ops.raw_records (
      raw_record_id BIGSERIAL PRIMARY KEY,
      run_id BIGINT REFERENCES ops.ingestion_runs(run_id) ON DELETE SET NULL,
      source_id SMALLINT NOT NULL REFERENCES ops.data_sources(source_id),
      dataset_code TEXT NOT NULL,
      source_key TEXT NOT NULL,
      source_updated_at TIMESTAMPTZ,
      payload JSONB NOT NULL,
      payload_hash TEXT NOT NULL,
      ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(source_id,dataset_code,source_key,payload_hash)
    );

    CREATE TABLE IF NOT EXISTS core.companies (
      company_id BIGSERIAL PRIMARY KEY,
      legal_name TEXT NOT NULL,
      short_name TEXT NOT NULL DEFAULT '',
      country_code CHAR(2) NOT NULL DEFAULT 'CN',
      registration_code TEXT,
      company_type TEXT NOT NULL DEFAULT '',
      registered_capital NUMERIC(28,4),
      raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_companies_cn_name ON core.companies(country_code,legal_name);

    CREATE TABLE IF NOT EXISTS core.instruments (
      instrument_id BIGSERIAL PRIMARY KEY,
      canonical_code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL DEFAULT '',
      asset_class TEXT NOT NULL,
      market TEXT NOT NULL DEFAULT '',
      exchange_code TEXT NOT NULL DEFAULT '',
      currency_code CHAR(3) NOT NULL DEFAULT 'CNY',
      list_date DATE,
      delist_date DATE,
      status TEXT NOT NULL DEFAULT 'listed',
      raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS core.instrument_identifiers (
      identifier_id BIGSERIAL PRIMARY KEY,
      instrument_id BIGINT NOT NULL REFERENCES core.instruments(instrument_id) ON DELETE CASCADE,
      source_id SMALLINT REFERENCES ops.data_sources(source_id),
      identifier_type TEXT NOT NULL,
      identifier_value TEXT NOT NULL,
      valid_from DATE,
      valid_to DATE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(source_id,identifier_type,identifier_value,valid_from)
    );
    CREATE INDEX IF NOT EXISTS idx_instrument_identifiers_instrument ON core.instrument_identifiers(instrument_id);

    CREATE TABLE IF NOT EXISTS core.company_instruments (
      company_id BIGINT NOT NULL REFERENCES core.companies(company_id) ON DELETE CASCADE,
      instrument_id BIGINT NOT NULL REFERENCES core.instruments(instrument_id) ON DELETE CASCADE,
      relation_type TEXT NOT NULL DEFAULT 'issued_by',
      valid_from DATE,
      valid_to DATE,
      PRIMARY KEY(company_id,instrument_id,relation_type)
    );

    CREATE TABLE IF NOT EXISTS core.industry_taxonomies (
      taxonomy_id SMALLSERIAL PRIMARY KEY,
      taxonomy_code TEXT NOT NULL UNIQUE,
      taxonomy_name TEXT NOT NULL,
      version TEXT NOT NULL DEFAULT ''
    );
    INSERT INTO core.industry_taxonomies(taxonomy_code,taxonomy_name,version) VALUES
      ('SW2021','申万行业','2021'),('TUSHARE_BASIC','Tushare基础行业','')
    ON CONFLICT(taxonomy_code) DO NOTHING;

    CREATE TABLE IF NOT EXISTS core.industry_nodes (
      industry_node_id BIGSERIAL PRIMARY KEY,
      taxonomy_id SMALLINT NOT NULL REFERENCES core.industry_taxonomies(taxonomy_id),
      industry_code TEXT NOT NULL,
      industry_name TEXT NOT NULL,
      level SMALLINT,
      parent_id BIGINT REFERENCES core.industry_nodes(industry_node_id),
      UNIQUE(taxonomy_id,industry_code)
    );

    CREATE TABLE IF NOT EXISTS core.company_industry_memberships (
      membership_id BIGSERIAL PRIMARY KEY,
      company_id BIGINT NOT NULL REFERENCES core.companies(company_id) ON DELETE CASCADE,
      industry_node_id BIGINT NOT NULL REFERENCES core.industry_nodes(industry_node_id),
      source_id SMALLINT REFERENCES ops.data_sources(source_id),
      valid_from DATE,
      valid_to DATE,
      announced_at DATE,
      is_current BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(company_id,industry_node_id,valid_from)
    );
    CREATE INDEX IF NOT EXISTS idx_company_industry_current ON core.company_industry_memberships(company_id,is_current);

    CREATE TABLE IF NOT EXISTS core.company_controllers (
      controller_id BIGSERIAL PRIMARY KEY,
      company_id BIGINT NOT NULL REFERENCES core.companies(company_id) ON DELETE CASCADE,
      controller_name TEXT NOT NULL,
      controller_type TEXT NOT NULL DEFAULT 'other',
      control_ratio NUMERIC(18,8),
      source_id SMALLINT REFERENCES ops.data_sources(source_id),
      source_document_id BIGINT,
      valid_from DATE,
      valid_to DATE,
      announced_at DATE,
      is_current BOOLEAN NOT NULL DEFAULT true,
      confidence NUMERIC(8,6),
      raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(company_id,controller_name,valid_from)
    );
    CREATE INDEX IF NOT EXISTS idx_company_controller_current ON core.company_controllers(company_id,is_current);

    CREATE TABLE IF NOT EXISTS market.daily_bars (
      instrument_id BIGINT NOT NULL REFERENCES core.instruments(instrument_id) ON DELETE CASCADE,
      trade_date DATE NOT NULL,
      source_id SMALLINT NOT NULL REFERENCES ops.data_sources(source_id),
      open NUMERIC(24,8),high NUMERIC(24,8),low NUMERIC(24,8),close NUMERIC(24,8),
      volume NUMERIC(30,4),amount NUMERIC(30,4),
      ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY(instrument_id,trade_date,source_id)
    );
    CREATE INDEX IF NOT EXISTS idx_daily_bars_lookup ON market.daily_bars(instrument_id,trade_date DESC);

    CREATE TABLE IF NOT EXISTS market.adjustment_factors (
      instrument_id BIGINT NOT NULL REFERENCES core.instruments(instrument_id) ON DELETE CASCADE,
      trade_date DATE NOT NULL,
      source_id SMALLINT NOT NULL REFERENCES ops.data_sources(source_id),
      adj_factor NUMERIC(30,12) NOT NULL,
      ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY(instrument_id,trade_date,source_id)
    );

    CREATE TABLE IF NOT EXISTS market.daily_valuations (
      instrument_id BIGINT NOT NULL REFERENCES core.instruments(instrument_id) ON DELETE CASCADE,
      trade_date DATE NOT NULL,
      source_id SMALLINT NOT NULL REFERENCES ops.data_sources(source_id),
      pe_static NUMERIC(28,10),pe_ttm NUMERIC(28,10),pb NUMERIC(28,10),dividend_yield_ttm NUMERIC(28,10),
      total_market_cap NUMERIC(30,4),circulating_market_cap NUMERIC(30,4),free_float_market_cap NUMERIC(30,4),
      currency_code CHAR(3) NOT NULL DEFAULT 'CNY',
      ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY(instrument_id,trade_date,source_id)
    );
    CREATE INDEX IF NOT EXISTS idx_daily_valuations_lookup ON market.daily_valuations(instrument_id,trade_date DESC);

    CREATE TABLE IF NOT EXISTS market.share_capital_history (
      share_capital_id BIGSERIAL PRIMARY KEY,
      instrument_id BIGINT NOT NULL REFERENCES core.instruments(instrument_id) ON DELETE CASCADE,
      effective_date DATE NOT NULL,
      source_id SMALLINT NOT NULL REFERENCES ops.data_sources(source_id),
      total_shares NUMERIC(30,4),a_shares NUMERIC(30,4),h_shares NUMERIC(30,4),
      circulating_shares NUMERIC(30,4),free_float_shares NUMERIC(30,4),restricted_shares NUMERIC(30,4),
      ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(instrument_id,effective_date,source_id)
    );

    CREATE TABLE IF NOT EXISTS market.latest_quotes (
      instrument_id BIGINT NOT NULL REFERENCES core.instruments(instrument_id) ON DELETE CASCADE,
      source_id SMALLINT NOT NULL REFERENCES ops.data_sources(source_id),
      price NUMERIC(24,8) NOT NULL,
      currency_code CHAR(3) NOT NULL,
      quote_time TIMESTAMPTZ,
      is_stale BOOLEAN NOT NULL DEFAULT false,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY(instrument_id,source_id)
    );

    CREATE TABLE IF NOT EXISTS market.fx_rates (
      base_currency CHAR(3) NOT NULL,quote_currency CHAR(3) NOT NULL,rate_date DATE NOT NULL,
      source_id SMALLINT NOT NULL REFERENCES ops.data_sources(source_id),rate NUMERIC(28,12) NOT NULL,
      PRIMARY KEY(base_currency,quote_currency,rate_date,source_id)
    );

    CREATE TABLE IF NOT EXISTS fundamental.financial_reports (
      report_id BIGSERIAL PRIMARY KEY,
      company_id BIGINT NOT NULL REFERENCES core.companies(company_id) ON DELETE CASCADE,
      report_kind TEXT NOT NULL,
      period_end DATE NOT NULL,
      period_type TEXT NOT NULL,
      statement_scope TEXT NOT NULL DEFAULT 'consolidated',
      announced_at DATE,
      source_id SMALLINT NOT NULL REFERENCES ops.data_sources(source_id),
      source_version TEXT NOT NULL,
      update_flag TEXT NOT NULL DEFAULT '',
      is_current_version BOOLEAN NOT NULL DEFAULT true,
      raw_record_id BIGINT REFERENCES ops.raw_records(raw_record_id),
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(company_id,report_kind,period_end,source_id,source_version)
    );
    CREATE INDEX IF NOT EXISTS idx_financial_reports_period ON fundamental.financial_reports(company_id,period_end DESC,announced_at DESC);

    CREATE TABLE IF NOT EXISTS fundamental.financial_facts (
      fact_id BIGSERIAL PRIMARY KEY,
      report_id BIGINT NOT NULL REFERENCES fundamental.financial_reports(report_id) ON DELETE CASCADE,
      statement_type TEXT NOT NULL,
      metric_code TEXT NOT NULL,
      numeric_value NUMERIC(36,10),text_value TEXT,
      unit_code TEXT NOT NULL DEFAULT '',currency_code CHAR(3),source_field TEXT NOT NULL DEFAULT '',
      is_calculated BOOLEAN NOT NULL DEFAULT false,
      UNIQUE(report_id,metric_code)
    );
    CREATE INDEX IF NOT EXISTS idx_financial_facts_metric ON fundamental.financial_facts(metric_code,report_id);

    CREATE TABLE IF NOT EXISTS fundamental.financial_period_summary (
      company_id BIGINT NOT NULL REFERENCES core.companies(company_id) ON DELETE CASCADE,
      period_end DATE NOT NULL,announced_at DATE,
      net_profit_parent NUMERIC(30,4),net_profit_deducted NUMERIC(30,4),total_assets NUMERIC(30,4),
      equity_parent NUMERIC(30,4),operating_cashflow NUMERIC(30,4),goodwill NUMERIC(30,4),
      interest_expense NUMERIC(30,4),roe NUMERIC(20,8),roa NUMERIC(20,8),
      source_report_ids BIGINT[] NOT NULL DEFAULT '{}',updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY(company_id,period_end)
    );

    CREATE TABLE IF NOT EXISTS fundamental.corporate_actions (
      action_id BIGSERIAL PRIMARY KEY,
      instrument_id BIGINT NOT NULL REFERENCES core.instruments(instrument_id) ON DELETE CASCADE,
      action_type TEXT NOT NULL,fiscal_period_end DATE,announced_at DATE,record_date DATE,ex_date DATE,pay_date DATE,
      status TEXT NOT NULL DEFAULT '',cash_per_share_pre_tax NUMERIC(24,10),cash_per_share_after_tax NUMERIC(24,10),
      stock_dividend_ratio NUMERIC(24,10),capitalization_ratio NUMERIC(24,10),base_shares NUMERIC(30,4),
      total_cash_amount NUMERIC(30,4),currency_code CHAR(3) NOT NULL DEFAULT 'CNY',
      source_id SMALLINT NOT NULL REFERENCES ops.data_sources(source_id),source_key TEXT NOT NULL,raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),UNIQUE(source_id,source_key)
    );
    CREATE INDEX IF NOT EXISTS idx_corporate_actions_instrument ON fundamental.corporate_actions(instrument_id,fiscal_period_end DESC,ex_date DESC);

    CREATE TABLE IF NOT EXISTS fundamental.earnings_guidance (
      guidance_id BIGSERIAL PRIMARY KEY,
      company_id BIGINT NOT NULL REFERENCES core.companies(company_id) ON DELETE CASCADE,
      period_end DATE NOT NULL,guidance_type TEXT NOT NULL,announced_at DATE,
      profit_min NUMERIC(30,4),profit_max NUMERIC(30,4),change_min NUMERIC(20,8),change_max NUMERIC(20,8),
      summary TEXT NOT NULL DEFAULT '',change_reason TEXT NOT NULL DEFAULT '',currency_code CHAR(3) NOT NULL DEFAULT 'CNY',
      source_id SMALLINT NOT NULL REFERENCES ops.data_sources(source_id),source_key TEXT NOT NULL,raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),UNIQUE(source_id,source_key)
    );

    CREATE TABLE IF NOT EXISTS event.documents (
      document_id BIGSERIAL PRIMARY KEY,
      company_id BIGINT REFERENCES core.companies(company_id) ON DELETE CASCADE,
      document_type TEXT NOT NULL,title TEXT NOT NULL,announced_at DATE,url TEXT NOT NULL DEFAULT '',
      source_id SMALLINT NOT NULL REFERENCES ops.data_sources(source_id),content_hash TEXT NOT NULL DEFAULT '',
      raw_record_id BIGINT REFERENCES ops.raw_records(raw_record_id),raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),UNIQUE(source_id,url,content_hash)
    );

    CREATE TABLE IF NOT EXISTS event.company_events (
      event_id BIGSERIAL PRIMARY KEY,
      company_id BIGINT NOT NULL REFERENCES core.companies(company_id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,event_date DATE NOT NULL,title TEXT NOT NULL,importance SMALLINT NOT NULL DEFAULT 0,
      is_official BOOLEAN NOT NULL DEFAULT false,source_id SMALLINT NOT NULL REFERENCES ops.data_sources(source_id),
      document_id BIGINT REFERENCES event.documents(document_id),source_key TEXT NOT NULL,details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),UNIQUE(source_id,source_key)
    );
    CREATE INDEX IF NOT EXISTS idx_company_events_date ON event.company_events(company_id,event_date DESC);

    CREATE TABLE IF NOT EXISTS analytics.metric_definitions (
      metric_code TEXT PRIMARY KEY,metric_name TEXT NOT NULL,category TEXT NOT NULL,value_type TEXT NOT NULL DEFAULT 'numeric',
      unit_code TEXT NOT NULL DEFAULT '',formula_text TEXT NOT NULL DEFAULT '',formula_version TEXT NOT NULL DEFAULT '1',
      negative_rule TEXT NOT NULL DEFAULT '',zero_rule TEXT NOT NULL DEFAULT '',enabled BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS analytics.metric_values (
      metric_value_id BIGSERIAL PRIMARY KEY,
      instrument_id BIGINT NOT NULL REFERENCES core.instruments(instrument_id) ON DELETE CASCADE,
      metric_code TEXT NOT NULL REFERENCES analytics.metric_definitions(metric_code),
      as_of_date DATE NOT NULL,period_start DATE NOT NULL DEFAULT DATE '0001-01-01',period_end DATE NOT NULL DEFAULT DATE '0001-01-01',numeric_value NUMERIC(36,12),text_value TEXT,
      status TEXT NOT NULL DEFAULT 'valid',formula_version TEXT NOT NULL,input_hash TEXT NOT NULL DEFAULT '',
      diagnostics JSONB NOT NULL DEFAULT '{}'::jsonb,calculated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_metric_values_scope ON analytics.metric_values(instrument_id,metric_code,as_of_date,period_start,period_end,formula_version);
    CREATE INDEX IF NOT EXISTS idx_metric_values_lookup ON analytics.metric_values(instrument_id,metric_code,as_of_date DESC);

    CREATE TABLE IF NOT EXISTS analytics.metric_statistics (
      statistic_id BIGSERIAL PRIMARY KEY,instrument_id BIGINT NOT NULL REFERENCES core.instruments(instrument_id) ON DELETE CASCADE,
      metric_code TEXT NOT NULL,as_of_date DATE NOT NULL,window_start DATE,window_end DATE,percentile_value NUMERIC(20,12),
      valid_samples INTEGER NOT NULL DEFAULT 0,excluded_samples INTEGER NOT NULL DEFAULT 0,excluded_reason TEXT NOT NULL DEFAULT '',
      calculated_at TIMESTAMPTZ NOT NULL DEFAULT now(),UNIQUE(instrument_id,metric_code,as_of_date,window_start,window_end)
    );

    CREATE TABLE IF NOT EXISTS analytics.analysis_snapshots (
      snapshot_id BIGSERIAL PRIMARY KEY,instrument_id BIGINT NOT NULL REFERENCES core.instruments(instrument_id) ON DELETE CASCADE,
      as_of_date DATE NOT NULL,snapshot_type TEXT NOT NULL DEFAULT 'stock_analysis',formula_bundle_version TEXT NOT NULL,
      payload JSONB NOT NULL,source_watermark JSONB NOT NULL DEFAULT '{}'::jsonb,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(instrument_id,as_of_date,snapshot_type,formula_bundle_version)
    );

    CREATE TABLE IF NOT EXISTS analytics.stock_overview_latest (
      instrument_id BIGINT PRIMARY KEY REFERENCES core.instruments(instrument_id) ON DELETE CASCADE,
      as_of_date DATE NOT NULL,name TEXT NOT NULL,canonical_code TEXT NOT NULL,industry_label TEXT NOT NULL DEFAULT '',
      currency_code CHAR(3) NOT NULL,price NUMERIC(24,8),total_market_cap NUMERIC(30,4),a_share_market_cap NUMERIC(30,4),
      circulating_market_cap NUMERIC(30,4),free_float_market_cap NUMERIC(30,4),controller_name TEXT NOT NULL DEFAULT '',
      controller_type TEXT NOT NULL DEFAULT '',latest_report_date DATE,latest_report_announced_at DATE,
      guidance_summary TEXT NOT NULL DEFAULT '',metrics JSONB NOT NULL DEFAULT '{}'::jsonb,updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS ops.sync_cursors (
      cursor_id BIGSERIAL PRIMARY KEY,instrument_id BIGINT REFERENCES core.instruments(instrument_id) ON DELETE CASCADE,
      company_id BIGINT REFERENCES core.companies(company_id) ON DELETE CASCADE,scope_key TEXT NOT NULL,dataset_code TEXT NOT NULL,
      last_success_date DATE,last_source_update TIMESTAMPTZ,last_attempt_at TIMESTAMPTZ,last_error TEXT NOT NULL DEFAULT '',
      retry_count INTEGER NOT NULL DEFAULT 0,updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_sync_cursor_scope ON ops.sync_cursors(scope_key,dataset_code);

    CREATE TABLE IF NOT EXISTS ops.data_quality_issues (
      issue_id BIGSERIAL PRIMARY KEY,instrument_id BIGINT REFERENCES core.instruments(instrument_id) ON DELETE CASCADE,
      company_id BIGINT REFERENCES core.companies(company_id) ON DELETE CASCADE,dataset_code TEXT NOT NULL,field_code TEXT NOT NULL DEFAULT '',
      issue_type TEXT NOT NULL,severity TEXT NOT NULL DEFAULT 'warning',status TEXT NOT NULL DEFAULT 'open',
      details JSONB NOT NULL DEFAULT '{}'::jsonb,detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),resolved_at TIMESTAMPTZ,
      UNIQUE(instrument_id,dataset_code,field_code,issue_type,status)
    );
  `);
}

async function migration008DropLegacyStockAnalysisTables() {
  await pool.query(`
    DROP TABLE IF EXISTS stock_analysis_snapshots;
    DROP TABLE IF EXISTS stock_events;
    DROP TABLE IF EXISTS stock_data_sync_state;
    DROP TABLE IF EXISTS stock_daily_valuations;
    DROP TABLE IF EXISTS stock_forecasts;
    DROP TABLE IF EXISTS stock_dividends;
    DROP TABLE IF EXISTS stock_financial_indicators;
    DROP TABLE IF EXISTS stock_cashflow_statements;
    DROP TABLE IF EXISTS stock_balance_sheets;
    DROP TABLE IF EXISTS stock_income_statements;
    DROP TABLE IF EXISTS stock_analysis_stocks;
  `);
}

async function migration009ValuationDataQuality() {
  await pool.query(`ALTER TABLE market.daily_valuations DROP CONSTRAINT IF EXISTS ck_daily_valuations_has_data;
    ALTER TABLE market.daily_valuations ADD CONSTRAINT ck_daily_valuations_has_data CHECK (
      pe_static IS NOT NULL OR pe_ttm IS NOT NULL OR pb IS NOT NULL OR dividend_yield_ttm IS NOT NULL OR
      total_market_cap IS NOT NULL OR circulating_market_cap IS NOT NULL OR free_float_market_cap IS NOT NULL
    );`);
}

async function migration010ConvertibleBondAnalysis() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fundamental.convertible_bond_profiles (
      instrument_id BIGINT PRIMARY KEY REFERENCES core.instruments(instrument_id) ON DELETE CASCADE,
      stock_instrument_id BIGINT REFERENCES core.instruments(instrument_id),
      bond_full_name TEXT NOT NULL DEFAULT '',bond_short_name TEXT NOT NULL DEFAULT '',cb_type TEXT NOT NULL DEFAULT 'CB',
      par_value NUMERIC(24,8),issue_price NUMERIC(24,8),issue_size NUMERIC(30,4),remain_size NUMERIC(30,4),
      value_date DATE,maturity_date DATE,conv_start_date DATE,conv_end_date DATE,conv_stop_date DATE,
      first_conv_price NUMERIC(24,8),current_conv_price NUMERIC(24,8),coupon_rate NUMERIC(20,8),add_rate NUMERIC(20,8),
      pay_per_year INTEGER,rate_type TEXT NOT NULL DEFAULT '',rate_clause TEXT NOT NULL DEFAULT '',
      maturity_call_price TEXT NOT NULL DEFAULT '',guarantor TEXT NOT NULL DEFAULT '',guarantee_type TEXT NOT NULL DEFAULT '',
      issue_rating TEXT NOT NULL DEFAULT '',newest_rating TEXT NOT NULL DEFAULT '',rating_company TEXT NOT NULL DEFAULT '',
      fundraising_purpose TEXT NOT NULL DEFAULT '',source_id SMALLINT REFERENCES ops.data_sources(source_id),
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,source_updated_at TIMESTAMPTZ,updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS fundamental.convertible_bond_terms (
      term_id BIGSERIAL PRIMARY KEY,instrument_id BIGINT NOT NULL REFERENCES core.instruments(instrument_id) ON DELETE CASCADE,
      term_type TEXT NOT NULL,effective_from DATE NOT NULL DEFAULT DATE '0001-01-01',effective_to DATE,
      clause_text TEXT NOT NULL DEFAULT '',trigger_ratio NUMERIC(20,8),observation_days INTEGER,required_days INTEGER,
      source_id SMALLINT REFERENCES ops.data_sources(source_id),document_id BIGINT REFERENCES event.documents(document_id),
      source_key TEXT NOT NULL,raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(instrument_id,term_type,effective_from,source_key)
    );
    CREATE INDEX IF NOT EXISTS idx_cb_terms_current ON fundamental.convertible_bond_terms(instrument_id,term_type,effective_from DESC);
    CREATE TABLE IF NOT EXISTS fundamental.convertible_bond_coupon_schedule (
      instrument_id BIGINT NOT NULL REFERENCES core.instruments(instrument_id) ON DELETE CASCADE,
      interest_year SMALLINT NOT NULL,coupon_rate NUMERIC(20,8),pay_date DATE,
      pre_tax_interest NUMERIC(24,8),after_tax_interest NUMERIC(24,8),source_id SMALLINT REFERENCES ops.data_sources(source_id),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(instrument_id,interest_year)
    );
    CREATE TABLE IF NOT EXISTS fundamental.convertible_bond_price_changes (
      instrument_id BIGINT NOT NULL REFERENCES core.instruments(instrument_id) ON DELETE CASCADE,
      publish_date DATE NOT NULL DEFAULT DATE '0001-01-01',change_date DATE NOT NULL,
      initial_price NUMERIC(24,8),price_before NUMERIC(24,8),price_after NUMERIC(24,8),reason TEXT NOT NULL DEFAULT '',
      source_id SMALLINT REFERENCES ops.data_sources(source_id),document_id BIGINT REFERENCES event.documents(document_id),
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,PRIMARY KEY(instrument_id,change_date)
    );
    CREATE TABLE IF NOT EXISTS fundamental.convertible_bond_no_revision_history (
      history_id BIGSERIAL PRIMARY KEY,instrument_id BIGINT NOT NULL REFERENCES core.instruments(instrument_id) ON DELETE CASCADE,
      announced_at DATE NOT NULL,valid_until DATE,next_eligible_date DATE,summary TEXT NOT NULL DEFAULT '',
      source_id SMALLINT REFERENCES ops.data_sources(source_id),document_id BIGINT REFERENCES event.documents(document_id),
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,UNIQUE(instrument_id,announced_at)
    );
    CREATE TABLE IF NOT EXISTS fundamental.convertible_bond_ratings (
      instrument_id BIGINT NOT NULL REFERENCES core.instruments(instrument_id) ON DELETE CASCADE,
      rating_date DATE NOT NULL,announced_at DATE,rating_company TEXT NOT NULL DEFAULT '',rating_method TEXT NOT NULL DEFAULT '',
      rating_type TEXT NOT NULL DEFAULT '',rating TEXT NOT NULL DEFAULT '',rating_outlook TEXT NOT NULL DEFAULT '',
      source_id SMALLINT REFERENCES ops.data_sources(source_id),raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      PRIMARY KEY(instrument_id,rating_date,rating_company)
    );
    CREATE TABLE IF NOT EXISTS fundamental.convertible_bond_fund_holdings (
      instrument_id BIGINT NOT NULL REFERENCES core.instruments(instrument_id) ON DELETE CASCADE,
      report_date DATE NOT NULL,fund_count INTEGER,holding_quantity NUMERIC(30,4),holding_market_value NUMERIC(30,4),
      remain_size_ratio NUMERIC(20,10),source_id SMALLINT REFERENCES ops.data_sources(source_id),
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,PRIMARY KEY(instrument_id,report_date)
    );
    CREATE TABLE IF NOT EXISTS analytics.convertible_bond_trigger_daily (
      instrument_id BIGINT NOT NULL REFERENCES core.instruments(instrument_id) ON DELETE CASCADE,
      trade_date DATE NOT NULL,trigger_type TEXT NOT NULL,trigger_price NUMERIC(24,8),close_price NUMERIC(24,8),
      matched_days INTEGER,required_days INTEGER,observation_days INTEGER,status TEXT NOT NULL DEFAULT 'unknown',
      formula_version TEXT NOT NULL DEFAULT '1',diagnostics JSONB NOT NULL DEFAULT '{}'::jsonb,
      calculated_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(instrument_id,trade_date,trigger_type,formula_version)
    );
  `);
}

// ====== 版本化迁移机制（P2-3）======
// 记录已执行的升级步骤，避免每次启动重复跑大量 ALTER
async function migration011IpoTrackingStorage() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS predictions (
      id SERIAL PRIMARY KEY,
      type TEXT NOT NULL,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      listing_date TEXT NOT NULL,
      pred_date TEXT NOT NULL,
      pred_return REAL,
      pred_price REAL,
      pred_advice TEXT,
      actual_return REAL,
      actual_price REAL,
      actual_date TEXT,
      status TEXT DEFAULT 'pending',
      updated_at TEXT,
      UNIQUE(type, code, pred_date)
    );
    ALTER TABLE predictions ADD COLUMN IF NOT EXISTS pred_price REAL;
    ALTER TABLE predictions ADD COLUMN IF NOT EXISTS actual_price REAL;
    ALTER TABLE predictions ADD COLUMN IF NOT EXISTS actual_date TEXT;
    CREATE INDEX IF NOT EXISTS idx_predictions_accuracy
      ON predictions(type, status, pred_date) WHERE actual_return IS NOT NULL;

    CREATE TABLE IF NOT EXISTS sector_heat (
      sector_key TEXT PRIMARY KEY,
      avg_gain_60d REAL,
      stock_count INTEGER,
      boost REAL,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS stock_gain (
      stock_code TEXT PRIMARY KEY,
      gain_60d REAL,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS stock_sector (
      stock_code TEXT,
      sector_key TEXT,
      stock_name TEXT,
      PRIMARY KEY(stock_code, sector_key)
    );
    CREATE INDEX IF NOT EXISTS idx_stock_sector_key ON stock_sector(sector_key);
  `);
}

// ========== 知识分享模块：文章 / 分类目录树 / 评论 ==========
async function migration012KnowledgeArticles() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS article_categories (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      parent_id INTEGER REFERENCES article_categories(id) ON DELETE CASCADE,
      sort_order INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS articles (
      id SERIAL PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      slug VARCHAR(255) UNIQUE,
      content TEXT NOT NULL DEFAULT '',
      html_content TEXT,
      summary TEXT,
      category_id INTEGER REFERENCES article_categories(id) ON DELETE SET NULL,
      status VARCHAR(20) DEFAULT 'draft',
      share_token VARCHAR(64) UNIQUE,
      view_count INTEGER DEFAULT 0,
      author_username TEXT NOT NULL REFERENCES users(username),
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now(),
      published_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_articles_status ON articles(status);
    CREATE INDEX IF NOT EXISTS idx_articles_share_token ON articles(share_token);
    CREATE INDEX IF NOT EXISTS idx_articles_category ON articles(category_id);
    CREATE INDEX IF NOT EXISTS idx_articles_author ON articles(author_username);

    CREATE TABLE IF NOT EXISTS article_comments (
      id SERIAL PRIMARY KEY,
      article_id INTEGER REFERENCES articles(id) ON DELETE CASCADE,
      nickname VARCHAR(50) NOT NULL DEFAULT '匿名',
      content TEXT NOT NULL,
      ip_hash VARCHAR(64),
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_comments_article ON article_comments(article_id);
    CREATE INDEX IF NOT EXISTS idx_comments_created ON article_comments(created_at DESC);
  `);
}

// ========== 013：知识分享写权限开关（users 表加字段） ==========
async function migration013KnowledgePermission() {
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS knowledge_enabled boolean NOT NULL DEFAULT false;
  `);
}

// ========== 014：评论楼中楼（article_comments 加 parent_id / root_id） ==========
async function migration014NestedComments() {
  await pool.query(`
    ALTER TABLE article_comments ADD COLUMN IF NOT EXISTS parent_id integer REFERENCES article_comments(id) ON DELETE CASCADE;
    ALTER TABLE article_comments ADD COLUMN IF NOT EXISTS root_id integer REFERENCES article_comments(id) ON DELETE CASCADE;
    CREATE INDEX IF NOT EXISTS idx_comments_parent ON article_comments(parent_id);
    CREATE INDEX IF NOT EXISTS idx_comments_root ON article_comments(root_id);
  `);
}

// ========== 015：评论作者归属（author_username，关联用户，注销置空） ==========
async function migration015CommentAuthor() {
  await pool.query(`
    ALTER TABLE article_comments ADD COLUMN IF NOT EXISTS author_username TEXT REFERENCES users(username) ON DELETE SET NULL;
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_comments_author ON article_comments(author_username)');
}

// ========== 016：文章作者外键允许为空（用户注销后保留文章） ==========
async function migration016ArticleAuthorNullable() {
  await pool.query('ALTER TABLE articles ALTER COLUMN author_username DROP NOT NULL');
  await pool.query('ALTER TABLE articles DROP CONSTRAINT IF EXISTS articles_author_username_fkey');
  await pool.query('ALTER TABLE articles ADD CONSTRAINT articles_author_username_fkey FOREIGN KEY (author_username) REFERENCES users(username) ON DELETE SET NULL');
}

// ========== 017：知识分享表约束强化 ==========
async function migration017KnowledgeConstraints() {
  // 先修正历史异常数据，再加严格约束
  await pool.query("UPDATE articles SET status='draft' WHERE status IS NULL OR status NOT IN ('draft','published')");
  await pool.query('UPDATE articles SET view_count=0 WHERE view_count IS NULL OR view_count<0');
  await pool.query('DELETE FROM article_comments WHERE article_id IS NULL');
  await pool.query("UPDATE article_categories SET name='未命名' WHERE name IS NULL OR name=''");

  const stmts = [
    'ALTER TABLE articles ALTER COLUMN status SET NOT NULL',
    `DO $migration$
     BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ck_articles_status' AND conrelid='articles'::regclass) THEN
         ALTER TABLE articles ADD CONSTRAINT ck_articles_status CHECK (status IN ('draft','published'));
       END IF;
     END
     $migration$`,
    'ALTER TABLE articles ALTER COLUMN view_count SET DEFAULT 0',
    'ALTER TABLE articles ALTER COLUMN view_count SET NOT NULL',
    `DO $migration$
     BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ck_articles_view_count' AND conrelid='articles'::regclass) THEN
         ALTER TABLE articles ADD CONSTRAINT ck_articles_view_count CHECK (view_count >= 0);
       END IF;
     END
     $migration$`,
    'ALTER TABLE article_comments ALTER COLUMN article_id SET NOT NULL',
    `DO $migration$
     BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ck_cat_name_nonempty' AND conrelid='article_categories'::regclass) THEN
         ALTER TABLE article_categories ADD CONSTRAINT ck_cat_name_nonempty CHECK (name <> '');
       END IF;
     END
     $migration$`,
    `DO $migration$
     BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ck_cat_no_self_parent' AND conrelid='article_categories'::regclass) THEN
         ALTER TABLE article_categories ADD CONSTRAINT ck_cat_no_self_parent CHECK (id <> parent_id);
       END IF;
     END
     $migration$`,
  ];
  for (const sql of stmts) {
    await pool.query(sql);
  }
  // 同级分类同名唯一（父子维度去重）
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS uq_cat_parent_name ON article_categories (COALESCE(parent_id, -1), lower(name))');
}

// ========== 018：默认分类幂等种子（读取接口不再写库） ==========
async function migration018SeedDefaultCategories() {
  const defaults = ['投资笔记', '打新攻略', '可转债', '读书笔记'];
  for (let i = 0; i < defaults.length; i++) {
    await pool.query(
      'INSERT INTO article_categories (name, parent_id, sort_order) VALUES ($1, NULL, $2) ON CONFLICT DO NOTHING',
      [defaults[i], i]
    );
  }
}

// ========== 019：重新核验知识分享约束（覆盖已执行旧版 016/017 的环境） ==========
async function migration019KnowledgeConstraintsVerify() {
  await migration016ArticleAuthorNullable();
  await migration017KnowledgeConstraints();
}

// ========== 020：分类归属与安全移动 ==========
async function migration020KnowledgeCategoryOwnership() {
  await pool.query(`
    ALTER TABLE article_categories
      ADD COLUMN IF NOT EXISTS owner_username TEXT REFERENCES users(username) ON DELETE SET NULL;
  `);

  // 历史分类优先归属给该分类文章的作者；没有文章时归属给首位管理员。
  await pool.query(`
    UPDATE article_categories c
    SET owner_username = COALESCE(
      (
        SELECT a.author_username
        FROM articles a
        WHERE a.category_id = c.id AND a.author_username IS NOT NULL
        ORDER BY a.created_at, a.id
        LIMIT 1
      ),
      (
        SELECT u.username
        FROM users u
        WHERE u.role = 'admin'
        ORDER BY u.created_at NULLS LAST, u.username
        LIMIT 1
      )
    )
    WHERE c.owner_username IS NULL
  `);

  // 删除父分类时仅把子分类移回根目录，避免连带删除其他用户的分类。
  await pool.query('ALTER TABLE article_categories DROP CONSTRAINT IF EXISTS article_categories_parent_id_fkey');
  await pool.query(`
    ALTER TABLE article_categories
      ADD CONSTRAINT article_categories_parent_id_fkey
      FOREIGN KEY (parent_id) REFERENCES article_categories(id) ON DELETE SET NULL
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_article_categories_owner ON article_categories(owner_username)');
}

// 可转债周期：原始日度事实表 + 周期聚合表（不修改/删除现有安全性表）
async function migration021ConvertibleBondCycle() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS market.convertible_bond_daily_metrics (
      instrument_id BIGINT NOT NULL REFERENCES core.instruments(instrument_id) ON DELETE CASCADE,
      trade_date DATE NOT NULL,
      source_id SMALLINT NOT NULL,
      close NUMERIC(20,4),
      conversion_value NUMERIC(20,4),
      conversion_premium_pct NUMERIC(20,4),
      bond_value NUMERIC(20,4),
      bond_premium_pct NUMERIC(20,4),
      raw_payload JSONB,
      ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (instrument_id, trade_date, source_id),
      CONSTRAINT chk_cbdm_close_positive CHECK (close > 0)
    );
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_cbdm_trade_date ON market.convertible_bond_daily_metrics(trade_date DESC)');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS analytics.convertible_bond_cycle_daily (
      trade_date DATE NOT NULL,
      formula_version TEXT NOT NULL,
      universe_version TEXT NOT NULL,
      bond_count INTEGER,
      premium_count INTEGER,
      coverage_ratio NUMERIC(5,4),
      median_price NUMERIC(20,4),
      median_conversion_value NUMERIC(20,4),
      median_conversion_premium_pct NUMERIC(20,4),
      premium_weight NUMERIC(5,4),
      composite_value NUMERIC(20,4),
      rolling_percentile NUMERIC(5,2),
      cycle_level TEXT,
      source_id SMALLINT,
      diagnostics JSONB,
      calculated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (trade_date, formula_version, universe_version),
      CONSTRAINT chk_cbcd_bond_count CHECK (bond_count >= 100),
      CONSTRAINT chk_cbcd_coverage CHECK (coverage_ratio >= 0 AND coverage_ratio <= 1),
      CONSTRAINT chk_cbcd_weight CHECK (premium_weight >= 0.20 AND premium_weight <= 0.55),
      CONSTRAINT chk_cbcd_percentile CHECK (rolling_percentile >= 0 AND rolling_percentile <= 100)
    );
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_cbcd_lookup ON analytics.convertible_bond_cycle_daily(formula_version, trade_date DESC)');
}

async function migration022ConvertibleBondValuation() {
  // 模型版本表：每次训练保存公式/特征/样本池版本、训练范围、中性市场基准、误差分位、模型文件与校验值
  await pool.query(`
    CREATE TABLE IF NOT EXISTS analytics.convertible_bond_valuation_models (
      model_version TEXT PRIMARY KEY,
      formula_version TEXT NOT NULL,
      feature_version TEXT NOT NULL,
      universe_version TEXT NOT NULL,
      training_start_date DATE,
      training_end_date DATE,
      training_row_count INTEGER,
      training_bond_count INTEGER,
      neutral_market_extra NUMERIC(14,8),
      residual_quantiles JSONB,
      model_path TEXT,
      model_sha256 TEXT,
      backtest_metrics JSONB,
      is_active BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      activated_at TIMESTAMPTZ
    );
  `);

  // 每日估值结果表：每个交易日每只转债一份（同一模型版本），保存当时使用的数据与模型版本，可历史追溯
  await pool.query(`
    CREATE TABLE IF NOT EXISTS analytics.convertible_bond_valuation_daily (
      trade_date DATE NOT NULL,
      instrument_id BIGINT NOT NULL REFERENCES core.instruments(instrument_id) ON DELETE CASCADE,
      model_version TEXT NOT NULL,
      formula_version TEXT NOT NULL,
      feature_version TEXT NOT NULL,
      universe_version TEXT NOT NULL,
      quote_date DATE,
      close NUMERIC(20,4),
      conversion_value NUMERIC(20,4),
      bond_value NUMERIC(20,4),
      conversion_premium_pct NUMERIC(20,4),
      anchor_value NUMERIC(20,4),
      remaining_years NUMERIC(8,4),
      conversion_value_volatility_60d NUMERIC(10,6),
      neutral_market_extra NUMERIC(14,8),
      predicted_relative_extra NUMERIC(14,8),
      fair_price NUMERIC(20,4),
      fair_price_low NUMERIC(20,4),
      fair_price_high NUMERIC(20,4),
      absolute_deviation_pct NUMERIC(12,6),
      valuation_percentile NUMERIC(6,3),
      market_heat_pct NUMERIC(12,6),
      relative_market_deviation_pct NUMERIC(12,6),
      base_evaluation TEXT,
      safety_level TEXT,
      credit_warning TEXT,
      final_evaluation TEXT,
      confidence_level TEXT,
      data_status TEXT,
      diagnostics JSONB,
      calculated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (trade_date, instrument_id, model_version),
      CONSTRAINT chk_cbvd_close_nonneg CHECK (close IS NULL OR close >= 0),
      CONSTRAINT chk_cbvd_fair_positive CHECK (fair_price IS NULL OR fair_price > 0),
      CONSTRAINT chk_cbvd_deviation_range CHECK (absolute_deviation_pct IS NULL OR absolute_deviation_pct BETWEEN -99 AND 999),
      CONSTRAINT chk_cbvd_percentile_range CHECK (valuation_percentile IS NULL OR valuation_percentile BETWEEN 0 AND 100),
      CONSTRAINT chk_cbvd_interval_order CHECK (fair_price_low IS NULL OR fair_price_high IS NULL OR fair_price_low <= fair_price_high)
    );
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_cbvd_trade_date ON analytics.convertible_bond_valuation_daily(trade_date DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_cbvd_instrument_date ON analytics.convertible_bond_valuation_daily(instrument_id, trade_date DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_cbvd_eval_date ON analytics.convertible_bond_valuation_daily(final_evaluation, trade_date DESC)');

  // 预警表：状态跃迁预警，去重键为 转债+类型+当前状态+模型版本
  await pool.query(`
    CREATE TABLE IF NOT EXISTS analytics.convertible_bond_valuation_alerts (
      alert_id BIGSERIAL PRIMARY KEY,
      instrument_id BIGINT NOT NULL REFERENCES core.instruments(instrument_id) ON DELETE CASCADE,
      trade_date DATE NOT NULL,
      alert_type TEXT NOT NULL,
      alert_level TEXT NOT NULL,
      previous_state TEXT,
      current_state TEXT,
      trigger_payload JSONB,
      model_version TEXT,
      is_active BOOLEAN NOT NULL DEFAULT true,
      resolved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (instrument_id, alert_type, current_state, model_version)
    );
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_cbva_trade_date ON analytics.convertible_bond_valuation_alerts(trade_date DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_cbva_instrument ON analytics.convertible_bond_valuation_alerts(instrument_id, trade_date DESC)');

  // 同步游标（历史回填游标，只前进不回退）
  await pool.query(
    `INSERT INTO ops.sync_cursors (scope_key, dataset_code, last_success_date)
     VALUES ('convertible_bond_valuation', 'daily_valuation', NULL)
     ON CONFLICT (scope_key, dataset_code) DO NOTHING`
  );
}

async function migration023ValuationConstraints() {
  // 每日估值表：实际使用的年度子模型版本、稳定评价分类（供统计/排序，不依赖中文文案）
  await pool.query(`ALTER TABLE analytics.convertible_bond_valuation_daily ADD COLUMN IF NOT EXISTS model_year INTEGER`);
  await pool.query(`ALTER TABLE analytics.convertible_bond_valuation_daily ADD COLUMN IF NOT EXISTS eval_class TEXT`);
  await pool.query(`ALTER TABLE analytics.convertible_bond_valuation_daily ADD COLUMN IF NOT EXISTS quote_lag_days INTEGER`);
  await pool.query(`ALTER TABLE analytics.convertible_bond_valuation_daily ADD COLUMN IF NOT EXISTS historical_safety TEXT`);

  // 模型版本表：相对路径（跨环境）、年度元数据固化、启用审计
  await pool.query(`ALTER TABLE analytics.convertible_bond_valuation_models ADD COLUMN IF NOT EXISTS model_file_rel_path TEXT`);
  await pool.query(`ALTER TABLE analytics.convertible_bond_valuation_models ADD COLUMN IF NOT EXISTS yearly_metadata JSONB`);
  await pool.query(`ALTER TABLE analytics.convertible_bond_valuation_models ADD COLUMN IF NOT EXISTS enabled_by TEXT`);
  await pool.query(`ALTER TABLE analytics.convertible_bond_valuation_models ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ`);

  // 同一时间仅一个活动模型：partial unique index（只对 is_active=true 生效）
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_cbv_one_active_model
     ON analytics.convertible_bond_valuation_models ((1)) WHERE is_active`
  );

  // 每日估值表的 model_version 外键关联模型版本表（历史重建后引用均存在）
  await pool.query(
    `ALTER TABLE analytics.convertible_bond_valuation_daily
     DROP CONSTRAINT IF EXISTS fk_cbvd_model_version;
     ALTER TABLE analytics.convertible_bond_valuation_daily
     ADD CONSTRAINT fk_cbvd_model_version
     FOREIGN KEY (model_version) REFERENCES analytics.convertible_bond_valuation_models(model_version)
     ON DELETE RESTRICT`
  );

  // 预警表的 model_version 外键关联
  await pool.query(
    `ALTER TABLE analytics.convertible_bond_valuation_alerts
     DROP CONSTRAINT IF EXISTS fk_cbva_model_version;
     ALTER TABLE analytics.convertible_bond_valuation_alerts
     ADD CONSTRAINT fk_cbva_model_version
     FOREIGN KEY (model_version) REFERENCES analytics.convertible_bond_valuation_models(model_version)
     ON DELETE RESTRICT`
  );

  // 历史安全性快照（供历史回填按快照日期取当时有效安全性；缺失则标记“历史安全性不可用”）
  await pool.query(`
    CREATE TABLE IF NOT EXISTS analytics.bond_safety_snapshot_history (
      snapshot_date DATE PRIMARY KEY,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function migration024ValuationAlertReentry() {
  // 同一状态恢复后可以在新的交易日再次触发；同日重跑仍保持幂等。
  await pool.query(`
    ALTER TABLE analytics.convertible_bond_valuation_alerts
      DROP CONSTRAINT IF EXISTS convertible_bond_valuation_al_instrument_id_alert_type_curr_key;
    ALTER TABLE analytics.convertible_bond_valuation_alerts
      DROP CONSTRAINT IF EXISTS uq_cbva_event_state;
    ALTER TABLE analytics.convertible_bond_valuation_alerts
      ADD CONSTRAINT uq_cbva_event_state
      UNIQUE (instrument_id, trade_date, alert_type, current_state, model_version);
  `);
}

// 股市波动：估值、国债收益率、格雷厄姆指数与用户策略设置。
// 所有数值均使用百分数口径，例如 1.73 表示 1.73%，不写入模拟数据。
async function migration025MarketVolatility() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS market.market_valuation_daily (
      market_code TEXT NOT NULL, benchmark_code TEXT NOT NULL, trade_date DATE NOT NULL,
      pe NUMERIC(20,6), pe_ttm NUMERIC(20,6), source_code TEXT NOT NULL,
      source_date DATE NOT NULL, raw_payload JSONB, ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (market_code, benchmark_code, trade_date, source_code),
      CONSTRAINT chk_market_valuation_pe_positive CHECK (pe IS NULL OR pe > 0)
    );
    CREATE INDEX IF NOT EXISTS idx_market_valuation_lookup ON market.market_valuation_daily(market_code, benchmark_code, trade_date DESC);

    CREATE TABLE IF NOT EXISTS market.sovereign_yield_daily (
      market_code TEXT NOT NULL, tenor_years SMALLINT NOT NULL, trade_date DATE NOT NULL,
      yield_pct NUMERIC(12,6) NOT NULL, source_code TEXT NOT NULL, source_date DATE NOT NULL,
      raw_payload JSONB, ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (market_code, tenor_years, trade_date, source_code),
      CONSTRAINT chk_sovereign_yield_tenor CHECK (tenor_years = 10)
    );
    CREATE INDEX IF NOT EXISTS idx_sovereign_yield_lookup ON market.sovereign_yield_daily(market_code, tenor_years, trade_date DESC);

    CREATE TABLE IF NOT EXISTS analytics.graham_index_daily (
      market_code TEXT NOT NULL, benchmark_code TEXT NOT NULL, trade_date DATE NOT NULL,
      pe NUMERIC(20,6), earnings_yield_pct NUMERIC(12,6), sovereign_yield_pct NUMERIC(12,6),
      sovereign_yield_date DATE, graham_index_pct NUMERIC(16,6), data_status TEXT NOT NULL,
      formula_version TEXT NOT NULL DEFAULT '1', calculated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (market_code, benchmark_code, trade_date, formula_version),
      CONSTRAINT chk_graham_status CHECK (data_status IN ('normal','carried_forward','stale','missing'))
    );
    CREATE INDEX IF NOT EXISTS idx_graham_index_lookup ON analytics.graham_index_daily(market_code, benchmark_code, trade_date DESC);

    CREATE TABLE IF NOT EXISTS analytics.graham_strategy_settings (
      setting_id BIGSERIAL PRIMARY KEY, username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      account_name TEXT NOT NULL, market_code TEXT NOT NULL, benchmark_code TEXT NOT NULL,
      lower_boundary_pct NUMERIC(16,4) NOT NULL, upper_boundary_pct NUMERIC(16,4) NOT NULL,
      step_pct NUMERIC(8,4) NOT NULL DEFAULT 10, version INTEGER NOT NULL DEFAULT 1,
      is_current BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT chk_graham_boundaries CHECK (lower_boundary_pct > 0 AND upper_boundary_pct > lower_boundary_pct),
      CONSTRAINT chk_graham_step CHECK (step_pct = 10)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_graham_settings_current
      ON analytics.graham_strategy_settings(username, account_name, market_code, benchmark_code) WHERE is_current;
  `);
}

async function migration026IndexValuationHistory() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS market.index_valuation_history (
      index_code TEXT NOT NULL, valuation_method TEXT NOT NULL, trade_date DATE NOT NULL,
      close NUMERIC(20,4), market_cap NUMERIC(28,4), pe_ttm NUMERIC(20,6), pb NUMERIC(20,6),
      pe_percentile NUMERIC(12,6), pe_p80 NUMERIC(20,6), pe_p50 NUMERIC(20,6), pe_p20 NUMERIC(20,6),
      pb_percentile NUMERIC(12,6), pb_p80 NUMERIC(20,6), pb_p50 NUMERIC(20,6), pb_p20 NUMERIC(20,6),
      source_code TEXT NOT NULL, raw_payload JSONB, ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY(index_code, valuation_method, trade_date, source_code)
    );
    CREATE INDEX IF NOT EXISTS idx_index_valuation_history_lookup
      ON market.index_valuation_history(index_code, valuation_method, trade_date DESC);
  `);
}

// ========== 027：知识文章分类内排序 ==========
async function migration027ArticleSortOrder() {
  await pool.query('ALTER TABLE articles ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0');
  await pool.query(`
    WITH ranked AS (
      SELECT id, ROW_NUMBER() OVER (
        PARTITION BY category_id
        ORDER BY COALESCE(published_at, updated_at) DESC, id DESC
      ) * 10 AS next_sort_order
      FROM articles
    )
    UPDATE articles a
    SET sort_order = ranked.next_sort_order
    FROM ranked
    WHERE a.id = ranked.id AND a.sort_order = 0
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_articles_category_sort ON articles(category_id, sort_order, id)');
}

// ========== 028：文章统一排序（支持“全部文章”和未分类文章拖动） ==========
async function migration028ArticleGlobalSortOrder() {
  await pool.query(`
    WITH ranked AS (
      SELECT id, ROW_NUMBER() OVER (
        ORDER BY COALESCE(published_at, updated_at, created_at) DESC, id DESC
      ) * 10 AS next_sort_order
      FROM articles
    )
    UPDATE articles a
    SET sort_order = ranked.next_sort_order
    FROM ranked
    WHERE a.id = ranked.id
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_articles_global_sort ON articles(sort_order, id)');
}

// 股市周期扩展：PE、PB、M2/股市市值比及三类新指标的用户边界设置。
async function migration029MarketCycleMetrics() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS market.money_supply_monthly (
      market_code TEXT NOT NULL, month DATE NOT NULL, m2_100m_yuan NUMERIC(28,4) NOT NULL,
      source_code TEXT NOT NULL, raw_payload JSONB, ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (market_code, month, source_code),
      CONSTRAINT chk_money_supply_m2_positive CHECK (m2_100m_yuan > 0)
    );
    CREATE INDEX IF NOT EXISTS idx_money_supply_monthly_lookup
      ON market.money_supply_monthly(market_code, month DESC);

    CREATE TABLE IF NOT EXISTS market.a_share_market_cap_daily (
      trade_date DATE NOT NULL, total_market_cap_100m_yuan NUMERIC(28,4) NOT NULL,
      security_count INTEGER NOT NULL, source_code TEXT NOT NULL,
      raw_payload JSONB, ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (trade_date, source_code),
      CONSTRAINT chk_a_share_market_cap_positive CHECK (total_market_cap_100m_yuan > 0),
      CONSTRAINT chk_a_share_security_count CHECK (security_count >= 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_a_share_market_cap_lookup
      ON market.a_share_market_cap_daily(trade_date DESC);

    CREATE TABLE IF NOT EXISTS analytics.m2_market_cap_daily (
      trade_date DATE NOT NULL, m2_month DATE NOT NULL,
      m2_100m_yuan NUMERIC(28,4) NOT NULL, total_market_cap_100m_yuan NUMERIC(28,4) NOT NULL,
      ratio_pct NUMERIC(18,6) NOT NULL, data_status TEXT NOT NULL DEFAULT 'normal',
      formula_version TEXT NOT NULL DEFAULT '1', calculated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (trade_date, formula_version),
      CONSTRAINT chk_m2_market_cap_ratio_positive CHECK (ratio_pct > 0),
      CONSTRAINT chk_m2_market_cap_status CHECK (data_status IN ('normal','carried_forward','stale','missing'))
    );
    CREATE INDEX IF NOT EXISTS idx_m2_market_cap_lookup
      ON analytics.m2_market_cap_daily(trade_date DESC);

    CREATE TABLE IF NOT EXISTS analytics.market_cycle_strategy_settings (
      setting_id BIGSERIAL PRIMARY KEY,
      username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      account_name TEXT NOT NULL, metric_code TEXT NOT NULL,
      market_code TEXT NOT NULL, benchmark_code TEXT NOT NULL,
      lower_boundary NUMERIC(20,6) NOT NULL, upper_boundary NUMERIC(20,6) NOT NULL,
      version INTEGER NOT NULL DEFAULT 1, is_current BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT chk_market_cycle_metric CHECK (metric_code IN ('pe','pb','m2_market_cap')),
      CONSTRAINT chk_market_cycle_boundaries CHECK (lower_boundary > 0 AND upper_boundary > lower_boundary)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_market_cycle_settings_current
      ON analytics.market_cycle_strategy_settings(username, account_name, metric_code, market_code, benchmark_code)
      WHERE is_current;
  `);
}

// 首页市场周期：全局只保留一个当前指标，并记录采用哪位管理员、哪个账户的已保存边界。
// ========== 031：可转债统一信息视图（合并 bond_history + profiles + instruments） ==========
async function migration031BondUnified() {
  await pool.query(`
    CREATE OR REPLACE FUNCTION normalize_bond_code(raw TEXT) RETURNS TEXT AS $$
      SELECT CASE WHEN strpos(raw, '.') > 0 THEN split_part(raw, '.', 1) ELSE raw END;
    $$ LANGUAGE sql IMMUTABLE;
  `);
  // 迁移 058 会重建不依赖旧表的统一视图并删除历史兼容表；这里仅为老版本升级保留输入表。
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bond_history (
      security_code          TEXT PRIMARY KEY,
      security_name          TEXT,
      listing_date           TEXT,
      first_day_return       REAL,
      updated_at             TEXT,
      ann_date               TEXT,
      res_ann_date           TEXT,
      issue_size             REAL,
      issue_type             TEXT,
      rating                 TEXT,
      shd_ration_ratio       REAL,
      issue_price            REAL,
      shd_ration_record_date TEXT,
      onl_date               TEXT,
      onl_size               REAL,
      onl_pch_num            REAL,
      offl_size              REAL,
      shd_ration_size        REAL,
      conv_price             REAL,
      stk_code               TEXT,
      stk_name               TEXT
    );
  `);
  // 使用普通视图而非物化视图：数据量小（<1000行），自动反映最新写入
  await pool.query(`DROP VIEW IF EXISTS public.bond_unified CASCADE`);
  await pool.query(`
    CREATE VIEW public.bond_unified AS
    SELECT
      i.canonical_code                                          AS bond_code,
      i.name                                                    AS bond_name,
      i.list_date                                               AS listing_date,
      i.delist_date,
      i.status,
      p.bond_full_name,
      p.stock_instrument_id,
      p.issue_size,
      p.remain_size,
      p.par_value,
      p.first_conv_price,
      p.current_conv_price                                      AS conv_price,
      p.value_date,
      p.maturity_date,
      p.conv_start_date,
      p.conv_end_date,
      p.conv_stop_date,
      p.coupon_rate,
      p.issue_rating,
      p.newest_rating                                           AS rating,
      p.rating_company,
      p.guarantor,
      p.guarantee_type,
      p.fundraising_purpose,
      p.cb_type,
      p.maturity_call_price,
      bh.ann_date,
      bh.res_ann_date,
      bh.issue_type,
      bh.shd_ration_ratio,
      bh.shd_ration_record_date,
      bh.onl_date,
      bh.onl_size,
      bh.onl_pch_num,
      bh.offl_size,
      bh.shd_ration_size,
      bh.issue_price                                              AS bh_issue_price,
      bh.first_day_return,
      s.canonical_code                                          AS stock_code,
      COALESCE(s.name, bh.stk_name, '')                         AS stock_name,
      COALESCE(p.newest_rating, bh.rating)                      AS display_rating,
      COALESCE(p.current_conv_price, bh.conv_price)             AS display_conv_price,
      COALESCE(p.issue_size, bh.issue_size)                     AS display_issue_size
    FROM core.instruments i
    LEFT JOIN fundamental.convertible_bond_profiles p ON p.instrument_id = i.instrument_id
    LEFT JOIN bond_history bh ON bh.security_code = normalize_bond_code(i.canonical_code)
    LEFT JOIN core.instruments s ON s.instrument_id = p.stock_instrument_id
    WHERE i.asset_class = 'convertible_bond';
  `);
}

// ========== 032：安全性快照结构化列（从 JSONB 提取关键汇总字段） ==========
async function migration032BondSafetyStructured() {
  await pool.query(`
    ALTER TABLE bond_safety_snapshots ADD COLUMN IF NOT EXISTS dominant_risk_level TEXT;
    ALTER TABLE bond_safety_snapshots ADD COLUMN IF NOT EXISTS total_bonds_count INTEGER;
  `);
  // 回填已有快照：从 data JSONB 中统计各级别数量，取最多的那个
  await pool.query(`
    UPDATE bond_safety_snapshots
    SET total_bonds_count = jsonb_array_length(data),
        dominant_risk_level = (
          SELECT key FROM jsonb_each_text(
            (SELECT jsonb_object_agg(safety, cnt) FROM (
              SELECT COALESCE(item->>'safety', '未评级') AS safety, COUNT(*) AS cnt
              FROM jsonb_array_elements(data) AS item
              GROUP BY item->>'safety'
            ) t)
          ) ORDER BY value::int DESC LIMIT 1
        )
    WHERE total_bonds_count IS NULL
  `);
}

// ========== 033：股票统一信息视图（合并 instruments + 最新估值） ==========
async function migration033StockUnified() {
  await pool.query(`DROP VIEW IF EXISTS public.stock_unified CASCADE`);
  await pool.query(`
    CREATE VIEW public.stock_unified AS
    SELECT
      i.canonical_code                                          AS stock_code,
      i.name                                                    AS stock_name,
      i.market,
      i.list_date,
      i.delist_date,
      i.status,
      NULL::text                                                AS industry,
      dv.trade_date                                             AS last_valuation_date,
      dv.pe_ttm,
      dv.pb,
      dv.dividend_yield_ttm,
      dv.total_market_cap,
      dv.circulating_market_cap
    FROM core.instruments i
    LEFT JOIN LATERAL (
      SELECT instrument_id, trade_date, pe_ttm, pb, dividend_yield_ttm, total_market_cap, circulating_market_cap
      FROM market.daily_valuations
      WHERE instrument_id = i.instrument_id
      ORDER BY trade_date DESC LIMIT 1
    ) dv ON true
    WHERE i.asset_class = 'stock';
  `);
}

// ========== 034：可转债档案补齐 list_date 列（统一数据层写入 SQL 引用该列，旧库缺失） ==========
async function migration034BondProfileListDate() {
  await pool.query(`ALTER TABLE fundamental.convertible_bond_profiles ADD COLUMN IF NOT EXISTS list_date DATE`);
}

// ========== 035：bond_unified 正股代码兜底（迁移期保护） ==========
// 正股代码补后缀规则必须与 bondDataService.normalizeStockCode() 保持一致（0/3 开头 → 深市，其余 → 沪市）。
async function migration035BondUnifiedStkFallback() {
  await pool.query(`
    CREATE OR REPLACE FUNCTION normalize_stock_code(raw TEXT) RETURNS TEXT AS $$
      SELECT CASE
        WHEN raw IS NULL OR raw = '' THEN NULL
        WHEN strpos(raw, '.') > 0 THEN raw
        WHEN raw ~ '^(0|3)' THEN raw || '.SZ'
        ELSE raw || '.SH'
      END;
    $$ LANGUAGE sql IMMUTABLE;
  `);
  await pool.query(`DROP VIEW IF EXISTS public.bond_unified CASCADE`);
  await pool.query(`
    CREATE VIEW public.bond_unified AS
    SELECT
      i.canonical_code                                          AS bond_code,
      i.name                                                    AS bond_name,
      i.list_date                                               AS listing_date,
      i.delist_date,
      i.status,
      p.bond_full_name,
      p.stock_instrument_id,
      p.issue_size,
      p.remain_size,
      p.par_value,
      p.first_conv_price,
      p.current_conv_price                                      AS conv_price,
      p.value_date,
      p.maturity_date,
      p.conv_start_date,
      p.conv_end_date,
      p.conv_stop_date,
      p.coupon_rate,
      p.issue_rating,
      p.newest_rating                                           AS rating,
      p.rating_company,
      p.guarantor,
      p.guarantee_type,
      p.fundraising_purpose,
      p.cb_type,
      p.maturity_call_price,
      bh.ann_date,
      bh.res_ann_date,
      bh.issue_type,
      bh.shd_ration_ratio,
      bh.shd_ration_record_date,
      bh.onl_date,
      bh.onl_size,
      bh.onl_pch_num,
      bh.offl_size,
      bh.shd_ration_size,
      bh.issue_price                                              AS bh_issue_price,
      bh.first_day_return,
      COALESCE(s.canonical_code, normalize_stock_code(bh.stk_code)) AS stock_code,
      COALESCE(s.name, bh.stk_name, '')                         AS stock_name,
      COALESCE(p.newest_rating, bh.rating)                      AS display_rating,
      COALESCE(p.current_conv_price, bh.conv_price)             AS display_conv_price,
      COALESCE(p.issue_size, bh.issue_size)                     AS display_issue_size
    FROM core.instruments i
    LEFT JOIN fundamental.convertible_bond_profiles p ON p.instrument_id = i.instrument_id
    LEFT JOIN bond_history bh ON bh.security_code = normalize_bond_code(i.canonical_code)
    LEFT JOIN core.instruments s ON s.instrument_id = p.stock_instrument_id
    WHERE i.asset_class = 'convertible_bond';
  `);
}

// ========== 030：市场周期首页设置（已有） ==========
async function migration030MarketCycleHomeSetting() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS analytics.market_cycle_home_setting (
      setting_key TEXT PRIMARY KEY,
      metric_code TEXT NOT NULL,
      market_code TEXT NOT NULL,
      benchmark_code TEXT NOT NULL,
      reference_username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      reference_account TEXT NOT NULL,
      updated_by TEXT REFERENCES users(username) ON DELETE SET NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT chk_market_cycle_home_key CHECK (setting_key = 'market_cycle_home'),
      CONSTRAINT chk_market_cycle_home_metric CHECK (metric_code IN ('graham','pe','pb','m2_market_cap'))
    );

    INSERT INTO analytics.market_cycle_home_setting
      (setting_key,metric_code,market_code,benchmark_code,reference_username,reference_account,updated_by)
    SELECT 'market_cycle_home','pe','CN','CSI300','daicunzai','华泰账户','daicunzai'
    WHERE EXISTS (
      SELECT 1 FROM analytics.market_cycle_strategy_settings
      WHERE username='daicunzai' AND account_name='华泰账户'
        AND metric_code='pe' AND market_code='CN' AND benchmark_code='CSI300' AND is_current
    )
    ON CONFLICT (setting_key) DO NOTHING;
  `);
}

// ========== 036：仓位对比功能（账户公开状态 + 持仓 instrument_id + 证券交易单位缓存） ==========
// 对应 docs/仓位对比功能_开发文档.md 8.2 节：
//   1) accounts 表加 position_visibility / position_visibility_updated_at（幂等加约束 + 部分索引）
//   2) positions 表加 instrument_id（兼容性新增，未匹配保持 NULL，不删除旧链路）
//   3) 新建 market.instrument_trade_rules（港股每手股数标准化事实表）
//   4) 注册港股每手股数数据源（复用 tushare，dataset_code 见同步脚本）
async function migration036PositionComparison() {
  // ---- 1) accounts 公开状态 ----
  await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS position_visibility TEXT NOT NULL DEFAULT 'private'`);
  await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS position_visibility_updated_at TIMESTAMPTZ`);
  await pool.query(`
    DO $migration$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_accounts_position_visibility' AND conrelid='accounts'::regclass) THEN
        ALTER TABLE accounts ADD CONSTRAINT chk_accounts_position_visibility
          CHECK (position_visibility IN ('public', 'semi_public', 'private'));
      END IF;
    END
    $migration$;
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_accounts_position_visibility
      ON accounts (position_visibility, position_visibility_updated_at DESC)
      WHERE position_visibility <> 'private';
  `);

  // ---- 2) positions.instrument_id（兼容性新增；保存链路见 server/db/accounts.js saveAccountData） ----
  await pool.query(`
    ALTER TABLE positions ADD COLUMN IF NOT EXISTS instrument_id BIGINT
      REFERENCES core.instruments(instrument_id) ON DELETE SET NULL
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_positions_account_instrument
      ON positions (username, account_name, instrument_id)
      WHERE instrument_id IS NOT NULL;
  `);

  // ---- 3) market.instrument_trade_rules（港股每手股数事实表） ----
  await pool.query(`
    CREATE TABLE IF NOT EXISTS market.instrument_trade_rules (
      instrument_id BIGINT NOT NULL
        REFERENCES core.instruments(instrument_id) ON DELETE CASCADE,
      source_id SMALLINT NOT NULL
        REFERENCES ops.data_sources(source_id),
      valid_from DATE NOT NULL,
      valid_to DATE,
      buy_lot_size_shares INTEGER NOT NULL,
      source_updated_at TIMESTAMPTZ,
      raw_record_id BIGINT
        REFERENCES ops.raw_records(raw_record_id) ON DELETE SET NULL,
      ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),

      PRIMARY KEY (instrument_id, source_id, valid_from),

      CONSTRAINT chk_trade_rules_lot_size
        CHECK (buy_lot_size_shares > 0),

      CONSTRAINT chk_trade_rules_validity
        CHECK (valid_to IS NULL OR valid_to >= valid_from)
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_trade_rules_lookup
      ON market.instrument_trade_rules
      (instrument_id, valid_from DESC, source_id);
  `);

  // ---- 4) 数据源登记（港股每手股数走 Tushare hk_basic，复用现有 tushare source_code） ----
  await pool.query(`
    INSERT INTO ops.data_sources(source_code,source_name,source_type,priority)
    VALUES ('tushare','Tushare','official',10)
    ON CONFLICT(source_code) DO NOTHING;
  `);
}

// ========== 037：回填历史持仓的 instrument_id（仓位对比统一证券身份） ==========
// 对应 docs/仓位对比功能_开发文档.md 8.2 节："迁移后按 core.instruments.canonical_code 和
// core.instrument_identifiers 回填现有持仓的 instrument_id。未匹配记录继续保留原 code，
// 写入 ops.data_quality_issues，不得因映射失败删除持仓。"
// 匹配规则与 server/db/accounts.js buildInstrumentIdMap 一致：
//   1) canonical_code 精确匹配（如 600519.SH / 00700.HK）；
//   2) 否则按"去掉非数字字符"的纯代码匹配（如 600519 / 00700）。
// 港股持仓需先有 core.instruments 主档（由 hkTradeRulesSync 落库），未匹配时保留 NULL
// 并在下一轮同步/回填补偿，不删除持仓。幂等：重复执行仅更新仍未匹配的行。
// 2026-08-01 收尾修复：映射成功后关闭 open 质量记录；未匹配先查重再插入（instrument_id NULL
// 时 UNIQUE 不生效，须手动去重，避免每日重复累积）。
async function migration037BackfillPositionInstrumentIds() {
  // 1) 精确匹配（canonical_code 或 code 本身）
  await pool.query(`
    UPDATE positions p
       SET instrument_id = i.instrument_id
      FROM core.instruments i
     WHERE p.instrument_id IS NULL
       AND i.canonical_code = p.code
  `);
  // 2) 去符号纯代码匹配（排除精确已匹配的行；同一纯代码映射多个主档时不覆盖，防错配）
  await pool.query(`
    UPDATE positions p
       SET instrument_id = m.instrument_id
      FROM (
        SELECT p.username, p.account_name, p.id, min(i.instrument_id) AS instrument_id
          FROM positions p
          JOIN core.instruments i
            ON REGEXP_REPLACE(i.canonical_code, '[^0-9]', '', 'g') = REGEXP_REPLACE(p.code, '[^0-9]', '', 'g')
         WHERE p.instrument_id IS NULL
         GROUP BY p.username, p.account_name, p.id
        HAVING count(DISTINCT i.instrument_id) = 1
      ) m
     WHERE p.username = m.username AND p.account_name = m.account_name AND p.id = m.id
  `);
  // 3) 映射成功：关闭已 open 的未匹配质量记录
  await pool.query(`
    UPDATE ops.data_quality_issues q
       SET status='resolved', resolved_at=now(), details=jsonb_set(details,'{resolved_by}','"backfill"')
      FROM positions p
     WHERE q.dataset_code='positions' AND q.field_code='instrument_id' AND q.issue_type='unmatched_position'
       AND q.status='open'
       AND p.instrument_id IS NOT NULL
       AND q.details->>'username'=p.username AND q.details->>'account_name'=p.account_name AND q.details->>'code'=p.code
  `);
  // 4) 仍未匹配：先查重再插入（避免重复累积）
  await pool.query(`
    INSERT INTO ops.data_quality_issues(instrument_id,dataset_code,field_code,issue_type,severity,details)
    SELECT NULL,'positions','instrument_id','unmatched_position','warning',
           jsonb_build_object('username',p.username,'account_name',p.account_name,'code',p.code)
      FROM positions p
     WHERE p.instrument_id IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM core.instruments i
          WHERE REGEXP_REPLACE(i.canonical_code, '[^0-9]', '', 'g') = REGEXP_REPLACE(p.code, '[^0-9]', '', 'g')
       )
       AND NOT EXISTS (
         SELECT 1 FROM ops.data_quality_issues q
          WHERE q.dataset_code='positions' AND q.field_code='instrument_id'
            AND q.issue_type='unmatched_position' AND q.status='open'
            AND q.details->>'username'=p.username
            AND q.details->>'account_name'=p.account_name
            AND q.details->>'code'=p.code
       )
  `);
  // 5) 清理历史重复的 open 记录（同一持仓保留最新一条）
  await pool.query(`
    DELETE FROM ops.data_quality_issues q
      USING ops.data_quality_issues q2
     WHERE q.dataset_code='positions' AND q.field_code='instrument_id' AND q.issue_type='unmatched_position'
       AND q.status='open' AND q2.dataset_code=q.dataset_code AND q2.field_code=q.field_code
       AND q2.issue_type=q.issue_type AND q2.status='open'
       AND q2.details->>'username'=q.details->>'username'
       AND q2.details->>'account_name'=q.details->>'account_name'
       AND q2.details->>'code'=q.details->>'code'
       AND (q.issue_id < q2.issue_id)
  `);
}

// ========== 038：数据架构收尾（交易单位规则去重 + 质量问题清理） ==========
// 2026-08-01 验收收尾：
//   1) 清理 037 早期版本累积的重复 open 质量记录（同持仓保留最新一条）；
//   2) 重跑回填并关闭已映射持仓的 open 记录（037 函数已含此逻辑，这里再次执行以修复存量）；
//   3) 修正 market.instrument_trade_rules 中同一天重复写入的规则（保留最新一条）。
async function migration038DataArchitectureCleanup() {
  // 1) 清理重复 open 质量记录（同一持仓仅保留 issue_id 最大的一条）
  await pool.query(`
    DELETE FROM ops.data_quality_issues q
      USING ops.data_quality_issues q2
     WHERE q.dataset_code='positions' AND q.field_code='instrument_id' AND q.issue_type='unmatched_position'
       AND q.status='open' AND q2.dataset_code=q.dataset_code AND q2.field_code=q.field_code
       AND q2.issue_type=q.issue_type AND q2.status='open'
       AND q2.details->>'username'=q.details->>'username'
       AND q2.details->>'account_name'=q.details->>'account_name'
       AND q2.details->>'code'=q.details->>'code'
       AND q.issue_id < q2.issue_id
  `);
  // 2) 重跑回填（037 逻辑，含关闭已映射的 open 记录 + 去重插入未匹配记录）
  await migration037BackfillPositionInstrumentIds();
}

// ========== 039：accounts.hk_rate_updated_at（精确记录汇率更新时间） ==========
// 2026-08-02 验收收尾：此前汇率"更新时间"复用 accounts.updated_at（会被持仓保存、公开状态
// 修改等操作更新），不是真实汇率更新时间。新增专用列，由 ensureHkRate / saveAccountData
// 在写 hk_rate 时同步更新；loadAccountCash 读取它作为汇率时间。
async function migration039AccountHkRateUpdatedAt() {
  await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS hk_rate_updated_at TIMESTAMPTZ`);
  // 存量：updated_at 是 text（to_char 格式），转 timestamptz 近似；转换失败则用 now()
  await pool.query(`
    UPDATE accounts SET hk_rate_updated_at = COALESCE(updated_at::timestamptz, now())
     WHERE hk_rate_updated_at IS NULL
  `);
}

// ========== 040：account_data 历史净值备份（导入前自动拍快照，误导入可一键还原） ==========
// 2026-08-02 误导入清污染：用户把招商账户的"投入本金"误导入到华泰账户，污染历史走势。
// 后续导入历史净值前自动备份当前 navHistory 到 nav_history_backup，并暴露一键还原 API。
async function migration040NavHistoryBackup() {
  await pool.query(`ALTER TABLE account_data ADD COLUMN IF NOT EXISTS nav_history_backup JSONB`);
  await pool.query(`ALTER TABLE account_data ADD COLUMN IF NOT EXISTS nav_history_backup_at TIMESTAMPTZ`);
}

// ========== 041：账户双数据源架构整改（2026-08-03 整改报告 P0/P1 代码部分） ==========
// 目标：结构化表成为唯一权威来源，JSON 兼容数据退出运行时读取。
// 1) 数据集级版本号：positions/trades/nav_history/cash_flows 各自独立版本，
//    整包保存时按数据集校验，后台任务写入净值后旧浏览器保存持仓不再覆盖新净值（8.2 并发验收）。
// 2) data_source_version：一次性迁移标记。存量行置 2（视为已归档，禁止 migrateToStructured 再回灌）；
//    新账户默认 0（表空即真空，绝不自动从 JSON 迁入）。人工确认补录后置 2。
// 3) accounts.fee_settings：税费设置从 JSON 迁入 accounts 表（账户偏好结构化，JSON 不再读写）。
async function migration041AccountDataSource() {
  await pool.query(`ALTER TABLE account_data ADD COLUMN IF NOT EXISTS pos_version INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE account_data ADD COLUMN IF NOT EXISTS trade_version INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE account_data ADD COLUMN IF NOT EXISTS nav_version INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE account_data ADD COLUMN IF NOT EXISTS cashflow_version INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE account_data ADD COLUMN IF NOT EXISTS data_source_version INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE account_data ADD COLUMN IF NOT EXISTS structured_migrated_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS fee_settings JSONB`);
  // P0-3 修复（2026-08-03）：**先**把 JSON 中仍有效的账户偏好（feeSettings/cashBase/hkRate）迁入
  // accounts 表，**再**置归档标记。否则 JSON 被标记归档后运行时不再读它，税费设置将永久丢失。
  // 幂等：accounts 表已有值（非 NULL 的 fee_settings、非默认的 cash_base/hk_rate）不被覆盖。
  const { rows: arch } = await pool.query(
    `SELECT ad.username, ad.account_name, ad.data
       FROM account_data ad
       LEFT JOIN accounts a ON a.username=ad.username AND a.account_name=ad.account_name
      WHERE (a.username IS NULL OR a.fee_settings IS NULL
         OR a.cash_base = 0 OR a.hk_rate = 0.868)
        AND EXISTS (SELECT 1 FROM users u WHERE u.username = ad.username)`
  );
  // 偏好迁移失败/JSON 解析失败的账户**不归档**（保持 data_source_version<2，下次启动重试），
  // 避免"设置还没迁走就被标记归档 → 运行时不再读 JSON → 设置永久丢失"（2026-08-03 阻断修复）。
  const failedArchive = [];
  for (const r of arch) {
    let d = null;
    try { d = JSON.parse(r.data); } catch (e) {
      failedArchive.push(r.username + '\u0000' + r.account_name);
      console.warn('[migrate 041] JSON 解析失败，不归档待重试', r.username + '/' + r.account_name + ':', e.message);
      continue;
    }
    const fee = (d && d.feeSettings && typeof d.feeSettings === 'object') ? JSON.stringify(d.feeSettings) : null;
    const cashBase = (d && typeof d.cashBase === 'number' && d.cashBase > 0) ? String(d.cashBase) : null;
    const hkRate = (d && typeof d.hkRate === 'number' && d.hkRate > 0) ? String(d.hkRate) : null;
    if (fee === null && cashBase === null && hkRate === null) continue; // 无偏好可迁，可直接归档
    const acctId = require('crypto').createHash('sha256').update(r.username + '\n' + r.account_name).digest('hex');
    try {
      await pool.query(
        `INSERT INTO accounts (id, username, account_name, cash_base, hk_rate, fee_settings, version, updated_at)
         VALUES ($1,$2,$3,COALESCE($4::numeric,0),COALESCE($5::numeric,0.868),$6,1,to_char(now(),'YYYY-MM-DD HH24:MI:SS'))
         ON CONFLICT (username, account_name) DO UPDATE SET
           cash_base = CASE WHEN accounts.cash_base = 0 THEN COALESCE(EXCLUDED.cash_base, accounts.cash_base) ELSE accounts.cash_base END,
           hk_rate = CASE WHEN accounts.hk_rate = 0.868 THEN COALESCE(EXCLUDED.hk_rate, accounts.hk_rate) ELSE accounts.hk_rate END,
           fee_settings = CASE WHEN accounts.fee_settings IS NULL THEN EXCLUDED.fee_settings ELSE accounts.fee_settings END,
           updated_at = EXCLUDED.updated_at`,
        [acctId, r.username, r.account_name, cashBase, hkRate, fee]
      );
    } catch (e) {
      // 孤立 account_data（无对应用户）或写入失败 → 不归档，留给人工处理/下次重试（审计脚本会列出）
      failedArchive.push(r.username + '\u0000' + r.account_name);
      console.warn('[migrate 041] 偏好迁移失败，不归档待重试', r.username + '/' + r.account_name + ':', e.message);
    }
  }
  // 存量 account_data 视为已归档（data_source_version=2）：本次部署后运行时代码不再读其业务数组，
  // 也未执行自动回灌；确需从 JSON 补录的账户由管理员人工确认后单独处理。
  // ⚠️ 2026-08-03 阻断修复：仅归档"偏好迁移成功/无需迁移"的账户；偏好迁移失败或 JSON 解析失败的
  //    账户**保持 data_source_version<2（待重试）**——否则设置还没迁走就被标记归档，运行时不再读
  //    JSON，税费设置将永久丢失。实现：先归档全部，再把失败账户回退为 1（下次启动 runMigration 重试）。
  await pool.query(`UPDATE account_data SET data_source_version = 2 WHERE data_source_version < 2`);
  for (const key of failedArchive) {
    const sep = key.indexOf('\u0000');
    await pool.query(
      'UPDATE account_data SET data_source_version = 1 WHERE username=$1 AND account_name=$2',
      [key.slice(0, sep), key.slice(sep + 1)]
    );
  }
  // ⚠️ 2026-08-03 执行器级修复：存在失败账户时必须**抛异常**，否则 runMigration 会把 041 登记为
  // 已完成，下次启动直接跳过 → 失败账户永远不会被重试（设置永久丢失风险）。
  // 抛错后：已成功归档的账户保留 dsv=2（幂等重跑跳过）；失败账户 dsv=1 → runMigration 不登记 → 下次启动重跑。
  if (failedArchive.length > 0) {
    throw new Error(
      '[migrate 041] ' + failedArchive.length + ' 个账户偏好迁移失败（未归档待重试）：' +
      failedArchive.map(function (k) { return k.replace('\u0000', '/'); }).join('、')
    );
  }
}

async function ensureMigrationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT now()
    );
  `);
}

// 执行单个迁移步骤；单步失败记录日志，下次启动会重试（SQL 均幂等可重跑）
async function runMigration(up, version) {
  try {
    await up();
    await pool.query('INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING', [version]);
  } catch (e) {
    console.warn('[migrate] 步骤', version, '执行失败，下次启动将重试:', e.message);
    throw e;
  }
}

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

// ========== 058：打新与可转债统一数据层直接切换 ==========
// 发行事实、证券生命周期事件、上市表现分别落表；bond_history 只在本迁移内作为一次性输入。
async function migration058ConvertibleBondIssueUnified() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TABLE IF NOT EXISTS fundamental.convertible_bond_issuance (
        instrument_id BIGINT PRIMARY KEY REFERENCES core.instruments(instrument_id) ON DELETE CASCADE,
        issue_type TEXT,
        issue_price_yuan NUMERIC(20,8),
        issue_size_100m_yuan NUMERIC(20,8),
        shareholder_allotment_ratio_yuan_per_share NUMERIC(20,8),
        online_size_100m_yuan NUMERIC(20,8),
        offline_size_100m_yuan NUMERIC(20,8),
        online_purchase_accounts_10k NUMERIC(20,8),
        shareholder_allotment_quantity NUMERIC(30,4),
        source_id SMALLINT NOT NULL REFERENCES ops.data_sources(source_id),
        source_updated_at TIMESTAMPTZ,
        raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_cb_issuance_source_updated
        ON fundamental.convertible_bond_issuance(source_updated_at DESC);

      CREATE TABLE IF NOT EXISTS event.instrument_events (
        event_id BIGSERIAL PRIMARY KEY,
        instrument_id BIGINT NOT NULL REFERENCES core.instruments(instrument_id) ON DELETE CASCADE,
        event_type TEXT NOT NULL CHECK (event_type IN (
          'issue_announcement','shareholder_record','online_subscription',
          'result_announcement','listing'
        )),
        event_date DATE NOT NULL,
        source_id SMALLINT NOT NULL REFERENCES ops.data_sources(source_id),
        document_id BIGINT NULL REFERENCES event.documents(document_id),
        source_key TEXT NOT NULL,
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        source_updated_at TIMESTAMPTZ NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (source_id, source_key)
      );
      CREATE INDEX IF NOT EXISTS idx_instrument_events_date
        ON event.instrument_events(instrument_id, event_date DESC);
      CREATE INDEX IF NOT EXISTS idx_instrument_events_type_date
        ON event.instrument_events(event_type, event_date);

      CREATE TABLE IF NOT EXISTS analytics.convertible_bond_listing_performance (
        instrument_id BIGINT NOT NULL REFERENCES core.instruments(instrument_id) ON DELETE CASCADE,
        listing_date DATE NOT NULL,
        observation_date DATE NOT NULL,
        measurement_type TEXT NOT NULL CHECK (measurement_type = 'first_non_limit_day'),
        close_price NUMERIC(24,8),
        return_pct NUMERIC(20,8),
        formula_version TEXT NOT NULL,
        source_id SMALLINT NOT NULL REFERENCES ops.data_sources(source_id),
        raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        calculated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (instrument_id, measurement_type, formula_version)
      );
      CREATE INDEX IF NOT EXISTS idx_cb_listing_performance_date
        ON analytics.convertible_bond_listing_performance(listing_date DESC);

      ALTER TABLE predictions ADD COLUMN IF NOT EXISTS instrument_id BIGINT
        REFERENCES core.instruments(instrument_id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS idx_predictions_instrument
        ON predictions(instrument_id, pred_date DESC);
    `);

    const sourceResult = await client.query(
      `SELECT source_id FROM ops.data_sources WHERE source_code='tushare' LIMIT 1`
    );
    if (!sourceResult.rows[0]) throw new Error('缺少 tushare 数据源');
    const tushareSourceId = sourceResult.rows[0].source_id;

    // 旧表可能由迁移 031 建成空壳，也可能由日报脚本建成完整表。
    const oldTable = await client.query(`
      SELECT to_regclass('public.bond_history') AS name
    `);
    if (oldTable.rows[0].name) {
      for (const [column, type] of [
        ['security_name', 'TEXT'], ['listing_date', 'TEXT'], ['first_day_return', 'REAL'], ['updated_at', 'TEXT'],
        ['ann_date', 'TEXT'], ['res_ann_date', 'TEXT'], ['issue_size', 'REAL'], ['issue_type', 'TEXT'],
        ['rating', 'TEXT'], ['shd_ration_ratio', 'REAL'], ['issue_price', 'REAL'],
        ['shd_ration_record_date', 'TEXT'], ['onl_date', 'TEXT'], ['onl_size', 'REAL'],
        ['onl_pch_num', 'REAL'], ['offl_size', 'REAL'], ['shd_ration_size', 'REAL'], ['conv_price', 'REAL'],
        ['stk_code', 'TEXT'], ['stk_name', 'TEXT']
      ]) {
        await client.query(`ALTER TABLE public.bond_history ADD COLUMN IF NOT EXISTS ${column} ${type}`);
      }
      const legacyAudit = await client.query(`
        SELECT COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE security_code !~ '^[0-9]{6}$')::int AS invalid_codes,
               COUNT(*) FILTER (WHERE NULLIF(stk_code,'') IS NOT NULL)::int AS stock_codes,
               COUNT(*) FILTER (WHERE NULLIF(issue_size::text,'') IS NOT NULL)::int AS issue_sizes,
               COUNT(*) FILTER (WHERE NULLIF(ann_date,'') IS NOT NULL OR NULLIF(res_ann_date,'') IS NOT NULL
                                  OR NULLIF(shd_ration_record_date,'') IS NOT NULL OR NULLIF(onl_date,'') IS NOT NULL)::int AS event_rows,
               COUNT(*) FILTER (WHERE first_day_return IS NOT NULL)::int AS performance_rows
          FROM public.bond_history`);
      if (legacyAudit.rows[0].invalid_codes > 0) {
        throw new Error(`bond_history 存在 ${legacyAudit.rows[0].invalid_codes} 条非法可转债代码，停止删除旧表`);
      }
      const oldRows = await client.query(`
        SELECT * FROM public.bond_history
        WHERE security_code ~ '^[0-9]{6}$'
        ORDER BY security_code
      `);
      for (const row of oldRows.rows) {
        const code = String(row.security_code);
        const canonicalCode = /^12/.test(code) ? `${code}.SZ` : `${code}.SH`;
        const instrument = await client.query(`
          INSERT INTO core.instruments(canonical_code,name,asset_class,market,list_date,status,raw_data)
          VALUES($1,$2,'convertible_bond','CN',$3::date,
                 CASE WHEN $3::date IS NULL THEN 'announced'
                      WHEN $3::date <= CURRENT_DATE THEN 'listed' ELSE 'pending_listing' END,
                 $4::jsonb)
          ON CONFLICT(canonical_code) DO UPDATE SET
            name=COALESCE(NULLIF(core.instruments.name,''),EXCLUDED.name),
            list_date=COALESCE(core.instruments.list_date,EXCLUDED.list_date),
            updated_at=now()
          RETURNING instrument_id
        `, [canonicalCode, row.security_name || code, normalizeMigrationDate(row.listing_date), JSON.stringify(row)]);
        const instrumentId = instrument.rows[0].instrument_id;

        let stockId = null;
        const stockCode = normalizeMigrationStockCode(row.stk_code);
        if (stockCode) {
          const stock = await client.query(`
            INSERT INTO core.instruments(canonical_code,name,asset_class,market)
            VALUES($1,$2,'stock','CN')
            ON CONFLICT(canonical_code) DO UPDATE SET
              name=COALESCE(NULLIF(core.instruments.name,''),EXCLUDED.name),updated_at=now()
            RETURNING instrument_id
          `, [stockCode, row.stk_name || stockCode]);
          stockId = stock.rows[0].instrument_id;
          await client.query(
            `UPDATE fundamental.convertible_bond_profiles
                SET stock_instrument_id=COALESCE(stock_instrument_id,$1),updated_at=now()
              WHERE instrument_id=$2`, [stockId, instrumentId]
          );
        }

        await client.query(`
          INSERT INTO fundamental.convertible_bond_profiles
            (instrument_id,stock_instrument_id,bond_short_name,current_conv_price,issue_size,newest_rating,list_date,source_id,raw_payload)
          VALUES($1,$2,$3,$4,$5,$6,$7::date,$8,$9::jsonb)
          ON CONFLICT(instrument_id) DO UPDATE SET
            stock_instrument_id=COALESCE(fundamental.convertible_bond_profiles.stock_instrument_id,EXCLUDED.stock_instrument_id),
            bond_short_name=COALESCE(NULLIF(fundamental.convertible_bond_profiles.bond_short_name,''),EXCLUDED.bond_short_name),
            current_conv_price=COALESCE(fundamental.convertible_bond_profiles.current_conv_price,EXCLUDED.current_conv_price),
            issue_size=COALESCE(fundamental.convertible_bond_profiles.issue_size,EXCLUDED.issue_size),
            newest_rating=COALESCE(NULLIF(fundamental.convertible_bond_profiles.newest_rating,''),EXCLUDED.newest_rating),
            list_date=COALESCE(fundamental.convertible_bond_profiles.list_date,EXCLUDED.list_date),
            raw_payload=fundamental.convertible_bond_profiles.raw_payload || EXCLUDED.raw_payload,
            updated_at=now()
        `, [instrumentId, stockId, row.security_name || code, toNumber(row.conv_price), toNumber(row.issue_size) == null ? null : toNumber(row.issue_size) * 100000000,
          row.rating || '', normalizeMigrationDate(row.listing_date), tushareSourceId, JSON.stringify(row)]);

        const updatedAt = normalizeMigrationTimestamp(row.updated_at);
        await client.query(`
          INSERT INTO fundamental.convertible_bond_issuance
            (instrument_id,issue_type,issue_price_yuan,issue_size_100m_yuan,
             shareholder_allotment_ratio_yuan_per_share,online_size_100m_yuan,
             offline_size_100m_yuan,online_purchase_accounts_10k,
             shareholder_allotment_quantity,source_id,source_updated_at,raw_payload)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
          ON CONFLICT(instrument_id) DO UPDATE SET
            issue_type=COALESCE(EXCLUDED.issue_type, fundamental.convertible_bond_issuance.issue_type),
            issue_price_yuan=COALESCE(EXCLUDED.issue_price_yuan, fundamental.convertible_bond_issuance.issue_price_yuan),
            issue_size_100m_yuan=COALESCE(EXCLUDED.issue_size_100m_yuan, fundamental.convertible_bond_issuance.issue_size_100m_yuan),
            shareholder_allotment_ratio_yuan_per_share=COALESCE(EXCLUDED.shareholder_allotment_ratio_yuan_per_share, fundamental.convertible_bond_issuance.shareholder_allotment_ratio_yuan_per_share),
            online_size_100m_yuan=COALESCE(EXCLUDED.online_size_100m_yuan, fundamental.convertible_bond_issuance.online_size_100m_yuan),
            offline_size_100m_yuan=COALESCE(EXCLUDED.offline_size_100m_yuan, fundamental.convertible_bond_issuance.offline_size_100m_yuan),
            online_purchase_accounts_10k=COALESCE(EXCLUDED.online_purchase_accounts_10k, fundamental.convertible_bond_issuance.online_purchase_accounts_10k),
            shareholder_allotment_quantity=COALESCE(EXCLUDED.shareholder_allotment_quantity, fundamental.convertible_bond_issuance.shareholder_allotment_quantity),
            source_updated_at=COALESCE(EXCLUDED.source_updated_at, fundamental.convertible_bond_issuance.source_updated_at),
            raw_payload=fundamental.convertible_bond_issuance.raw_payload || EXCLUDED.raw_payload,
            updated_at=now()
        `, [instrumentId, row.issue_type || null, toNumber(row.issue_price), toNumber(row.issue_size),
          toNumber(row.shd_ration_ratio), toNumber(row.onl_size), toNumber(row.offl_size),
          toNumber(row.onl_pch_num), toNumber(row.shd_ration_size), tushareSourceId,
          updatedAt, JSON.stringify(row)]);

        const events = [
          ['issue_announcement', row.ann_date],
          ['shareholder_record', row.shd_ration_record_date],
          ['online_subscription', row.onl_date],
          ['result_announcement', row.res_ann_date],
          ['listing', row.listing_date],
        ];
        for (const [eventType, date] of events) {
          const eventDate = normalizeMigrationDate(date);
          if (!eventDate) continue;
          await client.query(`
            INSERT INTO event.instrument_events
              (instrument_id,event_type,event_date,source_id,source_key,details,source_updated_at)
            VALUES($1,$2,$3::date,$4,$5,$6::jsonb,$7)
            ON CONFLICT(source_id,source_key) DO UPDATE SET
              instrument_id=EXCLUDED.instrument_id,event_date=EXCLUDED.event_date,
              details=EXCLUDED.details,source_updated_at=EXCLUDED.source_updated_at,updated_at=now()
          `, [instrumentId, eventType, eventDate, tushareSourceId,
            `tushare:cb_issue:${code}:${eventType}:${eventDate}`, JSON.stringify(row), updatedAt]);
        }

        const listingDate = normalizeMigrationDate(row.listing_date);
        const returnPct = toNumber(row.first_day_return);
        if (listingDate && returnPct != null) {
          await client.query(`
            INSERT INTO analytics.convertible_bond_listing_performance
              (instrument_id,listing_date,observation_date,measurement_type,close_price,return_pct,formula_version,source_id,raw_payload)
            VALUES($1,$2::date,$2::date,'first_non_limit_day',100 * (1 + $3::numeric / 100),$3::numeric,'legacy_bond_history_v1',$4,$5::jsonb)
            ON CONFLICT(instrument_id,measurement_type,formula_version) DO UPDATE SET
              listing_date=EXCLUDED.listing_date,observation_date=EXCLUDED.observation_date,
              close_price=EXCLUDED.close_price,return_pct=EXCLUDED.return_pct,
              raw_payload=EXCLUDED.raw_payload,calculated_at=now()
          `, [instrumentId, listingDate, returnPct, tushareSourceId, JSON.stringify(row)]);
        }
      }
      const coverage = await client.query(`
        SELECT
          (SELECT COUNT(*) FROM public.bond_history) AS old_total,
          (SELECT COUNT(*) FROM public.bond_history bh JOIN core.instruments i
             ON i.canonical_code = CASE WHEN bh.security_code LIKE '12%' THEN bh.security_code || '.SZ' ELSE bh.security_code || '.SH' END
            WHERE i.asset_class='convertible_bond') AS instrument_total,
          (SELECT COUNT(*) FROM public.bond_history bh JOIN core.instruments i
             ON i.canonical_code = CASE WHEN bh.security_code LIKE '12%' THEN bh.security_code || '.SZ' ELSE bh.security_code || '.SH' END
             JOIN fundamental.convertible_bond_issuance iss ON iss.instrument_id=i.instrument_id
            WHERE (NULLIF(bh.issue_type,'') IS NULL OR NULLIF(iss.issue_type,'') IS NOT NULL)
              AND (bh.issue_price IS NULL OR iss.issue_price_yuan IS NOT NULL)
              AND (bh.issue_size IS NULL OR iss.issue_size_100m_yuan IS NOT NULL)
              AND (bh.shd_ration_ratio IS NULL OR iss.shareholder_allotment_ratio_yuan_per_share IS NOT NULL)
              AND (bh.onl_size IS NULL OR iss.online_size_100m_yuan IS NOT NULL)
              AND (bh.offl_size IS NULL OR iss.offline_size_100m_yuan IS NOT NULL)
              AND (bh.onl_pch_num IS NULL OR iss.online_purchase_accounts_10k IS NOT NULL)
              AND (bh.shd_ration_size IS NULL OR iss.shareholder_allotment_quantity IS NOT NULL)) AS issuance_covered,
          (SELECT COUNT(*) FROM public.bond_history bh JOIN core.instruments i
             ON i.canonical_code = CASE WHEN bh.security_code LIKE '12%' THEN bh.security_code || '.SZ' ELSE bh.security_code || '.SH' END
             JOIN fundamental.convertible_bond_profiles p ON p.instrument_id=i.instrument_id
             WHERE NULLIF(bh.stk_code,'') IS NULL OR p.stock_instrument_id IS NOT NULL) AS stock_covered,
          (SELECT COUNT(*) FROM public.bond_history bh JOIN core.instruments i
             ON i.canonical_code = CASE WHEN bh.security_code LIKE '12%' THEN bh.security_code || '.SZ' ELSE bh.security_code || '.SH' END
            WHERE (NULLIF(bh.ann_date,'') IS NULL OR EXISTS (
                     SELECT 1 FROM event.instrument_events e
                      WHERE e.instrument_id=i.instrument_id AND e.event_type='issue_announcement'
                   ))
              AND (NULLIF(bh.shd_ration_record_date,'') IS NULL OR EXISTS (
                     SELECT 1 FROM event.instrument_events e
                      WHERE e.instrument_id=i.instrument_id AND e.event_type='shareholder_record'
                   ))
              AND (NULLIF(bh.onl_date,'') IS NULL OR EXISTS (
                     SELECT 1 FROM event.instrument_events e
                      WHERE e.instrument_id=i.instrument_id AND e.event_type='online_subscription'
                   ))
              AND (NULLIF(bh.res_ann_date,'') IS NULL OR EXISTS (
                     SELECT 1 FROM event.instrument_events e
                      WHERE e.instrument_id=i.instrument_id AND e.event_type='result_announcement'
                   ))
              AND (NULLIF(bh.listing_date,'') IS NULL OR EXISTS (
                     SELECT 1 FROM event.instrument_events e
                      WHERE e.instrument_id=i.instrument_id AND e.event_type='listing'
                   ))) AS issue_event_covered,
          (SELECT COUNT(*) FROM public.bond_history bh JOIN core.instruments i
             ON i.canonical_code = CASE WHEN bh.security_code LIKE '12%' THEN bh.security_code || '.SZ' ELSE bh.security_code || '.SH' END
             LEFT JOIN analytics.convertible_bond_listing_performance lp ON lp.instrument_id=i.instrument_id
            WHERE bh.first_day_return IS NULL OR lp.measurement_type='first_non_limit_day') AS performance_covered
      `);
      const c = coverage.rows[0];
      if (Number(c.old_total) !== Number(c.instrument_total)) throw new Error('旧债代码未 100% 映射到 instrument_id，停止删除旧表');
      if (Number(c.old_total) !== Number(c.issuance_covered)) throw new Error('旧债发行事实未 100% 覆盖，停止删除旧表');
      if (Number(c.old_total) !== Number(c.stock_covered)) throw new Error('旧债正股关联未 100% 覆盖，停止删除旧表');
      if (Number(c.old_total) !== Number(c.issue_event_covered)) throw new Error('旧债发行公告事件未 100% 覆盖，停止删除旧表');
      if (Number(c.old_total) !== Number(c.performance_covered)) throw new Error('旧债上市表现未 100% 覆盖，停止删除旧表');
    }

    const unresolved = await client.query(`
      SELECT p.id,p.type,p.code
        FROM predictions p
        LEFT JOIN core.instruments i
          ON i.canonical_code = CASE
               WHEN p.code ~ '^\\d{6}\\.(SH|SZ)$' THEN p.code
               WHEN p.code ~ '^(10|11|110|111|113|118)' THEN p.code || '.SH'
               ELSE p.code || '.SZ' END
       WHERE p.type='bond' AND p.instrument_id IS NULL AND i.instrument_id IS NULL
    `);
    if (unresolved.rows.length) {
      throw new Error(`存在无法映射到 instrument_id 的可转债预测：${unresolved.rows.slice(0, 10).map(r => r.code).join(',')}`);
    }
    await client.query(`
      UPDATE predictions p
         SET instrument_id=i.instrument_id,updated_at=COALESCE(p.updated_at,to_char(now(),'YYYY-MM-DD HH24:MI:SS'))
        FROM core.instruments i
       WHERE p.type='bond' AND p.instrument_id IS NULL
         AND i.canonical_code = CASE
           WHEN p.code ~ '^\\d{6}\\.(SH|SZ)$' THEN p.code
           WHEN p.code ~ '^(10|11|110|111|113|118)' THEN p.code || '.SH'
           ELSE p.code || '.SZ' END
    `);
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname='chk_predictions_bond_instrument'
            AND conrelid='predictions'::regclass
        ) THEN
          ALTER TABLE predictions ADD CONSTRAINT chk_predictions_bond_instrument
            CHECK (type <> 'bond' OR instrument_id IS NOT NULL) NOT VALID;
        END IF;
      END $$;
    `);

    await client.query(`
      DROP VIEW IF EXISTS public.bond_unified CASCADE;
      CREATE VIEW public.bond_unified AS
      SELECT
        i.instrument_id,
        i.canonical_code AS bond_code,
        split_part(i.canonical_code, '.', 1) AS security_code,
        i.name AS bond_name,
        COALESCE(ev.listing_date::date, i.list_date) AS listing_date,
        i.delist_date,
        i.status,
        p.bond_full_name,
        p.stock_instrument_id,
        p.issue_size,
        p.remain_size,
        p.par_value,
        p.first_conv_price,
        p.current_conv_price AS conv_price,
        p.value_date,
        p.maturity_date,
        p.conv_start_date,
        p.conv_end_date,
        p.conv_stop_date,
        p.coupon_rate,
        p.issue_rating,
        p.newest_rating AS rating,
        p.rating_company,
        p.guarantor,
        p.guarantee_type,
        p.fundraising_purpose,
        p.cb_type,
        p.maturity_call_price,
        iss.issue_type,
        iss.issue_size_100m_yuan,
        iss.shareholder_allotment_ratio_yuan_per_share AS shd_ration_ratio,
        iss.online_size_100m_yuan AS onl_size,
        iss.offline_size_100m_yuan AS offl_size,
        iss.online_purchase_accounts_10k AS onl_pch_num,
        iss.shareholder_allotment_quantity AS shd_ration_size,
        iss.issue_price_yuan AS bh_issue_price,
        ev.ann_date,
        ev.res_ann_date,
        ev.shd_ration_record_date,
        ev.onl_date,
        perf.first_day_return,
        s.canonical_code AS stock_code,
        COALESCE(s.name, '') AS stock_name,
        COALESCE(p.newest_rating, p.issue_rating) AS display_rating,
        p.current_conv_price AS display_conv_price,
        COALESCE(iss.issue_size_100m_yuan, p.issue_size / 100000000.0) AS display_issue_size
      FROM core.instruments i
      LEFT JOIN fundamental.convertible_bond_profiles p ON p.instrument_id=i.instrument_id
      LEFT JOIN fundamental.convertible_bond_issuance iss ON iss.instrument_id=i.instrument_id
      LEFT JOIN core.instruments s ON s.instrument_id=p.stock_instrument_id
      LEFT JOIN LATERAL (
        SELECT
          MAX(event_date) FILTER (WHERE event_type='issue_announcement')::text AS ann_date,
          MAX(event_date) FILTER (WHERE event_type='result_announcement')::text AS res_ann_date,
          MAX(event_date) FILTER (WHERE event_type='shareholder_record')::text AS shd_ration_record_date,
          MAX(event_date) FILTER (WHERE event_type='online_subscription')::text AS onl_date,
          MAX(event_date) FILTER (WHERE event_type='listing')::text AS listing_date
        FROM event.instrument_events e WHERE e.instrument_id=i.instrument_id
      ) ev ON true
      LEFT JOIN LATERAL (
        SELECT return_pct AS first_day_return
          FROM analytics.convertible_bond_listing_performance lp
         WHERE lp.instrument_id=i.instrument_id AND lp.measurement_type='first_non_limit_day'
         ORDER BY lp.calculated_at DESC LIMIT 1
      ) perf ON true
      WHERE i.asset_class='convertible_bond';
    `);

    const oldExists = await client.query(`SELECT to_regclass('public.bond_history') AS name`);
    if (oldExists.rows[0].name) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS ops.legacy_bond_history_20260812 AS
        SELECT * FROM public.bond_history WHERE false
      `);
      const oldCount = await client.query(`SELECT COUNT(*)::int AS n FROM public.bond_history`);
      const archiveCount = await client.query(`SELECT COUNT(*)::int AS n FROM ops.legacy_bond_history_20260812`);
      const oldTotal = oldCount.rows[0].n;
      const archivedTotal = archiveCount.rows[0].n;
      if (archivedTotal !== 0 && archivedTotal !== oldTotal) {
        throw new Error(`旧 bond_history 归档不完整：旧表 ${oldTotal} 行，归档表 ${archivedTotal} 行，停止删除旧表`);
      }
      if (archivedTotal === 0 && oldTotal > 0) {
        await client.query(`INSERT INTO ops.legacy_bond_history_20260812 SELECT * FROM public.bond_history`);
      }
      const verifiedArchive = await client.query(`SELECT COUNT(*)::int AS n FROM ops.legacy_bond_history_20260812`);
      if (verifiedArchive.rows[0].n !== oldTotal) {
        throw new Error(`旧 bond_history 归档校验失败：期望 ${oldTotal} 行，实际 ${verifiedArchive.rows[0].n} 行，停止删除旧表`);
      }
      await client.query(`DROP TABLE public.bond_history`);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
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

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeMigrationDate(value) {
  const text = String(value || '').replace(/-/g, '').slice(0, 8);
  return /^\d{8}$/.test(text) ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}` : null;
}

function normalizeMigrationTimestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeMigrationStockCode(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (!raw) return null;
  if (raw.includes('.')) return raw;
  return /^(0|3)/.test(raw) ? `${raw}.SZ` : `${raw}.SH`;
}

function scale100m(value, divisor) {
  const number = toNumber(value);
  return number == null ? null : number / divisor;
}

const MIGRATIONS = [
  { version: '001_init', up: migration001Init },
  { version: '002_bond_safety_snapshots', up: migration002BondSafetySnapshots },
  { version: '003_market_data_cache', up: migration003MarketDataCache },
  { version: '004_bond_safety_financial_cache', up: migration004BondSafetyFinancialCache },
  { version: '005_stock_analysis', up: migration005StockAnalysis },
  { version: '006_stock_analysis_overview', up: migration006StockAnalysisOverview },
  { version: '007_financial_data_architecture', up: migration007FinancialDataArchitecture },
  { version: '008_drop_legacy_stock_analysis_tables', up: migration008DropLegacyStockAnalysisTables },
  { version: '009_valuation_data_quality', up: migration009ValuationDataQuality },
  { version: '010_convertible_bond_analysis', up: migration010ConvertibleBondAnalysis },
  { version: '011_ipo_tracking_storage', up: migration011IpoTrackingStorage },
  { version: '012_knowledge_articles', up: migration012KnowledgeArticles },
  { version: '013_knowledge_permission', up: migration013KnowledgePermission },
  { version: '014_nested_comments', up: migration014NestedComments },
  { version: '015_comment_author', up: migration015CommentAuthor },
  { version: '016_article_author_nullable', up: migration016ArticleAuthorNullable },
  { version: '017_knowledge_constraints', up: migration017KnowledgeConstraints },
  { version: '018_seed_default_categories', up: migration018SeedDefaultCategories },
  { version: '019_knowledge_constraints_verify', up: migration019KnowledgeConstraintsVerify },
  { version: '020_knowledge_category_ownership', up: migration020KnowledgeCategoryOwnership },
  { version: '021_convertible_bond_cycle', up: migration021ConvertibleBondCycle },
  { version: '022_convertible_bond_valuation', up: migration022ConvertibleBondValuation },
  { version: '023_valuation_constraints', up: migration023ValuationConstraints },
  { version: '024_valuation_alert_reentry', up: migration024ValuationAlertReentry },
  { version: '025_market_volatility', up: migration025MarketVolatility },
  { version: '026_index_valuation_history', up: migration026IndexValuationHistory },
  { version: '027_article_sort_order', up: migration027ArticleSortOrder },
  { version: '028_article_global_sort_order', up: migration028ArticleGlobalSortOrder },
  { version: '029_market_cycle_metrics', up: migration029MarketCycleMetrics },
  { version: '030_market_cycle_home_setting', up: migration030MarketCycleHomeSetting },
  { version: '031_bond_unified', up: migration031BondUnified },
  { version: '032_bond_safety_structured', up: migration032BondSafetyStructured },
  { version: '033_stock_unified', up: migration033StockUnified },
  { version: '034_bond_profile_list_date', up: migration034BondProfileListDate },
  { version: '035_bond_unified_stk_fallback', up: migration035BondUnifiedStkFallback },
  { version: '036_position_comparison', up: migration036PositionComparison },
  { version: '037_backfill_position_instrument_ids', up: migration037BackfillPositionInstrumentIds },
  { version: '038_data_architecture_cleanup', up: migration038DataArchitectureCleanup },
  { version: '039_account_hk_rate_updated_at', up: migration039AccountHkRateUpdatedAt },
  { version: '040_nav_history_backup', up: migration040NavHistoryBackup },
  { version: '041_account_data_source', up: migration041AccountDataSource },
  { version: '042_trade_fields', up: migration042TradeFields },
  { version: '043_position_cost', up: migration043PositionCost },
  { version: '044_nav_cash_boundary', up: migration044NavCashBoundary },
  { version: '045_nav_snapshot_at', up: migration045NavSnapshotAt },
  { version: '046_position_events', up: migration046PositionEvents },
  { version: '047_account_id_fk', up: migration047AccountId },
  { version: '048_tighten_account_ledger', up: migration048TightenAccountLedger },
  { version: '049_session_revocation', up: migration049SessionRevocation },
  { version: '050_capability_permissions', up: migration050CapabilityPermissions },
  { version: '051_audit_result_metadata', up: migration051AuditResultMetadata },
  { version: '052_nav_history_hk_rate', up: migration052NavHistoryHkRate },
  { version: '053_index_baseline_settled', up: migration053IndexBaselineSettled },
  { version: '054_arbitrage_cases', up: migration054ArbitrageCases },
  { version: '055_arbitrage_parser_accuracy', up: migration055ArbitrageParserAccuracy },
  { version: '056_global_fx_rate_source', up: migration056GlobalFxRateSource },
  { version: '057_ipo_history_sync', up: migration057IpoHistorySync },
  { version: '058_convertible_bond_issue_unified', up: migration058ConvertibleBondIssueUnified },
  { version: '059_ipo_reports_schema', up: migration059IpoReportsSchema },
  { version: '060_sse_listing_announcement_source', up: migration060SseListingAnnouncementSource },
  { version: '061_job_orchestration', up: migration061JobOrchestration },
  { version: '062_alert_delivery_retry', up: migration062AlertDeliveryRetry },
  { version: '063_alert_sending_status', up: migration063AlertSendingStatus },
  { version: '064_alert_sending_started_at', up: migration064AlertSendingStartedAt },
  { version: '065_alert_recovery_attempts', up: migration065AlertRecoveryAttempts },
  { version: '066_arbitrage_parse_retry', up: migration066ArbitrageParseRetry },
  { version: '067_job_request_payload', up: migration067JobRequestPayload },
];

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

// ========== 042：交易字段整改（trade_date 交易日 / executed_at 成交时间 / import_batch_id 导入批次） ==========
// 2026-08-03 持仓账本整改（方案 3.6/阶段四）：
//  - date 保留完整 "YYYY-MM-DD HH:MM"（历史兼容），新增 trade_date 为纯交易日 YYYY-MM-DD，
//    后台净值重放一律按 trade_date 比较，修复"当天带时间交易被字符串比较漏算"。
//  - executed_at 成交时间（YYYY-MM-DD HH:MM:SS，用于同日现金流/交易排序与净值结算边界）。
//  - import_batch_id 导入批次标识（智能导入业务去重 + 追溯），无批次的手工交易为 NULL。
async function migration042TradeFields() {
  await pool.query(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS trade_date TEXT`);
  await pool.query(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS executed_at TEXT`);
  await pool.query(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS import_batch_id TEXT`);
  // 回填：trade_date = date 的前 10 位（纯日期）；executed_at = date 若有时间部分则取完整串，否则用 created_at
  await pool.query(`
    UPDATE trades
       SET trade_date = left(date, 10),
           executed_at = CASE
             WHEN length(date) > 10 THEN date
             WHEN created_at IS NOT NULL AND created_at <> '' THEN created_at
             ELSE date END
     WHERE trade_date IS NULL OR executed_at IS NULL
  `);
  // 数据约束（阶段五）：direction/quantity/price/amount 合法性
  await pool.query(`
    ALTER TABLE trades
      ADD CONSTRAINT chk_trades_direction CHECK (direction IN ('buy','sell'))
  `);
}

// ========== 043：账户账本整改（持仓成本与当前价分离注释性迁移占位） ==========
// 说明：positions.price = 当前行情价（由行情刷新更新）；positions.cost = 移动加权成本（由服务端交易事务维护）。
// 交易录入只更新 cost/quantity，禁止覆盖 price——已在服务端账本事务中强制执行，本迁移仅为后续约束预留。
async function migration043PositionCost() {
  // 无结构变更；账户账本整改的约束由服务端事务层保证（见 services/tradeLedger.js）
}

// ========== 044：同日现金流净值边界字段（nav_history 记录数据截止/结算边界） ==========
// 方案 3.7：当天净值需知道"已结算的现金流边界"，避免当天入金被误算成盈利。
// 在 account_data 上记录上次净值快照的现金流结算边界（快照时间），供前端同日更新净值时判断。
async function migration044NavCashBoundary() {
  await pool.query(`ALTER TABLE account_data ADD COLUMN IF NOT EXISTS nav_cash_cutoff TEXT`);
}

// ========== 045：nav_history 快照时间持久化（P0-3 验收修复） ==========
// 前端 recordNav 用 snapshot_at 记录"快照时刻"，作为同日现金流的结算边界。
// 原实现只在内存，刷新页面后丢失 → 同日入金仍可能误算盈利。
// 修复：nav_history 增加 snapshot_at 列持久化，读写全链路保留。
async function migration045NavSnapshotAt() {
  await pool.query(`ALTER TABLE nav_history ADD COLUMN IF NOT EXISTS snapshot_at TEXT`);
}

// ========== 046：期初持仓与调整事件 + 服务端导入幂等（P0-2 / P1-4 验收修复） ==========
// 方案 4.2：期初持仓不是普通买入交易，必须使用独立业务类型。
// 实现：trades.direction 扩展为 buy/sell/open/adjust：
//   - open   = 期初建仓（导入持仓快照，等效买入，记入成本）
//   - adjust = 持仓调整（数量可正可负，仅校正数量/成本，不产生现金变动）
// 同时删除旧的 direction 检查约束（迁移 042 建的），改为允许四值的约束。
// 幂等：import_batch_id 非空时，同批次+代码+交易日+方向+价格+数量 视为重复导入，数据库层拦截。
async function migration046PositionEvents() {
  await pool.query(`ALTER TABLE trades DROP CONSTRAINT IF EXISTS chk_trades_direction`);
  await pool.query(`
    ALTER TABLE trades
      ADD CONSTRAINT chk_trades_direction CHECK (direction IN ('buy','sell','open','adjust'))
  `);
  // 服务端导入幂等（P1-4 验收修复）：批次+账户+业务唯一键唯一索引（NULL 不参与约束，手工交易不受影响）
  // ⚠️ 必须含 username/account_name——否则相同批次号跨账户互相冲突
  await pool.query(`DROP INDEX IF EXISTS uq_trades_import_dedupe`);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_trades_import_dedupe
      ON trades (username, account_name, import_batch_id, code, trade_date, direction, price, quantity)
      WHERE import_batch_id IS NOT NULL
  `);
  // 数据库约束补齐（P1-5，方案阶段五第 5 条）：
  // price>=0、quantity>0（存量有 2 条 price=0 历史数据，允许 0 但禁止负价）、amount>=0、费用>=0
  // ⚠️ PG 不支持 ADD CONSTRAINT IF NOT EXISTS → 先查 pg_constraint 再建
  for (const c of [
    ['chk_trades_price', `CHECK (direction = 'adjust' OR price >= 0)`],
    ['chk_trades_qty', `CHECK (direction = 'adjust' OR quantity > 0)`],
    ['chk_trades_amount', `CHECK (amount IS NULL OR amount >= 0)`],
    ['chk_trades_fee', `CHECK (commission IS NULL OR commission >= 0)`],
    // 全部费用非负（验收补充：stamp_tax/transfer_fee/other_fee）
    ['chk_trades_fee_all', `CHECK ((stamp_tax IS NULL OR stamp_tax >= 0) AND (transfer_fee IS NULL OR transfer_fee >= 0) AND (other_fee IS NULL OR other_fee >= 0))`],
    // 交易日期格式合法（trade_date 为 YYYY-MM-DD）
    ['chk_trades_trade_date', `CHECK (trade_date IS NULL OR trade_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')`],
  ]) {
    const ex = await pool.query(`SELECT 1 FROM pg_constraint WHERE conname=$1 AND conrelid='trades'::regclass`, [c[0]]);
    if (ex.rowCount === 0) {
      await pool.query(`ALTER TABLE trades ADD CONSTRAINT ${c[0]} ${c[1]}`);
    }
  }
  // 金额关系 amount = price × quantity（验收补充）：存量有 20 条历史数据金额错位（招商期初导入），
  // 硬约束会拒绝存量 → 用 NOT VALID 只约束新写入（服务端账本已强制一致）
  const amtEx = await pool.query(`SELECT 1 FROM pg_constraint WHERE conname='chk_trades_amount_rel' AND conrelid='trades'::regclass`);
  if (amtEx.rowCount === 0) {
    await pool.query(`ALTER TABLE trades ADD CONSTRAINT chk_trades_amount_rel
      CHECK (direction IN ('open','adjust') OR amount IS NULL OR ABS(amount - ROUND(price*quantity, 2)) < 0.02) NOT VALID`);
  }
}

// ========== 047：不可变 account_id 外键基础设施（验收补充，方案阶段五） ==========
// 所有账户子表新增 account_id（指向 accounts.id 的不可变主键），回填后建立外键。
// 说明：读写代码仍以 username+account_name 为准（兼容层）；account_id 作为不可变关联键，
// 账户重命名不再影响子表关联（方案 4.2），并为未来按 account_id 收敛提供基础。
// NOT VALID：历史存量行若无法匹配 accounts（孤立数据）也允许建约束，仅约束新写入。
// ⚠️ 部署修复（2026-08-03）：PG 的 UPDATE 会重新校验 NOT VALID 约束！回填 account_id 的 UPDATE
//    命中招商 32 条期初导入（amount=成本金额≠price×qty）→ 被 chk_trades_amount_rel 拦截导致
//    迁移失败（服务器 0.4.3.6→0.4.4.3 实测）。处理：回填前临时 DROP，回填后重建（NOT VALID
//    仍允许存量违反；新写入由账本层强制 amount 一致）。
async function migration047AccountId() {
  const tables = ['positions', 'trades', 'nav_history', 'cash_flows', 'daily_prices', 'index_history'];
  for (const t of tables) {
    // 1) 加列
    const colEx = await pool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name='account_id'`, [t]
    );
    if (colEx.rowCount === 0) {
      await pool.query(`ALTER TABLE ${t} ADD COLUMN account_id TEXT`);
    }
    // 2) 回填（按 username+account_name 匹配 accounts.id）
    //    回填前 DROP 会拦截历史数据的 NOT VALID 约束（UPDATE 重新校验）
    await pool.query(`ALTER TABLE trades DROP CONSTRAINT IF EXISTS chk_trades_amount_rel`);
    await pool.query(
      `UPDATE ${t} b SET account_id = a.id
         FROM accounts a
        WHERE b.username = a.username AND b.account_name = a.account_name
          AND b.account_id IS NULL`
    );
    // 回填后重建 amount_rel（NOT VALID：存量违反不再校验）
    const amtRelEx = await pool.query(`SELECT 1 FROM pg_constraint WHERE conname='chk_trades_amount_rel' AND conrelid='trades'::regclass`);
    if (amtRelEx.rowCount === 0) {
      await pool.query(`ALTER TABLE trades ADD CONSTRAINT chk_trades_amount_rel
        CHECK (direction IN ('open','adjust') OR amount IS NULL OR ABS(amount - ROUND(price*quantity, 2)) < 0.02) NOT VALID`);
    }
    // 3) 外键（NOT VALID：存量孤立行不校验；后续写入由代码保证 account_id 关联）
    const fkName = `fk_${t}_account_id`;
    const fkEx = await pool.query(`SELECT 1 FROM pg_constraint WHERE conname=$1`, [fkName]);
    if (fkEx.rowCount === 0) {
      await pool.query(
        `ALTER TABLE ${t} ADD CONSTRAINT ${fkName}
         FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE NOT VALID`
      );
    }
  }
}

// ========== 048：046 增量约束与索引的幂等收敛（四轮验收修复） ==========
// 问题：046 曾含"含账户去重索引 + 补充约束 + amount_rel"，这些是在 046 已发布后追加的，
// 从 0.4.3.9 升级的库不会重跑 046 → 新库缺这些约束/索引。
// 解决：抽成独立迁移 048，全部幂等（先查后建 / IF NOT EXISTS），任何版本升级到本版都会补齐。
// 同时确保 account_id 在所有业务子表存在（与 047 相同逻辑，幂等；防止 047 缺跑的库）。
async function migration048TightenAccountLedger() {
  // 1) 含账户的导入幂等唯一索引（幂等重建）
  await pool.query(`DROP INDEX IF EXISTS uq_trades_import_dedupe`);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_trades_import_dedupe
      ON trades (username, account_name, import_batch_id, code, trade_date, direction, price, quantity)
      WHERE import_batch_id IS NOT NULL
  `);
  // 2) 补充约束（先查 pg_constraint 再建）
  for (const c of [
    ['chk_trades_fee_all', `CHECK ((stamp_tax IS NULL OR stamp_tax >= 0) AND (transfer_fee IS NULL OR transfer_fee >= 0) AND (other_fee IS NULL OR other_fee >= 0))`],
    ['chk_trades_trade_date', `CHECK (trade_date IS NULL OR trade_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')`],
  ]) {
    const ex = await pool.query(`SELECT 1 FROM pg_constraint WHERE conname=$1 AND conrelid='trades'::regclass`, [c[0]]);
    if (ex.rowCount === 0) {
      await pool.query(`ALTER TABLE trades ADD CONSTRAINT ${c[0]} ${c[1]}`);
    }
  }
  // 3) amount 关系（NOT VALID：兼容存量期初导入成本金额）
  const amtEx = await pool.query(`SELECT 1 FROM pg_constraint WHERE conname='chk_trades_amount_rel' AND conrelid='trades'::regclass`);
  if (amtEx.rowCount === 0) {
    await pool.query(`ALTER TABLE trades ADD CONSTRAINT chk_trades_amount_rel
      CHECK (direction IN ('open','adjust') OR amount IS NULL OR ABS(amount - ROUND(price*quantity, 2)) < 0.02) NOT VALID`);
  }
  // 4) account_id 基础设施（幂等，兼容 047 未跑/缺跑的库）
  //    ⚠️ 部署修复：回填 UPDATE 前临时 DROP amount_rel（UPDATE 重新校验 NOT VALID 约束），
  //    回填完成后重建——与 047 同款处理，防止服务器升级顺序（046建约束→048回填）再次撞约束。
  const tables = ['positions', 'trades', 'nav_history', 'cash_flows', 'daily_prices', 'index_history'];
  await pool.query(`ALTER TABLE trades DROP CONSTRAINT IF EXISTS chk_trades_amount_rel`);
  for (const t of tables) {
    const colEx = await pool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name='account_id'`, [t]
    );
    if (colEx.rowCount === 0) {
      await pool.query(`ALTER TABLE ${t} ADD COLUMN account_id TEXT`);
    }
    await pool.query(
      `UPDATE ${t} b SET account_id = a.id
         FROM accounts a
        WHERE b.username = a.username AND b.account_name = a.account_name
          AND b.account_id IS NULL`
    );
    const fkName = `fk_${t}_account_id`;
    const fkEx = await pool.query(`SELECT 1 FROM pg_constraint WHERE conname=$1`, [fkName]);
    if (fkEx.rowCount === 0) {
      await pool.query(
        `ALTER TABLE ${t} ADD CONSTRAINT ${fkName}
         FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE NOT VALID`
      );
    }
  }
  // 回填完成后重建 amount_rel（NOT VALID：存量期初导入成本金额不校验；新写入由账本层保证）
  const amtRelEx2 = await pool.query(`SELECT 1 FROM pg_constraint WHERE conname='chk_trades_amount_rel' AND conrelid='trades'::regclass`);
  if (amtRelEx2.rowCount === 0) {
    await pool.query(`ALTER TABLE trades ADD CONSTRAINT chk_trades_amount_rel
      CHECK (direction IN ('open','adjust') OR amount IS NULL OR ABS(amount - ROUND(price*quantity, 2)) < 0.02) NOT VALID`);
  }
}

// 版本化迁移执行器：只跑 schema_migrations 里没有记录过的步骤
async function runMigrations() {
  await ensureMigrationsTable();
  const { rows } = await pool.query('SELECT version FROM schema_migrations');
  const applied = new Set(rows.map(r => r.version));
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    console.log('[migrate] 执行升级步骤', m.version);
    await runMigration(m.up, m.version);
  }
}

// 兼容旧调用点（server/app.js、server/worker.js、test-integration.js）：语义不变，改走版本化迁移
async function initSchema() {
  await runMigrations();
}

// ====== 迁移（仅本地遗留 JSON 文件时触发；云上全新部署一般为空，不会执行） ======

async function migrateFromJson() {
  const usersPath = path.join(DATA_DIR, '__users__.json');
  if (!fs.existsSync(usersPath)) return;
  const { rows } = await pool.query('SELECT COUNT(*)::int AS cnt FROM users');
  if (rows[0].cnt > 0) return;
  try {
    const users = JSON.parse(fs.readFileSync(usersPath, 'utf-8'));
    for (const [u, v] of Object.entries(users)) {
      await pool.query(
        'INSERT INTO users (username, password, accounts) VALUES ($1,$2,$3) ON CONFLICT (username) DO NOTHING',
        [u, v.password, JSON.stringify(v.accounts || [])]
      );
      for (const acct of (v.accounts || [])) {
        const fp = path.join(DATA_DIR, `${u.replace(/[^a-zA-Z0-9@._-]/g, '_')}__${acct.replace(/[^a-zA-Z0-9一-龥_-]/g, '_')}.json`);
        try {
          const d = JSON.parse(fs.readFileSync(fp, 'utf-8'));
          await pool.query(
            'INSERT INTO account_data (username, account_name, data) VALUES ($1,$2,$3) ON CONFLICT (username, account_name) DO NOTHING',
            [u, acct, JSON.stringify(d)]
          );
        } catch (e) {}
      }
    }
    const bakDir = path.join(DATA_DIR, 'json_backup_' + Date.now());
    fs.mkdirSync(bakDir, { recursive: true });
    for (const f of fs.readdirSync(DATA_DIR)) {
      if (f.endsWith('.json') && f !== '__users__.json' && !f.startsWith('json_backup')) {
        try { fs.cpSync(path.join(DATA_DIR, f), path.join(bakDir, f)); } catch (e) {}
      }
    }
    console.log('已从 JSON 迁移到数据库');
  } catch (e) { console.error('JSON 迁移失败:', e.message); }
}

// 2026-08-03 架构整改（报告 3.4/阶段二）：迁移只能执行一次。
// - 存量 account_data 已由迁移 041 置 data_source_version=2（视为已归档），本函数对它们直接跳过，
//   即使 JSON 里还有旧业务数组也不再回灌 → 已删除的数据不可能被 /migrate-json 重新导入。
// - 仅 data_source_version<2 的账户（新库/人工确认需补录的账户）才会被合并，合并后置 2。
async function migrateToStructured() {
  const { rows } = await pool.query('SELECT username, account_name, data, data_source_version FROM account_data WHERE data_source_version < 2');
  if (rows.length === 0) return { ok: true, migrated: 0, skippedArchived: true };
  let migrated = 0;
  for (const r of rows) {
    let d;
    try { d = JSON.parse(r.data); } catch (e) { continue; }
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); // 账户级事务（六轮验收）：一账户全部写入成功才提交，失败整体回滚，杜绝半迁移
      // 不可变账户主键（新写入必须带 account_id；账户不存在则先建）
      const acctId = require('crypto').createHash('sha256').update(r.username + '\n' + r.account_name).digest('hex');
      await client.query(
        'INSERT INTO accounts (id, username, account_name, cash_base, hk_rate, fee_settings, version, updated_at) VALUES ($1,$2,$3,$4,$5,$6,1,to_char(now(),\'YYYY-MM-DD HH24:MI:SS\')) ON CONFLICT (username, account_name) DO NOTHING',
        [acctId, r.username, r.account_name, (typeof d.cashBase === 'number' ? d.cashBase : 0), (typeof d.hkRate === 'number' && d.hkRate > 0 ? d.hkRate : 0.868), (d.feeSettings && typeof d.feeSettings === 'object' ? JSON.stringify(d.feeSettings) : null)]
      );
      for (const p of (d.positions || [])) {
        await client.query(
          'INSERT INTO positions (id, username, account_name, account_id, code, name, price, quantity, cost, type, subtype, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (id, username, account_name) DO NOTHING',
          [p.id, r.username, r.account_name, acctId, p.code || '', p.name || '', p.price || 0, p.quantity || 0, p.cost || 0, p.type || '', p.subtype || '', p.note || '']
        );
      }
      for (const t of (d.trades || [])) {
        // ⚠️ 六轮验收修复：券商期初导入交易（note 含"导出导入"）保留"成本金额"，
        //    数据库金额约束要求 buy 的 amount=price×quantity（NOT VALID 也拦新写入）→
        //    期初导入的 direction 必须转成 'open'（期初建仓，金额约束豁免、不产生现金）。
        //    真实成交（非导入）amount 与 price×quantity 严重不符 → 按 price×quantity 修正。
        const rawAmount = (typeof t.amount === 'number' && isFinite(t.amount) ? t.amount : (t.price || 0) * (t.quantity || 0));
        const isSnapshotImport = (String(t.note || '').indexOf('导出导入') !== -1);
        const direction = isSnapshotImport ? 'open' : (t.direction || 'buy');
        const amount = isSnapshotImport ? rawAmount
          : Math.abs(rawAmount - (t.price || 0) * (t.quantity || 0)) > 0.02
            ? Math.round((t.price || 0) * (t.quantity || 0) * 100) / 100 : rawAmount;
        const tradeDate = t.trade_date || String(t.date || '').slice(0, 10);
        const executedAt = t.executed_at || (String(t.date || '').length > 10 ? t.date : (t.created_at || t.date || ''));
        await client.query(
          'INSERT INTO trades (id, username, account_name, account_id, date, created_at, trade_date, executed_at, import_batch_id, code, name, direction, price, quantity, amount, type, subtype, note, commission, stamp_tax, transfer_fee, other_fee) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) ON CONFLICT (id, username, account_name) DO NOTHING',
          [t.id, r.username, r.account_name, acctId, t.date || '', t.created_at || '', tradeDate, executedAt, t.import_batch_id || null, t.code || '', t.name || '', direction, t.price || 0, t.quantity || 0, amount, t.type || '', t.subtype || '', t.note || '', t.commission || 0, t.stamp_tax || 0, t.transfer_fee || 0, t.other_fee || 0]
        );
      }
      for (const n of (d.navHistory || [])) {
        await client.query(
          'INSERT INTO nav_history (username, account_name, account_id, date, nav, total_asset, invested, snapshot_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (username, account_name, date) DO NOTHING',
          [r.username, r.account_name, acctId, n.date || '', n.nav || 1.0, n.totalAsset || 0, (n.invested == null ? null : n.invested), n.snapshot_at || null]
        );
      }
      for (const c of (d.cashFlows || [])) {
        await client.query(
          'INSERT INTO cash_flows (id, username, account_name, account_id, date, created_at, amount, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id, username, account_name) DO NOTHING',
          [c.id || uid(), r.username, r.account_name, acctId, c.date || '', c.created_at || '', c.amount || 0, c.note || '']
        );
      }
      // 合并成功 → 置迁移标记并提交（事务内）
      await client.query('UPDATE account_data SET data_source_version=2, structured_migrated_at=now() WHERE username=$1 AND account_name=$2', [r.username, r.account_name]);
      await client.query('COMMIT');
      migrated++;
    } catch (e) {
      await client.query('ROLLBACK'); // 失败整体回滚：已写入的账户/持仓/交易全部撤销，无半迁移
      console.error('迁移账户失败 ' + r.username + '/' + r.account_name + ':', e.message);
    } finally {
      client.release();
    }
  }
  console.log('已按需合并 JSON → 结构化表（幂等，已迁移账户不再回灌）');
  return { ok: true, migrated: migrated, skippedArchived: false };
}

// ====== 用户 ======

module.exports = {
  MIGRATIONS,
  migration001Init,
  migration002BondSafetySnapshots,
  migration003MarketDataCache,
  migration004BondSafetyFinancialCache,
  migration022ConvertibleBondValuation,
  migration058ConvertibleBondIssueUnified,
  migration059IpoReportsSchema,
  migration060SseListingAnnouncementSource,
  migration061JobOrchestration,
  migration063AlertSendingStatus,
  migration064AlertSendingStartedAt,
  migration065AlertRecoveryAttempts,
  migration066ArbitrageParseRetry,
  migration067JobRequestPayload,
  ensureMigrationsTable,
  runMigration,
  runMigrations,
  initSchema,
  migrateFromJson,
  migrateToStructured,
};
