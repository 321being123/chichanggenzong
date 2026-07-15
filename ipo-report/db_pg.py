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
    "bond_history": ["security_code"],
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
    password = os.environ.get("PGPASSWORD", "")
    dbname = os.environ.get("PGDATABASE", "postgres")
    pg_conn = psycopg2.connect(
        host=host, port=port, user=user, password=password,
        dbname=dbname, connect_timeout=10)
    return _PGConn(pg_conn)
