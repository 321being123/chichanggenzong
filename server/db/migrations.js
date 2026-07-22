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
  // ===== 后台：平台公告 =====
  await pool.query(`
    CREATE TABLE IF NOT EXISTS announcements (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      content TEXT DEFAULT '',
      pinned BOOLEAN NOT NULL DEFAULT false,
      published_at TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT now()
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
];

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

async function migrateToStructured() {
  const { rows } = await pool.query('SELECT username, account_name, data FROM account_data');
  if (rows.length === 0) return;
  for (const r of rows) {
    let d;
    try { d = JSON.parse(r.data); } catch (e) { continue; }
    try {
      for (const p of (d.positions || [])) {
        await pool.query(
          'INSERT INTO positions (id, username, account_name, code, name, price, quantity, cost, type, subtype, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id, username, account_name) DO NOTHING',
          [p.id, r.username, r.account_name, p.code || '', p.name || '', p.price || 0, p.quantity || 0, p.cost || 0, p.type || '', p.subtype || '', p.note || '']
        );
      }
      for (const t of (d.trades || [])) {
        await pool.query(
          'INSERT INTO trades (id, username, account_name, date, created_at, code, name, direction, price, quantity, amount, type, subtype, note, commission, stamp_tax, transfer_fee, other_fee) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) ON CONFLICT (id, username, account_name) DO NOTHING',
          [t.id, r.username, r.account_name, t.date || '', t.created_at || '', t.code || '', t.name || '', t.direction || 'buy', t.price || 0, t.quantity || 0, t.amount || 0, t.type || '', t.subtype || '', t.note || '', t.commission || 0, t.stamp_tax || 0, t.transfer_fee || 0, t.other_fee || 0]
        );
      }
      for (const n of (d.navHistory || [])) {
        await pool.query(
          'INSERT INTO nav_history (username, account_name, date, nav, total_asset, invested) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (username, account_name, date) DO NOTHING',
          [r.username, r.account_name, n.date || '', n.nav || 1.0, n.totalAsset || 0, (n.invested == null ? null : n.invested)]
        );
      }
      for (const c of (d.cashFlows || [])) {
        await pool.query(
          'INSERT INTO cash_flows (id, username, account_name, date, created_at, amount, note) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id, username, account_name) DO NOTHING',
          [c.id || uid(), r.username, r.account_name, c.date || '', c.created_at || '', c.amount || 0, c.note || '']
        );
      }
    } catch (e) { console.error('迁移账户失败 ' + r.username + '/' + r.account_name + ':', e.message); }
  }
  console.log('已按需合并 JSON → 结构化表（幂等，不覆盖已有记录）');
}

// ====== 用户 ======

module.exports = {
  migration001Init,
  migration002BondSafetySnapshots,
  migration003MarketDataCache,
  migration004BondSafetyFinancialCache,
  ensureMigrationsTable,
  runMigration,
  runMigrations,
  initSchema,
  migrateFromJson,
  migrateToStructured,
};
