// 共享日线（market.daily_bars）此前只有来源，没有「口径 / 是否终盘 / 质量」三类证据。
// 后果：可转债同步会把腾讯实时报价写进同一张表，收盘核验只按来源名就把它当成
// 「已确认的不复权收盘价」，把盘中价写成收盘价。
// 这里补上三列证据列（默认 unknown = 不构成证据，旧行一律不被采信）并保留证据 JSONB。
async function migration201DailyBarEvidence(pool) {
  await pool.query(`
    ALTER TABLE market.daily_bars ADD COLUMN IF NOT EXISTS price_adjust TEXT NOT NULL DEFAULT 'unknown';
    ALTER TABLE market.daily_bars ADD COLUMN IF NOT EXISTS bar_status TEXT NOT NULL DEFAULT 'unknown';
    ALTER TABLE market.daily_bars ADD COLUMN IF NOT EXISTS quality_status TEXT NOT NULL DEFAULT 'unknown';
    ALTER TABLE market.daily_bars ADD COLUMN IF NOT EXISTS bar_evidence JSONB NOT NULL DEFAULT '{}'::jsonb;
  `);
  // 约束单独加，重复执行不报错（PG 不支持 ADD CONSTRAINT IF NOT EXISTS）。
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ck_daily_bars_price_adjust') THEN
        ALTER TABLE market.daily_bars ADD CONSTRAINT ck_daily_bars_price_adjust
          CHECK (price_adjust IN ('none','qfq','hfq','unknown'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ck_daily_bars_bar_status') THEN
        ALTER TABLE market.daily_bars ADD CONSTRAINT ck_daily_bars_bar_status
          CHECK (bar_status IN ('terminal','intraday','unknown'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ck_daily_bars_quality_status') THEN
        ALTER TABLE market.daily_bars ADD CONSTRAINT ck_daily_bars_quality_status
          CHECK (quality_status IN ('passed','rejected','unknown'));
      END IF;
    END $$;
  `);
}

module.exports = { migration201DailyBarEvidence };
