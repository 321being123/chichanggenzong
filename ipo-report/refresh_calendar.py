#!/usr/bin/env python3
"""从统一事实库一次性重建已有报告中的打新日历。

背景：
- 本地 ipo_reports 的 calendar 字段是历史某次生成时写入的，可能遗漏
  新近公告的申购日（如 长鑫科技 688825 2026-07-16）。
- ipo_history 缺 ipo_date（申购日期）列，历史表无法展示申购日。

新股读取 ipo_history，新债读取 event.instrument_events，不调用外部接口。
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
from _common import _load_env, psql_run


def main():
    print("1) 读取统一事实库...")
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

    print("完成。")


if __name__ == "__main__":
    main()
