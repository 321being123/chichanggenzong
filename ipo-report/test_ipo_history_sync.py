# -*- coding: utf-8 -*-
"""新股历史同步确定性测试：不访问外部接口，事务结束后回滚。"""
import os
import sys
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ipo_history_sync as sync

PASS, FAIL, ERR = [], [], []


def check(name, condition, detail=""):
    (PASS if condition else FAIL).append(name)
    print("  [%s] %s %s" % ("PASS" if condition else "FAIL", name, detail))


try:
    loss = sync.normalize_share({
        "ts_code": "999999.SH", "name": "测试新股", "ipo_date": "20260801",
        "issue_date": "20260811", "amount": 1000, "market_amount": 500,
        "price": 20, "pe": None, "limit_amount": 1, "funds": None, "ballot": 0.03,
    })
    check("日期标准化", loss["ipo_date"] == "2026-08-01" and loss["listing_date"] == "2026-08-11")
    check("募资额派生", loss["fund_raised"] == 2.0)
    check("公开发行市值派生", loss["circulation_mv"] == 1.0)
    check("亏损企业状态", loss["issue_pe"] is None and loss["issue_pe_status"] == "loss")

    conn = sync.pg_connect()
    cur = conn.cursor()
    inserted, refreshed = sync.upsert_shares(cur, [loss])
    check("首次写入", inserted == 1 and refreshed == 0)
    blank = dict(loss)
    blank.update({"issue_price": None, "online_shares": None, "circulation_mv": None,
                  "source_payload": {"ts_code": "999999.SH", "price": None}})
    inserted2, refreshed2 = sync.upsert_shares(cur, [blank])
    cur.execute("SELECT issue_price,online_shares,circulation_mv,ipo_date FROM ipo_history WHERE security_code='999999'")
    row = cur.fetchone()
    check("空值不覆盖旧值", inserted2 == 0 and refreshed2 == 1 and tuple(row) == (20.0, 500.0, 1.0, "2026-08-01"), str(row))
    conn.rollback()
    cur.close()
    conn.close()
except Exception as exc:
    ERR.append(str(exc))
    traceback.print_exc()

print("PASS=%d FAIL=%d ERROR=%d" % (len(PASS), len(FAIL), len(ERR)))
print("OK" if not FAIL and not ERR else "HAS_ISSUES")
