#!/usr/bin/env python3
"""一次性刷新打新日历 + 回填 ipo_history.ipo_date（申购日期）。

背景：
- 本地 ipo_reports 的 calendar 字段是历史某次生成时写入的，可能遗漏
  新近公告的申购日（如 长鑫科技 688825 2026-07-16）。
- ipo_history 缺 ipo_date（申购日期）列，历史表无法展示申购日。

实现：
- 直接用 urllib 调 Tushare REST（不依赖 tushare 库 / fitz），
  拉 new_share / cb_issue / cb_basic，复刻 fetch_calendar + build_upcoming_calendar
  逻辑重建日历（days=90），写回最新报告的 calendar 字段。
- 用 new_share 的 ipo_date 回填 ipo_history.ipo_date（仅匹配已存在代码）。
仅本地数据更新，不触达线上、不部署。
"""
import os
import sys
import json
from datetime import datetime, timedelta

# ── 日历核心逻辑统一收口（避免与 ipo_daily_report.py 重复分叉） ──
from calendar_core import (
    _str_date,
    fetch_calendar_entries,
    build_upcoming_calendar,
)

# ── 共用样板收口（_load_env / _tushare / psql_run 统一到 _common.py） ──
from _common import _load_env, _tushare, psql_run, TUSHARE_TOKEN


def main():
    if not TUSHARE_TOKEN:
        print("缺少 TUSHARE_TOKEN，退出")
        sys.exit(1)

    print("1) 拉取日历数据...")
    calendar = fetch_calendar_entries()
    print(f"   日历原始条目: {len(calendar)}")

    built = build_upcoming_calendar(calendar, days=90)
    print(f"   未来 {len(built)} 天有申购/上市事件")

    # 写回最新报告的 calendar 字段
    cal_json = json.dumps(built, ensure_ascii=False)
    cal_json_sql = cal_json.replace("'", "''")  # 转义单引号
    print("2) 更新最新报告 calendar 字段...")
    psql_run(
        f"UPDATE ipo_reports SET summary_json = jsonb_set(summary_json, ARRAY['calendar'], "
        f"'{cal_json_sql}'::jsonb) WHERE report_date = (SELECT max(report_date) FROM ipo_reports);"
    )
    print("   calendar 已更新")

    # 3) 回填 ipo_date：取 new_share 的 ipo_date，匹配 ipo_history 已存在的代码
    print("3) 回填 ipo_history.ipo_date ...")
    rows = _tushare("new_share", {}, "ts_code,name,ipo_date")
    ipo_map = {}
    for r in rows:
        ts_code = str(r.get("ts_code") or "")
        code6 = ts_code.split(".")[0] if ts_code else ""
        ipo = _str_date(r.get("ipo_date"))
        if code6 and ipo:
            ipo_map[code6] = ipo

    # 现有代码
    res = psql_run(
        "SELECT security_code FROM ipo_history;",
        ignore_error=True,
    )
    existing = set()
    for line in (res.stdout or "").splitlines():
        c = line.strip()
        if c:
            existing.add(c)

    updates = []
    for code, dt in ipo_map.items():
        if code in existing:
            updates.append((code, dt))

    if updates:
        sql_lines = [
            f"UPDATE ipo_history SET ipo_date='{dt}' WHERE security_code='{code}';"
            for code, dt in updates
        ]
        # 逐条执行（量不大，安全直观）
        ok = 0
        for sql in sql_lines:
            try:
                psql_run(sql)
                ok += 1
            except Exception as e:
                print("   单条失败:", sql[:60], e)
        print(f"   ipo_date 回填 {ok}/{len(updates)} 行")
    else:
        print("   无匹配代码，跳过")

    print("完成。")


if __name__ == "__main__":
    main()
