#!/usr/bin/env python3
"""可转债强赎公告：生产遗漏核查与补录工具。

背景
----
每日强赎公告同步（`convertible_bond_redemption_announcement_sync`）注册为
「工作日 07:45 跑一次」，周末不生成计划槽位。因此：

- 周五 07:45 之后（含盘中、收盘后）发布的公告不会当天入库；
- 周六、周日不跑，一直拖到下周一 07:45；
- 最长延迟可达约 4 天，页面在这期间显示过期状态。

本工具用于事后核查与人工补录，执行的是与定时任务同一套
`syncConvertibleBondCallAnnouncements` 逻辑，幂等写入。

用法
----
只读核查（不写库、不备份）：

    .\\venv\\Scripts\\python.exe deploy\\backfill_bond_call_announcements.py
        --audit --from 2026-08-28 --to 2026-08-30

生产补录（自动备份 + 幂等 + 验证，必须显式确认）：

    .\\venv\\Scripts\\python.exe deploy\\backfill_bond_call_announcements.py
        --sync --from 2026-08-28 --to 2026-08-30 --confirm-production

只补某只正股（传 6 位正股代码，走全局检索后按代码过滤）：

    ... --sync --from 2026-08-20 --to 2026-08-30 --stock 300870 --confirm-production

已知坑（改本脚本前务必保留）
--------------------------
1. 备份必须用重定向 `>` 而非 `pg_dump -f`：postgres 用户对 /var/backups 无写权限，
   `-f` 会报 Permission denied；重定向由 root shell 写文件。
2. 核查时 DB 对比窗口必须比搜索窗口放宽（这里向前放宽 10 天）：巨潮搜索窗口会返回
   起始日之前的公告，窗口不一致会把已入库公告误判为遗漏。
3. 无对应可转债的公司公告（如「现金管理提前赎回」）属关键词误命中，
   `pickInstrument` 会返回 null 自动跳过，不是漏数，无需手工处理。
"""

import argparse
import sys
from pathlib import Path

for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(errors="backslashreplace")

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "deploy"))

from deploy_password import HOST, USER, load_key, run_sudo  # noqa: E402
import paramiko  # noqa: E402

DB = "portfolio"
REMOTE_JS = "/opt/portfolio/_tmp_bond_call_backfill.js"

# 与 syncConvertibleBondCallAnnouncements 的默认关键词保持一致
KEYWORDS_JS = ("['强赎','提前赎回','不提前赎回','暂不赎回','不行使赎回','不实施赎回',"
               "'赎回实施','实施赎回','赎回结果','到期兑付','即将到期','停止交易','最后交易日']")

AUDIT_JS = r"""
require('dotenv').config();
const { searchAnnouncements } = require('./server/services/cninfoAnnouncement');
const { pool } = require('./server/db/connection');
const KEYWORDS = __KEYWORDS__;
(async () => {
  try {
    const items = await searchAnnouncements({
      fromDate: '__FROM__', toDate: '__TO__', keywords: KEYWORDS, exchanges: ['sse', 'szse'],
    });
    const uniq = new Map();
    for (const x of items) if (x.sourceKey) uniq.set(x.sourceKey, x);
    console.log('CNINFO_TOTAL ' + uniq.size);
    // 巨潮搜索窗口会返回起始日之前的公告，DB 对比窗口必须放宽，否则已入库公告会被误判为遗漏
    const { rows } = await pool.query(
      "SELECT source_key FROM event.convertible_bond_call_events " +
      "WHERE announced_at >= (DATE '__FROM__' - INTERVAL '10 days')"
    );
    const have = new Set(rows.map(r => r.source_key));
    console.log('DB_EVENTS_IN_WINDOW ' + rows.length);
    const missing = [...uniq.values()].filter(x => !have.has(x.sourceKey));
    console.log('MISSING ' + missing.length);
    for (const x of missing) {
      console.log('  [' + x.announcedAt + '] ' + x.stockCode + ' ' + x.stockName + ' | ' + x.title);
    }
  } catch (error) {
    console.error('AUDIT_FAILED ' + String(error.message || error));
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
})();
"""

SYNC_JS = r"""
require('dotenv').config();
const { syncConvertibleBondCallAnnouncements } = require('./server/services/convertibleBondRedemptionSync');
(async () => {
  try {
    const result = await syncConvertibleBondCallAnnouncements({
      fromDate: '__FROM__', toDate: '__TO__', stock: '__STOCK__', exchanges: ['sse', 'szse'],
    });
    console.log('SYNC_RESULT ' + JSON.stringify(result));
  } catch (error) {
    console.error('SYNC_FAILED ' + String(error.message || error));
    process.exitCode = 1;
  }
})();
"""

VERIFY_SQL = """
SELECT e.announced_at, e.event_type, split_part(i.canonical_code,'.',1) AS bond_code, i.name AS bond_name,
       COALESCE(e.no_call_until::text,'-') AS no_call_until,
       COALESCE(e.last_trade_date::text,'-') AS last_trade,
       COALESCE(e.last_conversion_date::text,'-') AS last_conv,
       e.parse_status, left(e.title,46) AS title
  FROM event.convertible_bond_call_events e
  JOIN core.instruments i ON i.instrument_id = e.instrument_id
 WHERE e.announced_at >= DATE '__FROM__'
 ORDER BY e.announced_at DESC, i.canonical_code;
"""


def render(template: str, from_date: str, to_date: str, stock: str = "") -> str:
    return (template
            .replace("__KEYWORDS__", KEYWORDS_JS)
            .replace("__FROM__", from_date)
            .replace("__TO__", to_date)
            .replace("__STOCK__", stock))


def run_remote_js(client, script: str, timeout: int = 1800) -> None:
    """写入临时脚本 → 以 portfolio-app 执行 → 无论成败都清理。"""
    write_cmd = (f"cat > {REMOTE_JS} <<'BF_EOF'\n{script}\nBF_EOF\n"
                 f"chown portfolio-app:portfolio-app {REMOTE_JS} && chmod 644 {REMOTE_JS}")
    run_sudo(client, write_cmd)
    try:
        run_sudo(client, f"cd /opt/portfolio && sudo -u portfolio-app /usr/bin/node {REMOTE_JS}", timeout=timeout)
    finally:
        run_sudo(client, f"rm -f {REMOTE_JS} && echo 'cleanup done'")


def psql(client, sql: str) -> None:
    run_sudo(client, "sudo -u postgres psql -d portfolio -tA -F'|' <<'SQL_EOF'\n" + sql + "\nSQL_EOF")


def main() -> None:
    parser = argparse.ArgumentParser(description="可转债强赎公告生产核查与补录")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--audit", action="store_true", help="只读核查：巨潮能搜到但未入库的公告")
    mode.add_argument("--sync", action="store_true", help="生产补录：备份后执行官方公告同步")
    parser.add_argument("--from", dest="from_date", required=True, help="起始日期 YYYY-MM-DD")
    parser.add_argument("--to", dest="to_date", required=True, help="结束日期 YYYY-MM-DD")
    parser.add_argument("--stock", default="", help="定点补录的正股 6 位代码，留空为全市场")
    parser.add_argument("--no-backup", action="store_true", help="跳过备份（仅限已确认有可用备份时）")
    parser.add_argument("--confirm-production", action="store_true", help="确认在生产执行写操作")
    args = parser.parse_args()

    if args.sync and not args.confirm_production:
        raise SystemExit("拒绝执行：--sync 必须显式传入 --confirm-production，并取得用户生产数据同步授权。")

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(hostname=HOST, username=USER, pkey=load_key(), timeout=30)
    try:
        if args.audit:
            print(f"===== 只读核查 {args.from_date} ~ {args.to_date} =====")
            run_remote_js(client, render(AUDIT_JS, args.from_date, args.to_date))
            return

        print(f"===== 生产补录 {args.from_date} ~ {args.to_date}"
              f"{'（正股 ' + args.stock + '）' if args.stock else '（全市场）'} =====")
        if args.no_backup:
            print("-- 已指定 --no-backup，跳过备份 --")
        else:
            print("===== 备份数据库 =====")
            backup = "/var/backups/portfolio_before_bond_call_backfill_$(date +%Y%m%d_%H%M%S).dump"
            run_sudo(client, f"sudo -u postgres pg_dump -Fc -d {DB} > {backup} && sudo ls -lt /var/backups/ | head -3",
                     timeout=1800)

        print("===== 执行同步 =====")
        run_remote_js(client, render(SYNC_JS, args.from_date, args.to_date, args.stock))

        print("===== 补录后验证 =====")
        psql(client, render(VERIFY_SQL, args.from_date, args.to_date))
        print("-- 强赎监控页统计 --")
        run_sudo(client, "curl -s 'http://127.0.0.1:3000/api/bond-redemption?limit=1000' | head -c 320")
        print("\n-- 服务状态 --")
        run_sudo(client, "systemctl is-active portfolio-server.service portfolio-worker.service")
    finally:
        client.close()


if __name__ == "__main__":
    main()
