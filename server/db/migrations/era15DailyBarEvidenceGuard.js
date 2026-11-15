// 日线证据随价格失效（2026-11-15 第八轮验收 P1）
//
// 201 给 market.daily_bars 加了口径/终盘/质量三列证据，但真正的风险在"后来被改写"：
// 可转债同步、选股、港股覆盖、投影等写入路径都只 SET close=...，不碰证据列。
// 于是"昨天收盘核验通过的终盘行"被后来一条实时报价（或同表其它来源）覆盖 close 之后，
// 新的价格会继承旧的 terminal/passed 证据，收盘核验就会把一个没人核验过的价格当成终盘收盘价。
//
// 修法：用数据库触发器在价格真正变化时把证据降级为 unknown，并把旧证据留档。
// 放在触发器里而不是逐个改写入 SQL，是因为写入方有 6 处且以后还会增加，
// 任何一处漏改都会重新打开这个漏洞；价格和证据必须在同一条 UPDATE 里原子完成。
// 唯一例外：同一条语句显式带来新的证据（收盘任务自己核验后回写），此时保留它。
async function migration202DailyBarEvidenceGuard(pool) {
  await pool.query(`
    CREATE OR REPLACE FUNCTION market.invalidate_daily_bar_evidence() RETURNS trigger AS $$
    BEGIN
      IF NEW.close IS DISTINCT FROM OLD.close
         AND NEW.bar_evidence IS NOT DISTINCT FROM OLD.bar_evidence THEN
        NEW.bar_status := 'unknown';
        NEW.price_adjust := 'unknown';
        NEW.quality_status := 'unknown';
        NEW.bar_evidence := COALESCE(OLD.bar_evidence, '{}'::jsonb) || jsonb_build_object(
          'evidence_invalidated_by', 'price_changed',
          'invalidated_at', to_jsonb(now()),
          'previous_close', OLD.close,
          'new_close', NEW.close,
          'previous_bar_status', OLD.bar_status,
          'previous_price_adjust', OLD.price_adjust,
          'previous_quality_status', OLD.quality_status
        );
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql;
  `);
  await pool.query('DROP TRIGGER IF EXISTS trg_daily_bars_evidence_invalidation ON market.daily_bars');
  await pool.query(`
    CREATE TRIGGER trg_daily_bars_evidence_invalidation
      BEFORE UPDATE ON market.daily_bars
      FOR EACH ROW EXECUTE FUNCTION market.invalidate_daily_bar_evidence();
  `);
}

module.exports = { migration202DailyBarEvidenceGuard };
