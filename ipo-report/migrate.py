#!/usr/bin/env python3
"""一次性迁移脚本：把 data/ 下的两个 SQLite 库导入 PostgreSQL。

- 不硬编码任何密码，全部从环境变量读取。
  本地测试:  PGPASSWORD=postgres PGDATABASE=portfolio python migrate.py
- 幂等：每个表先 DELETE 再全量 INSERT，可重复执行。
- 仅用于初次迁移，运行环境需 pip install psycopg2-binary。
"""
import os
import sys
import sqlite3

try:
    import psycopg2
except ImportError:
    sys.exit("缺少 psycopg2-binary，请先: pip install psycopg2-binary")

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
SCHEMA = os.path.join(HERE, "sql", "schema.sql")

# PG 连接参数只认环境变量（禁止硬编码密码）
PG = dict(
    host=os.getenv("PGHOST", "127.0.0.1"),
    port=os.getenv("PGPORT", "5432"),
    user=os.getenv("PGUSER", "postgres"),
    password=os.getenv("PGPASSWORD"),
    dbname=os.getenv("PGDATABASE", "portfolio"),
)
if not PG["password"]:
    sys.exit("ERROR: 请通过环境变量 PGPASSWORD 提供数据库密码（本地: PGPASSWORD=postgres）")


def conn_pg():
    return psycopg2.connect(**PG)


def run_schema(pg):
    with open(SCHEMA, encoding="utf-8") as f:
        pg.cursor().execute(f.read())
    pg.commit()


def migrate_table(pg, db_path, table, columns):
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    rows = con.execute(f"SELECT * FROM {table}").fetchall()
    con.close()
    if not rows:
        print(f"  {table}: 0 行(跳过)")
        return 0
    col_list = ", ".join(columns)
    ph = ", ".join(["%s"] * len(columns))
    sql = f"INSERT INTO {table} ({col_list}) VALUES ({ph})"
    cur = pg.cursor()
    cur.execute(f"DELETE FROM {table}")
    cur.executemany(sql, [tuple(r[c] for c in columns) for r in rows])
    pg.commit()
    print(f"  {table}: 迁移 {len(rows)} 行")
    return len(rows)


def main():
    ipo_db = os.path.join(DATA, "ipo_history.db")
    sec_db = os.path.join(DATA, "sector_heat.db")
    if not os.path.exists(ipo_db) or not os.path.exists(sec_db):
        sys.exit(f"未找到 SQLite 文件: {ipo_db} / {sec_db}")

    pg = conn_pg()
    print(f"连接 PG 成功: {PG['user']}@{PG['host']}:{PG['port']}/{PG['dbname']}")
    print("建表 (sql/schema.sql)...")
    run_schema(pg)

    print("迁移 ipo_history.db ...")
    migrate_table(pg, ipo_db, "ipo_history",
        ["security_code", "security_name", "market_type", "listing_date", "ld_close_change",
         "board_key", "updated_at", "issue_price", "issue_pe", "industry_pe", "fund_raised",
         "total_shares", "online_shares", "online_lottery_rate", "oversubscribe_multiple",
         "subscribe_upper_limit", "main_business", "industry", "circulation_mv", "pe_ratio"])
    migrate_table(pg, ipo_db, "bond_history",
        ["security_code", "security_name", "listing_date", "first_day_return", "updated_at"])
    migrate_table(pg, ipo_db, "predictions",
        ["type", "code", "name", "listing_date", "pred_date", "pred_return", "pred_price",
         "pred_advice", "actual_return", "actual_price", "actual_date", "status", "updated_at"])

    print("迁移 sector_heat.db ...")
    migrate_table(pg, sec_db, "sector_heat",
        ["sector_key", "avg_gain_60d", "stock_count", "boost", "updated_at"])
    migrate_table(pg, sec_db, "stock_gain",
        ["stock_code", "gain_60d", "updated_at"])
    migrate_table(pg, sec_db, "stock_sector",
        ["stock_code", "sector_key", "stock_name"])

    pg.close()
    print("迁移完成。")


if __name__ == "__main__":
    main()
