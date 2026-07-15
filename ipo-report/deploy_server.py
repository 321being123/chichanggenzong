"""通过密码 SSH 直连腾讯云服务器，执行部署：
  1) git pull origin master
  2) pm2 restart portfolio-server --update-env
  3) sftp 上传本地 server_bond_sync.sql 到服务器
  4) 在服务器读取 .env 的 DB 配置后执行 psql -f server_bond_sync.sql
  5) 依次执行：中签率精确化 UPDATE、ipo_history 同步、ipo_reports 同步（打新日历/打新建议数据）

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
    # 兼容服务器 .env 的 PG* 命名
    pg_map = {'PGHOST': 'DB_HOST', 'PGPORT': 'DB_PORT', 'PGUSER': 'DB_USER',
              'PGPASSWORD': 'DB_PASSWORD', 'PGDATABASE': 'DB_NAME'}
    for pk, dk in pg_map.items():
        if pk in cfg and dk not in cfg:
            cfg[dk] = cfg[pk]
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
    status, out, err = ssh_run(client, f"cat {REMOTE_DIR}/.env", sudo=True)
    if status != 0:
        print("      cat .env 失败:", err.strip())
        return {}
    return parse_env(out)


def build_psql_cmd(cfg, sql_path, env_file=f"{REMOTE_DIR}/.env"):
    # 在远程 source .env（含 PG* 变量）后直接用 PGPASSWORD 连接，避免密码内联注入失败
    return (f"set -a; source {shlex_quote(env_file)}; "
            f"PGPASSWORD=\"$PGPASSWORD\" psql -h \"$PGHOST\" -p \"$PGPORT\" -U \"$PGUSER\" -d \"$PGDATABASE\" -f {shlex_quote(sql_path)}")


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

    print("[4/5] SQL 文件已随 git pull 落到服务器，确认路径（/opt/portfolio 属 root，用 sudo 校验）...")
    remote_sql = f"{REMOTE_DIR}/ipo-report/server_bond_sync.sql"
    remote_lottery = f"{REMOTE_DIR}/ipo-report/backfill_lottery_rate.sql"
    st, out, err = ssh_run(client, f"test -f {remote_sql} && echo EXISTS || echo MISSING", sudo=True)
    print(f"      server_bond_sync.sql: {out.strip()}")
    st2, out2, err2 = ssh_run(client, f"test -f {remote_lottery} && echo EXISTS || echo MISSING", sudo=True)
    print(f"      backfill_lottery_rate.sql: {out2.strip()}")
    if "MISSING" in out:
        print("      server_bond_sync.sql 缺失，回退 sftp 上传 ...")
        sftp.put(LOCAL_SQL, remote_sql)
        ssh_run(client, f"chmod 644 {remote_sql}", sudo=True)

    print("[5/5] 读取服务器 .env 并执行 psql（建表 + 同步）...")
    cfg = read_env_db(client)
    print(f"      解析到 DB 配置键: {sorted(cfg.keys())}")
    if not cfg:
        print("ERROR: 无法从服务器 .env 解析 DB 配置，停止 psql（请手动执行）")
    else:
        # 5a. 先建表（bond_history / ipo_history 若不存在）
        schema_path = f"{REMOTE_DIR}/ipo-report/server_schema.sql"
        st_s, out_s, err_s = ssh_run(client, build_psql_cmd(cfg, schema_path), sudo=True, timeout=120)
        print(out_s)
        if err_s.strip():
            print("STDERR(schema):", err_s)
        print("      server_schema.sql:", "成功" if st_s == 0 else f"返回{st_s}")

        # 5b. bond_history 全量 upsert
        psql_cmd = build_psql_cmd(cfg, remote_sql)
        st, out, err = ssh_run(client, psql_cmd, sudo=True, timeout=300)
        print(out)
        if err.strip():
            print("STDERR:", err)
        print("      server_bond_sync.sql:", "成功" if st == 0 else f"返回{st}")

        # 5c. ipo_history 全量同步（含精确中签率），使「新股中签率精确化」在服务器生效
        remote_ipo = f"{REMOTE_DIR}/ipo-report/ipo_server_sync.sql"
        st_i, out_i, err_i = ssh_run(client, build_psql_cmd(cfg, remote_ipo), sudo=True, timeout=200)
        print(out_i)
        if err_i.strip():
            print("STDERR(ipo):", err_i)
        print("      ipo_server_sync.sql:", "成功" if st_i == 0 else f"返回{st_i}")

        # 5d. 中签率精确化 UPDATE（幂等，对已同步的 ipo_history 再保险）
        if remote_lottery and "MISSING" not in out2:
            psql_cmd2 = build_psql_cmd(cfg, remote_lottery)
            st2, out2b, err2 = ssh_run(client, psql_cmd2, sudo=True, timeout=120)
            print(out2b)
            if err2.strip():
                print("STDERR:", err2)
            print("      backfill_lottery_rate.sql:", "成功" if st2 == 0 else f"返回{st2}")
        else:
            print("      backfill_lottery_rate.sql: 服务器缺失，跳过")

        # 5e. ipo_reports 同步（打新日历 / 打新建议数据；此前未建表导致线上为空）
        remote_reports = f"{REMOTE_DIR}/ipo-report/server_ipo_reports_sync.sql"
        st_r, out_r, err_r = ssh_run(client, build_psql_cmd(cfg, remote_reports), sudo=True, timeout=120)
        print(out_r)
        if err_r.strip():
            print("STDERR(reports):", err_r)
        print("      server_ipo_reports_sync.sql:", "成功" if st_r == 0 else f"返回{st_r}")

    sftp.close()
    client.close()
    print("部署脚本完成。")


if __name__ == "__main__":
    main()
