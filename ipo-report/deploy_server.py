"""通过密码 SSH 直连腾讯云服务器，执行部署：
  1) git pull origin master
  2) pm2 restart portfolio-server --update-env
  3) sftp 上传本地 server_bond_sync.sql 到服务器
  4) 在服务器读取 .env 的 DB 配置后执行 psql -f server_bond_sync.sql
  5) 同时执行 backfill_lottery_rate.sql（中签率精确化，幂等 UPDATE）

依赖：paramiko（已在 ipo_test venv 安装）
用法：python deploy_server.py
"""
import os, sys, re
sys.path.insert(0, os.path.dirname(__file__))
import paramiko

HOST = "82.156.125.47"
PORT = 22
USER = "ubuntu"
PASS = "***REDACTED***"
REMOTE_DIR = "/opt/portfolio"
LOCAL_SQL = os.path.join(os.path.dirname(__file__), "server_bond_sync.sql")
LOCAL_LOTTERY = os.path.join(os.path.dirname(__file__), "backfill_lottery_rate.sql")


def shlex_quote(s):
    return "'" + s.replace("'", "'\\''") + "'"


def ssh_run(client, cmd, timeout=300, sudo=False):
    """远程执行命令，返回 (status, stdout, stderr)。sudo=True 用密码提权。"""
    if sudo:
        full = f"echo {PASS} | sudo -S bash -c {shlex_quote(cmd)}"
    else:
        full = f"bash -c {shlex_quote(cmd)}"
    stdin, stdout, stderr = client.exec_command(full, timeout=timeout)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    status = stdout.channel.recv_exit_status()
    return status, out, err


def parse_env(text):
    cfg = {}
    url = None
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k, v = k.strip(), v.strip().strip('"').strip("'")
        cfg[k] = v
        if k == "DATABASE_URL":
            url = v
    if url and "DB_HOST" not in cfg:
        m = re.match(r"postgres(?:ql)?://([^:]+):([^@]+)@([^:/]+):?(\d*)/(\w+)", url)
        if m:
            cfg.setdefault("DB_USER", m.group(1))
            cfg.setdefault("DB_PASSWORD", m.group(2))
            cfg.setdefault("DB_HOST", m.group(3))
            cfg.setdefault("DB_PORT", m.group(4) or "5432")
            cfg.setdefault("DB_NAME", m.group(5))
    return cfg


def read_env_db(client):
    status, out, err = ssh_run(client, f"cat {REMOTE_DIR}/.env")
    if status != 0:
        return {}
    return parse_env(out)


def build_psql_cmd(cfg, sql_path):
    host = cfg.get("DB_HOST", "127.0.0.1")
    port = cfg.get("DB_PORT", "5432")
    user = cfg.get("DB_USER", "postgres")
    db = cfg.get("DB_NAME", "portfolio")
    pw = cfg.get("DB_PASSWORD", "")
    return f"PGPASSWORD={shlex_quote(pw)} psql -h {shlex_quote(host)} -p {port} -U {shlex_quote(user)} -d {shlex_quote(db)} -f {shlex_quote(sql_path)}"


def main():
    if not os.path.exists(LOCAL_SQL):
        print("ERROR: 本地 server_bond_sync.sql 不存在，请先运行 generate_server_bond_sync.py")
        sys.exit(1)

    print(f"[1/5] SSH 连接 {USER}@{HOST}:{PORT} ...")
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, port=PORT, username=USER, password=PASS, timeout=30,
                   look_for_keys=False, allow_agent=False)
    sftp = client.open_sftp()
    print("      已连接")

    print("[2/5] git pull origin master ...")
    st, out, err = ssh_run(client, f"cd {REMOTE_DIR} && git pull origin master", sudo=True, timeout=180)
    print(out)
    if err.strip():
        print("STDERR:", err)

    print("[3/5] pm2 restart portfolio-server --update-env ...")
    st, out, err = ssh_run(client, f"cd {REMOTE_DIR} && pm2 restart portfolio-server --update-env", sudo=True, timeout=120)
    print(out)
    if err.strip():
        print("STDERR:", err)

    print("[4/5] sftp 上传 SQL ...")
    remote_sql = f"{REMOTE_DIR}/ipo-report/server_bond_sync.sql"
    sftp.put(LOCAL_SQL, remote_sql)
    print(f"      -> {remote_sql}")
    remote_lottery = None
    if os.path.exists(LOCAL_LOTTERY):
        remote_lottery = f"{REMOTE_DIR}/ipo-report/backfill_lottery_rate.sql"
        sftp.put(LOCAL_LOTTERY, remote_lottery)
        print(f"      -> {remote_lottery}")
    else:
        print("      (本地无 backfill_lottery_rate.sql，跳过)")

    print("[5/5] 读取服务器 .env 并执行 psql 同步 ...")
    cfg = read_env_db(client)
    if not cfg or "DB_PASSWORD" not in cfg:
        print("ERROR: 无法从服务器 .env 解析 DB 配置，停止 psql（请手动执行）")
    else:
        psql_cmd = build_psql_cmd(cfg, remote_sql)
        st, out, err = ssh_run(client, psql_cmd, sudo=True, timeout=300)
        print(out)
        if err.strip():
            print("STDERR:", err)
        print("      server_bond_sync.sql:", "成功" if st == 0 else f"返回{st}")

        if remote_lottery:
            psql_cmd2 = build_psql_cmd(cfg, remote_lottery)
            st2, out2, err2 = ssh_run(client, psql_cmd2, sudo=True, timeout=120)
            print(out2)
            if err2.strip():
                print("STDERR:", err2)
            print("      backfill_lottery_rate.sql:", "成功" if st2 == 0 else f"返回{st2}")

    sftp.close()
    client.close()
    print("部署脚本完成。")


if __name__ == "__main__":
    main()
