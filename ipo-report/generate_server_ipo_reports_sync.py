"""生成 ipo_reports 服务器同步 SQL（与 bond_history/ipo_history 同模式：建表 + 全量 upsert，无事务包裹）。

ipo_reports 由每日日报 ipo_daily_report.py 写入，存储打新日历(calendar)、打新建议(md 的"结论"段)、
赛道热度(sector_boost_info) 等。服务器此前未建该表，导致线上打新日历/打新建议为空。
本地库有最新报告(含未来申购/上市排期)，同步到服务器即可恢复展示。

Usage: python generate_server_ipo_reports_sync.py -> server_ipo_reports_sync.sql
"""
import json
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import db_pg

# ipo_reports 固定 schema（jsonb / timestamptz 不能套用通用 text/REAL 映射，故写死）
COLUMNS = [
    ('report_date', 'text'),
    ('html', 'text'),
    ('md', 'text'),
    ('summary_json', 'jsonb'),
    ('created_at', 'timestamptz'),
]

def sql_text(v):
    if v is None:
        return 'NULL'
    s = str(v)
    if s == '':
        return 'NULL'
    return "'" + s.replace("'", "''") + "'"

def sql_json(v):
    if v is None:
        return 'NULL'
    # ensure_ascii=False 保留中文原文；single-quote 转义；standard_conforming_strings=on 保证反斜杠按字面处理
    return "'" + json.dumps(v, ensure_ascii=False).replace("'", "''") + "'"

def sql_ts(v):
    if v is None:
        return 'now()'
    return "'" + v.isoformat() + "'::timestamptz"

# 凭据统一从 PG* 环境变量读取（.env / 部署脚本注入），不再写死密码
conn = db_pg.connect()
cur = conn.cursor()
cur.execute(f"SELECT {', '.join(c for c, _ in COLUMNS)} FROM ipo_reports ORDER BY report_date")
rows = cur.fetchall()
cur.close()
conn.close()

col_names = [c for c, _ in COLUMNS]
set_clause = ", ".join(f"{c}=EXCLUDED.{c}" for c in col_names if c != 'report_date')

lines = [
    "SET standard_conforming_strings = on;",
    "CREATE TABLE IF NOT EXISTS ipo_reports ("
    "  report_date  TEXT                     NOT NULL,"
    "  html         TEXT,"
    "  md           TEXT,"
    "  summary_json JSONB,"
    "  created_at   TIMESTAMPTZ DEFAULT now(),"
    "  PRIMARY KEY (report_date)"
    ");",
]
for r in rows:
    vals = [
        sql_text(r[0]),       # report_date
        sql_text(r[1]),       # html
        sql_text(r[2]),       # md
        sql_json(r[3]),       # summary_json
        sql_ts(r[4]),         # created_at
    ]
    lines.append(
        f"INSERT INTO ipo_reports ({', '.join(col_names)}) VALUES ({', '.join(vals)}) "
        f"ON CONFLICT (report_date) DO UPDATE SET {set_clause};"
    )

with open('server_ipo_reports_sync.sql', 'w', encoding='utf-8') as f:
    f.write("\n".join(lines) + "\n")

print(f"WROTE server_ipo_reports_sync.sql rows={len(rows)} cols={len(col_names)}")
