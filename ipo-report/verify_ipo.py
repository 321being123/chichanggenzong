import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from _common import shlex_quote, ssh_run, ssh_connect

client = ssh_connect()
base = "set -a; source " + shlex_quote("/opt/portfolio/.env") + "; PGPASSWORD=\"$PGPASSWORD\" psql -h \"$PGHOST\" -p \"$PGPORT\" -U \"$PGUSER\" -d \"$PGDATABASE\" -t -A -c"
checks = [
    ("ipo总行数", "SELECT count(*) FROM ipo_history;"),
    ("托伦斯中签率", "SELECT security_name, online_lottery_rate FROM ipo_history WHERE security_name LIKE '%托伦斯%';"),
    ("南芯(债券)", "SELECT security_code, display_issue_size, display_rating FROM public.bond_unified WHERE security_code='118070';"),
]
for label, sql in checks:
    o,e,s = ssh_run(client, base + " " + shlex_quote(sql), sudo=True)
    print(f"[{label}] status={s}")
    print(o.strip())
    if e.strip(): print("  ERR:", e.strip()[:160])
client.close()
