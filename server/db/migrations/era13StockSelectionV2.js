// 迁移 189：投资策略选股中心 V2（2026-11-06 方案第 27.7 节）。
// 纯增量：只给现有 runs/candidates/members 扩展列，并新增最小发布元数据与不可变发布事件。
// 不新建 PB/行情/财务事实表；V1 仍在写入的列保持可空或有兼容 DEFAULT，旧 INSERT 省略新列不会失败。
'use strict';

async function migration189StockSelectionV2(pg) {
  // 1) runs：周期（day/week/quarter）、主体、影子、发布与计算时刻。
  await pg.query(`
    ALTER TABLE analytics.stock_selection_runs
      ADD COLUMN IF NOT EXISTS period_type TEXT,
      ADD COLUMN IF NOT EXISTS period_key TEXT,
      ADD COLUMN IF NOT EXISTS period_start DATE,
      ADD COLUMN IF NOT EXISTS period_end DATE,
      ADD COLUMN IF NOT EXISTS source_daily_run_id BIGINT,
      ADD COLUMN IF NOT EXISTS settings_revision INTEGER,
      ADD COLUMN IF NOT EXISTS settings_hash TEXT,
      ADD COLUMN IF NOT EXISTS owner_subject_id UUID,
      ADD COLUMN IF NOT EXISTS revision_reason TEXT,
      ADD COLUMN IF NOT EXISTS computed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS is_shadow BOOLEAN NOT NULL DEFAULT false`);

  // 2) run_kind 允许 daily/weekly：原 CHECK 只列了 quarterly/preview/personal/backtest。
  await pg.query(`ALTER TABLE analytics.stock_selection_runs DROP CONSTRAINT IF EXISTS stock_selection_runs_kind_check`);
  await pg.query(`
    ALTER TABLE analytics.stock_selection_runs
      ADD CONSTRAINT stock_selection_runs_kind_check
      CHECK (run_kind IN ('quarterly','daily','weekly','preview','personal','backtest'))`);

  await pg.query(`ALTER TABLE analytics.stock_selection_runs DROP CONSTRAINT IF EXISTS stock_selection_runs_period_type_check`);
  await pg.query(`
    ALTER TABLE analytics.stock_selection_runs
      ADD CONSTRAINT stock_selection_runs_period_type_check
      CHECK (period_type IS NULL OR period_type IN ('day','week','quarter'))`);

  // 3) 周期键与日期必须自洽：period_key 前缀对应 period_type，period_start<=T<=period_end。
  //    用可空守卫，让 V1 旧行（period_type 尚未回填时）不因新 CHECK 失败。
  await pg.query(`ALTER TABLE analytics.stock_selection_runs DROP CONSTRAINT IF EXISTS stock_selection_runs_period_key_check`);
  await pg.query(`
    ALTER TABLE analytics.stock_selection_runs
      ADD CONSTRAINT stock_selection_runs_period_key_check
      CHECK (period_type IS NULL OR period_key IS NULL OR (
        (period_type = 'day' AND period_key ~ '^D:\\d{4}-\\d{2}-\\d{2}$') OR
        (period_type = 'week' AND period_key ~ '^W:\\d{4}-\\d{2}-\\d{2}$') OR
        (period_type = 'quarter' AND period_key ~ '^Q:\\d{4}Q[1-4]$')
      ))`);

  // 4) 回填 V1 季度行的周期信息（幂等）。
  await pg.query(`
    UPDATE analytics.stock_selection_runs
       SET period_type = 'quarter',
           period_key = 'Q:' || quarter,
           period_start = date_trunc('quarter', as_of_date)::date,
           period_end = as_of_date,
           computed_at = COALESCE(computed_at, created_at)
     WHERE quarter IS NOT NULL AND (period_type IS NULL OR period_key IS NULL)`);
  // 没有季度（预览/个人）的批次也补 period_type，便于按周期筛选；period_key 保持为空。
  await pg.query(`
    UPDATE analytics.stock_selection_runs
       SET period_type = CASE WHEN run_kind = 'quarterly' THEN 'quarter' ELSE 'day' END
     WHERE period_type IS NULL`);

  // 5) 幂等索引分域：旧索引不含 is_shadow/period_type/subject，
  //    影子与非影子、不同主体（同名重建账号）的同输入会互相撞，这里重建为完整身份索引。
  //    旧索引名不带 schema：search_path 不含 analytics 时 `DROP INDEX` 会静默跳过，
  //    必须按 pg_indexes 实际所在 schema 逐个删除（AC-06）。
  await pg.query(`
    DO $$
    DECLARE target RECORD;
    BEGIN
      FOR target IN
        SELECT schemaname, indexname FROM pg_indexes WHERE indexname = 'ux_selection_runs_idempotent'
      LOOP
        EXECUTE format('DROP INDEX IF EXISTS %I.%I', target.schemaname, target.indexname);
      END LOOP;
    END $$`);
  await pg.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_selection_runs_identity_v2
      ON analytics.stock_selection_runs (
        strategy_id, market, run_kind,
        COALESCE(period_type, 'quarter'),
        COALESCE(period_key, ''),
        is_shadow,
        COALESCE(owner_username, ''),
        COALESCE(owner_subject_id::text, ''),
        input_hash)`);

  // 6) 正式发布选择用索引：先按市场/策略/周期，再按日期稳定排序（不按 period_key 字典序）。
  await pg.query(`
    CREATE INDEX IF NOT EXISTS ix_selection_runs_period_lookup
      ON analytics.stock_selection_runs (market, strategy_id, period_type, published_at DESC, period_start DESC, as_of_date DESC, revision DESC)`);
  await pg.query(`
    CREATE INDEX IF NOT EXISTS ix_selection_runs_shadow
      ON analytics.stock_selection_runs (market, is_shadow, as_of_date DESC) WHERE is_shadow = true`);

  // 7) candidates：V2 判定与极值证据列（可空，V1 旧行不受影响）。
  await pg.query(`
    ALTER TABLE analytics.stock_selection_candidates
      ADD COLUMN IF NOT EXISTS historical_pb_min NUMERIC,
      ADD COLUMN IF NOT EXISTS pb_positive_extrema_ratio NUMERIC,
      ADD COLUMN IF NOT EXISTS pb_pe_product NUMERIC,
      ADD COLUMN IF NOT EXISTS valuation_status TEXT,
      ADD COLUMN IF NOT EXISTS valuation_pass_reason TEXT,
      ADD COLUMN IF NOT EXISTS ttm_profit_status TEXT,
      ADD COLUMN IF NOT EXISTS rank_ready BOOLEAN,
      ADD COLUMN IF NOT EXISTS rank_block_reasons JSONB,
      ADD COLUMN IF NOT EXISTS pb_covered_days INTEGER,
      ADD COLUMN IF NOT EXISTS pb_expected_days INTEGER,
      ADD COLUMN IF NOT EXISTS pb_gap_days INTEGER,
      ADD COLUMN IF NOT EXISTS pb_history_years NUMERIC`);
  await pg.query(`
    CREATE INDEX IF NOT EXISTS ix_selection_candidates_pb_product
      ON analytics.stock_selection_candidates (run_id, pb_pe_product) WHERE pb_pe_product IS NOT NULL`);

  // 8) members：实际股票子组合权重分母（不足 30 席时与 1/30 不同，全现金为 NULL）。
  await pg.query(`ALTER TABLE analytics.stock_selection_portfolio_members
    ADD COLUMN IF NOT EXISTS weight_in_invested_equity NUMERIC`);
  await pg.query(`ALTER TABLE analytics.stock_selection_portfolio_members
    DROP CONSTRAINT IF EXISTS stock_selection_members_weight_invested_check`);
  await pg.query(`
    ALTER TABLE analytics.stock_selection_portfolio_members
      ADD CONSTRAINT stock_selection_members_weight_invested_check
      CHECK (weight_in_invested_equity IS NULL OR (weight_in_invested_equity >= 0 AND weight_in_invested_equity <= 1))`);

  // 9) 当前发布指针：一个渠道一条，指向某个 run；成员仍只在 candidates/members 存一份。
  await pg.query(`
    CREATE TABLE IF NOT EXISTS analytics.stock_selection_publications (
      publication_id BIGSERIAL PRIMARY KEY,
      market TEXT NOT NULL,
      strategy_id BIGINT NOT NULL REFERENCES analytics.stock_selection_strategies(strategy_id),
      period_type TEXT NOT NULL,
      period_key TEXT NOT NULL,
      period_start DATE,
      period_end DATE,
      run_id BIGINT NOT NULL REFERENCES analytics.stock_selection_runs(run_id),
      pointer_revision INTEGER NOT NULL DEFAULT 1,
      activated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      visible_at TIMESTAMPTZ,
      actor TEXT,
      reason TEXT,
      CONSTRAINT stock_selection_publications_market_check CHECK (market IN ('CN','HK')),
      CONSTRAINT stock_selection_publications_period_type_check CHECK (period_type IN ('day','week','quarter')),
      CONSTRAINT stock_selection_publications_period_key_check CHECK (
        (period_type = 'day' AND period_key ~ '^D:\\d{4}-\\d{2}-\\d{2}$') OR
        (period_type = 'week' AND period_key ~ '^W:\\d{4}-\\d{2}-\\d{2}$') OR
        (period_type = 'quarter' AND period_key ~ '^Q:\\d{4}Q[1-4]$')
      ),
      CONSTRAINT stock_selection_publications_slot_uk UNIQUE (market, strategy_id, period_type, period_key)
    )`);

  // 10) 不可变发布事件：发布/修订/回滚/激活/停用，追加写，不改旧行。
  await pg.query(`
    CREATE TABLE IF NOT EXISTS analytics.stock_selection_publication_events (
      event_id BIGSERIAL PRIMARY KEY,
      market TEXT NOT NULL,
      strategy_id BIGINT,
      period_type TEXT NOT NULL,
      period_key TEXT NOT NULL,
      action TEXT NOT NULL,
      from_run_id BIGINT,
      to_run_id BIGINT,
      from_strategy_id BIGINT,
      to_strategy_id BIGINT,
      pointer_revision INTEGER,
      actor TEXT,
      subject_id UUID,
      slot_id TEXT,
      execution_token TEXT,
      input_hash TEXT,
      reason TEXT,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      visible_at TIMESTAMPTZ,
      CONSTRAINT stock_selection_publication_events_action_check
        CHECK (action IN ('publish','correct','rollback','activate','deactivate'))
    )`);
  await pg.query(`
    CREATE INDEX IF NOT EXISTS ix_selection_publication_events_channel
      ON analytics.stock_selection_publication_events
        (market, period_type, period_key, event_id DESC)`);
}

/**
 * 迁移 190：身份索引收敛（承接 AC-06 的存量环境）。
 * 189 的 `DROP INDEX` 未带 schema，在 search_path 不含 analytics 的库会静默跳过，
 * 已执行旧 189 的环境因此同时留着旧 `ux_selection_runs_idempotent` 与不含主体维度的新索引。
 * 本迁移按 pg_indexes 实际 schema 收敛，可重复执行；生产首装由 189 直接建对，这里会跳过。
 */
async function migration190StockSelectionIdentityIndex(pg) {
  await pg.query(`
    DO $do$
    DECLARE target RECORD;
    BEGIN
      FOR target IN
        SELECT schemaname, indexname FROM pg_indexes WHERE indexname = 'ux_selection_runs_idempotent'
      LOOP
        EXECUTE format('DROP INDEX IF EXISTS %I.%I', target.schemaname, target.indexname);
      END LOOP;
    END $do$`);

  await pg.query(`
    DO $do$
    DECLARE def TEXT;
    BEGIN
      SELECT indexdef INTO def FROM pg_indexes
       WHERE schemaname = 'analytics' AND indexname = 'ux_selection_runs_identity_v2';
      IF def IS NULL OR position('owner_subject_id' in def) = 0 THEN
        EXECUTE $idx$DROP INDEX IF EXISTS analytics.ux_selection_runs_identity_v2$idx$;
        EXECUTE $idx$CREATE UNIQUE INDEX ux_selection_runs_identity_v2
          ON analytics.stock_selection_runs (
            strategy_id, market, run_kind,
            COALESCE(period_type, 'quarter'),
            COALESCE(period_key, ''),
            is_shadow,
            COALESCE(owner_username, ''),
            COALESCE(owner_subject_id::text, ''),
            input_hash)$idx$;
      END IF;
    END $do$`);
}

/**
 * 迁移 191：历史股票池不可变 artifact（方案 27.11 / DEV-02）。
 * 同一 (市场, 目标日) 的证券集合首次计算后固化，后续重算/回测复用同一集合与哈希；
 * 今日抓到的名单不能回填历史，也不把"重建"冒充当时真实可见（replay_type 明确区分）。
 */
async function migration191StockSelectionUniverseArtifact(pg) {
  await pg.query(`
    CREATE TABLE IF NOT EXISTS analytics.stock_selection_universe_artifacts (
      artifact_id BIGSERIAL PRIMARY KEY,
      market TEXT NOT NULL,
      target_date DATE NOT NULL,
      content_hash TEXT NOT NULL,
      member_count INTEGER NOT NULL,
      instrument_ids BIGINT[] NOT NULL,
      members JSONB NOT NULL DEFAULT '[]'::jsonb,
      -- 被排除的成员与原因（无任何行情/近 60 日无行情），与"是否在池"分开记录（C0）。
      excluded JSONB NOT NULL DEFAULT '[]'::jsonb,
      -- 冻结时的信息可见截止与来源版本：同一目标日的名单必须能证明用的是同一批事实。
      knowledge_cutoff TEXT,
      source_versions JSONB NOT NULL DEFAULT '{}'::jsonb,
      basis JSONB NOT NULL DEFAULT '{}'::jsonb,
      replay_type TEXT NOT NULL DEFAULT 'pit_research_replay',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT stock_selection_universe_artifacts_market_check CHECK (market IN ('CN','HK')),
      CONSTRAINT stock_selection_universe_artifacts_replay_check
        CHECK (replay_type IN ('real_time_observation','pit_research_replay')),
      CONSTRAINT stock_selection_universe_artifacts_uk UNIQUE (market, target_date, content_hash)
    )`);
  await pg.query(`
    CREATE INDEX IF NOT EXISTS ix_selection_universe_artifacts_lookup
      ON analytics.stock_selection_universe_artifacts (market, target_date, created_at DESC, artifact_id DESC)`);
}

/**
 * 迁移 192：191 的前向补列（方案 27.7/27.12 升级兼容，C03）。
 * 已执行旧 191 的开发/验收库不会因为 CREATE TABLE IF NOT EXISTS 被修改而自动获得新列，
 * 必须用独立的前向 ALTER 补齐；保留原 artifact 数据，不重建表。
 */
async function migration192StockSelectionUniverseArtifactColumns(pg) {
  await pg.query(`
    ALTER TABLE analytics.stock_selection_universe_artifacts
      ADD COLUMN IF NOT EXISTS excluded JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS knowledge_cutoff TEXT,
      ADD COLUMN IF NOT EXISTS source_versions JSONB NOT NULL DEFAULT '{}'::jsonb`);
}

module.exports = {
  migration189StockSelectionV2,
  migration190StockSelectionIdentityIndex,
  migration191StockSelectionUniverseArtifact,
  migration192StockSelectionUniverseArtifactColumns,
};
