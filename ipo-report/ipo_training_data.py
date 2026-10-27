# -*- coding: utf-8 -*-
"""训练样本读取：保留 PostgreSQL 优先及旧 SQLite 回退。"""
import os
import sqlite3
import db_pg
from _common import _load_env

_load_env()

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
DB_PATH = os.path.join(DATA_DIR, "ipo_history.db")

TRAINING_SQL = """
    SELECT
        security_code, security_name, board_key, ld_close_change,
        issue_price, issue_pe, industry_pe, fund_raised,
        online_shares, total_shares, online_lottery_rate,
        oversubscribe_multiple, circulation_mv, subscribe_upper_limit,
        pe_ratio,
        listing_date, main_business, industry, source_payload,
        ipo_date
    FROM ipo_history
    WHERE board_key != '北交所'
      AND ld_close_change IS NOT NULL
    ORDER BY listing_date
"""

def load_training_rows():
    """读取可训练样本。生产历史数据在 PostgreSQL，SQLite 仅作旧环境兼容回退。"""
    try:
        conn = db_pg.connect()
        rows = conn.execute(TRAINING_SQL).fetchall()
        conn.close()
        if rows:
            print(f"数据源：PostgreSQL（{len(rows)} 条）")
            return rows
    except Exception as error:
        print(f"PostgreSQL 历史数据读取失败，尝试旧 SQLite：{error}")

    conn = sqlite3.connect(DB_PATH)
    try:
        return conn.execute(TRAINING_SQL).fetchall()
    except sqlite3.OperationalError:
        # 旧 SQLite 兼容库可能没有 ipo_history 表（如全新 CI 环境），视为无历史样本。
        return []
    finally:
        conn.close()
