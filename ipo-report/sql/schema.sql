-- 打新日历模块 PostgreSQL 表结构
-- 替代原 SQLite: ipo_history.db / sector_heat.db
-- 日期统一用 TEXT (YYYY-MM-DD) 与原 SQLite 保持一致，降低迁移转换风险
-- 执行: psql 连接后 \i sql/schema.sql  （迁移脚本 migrate.py 也会自动建表）

CREATE TABLE IF NOT EXISTS ipo_history (
  security_code         TEXT PRIMARY KEY,
  security_name         TEXT,
  market_type           TEXT,
  listing_date          TEXT,
  ld_close_change       REAL,
  board_key             TEXT,
  updated_at            TEXT,
  issue_price           REAL,
  issue_pe              REAL,
  industry_pe           REAL,
  fund_raised           REAL,
  total_shares          REAL,
  online_shares         REAL,
  online_lottery_rate   REAL,
  oversubscribe_multiple REAL,
  subscribe_upper_limit REAL,
  main_business         TEXT,
  industry              TEXT,
  circulation_mv        REAL,
  pe_ratio              REAL
);

CREATE TABLE IF NOT EXISTS bond_history (
  security_code   TEXT PRIMARY KEY,
  security_name   TEXT,
  listing_date    TEXT,
  first_day_return REAL,
  updated_at      TEXT
);

CREATE TABLE IF NOT EXISTS predictions (
  id           SERIAL PRIMARY KEY,
  type         TEXT NOT NULL,
  code         TEXT NOT NULL,
  name         TEXT NOT NULL,
  listing_date TEXT NOT NULL,
  pred_date    TEXT NOT NULL,
  pred_return  REAL,
  pred_price   REAL,
  pred_advice  TEXT,
  actual_return REAL,
  actual_price  REAL,
  actual_date   TEXT,
  status       TEXT DEFAULT 'pending',
  updated_at   TEXT,
  UNIQUE (type, code, pred_date)
);

CREATE TABLE IF NOT EXISTS sector_heat (
  sector_key   TEXT PRIMARY KEY,
  avg_gain_60d REAL,
  stock_count  INTEGER,
  boost        REAL,
  updated_at   TEXT
);

CREATE TABLE IF NOT EXISTS stock_gain (
  stock_code TEXT PRIMARY KEY,
  gain_60d   REAL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS stock_sector (
  stock_code TEXT,
  sector_key TEXT,
  stock_name TEXT,
  PRIMARY KEY (stock_code, sector_key)
);

-- 报告产物（新增，替代本地 HTML/MD 文件）
CREATE TABLE IF NOT EXISTS ipo_reports (
  report_date  TEXT PRIMARY KEY,   -- YYYYMMDD
  html         TEXT,
  md           TEXT,
  summary_json JSONB,
  created_at   TIMESTAMPTZ DEFAULT now()
);
