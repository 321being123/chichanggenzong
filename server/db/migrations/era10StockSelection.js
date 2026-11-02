// 迁移 184：投资策略选股中心产物表（2026-11-02 研发方案第 10 节）。
// 只新增原系统没有的策略与结果表；主档/行情/财务/原始证据仍分别落在 core/market/fundamental/ops，
// 本文件不复制任何事实表，也不创建审计机构表（方案第 1 节已删除该条件）。

async function migration184StockSelection(pg) {
  // 1) 策略版本：已使用版本不可原位改参，靠 content_hash + 唯一键约束。
  await pg.query(`
    CREATE TABLE IF NOT EXISTS analytics.stock_selection_strategies (
      strategy_id BIGSERIAL PRIMARY KEY,
      strategy_code TEXT NOT NULL,
      market TEXT NOT NULL,
      version TEXT NOT NULL,
      formula_version TEXT NOT NULL,
      adapter_version TEXT,
      risk_version TEXT,
      industry_version TEXT,
      effective_from DATE,
      parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
      content_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT stock_selection_strategies_market_check CHECK (market IN ('CN','HK')),
      CONSTRAINT stock_selection_strategies_version_uk UNIQUE (strategy_code, market, version)
    )`);

  // 2) 运行批次：执行状态 / 数据质量 / 业务准入分别保存（方案 9.3）。
  await pg.query(`
    CREATE TABLE IF NOT EXISTS analytics.stock_selection_runs (
      run_id BIGSERIAL PRIMARY KEY,
      strategy_id BIGINT NOT NULL REFERENCES analytics.stock_selection_strategies(strategy_id),
      market TEXT NOT NULL,
      run_kind TEXT NOT NULL,
      owner_username TEXT REFERENCES users(username),
      quarter TEXT,
      as_of_date DATE NOT NULL,
      knowledge_cutoff TIMESTAMPTZ NOT NULL,
      execution_status TEXT NOT NULL DEFAULT 'pending',
      quality_status TEXT NOT NULL DEFAULT 'pending',
      business_status TEXT NOT NULL DEFAULT 'pending',
      input_hash TEXT NOT NULL,
      input_manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
      universe_count INTEGER NOT NULL DEFAULT 0,
      pending_count INTEGER NOT NULL DEFAULT 0,
      selected_count INTEGER NOT NULL DEFAULT 0,
      market_pb NUMERIC,
      market_pe NUMERIC,
      benchmark_code TEXT,
      valuation_method TEXT,
      position_ratio NUMERIC,
      budget_ratio NUMERIC,
      revision INTEGER NOT NULL DEFAULT 1,
      published_at TIMESTAMPTZ,
      supersedes_run_id BIGINT REFERENCES analytics.stock_selection_runs(run_id),
      request_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT stock_selection_runs_market_check CHECK (market IN ('CN','HK')),
      CONSTRAINT stock_selection_runs_kind_check CHECK (run_kind IN ('quarterly','preview','personal','backtest')),
      CONSTRAINT stock_selection_runs_selected_check CHECK (selected_count BETWEEN 0 AND 30),
      CONSTRAINT stock_selection_runs_ratio_check CHECK (position_ratio IS NULL OR (position_ratio >= 0 AND position_ratio <= 1)),
      CONSTRAINT stock_selection_runs_budget_check CHECK (budget_ratio IS NULL OR (budget_ratio >= 0 AND budget_ratio <= 1))
    )`);
  // 正式季度同一 (market,quarter,strategy,revision) 只允许一条；预览与个人运行不受正式索引误限。
  await pg.query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_selection_runs_formal
    ON analytics.stock_selection_runs(market, quarter, strategy_id, revision)
    WHERE run_kind = 'quarterly'`);
  // 幂等键：同策略、同目标日、同运行类型、同输入哈希（个人运行还须同所有者）。
  await pg.query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_selection_runs_idempotent
    ON analytics.stock_selection_runs(strategy_id, market, as_of_date, run_kind, input_hash, COALESCE(owner_username, ''))`);
  await pg.query(`CREATE INDEX IF NOT EXISTS ix_selection_runs_lookup
    ON analytics.stock_selection_runs(market, run_kind, as_of_date, published_at DESC)`);

  // 3) 候选：四项规则结果、三项名次、排除原因与证据副本。
  await pg.query(`
    CREATE TABLE IF NOT EXISTS analytics.stock_selection_candidates (
      run_id BIGINT NOT NULL REFERENCES analytics.stock_selection_runs(run_id) ON DELETE CASCADE,
      instrument_id BIGINT NOT NULL,
      company_id BIGINT,
      code TEXT NOT NULL,
      name TEXT,
      industry_code TEXT,
      industry_name TEXT,
      industry_system TEXT,
      industry_version TEXT,
      current_pb NUMERIC,
      historical_pb_max NUMERIC,
      current_pe NUMERIC,
      profit_status TEXT NOT NULL DEFAULT 'unknown',
      dividend_yield NUMERIC,
      equity_amount NUMERIC,
      equity_currency TEXT,
      equity_cny NUMERIC,
      fx_rate NUMERIC,
      fx_date DATE,
      pb_rank INTEGER,
      pe_rank INTEGER,
      dividend_rank INTEGER,
      total_score INTEGER,
      selection_order INTEGER,
      filter_status TEXT NOT NULL,
      data_quality_status TEXT NOT NULL,
      exclusion_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
      detail JSONB NOT NULL DEFAULT '{}'::jsonb,
      PRIMARY KEY (run_id, instrument_id),
      CONSTRAINT stock_selection_candidates_pb_check CHECK (current_pb IS NULL OR current_pb = current_pb)
    )`);
  await pg.query(`CREATE INDEX IF NOT EXISTS ix_selection_candidates_order
    ON analytics.stock_selection_candidates(run_id, total_score, selection_order)`);
  await pg.query(`CREATE INDEX IF NOT EXISTS ix_selection_candidates_company
    ON analytics.stock_selection_candidates(company_id, run_id)`);

  // 4) 组合席位：每市场固定 30 席，权重为市场预算与股票目标两部分的小数。
  await pg.query(`
    CREATE TABLE IF NOT EXISTS analytics.stock_selection_portfolio_members (
      run_id BIGINT NOT NULL REFERENCES analytics.stock_selection_runs(run_id) ON DELETE CASCADE,
      instrument_id BIGINT NOT NULL,
      slot_no INTEGER NOT NULL,
      industry_code TEXT,
      industry_system TEXT,
      industry_version TEXT,
      weight_in_market_budget NUMERIC NOT NULL,
      weight_in_equity_target NUMERIC NOT NULL,
      issuer_duplicate BOOLEAN NOT NULL DEFAULT false,
      detail JSONB NOT NULL DEFAULT '{}'::jsonb,
      PRIMARY KEY (run_id, instrument_id),
      CONSTRAINT stock_selection_members_slot_check CHECK (slot_no BETWEEN 1 AND 30),
      CONSTRAINT stock_selection_members_weight_market_check CHECK (weight_in_market_budget >= 0 AND weight_in_market_budget <= 1),
      CONSTRAINT stock_selection_members_weight_equity_check CHECK (weight_in_equity_target >= 0 AND weight_in_equity_target <= 1),
      CONSTRAINT stock_selection_members_slot_uk UNIQUE (run_id, slot_no)
    )`);

  // 5) 回测与收益序列：与正式季度指针完全分开。
  await pg.query(`
    CREATE TABLE IF NOT EXISTS analytics.stock_selection_backtests (
      backtest_id BIGSERIAL PRIMARY KEY,
      market TEXT NOT NULL,
      strategy_id BIGINT NOT NULL REFERENCES analytics.stock_selection_strategies(strategy_id),
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      currency TEXT NOT NULL DEFAULT 'LOCAL',
      status TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      execution_model_version TEXT NOT NULL,
      cost_version TEXT NOT NULL,
      benchmark_code TEXT,
      benchmark_return_type TEXT,
      parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
      metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
      diagnostics JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT stock_selection_backtests_market_check CHECK (market IN ('CN','HK'))
    )`);
  await pg.query(`
    CREATE TABLE IF NOT EXISTS analytics.stock_selection_backtest_periods (
      backtest_id BIGINT NOT NULL REFERENCES analytics.stock_selection_backtests(backtest_id) ON DELETE CASCADE,
      trade_date DATE NOT NULL,
      nav NUMERIC,
      cash_weight NUMERIC,
      turnover NUMERIC,
      fees NUMERIC,
      dividend_income NUMERIC,
      benchmark_nav NUMERIC,
      unpriced_count INTEGER NOT NULL DEFAULT 0,
      run_id BIGINT,
      PRIMARY KEY (backtest_id, trade_date)
    )`);

  // 6) 用户资金设置：按 users.username 身份保存，版本号做并发校验；不写进全局 platform_config。
  await pg.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS stock_selection_settings JSONB`);
  await pg.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS stock_selection_settings_revision INTEGER NOT NULL DEFAULT 0`);

  // 7) 财报可见证据：可空追加，旧行保持未知，不把期末日或迁移日填成历史公告日。
  await pg.query(`ALTER TABLE fundamental.financial_reports ADD COLUMN IF NOT EXISTS available_at TIMESTAMPTZ`);
  await pg.query(`ALTER TABLE fundamental.financial_reports ADD COLUMN IF NOT EXISTS availability_basis TEXT`);
  await pg.query(`CREATE INDEX IF NOT EXISTS ix_financial_reports_available
    ON fundamental.financial_reports(company_id, period_end DESC, available_at DESC)`);
}

module.exports = { migration184StockSelection };
