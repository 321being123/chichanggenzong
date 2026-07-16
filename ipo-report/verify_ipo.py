import sys, os
sys.path.insert(0, os.path.dirname(__file__))
import paramiko
HOST="82.156.125.47"; PORT=22; USER="ubuntu"; PASS="***REDACTED***"
os.environ["SERVER_PASS"] = PASS  # 供 _common.ssh_run 提权使用
from _common import shlex_quote, ssh_run

client = paramiko.SSHClient(); client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, port=PORT, username=USER, password=PASS, timeout=30, look_for_keys=False, allow_agent=False)
base = "set -a; source " + shlex_quote("/opt/portfolio/.env") + "; PGPASSWORD=\"$PGPASSWORD\" psql -h \"$PGHOST\" -p \"$PGPORT\" -U \"$PGUSER\" -d \"$PGDATABASE\" -t -A -c"
checks = [
    ("ipo总行数", "SELECT count(*) FROM ipo_history;"),
    ("托伦斯中签率", "SELECT security_name, online_lottery_rate FROM ipo_history WHERE security_name LIKE '%托伦斯%';"),
    ("南芯(债券)", "SELECT security_code, issue_size, rating FROM bond_history WHERE security_code='118070';"),
]
for label, sql in checks:
    o,e,s = ssh_run(client, base + " " + shlex_quote(sql), sudo=True)
    print(f"[{label}] status={s}")
    print(o.strip())
    if e.strip(): print("  ERR:", e.strip()[:160])
client.close()
