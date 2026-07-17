# -*- coding: utf-8 -*-
"""
PostgreSQL 集成测试（仅依赖本地/CI 的 PostgreSQL，不调用外部行情）。
运行：python ipo-report/test_ipo_integration.py
依赖：本地 PostgreSQL 已启动 + .env 含 PG*
"""
import os
import sys
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ipo_daily_report as m
import db_pg
import psycopg2

PASS, FAIL, ERR = [], [], []


def check(name, cond, detail=""):
    if cond:
        PASS.append(name)
        print("  [PASS] %s %s" % (name, detail))
    else:
        FAIL.append(name)
        print("  [FAIL] %s %s" % (name, detail))


def pg_conn():
    return psycopg2.connect(
        host=os.environ.get("PGHOST", "127.0.0.1"),
        port=int(os.environ.get("PGPORT", "5432")),
        user=os.environ.get("PGUSER", "postgres"),
        password=os.environ.get("PGPASSWORD", "postgres"),
        dbname=os.environ.get("PGDATABASE", "portfolio"),
        connect_timeout=10,
    )


# ===== 1. db_pg 封装层（修复：CREATE TABLE 空操作报空语句；upsert 幂等）=====
print("== 1. db_pg 封装层 ==")
try:
    conn = db_pg.connect()
    # CREATE TABLE 必须静默空操作，不能抛 "can't execute an empty query"
    conn.execute("CREATE TABLE IF NOT EXISTS __ipo_test_noop (a int)")
    conn.commit()
    check("CREATE TABLE 空操作不抛错", True)

    # INSERT OR REPLACE 幂等（同主键两次写入=1行）
    conn.execute(
        "INSERT OR REPLACE INTO predictions (type, code, name, listing_date, pred_date, status) VALUES (?, ?, ?, ?, ?, ?)",
        ("stock", "TEST001", "测试股", "2026-07-20", "2026-07-20", "pending"),
    )
    conn.execute(
        "INSERT OR REPLACE INTO predictions (type, code, name, listing_date, pred_date, status) VALUES (?, ?, ?, ?, ?, ?)",
        ("stock", "TEST001", "测试股", "2026-07-20", "2026-07-20", "done"),
    )
    conn.commit()
    cur = conn.cursor()
    cur.execute(
        "SELECT count(*) FROM predictions WHERE type='stock' AND code='TEST001' AND pred_date='2026-07-20'")
    cnt = cur.fetchone()[0]
    check("INSERT OR REPLACE 幂等(1行)", cnt == 1, "实际=%d" % cnt)
    cur.execute("DELETE FROM predictions WHERE type='stock' AND code='TEST001'")
    conn.commit()
    conn.close()
    check("占位符 ? 被正确改写", True)
except Exception as e:
    ERR.append("db_pg: " + str(e))
    traceback.print_exc()


# ===== 2. fetch_bond_detail（读 bond_history，无样本则跳过细节）=====
print("== 2. fetch_bond_detail(真实已上市转债) ==")
try:
    c = pg_conn()
    cur = c.cursor()
    cur.execute("SELECT security_code FROM bond_history WHERE listing_date IS NOT NULL AND listing_date <> '' LIMIT 1")
    row = cur.fetchone()
    c.close()
    if row:
        code = row[0]
        b = m.fetch_bond_detail(code)
        check("返回 dict/None", b is None or isinstance(b, dict), "code=%s" % code)
        if isinstance(b, dict):
            check("含 convert_price 字段", "convert_price" in b)
            check("convert_price 非 None", b.get("convert_price") is not None,
                  "convert_price=%r" % b.get("convert_price"))
            check("含 rating 字段", "rating" in b)
    else:
        check("本地无已上市转债样本(跳过)", True, "bond_history 无 listing_date")
except Exception as e:
    ERR.append("fetch_bond_detail: " + str(e))
    traceback.print_exc()


# ===== 3. save_report_to_pg 幂等（修复：重复写入不新增行）=====
print("== 3. save_report_to_pg 幂等 ==")
try:
    date_str = "20260715"
    md = "# 测试报告"
    data = {"date_display": "2026-07-15", "weekday": "周三",
            "apply_stocks": [], "apply_bonds": [], "list_stocks": [],
            "list_bonds": [], "sector_boost_info": None}
    m.save_report_to_pg(md, "<html>test</html>", data, date_str)
    m.save_report_to_pg(md, "<html>test2</html>", data, date_str)  # 第二次应覆盖
    c = pg_conn()
    cur = c.cursor()
    cur.execute("SELECT count(*) FROM ipo_reports WHERE report_date=%s", (date_str,))
    cnt = cur.fetchone()[0]
    check("同日期仅 1 行(upsert)", cnt == 1, "实际=%d" % cnt)
    cur.execute("SELECT summary_json IS NOT NULL FROM ipo_reports WHERE report_date=%s", (date_str,))
    notnull = cur.fetchone()[0]
    check("summary_json 非空", notnull is True)
    cur.execute("DELETE FROM ipo_reports WHERE report_date=%s", (date_str,))
    c.commit()
    c.close()
except Exception as e:
    ERR.append("save_report_to_pg: " + str(e))
    traceback.print_exc()


# ===== 汇总 =====
print("\n===== 结果汇总（PostgreSQL 集成测试）=====")
print("PASS=%d  FAIL=%d  ERROR=%d" % (len(PASS), len(FAIL), len(ERR)))
if FAIL:
    print("失败项:", FAIL)
if ERR:
    print("异常项:", ERR)
print("OK" if not FAIL and not ERR else "HAS_ISSUES")
