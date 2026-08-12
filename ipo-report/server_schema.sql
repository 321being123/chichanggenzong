-- 服务器 Schema 初始化：创建打新新股产物表（可转债由统一数据层迁移负责）
-- 服务器执行: psql ... -f server_schema.sql
-- 与 server_bond_sync.sql / backfill_lottery_rate.sql 配合：先建表，再 upsert/UPDATE

CREATE TABLE IF NOT EXISTS ipo_history (
  security_code          TEXT PRIMARY KEY,
  security_name          TEXT,
  market_type            TEXT,
  listing_date           TEXT,
  ld_close_change        REAL,
  board_key              TEXT,
  updated_at             TEXT,
  issue_price            REAL,
  issue_pe               REAL,
  industry_pe            REAL,
  fund_raised            REAL,
  total_shares           REAL,
  online_shares          REAL,
  online_lottery_rate    REAL,
  oversubscribe_multiple REAL,
  subscribe_upper_limit  REAL,
  main_business          TEXT,
  industry               TEXT,
  circulation_mv         REAL,
  pe_ratio               REAL,
  ipo_date                TEXT
);

-- 打新日历/打新建议数据：由每日日报 ipo_daily_report.py 写入（calendar / md 的"结论"段 / sector_boost_info）
-- 服务器此前未建此表，导致线上打新日历、打新建议为空。配合 server_ipo_reports_sync.sql 全量 upsert。
CREATE TABLE IF NOT EXISTS ipo_reports (
  report_date  TEXT                     NOT NULL,
  html         TEXT,
  md           TEXT,
  summary_json JSONB,
  created_at   TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (report_date)
);
