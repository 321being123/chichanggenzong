#!/usr/bin/env python3
"""
SQLite 兼容的 PostgreSQL 薄封装层。

目的：让 ipo_daily_report.py 以最小改动从 SQLite 迁移到 PostgreSQL。
- connect() 返回 PGConn，提供与 sqlite3.Connection 兼容的接口：
  conn.execute(sql, params) -> 游标(支持 .fetchone()/.fetchall())
  conn.commit() / conn.close()
- 自动把 SQLite 占位符 ? 转为 PostgreSQL 的 %s
- CREATE TABLE 语句转为空操作（表已由 migrate.py / schema.sql 建好）
- INSERT OR REPLACE / INSERT OR IGNORE 转为 PostgreSQL 的 ON CONFLICT upsert

环境变量（与 portfolio-server 的 .env 一致，不写死密码）：
  PGHOST  PGHOSTADDR  PGPORT  PGUSER  PGPASSWORD  PGDATABASE
"""
import os
import re
import psycopg2

# 各表主键/唯一约束，用于 INSERT OR REPLACE / INSERT OR IGNORE 的冲突目标
_TABLE_PK = {
    "ipo_history": ["security_code"],
    "stock_gain": ["stock_code"],
    "sector_heat": ["sector_key"],
    "predictions": ["type", "code", "pred_date"],
}


class _PGCursor:
    """包装 psycopg2 游标，暴露 fetchone/fetchall。"""

    def __init__(self, cur):
        self._cur = cur

    def fetchone(self):
        return self._cur.fetchone()

    def fetchall(self):
        return self._cur.fetchall()

    def fetchmany(self, n):
        return self._cur.fetchmany(n)

    @property
    def rowcount(self):
        return self._cur.rowcount

    def __iter__(self):
        return iter(self._cur)


class _PGConn:
    def __init__(self, pg_conn):
        self._conn = pg_conn

    def execute(self, sql, params=None):
        rewritten, _ = _rewrite_sql(sql)
        cur = self._conn.cursor()
        cur.execute(rewritten, params)
        return _PGCursor(cur)

    def cursor(self):
        return self._conn.cursor()

    def commit(self):
        self._conn.commit()

    def rollback(self):
        self._conn.rollback()

    def close(self):
        self._conn.close()


def _rewrite_sql(sql):
    """把 SQLite 语法的 SQL 改写为 PostgreSQL 语法。返回 (改写后SQL, 是否INSERT-含列)。"""
    s = sql.strip()

    # CREATE TABLE -> 空操作（表已存在）；返回无害占位语句
    if re.match(r"^CREATE\s+TABLE", s, re.IGNORECASE):
        return "SELECT 1", None

    # INSERT OR IGNORE INTO t (cols) VALUES (...)
    m = re.match(
        r"INSERT\s+OR\s+IGNORE\s+INTO\s+(\w+)\s*\((.*?)\)\s*VALUES",
        s, re.IGNORECASE | re.DOTALL)
    if m:
        table, cols = m.group(1), [c.strip() for c in m.group(2).split(",")]
        pk = _TABLE_PK.get(table, ["__no_pk__"])
        return (
            f"INSERT INTO {table} ({','.join(cols)}) "
            f"VALUES ({','.join(['%s'] * len(cols))}) "
            f"ON CONFLICT ({','.join(pk)}) DO NOTHING", cols)

    # INSERT OR REPLACE INTO t (cols) VALUES (...)
    m = re.match(
        r"INSERT\s+OR\s+REPLACE\s+INTO\s+(\w+)\s*\((.*?)\)\s*VALUES",
        s, re.IGNORECASE | re.DOTALL)
    if m:
        table, cols = m.group(1), [c.strip() for c in m.group(2).split(",")]
        pk = _TABLE_PK.get(table)
        if pk:
            upd = ", ".join([f"{c}=EXCLUDED.{c}" for c in cols if c not in pk])
            return (
                f"INSERT INTO {table} ({','.join(cols)}) "
                f"VALUES ({','.join(['%s'] * len(cols))}) "
                f"ON CONFLICT ({','.join(pk)}) DO UPDATE SET {upd}", cols)
        return (f"INSERT INTO {table} ({','.join(cols)}) "
                f"VALUES ({','.join(['%s'] * len(cols))})", cols)

    # 其它语句：? -> %s
    return re.sub(r"\?", "%s", s), None


def connect():
    """建立 PostgreSQL 连接（参数来自环境变量，不写死）。"""
    host = os.environ.get("PGHOST", "127.0.0.1")
    port = int(os.environ.get("PGPORT", "5432"))
    user = os.environ.get("PGUSER", "postgres")
    password = os.environ.get("PGPASSWORD")
    if not password:
        raise RuntimeError("请通过 PGPASSWORD 环境变量提供数据库密码")
    dbname = os.environ.get("PGDATABASE", "postgres")
    pg_conn = psycopg2.connect(
        host=host, port=port, user=user, password=password,
        dbname=dbname, connect_timeout=10)
    return _PGConn(pg_conn)


def load_market_temperature_rows(conn, cutoff, upper):
    return conn.execute(
        "SELECT ld_close_change FROM ipo_history WHERE listing_date >= ? AND listing_date <= ?"
        " AND ld_close_change IS NOT NULL AND market_type != '北交所'",
        (cutoff, upper),
    ).fetchall()


def load_sector_boost_rows(conn):
    return conn.execute("SELECT sector_key, boost, stock_count FROM sector_heat").fetchall()


def init_sector_db():
    """初始化赛道热度数据库"""
    conn = connect()
    # 已上市股票-赛道映射表（存储哪些股票属于哪个赛道）
    conn.execute("""
        CREATE TABLE IF NOT EXISTS stock_sector (
            stock_code TEXT,
            sector_key TEXT,
            stock_name TEXT,
            PRIMARY KEY (stock_code, sector_key)
        )
    """)
    # 赛道热度快照表（每日存储一次赛道统计结果）
    conn.execute("""
        CREATE TABLE IF NOT EXISTS sector_heat (
            sector_key TEXT PRIMARY KEY,
            avg_gain_60d REAL,
            stock_count INTEGER,
            boost REAL,
            updated_at TEXT
        )
    """)
    # 股票涨跌幅缓存表（存储最近一次获取的60日涨跌幅）
    conn.execute("""
        CREATE TABLE IF NOT EXISTS stock_gain (
            stock_code TEXT PRIMARY KEY,
            gain_60d REAL,
            updated_at TEXT
        )
    """)
    conn.commit()
    return conn


def clear_sector_heat(conn):
    return conn.execute("DELETE FROM sector_heat")


def load_sector_history(conn, cutoff):
    return conn.execute("""SELECT security_code, security_name, market_type, listing_date,
                  main_business, industry, ld_close_change, source_payload
             FROM ipo_history
            WHERE listing_date >= ? AND ld_close_change IS NOT NULL""", (cutoff,)).fetchall()


def save_sector_heat(conn, sector_key, item, now_str):
    return conn.execute("INSERT OR REPLACE INTO sector_heat (sector_key, avg_gain_60d, stock_count, boost, updated_at) VALUES (?,?,?,?,?)", (sector_key, round(item["robust_gain"], 2), item["sample_count"], item["boost"], now_str))


def load_sector_heat(conn):
    return conn.execute("SELECT sector_key, boost, avg_gain_60d, stock_count FROM sector_heat ORDER BY boost DESC").fetchall()


def load_prediction_errors(conn, ptype, cutoff):
    return conn.execute("SELECT name, code, pred_return, actual_return, listing_date FROM predictions " "WHERE type=? AND status='fulfilled' AND actual_return IS NOT NULL AND pred_return IS NOT NULL " "AND pred_date >= ? ORDER BY listing_date DESC LIMIT 10", (ptype, cutoff)).fetchall()


def load_prediction_accuracy(conn, ptype, cutoff):
    return conn.execute("SELECT pred_return, actual_return FROM predictions WHERE type=? AND status='fulfilled' AND actual_return IS NOT NULL AND pred_date >= ?", (ptype, cutoff)).fetchall()


def load_board_calibration(conn, cutoff):
    return conn.execute("SELECT board_key, ld_close_change FROM ipo_history WHERE listing_date >= ? AND ld_close_change IS NOT NULL", (cutoff,)).fetchall()


def load_ipo_last_update(conn):
    return conn.execute("SELECT MAX(updated_at) FROM ipo_history").fetchone()


def load_bond_instrument(conn, code):
    return conn.execute("SELECT instrument_id FROM public.bond_unified WHERE security_code=? LIMIT 1", (code,)).fetchone()


def save_prediction_row(conn, row):
    if len(row) == 15:
        # 股票预测：含当次上线模型版本（验收第二批缺口——版本追溯）
        conn.execute("""
        INSERT OR REPLACE INTO predictions
            (type, code, name, listing_date, pred_date, pred_return, pred_price, pred_advice, updated_at,
             base_pred_return, sector_adjustment_pp, sector_multiplier, sector_confidence,
             valuation_model_version, prediction_context)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?::jsonb)
        """, row)
        return
    if len(row) == 14:
        conn.execute("""
        INSERT OR REPLACE INTO predictions
            (type, code, name, listing_date, pred_date, pred_return, pred_price, pred_advice, updated_at,
             base_pred_return, sector_adjustment_pp, sector_multiplier, sector_confidence, prediction_context)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?::jsonb)
        """, row)
        return
    if len(row) == 17:
        conn.execute("""
        INSERT OR REPLACE INTO predictions
            (type, code, name, listing_date, pred_date, pred_return, pred_price, pred_advice, updated_at, instrument_id,
             transfer_value, circulation_scale, base_price_no_liquidity, liquidity_adjustment_pp,
             liquidity_sample_count, valuation_model_version, valuation_context)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?::jsonb)
        """, row)
        return
    conn.execute("""
        INSERT OR REPLACE INTO predictions
            (type, code, name, listing_date, pred_date, pred_return, pred_price, pred_advice, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)
    """, row)


def insert_missing_bond_predictions(conn, params):
    return conn.execute("INSERT INTO predictions(type,code,name,listing_date,pred_date,actual_return,actual_price,actual_date,status,updated_at,instrument_id)\n           SELECT 'bond',split_part(i.canonical_code,'.',1),i.name,lp.listing_date::text,lp.listing_date::text,\n                  lp.return_pct,100*(1+lp.return_pct/100),lp.observation_date::text,'fulfilled',?,i.instrument_id\n             FROM analytics.convertible_bond_listing_performance lp\n             JOIN core.instruments i ON i.instrument_id=lp.instrument_id\n            WHERE lp.measurement_type='first_non_limit_day'\n              AND NOT EXISTS (SELECT 1 FROM predictions p WHERE p.type='bond' AND p.code=split_part(i.canonical_code,'.',1))", params)


def list_ipo_actuals(conn):
    return conn.execute('SELECT security_code, security_name, listing_date, ld_close_change, issue_price FROM ipo_history WHERE ld_close_change IS NOT NULL')


def prediction_exists(conn, params):
    return conn.execute('SELECT 1 FROM predictions WHERE code=?', params)


def insert_stock_actual(conn, params):
    return conn.execute("INSERT INTO predictions (type,code,name,listing_date,pred_date,actual_return,actual_price,actual_date,status,updated_at) VALUES ('stock',?,?,?,?,?,?,?,'fulfilled',?)", params)


def list_predictions_missing_price(conn):
    return conn.execute('SELECT id, type, code, pred_return FROM predictions WHERE pred_price IS NULL AND pred_return IS NOT NULL')


def load_stock_issue_price(conn, params):
    return conn.execute('SELECT issue_price FROM ipo_history WHERE security_code=? AND issue_price IS NOT NULL', params)


def update_prediction_price(conn, params):
    return conn.execute('UPDATE predictions SET pred_price=?, updated_at=? WHERE id=?', params)


def list_tracked_predictions(conn, params):
    return conn.execute('SELECT id, type, code, name, listing_date, pred_price FROM predictions WHERE (pred_return IS NOT NULL OR pred_price IS NOT NULL) AND listing_date <= ?', params)


def load_stock_actual(conn, params):
    return conn.execute('SELECT ld_close_change, issue_price, listing_date FROM ipo_history WHERE security_code=? AND ld_close_change IS NOT NULL', params)


def update_stock_actual(conn, params):
    return conn.execute("UPDATE predictions SET actual_return=?, actual_price=?, actual_date=?, status='fulfilled', updated_at=? WHERE id=?", params)


def load_bond_actual(conn, params):
    return conn.execute("SELECT lp.return_pct,lp.listing_date,lp.observation_date,i.instrument_id\n                         FROM analytics.convertible_bond_listing_performance lp\n                         JOIN core.instruments i ON i.instrument_id=lp.instrument_id\n                        WHERE lp.measurement_type='first_non_limit_day'\n                          AND split_part(i.canonical_code,'.',1)=? AND lp.return_pct IS NOT NULL", params)


def update_bond_actual(conn, params):
    return conn.execute("UPDATE predictions SET instrument_id=?, pred_return=COALESCE(?, pred_return), actual_return=?, actual_price=?, actual_date=?, status='fulfilled', updated_at=? WHERE id=?", params)
