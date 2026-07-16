#!/usr/bin/env python3
"""回填 ipo_history.subscribe_upper_limit（顶格申购上限,万股）给缺失的已上市新股。

只更新 (subscribe_upper_limit IS NULL OR =0) 且已上市的股票。
数据源：Tushare new_share 的 limit_amount（单位=顶格申购上限(万股)）。
仅本地数据更新，不触达线上、不部署。
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from _common import _load_env, _tushare, psql_run, TUSHARE_TOKEN


def main():
    if not TUSHARE_TOKEN:
        print("缺少 TUSHARE_TOKEN，退出"); return
    # 1. 取缺失行
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

    # 2. 拉 new_share（含 limit_amount）
    df = _tushare("new_share", {}, "ts_code,name,ipo_date,issue_date,limit_amount")
    by_code = {}
    for r in df:
        ts_code = str(r.get("ts_code") or "")
        code6 = ts_code.split(".")[0]
        if code6:
            by_code[code6] = r
    print(f"Tushare new_share 返回 {len(df)} 条")

    updated = 0
    for code, name in miss:
        r = by_code.get(code)
        if not r:
            print(f"  [跳过] {code} {name} 不在 new_share 返回中")
            continue
        la = r.get("limit_amount")
        try:
            la = float(la) if la not in (None, "") else None
        except Exception:
            la = None
        if not la:
            print(f"  [跳过] {code} {name} limit_amount 为空")
            continue
        upper = round(la, 2)
        psql_run(
            f"UPDATE ipo_history SET subscribe_upper_limit = {upper} "
            f"WHERE security_code = '{code}';"
        )
        print(f"  [更新] {code} {name} subscribe_upper_limit={upper}")
        updated += 1
    print(f"完成，更新 {updated} 行")

if __name__ == "__main__":
    main()
