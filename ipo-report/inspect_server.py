import sys, os
sys.path.insert(0, os.path.dirname(__file__))
import paramiko
HOST="82.156.125.47"; PORT=22; USER="ubuntu"; PASS="***REDACTED***"
def shlex_quote(s): return "'" + s.replace("'", "'\\''") + "'"
def ssh_run(client, cmd, sudo=False, timeout=120):
    full = f"echo {PASS} | sudo -S bash -c {shlex_quote(cmd)}" if sudo else f"bash -c {shlex_quote(cmd)}"
    i,o,e = client.exec_command(full, timeout=timeout)
    return o.read().decode('utf-8','replace'), e.read().decode('utf-8','replace'), o.channel.recv_exit_status()

client = paramiko.SSHClient(); client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, port=PORT, username=USER, password=PASS, timeout=30, look_for_keys=False, allow_agent=False)

print("=== 1) SQLite 文件 ===")
o,e,s = ssh_run(client, "find /opt/portfolio -maxdepth 3 -name '*.db' 2>/dev/null; ls -la /opt/portfolio/*.db 2>/dev/null; echo '---data dir---'; ls -la /opt/portfolio/data 2>/dev/null | head")
print(o.strip())

print("=== 2) db.js DB 类型 ===")
o,e,s = ssh_run(client, "grep -nE 'sqlite|better-sqlite|pg|postgres|Pool|Client|DB_TYPE|DATABASE' /opt/portfolio/server/db.js 2>/dev/null | head -30")
print(o.strip() or "(无 db.js 或无可匹配)")

print("=== 3) PostgreSQL 数据库列表 ===")
o,e,s = ssh_run(client, "set -a; source /opt/portfolio/.env; PGPASSWORD=\"$PGPASSWORD\" psql -h \"$PGHOST\" -p \"$PGPORT\" -U \"$PGUSER\" -d postgres -t -A -c \"SELECT datname FROM pg_database;\"", sudo=True)
print(o.strip() or e.strip())

print("=== 4) PGDATABASE 下的表 ===")
o,e,s = ssh_run(client, "set -a; source /opt/portfolio/.env; PGPASSWORD=\"$PGPASSWORD\" psql -h \"$PGHOST\" -p \"$PGPORT\" -U \"$PGUSER\" -d \"$PGDATABASE\" -t -A -c \"SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename;\"", sudo=True)
print(o.strip() or e.strip())

client.close()
