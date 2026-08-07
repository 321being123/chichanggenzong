#!/usr/bin/env python3
"""一次性回填 ipo_history 的发行详情字段（issue_price/issue_pe/fund_raised 等）。

背景：
- build_report 对北交所股票(_is_bj_stock)跳过详情获取，导致大量行
  issue_price/issue_pe/fund_raised/online_lottery_rate 等为空。
- 部分早期迁移行也可能缺失。
本脚本逐只调 fetch_stock_detail 补全，幂等可重跑。
"""
import sys
import os

# 确保能 import 同目录模块
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ipo_daily_report as m
import db_pg

# 要回填的字段（均为 fetch_stock_detail 返回的 key → DB 列名）
_DETAIL_FIELDS = [
    ("issue_price", "issue_price"),
    ("issue_pe", "issue_pe"),
    ("fund_raised", "fund_raised"),
    ("total_shares", "total_shares"),
    ("online_shares", "online_shares"),
    ("online_lottery_rate", "online_lottery_rate"),
    ("circulation_mv", "circulation_mv"),
    ("main_business", "main_business"),
    ("online_date", "ipo_date"),                       # 申购日
    ("subscribe_upper_limit", "subscribe_upper_limit"),  # 顶格申购上限(万股)
]

# 判定"这行还缺详情"的字段（任一为空即需要回填）
_MISSING_CHECK_COLS = [
    "issue_price", "issue_pe", "fund_raised", "total_shares", "online_shares",
    "online_lottery_rate", "circulation_mv", "ipo_date", "subscribe_upper_limit",
]


def main():
    conn = db_pg.connect()
    cur = conn.cursor()

    # 找出任一详情字段为空的行（不能只看 issue_price，
    # 否则"只缺申购日/顶格上限"的行永远进不了回填列表）
    where = " OR ".join(
        ("%s IS NULL OR %s = ''" % (c, c)) if c == "ipo_date" else ("%s IS NULL" % c)
        for c in _MISSING_CHECK_COLS
    )
    cur.execute("""
        SELECT security_code, security_name
        FROM ipo_history
        WHERE %s
        ORDER BY listing_date DESC NULLS LAST
    """ % where)
    rows = cur.fetchall()
    total = len(rows)
    print(f"共 {total} 行需要补全详情")

    if total == 0:
        print("无需补全")
        conn.close()
        return

    updated = 0
    skipped = 0
    for i, (code, name) in enumerate(rows, 1):
        print(f"[{i}/{total}] 处理 {code} {name} ...", end=" ", flush=True)
        detail = m.fetch_stock_detail(code)
        if not detail:
            print("无数据(跳过)")
            skipped += 1
            continue

        # 逐字段 UPDATE（只更新有意义的非空非零值）
        # 用 COALESCE 只填空位，绝不覆盖库里已有的值
        sets = []
        vals = []
        for src_key, db_col in _DETAIL_FIELDS:
            val = detail.get(src_key)
            if val is not None and val != "" and val != 0:
                if db_col == "ipo_date":
                    # ipo_date 是 TEXT，空串也算缺失
                    sets.append(f"{db_col}=CASE WHEN COALESCE({db_col}, '')='' THEN %s ELSE {db_col} END")
                else:
                    sets.append(f"{db_col}=COALESCE({db_col}, %s)")
                vals.append(val)

        if sets:
            vals.append(code)
            sql = f"UPDATE ipo_history SET {', '.join(sets)} WHERE security_code=%s"
            cur.execute(sql, vals)
            updated += 1
            print(f"OK ({len(sets)} 字段)")
        else:
            print("无可补字段(跳过)")
            skipped += 1

        # 每 20 行 commit 一次避免长事务
        if i % 20 == 0:
            conn.commit()
            print(f"  -- 已提交 {i}/{total}")

    conn.commit()
    conn.close()
    print(f"\n完成: 更新 {updated} 行, 跳过 {skipped} 行 (共 {total})")


if __name__ == "__main__":
    main()
