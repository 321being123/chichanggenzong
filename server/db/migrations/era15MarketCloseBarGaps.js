// 共享日线缺口（2026-11-15 第八轮第三次复核 P1）
//
// 收盘任务的账户日价与共享日线（market.daily_bars 证据行）是两个独立事实：
// 首次运行可能账户日价已确认、共享日线写库失败。若缺口只活在内存，重跑时
// recordCloseOne 看到"该证券当日已确认"就直接跳过，共享日线永远补不上，
// 任务还会以 sharedBarPublication=complete / barPartitionStatus=not_needed 报成功。
//
// 因此缺口必须落库：一张按「任务标签 + 日线代码 + 交易日」唯一的缺口表，
// 失败即登记、成功即销账；重跑先处理未销账缺口，全部销账且分区发布成功才算完成。
async function migration203MarketCloseBarGaps(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ops.market_close_bar_gaps (
      gap_id BIGSERIAL PRIMARY KEY,
      job_label TEXT NOT NULL,
      market TEXT NOT NULL CHECK (market IN ('CN','HK')),
      code TEXT NOT NULL,
      ts_code TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'stock',
      trade_date DATE NOT NULL,
      price NUMERIC(24,8),
      reason TEXT NOT NULL DEFAULT '',
      detail JSONB NOT NULL DEFAULT '{}'::jsonb,
      attempts INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      resolved_at TIMESTAMPTZ,
      UNIQUE(job_label, ts_code, trade_date)
    );
    CREATE INDEX IF NOT EXISTS idx_market_close_bar_gaps_open
      ON ops.market_close_bar_gaps(job_label, trade_date) WHERE resolved_at IS NULL;
  `);
}

module.exports = { migration203MarketCloseBarGaps };
