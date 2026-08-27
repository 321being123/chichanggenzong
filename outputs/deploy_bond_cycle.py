# -*- coding: utf-8 -*-
"""历史一次性部署脚本（已废弃，禁止执行）。

当前生产统一使用 deploy/deploy_password.py + systemd；保留本文件仅供历史追溯。

旧方案：可转债周期模块上线
1) 服务器 git fetch + reset --hard origin/master
2) pm2 restart（启动时自动跑迁移021建表）
3) 轮询等待 analytics.convertible_bond_cycle_daily 表出现
4) psql 导入 server_bond_cycle_sync.sql（1849条历史聚合数据）
5) 验证：:80 返回302 + 表行数
"""
import os, sys, time, shlex
import paramiko

HOST, PORT, USER = "82.156.125.47", 22, "ubuntu"
KEY_PATH = os.environ.get("SSH_KEY_PATH") or os.path.expanduser("~/.ssh/server_login")

def ssh_run(client, cmd, timeout=300, sudo=False):
    if sudo:
        full = "sudo bash -c %s" % shlex.quote(cmd)
    else:
        full = "bash -c %s" % shlex.quote(cmd)
    _, stdout, stderr = client.exec_command(full, timeout=timeout)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    return stdout.channel.recv_exit_status(), out, err

def main():
    print("此历史部署脚本已废弃，请使用 deploy/deploy_password.py。", file=sys.stderr)
    return 1

    # 以下代码仅保留历史记录，不再执行。
    if not os.path.exists(KEY_PATH):
        print("缺少 SSH 密钥：" + KEY_PATH); sys.exit(1)
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    known_hosts = os.environ.get("SSH_KNOWN_HOSTS")
    if known_hosts:
        client.load_host_keys(os.path.expanduser(known_hosts))
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    key = paramiko.Ed25519Key.from_private_key_file(KEY_PATH)
    client.connect(HOST, port=PORT, username=USER, pkey=key, timeout=30,
                   look_for_keys=False, allow_agent=False)
    print("[1] SSH 已连接")

    st, out, err = ssh_run(client, "cd /opt/portfolio && git fetch origin && git reset --hard origin/master && git log --oneline -1", sudo=True)
    print("[2] reset:", st, out.strip()[-80:] if out else err.strip()[-200:])
    if st != 0: sys.exit(1)

    st, out, err = ssh_run(client, "pm2 restart portfolio-server --update-env", sudo=True)
    print("[3] pm2 restart:", st)
    if st != 0:
        print(err[-300:]); sys.exit(1)

    # 等迁移021建表
    psql_prefix = "source /opt/portfolio/.env && export PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE && "
    table_ok = False
    for i in range(12):
        time.sleep(5)
        st, out, err = ssh_run(client, psql_prefix + "psql -t -A -c \"SELECT to_regclass('analytics.convertible_bond_cycle_daily')\"", sudo=True)
        if st == 0 and "convertible_bond_cycle_daily" in out:
            table_ok = True
            print("[4] 迁移021建表完成（第%d次探测）" % (i+1))
            break
        print("    等待建表... 第%d次: %s" % (i+1, (out or err).strip()[:80]))
    if not table_ok:
        print("[4] 超时：表未出现，请检查 pm2 日志"); sys.exit(1)

    st, out, err = ssh_run(client, psql_prefix + "psql -v ON_ERROR_STOP=1 -f /opt/portfolio/server/scripts/server_bond_cycle_sync.sql", timeout=600, sudo=True)
    print("[5] 导入历史数据:", st, err.strip()[-200:] if st != 0 else "OK")
    if st != 0: sys.exit(1)

    st, out, err = ssh_run(client, psql_prefix + "psql -t -A -c \"SELECT count(*), min(trade_date), max(trade_date) FROM analytics.convertible_bond_cycle_daily\"", sudo=True)
    print("[6] 表行数验证:", out.strip())

    st, out, err = ssh_run(client, "curl -s -o /dev/null -w '%{http_code}' http://localhost/")
    print("[7] :80 探活:", out.strip(), "(302=正常)")

    st, out, err = ssh_run(client, "curl -s -o /dev/null -w '%{http_code}' http://localhost/api/bond-cycle/history?range=1y")
    print("[8] 周期API探活:", out.strip())

    client.close()
    print("部署完成")

if __name__ == "__main__":
    main()
