#!/usr/bin/env python3
"""审计 ipo_history.subscribe_upper_limit（顶格申购上限,万股）缺口。

new_share 只允许由 ipo_history_sync 统一采集；本脚本不再调用接口或回填事实。
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from _common import _load_env, psql_run


def main():
    rows = psql_run(
        "SELECT security_code, security_name FROM ipo_history "
        "WHERE (subscribe_upper_limit IS NULL OR subscribe_upper_limit = 0) "
        "AND listing_date IS NOT NULL AND listing_date <> '';"
    ).stdout.strip().splitlines()
    # psql 表格输出，去掉表头/分隔行
    miss = []
    for ln in rows:
        ln = ln.strip()
        if not ln or ln.startswith("-") or ln == "security_code": continue
        parts = [x for x in ln.split("|")]
        if len(parts) >= 2:
            code = parts[0].strip(); name = parts[1].strip()
            if code: miss.append((code, name))
    print(f"缺失行 {len(miss)} 个: {[m[0] for m in miss]}")
    print("请运行统一任务 ipo_history_sync 补齐，当前脚本不会直接采集或修改事实表。")

if __name__ == "__main__":
    main()
