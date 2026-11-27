// 215：选股十年 PB 两步按月投影（2026-11-27）。
//
// 背景：`loadPbWindow` 每次硬扫 `market.daily_valuations` 十年约 1,220 万行，
// 生产实测单条 SQL 60.7 秒。方案《后台定时任务收敛与实时选股重构研发方案_20261127》
// 第 4.1 节确定在 `analytics` 下建三张投影表，按「每日唯一选源 → 按月汇总」两步收敛：
//   ① stock_daily_pb_picked        每日每证券唯一胜出行（多来源去重口径与原 SQL 逐字一致）
//   ② instrument_pb_monthly_summary 完整自然月的 15 项窗口证据（整月重算，禁止逐日加减）
//   ③ market_pb_trade_dates        原 marketDays 口径物化（基于 daily_valuations，不滤 pb）
//
// 只在 analytics 放投影，不改 market/fundamental 标准事实表；原始事实仍是唯一证据源。
// 所有语句必须幂等：迁移单步失败后下次启动会重跑。
async function migration215PbProjectionTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS analytics.stock_daily_pb_picked (
      instrument_id BIGINT NOT NULL REFERENCES core.instruments(instrument_id) ON DELETE CASCADE,
      trade_date DATE NOT NULL,
      market TEXT NOT NULL CHECK (market IN ('CN', 'HK')),
      source_id INTEGER NOT NULL,
      pb NUMERIC,
      picked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (instrument_id, trade_date)
    )
  `);
  // 兼容历史实验遗留表：旧库可能已有 stock_daily_pb_picked 但缺 market 列。
  // 迁移只补列并按主档回填，不删除旧行（旧行仍可被同一投影重算覆盖）。
  await pool.query(`ALTER TABLE analytics.stock_daily_pb_picked ADD COLUMN IF NOT EXISTS market TEXT`);
  await pool.query(`
    UPDATE analytics.stock_daily_pb_picked p
       SET market = i.market
      FROM core.instruments i
     WHERE i.instrument_id = p.instrument_id AND p.market IS NULL
  `);
  await pool.query(`
    DO $$
    DECLARE r RECORD;
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM analytics.stock_daily_pb_picked WHERE market IS NULL) THEN
        ALTER TABLE analytics.stock_daily_pb_picked ALTER COLUMN market SET NOT NULL;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'analytics.stock_daily_pb_picked'::regclass
           AND conname IN ('stock_daily_pb_picked_market_check', 'ck_stock_daily_pb_picked_market')
      ) THEN
        ALTER TABLE analytics.stock_daily_pb_picked
          ADD CONSTRAINT ck_stock_daily_pb_picked_market CHECK (market IN ('CN', 'HK')) NOT VALID;
      END IF;
      -- 旧实验表的外键可能没有 ON DELETE CASCADE；证券合并删除重复主档时会被挡住。
      -- 只改本表外键，NOT VALID 避免历史大表全量校验；新写入仍受约束，删除按级联清理。
      FOR r IN
        SELECT conname, pg_get_constraintdef(oid) AS def
          FROM pg_constraint
         WHERE conrelid = 'analytics.stock_daily_pb_picked'::regclass AND contype = 'f'
      LOOP
        IF r.def LIKE 'FOREIGN KEY (instrument_id)%' AND r.def NOT LIKE '%ON DELETE CASCADE%' THEN
          EXECUTE format('ALTER TABLE analytics.stock_daily_pb_picked DROP CONSTRAINT %I', r.conname);
          ALTER TABLE analytics.stock_daily_pb_picked
            ADD CONSTRAINT stock_daily_pb_picked_instrument_id_fkey
            FOREIGN KEY (instrument_id) REFERENCES core.instruments(instrument_id)
            ON DELETE CASCADE NOT VALID;
        END IF;
      END LOOP;
    END $$;
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ix_stock_daily_pb_picked_market_date
      ON analytics.stock_daily_pb_picked (market, trade_date)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS analytics.instrument_pb_monthly_summary (
      instrument_id BIGINT NOT NULL REFERENCES core.instruments(instrument_id) ON DELETE CASCADE,
      market TEXT NOT NULL CHECK (market IN ('CN', 'HK')),
      cal_year SMALLINT NOT NULL CHECK (cal_year BETWEEN 1990 AND 2100),
      cal_month SMALLINT NOT NULL CHECK (cal_month BETWEEN 1 AND 12),
      listed_days INTEGER NOT NULL DEFAULT 0,
      exempt_days INTEGER NOT NULL DEFAULT 0,
      covered_days INTEGER NOT NULL DEFAULT 0,
      observed_days INTEGER NOT NULL DEFAULT 0,
      non_positive_days INTEGER NOT NULL DEFAULT 0,
      invalid_days INTEGER NOT NULL DEFAULT 0,
      max_pb NUMERIC,
      max_positive_pb NUMERIC,
      min_positive_pb NUMERIC,
      min_pb_date DATE,
      max_pb_date DATE,
      effective_start DATE,
      series_digest BIGINT NOT NULL DEFAULT 0,
      series_rows INTEGER NOT NULL DEFAULT 0,
      picked_version BIGINT NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (instrument_id, cal_year, cal_month)
    )
  `);
  // 防御部分失败：如果表已存在但缺 market，同样补列（不覆盖已有行）。
  await pool.query(`ALTER TABLE analytics.instrument_pb_monthly_summary ADD COLUMN IF NOT EXISTS market TEXT`);
  await pool.query(`
    UPDATE analytics.instrument_pb_monthly_summary s
       SET market = i.market
      FROM core.instruments i
     WHERE i.instrument_id = s.instrument_id AND s.market IS NULL
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ix_pb_monthly_summary_market_ym
      ON analytics.instrument_pb_monthly_summary (market, cal_year, cal_month)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS analytics.market_pb_trade_dates (
      market TEXT NOT NULL CHECK (market IN ('CN', 'HK')),
      trade_date DATE NOT NULL,
      instrument_count INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (market, trade_date)
    )
  `);
}

module.exports = { migration215PbProjectionTables };
