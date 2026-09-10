#!/usr/bin/env python3
"""修复招商证券历史港股代码并补齐净值快照。

该脚本只允许显式确认后执行生产写入：先备份，再在同一事务内修正历史交易/持仓快照，
最后调用已发布的 nav_snapshot 任务，使用 2026-08-24 人工校准快照作为后续持仓锚点。
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "deploy"))

import paramiko  # noqa: E402
from deploy_password import HOST, USER, load_key, run_sudo  # noqa: E402


ACCOUNT_NAME = "招商证券账户"

REPAIR_SQL = r"""
BEGIN;

DO $$
DECLARE
  trade_count integer;
  manual_qty numeric;
  bad_count integer;
  good_count integer;
  fx_count integer;
BEGIN
  SELECT COUNT(*) INTO trade_count
   FROM trades
   WHERE account_name = '招商证券账户'
     AND code = '000152'
     AND COALESCE(trade_date, left(date, 10)) = '2026-08-12'
     AND name = '深圳国际';
  IF trade_count <> 1 THEN
    RAISE EXCEPTION '招商证券目标历史交易数量异常: %', trade_count;
  END IF;

  SELECT COUNT(*) INTO fx_count
    FROM market.fx_rates
   WHERE base_currency = 'HKD' AND quote_currency = 'CNY'
     AND rate_date = DATE '2026-08-12' AND rate > 0;
  IF fx_count = 0 THEN
    RAISE EXCEPTION '招商证券目标交易缺少 2026-08-12 港币汇率';
  END IF;

  SELECT COALESCE(SUM(quantity), 0) INTO manual_qty
    FROM nav_position_snapshots
   WHERE account_name = '招商证券账户'
     AND snapshot_date = DATE '2026-08-24'
     AND source = 'manual_reconciliation'
     AND instrument_code = '00152';
  IF manual_qty <> 12737 THEN
    RAISE EXCEPTION '招商证券 2026-08-24 人工校准锚点异常: %', manual_qty;
  END IF;

  SELECT COUNT(*) INTO bad_count
    FROM nav_position_snapshots
   WHERE account_name = '招商证券账户' AND instrument_code = '000152';
  SELECT COUNT(*) INTO good_count
    FROM nav_position_snapshots bad
    JOIN nav_position_snapshots good
      ON good.snapshot_id = bad.snapshot_id AND good.instrument_code = '00152'
   WHERE bad.account_name = '招商证券账户' AND bad.instrument_code = '000152';
  IF bad_count <> 4 OR good_count <> bad_count THEN
    RAISE EXCEPTION '招商证券历史持仓快照重复关系异常: bad=% good=%', bad_count, good_count;
  END IF;
END $$;

-- 交易金额原本按 CNY 保存；修正为港股后按数据库中 2026-08-12 的有效汇率重算人民币结算额。
UPDATE trades t
   SET code = '00152',
       type = '股权',
       subtype = '港股',
       quote_currency = 'HKD',
       fx_rate_to_cny = fx.rate,
       amount_cny = ROUND(t.amount * fx.rate, 2),
       currency_status = 'complete'
  FROM (
    SELECT rate::numeric AS rate
      FROM market.fx_rates
     WHERE base_currency = 'HKD' AND quote_currency = 'CNY' AND rate_date = DATE '2026-08-12'
     ORDER BY fetched_at DESC, source_id DESC
     LIMIT 1
  ) fx
 WHERE t.account_name = '招商证券账户'
   AND t.code = '000152'
   AND COALESCE(t.trade_date, left(t.date, 10)) = '2026-08-12'
   AND t.name = '深圳国际';

-- 8 月 16 日导入批次中同一快照已有正确的 00152 行，合并数量后删除错误的 000152 行，避免主键冲突。
WITH bad AS (
  SELECT snapshot_id, quantity
    FROM nav_position_snapshots
   WHERE account_name = '招商证券账户' AND instrument_code = '000152'
), merged AS (
  UPDATE nav_position_snapshots good
     SET quantity = good.quantity + bad.quantity,
         quote_currency = 'HKD',
         fx_rate_to_cny = good.fx_rate_to_cny,
         market_value_cny = ROUND((good.quantity + bad.quantity) * good.price * good.fx_rate_to_cny, 4)
    FROM bad
   WHERE good.snapshot_id = bad.snapshot_id AND good.instrument_code = '00152'
  RETURNING good.snapshot_id
)
DELETE FROM nav_position_snapshots bad
 WHERE bad.account_name = '招商证券账户' AND bad.instrument_code = '000152';

-- 导入行的系统估值是审计字段，按合并后的同批快照重新计算；券商权威总资产不改。
WITH v AS (
  SELECT COALESCE(SUM(market_value_cny), 0) AS total
    FROM nav_position_snapshots
   WHERE snapshot_id = (
     SELECT import_batch_id
       FROM nav_history
      WHERE account_name = '招商证券账户'
        AND date::text = '2026-08-16'
        AND snapshot_source = 'imported'
      ORDER BY is_locked DESC, snapshot_at DESC NULLS LAST
      LIMIT 1
   ) AND source = 'system_daily_price'
)
UPDATE nav_history n
   SET system_market_value_at_snapshot = v.total
  FROM v
 WHERE n.account_name = '招商证券账户'
   AND n.date::text = '2026-08-16'
   AND n.snapshot_source = 'imported';

COMMIT;
"""

VERIFY_SQL = r"""
\pset pager off
SELECT 'TRADE', code, subtype, quote_currency, fx_rate_to_cny::numeric(12,8), amount_cny::numeric(18,2), currency_status
 FROM trades
 WHERE account_name='招商证券账户' AND name='深圳国际'
   AND COALESCE(trade_date, left(date, 10))='2026-08-12';
SELECT 'BAD_SNAPSHOT_COUNT', COUNT(*)
  FROM nav_position_snapshots
 WHERE account_name='招商证券账户' AND instrument_code='000152';
SELECT 'ANCHOR', snapshot_date::text, instrument_code, quantity::numeric(18,4), quote_currency, source
  FROM nav_position_snapshots
 WHERE account_name='招商证券账户' AND snapshot_date=DATE '2026-08-24' AND source='manual_reconciliation';
SELECT 'NAV', date::text, total_asset::numeric(18,2), snapshot_at
 FROM nav_history
 WHERE account_name='招商证券账户'
   AND date::text IN ('2026-09-07','2026-09-08','2026-09-09','2026-09-10')
 ORDER BY date;
"""


def main() -> None:
    if "--confirm-production" not in sys.argv:
        raise SystemExit("拒绝执行：必须显式传入 --confirm-production")

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(hostname=HOST, username=USER, pkey=load_key(), timeout=30)
    try:
        backup = "/var/backups/portfolio_before招商_nav_snapshot_fix_$(date +%Y%m%d_%H%M%S).dump"
        run_sudo(client, f"sudo -u postgres pg_dump -Fc -d portfolio > {backup} && sudo ls -lt /var/backups/ | head -3", timeout=1800)
        run_sudo(client, "sudo -u postgres psql -d portfolio -X -v ON_ERROR_STOP=1 <<'SQL_EOF'\n" + REPAIR_SQL + "\nSQL_EOF", timeout=180)
        print("---修正后校验---")
        run_sudo(client, "sudo -u postgres psql -d portfolio -X -v ON_ERROR_STOP=1 -A -F'|' <<'SQL_EOF'\n" + VERIFY_SQL + "\nSQL_EOF", timeout=120)
        print("---执行净值快照补齐---")
        remote = r"""
require('dotenv').config();
const { runNavSnapshotJob } = require('./server/jobs/navSnapshot');
(async () => {
  try {
    const result = await runNavSnapshotJob();
    console.log('NAV_SNAPSHOT_RESULT ' + JSON.stringify(result));
    process.exit(result && result.ok === false ? 2 : 0);
  } catch (error) {
    console.error('NAV_SNAPSHOT_FAILED ' + String(error.message || error));
    process.exitCode = 1;
  }
})();
"""
        remote_path = "/opt/portfolio/_tmp_repair招商NavSnapshot.js"
        run_sudo(client, f"cat > {remote_path} <<'JS_EOF'\n{remote}\nJS_EOF\nchown portfolio-app:portfolio-app {remote_path} && chmod 644 {remote_path}")
        try:
            run_sudo(client, f"cd /opt/portfolio && sudo -u portfolio-app /usr/bin/node {remote_path}", timeout=300)
        finally:
            run_sudo(client, f"rm -f {remote_path}")
        print("---补齐后校验---")
        run_sudo(client, "sudo -u postgres psql -d portfolio -X -v ON_ERROR_STOP=1 -A -F'|' <<'SQL_EOF'\n" + VERIFY_SQL + "\nSQL_EOF", timeout=120)
    finally:
        client.close()


if __name__ == "__main__":
    main()
