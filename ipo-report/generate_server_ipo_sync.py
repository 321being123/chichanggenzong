"""生成 ipo_history 服务器同步 SQL（与 bond_history 同模式：建表+全量 upsert，无事务包裹）。
本地 ipo_history 含精确中签率(oneline_lottery_rate 等)，同步到服务器使 IPO 中签率精确化生效。
Usage: python generate_server_ipo_sync.py -> ipo_server_sync.sql
"""
import psycopg2
conn = psycopg2.connect(host='127.0.0.1', port=5432, dbname='portfolio', user='postgres', password=***REDACTED***)
cur = conn.cursor()
cur.execute("SELECT column_name, data_type FROM information_schema.columns WHERE table_name='ipo_history' ORDER BY ordinal_position")
cols = [(r[0], r[1]) for r in cur.fetchall()]

def sql_val(v, t):
    if v is None: return 'NULL'
    if t == 'text':
        s = str(v)
        if s == '' or s.lower() in ('nan','nat','none'): return 'NULL'
        return "'" + s.replace("'", "''") + "'"
    try: f = float(v)
    except (TypeError, ValueError): return 'NULL'
    if f != f: return 'NULL'
    return repr(f)

lines = [
    f"CREATE TABLE IF NOT EXISTS ipo_history ({', '.join(f'{c} ' + ('TEXT' if t=='text' else 'REAL') for c,t in cols)}, PRIMARY KEY (security_code));",
]
col_names = [c for c, _ in cols]
set_clause = ", ".join(f"{c}=EXCLUDED.{c}" for c in col_names if c != 'security_code')
cur.execute(f"SELECT {', '.join(col_names)} FROM ipo_history")
rows = cur.fetchall()
for r in rows:
    vals = [sql_val(r[i], cols[i][1]) for i in range(len(cols))]
    lines.append(f"INSERT INTO ipo_history ({', '.join(col_names)}) VALUES ({', '.join(vals)}) ON CONFLICT (security_code) DO UPDATE SET {set_clause};")
with open('ipo_server_sync.sql', 'w', encoding='utf-8') as f:
    f.write("\n".join(lines))
print(f"WROTE ipo_server_sync.sql rows={len(rows)} cols={len(cols)}")
cur.close(); conn.close()
