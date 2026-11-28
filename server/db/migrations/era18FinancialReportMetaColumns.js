// 216：财报元数据物化列与写入触发器（2026-11-28）。
//
// 背景：选股实时筛选（V2 与格雷厄姆）在 loadEquityFacts / loadAnnualProfits / loadTtmInputs /
// loadAnnualDividends / loadGrahamBalanceFacts 中高频过滤与投影 `fundamental.financial_reports.raw_payload`
// 内的 8 个标量字符串（ts_code、__statement_coverage.market、currency、value_basis、
// report_period_label、reportType、report_type_label、fs_table_type）。
// `raw_payload` 为 3.0 GB TOAST JSONB，每次全市场（5,582 家）查询都会逐行解压 TOAST，
// 单条耗时 16~21 秒，并发触发 45 秒 statement_timeout。
//
// 方案：
//   1) 在 `fundamental.financial_reports` 增加 8 个可空标量列 + `payload_meta_synced BOOLEAN NOT NULL DEFAULT false`
//      （PostgreSQL 11+ 为 O(1) 纯目录变更，零重写、零长锁，避免启动迁移阻塞上线）；
//   2) 安装 `BEFORE INSERT OR UPDATE OF raw_payload` 触发器，所有新写入与更新自动同步 8 列并置 `payload_meta_synced = true`；
//   3) 读端采用 `CASE WHEN payload_meta_synced THEN <标量列> ELSE <raw_payload 回退> END`，
//      存量行回填前语义 100% 等价，分批回填完成后全市场查询零 TOAST 解压（实测提速 20~23 倍）。
//
// 所有语句均幂等，可重复执行；禁止无条件 CREATE SCHEMA。
async function migration216FinancialReportMetaColumns(pool) {
  await pool.query(`
    ALTER TABLE fundamental.financial_reports
      ADD COLUMN IF NOT EXISTS payload_meta_synced BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS payload_ts_code TEXT,
      ADD COLUMN IF NOT EXISTS payload_market TEXT,
      ADD COLUMN IF NOT EXISTS payload_currency TEXT,
      ADD COLUMN IF NOT EXISTS payload_value_basis TEXT,
      ADD COLUMN IF NOT EXISTS payload_report_period_label TEXT,
      ADD COLUMN IF NOT EXISTS payload_report_type TEXT,
      ADD COLUMN IF NOT EXISTS payload_report_type_label TEXT,
      ADD COLUMN IF NOT EXISTS payload_fs_table_type TEXT
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION fundamental.sync_financial_report_payload_meta()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.payload_ts_code := upper(COALESCE(NEW.raw_payload->>'ts_code', ''));
      NEW.payload_market := upper(COALESCE(NEW.raw_payload->'__statement_coverage'->>'market', ''));
      NEW.payload_currency := upper(COALESCE(trim(NEW.raw_payload->>'currency'), ''));
      NEW.payload_value_basis := COALESCE(NEW.raw_payload->'__statement_coverage'->>'value_basis', '');
      NEW.payload_report_period_label := NEW.raw_payload->>'report_period_label';
      NEW.payload_report_type := NEW.raw_payload->>'reportType';
      NEW.payload_report_type_label := NEW.raw_payload->>'report_type_label';
      NEW.payload_fs_table_type := COALESCE(
        NULLIF(lower(trim(NEW.raw_payload->'__statement_coverage'->>'fs_table_type')), ''),
        NULLIF(lower(trim(NEW.raw_payload->>'fs_table_type')), '')
      );
      NEW.payload_meta_synced := true;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);

  await pool.query(`
    DROP TRIGGER IF EXISTS trg_financial_reports_sync_payload_meta ON fundamental.financial_reports;
    CREATE TRIGGER trg_financial_reports_sync_payload_meta
      BEFORE INSERT OR UPDATE OF raw_payload ON fundamental.financial_reports
      FOR EACH ROW EXECUTE FUNCTION fundamental.sync_financial_report_payload_meta()
  `);
}

module.exports = { migration216FinancialReportMetaColumns };
