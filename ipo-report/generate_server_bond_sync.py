"""Generate idempotent server-sync SQL for bond_history.

Reads the LOCAL (already-corrected) bond_history and emits:
  1) ALTER TABLE ... ADD COLUMN IF NOT EXISTS  (for the 16 columns the
     server is missing — it only has the original 5)
  2) ADD CONSTRAINT IF NOT EXISTS PK on security_code (required for ON CONFLICT)
  3) per-row INSERT ... ON CONFLICT (security_code) DO UPDATE  (full upsert)

Usage: python generate_server_bond_sync.py   ->  writes server_bond_sync.sql
The output is safe to re-run (idempotent). Execute on the server with:
  psql -h 127.0.0.1 -U postgres -d portfolio -f server_bond_sync.sql
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import db_pg

# 凭据统一从 PG* 环境变量读取（.env / 部署脚本注入），不再写死密码
conn = db_pg.connect()
cur = conn.cursor()

cur.execute("""SELECT column_name, data_type
               FROM information_schema.columns
               WHERE table_name='bond_history' ORDER BY ordinal_position""")
cols = [(r[0], r[1]) for r in cur.fetchall()]

base_cols = {'security_code', 'security_name', 'listing_date',
             'first_day_return', 'updated_at'}
new_cols = [(c, t) for c, t in cols if c not in base_cols]


def sql_val(v, t):
    if v is None:
        return 'NULL'
    if t == 'text':
        s = str(v)
        if s == '' or s.lower() in ('nan', 'nat', 'none'):
            return 'NULL'
        return "'" + s.replace("'", "''") + "'"
    # real / numeric
    try:
        f = float(v)
    except (TypeError, ValueError):
        return 'NULL'
    if f != f:  # NaN
        return 'NULL'
    return repr(f)


lines = [
    "-- bond_history 服务器同步：建表(若不存在) + 扩展列 + 全量 upsert（本地已验证，幂等可重跑）",
    "-- 服务器执行: psql -h 127.0.0.1 -U postgres -d portfolio -f server_bond_sync.sql",
    "-- 注：主键由 CREATE TABLE / server_schema.sql 建立；不包事务以单条独立提交，避免一行出错全滚。",
    f"CREATE TABLE IF NOT EXISTS bond_history ({', '.join(f'{c} ' + ('TEXT' if t=='text' else 'REAL') for c,t in cols)}, PRIMARY KEY (security_code));",
]
for c, t in new_cols:
    pgtype = 'TEXT' if t == 'text' else 'REAL'
    lines.append(f"ALTER TABLE bond_history ADD COLUMN IF NOT EXISTS {c} {pgtype};")

col_names = [c for c, _ in cols]
set_clause = ", ".join(f"{c}=EXCLUDED.{c}" for c in col_names if c != 'security_code')

cur.execute(f"SELECT {', '.join(col_names)} FROM bond_history")
rows = cur.fetchall()
for r in rows:
    vals = [sql_val(r[i], cols[i][1]) for i in range(len(cols))]
    lines.append(
        f"INSERT INTO bond_history ({', '.join(col_names)}) "
        f"VALUES ({', '.join(vals)}) ON CONFLICT (security_code) DO UPDATE SET {set_clause};"
    )


with open('server_bond_sync.sql', 'w', encoding='utf-8') as f:
    f.write("\n".join(lines))

print(f"WROTE server_bond_sync.sql  rows={len(rows)}  new_cols={len(new_cols)}")
cur.close()
conn.close()
