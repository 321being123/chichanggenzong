import sys, os
sys.path.insert(0, os.path.dirname(__file__))
import paramiko

HOST="82.156.125.47"; PORT=22; USER="ubuntu"; PASS=os.environ.get("SERVER_PASS", "")
os.environ["SERVER_PASS"] = PASS  # 供 _common.ssh_run 提权使用
from _common import shlex_quote, ssh_run

client = paramiko.SSHClient(); client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, port=PORT, username=USER, password=PASS, timeout=30, look_for_keys=False, allow_agent=False)

# 读 .env 的 PG 配置
st, out, err = ssh_run(client, "cat /opt/portfolio/.env", sudo=True)
cfg = {}
for line in out.splitlines():
    line=line.strip()
    if not line or line.startswith('#') or '=' not in line: continue
    k,v = line.split('=',1); k=k.strip(); v=v.strip().strip('"').strip("'"); cfg[k]=v
pg_map={'PGHOST':'DB_HOST','PGPORT':'DB_PORT','PGUSER':'DB_USER','PGPASSWORD':'DB_PASSWORD','PGDATABASE':'DB_NAME'}
for pk,dk in pg_map.items():
    if pk in cfg and dk not in cfg: cfg[dk]=cfg[pk]

psql_base = f"set -a; source {shlex_quote('/opt/portfolio/.env')}; PGPASSWORD=\"$PGPASSWORD\" psql -h \"$PGHOST\" -p \"$PGPORT\" -U \"$PGUSER\" -d \"$PGDATABASE\" -t -A -c"
q1 = psql_base + " " + shlex_quote("SELECT count(*) FROM bond_history;")
q2 = psql_base + " " + shlex_quote("SELECT security_code, security_name, issue_size, rating FROM bond_history WHERE security_code IN ('118070','110059') ORDER BY security_code;")
q3 = psql_base + " " + shlex_quote("SELECT count(*) FROM bond_history WHERE issue_size >= 10000;")
q4 = psql_base + " " + shlex_quote("SELECT count(*) FROM bond_history WHERE rating IS NULL OR rating='';")
for label, q in [("总行数",q1),("南芯/浦发",q2),("残留元值",q3),("缺失评级",q4)]:
    o,e,s = ssh_run(client, q, sudo=True)
    print(f"[{label}] status={s}")
    print(o.strip())
    if e.strip(): print("  ERR:", e.strip()[:200])
client.close()
